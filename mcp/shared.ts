import type { StandardSchemaV1 } from "@standard-schema/spec";
import { encode as toonEncode } from "@toon-format/toon";
import type { FastMCP, Tool } from "fastmcp";
import { formatJsonValue, log } from "../utils/cli.ts";
import { markActivity } from "../utils/activity.ts";
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

export const handleToolError = (error: unknown): ToolResult => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  return {
    content: [
      {
        type: "text",
        text: `Error: ${errorMessage}`,
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
    // every MCP tool call is agent activity. the dsh harness has no event
    // stream to watch (headless emits nothing until exit), so its activity
    // clock is fed from here + its session-JSONL watcher.
    markActivity();
    try {
      const result = await fn(params);
      return handleToolSuccess(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const prefix = toolName ? `[${toolName}]` : "tool";
      log.info(`${prefix} error: ${errorMessage}`);
      log.debug(`${prefix} params: ${formatJsonValue(params)}`);
      return handleToolError(error);
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
