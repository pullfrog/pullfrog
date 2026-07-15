/**
 * Single source of truth for reading, updating, deleting, and creating "progress comments" —
 * the GitHub comments Pullfrog uses to surface a run's status.
 *
 * A progress comment can be one of two distinct GitHub entities with non-overlapping IDs and
 * distinct REST endpoints:
 *   - "issue":  a top-level issue/PR timeline comment (octokit.rest.issues.*Comment)
 *   - "review": an inline PR review-thread comment   (octokit.rest.pulls.*ReviewComment)
 *
 * Callers carry a `ProgressComment` (id + type) value end-to-end so the right endpoint is always
 * picked. Adding a third comment type later means one new branch in this file, not six.
 */

export type ProgressCommentType = "issue" | "review";

export type ProgressComment = {
  id: number;
  type: ProgressCommentType;
};

/**
 * Parse the on-the-wire `{ id: string; type }` shape (the form carried in `JsonPayload`)
 * into the in-memory `ProgressComment` shape. Returns undefined when the id isn't a
 * positive integer so callers can short-circuit cleanly. Callers handle logging.
 */
export function parseProgressComment(
  raw: { id: string; type: ProgressCommentType } | null | undefined
): ProgressComment | undefined {
  if (!raw?.id) return undefined;
  const id = parseInt(raw.id, 10);
  if (Number.isNaN(id) || id <= 0) return undefined;
  return { id, type: raw.type };
}

// minimal Octokit shape needed by the progress-comment helpers. structural so the helper
// can be called from both the action package (@octokit/rest v22) and the root project
// (@octokit/rest v21) without a nominal type clash. only the methods used here are listed.
interface CommentResponse {
  data: { id: number; body?: string | null | undefined; html_url: string; node_id?: string };
}
export interface ProgressCommentOctokit {
  rest: {
    issues: {
      createComment: (params: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }) => Promise<CommentResponse>;
      getComment: (params: {
        owner: string;
        repo: string;
        comment_id: number;
      }) => Promise<CommentResponse>;
      updateComment: (params: {
        owner: string;
        repo: string;
        comment_id: number;
        body: string;
      }) => Promise<CommentResponse>;
      deleteComment: (params: {
        owner: string;
        repo: string;
        comment_id: number;
      }) => Promise<unknown>;
    };
    pulls: {
      createReplyForReviewComment: (params: {
        owner: string;
        repo: string;
        pull_number: number;
        comment_id: number;
        body: string;
      }) => Promise<CommentResponse>;
      getReviewComment: (params: {
        owner: string;
        repo: string;
        comment_id: number;
      }) => Promise<CommentResponse>;
      updateReviewComment: (params: {
        owner: string;
        repo: string;
        comment_id: number;
        body: string;
      }) => Promise<CommentResponse>;
      deleteReviewComment: (params: {
        owner: string;
        repo: string;
        comment_id: number;
      }) => Promise<unknown>;
    };
  };
}

interface ApiCtx {
  octokit: ProgressCommentOctokit;
  owner: string;
  repo: string;
}

export function isNotFoundError(error: unknown): boolean {
  return (
    (typeof error === "object" && error !== null && "status" in error && error.status === 404) ||
    (error instanceof Error && error.message.includes("Not Found"))
  );
}

/**
 * Fetch a progress comment via the appropriate REST endpoint for its type.
 * Returns the common subset of fields callers actually use.
 */
export async function getProgressComment(
  ctx: ApiCtx,
  comment: ProgressComment
): Promise<{ id: number; body: string | undefined; html_url: string }> {
  const result = await (comment.type === "review"
    ? ctx.octokit.rest.pulls.getReviewComment({
        owner: ctx.owner,
        repo: ctx.repo,
        comment_id: comment.id,
      })
    : ctx.octokit.rest.issues.getComment({
        owner: ctx.owner,
        repo: ctx.repo,
        comment_id: comment.id,
      }));
  return {
    id: result.data.id,
    body: result.data.body ?? undefined,
    html_url: result.data.html_url,
  };
}

/**
 * Update a progress comment in place via the appropriate REST endpoint.
 * Returns the common subset of fields callers actually use.
 */
export async function updateProgressComment(
  ctx: ApiCtx,
  comment: ProgressComment,
  body: string
): Promise<{
  id: number;
  body: string | undefined;
  html_url: string;
  node_id: string | undefined;
}> {
  const result = await (comment.type === "review"
    ? ctx.octokit.rest.pulls.updateReviewComment({
        owner: ctx.owner,
        repo: ctx.repo,
        comment_id: comment.id,
        body,
      })
    : ctx.octokit.rest.issues.updateComment({
        owner: ctx.owner,
        repo: ctx.repo,
        comment_id: comment.id,
        body,
      }));
  return {
    id: result.data.id,
    body: result.data.body ?? undefined,
    html_url: result.data.html_url,
    node_id: result.data.node_id,
  };
}

/**
 * Delete a progress comment via the appropriate REST endpoint.
 * Lower-level than `deleteProgressComment` in mcp/comment.ts — that one also clears
 * tool state. Callers that don't have a ToolContext (post cleanup, error handlers)
 * should use this directly; the higher-level wrapper delegates here.
 */
export async function deleteProgressCommentApi(
  ctx: ApiCtx,
  comment: ProgressComment
): Promise<void> {
  try {
    if (comment.type === "review") {
      await ctx.octokit.rest.pulls.deleteReviewComment({
        owner: ctx.owner,
        repo: ctx.repo,
        comment_id: comment.id,
      });
      return;
    }
    await ctx.octokit.rest.issues.deleteComment({
      owner: ctx.owner,
      repo: ctx.repo,
      comment_id: comment.id,
    });
  } catch (error) {
    // Deletion is idempotent: an already-removed progress comment is the
    // desired state, regardless of whether it disappeared locally or remotely.
    if (!isNotFoundError(error)) throw error;
  }
}

/**
 * Discriminated target for `createLeapingProgressComment`. The two variants map to the two
 * distinct GitHub create endpoints; review-reply additionally needs the parent comment ID.
 */
export type CreateProgressCommentTarget =
  | { kind: "issue"; issueNumber: number }
  | { kind: "reviewReply"; pullNumber: number; replyToCommentId: number };

export interface CreatedProgressComment {
  comment: ProgressComment;
  body: string | undefined;
  html_url: string;
}

/**
 * Create the initial "Leaping into action..." progress comment.
 *
 * Reliability: when `kind: "reviewReply"` fails (e.g. the parent comment was deleted or the
 * thread is otherwise unreachable), falls back to a top-level issue comment on the same PR
 * rather than leaving the run with no progress surface. The fallback is logged.
 *
 * (PR # === issue # in GitHub's number space, so `pullNumber` doubles as the fallback target.)
 */
export async function createLeapingProgressComment(
  ctx: ApiCtx,
  target: CreateProgressCommentTarget,
  body: string
): Promise<CreatedProgressComment> {
  if (target.kind === "reviewReply") {
    try {
      const result = await ctx.octokit.rest.pulls.createReplyForReviewComment({
        owner: ctx.owner,
        repo: ctx.repo,
        pull_number: target.pullNumber,
        comment_id: target.replyToCommentId,
        body,
      });
      return {
        comment: { id: result.data.id, type: "review" },
        body: result.data.body ?? undefined,
        html_url: result.data.html_url,
      };
    } catch (error) {
      // console.warn (not the action-flavored log.warning) because this helper runs in
      // both the action runtime and the Next.js webhook context, and we don't want a
      // ::warning:: GitHub Actions annotation leaking into Vercel logs.
      console.warn(
        `[progressComment] review reply failed (parent ${target.replyToCommentId} on PR #${target.pullNumber}), falling back to issue comment:`,
        error
      );
      const fallback = await ctx.octokit.rest.issues.createComment({
        owner: ctx.owner,
        repo: ctx.repo,
        issue_number: target.pullNumber,
        body,
      });
      return {
        comment: { id: fallback.data.id, type: "issue" },
        body: fallback.data.body ?? undefined,
        html_url: fallback.data.html_url,
      };
    }
  }
  const result = await ctx.octokit.rest.issues.createComment({
    owner: ctx.owner,
    repo: ctx.repo,
    issue_number: target.issueNumber,
    body,
  });
  return {
    comment: { id: result.data.id, type: "issue" },
    body: result.data.body ?? undefined,
    html_url: result.data.html_url,
  };
}
