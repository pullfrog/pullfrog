import type { RestEndpointMethodTypes } from "@octokit/rest";
import type { ToolContext } from "../mcp/server.ts";
import { primaryRepoState } from "../toolState.ts";
import { log } from "./cli.ts";
import {
  countOutstandingPullfrogThreads,
  type OutstandingThreadsCtx,
} from "./outstandingThreads.ts";
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
 *     a follow-up re-review reports. a review-mode run that ends without a review carries
 *     the prior verdict forward instead (see `resolveCarriedApproval`).
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

  if (checkRunId !== undefined) {
    await finalizeRunStatusCheck({
      octokit: ctx.octokit,
      owner: ctx.repo.owner,
      repo: ctx.repo.name,
      checkRunId,
      conclusion,
      detailsUrl,
      reviewUrl: ctx.toolState.approval?.url,
    })
      .then(() => log.info(`» finalized ${RUN_STATUS_CHECK_NAME} check (${conclusion})`))
      .catch((err) => log.debug(`status checks: ${RUN_STATUS_CHECK_NAME} finalize failed: ${err}`));
  }

  // everything below needs a head sha, which costs an API call — skip it when there is
  // nothing left to post.
  const approval = ctx.toolState.approval;
  const mode = ctx.toolState.selectedMode;
  const carriesVerdict = !approval && (mode === "Review" || mode === "IncrementalReview");
  const needsApprovalCheck =
    ctx.payload.approvalCheck && params.runSucceeded && (approval || carriesVerdict);
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
      reviewUrl: ctx.toolState.approval?.url,
    })
      .then(() => log.info(`» posted ${RUN_STATUS_CHECK_NAME} check (${conclusion})`))
      .catch((err) => log.debug(`status checks: ${RUN_STATUS_CHECK_NAME} post failed: ${err}`));
  }

  // only assert an approval verdict when the run cleanly completed. the verdict is
  // recorded before create_pull_request_review actually submits, so on a failed/crashed
  // run the review may not have landed — leave pullfrog-approval absent (the next run
  // resolves it) rather than post a stale verdict.
  if (!needsApprovalCheck) return;

  let verdict: { wouldApprove: boolean; sha: string; carriedFrom?: string } | undefined;
  if (approval) {
    verdict = { wouldApprove: approval.wouldApprove, sha: approval.sha ?? headSha };
  } else {
    // a review-mode run that submitted no review never asserted the agent's own verdict —
    // so only carry one forward onto the sha it actually checked out.
    const primary = primaryRepoState(ctx.toolState);
    const sha = primary.checkoutSha;
    if (!sha) return;
    const carried = await resolveCarriedApproval(ctx, {
      pullNumber,
      sha,
      beforeSha: primary.beforeSha,
    }).catch((err) => {
      log.debug(`status checks: ${APPROVAL_CHECK_NAME} carry-forward failed: ${err}`);
      return undefined;
    });
    if (!carried) return;
    verdict = { ...carried, sha };
  }

  const carriedNote = verdict.carriedFrom
    ? `\n\nPullfrog re-reviewed this commit without submitting a new review, so this verdict carries forward from ${verdict.carriedFrom.slice(0, 7)}.`
    : "";
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
        carriedNote,
    },
  };
  if (detailsUrl) createParams.details_url = detailsUrl;
  await ctx.octokit.rest.checks
    .create(createParams)
    .then(() => log.info(`» posted ${APPROVAL_CHECK_NAME} check`))
    .catch((err) => log.debug(`status checks: ${APPROVAL_CHECK_NAME} post failed: ${err}`));
}

// newest commits first is what the walk needs, and GraphQL's `last:` is the one way to get
// them in a single call — REST lists PR commits oldest-first.
const RECENT_COMMITS_QUERY = `
query ($owner: String!, $name: String!, $prNumber: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $prNumber) {
      commits(last: 20) { nodes { commit { oid } } }
    }
  }
}
`;

type RecentCommitsResponse = {
  repository: {
    pullRequest: {
      commits: { nodes: ({ commit: { oid: string } } | null)[] | null } | null;
    } | null;
  } | null;
};

type CarriedApprovalCtx = OutstandingThreadsCtx & {
  octokit: {
    rest: {
      checks: {
        listForRef: (params: {
          owner: string;
          repo: string;
          ref: string;
          check_name?: string;
          status?: "queued" | "in_progress" | "completed";
        }) => Promise<{
          data: {
            check_runs: {
              conclusion: string | null;
              completed_at: string | null;
              app?: { slug?: string | null } | null;
            }[];
          };
        }>;
      };
    };
  };
};

/**
 * the verdict for a Review / IncrementalReview run that completed without submitting a
 * review — chiefly IncrementalReview's "no behavioral surface" exit. no verdict was
 * recorded, but leaving `pullfrog-approval` absent strands a required check on the new
 * head with nothing left to post it. so carry the most recent prior verdict forward,
 * gated by the outstanding-thread invariant: a prior approval survives only while no
 * Pullfrog finding is open, and a prior rejection is never upgraded — the agent did not
 * assert approval this run, and a zero thread count alone can't grant it (a body-only
 * finding leaves no thread behind).
 *
 * returns undefined when no recent commit carries a verdict, or when `sha` already does
 * (a re-run on a head that was already reviewed).
 */
export async function resolveCarriedApproval(
  ctx: CarriedApprovalCtx,
  params: { pullNumber: number; sha: string; beforeSha: string | undefined }
): Promise<{ wouldApprove: boolean; carriedFrom: string } | undefined> {
  const response: RecentCommitsResponse = await ctx.octokit.graphql(RECENT_COMMITS_QUERY, {
    owner: ctx.repo.owner,
    name: ctx.repo.name,
    prNumber: params.pullNumber,
  });
  const oids = (response.repository?.pullRequest?.commits?.nodes ?? []).flatMap((node) =>
    node ? [node.commit.oid] : []
  );
  // walk back from the assessed sha: commits after it (a mid-run push) hold no prior
  // verdict. a force-push drops the reviewed commits from the list, which is why the
  // pre-push head (`beforeSha`) is checked right after `sha` itself.
  const at = oids.lastIndexOf(params.sha);
  const older = (at === -1 ? oids : oids.slice(0, at)).reverse();
  for (const ref of new Set([params.sha, params.beforeSha, ...older])) {
    if (!ref) continue;
    // a force-pushed-away `beforeSha` may no longer resolve; that is "no verdict there".
    // anywhere else an error must abort — skipping a commit whose verdict we failed to read
    // could carry an older, more favorable one past it.
    const conclusion = await latestApprovalConclusion(ctx, ref).catch((err: unknown) => {
      if (oids.includes(ref)) throw err;
      return undefined;
    });
    if (conclusion === undefined) continue;
    if (ref === params.sha) return undefined;
    if (conclusion !== "success") return { wouldApprove: false, carriedFrom: ref };
    const outstanding = await countOutstandingPullfrogThreads(ctx, params.pullNumber);
    return { wouldApprove: outstanding === 0, carriedFrom: ref };
  }
  return undefined;
}

async function latestApprovalConclusion(
  ctx: CarriedApprovalCtx,
  ref: string
): Promise<string | undefined> {
  const result = await ctx.octokit.rest.checks.listForRef({
    owner: ctx.repo.owner,
    repo: ctx.repo.name,
    ref,
    check_name: APPROVAL_CHECK_NAME,
    status: "completed",
  });
  // a workflow's GITHUB_TOKEN posts as GitHub Actions — never a verdict Pullfrog issued.
  const ours = result.data.check_runs.filter((run) => run.app?.slug !== GITHUB_ACTIONS_APP_SLUG);
  ours.sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""));
  return ours[0]?.conclusion ?? undefined;
}
