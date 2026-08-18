/**
 * DeepSeek Harness agent — drives `dsh --profile headless` as a one-shot
 * subprocess (`node <pkg>/lib/bin.js`), with post-run gate retries respawned
 * as fresh processes carrying a continuation prompt.
 *
 * Security model (every native surface disabled, mirroring the codex harness
 * for the seams dsh cannot gate itself):
 * - ALL native tools are disabled through the injected cordis.yml patch:
 *   bash/pwsh (exec), fs / fs-search / str-replace-editor (file I/O),
 *   web + web-search (fetch), skill + skill-filesystem, and the subagent /
 *   workflow / ralph fan-out. dsh exposes no pre-tool hook that carries a
 *   subagent marker, so ungated children could call mutating MCP tools
 *   (checkout_pr, push_branch, ...) behind the orchestrator's back — the
 *   same reasoning that disables codex's multi_agent*; see
 *   agents/subagentToolGates.ts.
 * - file I/O and command execution therefore flow exclusively through the
 *   pullfrog MCP tools (shell/git/gh), which run under the PID-namespace +
 *   env-filter + secret-overlay sandbox in mcp/shell.ts.
 * - DSH_PERMISSION_MODE=workspace-write + approval "ask" fails CLOSED in
 *   headless (no answerer): anything outside the workspace is refused, never
 *   prompted.
 * - secrets: no path-deny surface exists in dsh's fs layer (its fs tools are
 *   disabled anyway), but the process env still carries provider keys and
 *   PULLFROG_DATA_DIR is on disk — the accepted posture is the same as the
 *   codex harness ("the namespace overlay is the only layer here").
 *
 * Operational notes:
 * - headless prints NOTHING until the task completes, so stdout-based
 *   activity watchdogs cannot observe progress. activity is instead derived
 *   from the persisted session JSONL ($DSH_HOME/sessions/<session>/session.jsonl,
 *   written in real time with compression: none): any new event — including
 *   the assistant/chunk stream of a long reasoning turn — resets the idle
 *   clock. MCP tool calls additionally mark activity via the mcp/shared.ts
 *   execute() hook. main.ts sizes the outer process-output watchdog for this
 *   harness at DSH_ACTIVITY_TIMEOUT_MS (30min) so a legitimately long
 *   silent-thinking run isn't killed by the 15min opencode budget.
 * - a provider that accepts the request but never streams trips dsh's own
 *   streamIdleTimeoutMs and ends the turn with an error (exit 1), so a
 *   first-event watchdog is redundant; missing keys are caught before the
 *   agent starts by validateAgentApiKey in main.ts.
 * - post-run retries RESPAWN a fresh headless process with a continuation
 *   prompt (headless has no --resume; the tui/web --resume paths are
 *   interactive). retry prompts are self-contained and the fresh session
 *   re-reads repo state via MCP, which covers the gate budget.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pullfrogMcpName } from "../external.ts";
import { dshProviderForModel, stripProviderPrefix } from "../models.ts";
import { DEFAULT_ACTIVITY_CHECK_INTERVAL_MS, markActivity } from "../utils/activity.ts";
import { log } from "../utils/cli.ts";
import { installFromNpmTarball } from "../utils/install.ts";
import { resolveRunEffort } from "../utils/runEffort.ts";
import {
  DEFAULT_MAX_RETAINED_BYTES,
  TailBuffer,
  trackChild,
} from "../utils/subprocess.ts";
import { getDevDependencyVersion } from "../utils/version.ts";
import { buildReflectionPrompt, runPostRunRetryLoop } from "./postRun.ts";
import {
  type AgentResult,
  type AgentRunContext,
  type AgentUsage,
  agent,
  logTokenTable,
} from "./shared.ts";

/**
 * MCP tool timeout, mirrored from the opencode harness: MUST exceed
 * checkout_pr's own 600s deadline or a legitimately long checkout aborts
 * client-side into a confusing retry.
 */
const DSH_MCP_TOOL_TIMEOUT_MS = 660_000;

/**
 * idle budget for a dsh run, derived from session-JSONL growth (see the file
 * header). headless emits no stdout, and deepseek reasoning turns can run for
 * minutes with no tool calls — so this is 2x the opencode inner budget.
 */
export const DSH_ACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

/** dsh's native DeepSeek provider id (llm-deepseek). */
const DIRECT_PROVIDER_ID = "deepseek-official";
/** custom OpenAI-compatible provider id used for the OpenRouter route. */
const OPENROUTER_PROVIDER_ID = "openrouter";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const SESSIONS_SUBDIR = "sessions";

/** plugin ids disabled on every dsh run — the security model above. */
const DISABLED_PLUGIN_IDS = [
  // exec surfaces
  "tool-bash",
  "tool-pwsh",
  // file I/O
  "tool-fs",
  "tool-fs-search",
  "tool-str-replace-editor",
  // network fetch + deepseek-backed search
  "tool-web",
  "web-search-deepseek",
  // skills (all fs-backed)
  "tool-skill",
  "skill-filesystem",
  // ungated fan-out
  "tool-subagent",
  "tool-subagent-fork",
  "tool-subagent-control",
  "tool-subagent-control/list-agents",
  "tool-subagent-report",
  "tool-workflow",
  "tool-ralph",
];

/**
 * map a pullfrog effort rung onto dsh's reasoningEffort ladder. dsh only
 * publishes off/high/max — low collapses to off (documented divergence: an
 * explicit low pick gets no reasoning at all rather than minimal reasoning;
 * the default position resolves to high on every deepseek ladder, so this
 * only fires for explicit low selections).
 */
function mapEffortRung(rung: string | undefined): "off" | "high" | "max" | undefined {
  if (rung === "low") return "off";
  if (rung === "high" || rung === "max") return rung;
  return undefined;
}

/** the dsh provider/model/key configuration for a resolved model specifier. */
function resolveDshModel(modelSpec: string | undefined): {
  providerId: string;
  modelId: string;
  apiKeyEnv: string;
} {
  if (modelSpec) {
    const providerId = dshProviderForModel(modelSpec);
    if (providerId) {
      return {
        providerId,
        modelId: stripProviderPrefix(modelSpec),
        apiKeyEnv: providerId === DIRECT_PROVIDER_ID ? "DEEPSEEK_API_KEY" : "OPENROUTER_API_KEY",
      };
    }
  }
  // no model / not dsh-compatible (auto-select): the harness's own default.
  return {
    providerId: DIRECT_PROVIDER_ID,
    modelId: "deepseek-v4-flash",
    apiKeyEnv: "DEEPSEEK_API_KEY",
  };
}

/** compose the per-run cordis.yml overlay (see the file header for shape). */
export function buildCordisPatch(params: {
  dshHome: string;
  mcpServerUrl: string;
  providerId: string;
  modelId: string;
  apiKeyEnv: string;
  effortRung: "off" | "high" | "max" | undefined;
}): string {
  const lines: string[] = [];
  lines.push("# pullfrog-injected overlay — generated per run, never edit");
  lines.push("- id: agent-default-model");
  lines.push("  config:");
  lines.push(`    provider: ${params.providerId}`);
  lines.push(`    model: ${params.modelId}`);
  if (params.providerId === DIRECT_PROVIDER_ID) {
    lines.push("- id: llm-deepseek");
    lines.push("  config:");
    lines.push(`    apiKeyEnv: ${params.apiKeyEnv}`);
    lines.push("    models:");
    lines.push(`      - id: ${params.modelId}`);
    if (params.effortRung) lines.push(`    reasoningEffort: ${params.effortRung}`);
  } else {
    lines.push("- id: llm-pi-ai");
    lines.push("  config:");
    lines.push("    providers:");
    lines.push(`      ${params.providerId}:`);
    lines.push(`        apiKeyEnv: ${params.apiKeyEnv}`);
    lines.push("        api: openai-completions");
    lines.push(`        baseURL: ${OPENROUTER_BASE_URL}`);
    lines.push("        models:");
    lines.push(`          - id: ${params.modelId}`);
    if (params.effortRung) lines.push(`        reasoning: ${params.effortRung}`);
  }
  lines.push("- id: session-persistence-jsonl");
  lines.push("  config:");
  lines.push(`    root: ${join(params.dshHome, SESSIONS_SUBDIR)}`);
  lines.push("    compression: none");
  for (const id of DISABLED_PLUGIN_IDS) {
    lines.push(`- id: ${id}`);
    lines.push("  disabled: true");
  }
  // NEW plugins must come through `insert:` — a plain `- id:` entry only
  // patches an existing profile entry (measured: entry "mcp-client" not found).
  lines.push("- insert:");
  lines.push("  - id: mcp-client");
  lines.push("    name: '@deepseek-ai/dsh-mcp-client'");
  lines.push("    inject:");
  lines.push("      - tools");
  lines.push("    config:");
  lines.push("      transport: streamable-http");
  lines.push(`      serverName: ${pullfrogMcpName}`);
  lines.push(`      url: ${params.mcpServerUrl}`);
  lines.push(`      toolCallTimeoutMs: ${DSH_MCP_TOOL_TIMEOUT_MS}`);
  lines.push("      failOnStartupError: true");
  return lines.join("\n") + "\n";
}

/** newest session.jsonl mtime under the sessions root, or 0. */
function latestSessionMtime(sessionsRoot: string): number {
  let best = 0;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && entry.name === "session.jsonl") {
        try {
          best = Math.max(best, statSync(p).mtimeMs);
        } catch {
          // raced with cleanup — ignore
        }
      }
    }
  };
  walk(sessionsRoot);
  return best;
}

/**
 * aggregate provider-reported usage from the run's session JSONL. headless
 * prints only the final text, but every turn's assistant/message (and
 * assistant/chunk usage) events carry the same buckets the token-meter folds:
 * inputTokens (uncached input), cacheReadTokens, cacheWriteTokens,
 * outputTokens. summed across turns these match AgentUsage semantics (the
 * full billable input = uncached + cache read + cache write).
 */
export function parseSessionUsage(sessionsRoot: string): AgentUsage | undefined {
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let any = false;
  const parseFile = (path: string): void => {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let ev: { type?: string; data?: Record<string, unknown> };
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      let usage: Record<string, unknown> | undefined;
      if (ev.type === "assistant/message") {
        usage = ev.data?.usage as Record<string, unknown> | undefined;
      } else if (ev.type === "assistant/chunk") {
        const chunk = ev.data?.chunk as { type?: string; usage?: Record<string, unknown> } | undefined;
        if (chunk?.type === "usage") usage = chunk.usage;
      }
      if (!usage) continue;
      any = true;
      const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      totals.inputTokens += n(usage.inputTokens);
      totals.outputTokens += n(usage.outputTokens);
      totals.cacheReadTokens += n(usage.cacheReadTokens);
      totals.cacheWriteTokens += n(usage.cacheWriteTokens);
    }
  };
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && entry.name === "session.jsonl") parseFile(p);
    }
  };
  walk(sessionsRoot);
  if (!any || totals.inputTokens + totals.outputTokens === 0) return undefined;
  return {
    agent: "dsh",
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens > 0 ? totals.cacheReadTokens : undefined,
    cacheWriteTokens: totals.cacheWriteTokens > 0 ? totals.cacheWriteTokens : undefined,
  };
}

/** kill the whole process group (detached spawn) — mirrors codex's killGroup. */
function killGroup(child: ChildProcess): void {
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // already gone
    }
  }
  child.kill("SIGKILL");
}

const install = (): Promise<string> =>
  installFromNpmTarball({
    packageName: "@deepseek-ai/dsh",
    version: getDevDependencyVersion("@deepseek-ai/dsh"),
    executablePath: "node_modules/@deepseek-ai/dsh/lib/bin.js",
    installDependencies: true,
  });

/** one headless invocation; resolves when the subprocess exits. */
async function runDshOnce(params: {
  ctx: AgentRunContext;
  prompt: string;
  cliPath: string;
  home: string;
  patchPath: string;
  env: NodeJS.ProcessEnv;
  sessionsRoot: string;
}): Promise<AgentResult> {
  const { ctx } = params;
  const start = performance.now();
  const stdoutTail = new TailBuffer(DEFAULT_MAX_RETAINED_BYTES);
  const stderrTail = new TailBuffer(DEFAULT_MAX_RETAINED_BYTES);

  // spawn the CLI JS directly (never the `dsh` shim) — the shim is a node
  // script that would inherit NODE_OPTIONS/PATH from the run env; the same
  // reasoning as the codex native-binary bypass.
  const child = nodeSpawn(
    process.execPath,
    [params.cliPath, "--profile", "headless", "--patch", params.patchPath, params.prompt],
    {
      env: params.env,
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    }
  );
  trackChild({ child, killGroup: true });

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutTail.append(chunk.toString());
    markActivity();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail.append(chunk.toString());
    markActivity();
  });

  let exitCode: number | null = null;
  let innerKilled = false;
  const exited = new Promise<void>((resolve) => {
    child.on("close", (code) => {
      exitCode = code;
      resolve();
    });
  });

  // idle watchdog on session-JSONL growth (see the file header): any new
  // event — llm chunks, tool calls — resets the clock. markActivity() keeps
  // main.ts's outer process-output watchdog on the same clock.
  let lastMtime = latestSessionMtime(params.sessionsRoot);
  const watchdog = setInterval(() => {
    const mtime = latestSessionMtime(params.sessionsRoot);
    if (mtime > lastMtime) {
      lastMtime = mtime;
      markActivity();
      return;
    }
    const idleMs = performance.now() - (mtime > 0 ? mtime : start);
    if (idleMs > DSH_ACTIVITY_TIMEOUT_MS) {
      innerKilled = true;
      log.warning(
        `» dsh idle ${Math.round(idleMs / 1000)}s without session activity — killing (inner activity timeout)`
      );
      killGroup(child);
      ctx.onActivityTimeout?.();
    }
  }, DEFAULT_ACTIVITY_CHECK_INTERVAL_MS);

  await exited;
  clearInterval(watchdog);

  const usage = parseSessionUsage(params.sessionsRoot);
  const stdout = stdoutTail.toString();
  const stderr = stderrTail.toString();
  const durationMs = Math.round(performance.now() - start);

  if (innerKilled) {
    return {
      success: false,
      output: stdout,
      error: `dsh run killed for inactivity after ${DSH_ACTIVITY_TIMEOUT_MS / 60000}min`,
      usage,
    };
  }

  // headless exit contract: 0 = turn completed, 1 = turn ended in error with
  // a `dsh: <code>: <message>` line on stderr.
  const errorLine = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("dsh:"))
    .at(-1);
  const ok = exitCode === 0;
  log.debug(`» dsh process exited in ${durationMs}ms (code=${exitCode})`);
  if (usage) {
    logTokenTable({
      input: usage.inputTokens,
      cacheRead: usage.cacheReadTokens ?? 0,
      cacheWrite: usage.cacheWriteTokens ?? 0,
      output: usage.outputTokens,
    });
  }
  return {
    success: ok,
    output: stdout,
    error: ok ? undefined : (errorLine ?? `dsh exited with code ${exitCode}`),
    usage,
  };
}

export const dsh = agent({
  name: "dsh",
  install,
  run: async (ctx: AgentRunContext): Promise<AgentResult> => {
    const cliPath = await install();
    const home = mkdtempSync(join(tmpdir(), "pullfrog-dsh-"));
    const sessionsRoot = join(home, SESSIONS_SUBDIR);
    mkdirSync(sessionsRoot, { recursive: true });
    try {
      const modelSpec = ctx.payload.proxyModel ?? ctx.resolvedModel;
      const dshModel = resolveDshModel(modelSpec);
      const effort = resolveRunEffort(ctx);
      const patchPath = join(home, "cordis.patch.yml");
      writeFileSync(
        patchPath,
        buildCordisPatch({
          dshHome: home,
          mcpServerUrl: ctx.mcpServerUrl,
          providerId: dshModel.providerId,
          modelId: dshModel.modelId,
          apiKeyEnv: dshModel.apiKeyEnv,
          effortRung: mapEffortRung(effort.rung),
        })
      );
      log.info(
        `» dsh harness: provider=${dshModel.providerId} model=${dshModel.modelId} effort=${effort.rung ?? "default"}`
      );
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        DSH_HOME: home,
        DSH_PERMISSION_MODE: "workspace-write",
        PWD: process.cwd(),
      };
      const runOnce = (prompt: string): Promise<AgentResult> =>
        runDshOnce({ ctx, prompt, cliPath, home, patchPath, env, sessionsRoot });

      const initial = await runOnce(ctx.instructions.full);
      return await runPostRunRetryLoop({
        ctx,
        initialResult: initial,
        initialUsage: initial.usage,
        reflectionPrompt: buildReflectionPrompt(ctx.toolState),
        // headless can always be respawned with a continuation prompt.
        canResume: () => true,
        resume: async (c) => runOnce(c.prompt),
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
});
