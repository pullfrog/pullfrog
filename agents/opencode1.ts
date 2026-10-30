/**
 * The OpenCode V1 driver (`opencode-ai`, `@opencode-ai/sdk/v2`): how the shared
 * harness in `opencode.ts` opens a session on a V1 server, reads its event
 * stream, and runs one prompt turn. V1 reads its sandbox from
 * `OPENCODE_PERMISSION` and its gate plugin in the `tool.execute.before` shape.
 *
 * Naming note: the SDK's `/v2` subpath is the second generation of opencode's
 * HTTP API inside V1 — nothing to do with OpenCode V2, which is `opencode2.ts`.
 */
import { performance } from "node:perf_hooks";
import {
  type AssistantMessage,
  createOpencodeClient,
  type EventSubscribeResponse,
  type OpencodeClient,
  type Part,
  type TextPartInput,
} from "@opencode-ai/sdk/v2";
import { markActivity } from "../utils/activity.ts";
import { log } from "../utils/cli.ts";
import { buildOpencodeSubagentGateSource } from "./opencodePlugin.ts";
import {
  createRunState,
  declaredRung,
  emptyTurn,
  logTurnEnd,
  type OpencodeDriver,
  type OpencodeLaunch,
  type RunState,
  recordReasoning,
  recordSubagentDispatch,
  recordText,
  recordToolCall,
  stallCause,
  stallError,
  type TurnText,
} from "./opencodeSession.ts";
import type { AgentResult, AgentUsage } from "./shared.ts";

export const opencode1: OpencodeDriver = {
  gatePlugin: buildOpencodeSubagentGateSource,
  // OPENCODE_PERMISSION has absolute highest precedence (merged after managed/MDM configs).
  env: (params) => ({
    OPENCODE_CONFIG_CONTENT: JSON.stringify(params.config),
    OPENCODE_PERMISSION: JSON.stringify(params.sandbox),
  }),
  open,
};

/**
 * What we collect during a single session.prompt() turn so we can render a
 * unified AgentResult at the end. Per-turn snapshot is reset between turns
 * inside the event loop via `beginTurn()` / `endTurn()`.
 */
interface TurnAccumulator extends TurnText {
  /**
   * Aggregate token totals from step-finish parts across the orchestrator AND
   * any subagent sessions dispatched during the turn (e.g. reviewfrog).
   * Mirrors v1's `accumulatedTokens` semantics so production billing/audit
   * numbers stay apples-to-apples across the migration.
   */
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number;
}

function newTurn(): TurnAccumulator {
  return {
    finalText: "",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0,
  };
}

interface RunnerContext extends RunState {
  client: OpencodeClient;
  sessionID: string;
  /**
   * reasoning effort, already clamped to the model's ladder. lives on the
   * context rather than the turn params because `variant` is a per-prompt
   * field, not per-session — a resume that omits it silently drops back to the
   * model default. undefined when the model has no effort control.
   */
  variant: string | undefined;
  model: { providerID: string; modelID: string } | undefined;
  currentTurn: TurnAccumulator | null;
  /** message our own submitted prompt echoes back on — see `isModelOutput`. */
  promptMessageID: string | undefined;
  /**
   * the orchestrator's last `session.error` this turn. opencode reports a model-not-found
   * ONLY there — the prompt itself gets an opaque 500 (#1470).
   */
  lastSessionError: string | undefined;
}

async function open(launch: OpencodeLaunch) {
  const client = createOpencodeClient({
    baseUrl: launch.server.baseUrl,
    directory: launch.repoDir,
    fetch: launch.fetch,
  });

  const sessionResp = await client.session.create({ title: "Pullfrog" });
  if (sessionResp.error || !sessionResp.data) {
    const msg = sessionResp.error
      ? formatPromptError(sessionResp.error)
      : "session.create returned no data";
    // session.create is the first request to hit the server, so a failed
    // instance bootstrap (an invalid repo config above all) surfaces here.
    throw new Error(`opencode session.create failed: ${msg}`);
  }
  const sessionID = sessionResp.data.id;
  log.info(`» opencode session: ${sessionID}`);

  const model = parseModel(launch.model);
  const variant =
    launch.effort.declarable && model
      ? await resolveDeclaredRung(launch, { client, model })
      : launch.effort.rung;

  const ctx: RunnerContext = {
    ...createRunState(launch, sessionID),
    client,
    sessionID,
    variant,
    model,
    currentTurn: null,
    promptMessageID: undefined,
    lastSessionError: undefined,
  };

  const eventsController = new AbortController();
  const eventLoopPromise = consumeEvents(ctx, eventsController.signal).catch((err) => {
    // SSE stream breakage during cleanup is expected; only surface during
    // active operation.
    if (!eventsController.signal.aborted) {
      log.warning(
        `» opencode event subscription ended: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  });

  return {
    state: ctx,
    prompt: (text: string, signal: AbortSignal) => runPromptTurn(ctx, { text, signal }),
    close: async () => {
      eventsController.abort();
      await eventLoopPromise;
    },
  };
}

/** split `<providerID>/<modelID>` into the SDK's prompt model shape. */
function parseModel(
  value: string | undefined
): { providerID: string; modelID: string } | undefined {
  if (!value) return undefined;
  const slash = value.indexOf("/");
  if (slash <= 0) return undefined;
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) };
}

/** the variants the server's own `variants` map declares for the model — the one its request path indexes. */
async function resolveDeclaredRung(
  launch: OpencodeLaunch,
  params: { client: OpencodeClient; model: { providerID: string; modelID: string } }
): Promise<string | undefined> {
  const resp = await params.client.config.providers();
  const provider = resp.data?.providers.find((p) => p.id === params.model.providerID);
  const variants = provider?.models[params.model.modelID]?.variants ?? {};
  return declaredRung(launch, {
    name: `${params.model.providerID}/${params.model.modelID}`,
    variants: Object.keys(variants),
  });
}

// ── events ─────────────────────────────────────────────────────────────────────

/**
 * orchestrate the event stream consumer for the entire server lifetime.
 *
 * NB: the SDK subscribe is lazy — the SSE fetch only opens on the first
 * iteration. so the first turn's tool part-updated events can race the
 * connect and be missed. live-stream logging is best-effort; see the
 * end-of-turn `logUnseenToolCalls` fallback for the guarantee.
 */
async function consumeEvents(ctx: RunnerContext, signal: AbortSignal): Promise<void> {
  // wire the abort signal into the SSE request itself. without it the
  // generated client falls back to an internal never-aborting signal
  // (serverSentEvents.gen.js: `options.signal ?? new AbortController().signal`),
  // so `reader.read()` parks forever once the session goes idle and the stream
  // falls silent. the teardown `await eventLoopPromise` in the run() finally
  // then blocks — `abortController.abort()` can't interrupt a `for await` that
  // never advances — until the outer process-output watchdog kills the
  // already-succeeded run once the flat idle budget elapses and reports a false
  // "stalled" (PR #876).
  const result = await ctx.client.event.subscribe({}, { signal });
  for await (const event of result.stream as AsyncGenerator<EventSubscribeResponse>) {
    if (signal.aborted) break;
    ctx.eventCount += 1;
    ctx.diagnostic.eventCount = ctx.eventCount;
    // NB: `lastEventAt` (the inner-watchdog clock) is intentionally NOT bumped
    // here — opencode's keepalive/lifecycle/idle events would otherwise mask a
    // provider stall (the model going silent mid-turn looks like steady event
    // flow). it is refreshed only on meaningful progress in `dispatchEvent`.
    markActivity();
    try {
      await dispatchEvent(ctx, event);
    } catch (err) {
      log.debug(
        `» event dispatch threw for type=${(event as { type?: string }).type ?? "?"}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

/**
 * Whether a part is the model's own output rather than our submission echoed
 * back. `session.prompt` publishes the prompt we just sent as a `text` part
 * immediately, before the provider has been contacted — so "any part arrived"
 * is not the signal the first-event budget wants.
 *
 * The echo is the first `text` part of a turn; everything on a later message is
 * the model's. Non-text parts (`step-start` leads every assistant step) are
 * always the model's, which also covers the lazy-SSE-subscribe race past our
 * own echo.
 *
 * Supplying our own `messageID` to `session.prompt` would make this an exact
 * identity test, and the SDK accepts one — but measured, it silently breaks the
 * post-run reflection turn (11ms and no assistant output, vs 420ms and normal
 * output without it), so the heuristic stays.
 */
function isModelOutput(ctx: RunnerContext, part: Part): boolean {
  if (part.type !== "text") return true;
  if (ctx.promptMessageID === undefined) {
    ctx.promptMessageID = part.messageID;
    return false;
  }
  return part.messageID !== ctx.promptMessageID;
}

async function dispatchEvent(ctx: RunnerContext, event: EventSubscribeResponse): Promise<void> {
  // event union covers heartbeats, session lifecycle, message lifecycle, tui,
  // mcp, etc. we only care about a small subset.
  if (event.type === "message.part.updated") {
    // real model/tool progress: token/text/reasoning streaming and tool
    // part transitions all arrive as part.updated. this is the only event
    // class that refreshes the inner-watchdog clock.
    ctx.lastEventAt = performance.now();
    if (isModelOutput(ctx, event.properties.part)) ctx.diagnostic.sawModelOutput = true;
    onPartUpdated(ctx, event.properties.part);
    return;
  }
  if (event.type === "session.error") {
    const sessionID = event.properties.sessionID;
    if (sessionID !== ctx.orchestratorSessionID) return;
    const err = event.properties.error;
    const message = err ? extractErrorMessage(err) : "(no error payload)";
    log.info(`» ${ctx.label} session error: ${message}`);
    if (err) ctx.lastSessionError = message;
    return;
  }
  // session.idle / session.status are useful breadcrumbs but we don't drive
  // anything off them — the prompt() POST returns when the assistant message
  // is committed, which is also when the session goes idle.
}

function extractErrorMessage(err: {
  name?: string;
  data?: { message?: string; [key: string]: unknown };
}): string {
  if (err.data?.message) return err.data.message;
  if (err.name) return err.name;
  return JSON.stringify(err);
}

function onPartUpdated(ctx: RunnerContext, part: Part): void {
  // text — only orchestrator's final text becomes the run's "output";
  // subagent text is logged but not folded into finalOutput.
  if (part.type === "text" && part.time?.end !== undefined) {
    recordText(ctx, { sessionID: part.sessionID, text: part.text });
    return;
  }

  if (part.type === "reasoning" && part.time.end !== undefined) {
    recordReasoning(ctx, {
      sessionID: part.sessionID,
      text: part.text,
      duration: formatPartDuration(part.time),
    });
    return;
  }

  if (part.type === "step-finish") {
    // aggregate orchestrator AND subagent step-finish events into the same
    // per-turn accumulator. v1 (`opencode.ts`) summed both via opencode's
    // CLI `--print-logs` output; filtering subagents here would silently
    // undercount production cost/usage by the reviewfrog subagent's
    // contribution (often the bulk of a Review-mode turn).
    if (!ctx.currentTurn) return;
    const t = part.tokens;
    if (t) {
      ctx.currentTurn.tokens.input += t.input || 0;
      ctx.currentTurn.tokens.output += t.output || 0;
      ctx.currentTurn.tokens.cacheRead += t.cache?.read || 0;
      ctx.currentTurn.tokens.cacheWrite += t.cache?.write || 0;
    }
    if (typeof part.cost === "number" && Number.isFinite(part.cost)) {
      ctx.currentTurn.costUsd += part.cost;
    }
    return;
  }

  if (part.type === "tool") {
    onToolPart(ctx, part);
    return;
  }

  // step-start / snapshot / patch / agent / retry / compaction / subtask /
  // file: nothing actionable here.
}

function onToolPart(ctx: RunnerContext, part: Extract<Part, { type: "tool" }>): void {
  // early task-dispatch announce: bind subagent sessionID to a label as soon
  // as the orchestrator's task tool transitions to "running" (where input is
  // populated). dedupe against later terminal observations via callID.
  if (
    part.tool === "task" &&
    part.state.status === "running" &&
    part.sessionID === ctx.orchestratorSessionID
  ) {
    const input = (part.state.input ?? {}) as {
      description?: string;
      subagent_type?: string;
      prompt?: string;
    };
    recordSubagentDispatch(ctx, { callID: part.callID, input });
    return;
  }
  recordTerminalToolPart(ctx, part);
}

/** a tool part that reached a terminal state, through the shared bookkeeping. */
function recordTerminalToolPart(ctx: RunnerContext, part: Extract<Part, { type: "tool" }>): void {
  const state = part.state;
  if (state.status !== "completed" && state.status !== "error") return;
  recordToolCall(ctx, {
    tool: part.tool,
    callID: part.callID,
    sessionID: part.sessionID,
    input: state.input,
    output: state.status === "completed" ? state.output : undefined,
    error: state.status === "error" ? state.error : undefined,
  });
}

/**
 * end-of-turn safety net for tool-call bookkeeping. queries `session.messages`
 * for the canonical orchestrator transcript and replays any tool callID the
 * live event stream hasn't already processed — closes the SSE-connect race
 * documented on `loggedToolCallIDs`. `session.prompt`'s own `data.parts` is
 * only the final assistant message's parts (mostly text/reasoning); the tool
 * calls in earlier steps of the same turn live on prior messages, so we need
 * the full session-scoped read.
 */
async function logUnseenToolCalls(ctx: RunnerContext): Promise<void> {
  try {
    const resp = await ctx.client.session.messages({ sessionID: ctx.orchestratorSessionID });
    if (resp.error || !resp.data) return;
    for (const message of resp.data) {
      for (const part of message.parts) {
        if (part.type !== "tool") continue;
        recordTerminalToolPart(ctx, part);
      }
    }
  } catch (err) {
    log.debug(`» logUnseenToolCalls failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function formatPartDuration(time: { start?: number; end?: number } | undefined): string {
  if (!time || typeof time.start !== "number" || typeof time.end !== "number") return "";
  if (time.end <= time.start) return "";
  return ` (${((time.end - time.start) / 1000).toFixed(1)}s)`;
}

// ── per-turn execution ─────────────────────────────────────────────────────────

/**
 * Run a single prompt turn against the persistent server. Resets the per-turn
 * accumulator, calls `client.session.prompt()`, then assembles an AgentResult
 * from the returned AssistantMessage + accumulated event state.
 *
 * Token / cost: `AssistantMessage.tokens` and `.cost` are authoritative for
 * the turn. The event-stream accumulator is a fallback / sanity-check path
 * used when the response is missing (e.g. abort, transport error) — and as
 * the only source of per-step subagent attribution if we ever surface it.
 */
async function runPromptTurn(
  ctx: RunnerContext,
  params: { text: string; signal: AbortSignal }
): Promise<AgentResult> {
  const start = performance.now();
  // record the turn boundary in milliseconds (matches AssistantMessage.time.created)
  // so the post-turn aggregator can isolate this turn's messages from the prior
  // turns' messages on the same persistent orchestrator session.
  const turnStartMs = Date.now();
  ctx.currentTurn = newTurn();
  const turn = ctx.currentTurn;

  const part: TextPartInput = { type: "text", text: params.text };

  // re-arm the pre-first-token budget for every turn: a resumed turn waits on
  // the provider exactly the way the first one does.
  ctx.promptMessageID = undefined;
  // both fields describe the turn in flight, never a past one: the outer
  // process-output timer can terminalize the run long after a fire the harness
  // recovered from, and would otherwise render that stale fire's story.
  ctx.diagnostic.sawModelOutput = false;
  ctx.diagnostic.idleSec = undefined;
  ctx.lastSessionError = undefined;

  let assistant: AssistantMessage | undefined;
  let returnedParts: Part[] | undefined;
  let networkError: string | null = null;
  try {
    const response = await ctx.client.session.prompt(
      {
        sessionID: ctx.sessionID,
        parts: [part],
        ...(ctx.variant ? { variant: ctx.variant } : {}),
        ...(ctx.model ? { model: ctx.model } : {}),
      },
      // wire the inner activity watchdog's abort signal into the SDK request
      // — without this a hung HTTP keeps the run stuck even after the
      // watchdog fires.
      { signal: params.signal }
    );
    if (response.error) {
      networkError = formatPromptError(response.error);
    } else if (response.data) {
      assistant = response.data.info;
      returnedParts = response.data.parts;
    } else {
      // neither error nor data — malformed/partial SDK response. don't silently
      // succeed with an empty AgentResult; treat as a failure so the gate loop
      // surfaces it instead of looping on a "successful" no-op.
      networkError = "opencode prompt returned neither data nor error";
    }
  } catch (err) {
    networkError = err instanceof Error ? err.message : String(err);
  }
  const durationMs = performance.now() - start;

  // authoritative cost/usage: walk every assistant message that landed during
  // this turn (orchestrator session + any subagent sessions dispatched while
  // it ran) and sum tokens + cost. The step-finish accumulator and the live
  // AssistantMessage from session.prompt are both non-authoritative for a
  // multi-step turn — step-finish events arrive on the SSE stream after
  // session.prompt has already resolved (at least for the final message),
  // and AssistantMessage carries only the final message's usage. Mirrors v1's
  // accumulator-after-the-fact model but driven by the canonical message
  // store instead of best-effort SSE sniffing.
  const aggregatedUsage = await aggregateTurnUsage(ctx, turnStartMs);
  const usage = aggregatedUsage ?? buildUsage(turn, assistant);

  // surface the rendered final text. preference order:
  //   1. orchestrator text part with time.end set (captured by event loop)
  //   2. text part on the returned response (when present)
  //   3. assistant message id as a last-resort placeholder
  const finalText = turn.finalText || extractTextFromParts(returnedParts) || "";

  await logUnseenToolCalls(ctx);
  logTurnEnd(ctx, { durationMs, usage });

  // failure modes, in order of authority:
  //   1. transport / SDK-side error (response.error or thrown)
  //   2. AssistantMessage.error set by the provider (auth, context overflow, etc.)
  // a bare `session.error` is deliberately NOT a third mode: opencode publishes
  // it for conditions it recovers from, and sets (2) on the terminal ones (#1069).
  // a run that dies holding a classified provider error must never be
  // reported as "the model went silent" — the stderr subscriber knew the
  // cause seconds after session.create, and the claude harness already names
  // it on its own timeout path. see #1183.
  // a dead server outranks a provider error: it is why every later request failed.
  const cause = stallCause(ctx);
  // a session error explains only a prompt that failed before any output (model-not-found): one
  // after output, or after a watchdog abort, is a condition opencode recovered from (#1069).
  const promptCause =
    ctx.serverExitCause() ??
    (ctx.diagnostic.sawModelOutput ? undefined : ctx.lastSessionError) ??
    ctx.diagnostic.lastProviderError;

  if (networkError) {
    // a watchdog-fired abort surfaces here as a caught `session.prompt`
    // rejection (or an aborted `response.error`), not a throw that escapes to
    // the caller. classify it as an `activity timeout` so `renderRunError`
    // routes it through the hang renderer; any other transport failure falls
    // through to the generic humanized renderer.
    return {
      success: false,
      output: finalText,
      error: params.signal.aborted
        ? stallError({
            what: `the model went silent and the turn was aborted by the activity watchdog (${networkError})`,
            cause,
          })
        : `opencode prompt failed: ${networkError}${promptCause ? ` — likely cause: ${promptCause}` : ""}`,
      usage,
    };
  }
  if (assistant?.error) {
    return {
      success: false,
      output: finalText,
      error: `provider error: ${extractErrorMessage(assistant.error)}`,
      usage,
    };
  }

  const result = { success: true, output: finalText, usage };
  return emptyTurn(ctx, result) ?? result;
}

/**
 * Sum the cost + tokens of every assistant message created during this turn,
 * across the orchestrator session AND any subagent sessions dispatched while
 * it ran. Authoritative: the SDK's own cost/tokens fields per message are the
 * source of truth, identical to what `opencode --print-logs` aggregated in v1.
 */
async function aggregateTurnUsage(
  ctx: RunnerContext,
  turnStartMs: number
): Promise<AgentUsage | undefined> {
  // labeler tracks every sessionID we've observed events from on the
  // global SSE stream, including any subagent (task tool) child sessions.
  const sessionIDs = new Set<string>([ctx.orchestratorSessionID]);
  for (const [sessionID] of ctx.labeler.entries()) {
    sessionIDs.add(sessionID);
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let costUsd = 0;
  let counted = 0;

  for (const sessionID of sessionIDs) {
    try {
      const resp = await ctx.client.session.messages({ sessionID });
      if (resp.error || !resp.data) continue;
      for (const msg of resp.data) {
        if (msg.info.role !== "assistant") continue;
        if (msg.info.time.created < turnStartMs) continue;
        const t = msg.info.tokens;
        inputTokens += t.input || 0;
        outputTokens += t.output || 0;
        cacheReadTokens += t.cache?.read || 0;
        cacheWriteTokens += t.cache?.write || 0;
        costUsd += msg.info.cost || 0;
        counted++;
      }
    } catch (err) {
      log.debug(
        `» aggregateTurnUsage failed for session ${sessionID}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  if (counted === 0) return undefined;

  const total = inputTokens + cacheReadTokens + cacheWriteTokens;
  if (total === 0 && outputTokens === 0 && costUsd === 0) return undefined;

  return {
    agent: "pullfrog",
    inputTokens: total,
    outputTokens,
    cacheReadTokens: cacheReadTokens || undefined,
    cacheWriteTokens: cacheWriteTokens || undefined,
    costUsd: costUsd > 0 ? costUsd : undefined,
  };
}

function buildUsage(
  turn: TurnAccumulator,
  assistant: AssistantMessage | undefined
): AgentUsage | undefined {
  // Prefer the step-finish accumulator: it sums every LLM call across the
  // whole turn (orchestrator iterations + any subagent dispatches). The
  // AssistantMessage at the SDK boundary only carries the *final* assistant
  // message's tokens/cost — for a multi-step Review-mode turn that's just
  // the closing acknowledgment, missing the bulk of the work. Fall back to
  // assistant.tokens only if the accumulator is empty (e.g., the turn
  // errored before any step-finish events landed).
  const t = turn.tokens;
  const accumulatorTotal = t.input + t.cacheRead + t.cacheWrite;
  if (accumulatorTotal > 0 || t.output > 0 || turn.costUsd > 0) {
    return {
      agent: "pullfrog",
      inputTokens: accumulatorTotal,
      outputTokens: t.output,
      cacheReadTokens: t.cacheRead || undefined,
      cacheWriteTokens: t.cacheWrite || undefined,
      costUsd: turn.costUsd > 0 ? turn.costUsd : undefined,
    };
  }
  if (assistant) {
    const at = assistant.tokens;
    const total = (at.input || 0) + (at.cache?.read || 0) + (at.cache?.write || 0);
    if (total === 0 && (at.output || 0) === 0 && (assistant.cost || 0) === 0) return undefined;
    return {
      agent: "pullfrog",
      inputTokens: total,
      outputTokens: at.output || 0,
      cacheReadTokens: at.cache?.read || undefined,
      cacheWriteTokens: at.cache?.write || undefined,
      costUsd: assistant.cost > 0 ? assistant.cost : undefined,
    };
  }
  return undefined;
}

function extractTextFromParts(parts: Part[] | undefined): string | undefined {
  if (!parts) return undefined;
  const texts: string[] = [];
  for (const p of parts) {
    if (p.type === "text" && p.text) texts.push(p.text);
  }
  const joined = texts.join("\n").trim();
  return joined || undefined;
}

function formatPromptError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const obj = error as {
      name?: string;
      message?: string;
      error?: { message?: string };
      data?: unknown;
    };
    if (obj.message) return obj.message;
    if (obj.error?.message) return obj.error.message;
    const config = formatConfigError(obj.name, obj.data);
    if (config) return config;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

/**
 * Render opencode's typed config errors (`ConfigInvalidError`, `ConfigJsonError`,
 * `ConfigFrontmatterError`, `ConfigDirectoryTypoError`).
 *
 * They name the offending file and the exact issues but carry no top-level
 * `message`, so the generic branch above would JSON.stringify them. A repo config
 * error is fatal at instance bootstrap — it fails the FIRST request, whatever it is
 * — so this string is all a user with a bad `opencode.json` gets to act on.
 */
function formatConfigError(name: string | undefined, data: unknown): string | undefined {
  if (!name?.startsWith("Config") || !data || typeof data !== "object") return undefined;
  const at = "path" in data && typeof data.path === "string" ? ` at ${data.path}` : "";
  // ConfigFrontmatterError / ConfigJsonError carry their detail here, not in `issues`.
  const detail =
    "message" in data && typeof data.message === "string" ? `${at}: ${data.message}` : at;
  const issues = "issues" in data && Array.isArray(data.issues) ? data.issues : [];
  const bullets = issues
    .map((issue) =>
      issue && typeof issue === "object" && "message" in issue && typeof issue.message === "string"
        ? `\n↳ ${issue.message}`
        : ""
    )
    .join("");
  return `${name}${detail}${bullets}`;
}
