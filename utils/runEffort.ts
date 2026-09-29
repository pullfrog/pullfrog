/**
 * reasoning effort for a run: a stored POSITION landed on the ladder of the
 * model that actually runs. shared by both harnesses and the startup log so
 * they can't disagree — the log must never claim a level the agent didn't send.
 * see wiki/effort.md.
 */

import {
  DEFAULT_EFFORT_POSITION,
  type EffortPosition,
  rungPosition,
  SUBSIDY_RUNG,
} from "../effort.ts";
import { AZURE_PROVIDER, type ModelAlias, modelAliases, resolveModelRung } from "../models.ts";
import type { ResolvedPayload } from "./payload.ts";

export interface RunEffort {
  /** the position this run resolves at — the stored one, or the default. */
  position: EffortPosition;
  /** false when nothing was configured and `position` is the default. */
  configured: boolean;
  /**
   * the rung the harness sends — always one the model published. undefined when
   * the model publishes no rungs or we can't place it at all; either way the
   * flag is omitted.
   */
  rung: string | undefined;
  /** the catalog alias the ladder came from, if we recognized one. */
  alias: ModelAlias | undefined;
}

/**
 * match a Bedrock/Vertex backend ID (`us.anthropic.claude-opus-5-v1:0`,
 * `claude-opus-5@20260115`) against the Anthropic aliases we catalog. hosted IDs
 * embed the model name verbatim, so a substring match on the alias's resolve
 * target is conservative — an ID naming a model we don't catalog matches
 * nothing. inference-profile ARNs are excluded because their name is
 * operator-chosen and says nothing about the backing model, the same reason
 * `isBedrockAnthropicId` refuses to substring-match them.
 */
function matchHostedAnthropicAlias(modelId: string): ModelAlias | undefined {
  const id = modelId.toLowerCase();
  if (id.startsWith("arn:")) return undefined;
  return modelAliases.find(
    (a) =>
      !a.fallback &&
      a.provider === "anthropic" &&
      id.includes(a.resolve.replace(/^anthropic\//, ""))
  );
}

/**
 * the catalog alias whose ladder governs this run, found from the model that
 * actually executes — `main.ts` picks `proxyModel ?? resolvedModel`, and the
 * ladder has to follow that or an OSS run, which keeps the configured slug in
 * `settings.model` while forcing a DeepSeek `proxyModel`, would clamp against a
 * model it isn't using.
 *
 * both inputs are concrete specifiers rather than slugs, so this is a reverse
 * lookup. aliases sharing a target publish the same ladder (`openai/gpt-sol` and
 * `openai/gpt-sol-pro` both resolve to `openai/gpt-6.1-sol`), pinned by the catalog
 * test; deprecated aliases are skipped because they never run as-is.
 */
function resolveRunAlias(ctx: {
  payload: ResolvedPayload;
  resolvedModel?: string | undefined;
}): ModelAlias | undefined {
  const proxyModel = ctx.payload.proxyModel;
  if (proxyModel) {
    return modelAliases.find((a) => !a.fallback && a.openRouterResolve === proxyModel);
  }

  const model = ctx.resolvedModel;
  if (!model) return undefined;
  // an azure deployment name is chosen by whoever created the deployment, so it
  // says nothing about whether opencode can place the model behind it —
  // `my-claude-opus-5-prod` would pass the hosted match while being absent from
  // opencode's azure catalog, and sending a variant for a model it can't place
  // hangs the run to its job timeout. see wiki/effort.md.
  if (model.startsWith(`${AZURE_PROVIDER}/`)) return undefined;
  // routing slugs (`bedrock/byok`, `vertex/byok`) resolve to a customer-supplied
  // backend ID rather than a catalog target, so those fall to the hosted match.
  return (
    modelAliases.find((a) => !a.fallback && a.resolve === model) ?? matchHostedAnthropicAlias(model)
  );
}

/**
 * the position a subsidised run is pinned to — the `high` rung on the ladder of
 * the funded model. only reachable on the subsidy proxy, so the ladder is always
 * the OpenRouter one.
 *
 * `high` by name, not position 0. position 0 was equivalent for as long as every
 * subsidy candidate's ladder started at `high`, but DeepSeek V4 Flash 0731
 * publishes `low, high, max` on the OpenRouter route, so the floor would have
 * silently dropped a level the moment that became the funded default — undoing
 * the `high`-effort result #1063 chose the tier on. a model publishing no `high`
 * falls back to its own floor.
 */
export function ossEffortFloor(ctx: { payload: ResolvedPayload }): EffortPosition {
  const alias = resolveRunAlias(ctx);
  const published = alias?.openRouterEffort ?? alias?.effort;
  if (!published) return 0;
  return rungPosition({ rung: SUBSIDY_RUNG, published }) ?? 0;
}

export function resolveRunEffort(ctx: {
  payload: ResolvedPayload;
  resolvedModel?: string | undefined;
}): RunEffort {
  const configured = ctx.payload.effort !== undefined;
  const position = ctx.payload.effort ?? DEFAULT_EFFORT_POSITION;
  const alias = resolveRunAlias(ctx);
  // a model we can't place gets no flag. sending one anyway looks safe —
  // opencode no-ops a variant a KNOWN model doesn't publish — but that guarantee
  // doesn't extend to a model it can't place: doing so hung
  // `providers-live (google/gemini-pro)` to its job timeout, twice. callers that
  // know the real model (the opencode harness, which resolves
  // `autoSelectModel()` itself) should pass it as `resolvedModel` so the ladder
  // resolves. see wiki/effort.md.
  if (!alias) return { position, configured, rung: undefined, alias: undefined };
  return {
    position,
    configured,
    rung: resolveModelRung({
      slug: alias.slug,
      position,
      useOpenRouter: !!ctx.payload.proxyModel,
    }),
    alias,
  };
}
