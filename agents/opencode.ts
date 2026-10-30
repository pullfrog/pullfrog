/**
 * OpenCode agent — in-process harness, driving `opencode serve` over loopback
 * HTTP. Two OpenCode generations sit behind it: V1 (`opencode-ai` >=1.14.x, the
 * Effect-ts CLI rewrite) by default, and V2 (`@opencode/cli`) when
 * `opencodeGeneration()` picks it. This file is everything the two share — the
 * run's setup, the server process, the watchdog, the salvage and the post-run
 * loop; `opencode1.ts` and `opencode2.ts` are each generation's driver (session
 * setup, event stream, one prompt turn), and `opencodeSession.ts` is the
 * bookkeeping both drivers feed. See wiki/opencode-v2.md.
 *
 * Naming note: this was `opencode_v2.ts`, where "v2" meant the second
 * generation of PULLFROG's harness — never a version of OpenCode itself. The
 * original CLI-subprocess harness sat beside it as `opencode.ts` for a while,
 * imported by nothing, which is exactly how a fix lands in the file that
 * doesn't run. It is deleted; this is the only OpenCode harness.
 *
 * Architecture:
 *
 *   1. Spawn ONE `opencode serve --port <p>` subprocess per Pullfrog run via
 *      `node:child_process.spawn` directly (NOT our `spawn()` wrapper — see
 *      `bootOpencodeServer` for why: long-lived stdio streaming, manual
 *      activity gating against the SDK event loop, killGroup teardown).
 *   2. Talk to it over loopback HTTP via the generation's typed client — no
 *      `Server.Default()` embed, no `createOpencode()` SDK lifecycle (would
 *      re-wrap our subprocess).
 *   3. Create ONE session up front (the driver's `open`).
 *   4. Subscribe to events once and pump them through a single per-run
 *      handler set for live logging + activity tracking + subagent labeling.
 *   5. Run the initial prompt via the driver's `prompt`. Every post-run gate
 *      retry AND the reflection turn re-enter the same session via another
 *      prompt. Warm MCP, warm plugins, warm provider connections, same context
 *      window — no `--continue` subprocess respawn.
 *   6. Close the server in a finally.
 *
 * What that replaces (vs the pre-migration v2 harness):
 *   - The per-run `opencode run --format json --print-logs --thinking` CLI
 *     subprocess that emitted NDJSON envelopes.
 *   - The `runOpenCode(... args: [...baseArgs, "--continue", c.prompt] ...)`
 *     resume callback that booted a SECOND opencode process (fresh MCP,
 *     fresh plugins, cold cache) for each gate retry / reflection turn.
 *   - The `opencodePlugin.ts` bus-event re-emitter — we subscribe to the
 *     global event stream now, so subagent events arrive naturally without
 *     a stdout sentinel envelope.
 *
 * What stays identical:
 *   - native bash blocked (listed as "ask", thrown on by the gate plugin)
 *   - OPENCODE_PERMISSION filesystem sandbox — deny-all + allow /tmp
 *   - MCP Pullfrog server injected via `mcp.<name> = { type: "remote", url }`
 *   - ASKPASS for git auth
 *   - codex auth materialization + post-hook writeback
 *   - reviewfrog subagent config / model derivation
 *   - bedrock model prefix routing
 *   - skills install
 *   - todo tracker / onToolUse forwarding
 */
import { spawn as nodeSpawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { totalmem } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Agent, fetch as undiciFetch } from "undici";
import { pullfrogMcpName } from "../external.ts";
import { BEDROCK_MODEL_ID_ENV } from "../models.ts";
import {
  AGENT_ACTIVITY_TIMEOUT_MS,
  AGENT_FIRST_EVENT_TIMEOUT_MS,
  isDebugEnabled,
  watchdogBudgetMs,
} from "../utils/activity.ts";
import type { AgentDiagnostic } from "../utils/agentHangReport.ts";
import { log } from "../utils/cli.ts";
import { installCodexAuth, installXaiAuth } from "../utils/codexHome.ts";
import type { OAuthWriteback } from "../utils/codexRefreshDetect.ts";
import { OAUTH_WRITEBACK_STATE } from "../utils/oauthWriteback.ts";
import { openCodeHomeEnv, syncOpenCodeCredentials } from "../utils/openCodeModels.ts";
import { findProviderErrorMatch } from "../utils/providerErrors.ts";
import { resolveRunEffort } from "../utils/runEffort.ts";
import { saveSecretState } from "../utils/secretCommands.ts";
import { addSkill, installBundledSkills } from "../utils/skills.ts";
import { isTrackedChild, trackChild, untrackChild } from "../utils/subprocess.ts";
import { getDevDependencyVersion } from "../utils/version.ts";
import { resolveVertexOpenCodeModel } from "../utils/vertex.ts";
import { dirtyTrackedPaths, restoreDirtiedSince } from "../utils/worktree.ts";
import { GIT_NATIVE_READ_DENY_OPENCODE, GIT_NATIVE_WRITE_DENY_OPENCODE } from "./nativeFsDenies.ts";
import { opencode1 } from "./opencode1.ts";
import { opencode2 } from "./opencode2.ts";
import { opencodeGeneration } from "./opencodeGeneration.ts";
import { PULLFROG_OPENCODE_GATE_PLUGIN_FILENAME } from "./opencodePlugin.ts";
import type { OpencodeSession, RunState, Sandbox, ServerHandle } from "./opencodeSession.ts";
import {
  autoSelectModel,
  azureProvider,
  buildReviewerAgentConfig,
  installOpencodeCli,
  type OpenCodeConfig,
  openAICompatibleProvider,
  openRouterDataCollection,
  openRouterProvider,
  providerGatewayOverride,
} from "./opencodeShared.ts";
import { buildReflectionPrompt, runPostRunRetryLoop } from "./postRun.ts";
import { REVIEWER_AGENT_NAME } from "./reviewer.ts";
import {
  type AgentResult,
  type AgentRunContext,
  agent,
  MAX_STDERR_LINES,
  mergeAgentUsage,
} from "./shared.ts";

// ── config ─────────────────────────────────────────────────────────────────────

/** the run's config, in V1's shape: V2 normalizes it in memory, so one builder serves both. */
function buildSecurityConfig(ctx: AgentRunContext, model: string | undefined): OpenCodeConfig {
  const config: OpenCodeConfig = {
    permission: {
      // listed but never run: Zen's free tier 403s a tool list missing `bash`,
      // `glob`, `grep` or `read` (2026-09-17), so the gate plugin throws on
      // every bash call and "ask" (no responder in serve mode) fails closed.
      // never switch one of those four to "deny". see wiki/security.md.
      bash: "ask",
      edit: "allow",
      read: "allow",
      webfetch: "allow",
      external_directory: "allow",
      skill: "allow",
    },
    mcp: {
      // tool timeout (vs the MCP SDK's 60s default). `checkout_pr` runs a
      // multi-minute `git fetch` on large repos (remotion); a 60s client abort
      // surfaces as `MCP error -32001` and used to push the agent toward
      // deleting live git locks (the corruption in #860/#864 — the dangerous
      // `rm` guidance is gone, but the spurious aborts shouldn't happen either).
      // MUST exceed `checkout_pr`'s own 600s `timeoutMs`: at 300s a checkout
      // that legitimately took 300-600s was GUARANTEED to abort client-side
      // while the server kept working, which is half of #1171. the tool now
      // enforces its own deadline and always answers, so waiting for that
      // answer beats aborting into a retry.
      [pullfrogMcpName]: { type: "remote", url: ctx.mcpServerUrl, timeout: 660_000 },
    },
    agent: (() => {
      const cfg = buildReviewerAgentConfig(model);
      const reviewerModel = (cfg[REVIEWER_AGENT_NAME] as { model?: string })?.model ?? "(inherit)";
      log.info(`» subagent models: reviewfrog=${reviewerModel}`);
      return cfg;
    })(),
    // openrouter routing, not reasoning (every model's effort rides the
    // per-prompt `variant`): the run's data-collection policy, kimi pinned
    // away from Enforcer-less providers, the Muse Spark contributor tier
    // opened to training hosts. see opencodeShared.ts.
    provider: {
      openrouter: openRouterProvider(openRouterDataCollection(ctx)),
      ...openAICompatibleProvider(model),
      ...azureProvider(model),
      ...providerGatewayOverride(model),
    },
  };

  if (model) {
    config.model = model;
    const slashIndex = model.indexOf("/");
    if (slashIndex > 0) {
      config.enabled_providers = [model.slice(0, slashIndex).toLowerCase()];
    }
  }

  return config;
}

// ── server boot ────────────────────────────────────────────────────────────────

/**
 * Spawn `<cliPath> serve --port 0 --hostname 127.0.0.1` and wait for the
 * "server listening on http://..." stdout line (V1 prefixes it "opencode ").
 *
 * Direct node:child_process.spawn instead of our `spawn()` wrapper because
 * the wrapper's contract is "Promise<SpawnResult> that resolves on exit" —
 * we need a handle that stays alive across many session.prompt() calls.
 * We still register with `trackChild()` so Ctrl-C kills the server alongside
 * everything else.
 */
function bootOpencodeServer(params: {
  cliPath: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
}): Promise<ServerHandle> {
  // --print-logs routes opencode's own logger to stderr (it otherwise writes
  // only to a log file inside the throwaway per-run HOME, which nothing reads).
  // that logger is the ONLY place the server records the cause behind a 500
  // `UnknownError` + `ref` — without it `recentStderr` is empty and an invalid
  // repo config is undiagnosable. ERROR level keeps the ring buffer signal-dense.
  //
  // a debug run raises that to INFO, the only way to see a stall that produces
  // no error at all: opencode logs the provider request as `stream` at INFO
  // (`session/llm.ts`), so at ERROR a silent provider leaves the buffer empty
  // with no evidence the request was even issued. INFO and not DEBUG
  // deliberately — the `stream` line carries only provider/model/session
  // metadata, while DEBUG can carry payloads, and these logs are readable by
  // anyone with repo read. see wiki/opencode-silent-stall.md.
  const logLevel = isDebugEnabled() ? "INFO" : "ERROR";
  if (logLevel !== "ERROR") log.info(`» opencode log level: ${logLevel} (debug run)`);
  // V1's CLI takes the level upper-case and V2's lower-case; each refuses the other's spelling.
  const level = opencodeGeneration() === 2 ? logLevel.toLowerCase() : logLevel;
  const proc = nodeSpawn(
    params.cliPath,
    ["serve", "--port", "0", "--hostname", "127.0.0.1", "--print-logs", "--log-level", level],
    {
      cwd: params.cwd,
      env: params.env,
      stdio: ["ignore", "pipe", "pipe"],
      // detached + killGroup so SIGKILL nukes the whole tree: node_modules/
      // opencode-ai/bin/opencode is a Node shim that spawnSync's the native
      // binary; without process-group kill the native binary is reparented
      // to PID 1 and never dies. mirrors the same fix in runOpenCode's
      // original spawn().
      detached: true,
    }
  );
  trackChild({ child: proc, killGroup: true });

  const recentStderr: string[] = [];
  proc.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (!text) return;
    recentStderr.push(text);
    if (recentStderr.length > MAX_STDERR_LINES) recentStderr.shift();
    log.debug(`[opencode serve] ${text}`);
  });

  let closed = false;
  let exitCause: string | undefined;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    untrackChild(proc);
    // `killed` only records a signal WE sent. a server that already died has
    // fired its `close` event, and waiting for it again hangs the run until
    // the outer watchdog kills it.
    if (proc.pid && proc.exitCode === null && proc.signalCode === null) {
      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch {
        proc.kill("SIGTERM");
      }
      // give the server 2s to exit cleanly, then SIGKILL the group.
      await new Promise<void>((resolve) => {
        const escalator = setTimeout(() => {
          if (!proc.killed) {
            try {
              process.kill(-proc.pid!, "SIGKILL");
            } catch {
              proc.kill("SIGKILL");
            }
          }
        }, 2000);
        proc.once("close", () => {
          clearTimeout(escalator);
          resolve();
        });
      });
    }
  };

  return new Promise<ServerHandle>((resolve, reject) => {
    // serve logs `[opencode ]server listening on http://<host>:<port>` once
    // bound. parse it out, then resolve. drain remaining stdout to debug.
    let buffer = "";
    let resolved = false;
    const onStdout = (chunk: Buffer) => {
      const text = chunk.toString();
      buffer += text;
      if (!resolved) {
        const match = buffer.match(/server listening on (https?:\/\/[^\s]+)/);
        if (match?.[1]) {
          resolved = true;
          log.info(`» opencode server up: ${match[1]}`);
          resolve({ baseUrl: match[1], proc, close, recentStderr, exitCause: () => exitCause });
          // keep draining for debug visibility after handover.
        }
      }
      // log any stdout line that's not the listening sentinel at debug level
      // so a noisy serve startup is visible without polluting info logs.
      const lines = text.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.includes("server listening")) {
          log.debug(`[opencode serve] ${trimmed}`);
        }
      }
    };
    proc.stdout?.on("data", onStdout);

    proc.once("error", (err) => {
      if (!resolved) {
        reject(new Error(`failed to spawn opencode serve: ${err.message}`));
      }
    });
    proc.once("exit", (code, signal) => {
      // untracked means we killed it: `close()`, or `killTrackedChildren()` on a timeout or cancel.
      if (!resolved || !isTrackedChild(proc)) return;
      exitCause = describeServerExit(code, signal);
      log.warning(withServerStderr(`» ${exitCause}`, recentStderr));
    });
    proc.once("close", (code, signal) => {
      if (!resolved) {
        const tail = recentStderr.slice(-5).join("\n");
        reject(
          new Error(
            `opencode serve exited before ready (code=${code} signal=${signal})${tail ? `\n${tail}` : ""}`
          )
        );
      }
    });

    // safety: if the listening line never arrives, bail after 30s.
    const bootTimeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        const tail = recentStderr.slice(-5).join("\n");
        void close();
        reject(
          new Error(
            `timed out after 30s waiting for opencode serve to bind${tail ? `\n${tail}` : ""}`
          )
        );
      }
    }, 30_000);
    bootTimeout.unref?.();
  });
}

/**
 * Append the server's own stderr to a fatal harness error.
 *
 * opencode answers anything it cannot type as a bare 500 `UnknownError` plus a log
 * `ref` we have no way to resolve, so `--print-logs` (see `bootOpencodeServer`) is
 * what puts the underlying cause within reach at all.
 */
function withServerStderr(message: string, recentStderr: readonly string[]): string {
  const tail = recentStderr.join("\n").trim();
  return tail ? `${message}\nopencode server stderr:\n${tail}` : message;
}

/**
 * Name why the server died under a live run. Our own kills untrack it first, so
 * a SIGKILL arriving here is almost always the kernel's OOM killer, and the
 * memory the job may use is what the customer needs to act on it.
 */
function describeServerExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal !== "SIGKILL") return `opencode server exited mid-run (${signal ?? `code ${code}`})`;
  // a cgroup limit (k8s, ARC) is what the OOM killer enforces; with none it reads 0 or UINT64_MAX.
  const limit = process.constrainedMemory();
  const memoryGb = ((limit > 0 ? Math.min(limit, totalmem()) : totalmem()) / 1024 ** 3).toFixed(1);
  return `opencode server was killed (SIGKILL) mid-run, usually by the kernel OOM killer — this runner has ${memoryGb} GB of memory`;
}

/** server stderr → provider-error attribution (same pattern as the old CLI subprocess harness's onStderr handler). */
function watchProviderErrors(server: ServerHandle, diagnostic: AgentDiagnostic): void {
  server.proc.stderr?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = findProviderErrorMatch(trimmed);
      if (match) {
        diagnostic.lastProviderError = match.label;
        log.info(`» provider error detected (${match.label}): ${match.excerpt}`);
      }
    }
  });
}

// ── inner activity timer ───────────────────────────────────────────────────────

/**
 * Sent when the watchdog cut a turn off mid-flight. Deliberately terse and only
 * ever billed on the salvage path, never on a healthy run.
 */
const WATCHDOG_SALVAGE_PROMPT =
  "Your previous turn was cut off mid-response by a provider stall. Nothing you had not already submitted through a tool was saved. Continue from where you stopped and submit your work now — do not restart your analysis.";

/**
 * Start an event-silence watchdog. The outer process-level activity timer
 * (main.ts `createProcessOutputActivityTimeout`) watches `process.stdout.write`
 * which our harness log lines drive — but it doesn't see SSE event silence
 * when the harness is itself quiet. This inner timer specifically watches
 * `state.lastEventAt` and fires `onActivityTimeout` so main.ts can tear down
 * the MCP server early, mirroring the per-spawn watchdog in `subprocess.ts`.
 *
 * `state.lastEventAt` is refreshed only on meaningful progress (the model's
 * own token/tool events), so any prolonged gap with no progress advances the
 * clock — including a long in-flight tool call. the budget is the same flat
 * idle timeout as the outer watchdog, sized to exceed the worst-case
 * legitimate silent tool window (#760), so a real tool can't trip it; a
 * genuinely stalled provider or a hung tool does, at the flat budget.
 *
 * Before the first model event the tighter {@link AGENT_FIRST_EVENT_TIMEOUT_MS}
 * applies instead: the flat budget exists to protect an in-flight tool call, and
 * no tool has been called yet.
 *
 * The interval spans the whole run, so it also watches the gap BETWEEN turns.
 * A fire there arms the safety net but never stands it down — the next turn's
 * `armForTurn()` clears the latch, so `firedThisTurn()` reads false at that
 * turn's end. Unreachable today: the only between-turn work is `getGitStatus`
 * (10s cap), `isSummaryUnchanged` and `getUnsubmittedReview`, and the stop hook
 * is commented out (`postRun.ts`, #714), so the budget cannot elapse there.
 * Re-enabling the stop hook would make it reachable.
 */
function startInnerActivityWatchdog(params: {
  state: RunState;
  timeoutMs: number;
  abortTurn: () => void;
  onActivityTimeout: AgentRunContext["onActivityTimeout"];
}): { stop: () => void; armForTurn: () => void; firedThisTurn: () => boolean } {
  let fired = false;
  let everFired = false;
  const id = setInterval(() => {
    if (fired) return;
    const idleMs = performance.now() - params.state.lastEventAt;
    const compiledMs = params.state.diagnostic.sawModelOutput
      ? params.timeoutMs
      : AGENT_FIRST_EVENT_TIMEOUT_MS;
    // the e2e override is SPENT ON THE FIRST FIRE. its whole point is to abort
    // one turn on demand and then watch the salvage; clamping the salvage just
    // as hard aborts that too, and both turns draw first-token latency from the
    // same distribution — so a value low enough to trip turn 1 trips the salvage
    // at the same rate, and one high enough for the salvage never fires at all.
    // that is the one setting which cannot produce a LANDED salvage.
    const budgetMs = everFired
      ? compiledMs
      : watchdogBudgetMs(
          compiledMs,
          params.state.diagnostic.sawModelOutput
            ? "PULLFROG_E2E_ACTIVITY_TIMEOUT_MS"
            : "PULLFROG_E2E_FIRST_EVENT_TIMEOUT_MS"
        );
    if (idleMs <= budgetMs) return;
    fired = true;
    everFired = true;
    const idleSec = Math.round(idleMs / 1000);
    params.state.diagnostic.idleSec = idleSec;
    log.info(
      params.state.diagnostic.sawModelOutput
        ? `» no opencode events for ${idleSec}s — aborting in-flight prompt and notifying harness`
        : `» no opencode events for ${idleSec}s — the provider never returned a first token; aborting in-flight prompt and notifying harness`
    );
    params.abortTurn();
    // the safety net is armed here and NOT after the turn returns, because an
    // abort opencode ignores would otherwise hang with nothing watching. the
    // harness stands it down via `onTurnRecovered` the moment the turn does
    // come back, so it only ever guards the abort→return window. see #1085.
    try {
      params.onActivityTimeout?.();
    } catch (err) {
      log.debug(
        `inner activity callback threw: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }, 5_000);
  id.unref?.();
  return {
    stop: () => clearInterval(id),
    /**
     * Start a turn's idle budget from now. The clock must be reset with the
     * latch: `lastEventAt` only advances on model output, so a turn following a
     * stall would inherit the full stalled interval and be aborted on the very
     * next 5s tick — killing the salvage before the provider could answer. It
     * is the right semantics for an ordinary resume too, whose budget should
     * not be pre-spent by the post-run gate checks that ran between turns.
     */
    armForTurn: () => {
      fired = false;
      params.state.lastEventAt = performance.now();
    },
    firedThisTurn: () => fired,
  };
}

// ── agent entrypoint ───────────────────────────────────────────────────────────

export const opencode = agent({
  name: "opencode",
  install: installOpencodeCli,
  run: async (ctx) => {
    const driver = opencodeGeneration() === 2 ? opencode2 : opencode1;
    const cliPath = await installOpencodeCli();

    const rawModel = ctx.payload.proxyModel ?? ctx.resolvedModel ?? autoSelectModel();

    // rawModel is the authoritative "what actually ran" — including the
    // auto-select pick that main.ts cannot know (it's opencode-specific:
    // folding it into `resolvedModel` earlier would mis-route `resolveAgent`).
    // overwrite the pre-agent best-effort so `toolState.model` (footers + the
    // end-of-run PATCH that persists `WorkflowRun.model`) reflects the real model.
    if (rawModel) ctx.toolState.model = rawModel;

    // resolve effort against the model that actually runs, not `ctx.resolvedModel`
    // — an auto-selected run has none, and would otherwise lose its setting.
    const effort = resolveRunEffort({ ...ctx, resolvedModel: rawModel });
    // the startup block prints before auto-select happens, so it can only say
    // "pending" for those runs. this is the first point the real level is known.
    if (!ctx.resolvedModel && !ctx.payload.proxyModel) {
      log.info(`» effort: ${effort.rung ?? "n/a (model has no effort control)"}`);
    }

    // bedrock route: opencode's `amazon-bedrock` provider expects the model
    // in `amazon-bedrock/<bedrock-id>` form. detect via env-var sentinel
    // (same pattern as claude.ts). do not gate on Anthropic-vs-other — that
    // discriminant lives in resolveAgent.
    const bedrockModelId = process.env[BEDROCK_MODEL_ID_ENV]?.trim();
    const isBedrockRoute =
      rawModel !== undefined && bedrockModelId !== undefined && bedrockModelId === rawModel;
    const vertexModel = resolveVertexOpenCodeModel(rawModel);
    const model = vertexModel ?? (isBedrockRoute ? `amazon-bedrock/${rawModel}` : rawModel);

    // materialize CODEX_AUTH_JSON into the run's subscription data dir so
    // OpenCode's CodexAuthPlugin picks it up. see action/utils/codexHome.ts and
    // wiki/codex-auth.md.
    const codexAuth = installCodexAuth();

    // same for GROK_AUTH_JSON -> opencode's native XaiAuthPlugin. an account
    // can hold both chains; the writer merges rather than overwrites.
    const xaiAuth = installXaiAuth();

    // after both installs: XDG_DATA_HOME names the dir they wrote into.
    const homeEnv = openCodeHomeEnv(ctx.tmpdir);
    // install the subagent gate into opencode's auto-discovered plugin dir
    // (under the tmpdir-redirected XDG_CONFIG_HOME). v2 installs ONLY the gate,
    // not the events re-emitter — it reads subagent events off the SDK stream,
    // so the re-emitter would be dead weight. see action/agents/opencodePlugin.ts.
    const opencodePluginDir = join(homeEnv.XDG_CONFIG_HOME, "opencode", "plugin");
    mkdirSync(opencodePluginDir, { recursive: true });
    writeFileSync(
      join(opencodePluginDir, PULLFROG_OPENCODE_GATE_PLUGIN_FILENAME),
      driver.gatePlugin(ctx)
    );

    const agentBrowserVersion = getDevDependencyVersion("agent-browser");
    addSkill({
      ref: `vercel-labs/agent-browser@v${agentBrowserVersion}`,
      skill: "agent-browser",
      env: homeEnv,
      agent: "opencode",
    });
    installBundledSkills({ home: homeEnv.HOME });

    // external_directory gates ALL native filesystem tools (Read, Write, Edit, Glob, Grep, etc.)
    // for paths outside the project root. last-match-wins: deny everything, then allow /tmp.
    // codex auth lives at /var/lib/pullfrog/run-*/opencode/auth.json in CI (see codexHome.ts),
    // which is outside /tmp/* — deny-default protects it from native FS tools.
    //
    // read + edit rules deny git surfaces INSIDE the project root, where
    // external_directory short-circuits (Instance.containsPath). edit denies
    // ALL of .git (blanket write — nothing legit writes .git via native tools;
    // MCP git tools run in the action process, outside this gate); read denies
    // only .git/config (narrow — broad .git read-blocks break orientation reads
    // like .git/HEAD, and ASKPASS keeps live tokens out of .git/config). `*` is
    // recursive in opencode's Wildcard dialect. grep/glob match the search
    // pattern not a filepath, so they can't be path-denied (documented in
    // wiki/security.md). canonical surfaces: action/agents/nativeFsDenies.ts.
    // the plugin dir sits under /tmp (the per-run HOME), which the /tmp allow
    // would otherwise expose to native FS tools. deny it back AFTER that allow
    // (last-match-wins) so the agent cannot rewrite a pullfrog plugin to capture
    // the env it loads with — the OpenCode side of the hook seal. opencode's own
    // plugin loader is unaffected (it does not go through this tool gate). the
    // MCP shell is sealed separately by the read-only bind in action/mcp/shell.ts.
    const sandbox: Sandbox = {
      external_directory: {
        "*": "deny",
        "/tmp/*": "allow",
        // where a truncated tool result's full text is saved. V1 appends this allow itself; V2 does not.
        [join(homeEnv.XDG_DATA_HOME, "opencode", "tool-output", "*")]: "allow",
        [opencodePluginDir]: "deny",
        [`${opencodePluginDir}/*`]: "deny",
      },
      read: { "*": "allow", ...GIT_NATIVE_READ_DENY_OPENCODE },
      edit: { "*": "allow", ...GIT_NATIVE_WRITE_DENY_OPENCODE },
    };

    const repoDir = process.cwd();

    // opencode-ai >=1.14 resolves the session's `directory` from process.env.PWD
    // first (cli/cmd/run.ts:282 → Filesystem.resolve(PWD ?? cwd)). The server
    // does the same per-request via the x-opencode-directory header, but we
    // also pass PWD on the spawn env so any in-server tool that re-resolves
    // cwd locally lands in repoDir.
    const env: NodeJS.ProcessEnv & { OPENCODE_DB: string } = {
      ...process.env,
      ...homeEnv,
      PWD: repoDir,
      ...driver.env({
        config: buildSecurityConfig(ctx, model),
        sandbox,
        home: homeEnv.HOME,
        repoDir,
      }),
      GOOGLE_GENERATIVE_AI_API_KEY:
        process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY,
    };
    // opencode 1.18 gates a code-mode `execute` tool — a script interpreter —
    // behind either of these. the spawn env inherits the workflow's `env:` block,
    // so leaving them set would let a repo-level variable hand the agent shell
    // execution that sidesteps the bash block. shell goes through pullfrog_shell,
    // always. see wiki/sandbox-v2.md.
    delete env.OPENCODE_EXPERIMENTAL;
    delete env.OPENCODE_EXPERIMENTAL_CODE_MODE;
    // both chains rotate mid-run inside opencode, so each needs a post-hook
    // writeback entry. the API key is dropped only for the provider whose
    // subscription is driving the run — an OPENAI_API_KEY outranks the Codex
    // OAuth chain, and XAI_API_KEY likewise outranks the Grok one.
    const writebacks: OAuthWriteback[] = [];
    if (codexAuth) {
      delete env.OPENAI_API_KEY;
      writebacks.push({
        secretName: "CODEX_AUTH_JSON",
        provider: "openai",
        authPath: codexAuth.authPath,
        originalRefresh: codexAuth.originalRefresh,
        originalIdToken: codexAuth.originalIdToken,
      });
    }
    if (xaiAuth) {
      delete env.XAI_API_KEY;
      writebacks.push({
        secretName: "GROK_AUTH_JSON",
        provider: "xai",
        authPath: xaiAuth.authPath,
        originalRefresh: xaiAuth.originalRefresh,
      });
    }
    if (writebacks.length > 0) {
      saveSecretState(
        OAUTH_WRITEBACK_STATE,
        JSON.stringify({ apiToken: ctx.apiToken, entries: writebacks })
      );
    }
    // the credential pool may have swapped a chain since main.ts's capture imported it.
    syncOpenCodeCredentials({ cliPath, env });

    log.debug(
      `» starting Pullfrog (OpenCode V${opencodeGeneration()}, in-process SDK): ${cliPath}`
    );
    log.debug(`» working directory: ${repoDir}`);

    // ── boot server + create session ─────────────────────────────────────────
    // opencode's instance bootstrap writes into the project directory: it
    // injects `$schema` into any `opencode.json` it loads, and installs
    // `@opencode-ai/plugin` into `.opencode/` when the repo ships project
    // plugins. a repo that TRACKS either file goes dirty, and since the writes
    // land after prep's restore window nothing owned them — `checkout_pr` then
    // refused for the rest of the run (#1133). the binary exposes no
    // project-plugin-root override, so snapshot here and restore below.
    const preBootDirty = await dirtyTrackedPaths();
    const server = await bootOpencodeServer({ cliPath, env, cwd: repoDir });
    // the SDK's bundled fetch tries to disable per-request timeouts via the
    // bun-only `req.timeout = false` no-op, which does nothing under node/undici
    // — so undici's default 300s headers/body timeout aborts any turn that
    // streams for >5min as `TypeError: fetch failed`. wire an unbounded undici
    // dispatcher through a custom fetch (createOpencodeClient's `fetch` override
    // bypasses the SDK's own fetch) so a long turn isn't capped client-side.
    // the inner activity watchdog below — not undici — is what bounds true stalls.
    const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 0 });
    // forward the request through undici's own dispatcher-aware fetch (Agent and
    // fetch from the same package, so `dispatcher` typechecks with no cast). the
    // SDK hands our override a global `Request`, which the esbuild-bundled undici
    // realm can't consume directly ("Failed to parse URL from [object Request]"),
    // so we re-state its fields explicitly. `duplex: "half"` is required by the
    // fetch spec whenever a stream body is sent.
    const fetchWithoutTimeout: typeof fetch = (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return undiciFetch(request.url, {
        method: request.method,
        headers: [...request.headers],
        body: request.body,
        duplex: "half",
        signal: request.signal,
        dispatcher,
      });
    };
    try {
      const diagnostic: AgentDiagnostic = {
        label: "Pullfrog",
        recentStderr: server.recentStderr,
        lastProviderError: undefined,
        idleSec: undefined,
        sawModelOutput: false,
        eventCount: 0,
      };
      watchProviderErrors(server, diagnostic);
      const opened = await driver
        .open({
          ctx,
          server,
          sandbox,
          env,
          repoDir,
          model,
          rawModel,
          effort,
          fetch: fetchWithoutTimeout,
          diagnostic,
        })
        .catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))));
      // config and plugins load lazily during instance bootstrap — on the first
      // request, not at spawn — so this is the earliest point the startup writes
      // above have all landed, and it is still ahead of the first agent turn.
      await restoreDirtiedSince({ before: preBootDirty, actor: "agent startup" });
      if (opened instanceof Error) {
        return {
          success: false,
          output: "",
          error: withServerStderr(opened.message, server.recentStderr),
        };
      }
      ctx.toolState.agentDiagnostic = diagnostic;
      return await runTurns(ctx, opened);
    } finally {
      await server.close().catch((err) => {
        log.debug(
          `opencode server close failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });
      await dispatcher.close().catch(() => {});
    }
  },
});

/** the initial turn, the post-run gate retries and the reflection, all on one session. */
async function runTurns(ctx: AgentRunContext, session: OpencodeSession): Promise<AgentResult> {
  const state = session.state;
  // run-scoped: the outer `finally` binds to this, so it must OUTLIVE a
  // stalled turn. before #1085 the watchdog aborted this one controller,
  // which killed the event loop and left every subsequent `session.prompt`
  // rejecting as already-aborted — so the resume loop below was structurally
  // dead and 15-58min of work was discarded with no review.
  const runController = new AbortController();
  // per-turn: replaced for each prompt, and the only thing the watchdog
  // aborts. `AbortSignal.any` keeps run-scoped cancellation reaching the
  // in-flight turn.
  let turnController = new AbortController();
  const nextTurnSignal = () => {
    turnController = new AbortController();
    return AbortSignal.any([runController.signal, turnController.signal]);
  };

  const watchdog = startInnerActivityWatchdog({
    state,
    // model-stall budget: how long the orchestrator may stream NO progress
    // (no token/tool event) before we tear the turn down. opencode's
    // keepalive/lifecycle events keep the outer process-output monitor
    // alive even while the model is silent, so this inner timer is the only
    // stall detector for the SSE path. it shares the flat idle budget so
    // a long synchronous tool call (no model event while it runs) can't
    // false-positive it.
    timeoutMs: AGENT_ACTIVITY_TIMEOUT_MS,
    abortTurn: () => turnController.abort(),
    onActivityTimeout: ctx.onActivityTimeout,
  });

  // one salvage per run. the stall is provider-side, so a second attempt in
  // the same run is unlikely to differ, and each one costs up to a full idle
  // budget — the 1h cap still bounds the worst case either way.
  let salvagesLeft = 1;

  /**
   * Run one prompt turn, and re-prompt once if the activity watchdog cut it
   * off mid-flight. The turn's own controller is dead by then, so the retry
   * gets a fresh one; the session, MCP dispatcher and provider sockets are
   * all still live because only the turn was aborted.
   */
  const runTurn = async (text: string): Promise<AgentResult> => {
    const attempt = (prompt: string) => {
      watchdog.armForTurn();
      return runTurnGuarded(state, () => session.prompt(prompt, nextTurnSignal()));
    };
    /**
     * Stand the safety net down iff this turn both tripped the watchdog and
     * came back with work the run will act on. Applied to EVERY turn, the
     * salvage included: a second fire arms a fresh net, and leaving that one
     * up force-exits a run that has just recovered.
     *
     * A failure is left alone rather than actively re-armed. On the give-up
     * returns that means the net stays up, which is intended — it is the
     * only tight bound left on the shutdown path (`await eventLoopPromise`
     * has hung before, #876). On the no-tools return the net is down unless
     * the salvage tripped its own fire and re-armed it, and either state is
     * right: the salvage returned, so the abort was provably honored, and an
     * armed net is only ever the shutdown bound a failing return wants.
     */
    const standDownIfRecovered = (turn: AgentResult): AgentResult => {
      if (!watchdog.firedThisTurn() || !turn.success) return turn;
      // this fire ended nothing, and no later turn need follow to clear it —
      // the outer process-output timer can still terminalize the run, and
      // would otherwise report this span instead of its own.
      state.diagnostic.idleSec = undefined;
      ctx.onTurnRecovered?.();
      return turn;
    };

    const result = await attempt(text);
    if (!watchdog.firedThisTurn()) return result;
    // the watchdog fired but the turn landed anyway — it can beat the abort
    // through the driver's post-turn usage round trip.
    if (result.success) return standDownIfRecovered(result);
    if (salvagesLeft <= 0) return result;
    salvagesLeft--;
    // about to run another turn, so this net has done its job.
    ctx.onTurnRecovered?.();
    log.info("» activity watchdog cut the turn off — re-prompting once on the same session");
    const mcpCallsBefore = state.mcpToolCalls;
    const salvaged = await attempt(WATCHDOG_SALVAGE_PROMPT);
    // the aborted turn's tokens were really spent — returning only the
    // salvage's usage would bill the customer for less than the run cost and
    // under-report `WorkflowRun.inputTokens`. the post-run loop merges across
    // its own resumes but sits above this, so the pair is merged here.
    const usage = mergeAgentUsage(result.usage, salvaged.usage);
    // a salvage that reached no Pullfrog tool left nothing behind. Review
    // gates itself on `create_pull_request_review`, but Build/Fix/Plan have
    // no terminal gate — so letting prose alone stand as success would post
    // "sorry, I was cut off" as the run's answer and report a green run
    // where the pre-salvage code reported the timeout. counting ANY tool is
    // too weak for that: `read`/`grep` are orchestrator calls too, so a
    // salvage that re-read one file and then apologised would have passed.
    if (state.mcpToolCalls === mcpCallsBefore) {
      log.info("» salvage turn reached no Pullfrog tool — keeping the activity-timeout failure");
      return { ...result, usage };
    }
    return standDownIfRecovered({ ...salvaged, usage });
  };

  try {
    const initial = await runTurn(ctx.instructions.full);

    // post-run gate retry loop — every resume is another prompt against the
    // same session, so MCP, plugins, provider sockets stay warm and the
    // session's prompt cache survives.
    const result = await runPostRunRetryLoop({
      ctx,
      initialResult: initial,
      initialUsage: initial.usage,
      reflectionPrompt: buildReflectionPrompt(ctx.toolState),
      resume: async (c) => runTurn(c.prompt),
    });

    // gate the todo-tracker flush on the post-run loop's final verdict
    // (`result.success`), not the initial turn — otherwise a Review that
    // exhausts the `unsubmittedReview` retry budget flips success to
    // false but the tracker still flushes "completed" tasks to GitHub.
    // mirrors the old `if (result.exitCode === 0)` discriminant.
    if (result.success) {
      await ctx.todoTracker?.flush();
    } else {
      ctx.todoTracker?.cancel();
    }

    return result;
  } finally {
    watchdog.stop();
    runController.abort();
    await session.close().catch(() => {});
  }
}

/**
 * Safety net around a single turn: convert any unexpected throw that escapes
 * the driver's prompt into a `success: false` result so the post-run gate loop
 * (which expects a result, not a rejection) can surface it through the generic
 * renderer.
 *
 * Watchdog-fired aborts do NOT reach here — each driver owns the abort signal,
 * catches the aborted request internally, and classifies it as an `activity
 * timeout` error itself. This wrapper must not re-classify, since a stray
 * post-prompt throw is not a hang.
 */
async function runTurnGuarded(
  state: RunState,
  fn: () => Promise<AgentResult>
): Promise<AgentResult> {
  try {
    return await fn();
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.info(`» ${state.label} turn failed: ${errorMessage}`);
    return {
      success: false,
      output: state.currentTurn?.finalText ?? "",
      error: errorMessage,
    };
  }
}
