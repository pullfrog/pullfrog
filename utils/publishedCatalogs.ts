import type { ProviderConfig } from "../models.ts";

type ModelDef = ProviderConfig["models"][string];
type ReasoningOptions = { type: string; values?: string[] }[] | undefined;

export type ModelsDevCatalog = Record<
  string,
  {
    models: Record<
      string,
      {
        name?: string;
        canonical_model_id?: string;
        status?: string;
        tool_call?: boolean;
        cost?: { input?: number; output?: number };
        reasoning_options?: ReasoningOptions;
      }
    >;
  }
>;

export interface PublishedCatalogs {
  /** `https://models.dev/api.json` */
  modelsDev: ModelsDevCatalog;
  /** `https://ai-gateway.vercel.sh/v1/models`, whose ladders outrank models.dev's for `vercel/*` */
  gateway: { data: { id: string; reasoning_options?: ReasoningOptions }[] };
  /** the ids each route's own API lists: Zen, Go, OpenRouter and the Vercel gateway */
  served: Record<RouteProvider, ReadonlySet<string>>;
}

type Listing = { data: { id: string }[] };

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return JSON.parse(await response.text());
}

/** every catalog `applyPublishedCatalogs` reads, fetched together; rejects when any one fails */
export async function fetchPublishedCatalogs(signal: AbortSignal): Promise<PublishedCatalogs> {
  const [modelsDev, gateway, zen, go, openrouter] = await Promise.all([
    getJson<ModelsDevCatalog>("https://models.dev/api.json", signal),
    getJson<PublishedCatalogs["gateway"]>("https://ai-gateway.vercel.sh/v1/models", signal),
    getJson<Listing>("https://opencode.ai/zen/v1/models", signal),
    getJson<Listing>("https://opencode.ai/zen/go/v1/models", signal),
    getJson<Listing>("https://openrouter.ai/api/v1/models", signal),
  ]);
  const ids = (listing: Listing) => new Set(listing.data.map((m) => m.id));
  return {
    modelsDev,
    gateway,
    served: {
      opencode: ids(zen),
      "opencode-go": ids(go),
      openrouter: ids(openrouter),
      vercel: ids(gateway),
    },
  };
}

/** the providers that re-host another vendor's models, so their ids can be looked up rather than kept */
const ROUTE_PROVIDERS = ["opencode", "opencode-go", "openrouter", "vercel"] as const;
type RouteProvider = (typeof ROUTE_PROVIDERS)[number];
const isRoute = (provider: string): provider is RouteProvider =>
  ROUTE_PROVIDERS.some((route) => route === provider);

/**
 * models Zen LISTS in `/zen/v1/models` but will not actually serve — the endpoint answers 400
 * `[NOT_FOUND] ... not deployed`, on both Zen tiers. Membership is not availability, so these are
 * subtracted wherever a served list is read. Hand-kept, since only a call to the model can tell: add
 * one when `models-live` catches it, and delete it once the model completes a run again.
 */
export const ZEN_UNDEPLOYED: readonly string[] = [
  // 2026-08-28: 400 on both tiers, while kimi-k2.6 and kimi-k3 answer 200 on the same key.
  "kimi-k2.7-code",
];

/** where a dead free Zen model's stored picks land */
const FREE_ZEN_FALLBACK = "opencode/big-pickle";

/** free Zen lines declined on their terms or their output, never listed on their own. see wiki/models-catalog.md */
const DECLINED_FREE_ZEN = ["nemotron-", "ling-", "ring-"];

/** the Go relay rejects `reasoning_effort` although models.dev lists rungs for it */
const KEEP_BUNDLED_LADDER = new Set(["opencode-go/glm-flash"]);

type Ctx = { catalogs: PublishedCatalogs; providers: Record<string, ProviderConfig> };

const split = (spec: string) => [
  spec.slice(0, spec.indexOf("/")),
  spec.slice(spec.indexOf("/") + 1),
];

function isServed(ctx: Ctx, spec: string): boolean {
  const [route, id] = split(spec);
  if (!isRoute(route)) return true;
  if (route.startsWith("opencode") && ZEN_UNDEPLOYED.includes(id)) return false;
  return ctx.catalogs.served[route].has(id);
}

/** live ids on `route` that models.dev gives this canonical id */
function idsFor(ctx: Ctx, route: string, canonical: string): string[] {
  return Object.entries(ctx.catalogs.modelsDev[route]?.models ?? {})
    .filter(([, m]) => m.canonical_model_id === canonical && m.status !== "deprecated")
    .map(([id]) => `${route}/${id}`);
}

/**
 * of several ids sharing one canonical id, the one every other extends: `x` over `x-fast`, `x-256k`,
 * `x-contributor` or a dated `x-1017`. undefined when no such base exists.
 */
function baseOf(ids: string[]): string | undefined {
  return ids.find((base) => ids.every((id) => id.startsWith(base)));
}

/**
 * models.dev's id for the model `spec` names, when `spec` is the base of the ids sharing it on its own
 * provider. A variant that shares its base model's id (`-pro`, a contributor tier) would otherwise
 * collapse onto the base on every route.
 */
function canonicalOf(ctx: Ctx, spec: string): string | undefined {
  const [provider, id] = split(spec);
  const canonical = ctx.catalogs.modelsDev[provider]?.models[id]?.canonical_model_id;
  if (!canonical) return undefined;
  return baseOf(idsFor(ctx, provider, canonical)) === spec ? canonical : undefined;
}

/** the base of the ids `route` serves for `canonical` */
function routeIdFor(ctx: Ctx, route: string, canonical: string | undefined): string | undefined {
  if (!canonical) return undefined;
  return baseOf(idsFor(ctx, route, canonical).filter((spec) => isServed(ctx, spec)));
}

/** the canonical id every vendor entry under `key` agrees on, so a route copy knows which model it re-hosts */
function siblingCanonical(ctx: Ctx, key: string): string | undefined {
  const ids = Object.entries(ctx.providers)
    .filter(([provider]) => !isRoute(provider))
    .flatMap(([, config]) => {
      const def = config.models[key];
      return def && !def.routing && !def.fallback ? [def] : [];
    })
    .map((def) => canonicalOf(ctx, def.resolve));
  return ids.length > 0 && ids.every((id) => id && id === ids[0]) ? ids[0] : undefined;
}

/** the effort ladder `spec`'s catalog publishes, or undefined when the catalog doesn't list it */
function publishedLadder(
  ctx: Ctx,
  spec: string
): { ladder: readonly string[] | undefined } | undefined {
  const [provider, id] = split(spec);
  const model =
    provider === "vercel"
      ? ctx.catalogs.gateway.data.find((m) => m.id === id)
      : ctx.catalogs.modelsDev[provider]?.models[id];
  if (!model) return undefined;
  return { ladder: model.reasoning_options?.find((o) => o.type === "effort")?.values };
}

type ModelsDevModel = ModelsDevCatalog[string]["models"][string];

const isZeroCost = (model: ModelsDevModel) => model.cost?.input === 0 && model.cost?.output === 0;

/** a free Zen id that only discounts a model Zen also sells, which the paid alias already covers */
function isFreeTwin(ctx: Ctx, model: ModelsDevModel): boolean {
  const canonical = model.canonical_model_id;
  if (!canonical) return false;
  return Object.values(ctx.catalogs.modelsDev.opencode?.models ?? {}).some(
    (other) => other.canonical_model_id === canonical && !isZeroCost(other)
  );
}

/**
 * every free Zen promo models.dev lists that the registry doesn't, keyed by its own id: a runner
 * that keeps its bundled registry passes an unknown slug through raw, so the slug must be Zen's id.
 * a dead one is kept, falling back to Big Pickle, so a pick stored while it lived still resolves.
 */
function freeZenPromos(ctx: Ctx): Record<string, ModelDef> {
  const zen = ctx.providers.opencode?.models ?? {};
  const listed = new Set(Object.values(zen).map((def) => def.resolve));
  const promos = Object.entries(ctx.catalogs.modelsDev.opencode?.models ?? {}).flatMap(
    ([id, model]): [string, ModelDef][] => {
      const resolve = `opencode/${id}`;
      if (
        !id.endsWith("-free") ||
        listed.has(resolve) ||
        zen[id] ||
        !isZeroCost(model) ||
        !model.tool_call ||
        DECLINED_FREE_ZEN.some((prefix) => id.startsWith(prefix)) ||
        isFreeTwin(ctx, model)
      ) {
        return [];
      }
      const def: ModelDef = {
        displayName: (model.name ?? id).replace(/ Free$/, ""),
        description: "Free on Zen for a limited time; data may be used to improve it",
        resolve,
        isFree: true,
      };
      const dead = model.status === "deprecated" || !isServed(ctx, resolve);
      return [[id, dead ? { ...def, fallback: FREE_ZEN_FALLBACK } : def]];
    }
  );
  return Object.fromEntries(promos);
}

/** a free Zen model models.dev deprecates or Zen stops serving, while Big Pickle is still served */
function isDeadFreeZen(ctx: Ctx, slug: string, def: ModelDef): boolean {
  if (!def.isFree || def.fallback || !slug.startsWith("opencode/") || slug === FREE_ZEN_FALLBACK) {
    return false;
  }
  const pickle = ctx.providers.opencode?.models["big-pickle"];
  if (!pickle || !isServed(ctx, pickle.resolve)) return false;
  const [, id] = split(def.resolve);
  return (
    ctx.catalogs.modelsDev.opencode?.models[id]?.status === "deprecated" ||
    !isServed(ctx, def.resolve)
  );
}

function withPublished(ctx: Ctx, slug: string, def: ModelDef): ModelDef {
  if (def.routing || def.fallback) return def;
  if (isDeadFreeZen(ctx, slug, def)) return { ...def, fallback: FREE_ZEN_FALLBACK };
  const [provider, key] = split(slug);
  const resolve =
    (!def.pinned &&
      !def.isFree &&
      isRoute(provider) &&
      routeIdFor(ctx, provider, siblingCanonical(ctx, key))) ||
    def.resolve;
  const openRouterResolve =
    def.openRouterResolve &&
    ((!def.pinned && routeIdFor(ctx, "openrouter", canonicalOf(ctx, resolve))) ||
      def.openRouterResolve);
  if (KEEP_BUNDLED_LADDER.has(slug)) return { ...def, resolve, openRouterResolve };
  const direct = publishedLadder(ctx, resolve);
  const router = openRouterResolve ? publishedLadder(ctx, openRouterResolve) : undefined;
  return {
    ...def,
    resolve,
    openRouterResolve,
    effort: direct ? direct.ladder : def.effort,
    // `[]`, not undefined: an absent openRouterEffort means "the direct route's ladder"
    openRouterEffort: router ? (router.ladder ?? []) : def.openRouterEffort,
  };
}

/**
 * The registry as the published catalogs describe it today. A route copy of a vendor model takes
 * the one id its route serves under that model's canonical id, `openRouterResolve` likewise; each
 * route's effort ladder is the one it publishes; a free Zen model the registry lacks is listed;
 * and a dead free Zen model falls back to Big Pickle. Whatever the catalogs can't settle
 * unambiguously keeps the value written in `action/models.ts`, as does every `pinned` entry's id.
 * See wiki/model-resolution.md.
 */
export function applyPublishedCatalogs(params: Ctx): Record<string, ProviderConfig> {
  return Object.fromEntries(
    Object.entries(params.providers).map(([key, config]) => {
      const models =
        key === "opencode" ? { ...config.models, ...freeZenPromos(params) } : config.models;
      return [
        key,
        {
          ...config,
          models: Object.fromEntries(
            Object.entries(models).map(([id, def]) => [
              id,
              withPublished(params, `${key}/${id}`, def),
            ])
          ),
        },
      ];
    })
  );
}
