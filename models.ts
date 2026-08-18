/**
 * model alias registry.
 *
 * slugs use the format `provider/model-id` (e.g. "anthropic/claude-opus").
 * bump `resolve` when a new model generation ships — the alias (slug) stays stable.
 */

import { type EffortPosition, resolveRung } from "./effort.ts";

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
 *
 * `"azure"` is the same shape for a different reason. models.dev DOES carry an
 * Azure catalog, but the id it lists is sent to Azure as the DEPLOYMENT NAME,
 * and a deployment is named by whoever created it — so cataloging `azure/gpt-5`
 * would only work for customers who kept the portal's default name. the
 * deployment comes from `AZURE_DEPLOYMENT` instead. unlike bedrock/vertex it
 * resolves to a provider-PREFIXED specifier (`azure/<deployment>`), matching
 * openai-compatible, because `azure` is a real opencode provider id.
 */
export type ModelRouting = "bedrock" | "vertex" | "openai-compatible" | "azure";

export interface ModelAlias {
  /** stable alias stored in DB, e.g. "anthropic/claude-opus" */
  slug: string;
  /** provider key (matches providers keys) */
  provider: string;
  /** human-readable name shown in dropdowns */
  displayName: string;
  /** optional one-line picker sub-label clarifying what the alias is (e.g.
   * gpt-pro = "Maximum reasoning effort"). undefined for most aliases. */
  description: string | undefined;
  /** concrete models.dev specifier, e.g. "anthropic/claude-opus-4-6". sentinel for routing entries — never passed to a CLI directly. */
  resolve: string;
  /** full models.dev specifier for the OpenRouter equivalent (undefined for free models and routing entries) */
  openRouterResolve: string | undefined;
  /** top-tier pick for this provider — preferred during auto-select */
  preferred: boolean;
  /** whether this alias costs nothing to run. NOT the same as needing no
   * credential: Zen's free models still require `OPENCODE_API_KEY`, and reading
   * this as "keyless" is what let a keyless run boot onto one and die with
   * `No provider available` (#1077). used to skip the proxy mint. */
  isFree: boolean;
  /** slug of a replacement model to resolve through. presence means this alias
   * never runs as-is — resolution redirects to the replacement and it's hidden
   * from pickers. covers permanent deprecation AND riding out a temporarily
   * unavailable model: point it at a cheaper tier (downgrade) or a working
   * sibling/higher tier (upgrade), then clear it when the model returns. */
  fallback: string | undefined;
  /** dynamic-resolution discriminant — see ModelRouting docs */
  routing: ModelRouting | undefined;
  /** alias key (within same provider) of the cheaper sibling reviewfrog should
   * use as its lens-fanout subagent. e.g. claude-opus → "claude-sonnet". */
  subagentModel: string | undefined;
  /** reasoning-effort rungs this model accepts on the direct route, ascending.
   * mirrors models.dev `reasoning_options[type=effort].values`. undefined means
   * the model has no effort control and the setting is a documented no-op. */
  effort: readonly string[] | undefined;
  /** effort rungs on the OpenRouter route, when they differ from `effort` (the
   * DeepSeek/GLM top rung is `max` natively but `xhigh` via OpenRouter).
   * undefined falls back to `effort`. */
  openRouterEffort: readonly string[] | undefined;
  /** hide from selectable lists (UI dropdowns, CLI pickers). does NOT affect
   * resolution — for that use `fallback`. used to keep a redundant alias out of
   * pickers (e.g. the free `minimax-m2.5-free` duplicate). */
  hidden: boolean;
}

interface ModelDef {
  displayName: string;
  /** optional one-line picker sub-label (e.g. "Maximum reasoning effort"). */
  description?: string;
  /** concrete models.dev specifier, e.g. "anthropic/claude-opus-4-6" */
  resolve: string;
  /** full models.dev specifier for the OpenRouter equivalent, e.g. "openrouter/anthropic/claude-opus-4.6" */
  openRouterResolve?: string;
  preferred?: boolean;
  envVars?: readonly string[];
  isFree?: boolean;
  /** slug of a replacement model to resolve through — permanent deprecation or
   * temporary unavailability (downgrade/upgrade until the model returns). see
   * ModelAlias.fallback. */
  fallback?: string;
  /** dynamic-resolution discriminant — see ModelRouting docs */
  routing?: ModelRouting;
  /** alias key (within same provider) of the cheaper sibling reviewfrog should
   * use as its lens-fanout subagent (e.g. claude-opus → "claude-sonnet"). */
  subagentModel?: string;
  /** effort rungs accepted on the direct route, ascending — see ModelAlias.effort */
  effort?: readonly string[];
  /** effort rungs on the OpenRouter route when they differ — see ModelAlias.openRouterEffort */
  openRouterEffort?: readonly string[];
  /** hide from selectable lists. does NOT affect resolution; for that use `fallback`. */
  hidden?: boolean;
}

export interface ProviderConfig {
  displayName: string;
  /** whether this provider's models can be driven by the DeepSeek Harness
   * (dsh) harness. the single source of truth for the "auto" selection rule
   * and the explicit-agent compatibility gate in utils/agent.ts: a model
   * whose provider is not marked here can never run on dsh. today only
   * deepseek is marked; the OpenRouter route is resolved separately by
   * isDshCompatibleModel unwrapping the openrouter/ prefix. */
  dshCapable?: boolean;
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
      // claude-fable-5 is selectable but not recommended/auto-selected — it's
      // moving to usage-credits-only billing and isn't broadly available yet, so
      // opus stays the universally-available flagship, the AUTO_INTELLIGENT tier
      // target, and the recommended pick. an explicit fable pick hits the real
      // API and is access-gated: it errors for accounts without access today and
      // just works once usage credits are live — no silent opus fallback, the
      // API is the source of truth (#959).
      "claude-fable": {
        displayName: "Claude Fable",
        resolve: "anthropic/claude-fable-5",
        effort: ["low", "medium", "high", "xhigh", "max"],
        // rolling alias: models.dev's OpenRouter mirror lags brand-new pinned
        // versions (claude-fable-5 isn't indexed yet), so track ~…-latest to
        // stay catalog-valid and auto-follow version bumps.
        openRouterResolve: "openrouter/~anthropic/claude-fable-latest",
        subagentModel: "claude-sonnet",
      },
      "claude-opus": {
        displayName: "Claude Opus",
        resolve: "anthropic/claude-opus-5",
        effort: ["low", "medium", "high", "xhigh", "max"],
        openRouterResolve: "openrouter/anthropic/claude-opus-5",
        preferred: true,
        subagentModel: "claude-sonnet",
      },
      "claude-sonnet": {
        displayName: "Claude Sonnet",
        resolve: "anthropic/claude-sonnet-5",
        effort: ["low", "medium", "high", "xhigh", "max"],
        openRouterResolve: "openrouter/anthropic/claude-sonnet-5",
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
      // Sol/Terra/Luna are OpenAI's durable capability tiers, so they ARE the
      // brand-tier names the slug convention asks for — the pre-5.6 `gpt` /
      // `gpt-pro` / `gpt-mini` slugs are holdovers from the retired GPT / GPT Pro
      // / GPT Mini tiering and are carried below as deprecated aliases.
      "gpt-sol": {
        displayName: "GPT Sol",
        resolve: "openai/gpt-5.6-sol",
        effort: ["none", "low", "medium", "high", "xhigh", "max"],
        openRouterResolve: "openrouter/openai/gpt-5.6-sol",
        preferred: true,
        subagentModel: "gpt-terra",
      },
      // Sol served at reasoning.mode=pro — same $/token as Sol, just more tokens
      // burned; not a pricier premium tier. models.dev has no -pro id, so direct-key
      // (BYOK) resolves to plain Sol; only the Router/OpenRouter path gets sol-pro.
      "gpt-sol-pro": {
        displayName: "GPT Sol Pro",
        description: "Maximum reasoning effort",
        resolve: "openai/gpt-5.6-sol",
        effort: ["none", "low", "medium", "high", "xhigh", "max"],
        openRouterResolve: "openrouter/openai/gpt-5.6-sol-pro",
        subagentModel: "gpt-sol",
      },
      // gpt-5.6's balanced mid-tier. selectable on its own and doubles as Sol's
      // cheaper lens-fanout subagent — replaces the old hidden gpt-5.4 target.
      "gpt-terra": {
        displayName: "GPT Terra",
        resolve: "openai/gpt-5.6-terra",
        effort: ["none", "low", "medium", "high", "xhigh", "max"],
        openRouterResolve: "openrouter/openai/gpt-5.6-terra",
      },
      "gpt-luna": {
        displayName: "GPT Luna",
        resolve: "openai/gpt-5.6-luna",
        effort: ["none", "low", "medium", "high", "xhigh", "max"],
        openRouterResolve: "openrouter/openai/gpt-5.6-luna",
      },
      // legacy aliases — openai unified the codex line into the main GPT family
      // and is shutting down every "-codex" snapshot on 2026-07-23. transparently
      // upgrade existing users via the fallback chain. UI display sites resolve
      // to the terminal alias's label (so dropdown trigger + PR footers show
      // "GPT Sol" / "GPT Luna", not the historical name).
      "gpt-codex": {
        displayName: "GPT Codex",
        resolve: "openai/gpt-5.3-codex",
        openRouterResolve: "openrouter/openai/gpt-5.3-codex",
        fallback: "openai/gpt-sol",
      },
      "gpt-codex-mini": {
        displayName: "GPT Codex Mini",
        resolve: "openai/gpt-5.1-codex-mini",
        openRouterResolve: "openrouter/openai/gpt-5.1-codex-mini",
        fallback: "openai/gpt-luna",
      },
      // pre-5.6 tier slugs. the tiers themselves were renamed Sol/Sol Pro/Luna,
      // so these fold forward rather than describing anything that still runs.
      gpt: {
        displayName: "GPT",
        resolve: "openai/gpt-5.6-sol",
        openRouterResolve: "openrouter/openai/gpt-5.6-sol",
        fallback: "openai/gpt-sol",
      },
      "gpt-pro": {
        displayName: "GPT Pro",
        resolve: "openai/gpt-5.6-sol",
        openRouterResolve: "openrouter/openai/gpt-5.6-sol-pro",
        fallback: "openai/gpt-sol-pro",
      },
      "gpt-mini": {
        displayName: "GPT Mini",
        resolve: "openai/gpt-5.6-luna",
        openRouterResolve: "openrouter/openai/gpt-5.6-luna",
        fallback: "openai/gpt-luna",
      },
      // dropped hidden subagent tier — folds stored pins forward to Sol.
      "gpt-5.4": {
        displayName: "GPT 5.4",
        resolve: "openai/gpt-5.4",
        openRouterResolve: "openrouter/openai/gpt-5.4",
        fallback: "openai/gpt-sol",
      },
      o3: {
        displayName: "O3",
        resolve: "openai/o3",
        effort: ["low", "medium", "high"],
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
        effort: ["low", "medium", "high"],
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
        resolve: "google/gemini-3.6-flash",
        effort: ["minimal", "low", "medium", "high"],
        openRouterResolve: "openrouter/google/gemini-3.6-flash",
      },
    },
  }),
  xai: provider({
    displayName: "xAI",
    envVars: ["XAI_API_KEY"],
    models: {
      grok: {
        displayName: "Grok",
        resolve: "xai/grok-4.5",
        effort: ["low", "medium", "high"],
        openRouterResolve: "openrouter/x-ai/grok-4.5",
        preferred: true,
      },
      // legacy aliases — xAI retired the entire fast/code-fast line on
      // 2026-05-15 (https://docs.x.ai/developers/migration/may-15-deprecation)
      // and now redirects every deprecated text-model slug to grok-4.3 at
      // standard pricing. fall back to the live `xai/grok` so the alias
      // chain resolves to grok-4.5 for both direct-key and OpenRouter users.
      "grok-fast": {
        displayName: "Grok Fast",
        resolve: "xai/grok-4-1-fast",
        openRouterResolve: "openrouter/x-ai/grok-4.5",
        fallback: "xai/grok",
      },
      "grok-code-fast": {
        displayName: "Grok Code Fast",
        resolve: "xai/grok-code-fast-1",
        openRouterResolve: "openrouter/x-ai/grok-4.5",
        fallback: "xai/grok",
      },
    },
  }),
  deepseek: provider({
    displayName: "DeepSeek",
    dshCapable: true,
    envVars: ["DEEPSEEK_API_KEY"],
    models: {
      // same fork trap as `deepseek-flash` below, and Pro fell into it on
      // 2026-08-12: OpenRouter forked the 0813 release into its own id and left
      // the April preview live under the unversioned one at 2.7x the input and
      // 27x the CACHE-READ rate ($1.168/$2.336/$0.09855 vs
      // $0.435/$0.87/$0.003625). the direct route upgraded in place, so only the
      // OpenRouter side was stale — and that side is what OSS and Router runs
      // use. measured: $0.1719/run authoritative against the funded default's
      // $0.0405. there is no `~deepseek/*-pro-latest` pointer to track, so this
      // one has to be a dated pin; the `models-catalog` drift test is what
      // catches the next release.
      "deepseek-pro": {
        displayName: "DeepSeek Pro",
        resolve: "deepseek/deepseek-v4-pro",
        effort: ["high", "max"],
        openRouterEffort: ["low", "high", "max"],
        openRouterResolve: "openrouter/deepseek/deepseek-v4-pro-0813",
        preferred: true,
      },
      // DeepSeek upgrades the `deepseek-v4-flash` API model in place, so the
      // direct `resolve` needs no version. OpenRouter instead forked the 0731
      // release into its own id and left the April preview live under the
      // unversioned one at a HIGHER price ($0.14/$0.28 vs $0.09/$0.18) — so the
      // OpenRouter route can never use the bare id. it tracks the rolling
      // `~deepseek/*-latest` pointer (rule 4), which follows the next in-place
      // upgrade on its own rather than pinning a dated snapshot that goes stale
      // every release. that pointer is NOT priced like 0731 — its listed rates
      // run +40% on output and +57.5% on cache read, and it costs 12% more per
      // run on authoritative spend ($0.0405 vs $0.0361). kept anyway: ~$45/yr
      // buys auto-following the upgrade, and the listed gap overstates the real
      // one because a rolling alias prices at its routing ceiling.
      // 0731 gained a `low` rung and renamed the top to `max`, and that ladder
      // now reads the same on BOTH routes — the in-place direct upgrade caught
      // up to the fork. so `low`, not `high`, is position 0 either way, which is
      // why the OSS effort floor in `main.ts` pins the `high` rung by name. Pro
      // is the same shape via OpenRouter since 0813; only its direct route still
      // starts at `high`.
      "deepseek-flash": {
        displayName: "DeepSeek Flash",
        resolve: "deepseek/deepseek-v4-flash",
        effort: ["low", "high", "max"],
        openRouterEffort: ["low", "high", "max"],
        openRouterResolve: "openrouter/~deepseek/deepseek-v4-flash-latest",
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
      // Moonshot's premium 1M-context multimodal reasoning flagship — pricier
      // than K2.7-code, so it's the preferred BYOK pick but NOT the subsidized
      // efficient default (that stays K2 via AUTO_EFFICIENT).
      "kimi-k3": {
        displayName: "Kimi K3",
        resolve: "moonshotai/kimi-k3",
        effort: ["low", "high", "max"],
        openRouterResolve: "openrouter/moonshotai/kimi-k3",
        preferred: true,
        subagentModel: "kimi-k2",
      },
      "kimi-k2": {
        displayName: "Kimi K2",
        resolve: "moonshotai/kimi-k2.7-code",
        openRouterResolve: "openrouter/moonshotai/kimi-k2.7-code",
      },
    },
  }),
  opencode: provider({
    displayName: "OpenCode Zen",
    envVars: ["OPENCODE_API_KEY"],
    models: {
      "big-pickle": {
        displayName: "Big Pickle",
        resolve: "opencode/big-pickle",
        preferred: true,
        // free to RUN, but Zen still refuses it without a key — a keyless run
        // dies at session start with `No provider available`. the `envVars: []`
        // override that used to sit here shadowed the provider's own
        // `OPENCODE_API_KEY` and made every static gate wave it through (#1077).
        // `isFree` stays: it is what skips the proxy mint in run-context, and
        // the model does cost nothing.
        isFree: true,
      },
      "claude-opus": {
        displayName: "Claude Opus",
        resolve: "opencode/claude-opus-5",
        effort: ["low", "medium", "high", "xhigh", "max"],
        openRouterResolve: "openrouter/anthropic/claude-opus-5",
        subagentModel: "claude-sonnet",
      },
      "claude-sonnet": {
        displayName: "Claude Sonnet",
        resolve: "opencode/claude-sonnet-5",
        effort: ["low", "medium", "high", "xhigh", "max"],
        openRouterResolve: "openrouter/anthropic/claude-sonnet-5",
      },
      "claude-haiku": {
        displayName: "Claude Haiku",
        resolve: "opencode/claude-haiku-4-5",
        openRouterResolve: "openrouter/anthropic/claude-haiku-4.5",
      },
      "gpt-sol": {
        displayName: "GPT Sol",
        resolve: "opencode/gpt-5.6-sol",
        effort: ["none", "low", "medium", "high", "xhigh", "max"],
        openRouterResolve: "openrouter/openai/gpt-5.6-sol",
        subagentModel: "gpt-terra",
      },
      // see openai/gpt-sol-pro — Zen has no -pro id, so direct resolves to plain Sol.
      "gpt-sol-pro": {
        displayName: "GPT Sol Pro",
        description: "Maximum reasoning effort",
        resolve: "opencode/gpt-5.6-sol",
        effort: ["none", "low", "medium", "high", "xhigh", "max"],
        openRouterResolve: "openrouter/openai/gpt-5.6-sol-pro",
        subagentModel: "gpt-sol",
      },
      // gpt-5.6 balanced mid-tier — selectable + Sol's subagent. see openai above.
      "gpt-terra": {
        displayName: "GPT Terra",
        resolve: "opencode/gpt-5.6-terra",
        effort: ["none", "low", "medium", "high", "xhigh", "max"],
        openRouterResolve: "openrouter/openai/gpt-5.6-terra",
      },
      "gpt-luna": {
        displayName: "GPT Luna",
        resolve: "opencode/gpt-5.6-luna",
        effort: ["none", "low", "medium", "high", "xhigh", "max"],
        openRouterResolve: "openrouter/openai/gpt-5.6-luna",
      },
      // legacy aliases — see openai provider above for context.
      "gpt-codex": {
        displayName: "GPT Codex",
        resolve: "opencode/gpt-5.3-codex",
        openRouterResolve: "openrouter/openai/gpt-5.3-codex",
        fallback: "opencode/gpt-sol",
      },
      "gpt-codex-mini": {
        displayName: "GPT Codex Mini",
        resolve: "opencode/gpt-5.1-codex-mini",
        openRouterResolve: "openrouter/openai/gpt-5.1-codex-mini",
        fallback: "opencode/gpt-luna",
      },
      // pre-5.6 tier slugs — see openai provider above.
      gpt: {
        displayName: "GPT",
        resolve: "opencode/gpt-5.6-sol",
        openRouterResolve: "openrouter/openai/gpt-5.6-sol",
        fallback: "opencode/gpt-sol",
      },
      "gpt-pro": {
        displayName: "GPT Pro",
        resolve: "opencode/gpt-5.6-sol",
        openRouterResolve: "openrouter/openai/gpt-5.6-sol-pro",
        fallback: "opencode/gpt-sol-pro",
      },
      "gpt-mini": {
        displayName: "GPT Mini",
        resolve: "opencode/gpt-5.6-luna",
        openRouterResolve: "openrouter/openai/gpt-5.6-luna",
        fallback: "opencode/gpt-luna",
      },
      // dropped hidden subagent tier — folds stored pins forward to Sol.
      "gpt-5.4": {
        displayName: "GPT 5.4",
        resolve: "opencode/gpt-5.4",
        openRouterResolve: "openrouter/openai/gpt-5.4",
        fallback: "opencode/gpt-sol",
      },
      "gemini-pro": {
        displayName: "Gemini Pro",
        resolve: "opencode/gemini-3.1-pro",
        effort: ["low", "medium", "high"],
        openRouterResolve: "openrouter/google/gemini-3.1-pro-preview",
        // Inherit — see google/gemini-pro for rationale.
      },
      "gemini-flash": {
        displayName: "Gemini Flash",
        resolve: "opencode/gemini-3.6-flash",
        effort: ["minimal", "low", "medium", "high"],
        openRouterResolve: "openrouter/google/gemini-3.6-flash",
      },
      "kimi-k2": {
        displayName: "Kimi K2",
        resolve: "opencode/kimi-k2.7-code",
        openRouterResolve: "openrouter/moonshotai/kimi-k2.7-code",
      },
      // slug pins the m2 line for DB stability; resolve tracks the current m2.7.
      "minimax-m2.5": {
        displayName: "MiniMax M2",
        resolve: "opencode/minimax-m2.7",
        openRouterResolve: "openrouter/minimax/minimax-m2.7",
      },
      "gpt-5-nano": {
        displayName: "GPT Nano",
        resolve: "opencode/gpt-5-nano",
        effort: ["minimal", "low", "medium", "high"],
        openRouterResolve: "openrouter/openai/gpt-5-nano",
      },
      "mimo-v2-pro-free": {
        displayName: "MiMo V2 Pro",
        resolve: "opencode/mimo-v2-pro-free",
        // free to run, still gated on the provider's own OPENCODE_API_KEY —
        // see the big-pickle note above (#1077).
        isFree: true,
        fallback: "opencode/big-pickle",
      },
      "minimax-m2.5-free": {
        displayName: "MiniMax M2",
        resolve: "opencode/minimax-m2.5-free",
        // free to run, still gated on the provider's own OPENCODE_API_KEY —
        // see the big-pickle note above (#1077).
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
        displayName: "GLM 5.2",
        resolve: "opencode-go/glm-5.2",
        effort: ["high", "max"],
        openRouterEffort: ["high", "xhigh"],
        openRouterResolve: "openrouter/z-ai/glm-5.2",
        preferred: true,
      },
      "kimi-k2": {
        displayName: "Kimi K2",
        resolve: "opencode-go/kimi-k2.7-code",
        openRouterResolve: "openrouter/moonshotai/kimi-k2.7-code",
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
  azure: provider({
    displayName: "Azure OpenAI",
    // the resource name is half the endpoint URL and the deployment is the model
    // id, so both are as load-bearing as the key. only the key is sensitive.
    envVars: ["AZURE_API_KEY", "AZURE_RESOURCE_NAME", "AZURE_DEPLOYMENT"],
    models: {
      // single routing entry — the real model is the customer's deployment name,
      // read from AZURE_DEPLOYMENT at run time. see ModelRouting docs for why
      // Azure can't be cataloged even though models.dev lists it.
      byok: {
        displayName: "Azure OpenAI",
        resolve: "azure",
        routing: "azure",
      },
    },
  }),
  "openai-compatible": provider({
    // "Custom" is the picker group, "OpenAI-compatible" the entry under it, so the
    // menu reads `Custom › OpenAI-compatible` and a second custom backend (a
    // different wire format, say) slots in beside it without a rename. the
    // provider KEY stays `openai-compatible` — it's the stored slug and the
    // `OPENAI_COMPATIBLE_*` env prefix, so this is display-only.
    displayName: "Custom",
    // bring-your-own generic OpenAI-compatible endpoint — Cloudflare AI Gateway,
    // Alibaba DashScope, self-hosted vLLM, or any compatible gateway. base URL +
    // key + model ID are all supplied via env; nothing is cataloged or bumped.
    // the two token limits are deliberately absent: this list is the auth
    // heuristic (`hasPullfrogStoredAuthForModel`, `validateAgentApiKey`), and a
    // stored context number is config, not proof of a key. the console picks
    // them up from `PROVIDER_EXTRA_SECRET_NAMES` instead.
    envVars: ["OPENAI_COMPATIBLE_BASE_URL", "OPENAI_COMPATIBLE_API_KEY", "OPENAI_COMPATIBLE_MODEL"],
    models: {
      // single routing entry — the actual model ID is read from
      // OPENAI_COMPATIBLE_MODEL at run time and the provider is materialized
      // via `@ai-sdk/openai-compatible`.
      byok: {
        displayName: "OpenAI-compatible",
        resolve: "openai-compatible",
        routing: "openai-compatible",
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
        effort: ["low", "medium", "high", "xhigh", "max"],
        openRouterResolve: "openrouter/~anthropic/claude-opus-latest",
        preferred: true,
        subagentModel: "claude-sonnet",
      },
      "claude-sonnet": {
        displayName: "Claude Sonnet",
        resolve: "openrouter/~anthropic/claude-sonnet-latest",
        effort: ["low", "medium", "high", "xhigh", "max"],
        openRouterResolve: "openrouter/~anthropic/claude-sonnet-latest",
      },
      "claude-haiku": {
        displayName: "Claude Haiku",
        resolve: "openrouter/~anthropic/claude-haiku-latest",
        openRouterResolve: "openrouter/~anthropic/claude-haiku-latest",
      },
      // pinned to the explicit gpt-5.6 tiers (not the ~openai/gpt-latest rolling
      // alias): after the Sol/Terra/Luna rename, ~gpt-mini-latest no longer maps
      // to Luna, so rolling aliases would silently diverge `gpt`/`gpt-mini` from
      // the chosen tiers across funding paths.
      "gpt-sol": {
        displayName: "GPT Sol",
        resolve: "openrouter/openai/gpt-5.6-sol",
        effort: ["none", "low", "medium", "high", "xhigh", "max"],
        openRouterResolve: "openrouter/openai/gpt-5.6-sol",
        subagentModel: "gpt-terra",
      },
      // see openai/gpt-sol-pro. openrouter serves sol-pro directly on both routes.
      "gpt-sol-pro": {
        displayName: "GPT Sol Pro",
        description: "Maximum reasoning effort",
        resolve: "openrouter/openai/gpt-5.6-sol-pro",
        effort: ["none", "low", "medium", "high", "xhigh", "max"],
        openRouterResolve: "openrouter/openai/gpt-5.6-sol-pro",
        subagentModel: "gpt-sol",
      },
      // gpt-5.6 balanced mid-tier — selectable + Sol's subagent. see openai above.
      "gpt-terra": {
        displayName: "GPT Terra",
        resolve: "openrouter/openai/gpt-5.6-terra",
        effort: ["none", "low", "medium", "high", "xhigh", "max"],
        openRouterResolve: "openrouter/openai/gpt-5.6-terra",
      },
      "gpt-luna": {
        displayName: "GPT Luna",
        resolve: "openrouter/openai/gpt-5.6-luna",
        effort: ["none", "low", "medium", "high", "xhigh", "max"],
        openRouterResolve: "openrouter/openai/gpt-5.6-luna",
      },
      // legacy aliases — see openai provider for context.
      "gpt-codex": {
        displayName: "GPT Codex",
        resolve: "openrouter/openai/gpt-5.3-codex",
        openRouterResolve: "openrouter/openai/gpt-5.3-codex",
        fallback: "openrouter/gpt-sol",
      },
      "gpt-codex-mini": {
        displayName: "GPT Codex Mini",
        resolve: "openrouter/openai/gpt-5.1-codex-mini",
        openRouterResolve: "openrouter/openai/gpt-5.1-codex-mini",
        fallback: "openrouter/gpt-luna",
      },
      // pre-5.6 tier slugs — see openai provider above.
      gpt: {
        displayName: "GPT",
        resolve: "openrouter/openai/gpt-5.6-sol",
        openRouterResolve: "openrouter/openai/gpt-5.6-sol",
        fallback: "openrouter/gpt-sol",
      },
      "gpt-pro": {
        displayName: "GPT Pro",
        resolve: "openrouter/openai/gpt-5.6-sol-pro",
        openRouterResolve: "openrouter/openai/gpt-5.6-sol-pro",
        fallback: "openrouter/gpt-sol-pro",
      },
      "gpt-mini": {
        displayName: "GPT Mini",
        resolve: "openrouter/openai/gpt-5.6-luna",
        openRouterResolve: "openrouter/openai/gpt-5.6-luna",
        fallback: "openrouter/gpt-luna",
      },
      // dropped hidden subagent tier — folds stored pins forward to Sol.
      "gpt-5.4": {
        displayName: "GPT 5.4",
        resolve: "openrouter/openai/gpt-5.4",
        openRouterResolve: "openrouter/openai/gpt-5.4",
        fallback: "openrouter/gpt-sol",
      },
      "o4-mini": {
        displayName: "O4 Mini",
        resolve: "openrouter/openai/o4-mini",
        effort: ["low", "medium", "high"],
        openRouterResolve: "openrouter/openai/o4-mini",
      },
      "gemini-pro": {
        displayName: "Gemini Pro",
        resolve: "openrouter/~google/gemini-pro-latest",
        effort: ["low", "medium", "high"],
        openRouterResolve: "openrouter/~google/gemini-pro-latest",
        // Inherit — see google/gemini-pro for rationale.
      },
      "gemini-flash": {
        displayName: "Gemini Flash",
        resolve: "openrouter/~google/gemini-flash-latest",
        // no `minimal` here, unlike the google/ and opencode/ entries for the
        // same model: OpenRouter's floating `~google/gemini-flash-latest` stopped
        // publishing that rung. mirroring it is not cosmetic — claude-code
        // hard-errors on an out-of-range `--effort` before it calls the API.
        effort: ["low", "medium", "high"],
        openRouterResolve: "openrouter/~google/gemini-flash-latest",
      },
      grok: {
        displayName: "Grok",
        resolve: "openrouter/x-ai/grok-4.5",
        effort: ["low", "medium", "high"],
        openRouterResolve: "openrouter/x-ai/grok-4.5",
      },
      // dated pin, not the bare id — see `deepseek/deepseek-pro` for why
      // OpenRouter's unversioned `deepseek-v4-pro` is the stale April preview.
      "deepseek-pro": {
        displayName: "DeepSeek Pro",
        resolve: "openrouter/deepseek/deepseek-v4-pro-0813",
        effort: ["low", "high", "max"],
        openRouterResolve: "openrouter/deepseek/deepseek-v4-pro-0813",
      },
      // rolling pointer, not the bare id — see `deepseek/deepseek-flash` for why
      // OpenRouter's unversioned `deepseek-v4-flash` is the stale April preview.
      "deepseek-flash": {
        displayName: "DeepSeek Flash",
        resolve: "openrouter/~deepseek/deepseek-v4-flash-latest",
        effort: ["low", "high", "max"],
        openRouterResolve: "openrouter/~deepseek/deepseek-v4-flash-latest",
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
        resolve: "openrouter/moonshotai/kimi-k2.7-code",
        openRouterResolve: "openrouter/moonshotai/kimi-k2.7-code",
      },
      "kimi-k3": {
        displayName: "Kimi K3",
        resolve: "openrouter/moonshotai/kimi-k3",
        effort: ["low", "high", "max"],
        openRouterResolve: "openrouter/moonshotai/kimi-k3",
      },
      // slug pins the m2 line for DB stability; resolve tracks the current m2.7.
      "minimax-m2.5": {
        displayName: "MiniMax M2",
        resolve: "openrouter/minimax/minimax-m2.7",
        openRouterResolve: "openrouter/minimax/minimax-m2.7",
      },
      "minimax-m3": {
        displayName: "MiniMax M3",
        resolve: "openrouter/minimax/minimax-m3",
        openRouterResolve: "openrouter/minimax/minimax-m3",
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

/** the provider that actually serves a model specifier, unwrapping an outer
 * OpenRouter prefix. openrouter/deepseek/deepseek-v4-pro-0813 is served by
 * DeepSeek; openrouter/anthropic/... by Anthropic. needed because the
 * OpenRouter route must be routed by the INNER provider's capability, not by
 * the transport vendor. */
export function realProvider(specifier: string): string {
  const first = specifier.split("/")[0];
  if (first === "openrouter") {
    const inner = specifier.split("/")[1];
    return inner ?? first;
  }
  return first;
}

/** whether the DeepSeek Harness (dsh) can drive this resolved model specifier
 * on this run's route. v1: a model whose real provider (openrouter/ unwrapped)
 * is marked dshCapable in the provider registry. every other provider is out
 * of scope — dsh is configured for deepseek only (direct + OpenRouter). */
export function isDshCompatibleModel(specifier: string): boolean {
  const providerId = realProvider(specifier);
  return (providers as Record<string, ProviderConfig>)[providerId]?.dshCapable === true;
}

/** the dsh provider id to configure for a resolved model specifier. direct
 * deepseek models run on the native deepseek-official provider; OpenRouter-
 * served deepseek models run on a custom OpenAI-compatible provider whose id
 * is openrouter. undefined when the specifier is not dsh-compatible. */
export function dshProviderForModel(specifier: string): string | undefined {
  if (!isDshCompatibleModel(specifier)) return undefined;
  return specifier.split("/")[0] === "openrouter" ? "openrouter" : "deepseek-official";
}

export function getProviderDisplayName(slug: string): string | undefined {
  const parsed = parseModel(slug);
  return (providers as Record<string, ProviderConfig>)[parsed.provider]?.displayName;
}

/** provider-prefixed specifier → bare model id (`anthropic/claude-opus-5` → `claude-opus-5`). */
export function stripProviderPrefix(specifier: string): string {
  const slashIndex = specifier.indexOf("/");
  return slashIndex > 0 ? specifier.slice(slashIndex + 1) : specifier;
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

/**
 * Credentials that can serve a provider's models without belonging in its
 * `envVars`, because only one harness understands them. `ANTHROPIC_AUTH_TOKEN`
 * is claude-code's gateway variable: opencode cannot use it, so it must stay
 * out of `providers.anthropic.envVars` (which `getModelEnvVars` feeds to the
 * opencode-validation path) — but an account holding one DOES have a working
 * Anthropic credential, and reading it as "no BYOK" routes the run onto a
 * billed proxy, which `resolveAgent` then hands to opencode, bypassing the
 * gateway entirely.
 */
const HARNESS_ONLY_CREDENTIALS: Record<string, string[]> = {
  anthropic: ["ANTHROPIC_AUTH_TOKEN"],
};

/**
 * Whether one of `secretNames` can run `model` — the Router opt-out predicate,
 * shared so every caller decides the same way. Auto-tier sentinels and
 * deprecated aliases resolve first; `getModelEnvVars("auto/intelligent")` is
 * `[]` otherwise.
 */
export function modelHasStoredAuth(params: { model: string; secretNames: string[] }): boolean {
  const slug = resolveDisplayAlias(params.model)?.slug ?? params.model;
  const authVars = [
    ...getModelEnvVars(slug),
    ...getModelManagedCredentials(slug),
    ...(HARNESS_ONLY_CREDENTIALS[getModelProvider(slug)] ?? []),
  ];
  return authVars.some((v) => params.secretNames.includes(v));
}

// ── derived flat list ──────────────────────────────────────────────────────────

export const modelAliases: ModelAlias[] = Object.entries(providers).flatMap(
  ([providerKey, config]) =>
    Object.entries(config.models).map(([modelId, def]) => ({
      slug: `${providerKey}/${modelId}`,
      provider: providerKey,
      displayName: def.displayName,
      description: def.description,
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
      effort: def.effort,
      openRouterEffort: def.openRouterEffort,
      hidden: def.hidden ?? false,
    }))
);

// ── auto tiers ───────────────────────────────────────────────────────────────

/**
 * `repo.model` sentinels for the two managed auto tiers. stored verbatim in
 * the DB (they pass the `provider/model` shape check) and resolved to a
 * concrete alias by `resolveDisplayAlias` below, so every downstream consumer
 * (CLI resolve, OpenRouter resolve, footer label) handles them transparently.
 *
 * `efficient` mirrors the OSS/default subsidy model (DeepSeek Flash — the 0731
 * release is DeepSeek's first officially-shipped V4, where Pro is still the
 * April preview, and it costs ~0.45x Pro on our cache-heavy review workload);
 * `intelligent` is the frontier pick (Claude Opus). a `null` model means the
 * tier hasn't been pinned: callers default by card status via `defaultAutoTier`.
 */
export const AUTO_EFFICIENT = "auto/efficient";
export const AUTO_INTELLIGENT = "auto/intelligent";
export type AutoTier = typeof AUTO_EFFICIENT | typeof AUTO_INTELLIGENT;

const AUTO_TIER_TARGET: Record<AutoTier, string> = {
  [AUTO_EFFICIENT]: "deepseek/deepseek-flash",
  [AUTO_INTELLIGENT]: "anthropic/claude-opus",
};

export function isAutoTier(slug: string | null | undefined): slug is AutoTier {
  return slug === AUTO_EFFICIENT || slug === AUTO_INTELLIGENT;
}

/**
 * the tier to default to when the user hasn't pinned one. card on file →
 * intelligent (they've signalled willingness to pay for frontier reviews);
 * otherwise → efficient (safe, cheap). server (`run-context`) and the console
 * picker both call this so the displayed default and the runtime default agree.
 */
export function defaultAutoTier(hasCard: boolean): AutoTier {
  return hasCard ? AUTO_INTELLIGENT : AUTO_EFFICIENT;
}

/**
 * the auto tier that actually runs for an account, enforcing the card gate:
 * the intelligent tier (Opus) requires a card on file, so a no-card account is
 * always clamped to efficient (Kimi) — whether intelligent was the card-based
 * default or an explicit pick made while a card was once present. keeps a trial
 * balance from being torched on a premium model before the user has a card.
 * `model` may be null, an `auto/*` sentinel, or a concrete pick being
 * clamped — callers route concrete picks here only when `!hasCard` (carded
 * concrete picks resolve directly), so a concrete `model` always lands on the
 * efficient tier via the no-card early return.
 */
export function resolveAutoTier(params: { model: string | null; hasCard: boolean }): AutoTier {
  if (!params.hasCard) return AUTO_EFFICIENT;
  return isAutoTier(params.model) ? params.model : defaultAutoTier(params.hasCard);
}

/**
 * Router-resolvable — the set a card on file unlocks. custom (non-Auto) picks
 * are card-gated wholesale on the Router: the console locks the Custom tab
 * without a card and the server clamps any stored pick to the efficient tier.
 * a pick with no openRouterResolve (a model OpenRouter doesn't serve yet)
 * lands on the efficient default with or without a card, so "add a card to
 * run this model" messaging would be false for it — hence the predicate.
 * resolveOpenRouterModel walks display aliases, so auto sentinels and
 * deprecated slugs are judged by the model that actually runs.
 */
export function isCardGatedModel(slug: string): boolean {
  return resolveOpenRouterModel(slug) !== undefined;
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
  // auto-tier sentinels aren't real aliases — map them to their concrete
  // target first so CLI/OpenRouter resolution and display labels all work.
  let current = isAutoTier(slug) ? AUTO_TIER_TARGET[slug] : slug;
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

// ── effort ─────────────────────────────────────────────────────────────────────

/**
 * the effort rungs `slug` accepts on the route being used, or undefined when the
 * model has no effort control at all. walks the fallback chain, so a deprecated
 * slug is judged by the model that actually runs. drives both the console's
 * level list and the runtime clamp, so the two can't disagree.
 */
export function getModelEffortLevels(params: {
  slug: string;
  useOpenRouter: boolean;
}): readonly string[] | undefined {
  const alias = resolveDisplayAlias(params.slug);
  if (!alias) return undefined;
  if (params.useOpenRouter) return alias.openRouterEffort ?? alias.effort;
  return alias.effort;
}

/**
 * the rung a run actually sends: a position landed on this model's own published
 * ladder. the result is always a rung the model offers, so there is no arithmetic
 * anywhere that can produce a level it doesn't have. undefined means the model
 * publishes no rungs and the harness gets no flag.
 */
export function resolveModelRung(params: {
  slug: string;
  position: EffortPosition;
  useOpenRouter: boolean;
}): string | undefined {
  const published = getModelEffortLevels(params);
  if (!published) return undefined;
  return resolveRung({ position: params.position, published });
}

// ── default proxy model ──────────────────────────────────────────────────────────

/**
 * OpenRouter target when Router or OSS funding is active and `repo.model` is null.
 * resolved through the efficient tier's fallback chain, so if that tier's backing
 * model is given a `fallback` (e.g. to ride out a temporary outage) the OSS/Router
 * default follows the substitute instead of pinning the unavailable model.
 */
const defaultProxyAlias = resolveDisplayAlias(AUTO_EFFICIENT);
if (!defaultProxyAlias?.openRouterResolve) {
  throw new Error(`DEFAULT_PROXY_MODEL: ${AUTO_EFFICIENT} has no openRouterResolve`);
}
export const DEFAULT_PROXY_MODEL = defaultProxyAlias.openRouterResolve;
const defaultProxyDisplayName = defaultProxyAlias.displayName;

// ── OSS allowlist ──────────────────────────────────────────────────────────────

/**
 * the models Pullfrog is willing to fund on the OSS program. an accepted OSS
 * repo may pick any of these and run-context honors the pick; anything else
 * falls back to `DEFAULT_PROXY_MODEL`, so a subsidized run can never land on a
 * frontier model.
 *
 * membership is a spend decision, so it lives here as a literal rather than a
 * DB toggle — changing it is a deploy, which is the right friction. costs below
 * are modelled on the measured OSS token mix, where cache reads are ~87.5% of
 * input and list price therefore ranks models WRONG: Luna 0.39x, Flash 0.45x,
 * Pro 1.00x, MiniMax M2 1.30x.
 *
 * Kimi K2 was funded and then dropped: 13.2x the funded default as MEASURED
 * over 2,203 real runs ($0.4782 vs $0.0362), almost entirely on its cache-read
 * RATE — 8.5x Flash's. it also fails 2.9% of runs against Flash's 0.0%. best
 * achievable was 10.9x (cheapest OpenRouter endpoint), so no routing fixes it.
 * see wiki/oss-model-allowlist.md.
 */
// MiniMax has no direct-vendor block (it ships only through the routers), so
// it is listed under `openrouter/` where every other entry uses its vendor.
//
// CHANGING THIS LIST CHANGES PUBLIC COPY. four surfaces promise maintainers a
// menu in prose, and a stale one is a promise we don't keep. two now read the
// names from here via `ossFundedModelNames` and follow an edit on their own —
// but the sentences AROUND them are hand-written, so re-read all four:
//   - `app/for-oss/page.tsx` (derived) — the pitch + the OG/meta blurb.
//   - `emails/ossAccepted.ts` (derived) — what an accepted maintainer holds us to.
//   - `docs/models.mdx` (hand-written) — the "Pullfrog for OSS" table.
//   - `app/blog/ModelUsageSection.tsx` (hand-written) — the pricing-post aside.
// the two derived ones are derived because #1190 updated the other two and
// missed these, leaving the application page selling one model the program had
// stopped defaulting to, for two allowlist edits running.
export const OSS_MODEL_ALLOWLIST: readonly string[] = [
  "deepseek/deepseek-flash",
  "deepseek/deepseek-pro",
  "openai/gpt-luna",
  "openrouter/minimax-m2.5",
];

/** the pick the console badges. DERIVED from the efficient tier rather than
 * restated, so the badge cannot drift from the model that actually runs — a
 * second literal here would be an invariant nothing enforces. */
export const OSS_RECOMMENDED_MODEL = AUTO_TIER_TARGET[AUTO_EFFICIENT];

/**
 * display names of the funded set, in allowlist order. the single place every
 * surface that NAMES the menu in prose reads it from — the application page,
 * the acceptance email, the model-access error — so none of them can promise a
 * model the program stopped funding. callers format the list themselves; this
 * is a catalog, not copy.
 */
export function ossFundedModelNames(): string[] {
  return OSS_MODEL_ALLOWLIST.map((slug) => resolveDisplayAlias(slug)?.displayName ?? slug);
}

/**
 * the OpenRouter targets the allowlist admits. keying on the target rather than
 * the slug is what makes `openrouter/deepseek-flash` and `deepseek/deepseek-flash`
 * the same funded model — both spellings are stored in the wild.
 */
const ossAllowedTargets = new Set(
  OSS_MODEL_ALLOWLIST.map((slug) => {
    const target = resolveOpenRouterModel(slug);
    if (!target) throw new Error(`OSS_MODEL_ALLOWLIST: ${slug} has no openRouterResolve`);
    return target;
  })
);

/**
 * whether an OSS repo's stored pick is one the program funds. resolves through
 * the fallback chain first, so `auto/*` sentinels and deprecated slugs are
 * judged by the model that actually runs.
 */
export function isOssAllowedModel(slug: string | null | undefined): slug is string {
  if (!slug) return false;
  const target = resolveOpenRouterModel(slug);
  return target !== undefined && ossAllowedTargets.has(target);
}

/** short label for the model auto-select picks today (console hint copy). */
export function getAutoSelectHintModel(): string {
  return defaultProxyDisplayName;
}

// ── bedrock routing ────────────────────────────────────────────────────────────

/** env var that supplies the Bedrock model ID for the `bedrock/byok` slug. */
export const BEDROCK_MODEL_ID_ENV = "BEDROCK_MODEL_ID";

/** env var that supplies the Vertex AI model ID for the `vertex/byok` slug. */
export const VERTEX_MODEL_ID_ENV = "VERTEX_MODEL_ID";

/** provider key + slug prefix for the Azure OpenAI BYOK backend. matches opencode's own provider id. */
export const AZURE_PROVIDER = "azure";
/** resource name in the endpoint `https://<name>.openai.azure.com` — plain config, not a credential. */
export const AZURE_RESOURCE_NAME_ENV = "AZURE_RESOURCE_NAME";
/** API key for the Azure OpenAI resource — the one sensitive value. */
export const AZURE_API_KEY_ENV = "AZURE_API_KEY";
/**
 * the customer's Azure deployment name, supplied for the `azure/byok` slug.
 * Azure takes the deployment name where every other provider takes a model id
 * (`@ai-sdk/azure` types the argument `deploymentId`), and the name is whatever
 * its creator typed — which is why Azure gets a routing slug instead of the
 * catalog entries models.dev publishes for it.
 */
export const AZURE_DEPLOYMENT_ENV = "AZURE_DEPLOYMENT";
/**
 * context-window size of the model behind the deployment. required for the same
 * reason as its `OPENAI_COMPATIBLE_*` twin: opencode holds no metadata for a
 * deployment name, and an undeclared limit both caps completions at 32000 and
 * disables auto-compaction. see `azureProvider()` in agents/opencodeShared.ts.
 */
export const AZURE_CONTEXT_ENV = "AZURE_CONTEXT";
/** max completion tokens the model behind the deployment accepts. required. */
export const AZURE_MAX_OUTPUT_ENV = "AZURE_MAX_OUTPUT";
/**
 * opt this deployment into Chat Completions. opencode's azure loader calls
 * `sdk.responses(modelID)` unless its `useCompletionUrls` option is set
 * (`selectAzureLanguageModel`), so a deployment serving a model that predates
 * Azure's Responses API — gpt-4, gpt-35-turbo — fails on the wire dialect
 * rather than on anything we control. optional, and the only value here that
 * isn't required.
 */
export const AZURE_USE_CHAT_COMPLETIONS_ENV = "AZURE_USE_CHAT_COMPLETIONS";

/** provider key + slug prefix for the generic OpenAI-compatible BYOK backend. */
export const OPENAI_COMPATIBLE_PROVIDER = "openai-compatible";
/** base URL of the user's OpenAI-compatible endpoint (e.g. a Cloudflare AI Gateway URL). */
export const OPENAI_COMPATIBLE_BASE_URL_ENV = "OPENAI_COMPATIBLE_BASE_URL";
/** API key/token for the user's OpenAI-compatible endpoint — the one sensitive secret. */
export const OPENAI_COMPATIBLE_API_KEY_ENV = "OPENAI_COMPATIBLE_API_KEY";
/** model ID served by the endpoint, supplied for the `openai-compatible/byok` slug. */
export const OPENAI_COMPATIBLE_MODEL_ENV = "OPENAI_COMPATIBLE_MODEL";
/**
 * context-window size of the endpoint's model. required — `validateOpenAICompatibleSetup`
 * rejects the run pre-agent when it's unset or non-numeric. it also gates
 * auto-compaction: opencode's `isOverflow` short-circuits when
 * `limit.context === 0`, which would otherwise let a long session grow until the
 * endpoint rejects it on context length.
 */
export const OPENAI_COMPATIBLE_CONTEXT_ENV = "OPENAI_COMPATIBLE_CONTEXT";
/**
 * max completion tokens the endpoint's model accepts. required — see
 * OPENAI_COMPATIBLE_CONTEXT_ENV. opencode has no models.dev metadata for a
 * user-supplied endpoint, and an undeclared limit makes it send
 * `max_tokens: 32000`, which most models reject outright (gpt-4o and gpt-4o-mini
 * cap at 16384, many open models at 4096/8192). opencode's `limit` requires
 * `context` + `output` together, so the pair is validated and emitted as a unit.
 */
export const OPENAI_COMPATIBLE_MAX_OUTPUT_ENV = "OPENAI_COMPATIBLE_MAX_OUTPUT";

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
