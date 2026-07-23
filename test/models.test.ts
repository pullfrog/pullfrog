import { describe, expect, it } from "vitest";
import {
  getModelEnvVars,
  OPENAI_COMPATIBLE_API_KEY_ENV,
  OPENAI_COMPATIBLE_BASE_URL_ENV,
  OPENAI_COMPATIBLE_MODEL_ID_ENV,
  modelAliases,
  providers,
  resolveCliModel,
  resolveDisplayAlias,
} from "../models.ts";

// ── pure alias-registry invariants ──────────────────────────────────────────────
//
// these tests validate our alias data structure without hitting external APIs.
// network-dependent checks (models.dev / OpenRouter catalog drift, latest-model
// snapshot) live in models-catalog.main.test.ts and run on main pushes plus
// `pullfrog/models-bump` PRs (the bot's bump branch, gated in test.yml).

// models that have no OpenRouter equivalent and require BYOK.
// add a model here ONLY when it genuinely doesn't exist on both models.dev and OpenRouter.
// the models-bump cron flags entries that become fillable (see rule 9 in models-bump.yml).
const BYOK_ONLY_MODELS = new Set<string>([]);

describe("OpenAI-compatible registry", () => {
  it("declares the required environment variables and dynamic routing alias", () => {
    expect(providers["openai-compatible"].envVars).toEqual([
      OPENAI_COMPATIBLE_API_KEY_ENV,
      OPENAI_COMPATIBLE_BASE_URL_ENV,
      OPENAI_COMPATIBLE_MODEL_ID_ENV,
    ]);
    expect(getModelEnvVars("openai-compatible/byok")).toEqual(
      providers["openai-compatible"].envVars
    );
    expect(modelAliases.find((alias) => alias.slug === "openai-compatible/byok")).toMatchObject({
      provider: "openai-compatible",
      resolve: "openai-compatible",
      routing: "openai-compatible",
    });
    expect(modelAliases.find((alias) => alias.slug === "litellm/byok")).toBeUndefined();
  });
});

describe("openRouterResolve completeness", () => {
  for (const alias of modelAliases) {
    if (alias.isFree) continue;
    // routing slugs (e.g. bedrock/byok) are inherently BYOK — there's no
    // single model to map to OpenRouter because the actual model ID is read
    // from a per-run env var.
    if (alias.routing) continue;
    // deprecated/disabled aliases never run as-is — resolution redirects
    // through the fallback, whose own openRouterResolve is validated here.
    if (alias.fallback) continue;
    if (BYOK_ONLY_MODELS.has(alias.slug)) continue;
    it(`${alias.slug} has openRouterResolve`, () => {
      expect(
        alias.openRouterResolve,
        `non-free model "${alias.slug}" is missing openRouterResolve — add it or add to BYOK_ONLY_MODELS`
      ).toBeDefined();
    });
  }

  for (const alias of modelAliases) {
    if (!alias.isFree) continue;
    it(`${alias.slug} (free) does not need openRouterResolve`, () => {
      expect(alias.openRouterResolve).toBeUndefined();
    });
  }

  for (const alias of modelAliases) {
    if (!alias.routing) continue;
    it(`${alias.slug} (routing slug) has no openRouterResolve`, () => {
      expect(alias.openRouterResolve).toBeUndefined();
    });
  }
});

describe("fallback chain resolution", () => {
  for (const alias of modelAliases.filter((a) => a.fallback)) {
    it(`${alias.slug} fallback chain resolves to a non-deprecated model`, () => {
      const resolved = resolveCliModel(alias.slug);
      expect(
        resolved,
        `fallback chain for "${alias.slug}" does not resolve to a non-deprecated model`
      ).toBeDefined();
    });
  }
});

// ── isFree invariants — sanity-check the catalog data shape ─────────────────────
//
// these catch the latent regressions that produced issue #691:
//   - opencode/gpt-5-nano was marked `isFree` despite costing $0.05/M
//     (no static check existed; demoted to paid in the same PR adding these tests)
//   - opencode/mimo-v2-pro-free was free + fallback to big-pickle (correct shape),
//     but nothing enforced that the terminal of an isFree fallback chain is itself
//     free. if someone repointed big-pickle's fallback at a paid model, all of mimo
//     and big-pickle's users would silently start hitting a paid endpoint.
//
// the cost.input check itself is network-dependent (lives in
// models-catalog.main.test.ts); these are the static sibling that runs on every PR.
describe("isFree invariants", () => {
  for (const alias of modelAliases.filter((a) => a.isFree)) {
    it(`${alias.slug} lives under the opencode provider`, () => {
      expect(
        alias.provider,
        `isFree alias "${alias.slug}" must be under "opencode" (Zen's keyless gate is opencode-only)`
      ).toBe("opencode");
    });

    it(`${alias.slug} has empty envVars`, () => {
      expect(
        getModelEnvVars(alias.slug),
        `isFree alias "${alias.slug}" must declare \`envVars: []\` so validateAgentApiKey doesn't demand OPENCODE_API_KEY`
      ).toEqual([]);
    });

    it(`${alias.slug} has no openRouterResolve`, () => {
      expect(
        alias.openRouterResolve,
        `isFree alias "${alias.slug}" must omit \`openRouterResolve\` — free Zen models don't exist on OpenRouter`
      ).toBeUndefined();
    });

    it(`${alias.slug} fallback chain terminates at an isFree alias`, () => {
      const terminal = resolveDisplayAlias(alias.slug);
      expect(terminal, `fallback chain for "${alias.slug}" is broken`).toBeDefined();
      expect(
        terminal?.isFree,
        `isFree alias "${alias.slug}" walks to "${terminal?.slug}" which is NOT isFree — users would silently start paying`
      ).toBe(true);
    });
  }
});
