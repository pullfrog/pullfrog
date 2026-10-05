import type { AgentCredential, AgentUsage } from "./agents/shared.ts";
import type { PrepResult } from "./prep/types.ts";
import type { AgentDiagnostic } from "./utils/agentHangReport.ts";
import { log } from "./utils/cli.ts";
import type { DiffCoverageState } from "./utils/diffCoverage.ts";
import {
  type ProgressComment,
  type ProgressCommentType,
  parseProgressComment,
} from "./utils/progressComment.ts";
import type { TodoTracker } from "./utils/todoTracking.ts";

export type BackgroundProcess = {
  pid: number;
  outputPath: string;
  pidPath: string;
};

export type BrowserDaemon = { binDir: string; error?: never } | { binDir?: never; error: string };

export type StoredPushDest = {
  remoteName: string;
  remoteBranch: string;
  localBranch: string;
};

/**
 * Valid inline-comment anchor lines per side at a particular checkout SHA.
 * Lives here (not in `mcp/review.ts`) so `ToolState` — which caches
 * `Map<path, CommentableLines>` per checkout — does not pull the MCP server
 * graph into every consumer of run state (the action's main loop, agent
 * harnesses).
 */
export type CommentableLines = { RIGHT: Set<number>; LEFT: Set<number> };

/** access tier of a checked-out repo, drives token routing + push gating. */
export type RepoAccess = "primary" | "write" | "read";

/**
 * per-repo working-tree + PR state. the primary repo is keyed like any other
 * in `toolState.repos`; secondaries are added by `checkout_repo`. this is the
 * single source of truth for all repo-scoped git/PR state — there are no
 * parallel inline fields on `ToolState`. read via `primaryRepoState(toolState)`
 * for primary-only call sites, or `requireRepoState(toolState, owner, name)`
 * when a `repo` param routes to a specific checkout.
 */
export interface RepoToolState {
  owner: string;
  name: string;
  /** working directory: primary = `process.cwd()`; secondary = `ctx.tmpdir/xrepo/<name>` */
  dir: string;
  access: RepoAccess;
  // default branch name. for the primary this comes from ctx.repo.data; for
  // secondaries it's captured by checkout_repo and drives the restricted-mode
  // default-branch push guard.
  defaultBranch?: string;
  // where we're allowed to push - base repo initially, fork URL for fork PRs
  // set by configureRepoGit, updated by checkout_pr. always set before push validation.
  pushUrl?: string;
  // push destination set by checkout_pr - used as primary source in push_branch
  // because git config reads can fail in certain environments
  pushDest?: StoredPushDest;
  // HEAD identity captured by configureRepoGit at run start. load-bearing for the
  // checkout_pr initial-branch invariant: the only sanctioned HEAD positions
  // when calling checkout_pr are the run-entry HEAD or the target `pr-N`.
  // blocks the zed-style cross-PR clobber where a subagent left HEAD on
  // someone else's `pr-X` and the orchestrator's next checkout_pr inherited
  // that position.
  //
  // discriminated by `kind` because `git rev-parse --abbrev-ref HEAD` returns
  // the literal sentinel string `"HEAD"` on detached entry, which is the
  // default state from `actions/checkout` on `pull_request` events (it
  // checks out the merge commit as a detached SHA). without the kind tag,
  // detached-entry runs would trivially accept any future detached state.
  initialHead?: { kind: "branch"; name: string } | { kind: "detached"; sha: string };
  // issue or PR number (same number space in GitHub)
  issueNumber?: number;
  // PR HEAD sha at checkout time — used to detect new commits pushed during a review
  checkoutSha?: string;
  // commentable lines per file at checkoutSha — captured during checkout_pr so
  // review-time inline-comment validation matches the diff GitHub will anchor
  // to (commit_id=checkoutSha). without this, a PR update between checkout and
  // review would make listFiles (latest HEAD) disagree with the anchor,
  // silently dropping valid comments or letting invalid ones through.
  //
  // commentableLinesPullNumber records WHICH PR this snapshot belongs to. if
  // the agent checks out PR B and then reviews PR A in the same session, the
  // cached snapshot for B would silently mis-validate A's comments — keying
  // by PR number forces a re-fetch when the target changes.
  //
  // commentableLinesCheckoutSha pins the snapshot to the SHA it was built
  // against. if a second checkout_pr for the SAME PR bumps checkoutSha but
  // fails before repopulating the cache (e.g., listFiles rate-limits), the
  // stale snapshot would silently mis-validate comments against the new SHA.
  // comparing both fields forces a re-fetch when either moves.
  commentableLinesByFile?: Map<string, CommentableLines>;
  commentableLinesPullNumber?: number;
  commentableLinesCheckoutSha?: string | undefined;
  // SHA to diff incrementally against — set from event payload on first checkout,
  // then from checkoutSha when review.ts detects new commits mid-review
  beforeSha?: string;
  diffCoverage?: DiffCoverageState | undefined;
}

/**
 * mutable per-run record of facts that occurred during execution. shared
 * between the action process and the MCP server (one process — toolState is
 * just a JS object passed by reference into both surfaces).
 *
 * design rule: ToolState is LITERAL. each field records a thing that
 * happened — `review` is set when `create_pull_request_review` succeeded,
 * `finalSummaryWritten` flips when `report_progress` wrote a non-plan body,
 * `selectedMode` is set when `select_mode` was called. fields should never
 * encode the absence of an event ("unsubmittedReview", "missingArtifact"),
 * speculative state, or values derived from other fields.
 *
 * any predicate the rest of the code needs ("the agent picked review mode but
 * never produced a review or progress write") is computed inline at the call
 * site, not stored. derived state in this struct invariably drifts from the
 * literal fields under refactors and is the wrong layer for the check.
 *
 * write narrowly: prefer adding state inside the tool that mutates it (e.g.
 * `create_pull_request_review` populates `toolState.review`) and reading
 * narrowly elsewhere. don't introduce flags from main.ts that mirror what an
 * MCP tool already records.
 */
export interface ToolState {
  // single source of truth for per-repo git/PR working-tree state, keyed by
  // "owner/name". the primary (triggering) repo is keyed like any other —
  // seeded at init; secondaries are added on demand by checkout_repo. read via
  // primaryRepoState() or requireRepoState() — never re-introduce inline
  // per-repo fields here.
  repos: Map<string, RepoToolState>;
  // key into `repos` for the primary (triggering) repo.
  primaryRepoKey: string;
  selectedMode?: string;
  // number of prepush hook failures this run. push_branch runs the hook
  // while this is 0 and skips it once non-zero; never decremented within
  // a run.
  prepushFailureCount: number;
  // consecutive create_pull_request_review calls this session that posted
  // nothing (empty payload). bounded by MAX_CONSECUTIVE_NOOP_SUBMISSIONS so a
  // model that cannot serialize `body` fails loudly instead of looping until it
  // probes the tool with placeholder text. reset by any successful submission.
  noopReviewSubmissions: number;
  backgroundProcesses: Map<string, BackgroundProcess>;
  browserDaemon?: BrowserDaemon | undefined;
  review?: {
    id: number;
    nodeId: string;
    reviewedSha: string | undefined;
  };
  // approval verdict recorded by create_pull_request_review: whether Pullfrog
  // would approve this PR (the agent's `approved` intent AND no outstanding
  // unresolved Pullfrog-originated review threads). drives the opt-in
  // `pullfrog-approval` commit-status check posted at run end. distinct from
  // `review` (which postReviewCleanup deletes) so it survives to finalize.
  // `sha` is the sha the agent reviewed, so the check anchors to it rather
  // than to a head that may have moved mid-run.
  // `url` is the submitted review's html_url when one landed — the artifact a
  // reader most wants from the `Pullfrog` check, so it is surfaced as a link in
  // that check's summary. absent when the run produced no review.
  approval?: { wouldApprove: boolean; sha: string | undefined; url?: string | undefined };
  // the checkoutSha that report_progress's `no_review_needed` declared needs no review —
  // IncrementalReview's non-substantive exit, which carries the prior verdict forward.
  noReviewNeededSha?: string | undefined;
  // dedupe key: parent review comment_id → most-recent reply written this
  // session by reply_to_review_comment. used by duplicateReplyDecision to
  // skip identical-body re-emissions of the same call (PR #610 root cause).
  // body-keyed (not just id-keyed) so legitimate follow-up replies with
  // different content still go through.
  reviewReplies?: Map<
    number,
    { commentId: number; url: string | undefined; bodyWithFooter: string }
  >;
  dependencyInstallation?: {
    status: "not_started" | "in_progress" | "completed" | "failed";
    promise: Promise<PrepResult[]> | undefined;
    results: PrepResult[] | undefined;
  };
  // undefined = no comment yet, object = active comment, null = deliberately deleted
  progressComment: ProgressComment | null | undefined;
  // immutable snapshot: true if a progress comment was pre-created at init time.
  // survives deleteProgressComment so handleAgentResult can still detect "expected but never reported".
  hadProgressComment: boolean;
  lastProgressBody?: string;
  wasUpdated?: boolean;
  // set after a non-plan report_progress successfully writes the final summary.
  // decoupled from todoTracker.enabled so cleanup detection survives API failures.
  finalSummaryWritten?: boolean;
  // set when create_issue_comment posted a standalone comment to the run's OWN
  // target. that comment IS the run's deliverable, so a later report_progress
  // would leave the user with two comments restating each other.
  standaloneCommentId?: number;
  // set by select_mode when Plan + issue_number and plan-comment API returns existing plan (for report_progress target_plan_comment)
  existingPlanCommentId?: number;
  previousPlanBody?: string;
  // absolute path to the PR summary markdown file the agent edits in place.
  // seeded by main.ts before the agent starts when payload.generateSummary is set;
  // read back at end-of-run to persist to DB.
  summaryFilePath?: string;
  // exact bytes of the seeded snapshot file at run start. compared against
  // the file content at end-of-run to detect "agent never touched it" — in
  // that case persistSummary skips the DB write (saving the seed verbatim
  // would either re-write what the DB already has, on incremental runs, or
  // serialize the placeholder scaffold, on first runs).
  summarySeed?: string;
  // set to true after persistSummary completes once. prevents the error-path
  // call (which exists so a successful agent edit before a crash still gets
  // persisted) from redundantly re-running the DB PATCH on the
  // success-then-late-throw path.
  summaryPersistAttempted?: boolean;
  // absolute path to the rolling repo-level learnings markdown file the
  // agent reads at startup and may edit at end-of-run. seeded by main.ts
  // for every run from `Repo.learnings` (empty file when no learnings
  // exist yet); read back at end-of-run to persist any edits.
  learningsFilePath?: string;
  // exact bytes of the seeded learnings file at run start. compared
  // against the file content at end-of-run to detect "agent never touched
  // it" — in that case persistLearnings skips the DB PATCH (saving the
  // identical content would be a no-op write).
  learningsSeed?: string;
  // mirror of `summaryPersistAttempted` for the learnings tmpfile — guards
  // the error-path / exit-signal callers from a redundant second PATCH
  // after the success path already persisted.
  learningsPersistAttempted?: boolean;
  // org-level cross-repo learnings tmpfile — same lifecycle as the repo-level
  // learnings file but seeded from `Account.xrepoLearnings` and only on
  // --xrepo runs. persisted to /api/account/[owner]/xrepo-learnings.
  xrepoLearningsFilePath?: string;
  xrepoLearningsSeed?: string;
  xrepoLearningsPersistAttempted?: boolean;
  output?: string | undefined;
  usageEntries: AgentUsage[];
  model?: string | undefined;
  // the harness that actually ran (`resolveAgent`'s pick), persisted on the
  // end-of-run PATCH. the run row separately records which arm the canary
  // ASSIGNED, so the pair is what exposes an assignment the run didn't honor.
  agent?: string | undefined;
  // which credential the harness actually ran on, decided by the harness because
  // it is the only place that knows: claude-code strips keys to force a
  // precedence, and codex picks auth.json or an API key on mutually exclusive
  // branches. left unset rather than guessed where a harness cannot tell.
  credential?: AgentCredential | undefined;
  // true when the run fell back to the default proxy model purely because the
  // repo has no model selected (Router billing + "auto"). carried into footers
  // so the user can see they're on the cost-optimized default — a weaker
  // reviewer than a frontier model — and pick one. literal record of an event
  // that happened, matching the ToolState design rule.
  unselectedProxyDefault?: boolean | undefined;
  // set in proxy.ts when a no-card Router account had a model (or the
  // intelligent tier) selected and the server clamped it to the efficient
  // default — custom picks are card-gated wholesale. carried into footers so
  // the PR shows "Using <Kimi K2> (<Claude Opus> needs a payment method)"
  // rather than silently presenting Kimi as the user's pick. literal record
  // of an event — matches the ToolState design rule. `reason` distinguishes
  // the card gate ("card") from a pick that has no openRouterResolve yet and
  // no stored provider key ("noRouterPath", a model OpenRouter doesn't serve
  // yet).
  modelClamped?: { from: string; reason: "card" | "noRouterPath" | "oss" | "trial" } | undefined;
  // true when the run's model costs are covered by the Pullfrog for OSS
  // program. carried into footers (incl. error comments built from toolState
  // alone) so the "via Pullfrog for OSS" attribution is consistent everywhere.
  oss?: boolean | undefined;
  todoTracker?: TodoTracker | undefined;
  // mutable handle the agent harness writes to as a run progresses (recent
  // stderr ring buffer reference, last provider-error label, event count).
  // read by main.ts's outer catch so a watchdog-fired activity timeout still
  // surfaces the same agent-side context the harness's own catch path returns
  // via `result.error`. see `utils/agentHangReport.ts`.
  agentDiagnostic?: AgentDiagnostic | undefined;
  /**
   * a `PATCH /api/workflow-run/:id` came back 404 — Pullfrog never dispatched the
   * run or never claimed its reservation, which is permanent for the life of the
   * run (the claim happens at setup, strictly before any PATCH). latched so the
   * remaining calls stop firing: one CI run spent 28 doomed round trips on it.
   * see #1153.
   */
  workflowRunUnclaimed?: boolean | undefined;
}

interface InitToolStateParams {
  progressComment: { id: string; type: ProgressCommentType } | undefined;
  // primary repo identity + working tree (process.cwd()), seeded into `repos`.
  owner: string;
  name: string;
  dir: string;
}

export function initToolState(params: InitToolStateParams): ToolState {
  const resolved = parseProgressComment(params.progressComment);

  if (resolved) {
    log.info(`» using pre-created progress comment: ${resolved.id} (${resolved.type})`);
  }

  const primaryRepoKey = repoKey(params.owner, params.name);
  const repos = new Map<string, RepoToolState>([
    [
      primaryRepoKey,
      { owner: params.owner, name: params.name, dir: params.dir, access: "primary" },
    ],
  ]);

  return {
    repos,
    primaryRepoKey,
    progressComment: resolved,
    hadProgressComment: !!resolved,
    prepushFailureCount: 0,
    noopReviewSubmissions: 0,
    backgroundProcesses: new Map(),
    usageEntries: [],
  };
}

/** stable "owner/name" key for the `repos` map. lowercased — GitHub repo names are case-insensitive. */
export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`.toLowerCase();
}

/** the primary (triggering) repo's state. throws if init hasn't run. */
export function primaryRepoState(toolState: ToolState): RepoToolState {
  const state = toolState.repos.get(toolState.primaryRepoKey);
  if (!state) throw new Error("primary repo state not initialized");
  return state;
}

/**
 * state for a specific checked-out repo. throws when the repo isn't a
 * registered checkout — keeps the push/PR allow-set honest (the only way a
 * secondary becomes registered is via `checkout_repo`).
 */
export function requireRepoState(toolState: ToolState, owner: string, name: string): RepoToolState {
  const state = toolState.repos.get(repoKey(owner, name));
  if (!state) {
    throw new Error(
      `repo ${repoKey(owner, name)} is not a registered checkout — use checkout_repo first`
    );
  }
  return state;
}

/** get-or-create a repo's state (used by checkout_repo when registering a secondary). */
export function ensureRepoState(
  toolState: ToolState,
  init: { owner: string; name: string; dir: string; access: RepoAccess }
): RepoToolState {
  const key = repoKey(init.owner, init.name);
  const existing = toolState.repos.get(key);
  if (existing) return existing;
  const created: RepoToolState = {
    owner: init.owner,
    name: init.name,
    dir: init.dir,
    access: init.access,
  };
  toolState.repos.set(key, created);
  return created;
}
