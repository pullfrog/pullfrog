/**
 * Model-access gate for explicitly-requested per-run models (`--opus`,
 * `--model=<slug>`). An explicit model the run can't serve hard-fails *before*
 * the agent starts with one consistent, reason-tailored error.
 *
 * The provenance split lives upstream: `payload.modelExplicit` is true only for
 * a flag in the triggerer's own @pullfrog prompt. A standing default (repo
 * setting, a model flag in org/repo `baseInstructions`, or a trigger's fallback
 * instructions) keeps `modelExplicit = false` and never reaches the error
 * branches here — a missing key for a standing default surfaces through
 * `validateAgentApiKey`'s missing-key error instead (#938).
 *
 * `decideModelAccess` is pure (no env / IO) so the branching is unit-testable;
 * `buildModelAccessError` renders the user-facing markdown that `main.ts`
 * throws and `runErrorRenderer.ts` re-surfaces on both run surfaces.
 */

import { resolveDisplayAlias, resolveOpenRouterModel } from "../models.ts";
import { getApiUrl } from "./apiUrl.ts";

export type ModelAccessReason = "oss" | "byok_no_key" | "router";

export type ModelAccessDecision =
  | { kind: "ok" }
  /** route through the Router/OSS proxy, re-targeted to the requested model. */
  | { kind: "proxy"; target: string }
  /** run BYOK with the requested model — clear the minted proxy target. */
  | { kind: "byok" }
  | { kind: "error"; reason: ModelAccessReason };

/**
 * decide whether an (already-resolved) requested model can run, and how.
 *
 * - non-explicit / no model → `ok` (caller's missing-key validation applies).
 * - proxy active + OSS → only the funded subsidy target routes; a different
 *   model needs the repo's own key (`byok`) else `error("oss")`.
 * - proxy active + Router → honor any Router-servable model (`proxy`); fall to
 *   BYOK when locally authorized, else `error("router")`.
 * - no proxy → the resolved model must be locally authorized, else
 *   `error("byok_no_key")`.
 */
export function decideModelAccess(input: {
  modelExplicit: boolean;
  model: string | undefined;
  oss: boolean;
  proxyActive: boolean;
  subsidyTarget: string | undefined;
  resolvedModel: string | undefined;
  authorized: Set<string>;
}): ModelAccessDecision {
  if (!input.modelExplicit || !input.model) return { kind: "ok" };

  // routing slugs are validated by their own setup checks, not the opencode
  // `authorized` snapshot — discriminate on the alias' routing flag (their
  // resolved IDs may or may not contain a slash).
  const isRoutingSlug = resolveDisplayAlias(input.model)?.routing !== undefined;
  const byokAuthorized =
    !!input.resolvedModel &&
    (input.authorized.has(input.resolvedModel) ||
      !input.resolvedModel.includes("/") ||
      isRoutingSlug);

  if (input.proxyActive) {
    const target = resolveOpenRouterModel(input.model);
    if (input.oss) {
      if (target && target === input.subsidyTarget) return { kind: "proxy", target };
      if (byokAuthorized) return { kind: "byok" };
      return { kind: "error", reason: "oss" };
    }
    if (target) return { kind: "proxy", target };
    if (byokAuthorized) return { kind: "byok" };
    return { kind: "error", reason: "router" };
  }

  if (byokAuthorized) return { kind: "ok" };
  return { kind: "error", reason: "byok_no_key" };
}

/** marker on the throw message so `runErrorRenderer` can reclassify it. */
export const MODEL_ACCESS_MARKER = "requested model is not available";

/**
 * render the model-access failure body (used for both the thrown error and the
 * PR comment / job summary). one shape, reason-branched why → CTA.
 */
export function buildModelAccessError(input: {
  reason: ModelAccessReason;
  model: string;
  owner: string;
  name: string;
}): string {
  const settingsUrl = `${getApiUrl()}/console/${input.owner}/${input.name}`;
  const secretsUrl = `https://github.com/${input.owner}/${input.name}/settings/secrets/actions`;
  const docsUrl = "https://docs.pullfrog.com/keys";

  const headline = `**The ${MODEL_ACCESS_MARKER}: \`${input.model}\`.**`;

  const branch: Record<ModelAccessReason, { why: string; cta: string }> = {
    oss: {
      why: "This repo runs on Pullfrog's OSS subsidy, which only funds the default model. Switch back to the funded model, or add your own provider key to run a different one.",
      cta: `[Add a provider key →](${secretsUrl}) · [Setup docs →](${docsUrl})`,
    },
    byok_no_key: {
      why: `No provider key for \`${input.model}\` is present in this run's environment. Add the matching provider key as a GitHub Actions secret, or pick a model you already have a key for.`,
      cta: `[Open repo secrets →](${secretsUrl}) · [Configure model →](${settingsUrl}) · [Setup docs →](${docsUrl})`,
    },
    router: {
      why: "Pullfrog Router can't serve this model. Pick a Router-supported model, or add your own provider key to run it directly.",
      cta: `[Configure model →](${settingsUrl}) · [Add a provider key →](${secretsUrl})`,
    },
  };

  const { why, cta } = branch[input.reason];
  return [headline, "", why, "", cta].join("\n");
}
