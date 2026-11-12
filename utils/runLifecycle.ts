/**
 * End-of-run cleanup phases extracted out of `main.ts`. Four shapes:
 *
 *   - `persistRunArtifacts`: best-effort post-review cleanup + summary +
 *     learnings persistence. Shared by both the success path and the
 *     error-catch path; idempotent (each step has its own guard against
 *     double-execution).
 *
 *   - `finalizeSuccessRun`: success-only — calls `persistRunArtifacts`
 *     first, then surfaces harness-side failures in the progress comment,
 *     deletes stranded progress comments, writes the GitHub Actions job
 *     summary, and emits the structured output marker.
 *
 *   - `finalizeRunChecks`: success-only, after `handleAgentResult` — the
 *     `pullfrog` checks and auto-merge, on the run's final outcome.
 *
 *   - `writeRunErrorOutputs`: error-only — writes the rendered error
 *     summary to the Actions summary tab and mirrors it to the PR
 *     progress comment. The catch path calls this and then
 *     `persistRunArtifacts` separately so the rendered error lands before
 *     the persistence calls, in case the latter throw.
 *
 * All four swallow their own non-fatal errors (`log.debug` or empty
 * `catch {}`) so a cleanup failure can't flip an already-decided run
 * outcome.
 */

import * as core from "@actions/core";
import type { AgentResult } from "../agents/shared.ts";
import { deleteProgressComment } from "../mcp/comment.ts";
import { approveAfterFix } from "../mcp/review.ts";
import type { ToolContext } from "../mcp/server.ts";
import type { ToolState } from "../toolState.ts";
import { autoMergeAfterApprove } from "./autoMerge.ts";
import { formatUsageSummary, log, writeSummary } from "./cli.ts";
import { reportErrorToComment } from "./errorReport.ts";
import { persistLearnings } from "./learnings.ts";
import { persistSummary } from "./prSummary.ts";
import { postReviewCleanup } from "./reviewCleanup.ts";
import { type RenderedRunError, renderRunError } from "./runErrorRenderer.ts";
import { reportStatusChecks } from "./statusChecks.ts";

/**
 * Best-effort cleanup shared by both run-end paths:
 *   1. post-review cleanup (dispatch follow-up re-review on submitted reviews)
 *   2. persist the agent-edited PR summary tmpfile
 *   3. persist the agent-edited repo-level learnings tmpfile
 *
 * Each step is idempotent and swallows its own errors. Safe to call from
 * both `main()`'s success path and its catch path.
 */
export async function persistRunArtifacts(toolContext: ToolContext): Promise<void> {
  await postReviewCleanup(toolContext).catch((error) => {
    log.debug(`post-review cleanup failed: ${error}`);
  });
  await persistSummary(toolContext);
  await persistLearnings(toolContext);
}

/**
 * Run the success-path cleanup waterfall:
 *
 *   1. shared best-effort cleanup via `persistRunArtifacts`
 *   2. when the harness returned `success=false` (e.g. unsubmitted-review
 *      gate exhausted retries, stop-hook persistently failing), render via
 *      `renderRunError` and surface the error in BOTH the progress comment
 *      (rendered.comment) and the Actions job summary (rendered.summary,
 *      prepended below in step 4) — same classifier as the catch path so
 *      the user sees it instead of a deleted-comment void / empty summary
 *      tab
 *   3. when the run succeeded, some write landed (`wasUpdated`), but the
 *      progress comment was never finalized via `report_progress`, delete
 *      the stranded comment (abandoned checklist, or a substantive artifact
 *      written via another MCP write tool that skipped report_progress). a
 *      run where NO write landed keeps its comment for handleAgentResult to
 *      salvage into — see the `wasUpdated` guard below and #868
 *   4. write the GitHub Actions step summary (best-effort — a write
 *      failure must not throw past this point because we'd hit the outer
 *      catch and clobber any progress comment we just wrote)
 *   5. emit the structured output marker for tests + workflow consumers
 */
export async function finalizeSuccessRun(input: {
  toolContext: ToolContext;
  toolState: ToolState;
  result: AgentResult;
  repo: { owner: string; name: string };
}): Promise<void> {
  await persistRunArtifacts(input.toolContext);

  // shared rendering for the !success branch — same classifier as the
  // outer catch path (BillingError reclassify → hang → BYOK billing →
  // api-key → generic), so a harness-returned `{success: false}` lands an
  // actionable error block in the job summary alongside the matching body
  // in the progress comment. hang and generic get the `### ❌ Pullfrog
  // failed` H3 banner; BillingError, BYOK billing, and api-key render
  // their own provider-specific framing (no banner). renders once; reused
  // for both surfaces below.
  const rendered = !input.result.success
    ? renderRunError({
        errorMessage: input.result.error || "agent run failed",
        repo: input.repo,
        agentDiagnostic: input.toolState.agentDiagnostic,
        routerActive: !!input.toolContext.payload.proxyModel,
        model: input.toolState.model,
        credential: input.toolState.credential,
        trial: input.toolState.modelClamped?.reason === "trial",
      })
    : null;

  // `createIfMissing: true` is load-bearing for silent triggers
  // (IncrementalReview / pull_request_synchronize / auto-label) that have
  // no progress comment to update — without it, terminal failures like
  // BYOK billing exhaustion land only in the GH job summary, which most
  // users never open. `reportErrorToComment` no-ops when both progress
  // comment AND issue context are absent. see #835.
  if (rendered) {
    await reportErrorToComment({
      toolState: input.toolState,
      error: rendered.comment,
      createIfMissing: true,
    }).catch((error) => {
      log.debug(`failure error report failed: ${error}`);
    });
  }

  // create_pull_request_review owns its own deletion (see mcp/review.ts), so
  // progressComment is already closed by the time we get here for that path.
  // uses finalSummaryWritten (not todoTracker.enabled or wasUpdated) so
  // cleanup survives API failures in report_progress where cancel() ran but
  // the write didn't succeed, and isn't fooled by writes to *other* artifacts.
  //
  // the extra `wasUpdated` guard preserves the comment when NO write landed at
  // all: that's the case handleAgentResult salvages (raw-text answer / failed
  // report_progress) by writing the agent's result into this very comment, or
  // — when there's nothing to salvage — reports the failure into it. deleting
  // here would strand the user with a vanished "Leaping into action" comment
  // and a no-op error report (see #868).
  if (
    input.result.success &&
    input.toolState.progressComment.status === "open" &&
    input.toolState.wasUpdated &&
    !input.toolState.finalSummaryWritten
  ) {
    await deleteProgressComment(input.toolContext).catch((error) => {
      log.debug(`stranded progress comment cleanup failed: ${error}`);
    });
  }

  try {
    const usageSummary = formatUsageSummary(input.toolState.usageEntries);
    const body = input.toolState.lastProgressBody || input.result.output;
    const parts = [rendered?.summary, body, usageSummary].filter(Boolean);
    if (parts.length > 0) {
      await writeSummary(parts.join("\n\n"));
    }
  } catch (error) {
    log.debug(`job summary write failed: ${error}`);
  }

  if (input.toolState.output) {
    log.info(`::pullfrog-output::${Buffer.from(input.toolState.output).toString("base64")}`);
    core.setOutput("result", input.toolState.output);
  }

  // proactive approve-when-clean for the Fix-all / Fix-👍s flow: when a
  // fix_review run succeeded and every Pullfrog finding it raised is resolved,
  // post an approving review. composes with create_pull_request_review's gate
  // (which blocks a bad approval) — this is the approve side. runs before the
  // status check so the verdict it records lands on `pullfrog-approval`.
  // best-effort: a failure must not flip the run's outcome.
  if (input.result.success) {
    await approveAfterFix(input.toolContext).catch((error) => {
      log.debug(`fix auto-approval failed: ${error}`);
    });
  }
}

/**
 * Finalize the success path's checks on the run's FINAL outcome, which `handleAgentResult` decides
 * after `finalizeSuccessRun`: a run it fails for landing no GitHub write would otherwise leave a
 * green `pullfrog` check, and the first terminal write wins (#1682).
 */
export async function finalizeRunChecks(
  toolContext: ToolContext,
  params: { runSucceeded: boolean }
): Promise<void> {
  // opt-in branch-protection check-runs. own best-effort guard internally.
  await reportStatusChecks(toolContext, params);

  if (params.runSucceeded) {
    // bounded, experimental autonomous merge of any PR Pullfrog approved
    // (contributor PRs included, not just its own). runs after approveAfterFix so
    // it can consume the verdict that call (or create_pull_request_review) just
    // recorded. enables GitHub native auto-merge (or direct-merges an already-
    // mergeable PR); best-effort, never flips the outcome. runs after our own checks
    // are finalized, or their `in_progress` alone makes the PR `unstable` (#1533).
    await autoMergeAfterApprove(toolContext).catch((error) => {
      // 409 = the direct-merge fallback lost a TOCTOU race (a commit landed
      // mid-merge) — the expected "don't merge" outcome, stays quiet. anything
      // else is an unexpected enable/merge failure on an armed repo; surface it at
      // warn so on-call can tell "errored" from a normal skip (info in autoMerge).
      const raced =
        typeof error === "object" && error !== null && "status" in error && error.status === 409;
      if (raced) log.debug(`auto-merge skipped (head moved): ${error}`);
      else log.warning(`auto-merge failed: ${error}`);
    });
  }
}

/**
 * Write the rendered error to the GitHub Actions job summary tab + mirror
 * to the PR progress comment when one exists. Catch path only.
 *
 * `lastProgressBody` and the usage table are appended to the summary so the
 * partial work the agent did before failing isn't lost.
 *
 * `createIfMissing: true` is symmetric with `finalizeSuccessRun` — silent
 * triggers (IncrementalReview / pull_request_synchronize / auto-label) that
 * throw past `finalizeSuccessRun` (e.g. timeout race kills the agent
 * mid-billing-exhausted-retry) reach this catch path with no progress
 * comment to update, and without `createIfMissing` the terminal error
 * lands only in the GH job summary that most users never open. see #835.
 */
export async function writeRunErrorOutputs(input: {
  rendered: RenderedRunError;
  toolState: ToolState;
}): Promise<void> {
  try {
    const usageSummary = formatUsageSummary(input.toolState.usageEntries);
    const parts = [input.rendered.summary, input.toolState.lastProgressBody, usageSummary].filter(
      Boolean
    );
    await writeSummary(parts.join("\n\n"));
  } catch {}

  try {
    await reportErrorToComment({
      toolState: input.toolState,
      error: input.rendered.comment,
      createIfMissing: true,
    });
  } catch (error) {
    log.warning(`error comment failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
