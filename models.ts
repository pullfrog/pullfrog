/**
 * model alias registry.
 *
 * slugs use the format `provider/model-id` (e.g. "anthropic/claude-opus").
 * bump `resolve` when a new model generation ships — the alias (slug) stays stable.
 */

// ── types ──────────────────────────────────────────────────────────────────────

/**
 * routing discriminant for entries whose `resolve` is dynamic — looked up
 * from a separate env var at run time rather than fixed in the catalog.
 *
 * `"bedrock"` means the actual model ID comes from `BEDROCK_MODEL_ID`
 * (an AWS-canonical Bedrock model ID like `us.anthropic.claude-opus-4-7`
 * or `amazon.nova-pro-v1:0`). `"vertex"` means the actual model ID comes
 * from `VERTEX_MODEL_ID` (a Vertex AI model ID like
 * `claude-opus-4-1@20250805` or `gemini-2.5-pro`). enterprise hosted-model
 * customers self-select for version control — silent alias bumps would break
 * compliance review, model-access enrollment, and provisioned-throughput
 * contracts. so the single `bedrock/byok` and `vertex/byok` entries are
 * routing slugs, not model aliases: the harness reads the backend-specific
 * env var and routes to claude-code for Anthropic IDs or opencode for
 * everything else.
 */
export type ModelRouting = "bedrock" | "vertex";

export interface ModelAlias {
  /** stable alias stored in DB, e.g. "anthropic/claude-opus" */
  slug: string;
  /** provider key (matches providers keys) */
  provider: string;
  /** human-readable name shown in dropdowns */
  displayName: string;
  /** concrete models.dev specifier, e.g. "anthropic/claude-opus-4-6". sentinel for routing entries — never passed to a CLI directly. */
  resolve: string;
  /** full models.dev specifier for the OpenRouter equivalent (undefined for free models and routing entries) */
  openRouterResolve: string | undefined;
  /** top-tier pick for this provider — preferred during auto-select */
  preferred: boolean;
  /** whether this alias is free and requires no API key */
  isFree: boolean;
  /** slug of a replacement model — presence implies this model is deprecated */
  fallback: string | undefined;
  /** dynamic-resolution discriminant — see ModelRouting docs */
  routing: ModelRouting | undefined;
  /** alias key (within same provider) of the cheaper sibling reviewfrog should
   * use as its lens-fanout subagent. e.g. claude-opus → "claude-sonnet". */
  subagentModel: string | undefined;
  /** hide from selectable lists (UI dropdowns, CLI pickers). does NOT affect
   * resolution — for that use `fallback`. used for internal-only tier targets
   * (e.g. gpt-5.4 as a subagent target without exposing it to users). */
  hidden: boolean;
}

interface ModelDef {
  displayName: string;
  /** concrete models.dev specifier, e.g. "anthropic/claude-opus-4-6" */
  resolve: string;
  /** full models.dev specifier for the OpenRouter equivalent, e.g. "openrouter/anthropic/claude-opus-4.6" */
  openRouterResolve?: string;
  preferred?: boolean;
  envVars?: readonly string[];
  isFree?: boolean;
  /** slug of a replacement model — presence implies this model is deprecated */
  fallback?: string;
  /** dynamic-resolution discriminant — see ModelRouting docs */
  routing?: ModelRouting;
  /** alias key (within same provider) of the cheaper sibling reviewfrog should
   * use as its lens-fanout subagent (e.g. claude-opus → "claude-sonnet"). */
  subagentModel?: string;
  /** hide from selectable lists. does NOT affect resolution; for that use `fallback`. */
  hidden?: boolean;
}

export interface ProviderConfig {
  displayName: string;
  envVars: readonly string[];
  /** credentials authored only via `pullfrog auth <provider>` — never
   * user-facing in `init`, never documented as a manual GHA secret. counted
   * for hasAnyKey / log-redaction purposes but excluded from any prompt /
   * paste flow. CLI-managed magic. see wiki/codex-auth.md. */
  managedCredentials?: readonly string[];
  models: Record<string, ModelDef>;
}

// ── provider + model definitions ────────────────────────────────────────────────

function provider(config: ProviderConfig): ProviderConfig {
  return config;
}

export const providers = {
  anthropic: provider({
    displayName: "Anthropic",
    envVars: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
    models: {
      // OpenRouter serves claude-fable-5, but models.dev's OpenRouter mirror
      // hasn't indexed it yet (shipped 2026-06-09), so the catalog drift gate
      // can't validate an openRouterResolve. omit it until the mirror catches
      // up; direct BYOK / Claude Code resolves anthropic/claude-fable-5 fine.
      "claude-fable": {
        displayName: "Claude Fable",
        resolve: "anthropic/claude-fable-5",
        preferred: true,
        subagentModel: "claude-sonnet",
      },
      "claude-opus": {
        displayName: "Claude Opus",
        resolve: "anthropic/claude-opus-4-8",
        openRouterResolve: "openrouter/anthropic/claude-opus-4.8",
        subagentModel: "claude-sonnet",
      },
      "claude-sonnet": {
        displayName: "Claude Sonnet",
        resolve: "anthropic/claude-sonnet-4-6",
        openRouterResolve: "openrouter/anthropic/claude-sonnet-4.6",
      },
      "claude-haiku": {
        displayName: "Claude Haiku",
        resolve: "anthropic/claude-haiku-4-5",
        openRouterResolve: "openrouter/anthropic/claude-haiku-4.5",
      },
    },
  }),
  openai: provider({
    displayName: "OpenAI",
    envVars: ["OPENAI_API_KEY"],
    managedCredentials: ["CODEX_AUTH_JSON"],
    models: {
      gpt: {
        displayName: "GPT",
        resolve: "openai/gpt-5.5",
        openRouterResolve: "openrouter/openai/gpt-5.5",
        preferred: true,
        subagentModel: "gpt-5.4",
      },
      "gpt-pro": {
        displayName: "GPT Pro",
        resolve: "openai/gpt-5.5-pro",
        openRouterResolve: "openrouter/openai/gpt-5.5-pro",
        subagentModel: "gpt",
      },
      // hidden subagent target — `gpt` lenses run against this. surfacing
      // it in the picker would just confuse users (it's the prior-flagship,
      // and they already have `gpt` and `gpt-mini` to choose from).
      "gpt-5.4": {
        displayName: "GPT 5.4",
        resolve: "openai/gpt-5.4",
        openRouterResolve: "openrouter/openai/gpt-5.4",
        hidden: true,
      },
      "gpt-mini": {
        displayName: "GPT Mini",
        resolve: "openai/gpt-5.4-mini",
        openRouterResolve: "openrouter/openai/gpt-5.4-mini",
      },
      // legacy aliases — openai unified the codex line into the main GPT family
      // and is shutting down every "-codex" snapshot on 2026-07-23. transparently
      // upgrade existing users via the fallback chain. UI display sites resolve
      // to the terminal alias's label (so dropdown trigger + PR footers show
      // "GPT" / "GPT Mini", not the historical name).
      "gpt-codex": {
        displayName: "GPT Codex",
        resolve: "openai/gpt-5.3-codex",
        openRouterResolve: "openrouter/openai/gpt-5.3-codex",
        fallback: "openai/gpt",
      },
      "gpt-codex-mini": {
        displayName: "GPT Codex Mini",
        resolve: "openai/gpt-5.1-codex-mini",
        openRouterResolve: "openrouter/openai/gpt-5.1-codex-mini",
        fallback: "openai/gpt-mini",
      },
      o3: {
        displayName: "O3",
        resolve: "openai/o3",
        openRouterResolve: "openrouter/openai/o3",
      },
    },
  }),
  google: provider({
    displayName: "Google",
    envVars: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
    models: {
      "gemini-pro": {
        displayName: "Gemini Pro",
        resolve: "google/gemini-3.1-pro-preview",
        openRouterResolve: "openrouter/google/gemini-3.1-pro-preview",
        preferred: true,
        // Inherit (subagents stay on Pro). Google has no in-between tier;
        // dropping to Flash for review work was a meaningful capability cliff
        // (Flash missed the catastrophic camelCase/snake_case mismatch in
        // the v4 e2e test). Pro is cost-effective enough to use for both
        // orchestrator and lenses.
      },
      "gemini-flash": {
        displayName: "Gemini Flash",
        resolve: "google/gemini-3.5-flash",
        openRouterResolve: "openrouter/google/gemini-3.5-flash",
      },
    },
  }),
  xai: provider({
    displayName: "xAI",
    envVars: ["XAI_API_KEY"],
    models: {
      grok: {
        displayName: "Grok",
        resolve: "xai/grok-4.3",
        openRouterResolve: "openrouter/x-ai/grok-4.3",
        preferred: true,
      },
      // legacy aliases — xAI retired the entire fast/code-fast line on
      // 2026-05-15 (https://docs.x.ai/developers/migration/may-15-deprecation)
      // and now redirects every deprecated text-model slug to grok-4.3 at
      // standard pricing. fall back to the live `xai/grok` so the alias
      // chain resolves to grok-4.3 for both direct-key and OpenRouter users.
      "grok-fast": {
        displayName: "Grok Fast",
        resolve: "xai/grok-4-1-fast",
        openRouterResolve: "openrouter/x-ai/grok-4.3",
        fallback: "xai/grok",
      },
      "grok-code-fast": {
        displayName: "Grok Code Fast",
        resolve: "xai/grok-code-fast-1",
        openRouterResolve: "openrouter/x-ai/grok-4.3",
        fallback: "xai/grok",
      },
    },
  }),
  deepseek: provider({
    displayName: "DeepSeek",
    envVars: ["DEEPSEEK_API_KEY"],
    models: {
      "deepseek-pro": {
        displayName: "DeepSeek Pro",
        resolve: "deepseek/deepseek-v4-pro",
        openRouterResolve: "openrouter/deepseek/deepseek-v4-pro",
        preferred: true,
      },
      "deepseek-flash": {
        displayName: "DeepSeek Flash",
        resolve: "deepseek/deepseek-v4-flash",
        openRouterResolve: "openrouter/deepseek/deepseek-v4-flash",
      },
      // legacy aliases — deepseek retires these on 2026-07-24; transparently
      // upgrade existing users to the v4 family via the fallback chain.
      "deepseek-reasoner": {
        displayName: "DeepSeek Reasoner",
        resolve: "deepseek/deepseek-reasoner",
        openRouterResolve: "openrouter/deepseek/deepseek-v3.2",
        fallback: "deepseek/deepseek-pro",
      },
      "deepseek-chat": {
        displayName: "DeepSeek Chat",
        resolve: "deepseek/deepseek-chat",
        openRouterResolve: "openrouter/deepseek/deepseek-v3.2",
        fallback: "deepseek/deepseek-flash",
      },
    },
  }),
  moonshotai: provider({
    displayName: "Moonshot AI",
    envVars: ["MOONSHOT_API_KEY"],
    models: {
      "kimi-k2": {
        displayName: "Kimi K2",
        resolve: "moonshotai/kimi-k2.6",
        openRouterResolve: "openrouter/moonshotai/kimi-k2.6",
        preferred: true,
      },
    },
  }),
  qwen: provider({
    displayName: "Qwen",
    envVars: ["QWEN_API_KEY", "DASHSCOPE_API_KEY", "LLM_API_KEY"],
    models: {
      "qwen-coder": {
        displayName: "Qwen Coder",
        resolve: "qwen/qwen3-coder-plus",
        openRouterResolve: "openrouter/qwen/qwen3-coder-plus",
        preferred: true,
      },
      "qwen-plus": {
        displayName: "Qwen Plus",
        resolve: "qwen/qwen-plus",
        openRouterResolve: "openrouter/qwen/qwen-plus",
      },
      "qwen-max": {
        displayName: "Qwen Max",
        resolve: "qwen/qwen-max",
        openRouterResolve: "openrouter/qwen/qwen3-max",
      },
    },
  }),
  opencode: provider({
    displayName: "OpenCode",
    envVars: ["OPENCODE_API_KEY"],
    models: {
      "big-pickle": {
        displayName: "Big Pickle",
        resolve: "opencode/big-pickle",
        preferred: true,
        envVars: [],
        isFree: true,
      },
      "claude-opus": {
        displayName: "Claude Opus",
        resolve: "opencode/claude-opus-4-8",
        openRouterResolve: "openrouter/anthropic/claude-opus-4.8",
        subagentModel: "claude-sonnet",
      },
      "claude-sonnet": {
        displayName: "Claude Sonnet",
        resolve: "opencode/claude-sonnet-4-6",
        openRouterResolve: "openrouter/anthropic/claude-sonnet-4.6",
      },
      "claude-haiku": {
        displayName: "Claude Haiku",
        resolve: "opencode/claude-haiku-4-5",
        openRouterResolve: "openrouter/anthropic/claude-haiku-4.5",
      },
      gpt: {
        displayName: "GPT",
        resolve: "opencode/gpt-5.5",
        openRouterResolve: "openrouter/openai/gpt-5.5",
        subagentModel: "gpt-5.4",
      },
      "gpt-pro": {
        displayName: "GPT Pro",
        resolve: "opencode/gpt-5.5-pro",
        openRouterResolve: "openrouter/openai/gpt-5.5-pro",
        subagentModel: "gpt",
      },
      // hidden subagent target — see openai provider above for context.
      "gpt-5.4": {
        displayName: "GPT 5.4",
        resolve: "opencode/gpt-5.4",
        openRouterResolve: "openrouter/openai/gpt-5.4",
        hidden: true,
      },
      "gpt-mini": {
        displayName: "GPT Mini",
        resolve: "opencode/gpt-5.4-mini",
        openRouterResolve: "openrouter/openai/gpt-5.4-mini",
      },
      // legacy aliases — see openai provider above for context.
      "gpt-codex": {
        displayName: "GPT Codex",
        resolve: "opencode/gpt-5.3-codex",
        openRouterResolve: "openrouter/openai/gpt-5.3-codex",
        fallback: "opencode/gpt",
      },
      "gpt-codex-mini": {
        displayName: "GPT Codex Mini",
        resolve: "opencode/gpt-5.1-codex-mini",
        openRouterResolve: "openrouter/openai/gpt-5.1-codex-mini",
        fallback: "opencode/gpt-mini",
      },
      "gemini-pro": {
        displayName: "Gemini Pro",
        resolve: "opencode/gemini-3.1-pro",
        openRouterResolve: "openrouter/google/gemini-3.1-pro-preview",
        // Inherit — see google/gemini-pro for rationale.
      },
      "gemini-flash": {
        displayName: "Gemini Flash",
        resolve: "opencode/gemini-3.5-flash",
        openRouterResolve: "openrouter/google/gemini-3.5-flash",
      },
      "kimi-k2": {
        displayName: "Kimi K2",
        resolve: "opencode/kimi-k2.6",
        openRouterResolve: "openrouter/moonshotai/kimi-k2.6",
      },
      "minimax-m2.5": {
        displayName: "MiniMax M2",
        resolve: "opencode/minimax-m2.5",
        openRouterResolve: "openrouter/minimax/minimax-m2.5",
      },
      "gpt-5-nano": {
        displayName: "GPT Nano",
        resolve: "opencode/gpt-5-nano",
        openRouterResolve: "openrouter/openai/gpt-5-nano",
      },
      "mimo-v2-pro-free": {
        displayName: "MiMo V2 Pro",
        resolve: "opencode/mimo-v2-pro-free",
        envVars: [],
        isFree: true,
        fallback: "opencode/big-pickle",
      },
      "minimax-m2.5-free": {
        displayName: "MiniMax M2",
        resolve: "opencode/minimax-m2.5-free",
        envVars: [],
        isFree: true,
        fallback: "opencode/big-pickle",
        hidden: true,
      },
    },
  }),
  "opencode-go": provider({
    displayName: "OpenCode Go",
    envVars: ["OPENCODE_API_KEY"],
    models: {
      "glm-5.1": {
        displayName: "GLM 5.1",
        resolve: "opencode-go/glm-5.1",
        openRouterResolve: "openrouter/z-ai/glm-5.1",
        preferred: true,
      },
    },
  }),
  bedrock: provider({
    displayName: "Amazon Bedrock",
    envVars: ["AWS_BEARER_TOKEN_BEDROCK", "AWS_REGION", "BEDROCK_MODEL_ID"],
    models: {
      // single routing entry — the actual Bedrock model ID is read from
      // BEDROCK_MODEL_ID at run time. see ModelRouting docs for why we
      // don't catalog individual Bedrock models.
      byok: {
        displayName: "Amazon Bedrock",
        resolve: "bedrock",
        routing: "bedrock",
      },
    },
  }),
  vertex: provider({
    displayName: "Google Vertex AI",
    envVars: [
      "VERTEX_SERVICE_ACCOUNT_JSON",
      "GOOGLE_CLOUD_PROJECT",
      "VERTEX_LOCATION",
      "VERTEX_MODEL_ID",
    ],
    models: {
      // single routing entry — the actual Vertex AI model ID is read from
      // VERTEX_MODEL_ID at run time. see ModelRouting docs for why we don't
      // catalog individual Vertex models.
      byok: {
        displayName: "Google Vertex AI",
        resolve: "vertex",
        routing: "vertex",
      },
    },
  }),
  openrouter: provider({
    displayName: "OpenRouter",
    envVars: ["OPENROUTER_API_KEY"],
    models: {
      "claude-opus": {
        displayName: "Claude Opus",
        resolve: "openrouter/~anthropic/claude-opus-latest",
        openRouterResolve: "openrouter/~anthropic/claude-opus-latest",
        preferred: true,
        subagentModel: "claude-sonnet",
      },
      "claude-sonnet": {
        displayName: "Claude Sonnet",
        resolve: "openrouter/~anthropic/claude-sonnet-latest",
        openRouterResolve: "openrouter/~anthropic/claude-sonnet-latest",
      },
      "claude-haiku": {
        displayName: "Claude Haiku",
        resolve: "openrouter/~anthropic/claude-haiku-latest",
        openRouterResolve: "openrouter/~anthropic/claude-haiku-latest",
      },
      gpt: {
        displayName: "GPT",
        resolve: "openrouter/~openai/gpt-latest",
        openRouterResolve: "openrouter/~openai/gpt-latest",
        subagentModel: "gpt-5.4",
      },
      "gpt-pro": {
        displayName: "GPT Pro",
        resolve: "openrouter/openai/gpt-5.5-pro",
        openRouterResolve: "openrouter/openai/gpt-5.5-pro",
        subagentModel: "gpt",
      },
      // hidden subagent target — see openai provider above for context.
      "gpt-5.4": {
        displayName: "GPT 5.4",
        resolve: "openrouter/openai/gpt-5.4",
        openRouterResolve: "openrouter/openai/gpt-5.4",
        hidden: true,
      },
      "gpt-mini": {
        displayName: "GPT Mini",
        resolve: "openrouter/~openai/gpt-mini-latest",
        openRouterResolve: "openrouter/~openai/gpt-mini-latest",
      },
      // legacy aliases — see openai provider for context.
      "gpt-codex": {
        displayName: "GPT Codex",
        resolve: "openrouter/openai/gpt-5.3-codex",
        openRouterResolve: "openrouter/openai/gpt-5.3-codex",
        fallback: "openrouter/gpt",
      },
      "gpt-codex-mini": {
        displayName: "GPT Codex Mini",
        resolve: "openrouter/openai/gpt-5.1-codex-mini",
        openRouterResolve: "openrouter/openai/gpt-5.1-codex-mini",
        fallback: "openrouter/gpt-mini",
      },
      "o4-mini": {
        displayName: "O4 Mini",
        resolve: "openrouter/openai/o4-mini",
        openRouterResolve: "openrouter/openai/o4-mini",
      },
      "gemini-pro": {
        displayName: "Gemini Pro",
        resolve: "openrouter/~google/gemini-pro-latest",
        openRouterResolve: "openrouter/~google/gemini-pro-latest",
        // Inherit — see google/gemini-pro for rationale.
      },
      "gemini-flash": {
        displayName: "Gemini Flash",
        resolve: "openrouter/~google/gemini-flash-latest",
        openRouterResolve: "openrouter/~google/gemini-flash-latest",
      },
      grok: {
        displayName: "Grok",
        resolve: "openrouter/x-ai/grok-4.3",
        openRouterResolve: "openrouter/x-ai/grok-4.3",
      },
      "deepseek-pro": {
        displayName: "DeepSeek Pro",
        resolve: "openrouter/deepseek/deepseek-v4-pro",
        openRouterResolve: "openrouter/deepseek/deepseek-v4-pro",
      },
      "deepseek-flash": {
        displayName: "DeepSeek Flash",
        resolve: "openrouter/deepseek/deepseek-v4-flash",
        openRouterResolve: "openrouter/deepseek/deepseek-v4-flash",
      },
      // legacy alias — deepseek retires this on 2026-07-24; transparently
      // upgrade existing users to the v4 family via the fallback chain.
      "deepseek-chat": {
        displayName: "DeepSeek Chat",
        resolve: "openrouter/deepseek/deepseek-v3.2",
        openRouterResolve: "openrouter/deepseek/deepseek-v3.2",
        fallback: "openrouter/deepseek-flash",
      },
      "kimi-k2": {
        displayName: "Kimi K2",
        resolve: "openrouter/moonshotai/kimi-k2.6",
        openRouterResolve: "openrouter/moonshotai/kimi-k2.6",
      },
      "minimax-m2.5": {
        displayName: "MiniMax M2",
        resolve: "openrouter/minimax/minimax-m2.5",
        openRouterResolve: "openrouter/minimax/minimax-m2.5",
      },
    },
  }),
} satisfies Record<string, ProviderConfig>;

export type ModelProvider = keyof typeof providers;

// ── slug parsing ───────────────────────────────────────────────────────────────

export function parseModel(slug: string): { provider: string; model: string } {
  const slashIdx = slug.indexOf("/");
  if (slashIdx === -1) {
    throw new Error(`invalid model slug "${slug}" — expected "provider/model"`);
  }
  return { provider: slug.slice(0, slashIdx), model: slug.slice(slashIdx + 1) };
}

export function getModelProvider(slug: string): string {
  return parseModel(slug).provider;
}

export function getProviderDisplayName(slug: string): string | undefined {
  const parsed = parseModel(slug);
  return (providers as Record<string, ProviderConfig>)[parsed.provider]?.displayName;
}

export function getModelEnvVars(slug: string): string[] {
  const parsed = parseModel(slug);
  const providerConfig = (providers as Record<string, ProviderConfig>)[parsed.provider];
  if (!providerConfig) {
    return [];
  }

  const modelConfig = providerConfig.models[parsed.model];
  if (modelConfig?.envVars) {
    return modelConfig.envVars.slice();
  }

  return providerConfig.envVars.slice();
}

/** managed credentials are authored only via `pullfrog auth <provider>` — they
 * count as "configured" for hasAnyKey-style UI checks but are never offered as
 * a manual-paste option in `init` or the AgentSettings env-var button row.
 * see `provider.managedCredentials` and wiki/codex-auth.md. */
export function getModelManagedCredentials(slug: string): string[] {
  const parsed = parseModel(slug);
  const providerConfig = (providers as Record<string, ProviderConfig>)[parsed.provider];
  return providerConfig?.managedCredentials?.slice() ?? [];
}

// ── derived flat list ──────────────────────────────────────────────────────────

export const modelAliases: ModelAlias[] = Object.entries(providers).flatMap(
  ([providerKey, config]) =>
    Object.entries(config.models).map(([modelId, def]) => ({
      slug: `${providerKey}/${modelId}`,
      provider: providerKey,
      displayName: def.displayName,
      resolve: def.resolve,
      openRouterResolve: def.openRouterResolve,
      preferred: def.preferred ?? false,
      isFree: def.isFree ?? false,
      fallback: def.fallback,
      routing: def.routing,
      // subagentModel is stored as an alias key local to the provider; expand
      // here to a fully-qualified slug so callers can look up the target alias
      // directly without re-deriving the provider.
      subagentModel: def.subagentModel ? `${providerKey}/${def.subagentModel}` : undefined,
      hidden: def.hidden ?? false,
    }))
);

/** OpenRouter target when Router or OSS funding is active and `repo.model` is null. */
const defaultProxyAlias = modelAliases.find((a) => a.slug === "deepseek/deepseek-pro");
if (!defaultProxyAlias?.openRouterResolve) {
  throw new Error("DEFAULT_PROXY_MODEL: deepseek/deepseek-pro missing openRouterResolve");
}
export const DEFAULT_PROXY_MODEL = defaultProxyAlias.openRouterResolve;
const defaultProxyDisplayName = defaultProxyAlias.displayName;

/** short label for the model auto-select picks today (console hint copy). */
export function getAutoSelectHintModel(): string {
  return defaultProxyDisplayName;
}

// ── resolution ─────────────────────────────────────────────────────────────────

/** resolve a model slug to its concrete models.dev specifier (e.g. "anthropic/claude-opus-4-6") */
export function resolveModelSlug(slug: string): string | undefined {
  return modelAliases.find((a) => a.slug === slug)?.resolve;
}

const MAX_FALLBACK_DEPTH = 10;

/**
 * walk the fallback chain to the terminal (non-deprecated) alias.
 * returns undefined if the chain is broken, exhausted, or cyclic.
 *
 * use this in UI display sites (dropdown trigger labels, PR-comment footers,
 * etc.) so a deprecated stored slug renders as the model the user actually
 * runs against — not the historical name. selectable lists should still hide
 * deprecated and internal-only aliases by filtering on `!a.fallback && !a.hidden`.
 */
export function resolveDisplayAlias(slug: string): ModelAlias | undefined {
  let current = slug;
  const visited = new Set<string>();
  for (let i = 0; i < MAX_FALLBACK_DEPTH; i++) {
    if (visited.has(current)) return undefined;
    visited.add(current);
    const alias = modelAliases.find((a) => a.slug === current);
    if (!alias) return undefined;
    if (!alias.fallback) return alias;
    current = alias.fallback;
  }
  return undefined;
}

/**
 * resolve a model slug to the CLI-ready model string, following the fallback
 * chain when a model is deprecated. returns the first non-deprecated resolve
 * target, or undefined if the chain is exhausted or broken.
 */
export function resolveCliModel(slug: string): string | undefined {
  return resolveDisplayAlias(slug)?.resolve;
}

/**
 * resolve a model slug to the OpenRouter-ready model string, following the
 * fallback chain when a model is deprecated. returns undefined if the chain
 * is exhausted/broken or the terminal alias has no openrouter equivalent
 * (e.g. free opencode models).
 */
export function resolveOpenRouterModel(slug: string): string | undefined {
  return resolveDisplayAlias(slug)?.openRouterResolve;
}

// ── bedrock routing ────────────────────────────────────────────────────────────

/** env var that supplies the Bedrock model ID for the `bedrock/byok` slug. */
export const BEDROCK_MODEL_ID_ENV = "BEDROCK_MODEL_ID";

/** env var that supplies the Vertex AI model ID for the `vertex/byok` slug. */
export const VERTEX_MODEL_ID_ENV = "VERTEX_MODEL_ID";

/**
 * the Bedrock model ID passed to claude-code or opencode is whatever the
 * user set in `BEDROCK_MODEL_ID` — Pullfrog never resolves or upgrades it.
 * we route by checking whether the ID names an Anthropic model: claude-code
 * handles Anthropic-on-Bedrock natively (with `CLAUDE_CODE_USE_BEDROCK=1`),
 * everything else goes through opencode's `amazon-bedrock` provider.
 *
 * AWS Bedrock IDs come in two shapes:
 *   - dotted foundation IDs: `us.anthropic.claude-opus-4-7`,
 *     `anthropic.claude-haiku-4-5-20251001-v1:0`, `amazon.nova-pro-v1:0`,
 *     `meta.llama4-scout-17b-instruct-v1:0`. AWS-published, lowercase, the
 *     foundation provider always appears as a discrete dot-segment.
 *   - inference-profile ARNs: `arn:aws:bedrock:us-east-2:<acct>:application-inference-profile/<user-name>`.
 *     `<user-name>` is operator-chosen, so a naive substring check is fragile
 *     in both directions (Anthropic profile named without "anthropic" → routes
 *     to opencode and misses CLAUDE_CODE_USE_BEDROCK; non-Anthropic profile
 *     whose name happens to contain "anthropic" → routes to claude-code).
 *
 * we anchor on a discrete dot-segment match (case-insensitive). this catches
 * every published foundation ID and is conservative for ARN-form IDs: ARN
 * names that don't include "anthropic" as their own dot-segment route to
 * opencode by default. operators using ARN-form IDs whose backing model is
 * Anthropic should set `PULLFROG_AGENT=claude` to force the right route, or
 * include the foundation segment in the profile name.
 */
export function isBedrockAnthropicId(bedrockModelId: string): boolean {
  // split on `.`, `/`, and `:` so the check works for both dotted foundation
  // IDs (anthropic.* / us.anthropic.*) and ARN-form IDs (where the relevant
  // foundation segment sits between `/` and `.` inside the resource name).
  return bedrockModelId.toLowerCase().split(/[./:]/).includes("anthropic");
}

/**
 * Vertex Anthropic model IDs start with the Claude family name, e.g.
 * `claude-opus-4-1@20250805`. partner-model resource paths can contain the
 * substring "anthropic" elsewhere, so the Bedrock segment check does not
 * transfer — anchor on the model ID prefix instead.
 */
export function isVertexAnthropicId(vertexModelId: string): boolean {
  return /^claude-/i.test(vertexModelId.trim());
}
