import type { Agent } from "../agents/index.ts";
import { agents } from "../agents/index.ts";
import {
  AZURE_DEPLOYMENT_ENV,
  AZURE_PROVIDER,
  BEDROCK_MODEL_ID_ENV,
  getModelProvider,
  isBedrockAnthropicId,
  isDshCompatibleModel,
  isVertexAnthropicId,
  OPENAI_COMPATIBLE_MODEL_ENV,
  OPENAI_COMPATIBLE_PROVIDER,
  resolveCliModel,
  resolveDisplayAlias,
  VERTEX_MODEL_ID_ENV,
} from "../models.ts";
import { log } from "./cli.ts";
import { VERTEX_SERVICE_ACCOUNT_JSON_ENV } from "./vertex.ts";

function hasEnvVar(name: string): boolean {
  const val = process.env[name];
  return typeof val === "string" && val.length > 0;
}

/** every credential claude-code can run on, including `ANTHROPIC_AUTH_TOKEN` —
 * the gateway variable it sends as `Authorization: Bearer`. opencode cannot use
 * that one, so leaving it out routed a gateway-only run to the harness that had
 * no way to authenticate it. */
function hasClaudeCodeAuth(): boolean {
  return (
    hasEnvVar("CLAUDE_CODE_OAUTH_TOKEN") ||
    hasEnvVar("ANTHROPIC_API_KEY") ||
    hasEnvVar("ANTHROPIC_AUTH_TOKEN")
  );
}

/** either credential the codex CLI can run on: the ChatGPT-subscription blob
 * `pullfrog auth codex` stores, or a plain OpenAI API key. */
function hasCodexAuth(): boolean {
  return hasEnvVar("CODEX_AUTH_JSON") || hasEnvVar("OPENAI_API_KEY");
}

function hasBedrockAuth(): boolean {
  return (
    hasEnvVar("AWS_BEARER_TOKEN_BEDROCK") ||
    (hasEnvVar("AWS_ACCESS_KEY_ID") && hasEnvVar("AWS_SECRET_ACCESS_KEY"))
  );
}

function hasVertexAuth(): boolean {
  return hasEnvVar(VERTEX_SERVICE_ACCOUNT_JSON_ENV);
}

function hasDeepSeekAuth(): boolean {
  return hasEnvVar("DEEPSEEK_API_KEY");
}

/** human-readable set of harnesses that can run a given effective model. used
 * by the explicit-agent compatibility gate's error copy. */
function compatibleAgentsFor(model: string): string[] {
  const out = ["opencode"]; // opencode is universal
  try {
    const provider = getModelProvider(model);
    if (provider === "anthropic" || isBedrockAnthropicId(model) || isVertexAnthropicId(model)) {
      out.push("claude");
    } else if (provider === "openai") {
      out.push("codex");
    }
  } catch {
    // unparseable — opencode only
  }
  if (isDshCompatibleModel(model)) out.push("dsh");
  return out;
}

/**
 * hard-fail gate for an explicit user agent choice: the choice must be able
 * to actually run the resolved model on this run's route. thrown before the
 * agent starts (and before any spend) with actionable copy naming the
 * compatible set. when no model is configured the harness auto-selects its
 * own, so every explicit choice is allowed.
 */
export function assertAgentModelCompatible(
  agentName: "claude" | "codex" | "opencode" | "dsh",
  model: string | undefined
): void {
  if (!model) return;
  if (agentName === "opencode") return; // universal
  let allowed = false;
  try {
    const provider = getModelProvider(model);
    if (agentName === "claude") {
      allowed = provider === "anthropic" || isBedrockAnthropicId(model) || isVertexAnthropicId(model);
    } else if (agentName === "codex") {
      allowed = provider === "openai";
    } else if (agentName === "dsh") {
      allowed = isDshCompatibleModel(model);
    }
  } catch {
    allowed = false;
  }
  if (allowed) return;
  const compatible = compatibleAgentsFor(model).join(" or ");
  throw new Error(
    `agent "${agentName}" cannot run model "${model}" — the configured harness only drives ` +
      (agentName === "dsh"
        ? "deepseek models"
        : agentName === "claude"
          ? "Anthropic models (direct, Bedrock, or Vertex)"
          : "OpenAI models") +
      `. pick "${compatible}" (or "auto"), or set PULLFROG_AGENT to force a harness at your own risk.`
  );
}

/**
 * resolve a single slug to its CLI-ready model string. routing aliases
 * (e.g. `bedrock/byok`) defer to their backing env var instead of the
 * sentinel stored in `resolve`. shared between PULLFROG_MODEL override
 * and repo-config slug resolution so both paths get the same routing
 * semantics — without this helper, `PULLFROG_MODEL=bedrock/byok` would
 * leak the literal sentinel string `"bedrock"` downstream.
 */
function resolveSlug(slug: string): string | undefined {
  const alias = resolveDisplayAlias(slug);
  if (alias?.routing === "bedrock") {
    const bedrockId = process.env[BEDROCK_MODEL_ID_ENV]?.trim();
    if (!bedrockId) {
      throw new Error(
        `${BEDROCK_MODEL_ID_ENV} env var is required when the model is set to "${slug}". ` +
          `set it to an AWS Bedrock model ID from the Bedrock console. ` +
          `see https://docs.pullfrog.com/bedrock for setup.`
      );
    }
    return bedrockId;
  }
  if (alias?.routing === "vertex") {
    const vertexId = process.env[VERTEX_MODEL_ID_ENV]?.trim();
    if (!vertexId) {
      throw new Error(
        `${VERTEX_MODEL_ID_ENV} env var is required when the model is set to "${slug}". ` +
          `set it to a Google Vertex AI model ID from Model Garden. ` +
          `see https://docs.pullfrog.com/vertex for setup.`
      );
    }
    return vertexId;
  }
  if (alias?.routing === "azure") {
    const deployment = process.env[AZURE_DEPLOYMENT_ENV]?.trim();
    if (!deployment) {
      throw new Error(
        `${AZURE_DEPLOYMENT_ENV} env var is required when the model is set to "${slug}". ` +
          `set it to the name of your Azure OpenAI deployment (not the model it serves — ` +
          `Azure routes on the deployment name). ` +
          `see https://docs.pullfrog.com/azure for setup.`
      );
    }
    return `${AZURE_PROVIDER}/${deployment}`;
  }
  if (alias?.routing === "openai-compatible") {
    const modelId = process.env[OPENAI_COMPATIBLE_MODEL_ENV]?.trim();
    if (!modelId) {
      throw new Error(
        `${OPENAI_COMPATIBLE_MODEL_ENV} env var is required when the model is set to "${slug}". ` +
          `set it to the model ID served by your OpenAI-compatible endpoint ` +
          `(e.g. a Cloudflare AI Gateway or DashScope model). ` +
          `see https://docs.pullfrog.com/openai-compatible for setup.`
      );
    }
    return `${OPENAI_COMPATIBLE_PROVIDER}/${modelId}`;
  }
  return resolveCliModel(slug);
}

/**
 * resolve the effective model for this run.
 *
 * priority:
 *   1. PULLFROG_MODEL env var — resolved through the alias registry first,
 *      so values like "anthropic/claude-opus" become "anthropic/claude-opus-4-7".
 *      raw specifiers (e.g. "anthropic/claude-opus-4-6") pass through unchanged.
 *      always wins — bypasses Bedrock routing entirely. to test a different
 *      Bedrock model, change `BEDROCK_MODEL_ID`, not `PULLFROG_MODEL`.
 *   2. slug from repo config / payload → alias registry. routing slugs
 *      (e.g. `bedrock/byok`) defer to a separate env var (`BEDROCK_MODEL_ID`).
 *      a non-curated value with a slash passes through unchanged as a raw
 *      models.dev specifier (same as `PULLFROG_MODEL`), not auto-selected away.
 *   3. undefined (no slug, or a bare-word non-specifier) — agent auto-selects.
 */
export function resolveModel(ctx: { slug?: string | undefined }): string | undefined {
  const envModel = process.env.PULLFROG_MODEL?.trim();
  if (envModel) {
    return resolveSlug(envModel) ?? envModel;
  }

  const slug = ctx.slug?.trim();
  if (slug) {
    const resolved = resolveSlug(slug);
    if (resolved) {
      return resolved;
    }
    // not a curated alias: a slashed value passes through as a raw models.dev
    // specifier (explicit picks honored); a bare word isn't a valid specifier
    // and downstream would misread it as a Bedrock/Vertex backend ID — auto-select.
    if (slug.includes("/")) {
      log.info(`» "${slug}" is not a curated alias — passing through as a raw model specifier`);
      return slug;
    }
    log.warning(`» unknown model slug "${slug}" — agent will auto-select`);
  }

  return undefined;
}

export function resolveAgent(ctx: {
  model?: string | undefined;
  /** set on router / OSS runs, where the model is served by OpenRouter. those
   * pin no `model`, so without this the auto-select branches below would read
   * a stored Anthropic or OpenAI credential as the routing signal for a run
   * that isn't using it. */
  proxyModel?: string | undefined;
  /** the account opted in to the EXPERIMENTAL codex harness, already ANDed
   * server-side with the global kill switch. false — the default for every
   * account — routes OpenAI models to opencode exactly as before the harness
   * existed. see wiki/codex-agent.md. */
  codexAgent?: boolean | undefined;
  /** explicit user choice from RepoSettings.agent (the console radio).
   * null/undefined/"auto" = model-based routing below. a set value is
   * compatibility-gated against the resolved model — an incompatible pair
   * hard-fails before the agent starts. */
  agent?: "auto" | "claude" | "codex" | "opencode" | "dsh" | null | undefined;
  /** server-side dsh kill-switch verdict (ANDed server-side with
   * isDshAgentEnabled()). gates BOTH the auto deepseek -> dsh route and an
   * explicit agent: "dsh" pick. */
  dshEnabled?: boolean | undefined;
}): Agent {
  // 1. explicit env var override (escape hatch). deliberately NOT gated on the
  //    opt-in: an operator who sets PULLFROG_AGENT in their own workflow is
  //    asking for a specific harness, which is what the escape hatch is for.
  const envAgent = process.env.PULLFROG_AGENT?.trim();
  if (envAgent) {
    if (envAgent in agents) {
      return agents[envAgent as keyof typeof agents];
    }
    log.warning(`» unknown PULLFROG_AGENT="${envAgent}" — falling through to auto-select`);
  }

  // the model that decides capability on this run's route: the OpenRouter
  // specifier on proxy runs, the resolved model otherwise.
  const effectiveModel = ctx.proxyModel ?? ctx.model;

  // 2. explicit user choice (settings.agent). compatibility-gated: the pair
  //    must be in the harness x model matrix, else hard-fail before any spend.
  if (ctx.agent && ctx.agent !== "auto") {
    if (ctx.agent === "dsh" && !ctx.dshEnabled) {
      throw new Error(
        `agent "dsh" is not enabled for this repo (DeepSeek Harness kill switch off) — ` +
          `pick "auto" or another harness, or set PULLFROG_AGENT to force it at your own risk.`
      );
    }
    assertAgentModelCompatible(ctx.agent, effectiveModel);
    return agents[ctx.agent];
  }

  // 3. proxy runs are OpenRouter-served. deepseek models route to dsh when
  //    the harness is enabled (dsh's custom OpenAI-compatible provider speaks
  //    OpenRouter); everything else stays on opencode.
  if (ctx.proxyModel) {
    if (ctx.dshEnabled && isDshCompatibleModel(ctx.proxyModel)) return agents.dsh;
    return agents.opencode;
  }

  // 4. Bedrock routing: when BEDROCK_MODEL_ID is the resolved model, route
  //    Anthropic IDs through claude-code (which supports Bedrock natively
  //    once CLAUDE_CODE_USE_BEDROCK=1) and everything else through opencode's
  //    `amazon-bedrock` provider.
  if (ctx.model && hasBedrockAuth() && process.env[BEDROCK_MODEL_ID_ENV]?.trim() === ctx.model) {
    return isBedrockAnthropicId(ctx.model) ? agents.claude : agents.opencode;
  }

  // 5. Vertex routing: same shape as Bedrock, but Anthropic Vertex IDs are
  //    anchored `claude-*` IDs and non-Anthropic models use opencode's
  //    `google-vertex` provider.
  if (ctx.model && hasVertexAuth() && process.env[VERTEX_MODEL_ID_ENV]?.trim() === ctx.model) {
    return isVertexAnthropicId(ctx.model) ? agents.claude : agents.opencode;
  }

  // 6. each vendor's own harness wins for its own models when the matching
  //    credential is present — claude-code for Anthropic, codex for OpenAI,
  //    DeepSeek Harness for deepseek (direct route, when enabled).
  if (ctx.model) {
    try {
      const provider = getModelProvider(ctx.model);
      if (provider === "anthropic" && hasClaudeCodeAuth()) return agents.claude;
      if (provider === "openai" && ctx.codexAgent && hasCodexAuth()) return agents.codex;
      if (ctx.dshEnabled && isDshCompatibleModel(ctx.model) && hasDeepSeekAuth()) {
        return agents.dsh;
      }
    } catch {
      // invalid model format — fall through
    }
  }

  // 7. auto-select with no configured model. an account whose ONLY Anthropic
  //    credential is `ANTHROPIC_AUTH_TOKEN` has to take claude-code: opencode
  //    cannot use that variable, so `autoSelectModel` would rank a catalog it
  //    has no way to authenticate and the run dies on a missing key. a plain
  //    API key stays on opencode, whose ranking across providers beats guessing
  //    from whichever env var we tested first — which is also why a
  //    Codex/OpenAI credential yields to any Anthropic one.
  if (!ctx.model) {
    if (
      hasEnvVar("ANTHROPIC_AUTH_TOKEN") &&
      !hasEnvVar("ANTHROPIC_API_KEY") &&
      !hasEnvVar("CLAUDE_CODE_OAUTH_TOKEN")
    ) {
      return agents.claude;
    }
    if (ctx.codexAgent && hasCodexAuth() && !hasClaudeCodeAuth()) return agents.codex;
  }

  // 8. default: OpenCode (universal, supports all providers)
  return agents.opencode;
}
