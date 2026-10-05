// this must be imported first
import "./arkConfig.ts";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { FastMCP, type Tool } from "fastmcp";
import { type AgentId, hasSimilarIssues, pullfrogMcpName, type XrepoConfig } from "../external.ts";
import type { Mode } from "../modes.ts";
import type { ToolState } from "../toolState.ts";
import { closeBrowserDaemon } from "../utils/browser.ts";
import type { OctokitWithPlugins } from "../utils/github.ts";
import type { ResolvedPayload } from "../utils/payload.ts";
import type { AccountPlan } from "../utils/runContext.ts";
import type { RunContextData } from "../utils/runContextData.ts";
import { CheckoutPrTool } from "./checkout.ts";
import { GetCheckSuiteLogsTool } from "./checkSuite.ts";
import {
  CreateCommentTool,
  EditCommentTool,
  ReplyToReviewCommentTool,
  ReportProgressTool,
} from "./comment.ts";
import { CommitInfoTool } from "./commitInfo.ts";
import { CloseCurrentTool, ReopenCurrentTool } from "./currentObject.ts";
import {
  AwaitDependencyInstallationTool,
  StartDependencyInstallationTool,
} from "./dependencies.ts";
import { GhTool } from "./gh.ts";
import {
  CommitChangesTool,
  DeleteBranchTool,
  GitFetchTool,
  GitTool,
  PushBranchTool,
  PushTagsTool,
} from "./git.ts";
import { IssueTool } from "./issue.ts";
import { GetIssueCommentsTool } from "./issueComments.ts";
import { GetIssueEventsTool } from "./issueEvents.ts";
import { IssueInfoTool } from "./issueInfo.ts";
import { AddLabelsTool, RemoveLabelsTool } from "./labels.ts";
import { SetOutputTool } from "./output.ts";
import { CreatePullRequestTool, UpdatePullRequestBodyTool } from "./pr.ts";
import { PullRequestInfoTool } from "./prInfo.ts";
import { CreatePullRequestReviewTool } from "./review.ts";
import {
  GetReviewCommentsTool,
  ListPullRequestReviewsTool,
  ResolveReviewThreadTool,
} from "./reviewComments.ts";
import { SearchIssuesTool } from "./searchIssues.ts";
import { SelectModeTool } from "./selectMode.ts";
import { addTools, type PullfrogTool } from "./shared.ts";
import { KillBackgroundTool, ShellTool } from "./shell.ts";
import { SimilarIssuesTool } from "./similarIssues.ts";
import { UploadFileTool } from "./upload.ts";
import { CheckoutRepoTool, ListReposTool } from "./xrepo.ts";

export interface ToolContext {
  agentId: AgentId;
  repo: RunContextData["repo"];
  payload: ResolvedPayload;
  octokit: OctokitWithPlugins;
  githubInstallationToken: string;
  gitToken: string;
  // re-mint the git-scoped token matching the passed value, for push retries
  // when GitHub hands out a git token its push edge never accepts. undefined on
  // the external-GH_TOKEN path. see pushWithRetry + resolveTokens.
  refreshGitToken: ((stale: string) => Promise<string>) | undefined;
  // contents:read token over the cross-repo READ set (read-tier secondary
  // clones). undefined on single-repo runs. see resolveRepoCtx.
  readToken: string | undefined;
  // credential for the `gh` tool, scoped to mirror the triggering user's own
  // repo role. undefined below the mirror threshold, which is what withholds
  // the tool. unlike the MCP token this one IS reachable by the agent — `gh`
  // can print it — so its scope is the whole boundary. see roleMirror.ts.
  ghToken: string | undefined;
  // cross-repo access sets, resolved server-side. undefined ⇒ single-repo run.
  // checkout_repo / list_repos gate on this; resolveRepoCtx routes by tier.
  xrepo: XrepoConfig | undefined;
  apiToken: string;
  modes: Mode[];
  postCheckoutScript: string | null;
  prepushScript: string | null;
  prApproveEnabled: boolean;
  reviewDrafts: boolean;
  // globally-gated server-side (run-context ANDs the per-repo toggle with the
  // `isAutonomousMaintenanceEnabled()` kill switch). gates the run-end
  // autoMergeAfterApprove lifecycle action — there is deliberately NO
  // agent-callable merge tool.
  autoMergeEnabled: boolean;
  // commits are created via the GitHub API (server-side signed, Verified)
  // instead of local git commit + push_branch. see CommitChangesTool.
  signedCommits: boolean;
  repoIntelligence: boolean;
  modeInstructions: Record<string, string>;
  toolState: ToolState;
  runId: number | undefined;
  jobId: string | undefined;
  mcpServerUrl: string;
  tmpdir: string;
  // repo-level OSS flag + legacy-named account card signal. retained in the
  // runtime context for existing consumers and observability.
  oss: boolean;
  plan: AccountPlan;
  // resolved upstream model specifier (e.g. "google/gemini-3.1-pro-preview").
  // undefined when payload.proxyModel is set or when the alias is unresolvable.
  // used by the schema sanitizer to detect Gemini-routed traffic.
  resolvedModel: string | undefined;
}

const mcpPortStart = 3764;
const mcpPortAttempts = 100;
const mcpHost = "127.0.0.1";
const mcpEndpoint = "/mcp";

function readEnvPort(): number | null {
  const rawPort = process.env.PULLFROG_MCP_PORT;
  if (!rawPort) return null;
  const parsed = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`invalid PULLFROG_MCP_PORT: ${rawPort}`);
  }
  return parsed;
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, mcpHost);
  });
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isAddressInUse(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return message.includes("eaddrinuse") || message.includes("address already in use");
}

type JsonSchema = Record<string, unknown>;

function buildCommonTools(ctx: ToolContext, outputSchema?: JsonSchema): PullfrogTool[] {
  const tools: PullfrogTool[] = [
    StartDependencyInstallationTool(ctx),
    AwaitDependencyInstallationTool(ctx),
    CreateCommentTool(ctx),
    EditCommentTool(ctx),
    ReplyToReviewCommentTool(ctx),
    IssueTool(ctx),
    CloseCurrentTool(ctx),
    ReopenCurrentTool(ctx),
    IssueInfoTool(ctx),
    GetIssueCommentsTool(ctx),
    GetIssueEventsTool(ctx),
    CreatePullRequestReviewTool(ctx),
    PullRequestInfoTool(ctx),
    CommitInfoTool(ctx),
    CheckoutPrTool(ctx),
    GetReviewCommentsTool(ctx),
    ListPullRequestReviewsTool(ctx),
    ResolveReviewThreadTool(ctx),
    GetCheckSuiteLogsTool(ctx),
    AddLabelsTool(ctx),
    RemoveLabelsTool(ctx),
    GitTool(ctx),
    GitFetchTool(ctx),
    UploadFileTool(ctx),
  ];

  // cross-repo tools only surface on --xrepo runs (keeps the single-repo tool
  // list unchanged). list_repos + checkout_repo gate further on ctx.xrepo.
  if (ctx.xrepo) {
    tools.push(ListReposTool(ctx), CheckoutRepoTool(ctx));
  }

  if (hasSimilarIssues({ repoIntelligence: ctx.repoIntelligence, event: ctx.payload.event })) {
    tools.push(SimilarIssuesTool(ctx));
  }
  if (ctx.payload.event.issue_number !== undefined && !ctx.payload.event.is_pr) {
    tools.push(SearchIssuesTool(ctx));
  }

  const isStandalone = ctx.payload.event.trigger === "unknown";
  if (isStandalone || outputSchema) {
    tools.push(SetOutputTool(ctx, outputSchema));
  }

  // sandboxed in CI, env filtered unless shell is "enabled". claude code and opencode deny their
  // native shells, so this is their only one
  if (ctx.payload.shell !== "disabled") {
    tools.push(ShellTool(ctx));
    tools.push(KillBackgroundTool(ctx));
  }

  // above the mirror threshold the triggering user already holds repo-wide
  // rights, so `gh` grants nothing they could not do themselves — and it
  // subsumes the arbitrary-number close/reopen tools that used to live here
  // (`gh issue close`, `gh pr close`). below it, `close_current`/`reopen_current`
  // (always registered above) are the only state changes available, because no
  // token scope expresses "act only on the object you authored".
  if (ctx.ghToken) {
    tools.push(GhTool(ctx));
  }

  return tools;
}

export function buildOrchestratorTools(
  ctx: ToolContext,
  outputSchema?: JsonSchema
): PullfrogTool[] {
  const tools = [
    ...buildCommonTools(ctx, outputSchema),
    ReportProgressTool(ctx),
    SelectModeTool(ctx),
    PushBranchTool(ctx),
    PushTagsTool(ctx),
    DeleteBranchTool(ctx),
    CreatePullRequestTool(ctx),
    UpdatePullRequestBodyTool(ctx),
  ];
  // only registered in signed-commits mode so the tool never tempts agents
  // on repos where plain git commit + push_branch is the canonical flow
  if (ctx.signedCommits) {
    tools.push(CommitChangesTool(ctx));
  }
  return tools;
}

type McpStartResult = {
  server: FastMCP;
  url: string;
  port: number;
};

async function tryStartMcpServer(
  ctx: ToolContext,
  tools: Tool<any, any>[],
  port: number
): Promise<McpStartResult | null> {
  const server = new FastMCP({ name: pullfrogMcpName, version: "0.0.1" });
  addTools(ctx, server, tools);

  try {
    await server.start({
      transportType: "httpStream",
      httpStream: {
        port,
        host: mcpHost,
        endpoint: mcpEndpoint,
      },
    });
    const url = `http://${mcpHost}:${port}${mcpEndpoint}`;
    return { server, url, port };
  } catch (error) {
    if (!isAddressInUse(error)) {
      throw error;
    }
    try {
      await server.stop();
    } catch {
      // ignore cleanup errors on failed start
    }
    return null;
  }
}

async function selectMcpPort(ctx: ToolContext, tools: Tool<any, any>[]): Promise<McpStartResult> {
  let lastError: unknown = null;

  const requestedPort = readEnvPort();
  if (requestedPort !== null) {
    if (await isPortAvailable(requestedPort)) {
      const requestedResult = await tryStartMcpServer(ctx, tools, requestedPort);
      if (requestedResult) {
        return requestedResult;
      }
    }
  }

  // randomize start offset to reduce collision chance in parallel runs
  const randomOffset = Math.floor(Math.random() * 50);

  for (let offset = 0; offset < mcpPortAttempts; offset++) {
    const port = mcpPortStart + randomOffset + offset;
    try {
      if (!(await isPortAvailable(port))) {
        continue;
      }
      const result = await tryStartMcpServer(ctx, tools, port);
      if (result) {
        return result;
      }
    } catch (error) {
      lastError = error;
      if (!isAddressInUse(error)) {
        throw error;
      }
    }
  }

  const message = getErrorMessage(lastError);
  throw new Error(
    `could not find available mcp port starting at ${mcpPortStart} (last error: ${message})`
  );
}

async function killBackgroundProcesses(toolState: ToolState): Promise<void> {
  const backgroundProcesses = toolState.backgroundProcesses;
  if (backgroundProcesses.size === 0) return;
  for (const proc of backgroundProcesses.values()) {
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      // already dead
    }
  }
  await sleep(200);
  for (const proc of backgroundProcesses.values()) {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      // already dead
    }
  }
  backgroundProcesses.clear();
}

type McpHttpServerOptions = {
  outputSchema?: JsonSchema | undefined;
};

/**
 * Start the MCP HTTP server.
 *
 * The returned disposer is idempotent — safe to call multiple times.
 * Callers (e.g. the inner activity-timeout handler in main.ts) may need to
 * stop the server before the `await using` block exits; a subsequent
 * automatic dispose is then a no-op.
 */
export async function startMcpHttpServer(
  ctx: ToolContext,
  options?: McpHttpServerOptions
): Promise<{ url: string; toolNames: string[]; [Symbol.asyncDispose]: () => Promise<void> }> {
  const tools = buildOrchestratorTools(ctx, options?.outputSchema);
  const startResult = await selectMcpPort(ctx, tools);

  let disposed = false;
  return {
    url: startResult.url,
    // the names actually registered, handed back so the prompt can be checked
    // against them rather than against a second derivation. see
    // assertPromptToolRefs.
    toolNames: tools.map((registered) => registered.name),
    [Symbol.asyncDispose]: async () => {
      if (disposed) return;
      disposed = true;
      closeBrowserDaemon(ctx.toolState);
      await killBackgroundProcesses(ctx.toolState);
      await startResult.server.stop();
    },
  };
}
