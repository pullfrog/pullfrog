// Codex-to-OpenCode auth bridging for the action runtime.
//
// `pullfrog auth codex` stores a Codex CLI `auth.json` blob in the Pullfrog
// per-org secret store (production Postgres) — NOT a GitHub Actions secret.
// This is non-negotiable: the OAuth refresh chain rotates on every use, and
// `entryPost.ts` writes the rotated chain back via `PUT /api/runtime/secret`
// after each run. GH Actions secrets are immutable at runtime, so a token
// stashed there silently expires on the first refresh (~1h). See
// wiki/codex-auth.md for the full constraint.
//
// At runtime, `CODEX_AUTH_JSON` lands in process.env via `runContext.dbSecrets`
// merged in main.ts — sourced from Pullfrog Postgres through the OIDC-validated
// run-context endpoint, never from `${{ secrets.CODEX_AUTH_JSON }}` in
// workflow yaml.
//
// The run-context endpoint calls `maybeRotateCodexSecret` (see
// `utils/codexSecretRotation.ts`) inside a Postgres row lock just before
// decrypting + returning dbSecrets. That serializes concurrent rotations
// across the fleet: the first concurrent run rotates the token; the rest
// see the just-written value and skip. Result: the token in
// `process.env.CODEX_AUTH_JSON` is guaranteed fresh for at least the
// rotation safety margin (~50min) when this code runs. No action-side
// pre-flight refresh is needed.
//
// This utility then:
//   1. parses + validates the env value
//   2. decodes the access_token JWT's `exp` claim so opencode knows how
//      long to trust the token before its CodexAuthPlugin attempts its
//      own mid-run refresh
//   3. converts Codex's shape `{ auth_mode, tokens: { access_token,
//      refresh_token, id_token?, account_id? } }` into OpenCode's shape
//      `{ openai: { type: "oauth", refresh, access, expires, accountId } }`
//   4. materializes it to disk under a path the MCP-shell mount-namespace
//      sandbox can hide from bash: `/var/lib/pullfrog/run-*/opencode/auth.json`
//      in CI (sudo-bootstrapped, fail-closed if sudo unavailable),
//      `$HOME/.local/share/opencode/auth.json` locally (sandbox is no-op
//      locally so the path is irrelevant to security)
//   5. returns the path + the original refresh token so the post-run hook
//      can detect a mid-run rotation and write back to Pullfrog
//
// Why `/var/lib/pullfrog/` and not `$HOME` in CI: bash via MCP runs inside a
// mount namespace that overlays tmpfs on `/var/lib/pullfrog/` (see FS_MOUNTS
// in action/mcp/shell.ts), so bash sees an empty dir while opencode's
// internal auth module — which runs in the agent process outside that
// namespace — reads/writes the real file. `$HOME` can't be tmpfs-overlaid
// without breaking the agent's legitimate need to access ~/.npm, ~/.cache,
// etc.
//
// See [wiki/codex-auth.md] for the full data-flow picture.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { log } from "./cli.ts";
import { type CodexAuthBody, parseCodexAuthBody, stringifyCodexAuthBody } from "./codexOAuth.ts";
import { decodeJwtExpMs } from "./oauthShared.ts";
import { SUBSCRIPTION_DATA_DIR_STATE } from "./oauthWriteback.ts";
import { saveSecretState } from "./secretCommands.ts";
import { parseXaiAuthBody, type XaiAuthBody } from "./xaiOAuth.ts";

const CODEX_AUTH_ENV = "CODEX_AUTH_JSON";
const XAI_AUTH_ENV = "GROK_AUTH_JSON";
const installedSubscriptionPaths = new Map<string, string>();
let installedDataHome: string | undefined;

/** the data dir a subscription was installed into this run, which opencode's XDG_DATA_HOME must name. */
export function getSubscriptionDataHome(): string | undefined {
  return installedDataHome;
}

export function clearInstalledSubscription(name: "CODEX_AUTH_JSON" | "GROK_AUTH_JSON") {
  const path = installedSubscriptionPaths.get(name);
  if (!path || !existsSync(path)) return;
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object") return;
  if (name === "CODEX_AUTH_JSON" && "openai" in value) delete value.openai;
  if (name === "GROK_AUTH_JSON" && "xai" in value) delete value.xai;
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  installedSubscriptionPaths.delete(name);
}

/** sandbox-hidden home for pullfrog-managed on-disk secrets in CI. bash via
 * MCP shell tmpfs-overlays this path; opencode's internal auth module
 * bypasses external_directory and reaches the real file. mirrors the
 * pattern in action/agents/claude.ts installManagedSettings.
 *
 * not used for codex auth in local dev — the sandbox is no-op there, so
 * the path doesn't matter. local dev keeps the existing $HOME path. */
export const PULLFROG_DATA_DIR = "/var/lib/pullfrog";

interface OpenCodeOAuthEntry {
  type: "oauth";
  refresh: string;
  access: string;
  expires: number;
  accountId?: string;
}

/** opencode keys auth.json by provider id — `openai` for the Codex chain,
 * `xai` for the Grok chain. An account can hold both, so entries are merged
 * into whatever is already on disk rather than overwriting the file. */
type OpenCodeAuthFile = Record<string, OpenCodeOAuthEntry>;

/** the server latches `refresh_rejected_at` when OpenAI rejects the refresh —
 * the rotation is one-shot, so a rejection is PERMANENT until the user re-runs
 * `pullfrog auth codex` (see utils/codexSecretRotation.ts and #1101). the
 * latched blob still reaches the runner, and materializing it buys nothing: it
 * dies at the first model call, having already displaced an `OPENAI_API_KEY`
 * that would have served the run. */
function isRejectedChain(body: CodexAuthBody): boolean {
  if (!body.refresh_rejected_at) return false;
  log.warning(
    `» ${CODEX_AUTH_ENV} was rejected by OpenAI at ${body.refresh_rejected_at} and cannot be ` +
      `refreshed — re-run \`npx pullfrog auth codex\`. skipping it for this run.`
  );
  return true;
}

export interface InstalledCodexAuth {
  /** absolute path of the auth.json we wrote — caller passes this to the
   * post-hook via core.saveState for refresh-detection later. */
  authPath: string;
  /** refresh_token from the env at materialization time. post-hook
   * compares against the on-disk file after the run to detect whether
   * OpenCode refreshed during the session (only happens on long runs
   * that span >50min — see wiki/codex-auth.md "Concurrency"). */
  originalRefresh: string;
  /** id_token from the env at materialization time. OpenCode's auth file has
   * no slot for it, so the post-hook has to re-attach this one or the written
   * back blob loses it — and the Codex CLI REFUSES an auth.json without
   * `tokens.id_token` (measured: `missing field 'id_token'`), so dropping it
   * silently disqualifies the account from the codex harness forever. */
  originalIdToken: string | undefined;
}

/** materialize CODEX_AUTH_JSON from env into a disk path OpenCode reads from.
 * returns null when the env var is absent, malformed, or wrong auth mode, or
 * when this runner cannot host it (`resolveDataHome`) —
 * caller treats null as "no codex auth, fall through to API key flow".
 *
 * The env value is server-side guaranteed fresh by `maybeRotateCodexSecret`
 * in the run-context endpoint. We parse + write it here and record the dir
 * (`getSubscriptionDataHome`) so every opencode subprocess discovers the
 * auth.json; no refresh, no DB interaction. */
export function installCodexAuth(): InstalledCodexAuth | null {
  const raw = process.env[CODEX_AUTH_ENV];
  if (!raw) return null;

  const body = parseCodexAuthBody(raw);
  if (!body) {
    log.warning(`» ${CODEX_AUTH_ENV} present but malformed; ignoring`);
    return null;
  }
  if (isRejectedChain(body)) return null;

  // decode the access_token's JWT exp so opencode trusts the token until
  // its real expiry (no need to refresh on first request). null exp ->
  // fall back to "expires: 0" so opencode refreshes immediately on first
  // request (the old behavior).
  const expiresMs = decodeJwtExpMs(body.tokens.access_token) ?? 0;

  const xdgDataHome = resolveDataHome();
  if (!xdgDataHome) return null;
  const opencodeDir = join(xdgDataHome, "opencode");
  const authPath = join(opencodeDir, "auth.json");

  writeOpenCodeAuthEntry({
    opencodeDir,
    authPath,
    provider: "openai",
    entry: {
      type: "oauth",
      refresh: body.tokens.refresh_token,
      access: body.tokens.access_token,
      expires: expiresMs,
      ...(body.tokens.account_id ? { accountId: body.tokens.account_id } : {}),
    },
  });

  // every opencode subprocess in this run (agent spawn + `opencode models`
  // introspection) reads this through `openCodeHomeEnv`.
  installedDataHome = xdgDataHome;

  log.info(`» installed Codex auth at ${authPath}`);
  installedSubscriptionPaths.set(CODEX_AUTH_ENV, authPath);

  return {
    authPath,
    originalRefresh: body.tokens.refresh_token,
    originalIdToken: body.tokens.id_token,
  };
}

/** merge one provider entry into opencode's auth.json, preserving any other
 * provider already there. An account can hold both a Codex and a Grok
 * credential, and both install into the same file — a wholesale write would
 * silently drop whichever ran first. Unreadable or malformed existing content
 * is replaced rather than merged: it is opencode's own cache, not a credential
 * we can recover, and a stale half-file would break the run either way. */
function writeOpenCodeAuthEntry(params: {
  opencodeDir: string;
  authPath: string;
  provider: string;
  entry: OpenCodeOAuthEntry;
}): void {
  let existing: OpenCodeAuthFile = {};
  if (existsSync(params.authPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(params.authPath, "utf8"));
      if (parsed && typeof parsed === "object") existing = parsed as OpenCodeAuthFile;
    } catch {
      log.warning(`» ${params.authPath} was unreadable; rewriting it`);
    }
  }
  const merged: OpenCodeAuthFile = { ...existing, [params.provider]: params.entry };
  mkdirSync(params.opencodeDir, { recursive: true });
  writeFileSync(params.authPath, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
}

export interface InstalledXaiAuth {
  /** absolute path of the auth.json we wrote — the post-hook diffs it. */
  authPath: string;
  /** refresh_token at materialization time. opencode's XaiAuthPlugin rotates
   * in-process on a long run, so the post-hook compares against this to decide
   * whether anything needs writing back. */
  originalRefresh: string;
}

/** materialize GROK_AUTH_JSON from env into opencode's auth.json.
 *
 * opencode ships xAI Grok OAuth natively (`XaiAuthPlugin`, added upstream
 * 2026-05-21, present in our pinned 1.18.5) against the same public
 * Grok-CLI OAuth client we mint with, so the stored chain drops straight in.
 * The plugin sends the token to `api.x.ai/v1` — it deliberately sets no
 * baseURL — so there is no CLI proxy and no client-version header in play.
 *
 * returns null when the env var is absent or malformed, or when this runner
 * cannot host it (`resolveDataHome`); caller treats null as
 * "no grok subscription auth, fall through to XAI_API_KEY". */
export function installXaiAuth(): InstalledXaiAuth | null {
  const raw = process.env[XAI_AUTH_ENV];
  if (!raw) return null;

  const body = parseXaiAuthBody(raw);
  if (!body) {
    log.warning(`» ${XAI_AUTH_ENV} present but malformed; ignoring`);
    return null;
  }
  if (isXaiRejectedChain(body)) return null;

  const xdgDataHome = resolveDataHome();
  if (!xdgDataHome) return null;
  const opencodeDir = join(xdgDataHome, "opencode");
  const authPath = join(opencodeDir, "auth.json");

  writeOpenCodeAuthEntry({
    opencodeDir,
    authPath,
    provider: "xai",
    // opencode refreshes when `expires` is inside its skew window, and falls
    // back to the JWT's own exp when the stored value is absent. Decoding it
    // here means the first request uses the token we already hold instead of
    // burning a rotation on startup.
    entry: {
      type: "oauth",
      refresh: body.tokens.refresh_token,
      access: body.tokens.access_token,
      expires: decodeJwtExpMs(body.tokens.access_token) ?? 0,
    },
  });

  installedDataHome = xdgDataHome;
  log.info(`» installed Grok auth at ${authPath}`);
  installedSubscriptionPaths.set(XAI_AUTH_ENV, authPath);

  return { authPath, originalRefresh: body.tokens.refresh_token };
}

/** the server latches `refresh_rejected_at` when xAI rejects the refresh.
 * rotation is one-shot, so the rejection is permanent until the user re-runs
 * `pullfrog auth grok`. materializing a latched blob buys nothing — it dies at
 * the first model call, having already displaced an `XAI_API_KEY` that would
 * have served the run. */
function isXaiRejectedChain(body: XaiAuthBody): boolean {
  if (!body.refresh_rejected_at) return false;
  log.warning(
    `» ${XAI_AUTH_ENV} was rejected by xAI at ${body.refresh_rejected_at} and cannot be ` +
      `refreshed — re-run \`npx pullfrog auth grok\`. skipping it for this run.`
  );
  return true;
}

export interface InstalledCodexHome {
  /** value to set as CODEX_HOME for the codex subprocess. holds auth.json,
   * config.toml and the session rollouts the resume path reads. */
  codexHome: string;
  /** absolute path of the auth.json we wrote. the codex CLI rewrites this file
   * in place when it refreshes, so the post-hook diffs it for a rotation. */
  authPath: string;
  originalRefresh: string;
}

/**
 * materialize CODEX_AUTH_JSON into a CODEX_HOME the codex CLI reads directly.
 * unlike {@link installCodexAuth} there is no shape conversion — the stored
 * blob IS the codex CLI's own `auth.json`, so it round-trips verbatim.
 *
 * returns null when the env var is absent, malformed, or carries no
 * `tokens.id_token`. that last one is not defensive: the CLI's `TokenData`
 * makes `id_token` a required field with a JWT deserializer, so an auth.json
 * without it fails to load with `missing field 'id_token'` before any model
 * call. callers treat null as "codex CLI can't use this credential".
 */
export function installCodexHome(): InstalledCodexHome | null {
  const raw = process.env[CODEX_AUTH_ENV];
  if (!raw) return null;

  const body = parseCodexAuthBody(raw);
  if (!body) {
    log.warning(`» ${CODEX_AUTH_ENV} present but malformed; ignoring`);
    return null;
  }
  if (isRejectedChain(body)) return null;
  if (!body.tokens.id_token) {
    log.warning(
      `» ${CODEX_AUTH_ENV} carries no id_token — the codex CLI cannot load it. ` +
        `re-run \`npx pullfrog auth codex\` to mint a complete credential.`
    );
    return null;
  }

  const root = resolveDataHome();
  if (!root) return null;
  const codexHome = join(root, "codex");
  const authPath = join(codexHome, "auth.json");

  mkdirSync(codexHome, { recursive: true });
  writeFileSync(authPath, stringifyCodexAuthBody(body), { mode: 0o600 });

  log.info(`» installed Codex auth at ${authPath}`);

  return { codexHome, authPath, originalRefresh: body.tokens.refresh_token };
}

let dataHome: string | null | undefined;

/** subscriptions this run held but could not install, so a no-key error can name the real cause. */
export const unhostedSubscriptions = new Set<string>();

/** false for a Codex or Grok subscription on a runner that cannot host it (`resolveDataHome`). */
export function canInstallSubscription(name: string) {
  return (name !== CODEX_AUTH_ENV && name !== XAI_AUTH_ENV) || resolveDataHome() !== null;
}

/** pick the XDG_DATA_HOME for codex auth.
 *
 * - **local dev (CI != true)**: use $HOME. mount-namespace sandbox is no-op
 *   locally so the file isn't protected from bash either way; codex auth on
 *   a developer's machine is the developer's responsibility.
 * - **CI**: bootstrap /var/lib/pullfrog via sudo and use a fresh dir inside it.
 *   MCP shell's mount namespace tmpfs-overlays this path, and claude
 *   managed-settings + opencode external_directory both deny it — three
 *   independent layers.
 *
 * **fail closed in CI** when the sudo bootstrap fails — for the credential,
 * not the run. falling back to $HOME silently strips two of the three
 * protection layers, so the subscription is not installed at all (null) and
 * leaves env: a run on any other model proceeds, and one that needs it
 * reports no key.
 * failing the whole run instead broke every run on a sudo-less self-hosted
 * runner that merely HELD a subscription, whatever its model (#1335). */
function resolveDataHome(): string | null {
  if (process.env.CI !== "true") return join(homedir(), ".local", "share");
  if (dataHome === undefined) dataHome = bootstrapPullfrogDataDir();
  return dataHome;
}

function bootstrapPullfrogDataDir(): string | null {
  const user = userInfo().username;
  // `id -gn $user` resolves the user's primary group name correctly even on
  // self-hosted images where the group isn't `<user>:<user>` (e.g., `runner`
  // belongs to `runner`, but a self-hosted setup might use `users`, `docker`,
  // or a project-specific gid). avoids the brittle "group has same name as
  // user" assumption.
  let primaryGroup: string;
  try {
    primaryGroup = execFileSync("id", ["-gn", user], { stdio: "pipe", encoding: "utf-8" }).trim();
  } catch {
    primaryGroup = user;
  }
  // `-n` (non-interactive) makes sudo fail-fast on locked-down runners
  // instead of prompting and timing out.
  try {
    execFileSync("sudo", ["-n", "mkdir", "-p", PULLFROG_DATA_DIR], { stdio: "pipe" });
    execFileSync("sudo", ["-n", "chown", `${user}:${primaryGroup}`, PULLFROG_DATA_DIR], {
      stdio: "pipe",
    });
    execFileSync("sudo", ["-n", "chmod", "700", PULLFROG_DATA_DIR], { stdio: "pipe" });
  } catch (err) {
    log.warning(
      `» subscription auth skipped: could not create ${PULLFROG_DATA_DIR} (${err instanceof Error ? err.message : String(err)}). ` +
        `it must live outside the agent sandbox's reach, which needs passwordless sudo on this runner; ` +
        `runs on a model that needs the subscription will report no key.`
    );
    // harness routing and key validation read the env vars, not the installed file.
    for (const name of [CODEX_AUTH_ENV, XAI_AUTH_ENV]) {
      if (process.env[name]) unhostedSubscriptions.add(name);
      delete process.env[name];
    }
    return null;
  }
  // one per run: concurrent runs on a self-hosted host shared opencode's SQLite db and
  // the codex CLI's home here (#1475). the post hook removes it after the writeback; a
  // GitHub-hosted VM is discarded anyway, so it skips that post-step npm bootstrap.
  const runDir = mkdtempSync(join(PULLFROG_DATA_DIR, "run-"));
  // not a credential: this is just the one state writer the secret-command guard allows.
  if (process.env.RUNNER_ENVIRONMENT !== "github-hosted") {
    saveSecretState(SUBSCRIPTION_DATA_DIR_STATE, runDir);
  }
  return runDir;
}
