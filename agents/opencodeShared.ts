// Shared helpers for the OpenCode agent harnesses (`./opencode.ts` v1 and
// `./opencode_v2.ts` v2). Pure config / model-registry / install glue —
// nothing here touches the NDJSON event loop, which differs between v1 and v2.
//
// Once v1 is deleted post-burn-in this module collapses back into v2; until
// then it keeps both runners synchronized so a config drift can't make v1 a
// silently-broken fallback.

import { modelAliases } from "../models.ts";
import { log } from "../utils/cli.ts";
import { installFromNpmTarball } from "../utils/install.ts";
import { getAuthorizedModels } from "../utils/openCodeModels.ts";
import { getDevDependencyVersion } from "../utils/version.ts";
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

/**
 * Build the `provider.google.models[id].options` map that pins every direct-Google
 * Gemini alias to `thinkingLevel: "high"`. Sourced from the model registry so
 * adding/renaming a Google alias in `action/models.ts` flows through automatically.
 */
export function geminiHighThinkingOverrides(): Record<string, { options: object }> {
  return Object.fromEntries(
    modelAliases
      .filter((a) => a.provider === "google")
      .map((a) => [
        a.resolve.replace(/^google\//, ""),
        { options: { thinkingConfig: { thinkingLevel: "high" } } },
      ])
  );
}

// OpenRouter sub-providers that serve Kimi K2 WITHOUT Moonshot's Enforcer
// (schema-constrained decoding), so they silently drop optional tool-call
// params after the reasoning phase (SGLang #12932). ignoring them keeps Kimi
// on a good route (Fireworks, Novita, etc.). needs upkeep as OpenRouter's
// roster shifts. see wiki/review-approval.md.
const KIMI_ENFORCERLESS_PROVIDERS = ["siliconflow", "together"];

/**
 * Build the `provider.openrouter.models[id].options` map that pins every Kimi
 * K2 OpenRouter alias away from the Enforcer-less providers via OpenRouter's
 * `provider: {ignore:[...]}` routing directive. Sourced from the model registry
 * so a Kimi alias/route change in `action/models.ts` flows through automatically.
 *
 * Wiring: the per-model `options` object merges into the request options
 * (opencode `session/llm/request.ts` `mergeOptions(base, model.options)`),
 * gets wrapped under `providerOptions.openrouter` (`provider/transform.ts`
 * `sdkKey("@openrouter/ai-sdk-provider") === "openrouter"`), and the OpenRouter
 * AI-SDK provider spreads everything under `providerOptions.openrouter` straight
 * into the request body (`@openrouter/ai-sdk-provider` `doStream`/`doGenerate`),
 * so `provider` lands as the top-level routing object OpenRouter expects.
 */
export function kimiOpenRouterProviderOverrides(): Record<string, { options: object }> {
  return Object.fromEntries(
    modelAliases
      .map((a) => a.openRouterResolve)
      .filter((r): r is string => r?.includes("kimi") ?? false)
      .map((r) => [
        r.replace(/^openrouter\//, ""),
        { options: { provider: { ignore: KIMI_ENFORCERLESS_PROVIDERS } } },
      ])
  );
}

/**
 * Build the `provider.openrouter.models[id].options` map that pins the
 * efficient-tier DeepSeek model to high reasoning effort on the OpenRouter
 * route — the funded/OSS default path. The shape must nest under `options`
 * (opencode builds `Model.options` only from the entry's `options` sub-object —
 * `provider.ts` `mergeDeep(existingModel.options, model.options)`) and use a
 * `reasoning` record (the openrouter provider forwards only `usage`/`reasoning`/
 * `promptCacheKey`); a bare `reasoningEffort` sibling is silently dropped.
 * Sourced from the registry so a resolve bump carries the override forward.
 * `high` is the ceiling OpenRouter's unified `reasoning.effort` exposes
 * (low/medium/high); DeepSeek's native `max` is only reachable via a direct
 * DeepSeek key, not the OpenRouter route.
 */
export function deepseekHighEffortOverrides(): Record<
  string,
  { options: { reasoning: { effort: string } } }
> {
  const orModel = modelAliases
    .find((a) => a.slug === "deepseek/deepseek-pro")
    ?.openRouterResolve?.replace(/^openrouter\//, "");
  return orModel ? { [orModel]: { options: { reasoning: { effort: "high" } } } } : {};
}

/** env var carrying an explicit endpoint override, per models.dev Azure provider. */
const AZURE_BASE_URL_ENV: Record<string, string> = {
  azure: "AZURE_BASE_URL",
  "azure-cognitive-services": "AZURE_COGNITIVE_SERVICES_BASE_URL",
};

/**
 * Build the `provider.<azure-provider>.options.baseURL` entries that point the
 * Azure providers at an explicit endpoint.
 *
 * Without this, `@ai-sdk/azure` derives its URL from a resource name as
 * `https://<AZURE_RESOURCE_NAME>.openai.azure.com/openai`, which can't express
 * an AI Foundry / AI Services host, an API Management front door, or an AI
 * gateway. Supplying `baseURL` makes `resourceName` unnecessary — the SDK
 * ignores it once a base URL is set.
 *
 * Wiring: config `provider.<id>.options` is merged over OpenCode's own provider
 * options (`mergeDeep` in opencode `provider/provider.ts`), and `getSDK` reads
 * `options.baseURL` (via `loadBaseURL`) straight into the `createAzure` factory.
 * The provider still has to be *enabled*, which OpenCode does when any of the
 * provider's models.dev env vars is present — `AZURE_API_KEY` alone is enough,
 * so a custom endpoint doesn't need a dummy resource name.
 *
 * The value should carry the `/openai` suffix, matching both the SDK's own
 * resource-name default and OpenCode's `azure-cognitive-services` loader:
 *   https://my-resource.openai.azure.com/openai
 *
 * Returns `{}` when unset, so spreading it into `provider` is a no-op.
 */
export function azureBaseUrlOverrides(): Record<string, { options: { baseURL: string } }> {
  const overrides: Record<string, { options: { baseURL: string } }> = {};
  for (const [providerID, envVar] of Object.entries(AZURE_BASE_URL_ENV)) {
    const baseURL = process.env[envVar]?.trim();
    if (!baseURL) continue;
    overrides[providerID] = { options: { baseURL } };
    log.info(`» ${providerID} endpoint overridden via ${envVar}: ${baseURL}`);
  }
  return overrides;
}

/**
 * Read-only `reviewfrog` subagent for lens-based review. Non-mutative +
 * non-recursive — enforced by the system prompt in reviewer.ts.
 *
 * Per-subagent `model:` override is driven by the registry in
 * `action/models.ts` via each alias's `subagentModel` field. Currently wired:
 * Anthropic opus → sonnet, OpenAI gpt-pro → gpt and gpt → gpt-terra, Google
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
 * Install the opencode-ai npm tarball and return the path to the executable.
 *
 * The bin path differs by version: v1.4.x and earlier shipped `bin/opencode`;
 * v1.14+ renames the platform-specific binary to `bin/opencode.exe` for every
 * OS via the postinstall script. Callers pass the binPath that matches their
 * pinned version so a v1↔v2 swap can't silently install the wrong file.
 */
export async function installOpencodeCli(params: { binPath: string }): Promise<string> {
  return await installFromNpmTarball({
    packageName: "opencode-ai",
    version: getDevDependencyVersion("opencode-ai"),
    executablePath: params.binPath,
    installDependencies: true,
  });
}

// ── model auto-select fallback ──────────────────────────────────────────────────
//
// steps 1–2 of model resolution (PULLFROG_MODEL env, slug resolution) happen
// in resolveModel() in utils/agent.ts before the agent runs. this is step 3:
// auto-select using the authorized model set captured in main.ts via
// `opencode models` introspection.

const AUTO_SELECT_WARNING =
  "select a model explicitly in the Pullfrog console (https://pullfrog.com/console) to avoid this.";

export function autoSelectModel(): string | undefined {
  const authorized = getAuthorizedModels();
  if (authorized.size > 0) {
    // skip hidden aliases (internal subagent-tier targets like opencode/gpt-5.4)
    // and fallback aliases (deprecated or temporarily unavailable — they must
    // resolve through to their replacement, never run as-is). mirrors the
    // selectable-list filter (`!a.fallback && !a.hidden`) in
    // components/ModelSelector.tsx and action/commands/init.ts.
    const match =
      modelAliases.find(
        (a) => !a.hidden && !a.fallback && a.preferred && authorized.has(a.resolve)
      ) ?? modelAliases.find((a) => !a.hidden && !a.fallback && authorized.has(a.resolve));
    if (match) {
      log.info(
        `» model: ${match.resolve} (auto-selected${match.preferred ? " — preferred" : ""} curated match)`
      );
      log.warning(`» model auto-selected. ${AUTO_SELECT_WARNING}`);
      return match.resolve;
    }
    log.info(
      `» opencode has ${authorized.size} models but none match curated aliases — letting OpenCode auto-select`
    );
  }

  log.warning(`» no model resolved. letting OpenCode auto-select. ${AUTO_SELECT_WARNING}`);
  return undefined;
}
