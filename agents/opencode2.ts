/**
 * The OpenCode V2 driver (`@opencode/cli`, `@opencode/client`): how the shared
 * harness in `opencode.ts` opens a session on a V2 server, reads its event
 * stream, and runs one prompt turn. V2 redesigned the server API, the plugin
 * API and credential storage, and changed defaults that the V1 setup leaned on
 * without saying so. Each of these replaces a V1 mechanism V2 silently ignores:
 *
 *   - the sandbox rides session permissions, which V2 merges after every agent
 *     rule and children inherit. V2 never reads `OPENCODE_PERMISSION`.
 *   - `execute` (Code Mode, on by default) is denied, so MCP tools reach the
 *     model directly as `pullfrog_<tool>` — the names the salvage gate, the
 *     diff-coverage tracker and the todo tracker count.
 *   - a permission prompt is refused at once: V2's `ask` waits for a reply
 *     forever, where V1's failed closed.
 *   - subscription tokens V2 rotates in its database are mirrored back into
 *     auth.json, the file the post hook writes back from.
 *
 * See wiki/opencode-v2.md.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import {
  OpenCode,
  type OpenCodeClient,
  type OpenCodeEvent,
  type SessionInfo,
} from "@opencode/client";
import * as yes from "yes";
import { pullfrogMcpName } from "../external.ts";
import { markActivity } from "../utils/activity.ts";
import { log } from "../utils/cli.ts";
import { mirrorOpenCodeV2Credentials } from "../utils/codexHome.ts";
import { findProviderErrorMatch } from "../utils/providerErrors.ts";
import {
  buildOpencode2GateSource,
  OPENCODE_V2_GATE_PLUGIN_ID,
  PULLFROG_OPENCODE_GATE_PLUGIN_FILENAME,
} from "./opencodePlugin.ts";
import {
  createRunState,
  declaredRung,
  emptyTurn,
  logTurnEnd,
  type OpencodeDriver,
  type OpencodeLaunch,
  type OpencodeSession,
  type RunState,
  recordReasoning,
  recordSubagentDispatch,
  recordText,
  recordToolCall,
  type Sandbox,
  stallCause,
  stallError,
} from "./opencodeSession.ts";
import type { AgentResult, AgentUsage } from "./shared.ts";

export const opencode2: OpencodeDriver = {
  gatePlugin: buildOpencode2GateSource,
  env: (params) => ({
    // the V1-shaped config is normalized in memory by V2; these keys exist only in V2.
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...params.config,
      // off by default in V2, and the todo tracker reads `todowrite`.
      experimental: { todo: true },
      // where `installBundledSkills` and `addSkill` put them.
      skills: [join(params.home, ".agents", "skills")],
      // V2 dropped V1's CLAUDE.md fallback. config lists union across files, so this adds, never replaces.
      instructions: existsSync(join(params.repoDir, "AGENTS.md")) ? [] : ["CLAUDE.md"],
    }),
    // without one, serve prints a generated password to stdout, which the job log would carry.
    OPENCODE_PASSWORD: randomBytes(24).toString("base64url"),
  }),
  open,
};

const EVENT_TYPES = [
  "session.created",
  "session.text.delta",
  "session.text.ended",
  "session.reasoning.delta",
  "session.reasoning.ended",
  "session.tool.input.started",
  "session.tool.input.delta",
  "session.tool.called",
  "session.tool.success",
  "session.tool.failed",
  "session.step.ended",
  "session.step.failed",
  "session.retry.scheduled",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "permission.asked",
  "credential.updated",
] as const;

type Event = Extract<OpenCodeEvent, { type: (typeof EVENT_TYPES)[number] }>;

/** how long the event stream may trail `session.wait` before a turn reads what it delivered. */
const STREAM_SETTLE_MS = 10_000;

/** about 45s (120 jittered polls) for the local MCP server to connect. */
const MCP_CONNECT_SCHEDULE = yes.schedule(() => 500, 120);
const MCP_REGISTRY_SETTLE_MS = 300;

interface RunnerContext extends RunState {
  client: OpenCodeClient;
  /** every session the run has seen, orchestrator first: a turn's usage sums across them. */
  sessions: Set<string>;
  /** each session's cumulative usage as last read: the next turn's baseline. */
  usage: Map<string, SessionInfo>;
  /** a tool call's name, from `tool.input.started`: the later events carry only its id. */
  toolNames: Map<string, string>;
  toolInputs: Map<string, unknown>;
  /** resolves the turn's stream barrier on the orchestrator's execution ending. */
  executionEnded: (() => void) | undefined;
}

async function open(launch: OpencodeLaunch): Promise<OpencodeSession> {
  const client = OpenCode.make({
    baseUrl: launch.server.baseUrl,
    fetch: launch.fetch,
    headers: { authorization: `Basic ${btoa(`opencode:${launch.env.OPENCODE_PASSWORD}`)}` },
  });
  const location = { directory: launch.repoDir };

  // subscribe before anything runs: `server.connected` leads the stream, so once it
  // arrives no later event can be missed (V1's lazy-subscribe race has no V2 twin).
  const eventsController = new AbortController();
  const events = client.event
    .subscribe({ types: EVENT_TYPES, signal: eventsController.signal })
    [Symbol.asyncIterator]();
  await events.next();
  await requireGate(client, location);
  await awaitPullfrogMcp(client, location);

  const session = await client.session.create({
    title: "Pullfrog",
    location,
    model: await sessionModel(launch, client),
    permissions: [
      ...sessionPermissions(launch.sandbox),
      { action: "execute", resource: "*", effect: "deny" },
    ],
  });
  log.info(`» opencode session: ${session.id}`);

  const ctx: RunnerContext = {
    ...createRunState(launch, session.id),
    client,
    sessions: new Set([session.id]),
    usage: new Map(),
    toolNames: new Map(),
    toolInputs: new Map(),
    executionEnded: undefined,
  };
  const eventLoopPromise = consumeEvents(ctx, events).catch((err) => {
    if (!eventsController.signal.aborted) {
      log.warning(
        `» opencode event subscription ended: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  });

  return {
    state: ctx,
    prompt: (text, signal) => runPromptTurn(ctx, { text, signal }),
    close: async () => {
      await mirrorCredentials(ctx);
      eventsController.abort();
      await eventLoopPromise;
    },
  };
}

/**
 * A V1-shaped or broken plugin is skipped with a warning below our log level, which would
 * leave native shell and subagent mutations ungated, so the run refuses instead.
 * `plugin.list` reports the registry mid-activation; `agent.list` waits for it to finish.
 */
async function requireGate(client: OpenCodeClient, location: { directory: string }) {
  await client.agent.list({ location });
  const plugins = await client.plugin.list({ location });
  // a plugin that failed to load is listed by its file, without an id.
  const gate = plugins.data.find(
    (plugin) =>
      plugin.id === OPENCODE_V2_GATE_PLUGIN_ID ||
      (plugin.source.type === "local" &&
        plugin.source.path.endsWith(PULLFROG_OPENCODE_GATE_PLUGIN_FILENAME))
  );
  if (gate?.state.status === "active") return;
  const reason = gate?.state.status === "failed" ? gate.state.error : "not loaded";
  throw new Error(`opencode did not load Pullfrog's gate plugin (${reason}); refusing to run`);
}

class McpPending extends Error {}

/**
 * V2 connects MCP servers in the background and offers a step only the tools connected when it
 * starts, so a first prompt sent early ran with no `pullfrog_*` tool listed (V1 connected before
 * serving). A connect announces its tools and the registry reloads 100ms later, hence the settle.
 */
async function awaitPullfrogMcp(client: OpenCodeClient, location: { directory: string }) {
  const server = await yes.query({
    name: "opencode MCP connect",
    run: async () => {
      const servers = await client.mcp.list({ location });
      const found = servers.data.find((entry) => entry.name === pullfrogMcpName);
      if (!found || found.status.status === "pending") {
        throw new McpPending(`the ${pullfrogMcpName} MCP server was still connecting`);
      }
      return found;
    },
    retry: (error, attempt) =>
      error instanceof McpPending ? yes.backoff(MCP_CONNECT_SCHEDULE, attempt) : -1,
    // a pending server is the expected state for the first polls, not a failure to report.
    on: { retry: null },
  })();
  if (server.status.status !== "connected") {
    const reason = "error" in server.status ? server.status.error : server.status.status;
    throw new Error(`opencode could not connect the ${pullfrogMcpName} MCP server: ${reason}`);
  }
  await sleep(MCP_REGISTRY_SETTLE_MS);
}

/** last-match-wins per action, the same order V1 evaluates `OPENCODE_PERMISSION` in. */
function sessionPermissions(sandbox: Sandbox) {
  return Object.entries(sandbox).flatMap(([action, rules]) =>
    Object.entries(rules).map(([resource, effect]) => ({ action, resource, effect }))
  );
}

/**
 * The session's model and effort. V2 fails every request on a variant the model
 * does not declare (`Variant unavailable`) where V1 ignored one, so a catalog
 * rung runs only when V2 lists it for the model.
 */
async function sessionModel(launch: OpencodeLaunch, client: OpenCodeClient) {
  const slash = launch.model?.indexOf("/") ?? -1;
  if (!launch.model || slash <= 0) return undefined;
  const providerID = launch.model.slice(0, slash);
  const id = launch.model.slice(slash + 1);
  const models = await client.model.list({ location: { directory: launch.repoDir } });
  const listed = models.data.find((m) => m.providerID === providerID && m.modelID === id);
  const variants = listed?.variants.map((variant) => variant.id) ?? [];
  const rung = launch.effort.declarable
    ? declaredRung(launch, { name: launch.model, variants })
    : launch.effort.rung;
  if (rung && !variants.includes(rung)) {
    log.info(
      `» effort: ${rung} not applied — opencode declares no such variant for ${launch.model}`
    );
    return { providerID, id };
  }
  return { providerID, id, ...(rung ? { variant: rung } : {}) };
}

// ── events ─────────────────────────────────────────────────────────────────────

async function consumeEvents(
  ctx: RunnerContext,
  events: AsyncIterator<OpenCodeEvent>
): Promise<void> {
  for (let next = await events.next(); !next.done; next = await events.next()) {
    ctx.eventCount += 1;
    ctx.diagnostic.eventCount = ctx.eventCount;
    markActivity();
    try {
      dispatchEvent(ctx, next.value);
    } catch (err) {
      log.debug(
        `» event dispatch threw for type=${next.value.type}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

function dispatchEvent(ctx: RunnerContext, event: OpenCodeEvent): void {
  if (!isHandled(event)) return;
  switch (event.type) {
    case "permission.asked":
      refusePermission(ctx, event.data);
      return;
    case "credential.updated":
      void mirrorCredentials(ctx);
      return;
    case "session.created":
      ctx.sessions.add(event.data.sessionID);
      // binds the child to the label its dispatch queued.
      ctx.labeler.labelFor(event.data.sessionID);
      return;
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted":
      if (event.data.sessionID !== ctx.orchestratorSessionID) return;
      ctx.executionEnded?.();
      ctx.executionEnded = undefined;
      return;
    case "session.step.failed":
    case "session.retry.scheduled":
      onProviderError(ctx, { sessionID: event.data.sessionID, message: event.data.error.message });
      return;
  }
  // everything left is the model's own output: the only progress the watchdog counts.
  ctx.lastEventAt = performance.now();
  ctx.diagnostic.sawModelOutput = true;
  onModelEvent(ctx, event);
}

function isHandled(event: OpenCodeEvent): event is Event {
  return EVENT_TYPES.some((type) => type === event.type);
}

function onModelEvent(ctx: RunnerContext, event: Event): void {
  switch (event.type) {
    case "session.text.ended":
      recordText(ctx, event.data);
      return;
    case "session.reasoning.ended":
      recordReasoning(ctx, {
        sessionID: event.data.sessionID,
        text: event.data.text,
        duration: "",
      });
      return;
    case "session.tool.input.started":
      ctx.toolNames.set(event.data.id, event.data.name);
      return;
    case "session.tool.called": {
      ctx.toolInputs.set(event.data.id, event.data.input);
      const isOrchestrator = event.data.sessionID === ctx.orchestratorSessionID;
      if (isOrchestrator && ctx.toolNames.get(event.data.id) === "subagent") {
        const input = event.data.input;
        recordSubagentDispatch(ctx, {
          callID: event.data.id,
          input: {
            description: input.description,
            subagent_type: input.agent,
            prompt: input.prompt,
          },
        });
      }
      return;
    }
    case "session.tool.success":
    case "session.tool.failed":
      recordToolCall(ctx, {
        tool: ctx.toolNames.get(event.data.id) ?? "unknown",
        callID: event.data.id,
        sessionID: event.data.sessionID,
        input: ctx.toolInputs.get(event.data.id),
        output: event.type === "session.tool.success" ? toolText(event.data.content) : undefined,
        error: event.type === "session.tool.failed" ? event.data.error.message : undefined,
      });
      return;
  }
}

function toolText(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content.map((item) => item.text ?? `[${item.type}]`).join("\n");
}

/**
 * V2 waits on a reply to `ask` with no timeout, so answering nothing hangs the run
 * on the first one. refusing keeps the V1 behavior: `ask` fails closed. the gate
 * plugin already refuses native shell before permissions are consulted, so this
 * is the backstop, and the answer for anything else that asks.
 */
function refusePermission(
  ctx: RunnerContext,
  request: { id: string; sessionID: string; action: string; resources: string[] }
): void {
  log.info(`» permission refused: ${request.action} ${request.resources.join(", ")}`);
  ctx.client.permission
    .reply({
      sessionID: request.sessionID,
      requestID: request.id,
      decision: "reject",
      message: `${request.action} needs an approval nobody can give in a Pullfrog run.`,
    })
    .catch((err) => log.warning(`» could not refuse a permission request: ${String(err)}`));
}

function onProviderError(ctx: RunnerContext, params: { sessionID: string; message: string }): void {
  if (params.sessionID !== ctx.orchestratorSessionID) return;
  log.info(`» ${ctx.label} provider error: ${params.message}`);
  const match = findProviderErrorMatch(params.message);
  if (match) ctx.diagnostic.lastProviderError = match.label;
}

/** best-effort: the close-time mirror catches up whatever a failed one missed. */
async function mirrorCredentials(ctx: RunnerContext): Promise<void> {
  await ctx.client.credential
    .list()
    .then(mirrorOpenCodeV2Credentials)
    .catch((err) => log.debug(`» credential mirror failed: ${String(err)}`));
}

// ── per-turn execution ─────────────────────────────────────────────────────────

/**
 * Run one prompt turn. `session.prompt` only enqueues; `session.wait` returns once
 * the session's execution has settled, and the idle message it leaves is the
 * authoritative outcome. The event stream trails both, so the turn waits for the
 * orchestrator's execution event to come through before it reads what the stream
 * recorded (the final text, every tool call).
 */
async function runPromptTurn(
  ctx: RunnerContext,
  params: { text: string; signal: AbortSignal }
): Promise<AgentResult> {
  const start = performance.now();
  ctx.currentTurn = { finalText: "" };
  // both fields describe the turn in flight, never a past one: the outer
  // process-output timer can terminalize the run long after a fire the harness
  // recovered from, and would otherwise render that stale fire's story.
  ctx.diagnostic.sawModelOutput = false;
  ctx.diagnostic.idleSec = undefined;
  const settled = new Promise<void>((resolve) => {
    ctx.executionEnded = resolve;
  });

  const sessionID = ctx.orchestratorSessionID;
  let requestError: string | undefined;
  try {
    await ctx.client.session.prompt({ sessionID, text: params.text }, { signal: params.signal });
    await ctx.client.session.wait({ sessionID }, { signal: params.signal });
  } catch (err) {
    requestError = err instanceof Error ? err.message : String(err);
  }
  // an aborted request leaves the execution running server-side; the next turn needs it stopped.
  if (params.signal.aborted) await interrupt(ctx);
  await Promise.race([settled, sleep(STREAM_SETTLE_MS, undefined, { ref: false })]);

  const usage = await turnUsage(ctx);
  const finalText = ctx.currentTurn.finalText;
  logTurnEnd(ctx, { durationMs: performance.now() - start, usage });
  const fail = (error: string): AgentResult => ({
    success: false,
    output: finalText,
    error,
    usage,
  });

  if (params.signal.aborted) {
    return fail(
      stallError({
        what: `the model went silent and the turn was aborted by the activity watchdog (${requestError})`,
        cause: stallCause(ctx),
      })
    );
  }
  if (requestError) return fail(`opencode prompt failed: ${requestError}`);
  const idle = await lastIdle(ctx);
  if (idle?.outcome === "failed") {
    return fail(
      `provider error: ${idle.error?.message ?? "the turn failed with no error recorded"}`
    );
  }
  if (idle?.outcome === "interrupted") {
    return fail(stallError({ what: "opencode interrupted the turn", cause: stallCause(ctx) }));
  }
  const result = { success: true, output: finalText, usage };
  return emptyTurn(ctx, result) ?? result;
}

/** stop the execution the aborted request left running, and wait (bounded) for it to settle. */
async function interrupt(ctx: RunnerContext): Promise<void> {
  const sessionID = ctx.orchestratorSessionID;
  await ctx.client.session
    .interrupt({ sessionID })
    .then(() => ctx.client.session.wait({ sessionID }, { signal: AbortSignal.timeout(30_000) }))
    .catch((err) => log.warning(`» could not interrupt the stalled turn: ${String(err)}`));
}

async function lastIdle(ctx: RunnerContext) {
  const messages = await ctx.client.message.list({
    sessionID: ctx.orchestratorSessionID,
    type: "idle",
    order: "desc",
    limit: 1,
  });
  const idle = messages.data[0];
  return idle?.type === "idle" ? idle : undefined;
}

/**
 * The turn's usage, against the last read rather than a fresh pre-turn one: a session
 * V2 cannot report is left out and keeps its old baseline, so its growth is deferred
 * to the next read that succeeds, never re-billed from zero.
 */
async function turnUsage(ctx: RunnerContext): Promise<AgentUsage | undefined> {
  const after = new Map<string, SessionInfo>();
  for (const sessionID of ctx.sessions) {
    const info = await ctx.client.session.get({ sessionID }).catch(() => undefined);
    if (info) after.set(sessionID, info);
  }
  const usage = usageSince(ctx.usage, after);
  for (const entry of after) ctx.usage.set(entry[0], entry[1]);
  return usage;
}

/**
 * The turn's usage: each session's growth since its last read. V2 counts a subagent's
 * spend on its own session, never its parent's, so the sum counts nothing twice. V2's
 * `output` excludes reasoning, which is billed as output all the same.
 */
function usageSince(
  before: Map<string, SessionInfo>,
  after: Map<string, SessionInfo>
): AgentUsage | undefined {
  let costUsd = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const [sessionID, info] of after) {
    const prior = before.get(sessionID);
    costUsd += info.cost - (prior?.cost ?? 0);
    input += info.tokens.input - (prior?.tokens.input ?? 0);
    output += info.tokens.output + info.tokens.reasoning;
    output -= (prior?.tokens.output ?? 0) + (prior?.tokens.reasoning ?? 0);
    cacheRead += info.tokens.cache.read - (prior?.tokens.cache.read ?? 0);
    cacheWrite += info.tokens.cache.write - (prior?.tokens.cache.write ?? 0);
  }
  const inputTokens = input + cacheRead + cacheWrite;
  if (inputTokens === 0 && output === 0 && costUsd === 0) return undefined;
  return {
    agent: "pullfrog",
    inputTokens,
    outputTokens: output,
    cacheReadTokens: cacheRead || undefined,
    cacheWriteTokens: cacheWrite || undefined,
    costUsd: costUsd > 0 ? costUsd : undefined,
  };
}
