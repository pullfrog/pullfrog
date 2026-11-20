import { modelAliases, resolveDisplayAlias } from "../models.ts";

/**
 * Derive a cheaper subagent model override from the orchestrator's resolved
 * model spec.
 *
 * This is a pure registry lookup: every alias in `action/models.ts` declares
 * its own `subagentModel` (alias key in the same provider). At runtime we
 * reverse-lookup the orchestrator's resolved slug to find the alias that
 * produced it, follow the `subagentModel` pointer, and return the target
 * alias's resolve / openRouterResolve depending on which route the
 * orchestrator was using.
 *
 * Returns `{ reviewer: undefined }` when the orchestrator's alias has no
 * `subagentModel` (e.g. it's already at a sufficiently cheap tier, or its
 * provider doesn't have a clean cheaper-but-capable sibling). See models.ts
 * for the wiring + per-provider rationale.
 */
export function deriveSubagentModels(orchestratorSpec: string | undefined): {
  reviewer: string | undefined;
} {
  if (!orchestratorSpec) return { reviewer: undefined };

  // Reverse-lookup by resolved spec. A resolve string usually maps to one alias
  // per provider; the exception is gpt/gpt-pro, which share the direct `…-sol`
  // resolve (gpt-pro has no distinct -pro id on models.dev/Zen, so on BYOK it
  // runs as plain Sol). first-match-wins by declaration order (gpt precedes
  // gpt-pro) yields the canonical gpt downshift; gpt-pro's distinct sol-pro
  // OpenRouter route still resolves its own subagent. We track which field
  // matched (resolve vs openRouterResolve) to pick the same field off the target.
  for (const source of modelAliases) {
    const matchedDirect = source.resolve === orchestratorSpec;
    const matchedOR = source.openRouterResolve === orchestratorSpec;
    if (!matchedDirect && !matchedOR) continue;
    if (!source.subagentModel) return { reviewer: undefined };
    // a target that falls back runs its fallback, as a pick of it would
    const target = resolveDisplayAlias(source.subagentModel);
    if (!target) return { reviewer: undefined };
    const reviewer = matchedOR ? target.openRouterResolve : target.resolve;
    return { reviewer };
  }

  return { reviewer: undefined };
}
