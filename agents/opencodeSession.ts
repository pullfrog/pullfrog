/**
 * What the two OpenCode generations share once a session is open: the run state the turn loop in
 * `opencode.ts` reads, the contract each driver (`opencode1.ts`, `opencode2.ts`) implements, and the
 * bookkeeping every tool call, text block and turn end goes through. Each driver maps its own event
 * stream onto these, so the side effects — diff coverage, todos, the salvage gate's MCP count —
 * cannot drift between generations. See wiki/opencode-v2.md.
 */
import type { ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { AgentDiagnostic } from "../utils/agentHangReport.ts";
import { formatJsonValue, log } from "../utils/cli.ts";
import { type RunEffort, resolveRunEffort } from "../utils/runEffort.ts";
import type { OpenCodeConfig } from "./opencodeShared.ts";
import {
  formatWithLabel,
  ORCHESTRATOR_LABEL,
  SessionLabeler,
  type TaskDispatchInput,
} from "./sessionLabeler.ts";
import {
  type AgentResult,
  type AgentRunContext,
  type AgentUsage,
  logTokenTable,
} from "./shared.ts";

export interface ServerHandle {
  baseUrl: string;
  proc: ChildProcess;
  /** kill the server; idempotent. */
  close: () => Promise<void>;
  /** rolling tail of server stderr for diagnostics. */
  recentStderr: string[];
  /** why the server died on its own after boot; undefined while it is up or once `close()` ran. */
  exitCause: () => string | undefined;
}

/**
 * The native-tool sandbox, as V1's `OPENCODE_PERMISSION` spells it: per action, resource
 * patterns in last-match-wins order. V2 takes the same rules as session permissions.
 */
export type Sandbox = Record<string, Record<string, "allow" | "deny">>;

/** one OpenCode generation's half of the harness. see `opencode1.ts` and `opencode2.ts`. */
export interface OpencodeDriver {
  /** the gate plugin, in this generation's plugin API. */
  gatePlugin: (ctx: AgentRunContext) => string;
  /** the spawn env only this generation reads: its config, its sandbox, its server auth. */
  env: (params: {
    config: OpenCodeConfig;
    sandbox: Sandbox;
    home: string;
    repoDir: string;
  }) => Record<string, string>;
  /** open the run's session on the booted server. throws when the server refuses it. */
  open: (launch: OpencodeLaunch) => Promise<OpencodeSession>;
}

/** everything a driver needs to open the run's session on a booted server. */
export interface OpencodeLaunch {
  ctx: AgentRunContext;
  server: ServerHandle;
  sandbox: Sandbox;
  /** the env the server was spawned with. */
  env: NodeJS.ProcessEnv;
  repoDir: string;
  /** `<provider>/<model>` as opencode names it; undefined lets opencode choose. */
  model: string | undefined;
  /** the run's model before bedrock/vertex prefixing, which effort resolves against. */
  rawModel: string | undefined;
  effort: RunEffort;
  /** a fetch with no client-side timeouts: the activity watchdog, not undici, bounds a stall. */
  fetch: typeof fetch;
  diagnostic: AgentDiagnostic;
}

export interface OpencodeSession {
  state: RunState;
  /** run one prompt turn to completion. */
  prompt: (text: string, signal: AbortSignal) => Promise<AgentResult>;
  /** stop the event stream. the caller closes the server. */
  close: () => Promise<void>;
}

/** what a single turn collects for its result. reset by the driver at each turn start. */
export interface TurnText {
  finalText: string;
}

export interface RunState {
  label: string;
  orchestratorSessionID: string;
  labeler: SessionLabeler;
  todoTracker: AgentRunContext["todoTracker"];
  onToolUse: AgentRunContext["onToolUse"];
  currentTurn: TurnText | null;
  /** monotonic event count for diagnostics. */
  eventCount: number;
  /** last meaningful-progress timestamp, the inner watchdog's clock. */
  lastEventAt: number;
  /** subagent dispatches in flight, keyed by the dispatching tool call's id. */
  taskDispatchByCallID: Map<string, { label: string; startedAt: number }>;
  /** orchestrator tool calls already bookkept, so a replay never fires side effects twice. */
  loggedToolCallIDs: Set<string>;
  /**
   * Count of orchestrator calls to a Pullfrog MCP tool (`pullfrog_*`). Every
   * artifact a run can leave behind — a review, a progress report, a push, a
   * commit through the shell — goes through one, whereas `read`/`grep`/`glob`
   * leave nothing. The salvage gate reads it to tell work from talk (#1085).
   */
  mcpToolCalls: number;
  serverExitCause: ServerHandle["exitCause"];
  diagnostic: AgentDiagnostic;
}

export function createRunState(launch: OpencodeLaunch, sessionID: string): RunState {
  // bind the orchestrator label up front. without this, the first foreign
  // sessionID we see (a subagent) would consume the ORCHESTRATOR slot in the
  // labeler's FIFO and every label downstream would shift.
  const labeler = new SessionLabeler();
  labeler.labelFor(sessionID);
  return {
    label: "Pullfrog",
    orchestratorSessionID: sessionID,
    labeler,
    todoTracker: launch.ctx.todoTracker,
    onToolUse: launch.ctx.onToolUse,
    currentTurn: null,
    eventCount: 0,
    lastEventAt: performance.now(),
    taskDispatchByCallID: new Map(),
    loggedToolCallIDs: new Set(),
    mcpToolCalls: 0,
    serverExitCause: launch.server.exitCause,
    diagnostic: launch.diagnostic,
  };
}

/** a finished tool call, in the shape both generations' events reduce to. */
export interface ToolCall {
  tool: string;
  callID: string;
  sessionID: string;
  input: unknown;
  /** the tool's output on success; undefined when it failed. */
  output: string | undefined;
  error: string | undefined;
}

/** bind an orchestrator subagent dispatch to a label, so its child session's logs carry it. */
export function recordSubagentDispatch(
  state: RunState,
  params: { callID: string; input: TaskDispatchInput }
): void {
  if (state.taskDispatchByCallID.has(params.callID)) return;
  const label = state.labeler.recordTaskDispatch(params.input);
  state.taskDispatchByCallID.set(params.callID, { label, startedAt: performance.now() });
  log.info(
    `» dispatching subagent: ${label}` +
      (params.input.subagent_type ? ` (subagent_type=${params.input.subagent_type})` : "")
  );
}

/**
 * Terminal bookkeeping for one tool call: the log line, the orchestrator-side
 * hooks (`onToolUse` → diff-coverage tracker; `todowrite` / `report_progress`
 * → todo tracker), the MCP count, and the subagent-finish summary.
 *
 * `loggedToolCallIDs` is the dedup guard, so a driver that replays the
 * transcript at turn end (V1's SSE-connect race) fires each call's side
 * effects exactly once. critical for diff-coverage: a missed first-turn `read`
 * would make the `create_pull_request_review` pre-flight reject the review.
 */
export function recordToolCall(state: RunState, call: ToolCall): void {
  const isOrchestrator = call.sessionID === state.orchestratorSessionID;
  if (isOrchestrator && state.loggedToolCallIDs.has(call.callID)) return;
  const label = state.labeler.labelFor(call.sessionID);

  const inputFormatted = formatJsonValue(call.input ?? {});
  log.info(
    withLabel(
      label,
      inputFormatted !== "{}" ? `» ${call.tool}(${inputFormatted})` : `» ${call.tool}()`
    )
  );
  if (isOrchestrator) state.loggedToolCallIDs.add(call.callID);
  if (isOrchestrator && call.tool.startsWith("pullfrog_")) state.mcpToolCalls++;

  if (call.error === undefined) log.debug(withLabel(label, `  output: ${call.output}`));
  else log.info(withLabel(label, `» tool call failed: ${call.error}`));

  const dispatch = state.taskDispatchByCallID.get(call.callID);
  if (dispatch) {
    const dur = ((performance.now() - dispatch.startedAt) / 1000).toFixed(1);
    const output = call.output ?? "";
    const preview = output.length > 120 ? `${output.slice(0, 120)}…` : output;
    log.info(
      `» subagent finished: ${dispatch.label} (${dur}s, status=${call.error === undefined ? "completed" : "error"})` +
        (preview ? ` — ${preview.replace(/\n/g, " ")}` : "")
    );
    state.taskDispatchByCallID.delete(call.callID);
  }

  // subagent tool calls don't count toward the parent's diff-coverage
  // tracking — it's the orchestrator that submits the review.
  if (isOrchestrator) state.onToolUse?.({ toolName: call.tool, input: call.input });

  if (call.tool.includes("report_progress") && state.todoTracker) {
    log.debug("» report_progress detected, disabling todo tracking");
    state.todoTracker.cancel();
  }
  if (call.tool === "todowrite" && state.todoTracker?.enabled && isOrchestrator) {
    state.todoTracker.update(call.input);
  }
}

/** a finished text block. only the orchestrator's becomes the turn's output. */
export function recordText(state: RunState, params: { sessionID: string; text: string }): void {
  const text = params.text.trim();
  if (!text) return;
  const label = state.labeler.labelFor(params.sessionID);
  log.box(text, {
    title: label === ORCHESTRATOR_LABEL ? state.label : `${state.label} [${label}]`,
  });
  if (params.sessionID === state.orchestratorSessionID && state.currentTurn) {
    state.currentTurn.finalText = text;
  }
}

export function recordReasoning(
  state: RunState,
  params: { sessionID: string; text: string; duration: string }
): void {
  const text = params.text.trim();
  if (!text) return;
  const label = state.labeler.labelFor(params.sessionID);
  const preview = text.length > 280 ? `${text.slice(0, 280)}…` : text;
  log.info(withLabel(label, `» thinking${params.duration}: ${preview.replace(/\n+/g, " ")}`));
  if (text.length > 280) log.debug(withLabel(label, `» thinking (full): ${text}`));
}

/**
 * Land a configured effort on the variants the server declares for a model the
 * catalog has no alias for. it is the same `variants` list opencode's request
 * path indexes, so the rung is one it can apply; a model it does not list gets
 * no flag. see wiki/effort.md.
 */
export function declaredRung(
  launch: OpencodeLaunch,
  params: { name: string; variants: readonly string[] }
): string | undefined {
  const rung = resolveRunEffort({
    ...launch.ctx,
    resolvedModel: launch.rawModel,
    declaredVariants: params.variants,
  }).rung;
  log.info(
    `» effort: ${rung ? `${rung} (declared by opencode for ${params.name})` : `not applied — opencode declares no variants for ${params.name}`}`
  );
  return rung;
}

export function logTurnEnd(
  state: RunState,
  params: { durationMs: number; usage: AgentUsage | undefined }
): void {
  log.info(`» ${state.label} turn completed in ${Math.round(params.durationMs)}ms`);
  const usage = params.usage;
  if (!usage) return;
  logTokenTable({
    input: usage.inputTokens - (usage.cacheReadTokens ?? 0) - (usage.cacheWriteTokens ?? 0),
    cacheRead: usage.cacheReadTokens ?? 0,
    cacheWrite: usage.cacheWriteTokens ?? 0,
    output: usage.outputTokens,
    costUsd: usage.costUsd,
  });
}

/**
 * Why the turn ended without the model's work: the server dying outranks a
 * provider error, since it is why every later request failed.
 */
export function stallCause(state: RunState): string | undefined {
  return state.serverExitCause() ?? state.diagnostic.lastProviderError;
}

/** prefixed `activity timeout` so `renderRunError` routes the stall through the hang renderer. */
export function stallError(params: { what: string; cause: string | undefined }): string {
  return `activity timeout: ${params.what}${params.cause ? ` — likely cause: ${params.cause}` : ""}`;
}

/**
 * A turn that resolved with no model output, no text and no usage is the same
 * provider-silence condition `AGENT_FIRST_EVENT_TIMEOUT_MS` exists for — it
 * just RETURNED instead of hanging. calling it a success spent another gate
 * retry on the same mute provider and then told the customer the agent
 * "completed without reporting progress", which blames the one party that
 * never got a turn. see #1161.
 */
export function emptyTurn(state: RunState, result: AgentResult): AgentResult | undefined {
  if (state.diagnostic.sawModelOutput || result.output?.trim() || result.usage) return undefined;
  return {
    success: false,
    output: result.output,
    error: stallError({
      what: "the provider returned an empty turn — no model output, no tool calls, no usage",
      cause: stallCause(state),
    }),
    usage: result.usage,
  };
}

export function withLabel(label: string, message: string): string {
  return label === ORCHESTRATOR_LABEL ? message : formatWithLabel(label, message);
}
