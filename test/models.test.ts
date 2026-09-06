import { describe, expect, it } from "vitest";
import { getModelEnvVars, modelAliases, resolveCliModel, resolveDisplayAlias } from "../models.ts";

// ── pure alias-registry invariants ──────────────────────────────────────────────
//
// these tests validate our alias data structure without hitting external APIs.
// network-dependent checks (models.dev / OpenRouter catalog drift, latest-model
// snapshot) live in models-catalog.main.test.ts and run on main pushes plus
// `pullfrog/models-bump` PRs (the bot's bump branch, gated in test.yml).

// models that have no OpenRouter equivalent and require BYOK.
// add a model here ONLY when it genuinely doesn't exist on both models.dev and
// OpenRouter — or, as with the vercel/* gateway aliases, when rerouting over
// OpenRouter would defeat the pick: a Vercel AI Gateway alias exists to send
// traffic through the user's own gateway (their observability, their billing),
// so a Router-proxy equivalent is deliberately withheld and the picker locks
// the entry until an AI_GATEWAY_API_KEY is stored.
// the models-bump cron flags entries that become fillable (see rule 9 in models-bump.yml).
const BYOK_ONLY_MODELS = new Set<string>([
  "vercel/claude-opus",
  "vercel/claude-sonnet",
  "vercel/claude-haiku",
  "vercel/gpt-astra",
  "vercel/gpt-sol",
  "vercel/gpt-terra",
  "vercel/gpt-luna",
  "vercel/gemini-pro",
  "vercel/gemini-flash",
  "vercel/deepseek-pro",
  "vercel/deepseek-flash",
  "vercel/glm",
  "vercel/kimi-k3",
  // same reason as the vercel/* entries, one step further: these aliases exist
  // to spend a Kimi MEMBERSHIP, and OpenRouter cannot resell one — its
  // `moonshotai/*` ids are the pay-as-you-go route the user picked these to
  // avoid. never fillable, so rule 9 can't reach them (the scanner exact-matches
  // `kimi-for-coding/<id>`, which OpenRouter does not carry). see wiki/kimi-code.md.
  "kimi-for-coding/kimi-k3",
  "kimi-for-coding/kimi-k3-256k",
  "kimi-for-coding/kimi-k2",
  "kimi-for-coding/kimi-k2-highspeed",
]);

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

    // #1077 — `isFree` is about COST, not credentials. Zen refuses a keyless
    // request with `No provider available`, so a free alias that declared
    // `envVars: []` waved every static gate through and the run died at session
    // start with no missing-key CTA. free Zen models still need the key.
    it(`${alias.slug} requires the provider credential`, () => {
      expect(
        getModelEnvVars(alias.slug),
        `isFree alias "${alias.slug}" is free of CHARGE, not of credential — Zen still needs OPENCODE_API_KEY`
      ).toEqual(["OPENCODE_API_KEY"]);
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
