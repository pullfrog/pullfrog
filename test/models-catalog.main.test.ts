import { describe, expect, it } from "vitest";
import { DEFAULT_PROXY_MODEL, modelAliases, resolveDisplayAlias } from "../models.ts";

// ── catalog drift tests ─────────────────────────────────────────────────────
//
// these tests fetch models.dev and openrouter.ai to verify that every alias in
// models.ts still corresponds to a live, non-deprecated upstream model. upstream
// catalog drift (new model ships, old model deprecated, etc.) causes failures
// that are unrelated to any code change in a typical PR — so these are gated
// off for normal PRs and run only on main pushes plus PRs from the
// `pullfrog/models-bump` branch (the bot-authored bump PR — this test IS the
// integrity gate for its edits, so it has to run on the PR itself, not just
// post-merge).
//
// the registry is kept in sync with upstreams by the `models-bump` cron
// (`.github/workflows/models-bump.yml`), which scans models.dev every 12h and
// opens a PR bumping `resolve` / `openRouterResolve` for any alias whose
// upstream has shipped a newer GA version. these tests are the integrity gate
// for that PR — they catch typos, removed models, and openrouter mismatches.
//
// run locally with `pnpm test:catalog`.

type ModelsDevModel = {
  name: string;
  status?: string;
  release_date?: string;
  cost?: { input?: number; output?: number };
};

type ModelsDevProvider = {
  name: string;
  models: Record<string, ModelsDevModel>;
};

type ModelsDevApi = Record<string, ModelsDevProvider>;

const api = fetch("https://models.dev/api.json").then((r) => r.json() as Promise<ModelsDevApi>);

function parseResolve(resolve: string): { provider: string; modelId: string } {
  const idx = resolve.indexOf("/");
  return { provider: resolve.slice(0, idx), modelId: resolve.slice(idx + 1) };
}

describe("models.dev validity", async () => {
  const data = await api;

  for (const alias of modelAliases) {
    // routing slugs (e.g. bedrock/byok) have no fixed `resolve` — the actual
    // model ID is read from a separate env var at run time. skip drift checks
    // since there's no models.dev entry to validate against.
    if (alias.routing) continue;

    // aliases with a `fallback` are deprecated entries that legitimately point
    // at dead resolve targets — the fallback chain redirects callers to a live
    // model. skip both existence and deprecation checks; the terminal-fallback
    // is validated separately by the Zen served-list test below.
    if (alias.fallback) continue;

    // byok providers (e.g. qwen) have no models.dev entry; nothing to validate
    // upstream. their openRouterResolve, when set, is still checked below.
    if (alias.byok) continue;

    const parsed = parseResolve(alias.resolve);

    it(`${alias.resolve} exists on models.dev`, () => {
      const providerData = data[parsed.provider];
      expect(providerData, `provider "${parsed.provider}" not found on models.dev`).toBeDefined();
      const model = providerData.models[parsed.modelId];
      expect(
        model,
        `model "${parsed.modelId}" not found under ${parsed.provider} on models.dev`
      ).toBeDefined();
    });

    it(`${alias.resolve} is not deprecated`, () => {
      const model = data[parsed.provider]?.models[parsed.modelId];
      if (!model) return; // covered by existence test above
      expect(model.status, `${alias.resolve} is deprecated on models.dev`).not.toBe("deprecated");
    });
  }
});

describe("openRouterResolve models.dev validity", async () => {
  const data = await api;
  const seen = new Set<string>();

  for (const alias of modelAliases) {
    if (!alias.openRouterResolve) continue;
    // a fallback alias never runs as-is — resolution redirects to the terminal,
    // whose openRouterResolve is validated instead. skip its (possibly stale,
    // e.g. temporarily-unavailable) own target, mirroring the `resolve` loop.
    if (alias.fallback) continue;
    if (seen.has(alias.openRouterResolve)) continue;
    seen.add(alias.openRouterResolve);

    const parsed = parseResolve(alias.openRouterResolve);

    it(`${alias.openRouterResolve} exists on models.dev`, () => {
      const providerData = data[parsed.provider];
      expect(providerData, `provider "${parsed.provider}" not found on models.dev`).toBeDefined();
      const model = providerData.models[parsed.modelId];
      expect(
        model,
        `model "${parsed.modelId}" not found under ${parsed.provider} on models.dev`
      ).toBeDefined();
    });
  }
});

describe("DEFAULT_PROXY_MODEL models.dev validity", async () => {
  const data = await api;
  const parsed = parseResolve(DEFAULT_PROXY_MODEL);

  it(`${DEFAULT_PROXY_MODEL} exists on models.dev`, () => {
    const providerData = data[parsed.provider];
    expect(providerData, `provider "${parsed.provider}" not found on models.dev`).toBeDefined();
    const model = providerData.models[parsed.modelId];
    expect(
      model,
      `model "${parsed.modelId}" not found under ${parsed.provider} on models.dev`
    ).toBeDefined();
  });

  it(`${DEFAULT_PROXY_MODEL} is not deprecated on models.dev`, () => {
    const model = data[parsed.provider]?.models[parsed.modelId];
    if (!model) return;
    expect(model.status, `${DEFAULT_PROXY_MODEL} is deprecated on models.dev`).not.toBe(
      "deprecated"
    );
  });
});

type OpenRouterModel = { id: string };
type OpenRouterModelsResponse = { data: OpenRouterModel[] };

const openRouterApi = fetch("https://openrouter.ai/api/v1/models").then(
  (r) => r.json() as Promise<OpenRouterModelsResponse>
);

describe("openRouterResolve OpenRouter API validity", async () => {
  const orData = await openRouterApi;
  const orModelIds = new Set(orData.data.map((m) => m.id));
  const seen = new Set<string>();

  for (const alias of modelAliases) {
    if (!alias.openRouterResolve) continue;
    // fallback aliases redirect to a terminal that's validated on its own; their
    // own target may be deprecated or temporarily unavailable. skip, mirroring
    // the `resolve` loop.
    if (alias.fallback) continue;
    const orModelId = alias.openRouterResolve.slice("openrouter/".length);
    if (seen.has(orModelId)) continue;
    seen.add(orModelId);

    it(`${orModelId} exists on OpenRouter`, () => {
      expect(
        orModelIds.has(orModelId),
        `model "${orModelId}" not found in OpenRouter API (/api/v1/models)`
      ).toBe(true);
    });
  }
});

// ── OpenCode Zen served-list + free-cost checks ────────────────────────────────
//
// these enforce the two dynamic conditions for "this opencode alias works for a
// user without OPENCODE_API_KEY" — the gap that let issue #691 ship:
//   1. the alias's terminal-fallback resolve appears in Zen's /v1/models (Zen
//      actually serves it). caught nothing in #691 because mimo had a fallback
//      to big-pickle which IS served, but would catch any future alias that
//      points at a Zen-removed model without a fallback.
//   2. for isFree aliases, the terminal-fallback's models.dev `cost.input` is
//      zero. caught the gpt-5-nano regression: $0.05/M input on models.dev,
//      marked isFree in our catalog.
//
// we check the terminal-fallback (via resolveDisplayAlias) because deprecated
// aliases legitimately point at dead resolve targets — the terminal is what
// actually runs at the agent CLI.

type ZenModel = { id: string };
type ZenModelsResponse = { data: ZenModel[] };

const zenApi = fetch("https://opencode.ai/zen/v1/models").then(
  (r) => r.json() as Promise<ZenModelsResponse>
);

describe("opencode Zen served list", async () => {
  const zenData = await zenApi;
  const zenIds = new Set(zenData.data.map((m) => m.id));
  const seen = new Set<string>();

  for (const alias of modelAliases) {
    const terminal = resolveDisplayAlias(alias.slug);
    if (!terminal) continue;
    const parsed = parseResolve(terminal.resolve);
    if (parsed.provider !== "opencode") continue;
    if (seen.has(terminal.resolve)) continue;
    seen.add(terminal.resolve);

    it(`${alias.slug} terminal resolve ${terminal.resolve} is served by Zen`, () => {
      expect(
        zenIds.has(parsed.modelId),
        `terminal resolve "${terminal.resolve}" for alias "${alias.slug}" is not in https://opencode.ai/zen/v1/models — Zen no longer serves it. either point a fallback at a Zen-served alias or remove the entry.`
      ).toBe(true);
    });
  }
});

describe("isFree models.dev cost", async () => {
  const data = await api;
  const seen = new Set<string>();

  for (const alias of modelAliases.filter((a) => a.isFree)) {
    const terminal = resolveDisplayAlias(alias.slug);
    if (!terminal) continue;
    const parsed = parseResolve(terminal.resolve);
    if (seen.has(terminal.resolve)) continue;
    seen.add(terminal.resolve);

    it(`${alias.slug} terminal resolve ${terminal.resolve} has cost.input === 0`, () => {
      const model = data[parsed.provider]?.models[parsed.modelId];
      expect(model, `terminal resolve "${terminal.resolve}" missing on models.dev`).toBeDefined();
      expect(
        model?.cost?.input,
        `isFree alias "${alias.slug}" walks to "${terminal.resolve}" which reports cost.input=${model?.cost?.input} on models.dev — either repoint the fallback or drop \`isFree\``
      ).toBe(0);
    });
  }
});
