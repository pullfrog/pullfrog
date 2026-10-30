import { type } from "arktype";
import { formatMcpToolRef } from "../external.ts";
import type { Mode } from "../modes.ts";
import { apiFetch } from "../utils/apiFetch.ts";
import type { ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";

export const SelectModeParams = type({
  mode: type.string.describe(
    "the name of the mode to select (e.g., 'Build', 'Plan', 'Review', 'IncrementalReview', 'Fix', 'AddressReviews', 'Task', 'ResolveConflicts')"
  ),
  "issue_number?": type("number").describe(
    "optional issue number; when provided with Plan mode, used to look up an existing plan comment for this issue (edit vs create)"
  ),
});

function resolveMode(modes: Mode[], modeName: string): Mode | null {
  return modes.find((m) => m.name.toLowerCase() === modeName.toLowerCase()) ?? null;
}

function buildModeOverrides(t: (name: string) => string): Record<string, string> {
  return {
    PlanEdit: `### Checklist (editing existing plan)

An existing plan comment was found for this issue. Update that comment with the revised plan — do not create a new plan comment.

1. **task list**: create your task list for this run as your first action.
2. Use \`previousPlanBody\` from this response as the plan to revise; do not call \`get_issue\` or \`get_issue_comments\`.
3. Revise the plan based on the user's request:
   - incorporate the current plan (\`previousPlanBody\`) and the user's revision request
   - gather relevant codebase context (file paths, architecture notes from AGENTS.md)
   - produce a structured plan with clear milestones
4. Call \`${t("report_progress")}\` with the full revised plan text and \`{ target_plan_comment: true }\` so it updates the existing plan comment (not the progress comment).
5. Then post a short note to the progress comment (e.g. "Plan has been updated in the comment above.") via \`${t("report_progress")}\` so it is not left as "Leaping...".`,
  };
}

type OrchestratorGuidance = {
  modeName: string;
  description: string;
  orchestratorGuidance: string;
};

// IncrementalReview inherits Review's user instructions; Fix has its own prompt.
const modeInstructionParent: Record<string, string> = {
  IncrementalReview: "Review",
};

function buildOrchestratorGuidance(
  ctx: ToolContext,
  mode: Mode,
  overrideGuidance?: string
): OrchestratorGuidance {
  const hardcoded = overrideGuidance ?? mode.prompt ?? "";
  const lookupKey = modeInstructionParent[mode.name] ?? mode.name;
  const userInstructions = ctx.modeInstructions[lookupKey] ?? "";
  // unlabeled, these lost to the checklist's own drop rules (e.g. Review's "drop style preferences")
  const repoSection = userInstructions
    ? `### Repository instructions\n\nSet by this repository's maintainers. Where they conflict with the steps above, including asking for feedback those steps drop, follow them.\n\n${userInstructions}`
    : "";
  const guidance = [hardcoded, repoSection].filter(Boolean).join("\n\n");
  return {
    modeName: mode.name,
    description: mode.description,
    orchestratorGuidance: guidance,
  };
}

// matches the API response for /repo/[owner]/[repo]/issue/[issueNumber]/plan-comment
export type PlanCommentResponsePayload = { error: string } | { commentId: number; body: string };

// IMPORTANT: this route authenticates via GitHub installation token (getEnrichedRepo),
// NOT the Pullfrog API JWT (ctx.apiToken). use ctx.githubInstallationToken here.
// see wiki/api-auth.md for the two auth patterns.
async function fetchExistingPlanComment(
  ctx: ToolContext,
  issueNumber: number
): Promise<Extract<PlanCommentResponsePayload, { commentId: number }> | null> {
  if (!ctx.githubInstallationToken) return null;
  try {
    const response = await apiFetch({
      path: `/api/repo/${ctx.repo.owner}/${ctx.repo.name}/issue/${issueNumber}/plan-comment`,
      method: "GET",
      headers: { authorization: `Bearer ${ctx.githubInstallationToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await response.json()) as PlanCommentResponsePayload;
    return response.ok && "commentId" in data ? data : null;
  } catch {
    return null;
  }
}

const SUMMARY_MODES = new Set(["Review", "IncrementalReview", "Task"]);

/** modes that gain the PR summary edit step when toolState.summaryFilePath is set.
 *
 * NOTE: this snapshot is an internal artifact consumed by future agent runs. it is
 * deliberately NOT shaped by user-supplied summary instructions — those would warp
 * the durable agent context. user-facing summarization (e.g. the review body's
 * "Reviewed changes" section) is governed by review-mode prompts and review
 * instructions, separately from this snapshot. */
function buildSummaryAddendum(t: (name: string) => string, ctx: ToolContext): string {
  const filePath = ctx.toolState.summaryFilePath;
  if (!filePath) return "";
  return `### PR summary snapshot — required step

A rolling PR summary lives at \`${filePath}\`. It is your durable cross-run agent context — a functional summary of what this PR does, the subsystems and files it touches, the material behavior of its changes, and any risks or open questions worth carrying forward. It is NOT a chronological log of past review runs; commit-level history can already be reconstructed from \`${t("list_pull_request_reviews")}\`.

How to use it:

- read \`${filePath}\` at the START of the run, alongside the diff. it represents what previous agent runs already understood about this PR — absorb it before picking lenses or crafting subagent dispatch prompts. if it's a fresh seed (file is one or two lines), this is a first review and you'll be filling it in from the diff.
- let the snapshot inform triage and dispatch. when it already tracks a risk, your lens prompts to subagents are stronger when they reference that context (e.g. "the JSDoc explicitly scopes to code points — do not flag grapheme-cluster issues" if the snapshot already documents that contract). when something the snapshot tracks is now resolved by new commits, note that. when new commits introduce something the snapshot doesn't yet describe, that's exactly where your fan-out should focus.
- update the file in place to reflect the PR's CURRENT state. revise stale claims, drop resolved risks, add new behavior or risks. accuracy over breadth — every claim must be grounded in the diff. write for the next agent run, not for a human.
- structure however serves THIS PR. there is no required section template. a refactor might organize by renamed export and call-site impact; a feature by capability; a billing change by money path. a compact note of which commit ranges have been reviewed should always be present so future runs scope correctly, but the rest is your call. when the structure works across runs, keep it stable so range-diffs are clean; when the PR's character changes (e.g. scope expands), reshape.

Do NOT call \`${t("create_issue_comment")}\` for the summary — the server reads this file at end-of-run and persists it. The file edit is mandatory regardless of whether a review is submitted; the snapshot feeds the next run.`;
}

export function SelectModeTool(ctx: ToolContext) {
  const t = (name: string) => formatMcpToolRef(ctx.agentId, name);
  const overrides = buildModeOverrides(t);

  return tool({
    name: "select_mode",
    mutates: true,
    description:
      "Select a mode and receive step-by-step guidance on how to handle the task. Call this to understand the best workflow for the current mode. " +
      'Example: `select_mode({ mode: "Review" })` or `select_mode({ mode: "Plan", issue_number: 1234 })`.',
    parameters: SelectModeParams,
    execute: execute(async (params) => {
      const guidanceFor = (mode: Mode) => {
        const base = buildOrchestratorGuidance(ctx, mode);
        if (!SUMMARY_MODES.has(mode.name)) return base;
        const addendum = buildSummaryAddendum(t, ctx);
        if (addendum.length === 0) return base;
        return {
          ...base,
          orchestratorGuidance: `${base.orchestratorGuidance}\n\n${addendum}`,
          summaryFilePath: ctx.toolState.summaryFilePath,
        };
      };

      // a refused switch re-serves the ACTIVE mode's guidance rather than a bare
      // error: the refusal arrives as an ordinary tool result, and an agent that
      // reads it as "switched" keeps working under a mode it is not in — observed
      // on a run that announced AddressReviews, stayed in Review, and submitted a
      // review carrying none of Review's format.
      if (ctx.toolState.selectedMode) {
        const active = ctx.toolState.selectedMode;
        const error = `mode already selected: "${active}". mode selection is final — this call changed NOTHING and you are still in "${active}". Do not proceed as though you switched modes. "${active}" guidance is repeated below; finish its steps. If the task genuinely belongs to another mode, do what you can within "${active}" and say so in your final summary.`;
        const activeMode = resolveMode(ctx.modes, active);
        if (!activeMode) return { error };
        // a Plan run that already routed to PlanEdit must get PlanEdit back. the
        // plain Plan checklist says "do NOT set target_plan_comment", the exact
        // opposite of the override the agent is under, so re-serving it would
        // hand over a newer, authoritative-looking instruction to revise the
        // wrong comment.
        if (activeMode.name === "Plan" && ctx.toolState.existingPlanCommentId !== undefined) {
          return {
            ...buildOrchestratorGuidance(ctx, activeMode, overrides.PlanEdit),
            previousPlanBody: ctx.toolState.previousPlanBody,
            error,
          };
        }
        return { ...guidanceFor(activeMode), error };
      }

      const modeName = params.mode;

      const selectedMode = resolveMode(ctx.modes, modeName);

      if (!selectedMode) {
        const availableModes = ctx.modes.map((m) => m.name).join(", ");
        return {
          error: `mode "${modeName}" not found. available modes: ${availableModes}`,
          availableModes: ctx.modes.map((m) => ({
            name: m.name,
            description: m.description,
          })),
        };
      }

      ctx.toolState.selectedMode = selectedMode.name;

      if (selectedMode.name === "Plan") {
        const issueNumber = params.issue_number ?? ctx.payload.event.issue_number;
        if (issueNumber !== undefined) {
          const existing = await fetchExistingPlanComment(ctx, issueNumber);
          if (existing !== null) {
            ctx.toolState.existingPlanCommentId = existing.commentId;
            ctx.toolState.previousPlanBody = existing.body;
            return {
              ...buildOrchestratorGuidance(ctx, selectedMode, overrides.PlanEdit),
              previousPlanBody: existing.body,
            };
          }
        }
      }

      return guidanceFor(selectedMode);
    }),
  });
}
