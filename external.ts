/**
 * ⚠️ LIMITED IMPORTS - this file is imported by Next.js and must avoid pulling in backend code.
 * All shared constants, types, and data used by both the Next.js app and the action runtime live here.
 * Other files in action/ re-export from this file for backward compatibility.
 */

import type { EffortPosition } from "./effort.ts";

// mcp name constant
export const pullfrogMcpName = "pullfrog";

/** @see {@link file://./agents/shared.ts} Agent interface that uses this type */
export type AgentId = "claude" | "codex" | "opencode" | "dsh";

/**
 * format a tool name the way each agent's MCP client presents it to the model.
 * claude code: mcp__pullfrog__select_mode
 * codex:       pullfrog__select_mode
 * opencode:    pullfrog_select_mode
 * dsh:         mcp__pullfrog__select_mode (DeepSeek Harness mcp-client namespace)
 */
export function formatMcpToolRef(agentId: AgentId, toolName: string): string {
  switch (agentId) {
    case "claude":
      return `mcp__${pullfrogMcpName}__${toolName}`;
    case "codex":
      return `${pullfrogMcpName}__${toolName}`;
    case "opencode":
      return `${pullfrogMcpName}_${toolName}`;
    case "dsh":
      // DeepSeek Harness's mcp-client bridge exposes MCP tools as
      // mcp__<serverName>__<rawName> (see @deepseek-ai/dsh-mcp-client).
      return `mcp__${pullfrogMcpName}__${toolName}`;
    default:
      return agentId satisfies never;
  }
}

/**
 * Every MCP tool name `text` references, parsed with the same naming scheme
 * `formatMcpToolRef` emits. Deliberately lives next to that function so the
 * producer and the parser cannot drift apart.
 *
 * The convention this assumes — and enforces, via `assertPromptToolRefs` — is
 * that a prefixed token appearing anywhere in prompt text IS a tool reference.
 * Prose that merely looks like one would read as a tool reference to the model
 * too, so treating it as a mistake is correct.
 */
export function extractMcpToolRefs(agentId: AgentId, text: string): string[] {
  const prefix = formatMcpToolRef(agentId, "");
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // the prefix must start a token. without this, opencode's `pullfrog_` prefix
  // matches INSIDE a claude-style `mcp__pullfrog__shell` ref and captures
  // `_shell`, which is never a registered name — every run on a repo whose
  // prompt carried a claude-style ref died on the check below.
  return [...text.matchAll(new RegExp(`(?<![A-Za-z0-9_])${escaped}([a-z0-9_]+)`, "g"))].map(
    (match) => match[1]
  );
}

/**
 * Report when the assembled prompt advertises a tool the MCP server did not
 * actually register.
 *
 * Prompt text and tool registration are decided in different files off
 * overlapping conditions (`signedCommits`, `repoIntelligence`, `shell`, the
 * `gh` mirror threshold, …), so they can silently disagree — and the failure
 * mode is invisible: the agent burns turns calling a tool that isn't there, or
 * never learns about one that is. `toolNames` comes straight back from
 * `startMcpHttpServer`, i.e. the list the server registered rather than a
 * second derivation of it, so there is nothing to keep in sync.
 *
 * WARNS rather than throws, and that is deliberate. The prompt embeds
 * customer-authored text — repo instructions, an issue or PR body — so a
 * customer who merely WRITES a prefixed token controls this predicate. Throwing
 * handed them a way to fail every run on their repo, which is what happened to
 * `arcainc/arca` on 0.1.56. A drift check that aborts a customer run is the
 * same mistake 0.1.54 made; the drift still has to be visible, so it is logged.
 */
export function findDanglingPromptToolRefs(params: {
  agentId: AgentId;
  prompt: string;
  toolNames: string[];
}): string[] {
  const registered = new Set(params.toolNames);
  return [...new Set(extractMcpToolRefs(params.agentId, params.prompt))]
    .filter((name) => !registered.has(name))
    .sort();
}

// reasoning effort lives in effort.ts — see wiki/effort.md
export type { EffortPosition } from "./effort.ts";
export {
  DEFAULT_EFFORT_POSITION,
  EFFORT_ALIASES,
  isEffortPosition,
  offeredRungs,
  parseEffortPosition,
  resolveRung,
  rungLabel,
  rungPosition,
} from "./effort.ts";
// model alias registry lives in models.ts — re-exported here for shared access
export type { AutoTier, ModelAlias, ModelProvider, ProviderConfig } from "./models.ts";
export {
  AUTO_EFFICIENT,
  AUTO_INTELLIGENT,
  DEFAULT_PROXY_MODEL,
  defaultAutoTier,
  getAutoSelectHintModel,
  getModelEffortLevels,
  getModelEnvVars,
  getModelManagedCredentials,
  getModelProvider,
  getProviderDisplayName,
  isAutoTier,
  isCardGatedModel,
  isOssAllowedModel,
  modelAliases,
  modelHasStoredAuth,
  OSS_MODEL_ALLOWLIST,
  OSS_RECOMMENDED_MODEL,
  ossFundedModelNames,
  parseModel,
  providers,
  resolveAutoTier,
  resolveCliModel,
  resolveDisplayAlias,
  resolveModelRung,
  resolveModelSlug,
  resolveOpenRouterModel,
} from "./models.ts";

// tool permission types shared with server dispatch
export type ToolPermission = "disabled" | "enabled";
export type ShellPermission = "disabled" | "restricted" | "enabled";
export type PushPermission = "disabled" | "restricted" | "enabled";

// workflow yml permissions for GITHUB_TOKEN
export type WorkflowPermissionValue = "read" | "write" | "none";
export type WorkflowIdTokenPermissionValue = "write" | "none";

export interface WorkflowPermissions {
  actions?: WorkflowPermissionValue;
  attestations?: WorkflowPermissionValue;
  checks?: WorkflowPermissionValue;
  contents?: WorkflowPermissionValue;
  deployments?: WorkflowPermissionValue;
  discussions?: WorkflowPermissionValue;
  "id-token"?: WorkflowIdTokenPermissionValue;
  issues?: WorkflowPermissionValue;
  models?: WorkflowPermissionValue;
  packages?: WorkflowPermissionValue;
  pages?: WorkflowPermissionValue;
  "pull-requests"?: WorkflowPermissionValue;
  "repository-projects"?: WorkflowPermissionValue;
  "security-events"?: WorkflowPermissionValue;
  statuses?: WorkflowPermissionValue;
}

// permission level for the author who triggered the event
// matches GitHub's permission levels: admin > write > maintain > triage > read > none
export type AuthorPermission = "admin" | "maintain" | "write" | "triage" | "read" | "none";

// base interface for common payload event fields
interface BasePayloadEvent {
  issue_number?: number;
  is_pr?: boolean;
  branch?: string;
  /** title of the issue/PR (or contextual title for comments) */
  title?: string;
  /** primary content for this trigger (issue body, PR body, comment body, review body, etc.) */
  body?: string | null;
  comment_id?: number;
  review_id?: number;
  review_state?: string;
  thread?: any;
  pull_request?: any;
  check_suite?: {
    id: number;
    head_sha: string;
    head_branch: string | null;
    status: string | null;
    conclusion: string | null;
    url: string;
  };
  comment_ids?: number[] | "all";
  /** permission level of the user who triggered this event */
  authorPermission?: AuthorPermission;
  /** when true, runs silently without progress comments (e.g., auto-labeling) */
  silent?: boolean;
  [key: string]: any;
}

interface PullRequestOpenedEvent extends BasePayloadEvent {
  trigger: "pull_request_opened";
  issue_number: number;
  is_pr: true;
  title: string;
  body: string | null;
  branch: string;
}

interface PullRequestReadyForReviewEvent extends BasePayloadEvent {
  trigger: "pull_request_ready_for_review";
  issue_number: number;
  is_pr: true;
  title: string;
  body: string | null;
  branch: string;
}

interface PullRequestReviewRequestedEvent extends BasePayloadEvent {
  trigger: "pull_request_review_requested";
  issue_number: number;
  is_pr: true;
  title: string;
  body: string | null;
  branch: string;
}

interface PullRequestReviewSubmittedEvent extends BasePayloadEvent {
  trigger: "pull_request_review_submitted";
  issue_number: number;
  is_pr: true;
  review_id: number;
  /** review body is the primary content */
  body: string | null;
  review_state: string;
  branch: string;
}

interface PullRequestReviewCommentCreatedEvent extends BasePayloadEvent {
  trigger: "pull_request_review_comment_created";
  issue_number: number;
  is_pr: true;
  title: string;
  comment_id: number;
  /** comment body is the primary content (null if already in prompt) */
  body: string | null;
  thread?: any;
  branch: string;
}

interface IssuesOpenedEvent extends BasePayloadEvent {
  trigger: "issues_opened";
  issue_number: number;
  title: string;
  body: string | null;
}

interface IssuesAssignedEvent extends BasePayloadEvent {
  trigger: "issues_assigned";
  issue_number: number;
  title: string;
  body: string | null;
}

interface IssuesLabeledEvent extends BasePayloadEvent {
  trigger: "issues_labeled";
  issue_number: number;
  title: string;
  body: string | null;
}

interface IssueCommentCreatedEvent extends BasePayloadEvent {
  trigger: "issue_comment_created";
  comment_id: number;
  /** distinguishes this from PR review comments (which use pull_request_review_comment_created) */
  comment_type: "issue";
  /** comment body is the primary content (null if already in prompt) */
  body: string | null;
  issue_number: number;
  // PR-specific fields (only present when is_pr is true)
  is_pr?: true;
  branch?: string;
  title?: string;
}

interface CheckSuiteCompletedEvent extends BasePayloadEvent {
  trigger: "check_suite_completed";
  issue_number: number;
  is_pr: true;
  title: string;
  body: string | null;
  pull_request: any;
  branch: string;
  check_suite: {
    id: number;
    head_sha: string;
    head_branch: string | null;
    status: string | null;
    conclusion: string | null;
    url: string;
  };
}

interface WorkflowDispatchEvent extends BasePayloadEvent {
  trigger: "workflow_dispatch";
}

interface FixReviewEvent extends BasePayloadEvent {
  trigger: "fix_review";
  issue_number: number;
  is_pr: true;
  review_id: number;
  /** when true, only address comments the triggerer approved with 👍 (vs all comments) */
  approved_only?: boolean | undefined;
}

interface ImplementPlanEvent extends BasePayloadEvent {
  trigger: "implement_plan";
  issue_number: number;
  is_pr?: true;
  plan_comment_id: number;
  /** plan content is the primary content (null if already in prompt) */
  body: string | null;
}

interface PullRequestSynchronizeEvent extends BasePayloadEvent {
  trigger: "pull_request_synchronize";
  issue_number: number;
  is_pr: true;
  title: string;
  body: string | null;
  branch: string;
  /** SHA before the push -- used to compute incremental range-diff between PR versions */
  before_sha: string;
}

interface UnknownEvent extends BasePayloadEvent {
  trigger: "unknown";
}

// discriminated union for payload event based on trigger
// note: all events use issue_number for consistency (PRs are issues in GitHub's API)
export type PayloadEvent =
  | PullRequestOpenedEvent
  | PullRequestReadyForReviewEvent
  | PullRequestSynchronizeEvent
  | PullRequestReviewRequestedEvent
  | PullRequestReviewSubmittedEvent
  | PullRequestReviewCommentCreatedEvent
  | IssuesOpenedEvent
  | IssuesAssignedEvent
  | IssuesLabeledEvent
  | IssueCommentCreatedEvent
  | CheckSuiteCompletedEvent
  | WorkflowDispatchEvent
  | FixReviewEvent
  | ImplementPlanEvent
  | UnknownEvent;

/**
 * cross-repo intent + resolved access sets, computed server-side from the
 * `--xrepo` flag and the triggerer's own GitHub access. absent on every
 * single-repo run (the default path is byte-identical to today). repo names
 * are owner-implicit — a GitHub App installation is scoped to one account, so
 * every entry shares the primary repo's owner. see utils/flags.ts + wiki.
 */
export interface XrepoConfig {
  /** `all` = bare `--xrepo` (top-N active), `explicit` = `--xrepo=a,b` subset */
  mode: "all" | "explicit";
  /** repo names the triggerer can READ (clone-for-reference); includes primary */
  read: string[];
  /** repo names the triggerer can WRITE (open PRs); subset of `read` */
  write: string[];
  /**
   * repos the triggerer explicitly named (`--xrepo=a,b`) that were NOT granted —
   * unknown to the installation, a different owner, or excluded for lacking a
   * verified per-repo permission. surfaced by `list_repos` so a narrowed request
   * isn't silently swallowed. empty for bare `--xrepo`. optional (defaulted to
   * `[]` on read) so an older server build that predates this field can't
   * hard-fail payload parse against a newer action across a rolling deploy.
   */
  unavailable?: string[] | undefined;
}

// writeable payload type for building payloads
export interface WriteablePayload {
  "~pullfrog": true;
  /** semantic version of the payload to ensure compatibility */
  version: string;
  /** provider/model slug (e.g. "anthropic/claude-opus") */
  model?: string | undefined;
  /**
   * true when `model` came from a per-run override flag (trigger / user prompt
   * `--opus`, `--model=<slug>`). drives the model-access gate: an explicit,
   * inaccessible model hard-fails; a standing default (repo setting or org/repo
   * baseInstructions flag) keeps the soft-fallback safety net. see modelAccess.ts.
   */
  modelExplicit?: boolean | undefined;
  /** reasoning-effort position on [0,1]; 0 is the model's cheapest rung, 1 its priciest */
  effort?: EffortPosition | undefined;
  /**
   * raise this one run's logging (`--debug`, or the `debug` action input): makes
   * `log.debug` output visible and puts the opencode server at INFO. the only
   * way to diagnose a run that fails with an empty log — see
   * wiki/opencode-silent-stall.md. affects what we print, never what the agent
   * may do, so it carries no access/permission consequence.
   */
  debug?: boolean | undefined;
  /** the user's actual request (body if @pullfrog tagged) */
  prompt: string;
  /** github username of the human who triggered this workflow run */
  triggerer?: string | undefined;
  /**
   * org + repo standing instructions (`Account.baseInstructions` then
   * `Repo.baseInstructions`), custom-alias-expanded and reserved-flag-stripped
   * server-side. always applies, regardless of user-prompt precedence — the
   * most-general levels of the leveled-config stack. see utils/flags.ts.
   */
  baseInstructions?: string | undefined;
  /** event-level instructions for this trigger type (flag-expanded server-side) */
  eventInstructions?: string | undefined;
  /**
   * system-injected note about prior superseded runs (e.g. when the
   * triggering @pullfrog comment is edited). rendered alongside the user's
   * prompt rather than via eventInstructions so it survives user-prompt
   * precedence.
   */
  previousRunsNote?: string | undefined;
  /** event data from webhook payload - discriminated union based on trigger field */
  event: PayloadEvent;
  /**
   * cross-repo access sets, resolved server-side. absent ⇒ single-repo run
   * (every cross-repo runtime branch gates on this being present).
   */
  xrepo?: XrepoConfig | undefined;
  /** timeout for agent run (e.g., "10m", "1h30m") - defaults to "1h" */
  timeout?: string | undefined;
  /** working directory for the agent */
  cwd?: string | undefined;
  /** pre-created progress comment (ID + type) for updating status */
  progressComment?: { id: string; type: "issue" | "review" } | undefined;
  /**
   * pre-created `pullfrog` check-run, seeded `in_progress` by the server at dispatch so
   * the PR's checks list shows the run before the GHA runner boots. the action PATCHes
   * it to a terminal conclusion at run end. see `action/utils/runStatusCheck.ts`.
   */
  checkRun?: { id: string } | undefined;
  /** when true, seed the PR summary tmpfile + persist edits at run end */
  generateSummary?: boolean | undefined;
}

// immutable payload type for agent execution
export type Payload = Readonly<WriteablePayload>;

/**
 * Whether `find_similar_issues` is registered for this run: an entitled account,
 * on an issue rather than a PR. Shared by the MCP registration and the prompt so
 * the duplicate-detection instructions can never describe an absent tool.
 */
export function hasSimilarIssues(params: {
  repoIntelligence: boolean;
  event: PayloadEvent;
}): boolean {
  return params.repoIntelligence && !!params.event.issue_number && !params.event.is_pr;
}
