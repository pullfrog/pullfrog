/**
 * Claude Code agent — secure harness around the `claude` CLI.
 *
 * mirrors the opencode harness's security model:
 * - native exec tools (Bash, Monitor, REPL, Workflow) blocked via BOTH
 *   --disallowedTools AND managed-settings.json `permissions.deny` (the agent
 *   cannot shell out / run code outside the MCP shell). the managed-settings
 *   deny is the authoritative, bypass-immune layer: `--disallowedTools` alone
 *   (a `cliArg`-source deny) was observed to leak under
 *   `--dangerously-skip-permissions`, surfacing a secret env marker via the
 *   native Bash tool. managed-settings denies are `policySettings`-source,
 *   highest precedence, and survive bypassPermissions mode.
 * - managed-settings.json: filesystem sandbox — deny /proc, /sys reads
 * - MCP ShellTool provides restricted shell (filtered env, no secrets)
 * - MCP server injected via --mcp-config (not replacing project config)
 * - ASKPASS handles git auth separately (token never in subprocess env)
 *
 * the agent process itself gets full env (needs LLM API keys, PATH, etc.).
 * security is enforced at the tool layer, not the process layer.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pullfrogMcpName } from "../external.ts";
import {
  BEDROCK_MODEL_ID_ENV,
  isBedrockAnthropicId,
  isVertexAnthropicId,
  VERTEX_MODEL_ID_ENV,
} from "../models.ts";

import { AGENT_ACTIVITY_TIMEOUT_MS, getIdleMs, markActivity } from "../utils/activity.ts";
import { preflightClaudeSubscription } from "../utils/claudeSubscription.ts";
import { formatJsonValue, log } from "../utils/cli.ts";
import { installFromNpmTarball } from "../utils/install.ts";
import { findProviderErrorMatch } from "../utils/providerErrors.ts";
import { addSkill, installBundledSkills } from "../utils/skills.ts";
import {
  DEFAULT_MAX_RETAINED_BYTES,
  SPAWN_ACTIVITY_TIMEOUT_CODE,
  SpawnTimeoutError,
  spawn,
  TailBuffer,
} from "../utils/subprocess.ts";
import { ThinkingTimer } from "../utils/timer.ts";
import type { TodoTracker } from "../utils/todoTracking.ts";
import { getDevDependencyVersion } from "../utils/version.ts";
import { applyClaudeVertexEnv } from "../utils/vertex.ts";
import {
  buildClaudePretoolGateSettings,
  buildClaudePretoolGateSource,
  CLAUDE_PRETOOL_GATE_FILENAME,
} from "./claudePretoolGate.ts";
import { startGateServer } from "./gateServer.ts";
import { GIT_NATIVE_READ_DENY_CLAUDE, GIT_NATIVE_WRITE_DENY_CLAUDE } from "./nativeFsDenies.ts";
import { finalizeAgentResult } from "./postRun.ts";
import { REVIEWER_AGENT_NAME, REVIEWER_SYSTEM_PROMPT } from "./reviewer.ts";
import { formatWithLabel, ORCHESTRATOR_LABEL, SessionLabeler } from "./sessionLabeler.ts";
import {
  type AgentResult,
  type AgentRunContext,
  type AgentUsage,
  agent,
  logTokenTable,
  MAX_STDERR_LINES,
} from "./shared.ts";

async function installClaudeCli(): Promise<string> {
  return await installFromNpmTarball({
    packageName: "@anthropic-ai/claude-code",
    version: getDevDependencyVersion("@anthropic-ai/claude-code"),
    // 2.1.113+ ships a native binary (bin/claude.exe) instead of cli.js; the
    // package postinstall copies it from the platform optionalDependency, so we
    // need installDependencies to run that postinstall.
    executablePath: "bin/claude.exe",
    installDependencies: true,
  });
}

/**
 * Native claude-code tools that execute arbitrary shell/code and therefore
 * bypass Pullfrog's security boundary (the restricted MCP `shell` tool with a
 * filtered, secret-free env). These run inside the agent process with full env,
 * so leaving any of them enabled defeats both `shell: "disabled"` AND the
 * env-filtering that the MCP shell relies on even when shell is enabled.
 *
 * As of claude-code 2.1.150 the exec surface is no longer just `Bash`:
 *   - `Monitor` runs a shell command/script (the `command` field)
 *   - `REPL` runs arbitrary JavaScript (can `require("node:child_process")`)
 *   - `Workflow` orchestrates subagents/pipelines that can reach the above
 * Each is denied at top level and inside `Agent(...)` (Task subagents), mirroring
 * the existing `Bash` / `Agent(Bash)` pair. Denying a tool that isn't registered
 * in a given run is a harmless no-op, so this list is also forward-safe.
 *
 * `CLAUDE_EXEC_TOOL_DENY_RULES` is wired into TWO surfaces: `--disallowedTools`
 * (removes the tools from the advertised list) and managed-settings.json
 * `permissions.deny` (the authoritative, bypass-immune deny — see
 * buildManagedSettings). The flag alone proved insufficient: under
 * `--dangerously-skip-permissions` the native Bash tool ran despite
 * `--disallowedTools Bash`, leaking a per-run secret marker.
 */
const CLAUDE_EXEC_TOOLS = ["Bash", "Monitor", "REPL", "Workflow"] as const;
const CLAUDE_EXEC_TOOL_DENY_RULES = [
  ...CLAUDE_EXEC_TOOLS,
  ...CLAUDE_EXEC_TOOLS.map((t) => `Agent(${t})`),
];
const CLAUDE_DISALLOWED_TOOLS = CLAUDE_EXEC_TOOL_DENY_RULES.join(",");

// ── config ─────────────────────────────────────────────────────────────────────

function writeMcpConfig(ctx: AgentRunContext): string {
  const configDir = join(ctx.tmpdir, ".claude");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "mcp.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        [pullfrogMcpName]: { type: "http", url: ctx.mcpServerUrl },
      },
    })
  );
  return configPath;
}

/**
 * Drop the PreToolUse gate script + its `--settings` JSON into the per-run
 * tmpdir and return the absolute path to the settings file. The script
 * blocks state-mutating MCP tool calls when `agent_id` is non-empty (i.e.,
 * the call originates inside a Task/Agent subagent dispatch). See
 * action/agents/claudePretoolGate.ts for the contract.
 *
 * Two paths register the gate:
 *   1. flag settings (`--settings <path>`) — covers non-CI runs (`pnpm play`,
 *      local dev) where `installManagedSettings` is a no-op.
 *   2. managed settings (/etc/claude-code/managed-settings.json) — covers CI,
 *      where `allowManagedHooksOnly: true` filters flag-settings hooks. The
 *      same hook entry is embedded in `buildManagedSettings` below.
 *
 * The flag settings also carry the native exec-tool `permissions.deny`
 * (via `buildClaudePretoolGateSettings`) so non-CI runs (where managed
 * settings are absent) still block native Bash et al. at a settings-source
 * deny, not just the `--disallowedTools` cliArg deny that proved leaky under
 * `--dangerously-skip-permissions`.
 */
function writePretoolGateAssets(ctx: AgentRunContext): {
  scriptPath: string;
  settingsPath: string;
} {
  const scriptPath = join(ctx.tmpdir, CLAUDE_PRETOOL_GATE_FILENAME);
  writeFileSync(scriptPath, buildClaudePretoolGateSource(ctx.subagentDeniedTools));
  chmodSync(scriptPath, 0o755);
  const settingsPath = join(ctx.tmpdir, "pullfrog-claude-settings.json");
  const settings = buildClaudePretoolGateSettings(scriptPath, CLAUDE_EXEC_TOOL_DENY_RULES);
  writeFileSync(settingsPath, JSON.stringify(settings));
  return { scriptPath, settingsPath };
}

/**
 * Build the `--agents` JSON definition for the `reviewfrog` subagent.
 *
 * The Claude Code path always runs against an Anthropic model (see
 * resolveAgent), so we hardcode the cheaper-sibling downshift: lenses run
 * on Sonnet, the orchestrator stays on whatever model `--model` was passed.
 *
 * Per-call model override is also possible (Task tool's `model` arg accepts
 * 'sonnet' | 'opus' | 'haiku') and takes precedence over what's set here —
 * we don't pass it; the per-subagent `model` field is the right default.
 *
 * The non-mutative + non-recursive contract is enforced by the prose system
 * prompt baked into the agent — see action/agents/reviewer.ts for why we
 * no longer wire per-agent `disallowedTools` here.
 */
function buildAgentsJson(): string {
  const agents = {
    [REVIEWER_AGENT_NAME]: {
      description:
        "Read-only review subagent for lens-based code review (correctness, security, billing-subsystem, etc.). " +
        "Reads only — no writes, no state-changing shell or MCP calls, no nested subagent dispatch.",
      prompt: REVIEWER_SYSTEM_PROMPT,
      model: "claude-sonnet-5",
    },
  };
  return JSON.stringify(agents);
}

// ── model helpers ─────────────────────────────────────────────────────────────

// claude CLI expects bare model names (e.g. "claude-sonnet-5"), not provider-prefixed specifiers
function stripProviderPrefix(specifier: string): string {
  const slashIndex = specifier.indexOf("/");
  return slashIndex > 0 ? specifier.slice(slashIndex + 1) : specifier;
}

// Claude Code `--effort` controls thinking budget (token cost + latency).
// `high` is Anthropic's tuned default; `max` is unconstrained and expensive.
// Override per run via action input `effort` or env `PULLFROG_EFFORT`
// (low | medium | high | max). Invalid values fall back to high.
export type ClaudeEffort = "low" | "medium" | "high" | "max";

const EFFORT_LEVELS = new Set<ClaudeEffort>(["low", "medium", "high", "max"]);

export function resolveEffort(_model?: string | undefined): ClaudeEffort {
  const raw = (
    process.env.PULLFROG_EFFORT ||
    process.env.INPUT_EFFORT ||
    "high"
  )
    .trim()
    .toLowerCase();
  if (EFFORT_LEVELS.has(raw as ClaudeEffort)) {
    return raw as ClaudeEffort;
  }
  if (raw) {
    log.warning(`» unknown effort "${raw}" — using high (valid: low|medium|high|max)`);
  }
  return "high";
}

// ── NDJSON event types ─────────────────────────────────────────────────────────

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | unknown;
  is_error?: boolean;
  [key: string]: unknown;
}

// SDK schema (per claude-agent-sdk docs) puts `session_id` and
// `parent_tool_use_id` at the top level of every Assistant/User/System/Result
// message, not inside `message`. Subagent events carry a non-null
// `parent_tool_use_id` pointing at the orchestrator's Task/Agent tool_use id.
interface ClaudeSystemEvent {
  type: "system";
  session_id?: string;
  parent_tool_use_id?: string | null;
  [key: string]: unknown;
}

interface ClaudeAssistantEvent {
  type: "assistant";
  session_id?: string;
  parent_tool_use_id?: string | null;
  message?: {
    role?: string;
    content?: ContentBlock[];
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface ClaudeUserEvent {
  type: "user";
  session_id?: string;
  parent_tool_use_id?: string | null;
  message?: {
    role?: string;
    content?: ContentBlock[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface ClaudeResultEvent {
  type: "result";
  subtype?: string;
  // claude CLI sets `is_error: true` (alongside `subtype: "success"`) when
  // an upstream provider fails mid-stream. `api_error_status` carries the
  // provider HTTP status (e.g. 401 for invalid API key). per the official
  // SDK types, `api_error_status` is `number | null`, and the `error_*`
  // subtypes carry their actionable payload in `errors: string[]` instead
  // of `result`.
  is_error?: boolean;
  api_error_status?: number | null;
  errors?: string[];
  result?: string;
  session_id?: string;
  num_turns?: number;
  total_cost_usd?: number;
  total_input_tokens?: number;
  total_output_tokens?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  [key: string]: unknown;
}

// additional event types emitted by Claude CLI (handled as no-ops / debug)
interface ClaudeStreamEvent {
  type: "stream_event";
  [key: string]: unknown;
}
interface ClaudeToolProgressEvent {
  type: "tool_progress";
  [key: string]: unknown;
}
interface ClaudeToolUseSummaryEvent {
  type: "tool_use_summary";
  [key: string]: unknown;
}
interface ClaudeAuthStatusEvent {
  type: "auth_status";
  [key: string]: unknown;
}

type ClaudeEvent =
  | ClaudeSystemEvent
  | ClaudeAssistantEvent
  | ClaudeUserEvent
  | ClaudeResultEvent
  | ClaudeStreamEvent
  | ClaudeToolProgressEvent
  | ClaudeToolUseSummaryEvent
  | ClaudeAuthStatusEvent;

// ── runner ──────────────────────────────────────────────────────────────────────

type RunParams = {
  label: string;
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  todoTracker?: TodoTracker | undefined;
  onActivityTimeout?: (() => void) | undefined;
  onToolUse?: ((event: { toolName: string; input: unknown }) => void) | undefined;
};

type ClaudeRunResult = AgentResult & { sessionId?: string | undefined };

/**
 * Return the tail of `text` capped at `maxCodeUnits` UTF-16 code units,
 * dropping any partial first line. used in the exit-non-zero stdout fallback
 * so we never surface a truncated NDJSON event to operators —
 * `result.stdout.slice(-2048)` would otherwise cut mid-line and produce a
 * syntactically broken JSON fragment. code units rather than bytes because
 * `String.prototype.slice` operates on UTF-16 units; for multi-byte UTF-8
 * content the effective byte budget can be up to 4× the nominal limit.
 */
function tailLines(text: string, maxCodeUnits: number): string {
  if (text.length <= maxCodeUnits) return text;
  const tail = text.slice(-maxCodeUnits);
  const firstNewline = tail.indexOf("\n");
  // if no newline in window or it's at the very start, return as-is;
  // otherwise drop the partial first line.
  return firstNewline > 0 && firstNewline < tail.length - 1 ? tail.slice(firstNewline + 1) : tail;
}

export async function runClaude(params: RunParams): Promise<ClaudeRunResult> {
  const startTime = performance.now();
  let eventCount = 0;

  // per-session labeler so parallel subagent log lines can be differentiated.
  // claude-agent-sdk runs subagents inside the orchestrator's session — they
  // share `session_id` — and stamps every subagent message with a non-null
  // `parent_tool_use_id` pointing at the Agent tool_use that spawned them.
  // we bind each Agent tool_use id to its dispatched label up front, then
  // labelFor short-circuits to the direct mapping when parent_tool_use_id is
  // set. orchestrator events (parent_tool_use_id === null) flow through the
  // sessionID path and bind to ORCHESTRATOR_LABEL on first sighting.
  const labeler = new SessionLabeler();
  function eventLabel(event: { session_id?: string; parent_tool_use_id?: string | null }): string {
    return labeler.labelFor(event.session_id ?? null, event.parent_tool_use_id ?? null);
  }
  function withLabel(label: string, message: string): string {
    return label === ORCHESTRATOR_LABEL ? message : formatWithLabel(label, message);
  }

  // one ThinkingTimer per session — sharing a single timer across sessions
  // conflated cross-session interleaving as parent thinking time. each timer
  // formats its log lines through the session label so attribution is visible.
  const thinkingTimers = new Map<string, ThinkingTimer>();
  function timerFor(label: string): ThinkingTimer {
    let t = thinkingTimers.get(label);
    if (!t) {
      const formatLine = (line: string) =>
        label === ORCHESTRATOR_LABEL ? line : formatWithLabel(label, line);
      t = new ThinkingTimer(formatLine);
      thinkingTimers.set(label, t);
    }
    return t;
  }

  let finalOutput = "";
  let sessionId: string | undefined;
  let resultErrorSubtype: string | null = null;
  // captures the structured error string from a result event with
  // `is_error: true` (e.g. mid-stream provider auth failures the CLI
  // surfaces as `subtype: "success"` synthetic-stop events, or the
  // `errors[]` array from `error_*` subtypes). preferred over raw
  // stdout/stderr in the exit-non-zero path so the GitHub Actions
  // `##[error]` line shows the actionable message instead of an 8KB+
  // NDJSON dump.
  let lastResultError: string | null = null;
  // set only for synthetic-stop `subtype: "success"` + `is_error: true`
  // events, where `accumulatedTokens` from prior `assistant` events is
  // stale and logging it would mislead operators into thinking billable
  // tokens were spent on a successful turn. deliberately NOT set for
  // `error_max_turns` / `error_during_execution` / `error_*` subtypes
  // because those runs genuinely consumed tokens and operators need
  // billing visibility for them.
  let syntheticStopFailure = false;
  let accumulatedTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  // Claude CLI reports a single end-of-run `total_cost_usd` on the result
  // event. per-message events don't carry cost, so there's nothing to sum —
  // we just capture the final value when it arrives.
  let accumulatedCostUsd = 0;
  let tokensLogged = false;

  function buildUsage(): AgentUsage | undefined {
    const totalInput =
      accumulatedTokens.input + accumulatedTokens.cacheRead + accumulatedTokens.cacheWrite;
    return totalInput > 0 || accumulatedTokens.output > 0
      ? {
          agent: "claude",
          inputTokens: totalInput,
          outputTokens: accumulatedTokens.output,
          cacheReadTokens: accumulatedTokens.cacheRead || undefined,
          cacheWriteTokens: accumulatedTokens.cacheWrite || undefined,
          costUsd: accumulatedCostUsd > 0 ? accumulatedCostUsd : undefined,
        }
      : undefined;
  }

  const handlers = {
    system: (event: ClaudeSystemEvent) => {
      // claude-agent-sdk only emits system:init for the top-level query, so
      // this binds the orchestrator label and never appears in subagent flow.
      // we still route through eventLabel so a subagent system event (if the
      // SDK ever adds one) wouldn't go silently misattributed.
      const label = eventLabel(event);
      log.debug(withLabel(label, `» ${params.label} system event`));
    },
    assistant: (event: ClaudeAssistantEvent) => {
      const content = event.message?.content;
      if (!content) return;

      const label = eventLabel(event);
      const boxTitle = label === ORCHESTRATOR_LABEL ? params.label : `${params.label} [${label}]`;

      for (const block of content) {
        if (block.type === "text" && block.text?.trim()) {
          const message = block.text.trim();
          log.box(message, { title: boxTitle });
          // only the orchestrator's text becomes the run's "output" — subagent
          // report-back text would otherwise clobber the parent's final answer.
          if (label === ORCHESTRATOR_LABEL) {
            finalOutput = message;
          }
        } else if (block.type === "tool_use") {
          const toolName = block.name || "unknown";
          if (params.onToolUse) {
            params.onToolUse({
              toolName,
              input: block.input,
            });
          }
          timerFor(label).markToolCall();
          const inputFormatted = formatJsonValue(block.input || {});
          const toolCallLine =
            inputFormatted !== "{}" ? `» ${toolName}(${inputFormatted})` : `» ${toolName}()`;
          log.info(withLabel(label, toolCallLine));

          // when the orchestrator dispatches a subagent, bind the Agent
          // tool_use id to the dispatched label so future events carrying
          // `parent_tool_use_id === block.id` resolve directly to the right
          // lens. v2.1.63+ renamed the tool to "Agent"; older versions
          // emitted "Task". match both for forward-compat.
          if (
            (toolName === "Task" || toolName === "Agent") &&
            block.input &&
            typeof block.input === "object"
          ) {
            const taskInput = block.input as {
              description?: string;
              subagent_type?: string;
              prompt?: string;
            };
            const dispatchedLabel = labeler.recordTaskDispatch(taskInput, block.id ?? null);
            log.info(
              withLabel(
                label,
                `» dispatching subagent: ${dispatchedLabel}` +
                  (taskInput.subagent_type ? ` (subagent_type=${taskInput.subagent_type})` : "")
              )
            );
          }

          // agent's explicit MCP report_progress takes priority over todo tracking
          if (toolName.includes("report_progress") && params.todoTracker) {
            log.debug("» report_progress detected, disabling todo tracking");
            params.todoTracker.cancel();
          }

          // parse TodoWrite events for live progress tracking. only honor the
          // orchestrator's todos — subagents emit their own todo lists which
          // would otherwise clobber the visible progress comment.
          if (
            toolName === "TodoWrite" &&
            params.todoTracker?.enabled &&
            label === ORCHESTRATOR_LABEL
          ) {
            params.todoTracker.update(block.input);
          }
        }
      }

      // accumulate per-message usage if available. capture cache fields too
      // so the fallback token table (used when no final `result` event fires)
      // still reports the full breakdown instead of silently dropping cache.
      const msgUsage = event.message?.usage;
      if (msgUsage) {
        accumulatedTokens.input += msgUsage.input_tokens || 0;
        accumulatedTokens.output += msgUsage.output_tokens || 0;
        accumulatedTokens.cacheRead += msgUsage.cache_read_input_tokens || 0;
        accumulatedTokens.cacheWrite += msgUsage.cache_creation_input_tokens || 0;
      }
    },
    user: (event: ClaudeUserEvent) => {
      const content = event.message?.content;
      if (!content) return;

      const label = eventLabel(event);

      for (const block of content) {
        if (typeof block === "string") continue;
        if (block.type === "tool_result") {
          timerFor(label).markToolResult();

          const outputContent =
            typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? (block.content as unknown[])
                    .map((entry: unknown) =>
                      typeof entry === "string"
                        ? entry
                        : typeof entry === "object" && entry !== null && "text" in entry
                          ? String((entry as { text: unknown }).text)
                          : JSON.stringify(entry)
                    )
                    .join("\n")
                : String(block.content);

          if (block.is_error) {
            log.info(withLabel(label, `» tool error: ${outputContent}`));
          } else {
            log.debug(withLabel(label, `» tool output: ${outputContent}`));
          }
        }
      }
    },
    result: (event: ClaudeResultEvent) => {
      if (event.session_id) sessionId = event.session_id;
      const subtype = event.subtype || "unknown";
      const numTurns = event.num_turns || 0;

      // claude CLI emits synthetic-stop result events with `subtype: "success"`
      // but `is_error: true` when an upstream provider fails mid-stream (e.g.
      // 401 from anthropic). short-circuit before the usage/token-table path
      // so we don't log a usage table for a failed attempt and so downstream
      // (`resultErrorSubtype` branch) surfaces the structured error. gated on
      // `subtype === "success"` because the `error_*` subtypes also set
      // `is_error: true` but carry their payload in `errors: string[]` and
      // are handled by the dedicated branches below.
      if (event.is_error === true && subtype === "success") {
        const apiStatus = event.api_error_status;
        lastResultError =
          event.result?.trim() ||
          `claude reported is_error=true with no result text (api_error_status=${apiStatus ?? "unknown"})`;
        resultErrorSubtype = subtype;
        syntheticStopFailure = true;
        log.info(
          `» ${params.label} result error: subtype=${subtype}, api_error_status=${apiStatus ?? "unknown"}, message=${lastResultError}`
        );
        return;
      }

      if (subtype === "success") {
        // extract detailed usage from result event (most accurate source).
        // note: `input` here is non-cached input tokens only, matching the
        // semantics of OpenCode's step_finish.tokens.input — the logTokenTable
        // helper sums Input + Cache Read + Cache Write + Output into the Total
        // column so consumers get the real billable figure.
        const usage = event.usage;
        const inputTokens = usage?.input_tokens || 0;
        const cacheRead = usage?.cache_read_input_tokens || 0;
        const cacheWrite = usage?.cache_creation_input_tokens || 0;
        const outputTokens = usage?.output_tokens || 0;
        // guard against NaN/Infinity from malformed CLI output poisoning the total
        const costUsd =
          typeof event.total_cost_usd === "number" && Number.isFinite(event.total_cost_usd)
            ? event.total_cost_usd
            : 0;

        accumulatedTokens = { input: inputTokens, output: outputTokens, cacheRead, cacheWrite };
        accumulatedCostUsd = costUsd;

        log.info(`» ${params.label} result: subtype=${subtype}, turns=${numTurns}`);

        if (!tokensLogged) {
          logTokenTable({
            input: inputTokens,
            cacheRead,
            cacheWrite,
            output: outputTokens,
            costUsd,
          });
          tokensLogged = true;
        }
      } else if (subtype === "error_max_turns") {
        resultErrorSubtype = subtype;
        lastResultError = event.errors?.join("\n").trim() || null;
        log.info(`» ${params.label} max turns reached: ${JSON.stringify(event)}`);
      } else if (subtype === "error_during_execution") {
        resultErrorSubtype = subtype;
        lastResultError = event.errors?.join("\n").trim() || null;
        log.info(`» ${params.label} execution error: ${JSON.stringify(event)}`);
      } else if (subtype.startsWith("error")) {
        resultErrorSubtype = subtype;
        lastResultError = event.errors?.join("\n").trim() || null;
        log.info(`» ${params.label} result: subtype=${subtype}, data=${JSON.stringify(event)}`);
      } else {
        log.info(`» ${params.label} result: subtype=${subtype}, data=${JSON.stringify(event)}`);
      }

      if (event.result?.trim()) {
        finalOutput = event.result.trim();
      }
    },
    // additional Claude CLI event types — debug-logged only
    stream_event: () => {},
    tool_progress: () => {},
    tool_use_summary: () => {},
    auth_status: () => {},
  };

  const recentStderr: string[] = [];
  // ring buffer of recent non-JSON stdout lines. Claude CLI prints
  // human-readable TTY chrome (status bubbles, quota notices, etc.)
  // alongside the NDJSON event stream. when the CLI exits non-zero without
  // emitting a structured error event, these lines are the only actionable
  // signal — preferring them over the NDJSON tail keeps progress comments
  // readable. issue #643.
  const recentNonJsonStdout: string[] = [];

  let lastProviderError: string | null = null;

  // capped accumulator — see opencode.ts for rationale (issue #680).
  const output = new TailBuffer(DEFAULT_MAX_RETAINED_BYTES);
  let stdoutBuffer = "";

  try {
    const result = await spawn({
      cmd: params.cmd,
      args: params.args,
      cwd: params.cwd,
      env: params.env,
      // flat agent idle budget — long synchronous MCP tool calls (issue #760)
      // sit well under it, so no per-toolcall suspend bracketing is needed.
      activityTimeout: AGENT_ACTIVITY_TIMEOUT_MS,
      onActivityTimeout: params.onActivityTimeout,
      stdio: ["ignore", "pipe", "pipe"],
      // run claude in its own process group so SIGKILL on activity timeout /
      // outer cancellation reaches any subprocesses it spawns (rg, file
      // watchers, mcp transports, etc). claude (2.1.113+) is now a native
      // binary like opencode-ai/bin/opencode, so detached + killGroup is
      // required to avoid orphaning the binary and its children.
      killGroup: true,
      // claude already drains every chunk via onStdout (NDJSON parsing) and
      // onStderr (recentStderr ring buffer). retaining a second copy in the
      // spawn wrapper would grow unbounded for long sessions and previously
      // crashed the wrapper with RangeError. see issue #680.
      retain: "none",
      onStdout: async (chunk) => {
        const text = chunk.toString();
        output.append(text);
        markActivity();

        stdoutBuffer += text;
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let event: ClaudeEvent;
          try {
            event = JSON.parse(trimmed) as ClaudeEvent;
          } catch {
            log.debug(`» non-JSON stdout line: ${trimmed.substring(0, 200)}`);
            recentNonJsonStdout.push(trimmed);
            if (recentNonJsonStdout.length > MAX_STDERR_LINES) recentNonJsonStdout.shift();
            continue;
          }

          eventCount++;
          log.debug(JSON.stringify(event, null, 2));

          const timeSinceLastActivity = getIdleMs();
          if (timeSinceLastActivity > 10000) {
            log.info(
              `» no activity for ${(timeSinceLastActivity / 1000).toFixed(1)}s (${params.label} may be processing internally) (${eventCount} events processed so far)`
            );
          }
          markActivity();

          const handler = handlers[event.type as keyof typeof handlers];
          if (!handler) {
            log.debug(`» ${params.label} event (unhandled): type=${event.type}`);
            continue;
          }
          try {
            (handler as (e: ClaudeEvent) => void)(event);
          } catch (err) {
            log.info(
              `» ${params.label} handler for type=${event.type} threw: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      },
      onStderr: (chunk) => {
        const trimmed = chunk.trim();
        if (!trimmed) return;

        recentStderr.push(trimmed);
        if (recentStderr.length > MAX_STDERR_LINES) recentStderr.shift();

        const match = findProviderErrorMatch(trimmed);
        if (match) {
          lastProviderError = match.label;
          log.info(`» provider error detected (${match.label}): ${match.excerpt}`);
        } else {
          log.debug(trimmed);
        }
      },
    });

    if (result.exitCode === 0) {
      await params.todoTracker?.flush();
    } else {
      params.todoTracker?.cancel();
    }

    const duration = performance.now() - startTime;
    log.info(
      `» ${params.label} completed in ${Math.round(duration)}ms with exit code ${result.exitCode}`
    );

    if (eventCount === 0) {
      const stderrContext = recentStderr.join("\n");
      const diagnosis = lastProviderError
        ? `provider error: ${lastProviderError}`
        : "unknown cause (no stdout events received)";
      log.info(`» ${params.label} produced 0 events (${diagnosis})`);
      if (stderrContext) log.info(`» last stderr output:\n${stderrContext}`);
    }

    // skip the fallback token table only for the synthetic-stop
    // `subtype: "success"` + `is_error: true` case: `accumulatedTokens` from
    // prior `assistant` events is stale there and logging it would mislead
    // operators into thinking billable tokens were spent on a successful turn.
    // `error_max_turns` / `error_during_execution` / `error_*` subtypes
    // represent runs that genuinely consumed tokens, so they still get the
    // table for billing visibility.
    if (
      !tokensLogged &&
      !syntheticStopFailure &&
      (accumulatedTokens.input > 0 ||
        accumulatedTokens.output > 0 ||
        accumulatedTokens.cacheRead > 0 ||
        accumulatedTokens.cacheWrite > 0)
    ) {
      logTokenTable({ ...accumulatedTokens, costUsd: accumulatedCostUsd });
      tokensLogged = true;
    }

    const usage = buildUsage();

    if (result.exitCode !== 0) {
      const errorContext = lastProviderError ? ` (${lastProviderError})` : "";
      // prefer the structured `lastResultError` (parsed from a result event
      // with `is_error: true`) over raw stdout. raw stdout is the full NDJSON
      // event stream — dumping it into a GitHub Actions `##[error]` line both
      // hides the actionable provider message and pollutes the run log. cap
      // the stdout fallback to the last 2KB so it stays readable when neither
      // a structured error nor stderr is available.
      //
      // result.stdout / result.stderr are empty because we pass retain:"none"
      // to spawn (see issue #680); the agent layer keeps its own bounded
      // mirrors via `output` (TailBuffer) and `recentStderr` (ring buffer).
      const stdoutSnapshot = output.toString();
      const stderrSnapshot = recentStderr.join("\n");
      const truncatedStdout = stdoutSnapshot ? tailLines(stdoutSnapshot, 2048) : "";
      // prefer non-JSON stdout (human-readable TTY chrome the CLI prints,
      // including status bubbles and quota notices) over the raw NDJSON
      // tail. when the CLI exits 1 without emitting `is_error` (issue #643),
      // the NDJSON fallback would otherwise dump 2KB of `system/init` events
      // into the progress comment with no mention of the actual cause.
      const nonJsonStdoutSnapshot = recentNonJsonStdout.join("\n");
      const errorMessage =
        lastResultError ||
        stderrSnapshot ||
        nonJsonStdoutSnapshot ||
        truncatedStdout ||
        `unknown error - no output from Claude CLI${errorContext}`;
      log.error(
        `${params.label} exited with code ${result.exitCode}${errorContext}: ${errorMessage}`
      );
      log.debug(`stdout: ${stdoutSnapshot.substring(0, 500)}`);
      log.debug(`stderr: ${stderrSnapshot.substring(0, 500)}`);
      return {
        success: false,
        output: finalOutput || stdoutSnapshot,
        error: errorMessage,
        usage,
        sessionId,
      };
    }

    if (eventCount === 0 && lastProviderError) {
      return {
        success: false,
        output: finalOutput || output.toString(),
        error: `provider error: ${lastProviderError}`,
        usage,
        sessionId,
      };
    }

    if (resultErrorSubtype) {
      return {
        success: false,
        output: finalOutput || output.toString(),
        error: lastResultError || `result subtype: ${resultErrorSubtype}`,
        usage,
        sessionId,
      };
    }

    return { success: true, output: finalOutput || output.toString(), usage, sessionId };
  } catch (error) {
    params.todoTracker?.cancel();
    const duration = performance.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isActivityTimeout =
      error instanceof SpawnTimeoutError && error.code === SPAWN_ACTIVITY_TIMEOUT_CODE;

    const stderrContext = recentStderr.slice(-10).join("\n");
    const diagnosis = lastProviderError
      ? `likely cause: ${lastProviderError}`
      : eventCount === 0
        ? "Claude produced 0 stdout events - check if the API is reachable"
        : `${eventCount} events were processed before the hang`;

    log.info(
      `» ${params.label} ${isActivityTimeout ? "hung" : "failed"} after ${(duration / 1000).toFixed(1)}s: ${errorMessage}`
    );
    log.info(`» diagnosis: ${diagnosis}`);
    if (stderrContext)
      log.info(
        `» recent stderr (last ${Math.min(recentStderr.length, 10)} lines):\n${stderrContext}`
      );

    return {
      success: false,
      output: finalOutput || output.toString(),
      error: `${errorMessage} [${diagnosis}]`,
      usage: buildUsage(),
      sessionId,
    };
  }
}

// ── managed settings ────────────────────────────────────────────────────────────

const MANAGED_SETTINGS_DIR = "/etc/claude-code";
const MANAGED_SETTINGS_PATH = `${MANAGED_SETTINGS_DIR}/managed-settings.json`;

// managed-settings.json has absolute highest precedence in Claude Code's config hierarchy.
// it cannot be overridden by user, project, or local settings — safe against malicious PRs.
//
// permissions.deny blocks native tools (Read, Grep, Edit, Glob) from accessing /proc and /sys,
// the git surfaces (blanket Edit(.git/**) write deny + narrow .git/config read deny — see
// nativeFsDenies.ts), and any path passed in via ctx.secretDenyPaths (codex auth dir, vertex
// creds dir, etc.).
// sandbox.filesystem.denyRead blocks the Bash tool sandbox from reading those paths.
// allowManagedPermissionRulesOnly prevents malicious PRs from adding allow rules that override
// our deny rules — safe in CI because --dangerously-skip-permissions makes allow/ask irrelevant.
// allowManagedHooksOnly prevents malicious project hooks from bypassing deny rules.
// Per Claude Code permissions docs, Read(...) deny ALSO blocks file-reading Bash commands
// (cat, head, tail, sed) and survives bypassPermissions mode. See wiki/security.md and
// wiki/codex-auth.md.

/**
 * env var carrying the gate-server URL to the Claude subprocess. the Stop
 * hook curls it on every stop; an absent value disables the hook (e.g.
 * non-CI local dev paths that don't install managed settings either).
 */
const STOP_HOOK_GATE_URL_ENV = "PULLFROG_GATE_URL";

/**
 * managed Stop hook. swaps the old `--resume <sessionId>` follow-up
 * subprocesses (reflection + every gate retry — cost audit on PR #792
 * showed reflection alone burned ~$0.85 / 111K cache_write per Opus run,
 * almost all of it wasted re-running `getAttachmentMessages` in the fresh
 * process) for a `{decision: "block", reason: ...}` injection inside the
 * live `queryLoop`. existing session context is already in the prompt
 * cache so only the new reason text is fresh cache_write.
 *
 * the script is intentionally minimal — all decision logic lives in the
 * sidecar gate server (`gateServer.ts`), which reads live `ctx.toolState`
 * mutations from the same process the MCP server runs in. budget +
 * one-shot tracking lives there too, so re-fires across multiple stops in
 * one session are safe. claude-code's 8-consecutive-block override is the
 * last-line backstop.
 */
function buildStopHookScript(): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `url="\${${STOP_HOOK_GATE_URL_ENV}:-}"`,
    'if [ -z "$url" ]; then exit 0; fi',
    "cat >/dev/null",
    'response=$(curl -fsS --max-time 30 "$url" 2>/dev/null || printf \'{"block":false}\')',
    'block=$(printf "%s" "$response" | jq -r ".block // false")',
    'if [ "$block" != "true" ]; then exit 0; fi',
    'reason=$(printf "%s" "$response" | jq -r ".reason // \\"\\"")',
    'if [ -z "$reason" ]; then exit 0; fi',
    'jq -n --arg reason "$reason" \'{decision: "block", reason: $reason}\'',
    "",
  ].join("\n");
}

interface ManagedSettingsParams {
  ctx: AgentRunContext;
  stopHookPath: string | null;
  pretoolGateScriptPath: string;
}

function buildManagedSettings(params: ManagedSettingsParams): Record<string, unknown> {
  const secretDenyPaths = params.ctx.secretDenyPaths ?? [];
  const toolDeny = secretDenyPaths.flatMap((path) => [
    `Read(${path}/**)`,
    `Read(/${path}/**)`,
    `Grep(${path}/**)`,
    `Grep(/${path}/**)`,
    `Edit(${path}/**)`,
    `Edit(/${path}/**)`,
    `Glob(${path}/**)`,
    `Glob(/${path}/**)`,
  ]);
  // single builder for both the PreToolUse gate hook and the native exec-tool
  // deny — both fields are consumed here (and identically in the flag-settings
  // path via writePretoolGateAssets), keeping CLAUDE_EXEC_TOOL_DENY_RULES the
  // single source.
  const gate = buildClaudePretoolGateSettings(
    params.pretoolGateScriptPath,
    CLAUDE_EXEC_TOOL_DENY_RULES
  );
  const base: Record<string, unknown> = {
    allowManagedPermissionRulesOnly: true,
    allowManagedHooksOnly: true,
    permissions: {
      deny: [
        // native exec tools — the authoritative, bypass-immune deny.
        // `--disallowedTools` (a cliArg-source deny) leaked under
        // `--dangerously-skip-permissions`; policySettings denies survive
        // bypassPermissions mode. covers top-level + Agent(...) subagent use.
        ...gate.permissions.deny,
        "Read(//proc/**)",
        "Read(//sys/**)",
        "Grep(//proc/**)",
        "Grep(//sys/**)",
        "Edit(//proc/**)",
        "Edit(//sys/**)",
        "Glob(//proc/**)",
        "Glob(//sys/**)",
        // git surfaces — blanket Edit(.git/**) write deny (nothing legit
        // writes .git via native tools; real commits go through MCP git tools
        // outside this gate) + narrow Read/Grep/Glob(.git/config) read deny.
        // mirrors opencode's edit-blanket / read-narrow split. canonical:
        // action/agents/nativeFsDenies.ts.
        ...GIT_NATIVE_WRITE_DENY_CLAUDE,
        ...GIT_NATIVE_READ_DENY_CLAUDE,
        ...toolDeny,
      ],
    },
    sandbox: {
      filesystem: {
        denyRead: ["/proc", "/sys", ...secretDenyPaths],
      },
    },
  };
  // PreToolUse gate replicated into managed settings so it survives the
  // `allowManagedHooksOnly: true` policy gate (see
  // src/utils/hooks/hooksConfigSnapshot.ts in claude-code source). the Stop
  // hook (gate-server retries) is layered into the same `hooks` object when
  // present so both fire under managed settings.
  const hooks: Record<string, unknown> = {
    ...gate.hooks,
  };
  if (params.stopHookPath) {
    hooks.Stop = [
      {
        hooks: [{ type: "command", command: params.stopHookPath }],
      },
    ];
  }
  base.hooks = hooks;
  return base;
}

function installManagedSettings(params: ManagedSettingsParams): void {
  if (process.env.CI !== "true") return;

  const content = JSON.stringify(buildManagedSettings(params), null, 2);
  try {
    execFileSync("sudo", ["mkdir", "-p", MANAGED_SETTINGS_DIR]);
    execFileSync("sudo", ["tee", MANAGED_SETTINGS_PATH], {
      input: content,
      stdio: ["pipe", "ignore", "pipe"],
    });
    log.debug(`» wrote managed settings to ${MANAGED_SETTINGS_PATH}`);
  } catch (err) {
    log.warning(`» failed to install managed settings: ${err}`);
  }
}

// ── agent ───────────────────────────────────────────────────────────────────────

export const claude = agent({
  name: "claude",
  install: installClaudeCli,
  run: async (ctx) => {
    const cliPath = await installClaudeCli();

    const specifier = ctx.payload.proxyModel ?? ctx.resolvedModel;
    // claude-code on Bedrock takes the bare AWS model ID — no provider prefix
    // to strip, since the ID is already in `provider.model` form (e.g.
    // `us.anthropic.claude-opus-4-7`). detect via the env-var sentinel: if
    // BEDROCK_MODEL_ID is set and matches the resolved specifier, this is a
    // bedrock route. see `wiki/model-resolution.md` for the routing pattern.
    const bedrockModelId = process.env[BEDROCK_MODEL_ID_ENV]?.trim();
    const isBedrockRoute =
      specifier !== undefined &&
      bedrockModelId !== undefined &&
      bedrockModelId === specifier &&
      isBedrockAnthropicId(specifier);
    const vertexModelId = process.env[VERTEX_MODEL_ID_ENV]?.trim();
    const isVertexRoute =
      specifier !== undefined &&
      vertexModelId !== undefined &&
      vertexModelId === specifier &&
      isVertexAnthropicId(specifier);
    const model = !specifier
      ? undefined
      : isBedrockRoute
        ? specifier
        : isVertexRoute
          ? undefined
          : stripProviderPrefix(specifier);

    const homeEnv = {
      HOME: ctx.tmpdir,
      XDG_CONFIG_HOME: join(ctx.tmpdir, ".config"),
    };

    mkdirSync(join(homeEnv.XDG_CONFIG_HOME, "claude"), { recursive: true });

    const agentBrowserVersion = getDevDependencyVersion("agent-browser");
    addSkill({
      ref: `vercel-labs/agent-browser@v${agentBrowserVersion}`,
      skill: "agent-browser",
      env: homeEnv,
      agent: "claude-code",
    });

    installBundledSkills({ home: homeEnv.HOME });

    const mcpConfigPath = writeMcpConfig(ctx);
    const effort = resolveEffort(model);

    // PreToolUse gate that hard-blocks state-mutating MCP tool calls from
    // subagents (the `agent_id` field is non-empty in the hook input only
    // for subagent-originated calls — verified against
    // yasasbanukaofficial/claude-code src/utils/hooks.ts createBaseHookInput).
    // Wired via two surfaces so it fires in both CI and local (see
    // writePretoolGateAssets / buildManagedSettings comments).
    const pretoolGate = writePretoolGateAssets(ctx);

    // reflection + every gate retry (dirty tree, unsubmitted review, summary
    // stale) move from post-exit `--resume <sessionId>` subprocesses to a
    // managed Stop hook that curls a sidecar gate server. see
    // `buildStopHookScript` for the cost rationale (PR #792 audit) and
    // `gateServer.ts` for the decision policy.
    const stopHookPath = join(ctx.tmpdir, "pullfrog-stop-hook.sh");
    writeFileSync(stopHookPath, buildStopHookScript(), { mode: 0o755 });

    installManagedSettings({ ctx, stopHookPath, pretoolGateScriptPath: pretoolGate.scriptPath });

    // base args shared between initial run and continue runs
    const baseArgs = [
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
      "--mcp-config",
      mcpConfigPath,
      "--settings",
      pretoolGate.settingsPath,
      "--verbose",
      "--effort",
      effort,
      "--disallowedTools",
      CLAUDE_DISALLOWED_TOOLS,
      "--agents",
      buildAgentsJson(),
    ];

    if (model) {
      baseArgs.push("--model", model);
    }

    // agent process gets full env — needs LLM API keys, PATH, locale, etc.
    // security is enforced via managed-settings.json, --disallowedTools (native exec tools), and MCP tool filtering.
    //
    // bedrock route: claude-code reads `CLAUDE_CODE_USE_BEDROCK=1` to switch
    // its provider implementation from the direct Anthropic API to Bedrock.
    // AWS_BEARER_TOKEN_BEDROCK / AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY +
    // AWS_REGION are already in process.env from the workflow's `env:` block.
    // see https://docs.claude.com/en/docs/claude-code/amazon-bedrock.
    //
    // we only force CLAUDE_CODE_USE_BEDROCK=1 when this is a Pullfrog-routed
    // bedrock run; if the user has set the env var manually for some other
    // reason (e.g. always-Bedrock org policy), `...process.env` already
    // carries it through and we don't disturb it.
    const repoDir = process.cwd();

    // PWD must match the spawn cwd (see opencode_v2.ts for the analogous fix).
    // claude-code 2.1.x reads `process.env.PWD` and registers it as a "session"
    // additional-working-directory when it differs from `process.cwd()` (per
    // the bundled cli.js — `let H=process.env.PWD; if(H && H !== Y7() && ...)
    // j.set(H, {path: H, source: "session"})`). Inheriting harness PWD via
    // `...process.env` ends up adding the wrong dir to the agent's allowed
    // working set under `pnpm runtest` / `pnpm play`, which silently confuses
    // path-relative tools.
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...homeEnv,
      PWD: repoDir,
    };
    if (isBedrockRoute) {
      env.CLAUDE_CODE_USE_BEDROCK = "1";
    }
    if (isVertexRoute) {
      applyClaudeVertexEnv(env);
      env.ANTHROPIC_MODEL = specifier;
    }

    // claude-code's `Vw()` resolver prefers ANTHROPIC_API_KEY over the OAuth
    // token when both are set, so we strip the API key to fall through to the
    // Max-subscription path. bedrock route uses AWS creds and is excluded.
    // the strip is gated on a 1-token preflight: an exhausted (session/weekly
    // limit) or revoked subscription would otherwise kill the run at its first
    // model call with a working API key sitting unused in env.
    if (env.CLAUDE_CODE_OAUTH_TOKEN && !isBedrockRoute && env.ANTHROPIC_API_KEY) {
      const preflight = await preflightClaudeSubscription({
        token: env.CLAUDE_CODE_OAUTH_TOKEN,
        model,
      });
      if (preflight.usable) {
        log.debug(
          "» CLAUDE_CODE_OAUTH_TOKEN present — stripping ANTHROPIC_API_KEY from Claude Code env so the OAuth subscription is used"
        );
        delete env.ANTHROPIC_API_KEY;
      } else {
        log.info(
          `» Claude subscription unusable (${preflight.reason}) — falling back to ANTHROPIC_API_KEY`
        );
        delete env.CLAUDE_CODE_OAUTH_TOKEN;
      }
    }

    log.info(`» effort: ${effort}`);
    log.debug(`» starting Pullfrog (Claude Code): ${cliPath} ${baseArgs.join(" ")}`);
    log.debug(`» working directory: ${repoDir}`);

    // gate server lives only as long as the claude subprocess does. the
    // Stop hook curls `gateServer.url` and turns the response into its
    // `{decision: "block", reason}` payload (or exits 0 to allow stop).
    await using gateServer = await startGateServer(ctx);

    const result = await runClaude({
      label: "Pullfrog",
      cmd: cliPath,
      cwd: repoDir,
      env: { ...env, [STOP_HOOK_GATE_URL_ENV]: gateServer.url },
      todoTracker: ctx.todoTracker,
      onActivityTimeout: ctx.onActivityTimeout,
      onToolUse: ctx.onToolUse,
      args: [...baseArgs, "-p", ctx.instructions.full],
    });

    // every follow-up turn (reflection + gate retries) has already happened
    // inside this single subprocess via the Stop hook, so usage aggregation
    // and resume orchestration are no-ops. all that remains is the terminal
    // hard-fail render: when the budget exhausted with `stopHook` /
    // `unsubmittedReview` still failing, flip `success` to false with the
    // same error shape `runPostRunRetryLoop` produced pre-migration.
    return finalizeAgentResult({ ctx, result });
  },
});
