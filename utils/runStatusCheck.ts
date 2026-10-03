/**
 * Single source of truth for the `pullfrog` commit-status check-run — the row a PR's
 * checks list shows while a run is in flight and after it ends.
 *
 * Pullfrog dispatches its workflow with `ref: <default branch>`, so the GitHub Actions
 * run attaches its check suite to the default branch head and never to the PR head.
 * Nothing about a run is therefore visible from the PR itself unless we post this
 * check-run against the PR head sha ourselves.
 *
 * Created `in_progress` by the server at dispatch — before the runner boots, and
 * upstream of every action-side failure that would otherwise leave the PR silent
 * (billing 402, token resolution, bad model slug, missing provider key). Moved to a
 * terminal conclusion by whichever of three actors reaches it first, all calling
 * `finalizeRunStatusCheck`:
 *
 *   1. the action at run end (`reportStatusChecks`)
 *   2. the `workflow_run.completed` webhook (covers cancel / SIGKILL / early throw)
 *   3. the hourly stuck-run reaper (covers a dropped webhook)
 *
 * That three-layer close-out is what makes an `in_progress` check safe here: a check
 * stranded `in_progress` on a required branch-protection rule would block merges
 * forever, which is why this file did not exist before.
 */

/**
 * the run-lifecycle check. verdict-agnostic — it reports that a run happened, not what it
 * found.
 *
 * **DO NOT RENAME.** A check run has no separate display name, so this string is also the
 * context branch protection matches on. Renaming it on 2026-08-02 stopped the old context
 * reporting and blocked merges on four customer repos; it was reverted. Most installs'
 * branch protection is unreadable to us, so the blast radius cannot even be measured.
 * See wiki/review-approval.md.
 */
export const RUN_STATUS_CHECK_NAME = "pullfrog";

/**
 * GitHub's own Actions app. It publishes a check run per job, named after the
 * job — and the generated workflow's job is also called `pullfrog`, so the
 * collision is structural rather than incidental. Renaming our check is not
 * available: it was tried on 2026-08-02 and blocked merges on four customer
 * repos (see above), so the reuse lookup filters instead. See #1196.
 */
export const GITHUB_ACTIONS_APP_SLUG = "github-actions";

/** the review-verdict check. opt-in, terminal-only, and deliberately separate from the above. */
export const APPROVAL_CHECK_NAME = "pullfrog-approval";

/**
 * The terminal states we report: exactly GitHub's check-run `conclusion` enum.
 *
 * NOT `WorkflowRunStatus`. `stale` is a valid `workflow_run.conclusion` and is
 * NOT a member of the Checks API enum, which GitHub's own 422 enumerates as
 * `["success", "failure", "neutral", "cancelled", "timed_out",
 * "action_required", "skipped"]`. Admitting it here let
 * `checkConclusionFromStatus` type-check while producing a value the wire
 * always rejects, so 100% of reaper-expired rows failed close-out — and since
 * the failure left `checkRunId` set, the hourly sweep re-sent the same illegal
 * conclusion forever. See [#1178](https://github.com/pullfrog/app/issues/1178).
 */
export type RunStatusCheckConclusion =
  | "success"
  | "failure"
  | "cancelled"
  | "timed_out"
  | "action_required"
  | "neutral"
  | "skipped";

/**
 * Parse the on-the-wire `{ id: string }` shape (the form carried in `JsonPayload`) into
 * a check-run id. Mirrors `parseProgressComment` — returns undefined when the id isn't a
 * positive integer so callers can short-circuit cleanly.
 */
export function parseCheckRunId(raw: { id: string } | null | undefined): number | undefined {
  if (!raw?.id) return undefined;
  const id = parseInt(raw.id, 10);
  if (Number.isNaN(id) || id <= 0) return undefined;
  return id;
}

// minimal structural Octokit shape, matching the convention in progressComment.ts: the
// action package is on @octokit/rest v22 and the root project on v21, so a nominal type
// would clash. only the two methods used here are listed.
interface CheckRunResponse {
  data: { id: number };
}
type CheckRunStatus = "queued" | "in_progress" | "completed";
type CheckRunOutput = { title: string; summary: string };

// `details_url` is deliberately `?: string` and never `| undefined`: octokit types it
// that way and the action compiles with `exactOptionalPropertyTypes`, so it must be
// omitted rather than set to undefined. hence the conditional assignment below.
// a `type` (not `interface`) so it gains an implicit index signature and stays
// assignable to octokit's `RequestParameters & {...}` param.
type CreateCheckRunParams = {
  owner: string;
  repo: string;
  name: string;
  head_sha: string;
  status?: CheckRunStatus;
  conclusion?: RunStatusCheckConclusion;
  details_url?: string;
  output?: CheckRunOutput;
};
type UpdateCheckRunParams = {
  owner: string;
  repo: string;
  check_run_id: number;
  status?: CheckRunStatus;
  conclusion?: RunStatusCheckConclusion;
  details_url?: string;
  output?: CheckRunOutput;
};
export interface RunStatusCheckOctokit {
  rest: {
    checks: {
      create: (params: CreateCheckRunParams) => Promise<CheckRunResponse>;
      update: (params: UpdateCheckRunParams) => Promise<CheckRunResponse>;
      get: (params: {
        owner: string;
        repo: string;
        check_run_id: number;
      }) => Promise<{ data: { status: string } }>;
      listForRef: (params: {
        owner: string;
        repo: string;
        ref: string;
        check_name?: string;
        status?: "queued" | "in_progress" | "completed";
      }) => Promise<{
        data: { check_runs: { id: number; app?: { slug?: string | null } | null }[] };
      }>;
    };
  };
}

const IN_PROGRESS_OUTPUT = {
  title: "Pullfrog is running",
  summary: "Pullfrog is working on this pull request. This check updates when the run finishes.",
};

/**
 * Repo console deep-link, anchored at the Review PRs card that holds the toggle. Origin is
 * hardcoded to match `billingErrors.ts`, the established pattern for console links from the
 * action. Appended last to every non-success summary so a user whose merge is blocked by a
 * check they never asked for can reach the off switch — but a one-off failure must not read
 * as "the remedy is to turn this off", so the link names the exact toggle and never leads.
 */
function disableCheckLine(owner: string, repo: string): string {
  const url = `https://pullfrog.com/console/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}#auto-review-prs`;
  return `\n\nThis check reports run status only and gates nothing unless you required it in branch protection. [Turn off the run status check →](${url})`;
}

/**
 * The logs link. GitHub renders `details_url` as "View more details on Pullfrog" whatever it
 * points at, so a summary that says "see the run logs" without linking them leaves the user
 * with no visible way to reach them (measured on a real failed check: the only link in the
 * panel was the off switch). Every finalizer's `detailsUrl` is the Actions run or the
 * pullfrog.com shortlink that redirects to it; undefined means no run ever existed.
 */
function logsLine(detailsUrl: string | undefined): string {
  return detailsUrl ? `\n\n[View the run logs →](${detailsUrl})` : "";
}

const TERMINAL_OUTPUT: Record<RunStatusCheckConclusion, { title: string; summary: string }> = {
  success: {
    title: "Pullfrog run completed",
    summary: "The Pullfrog run finished successfully.",
  },
  failure: {
    title: "Pullfrog run failed",
    summary: "The Pullfrog run failed.",
  },
  cancelled: {
    title: "Pullfrog run cancelled",
    summary: "The Pullfrog run was cancelled before it finished.",
  },
  timed_out: {
    title: "Pullfrog run timed out",
    summary: "The Pullfrog run exceeded its timeout.",
  },
  action_required: {
    title: "Pullfrog run needs attention",
    summary: "The Pullfrog run stopped and needs attention.",
  },
  neutral: {
    title: "Pullfrog run finished",
    summary: "The Pullfrog run finished without a pass or fail outcome.",
  },
  skipped: {
    title: "Pullfrog run skipped",
    summary: "This run was superseded by another Pullfrog run.",
  },
};

/**
 * Terminal output for a conclusion. A non-success links the run logs first — that is what a
 * failed check is for — then the review, and only then the console deep-link, so the off
 * switch is reachable from a check the user never asked for without being the headline.
 */
function terminalOutput(params: {
  conclusion: RunStatusCheckConclusion;
  owner: string;
  repo: string;
  detailsUrl: string | undefined;
  reviewUrl: string | undefined;
}): { title: string; summary: string } {
  const base = TERMINAL_OUTPUT[params.conclusion];
  // `details_url` can only carry one destination, so the rest go here — the summary is
  // rendered markdown in the check's detail panel. (Check-run `actions` are NOT links:
  // they are buttons that fire `check_run.requested_action`, so they cannot navigate.)
  const review = params.reviewUrl
    ? `\n\n[View the review Pullfrog posted →](${params.reviewUrl})`
    : "";
  if (params.conclusion === "success") return { title: base.title, summary: base.summary + review };
  return {
    title: base.title,
    summary:
      base.summary +
      logsLine(params.detailsUrl) +
      review +
      disableCheckLine(params.owner, params.repo),
  };
}

/**
 * Post the `in_progress` check-run on `headSha` and return its id for the finalizers.
 *
 * Best-effort: a transient 5xx, a repo that revoked `checks: write`, or a PR whose head
 * has already been deleted must never stop a run from dispatching. Returns undefined on
 * failure, which every caller treats as "no check to finalize".
 */
export async function createRunStatusCheck(params: {
  octokit: RunStatusCheckOctokit;
  owner: string;
  repo: string;
  headSha: string;
  detailsUrl: string | undefined;
}): Promise<number | undefined> {
  // reuse an in-flight check on this sha rather than adding a second identical row.
  // concurrent Pullfrog runs on one head are routine (an auto-review plus an @pullfrog
  // mention, say), and "is Pullfrog running on this commit?" has one answer, not two.
  // whichever run finishes first resolves it; the others re-PATCH the same conclusion.
  const existing = await params.octokit.rest.checks
    .listForRef({
      owner: params.owner,
      repo: params.repo,
      ref: params.headSha,
      check_name: RUN_STATUS_CHECK_NAME,
      status: "in_progress",
    })
    .catch(() => undefined);
  // ...but only a check we can actually PATCH. the generated workflow names its
  // job `pullfrog`, so GitHub Actions publishes a check run with the SAME name
  // for every Pullfrog run, owned by app 15368. adopting that one meant our own
  // check was never created, `WorkflowRun.checkRunId` pointed at a foreign row,
  // and every close-out path — action, webhook, both reaper sweeps — 403'd with
  // `Invalid app_id 15368`. see #1196.
  const reusable = existing?.data.check_runs.find(
    (run) => run.app?.slug !== GITHUB_ACTIONS_APP_SLUG
  );
  if (reusable) return reusable.id;

  const createParams: CreateCheckRunParams = {
    owner: params.owner,
    repo: params.repo,
    name: RUN_STATUS_CHECK_NAME,
    head_sha: params.headSha,
    status: "in_progress",
    output: IN_PROGRESS_OUTPUT,
  };
  if (params.detailsUrl) createParams.details_url = params.detailsUrl;
  const created = await params.octokit.rest.checks.create(createParams);
  return created.data.id;
}

/**
 * Move an existing check-run to its terminal conclusion.
 *
 * A PATCH, not a second create: `POST /check-runs` with the same name + sha creates a
 * SECOND row rather than replacing the first, so creating twice would show the PR two
 * contradictory `pullfrog` rows. (That is a real bug today — `finalizeSuccessRun` posts
 * success and a later throw posts failure, both as fresh rows.)
 */
export async function finalizeRunStatusCheck(params: {
  octokit: RunStatusCheckOctokit;
  owner: string;
  repo: string;
  checkRunId: number;
  conclusion: RunStatusCheckConclusion;
  detailsUrl: string | undefined;
  reviewUrl?: string | undefined;
}): Promise<void> {
  const updateParams: UpdateCheckRunParams = {
    owner: params.owner,
    repo: params.repo,
    check_run_id: params.checkRunId,
    status: "completed",
    conclusion: params.conclusion,
    output: terminalOutput({
      conclusion: params.conclusion,
      owner: params.owner,
      repo: params.repo,
      detailsUrl: params.detailsUrl,
      reviewUrl: params.reviewUrl,
    }),
  };
  if (params.detailsUrl) updateParams.details_url = params.detailsUrl;
  await params.octokit.rest.checks.update(updateParams);
}

/**
 * Post an already-terminal check-run in one call.
 *
 * The fallback for runs that never got a server-created check to update: a rolling
 * deploy where the dispatch payload predates `checkRun`, or a workflow invoked outside
 * Pullfrog's own dispatch path (`prompt_file`, a hand-written step).
 */
export async function createTerminalRunStatusCheck(params: {
  octokit: RunStatusCheckOctokit;
  owner: string;
  repo: string;
  headSha: string;
  conclusion: RunStatusCheckConclusion;
  detailsUrl: string | undefined;
  reviewUrl?: string | undefined;
}): Promise<void> {
  const createParams: CreateCheckRunParams = {
    owner: params.owner,
    repo: params.repo,
    name: RUN_STATUS_CHECK_NAME,
    head_sha: params.headSha,
    status: "completed",
    conclusion: params.conclusion,
    output: terminalOutput({
      conclusion: params.conclusion,
      owner: params.owner,
      repo: params.repo,
      detailsUrl: params.detailsUrl,
      reviewUrl: params.reviewUrl,
    }),
  };
  if (params.detailsUrl) createParams.details_url = params.detailsUrl;
  await params.octokit.rest.checks.create(createParams);
}

/**
 * Whether this check still needs finalizing.
 *
 * The server-side close-outs are BACKSTOPS: they exist for runs the action could not
 * finalize itself. Firing them unconditionally is actively harmful, because the action
 * writes a richer summary than they can — it knows the review URL, they do not — so a
 * blind re-PATCH silently strips that link seconds after it appears. It also resets
 * `completed_at`, discarding the duration GitHub renders as "Successful in 2m".
 *
 * Returns false when GitHub cannot be reached: a backstop that cannot confirm the check
 * is unfinished must not overwrite a good one.
 */
export async function runStatusCheckNeedsFinalizing(params: {
  octokit: RunStatusCheckOctokit;
  owner: string;
  repo: string;
  checkRunId: number;
}): Promise<boolean> {
  try {
    const existing = await params.octokit.rest.checks.get({
      owner: params.owner,
      repo: params.repo,
      check_run_id: params.checkRunId,
    });
    return existing.data.status !== "completed";
  } catch {
    return false;
  }
}
