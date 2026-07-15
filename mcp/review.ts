import type { RestEndpointMethodTypes } from "@octokit/rest";
import { type } from "arktype";
import { formatMcpToolRef } from "../external.ts";
import { type CommentableLines, primaryRepoState } from "../toolState.ts";
import { getApiUrl } from "../utils/apiUrl.ts";
import { buildPullfrogFooter } from "../utils/buildPullfrogFooter.ts";
import { log } from "../utils/cli.ts";
import { countLinesInRanges, getDiffCoverageBreakdown } from "../utils/diffCoverage.ts";
import { fixDoubleEscapedString } from "../utils/fixDoubleEscapedString.ts";
import { patchWorkflowRunFields } from "../utils/patchWorkflowRunFields.ts";
import { isPullfrog } from "../utils/payload.ts";
import * as yes from "../yes/index.ts";
import { deleteProgressComment } from "./comment.ts";
import type { ToolContext } from "./server.ts";
import { execute, getHttpStatus, tool } from "./shared.ts";

export type { CommentableLines };

/**
 * detect GitHub's generic server-side 422 ("An internal error occurred,
 * please try again.") that sometimes fires on `POST /pulls/{n}/reviews`.
 *
 * the body is stable across occurrences and distinct from every other 422
 * cause we care about (anchor validation, body length, malformed suggestion
 * blocks) — those all cite the specific problem. treating this as a
 * transient server error unlocks bounded in-tool retry instead of surfacing
 * it to the agent with the generic "likely causes (1)(2)(3)" prompt, which
 * induces whack-a-mole comment dropping on content that was never the issue.
 */
export function isTransientReviewError(err: unknown): boolean {
  if (getHttpStatus(err) !== 422) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return /internal error occurred, please try again/i.test(msg);
}

// backoff schedule for transient GitHub 422 "internal error" responses on the
// reviews endpoint. 3 attempts total (initial + 2 retries) with 1s/3s delays
// — most transient GH errors clear within a few seconds, and longer delays
// push review submission past agent-perceived responsiveness.
export const TRANSIENT_REVIEW_RETRY_DELAYS_MS = [1_000, 3_000];

type PullFile = RestEndpointMethodTypes["pulls"]["listFiles"]["response"]["data"][number];

/**
 * parse a PR file's patch to determine which line numbers on each side are
 * valid anchors for inline comments. GitHub only accepts comments on lines
 * inside a diff hunk: added/context lines on RIGHT, removed/context lines
 * on LEFT.
 */
export function commentableLinesForFile(patch: string | undefined): CommentableLines {
  const right = new Set<number>();
  const left = new Set<number>();
  if (!patch) return { RIGHT: right, LEFT: left };

  let oldLine = 0;
  let newLine = 0;
  for (const line of patch.split("\n")) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = parseInt(hunk[1], 10);
      newLine = parseInt(hunk[2], 10);
      continue;
    }
    const changeType = line[0];
    if (changeType === "+") {
      right.add(newLine);
      newLine++;
    } else if (changeType === "-") {
      left.add(oldLine);
      oldLine++;
    } else if (changeType === " ") {
      right.add(newLine);
      left.add(oldLine);
      newLine++;
      oldLine++;
    }
    // "\" (no newline marker) and anything else: skip, don't advance counters
  }
  return { RIGHT: right, LEFT: left };
}

export async function buildCommentableMap(
  ctx: ToolContext,
  pullNumber: number
): Promise<Map<string, CommentableLines>> {
  // prefer the snapshot captured by checkout_pr — it matches the diff GitHub
  // will anchor to (commit_id=checkoutSha). refetching via listFiles at review
  // time gives the LATEST PR state, which can drift from what the agent
  // actually reviewed if the PR was updated mid-run.
  //
  // only reuse the cache if it was built for THIS pull request AND for the
  // sha we will anchor the review to. a second checkout_pr that bumps
  // checkoutSha but fails before repopulating the cache (e.g., listFiles 5xx)
  // would otherwise leave a stale snapshot keyed to the right PR number but
  // the wrong sha, silently mis-validating comments.
  const primary = primaryRepoState(ctx.toolState);
  const cached = primary.commentableLinesByFile;
  const cachedFor = primary.commentableLinesPullNumber;
  const cachedSha = primary.commentableLinesCheckoutSha;
  const currentSha = primary.checkoutSha;
  if (cached && cachedFor === pullNumber && cachedSha && cachedSha === currentSha) return cached;

  const files: PullFile[] = await ctx.octokit.paginate(ctx.octokit.rest.pulls.listFiles, {
    owner: ctx.repo.owner,
    repo: ctx.repo.name,
    pull_number: pullNumber,
    per_page: 100,
  });
  const map = new Map<string, CommentableLines>();
  for (const file of files) {
    map.set(file.filename, commentableLinesForFile(file.patch));
  }
  return map;
}

/**
 * lightweight PAGINATED query for the approval gate: we only need each thread's
 * resolved state and its ROOT author (oldest comment, hence `first: 1`) to count
 * outstanding Pullfrog findings. distinct from REVIEW_THREADS_QUERY (a single
 * page of 100 with full comment bodies) because the invariant must hold on PRs
 * with >100 threads — a silent first-100 cap would let a finding beyond #100
 * slip an approval through.
 */
const OUTSTANDING_THREADS_QUERY = `
query ($owner: String!, $name: String!, $prNumber: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $prNumber) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          comments(first: 1) { nodes { author { login } } }
        }
      }
    }
  }
}
`;

type OutstandingThreadsResponse = {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes:
          | ({
              isResolved: boolean;
              comments: { nodes: ({ author: { login: string } | null } | null)[] | null } | null;
            } | null)[]
          | null;
      } | null;
    } | null;
  } | null;
};

/**
 * count unresolved review threads on a PR whose root comment was authored by
 * Pullfrog's bot. this is the full set of open Pullfrog findings on the PR —
 * the basis for both the never-approve-with-outstanding-issues invariant (the
 * approval gate below) and the `pullfrog-approval` status verdict. it is a
 * function of all open findings, NOT just the latest commit's delta.
 *
 * outdated-but-unresolved threads still count — GitHub marks a thread
 * `[OUTDATED]` when the anchor line moved (reformat, rename, force-push), which
 * is not the same as the concern being addressed. human-reviewer threads are
 * excluded: they belong to those reviewers to resolve. walks every page so a
 * long-lived PR with >100 threads can't hide an outstanding finding.
 */
export async function countOutstandingPullfrogThreads(
  ctx: ToolContext,
  pullNumber: number
): Promise<number> {
  let count = 0;
  let cursor: string | null = null;
  // bound the walk so a misbehaving cursor can't loop forever; 50 pages = 5000
  // threads, orders of magnitude beyond any real PR.
  for (let page = 0; page < 50; page += 1) {
    const response: OutstandingThreadsResponse = await ctx.octokit.graphql(
      OUTSTANDING_THREADS_QUERY,
      { owner: ctx.repo.owner, name: ctx.repo.name, prNumber: pullNumber, cursor }
    );
    const conn = response.repository?.pullRequest?.reviewThreads;
    for (const thread of conn?.nodes ?? []) {
      if (!thread || thread.isResolved) continue;
      const root = thread.comments?.nodes?.find((c) => c != null);
      if (root && isPullfrog(root.author?.login)) count += 1;
    }
    if (!conn?.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return count;
}

/** Prevent a post-review report from recreating progress chrome suppressed at startup. */
export function sealProgressAfterReview(ctx: ToolContext): void {
  if (ctx.payload.progressComments === false && ctx.toolState.progressComment === undefined) {
    ctx.toolState.progressComment = null;
  }
}

/**
 * proactive approve-when-clean for the Fix-all / Fix-👍s flow (`fix_review`
 * trigger). when such a run completes successfully and every Pullfrog-originated
 * review thread it raised is resolved, post a NEW approving review summarizing
 * the run's work.
 *
 * the verification step shares `countOutstandingPullfrogThreads` with the
 * approval gate in create_pull_request_review: that gate REACTIVELY blocks a
 * bad approval; this is the PROACTIVE approve side. approval is contingent on
 * Pullfrog's own findings actually being addressed — never a blind post-fix
 * approval. a Fix-👍s run that only resolved a subset naturally fails the
 * outstanding-thread check and is left unapproved.
 *
 * respects `prApproveEnabled` (the repo's "Allow Pullfrog to approve PRs"
 * opt-in): a repo that hasn't enabled binding bot approvals never gets one
 * here. skips when the agent already rendered an explicit review verdict this
 * run (`toolState.approval`), so an agent that found a real issue and submitted
 * a non-approving review is never overridden. best-effort — a failure must not
 * flip the run's outcome.
 */
export async function approveAfterFix(ctx: ToolContext): Promise<void> {
  if (ctx.payload.event.trigger !== "fix_review") return;
  if (!ctx.prApproveEnabled) return;
  // the agent already submitted a review this run — respect its verdict (an
  // approval, or a non-approving review covering a real outstanding issue).
  if (ctx.toolState.approval) return;

  const pullNumber = ctx.payload.event.issue_number;
  if (typeof pullNumber !== "number") return;

  const outstanding = await countOutstandingPullfrogThreads(ctx, pullNumber);
  if (outstanding > 0) {
    log.info(
      `skipping fix auto-approval: ${outstanding} unresolved Pullfrog review thread(s) still open on #${pullNumber}`
    );
    return;
  }

  const pr = await ctx.octokit.rest.pulls.get({
    owner: ctx.repo.owner,
    repo: ctx.repo.name,
    pull_number: pullNumber,
  });
  // never approve a PR that is closed/merged out from under the run.
  if (pr.data.state !== "open") return;
  const headSha = pr.data.head.sha;
  // GitHub blocks approving your own PR, so a self-authored PR posts a COMMENT
  // instead — the recorded verdict below is what drives the pullfrog-approval
  // check + auto-merge, not the GitHub review event.
  const selfAuthored = isPullfrog(pr.data.user?.login);

  // the agent's own end-of-run summary IS "the work done in this run"; reuse it
  // as the approval body, falling back to a concise statement when absent.
  const summary = ctx.toolState.lastProgressBody?.trim();
  const body =
    "> ✅ Pullfrog addressed all of its review feedback on this PR.\n\n" +
    (summary ||
      "all Pullfrog-raised review threads are resolved — no outstanding findings remain.");

  const params: RestEndpointMethodTypes["pulls"]["createReview"]["parameters"] = {
    owner: ctx.repo.owner,
    repo: ctx.repo.name,
    pull_number: pullNumber,
    event: selfAuthored ? "COMMENT" : "APPROVE",
    commit_id: headSha,
  };
  const result = await createAndSubmitWithFooter(ctx, params, {
    body,
    approved: true,
    hasComments: false,
  });
  // record the verdict so the opt-in `pullfrog-approval` status check (posted
  // right after this in finalizeSuccessRun) reports success on the reviewed sha.
  ctx.toolState.approval = { wouldApprove: true, sha: headSha };
  log.info(`» auto-approved #${pullNumber} after fix run (review ${result.data.id})`);

  // the approval review is now the durable artifact for this run; drop the
  // redundant fix progress comment (mirrors create_pull_request_review).
  await deleteProgressComment(ctx).catch((err) => {
    log.debug(`progress comment cleanup after fix auto-approval failed: ${err}`);
  });
  sealProgressAfterReview(ctx);
}

export type ReviewCommentInput = NonNullable<
  RestEndpointMethodTypes["pulls"]["createReview"]["parameters"]["comments"]
>[number];

export interface DroppedComment {
  path: string;
  line: number;
  startLine?: number | undefined;
  side: "LEFT" | "RIGHT";
  reason: string;
}

export function validateInlineComments(
  comments: ReviewCommentInput[],
  map: Map<string, CommentableLines>
): { valid: ReviewCommentInput[]; dropped: DroppedComment[] } {
  const valid: ReviewCommentInput[] = [];
  const dropped: DroppedComment[] = [];
  for (const c of comments) {
    const side = c.side === "LEFT" ? "LEFT" : "RIGHT";
    const line = c.line ?? 0;
    const startLine = c.start_line ?? line;
    const lines = map.get(c.path);
    const record = (reason: string): void => {
      const entry: DroppedComment = { path: c.path, line, side, reason };
      if (c.start_line != null) entry.startLine = c.start_line;
      dropped.push(entry);
    };
    if (!lines) {
      record(`file not in PR diff`);
      continue;
    }
    if (lines.LEFT.size === 0 && lines.RIGHT.size === 0) {
      // file is in the PR but has no textual patch — usually binary, a
      // pure rename with no content change, or a mode-only change. GitHub
      // won't accept inline comments on these regardless of line number.
      record(`file has no textual diff (binary, pure rename, or mode change)`);
      continue;
    }
    const anchors = lines[side];
    if (!anchors.has(line)) {
      record(`line ${line} (${side}) is not inside a diff hunk`);
      continue;
    }
    // GitHub requires start_line <= line. both anchors could be valid but
    // inverted (e.g. start=44, line=42) — GitHub 422s with "invalid line
    // numbers". catch it here so the agent sees a precise reason.
    if (c.start_line != null && c.start_line > line) {
      record(
        `start_line ${c.start_line} is after line ${line} — ranges must satisfy start_line <= line`
      );
      continue;
    }
    if (startLine !== line && !anchors.has(startLine)) {
      record(`start_line ${startLine} (${side}) is not inside a diff hunk`);
      continue;
    }
    valid.push(c);
  }
  return { valid, dropped };
}

// cap the detail list so a pathological run (agent emits hundreds of invalid
// comments on a huge PR) doesn't push the review body past GitHub's ~65KB
// limit and fail the whole submission with a body-too-long 422.
export const MAX_DROPPED_COMMENT_LINES = 50;

/**
 * reason a create_pull_request_review call should be skipped without hitting
 * GitHub. returned by reviewSkipDecision; null means submit normally.
 */
export type ReviewSkipDecision =
  | { kind: "no-issues"; reason: string }
  | { kind: "empty-downgraded-approve"; reason: string };

/**
 * decision returned by duplicateReviewDecision when a session has already
 * submitted a review and the current call would be a duplicate.
 */
export type DuplicateReviewDecision = {
  kind: "already-submitted";
  reviewId: number;
  reason: string;
};

/**
 * decide whether a second create_pull_request_review call in the same session
 * is a duplicate of an earlier submission.
 *
 * the agent is instructed to call create_pull_request_review exactly once per
 * Review-mode session (see action/modes.ts), but in practice it sometimes
 * submits twice — once with substantive feedback, then again with the
 * canonical "No new issues found." body when the prompt's branch logic
 * re-classifies non-blocking observations. the second submission is
 * always redundant: the first review is the record, and the duplicate just
 * adds noise to the PR.
 *
 * legitimate follow-up reviews after new commits ARE allowed: the
 * new-commits-mid-review path advances the primary repo state's checkoutSha past the
 * previously reviewed sha, and a subsequent checkout_pr advances it again.
 * any call where checkoutSha has moved past the prior reviewedSha is a real
 * follow-up and goes through. anything else — same sha, or no checkoutSha
 * to compare against — is a duplicate.
 */
export function duplicateReviewDecision(params: {
  existing: { id: number; reviewedSha: string | undefined } | undefined;
  currentCheckoutSha: string | undefined;
}): DuplicateReviewDecision | null {
  const existing = params.existing;
  if (!existing) return null;
  // checkoutSha advanced past the prior reviewed sha — legitimate follow-up
  // (e.g. after checkout_pr re-fetched new commits the agent was nudged to
  // pull). only treat as a duplicate when we cannot prove the SHA moved.
  if (
    params.currentCheckoutSha &&
    existing.reviewedSha &&
    params.currentCheckoutSha !== existing.reviewedSha
  ) {
    return null;
  }
  return {
    kind: "already-submitted",
    reviewId: existing.id,
    reason: `review ${existing.id} was already submitted in this session; ignoring duplicate call (call \`checkout_pr\` again first if new commits were pushed)`,
  };
}

/**
 * decide whether to skip a review submission before any network call.
 *
 * GitHub rejects `event: "COMMENT"` reviews with no body and no inline comments
 * with HTTP 422 "Unprocessable Entity". two paths produce that shape:
 *
 *   1. `!approved` + empty body/comments: agent's "no issues found" result.
 *      skipping preserves the agent's intent (nothing to post is a fine
 *      outcome for a review run) without a spurious 422.
 *   2. `approved` + `!prApproveEnabled` + empty body/comments: the runtime
 *      downgrades APPROVE to COMMENT when prApproveEnabled is off, and the
 *      resulting empty-COMMENT is exactly the shape GitHub 422s. skipping
 *      here surfaces the cause (downgrade + nothing to say) instead of an
 *      opaque 422 the agent can't recover from.
 *
 * legitimate bare approvals (`approved` + `prApproveEnabled`, no body/comments)
 * are never skipped — GitHub accepts empty APPROVE reviews and the approval
 * stamp itself is the review's content.
 */
export function reviewSkipDecision(params: {
  approved: boolean;
  requestChanges?: boolean;
  body: string | null | undefined;
  hasComments: boolean;
  prApproveEnabled: boolean;
}): ReviewSkipDecision | null {
  if (params.body || params.hasComments) return null;
  if (!params.approved) {
    return {
      kind: "no-issues",
      reason: params.requestChanges
        ? "request_changes with no body or comments — nothing to block on"
        : "no issues found — nothing to post",
    };
  }
  if (!params.prApproveEnabled) {
    return {
      kind: "empty-downgraded-approve",
      reason:
        "approve requested but prApproveEnabled is disabled; no feedback body or comments to post as a COMMENT review instead",
    };
  }
  return null;
}

export function formatDroppedCommentsNote(dropped: DroppedComment[]): string {
  const renderEntry = (d: DroppedComment): string => {
    const range =
      d.startLine != null && d.startLine !== d.line ? `${d.startLine}-${d.line}` : `${d.line}`;
    return `- \`${d.path}:${range}\` (${d.side}) — ${d.reason}`;
  };
  const shown = dropped.slice(0, MAX_DROPPED_COMMENT_LINES).map(renderEntry);
  const remainder = dropped.length - shown.length;
  if (remainder > 0) shown.push(`- …and ${remainder} more dropped comment(s) not shown`);
  return (
    `\n\n---\n\n` +
    `**Note:** ${dropped.length} inline comment(s) dropped because they did not anchor to lines inside the PR diff:\n` +
    shown.join("\n")
  );
}

// one-shot review tool
export const CreatePullRequestReview = type({
  pull_number: type.number.describe("The pull request number to review"),
  body: type.string
    .describe(
      "1-2 sentence high-level summary with urgency level, critical callouts, and feedback about code outside the diff. Specific feedback on diff lines goes in 'comments' array."
    )
    .optional(),
  approved: type.boolean
    .describe(
      "Set to true to submit as an approval. Use for `> ✅ No new issues found.` reviews where the PR is mergeable as-is and nothing in the body warrants code changes — approving also suppresses the Fix-button footer affordance so users don't dispatch a fix run on non-actionable feedback. Reserve approved: false for `> ℹ️ ...` (minor suggestions inline), `> [!IMPORTANT]` (recommended changes), and `> [!CAUTION]` (critical) reviews. Defaults to false (comment-only review). Mutually exclusive with request_changes. Approval is REJECTED while any unresolved Pullfrog review thread remains open on the PR (not just the latest commit's diff): resolve the threads the current code addresses (reply + resolve_review_thread) first, or submit a non-approving review if a real issue remains."
    )
    .optional(),
  request_changes: type.boolean
    .describe(
      "Set to true to submit a blocking REQUEST_CHANGES review — the PR cannot merge until the requested changes are made and the review is dismissed or re-reviewed. Reserve for changes you consider required, not optional suggestions. Mutually exclusive with approved; a contentless request (no body and no comments) is skipped."
    )
    .optional(),
  commit_id: type.string
    .describe(
      "Optional SHA of the commit being reviewed. Defaults to latest. Must be the FULL 40-character SHA — abbreviated SHAs are rejected by GitHub with `422 Unprocessable Entity`. The PR-synchronize event payload's `head_sha` is already full-length."
    )
    .optional(),
  comments: type({
    path: type.string.describe(
      "The file path to comment on (relative to repo root). Must be a file that appears in the PR diff."
    ),
    line: type.number.describe(
      "Line number to comment on. For multi-line ranges, this is the end line. Use NEW column from diff format. Must sit inside a `@@` hunk in the PR diff — anchors on context-only or untouched lines are dropped silently (the rest of the review still posts; dropped entries are reported under `droppedComments` in the response)."
    ),
    side: type
      .enumerated("LEFT", "RIGHT")
      .describe(
        "Side of the diff: LEFT (old code, lines starting with -) or RIGHT (new code, lines starting with + or unchanged). Defaults to RIGHT."
      )
      .optional(),
    body: type.string
      .describe("Explanatory comment text (optional if suggestion is provided)")
      .optional(),
    suggestion: type.string
      .describe(
        "Full replacement code for the line range [start_line, line]. MUST preserve the exact indentation of the original code."
      )
      .optional(),
    start_line: type.number
      .describe(
        "Start line for multi-line comment ranges. Omit for single-line comments. The range [start_line, line] defines which lines a suggestion replaces. Both `start_line` and `line` must sit inside the same `@@` hunk — a `start_line` outside the hunk causes the whole comment to be dropped even when `line` is valid. If you need to comment on context just above/below a hunk, shrink the range to a single line that is provably modified."
      )
      .optional(),
  })
    .array()
    .describe(
      "Inline comments on lines within diff hunks. Feedback about code outside the diff goes in 'body' instead."
    )
    .optional(),
});

export function CreatePullRequestReviewTool(ctx: ToolContext) {
  return tool({
    name: "create_pull_request_review",
    mutates: true,
    description:
      "Submit a review for an existing pull request. " +
      'Example: `create_pull_request_review({ pull_number: 1234, body: "LGTM", approved: true, comments: [{ path: "src/api.ts", line: 42, body: "nit: rename" }] })`. ' +
      "Each call creates a permanent, visible review on the PR — NEVER submit test or diagnostic reviews. " +
      "Set `approved: true` to approve, `request_changes: true` to submit a blocking review, or neither for a plain comment review (the three are mutually exclusive). " +
      "Reviews with no body AND no comments are silently skipped (nothing to post). " +
      "IMPORTANT: 95%+ of feedback should be in 'comments' array with file paths and line numbers. " +
      "Only use 'body' for a 1-2 sentence summary with urgency and critical callouts. " +
      "Use 'suggestion' to propose replacement code - MUST preserve exact indentation of original code. " +
      "The first submission may error once with a one-time diff-coverage nudge listing unread TOC regions — retry with the same arguments and the pre-flight will not block again. " +
      "Example replacing lines 42-44 (3 lines) with 5 lines: " +
      `{ path: 'src/api.ts', start_line: 42, line: 44, suggestion: '    const result = await fetch(url);\\n    if (!result.ok) {\\n      log.error(result.status);\\n      throw new Error("request failed");\\n    }' }` +
      " CONSTRAINT: Inline comments can ONLY target files and lines that appear in the PR diff." +
      " Comments anchored outside a diff hunk are dropped automatically (with a note appended to the review body) — the rest of the review still posts.",
    parameters: CreatePullRequestReview,
    execute: execute(
      async ({ pull_number, body, approved, request_changes, commit_id, comments = [] }) => {
        if (approved && request_changes) {
          throw new Error(
            "approved and request_changes are mutually exclusive — set at most one. an approval cannot also block."
          );
        }
        if (body) body = fixDoubleEscapedString(body);

        // set issue context (PRs are issues)
        const primary = primaryRepoState(ctx.toolState);
        primary.issueNumber = pull_number;

        // guard against duplicate review submissions in the same session.
        // see duplicateReviewDecision for the rationale — short version: the
        // agent occasionally submits twice (substantive review + canonical
        // "no issues found" follow-up) and the second is always redundant.
        // legit re-reviews after new commits are still allowed because
        // checkout_pr advances toolState.checkoutSha past the prior reviewedSha.
        const dup = duplicateReviewDecision({
          existing: ctx.toolState.review,
          currentCheckoutSha: primary.checkoutSha,
        });
        if (dup) {
          log.info(`skipping duplicate review submission: ${dup.reason}`);
          return {
            success: true,
            skipped: true,
            reason: dup.reason,
            reviewId: dup.reviewId,
          };
        }

        // invariant: Pullfrog must never approve a PR while ANY outstanding,
        // unaddressed Pullfrog finding remains — even on an incremental commit
        // that introduces no NEW issues. the approval verdict is otherwise just
        // the agent's `approved` boolean with zero verification, and the
        // incremental-review framing biases the agent toward the latest diff,
        // so a prior unresolved thread outside the delta can slip an approval
        // through. enforce it mechanically against the FULL set of open
        // Pullfrog-originated review threads (see countOutstandingPullfrogThreads).
        // applies regardless of prApproveEnabled — the downgrade to COMMENT
        // still leaves a misleading "no issues" body and a would-approve verdict.
        if (approved) {
          const outstanding = await countOutstandingPullfrogThreads(ctx, pull_number);
          if (outstanding > 0) {
            const listRef = formatMcpToolRef(ctx.agentId, "get_review_comments");
            const resolveRef = formatMcpToolRef(ctx.agentId, "resolve_review_thread");
            throw new Error(
              `cannot approve: ${outstanding} unresolved Pullfrog review thread(s) still open on this PR. ` +
                `approval requires every prior Pullfrog finding to be resolved, not just the latest commits to be clean. ` +
                `inspect them with \`${listRef}\`; for each thread the current code genuinely addresses, reply then call \`${resolveRef}\`, and retry this approval. ` +
                `if any thread is a real outstanding issue, do NOT approve — submit a non-approving review (omit \`approved\`) that covers it instead.`
            );
          }
        }
        // fetch the PR once up front: its author drives the self-approve
        // downgrade below (GitHub blocks approving your own PR) and its head sha
        // anchors the review — reused so a self-authored PR needs no second get.
        const prSnapshot = (
          await ctx.octokit.rest.pulls.get({
            owner: ctx.repo.owner,
            repo: ctx.repo.name,
            pull_number,
          })
        ).data;
        const selfAuthored = isPullfrog(prSnapshot.user?.login);

        // gate above guarantees approved ⇒ no outstanding Pullfrog threads, so
        // "would approve" is exactly the agent's intent. recorded here (not at
        // finalize) so it survives postReviewCleanup deleting toolState.review;
        // anchored to the reviewed sha so a mid-run push leaves the new head
        // unapproved until the follow-up re-review reports.
        ctx.toolState.approval = { wouldApprove: approved === true, sha: primary.checkoutSha };

        // skip empty COMMENT reviews before any GitHub call. see reviewSkipDecision
        // for the cases (no-issues vs empty-downgraded-approve) and why GitHub 422s
        // the shape we'd otherwise POST.
        const skip = reviewSkipDecision({
          approved: approved ?? false,
          requestChanges: request_changes ?? false,
          body,
          hasComments: comments.length > 0,
          // a self-authored approve downgrades to COMMENT (GitHub blocks a
          // self-APPROVE), so treat it as non-binding here — an empty self-
          // approve is then skipped (the verdict is still recorded above)
          // instead of POSTing an empty COMMENT that GitHub 422s.
          prApproveEnabled: ctx.prApproveEnabled && !selfAuthored,
        });
        if (skip) {
          log.info(`skipping review submission: ${skip.reason}`);
          return { success: true, skipped: true, reason: skip.reason };
        }

        // prApproveEnabled gates binding verdicts: a repo that hasn't opted in gets
        // neither an APPROVE nor a blocking REQUEST_CHANGES from the bot — both
        // downgrade to COMMENT (the feedback still posts, it just isn't binding). by
        // this point we already returned if the downgrade would produce an empty
        // COMMENT (the skip above), so every downgrade here carries body or comments.
        let event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES" = approved
          ? "APPROVE"
          : request_changes
            ? "REQUEST_CHANGES"
            : "COMMENT";
        if (event === "APPROVE" || event === "REQUEST_CHANGES") {
          if (!ctx.prApproveEnabled) {
            log.info(`prApproveEnabled is disabled — downgrading ${event} to COMMENT`);
            event = "COMMENT";
          } else if (selfAuthored) {
            // GitHub structurally rejects APPROVE/REQUEST_CHANGES on your own PR
            // (422 "Can not approve your own pull request"). post a COMMENT; the
            // internal approve verdict recorded above is what drives the
            // pullfrog-approval check + auto-merge, not a GitHub review that
            // cannot exist for a self-authored PR.
            log.info(
              `self-authored PR — downgrading binding ${event} to COMMENT (verdict recorded internally)`
            );
            event = "COMMENT";
          }
        }

        const params: RestEndpointMethodTypes["pulls"]["createReview"]["parameters"] = {
          owner: ctx.repo.owner,
          repo: ctx.repo.name,
          pull_number,
          event,
        };
        let latestHeadSha: string | undefined;
        if (commit_id) {
          params.commit_id = commit_id;
        } else {
          latestHeadSha = prSnapshot.head.sha;
          // anchor to checkout sha so line numbers match the diff the agent analyzed
          params.commit_id = primary.checkoutSha ?? latestHeadSha;
          if (primary.checkoutSha && latestHeadSha !== primary.checkoutSha) {
            log.info(
              `anchoring review to checkout ${primary.checkoutSha.slice(0, 7)} ` +
                `(HEAD is now ${latestHeadSha.slice(0, 7)})`
            );
          }
        }

        runDiffCoveragePreflight({ ctx });

        type ReviewComment = NonNullable<typeof params.comments>[number];
        const reviewComments = comments.map((comment) => {
          let commentBody = fixDoubleEscapedString(comment.body || "");
          if (comment.suggestion !== undefined) {
            const suggestionBlock = "```suggestion\n" + comment.suggestion + "\n```";
            commentBody = commentBody ? commentBody + "\n\n" + suggestionBlock : suggestionBlock;
          }
          const side = comment.side || "RIGHT";
          const reviewComment: ReviewComment = {
            path: comment.path,
            line: comment.line,
            body: commentBody,
            side,
          };
          if (comment.start_line != null && comment.start_line !== comment.line) {
            reviewComment.start_line = comment.start_line;
            reviewComment.start_side = side;
          }
          return reviewComment;
        });

        // pre-validate inline comments against the current PR diff. drop any
        // comment that does not anchor to a line inside a hunk, rather than
        // letting GitHub 422 and sink the whole review.
        let droppedComments: DroppedComment[] = [];
        if (reviewComments.length > 0) {
          const commentableMap = await buildCommentableMap(ctx, pull_number);
          const validation = validateInlineComments(reviewComments, commentableMap);
          droppedComments = validation.dropped;
          if (droppedComments.length > 0) {
            log.info(
              `dropping ${droppedComments.length}/${reviewComments.length} inline comment(s) that do not anchor to PR diff lines`
            );
          }
          // always reassign so all-dropped reviews leave params.comments empty
          // instead of carrying the original invalid set (which would 422).
          params.comments = validation.valid;
        }

        // if we dropped comments, surface them in the review body so the
        // author (and the agent, on retry) can see what was skipped.
        if (droppedComments.length > 0) {
          const note = formatDroppedCommentsNote(droppedComments);
          body = body ? body + note : note.replace(/^\n\n/, "");
        }

        // after dropping, an empty non-approve review has nothing left to post.
        if (!approved && !body && !params.comments?.length) {
          log.info("review has no body and all inline comments were dropped — skipping submission");
          return {
            success: true,
            skipped: true,
            reason: "all inline comments were invalid — nothing to post",
            droppedComments,
          };
        }

        // no body → single-step createReview (no footer needed)
        // has body → pending + submit so we can build footer with Fix links using review ID
        //
        // wrap the submission in `yes.op` so GitHub's transient 422 "internal
        // error" body (distinct from anchor / body-length / suggestion 422s,
        // which all cite the specific cause) clears on its own instead of
        // surfacing through the generic 422 handler — that framing sent the
        // agent dropping valid inline comments chasing a non-issue.
        // `bail` scopes retries to the transient body only, so real
        // validation 422s still fail fast.
        let result;
        try {
          result = await yes.op(
            () =>
              body
                ? createAndSubmitWithFooter(ctx, params, {
                    body,
                    approved: approved ?? false,
                    hasComments: (params.comments?.length ?? 0) > 0,
                  })
                : createReviewWithStrandedRecovery(ctx, params),
            {
              retries: TRANSIENT_REVIEW_RETRY_DELAYS_MS,
              bail: (err) => !isTransientReviewError(err),
              name: "review submission",
            }
          )();
        } catch (err: unknown) {
          // the "would approve" verdict was recorded before this POST; a failed
          // submit must roll it back so a transient failure cannot fail-open into
          // an auto-merge with no review actually posted. a later retry re-sets it.
          if (ctx.toolState.approval) ctx.toolState.approval.wouldApprove = false;
          // GitHub's transient 422 "internal error" is distinct from anchor /
          // body-length / suggestion validation failures — framing it with the
          // generic "likely causes (1)(2)(3)" prompt sends the agent dropping
          // comments that were never the problem. after bounded in-tool retry
          // we surface a dedicated message that tells the agent to wait-and-
          // retry or fall back to a body-only review.
          if (isTransientReviewError(err)) {
            const rawMsg = err instanceof Error ? err.message : String(err);
            throw new Error(
              `GitHub returned a transient 422 "internal error" on the reviews endpoint after ${TRANSIENT_REVIEW_RETRY_DELAYS_MS.length + 1} attempts. ` +
                `This is a GitHub-side issue, not a problem with your review content. ` +
                `Do NOT modify or drop inline comments — their content is not the cause. ` +
                `Wait ~30 seconds and call this tool once more with the SAME arguments. ` +
                `If it still fails, submit a body-only review (move all inline feedback into \`body\` as text) so nothing is lost. ` +
                `GitHub said: ${rawMsg}`,
              { cause: err }
            );
          }
          if (getHttpStatus(err) !== 422 || !params.comments?.length) throw err;

          const details = params.comments.map((c) => {
            const line = c.line ?? 0;
            const startLine = c.start_line ?? line;
            const range = startLine !== line ? `${startLine}-${line}` : `${line}`;
            return `${c.path}:${range} (${c.side ?? "RIGHT"})`;
          });
          // a 422 on createReview-with-comments is USUALLY about comment
          // anchors, but could also be about body length, invalid suggestion
          // blocks, etc. include the verbatim GitHub error so the agent can
          // diagnose non-anchor 422s without us having to enumerate every
          // possible GitHub validation rule.
          const rawMsg = err instanceof Error ? err.message : String(err);
          const checkoutRef = formatMcpToolRef(ctx.agentId, "checkout_pr");
          throw new Error(
            `GitHub rejected the review with 422 even after pre-validation. ` +
              `Likely causes (check "GitHub said" below to narrow down): ` +
              `(1) new commits pushed after pre-validation — call \`${checkoutRef}\` again to refresh the diff snapshot, then resubmit; ` +
              `(2) the review body exceeded GitHub's ~65KB limit — shorten it and retry; ` +
              `(3) a \`suggestion\` block is malformed (missing backticks, extra backticks, or wrong indentation) — inspect the affected comments below. ` +
              `If none apply, move the failing comments into the review body as text so the rest still posts. ` +
              `Affected comments: ${details.join(", ")}. ` +
              `GitHub said: ${rawMsg}`,
            { cause: err }
          );
        }
        log.debug(`createReview response: ${JSON.stringify(result.data)}`);
        if (!result.data.id) {
          throw new Error(`createReview returned invalid data: ${JSON.stringify(result.data)}`);
        }
        const reviewId = result.data.id;
        const reviewNodeId = result.data.node_id;
        log.info(`» created review ${reviewId} on pull request #${pull_number}`);

        // reviewedSha = what the agent actually reviewed (checkout SHA), not the
        // submission anchor (current HEAD). this ensures postReviewCleanup dispatches
        // a follow-up if the agent doesn't handle new commits inline.
        const actuallyReviewedSha = primary.checkoutSha ?? params.commit_id;
        ctx.toolState.review = {
          id: reviewId,
          nodeId: reviewNodeId,
          reviewedSha: actuallyReviewedSha,
        };
        // pin the approval verdict to the sha actually reviewed, so the
        // pullfrog-approval check never anchors to a head the agent didn't
        // review. the gate set a provisional checkoutSha, which is undefined
        // for a review submitted without checkout_pr — without this, finalize
        // would fall back to the (possibly moved) live head.
        if (ctx.toolState.approval) ctx.toolState.approval.sha = actuallyReviewedSha;

        ctx.toolState.wasUpdated = true;

        // a submitted review obsoletes the progress comment — the review IS the
        // durable artifact. owned here (not in main.ts) so cleanup is atomic with
        // submission and survives any path out of the run (success, timeout,
        // crash). deleteProgressComment sets progressComment = null, so a later
        // report_progress call short-circuits to a no-op.
        // best-effort: a cleanup failure must not turn a successful review into
        // a tool-call failure visible to the agent.
        await deleteProgressComment(ctx).catch((err) => {
          log.debug(`progress comment cleanup after review failed: ${err}`);
        });
        sealProgressAfterReview(ctx);

        // detect commits pushed since checkout and guide the agent to review them
        // inline instead of dispatching a separate workflow run
        if (primary.checkoutSha && latestHeadSha && latestHeadSha !== primary.checkoutSha) {
          const fromSha = primary.checkoutSha;
          const toSha = latestHeadSha;
          // store old checkoutSha as beforeSha so the next checkout_pr computes an incremental diff
          primary.beforeSha = fromSha;
          // advance checkoutSha so the next review submission tracks correctly (just in case, checkout_pr will overwrite it again)
          primary.checkoutSha = toSha;

          log.info(
            `new commits detected during review: ${fromSha.slice(0, 7)}..${toSha.slice(0, 7)}`
          );

          return {
            success: true,
            reviewId,
            html_url: result.data.html_url,
            state: result.data.state,
            user: result.data.user?.login,
            submitted_at: result.data.submitted_at,
            droppedComments: droppedComments.length > 0 ? droppedComments : undefined,
            newCommits: {
              from: fromSha,
              to: toSha,
              instructions:
                `new commits were pushed while you were reviewing. ` +
                `call \`${formatMcpToolRef(ctx.agentId, "checkout_pr")}\` again to fetch the latest version — it will compute the incremental diff automatically. ` +
                `submit another review covering only the new changes. do not repeat feedback from your previous review.`,
            },
          };
        }

        return {
          success: true,
          reviewId,
          html_url: result.data.html_url,
          state: result.data.state,
          user: result.data.user?.login,
          submitted_at: result.data.submitted_at,
          droppedComments: droppedComments.length > 0 ? droppedComments : undefined,
        };
      }
    ),
  });
}

function runDiffCoveragePreflight(params: { ctx: ToolContext }): void {
  const coverageState = primaryRepoState(params.ctx.toolState).diffCoverage;
  if (!coverageState) {
    log.debug("diff coverage pre-flight skipped: no diffCoverage state present in toolState");
    return;
  }
  if (coverageState.coveragePreflightRan) {
    log.debug("diff coverage pre-flight skipped: already ran in this session");
    return;
  }

  coverageState.coveragePreflightRan = true;
  log.debug(
    `diff coverage pre-flight start: diffPath=${coverageState.diffPath}, totalLines=${coverageState.totalLines}, tocEntries=${coverageState.tocEntries.length}, coveredRanges=${coverageState.coveredRanges.length}`
  );
  const breakdown = getDiffCoverageBreakdown({ state: coverageState });
  const unread: Array<{ path: string; ranges: string; unreadLines: number }> = [];
  let unreadLines = 0;
  for (const file of breakdown.files) {
    if (file.unreadRanges.length === 0) continue;
    const rangesText = file.unreadRanges
      .map((range) => `${range.startLine}-${range.endLine}`)
      .join(", ");
    const fileUnreadLines = countLinesInRanges({ ranges: file.unreadRanges });
    unread.push({ path: file.filename, ranges: rangesText, unreadLines: fileUnreadLines });
    unreadLines += fileUnreadLines;
  }
  log.debug(
    `diff coverage pre-flight breakdown: coveredLines=${breakdown.coveredLines}, unreadLines=${unreadLines}`
  );

  if (unreadLines === 0) {
    log.debug("diff coverage pre-flight passed: no unread regions");
    return;
  }

  log.info(
    `diff coverage pre-flight nudge: unread lines=${unreadLines}, unread files=${unread.length}`
  );
  const unreadText = unread
    .map((entry) => `- ${entry.path} (${entry.unreadLines} lines, ${entry.ranges})`)
    .join("\n");
  throw new Error(
    `diff coverage pre-flight: some TOC regions were not read before review submission. ` +
      `this is a one-time nudge — read the ranges below from ${coverageState.diffPath} on a best-effort basis, then call create_pull_request_review again. ` +
      `you are NOT obligated to read generated artifacts (lockfiles like pnpm-lock.yaml / package-lock.json / yarn.lock / Cargo.lock; codegen output like *.gen.*, *.pb.go, *.generated.*; snapshot/fixture dirs like __snapshots__/; migration metadata like drizzle/meta/, prisma migration SQL). ` +
      `if every unread region is generated, retry immediately without reading. ` +
      `this pre-flight will not block again in this review session.\n\n` +
      `unread TOC regions:\n${unreadText}`
  );
}

type FooterOpts = { body: string; approved: boolean; hasComments: boolean };

/**
 * clear a pending review draft stranded on the PR by a prior hard-killed run
 * (workflow timeout, OOM) so the next createReview can succeed.
 *
 * GitHub enforces one-pending-review-per-user-per-PR. if the previous process
 * died between createReview(PENDING) and submitReview, the draft remains and
 * the next run's createReview 422s with "already has a pending review".
 * listReviews only exposes PENDING reviews to their author, so filtering on
 * state === "PENDING" is already scoped to the authed token's own draft.
 *
 * if `originalErr` is not a pending-review 422, or no leftover is found, this
 * function rethrows `originalErr` so the caller surfaces the original failure.
 * delete failures with 404 (draft already gone) or 422 (draft submitted by a
 * concurrent caller) are swallowed — the caller's retry will succeed in both
 * cases. any other delete error is rethrown unchanged.
 *
 * known limitation: if two runs on the SAME PR share the authed token and
 * overlap in time, the loser's createReview 422s on the winner's still-active
 * draft. recovery would then delete the winner's active draft and the
 * winner's submitReview would 404. this is not distinguishable from a
 * genuinely-stranded draft via the review object alone (PENDING reviews
 * expose no created_at timestamp, and both reviews are authored by the same
 * bot user). rely on workflow-level concurrency controls (e.g. a concurrency
 * key keyed to the PR number) to prevent overlap.
 */
export async function clearStrandedPendingReview(
  ctx: ToolContext,
  params: { owner: string; repo: string; pull_number: number; originalErr: unknown }
): Promise<void> {
  const originalErr = params.originalErr;
  const msg = originalErr instanceof Error ? originalErr.message.toLowerCase() : "";
  if (getHttpStatus(originalErr) !== 422 || !msg.includes("pending review")) throw originalErr;
  // if listReviews itself fails (5xx, rate limit, etc), surface the ORIGINAL
  // 422 rather than the listing failure — "pending review conflict" is the
  // real blocker the caller needs to see. hiding it behind a transient 502
  // sent agents chasing phantom server errors instead of retrying the
  // conflict. log the listing failure for diagnosis but do not mask.
  const reviews = await ctx.octokit
    .paginate(ctx.octokit.rest.pulls.listReviews, {
      owner: params.owner,
      repo: params.repo,
      pull_number: params.pull_number,
      per_page: 100,
    })
    .catch((listErr: unknown) => {
      // surface at info so operators not running at debug still see that
      // recovery was attempted (and why) before the original 422 bubbles up.
      log.info(
        `» listReviews failed during pending-review cleanup, surfacing original 422: ${listErr instanceof Error ? listErr.message : String(listErr)}`
      );
      throw originalErr;
    });
  const leftover = reviews.find((r) => r.state === "PENDING");
  if (!leftover?.id) throw originalErr;
  log.info(
    `» clearing leftover pending review ${leftover.id} (likely stranded by a killed prior run)`
  );
  try {
    await ctx.octokit.rest.pulls.deletePendingReview({
      owner: params.owner,
      repo: params.repo,
      pull_number: params.pull_number,
      review_id: leftover.id,
    });
  } catch (cleanupErr) {
    const cleanupStatus = getHttpStatus(cleanupErr);
    if (cleanupStatus !== 404 && cleanupStatus !== 422) throw cleanupErr;
    log.debug(`» delete of leftover pending ${leftover.id} no-op (status ${cleanupStatus})`);
  }
}

/**
 * single-step createReview (event != PENDING) with stranded-draft recovery.
 * the body path goes through createAndSubmitWithFooter which already recovers
 * from a stranded PENDING draft at its own createReview call. the no-body path
 * used to call createReview directly with no recovery — so a PR whose previous
 * body-path run crashed between createReview(PENDING) and submitReview would
 * permanently 422 any subsequent no-body review (approve-with-no-feedback or
 * comments-only) until a body-path run happened to clear the draft.
 */
export async function createReviewWithStrandedRecovery(
  ctx: ToolContext,
  params: RestEndpointMethodTypes["pulls"]["createReview"]["parameters"]
): Promise<Awaited<ReturnType<typeof ctx.octokit.rest.pulls.createReview>>> {
  try {
    return await ctx.octokit.rest.pulls.createReview(params);
  } catch (err) {
    await clearStrandedPendingReview(ctx, {
      owner: params.owner,
      repo: params.repo,
      pull_number: params.pull_number,
      originalErr: err,
    });
    return await ctx.octokit.rest.pulls.createReview(params);
  }
}

export async function createAndSubmitWithFooter(
  ctx: ToolContext,
  params: RestEndpointMethodTypes["pulls"]["createReview"]["parameters"],
  opts: FooterOpts
): Promise<Awaited<ReturnType<typeof ctx.octokit.rest.pulls.submitReview>>> {
  // create as PENDING (strip event) so we get the review ID before publishing
  const { event: _, ...pendingParams } = params;
  let pending: Awaited<ReturnType<typeof ctx.octokit.rest.pulls.createReview>>;
  try {
    pending = await ctx.octokit.rest.pulls.createReview(pendingParams);
  } catch (err) {
    await clearStrandedPendingReview(ctx, {
      owner: params.owner,
      repo: params.repo,
      pull_number: params.pull_number,
      originalErr: err,
    });
    pending = await ctx.octokit.rest.pulls.createReview(pendingParams);
  }
  if (!pending.data.id) {
    throw new Error(`createReview returned invalid data: ${JSON.stringify(pending.data)}`);
  }

  // once the pending draft exists, GitHub only allows one pending review per
  // user per PR — so ANY failure between here and successful submit must
  // clean up, not just a submitReview throw. getApiUrl() can throw if
  // API_URL is misconfigured, and future footer-building changes could
  // introduce new throw paths. keep the whole body wrapped.
  try {
    // Fix buttons are suppressed on approving reviews — those are mergeable
    // by definition (the `> ✅ No new issues found.` tier, with no inline
    // comments), so dispatching a fix run would be a UX trap.
    const customParts: string[] = [];
    if (!opts.approved) {
      const apiUrl = getApiUrl();
      if (opts.hasComments) {
        const fixAllUrl = `${apiUrl}/trigger/${ctx.repo.owner}/${ctx.repo.name}/${params.pull_number}?action=fix&review_id=${pending.data.id}`;
        const fixApprovedUrl = `${apiUrl}/trigger/${ctx.repo.owner}/${ctx.repo.name}/${params.pull_number}?action=fix-approved&review_id=${pending.data.id}`;
        customParts.push(`[Fix all ➔](${fixAllUrl})`, `[Fix 👍s ➔](${fixApprovedUrl})`);
      } else {
        const fixUrl = `${apiUrl}/trigger/${ctx.repo.owner}/${ctx.repo.name}/${params.pull_number}?action=fix&review_id=${pending.data.id}`;
        customParts.push(`[Fix it ➔](${fixUrl})`);
      }
    }

    const footer = buildPullfrogFooter({
      workflowRun: ctx.runId
        ? { owner: ctx.repo.owner, repo: ctx.repo.name, runId: ctx.runId, jobId: ctx.jobId }
        : undefined,
      customParts,
      model: ctx.toolState.model,
      fallbackFrom: ctx.toolState.modelFallback?.from,
      clamped: ctx.toolState.modelClamped,
      unselectedProxyDefault: ctx.toolState.unselectedProxyDefault,
      shaPinned: ctx.toolState.shaPinned,
      oss: ctx.oss,
    });

    return await ctx.octokit.rest.pulls.submitReview({
      owner: params.owner,
      repo: params.repo,
      pull_number: params.pull_number,
      review_id: pending.data.id,
      event: params.event!,
      body: opts.body + footer,
    });
  } catch (err) {
    // anything failed after the pending draft was created. leaving the draft
    // on the PR would cause the agent's retry to fail with "already has a
    // pending review" (GitHub's one-pending-per-user-per-PR limit). best-effort
    // cleanup so retries start from a clean slate. the cleanup itself may
    // 404/422 (review already submitted by a concurrent caller, or the PR
    // was closed mid-flight) — log and swallow those so the original error
    // isn't masked.
    try {
      await ctx.octokit.rest.pulls.deletePendingReview({
        owner: params.owner,
        repo: params.repo,
        pull_number: params.pull_number,
        review_id: pending.data.id,
      });
      log.debug(`» deleted leftover pending review ${pending.data.id} after failure`);
    } catch (cleanupErr) {
      log.debug(
        `» failed to delete pending review ${pending.data.id}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`
      );
    }
    throw err;
  }
}

/**
 * report the review node ID so the WorkflowRun is marked as "review submitted".
 * exported for use in main.ts post-agent cleanup.
 */
export async function reportReviewNodeId(
  ctx: ToolContext,
  params: { nodeId: string }
): Promise<void> {
  await patchWorkflowRunFields(ctx, { reviewNodeId: params.nodeId });
}
