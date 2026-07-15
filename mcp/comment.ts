import { type } from "arktype";
import { primaryRepoState } from "../toolState.ts";
import { getApiUrl } from "../utils/apiUrl.ts";
import { buildPullfrogFooter, stripExistingFooter } from "../utils/buildPullfrogFooter.ts";
import { log } from "../utils/cli.ts";
import { fixDoubleEscapedString } from "../utils/fixDoubleEscapedString.ts";
import { patchWorkflowRunFields } from "../utils/patchWorkflowRunFields.ts";
import {
  createLeapingProgressComment,
  deleteProgressCommentApi,
  isNotFoundError,
  updateProgressComment,
} from "../utils/progressComment.ts";
import type { ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";

// re-export for backward compat with anything importing the leaping helpers from mcp/comment
export {
  isLeapingIntoActionCommentBody,
  LEAPING_INTO_ACTION_PREFIX,
} from "../utils/leapingComment.ts";

function buildCommentFooter(ctx: ToolContext, customParts?: string[]): string {
  const runId = ctx.runId;
  return buildPullfrogFooter({
    triggeredBy: true,
    workflowRun:
      runId !== undefined
        ? {
            owner: ctx.repo.owner,
            repo: ctx.repo.name,
            runId,
            jobId: ctx.jobId,
          }
        : undefined,
    customParts,
    model: ctx.toolState.model,
    fallbackFrom: ctx.toolState.modelFallback?.from,
    clamped: ctx.toolState.modelClamped,
    unselectedProxyDefault: ctx.toolState.unselectedProxyDefault,
    shaPinned: ctx.toolState.shaPinned,
    oss: ctx.oss,
  });
}

function buildImplementPlanLink(ctx: ToolContext, issueNumber: number, commentId: number): string {
  const apiUrl = getApiUrl();
  return `[Implement plan ➔](${apiUrl}/trigger/${ctx.repo.owner}/${ctx.repo.name}/${issueNumber}?action=implement&comment_id=${commentId})`;
}

export function addFooter(ctx: ToolContext, body: string): string {
  if (/<br\s*\/?>[ \t]*\n(?!\s*\n)/i.test(body)) {
    throw new Error(
      "body contains <br/> followed by a non-blank line, which breaks GitHub markdown rendering. always add a blank line after <br/> tags."
    );
  }
  const bodyWithoutFooter = stripExistingFooter(fixDoubleEscapedString(body));
  const footer = buildCommentFooter(ctx);
  return `${bodyWithoutFooter}${footer}`;
}

export const Comment = type({
  issueNumber: type.number.describe("the issue number to comment on"),
  body: type.string.describe("the comment body content"),
  type: type
    .enumerated("Plan", "Comment")
    .describe(
      "Plan: standalone plan comment on another target. Comment: regular comment (default)."
    )
    .optional(),
});

export function CreateCommentTool(ctx: ToolContext) {
  return tool({
    name: "create_issue_comment",
    mutates: true,
    description:
      "Create a comment on a GitHub issue or PR. " +
      'Example: `create_issue_comment({ issueNumber: 1234, body: "Thanks for the report." })`. ' +
      "For the current run's answer, progress, or plan use report_progress instead. Use this on the current target only when the task explicitly requests a standalone comment. Skip report_progress only when that current-target comment is the task's sole requested deliverable.",
    parameters: Comment,
    execute: execute(async ({ issueNumber, body, type: commentType }) => {
      const bodyWithFooter = addFooter(ctx, body);

      const result = await ctx.octokit.rest.issues.createComment({
        owner: ctx.repo.owner,
        repo: ctx.repo.name,
        issue_number: issueNumber,
        body: bodyWithFooter,
      });

      ctx.toolState.wasUpdated = true;
      log.info(`» created comment ${result.data.id}`);

      if (commentType === "Plan") {
        if (result.data.node_id) {
          await patchWorkflowRunFields(ctx, { planCommentNodeId: result.data.node_id });
        }
        // add "Implement plan" link (needs comment ID, so create-then-update)
        const customParts = [buildImplementPlanLink(ctx, issueNumber, result.data.id)];
        const footer = buildCommentFooter(ctx, customParts);
        const bodyWithPlanLink = `${stripExistingFooter(body)}${footer}`;

        const updateResult = await ctx.octokit.rest.issues.updateComment({
          owner: ctx.repo.owner,
          repo: ctx.repo.name,
          comment_id: result.data.id,
          body: bodyWithPlanLink,
        });
        log.info(`» updated comment ${updateResult.data.id}`);

        return {
          success: true,
          commentId: updateResult.data.id,
          url: updateResult.data.html_url,
          body: updateResult.data.body,
        };
      }

      return {
        success: true,
        commentId: result.data.id,
        url: result.data.html_url,
        body: result.data.body,
      };
    }),
  });
}

export const EditComment = type({
  commentId: type.number.describe("the ID of the comment to edit"),
  body: type.string.describe("the new comment body content"),
});

export function EditCommentTool(ctx: ToolContext) {
  return tool({
    name: "edit_issue_comment",
    mutates: true,
    description: "Edit a GitHub issue comment by its ID",
    parameters: EditComment,
    execute: execute(async ({ commentId, body }) => {
      const bodyWithFooter = addFooter(ctx, body);

      const result = await ctx.octokit.rest.issues.updateComment({
        owner: ctx.repo.owner,
        repo: ctx.repo.name,
        comment_id: commentId,
        body: bodyWithFooter,
      });
      log.info(`» updated comment ${result.data.id}`);

      return {
        success: true,
        commentId: result.data.id,
        url: result.data.html_url,
        body: result.data.body,
        updatedAt: result.data.updated_at,
      };
    }),
  });
}

export const ReportProgress = type({
  body: type.string.describe("the progress update content to share"),
  "target_plan_comment?": type("boolean").describe(
    "for revising an existing plan comment ONLY. set to true only when the PlanEdit checklist from select_mode tells you to (i.e. a prior plan comment was found for this issue). NEVER set on the initial plan post — the initial plan reuses the run's progress comment and is posted by calling report_progress without this flag."
  ),
});

/**
 * Report progress to a GitHub comment.
 *
 * progressComment has three states:
 *   - undefined: no comment yet — will create one if an issue/PR target exists
 *   - object:    active comment — will update it in place via the right REST endpoint for its type
 *   - null:      deliberately deleted (e.g. after submitting a PR review) — skips silently
 *
 * The body is tracked in lastProgressBody for the job summary regardless of comment state,
 * EXCEPT for `liveProgress` (todo-tracker) writes — see the param note below.
 *
 * The "existing plan comment" path always targets a top-level issue comment (plan comments are
 * created by create_issue_comment with type:"Plan", never as review-thread replies).
 */
export async function reportProgress(
  ctx: ToolContext,
  params: { body: string; target_plan_comment?: boolean; liveProgress?: boolean }
): Promise<{
  commentId?: number;
  url?: string;
  body: string;
  action: "created" | "updated" | "skipped";
}> {
  const { body, target_plan_comment } = params;
  // `liveProgress` marks the automatic todo-tracker checklist render — a live
  // progress update, NOT the agent's deliberate final answer. such writes must
  // not record `lastProgressBody` or flip `wasUpdated`: both signal "a real
  // user-facing answer landed", and letting an auto checklist trip them masks
  // the #868 salvage (it would post the checklist instead of the real output,
  // or skip salvage entirely) and triggers stranded-comment deletion.
  if (!params.liveProgress) {
    ctx.toolState.lastProgressBody = body;
  }

  if (params.liveProgress && !ctx.payload.progressComments) {
    return { body, action: "skipped" };
  }

  // silent events (e.g., auto-label, pr-summary Task) should never create or update progress comments.
  // the body is still tracked above for the GitHub Actions job summary.
  if (ctx.payload.event.silent) {
    return { body, action: "skipped" };
  }

  const issueNumber = ctx.payload.event.issue_number ?? primaryRepoState(ctx.toolState).issueNumber;
  const isPlanMode = ctx.toolState.selectedMode === "Plan";
  const apiCtx = { octokit: ctx.octokit, owner: ctx.repo.owner, repo: ctx.repo.name };

  // when editing existing plan: update the plan comment from tool state (set by select_mode)
  if (target_plan_comment === true && ctx.toolState.existingPlanCommentId === undefined) {
    log.warning("target_plan_comment requested but no existingPlanCommentId in tool state");
  }
  if (target_plan_comment === true && ctx.toolState.existingPlanCommentId !== undefined) {
    const commentId = ctx.toolState.existingPlanCommentId;
    const customParts =
      issueNumber !== undefined ? [buildImplementPlanLink(ctx, issueNumber, commentId)] : undefined;
    const bodyWithoutFooter = stripExistingFooter(body);
    const footer = buildCommentFooter(ctx, customParts);
    const bodyWithFooter = `${bodyWithoutFooter}${footer}`;

    const result = await updateProgressComment(
      apiCtx,
      { id: commentId, type: "issue" },
      bodyWithFooter
    );

    if (!params.liveProgress) ctx.toolState.wasUpdated = true;

    if (isPlanMode && result.node_id) {
      await patchWorkflowRunFields(ctx, { planCommentNodeId: result.node_id });
    }

    return {
      commentId: result.id,
      url: result.html_url,
      body: result.body || "",
      action: "updated",
    };
  }

  const existingComment = ctx.toolState.progressComment;

  // if we already have a progress comment, update it
  if (existingComment) {
    const customParts =
      isPlanMode && issueNumber !== undefined
        ? [buildImplementPlanLink(ctx, issueNumber, existingComment.id)]
        : undefined;

    const bodyWithoutFooter = stripExistingFooter(body);
    const footer = buildCommentFooter(ctx, customParts);
    const bodyWithFooter = `${bodyWithoutFooter}${footer}`;

    // a review-reply progress comment (seeded by the AddressReviews dispatch
    // path) can become stale before final delivery — the thread is deleted or
    // otherwise unreachable, so updateReviewComment 404s. rather than fail an
    // already-completed run, fall back to a fresh top-level comment on the PR
    // and retarget future writes there. (#919)
    let result: Awaited<ReturnType<typeof updateProgressComment>>;
    try {
      result = await updateProgressComment(apiCtx, existingComment, bodyWithFooter);
    } catch (error) {
      // only a deliberate write to a stale review-reply comment falls back. a
      // liveProgress (todo-tracker) 404 rethrows — it must never create a
      // user-facing comment, and the next deliberate report_progress recovers.
      if (
        params.liveProgress ||
        existingComment.type !== "review" ||
        !isNotFoundError(error) ||
        issueNumber === undefined
      ) {
        throw error;
      }
      log.warning(
        `progress review comment ${existingComment.id} is gone (404); posting a top-level comment on #${issueNumber} instead`
      );
      const created = await createLeapingProgressComment(
        apiCtx,
        { kind: "issue", issueNumber },
        bodyWithFooter
      );
      ctx.toolState.progressComment = created.comment;
      if (!params.liveProgress) ctx.toolState.wasUpdated = true;
      return {
        commentId: created.comment.id,
        url: created.html_url,
        body: created.body || "",
        action: "created",
      };
    }

    if (!params.liveProgress) ctx.toolState.wasUpdated = true;

    if (isPlanMode && result.node_id) {
      await patchWorkflowRunFields(ctx, { planCommentNodeId: result.node_id });
    }

    return {
      commentId: result.id,
      url: result.html_url,
      body: result.body || "",
      action: "updated",
    };
  }

  // null = progress comment was deleted by stranded-comment cleanup in main.ts
  if (existingComment === null) {
    return { body, action: "skipped" };
  }

  // no existing comment - need an issue/PR to create one on
  // use fallback chain: dynamically set context > event payload
  if (issueNumber === undefined) {
    // no-op: no comment target (e.g., workflow_dispatch events)
    // body is already tracked for job summary
    return { body, action: "skipped" };
  }

  // for new comments, we need to create first, then update with Plan link if in Plan mode
  // self-created progress comments are always top-level issue comments — review-reply
  // progress comments only originate from the dispatch path and arrive pre-created.
  const initialBody = addFooter(ctx, body);
  const created = await createLeapingProgressComment(
    apiCtx,
    { kind: "issue", issueNumber },
    initialBody
  );

  ctx.toolState.progressComment = created.comment;
  if (!params.liveProgress) ctx.toolState.wasUpdated = true;

  // if Plan mode, update the comment to add the "Implement plan" link
  if (isPlanMode) {
    const customParts = [buildImplementPlanLink(ctx, issueNumber, created.comment.id)];
    const bodyWithoutFooter = stripExistingFooter(body);
    const footer = buildCommentFooter(ctx, customParts);
    const bodyWithPlanLink = `${bodyWithoutFooter}${footer}`;

    const updateResult = await updateProgressComment(apiCtx, created.comment, bodyWithPlanLink);

    if (updateResult.node_id) {
      await patchWorkflowRunFields(ctx, { planCommentNodeId: updateResult.node_id });
    }

    return {
      commentId: updateResult.id,
      url: updateResult.html_url,
      body: updateResult.body || "",
      action: "created",
    };
  }

  return {
    commentId: created.comment.id,
    url: created.html_url,
    body: created.body || "",
    action: "created",
  };
}

export function ReportProgressTool(ctx: ToolContext) {
  return tool({
    name: "report_progress",
    mutates: true,
    description:
      "Share progress on the associated GitHub issue/PR. The first call creates a comment; subsequent calls update it in place. " +
      'Example: `report_progress({ body: "Implemented the auth check and added tests." })`. ' +
      "Call this at the end of every run with a brief final summary (1-3 sentences) unless the mode guidance instructs otherwise. The current task list is automatically appended in a collapsible section — do not restate individual steps.",
    parameters: ReportProgress,
    execute: execute(async (params) => {
      let body = params.body;

      // for non-plan calls: stop auto-updates, wait for in-flight writes to settle,
      // then append completed task list collapsible
      if (!params.target_plan_comment && ctx.toolState.todoTracker) {
        ctx.toolState.todoTracker.cancel();
        await ctx.toolState.todoTracker.settled();
        const collapsible = ctx.toolState.todoTracker.renderCollapsible({
          completeInProgress: true,
        });
        if (collapsible) {
          body = `${body}\n\n${collapsible}`;
        }
      }

      const reportParams: { body: string; target_plan_comment?: boolean } = { body };
      if (params.target_plan_comment !== undefined) {
        reportParams.target_plan_comment = params.target_plan_comment;
      }
      const result = await reportProgress(ctx, reportParams);

      if (result.action === "skipped") {
        return {
          success: true,
          message:
            "progress recorded (no GitHub comment created - this may occur for workflow_dispatch events or when there is no associated issue/PR)",
        };
      }

      if (result.commentId !== undefined) {
        log.info(`» ${result.action} comment ${result.commentId}`);
      }

      if (!params.target_plan_comment) {
        ctx.toolState.finalSummaryWritten = true;
      }

      return {
        success: true,
        ...result,
      };
    }),
  });
}

/**
 * Delete the progress comment if it exists.
 * Used by main.ts for stranded-comment cleanup (orphaned "Leaping into action" or
 * checklist left by the todo tracker when the agent didn't call report_progress).
 * Sets progressComment to null so subsequent report_progress calls are no-ops.
 */
export async function deleteProgressComment(ctx: ToolContext): Promise<boolean> {
  const existing = ctx.toolState.progressComment;
  if (!existing) return false;

  await deleteProgressCommentApi(
    { octokit: ctx.octokit, owner: ctx.repo.owner, repo: ctx.repo.name },
    existing
  );

  // set to null (not undefined) so report_progress skips instead of creating a new comment
  ctx.toolState.progressComment = null;

  return true;
}

export const ReplyToReviewComment = type({
  pull_number: type.number.describe("the pull request number"),
  comment_id: type.number.describe("the ID of the review comment to reply to"),
  body: type.string.describe(
    "extremely brief reply (1 sentence max) explaining what was fixed, e.g. 'Fixed by renaming to X' or 'Added null check'"
  ),
});

/**
 * decision returned by `duplicateReplyDecision` when a session has already
 * posted an identical reply to the same parent review comment.
 */
export interface DuplicateReplyDecision {
  kind: "already-replied";
  commentId: number;
  url: string | undefined;
  reason: string;
}

/**
 * decide whether a second reply_to_review_comment call in the same session
 * is a duplicate of an earlier reply to the same parent comment.
 *
 * the agent is instructed to call reply_to_review_comment exactly once per
 * parent comment per AddressReviews session, but in practice it sometimes
 * emits the same call twice. PR #610 reproduced this with Kimi K2:
 * identical body posted 3 seconds apart, only one tool_use event in the
 * agent log. the second post is always redundant and clutters the PR thread.
 *
 * we key on (comment_id, bodyWithFooter) so a legitimate follow-up reply
 * with different content still goes through. within a single run the
 * footer is constant (workflow run + model + jobId), so byte-equal bodies
 * catch the stutter without blocking real follow-ups.
 *
 * mirrors the shape of `duplicateReviewDecision` in mcp/review.ts.
 */
export function duplicateReplyDecision(params: {
  existing: { commentId: number; url: string | undefined; bodyWithFooter: string } | undefined;
  bodyWithFooter: string;
}): DuplicateReplyDecision | null {
  const existing = params.existing;
  if (!existing) return null;
  if (existing.bodyWithFooter !== params.bodyWithFooter) return null;
  return {
    kind: "already-replied",
    commentId: existing.commentId,
    url: existing.url,
    reason: `reply ${existing.commentId} with identical body was already posted in this session; ignoring duplicate call`,
  };
}

export function ReplyToReviewCommentTool(ctx: ToolContext) {
  return tool({
    name: "reply_to_review_comment",
    mutates: true,
    description:
      "Reply to a PR review comment thread (NOT issue comments — this only works for inline review comments on PR diffs). " +
      'Example: `reply_to_review_comment({ pull_number: 1234, comment_id: 567890, body: "Fixed by adding a null check." })`. ' +
      "Call exactly ONCE per parent comment you address in AddressReviews mode — duplicate calls with the same body are a no-op. Keep replies extremely brief (1 sentence max).",
    parameters: ReplyToReviewComment,
    execute: execute(async ({ pull_number, comment_id, body }) => {
      const bodyWithFooter = addFooter(ctx, body);

      // guard against duplicate reply submissions in the same session.
      // see duplicateReplyDecision for the rationale.
      const dup = duplicateReplyDecision({
        existing: ctx.toolState.reviewReplies?.get(comment_id),
        bodyWithFooter,
      });
      if (dup) {
        log.info(`skipping duplicate review reply: ${dup.reason}`);
        return {
          success: true,
          skipped: true,
          reason: dup.reason,
          commentId: dup.commentId,
          url: dup.url,
        };
      }

      const result = await ctx.octokit.rest.pulls.createReplyForReviewComment({
        owner: ctx.repo.owner,
        repo: ctx.repo.name,
        pull_number,
        comment_id,
        body: bodyWithFooter,
      });
      log.info(`» created review comment ${result.data.id} (in reply to ${comment_id})`);

      // mark progress as updated so error reporting + run-result handling know
      // a substantive write happened (used by reportErrorToComment / handleAgentResult)
      ctx.toolState.wasUpdated = true;

      // record this reply for in-session dedupe of subsequent identical calls.
      ctx.toolState.reviewReplies ??= new Map();
      ctx.toolState.reviewReplies.set(comment_id, {
        commentId: result.data.id,
        url: result.data.html_url,
        bodyWithFooter,
      });

      return {
        success: true,
        commentId: result.data.id,
        url: result.data.html_url,
        body: result.data.body,
        in_reply_to_id: result.data.in_reply_to_id,
      };
    }, "reply_to_review_comment"),
  });
}
