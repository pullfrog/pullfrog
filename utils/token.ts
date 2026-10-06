import assert from "node:assert/strict";
import * as core from "@actions/core";
import type { AuthorPermission, PushPermission, XrepoConfig } from "../external.ts";
import { log } from "./cli.ts";
import { onExitSignal } from "./exitHandler.ts";
import { acquireNewToken, type OidcCredentials } from "./github.ts";
import { formatPermissions, mirrorRolePermissions } from "./roleMirror.ts";
import { maskSecret } from "./secretCommands.ts";

// re-export for `pullfrog gha token` subcommand
export { acquireNewToken as acquireInstallationToken };
export { revokeGitHubInstallationToken as revokeInstallationToken };

// store MCP token in memory for getGitHubInstallationToken()
let mcpTokenValue: string | undefined;

// single-flight re-acquisition for mid-run 401s, set by resolveTokens on the
// minted path (external GH_TOKEN can't be re-minted, so it stays undefined)
let refreshMcpTokenFn: ((stale: string) => Promise<string>) | undefined;

/**
 * get the refresh function for the MCP token, if re-acquisition is possible.
 * pass to `createOctokit` so a mid-run 401 triggers a refresh + retry (#891).
 */
export function getMcpTokenRefresh(): ((stale: string) => Promise<string>) | undefined {
  return refreshMcpTokenFn;
}

/**
 * get the job-scoped token from action input.
 * this token has permissions defined by the workflow's permissions block.
 *
 * fallback order:
 * 1. INPUT_TOKEN (from workflow `with: token:`)
 * 2. GH_TOKEN (external token override)
 * 3. GITHUB_TOKEN (pre-acquired in tests or from GHA env)
 */
export function getJobToken(): string {
  const inputToken = core.getInput("token");
  if (inputToken) {
    return inputToken;
  }

  // fallback for test environment and local dev
  const fallbackToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (fallbackToken) {
    return fallbackToken;
  }

  throw new Error("token input is required");
}

export type TokenRef = {
  // live getter: after a mid-run re-mint (`refreshGitToken` on an auth-class
  // push failure) the old token is revoked, so this reflects the CURRENT git
  // token — push-class tools (push_branch, push_tags, delete_branch) that read
  // it per call never reuse a stale/revoked snapshot. mirrors the #891
  // githubInstallationToken live getter. see #964.
  gitToken: string;
  mcpToken: string;
  // contents:read token scoped to the cross-repo READ set (clone-for-reference
  // of read-only secondaries). only minted on `--xrepo` runs; undefined
  // otherwise. resolveRepoCtx routes read-tier secondaries to this token.
  readToken?: string | undefined;
  // credential handed to the `gh` MCP tool, scoped to mirror the triggering
  // user's own repo role. undefined below the mirror threshold (read/none),
  // which is what withholds the tool entirely. see roleMirror.ts.
  ghToken?: string | undefined;
  // re-mint the git-scoped token matching `stale` (the write gitToken or the
  // read readToken) for push retries, when GitHub hands out a token its
  // git-over-HTTPS edge never accepts. undefined on the external-GH_TOKEN path
  // (can't be re-minted). single-flight per token.
  refreshGitToken?: ((stale: string) => Promise<string>) | undefined;
  [Symbol.asyncDispose]: () => Promise<void>;
};

type ResolveTokensParams = {
  push: PushPermission;
  // the triggering user's repo role, resolved server-side before dispatch. the
  // `gh` token's scope is derived from it; `undefined` withholds the token.
  authorPermission: AuthorPermission | undefined;
  // cross-repo access sets (server-resolved). when present, gitToken + mcpToken
  // are scoped to the WRITE set (∪ primary) and a readToken is minted over the
  // READ set. absent → single-repo, primary-scoped tokens (unchanged).
  xrepo?: XrepoConfig | undefined;
  /**
   * handle to the cross-repo grant the server persisted for this run. required
   * alongside `xrepo`: the mint endpoint refuses a `repos` list without one,
   * because the runner's list is attacker-controlled on a manual dispatch.
   */
  xrepoGrant?: string | undefined;
  /**
   * OIDC credentials stashed by main.ts before the restricted-mode env wipe —
   * the mid-run MCP token refresh mints from this snapshot (#891). null when
   * OIDC isn't available (local dev, external token).
   */
  oidc: OidcCredentials | null;
};

/**
 * resolve tokens for the action run.
 *
 * creates two separate tokens (three on cross-repo runs):
 * - gitToken: contents permission based on `push` setting (assumed exfiltratable)
 *   - push: enabled → contents:write (can push)
 *   - push: disabled → contents:read (read-only)
 * - mcpToken: full installation token - used for GitHub API calls in MCP tools (not exfiltratable)
 * - readToken (xrepo only): contents:read over the read set, for cloning read-tier secondaries
 *
 * on cross-repo runs, gitToken + mcpToken are scoped to the WRITE set (always
 * incl. the primary), so a writable secondary can take PRs; read-only
 * secondaries route through readToken instead.
 *
 * security-conscious users can pass their own token via GH_TOKEN env var or inputs.token.
 */
export async function resolveTokens(params: ResolveTokensParams): Promise<TokenRef> {
  assert(!mcpTokenValue, "tokens are already resolved");

  const externalToken = process.env.GH_TOKEN;

  // external token takes precedence - use for both git and MCP
  if (externalToken) {
    mcpTokenValue = externalToken;

    maskSecret(externalToken);

    log.info("» using external GH_TOKEN for both git and MCP");

    return {
      gitToken: externalToken,
      mcpToken: externalToken,
      // external token is whatever scope the user granted — reuse for reads too.
      readToken: params.xrepo ? externalToken : undefined,
      // the scope is the user's to choose here, but the role threshold still
      // decides whether the agent gets a CLI credential at all.
      ghToken: mirrorRolePermissions(params.authorPermission) ? externalToken : undefined,
      async [Symbol.asyncDispose]() {
        mcpTokenValue = undefined;
        // GH_TOKEN isn't acquired here, so it's not revoked here either
      },
    };
  }

  // on cross-repo runs, scope the write-tier tokens to the WRITE set;
  // `acquireTokenViaOIDC` (action/utils/github.ts) appends the primary repo
  // client-side before the request, so this covers primary + writable
  // secondaries. undefined → primary only (unchanged).
  const writeRepos = params.xrepo?.write;

  // create git token based on push permission (assumed exfiltratable)
  // disabled = read-only, restricted/enabled = write (MCP tools enforce branch restrictions)
  // workflows permission is write-only in the API, so only requested when pushing is allowed
  const gitPermissions =
    params.push === "disabled"
      ? { contents: "read" as const }
      : { contents: "write" as const, workflows: "write" as const };
  const gitToken = await acquireNewToken({
    repos: writeRepos,
    xrepoGrant: params.xrepoGrant,
    permissions: gitPermissions,
  });
  maskSecret(gitToken);
  log.info(
    `» acquired git token (${Object.entries(gitPermissions)
      .map((e) => e.join(":"))
      .join(", ")})`
  );

  // MCP token scoped to only what MCP tools actually need.
  // not exfiltratable (only accessible via MCP tools), but scoped as defense-in-depth
  // so even a compromised tool context can't touch secrets, admin, etc.
  const mcpPermissions = {
    contents: "write",
    pull_requests: "write",
    issues: "write",
    // write (not read) so the run can post `pullfrog` / `pullfrog-approval`
    // commit-status check-runs for branch protection. the app already grants
    // checks:write; this scopes the MCP token up to use it.
    checks: "write",
    // write (not read) so postReviewCleanup can dispatch the follow-up re-review
    // for commits pushed while a review was in flight; read 403s it.
    actions: "write",
  } as const;
  const mcpToken = await acquireNewToken({
    repos: writeRepos,
    xrepoGrant: params.xrepoGrant,
    permissions: mcpPermissions,
  });
  maskSecret(mcpToken);
  log.info(
    `» acquired scoped MCP token (${Object.entries(mcpPermissions)
      .map((e) => e.join(":"))
      .join(", ")})`
  );

  // credential for the `gh` MCP tool, mirroring the triggering user's own role.
  // deliberately a SEPARATE token from mcpToken: the MCP token stays
  // broad-and-unreachable, while this one is handed to a subprocess that can
  // print it, so its scope is the entire security boundary. passing NO `repos`
  // does not mean unscoped: `acquireTokenViaOIDC` always appends
  // `$GITHUB_REPOSITORY`, so the list is exactly `[this repo]` regardless of how
  // much org-wide reach the triggerer has, and a leak cannot cross into the
  // xrepo write set. see mirrorRolePermissions for why that stays correct.
  const ghPermissions = mirrorRolePermissions(params.authorPermission);
  let ghToken: string | undefined;
  if (ghPermissions) {
    ghToken = await acquireNewToken({ permissions: ghPermissions });
    maskSecret(ghToken);
    log.info(
      `» acquired gh token mirroring ${params.authorPermission} (${formatPermissions(ghPermissions)})`
    );
  }

  // read-tier token for cloning read-only secondaries (cross-repo only).
  let readToken: string | undefined;
  if (params.xrepo) {
    readToken = await acquireNewToken({
      repos: params.xrepo.read,
      xrepoGrant: params.xrepoGrant,
      permissions: { contents: "read" },
    });
    maskSecret(readToken);
    log.info(`» acquired cross-repo read token (contents:read, ${params.xrepo.read.length} repos)`);
  }

  mcpTokenValue = mcpToken;
  let currentMcpToken = mcpToken;
  let currentGitToken = gitToken;
  let currentReadToken = readToken;

  // GitHub can invalidate an installation token before expiry (see #891).
  // single-flight: concurrent 401s share one mint, and a caller whose token
  // was already replaced by a parallel refresh gets the replacement without
  // minting again. cleared on settle so a transient refresh failure doesn't
  // poison the rest of the run (acquireNewToken retries transients itself).
  let refreshPromise: Promise<string> | undefined;
  refreshMcpTokenFn = (stale) => {
    assert(mcpTokenValue, "tokens already disposed");
    if (stale !== currentMcpToken) {
      return Promise.resolve(currentMcpToken);
    }
    // keep the original scope: on xrepo runs the MCP token covers the WRITE
    // set, and a refresh that dropped `repos` would silently re-scope it to
    // the primary only (secondaries would start 403ing mid-run).
    refreshPromise ??= acquireNewToken({
      repos: writeRepos,
      xrepoGrant: params.xrepoGrant,
      permissions: mcpPermissions,
      oidc: params.oidc ?? undefined,
    })
      .then((fresh) => {
        maskSecret(fresh);
        mcpTokenValue = fresh;
        currentMcpToken = fresh;
        log.warning("» GitHub rejected the MCP token; re-acquired a fresh scoped MCP token");
        return fresh;
      })
      .finally(() => {
        refreshPromise = undefined;
      });
    return refreshPromise;
  };

  // GitHub intermittently mints a git token its git-over-HTTPS edge never
  // accepts — it 401s as "Invalid username or token" for the token's whole
  // life, so retrying the same token never recovers. re-minting draws a fresh
  // token instance, which is the actual cure. dispatches by which current
  // git-scoped token `stale` matches (write gitToken or read readToken),
  // single-flight per token, and revokes the superseded one.
  let gitRefreshPromise: Promise<string> | undefined;
  let readRefreshPromise: Promise<string> | undefined;
  const refreshGitToken = (stale: string): Promise<string> => {
    assert(mcpTokenValue, "tokens already disposed");
    if (stale === currentGitToken) {
      gitRefreshPromise ??= acquireNewToken({
        repos: writeRepos,
        xrepoGrant: params.xrepoGrant,
        permissions: gitPermissions,
        oidc: params.oidc ?? undefined,
      })
        .then((fresh) => {
          maskSecret(fresh);
          void revokeGitHubInstallationToken(currentGitToken);
          currentGitToken = fresh;
          log.warning("» GitHub rejected the git token; re-acquired a fresh git token");
          return fresh;
        })
        .finally(() => {
          gitRefreshPromise = undefined;
        });
      return gitRefreshPromise;
    }
    if (currentReadToken && stale === currentReadToken) {
      const read = currentReadToken;
      readRefreshPromise ??= acquireNewToken({
        repos: params.xrepo?.read,
        xrepoGrant: params.xrepoGrant,
        permissions: { contents: "read" },
        oidc: params.oidc ?? undefined,
      })
        .then((fresh) => {
          maskSecret(fresh);
          void revokeGitHubInstallationToken(read);
          currentReadToken = fresh;
          log.warning("» GitHub rejected the read token; re-acquired a fresh read token");
          return fresh;
        })
        .finally(() => {
          readRefreshPromise = undefined;
        });
      return readRefreshPromise;
    }
    // `stale` was already replaced by a parallel refresh — hand back the
    // fresh token of whichever tier it belonged to.
    return Promise.resolve(
      stale === readToken ? (currentReadToken ?? currentGitToken) : currentGitToken
    );
  };

  let disposingRef: PromiseWithResolvers<void> | undefined;

  const dispose = async () => {
    if (disposingRef) {
      // this can happen if the signal arrives when disposing tokens
      // we make sure to wait for the current dispose to complete
      return disposingRef.promise;
    }
    disposingRef = Promise.withResolvers();
    try {
      mcpTokenValue = undefined;
      refreshMcpTokenFn = undefined;
      // revoke all minted tokens (a refresh may have replaced any of them)
      await Promise.all([
        revokeGitHubInstallationToken(currentGitToken),
        revokeGitHubInstallationToken(currentMcpToken),
        ...(currentReadToken ? [revokeGitHubInstallationToken(currentReadToken)] : []),
        // revoking this one is what bounds a `gh` leak to the run's lifetime
        ...(ghToken ? [revokeGitHubInstallationToken(ghToken)] : []),
      ]);
    } finally {
      removeSignalHandler();
      disposingRef.resolve();
      disposingRef = undefined;
    }
  };

  const removeSignalHandler = onExitSignal(dispose);

  return {
    get gitToken() {
      return currentGitToken;
    },
    mcpToken,
    readToken,
    ghToken,
    refreshGitToken,
    [Symbol.asyncDispose]: dispose,
  };
}

/**
 * get the MCP token from memory.
 * this is the token used for GitHub API calls in MCP tools.
 */
export function getGitHubInstallationToken(): string {
  assert(mcpTokenValue, "tokens not set. call resolveTokens first.");
  return mcpTokenValue;
}

export async function revokeGitHubInstallationToken(token: string): Promise<void> {
  const apiUrl = process.env.GITHUB_API_URL || "https://api.github.com";

  try {
    await fetch(`${apiUrl}/installation/token`, {
      method: "DELETE",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    log.debug("» installation token revoked");
  } catch (error) {
    log.info(
      `Failed to revoke installation token: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
