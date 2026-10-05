import * as yes from "yes";
import type { AgentUsage } from "../agents/shared.ts";
import type { ToolContext } from "../mcp/server.ts";
import { apiFetch } from "./apiFetch.ts";
import { log } from "./cli.ts";
import { isTransientNetworkError } from "./isTransientNetworkError.ts";

/**
 * String-valued PATCH fields (all serialized identically on the wire):
 *  - artifact node IDs (`*NodeId`, `summarySnapshot`) — PATCHed incrementally
 *    by MCP tools as GitHub entities are created during the run.
 *  - `model` — the resolved/effective model the run actually ran on (proxy spec
 *    for router/oss, post-fallback slug otherwise; NOT the configured
 *    `Repo.model` slug), PATCHed once at end-of-run so per-model cost analytics
 *    don't parse the audit-only `payload`.
 * Keep in sync with `STRING_FIELDS` in `app/api/workflow-run/[runId]/route.ts`.
 */
const STRING_KEYS = [
  "prNodeId",
  "issueNodeId",
  "reviewNodeId",
  "planCommentNodeId",
  "summarySnapshot",
  "model",
  "agent",
  "credential",
] as const;

/**
 * Number-valued usage fields — aggregated across all agent calls and PATCHed
 * once at end-of-run. Token counts are Int4 on the DB side (ample for any
 * realistic run); `costUsd` is a Decimal populated by provider-reported dollar
 * amounts. Keep in sync with `INT_FIELDS` + `DECIMAL_FIELDS` in the server route.
 */
const NUMBER_KEYS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "costUsd",
] as const;

export type WorkflowRunPatch = Partial<Record<(typeof STRING_KEYS)[number], string>> &
  Partial<Record<(typeof NUMBER_KEYS)[number], number>>;

/** PATCH workflow-run fields (Pullfrog JWT, not GitHub). */
export async function patchWorkflowRunFields(
  ctx: ToolContext,
  fields: WorkflowRunPatch
): Promise<void> {
  if (ctx.runId === undefined || !ctx.apiToken) return;
  // a 404 means Pullfrog never dispatched the run or never claimed its
  // reservation; the claim happens at setup — strictly before any PATCH — so
  // neither can change later in this run. see #1153.
  if (ctx.toolState.workflowRunUnclaimed) return;
  const body: Record<string, string | number> = {};
  for (const key of STRING_KEYS) {
    const value = fields[key];
    if (typeof value === "string" && value.length > 0) {
      body[key] = value;
    }
  }
  for (const key of NUMBER_KEYS) {
    const value = fields[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      body[key] = value;
    }
  }
  if (Object.keys(body).length === 0) return;
  try {
    await yes.mutation({
      run: async () => {
        const response = await apiFetch({
          path: `/api/workflow-run/${ctx.runId}`,
          method: "PATCH",
          headers: {
            authorization: `Bearer ${ctx.apiToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        if (response.status === 404) {
          // routine for a run Pullfrog didn't dispatch (a custom workflow on the user's own
          // key), so no annotation: the runner can't act on it, and the server logs each one.
          ctx.toolState.workflowRunUnclaimed = true;
          log.info(`» Pullfrog has no record of run ${ctx.runId}; skipping run metadata updates`);
          return;
        }
        if (!response.ok) throw new Error(`PATCH workflow-run: ${response.status}`);
      },
      // only retry transient network errors; explicit HTTP failures throw
      // a status-bearing message and should fail fast.
      retry: (error, attempt) =>
        isTransientNetworkError(error) ? yes.delay([2000, 4000], attempt) : -1,
      name: "patchWorkflowRunFields",
    })();
  } catch (error) {
    // not necessarily exhausted — an explicit HTTP status bails on the first
    // attempt via the predicate above, so say "failed" rather than implying
    // three attempts happened.
    log.warning(`patchWorkflowRunFields failed: ${error}`);
  }
}

/**
 * Postgres INTEGER / Prisma Int4 is signed 32-bit. Aggregated usage won't
 * realistically hit this in a single run (2.1B tokens ≈ $6000+ of input on
 * Claude Opus), but clamping here keeps the wire payload self-consistent:
 * the server rejects out-of-range INT fields individually, so without a
 * client-side clamp a single overflow would write a partial row where
 * some columns land and others silently don't.
 */
const INT4_MAX = 2_147_483_647;

function clampInt(value: number, field: (typeof NUMBER_KEYS)[number]): number {
  if (value > INT4_MAX) {
    log.warning(
      `aggregateUsage: ${field}=${value} exceeds INT4_MAX (${INT4_MAX}) — clamping so the rest of the usage row still persists.`
    );
    return INT4_MAX;
  }
  return value;
}

/**
 * Sum per-agent usage entries into a single WorkflowRunPatch payload.
 * Returns an empty object when there's nothing to report, which causes
 * `patchWorkflowRunFields` to no-op — safe to call unconditionally from
 * end-of-run paths. Zero-valued fields are dropped so the DB only stores
 * positive sums (and NULL means "not reported").
 *
 * Token sums are clamped to INT4_MAX to guarantee the payload the server
 * sees is always self-consistent across all numeric columns.
 */
export function aggregateUsage(entries: AgentUsage[]): WorkflowRunPatch {
  if (entries.length === 0) return {};

  const sum = entries.reduce(
    (acc, e) => ({
      inputTokens: acc.inputTokens + e.inputTokens,
      outputTokens: acc.outputTokens + e.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + (e.cacheReadTokens ?? 0),
      cacheWriteTokens: acc.cacheWriteTokens + (e.cacheWriteTokens ?? 0),
      costUsd: acc.costUsd + (e.costUsd ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }
  );

  const out: WorkflowRunPatch = {};
  if (sum.inputTokens > 0) out.inputTokens = clampInt(sum.inputTokens, "inputTokens");
  if (sum.outputTokens > 0) out.outputTokens = clampInt(sum.outputTokens, "outputTokens");
  if (sum.cacheReadTokens > 0)
    out.cacheReadTokens = clampInt(sum.cacheReadTokens, "cacheReadTokens");
  if (sum.cacheWriteTokens > 0)
    out.cacheWriteTokens = clampInt(sum.cacheWriteTokens, "cacheWriteTokens");
  if (sum.costUsd > 0) out.costUsd = sum.costUsd;
  return out;
}
