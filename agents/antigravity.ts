/**
 * Antigravity agent — harness around Google's `agy` CLI (subscription OAuth).
 *
 * Auth: `ANTIGRAVITY_TOKEN` is materialized into
 *   $HOME/.gemini/antigravity-cli/antigravity-oauth-token
 * under an isolated tmpdir HOME (never the workspace).
 *
 * Headless invocation mirrors Claude Code:
 *   agy -p "<prompt>" --dangerously-skip-permissions
 *
 * MCP: Pullfrog HTTP server is dual-written into the documented global MCP
 * config locations under the isolated home so agy discovers it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { pullfrogMcpName } from "../external.ts";
import { AGENT_ACTIVITY_TIMEOUT_MS, markActivity } from "../utils/activity.ts";
import { installAntigravityAuth } from "../utils/antigravityAuth.ts";
import { formatJsonValue, log } from "../utils/cli.ts";
import { installFromCurl } from "../utils/install.ts";
import { findProviderErrorMatch } from "../utils/providerErrors.ts";
import { installBundledSkills } from "../utils/skills.ts";
import {
  DEFAULT_MAX_RETAINED_BYTES,
  SPAWN_ACTIVITY_TIMEOUT_CODE,
  SpawnTimeoutError,
  spawn,
  TailBuffer,
} from "../utils/subprocess.ts";
import { finalizeAgentResult } from "./postRun.ts";
import {
  type AgentResult,
  type AgentRunContext,
  type AgentUsage,
  agent,
  MAX_STDERR_LINES,
} from "./shared.ts";

const ANTIGRAVITY_INSTALL_URL = "https://antigravity.google/cli/install.sh";

async function installAntigravityCli(): Promise<string> {
  return await installFromCurl({
    installUrl: ANTIGRAVITY_INSTALL_URL,
    executableName: "agy",
    executableRelPaths: [join(".local", "bin", "agy"), join("bin", "agy")],
  });
}

/**
 * Dual-write MCP config for agy. Public docs list both:
 *   ~/.gemini/config/mcp_config.json
 *   ~/.gemini/antigravity/mcp_config.json
 * plus plugin-local mcp_config.json. Writing both global candidates is cheap
 * and avoids silent "MCP never loaded" failures when the CLI picks one path.
 */
function writeMcpConfigs(ctx: AgentRunContext, home: string): void {
  const mcpServers = {
    [pullfrogMcpName]: {
      // remote HTTP MCP (same shape Claude-style configs use)
      type: "http",
      url: ctx.mcpServerUrl,
      serverUrl: ctx.mcpServerUrl,
    },
  };
  const body = JSON.stringify({ mcpServers }, null, 2);

  const paths = [
    join(home, ".gemini", "config", "mcp_config.json"),
    join(home, ".gemini", "antigravity", "mcp_config.json"),
    join(home, ".gemini", "antigravity-cli", "mcp_config.json"),
  ];
  for (const p of paths) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  log.debug(`» wrote Antigravity MCP configs under ${join(home, ".gemini")}`);
}

// strip provider prefix for -m if agy accepts bare model names
function stripProviderPrefix(specifier: string): string {
  const slashIndex = specifier.indexOf("/");
  return slashIndex > 0 ? specifier.slice(slashIndex + 1) : specifier;
}

type RunParams = {
  label: string;
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  onActivityTimeout?: (() => void) | undefined;
  onToolUse?: ((event: { toolName: string; input: unknown }) => void) | undefined;
};

async function runAntigravity(params: RunParams): Promise<AgentResult> {
  const startTime = performance.now();
  let finalOutput = "";
  const recentStderr: string[] = [];
  let lastProviderError: string | null = null;
  const output = new TailBuffer(DEFAULT_MAX_RETAINED_BYTES);
  let lineBuf = "";

  function handleJsonLine(trimmed: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // plain text line — treat as assistant narration when non-empty
      if (trimmed) {
        log.info(trimmed);
        finalOutput = trimmed;
        markActivity();
      }
      return;
    }

    markActivity();
    log.debug(JSON.stringify(event, null, 2));

    // best-effort streaming schema: text / message / result / tool_use fields
    const type = typeof event.type === "string" ? event.type : undefined;
    if (type === "assistant" || type === "message" || type === "text") {
      const text =
        (typeof event.text === "string" && event.text) ||
        (typeof event.content === "string" && event.content) ||
        (typeof event.message === "string" && event.message) ||
        undefined;
      if (text?.trim()) {
        finalOutput = text.trim();
        log.box(finalOutput, { title: params.label });
      }
    }

    if (type === "result" || type === "final") {
      const text =
        (typeof event.result === "string" && event.result) ||
        (typeof event.text === "string" && event.text) ||
        (typeof event.output === "string" && event.output) ||
        undefined;
      if (text?.trim()) finalOutput = text.trim();
    }

    // tool_use shaped events
    const toolName =
      (typeof event.toolName === "string" && event.toolName) ||
      (typeof event.name === "string" && type === "tool_use" ? event.name : undefined) ||
      (typeof event.tool === "string" && event.tool) ||
      undefined;
    if (toolName) {
      const input = event.input ?? event.arguments ?? event.args ?? {};
      params.onToolUse?.({ toolName, input });
      const inputFormatted = formatJsonValue(input || {});
      log.info(
        inputFormatted !== "{}" ? `» ${toolName}(${inputFormatted})` : `» ${toolName}()`
      );
    }
  }

  try {
    const result = await spawn({
      cmd: params.cmd,
      args: params.args,
      cwd: params.cwd,
      env: params.env,
      activityTimeout: AGENT_ACTIVITY_TIMEOUT_MS,
      retain: "none",
      killGroup: true,
      onActivityTimeout: params.onActivityTimeout,
      onStdout: (chunk) => {
        output.append(chunk);
        lineBuf += chunk;
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          handleJsonLine(trimmed);
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

    // flush trailing partial line
    if (lineBuf.trim()) handleJsonLine(lineBuf.trim());

    const duration = performance.now() - startTime;
    log.info(
      `» ${params.label} completed in ${Math.round(duration)}ms with exit code ${result.exitCode}`
    );

    const usage: AgentUsage | undefined = undefined;
    const stdoutSnapshot = output.toString();

    if (result.exitCode !== 0) {
      const errorMessage =
        recentStderr.join("\n") ||
        lastProviderError ||
        stdoutSnapshot.slice(-2048) ||
        `agy exited with code ${result.exitCode}`;
      log.error(`${params.label} exited with code ${result.exitCode}: ${errorMessage}`);
      return {
        success: false,
        output: finalOutput || stdoutSnapshot,
        error: errorMessage,
        usage,
      };
    }

    return {
      success: true,
      output: finalOutput || stdoutSnapshot,
      usage,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isActivityTimeout =
      error instanceof SpawnTimeoutError && error.code === SPAWN_ACTIVITY_TIMEOUT_CODE;
    log.info(
      `» ${params.label} ${isActivityTimeout ? "hung" : "failed"}: ${errorMessage}`
    );
    return {
      success: false,
      output: finalOutput || output.toString(),
      error: errorMessage,
    };
  }
}

export const antigravity = agent({
  name: "antigravity",
  install: installAntigravityCli,
  run: async (ctx: AgentRunContext) => {
    const cliPath = await installAntigravityCli();

    const homeEnv = {
      HOME: ctx.tmpdir,
      XDG_CONFIG_HOME: join(ctx.tmpdir, ".config"),
    };

    const auth = installAntigravityAuth(homeEnv.HOME);
    if (!auth) {
      return {
        success: false,
        error:
          "ANTIGRAVITY_TOKEN is required for the Antigravity harness but was not set or was empty",
      };
    }

    installBundledSkills({ home: homeEnv.HOME });
    writeMcpConfigs(ctx, homeEnv.HOME);

    const specifier = ctx.payload.proxyModel ?? ctx.resolvedModel;
    const model = specifier ? stripProviderPrefix(specifier) : undefined;

    const repoDir = process.cwd();
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...homeEnv,
      PWD: repoDir,
      // belt-and-suspenders: some builds also honor the env var directly
      ANTIGRAVITY_TOKEN: process.env.ANTIGRAVITY_TOKEN,
    };

    const args = ["-p", ctx.instructions.full, "--dangerously-skip-permissions"];
    if (model) {
      // agy may accept -m / --model; ignored harmlessly if unsupported
      args.push("-m", model);
    }

    log.debug(`» starting Pullfrog (Antigravity): ${cliPath} ${args.slice(0, 3).join(" ")}...`);
    log.debug(`» working directory: ${repoDir}`);

    const result = await runAntigravity({
      label: "Pullfrog",
      cmd: cliPath,
      args,
      cwd: repoDir,
      env,
      onActivityTimeout: ctx.onActivityTimeout,
      onToolUse: ctx.onToolUse,
    });

    return finalizeAgentResult({ ctx, result });
  },
});
