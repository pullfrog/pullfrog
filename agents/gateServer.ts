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
 *   - gates dirty + budget remaining → block with combined gate prompt
 *   - gates clean + reflection pending → block with reflection prompt
 *   - otherwise → allow stop
 * `summaryStale` is a one-shot nudge; once delivered the gate is suppressed
 * so a deliberately-unchanged file doesn't burn the retry budget. when the
 * budget is exhausted with hard-fail gates still failing, we allow the stop
 * so `finalizeAgentResult` can render the terminal `AgentResult.success =
 * false` — that state cannot be set from a stdout-only hook.
 */
import { createServer } from "node:http";
import { log } from "../utils/cli.ts";
import { buildPostRunPrompt, buildReflectionPrompt, collectPostRunIssues } from "./postRun.ts";
import { type AgentRunContext, hasPostRunIssues, MAX_POST_RUN_RETRIES } from "./shared.ts";

export interface GateServerHandle {
  url: string;
  [Symbol.asyncDispose]: () => Promise<void>;
}

export async function startGateServer(ctx: AgentRunContext): Promise<GateServerHandle> {
  let blockCount = 0;
  let reflectionDelivered = false;
  let summaryStaleNudged = false;

  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== "GET" || req.url !== "/gates") {
        res.writeHead(404).end();
        return;
      }
      try {
        const issues = await collectPostRunIssues(ctx, { skipSummaryStale: summaryStaleNudged });
        if (hasPostRunIssues(issues)) {
          if (blockCount >= MAX_POST_RUN_RETRIES) {
            log.info("» gate-server: retry budget exhausted, allowing stop for terminal hard-fail");
            res.writeHead(200, { "content-type": "application/json" }).end('{"block":false}');
            return;
          }
          if (issues.summaryStale) summaryStaleNudged = true;
          blockCount++;
          const reason = buildPostRunPrompt(issues);
          log.info(`» gate-server: blocking (attempt ${blockCount}/${MAX_POST_RUN_RETRIES})`);
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ block: true, reason }));
          return;
        }
        const reflectionPrompt = reflectionDelivered ? undefined : buildReflectionPrompt(ctx);
        if (reflectionPrompt) {
          reflectionDelivered = true;
          const reason = reflectionPrompt;
          log.info("» gate-server: delivering reflection nudge");
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ block: true, reason }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end('{"block":false}');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warning(`» gate-server handler error: ${msg}`);
        // never block claude on a server-side fault — allow the stop and
        // let the harness's terminal hard-fail path own the decision.
        res.writeHead(200, { "content-type": "application/json" }).end('{"block":false}');
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
  const url = `http://127.0.0.1:${addr.port}/gates`;
  log.debug(`» gate-server listening at ${url}`);

  return {
    url,
    [Symbol.asyncDispose]: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
