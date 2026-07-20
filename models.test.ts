import { describe, expect, it } from "vitest";
import {
  getModelEnvVars,
  getModelProvider,
  isBedrockAnthropicId,
  isVertexAnthropicId,
  modelAliases,
  parseModel,
  providers,
  resolveCliModel,
  resolveDisplayAlias,
  resolveModelSlug,
  resolveOpenRouterModel,
} from "./models.ts";

describe("parseModel", () => {
  it("parses provider/model format", () => {
    const result = parseModel("anthropic/claude-opus");
    expect(result).toEqual({ provider: "anthropic", model: "claude-opus" });
  });

  it("handles nested slashes (openrouter format)", () => {
    const result = parseModel("openrouter/anthropic/claude-opus-4.6");
    expect(result).toEqual({ provider: "openrouter", model: "anthropic/claude-opus-4.6" });
  });

  it("throws on invalid slug without slash", () => {
    expect(() => parseModel("invalid")).toThrow("invalid model slug");
  });
});

describe("getModelProvider", () => {
  it("extracts provider from slug", () => {
    expect(getModelProvider("anthropic/claude-opus")).toBe("anthropic");
    expect(getModelProvider("openai/gpt")).toBe("openai");
    expect(getModelProvider("google/gemini-pro")).toBe("google");
  });
});

describe("getModelEnvVars", () => {
  it("returns correct env vars for anthropic", () => {
    expect(getModelEnvVars("anthropic/claude-opus")).toEqual([
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]);
  });

  it("returns correct env vars for google (multiple)", () => {
    const envVars = getModelEnvVars("google/gemini-pro");
    expect(envVars).toContain("GOOGLE_GENERATIVE_AI_API_KEY");
    expect(envVars).toContain("GEMINI_API_KEY");
    expect(envVars).toContain("ANTIGRAVITY_TOKEN");
  });

  it("returns GROK_AUTH_JSON for xai models", () => {
    const envVars = getModelEnvVars("xai/grok");
    expect(envVars).toContain("XAI_API_KEY");
    expect(envVars).toContain("GROK_AUTH_JSON");
  });

  it("returns empty array for unknown provider", () => {
    expect(getModelEnvVars("unknown/model")).toEqual([]);
  });

  it("returns empty env vars for free opencode models", () => {
    expect(getModelEnvVars("opencode/big-pickle")).toEqual([]);
    expect(getModelEnvVars("opencode/mimo-v2-pro-free")).toEqual([]);
    expect(getModelEnvVars("opencode/minimax-m2.5-free")).toEqual([]);
  });

  it("still requires OPENCODE_API_KEY for non-free opencode models", () => {
    expect(getModelEnvVars("opencode/claude-opus")).toEqual(["OPENCODE_API_KEY"]);
    expect(getModelEnvVars("opencode/minimax-m2.5")).toEqual(["OPENCODE_API_KEY"]);
    expect(getModelEnvVars("opencode/gpt-5-nano")).toEqual(["OPENCODE_API_KEY"]);
  });
});

describe("resolveModelSlug", () => {
  it("resolves known alias to concrete specifier", () => {
    const resolved = resolveModelSlug("anthropic/claude-opus");
    expect(resolved).toBe("anthropic/claude-opus-4-8");
  });

  it("resolves openai alias", () => {
    const resolved = resolveModelSlug("openai/gpt");
    expect(resolved).toBe("openai/gpt-5.5");
  });

  it("returns the raw resolve for deprecated aliases (does not walk fallback)", () => {
    expect(resolveModelSlug("openai/gpt-codex")).toBe("openai/gpt-5.3-codex");
  });

  it("returns undefined for unknown slug", () => {
    expect(resolveModelSlug("unknown/model")).toBeUndefined();
  });
});

describe("resolveCliModel", () => {
  it("returns same as resolveModelSlug (models.dev specifier)", () => {
    const slug = "anthropic/claude-opus";
    expect(resolveCliModel(slug)).toBe(resolveModelSlug(slug));
  });

  it("returns undefined for unknown slug", () => {
    expect(resolveCliModel("bogus/nope")).toBeUndefined();
  });

  it("walks fallback chain for deprecated deepseek aliases", () => {
    expect(resolveCliModel("deepseek/deepseek-reasoner")).toBe("deepseek/deepseek-v4-pro");
    expect(resolveCliModel("deepseek/deepseek-chat")).toBe("deepseek/deepseek-v4-flash");
  });

  it("walks fallback chain for deprecated openai codex aliases", () => {
    expect(resolveCliModel("openai/gpt-codex")).toBe("openai/gpt-5.5");
    expect(resolveCliModel("openai/gpt-codex-mini")).toBe("openai/gpt-5.4-mini");
    expect(resolveCliModel("opencode/gpt-codex")).toBe("opencode/gpt-5.5");
    expect(resolveCliModel("openrouter/gpt-codex")).toBe("openrouter/~openai/gpt-latest");
  });

  it("walks fallback chain for hidden deprecated minimax-m2.5-free", () => {
    expect(resolveCliModel("opencode/minimax-m2.5-free")).toBe("opencode/big-pickle");
  });
});

describe("resolveDisplayAlias", () => {
  it("returns the alias itself for a non-deprecated slug", () => {
    const alias = resolveDisplayAlias("anthropic/claude-opus");
    expect(alias?.slug).toBe("anthropic/claude-opus");
    expect(alias?.displayName).toBe("Claude Opus");
  });

  it("walks fallback chain to terminal alias for deprecated slug", () => {
    const alias = resolveDisplayAlias("openai/gpt-codex");
    expect(alias?.slug).toBe("openai/gpt");
    expect(alias?.displayName).toBe("GPT");
  });

  it("walks fallback chain for deepseek-reasoner -> deepseek-pro", () => {
    const alias = resolveDisplayAlias("deepseek/deepseek-reasoner");
    expect(alias?.slug).toBe("deepseek/deepseek-pro");
    expect(alias?.displayName).toBe("DeepSeek Pro");
  });

  it("returns undefined for unknown slug", () => {
    expect(resolveDisplayAlias("bogus/nope")).toBeUndefined();
  });
});

describe("resolveOpenRouterModel", () => {
  it("returns the openrouter specifier for a non-deprecated alias", () => {
    expect(resolveOpenRouterModel("anthropic/claude-opus")).toBe(
      "openrouter/anthropic/claude-opus-4.8"
    );
  });

  it("walks fallback chain for deprecated deepseek aliases", () => {
    expect(resolveOpenRouterModel("deepseek/deepseek-reasoner")).toBe(
      "openrouter/deepseek/deepseek-v4-pro"
    );
    expect(resolveOpenRouterModel("deepseek/deepseek-chat")).toBe(
      "openrouter/deepseek/deepseek-v4-flash"
    );
    expect(resolveOpenRouterModel("openrouter/deepseek-chat")).toBe(
      "openrouter/deepseek/deepseek-v4-flash"
    );
  });

  it("walks fallback chain for deprecated openai codex aliases", () => {
    expect(resolveOpenRouterModel("openai/gpt-codex")).toBe("openrouter/openai/gpt-5.5");
    expect(resolveOpenRouterModel("openai/gpt-codex-mini")).toBe("openrouter/openai/gpt-5.4-mini");
  });

  it("returns undefined for free opencode models with no openrouter equivalent", () => {
    expect(resolveOpenRouterModel("opencode/big-pickle")).toBeUndefined();
  });

  it("returns undefined for unknown slug", () => {
    expect(resolveOpenRouterModel("bogus/nope")).toBeUndefined();
  });
});

describe("modelAliases registry", () => {
  it("has at least one model per provider", () => {
    for (const providerKey of Object.keys(providers)) {
      const providerModels = modelAliases.filter((a) => a.provider === providerKey);
      expect(providerModels.length).toBeGreaterThan(0);
    }
  });

  it("has exactly one preferred model per provider", () => {
    for (const providerKey of Object.keys(providers)) {
      // routing-only providers (bedrock) deliberately have no preferred
      // model — the user picks the actual model via a per-run env var, so
      // there's no "preferred default" to surface to auto-select.
      const aliases = modelAliases.filter((a) => a.provider === providerKey);
      if (aliases.every((a) => a.routing)) continue;
      const preferred = aliases.filter((a) => a.preferred);
      expect(preferred.length, `${providerKey} should have exactly 1 preferred model`).toBe(1);
    }
  });

  it("all slugs follow provider/model format", () => {
    for (const alias of modelAliases) {
      expect(alias.slug).toContain("/");
      const parsed = parseModel(alias.slug);
      expect(parsed.provider).toBe(alias.provider);
    }
  });

  it("all resolve values follow provider/model format", () => {
    for (const alias of modelAliases) {
      // routing slugs use a sentinel `resolve` (e.g. "bedrock") that's never
      // passed to a CLI directly — the harness reads a separate env var to
      // get the real model ID. format check doesn't apply.
      if (alias.routing) continue;
      expect(alias.resolve).toContain("/");
    }
  });

  it("slugs are unique", () => {
    const slugs = modelAliases.map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

describe("isBedrockAnthropicId", () => {
  it("matches geo-prefixed Anthropic foundation IDs", () => {
    expect(isBedrockAnthropicId("us.anthropic.claude-opus-4-7")).toBe(true);
    expect(isBedrockAnthropicId("eu.anthropic.claude-sonnet-4-6")).toBe(true);
    expect(isBedrockAnthropicId("global.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(true);
  });

  it("matches in-region Anthropic foundation IDs", () => {
    expect(isBedrockAnthropicId("anthropic.claude-opus-4-7")).toBe(true);
  });

  it("rejects non-Anthropic foundation IDs", () => {
    expect(isBedrockAnthropicId("amazon.nova-pro-v1:0")).toBe(false);
    expect(isBedrockAnthropicId("us.meta.llama4-scout-17b-instruct-v1:0")).toBe(false);
    expect(isBedrockAnthropicId("deepseek.v3.2")).toBe(false);
  });

  // regression: PR #720 review caught that a substring-only match was
  // fragile for inference-profile ARNs (which BEDROCK_MODEL_ID accepts per
  // the AWS docs). ARN names are user-chosen — both directions of the
  // heuristic could break depending on what name the operator picked.
  // We anchor on a discrete dot-segment match (case-insensitive) instead.
  it("ignores 'anthropic' substrings inside non-segment text", () => {
    // ARN whose user-chosen profile name happens to contain "anthropic" as
    // part of a longer word — would route to claude-code under naive
    // includes("anthropic") even though the backing model is unknown.
    expect(
      isBedrockAnthropicId(
        "arn:aws:bedrock:us-east-2:123456789012:application-inference-profile/my-anthropicish-profile"
      )
    ).toBe(false);
  });

  it("matches when 'anthropic' appears as its own dot-segment in ARN", () => {
    // ARN whose profile name embeds the foundation segment correctly —
    // operator chose to surface the backing model in the name.
    expect(
      isBedrockAnthropicId(
        "arn:aws:bedrock:us-east-2:123456789012:application-inference-profile/anthropic.claude-opus-4-7"
      )
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isBedrockAnthropicId("US.ANTHROPIC.CLAUDE-OPUS-4-7")).toBe(true);
  });
});

describe("isVertexAnthropicId", () => {
  it("matches Claude Vertex IDs by anchored prefix", () => {
    expect(isVertexAnthropicId("claude-opus-4-1@20250805")).toBe(true);
  });

  it("rejects Gemini IDs", () => {
    expect(isVertexAnthropicId("gemini-2.5-pro")).toBe(false);
  });

  it("ignores Anthropic substrings outside the prefix", () => {
    expect(isVertexAnthropicId("publishers/anthropic/models/claude-opus-4-1")).toBe(false);
  });
});

describe("providers registry", () => {
  it("every provider has envVars", () => {
    for (const [key, config] of Object.entries(providers)) {
      expect(config.envVars.length, `${key} should have env vars`).toBeGreaterThan(0);
    }
  });

  it("every provider has a displayName", () => {
    for (const [key, config] of Object.entries(providers)) {
      expect(config.displayName, `${key} should have a displayName`).toBeTruthy();
    }
  });
});
