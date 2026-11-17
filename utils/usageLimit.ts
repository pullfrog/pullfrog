import type { ToolContext } from "../mcp/server.ts";
import { stripProviderPrefix } from "../models.ts";
import type { ToolState } from "../toolState.ts";
import { CredentialPoolRefusedError } from "./apiKeys.ts";
import { log } from "./cli.ts";
import { patchWorkflowRunFields } from "./patchWorkflowRunFields.ts";
import { isUsageLimitFailure } from "./runErrorRenderer.ts";
import { subscriptionFor, subscriptionNameSchema } from "./subscriptionCredentials.ts";
import { probeSubscription } from "./subscriptionProbe.ts";

type ReportCtx = Pick<ToolContext, "runId" | "apiToken" | "toolState">;

/**
 * Tell Pullfrog this run failed on a usage window that lifts on its own, and when the provider
 * says it lifts. The server sends no failure email over one, and re-runs a review once it has
 * reset. see wiki/limit-retry.md.
 */
export async function reportUsageLimit(ctx: ReportCtx, error: unknown): Promise<void> {
  const resets = await usageLimitResets(ctx, error);
  if (!resets) return;
  const known = resets.flatMap((reset) => (reset ? [reset.getTime()] : []));
  const resetAt = known.length ? new Date(Math.min(...known)).toISOString() : undefined;
  log.info(`» the run hit a usage limit${resetAt ? ` that resets at ${resetAt}` : ""}`);
  await patchWorkflowRunFields(ctx, { usageLimited: true, limitResetAt: resetAt });
}

/** null unless the run died on a usage limit; else when each window it hit resets, if the provider says. */
async function usageLimitResets(ctx: ReportCtx, error: unknown) {
  if (error instanceof CredentialPoolRefusedError) {
    const resets = error.refused.flatMap((credential) =>
      credential.verdict.status === "exhausted" &&
      subscriptionNameSchema.safeParse(credential.name).success
        ? [credential.verdict.resetAt]
        : []
    );
    return resets.length ? resets : null;
  }
  const errorMessage = error instanceof Error ? error.message : String(error);
  const agentDiagnostic = ctx.toolState.agentDiagnostic;
  if (!isUsageLimitFailure({ errorMessage, agentDiagnostic })) return null;
  return [await probeReset(ctx.toolState)];
}

/** a limit hit mid-run names its reset only in prose, so ask the subscription, as the pool does at startup. */
async function probeReset(toolState: ToolState): Promise<Date | undefined> {
  if (toolState.credential !== "subscription" || !toolState.model) return undefined;
  const name = subscriptionNameSchema.safeParse(subscriptionFor(toolState.model)?.env);
  const value = name.success ? process.env[name.data] : undefined;
  if (!name.success || !value) return undefined;
  const model = stripProviderPrefix(toolState.model);
  const verdict = await probeSubscription({ name: name.data, value, model });
  return verdict.status === "exhausted" ? verdict.resetAt : undefined;
}
