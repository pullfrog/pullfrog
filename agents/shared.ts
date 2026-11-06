import type { AgentId } from "../external.ts";
import type { ToolState } from "../toolState.ts";
import { log } from "../utils/cli.ts";
import type { ResolvedInstructions } from "../utils/instructions.ts";
import type { ResolvedPayload } from "../utils/payload.ts";
import type { TodoTracker } from "../utils/todoTracking.ts";

// maximum number of stderr lines to keep in the rolling buffer during agent execution
export const MAX_STDERR_LINES = 20;

// ── post-run retry loop ────────────────────────────────────────────────────────

/**
 * how many times the post-run loop may resume the agent to fix a dirty tree
 * or a failing stop hook before giving up.
 */
export const MAX_POST_RUN_RETRIES = 3;

export function buildCommitPrompt(status: string): string {
  return [
    `UNCOMMITTED CHANGES — the working tree is dirty. push all changes to a pull request (new or existing). \`git status\` must be clean before you finish.`,
    "",
    "```",
    status,
    "```",
  ].join("\n");
}

export interface StopHookFailure {
  exitCode: number;
  output: string;
}

export interface SummaryStale {
  /** absolute path to the seeded snapshot file the agent was meant to edit. */
  filePath: string;
}

export interface PostRunIssues {
  stopHook?: StopHookFailure;
  dirtyTree?: string;
  /** populated when the rolling PR summary file is byte-identical to its
   * seed, i.e. the agent never touched it. soft gate — nudges once via a
   * resume turn but never fails the run, parallel to dirtyTree semantics. */
  summaryStale?: SummaryStale;
  /**
   * populated when the agent selected a review mode but the post-run check
   * over toolState shows neither a `create_pull_request_review` submission
   * nor a final `report_progress` write happened. derived inline from
   * `toolState.selectedMode` + `toolState.review` + `toolState.finalSummaryWritten`
   * via {@link getUnsubmittedReview} — no parallel toolState flag is stored.
   * says which exit is still owed so the resume prompt can name it. handled like
   * `stopHook`: nudge via resume, hard-fail if still unsatisfied after
   * `MAX_POST_RUN_RETRIES`.
   */
  unsubmittedReview?: UnsubmittedReview;
}

/** `ReviewOnIssue` is Review mode on an issue target, which cannot owe a pull request review. */
export type UnsubmittedReview = "Review" | "ReviewOnIssue" | "IncrementalReview";

export function hasPostRunIssues(issues: PostRunIssues): boolean {
  return (
    issues.stopHook !== undefined ||
    issues.dirtyTree !== undefined ||
    issues.summaryStale !== undefined ||
    issues.unsubmittedReview !== undefined
  );
}

/**
 * token/cost usage data from a single agent run.
 *
 * NOTE on semantics: `inputTokens` here is the *total* billable input for the
 * run — non-cached input + cache read + cache write — matching the per-agent
 * SDK conventions. This is what gets persisted to `WorkflowRun.inputTokens`.
 *
 * The stdout token table and markdown step summary display a different "Input"
 * column that shows only the non-cached portion (derivable as
 * `inputTokens - cacheReadTokens - cacheWriteTokens`) so humans can see the
 * cache hit ratio at a glance. Dashboards that query `WorkflowRun.inputTokens`
 * directly are seeing the full total, not the log column.
 */
/**
 * Which credential actually paid for a run.
 *
 * `subscription` is the one that changes what a cost figure MEANS: a Claude
 * Pro/Max or ChatGPT subscription moves no per-token money, so a dollar figure
 * on such a run is what it WOULD have cost on the API, not spend. Without this
 * recorded, `WorkflowRun.costUsd` silently mixes the two and there is no way
 * after the fact to separate them.
 */
export type AgentCredential =
  | "subscription"
  | "api_key"
  | "gateway"
  | "bedrock"
  | "vertex"
  | "foundry";

export interface AgentUsage {
  agent: string;
  /** full billable input: non-cached + cache read + cache write */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
  costUsd?: number | undefined;
}

export interface AgentToolUseEvent {
  toolName: string;
  input: unknown;
}

/**
 * Result returned by agent execution
 */
export interface AgentResult {
  success: boolean;
  output?: string | undefined;
  error?: string | undefined;
  metadata?: Record<string, unknown>;
  usage?: AgentUsage | undefined;
}

/**
 * the last stretch before `deadlineAt` belongs to submitting: nothing optional starts in it,
 * and running lenses are interrupted when it begins (#1532, #1524).
 */
export const DEADLINE_RESERVE_MS = 5 * 60_000;

/**
 * Context passed to agent.run() and threaded through the post-run loop.
 *
 * design rule: this is the single object that flows through the harness and
 * downstream utilities by reference. derived predicates (e.g.
 * `getUnsubmittedReview`), tmpfile paths, and seed bytes live on
 * `toolState` — read them at the call site, do not duplicate them onto this
 * interface. utilities that need run state should accept `ctx` whole, not
 * destructure a narrow subset.
 */
export interface AgentRunContext {
  payload: ResolvedPayload;
  /** epoch ms at which main.ts's run timer fires; undefined under `--notimeout`. */
  deadlineAt?: number | undefined;
  resolvedModel?: string | undefined;
  mcpServerUrl: string;
  tmpdir: string;
  /** harness-owned secret paths that agent filesystem tools must never read. */
  secretDenyPaths?: string[] | undefined;
  /**
   * canonical bare names of state-mutating MCP tools the subagent gate must
   * deny (derived from each tool's `mutates` flag). embedded into the per-run
   * gate scripts. see action/agents/subagentToolGates.ts.
   */
  subagentDeniedTools: readonly string[];
  instructions: ResolvedInstructions;
  todoTracker?: TodoTracker | undefined;
  /**
   * user-configured stop hook script. runs after the agent finishes each
   * attempt; non-zero exit resumes the agent with the hook output as
   * guidance. null when the repo has no stop hook configured.
   */
  stopScript?: string | null | undefined;
  /**
   * mutable per-run state shared with the MCP server (by reference). post-run
   * gates read fresh values from it after each agent attempt — `summaryFilePath`,
   * `summarySeed`, `selectedMode`, `review`, `finalSummaryWritten`,
   * `hadProgressComment` are all consulted by `collectPostRunIssues`. see
   * `action/toolState.ts` for the literal-state design rule.
   */
  toolState: ToolState;
  /**
   * called synchronously when the agent subprocess is killed for inner
   * activity timeout. lets main.ts tear down shared resources (MCP HTTP
   * server) so lingering SSE reconnects don't keep the outer timer alive.
   */
  onActivityTimeout?: (() => void) | undefined;
  /**
   * called when an aborted turn actually comes back and the harness intends to
   * keep going. stands down the safety-net timer `onActivityTimeout` armed, so
   * it only ever guards the window where an abort might have been ignored
   * rather than force-exiting a run mid-salvage. see #1085.
   */
  onTurnRecovered?: (() => void) | undefined;
  onToolUse?: ((event: AgentToolUseEvent) => void) | undefined;
  /**
   * Pullfrog API JWT scoped to this run. agents only need this when they
   * have to write state back to Pullfrog mid-run (today: opencode.ts uses
   * it to seed the post-hook's writeback envelope for Codex auth refresh).
   * empty string when the run wasn't context-resolved (e.g. local dry-runs).
   */
  apiToken: string;
}

export interface Agent {
  name: AgentId;
  install: (token?: string) => Promise<string>;
  run: (ctx: AgentRunContext) => Promise<AgentResult>;
}

export const agent = (input: Agent): Agent => {
  return {
    ...input,
    run: async (ctx: AgentRunContext): Promise<AgentResult> => {
      log.debug(`» payload: ${JSON.stringify(ctx.payload, null, 2)}`);
      return input.run(ctx);
    },
  };
};

/** format a USD cost to 4 decimal places, always showing the leading zero */
export function formatCostUsd(costUsd: number): string {
  return costUsd.toFixed(4);
}

/**
 * merge two AgentUsage snapshots into one running total.
 *
 * both agent harnesses invoke their runner multiple times per `run()` when the
 * post-run retry loop kicks in (MAX_POST_RUN_RETRIES). each invocation
 * produces its own AgentUsage; we sum them so downstream callers (usage
 * summary, WorkflowRun persistence) see the whole session — not just the
 * final retry's slice.
 *
 * returns `undefined` when both sides are empty so callers can short-circuit
 * without a special case. zero-valued cache / cost fields are dropped to
 * `undefined` for symmetry with each harness's `buildUsage`.
 */
export function mergeAgentUsage(
  a: AgentUsage | undefined,
  b: AgentUsage | undefined
): AgentUsage | undefined {
  // always return a fresh object — callers treat AgentUsage as immutable, and
  // returning `a` / `b` directly would leak that invariant to future callers
  if (!a && !b) return undefined;
  if (!a) return { ...(b as AgentUsage) };
  if (!b) return { ...a };
  const cacheRead = (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0);
  const cacheWrite = (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0);
  const cost = (a.costUsd ?? 0) + (b.costUsd ?? 0);
  return {
    agent: a.agent,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: cacheRead > 0 ? cacheRead : undefined,
    cacheWriteTokens: cacheWrite > 0 ? cacheWrite : undefined,
    costUsd: cost > 0 ? cost : undefined,
  };
}

/**
 * unified per-run token table used by every agent harness.
 *
 * columns are kept stable across agents and models so downstream log parsers
 * (scripts/token-usage.ts, cost dashboards) only have to understand one format:
 *
 *   Input       non-cached input tokens sent this run
 *   Cache Read  input tokens served from prompt cache (Anthropic, etc.)
 *   Cache Write input tokens written to prompt cache this run
 *   Output      assistant output tokens
 *   Total       sum of the four columns — the real billable quantity
 *   Cost ($)    USD cost reported by the provider (only rendered when known)
 *
 * models that don't report prompt caching leave Cache Read / Write at 0.
 * OpenCode emits per-step `part.cost` sourced from models.dev (works across
 * Anthropic, OpenAI, Google, xAI, DeepSeek, Moonshot, OpenRouter, etc.);
 * Claude CLI emits `total_cost_usd` on its final `result` event. pass the
 * accumulated value via `costUsd` to render the Cost column.
 */
export function logTokenTable(t: {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  costUsd?: number | undefined;
}): void {
  const total = t.input + t.cacheRead + t.cacheWrite + t.output;
  // narrow costUsd to a concrete number so the render path doesn't need a cast
  const costUsd = typeof t.costUsd === "number" && t.costUsd > 0 ? t.costUsd : undefined;

  const headerRow: Array<{ data: string; header: true }> = [
    { data: "Input", header: true },
    { data: "Cache Read", header: true },
    { data: "Cache Write", header: true },
    { data: "Output", header: true },
    { data: "Total", header: true },
  ];
  const dataRow: string[] = [
    String(t.input),
    String(t.cacheRead),
    String(t.cacheWrite),
    String(t.output),
    String(total),
  ];

  if (costUsd !== undefined) {
    headerRow.push({ data: "Cost ($)", header: true });
    dataRow.push(formatCostUsd(costUsd));
  }

  log.table([headerRow, dataRow]);
}
