/**
 * Grok Build agent — harness around xAI's `grok` CLI (subscription OAuth).
 *
 * Auth: `GROK_AUTH_JSON` (base64 of ~/.grok/auth.json, or raw JSON) is
 * materialized into `$HOME/.grok/auth.json` under an isolated tmpdir HOME
 * (never the workspace).
 *
 * Headless invocation (official docs):
 *   grok -p "<prompt>" --always-approve --output-format streaming-json --no-auto-update
 *
 * MCP: Claude-compatible `.mcp.json` + `~/.grok` settings so Grok discovers
 * the Pullfrog HTTP MCP server.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pullfrogMcpName } from "../external.ts";
import { AGENT_ACTIVITY_TIMEOUT_MS, markActivity } from "../utils/activity.ts";
import { formatJsonValue, log } from "../utils/cli.ts";
import { installGrokAuth } from "../utils/grokAuth.ts";
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

const GROK_INSTALL_URL = "https://x.ai/cli/install.sh";

async function installGrokCli(): Promise<string> {
  return await installFromCurl({
    installUrl: GROK_INSTALL_URL,
    executableName: "grok",
    // install scripts have used both ~/.local/bin and ~/.grok/bin
    executableRelPaths: [
      join(".local", "bin", "grok"),
      join(".grok", "bin", "grok"),
      join("bin", "grok"),
    ],
  });
}

/**
 * Write MCP config for Grok Build. Docs say Grok reads Claude-style
 * `.mcp.json` and can also take servers from `~/.grok` settings.
 */
function writeMcpConfigs(ctx: AgentRunContext, home: string, repoDir: string): void {
  const mcpServers = {
    [pullfrogMcpName]: {
      type: "http",
      url: ctx.mcpServerUrl,
      transport: { type: "http", url: ctx.mcpServerUrl },
    },
  };
  const claudeStyle = JSON.stringify({ mcpServers }, null, 2);

  // project-local Claude-compatible discovery
  writeFileSync(join(home, ".mcp.json"), claudeStyle);
  // also under the redirected home's copy of the project is not needed —
  // write into the real repo as a tmp-only file is risky. Prefer home-level.
  mkdirSync(join(home, ".grok"), { recursive: true });
  writeFileSync(join(home, ".grok", "mcp.json"), claudeStyle);

  // settings.json array form used by some Grok docs
  const settingsBody = JSON.stringify(
    {
      mcpServers: [
        {
          name: pullfrogMcpName,
          transport: { type: "http", url: ctx.mcpServerUrl },
        },
      ],
    },
    null,
    2
  );
  writeFileSync(join(home, ".grok", "settings.json"), settingsBody);

  // workspace-level Claude-style file (cwd-relative discovery). write into
  // the isolated home only if the CLI resolves cwd against HOME — also drop a
  // file next to the repo under a non-committed path is not allowed. Rely on
  // HOME + explicit --cwd.
  void repoDir;
  log.debug(`» wrote Grok Build MCP configs under ${join(home, ".grok")}`);
}

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

async function runGrok(params: RunParams): Promise<AgentResult> {
  const startTime = performance.now();
  let finalOutput = "";
  const recentStderr: string[] = [];
  let lastProviderError: string | null = null;
  const output = new TailBuffer(DEFAULT_MAX_RETAINED_BYTES);
  let lineBuf = "";
  let inputTokens = 0;
  let outputTokens = 0;

  function handleJsonLine(trimmed: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      if (trimmed) {
        log.info(trimmed);
        finalOutput = trimmed;
        markActivity();
      }
      return;
    }

    markActivity();
    log.debug(JSON.stringify(event, null, 2));

    const type = typeof event.type === "string" ? event.type : undefined;
    const sessionUpdate =
      typeof event.sessionUpdate === "string"
        ? event.sessionUpdate
        : typeof (event.update as { sessionUpdate?: unknown } | undefined)?.sessionUpdate ===
            "string"
          ? (event.update as { sessionUpdate: string }).sessionUpdate
          : undefined;

    // streaming-json assistant text chunks
    if (
      type === "assistant" ||
      type === "message" ||
      type === "text" ||
      type === "agent_message" ||
      sessionUpdate === "agent_message_chunk"
    ) {
      const content = event.content as { text?: string } | string | undefined;
      const text =
        (typeof event.text === "string" && event.text) ||
        (typeof content === "string" && content) ||
        (typeof content === "object" && content && typeof content.text === "string"
          ? content.text
          : undefined) ||
        (typeof event.message === "string" && event.message) ||
        undefined;
      if (text?.trim()) {
        // chunks may stream incrementally — append for chunks, replace for full messages
        if (sessionUpdate === "agent_message_chunk") {
          finalOutput = (finalOutput + text).trim();
        } else {
          finalOutput = text.trim();
          log.box(finalOutput, { title: params.label });
        }
      }
    }

    if (type === "result" || type === "final" || type === "complete") {
      const text =
        (typeof event.result === "string" && event.result) ||
        (typeof event.text === "string" && event.text) ||
        (typeof event.output === "string" && event.output) ||
        (typeof event.summary === "string" && event.summary) ||
        undefined;
      if (text?.trim()) {
        finalOutput = text.trim();
        log.box(finalOutput, { title: params.label });
      }
      const usage = event.usage as
        | { input_tokens?: number; output_tokens?: number; inputTokens?: number; outputTokens?: number }
        | undefined;
      if (usage) {
        inputTokens += usage.input_tokens ?? usage.inputTokens ?? 0;
        outputTokens += usage.output_tokens ?? usage.outputTokens ?? 0;
      }
    }

    const toolName =
      (typeof event.toolName === "string" && event.toolName) ||
      (typeof event.name === "string" && (type === "tool_use" || type === "tool_call")
        ? event.name
        : undefined) ||
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

    if (lineBuf.trim()) handleJsonLine(lineBuf.trim());

    const duration = performance.now() - startTime;
    log.info(
      `» ${params.label} completed in ${Math.round(duration)}ms with exit code ${result.exitCode}`
    );

    const usage: AgentUsage | undefined =
      inputTokens > 0 || outputTokens > 0
        ? { agent: "grok", inputTokens, outputTokens }
        : undefined;
    const stdoutSnapshot = output.toString();

    if (result.exitCode !== 0) {
      const errorMessage =
        recentStderr.join("\n") ||
        lastProviderError ||
        stdoutSnapshot.slice(-2048) ||
        `grok exited with code ${result.exitCode}`;
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
      usage:
        inputTokens > 0 || outputTokens > 0
          ? { agent: "grok", inputTokens, outputTokens }
          : undefined,
    };
  }
}

export const grok = agent({
  name: "grok",
  install: installGrokCli,
  run: async (ctx: AgentRunContext) => {
    const cliPath = await installGrokCli();

    const homeEnv = {
      HOME: ctx.tmpdir,
      XDG_CONFIG_HOME: join(ctx.tmpdir, ".config"),
    };

    const auth = installGrokAuth(homeEnv.HOME);
    if (!auth) {
      return {
        success: false,
        error:
          "GROK_AUTH_JSON is required for the Grok Build harness but was not set, empty, or malformed",
      };
    }

    installBundledSkills({ home: homeEnv.HOME });

    const repoDir = process.cwd();
    writeMcpConfigs(ctx, homeEnv.HOME, repoDir);

    const specifier = ctx.payload.proxyModel ?? ctx.resolvedModel;
    const model = specifier ? stripProviderPrefix(specifier) : undefined;

    const env: Record<string, string | undefined> = {
      ...process.env,
      ...homeEnv,
      PWD: repoDir,
    };
    // prefer OAuth session over API key when both are present
    if (env.XAI_API_KEY) {
      log.debug("» GROK_AUTH_JSON present — stripping XAI_API_KEY so OAuth session is used");
      delete env.XAI_API_KEY;
    }

    const args = [
      "--no-auto-update",
      "-p",
      ctx.instructions.full,
      "--always-approve",
      "--output-format",
      "streaming-json",
      "--cwd",
      repoDir,
    ];
    if (model) {
      args.push("-m", model);
    }

    log.debug(`» starting Pullfrog (Grok Build): ${cliPath} ${args.slice(0, 4).join(" ")}...`);
    log.debug(`» working directory: ${repoDir}`);

    const result = await runGrok({
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
