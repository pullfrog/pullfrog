import type { RestEndpointMethodTypes } from "@octokit/rest";
import type { ToolContext } from "../mcp/server.ts";
import { primaryRepoState } from "../toolState.ts";
import { log } from "./cli.ts";
import { countOutstandingPullfrogThreads } from "./outstandingThreads.ts";
import {
  APPROVAL_CHECK_NAME,
  createTerminalRunStatusCheck,
  finalizeRunStatusCheck,
  GITHUB_ACTIONS_APP_SLUG,
  parseCheckRunId,
  RUN_STATUS_CHECK_NAME,
} from "./runStatusCheck.ts";

/**
 * post the `pullfrog` (run lifecycle) and `pullfrog-approval` (review verdict)
 * commit-status check-runs.
 *
 *   - `Pullfrog` is on by default (`Repo.statusChecks`). the server already created it
 *     `in_progress` at dispatch, so the work here is a PATCH to its terminal conclusion —
 *     see `runStatusCheck.ts` for why a second create would leave two contradictory rows.
 *     the terminal-create fallback covers a payload with no `checkRun` (older server
 *     build mid-rolling-deploy, or a workflow driven outside Pullfrog's dispatch path).
 *   - `pullfrog-approval` stays opt-in (`Repo.approvalCheck`, default off) and terminal-only:
 *     it asserts a review verdict, which only exists once a run produces one. anchored
 *     to the exact reviewed sha so a mid-run push leaves the new head unapproved until
 *     a follow-up re-review reports. a re-review that submits no review carries the
 *     prior verdict forward instead (see `carriedApproval`).
 *
 * best-effort throughout: a check-post failure (transient 5xx, closed PR, revoked
 * permission) must never flip the run's own outcome. the `workflow_run.completed` webhook
 * and both stuck-run reaper sweeps close out a check this function fails to finalize.
 */
export async function reportStatusChecks(
  ctx: ToolContext,
  params: { runSucceeded: boolean }
): Promise<void> {
  const event = ctx.payload.event;
  const pullNumber = event.issue_number;
  if (event.is_pr !== true || typeof pullNumber !== "number") return;
  // the check-run id is the authority, not the setting: if the server seeded a check, it
  // MUST be finalized even when this workflow opted out via `status_checks: disabled`.
  // the server never parses workflow YAML (it only sees `Repo.statusChecks`), so the
  // opt-out cannot prevent the seed — and a seeded check left `in_progress` because the
  // action declined to touch it is strictly worse than the check the user didn't want.
  const checkRunId = parseCheckRunId(ctx.payload.checkRun);
  if (checkRunId === undefined && !ctx.payload.runStatusCheck && !ctx.payload.approvalCheck) return;

  const conclusion = params.runSucceeded ? "success" : "failure";
  const detailsUrl = ctx.runId
    ? `https://github.com/${ctx.repo.owner}/${ctx.repo.name}/actions/runs/${ctx.runId}`
    : undefined;
  const approval = ctx.toolState.approval;
  // a silent run has no progress comment, so a final report that is not a review — a
  // re-review's "no new review was warranted" — otherwise reaches nobody.
  const note = event.silent && !approval?.url ? ctx.toolState.lastProgressBody : undefined;

  if (checkRunId !== undefined) {
    await finalizeRunStatusCheck({
      octokit: ctx.octokit,
      owner: ctx.repo.owner,
      repo: ctx.repo.name,
      checkRunId,
      conclusion,
      detailsUrl,
      reviewUrl: approval?.url,
      note,
    })
      .then(() => log.info(`» finalized ${RUN_STATUS_CHECK_NAME} check (${conclusion})`))
      .catch((err) => log.debug(`status checks: ${RUN_STATUS_CHECK_NAME} finalize failed: ${err}`));
  }

  // a re-review that submits no review records no verdict of its own.
  const carriesApproval = !approval && ctx.toolState.selectedMode === "IncrementalReview";
  // everything below needs a head sha, which costs an API call — skip it when there is
  // nothing left to post.
  const needsApprovalCheck =
    ctx.payload.approvalCheck && params.runSucceeded && (approval !== undefined || carriesApproval);
  const needsFallbackRunCheck = ctx.payload.runStatusCheck && checkRunId === undefined;
  if (!needsApprovalCheck && !needsFallbackRunCheck) return;

  let headSha: string;
  try {
    const pr = await ctx.octokit.rest.pulls.get({
      owner: ctx.repo.owner,
      repo: ctx.repo.name,
      pull_number: pullNumber,
    });
    headSha = pr.data.head.sha;
  } catch (err) {
    log.debug(`status checks: failed to resolve PR #${pullNumber} head sha: ${err}`);
    return;
  }

  if (needsFallbackRunCheck) {
    await createTerminalRunStatusCheck({
      octokit: ctx.octokit,
      owner: ctx.repo.owner,
      repo: ctx.repo.name,
      headSha: primaryRepoState(ctx.toolState).checkoutSha ?? headSha,
      conclusion,
      detailsUrl,
      reviewUrl: approval?.url,
      note,
    })
      .then(() => log.info(`» posted ${RUN_STATUS_CHECK_NAME} check (${conclusion})`))
      .catch((err) => log.debug(`status checks: ${RUN_STATUS_CHECK_NAME} post failed: ${err}`));
  }

  // only assert an approval verdict when the run cleanly completed. the verdict is
  // recorded before create_pull_request_review actually submits, so on a failed/crashed
  // run the review may not have landed — leave pullfrog-approval absent (the next run
  // resolves it) rather than post a stale verdict.
  if (!needsApprovalCheck) return;

  const verdict = approval
    ? { wouldApprove: approval.wouldApprove, sha: approval.sha ?? headSha, carriedLine: "" }
    : await carriedApproval(ctx, pullNumber).catch((err) => {
        log.debug(`status checks: ${APPROVAL_CHECK_NAME} carry-forward failed: ${err}`);
        return undefined;
      });
  if (!verdict) return;

  const createParams: RestEndpointMethodTypes["checks"]["create"]["parameters"] = {
    owner: ctx.repo.owner,
    repo: ctx.repo.name,
    name: APPROVAL_CHECK_NAME,
    head_sha: verdict.sha,
    status: "completed",
    conclusion: verdict.wouldApprove ? "success" : "failure",
    output: {
      title: verdict.wouldApprove ? "Pullfrog would approve" : "Pullfrog would not approve",
      summary:
        (verdict.wouldApprove
          ? "Pullfrog has no outstanding review feedback on this PR."
          : "Pullfrog has outstanding review feedback or requested changes on this PR.") +
        verdict.carriedLine,
    },
  };
  if (detailsUrl) createParams.details_url = detailsUrl;
  await ctx.octokit.rest.checks
    .create(createParams)
    .then(() => log.info(`» posted ${APPROVAL_CHECK_NAME} check`))
    .catch((err) => log.debug(`status checks: ${APPROVAL_CHECK_NAME} post failed: ${err}`));
}

/**
 * the verdict for a re-review that submitted no review. recording none left a PR requiring
 * `pullfrog-approval` blocked on "Expected — Waiting for status to be reported" after every
 * base-branch merge. the verdict on `beforeSha` carries to the checked-out commit, and never
 * one from further back, which would approve changes no run reviewed. a rejection always
 * carries. an approval carries only when the agent declared this commit needs no review
 * (`no_review_needed`) and no Pullfrog finding is open: a run blocked mid-review also ends
 * on `report_progress`, so ending there proves nothing.
 */
async function carriedApproval(ctx: ToolContext, pullNumber: number) {
  const primary = primaryRepoState(ctx.toolState);
  if (!primary.beforeSha || !primary.checkoutSha) return undefined;
  // never shadow a verdict a concurrent review already posted on this commit.
  if ((await latestApprovalConclusion(ctx, primary.checkoutSha)) !== undefined) return undefined;
  const prior = await latestApprovalConclusion(ctx, primary.beforeSha);
  if (prior === undefined) return undefined;
  const from = primary.beforeSha.slice(0, 7);
  if (prior !== "success") {
    const carriedLine = `\n\nNo review covered this commit, so the verdict on ${from} carries forward.`;
    return { wouldApprove: false, sha: primary.checkoutSha, carriedLine };
  }
  if (ctx.toolState.noReviewNeededSha !== primary.checkoutSha) return undefined;
  return {
    wouldApprove: (await countOutstandingPullfrogThreads(ctx, pullNumber)) === 0,
    sha: primary.checkoutSha,
    carriedLine: `\n\nPullfrog found nothing to review in the commits since ${from}.`,
  };
}

/** the conclusion of the newest `pullfrog-approval` on `ref`, if one was posted. */
async function latestApprovalConclusion(ctx: ToolContext, ref: string) {
  const result = await ctx.octokit.rest.checks.listForRef({
    owner: ctx.repo.owner,
    repo: ctx.repo.name,
    ref,
    check_name: APPROVAL_CHECK_NAME,
    status: "completed",
  });
  // a workflow job of the same name posts as GitHub Actions — never a verdict Pullfrog issued.
  const latest = result.data.check_runs
    .filter((run) => run.app?.slug !== GITHUB_ACTIONS_APP_SLUG)
    .sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""))[0];
  return latest?.conclusion ?? undefined;
}
