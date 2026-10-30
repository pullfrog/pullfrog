// Shared helpers for the OpenCode agent harnesses (`./opencode.ts` v1 and
// `./opencode.ts` v2). Pure config / model-registry / install glue —
// nothing here touches the NDJSON event loop, which differs between v1 and v2.
//
// Once v1 is deleted post-burn-in this module collapses back into v2; until
// then it keeps both runners synchronized so a config drift can't make v1 a
// silently-broken fallback.

import {
  AZURE_CONTEXT_ENV,
  AZURE_MAX_OUTPUT_ENV,
  AZURE_PROVIDER,
  AZURE_USE_CHAT_COMPLETIONS_ENV,
  getOpenCodeEnvVars,
  getProviderGatewayUrl,
  modelAliases,
  OPENAI_COMPATIBLE_API_KEY_ENV,
  OPENAI_COMPATIBLE_BASE_URL_ENV,
  OPENAI_COMPATIBLE_CONTEXT_ENV,
  OPENAI_COMPATIBLE_MAX_OUTPUT_ENV,
  OPENAI_COMPATIBLE_PROVIDER,
} from "../models.ts";
import { log } from "../utils/cli.ts";
import { installFromNpmTarball } from "../utils/install.ts";
import { getAuthorizedModels } from "../utils/openCodeModels.ts";
import { getDevDependencyVersion } from "../utils/version.ts";
import { opencodeGeneration } from "./opencodeGeneration.ts";
import { REVIEWER_AGENT_NAME, REVIEWER_SYSTEM_PROMPT } from "./reviewer.ts";
import { deriveSubagentModels } from "./subagentModels.ts";

// ── config ─────────────────────────────────────────────────────────────────────

export type OpenCodeConfig = {
  mcp?: Record<string, unknown>;
  permission?: Record<string, unknown>;
  provider?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  experimental?: Record<string, unknown>;
  model?: string;
  enabled_providers?: string[];
  [key: string]: unknown;
};

interface OpenAICompatibleProviderEntry {
  npm: string;
  name: string;
  options: { baseURL: string | undefined; apiKey: string | undefined };
  models: Record<string, { name: string; limit: ModelLimit }>;
}

interface ModelLimit {
  context: number;
  output: number;
}

/** azure needs no `npm` — opencode's native provider supplies it. */
interface AzureProviderEntry {
  options: { useCompletionUrls: boolean };
  models: Record<string, { name: string; limit: ModelLimit }>;
}

/**
 * Per-model token limits for the injected provider. opencode carries no models.dev
 * metadata for a user-supplied endpoint, so an absent `limit` defaults to
 * `{context: 0, output: 0}` (`provider/provider.ts`) and that zero costs two
 * things: `maxOutputTokens` falls back to `OUTPUT_TOKEN_MAX` and sends
 * `max_tokens: 32000` — rejected by any model with a smaller completion cap
 * (gpt-4o-mini: "max_tokens is too large: 32000. This model supports at most
 * 16384") — and `isOverflow` short-circuits on `limit.context === 0`
 * (`session/overflow.ts`), silently disabling auto-compaction for the whole run.
 *
 * Both env vars are therefore required by `validateOpenAICompatibleSetup`, which
 * runs before the agent and rejects non-numeric values, so they parse here.
 */
function openAICompatibleLimit(): ModelLimit {
  return {
    context: Number(process.env[OPENAI_COMPATIBLE_CONTEXT_ENV]),
    output: Number(process.env[OPENAI_COMPATIBLE_MAX_OUTPUT_ENV]),
  };
}

/**
 * OpenAI-compatible provider block for OPENCODE_CONFIG_CONTENT. opencode has no
 * native provider for an arbitrary gateway, so inject one via
 * `@ai-sdk/openai-compatible` when the run targets `openai-compatible/<model>`;
 * `{}` otherwise so the caller can spread it unconditionally. base URL + key are
 * guaranteed present by `validateOpenAICompatibleSetup`.
 */
export function openAICompatibleProvider(
  model: string | undefined
): Record<string, OpenAICompatibleProviderEntry> {
  const prefix = `${OPENAI_COMPATIBLE_PROVIDER}/`;
  if (!model?.startsWith(prefix)) return {};
  const modelId = model.slice(prefix.length);
  return {
    [OPENAI_COMPATIBLE_PROVIDER]: {
      npm: "@ai-sdk/openai-compatible",
      name: "OpenAI-compatible",
      options: {
        // trailing slash would double up against opencode's `/chat/completions` join
        baseURL: process.env[OPENAI_COMPATIBLE_BASE_URL_ENV]?.replace(/\/$/, ""),
        apiKey: process.env[OPENAI_COMPATIBLE_API_KEY_ENV],
      },
      models: { [modelId]: { name: modelId, limit: openAICompatibleLimit() } },
    },
  };
}

/**
 * What each opencode SDK joins onto `options.baseURL`, reconciled against the
 * env var's own convention. `@ai-sdk/anthropic` posts to `${baseURL}/messages`,
 * but `ANTHROPIC_BASE_URL` is a bare host — claude-code and Anthropic's SDKs
 * append `/v1/messages` themselves — so the `/v1` has to be restored here or
 * the gateway answers 404 (measured 2026-09-11). `@ai-sdk/openai` posts to
 * `${baseURL}/responses`, which the `/v1`-inclusive `OPENAI_BASE_URL`
 * convention already satisfies.
 */
const OPENCODE_GATEWAY_PATH: Record<string, string> = { anthropic: "/v1" };

/**
 * Customer-gateway block for OPENCODE_CONFIG_CONTENT. opencode resolves a
 * provider's endpoint as `options.baseURL ?? model.api.url` (`getSDK`), and
 * models.dev declares no base-URL env var for any provider we catalog — so a
 * config override is the ONLY lever that re-points one. Unlike
 * `openAICompatibleProvider` this declares no `npm` and no models: the native
 * provider and its catalog metadata (including token limits) stay exactly as
 * they are, and only the host changes. `{}` when unset so the caller can spread
 * it unconditionally.
 *
 * `anthropic/*` normally never reaches here — `resolveAgent` routes it to
 * claude-code, which reads ANTHROPIC_BASE_URL natively — but keying off the
 * resolved specifier rather than the harness means it still holds on the paths
 * that do send a Claude model through opencode (`PULLFROG_AGENT=opencode`).
 */
export function providerGatewayOverride(
  model: string | undefined
): Record<string, { options: { baseURL: string } }> {
  const gatewayUrl = getProviderGatewayUrl(model);
  if (!model || !gatewayUrl) return {};
  const provider = model.slice(0, model.indexOf("/"));
  const baseURL = `${gatewayUrl}${OPENCODE_GATEWAY_PATH[provider] ?? ""}`;
  return { [provider]: { options: { baseURL } } };
}

/**
 * Azure model block for OPENCODE_CONFIG_CONTENT. Unlike openai-compatible this
 * does NOT declare a provider — opencode has a native `azure` one and the env
 * loop already enables it. What it declares is the MODEL, because opencode
 * resolves `azure/<deployment>` by looking the id up in the provider's catalog
 * (`Provider.getModel` → `provider.models[modelID]`) and throws
 * `ProviderModelNotFoundError` when it misses. A deployment name is chosen by
 * whoever created the deployment, so it is absent from that catalog unless it
 * happens to match a models.dev azure id — measured against opencode-ai@1.18.5:
 * `azure/prod-reasoning` throws, and the same run with this block resolves and
 * reaches the network. The limits come from env for the same reason
 * openai-compatible's do; `validateAzureSetup` guarantees they parse.
 */
export function azureProvider(model: string | undefined): Record<string, AzureProviderEntry> {
  const prefix = `${AZURE_PROVIDER}/`;
  if (!model?.startsWith(prefix)) return {};
  const deployment = model.slice(prefix.length);
  // opencode calls `sdk.responses(modelID)` unless `useCompletionUrls` is set, so
  // a deployment serving a pre-Responses model (gpt-4, gpt-35-turbo) needs this
  // to speak the dialect Azure will actually answer.
  return {
    [AZURE_PROVIDER]: {
      // always sent: opencode reads it as `Boolean(options?.useCompletionUrls)`,
      // so `false` and absent are the same, and the deep merge keeps the native
      // loader's `resourceName` either way.
      options: {
        useCompletionUrls: process.env[AZURE_USE_CHAT_COMPLETIONS_ENV]?.trim() === "true",
      },
      models: {
        [deployment]: {
          name: deployment,
          limit: {
            context: Number(process.env[AZURE_CONTEXT_ENV]),
            output: Number(process.env[AZURE_MAX_OUTPUT_ENV]),
          },
        },
      },
    },
  };
}

// OpenRouter sub-providers that serve Kimi K2 WITHOUT Moonshot's Enforcer
// (schema-constrained decoding), so they silently drop optional tool-call
// params after the reasoning phase (SGLang #12932). ignoring them keeps Kimi
// on a good route (Fireworks, Novita, etc.). needs upkeep as OpenRouter's
// roster shifts. see wiki/review-approval.md.
const KIMI_ENFORCERLESS_PROVIDERS = ["siliconflow", "together"];

export type OpenRouterDataCollection = "allow" | "deny";

/**
 * OpenRouter's request-level `provider.data_collection` decides whether hosts
 * that retain or train on prompts may serve a run. The account-wide privacy
 * setting is only a ceiling a request can tighten, so the policy rides on the
 * run instead: OSS-funded runs `allow` (public code on headless runs — and the
 * cheapest V4.1 Flash host, DeepSeek's own, is a training host), Router runs
 * `deny` (a customer's private code never reaches one; every catalog target
 * was still served under `deny` on 2026-09-11), and a BYOK OpenRouter key gets
 * no preference — the customer's own account decides. see wiki/muse-spark.md.
 */
export function openRouterDataCollection(ctx: {
  payload: { proxyModel?: string | undefined };
  toolState: { oss?: boolean | undefined };
}): OpenRouterDataCollection | undefined {
  if (!ctx.payload.proxyModel) return undefined;
  return ctx.toolState.oss ? "allow" : "deny";
}

function dataCollectionPreference(policy: OpenRouterDataCollection | undefined): {
  data_collection?: OpenRouterDataCollection;
} {
  if (!policy) return {};
  return { data_collection: policy };
}

/**
 * The `provider.openrouter` config block: the run's data policy as `extraBody`
 * (the SDK merges it into every request), plus the per-model `options` that
 * carry OpenRouter's `provider` routing object where a model needs its own —
 * Kimi K2 pinned away from the Enforcer-less providers, and the Muse Spark
 * contributor tier opened to data collection whatever the run's policy, since
 * Meta training on the traffic is what that tier is. Sourced from the model
 * registry so an alias/route change in `action/models.ts` flows through.
 *
 * Wiring: the per-model `options` object merges into the request options
 * (opencode `session/llm/request.ts` `mergeOptions(base, model.options)`),
 * gets wrapped under `providerOptions.openrouter` (`provider/transform.ts`
 * `sdkKey("@openrouter/ai-sdk-provider") === "openrouter"`), and the OpenRouter
 * AI-SDK provider spreads everything under `providerOptions.openrouter` into the
 * request body LAST — after `extraBody` — so a per-model `provider` object
 * replaces the run-level one wholesale. that is why the Kimi entry restates
 * the run's `data_collection` beside its `ignore` list.
 */
export function openRouterProvider(policy: OpenRouterDataCollection | undefined): {
  options?: { extraBody: { provider: { data_collection: OpenRouterDataCollection } } };
  models: Record<string, { options: { provider: object } }>;
} {
  const models: Record<string, { options: { provider: object } }> = {};
  for (const alias of modelAliases) {
    const id = alias.openRouterResolve?.replace(/^openrouter\//, "");
    if (!id) continue;
    if (id.endsWith("-contributor")) {
      models[id] = { options: { provider: { data_collection: "allow" } } };
    }
    if (id.includes("kimi")) {
      const provider = { ...dataCollectionPreference(policy), ignore: KIMI_ENFORCERLESS_PROVIDERS };
      models[id] = { options: { provider } };
    }
  }
  if (!policy) return { models };
  return { options: { extraBody: { provider: { data_collection: policy } } }, models };
}

/**
 * Read-only `reviewfrog` subagent for lens-based review. Non-mutative +
 * non-recursive — enforced by the system prompt in reviewer.ts.
 *
 * Per-subagent `model:` override is driven by the registry in
 * `action/models.ts` via each alias's `subagentModel` field. Currently wired:
 * Anthropic opus → sonnet, OpenAI gpt-sol-pro → gpt-sol and gpt-sol → gpt-terra, Google
 * gemini-pro → gemini-flash. Other providers inherit (no override).
 */
export function buildReviewerAgentConfig(
  orchestratorModel: string | undefined
): Record<string, unknown> {
  const overrides = deriveSubagentModels(orchestratorModel);
  return {
    [REVIEWER_AGENT_NAME]: {
      description:
        "Read-only review subagent for lens-based code review (correctness, security, billing-subsystem, etc.). " +
        "Reads only — no writes, no state-changing shell or MCP calls, no nested subagent dispatch.",
      mode: "subagent",
      prompt: REVIEWER_SYSTEM_PROMPT,
      ...(overrides.reviewer !== undefined ? { model: overrides.reviewer } : {}),
    },
  };
}

// ── install ────────────────────────────────────────────────────────────────────

/**
 * Install the run's OpenCode generation from its npm tarball and return the path
 * to the executable: `opencode-ai` for V1, `@opencode/cli` for V2. Both ship the
 * platform binary as `bin/opencode.exe` for every OS via their postinstall.
 */
export async function installOpencodeCli(): Promise<string> {
  const packageName = opencodeGeneration() === 2 ? "@opencode/cli" : "opencode-ai";
  return await installFromNpmTarball({
    packageName,
    version: getDevDependencyVersion(packageName),
    executablePath: "bin/opencode.exe",
    installDependencies: true,
  });
}

// ── model auto-select fallback ──────────────────────────────────────────────────
//
// steps 1–2 of model resolution (PULLFROG_MODEL env, slug resolution) happen
// in resolveModel() in utils/agent.ts before the agent runs. this is step 3:
// auto-select using the authorized model set captured in main.ts via
// `opencode models` introspection.

// the console picker is locked for Router accounts without a payment method —
// exactly the accounts that land here once their wallet runs dry.
const AUTO_SELECT_WARNING =
  "select a model explicitly in the Pullfrog console (https://pullfrog.com/console) to avoid this — " +
  "if the picker is locked, this run had no Pullfrog Router funding: add a card or top up your credit.";

export function autoSelectModel(): string | undefined {
  const authorized = getAuthorizedModels();
  // skip hidden aliases (internal subagent-tier targets like opencode/gpt-5.4)
  // and fallback aliases (deprecated or temporarily unavailable — they must
  // resolve through to their replacement, never run as-is). mirrors the
  // selectable-list filter (`!a.fallback && !a.hidden`) in
  // components/ModelSelector.tsx and action/commands/init.ts.
  // `opencode models` lists a provider's catalog whether or not the run holds
  // that provider's credential, so `authorized` alone is not "servable": a
  // preferred OpenCode Zen alias won auto-select on repos with 43 working
  // OpenRouter models and then died at session start with `No provider
  // available` (#1077). require the credential too — a model with no declared
  // env var stays eligible, so this only excludes candidates we can already
  // see we cannot serve.
  // `routing` joins the filter because a routing alias resolves to a bare
  // `bedrock`/`vertex`/`azure` sentinel only resolveModel can expand.
  const selectable = modelAliases.filter((a) => !a.hidden && !a.fallback && !a.routing);
  const servable = selectable.filter((a) => {
    // `getOpenCodeEnvVars`, not `getModelEnvVars`: a Claude subscription token
    // is an Anthropic credential but not one OPENCODE can present, so counting
    // it here pinned `anthropic/claude-opus-5` on subscription-only accounts
    // and handed it to a harness that dies on `Model not found`.
    const envVars = getOpenCodeEnvVars(a.resolve);
    return envVars.length === 0 || envVars.some((name) => process.env[name]);
  });
  const pick = (list: typeof servable) => list.find((a) => a.preferred) ?? list[0];
  // a catalog hit is the better evidence, but `opencode models` can exit 0 having printed
  // only an alphabetical PREFIX of its catalog (wiki/opencode-catalog-trust.md), so an
  // absent alias is not proof we cannot serve it — same rescue validateAgentApiKey applies.
  // no empty-catalog arm is needed: validateAgentApiKey throws on an empty `authorized`
  // before the agent starts, and a proxyModel run short-circuits before reaching here.
  const match = pick(servable.filter((a) => authorized.has(a.resolve))) ?? pick(servable);
  if (match) {
    log.info(
      `» model: ${match.resolve} (auto-selected${match.preferred ? " — preferred" : ""} curated match)`
    );
    log.warning(`» model auto-selected. ${AUTO_SELECT_WARNING}`);
    return match.resolve;
  }
  log.info(
    `» opencode has ${authorized.size} models but none match curated aliases and none hold a credential — letting OpenCode auto-select: ${[...authorized].join(", ")}`
  );

  log.warning(`» no model resolved. letting OpenCode auto-select. ${AUTO_SELECT_WARNING}`);
  return undefined;
}
