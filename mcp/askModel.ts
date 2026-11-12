import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type } from "arktype";
import {
  GIT_NATIVE_READ_DENY_CLAUDE,
  GIT_NATIVE_READ_DENY_OPENCODE,
  GIT_NATIVE_WRITE_DENY_CLAUDE,
  GIT_NATIVE_WRITE_DENY_OPENCODE,
  HOOK_ASSET_TMPDIR_RELPATHS,
} from "../agents/nativeFsDenies.ts";
import type { Sandbox } from "../agents/opencodeSession.ts";
import {
  azureProvider,
  type OpenCodeConfig,
  openAICompatibleProvider,
  openRouterDataCollection,
  openRouterProvider,
} from "../agents/opencodeShared.ts";
import type { AgentUsage } from "../agents/shared.ts";
import { pullfrogMcpName } from "../external.ts";
import {
  AZURE_DEPLOYMENT_ENV,
  BEDROCK_MODEL_ID_ENV,
  getModelProvider,
  modelAliases,
  OPENAI_COMPATIBLE_PROVIDER,
  openAICompatibleEnv,
  openAICompatibleSets,
  stripProviderPrefix,
  VERTEX_MODEL_ID_ENV,
} from "../models.ts";
import {
  azureSetupMissing,
  bedrockSetupMissing,
  openAICompatibleSetupMissing,
  vertexSetupMissing,
} from "../utils/apiKeys.ts";
import { type CallableModel, callableModels } from "../utils/callableModels.ts";
import { log } from "../utils/cli.ts";
import { askModelPrivateDir, installPrivateSubscription } from "../utils/codexHome.ts";
import { loadStoredCredential } from "../utils/credentialPool.ts";
import { installFromNpmTarball } from "../utils/install.ts";
import type { RunContextData } from "../utils/runContextData.ts";
import { filterEnvForUntrustedCode, isSensitiveEnvName, proxyEnv } from "../utils/secrets.ts";
import { SpawnTimeoutError, spawn } from "../utils/subprocess.ts";
import { type CredentialAccess, subscriptionNameSchema } from "../utils/subscriptionCredentials.ts";
import { probeSubscription } from "../utils/subscriptionProbe.ts";
import { getDevDependencyVersion } from "../utils/version.ts";
import {
  GOOGLE_APPLICATION_CREDENTIALS_ENV,
  GOOGLE_CLOUD_PROJECT_ENV,
  readProjectIdFromVertexServiceAccountJson,
  VERTEX_LOCATION_ENV,
  VERTEX_SERVICE_ACCOUNT_JSON_ENV,
} from "../utils/vertex.ts";
import type { ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";

/** under the 660s the opencode and codex harnesses give a Pullfrog tool call before aborting it. */
const ASK_TIMEOUT_MS = 9 * 60_000;
/** bounds what a prompt injection in a PR can spend on the account's other credentials. */
const MAX_ASKS = 12;
/** claude-code's native tools an ask keeps: the file tools and the web, as the run's own agent has. */
const CLAUDE_ASK_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Edit",
  "Write",
  "NotebookEdit",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
];
const FRAMING =
  "Another AI agent working in this repository asks for your independent answer. " +
  "You have its pullfrog tools: run commands with the pullfrog shell tool, as the built-in shell is off. " +
  "Pushing, posting to GitHub and the run's own state stay with that agent. Answer directly.\n\n";

/**
 * a provider that runs the one model the account configured for it (Bedrock, Vertex, Azure, an
 * OpenAI-compatible endpoint): the env it reads, as held, and the opencode provider block.
 */
interface Route {
  env: string[];
  provider: Record<string, unknown>;
}

type AskModel = CallableModel & { route?: Route | undefined };

export interface AskModels {
  models: AskModel[];
  /** the env names the run can pay an ask with: every non-empty one but a proxy's minted key. */
  held: string[];
  access: CredentialAccess | undefined;
  /** the MCP server an ask connects to, set once `startMcpHttpServer` has started it. */
  mcpUrl?: string | undefined;
}

interface Ask {
  model: AskModel;
  prompt: string;
  value: string;
  rung: string | undefined;
}

interface Answer {
  text: string;
  usage: AgentUsage;
}

/**
 * the models this run can ask: credentials it holds plus stored ones it has not loaded. the
 * OpenRouter key a proxied run was minted is not one of them: the Router, the OSS subsidy and the
 * trial each fund the run itself, and the console cannot list a key that is not stored.
 */
export function resolveAskModels(input: {
  runContext: RunContextData;
  proxied: boolean;
}): AskModels {
  const access = input.runContext.credentialAccess;
  const held = Object.keys(process.env).filter(
    (name) => process.env[name]?.trim() && !(input.proxied && name === "OPENROUTER_API_KEY")
  );
  const stored = access?.candidates.map((candidate) => candidate.name) ?? [];
  return { models: [...callableModels([...held, ...stored]), ...routedModels(held)], held, access };
}

/**
 * one model per routing provider whose setup is complete in this run's env, checked by the same
 * functions that validate a run on it. these are runner-only: the model id often lives in the
 * workflow's `env:`, out of the console's sight.
 */
function routedModels(held: string[]): AskModel[] {
  const routed = (input: { slug: string; resolve: string; credential: string; route: Route }) => ({
    ...input,
    displayName: input.slug,
    effort: [],
  });
  const env = (name: string) => process.env[name]?.trim() ?? "";
  const models: AskModel[] = [];
  if (bedrockSetupMissing().length === 0) {
    const id = env(BEDROCK_MODEL_ID_ENV);
    const bearer = env("AWS_BEARER_TOKEN_BEDROCK") !== "";
    models.push(
      routed({
        slug: `bedrock/${id}`,
        // opencode's provider id, as opencode.ts writes it for a Bedrock run
        resolve: `amazon-bedrock/${id}`,
        credential: bearer ? "AWS_BEARER_TOKEN_BEDROCK" : "AWS_ACCESS_KEY_ID",
        route: {
          env: bearer
            ? ["AWS_BEARER_TOKEN_BEDROCK", "AWS_REGION"]
            : ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION"],
          provider: {},
        },
      })
    );
  }
  if (vertexSetupMissing().length === 0) {
    const id = env(VERTEX_MODEL_ID_ENV);
    models.push(
      routed({
        slug: `vertex/${id}`,
        resolve: `google-vertex/${id}`,
        credential: VERTEX_SERVICE_ACCOUNT_JSON_ENV,
        route: { env: [GOOGLE_CLOUD_PROJECT_ENV, VERTEX_LOCATION_ENV], provider: {} },
      })
    );
  }
  if (azureSetupMissing().length === 0) {
    const resolve = `azure/${env(AZURE_DEPLOYMENT_ENV)}`;
    models.push(
      routed({
        slug: resolve,
        resolve,
        credential: "AZURE_API_KEY",
        route: { env: ["AZURE_API_KEY", "AZURE_RESOURCE_NAME"], provider: azureProvider(resolve) },
      })
    );
  }
  for (const set of [undefined, ...openAICompatibleSets(held)]) {
    if (openAICompatibleSetupMissing(set).length > 0) continue;
    const names = openAICompatibleEnv(set);
    const resolve = `${OPENAI_COMPATIBLE_PROVIDER}/${env(names.model)}`;
    models.push(
      routed({
        slug: `${OPENAI_COMPATIBLE_PROVIDER}/${set ?? env(names.model)}`,
        resolve,
        credential: names.apiKey,
        route: { env: [], provider: openAICompatibleProvider(resolve, set) },
      })
    );
  }
  return models;
}

const AskModelParams = type({
  model: type.string.describe("provider/model slug; an unknown one returns every available slug"),
  prompt: type.string.describe(
    "the whole question. it starts fresh in the same checkout, without your conversation, so include what it needs"
  ),
  "effort?": type.string.describe(
    "one of the model's effort levels, e.g. high; omit for its default"
  ),
});

export function AskModelTool(ctx: ToolContext) {
  let asked = 0;
  return tool({
    name: "ask_model",
    description:
      "ask another model for an independent answer, e.g. to check findings or a plan. " +
      "it works in the checkout with your shell and read-only tools, but cannot push or post; billed to that model's credential. " +
      `examples, one per provider this run can reach: ${describeModels(ctx.askModels.models)}`,
    parameters: AskModelParams,
    execute: execute(async (params) => {
      const model = findModel(ctx.askModels.models, params.model);
      const rung = askRung({ model, effort: params.effort });
      if (asked >= MAX_ASKS) throw new Error(`ask_model is limited to ${MAX_ASKS} calls per run`);
      asked++;
      const value = model.route ? "" : await credentialValue(ctx, model.credential);
      await refuseCappedSubscription({ model, value });
      const ask = { model, prompt: params.prompt, value, rung };
      log.info(`» ask_model: ${model.slug}${rung ? ` at ${rung}` : ""} via ${model.credential}`);
      const answer = await (model.credential === "CLAUDE_CODE_OAUTH_TOKEN"
        ? askClaude(ctx, ask)
        : askOpenCode(ctx, ask)
      ).catch(explainTimeout);
      // logged in the job summary, kept off the run row (see wiki/ask-model.md)
      ctx.toolState.usageEntries.push(answer.usage);
      return `${model.slug}:\n\n${answer.text}`;
    }, "ask_model"),
  });
}

/** opencode runs an unknown `--variant` at the model's default without a word, so refuse one here. */
function askRung(input: { model: AskModel; effort: string | undefined }) {
  if (input.effort === undefined) return undefined;
  const levels = input.model.effort;
  const rung = input.effort.trim().toLowerCase();
  if (levels.includes(rung)) return rung;
  throw new Error(
    levels.length > 0
      ? `${input.model.slug} takes effort ${levels.join(", ")}`
      : `${input.model.slug} takes no effort level; omit effort`
  );
}

/**
 * a capped subscription would sit out its reset inside opencode, so ask the run's own startup probe
 * first: ChatGPT's quota endpoint, a one-token request for Claude and Grok. an API key has no quota
 * endpoint to ask, which leaves its cap to the timeout.
 */
async function refuseCappedSubscription(input: { model: AskModel; value: string }) {
  const name = subscriptionNameSchema.safeParse(input.model.credential);
  if (!name.success) return;
  const verdict = await probeSubscription({
    name: name.data,
    value: input.value,
    model: stripProviderPrefix(input.model.resolve),
  });
  if (verdict.status === "exhausted") {
    const reset = verdict.resetAt ? `, until ${verdict.resetAt.toISOString()}` : "";
    throw new Error(`${input.model.credential} is at its usage limit${reset}: ${verdict.detail}`);
  }
  if (verdict.status === "rejected") {
    throw new Error(`${input.model.credential} was rejected: ${verdict.detail}`);
  }
}

/** opencode sleeps through a provider's `retry-after` (hours, on a capped free tier) without a word on stdout. */
function explainTimeout(error: unknown): never {
  if (error instanceof SpawnTimeoutError) {
    throw new Error(
      `no answer within ${ASK_TIMEOUT_MS / 60_000} minutes. the provider is most likely rate-limiting this credential or it has hit a usage cap`
    );
  }
  throw error;
}

/**
 * one example per provider (`anthropic/claude-opus, …`): the description is billed on every run,
 * and one Zen key alone serves 39 models. an unknown slug answers with the full list.
 */
function describeModels(models: AskModel[]) {
  const groups = Map.groupBy(models, (model) => getModelProvider(model.slug));
  return [...groups.values()]
    .map((entries) => (entries.find((entry) => isPreferred(entry.slug)) ?? entries[0])?.slug)
    .join(", ");
}

const isPreferred = (slug: string) =>
  modelAliases.some((alias) => alias.slug === slug && alias.preferred);

/** an exact slug, or a bare alias (`gpt-sol`) that names one model. */
function findModel(models: AskModel[], requested: string) {
  const wanted = requested.trim().toLowerCase();
  // a routed slug carries the customer's own casing (`azure/GPT4o-Prod`)
  const exact = models.find((model) => model.slug.toLowerCase() === wanted);
  const bare = models.filter((model) => stripProviderPrefix(model.slug).toLowerCase() === wanted);
  const found = exact ?? (bare.length === 1 ? bare[0] : undefined);
  if (found) return found;
  throw new Error(
    `"${requested}" is not a model this run can ask. available: ${models.map((model) => model.slug).join(", ")}`
  );
}

/** the run's own copy when it holds one; a stored one is loaded only for a name it does not. */
async function credentialValue(ctx: ToolContext, name: string) {
  const held = ctx.askModels.held.includes(name) && process.env[name]?.trim();
  if (held) return held;
  const access = ctx.askModels.access;
  const stored = access && (await loadStoredCredential({ access, name }));
  if (stored) return stored;
  throw new Error(`${name} is configured but could not be loaded`);
}

/** a private HOME, and no credential but the one this call is billed to. */
function isolatedEnv(ctx: ToolContext) {
  const home = mkdtempSync(join(ctx.tmpdir, "ask-model-"));
  const env: Record<string, string | undefined> = {
    ...filterEnvForUntrustedCode(),
    ...proxyEnv(),
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    PWD: process.cwd(),
  };
  // an allowlisted workflow var must not hand the side call opencode's script interpreter
  delete env.OPENCODE_EXPERIMENTAL;
  delete env.OPENCODE_EXPERIMENTAL_CODE_MODE;
  // nor a second credential: an allowlisted API key outranks the subscription this call selects
  for (const name of Object.keys(env)) if (isSensitiveEnvName(name)) delete env[name];
  return env;
}

async function askOpenCode(ctx: ToolContext, ask: Ask): Promise<Answer> {
  const cliPath = await installFromNpmTarball({
    packageName: "opencode-ai",
    version: getDevDependencyVersion("opencode-ai"),
    executablePath: "bin/opencode.exe",
    installDependencies: true,
  });
  const env = isolatedEnv(ctx);
  const route = ask.model.route;
  if (route) {
    for (const name of route.env) env[name] = process.env[name];
    if (ask.model.credential === VERTEX_SERVICE_ACCOUNT_JSON_ENV) installVertexAccount(env);
  } else if (
    ask.model.credential === "CODEX_AUTH_JSON" ||
    ask.model.credential === "GROK_AUTH_JSON"
  ) {
    env.XDG_DATA_HOME = privateSubscriptionHome({ name: ask.model.credential, value: ask.value });
  } else {
    env[ask.model.credential] = ask.value;
    if (ask.model.credential === "GEMINI_API_KEY") env.GOOGLE_GENERATIVE_AI_API_KEY = ask.value;
  }
  // the run's own posture (buildSecurityConfig and its sandbox in opencode.ts): native bash stays
  // listed for Zen's free tier but off, since `run` rejects every "ask", and the loop carries on past
  // the rejection to the pullfrog shell rather than ending the turn unanswered.
  const config: OpenCodeConfig = {
    permission: { bash: "ask", edit: "allow", read: "allow", webfetch: "allow" },
    experimental: { continue_loop_on_deny: true },
    enabled_providers: [getModelProvider(ask.model.resolve)],
    provider: {
      openrouter: openRouterProvider(openRouterDataCollection(ctx)),
      ...route?.provider,
    },
    mcp: {
      [pullfrogMcpName]: { type: "remote", url: ctx.askModels.mcpUrl, timeout: 660_000 },
    },
  };
  // the run's hook scripts, plugins and PATH tools sit under ctx.tmpdir and run with its full env,
  // so deny them after the allow (last match wins), as opencode.ts does for the run itself
  const sealed = HOOK_ASSET_TMPDIR_RELPATHS.flatMap((rel) => {
    const path = join(ctx.tmpdir, rel);
    return [
      [path, "deny"],
      [`${path}/*`, "deny"],
    ];
  });
  const sandbox: Sandbox = {
    external_directory: {
      "*": "deny",
      "/tmp/*": "allow",
      [`${ctx.tmpdir}/*`]: "allow",
      ...Object.fromEntries(sealed),
    },
    read: { "*": "allow", ...GIT_NATIVE_READ_DENY_OPENCODE },
    edit: { "*": "allow", ...GIT_NATIVE_WRITE_DENY_OPENCODE },
  };
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  env.OPENCODE_PERMISSION = JSON.stringify(sandbox);
  // the checkout is untrusted by now: its opencode.json could start a local MCP server with this env
  env.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
  const args = ["run", "--pure", "--format", "json", "-m", ask.model.resolve];
  if (ask.rung) args.push("--variant", ask.rung);
  const result = await spawn({
    cmd: cliPath,
    args,
    env,
    input: FRAMING + ask.prompt,
    timeout: ASK_TIMEOUT_MS,
    activityTimeout: 0,
    killGroup: true,
  });
  return parseOpenCodeEvents({ stdout: result.stdout, stderr: result.stderr });
}

/**
 * the service account as a file, the only form opencode's Vertex provider reads, kept out of the
 * agent shell's sight like a subscription's; the project falls back to the account's own.
 */
function installVertexAccount(env: Record<string, string | undefined>) {
  const dir = askModelPrivateDir();
  if (!dir) throw new Error("no private directory for the Vertex service account");
  const path = join(dir, "vertex-sa.json");
  writeFileSync(path, process.env[VERTEX_SERVICE_ACCOUNT_JSON_ENV] ?? "", { mode: 0o600 });
  env[GOOGLE_APPLICATION_CREDENTIALS_ENV] = path;
  env[GOOGLE_CLOUD_PROJECT_ENV] ??= readProjectIdFromVertexServiceAccountJson();
}

/** refuses a token that could expire mid-call: opencode would refresh it, and nothing writes the rotated chain back. */
function privateSubscriptionHome(input: {
  name: "CODEX_AUTH_JSON" | "GROK_AUTH_JSON";
  value: string;
}) {
  const installed = installPrivateSubscription(input);
  if (!installed) throw new Error(`${input.name} could not be installed for this call`);
  if (installed.expires < Date.now() + ASK_TIMEOUT_MS + 5 * 60_000) {
    throw new Error(
      `${input.name}'s access token expires too soon: refreshing it here would rotate the chain the stored credential depends on`
    );
  }
  return installed.dataHome;
}

function parseOpenCodeEvents(output: { stdout: string; stderr: string }): Answer {
  const texts: string[] = [];
  const usage: AgentUsage = { agent: "ask_model", inputTokens: 0, outputTokens: 0, costUsd: 0 };
  let error: unknown;
  for (const line of output.stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    const event = JSON.parse(line);
    // an error the session recovered from (a compaction) is followed by more text
    if (event.type === "text") {
      texts.push(event.part.text);
      error = undefined;
    }
    if (event.type === "error") error = event.error;
    if (event.type === "step_finish") {
      const tokens = event.part.tokens;
      usage.inputTokens += tokens.input + tokens.cache.read + tokens.cache.write;
      usage.outputTokens += tokens.output + tokens.reasoning;
      usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + tokens.cache.read;
      usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + tokens.cache.write;
      usage.costUsd = (usage.costUsd ?? 0) + event.part.cost;
    }
  }
  if (texts.length > 0 && error === undefined) return { text: texts.join("\n\n"), usage };
  throw new Error(`the model did not answer: ${JSON.stringify(error) ?? output.stderr.trim()}`);
}

async function askClaude(ctx: ToolContext, ask: Ask): Promise<Answer> {
  const cliPath = await installFromNpmTarball({
    packageName: "@anthropic-ai/claude-code",
    version: getDevDependencyVersion("@anthropic-ai/claude-code"),
    executablePath: "bin/claude.exe",
    installDependencies: true,
  });
  const env = isolatedEnv(ctx);
  env.CLAUDE_CODE_OAUTH_TOKEN = ask.value;
  const mcpConfig = join(env.HOME ?? "", "mcp.json");
  writeFileSync(
    mcpConfig,
    JSON.stringify({
      mcpServers: { [pullfrogMcpName]: { type: "http", url: ctx.askModels.mcpUrl } },
    })
  );
  // `--restricted` drops the native tools that run code, confines file tools to the checkout and
  // ignores the checkout's own settings. `dontAsk` refuses anything not allowed here, which holds
  // even where the run installed no managed settings (an opencode run)
  const result = await spawn({
    cmd: cliPath,
    args: [
      "-p",
      "--restricted",
      "--tools",
      CLAUDE_ASK_TOOLS.join(","),
      "--mcp-config",
      mcpConfig,
      "--strict-mcp-config",
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      [...CLAUDE_ASK_TOOLS, `mcp__${pullfrogMcpName}`].join(","),
      "--disallowedTools",
      [...GIT_NATIVE_READ_DENY_CLAUDE, ...GIT_NATIVE_WRITE_DENY_CLAUDE].join(","),
      "--no-session-persistence",
      "--output-format",
      "json",
      "--model",
      stripProviderPrefix(ask.model.resolve),
      "--append-system-prompt",
      FRAMING.trim(),
      ...(ask.rung ? ["--effort", ask.rung] : []),
    ],
    env,
    input: ask.prompt,
    timeout: ASK_TIMEOUT_MS,
    activityTimeout: 0,
    killGroup: true,
  });
  const parsed = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}");
  if (parsed.is_error || typeof parsed.result !== "string") {
    throw new Error(`the model returned no answer: ${parsed.result ?? result.stderr.trim()}`);
  }
  const usage = parsed.usage;
  return {
    text: parsed.result,
    usage: {
      agent: "ask_model",
      inputTokens:
        usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens,
      cacheWriteTokens: usage.cache_creation_input_tokens,
      costUsd: parsed.total_cost_usd,
    },
  };
}
