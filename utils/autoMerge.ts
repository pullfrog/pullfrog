import * as yes from "yes";
import { addFooter } from "../mcp/comment.ts";
import type { ToolContext } from "../mcp/server.ts";
import { log } from "./cli.ts";
import { isPullfrog } from "./isPullfrog.ts";
import { isTransientOctokitError } from "./isTransientNetworkError.ts";
import { countOutstandingPullfrogThreads } from "./outstandingThreads.ts";

/** narrow view of a PR review — the only fields the blocking-verdict logic reads. */
type ReviewVerdict = { user: { login: string } | null; state: string };

/**
 * true when some non-Pullfrog reviewer's latest binding verdict is
 * CHANGES_REQUESTED. GitHub returns reviews in chronological order; a later
 * APPROVED or DISMISSED from the same reviewer clears an earlier
 * CHANGES_REQUESTED, and COMMENTED/PENDING never change standing. pure so the
 * blocking-verdict logic is inspectable without the merge round-trip. still
 * load-bearing on a CI-only-protected repo, which won't otherwise honor a human
 * CHANGES_REQUESTED as a required review.
 */
function hasBlockingHumanReview(reviews: ReviewVerdict[]): boolean {
  const latestByReviewer = new Map<string, "APPROVED" | "CHANGES_REQUESTED">();
  for (const review of reviews) {
    const login = review.user?.login;
    if (!login || isPullfrog(login)) continue;
    if (review.state === "APPROVED" || review.state === "CHANGES_REQUESTED") {
      latestByReviewer.set(login, review.state);
    } else if (review.state === "DISMISSED") {
      latestByReviewer.delete(login);
    }
  }
  for (const state of latestByReviewer.values()) {
    if (state === "CHANGES_REQUESTED") return true;
  }
  return false;
}

const ENABLE_AUTO_MERGE = /* GraphQL */ `
  mutation ($pullRequestId: ID!, $headSha: GitObjectID!) {
    enablePullRequestAutoMerge(input: {
      pullRequestId: $pullRequestId
      mergeMethod: SQUASH
      expectedHeadOid: $headSha
    }) { clientMutationId }
  }`;

/**
 * GitHub 422 `Pull request is in clean status` — nothing left for native
 * auto-merge to wait on, so the PR is immediately mergeable → merge directly.
 */
const isAlreadyMergeable = (error: unknown): boolean =>
  error instanceof Error && /clean status/i.test(error.message);

/**
 * GitHub rejects `enablePullRequestAutoMerge` when `expectedHeadOid` no longer
 * matches the head — a commit landed in the read→enable window, so we'd arm a
 * head we never reviewed. benign: the same "don't merge an unreviewed head"
 * outcome the direct-merge 409 guards, not a failure. it surfaces as a GraphQL
 * error (HTTP 200, no `.status`), so the caller's status===409 quieting can't
 * see it — classify it here as a skip.
 */
const isHeadChanged = (error: unknown): boolean =>
  error instanceof Error && /head has changed|expected head/i.test(error.message);

/**
 * GitHub rejects `enablePullRequestAutoMerge` with "Auto merge is not allowed
 * for this repository" when the repo-level `Allow auto-merge` setting is off
 * (Settings > General > Pull Requests, off by default). not the `clean status`
 * 422, so it would otherwise surface only as a server-side warn — classify it so
 * the caller can post an actionable PR comment instead.
 */
const isAutoMergeDisallowed = (error: unknown): boolean =>
  error instanceof Error && /not allowed/i.test(error.message);

/**
 * Run-end lifecycle action: hand any PR this run mechanically approved on its
 * current head to GitHub's NATIVE auto-merge — Pullfrog acting as a full repo
 * maintainer, contributor PRs included. There is deliberately NO agent-callable
 * merge tool — the merge is a deterministic consequence of the recorded approval
 * verdict, so a prompt-injected agent has no merge surface to reach for.
 *
 * Native auto-merge waits for all REQUIRED checks + reviews (un-fakeable by a
 * fork), respects the human veto via branch protection, and requires branch
 * protection to exist. We keep only the Pullfrog-specific pre-gates GitHub can't
 * express: armed toggles, approved-THIS-head, zero outstanding Pullfrog threads,
 * no human CHANGES_REQUESTED. Best-effort — the caller wraps this in `.catch`,
 * and a merge/comment failure can never flip the run's outcome.
 *
 * The invariant (all must hold):
 *   1. `ctx.autoMergeEnabled` — the per-repo toggle ANDed with the global
 *      `isAutonomousMaintenanceEnabled()` kill switch, server-side (run-context).
 *   2. `ctx.prApproveEnabled` — cannot auto-merge what it may not approve.
 *   3. this run recorded an APPROVE verdict (`toolState.approval.wouldApprove`).
 *   4. the PR is open and not a draft.
 *   5. `toolState.approval.sha === <current head sha>` — approved THIS head.
 *   6. `countOutstandingPullfrogThreads === 0` — re-queried at merge time.
 *   7. no un-dismissed human CHANGES_REQUESTED at handoff.
 * The remaining wait-for-required-checks + wait-for-required-reviews semantics
 * are GitHub's, via native auto-merge and branch protection.
 */
export async function autoMergeAfterApprove(ctx: ToolContext): Promise<void> {
  if (!ctx.autoMergeEnabled) return;
  if (!ctx.prApproveEnabled) return;

  const approval = ctx.toolState.approval;
  if (!approval?.wouldApprove) return;

  const pullNumber = ctx.payload.event.issue_number;
  if (typeof pullNumber !== "number") return;

  const skip = (reason: string): void =>
    log.info(
      `autoMerge: pr=#${pullNumber} approvalSha=${approval.sha?.slice(0, 7)} → skipped: ${reason}`
    );

  // attributable audit comment carrying the standard Pullfrog run footer.
  // best-effort — a failure must not undo the merge/enable or surface as a run error.
  const comment = (body: string): Promise<unknown> =>
    ctx.octokit.rest.issues
      .createComment({
        owner: ctx.repo.owner,
        repo: ctx.repo.name,
        issue_number: pullNumber,
        body: addFooter(ctx, body),
      })
      .catch((err) => log.debug(`autoMerge comment failed: ${err}`));

  const pr = await ctx.octokit.rest.pulls.get({
    owner: ctx.repo.owner,
    repo: ctx.repo.name,
    pull_number: pullNumber,
  });

  if (pr.data.state !== "open") return skip("pr not open");
  if (pr.data.draft) return skip("pr is draft");
  if (pr.data.auto_merge) return skip("auto-merge already enabled");

  const headSha = pr.data.head.sha;
  if (approval.sha !== headSha) return skip(`approval sha != head ${headSha.slice(0, 7)}`);

  const outstanding = await countOutstandingPullfrogThreads(ctx, pullNumber);
  if (outstanding > 0) return skip(`${outstanding} unresolved Pullfrog thread(s)`);

  const reviews = await ctx.octokit.paginate(ctx.octokit.rest.pulls.listReviews, {
    owner: ctx.repo.owner,
    repo: ctx.repo.name,
    pull_number: pullNumber,
    per_page: 100,
  });
  if (hasBlockingHumanReview(reviews)) return skip("human changes requested");

  // hand off to GitHub. enable native auto-merge (waits for required checks +
  // reviews, honors branch protection, expectedHeadOid rejects the enable if the
  // head moved since our read (guards the read→enable window, not the eventual
  // merged head)). a 422 `clean status` means nothing is left to wait on → merge
  // now. any other enable failure (e.g. a push-restricted branch that also blocks
  // the app) surfaces at warn via the caller's `.catch`.
  try {
    await yes.mutation({
      run: () =>
        ctx.octokit.graphql(ENABLE_AUTO_MERGE, {
          pullRequestId: pr.data.node_id,
          headSha,
        }),
      name: "enablePullRequestAutoMerge",
      retry: (error, attempt) =>
        isTransientOctokitError(error) ? yes.delay([500, 2000], attempt) : -1,
    })();
    log.info(`autoMerge: pr=#${pullNumber} @ ${headSha.slice(0, 7)} → native auto-merge enabled`);
    await comment(
      "> ✅ Approved — auto-merge enabled; GitHub will merge once required checks pass."
    );
    return;
  } catch (error) {
    if (isHeadChanged(error)) return skip("head moved during enable");
    if (isAutoMergeDisallowed(error)) {
      await comment(
        "> ⚠️ Approved, but auto-merge is off for this repo. Enable `Allow auto-merge` in Settings > General > Pull Requests."
      );
      return;
    }
    if (!isAlreadyMergeable(error)) throw error;
  }

  // `clean status` = immediately mergeable, which is EITHER a protected branch
  // whose requirements are already met (safe) OR an UNPROTECTED branch with no CI
  // gate at all. a direct merge on the latter would be CI-ungated — the regression
  // native auto-merge exists to avoid, and exactly what the UI/docs promise
  // against. so only direct-merge when the base branch is protected; else refuse
  // (native auto-merge needs branch protection anyway). fail-closed if the
  // metadata read fails.
  const base = await ctx.octokit.rest.repos
    .getBranch({ owner: ctx.repo.owner, repo: ctx.repo.name, branch: pr.data.base.ref })
    .catch(() => null);
  if (!base?.data.protected) return skip("base branch not protected — refusing CI-ungated merge");

  // `sha` pins the merge to the reviewed head — GitHub 409s (absorbed by the
  // caller's `.catch`) if a commit landed in the read→merge window, so a TOCTOU
  // push can't slip in.
  const merge = await ctx.octokit.rest.pulls.merge({
    owner: ctx.repo.owner,
    repo: ctx.repo.name,
    pull_number: pullNumber,
    sha: headSha,
    merge_method: "squash",
    commit_title: `${pr.data.title} (#${pullNumber})`,
  });
  log.info(
    `autoMerge: pr=#${pullNumber} @ ${headSha.slice(0, 7)} → merged directly ${merge.data.sha?.slice(0, 7)}`
  );
  await comment(
    "> ✅ Merged autonomously after Pullfrog approved this PR and resolved all of its own review threads."
  );
}
