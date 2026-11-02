import type { StandardSchemaV1 } from "@standard-schema/spec";
import { encode as toonEncode } from "@toon-format/toon";
import type { FastMCP, Tool } from "fastmcp";
import { formatJsonValue, log } from "../utils/cli.ts";
import { MAX_ERROR_DETAIL_CHARS } from "../utils/shell.ts";
import { isGeminiRouted, sanitizeToolForGemini } from "./geminiSanitizer.ts";
import type { ToolContext } from "./server.ts";

/** extract the HTTP status from an unknown thrown value (octokit RequestError etc.), or undefined. */
export function getHttpStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null || !("status" in err)) return undefined;
  return typeof err.status === "number" ? err.status : undefined;
}

/**
 * a Pullfrog MCP tool definition. `mutates` marks a named state-changing tool
 * that must be reserved for the orchestrator and denied to subagents — it is
 * the single source of truth the subagent deny list derives from (see
 * action/agents/subagentToolGates.ts). general-purpose execution tools (`git`,
 * `shell`) are deliberately left unmarked: they can mutate but are allowed for
 * subagents and gated by command-arg validation instead. `readOnlyHint` is
 * independent scheduler metadata and must only follow an implementation audit;
 * the absence of `mutates` does not imply that a tool is read-only.
 */
export type PullfrogTool = Tool<any, any> & { mutates?: boolean };

export const tool = <const params>(
  toolDef: Tool<any, StandardSchemaV1<params>> & { mutates?: boolean }
): Tool<any, StandardSchemaV1<params>> & { mutates?: boolean } => toolDef;

export interface ToolResult {
  content: {
    type: "text";
    text: string;
  }[];
  isError?: boolean;
}

export const handleToolSuccess = (data: Record<string, any> | string): ToolResult => {
  const text = typeof data === "string" ? data : toonEncode(data);
  return {
    content: [{ type: "text", text }],
  };
};

/**
 * the one error text the log and the model both see. octokit's message for a non-JSON
 * response is the raw body, so a GitHub 5xx arrives as a 55 KB HTML page (#1582) or as
 * nothing at all (#1487); either way the status is the only useful fact.
 */
function formatToolError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const status = getHttpStatus(error);
  if (status !== undefined && (message.trim() === "" || message.trimStart().startsWith("<"))) {
    const transient = status >= 500 ? "; this is GitHub-side, retry shortly" : "";
    return `GitHub returned HTTP ${status} with no usable message${transient}`;
  }
  if (message.length <= MAX_ERROR_DETAIL_CHARS) return message;
  return `${message.slice(0, MAX_ERROR_DETAIL_CHARS)}…[truncated]`;
}

export const handleToolError = (message: string): ToolResult => {
  return {
    content: [
      {
        type: "text",
        text: `Error: ${message}`,
      },
    ],
    isError: true,
  };
};

/**
 * Helper to wrap a tool execute function with error handling.
 * Captures ctx in closure so tools don't need to handle try/catch.
 * @param fn - the function to execute
 * @param toolName - optional tool name for error logging
 */
export const execute = <T, R extends Record<string, any> | string>(
  fn: (params: T) => Promise<R>,
  toolName?: string
) => {
  const _fn = async (params: T): Promise<ToolResult> => {
    try {
      const result = await fn(params);
      return handleToolSuccess(result);
    } catch (error) {
      const message = formatToolError(error);
      const prefix = toolName ? `[${toolName}]` : "tool";
      log.info(`${prefix} error: ${message}`);
      log.debug(`${prefix} params: ${formatJsonValue(params)}`);
      return handleToolError(message);
    }
  };
  return _fn;
};

export const addTools = (ctx: ToolContext, server: FastMCP<any>, tools: Tool<any, any>[]) => {
  const shouldSanitize = isGeminiRouted(ctx);
  for (const tool of tools) {
    server.addTool(shouldSanitize ? sanitizeToolForGemini(tool) : tool);
  }
  return server;
};
