/**
 * gate server — localhost HTTP sidecar that returns Stop-hook decisions for
 * the Claude harness. the managed Stop hook (see `action/agents/claude.ts`)
 * curls this server on every stop and writes back the resulting
 * `{decision: "block", reason}` to inject a follow-up turn inside the live
 * `queryLoop`, replacing the pre-PR-#795 `--resume <sessionId>` subprocess.
 *
 * the server captures `ctx` by closure so every request reads the latest
 * mutations from MCP tool callbacks (which run in the same process). the
 * counters live here, not on `toolState`, because gate-retry budget and
 * reflection one-shot are harness concerns the literal `toolState` design
 * rule (see `action/toolState.ts`) explicitly excludes.
 *
 * decision policy mirrors the old `runPostRunRetryLoop`:
 *   - a background subagent still running → allow stop, uncounted (its return wakes the orchestrator)
 *   - gates dirty + budget remaining → block with combined gate prompt
 *   - gates clean + reflection pending → block with reflection prompt
 *   - otherwise → allow stop
 * `summaryStale` is a one-shot nudge; once delivered the gate is suppressed
 * so a deliberately-unchanged file doesn't burn the retry budget. when the
 * budget is exhausted with hard-fail gates still failing, we allow the stop
 * so `finalizeAgentResult` can render the terminal `AgentResult.success =
 * false` — that state cannot be set from a stdout-only hook.
 *
 * `/pretool` answers the PreToolUse hook (see `claudePretoolGate.ts`) with the
 * lens budget and deadline reserve the OpenCode harness enforces by interrupt:
 * a Claude subagent cannot be interrupted from outside, so its tool calls are
 * refused instead, and it reports back with what it has (#1757).
 */
import { createServer, type ServerResponse } from "node:http";
import { watchdogBudgetMs } from "../utils/activity.ts";
import { log } from "../utils/cli.ts";
import { buildPostRunPrompt, buildReflectionPrompt, collectPostRunIssues } from "./postRun.ts";
import { REVIEWER_AGENT_NAME } from "./reviewer.ts";
import {
  type AgentRunContext,
  DEADLINE_RESERVE_MS,
  hasPostRunIssues,
  LENS_BUDGET_MS,
  LENS_STOPPED_DISPATCH_REFUSAL,
  MAX_POST_RUN_RETRIES,
  RESERVE_DISPATCH_REFUSAL,
} from "./shared.ts";

const LENS_OVER_BUDGET_REFUSAL =
  "Pullfrog's time budget for this review specialist is spent, so it may call no more tools. Stop now and report the findings you have, and tell the orchestrator Pullfrog stopped you for time: it is not a transient failure, so you must not be dispatched again.";
const RESERVE_TOOL_REFUSAL =
  "the run is within 5 minutes of its time limit, so subagents may call no more tools. Stop now and report the findings you have.";

export interface GateServerHandle {
  url: string;
  /** the CLI's `background_tasks_changed` events, which say how many subagents still run */
  trackTask: (event: Record<string, unknown>) => void;
  [Symbol.asyncDispose]: () => Promise<void>;
}

interface GateState {
  ctx: AgentRunContext;
  blockCount: number;
  reflectionDelivered: boolean;
  summaryStaleNudged: boolean;
  runningSubagents: number;
  /** each `reviewfrog` lens's first gated tool call, by `agent_id` */
  lensStartedAt: Map<string, number>;
  stoppedLenses: Set<string>;
}

type StopDecision = { block: false } | { block: true; reason: string };

async function decideStop(state: GateState): Promise<StopDecision> {
  // the orchestrator is waiting on its subagents, and the next to finish wakes it (#1757)
  if (state.runningSubagents > 0) {
    log.info(`» gate-server: ${state.runningSubagents} subagent(s) still running, allowing stop`);
    return { block: false };
  }
  const issues = await collectPostRunIssues(state.ctx, {
    skipSummaryStale: state.summaryStaleNudged,
  });
  if (hasPostRunIssues(issues)) {
    if (state.blockCount >= MAX_POST_RUN_RETRIES) {
      log.info("» gate-server: retry budget exhausted, allowing stop for terminal hard-fail");
      return { block: false };
    }
    if (issues.summaryStale) state.summaryStaleNudged = true;
    state.blockCount++;
    log.info(`» gate-server: blocking (attempt ${state.blockCount}/${MAX_POST_RUN_RETRIES})`);
    return { block: true, reason: buildPostRunPrompt(issues) };
  }
  const reflectionPrompt = state.reflectionDelivered ? undefined : buildReflectionPrompt(state.ctx);
  if (!reflectionPrompt) return { block: false };
  state.reflectionDelivered = true;
  log.info("» gate-server: delivering reflection nudge");
  return { block: true, reason: reflectionPrompt };
}

/** `agent` is the calling subagent's id, empty for the orchestrator's own dispatch; `type` is that subagent's type, or the type it dispatches. */
function decidePretool(state: GateState, query: URLSearchParams): string | null {
  const deadlineAt = state.ctx.deadlineAt;
  const inReserve = deadlineAt !== undefined && Date.now() >= deadlineAt - DEADLINE_RESERVE_MS;
  const agent = query.get("agent") ?? "";
  const type = query.get("type");
  if (!agent) {
    if (inReserve) return RESERVE_DISPATCH_REFUSAL;
    const lensStopped = type === REVIEWER_AGENT_NAME && state.stoppedLenses.size > 0;
    return lensStopped ? LENS_STOPPED_DISPATCH_REFUSAL : null;
  }
  if (inReserve) return RESERVE_TOOL_REFUSAL;
  if (type !== REVIEWER_AGENT_NAME || !lensOverBudget(state, agent)) return null;
  return LENS_OVER_BUDGET_REFUSAL;
}

function lensOverBudget(state: GateState, agent: string): boolean {
  const now = Date.now();
  const startedAt = state.lensStartedAt.get(agent) ?? now;
  state.lensStartedAt.set(agent, startedAt);
  // read per call, not at import: `unsafe_overrides` lands in the env after modules load
  const budgetMs = watchdogBudgetMs(LENS_BUDGET_MS, "PULLFROG_E2E_LENS_BUDGET_MS");
  if (now - startedAt <= budgetMs) return false;
  if (!state.stoppedLenses.has(agent)) {
    log.info(
      `» gate-server: subagent ${agent} past its ${Math.round(budgetMs / 1000)}s budget, refusing its tool calls`
    );
  }
  state.stoppedLenses.add(agent);
  return true;
}

function reply(res: ServerResponse, body: object): void {
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
}

export async function startGateServer(ctx: AgentRunContext): Promise<GateServerHandle> {
  const state: GateState = {
    ctx,
    blockCount: 0,
    reflectionDelivered: false,
    summaryStaleNudged: false,
    runningSubagents: 0,
    lensStartedAt: new Map(),
    stoppedLenses: new Set(),
  };

  const server = createServer((req, res) => {
    void (async () => {
      const path = req.url?.split("?")[0];
      if (req.method !== "GET" || (path !== "/gates" && path !== "/pretool")) {
        res.writeHead(404).end();
        return;
      }
      try {
        if (path === "/gates") {
          reply(res, await decideStop(state));
          return;
        }
        const query = new URL(req.url ?? "", "http://gate").searchParams;
        reply(res, { refusal: decidePretool(state, query) });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warning(`» gate-server handler error: ${msg}`);
        // never block claude on a server-side fault — allow the stop or tool call
        // and let the harness's terminal hard-fail path own the decision.
        reply(res, { block: false });
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("gate-server: failed to bind localhost port");
  }
  const url = `http://127.0.0.1:${addr.port}`;
  log.debug(`» gate-server listening at ${url}`);

  return {
    url,
    trackTask: (event) => {
      // each payload lists every live background task, so a missed event cannot wedge the count
      if (event.subtype !== "background_tasks_changed" || !Array.isArray(event.tasks)) return;
      state.runningSubagents = event.tasks.filter(
        (task) => task?.task_type === "local_agent" && task.ambient !== true
      ).length;
    },
    [Symbol.asyncDispose]: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
