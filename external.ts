/**
 * ⚠️ LIMITED IMPORTS - this file is imported by Next.js and must avoid pulling in backend code.
 * All shared constants, types, and data used by both the Next.js app and the action runtime live here.
 * Other files in action/ re-export from this file for backward compatibility.
 */

// mcp name constant
export const pullfrogMcpName = "pullfrog";

/** @see {@link file://./agents/shared.ts} Agent interface that uses this type */
export type AgentId = "claude" | "opencode" | "antigravity" | "grok";

/**
 * format a tool name the way each agent's MCP client presents it to the model.
 * claude code / antigravity / grok build: mcp__pullfrog__select_mode
 * opencode:    pullfrog_select_mode
 *
 * antigravity and grok default to the Claude-style MCP tool naming used by
 * Claude-compatible CLIs; adjust if either CLI is observed to use a different
 * presentation.
 */
export function formatMcpToolRef(agentId: AgentId, toolName: string): string {
  switch (agentId) {
    case "claude":
    case "antigravity":
    case "grok":
      return `mcp__${pullfrogMcpName}__${toolName}`;
    case "opencode":
      return `${pullfrogMcpName}_${toolName}`;
    default:
      return agentId satisfies never;
  }
}

// model alias registry lives in models.ts — re-exported here for shared access
export type { AutoTier, ModelAlias, ModelProvider, ProviderConfig } from "./models.ts";
export {
  AUTO_EFFICIENT,
  AUTO_INTELLIGENT,
  DEFAULT_PROXY_MODEL,
  defaultAutoTier,
  getAutoSelectHintModel,
  getModelEnvVars,
  getModelManagedCredentials,
  getModelProvider,
  getProviderDisplayName,
  isAutoTier,
  isCardGatedModel,
  modelAliases,
  parseModel,
  providers,
  resolveAutoTier,
  resolveCliModel,
  resolveDisplayAlias,
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
  /** when true, seed the PR summary tmpfile + persist edits at run end */
  generateSummary?: boolean | undefined;
}

// immutable payload type for agent execution
export type Payload = Readonly<WriteablePayload>;
