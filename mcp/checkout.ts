import { createHash } from "node:crypto";
import { statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Octokit, RestEndpointMethodTypes } from "@octokit/rest";
import { type } from "arktype";
import * as yes from "yes";
import { primaryRepoState, type RepoToolState, requireRepoState } from "../toolState.ts";
import { createChangeImpactArtifact } from "../utils/changeImpact.ts";
import { log } from "../utils/cli.ts";
import { countLines, createDiffCoverageState } from "../utils/diffCoverage.ts";
import { $git, $gitFetchWithDeepen, DEEPEN_RETRY_DEPTH } from "../utils/gitAuth.ts";
import { executeLifecycleHook } from "../utils/lifecycle.ts";
import { computeIncrementalDiff } from "../utils/rangeDiff.ts";
import { $ } from "../utils/shell.ts";
import { rejectIfLeadingDash } from "./git.ts";
import { commentableLinesForFile } from "./review.ts";
import type { ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";

type PullFile = RestEndpointMethodTypes["pulls"]["listFiles"]["response"]["data"][number];

export type FormatFilesResult = {
  content: string;
  toc: string;
};

export type FetchAndFormatPrDiffResult = FormatFilesResult & {
  files: PullFile[];
};

/**
 * formats PR files with explicit line numbers for each code line.
 * preserves all original diff info (file headers, hunk headers) and adds:
 * | OLD | NEW | TYPE | code
 * returns both the formatted content and a TOC with line ranges per file.
 */
export function formatFilesWithLineNumbers(files: PullFile[]): FormatFilesResult {
  const output: string[] = [];
  const tocEntries: Array<{ filename: string; startLine: number; endLine: number }> = [];

  // calculate TOC header size: "## Files (N)\n" + N entries + "\n---\n\n"
  const tocHeaderSize = 1 + files.length + 2;
  let currentLine = tocHeaderSize + 1;

  for (const file of files) {
    const fileStartLine = currentLine;

    // file header
    output.push(`diff --git a/${file.filename} b/${file.filename}`);
    output.push(`--- a/${file.filename}`);
    output.push(`+++ b/${file.filename}`);
    currentLine += 3;

    if (!file.patch) {
      output.push("(binary file or no changes)");
      output.push("");
      currentLine += 2;
      tocEntries.push({
        filename: file.filename,
        startLine: fileStartLine,
        endLine: currentLine - 1,
      });
      continue;
    }

    // parse and format the patch with line numbers
    const lines = file.patch.split("\n");
    let oldLine = 0;
    let newLine = 0;

    for (const line of lines) {
      // hunk header: @@ -OLD,COUNT +NEW,COUNT @@ optional context
      const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunkMatch) {
        oldLine = parseInt(hunkMatch[1], 10);
        newLine = parseInt(hunkMatch[2], 10);
        output.push(line); // pass through unchanged
        currentLine++;
        continue;
      }

      // code lines within hunks
      const changeType = line[0] || " ";
      const code = line.slice(1);

      if (changeType === "-") {
        // removed line: show old line number, no new line number
        output.push(`| ${padNum(oldLine)} |      | - | ${code}`);
        oldLine++;
      } else if (changeType === "+") {
        // added line: no old line number, show new line number
        output.push(`|      | ${padNum(newLine)} | + | ${code}`);
        newLine++;
      } else if (changeType === " " || changeType === "\\") {
        // context line or "\ No newline at end of file"
        if (changeType === "\\") {
          output.push(line); // pass through as-is
        } else {
          output.push(`| ${padNum(oldLine)} | ${padNum(newLine)} |   | ${code}`);
          oldLine++;
          newLine++;
        }
      } else {
        // unknown line type, pass through
        output.push(line);
      }
      currentLine++;
    }
    output.push(""); // blank line between files
    currentLine++;

    tocEntries.push({
      filename: file.filename,
      startLine: fileStartLine,
      endLine: currentLine - 1,
    });
  }

  // build TOC. each entry includes the precomputed sha256 anchor used in
  // github PR Files Changed URLs (#diff-<hex>), so the agent never needs to
  // shell out to sha256sum.
  const tocLines = [`## Files (${files.length})`];
  for (const entry of tocEntries) {
    const anchor = createHash("sha256").update(entry.filename).digest("hex");
    tocLines.push(
      `- ${entry.filename} → lines ${entry.startLine}-${entry.endLine} · diff-${anchor}`
    );
  }
  tocLines.push("");
  tocLines.push("---");
  tocLines.push("");

  const toc = tocLines.join("\n");
  const content = toc + output.join("\n");

  return { content, toc };
}

function padNum(n: number): string {
  return n.toString().padStart(4, " ");
}

export const CheckoutPr = type({
  pull_number: type.number.describe("the pull request number to checkout"),
});

export type CheckoutPrResult = {
  success: true;
  number: number;
  title: string;
  body: string | null;
  base: string;
  localBranch: string;
  remoteBranch: string;
  isFork: boolean;
  maintainerCanModify: boolean;
  url: string;
  headRepo: string;
  diffPath: string;
  impactPath?: string | undefined;
  incrementalDiffPath?: string | undefined;
  toc: string;
  commitCount: number;
  commitLog: string;
  /** true when commitLog was capped because the PR has more commits than we render */
  commitLogTruncated: boolean;
  /** true when commit metadata could not be computed (e.g. base ref unreachable after shallow fetch). commitCount/commitLog are zero/empty in that case, not "no commits". */
  commitLogUnavailable: boolean;
  /** non-fatal warning from the post-checkout lifecycle hook, if any */
  hookWarning?: string | undefined;
  instructions: string;
};

/**
 * fetches PR files from GitHub and formats them with line numbers and TOC.
 * this is the core diff formatting logic, extracted for testability.
 */
export async function fetchAndFormatPrDiff(
  ctx: ToolContext,
  pullNumber: number
): Promise<FetchAndFormatPrDiffResult> {
  const files = await ctx.octokit.paginate(ctx.octokit.rest.pulls.listFiles, {
    owner: ctx.repo.owner,
    repo: ctx.repo.name,
    pull_number: pullNumber,
    per_page: 100,
  });
  return { ...formatFilesWithLineNumbers(files), files };
}

import { captureInitialHead, type GitContext } from "../utils/setup.ts";

export type PrData = {
  number: number;
  headSha: string;
  headRef: string;
  headRepoFullName: string;
  baseRef: string;
  baseRepoFullName: string;
  maintainerCanModify: boolean;
};

type EnsureBeforeShaParams = {
  sha: string;
  octokit: Octokit;
  owner: string;
  repo: string;
  gitToken: string;
  refreshGitToken?: ((stale: string) => Promise<string>) | undefined;
  isShallow: boolean;
  signal: AbortSignal;
};

type CreateTempBranchParams = {
  octokit: Octokit;
  owner: string;
  repo: string;
  ref: string;
  sha: string;
};

async function createTempBranch(params: CreateTempBranchParams) {
  const response = await params.octokit.rest.git.createRef({
    owner: params.owner,
    repo: params.repo,
    ref: `refs/heads/${params.ref}`,
    sha: params.sha,
  });
  return {
    data: response.data,
    async [Symbol.asyncDispose]() {
      try {
        await params.octokit.rest.git.deleteRef({
          owner: params.owner,
          repo: params.repo,
          ref: `heads/${params.ref}`,
        });
        log.debug(`» deleted temp branch ${params.ref}`);
      } catch (e) {
        log.debug(
          `» failed to delete temp branch ${params.ref}: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    },
  };
}

async function ensureBeforeShaReachable(params: EnsureBeforeShaParams): Promise<boolean> {
  try {
    $("git", ["cat-file", "-t", params.sha], { log: false });
    log.debug(`» before_sha ${params.sha.slice(0, 7)} is reachable`);
    return true;
  } catch {
    // not available locally — create a temporary branch to fetch it
  }

  const tempBranch = `pullfrog/tmp/${params.sha.slice(0, 12)}`;
  try {
    log.debug(`» before_sha ${params.sha.slice(0, 7)} not reachable, creating temp branch...`);
    await using _ref = await createTempBranch({
      octokit: params.octokit,
      owner: params.owner,
      repo: params.repo,
      sha: params.sha,
      ref: tempBranch,
    });
    // NOT `--depth=1`: that lands `beforeSha` as a brand-new shallow root with
    // zero ancestry, which is strictly worse than not fetching it — `cat-file`
    // then succeeds, so nothing retries, while every `merge-base` against it
    // fails and the incremental diff silently never computes. 174 of 744
    // IncrementalReview runs lost their delta this way (#1139).
    // `DEEPEN_RETRY_DEPTH` is this repo's existing "clears the merge base on
    // most real-world PRs without downloading full history" bound.
    await $gitFetchWithDeepen(
      [
        "--no-tags",
        ...(params.isShallow ? [`--depth=${DEEPEN_RETRY_DEPTH}`] : []),
        "origin",
        tempBranch,
      ],
      { token: params.gitToken, refreshGitToken: params.refreshGitToken, signal: params.signal },
      `before_sha temp branch ${tempBranch}`
    );
    log.debug(`» fetched before_sha via temp branch ${tempBranch}`);
    return true;
  } catch (e) {
    log.debug(`» failed to fetch before_sha: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/**
 * Is this commit object present locally? `merge-base` failing does NOT tell us
 * which case we are in — a missing object and a missing common ancestor collapse
 * into the same `sh -c` failure — and `git diff-tree` needs the object too. So
 * ask directly before recommending it. See #1139.
 */
function hasLocalCommit(sha: string | undefined): boolean {
  if (!sha) return false;
  try {
    return $("git", ["cat-file", "-t", sha], { log: false }).trim() === "commit";
  } catch {
    return false;
  }
}

type CheckoutPrBranchParams = GitContext & {
  beforeSha?: string | undefined;
  /** aborts the in-flight fetch (SIGTERM, so git removes its own locks) when the tool deadline fires */
  signal: AbortSignal;
};

// stale lock files left over from a crashed/cancelled prior git process block
// every subsequent fetch with `Unable to create '<path>': File exists`. only
// sweep locks older than this threshold so we never race a concurrent
// legitimate git op that's holding the lock.
const STALE_LOCK_AGE_MS = 30_000;

// PR head refs (refs/pull/N/head) sometimes lag the pull_request.opened
// webhook by a few seconds. retry the missing-ref case with backoff
// before giving up — see issue #591.
const PULL_REF_RETRY_DELAYS_MS = [2_000, 5_000, 10_000];
const PULL_REF_MISSING_PATTERN = /couldn't find remote ref pull\/\d+\/head/i;

const GIT_LOCK_PATHS = [
  ".git/shallow.lock",
  ".git/index.lock",
  ".git/objects/maintenance.lock",
] as const;

function cleanupStaleGitLocks(): void {
  const now = Date.now();
  for (const relPath of GIT_LOCK_PATHS) {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(relPath).mtimeMs;
    } catch {
      continue;
    }
    // a lock created after this process started belongs to one of this run's own git
    // processes (an agent `git_fetch`, or an attempt the deadline is still cancelling).
    if (now - mtimeMs < STALE_LOCK_AGE_MS || mtimeMs >= performance.timeOrigin) continue;
    try {
      unlinkSync(relPath);
      log.warning(`» removed stale ${relPath} from prior run`);
    } catch (e) {
      log.debug(
        `» failed to remove stale ${relPath}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
}

/**
 * Returns false when a PR's current state diverges from what we dispatched
 * on (closed/merged, or head SHA differs from pr.headSha). Used to short-
 * circuit the pull/N/head retry loop when the ref is missing because the
 * PR has moved on, not because of a webhook race.
 *
 * Network failures here are treated as "still valid" — we'd rather burn the
 * retry budget than wrongly abort on a transient API blip.
 *
 * Note: this answers "should we keep trying?", NOT "will the next fetch
 * succeed?". `pulls.get` (REST API) and `pull/N/head` (git ref) are served
 * by independent GitHub replicas with their own propagation lag, so
 * `pulls.get` reporting an open PR with a matching head SHA does not
 * guarantee the git ref is yet visible — and vice versa (see issue #591
 * for the original webhook-vs-ref replication-lag context).
 */
async function isPullRequestStillDispatchable(args: {
  octokit: Octokit;
  owner: string;
  repo: string;
  pr: PrData;
}): Promise<boolean> {
  try {
    const { data } = await args.octokit.rest.pulls.get({
      owner: args.owner,
      repo: args.repo,
      pull_number: args.pr.number,
    });
    if (data.state !== "open") return false;
    if (data.head.sha !== args.pr.headSha) return false;
    return true;
  } catch {
    // lenient — don't abort on API hiccups
    return true;
  }
}

/**
 * Throws the friendly clean-abort error when the PR has moved on since
 * dispatch. Wraps `isPullRequestStillDispatchable` so the abort message
 * lives in one place and is invoked from the inner `catch` around the
 * `pull/N/head` fetch on every missing-ref failure.
 */
async function abortIfPullRequestMoved(args: {
  octokit: Octokit;
  owner: string;
  repo: string;
  pr: PrData;
}): Promise<void> {
  const stillValid = await isPullRequestStillDispatchable(args);
  if (stillValid) return;
  throw new Error(
    `PR #${args.pr.number} is no longer in the state it was at dispatch (likely closed, merged, or force-pushed between webhook fire and run start). aborting checkout — re-trigger the run if this PR is still active.`
  );
}

/**
 * Shared helper to checkout a PR branch and configure fork remotes.
 * Assumes origin remote is already configured with authentication.
 * Updates the primary repo state's issueNumber, checkoutSha, and pushUrl (for fork PRs).
 */
export async function checkoutPrBranch(
  pr: PrData,
  params: CheckoutPrBranchParams
): Promise<{ hookWarning?: string | undefined }> {
  const { octokit, owner, name, gitToken, refreshGitToken, toolState, beforeSha, signal } = params;

  // SECURITY: PR ref names come from GitHub and are attacker-controlled on
  // forks (the PR author picks headRef freely, and baseRef could be a
  // maliciously-named branch on the target repo). reject leading-dash names
  // before any other work (including repo-state resolution) so they never
  // reach a git command — without this, a ref like "-upload-pack=evil" fed
  // into `git fetch origin <ref>` would be parsed as a flag, not a refspec.
  rejectIfLeadingDash(pr.baseRef, "PR base ref");
  rejectIfLeadingDash(pr.headRef, "PR head ref");

  const repoState = requireRepoState(toolState, owner, name);
  log.info(`» checking out PR #${pr.number}...`);

  // self-hosted runners and cancelled jobs frequently leave stale .git/*.lock
  // files behind. without this sweep, the first fetch below aborts with
  // `Unable to create '.git/shallow.lock': File exists` (originally surfaced
  // by agents shelling out to `rm -f` here, issue #564). doing it server-side
  // is the only safe place — the tool description now explicitly forbids the
  // agent from removing lock files, because manual removal during an in-flight
  // fetch kills the running fetch and creates an inescapable retry loop
  // (issue #860).
  cleanupStaleGitLocks();

  const isFork = pr.headRepoFullName !== pr.baseRepoFullName;

  // always use pr-{number} as local branch name for consistency
  // this avoids naming conflicts and makes push config simpler
  const localBranch = `pr-${pr.number}`;

  const isShallow =
    $("git", ["rev-parse", "--is-shallow-repository"], { log: false }).trim() === "true";

  repoState.checkoutSha = $("git", ["rev-parse", "HEAD"], { log: false }).trim();
  const alreadyOnBranch = repoState.checkoutSha === pr.headSha;

  // fetch base branch so origin/<base> exists for diff operations.
  // wrap with deepen-retry: on shallow clones (the actions/checkout default
  // is depth=1), repos with deep PR ancestry can't reach the baseRef tip in
  // a single round trip, surfacing as `Could not read <sha>` / `remote did
  // not send all necessary objects` (issue #656).
  log.debug(`» fetching base branch (${pr.baseRef})...`);
  await $gitFetchWithDeepen(
    ["--no-tags", "origin", pr.baseRef],
    { token: gitToken, refreshGitToken, signal },
    `base branch ${pr.baseRef}`
  );

  // alreadyOnBranch only matches for repeated checkout_pr calls for the same PR in one session
  // (without the tip moving), or if an external setup already checked out the PR head.
  // normal PR-triggered runs won't match here — actions/checkout lands on a synthesized
  // merge commit whose SHA differs from pr.headSha.
  //
  // so the fetch+checkout block below will almost always execute, and the fetched HEAD
  // might differ from pr.headSha. the repo state's checkoutSha is set after to capture the actual SHA.
  if (!alreadyOnBranch) {
    // checkout base branch first to avoid "refusing to fetch into current branch" error
    // -B creates or resets the branch to match origin/baseBranch
    $("git", ["checkout", "-B", pr.baseRef, `origin/${pr.baseRef}`], { log: false });

    // fetch PR branch using pull/{n}/head refspec (works for both fork and same-repo PRs).
    // two transient classes wrap this fetch:
    //   - shallow-unreachable (`Could not read <sha>` etc.) — handled by the
    //     inner `$gitFetchWithDeepen` deepen-retry (one shot, see issue #656)
    //   - pull/N/head webhook race (`couldn't find remote ref pull/N/head`) —
    //     handled by the outer retry below (see issue #591)
    log.debug(`» fetching PR #${pr.number} (${localBranch})...`);
    await yes.mutation({
      run: async () => {
        try {
          await $gitFetchWithDeepen(
            ["--no-tags", "origin", `+pull/${pr.number}/head:${localBranch}`],
            { token: gitToken, refreshGitToken, signal },
            `PR #${pr.number}`
          );
        } catch (e) {
          // on the webhook race, check whether the PR still matches what we
          // dispatched on. if it's been closed/merged or the head SHA moved,
          // no amount of retrying will populate the expected ref — surface a
          // clean abort error instead of burning the full retry budget.
          const msg = e instanceof Error ? e.message : String(e);
          if (PULL_REF_MISSING_PATTERN.test(msg)) {
            await abortIfPullRequestMoved({ octokit, owner, repo: name, pr });
          }
          throw e;
        }
      },
      retry: (error, attempt) =>
        PULL_REF_MISSING_PATTERN.test(error instanceof Error ? error.message : String(error))
          ? yes.delay(PULL_REF_RETRY_DELAYS_MS, attempt)
          : -1,
      name: `pull/${pr.number}/head fetch`,
    })();

    // checkout the branch
    $("git", ["checkout", localBranch], { log: false });
    log.debug(`» checked out PR #${pr.number}`);
    // make sure checkoutSha is set to the actual checked-out SHA (which might be different from pr.headSha)
    repoState.checkoutSha = $("git", ["rev-parse", "HEAD"], { log: false }).trim();
  }

  const beforeShaReachable = beforeSha
    ? await ensureBeforeShaReachable({
        sha: beforeSha,
        octokit,
        owner,
        repo: name,
        gitToken,
        refreshGitToken,
        isShallow,
        signal,
      })
    : false;

  // compute deepen depth for shallow clones. actions/checkout uses depth=1
  // by default, which breaks rebase/log because git can't find the merge base.
  // use the GitHub compare API to fetch exactly enough history.
  // computed after checkout so compareCommits uses the actual checked-out SHA.
  if (isShallow) {
    let deepenDepth = 0;
    try {
      // ahead_by = PR commits past merge base, behind_by = base commits past merge base.
      // --deepen extends ALL shallow roots equally (can't deepen a single branch),
      // so we need the max across both the PR head and before_sha to ensure all
      // three points (base, head, before_sha) reach the merge base in a single deepen call.
      const [prComparison, beforeShaComparison] = await Promise.all([
        octokit.rest.repos.compareCommits({
          owner,
          repo: name,
          base: pr.baseRef,
          head: repoState.checkoutSha,
        }),
        beforeSha && beforeShaReachable
          ? octokit.rest.repos.compareCommits({
              owner,
              repo: name,
              base: pr.baseRef,
              head: beforeSha,
            })
          : undefined,
      ]);
      deepenDepth =
        Math.max(
          prComparison.data.ahead_by,
          prComparison.data.behind_by,
          beforeShaComparison?.data.ahead_by ?? 0,
          beforeShaComparison?.data.behind_by ?? 0
        ) + 10;
      log.debug(
        `» PR: ${prComparison.data.ahead_by} ahead / ${prComparison.data.behind_by} behind` +
          (beforeShaComparison
            ? `, before_sha: ${beforeShaComparison.data.ahead_by} ahead / ${beforeShaComparison.data.behind_by} behind`
            : "") +
          `, deepen by ${deepenDepth}`
      );
    } catch {
      deepenDepth = 1000;
      log.debug(`» compare API failed, falling back to --deepen=${deepenDepth}`);
    }
    // deepen after both branches are fetched so the merge base is reachable from both sides
    if (deepenDepth) {
      log.debug(`» deepening by ${deepenDepth} to reach merge base...`);
      await $git("fetch", [`--deepen=${deepenDepth}`, "--no-tags", "origin"], {
        token: gitToken,
        signal,
      });
    }
  }

  // configure push remote for this branch
  // NOTE: This always runs regardless of alreadyOnBranch, because setupGit doesn't configure
  // fork remotes. This ensures fork PRs can push even when checkout_pr is called after setupGit.
  if (isFork) {
    const remoteName = `pr-${pr.number}`;
    // SECURITY: fork URL without token - auth is injected via GIT_ASKPASS in $git()
    const forkUrl = `https://github.com/${pr.headRepoFullName}.git`;

    // add fork as a named remote (suppress logging to avoid "error: remote already exists" spam)
    try {
      $("git", ["remote", "add", remoteName, forkUrl], { log: false });
      log.debug(`» added remote '${remoteName}' for fork ${pr.headRepoFullName}`);
    } catch {
      // remote already exists, update its URL
      $("git", ["remote", "set-url", remoteName, forkUrl], { log: false });
      log.debug(`» updated remote '${remoteName}' for fork ${pr.headRepoFullName}`);
    }

    // url.*.pushInsteadOf matches by URL prefix rather than remote name, so a runner-wide
    // rewrite reaches a remote we just created. pin this one the same way configureRepoGit
    // pins origin.
    $("git", ["config", "--local", "--replace-all", `remote.${remoteName}.pushurl`, forkUrl], {
      log: false,
    });

    // set branch push config so `git push` knows where to push
    $("git", ["config", `branch.${localBranch}.pushRemote`, remoteName], { log: false });
    // set merge ref so git knows the remote branch name (may differ from local)
    $("git", ["config", `branch.${localBranch}.merge`, `refs/heads/${pr.headRef}`], { log: false });
    log.debug(`» configured branch '${localBranch}' to push to '${remoteName}/${pr.headRef}'`);

    // warn if maintainer can't modify (push will likely fail)
    if (!pr.maintainerCanModify) {
      log.warning(
        `» fork PR has maintainer_can_modify=false - push operations will fail. ` +
          `ask the PR author to enable "Allow edits from maintainers" or the fork may be owned by an organization.`
      );
    }
  } else {
    // for same-repo PRs, push to origin
    $("git", ["config", `branch.${localBranch}.pushRemote`, "origin"], { log: false });
    $("git", ["config", `branch.${localBranch}.merge`, `refs/heads/${pr.headRef}`], { log: false });
  }

  // update repo state
  repoState.issueNumber = pr.number;
  if (isFork) {
    repoState.pushUrl = `https://github.com/${pr.headRepoFullName}.git`;
  }

  // store push destination so push_branch can use it directly
  // git config is the primary mechanism, but repoState serves as a reliable fallback
  // in case git config reads fail in certain environments
  repoState.pushDest = {
    remoteName: isFork ? `pr-${pr.number}` : "origin",
    remoteBranch: pr.headRef,
    localBranch,
  };

  // the hook ignores the signal, so never start it past the deadline (an abort swallowed by
  // `ensureBeforeShaReachable` reaches here with no `$git` call left to surface it)
  signal.throwIfAborted();
  // execute post-checkout lifecycle hook. soft-fail: surface the warning
  // to the agent via the tool response instead of throwing, so a flaky or
  // slightly-broken hook doesn't block checkout entirely.
  const postCheckoutHook = await executeLifecycleHook({
    event: "post-checkout",
    script: params.postCheckoutScript,
    shell: params.shell,
    normalizeWorkingTreeAfter: true,
  });
  return { hookWarning: postCheckoutHook.warning };
}

/**
 * dedupes concurrent `checkout_pr` calls for the same PR. agents (notably
 * Sonnet/Claude) occasionally emit duplicate parallel tool_use blocks for the
 * same args in one turn; without this, both invocations race
 * `checkoutPrBranch` against the same `.git/shallow.lock` and one fails with
 * `File exists` (issue #642). cleared in `finally` so subsequent same-PR
 * calls re-do the work normally.
 */
const inFlightCheckouts = new Map<number, Promise<CheckoutPrResult>>();

/**
 * The tool's own budget, enforced by US rather than by fastmcp. fastmcp's
 * `timeoutMs` is a `Promise.race`: it bounds the response the client sees and
 * never settles the loser, so a `runCheckout` that stopped settling left a dead
 * entry in `inFlightCheckouts` for the rest of the run — and every later
 * `checkout_pr` for that PR short-circuited onto it. 222 client aborts over 110
 * runs, two of which burned the entire 1h cap re-issuing one checkout whose git
 * work had finished 35 minutes earlier (#1171). Racing here settles the promise
 * the `finally` is waiting on, so the entry always clears and a retry gets a
 * real attempt.
 *
 * The deadline also ABORTS the attempt: racing alone left its git child running,
 * and the retry's lock sweep then deleted that orphan's live `shallow.lock` (#1468).
 * The race stays as a backstop for awaits the signal cannot reach (Octokit, the hook).
 */
const CHECKOUT_DEADLINE_MS = 570_000;
/** covers the 5s SIGKILL escalation and a ≤10s pull-ref retry wait; 585s stays under fastmcp's 600s */
const CHECKOUT_ABORT_GRACE_MS = 15_000;

function withCheckoutDeadline(
  run: (signal: AbortSignal) => Promise<CheckoutPrResult>,
  pullNumber: number
): Promise<CheckoutPrResult> {
  const exceeded = `checkout_pr #${pullNumber} exceeded ${CHECKOUT_DEADLINE_MS / 1000}s`;
  const retry = "retry the call to start a fresh attempt.";
  const controller = new AbortController();
  const abortTimer = setTimeout(
    () => controller.abort(new Error(`${exceeded} and was cancelled; ${retry}`)),
    CHECKOUT_DEADLINE_MS
  );
  let backstopTimer: NodeJS.Timeout | undefined;
  const backstop = new Promise<never>((_, reject) => {
    backstopTimer = setTimeout(
      () =>
        reject(
          new Error(
            `${exceeded} and was asked to cancel, but a step that cannot be interrupted (the post-checkout hook or a GitHub API call) was still running ${CHECKOUT_ABORT_GRACE_MS / 1000}s later. ${retry}`
          )
        ),
      CHECKOUT_DEADLINE_MS + CHECKOUT_ABORT_GRACE_MS
    );
  });
  return Promise.race([run(controller.signal), backstop]).finally(() => {
    clearTimeout(abortTimer);
    clearTimeout(backstopTimer);
  });
}

type InitialHead = NonNullable<RepoToolState["initialHead"]>;

function headsEqual(a: InitialHead, b: InitialHead): boolean {
  if (a.kind === "branch" && b.kind === "branch") return a.name === b.name;
  if (a.kind === "detached" && b.kind === "detached") return a.sha === b.sha;
  return false;
}

function describeHead(h: InitialHead): string {
  if (h.kind === "branch") return `branch \`${h.name}\``;
  return `detached HEAD \`${h.sha}\``;
}

export function CheckoutPrTool(ctx: ToolContext) {
  const runCheckout = async (
    pull_number: number,
    signal: AbortSignal
  ): Promise<CheckoutPrResult> => {
    const prResponse = await ctx.octokit.rest.pulls.get({
      owner: ctx.repo.owner,
      repo: ctx.repo.name,
      pull_number,
    });

    const headRepo = prResponse.data.head.repo;
    if (!headRepo) {
      throw new Error(`PR #${pull_number} source repository was deleted`);
    }

    const pr: PrData = {
      number: pull_number,
      headSha: prResponse.data.head.sha,
      headRef: prResponse.data.head.ref,
      headRepoFullName: headRepo.full_name,
      baseRef: prResponse.data.base.ref,
      baseRepoFullName: prResponse.data.base.repo.full_name,
      maintainerCanModify: prResponse.data.maintainer_can_modify,
    };

    const primary = primaryRepoState(ctx.toolState);
    const checkoutResult = await checkoutPrBranch(pr, {
      octokit: ctx.octokit,
      owner: ctx.repo.owner,
      name: ctx.repo.name,
      gitToken: ctx.gitToken,
      refreshGitToken: ctx.refreshGitToken,
      toolState: ctx.toolState,
      shell: ctx.payload.shell,
      postCheckoutScript: ctx.postCheckoutScript,
      beforeSha: primary.beforeSha,
      signal,
    });

    const tempDir = process.env.PULLFROG_TEMP_DIR;
    if (!tempDir) {
      throw new Error(
        "PULLFROG_TEMP_DIR not set - checkout_pr must run in pullfrog action context"
      );
    }

    const checkoutSha = primary.checkoutSha;
    if (!checkoutSha) throw new Error("checkout completed without a resolved HEAD SHA");
    const headShort = checkoutSha.slice(0, 7);

    // compute incremental diff if we have a beforeSha to compare against
    let incrementalDiffPath: string | undefined;
    let incrementalUnavailable = false;
    let incrementalUnavailableReason: string | undefined;
    if (primary.beforeSha) {
      const beforeShort = primary.beforeSha.slice(0, 7);
      const incremental = computeIncrementalDiff({
        baseBranch: pr.baseRef,
        beforeSha: primary.beforeSha,
        headSha: checkoutSha,
      });
      if (incremental.status === "ok") {
        incrementalDiffPath = join(
          tempDir,
          `pr-${pull_number}-${beforeShort}-${headShort}-incremental.diff`
        );
        writeFileSync(incrementalDiffPath, incremental.diff);
        log.info(
          `» incremental diff computed (${incremental.diff.length} bytes) → ${incrementalDiffPath}`
        );
      } else if (incremental.status === "unavailable") {
        incrementalUnavailable = true;
        incrementalUnavailableReason = incremental.reason;
      }
    }

    // fetch PR files and format with line numbers
    const formatResult = await fetchAndFormatPrDiff(ctx, pull_number);
    const diffPreview = formatResult.content.split("\n").slice(0, 100).join("\n");
    log.debug(`formatted diff preview (first 100 lines):\n${diffPreview}`);
    const diffPath = join(tempDir, `pr-${pull_number}-${headShort}.diff`);
    writeFileSync(diffPath, formatResult.content);
    log.debug(`wrote diff to ${diffPath} (${formatResult.content.length} bytes)`);
    primary.diffCoverage = createDiffCoverageState({
      diffPath,
      totalLines: countLines({ content: formatResult.content }),
      toc: formatResult.toc,
      previous: primary.diffCoverage,
    });
    log.debug(
      `» diff coverage initialized: diffPath=${diffPath}, totalLines=${primary.diffCoverage.totalLines}, tocEntries=${primary.diffCoverage.tocEntries.length}`
    );

    let impactPath: string | undefined;
    if (process.env.PULLFROG_DISABLE_CHANGE_IMPACT === "1") {
      log.info("» change impact disabled by PULLFROG_DISABLE_CHANGE_IMPACT");
    } else {
      let revisionVerified = false;
      let revisionFailure: string | undefined;
      try {
        const latest = await ctx.octokit.rest.pulls.get({
          owner: ctx.repo.owner,
          repo: ctx.repo.name,
          pull_number,
        });
        revisionVerified =
          latest.data.head.sha === checkoutSha && latest.data.base.sha === prResponse.data.base.sha;
      } catch (error) {
        revisionFailure = error instanceof Error ? error.message : String(error);
      }

      if (revisionFailure !== undefined) {
        log.warning(
          `» change impact skipped: PR revision could not be verified (${revisionFailure})`
        );
      } else if (!revisionVerified) {
        log.warning("» change impact skipped: PR revision changed while the diff was fetched");
      } else {
        try {
          const impact = await createChangeImpactArtifact(ctx, {
            files: formatResult.files,
            pullNumber: pull_number,
            baseSha: prResponse.data.base.sha,
            headSha: checkoutSha,
            signal,
          });
          impactPath = impact.path;
          log.info(
            `» change impact: ${impact.candidateCount} candidate atom(s), ${impact.renderedAtomCount} detailed atom(s), ${impact.referenceCount} tracked reference(s), ${impact.bytes} bytes → ${impact.path}`
          );
        } catch (error) {
          log.warning(
            `» change impact skipped: generation failed (${error instanceof Error ? error.message : String(error)})`
          );
        }
      }
    }

    // cache commentable-lines snapshot so review-time validation matches what
    // GitHub will anchor to (commit_id=checkoutSha), even if the PR is updated
    // between checkout and review.
    const cached = new Map<string, ReturnType<typeof commentableLinesForFile>>();
    for (const file of formatResult.files) {
      cached.set(file.filename, commentableLinesForFile(file.patch));
    }
    primary.commentableLinesByFile = cached;
    primary.commentableLinesPullNumber = pull_number;
    primary.commentableLinesCheckoutSha = checkoutSha;

    const incrementalInstructions = incrementalDiffPath
      ? `IMPORTANT: incrementalDiffPath contains ONLY the changes since the last reviewed version ` +
        `(computed via range-diff). you MUST read incrementalDiffPath FIRST to understand what changed, ` +
        `then use diffPath for full PR context. do NOT skip the incremental diff. `
      : incrementalUnavailable
        ? // say it FAILED rather than leaving the agent to infer "nothing changed"
          // from an absent field. only suggest diff-tree when the previous
          // revision is actually PRESENT locally — if the fetch never landed it,
          // diff-tree needs that object too and would fail identically. see #1139.
          `NOTE: an incremental diff was expected for this run but could not be computed` +
          (incrementalUnavailableReason ? ` (${incrementalUnavailableReason})` : "") +
          `. review the full diffPath instead. ` +
          (hasLocalCommit(primary.beforeSha)
            ? `if you need just the delta, \`git diff-tree -p ${primary.beforeSha} ${checkoutSha}\` works without a merge base. `
            : `the previous revision was never fetched into this shallow checkout, so the full diff is the only option. `)
        : "";

    const impactInstructions = impactPath
      ? ` impactPath contains bounded, deterministic reference leads for semantic atoms changed by the PR. ` +
        `read the authoritative diff TOC and relevant raw diff lines FIRST; only then use impactPath as a supplemental, explicitly incomplete lead list. ` +
        `impactPath never establishes review coverage and an empty artifact is not evidence of no wider impact.`
      : "";

    // commit metadata relative to the PR base (e.g. main). use origin/<base>
    // because the local base ref may not exist after a shallow fetch. cap
    // the log so a PR with thousands of commits doesn't blow up the tool
    // response. if the base ref can't be resolved (e.g. shallow fetch that
    // didn't pull down origin/<base>), degrade gracefully rather than
    // failing the whole checkout_pr call over metadata.
    const COMMIT_LOG_MAX = 200;
    const baseRange = `origin/${pr.baseRef}..HEAD`;
    let commitCount = 0;
    let commitLog = "";
    let commitLogUnavailable = false;
    try {
      commitCount = parseInt(
        $("git", ["rev-list", "--count", baseRange], { log: false }).trim() || "0",
        10
      );
      commitLog = $("git", ["log", "--oneline", `--max-count=${COMMIT_LOG_MAX}`, baseRange], {
        log: false,
      });
    } catch (err) {
      commitLogUnavailable = true;
      log.debug(
        `» unable to compute commit metadata for ${baseRange}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const commitLogTruncated = commitCount > COMMIT_LOG_MAX;

    const hookWarningInstructions = checkoutResult.hookWarning
      ? ` HOOK WARNING: the post-checkout lifecycle hook reported a non-fatal failure (see hookWarning). ` +
        `decide whether to retry based on the guidance in that field before proceeding.`
      : "";

    const commitLogInstructions = commitLogUnavailable
      ? ` NOTE: commit metadata is partial (base ref unreachable, likely a shallow fetch). ` +
        `commitCount/commitLog may be 0/empty or incomplete; treat them as "unknown" rather than "no commits", ` +
        `and use \`git log\` directly if you need the full history.`
      : commitLogTruncated
        ? ` NOTE: commitLog was capped at ${COMMIT_LOG_MAX} entries out of ${commitCount} commits; ` +
          `use \`git log\` directly if you need the full history.`
        : "";

    return {
      success: true,
      number: prResponse.data.number,
      title: prResponse.data.title,
      body: prResponse.data.body,
      base: pr.baseRef,
      localBranch: `pr-${pull_number}`,
      remoteBranch: `refs/heads/${pr.headRef}`,
      isFork: pr.headRepoFullName !== pr.baseRepoFullName,
      maintainerCanModify: pr.maintainerCanModify,
      url: prResponse.data.html_url,
      headRepo: pr.headRepoFullName,
      diffPath,
      impactPath,
      incrementalDiffPath,
      toc: formatResult.toc,
      commitCount,
      commitLog,
      commitLogTruncated,
      commitLogUnavailable,
      hookWarning: checkoutResult.hookWarning,
      instructions:
        incrementalInstructions +
        `the diff file at diffPath contains a table of contents (TOC) at the top listing every changed file with its line range. ` +
        `use the TOC line ranges as your checklist and read specific files from the diff instead of reading the entire file. ` +
        `for example, if the TOC says "src/foo.ts → lines 5-42", read lines 5-42 from diffPath to see that file's changes. ` +
        `review files selectively based on relevance rather than reading everything sequentially. ` +
        `to inspect the PR's changed files, use diffPath — do NOT run \`git diff\` to re-derive what's already in diffPath. the formatted diff with line numbers is authoritative. ` +
        `if you ever do need a branch-vs-base diff via the git tool, use \`git diff --merge-base <base>\` (single call, includes uncommitted edits) or three-dot \`git diff <base>...HEAD\` (committed-only). bare \`<base>\` and two-dot \`<base>..HEAD\` are symmetric and pull in the inverse of every commit landed on \`<base>\` since the branch forked — the git tool will reject those forms when the divergence is detected. \`$(...)\` subshells are NOT expanded by the git tool. ` +
        `\`git log\` and \`git diff --stat\` are fine for commit-range overview, and \`git diff\` / \`git diff --cached\` are fine for inspecting *your own* uncommitted changes — but PR review content MUST come from diffPath. ` +
        `before your review is submitted, a one-time coverage pre-flight may error listing unread TOC regions. ` +
        `retry the same create_pull_request_review call to proceed — optionally after reading the listed ranges. the pre-flight will not block again this session. ` +
        `the local branch is 'localBranch' (pr-{number}), not the remote branch name. ` +
        `when pushing, omit branchName to use the current branch. do not use remoteBranch as a local branch name.` +
        impactInstructions +
        hookWarningInstructions +
        commitLogInstructions,
    } satisfies CheckoutPrResult;
  };

  return tool({
    name: "checkout_pr",
    mutates: true,
    timeoutMs: 600_000,
    description:
      "Checkout a pull request branch locally. This fetches the PR branch and sets up push configuration for fork PRs. " +
      "Returns diffPath pointing to the formatted diff file. " +
      "Example: `checkout_pr({ pull_number: 1234 })`. " +
      "Large repos can take several minutes — wait for the call to finish; do not treat a slow response as failure. " +
      "If a call times out, retry it — the retry starts a fresh attempt. DO NOT touch `.git/*.lock` files: removing them kills a still-running fetch and creates an inescapable retry loop. " +
      "Stale lock files from prior crashed runs are swept automatically by the tool itself before each fetch; you do not need to remove them by hand.",
    parameters: CheckoutPr,
    execute: execute(async ({ pull_number }) => {
      const inFlight = inFlightCheckouts.get(pull_number);
      if (inFlight) {
        log.info(`» checkout_pr({pull_number:${pull_number}}) already in flight — sharing result`);
        return inFlight;
      }

      // unconditional refusal: any dirty working tree blocks checkout_pr, even
      // when HEAD is already on pr-N. no stashing, no live-HEAD escape hatch.
      // shared-cwd subagents made "carry edits along" semantics dangerous
      // (zed-industries/cloud, 2026-05-18) — forcing commit/discard before
      // any PR-context op eliminates the entire carry-forward failure class.
      const dirty = $("git", ["status", "--porcelain"], { log: false }).trim();
      if (dirty) {
        throw new Error(
          `cannot checkout PR #${pull_number} while the working tree has uncommitted changes. ` +
            `commit (then push if needed), or discard with \`git restore --staged --worktree .\` / \`git clean -fd\` before retrying. ` +
            `this refusal is unconditional — even re-checking-out the PR you're already on is refused, ` +
            `because shared-working-tree subagents make carry-forward edits unsafe. dirty paths:\n${dirty}`
        );
      }

      // initial-branch invariant: the only sanctioned HEAD positions for a
      // checkout_pr call are (a) the run-entry HEAD captured by setupGit, or
      // (b) `pr-${pull_number}` for idempotent same-PR re-checkout (e.g.
      // re-fetch after the PR head moved). anything else means a subagent
      // silently parked HEAD on another PR, which is the zed-industries/cloud
      // (2026-05-18) cross-PR clobber shape. uses the same live probe (not
      // the repo state's issueNumber, poisonable per the PR #796 review) and
      // discriminates branch vs detached so detached-entry runs don't get a
      // trivial "any future detached state matches" carve-out.
      const initialHead = primaryRepoState(ctx.toolState).initialHead;
      if (initialHead) {
        const currentHead = captureInitialHead(process.cwd());
        const targetBranch = `pr-${pull_number}`;
        const onTarget = currentHead.kind === "branch" && currentHead.name === targetBranch;
        const onInitial = headsEqual(currentHead, initialHead);
        if (!onTarget && !onInitial) {
          const recoverCmd =
            initialHead.kind === "branch"
              ? `git checkout ${initialHead.name}`
              : `git checkout ${initialHead.sha}`;
          throw new Error(
            `cannot checkout PR #${pull_number} from ${describeHead(currentHead)}. ` +
              `the only sanctioned HEAD positions for checkout_pr are the run-entry HEAD ` +
              `(${describeHead(initialHead)}) or the target PR's branch (\`${targetBranch}\`, idempotent re-checkout). ` +
              `recover with \`${recoverCmd}\` first — if that would carry uncommitted ` +
              `work along, commit or discard it (\`git restore --staged --worktree .\` / \`git clean -fd\`) before switching. ` +
              `routing around this via the \`git\` tool's \`checkout\`/\`switch\` subcommands is not sanctioned: ` +
              `this guard exists to prevent the shared-working-tree cross-PR clobber pattern from the ` +
              `zed-industries/cloud (2026-05-18) incident.`
          );
        }
      }

      const promise = withCheckoutDeadline(
        (signal) => runCheckout(pull_number, signal),
        pull_number
      );
      inFlightCheckouts.set(pull_number, promise);
      try {
        return await promise;
      } finally {
        inFlightCheckouts.delete(pull_number);
      }
    }),
  });
}
