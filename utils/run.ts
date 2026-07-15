import type { AgentResult } from "../agents/shared.ts";
import type { MainResult } from "../main.ts";
import { reportProgress } from "../mcp/comment.ts";
import type { ToolContext } from "../mcp/server.ts";
import { log } from "./cli.ts";
import { reportErrorToComment } from "./errorReport.ts";

export interface HandleAgentResultParams {
  result: AgentResult;
  toolContext: ToolContext;
  silent: boolean | undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function handleAgentResult(ctx: HandleAgentResultParams): Promise<MainResult> {
  if (!ctx.result.success) {
    // rendering + posting for the `!success` branch lives in
    // `finalizeSuccessRun` (called immediately before this function) so the
    // BYOK billing-exhausted, hang, and api-key bodies land on a single
    // surface — both for runs with a pre-existing progress comment AND for
    // silent triggers via `createIfMissing`. see #835.
    return {
      success: false,
      error: ctx.result.error || "Agent execution failed",
      output: ctx.result.output!,
    };
  }

  // IncrementalReview's non-substantive path exits cleanly without
  // submitting any review, so no MCP write tool flips wasUpdated and the
  // strict completion check below would otherwise fail the run. The
  // isReviewMode skip is load-bearing for that path: the agent's exit
  // code is the completion signal, not a progress-comment write.
  // (Review mode that submits a real review now flips wasUpdated via
  // create_pull_request_review, so the skip is redundant for the
  // substantive-review path but kept for symmetry with IncrementalReview.)
  // See plans/review_progress_comment_cleanup_b0120f6c.plan.md.
  const toolState = ctx.toolContext.toolState;
  const mode = toolState.selectedMode;
  const isReviewMode = mode === "Review" || mode === "IncrementalReview";
  if (!isReviewMode && !toolState.wasUpdated && toolState.hadProgressComment && !ctx.silent) {
    // the agent exited successfully but never landed a GitHub write — either it
    // answered the mention in raw assistant text (which is never posted, only
    // logged) or a write tool failed (e.g. report_progress hit a 401). salvage
    // by delivering the content we have to the progress comment so the user
    // actually gets the answer instead of a failed run. (finalizeSuccessRun
    // preserves the progress comment whenever wasUpdated is false, so the write
    // lands here.)
    //
    // stop the todo tracker first: on this path the agent used todowrite but
    // never called report_progress, so a pending debounced render could still
    // be queued — draining it keeps it from clobbering the salvaged answer and
    // from holding the event loop open. mirrors ReportProgressTool.
    const tracker = toolState.todoTracker;
    if (tracker) {
      tracker.cancel();
      await tracker.settled();
    }
    // `lastProgressBody` is the body a failed report_progress already assembled
    // (task-list collapsible included), so use it verbatim; otherwise fall back
    // to the agent's final assistant text and append the collapsible the way
    // report_progress would.
    let salvage = toolState.lastProgressBody?.trim();
    if (!salvage) {
      const output = ctx.result.output?.trim();
      const collapsible = tracker?.renderCollapsible({ completeInProgress: true });
      salvage = output && collapsible ? `${output}\n\n${collapsible}` : output;
    }
    if (salvage) {
      try {
        await reportProgress(ctx.toolContext, { body: salvage });
        log.success("Task complete.");
        return { success: true, output: ctx.result.output || "" };
      } catch (writeError) {
        // the write itself is failing (auth/permissions) — surface THAT, not
        // the generic "no progress" message, so the real cause isn't masked.
        const error = `failed to deliver agent result: ${getErrorMessage(writeError)}`;
        await reportErrorToComment({
          toolState,
          error,
          title: "Error",
          createIfMissing: true,
        }).catch(() => {});
        return { success: false, error, output: ctx.result.output || "" };
      }
    }

    const error = ctx.result.error || "agent completed without reporting progress";
    try {
      await reportErrorToComment({ toolState, error, title: "Error", createIfMissing: true });
    } catch {}
    return { success: false, error, output: ctx.result.output || "" };
  }

  log.success("Task complete.");

  return {
    success: true,
    output: ctx.result.output || "",
  };
}
