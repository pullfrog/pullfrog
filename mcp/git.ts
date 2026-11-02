import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { regex } from "arkregex";
import { type } from "arktype";
import { NON_COMMITTING_MODES } from "../modes.ts";
import {
  primaryRepoState,
  type RepoAccess,
  type RepoToolState,
  requireRepoState,
  type StoredPushDest,
} from "../toolState.ts";
import {
  assertApiCommittable,
  createSignedCommit,
  detectWorkingTreeChanges,
} from "../utils/apiCommit.ts";
import { log } from "../utils/cli.ts";
import {
  $git,
  $gitFetchWithDeepen,
  TRANSIENT_AUTH_PATTERNS,
  WORKING_TREE_GIT_ENV,
} from "../utils/gitAuth.ts";
import { executeLifecycleHook, type LifecycleHookFailure } from "../utils/lifecycle.ts";
import { $ } from "../utils/shell.ts";
import { resolveRepoCtx } from "./resolveRepoCtx.ts";
import type { ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";

type PushDestination = {
  remoteName: string;
  remoteBranch: string;
  url: string;
};

/**
 * get where git would actually push this branch.
 * prefers the stored destination from toolState (set by checkout_pr) when it
 * matches the current branch, because git config reads can silently fail in
 * certain environments causing pushes to the wrong remote branch.
 *
 * falls back to reading branch.X.pushRemote and branch.X.merge from git config,
 * and finally to origin/<branch> for branches created without checkout_pr.
 */
function getPushDestination(
  branch: string,
  storedDest: StoredPushDest | undefined,
  cwd: string
): PushDestination {
  // prefer stored destination from checkout_pr when it matches the current branch
  if (storedDest && storedDest.localBranch === branch) {
    log.debug(`using stored push destination: ${storedDest.remoteName}/${storedDest.remoteBranch}`);
    const url = $("git", ["remote", "get-url", "--push", storedDest.remoteName], {
      cwd,
      log: false,
    }).trim();
    return { remoteName: storedDest.remoteName, remoteBranch: storedDest.remoteBranch, url };
  }

  // fall back to git config (for branches not created by checkout_pr)
  try {
    const pushRemote = $("git", ["config", `branch.${branch}.pushRemote`], {
      cwd,
      log: false,
    }).trim();
    const merge = $("git", ["config", `branch.${branch}.merge`], { cwd, log: false }).trim();
    const remoteBranch = merge.replace(/^refs\/heads\//, "");
    const url = $("git", ["remote", "get-url", "--push", pushRemote], { cwd, log: false }).trim();
    return { remoteName: pushRemote, remoteBranch, url };
  } catch {
    // no push config - branch was created locally without checkout_pr
    log.debug(`no push config for ${branch}, falling back to origin/${branch}`);
    const url = $("git", ["remote", "get-url", "--push", "origin"], { cwd, log: false }).trim();
    return { remoteName: "origin", remoteBranch: branch, url };
  }
}

/**
 * normalize URL for comparison (handle .git suffix, case)
 */
function normalizeUrl(url: string): string {
  return url.replace(/\.git$/, "").toLowerCase();
}

// SECURITY: reject refs/branch names that begin with "-". git's parseopt
// accepts options intermixed with positional args, so a ref like
// "--upload-pack=evil" could be interpreted as a flag rather than a refspec.
export function rejectIfLeadingDash(value: string, kind: string): void {
  if (value.startsWith("-")) {
    throw new Error(`Blocked: ${kind} '${value}' starts with '-' — git could parse it as a flag.`);
  }
}

// SECURITY: branch inputs to push/delete must be bare branch names. a branch
// name like "refs/heads/main" bypasses the restricted-mode default-branch
// check below (which does exact-string compare against "main"), and symbolic
// refs (HEAD / FETCH_HEAD / ORIG_HEAD / MERGE_HEAD) would resolve to
// whatever commit those refs point at — both routes let an agent push to
// protected branches even under push: restricted. checkout_pr only ever
// stores bare names like "pr-123", so nothing legitimate relies on the
// refs/... form here.
const SYMBOLIC_REFS = new Set(["HEAD", "FETCH_HEAD", "ORIG_HEAD", "MERGE_HEAD"]);
export function rejectSpecialRef(value: string, kind: string): void {
  rejectIfLeadingDash(value, kind);
  if (value.startsWith("refs/")) {
    throw new Error(
      `Blocked: ${kind} '${value}' is a fully-qualified ref path. Use a bare branch name (e.g. 'feature/foo' or 'main'), not a 'refs/heads/...' form.`
    );
  }
  if (SYMBOLIC_REFS.has(value)) {
    throw new Error(
      `Blocked: ${kind} '${value}' is a git symbolic ref, not a branch name. Pass the resolved branch name (e.g. 'main'), or omit branchName to push the current branch.`
    );
  }
  // SECURITY: git interprets ':' and leading '+' as refspec syntax, not as
  // part of a branch name. without this check, an agent under push:restricted
  // can smuggle a full refspec through branchName:
  //   - "evil:refs/heads/main"  → pushes local 'evil' to remote main
  //   - ":refs/heads/main"      → deletes remote main
  //   - ":other"                → deletes remote 'other' under push:restricted
  //   - "+main"                 → force-push refspec
  // the default-branch guard downstream is an exact-string compare, so any
  // character that lets git parse the value as <src>:<dst> (or as a force
  // prefix) bypasses it. git's own check-ref-format forbids ':', '+', '^',
  // '~', '?', '*', '[', '\\', and whitespace in branch names, so rejecting
  // them here cannot false-positive against a legitimate branch name.
  const BAD = /[:+^~?*[\\\s]/;
  const badMatch = value.match(BAD);
  if (badMatch) {
    throw new Error(
      `Blocked: ${kind} '${value}' contains '${badMatch[0]}', which git interprets as refspec/revision syntax, not as part of a branch name.`
    );
  }
}

// SECURITY: validate tag names so the push_tags refspec can't be split into
// a <src>:<dst> refspec that targets a non-tag ref. without this, a tag like
// "foo:refs/heads/main" becomes "refs/tags/foo:refs/heads/main" and git
// pushes the local tag's commit to remote main — a back door around the
// branch-push rules in push_branch. keep the allow-list conservative (git's
// own check-ref-format forbids far more, but we only need enough to block
// refspec injection).
export function validateTagName(tag: string): void {
  rejectIfLeadingDash(tag, "tag");
  if (!/^[A-Za-z0-9._/-]+$/.test(tag)) {
    throw new Error(
      `Blocked: tag '${tag}' contains characters that could be parsed as a refspec or flag. Tags must match [A-Za-z0-9._/-]+.`
    );
  }
}

/**
 * whether this run pushes to the base repo (vs a contributor's fork). signed
 * commits only apply to the base repo — the app can't API-commit to a fork.
 * keyed off `toolState.pushUrl` (set by setupGit to the base URL, updated by
 * checkout_pr to the fork URL for fork PRs) rather than the remote *name*,
 * which is mutable git config an agent could rename.
 */
function pushesToBaseRepo(ctx: ToolContext): boolean {
  const baseUrl = `https://github.com/${ctx.repo.owner}/${ctx.repo.name}.git`;
  return normalizeUrl(primaryRepoState(ctx.toolState).pushUrl ?? "") === normalizeUrl(baseUrl);
}

/**
 * validate that the push destination matches expected URL.
 * pushUrl is set at checkout configuration (setupGit for the primary, checkout_repo for
 * secondaries) and updated by checkout_pr (fork repo).
 */
function validatePushDestination(
  repoState: RepoToolState,
  branch: string,
  cwd: string
): PushDestination {
  const pushUrl = repoState.pushUrl;
  if (!pushUrl) throw new Error("pushUrl not set - setupGit must run before push_branch");

  const dest = getPushDestination(branch, repoState.pushDest, cwd);

  if (normalizeUrl(dest.url) !== normalizeUrl(pushUrl)) {
    throw new Error(
      `Push blocked: destination does not match expected repository.\n` +
        `Expected: ${pushUrl}\n` +
        `Actual: remote '${dest.remoteName}' -> ${dest.url}\n` +
        `Git configuration may have been tampered with, or a url.*.insteadOf rewrite is in effect.`
    );
  }

  return dest;
}

export const PushBranch = type({
  branchName: type.string
    .describe("The branch name to push (defaults to current branch)")
    .optional(),
  force: type.boolean.describe("Force push (use with caution)").default(false),
  "repo?": type.string.describe(
    "cross-repo runs only: the writable secondary repo whose checkout to push from (bare name, from list_repos). omit for the primary repo."
  ),
});

/**
 * review-family modes (`NON_COMMITTING_MODES`: Review, IncrementalReview,
 * Plan) complete by submitting a review or a plan comment — they must never
 * write code to a branch. the behavioral mode is chosen at runtime via
 * `select_mode`, AFTER the tool set is registered, so the git-write tools
 * enforce this at call time rather than being withheld at build time. this is
 * the only reachable write path: git credentials are ASKPASS-ephemeral per
 * `$git()` call (no ambient credential for a raw shell `git push`), and the
 * native git tool blocks `push` outright. an undefined mode (select_mode not
 * yet called) is allowed — the block only fires once a review/plan mode is
 * committed. `commit_changes` writes via the API, not push, so it needs the
 * same gate.
 */
function assertWritableMode(ctx: ToolContext, toolName: string): void {
  const mode = ctx.toolState?.selectedMode;
  if (mode && NON_COMMITTING_MODES.has(mode)) {
    throw new Error(
      `${toolName} is blocked in ${mode} mode — review and plan runs must not push or commit code. ` +
        `finish by submitting your review (create_pull_request_review) or plan. ` +
        `if this PR genuinely needs a code change, that is a separate task from reviewing it.`
    );
  }
}

/** target guards shared by push_branch and commit_changes: the cross-PR
 * backstop and the default-branch block. the default-branch block fires in
 * restricted mode (any repo) and for every non-primary secondary — cross-repo
 * secondaries are PR-only by design, so a writable secondary must never push
 * straight to its default branch even when the primary's `push` is `enabled`. */
function assertPushTarget(
  ctx: ToolContext,
  params: {
    branch: string;
    pushDest: PushDestination;
    defaultBranch: string;
    access: RepoAccess;
  }
): void {
  const branch = params.branch;
  const pushDest = params.pushDest;
  // backstop against subagent-induced cross-PR clobbers: a subagent
  // shares cwd + toolState with the orchestrator, so its `checkout_pr(N)`
  // moves HEAD to pr-N and persists pushDest pointing at the foreign
  // PR's remote branch. refuse pr-N → origin/<other> pushes unless this
  // run is itself scoped to PR N (zed-industries/cloud, 2026-05-18).
  const prBranchMatch = branch.match(/^pr-(\d+)$/);
  if (prBranchMatch && pushDest.remoteBranch !== branch) {
    const prNumber = Number(prBranchMatch[1]);
    const event = ctx.payload.event;
    const runScoped = event.is_pr === true && event.issue_number === prNumber;
    if (!runScoped) {
      throw new Error(
        `push blocked: local branch '${branch}' would push to '${pushDest.remoteName}/${pushDest.remoteBranch}', ` +
          `but this run is not scoped to PR #${prNumber}. ` +
          `the 'pr-${prNumber}' branch was created by a prior checkout_pr call (likely from a subagent — subagents share the working tree and toolState with the orchestrator). ` +
          `you have probably landed your commit on the wrong branch. ` +
          `switch to your own feature branch first (e.g. 'git checkout <feature-branch>') and then push. ` +
          `if the push to PR #${prNumber} is intentional, this run needs to be triggered against that PR.`
      );
    }
  }

  // block default-branch pushes in restricted mode, and always on secondaries
  // (cross-repo write checkouts are PR-only — never a direct default-branch push).
  const blockDefaultBranch = ctx.payload.push === "restricted" || params.access !== "primary";
  if (blockDefaultBranch && pushDest.remoteBranch === params.defaultBranch) {
    const where = params.access === "primary" ? "" : ` of secondary repo '${pushDest.remoteName}'`;
    throw new Error(
      `Push blocked: cannot push directly to default branch '${pushDest.remoteBranch}'${where}. ` +
        `Create a feature branch and open a PR instead.`
    );
  }
}

/** run the repo's best-effort prepush hook with the per-run failure latch.
 * returns true when the hook was skipped due to an earlier failure.
 * `retryTool` names the tool the agent should re-invoke on failure. */
async function runPrepushHook(ctx: ToolContext, retryTool: string): Promise<boolean> {
  if (ctx.toolState.prepushFailureCount > 0) {
    log.info(`» skipping prepush hook (failed earlier this run)`);
    return true;
  }
  if (!ctx.prepushScript) return false;
  const prepushHook = await executeLifecycleHook({
    event: "prepush",
    script: ctx.prepushScript,
    shell: ctx.payload.shell,
  });
  if (prepushHook.failure) {
    ctx.toolState.prepushFailureCount += 1;
    throw new Error(
      buildPrepushFailureMessage({
        failure: prepushHook.failure,
        shell: ctx.payload.shell,
        retryTool,
      })
    );
  }
  return false;
}

// classify an error from `$git("push", ...)` to decide retry vs. recovery
// vs. rethrow. exported for tests.
//
// - `concurrent-push`: server-side compare-and-swap failed because the ref
//   advanced between fetch and push. recovery is fetch + integrate + retry.
//   matches both the client-side detection (`fetch first` /
//   `non-fast-forward`) and the server-side detection (`cannot lock ref`
//   with `is at <SHA1> but expected <SHA2>`).
// - `transient`: network or upstream server hiccup (RPC failed mid-stream,
//   HTTP 5xx, early EOF, reset, timeout, dns flake). push is idempotent so
//   verbatim retry with backoff is safe.
// - `unknown`: anything else (including auth/permission/protected-branch
//   rejections). retrying these wastes time; surface to the caller.
//
// kept conservative: a misclassification of `unknown` -> `transient` would
// cause two extra round-trips on a permanently-failing push, while the
// reverse (true transient labeled `unknown`) just falls back to current
// behavior. so we only mark as transient when the error string is
// unambiguously a network/server-side fault, not a refusal.
export type PushErrorKind = "concurrent-push" | "transient" | "transient-auth" | "unknown";

const CONCURRENT_PUSH_PATTERNS = ["fetch first", "non-fast-forward", "cannot lock ref"] as const;

// network/server-side faults — the token is fine, the wire blipped. retry the
// same token with backoff.
const TRANSIENT_PATTERNS: RegExp[] = [
  /RPC failed/i,
  /early EOF/,
  /the remote end hung up unexpectedly/,
  /Connection reset/i,
  /Could not resolve host/i,
  /Operation timed out/i,
  /HTTP\/2 stream \d+ was not closed cleanly/i,
  /unexpected disconnect while reading sideband packet/i,
  // libcurl HTTP 5xx surfaced by git over https. matches both the
  // libcurl-style "The requested URL returned error: 502" and the more
  // recent "HTTP 502" wording. most 4xx is intentionally excluded —
  // 401/403/404 indicate auth/permission problems that are not
  // retry-safe — but 429 (rate-limited / abuse detection) IS retry-safe
  // and GitHub occasionally surfaces it on git push, so it's included
  // explicitly below.
  /HTTP 5\d\d/,
  /returned error: 5\d\d/i,
  /HTTP 429/,
  /returned error: 429/i,
];

export function classifyPushError(msg: string): PushErrorKind {
  if (CONCURRENT_PUSH_PATTERNS.some((p) => msg.includes(p))) return "concurrent-push";
  if (TRANSIENT_AUTH_PATTERNS.some((p) => p.test(msg))) return "transient-auth";
  if (TRANSIENT_PATTERNS.some((p) => p.test(msg))) return "transient";
  return "unknown";
}

// exponential backoff delays before retry attempts 2-6. attempt 1 is the
// original push. used for network transients (5xx/reset/timeout) where the
// token is fine and the wire blipped. auth transients don't wait this out —
// they re-mint the token and retry on a short delay.
const TRANSIENT_RETRY_DELAYS_MS = [2000, 4000, 8000, 16000, 30000];

/**
 * push with retry on transient failures. two transient classes:
 *
 * - network/server-side (5xx, connection reset, timeout — TRANSIENT_PATTERNS):
 *   the token is valid, so back off and retry the SAME token.
 * - installation-token 401 ("Invalid username or token" — TRANSIENT_AUTH_PATTERNS):
 *   GitHub intermittently hands out a token its git edge never accepts; the
 *   token is poisoned for its whole life, so re-mint a fresh token via
 *   `refreshGitToken` and retry with it (the actual cure). when no refresh is
 *   available (external GH_TOKEN), it falls back to same-token backoff.
 *
 * concurrent-push and permission rejections are not retried — they need caller
 * intervention. shared by push_branch, push_tags, and delete_branch.
 */
async function pushWithRetry(
  args: string[],
  token: string,
  refreshGitToken: ((stale: string) => Promise<string>) | undefined,
  cwd: string = process.cwd()
): Promise<void> {
  let currentToken = token;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= TRANSIENT_RETRY_DELAYS_MS.length; attempt++) {
    try {
      await $git("push", args, { token: currentToken, cwd });
      if (attempt > 0) log.info(`push succeeded on attempt ${attempt + 1}`);
      return;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const kind = classifyPushError(msg);
      if (
        (kind === "transient" || kind === "transient-auth") &&
        attempt < TRANSIENT_RETRY_DELAYS_MS.length
      ) {
        // auth-class: re-mint a fresh token (the poisoned one never recovers)
        // and retry on a short delay. network-class: keep the token, back off.
        if (kind === "transient-auth" && refreshGitToken) {
          currentToken = await refreshGitToken(currentToken);
          const delay = Math.round(1000 * (0.75 + Math.random() * 0.5));
          log.info(
            `push attempt ${attempt + 1} failed (auth), re-minted token, retrying in ${delay}ms: ${msg.slice(0, 300)}`
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        // jitter avoids lockstep retries when several agents are hit by the
        // same upstream blip simultaneously.
        const baseDelay = TRANSIENT_RETRY_DELAYS_MS[attempt] ?? 5000;
        const delay = Math.round(baseDelay * (0.75 + Math.random() * 0.5));
        log.info(
          `push attempt ${attempt + 1} failed (transient), retrying in ${delay}ms: ${msg.slice(0, 300)}`
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export function PushBranchTool(ctx: ToolContext) {
  const primaryDefaultBranch = ctx.repo.defaultBranch;
  const pushPermission = ctx.payload.push;

  return tool({
    name: "push_branch",
    mutates: true,
    description:
      "Push the current branch to the remote repository. Omit branchName to push the current branch (recommended). " +
      'Example: `push_branch({})` to push the current branch. Example: `push_branch({ branchName: "pr-1" })` to push a specific local branch. ' +
      "If specifying branchName, use the LOCAL branch name (e.g., 'pr-1'), not the remote branch name. " +
      "The correct remote and remote branch are determined automatically from branch config set by checkout_pr. " +
      "Requires a clean working tree. Runs the repository prepush hook (if configured) — best-effort. If the hook fails, the tool returns the failure output and every subsequent call this run skips the hook. " +
      "Never force push unless explicitly requested. Pushes to the default branch are blocked in restricted mode. " +
      "If the response reports a timeout, the underlying push may have actually succeeded — verify with `git log origin/<branch>` (or this tool with command 'log') before retrying, otherwise you'll push a duplicate.",
    parameters: PushBranch,
    execute: execute(async ({ branchName, force, repo }) => {
      // permission check
      if (pushPermission === "disabled") {
        throw new Error(
          "Push is disabled for this run: the repository is read-only, or the person who triggered it has no write access."
        );
      }
      assertWritableMode(ctx, "push_branch");

      const rc = resolveRepoCtx(ctx, repo);
      if (rc.access === "read") {
        throw new Error(
          `push blocked: ${rc.owner}/${rc.name} is read-only (reference-only) in this run.`
        );
      }
      const cwd = rc.dir;
      const repoState = requireRepoState(ctx.toolState, rc.owner, rc.name);
      // primary's default branch comes from ctx.repo; secondaries store it at checkout_repo.
      const defaultBranch =
        rc.access === "primary" ? primaryDefaultBranch : repoState.defaultBranch || "main";

      const branch =
        branchName || $("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, log: false });
      // check the resolved branch too — rev-parse could surface a weird current
      // branch name that would otherwise bypass the user-facing check. use
      // rejectSpecialRef so "refs/heads/main" and symbolic refs like HEAD
      // can't slip past the default-branch guard below.
      rejectSpecialRef(branch, "branch");

      // signed-commits mode: same-repo commits are created directly on the
      // remote by commit_changes, so there is nothing to push. fork PRs keep
      // the git push path (the app can't API-commit to a contributor's fork).
      // signedCommits is the primary repo's setting — cross-repo secondaries
      // keep the normal push path (commit_changes only targets the primary).
      if (ctx.signedCommits && rc.access === "primary" && pushesToBaseRepo(ctx)) {
        throw new Error(
          "push_branch is not used in signed-commits mode — commits land on the remote via the commit_changes tool. " +
            "call commit_changes to commit your working-tree changes as a GitHub-signed commit. " +
            "if you already called commit_changes, your work is already on the remote — there is nothing left to push."
        );
      }

      // reject push if working tree is dirty — forces agent to commit or discard before pushing
      const status = $("git", ["status", "--porcelain"], { cwd, log: false });
      if (status) {
        throw new Error(
          `push blocked: working tree is not clean (tracked changes and/or untracked files). commit, discard, or remove stray artifacts before pushing.\n\n` +
            `git status:\n${status}` +
            (ctx.toolState.prepushFailureCount > 0
              ? "\n\nnote: the prepush hook failed earlier this run — once the working tree is clean, push_branch will skip the hook."
              : "")
        );
      }

      // validate push destination matches expected URL
      const pushDest = validatePushDestination(repoState, branch, cwd);
      assertPushTarget(ctx, { branch, pushDest, defaultBranch, access: rc.access });

      // use refspec when local and remote branch names differ
      const refspec =
        branch === pushDest.remoteBranch ? branch : `${branch}:${pushDest.remoteBranch}`;
      const pushArgs = force
        ? ["--force", "-u", pushDest.remoteName, refspec]
        : ["-u", pushDest.remoteName, refspec];

      // the prepush hook is a primary-repo setting — secondaries skip it.
      const prepushSkipped =
        rc.access === "primary" ? await runPrepushHook(ctx, "push_branch") : false;
      if (rc.access === "primary" && !prepushSkipped && ctx.prepushScript) {
        // re-verify clean working tree after prepush. a hook that writes tracked
        // files (formatter, type generator, build artifacts) would leave those
        // changes uncommitted — pushing now would silently drop them, and the
        // agent would report a "successful push" of code the hook had expected
        // to be included.
        const postHookStatus = $("git", ["status", "--porcelain"], { cwd, log: false });
        if (postHookStatus) {
          throw new Error(
            `push blocked: the prepush hook modified the working tree. those changes are not included in the push. commit or discard them (or change the hook to not mutate tracked files) before retrying.\n\n` +
              `git status:\n${postHookStatus}`
          );
        }
      }

      log.debug(`pushing ${branch} to ${pushDest.remoteName}/${pushDest.remoteBranch}`);
      if (force) {
        log.warning(`force pushing - this will overwrite remote history`);
      }

      // push is idempotent, so pushWithRetry rides out transient failures
      // (5xx, reset, freshly-minted-token 401). concurrent-push is not
      // transient — it surfaces here so we can render the integrate-and-retry
      // recovery the agent needs.
      try {
        await pushWithRetry(pushArgs, rc.gitToken, rc.refreshGitToken, cwd);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (classifyPushError(msg) === "concurrent-push") {
          // git rebase is blocked through the MCP tool when shell is disabled
          // (rebase --exec can execute arbitrary code). merge always works and
          // integrates remote changes cleanly, so suggest it as the default.
          const integrateStep =
            ctx.payload.shell === "disabled"
              ? `2. use the git tool to merge the remote branch into yours: git({ command: "merge", args: ["origin/${pushDest.remoteBranch}"] })`
              : `2. use the git tool to rebase or merge your changes on top: git({ command: "merge", args: ["origin/${pushDest.remoteBranch}"] }) (or 'rebase')`;
          throw new Error(
            `push rejected: the remote branch '${pushDest.remoteBranch}' has new commits you don't have locally (often a concurrent push to the same branch).\n\n` +
              `to resolve this:\n` +
              `1. use git_fetch to fetch the remote branch: git_fetch({ ref: "${pushDest.remoteBranch}" })\n` +
              `${integrateStep}\n` +
              `3. resolve any merge conflicts if needed\n` +
              `4. retry push_branch`
          );
        }
        throw err;
      }

      const pushedSha = $("git", ["rev-parse", "HEAD"], { cwd, log: false }).trim();
      log.info(
        `» pushed branch ${branch} to ${pushDest.remoteName}/${pushDest.remoteBranch} (sha ${pushedSha})`
      );

      const baseMsg = `successfully pushed ${branch} to ${pushDest.remoteName}/${pushDest.remoteBranch}`;
      const message = prepushSkipped
        ? `${baseMsg} (prepush hook skipped — failed earlier this run).`
        : baseMsg;

      return {
        success: true,
        branch,
        remoteBranch: pushDest.remoteBranch,
        remote: pushDest.remoteName,
        force,
        prepushSkipped,
        message,
      };
    }),
  });
}

/** agent-facing prepush failure message: script output + bypass guidance,
 * with no generic lifecycle retry advice (which would conflict). */
function buildPrepushFailureMessage(params: {
  failure: LifecycleHookFailure;
  shell: ToolContext["payload"]["shell"];
  retryTool: string;
}): string {
  const failure = params.failure;
  const header =
    failure.kind === "exit"
      ? `prepush hook failed with exit code ${failure.exitCode}.\n\nscript output:\n${failure.output || "(empty)"}`
      : failure.kind === "timeout"
        ? `prepush hook timed out — the script is hung or doing too much work.`
        : `prepush hook failed to spawn: ${failure.spawnError}.`;

  const ifRealBug =
    params.shell === "disabled"
      ? `fix it before pushing again — shell access is disabled in this run, so you can't re-run the hook command yourself.`
      : `run the hook command yourself via the shell tool to iterate (${params.retryTool} will NOT re-run it).`;

  return (
    `${header}\n\n` +
    `this repo's prepush hook is best-effort: the next ${params.retryTool} call will SKIP the hook and proceed. ` +
    `if the failure is unrelated to your changes (pre-existing breakage, flaky check), just call ${params.retryTool} again. ` +
    `if it could be a real bug in your code, ${ifRealBug}`
  );
}

/** distinguish "work already landed" and "stranded local commits" from a
 * genuinely clean tree — all three end in a clean worktree, and the wrong
 * diagnosis sends agents in circles. */
function buildNothingToCommitMessage(pushDest: PushDestination): string {
  const base = "nothing to commit — the working tree matches HEAD.";
  try {
    const remoteTip = $(
      "git",
      ["rev-parse", `refs/remotes/${pushDest.remoteName}/${pushDest.remoteBranch}`],
      { log: false }
    ).trim();
    const head = $("git", ["rev-parse", "HEAD"], { log: false }).trim();
    if (remoteTip === head) {
      return `${base} your work is already on ${pushDest.remoteName}/${pushDest.remoteBranch} — there is no push step in signed-commits mode.`;
    }
    $("git", ["merge-base", "--is-ancestor", remoteTip, "HEAD"], { log: false });
    return (
      `${base} but your local branch has commits that were never pushed — signed-commits mode can't push local commits. ` +
      `run git reset --mixed ${remoteTip} (keeps every change in the working tree), then retry commit_changes.`
    );
  } catch {
    return base;
  }
}

const CommitChanges = type({
  message: type.string.describe("Commit message (first line = subject)"),
  files: type.string
    .array()
    .describe("Optional subset of changed paths to commit. Defaults to every working-tree change.")
    .optional(),
});

export function CommitChangesTool(ctx: ToolContext) {
  const pushPermission = ctx.payload.push;

  return tool({
    name: "commit_changes",
    mutates: true,
    description:
      "Commit working-tree changes directly to the remote branch as a GitHub-signed (Verified) commit — this repository has signed commits enabled, so use this INSTEAD of git commit + push_branch. " +
      "Edit files locally, then call this tool: it detects every working-tree change (new, modified, deleted files), or commits a subset via `files`. " +
      "The commit lands on the remote immediately — there is no separate push step. The remote branch is created automatically on the first commit to a new local branch. " +
      "A merge in progress (git merge --no-commit) is concluded as a signed merge commit — resolve conflicts and git add first. " +
      "Runs the repository prepush hook (if configured) before committing — best-effort, same skip-on-failure behavior as push_branch.",
    parameters: CommitChanges,
    timeoutMs: 600_000,
    execute: execute(async (params) => {
      if (pushPermission === "disabled") {
        throw new Error(
          "Push is disabled for this run: the repository is read-only, or the person who triggered it has no write access."
        );
      }
      assertWritableMode(ctx, "commit_changes");

      const branch = $("git", ["rev-parse", "--abbrev-ref", "HEAD"], { log: false }).trim();
      if (branch === "HEAD") {
        throw new Error(
          "HEAD is detached — create or check out a branch before committing (e.g. git checkout -b pullfrog/<description>)."
        );
      }
      rejectSpecialRef(branch, "branch");

      // signed commits are a primary-repo concern: the tool operates on the
      // run's working directory and the base repo's branch.
      const pushDest = validatePushDestination(
        primaryRepoState(ctx.toolState),
        branch,
        process.cwd()
      );
      if (!pushesToBaseRepo(ctx)) {
        throw new Error(
          `'${branch}' pushes to the fork '${pushDest.url}', where the app can't create signed commits. ` +
            `commit locally via the git tool and use push_branch instead (those commits will be unsigned).`
        );
      }
      assertPushTarget(ctx, {
        branch,
        pushDest,
        defaultBranch: ctx.repo.defaultBranch,
        // commit_changes (signed commits) only ever targets the primary repo.
        access: "primary",
      });

      // run the hook before reading file content so formatter/codegen
      // effects land inside the commit instead of being silently dropped
      const prepushSkipped = await runPrepushHook(ctx, "commit_changes");

      const head = $("git", ["rev-parse", "HEAD"], { log: false }).trim();
      // a pending merge contributes MERGE_HEAD as a second parent: the API
      // commit becomes a true merge commit, so integrating the base branch
      // doesn't flatten its commits into the PR diff.
      let mergeHead = "";
      try {
        mergeHead = $("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { log: false }).trim();
      } catch {
        // no merge in progress
      }

      let changes = detectWorkingTreeChanges();
      if (params.files) {
        if (mergeHead) {
          throw new Error(
            "can't commit a subset of files while a merge is in progress — the merge commit must include every merged change. omit `files`."
          );
        }
        const requested = new Set(params.files);
        const known = new Set(changes.map((c) => c.path));
        const unknown = [...requested].filter((p) => !known.has(p));
        if (unknown.length > 0) {
          throw new Error(
            `no detected change at: ${unknown.join(", ")} — run git status to list changed paths.`
          );
        }
        changes = changes.filter((c) => requested.has(c.path));
      }
      // a merge that resolved to HEAD's tree (both sides made the same
      // change) still needs its empty merge commit to conclude
      if (changes.length === 0 && !mergeHead) {
        throw new Error(buildNothingToCommitMessage(pushDest));
      }
      await assertApiCommittable(changes);
      const parents = mergeHead ? [head, mergeHead] : [head];

      const result = await createSignedCommit({
        token: ctx.gitToken,
        owner: ctx.repo.owner,
        repo: ctx.repo.name,
        remoteBranch: pushDest.remoteBranch,
        message: params.message,
        parents,
        files: changes,
      });

      // resync the local clone: fetch the new commit, advance the local
      // branch to it, refresh the index. worktree files already match the
      // committed content, so leftovers from a `files` subset stay visible
      // in git status and nothing is lost.
      await $git(
        "fetch",
        [
          "--no-tags",
          "origin",
          `+refs/heads/${pushDest.remoteBranch}:refs/remotes/origin/${pushDest.remoteBranch}`,
        ],
        { token: ctx.gitToken }
      );
      $("git", ["update-ref", `refs/heads/${branch}`, result.sha], { log: false });
      if (mergeHead) {
        $("git", ["merge", "--quit"], { log: false });
      }
      $("git", ["reset", "-q"], { log: false });
      if (result.createdBranch) {
        // mirror what `git push -u` would have configured
        $("git", ["config", `branch.${branch}.remote`, "origin"], { log: false });
        $("git", ["config", `branch.${branch}.merge`, `refs/heads/${pushDest.remoteBranch}`], {
          log: false,
        });
      }

      log.info(
        `» created signed commit ${result.sha.slice(0, 7)} (${changes.length} file(s)) on ${pushDest.remoteName}/${pushDest.remoteBranch}`
      );

      return {
        success: true,
        sha: result.sha,
        branch,
        remoteBranch: pushDest.remoteBranch,
        files: changes.map((c) => (c.deleted ? `D ${c.path}` : c.path)),
        createdBranch: result.createdBranch,
        verified: true,
        prepushSkipped,
        message: `created signed commit ${result.sha.slice(0, 7)} on ${pushDest.remoteName}/${pushDest.remoteBranch}${result.createdBranch ? " (remote branch created)" : ""}`,
      };
    }),
  });
}

// commands that require authentication - redirect to dedicated tools.
// exported so tests can exercise the same table the runtime uses.
//
// note: the `pull` redirect intentionally does not mention `rebase` — under
// shell=disabled rebase is itself blocked by NOSHELL_BLOCKED_SUBCOMMANDS, so
// advertising it here would just send the agent into a second block. agents
// under shell=restricted/enabled who prefer rebase can invoke it directly;
// the redirect's job is to name the canonical alternative (merge), which
// works in all modes.
export const AUTH_REQUIRED_REDIRECT: Record<string, string> = {
  push: "use the push_branch tool instead — it handles authentication and permission checks.",
  fetch: "use the git_fetch tool instead — it handles authentication.",
  pull: "use git_fetch to fetch the remote ref, then call this git tool with command 'merge' locally.",
  clone: "the repository is already cloned. use checkout_pr for PR branches.",
};

// SECURITY: subcommands blocked when shell is disabled.
// in disabled mode the agent has no shell access, so these subcommands are the
// primary escape vectors for arbitrary code execution. in restricted mode the
// agent already has shell in a stripped sandbox, so blocking these is redundant.
// exported so tests stay in sync with the runtime table.
export const NOSHELL_BLOCKED_SUBCOMMANDS: Record<string, string> = {
  config: "Blocked: git config can set up filter drivers or hooks that execute arbitrary code.",
  submodule:
    "Blocked: git submodule can reference malicious repositories and execute code on update.",
  "update-index":
    "Blocked: git update-index can modify index entries in ways that bypass file protections.",
  "filter-branch": "Blocked: git filter-branch executes arbitrary code on repository history.",
  replace: "Blocked: git replace can redirect object lookups.",
  // subcommands that accept --exec or similar flags for arbitrary code execution
  rebase:
    "Blocked: git rebase --exec can execute arbitrary shell commands. Use 'merge' instead to integrate remote changes.",
  bisect:
    "Blocked: git bisect run can execute arbitrary shell commands. Bisect by hand (bisect start/good/bad/reset) is not available through this tool either — ask the user to run the bisect if needed.",
  // difftool/mergetool exist to shell out to external diff/merge programs.
  // both accept `--extcmd` / `-x` (difftool) or configured tool commands
  // (mergetool) that run arbitrary code. NOSHELL_BLOCKED_ARGS catches the
  // long `--extcmd` form, but not the `-x` short form — and globally blocking
  // `-x` would false-positive on `git cherry-pick -x`. block the subcommands
  // wholesale instead; neither has a meaningful use in an automated agent
  // workflow (agents use `git diff` / `git show` for diffs and resolve
  // conflicts via file edits, not a TUI merge tool).
  difftool:
    "Blocked: git difftool runs an external diff program via --extcmd/-x or configured tool and can execute arbitrary shell commands. Use 'diff' (or 'show' for single commits) to inspect changes — those output directly and don't invoke an external tool.",
  mergetool:
    "Blocked: git mergetool runs an external merge program configured via mergetool.<name>.cmd and can execute arbitrary shell commands. Resolve conflicts by editing the files directly (conflict markers are written into the working tree) and then commit.",
};

// SECURITY: subcommand-specific arg flags that execute code.
// only blocked when shell is disabled — in restricted mode the agent already
// has shell access in a stripped sandbox, so these provide no additional security.
//
// NOTE: global git flags like -c and --config-env are NOT included here
// because they only work before the subcommand. in the MCP tool, the
// subcommand is always first, so -c in args is parsed as a subcommand flag
// (e.g., git log -c = combined diff format), not config injection.
// the subcommand check (rejecting "-" prefix) already blocks that attack.
//
// matched as: arg === flag OR arg starts with flag + "="
// (avoids false positives like --exclude matching --exec).
// exported so tests stay in sync with the runtime flag set.
export const NOSHELL_BLOCKED_ARGS = ["--exec", "--extcmd", "--upload-pack", "--receive-pack"];

const COLLAPSE_THRESHOLD = 200;

/** above this, the full body is spilled to a tmp file and only a short head
 * preview is logged + returned inline. mirrors `capOutput` in `mcp/shell.ts`
 * (which uses 5000 for shell commands; diff/log outputs need more headroom).
 * the operator log gets a single summary line instead of a 1000+ line dump. */
const MAX_GIT_OUTPUT_CHARS = 50_000;
const OVERFLOW_PREVIEW_LINES = 50;
/** absolute char cap on the inline preview, in case the first
 * `OVERFLOW_PREVIEW_LINES` lines contain a minified blob / binary diff /
 * single very long line that would blow the agent's context anyway. */
const OVERFLOW_PREVIEW_MAX_CHARS = 5_000;

/** detect refs in `git diff` args that would produce a symmetric (two-dot)
 * diff including the inverse of commits that landed on `<ref>` since the
 * branch forked. returns the offending arg + the ref that's ahead + count of
 * unmerged commits, or null if the call is safe. silently ignores args that
 * aren't refs (paths, pathspecs), three-dot ranges (those are merge-base
 * diffs, the correct shape), and any call passing `--merge-base` (git's own
 * shorthand for a merge-base diff, also safe). see [run 26545933188](https://github.com/pullfrog/app/actions/runs/26545933188)
 * for the failure mode this guards against. */
function detectSymmetricDiffTrap(
  args: string[],
  cwd: string
): { arg: string; aheadRef: string; ahead: number } | null {
  // git's own `--merge-base` flag (2.30+) produces a safe merge-base diff
  // regardless of the positional ref; the GHA runner has git 2.54.x.
  if (args.includes("--merge-base")) return null;
  // ignore everything after `--` (pathspec separator)
  const endIdx = args.indexOf("--");
  const positionals = (endIdx === -1 ? args : args.slice(0, endIdx)).filter(
    (a) => !a.startsWith("-")
  );
  for (const p of positionals) {
    if (p.includes("...")) continue; // three-dot = merge-base diff, safe
    // bare ref `A`: implicit second side is HEAD; agent's intent is
    // "what my branch changed vs <ref>". fires when <ref> has commits HEAD
    // doesn't (branch behind base). diffs against an ancestor (HEAD ahead
    // of <ref>) are the legitimate "what did I add since X" case and must
    // not be blocked.
    //
    // two-dot range `A..B`: degenerate when one side is an ancestor of the
    // other (the tree diff equals the merge-base diff — safe). only the
    // truly-diverged case (BOTH sides have commits the other lacks) pulls
    // unwanted inverse-of-progress into the diff. shorthand expansions:
    // `A..` → `A..HEAD`, `..A` → `HEAD..A`.
    if (p.includes("..")) {
      const parts = p.split("..");
      if (parts.length !== 2) continue;
      const left = parts[0] || "HEAD";
      const right = parts[1] || "HEAD";
      const leftAhead = countAhead(right, left, cwd);
      const rightAhead = countAhead(left, right, cwd);
      if (leftAhead === null || rightAhead === null) continue;
      // `countAhead` is a reachability walk that stops at the shallow boundary
      // and needs no common ancestor, so on a grafted checkout it happily
      // reports divergence across the graft — and then every remedy this trap
      // prescribes is merge-base-based and guaranteed to fail on that same
      // checkout. the symmetric tree diff is the only meaningful answer left,
      // so let it through rather than sending the agent into a dead end (#1139).
      if (leftAhead > 0 && rightAhead > 0 && hasMergeBase(left, right, cwd)) {
        const aheadRef = leftAhead >= rightAhead ? left : right;
        return { arg: p, aheadRef, ahead: Math.max(leftAhead, rightAhead) };
      }
      continue;
    }
    const ahead = countAhead("HEAD", p, cwd);
    if (ahead === null) continue;
    if (ahead > 0 && hasMergeBase("HEAD", p, cwd)) return { arg: p, aheadRef: p, ahead };
  }
  return null;
}

/**
 * do the two endpoints share a common ancestor? on a shallow, grafted checkout
 * they may not, and every remedy `detectSymmetricDiffTrap` prescribes is
 * merge-base-based. see #1139.
 */
function hasMergeBase(a: string, b: string, cwd: string): boolean {
  try {
    return $("git", ["merge-base", a, b], { cwd, log: false }).trim().length > 0;
  } catch {
    return false;
  }
}

/** `rev-list --count head..base` = commits on `base` not on `head`. returns
 * null if either ref is unresolvable (probably a pathspec). */
function countAhead(head: string, base: string, cwd: string): number | null {
  try {
    const out = $("git", ["rev-list", "--count", `${head}..${base}`], { cwd, log: false }).trim();
    const n = parseInt(out, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** persist `output` to a tmp file and return an agent-facing string that
 * leads with a head preview and ends with a sentinel pointing at the path.
 * keeps the operator log to a single summary line for the overflow case. */
function spillGitOutput(params: {
  command: string;
  args: string[];
  output: string;
  lineCount: number;
}): { output: string; outputPath: string } {
  const tempDir = process.env.PULLFROG_TEMP_DIR;
  if (!tempDir) throw new Error("PULLFROG_TEMP_DIR not set");
  const outputPath = join(tempDir, `git-${params.command}-${randomUUID().slice(0, 8)}.txt`);
  writeFileSync(outputPath, params.output);
  const previewByLines = params.output.split("\n").slice(0, OVERFLOW_PREVIEW_LINES).join("\n");
  const preview =
    previewByLines.length <= OVERFLOW_PREVIEW_MAX_CHARS
      ? previewByLines
      : `${previewByLines.slice(0, OVERFLOW_PREVIEW_MAX_CHARS)}…`;
  log.info(
    `» git ${params.command} ${params.args.join(" ")}: ${params.lineCount} lines / ${params.output.length} chars → ${outputPath}`
  );
  return {
    output: `${preview}\n\n... [output truncated; full ${params.lineCount}-line / ${params.output.length}-char body saved to ${outputPath} — read selectively with \`read({ filePath: "${outputPath}" })\`] ...`,
    outputPath,
  };
}

// SECURITY: subcommand must match [a-z][a-z0-9-]* to reject flags passed as the subcommand.
// this blocks injection of global git options like -c, -C, --exec-path, --config-env, etc.
//
// critical attack: git -c "alias.x=!evil-command" x
//   -> sets alias "x" to a shell command via -c config injection, then runs it
//   -> achieves arbitrary code execution even with shell=disabled
const subcommandPattern = regex("^[a-z][a-z0-9-]*$");

/**
 * Two malformed-but-unambiguous shapes the models keep emitting: `args[0]`
 * repeating the subcommand, and the whole cmdline pushed into `args` behind
 * `command: "git"`. Both were rejected (or, for the second, run as `git git
 * log …`) and the models re-emitted the byte-identical call rather than
 * adapting — 368 dead round trips over 190 runs in 24h (#1199). The intent is
 * knowable, so normalize rather than reject.
 *
 * The promotion out of `command: "git"` re-clears `subcommandPattern`: without
 * that, `args: ["-c", "alias.x=!evil", "x"]` would move a global git option
 * into the subcommand slot that pattern exists to guard.
 */
export function normalizeGitInvocation(input: { command: string; args: string[] }): {
  command: string;
  args: string[];
} {
  let command = input.command;
  let args = input.args;
  while (command === "git" && args[0] !== undefined && subcommandPattern.test(args[0])) {
    command = args[0];
    args = args.slice(1);
  }
  // git would otherwise read the duplicate as a pathspec and silently return
  // clean/empty output on a dirty tree. a real pathspec stays reachable via the
  // documented `args: ["--", "<path>"]` form.
  if (args[0]?.toLowerCase() === command.toLowerCase()) args = args.slice(1);
  return { command, args };
}

/**
 * git subcommands whose exit 1 is a documented result rather than a failure.
 * The status code IS the answer and both streams are empty by design, so
 * anything that reads "non-zero means broken" reports a successful negative as
 * an error. See #1152; `merge-base --is-ancestor` keeps its own branch because
 * it returns a boolean rather than a note.
 */
export function describeEmptyResult(command: string, args: string[]): string | null {
  if (command === "grep") return "no matches";
  if (command === "check-ignore") return "none of the given paths are ignored";
  if (command === "show-ref") return "no matching ref";
  if (command === "merge-base" && args.includes("--fork-point")) return "no fork point";
  if (
    (command === "diff" || command === "diff-index" || command === "diff-tree") &&
    (args.includes("--quiet") || args.includes("--exit-code"))
  ) {
    return "differences found";
  }
  return null;
}

const Git = type({
  command: type(subcommandPattern).describe("Git command (e.g., 'status', 'log', 'diff')"),
  args: type.string.array().describe("Additional arguments for the git command").optional(),
  "repo?": type.string.describe(
    "cross-repo runs only: run this git command inside the named secondary repo's checkout (bare name, from list_repos). omit for the primary repo."
  ),
});

export function GitTool(ctx: ToolContext) {
  return tool({
    name: "git",
    description:
      "Run a git subcommand. `command` is the subcommand ONLY — never repeat it inside `args`. " +
      "`args` is optional; omit it entirely for no-flag invocations like plain `git status`. " +
      'Example: `git({ command: "status" })` for plain `git status`. ' +
      'Example: `git({ command: "log", args: ["--oneline", "-n", "20"] })`. ' +
      'Example: `git({ command: "diff", args: ["--merge-base", "origin/main"] })` — merge-base diff including uncommitted edits (single MCP call). ' +
      'Example: `git({ command: "diff", args: ["origin/main...HEAD"] })` — three-dot, committed-only changes vs merge-base. ' +
      "For PR-scope diffs ALWAYS use `--merge-base <base>` or three-dot `<base>...HEAD`. " +
      "Bare `<base>` and two-dot `<base>..HEAD` are symmetric (working-tree-or-HEAD vs ref): when your branch is behind `<base>` they include the inverse of every commit on `<base>` you lack — pure noise, and this tool will reject those forms when the divergence is detected. " +
      "Output >50K chars is spilled to a tmp file; the tool returns a head preview + path you can `read` selectively. " +
      "For push/fetch, use the dedicated MCP tools (push_branch, git_fetch). " +
      "git pull is not available — use git_fetch then this tool with command 'merge'.",
    parameters: Git,
    execute: execute(async (params) => {
      const invocation = normalizeGitInvocation({
        command: params.command,
        args: params.args ?? [],
      });
      const command = invocation.command;
      const args = invocation.args;
      const cwd = resolveRepoCtx(ctx, params.repo).dir;

      // only reachable when args[0] is not a subcommand (a flag, a path); git's
      // own `git: 'git' is not a git command` says nothing about our contract.
      if (command === "git") {
        throw new Error(
          "git: 'command' is the subcommand only — pass e.g. " +
            'git({ command: "log", args: ["--oneline"] }), not command: "git".'
        );
      }

      const redirect = AUTH_REQUIRED_REDIRECT[command];
      if (redirect) {
        if (command === "push" && ctx.signedCommits) {
          throw new Error(
            "git push is not available through this tool — in signed-commits mode use commit_changes instead: it commits your working-tree changes directly to the remote as a GitHub-signed commit (push_branch only applies to fork PRs)."
          );
        }
        throw new Error(`git ${command} is not available through this tool — ${redirect}`);
      }

      // signed-commits mode: local commits can never reach the remote (the
      // app only accepts API-created signed commits via commit_changes), so
      // block commit-creating subcommands for same-repo work up front. merge
      // stays available with --no-commit so conflict resolution still works;
      // commit_changes concludes the pending merge as a signed merge commit.
      // fork-PR branches keep plain git semantics (signing is impossible there).
      if (ctx.signedCommits && (command === "commit" || command === "merge")) {
        if (pushesToBaseRepo(ctx)) {
          if (command === "commit") {
            throw new Error(
              "git commit is blocked in signed-commits mode — use the commit_changes tool instead. " +
                "it commits your working-tree changes directly to the remote as a GitHub-signed (Verified) commit. " +
                "if you are concluding a merge, stage the resolutions with git add and call commit_changes — no local commit is needed."
            );
          }
          const noLocalCommit = args.some(
            (a) => a === "--no-commit" || a === "--abort" || a === "--quit"
          );
          if (!noLocalCommit) {
            throw new Error(
              "bare git merge would create a local commit, which can't be pushed in signed-commits mode. " +
                "use git merge --no-commit <ref>, resolve any conflicts, git add the results, then call commit_changes — " +
                "it concludes the merge as a signed merge commit."
            );
          }
        }
      }

      // SECURITY: block dangerous subcommands when shell is disabled.
      // in restricted mode the agent has shell in a stripped sandbox, so blocking
      // these through the MCP tool is redundant (agent can do it via shell).
      if (ctx.payload.shell === "disabled") {
        const blocked = NOSHELL_BLOCKED_SUBCOMMANDS[command];
        if (blocked) {
          throw new Error(blocked);
        }

        // block subcommand-specific flags that execute arbitrary code
        for (const arg of args) {
          const isBlocked = NOSHELL_BLOCKED_ARGS.some(
            (flag) => arg === flag || arg.startsWith(flag + "=")
          );
          if (isBlocked) {
            throw new Error(
              `Blocked: '${arg}' flag can execute arbitrary code and is not allowed.`
            );
          }
        }
      }

      // reject symmetric (two-dot or bare-ref) diffs whose endpoints have
      // commits each other doesn't — those include the *inverse* of every
      // commit on the diverged side, ballooning the diff and confusing
      // reviewer subagents. three-dot (`A...B`) and `--merge-base` are
      // always allowed (both produce merge-base diffs).
      if (command === "diff") {
        const trap = detectSymmetricDiffTrap(args, cwd);
        if (trap) {
          throw new Error(
            `git diff '${trap.arg}' would include the inverse of ${trap.ahead} commit(s) on '${trap.aheadRef}' that aren't on the other side — that's a symmetric tree diff full of upstream noise, not your branch's own changes.\n\n` +
              `use one of:\n` +
              `  - git diff --merge-base ${trap.aheadRef}     (one MCP call; merge-base diff, includes uncommitted edits)\n` +
              `  - git diff ${trap.aheadRef}...HEAD            (three-dot; merge-base diff of committed-only changes)\n\n` +
              `if you ALSO need the PR's pre-formatted diff, the orchestrator's checkout_pr response includes a \`diffPath\` you can \`read\` directly without invoking git at all.`
          );
        }
      }

      // `git merge-base --is-ancestor` uses exit codes as data: 0 = ancestor,
      // 1 = not-an-ancestor, >1 = real error. Surface the binary answer
      // instead of throwing on exit 1. see #766.
      if (command === "merge-base" && args.includes("--is-ancestor")) {
        let isAncestor = true;
        $("git", [command, ...args], {
          cwd,
          log: false,
          onError: (r) => {
            if (r.status === 1) {
              isAncestor = false;
              return;
            }
            const detail = [r.stderr, r.stdout]
              .map((s) => s.trim())
              .filter(Boolean)
              .join("\n");
            throw new Error(
              `git merge-base --is-ancestor failed (exit ${r.status}): ${detail || "Unknown error"}`
            );
          },
        });
        return { success: true, isAncestor };
      }

      // exit 1 from these carries the ANSWER, and both streams are
      // deliberately empty, so `$()`'s `detail || "Unknown error"` fallback
      // handed the model the word "error" for a successful negative result.
      // that cost a turn every time and, worse, let a review conclude it had
      // been unable to check rather than that it checked and found nothing
      // (#1152). same idea as the `--is-ancestor` branch above, generalized.
      const emptyResult = describeEmptyResult(command, args);
      let noResult = false;
      const output = $("git", [command, ...args], {
        cwd,
        log: false,
        env: WORKING_TREE_GIT_ENV,
        onError: (r) => {
          if (r.status === 1 && emptyResult && !r.stderr.trim() && !r.stdout.trim()) {
            noResult = true;
            return;
          }
          const detail = [r.stderr, r.stdout]
            .map((s) => s.trim())
            .filter(Boolean)
            .join("\n");
          throw new Error(
            `Command failed with exit code ${r.status}: ${detail || `no output from \`git ${command} ${args.join(" ")}\``}`
          );
        },
      });
      if (noResult) return { success: true, output: "", note: emptyResult };
      const lineCount = output.split("\n").length;
      if (output.length > MAX_GIT_OUTPUT_CHARS) {
        const spilled = spillGitOutput({ command, args, output, lineCount });
        return { success: true, output: spilled.output, outputPath: spilled.outputPath };
      }
      if (lineCount > COLLAPSE_THRESHOLD) {
        log.group(`git ${command} output (${lineCount} lines)`, () => {
          log.info(output);
        });
      } else if (output) {
        log.info(output);
      }

      return { success: true, output };
    }),
  });
}

const GitFetch = type({
  ref: type.string.describe("Ref to fetch: branch name, tag, or 'pull/N/head' for PRs"),
  depth: type.number.describe("Fetch depth (for shallow clones)").optional(),
  "repo?": type.string.describe(
    "cross-repo runs only: fetch inside the named secondary repo's checkout (bare name, from list_repos). omit for the primary repo."
  ),
});

export function GitFetchTool(ctx: ToolContext) {
  return tool({
    name: "git_fetch",
    description:
      "Fetch refs from remote repository. Use this instead of git fetch directly. " +
      'Example: `git_fetch({ ref: "main" })`. With depth: `git_fetch({ ref: "pull/1234/head", depth: 1 })`.',
    parameters: GitFetch,
    execute: execute(async (params) => {
      rejectIfLeadingDash(params.ref, "ref");
      const rc = resolveRepoCtx(ctx, params.repo);
      const fetchArgs = ["--no-tags", "origin", params.ref];
      if (params.depth !== undefined) {
        fetchArgs.push(`--depth=${params.depth}`);
      }
      await $gitFetchWithDeepen(
        fetchArgs,
        { token: rc.gitToken, cwd: rc.dir, refreshGitToken: rc.refreshGitToken },
        "git_fetch"
      );
      return { success: true, ref: params.ref };
    }),
  });
}

const DeleteBranch = type({
  branchName: type.string.describe("Remote branch to delete"),
});

export function DeleteBranchTool(ctx: ToolContext) {
  const pushPermission = ctx.payload.push;
  const defaultBranch = ctx.repo.defaultBranch;

  return tool({
    name: "delete_branch",
    mutates: true,
    description:
      "Delete a remote branch. Requires push: enabled permission. " +
      "Deletion of the repository's default branch is always blocked regardless of permission mode.",
    parameters: DeleteBranch,
    execute: execute(async (params) => {
      if (pushPermission !== "enabled") {
        throw new Error(
          "Branch deletion requires push: enabled permission. " +
            "Current mode only allows pushing to non-protected branches."
        );
      }
      assertWritableMode(ctx, "delete_branch");

      // delete_branch is already gated on push: enabled, but also block the
      // refs/heads/... and symbolic-ref forms so this tool can't be tricked
      // into deleting a protected ref that wouldn't match a bare-name check.
      rejectSpecialRef(params.branchName, "branchName");

      // defense-in-depth: deleting the default branch is catastrophic and
      // unlike pushing to main it has no easy revert path (GitHub retains
      // refs for 30 days but restoring requires the reflog or a direct SHA).
      // push: enabled authorizes pushes, not wholesale removal of the
      // repository's primary branch. block it locally even if GitHub branch
      // protection would also reject — some repos disable protection on
      // default branches and we should not rely on that config for safety.
      if (params.branchName === defaultBranch) {
        throw new Error(
          `Blocked: cannot delete the default branch '${defaultBranch}'. ` +
            `If you really need to delete or rename it, do it manually via the repository settings.`
        );
      }

      // use refs/heads/<name> explicitly so a same-named tag can't be deleted
      // by accident. `push --delete <bare-name>` resolves against both remote
      // branches and tags; a tag-only match would silently remove the tag.
      // rejectSpecialRef guarantees branchName is a bare name, so the
      // branchName construction here can't collide with user-supplied refs.
      await pushWithRetry(
        ["origin", "--delete", `refs/heads/${params.branchName}`],
        ctx.gitToken,
        ctx.refreshGitToken
      );
      log.info(`» deleted branch ${params.branchName}`);
      return { success: true, deleted: params.branchName };
    }),
  });
}

const PushTags = type({
  tag: type.string.describe("Tag name to push"),
  force: type.boolean.describe("Force push the tag").default(false),
});

export function PushTagsTool(ctx: ToolContext) {
  const pushPermission = ctx.payload.push;

  return tool({
    name: "push_tags",
    mutates: true,
    description: "Push a tag to remote. Requires push: enabled permission.",
    parameters: PushTags,
    execute: execute(async (params) => {
      if (pushPermission !== "enabled") {
        throw new Error(
          "Tag pushing requires push: enabled permission. " +
            "Current mode only allows pushing branches."
        );
      }
      assertWritableMode(ctx, "push_tags");

      validateTagName(params.tag);
      const pushArgs = [...(params.force ? ["-f"] : []), "origin", `refs/tags/${params.tag}`];
      await pushWithRetry(pushArgs, ctx.gitToken, ctx.refreshGitToken);
      log.info(`» pushed tag ${params.tag}`);
      return { success: true, tag: params.tag };
    }),
  });
}
