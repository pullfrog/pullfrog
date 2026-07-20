import type { Agent } from "../agents/index.ts";
import { agents } from "../agents/index.ts";
import {
  BEDROCK_MODEL_ID_ENV,
  getModelProvider,
  isBedrockAnthropicId,
  isVertexAnthropicId,
  OPENAI_COMPATIBLE_API_KEY_ENV,
  OPENAI_COMPATIBLE_BASE_URL_ENV,
  OPENAI_COMPATIBLE_MODEL_ID_ENV,
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

function hasClaudeCodeAuth(): boolean {
  return hasEnvVar("CLAUDE_CODE_OAUTH_TOKEN") || hasEnvVar("ANTHROPIC_API_KEY");
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

function getMissingOpenAICompatibleEnvVars(): string[] {
  return [
    OPENAI_COMPATIBLE_API_KEY_ENV,
    OPENAI_COMPATIBLE_BASE_URL_ENV,
    OPENAI_COMPATIBLE_MODEL_ID_ENV,
  ].filter((name) => !process.env[name]?.trim());
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
  if (alias?.routing === "openai-compatible") {
    const openAICompatibleModelId = process.env[OPENAI_COMPATIBLE_MODEL_ID_ENV]?.trim();
    if (!openAICompatibleModelId) {
      const missing = getMissingOpenAICompatibleEnvVars();
      throw new Error(
        `OpenAI-compatible model selected but required configuration is missing: ${missing.join(", ")}. ` +
          "set the missing environment variables before running Pullfrog."
      );
    }
    return `openai-compatible/${openAICompatibleModelId}`;
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

export function resolveAgent(ctx: { model?: string | undefined }): Agent {
  // 1. explicit env var override (escape hatch)
  const envAgent = process.env.PULLFROG_AGENT?.trim();
  if (envAgent) {
    if (envAgent in agents) {
      return agents[envAgent as keyof typeof agents];
    }
    log.warning(`» unknown PULLFROG_AGENT="${envAgent}" — falling through to auto-select`);
  }

  // 2. Bedrock routing: when BEDROCK_MODEL_ID is the resolved model, route
  //    Anthropic IDs through claude-code (which supports Bedrock natively
  //    once CLAUDE_CODE_USE_BEDROCK=1) and everything else through opencode's
  //    `amazon-bedrock` provider.
  if (ctx.model && hasBedrockAuth() && process.env[BEDROCK_MODEL_ID_ENV]?.trim() === ctx.model) {
    return isBedrockAnthropicId(ctx.model) ? agents.claude : agents.opencode;
  }

  // 3. Vertex routing: same shape as Bedrock, but Anthropic Vertex IDs are
  //    anchored `claude-*` IDs and non-Anthropic models use opencode's
  //    `google-vertex` provider.
  if (ctx.model && hasVertexAuth() && process.env[VERTEX_MODEL_ID_ENV]?.trim() === ctx.model) {
    return isVertexAnthropicId(ctx.model) ? agents.claude : agents.opencode;
  }

  // 4. if model is Anthropic and Claude Code credentials are available, use Claude Code
  if (ctx.model) {
    try {
      const provider = getModelProvider(ctx.model);
      if (provider === "anthropic" && hasClaudeCodeAuth()) {
        return agents.claude;
      }
    } catch {
      // invalid model format — fall through
    }
  }

  // 5. default: OpenCode (universal, supports all providers)
  return agents.opencode;
}
