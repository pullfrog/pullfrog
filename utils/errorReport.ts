import { primaryRepoState, type ToolState } from "../toolState.ts";
import { getApiUrl } from "./apiUrl.ts";
import { buildPullfrogFooter } from "./buildPullfrogFooter.ts";
import { log } from "./cli.ts";
import { createOctokit, parseRepoContext } from "./github.ts";
import { updateProgressComment } from "./progressComment.ts";
import { redactSecrets } from "./secretCommands.ts";
import { getGitHubInstallationToken, getMcpTokenRefresh } from "./token.ts";

interface ReportErrorParams {
  toolState: ToolState;
  error: string;
  /**
   * When the run has no pre-existing progress comment to update (silent
   * IncrementalReview / pull_request_synchronize, mode-less polls), create
   * a fresh issue comment on the primary repo state's `issueNumber` instead of returning
   * silently. Used for terminal errors (BillingError, TransientError) where
   * the GH job summary is the only other surface and most users never open
   * it. see #775.
   */
  createIfMissing?: boolean;
}

export async function reportErrorToComment(ctx: ReportErrorParams): Promise<void> {
  const repoContext = parseRepoContext();
  const octokit = createOctokit(getGitHubInstallationToken(), getMcpTokenRefresh());
  const runId = process.env.GITHUB_RUN_ID
    ? Number.parseInt(process.env.GITHUB_RUN_ID, 10)
    : undefined;

  const customParts: string[] = [];
  if (runId) {
    const apiUrl = getApiUrl();
    customParts.push(
      `[Rerun failed job ➔](${apiUrl}/trigger/${repoContext.owner}/${repoContext.name}/${runId}?action=rerun)`
    );
  }

  const footer = buildPullfrogFooter({
    triggeredBy: true,
    workflowRun: runId ? { owner: repoContext.owner, repo: repoContext.name, runId } : undefined,
    customParts,
    model: ctx.toolState.model,
    clamped: ctx.toolState.modelClamped,
    unselectedProxyDefault: ctx.toolState.unselectedProxyDefault,
    oss: ctx.toolState.oss,
    owner: repoContext.owner,
    failed: true,
  });

  // GitHub masks a registered secret in logs, but a comment posted through the API
  // is never masked — and the error bodies quote provider and tool output.
  const body = `${redactSecrets(ctx.error)}${footer}`;

  const progress = ctx.toolState.progressComment;
  if (progress.status === "open") {
    await updateProgressComment(
      { octokit, owner: repoContext.owner, repo: repoContext.name },
      progress.comment,
      body
    );
    ctx.toolState.wasUpdated = true;
    return;
  }

  // silent triggers (pull_request_synchronize IncrementalReview, etc.)
  // intentionally have no progress comment. for terminal errors that need
  // user action — billing exhaustion, transient billing-service outage —
  // surface a fresh issue comment instead of leaving the GH job summary as
  // the only signal. see #775. a `closed` comment lands here too: the review
  // that replaced it says nothing about this failure.
  if (!ctx.createIfMissing) return;
  const issueNumber = primaryRepoState(ctx.toolState).issueNumber;
  if (!issueNumber) return;

  try {
    const created = await octokit.rest.issues.createComment({
      owner: repoContext.owner,
      repo: repoContext.name,
      issue_number: issueNumber,
      body,
    });
    ctx.toolState.progressComment = {
      status: "open",
      comment: { id: created.data.id, type: "issue" },
    };
    ctx.toolState.wasUpdated = true;
  } catch (error) {
    log.warning(
      `[errorReport] fallback comment create failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
