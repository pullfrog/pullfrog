import { readFile } from "node:fs/promises";
import { LIFECYCLE_HOOK_TIMEOUT_MS } from "../lifecycle.ts";
import { NON_COMMITTING_MODES } from "../modes.ts";
import type { ToolState } from "../toolState.ts";
import { log } from "../utils/cli.ts";
import {
  SPAWN_ACTIVITY_TIMEOUT_CODE,
  SPAWN_TIMEOUT_CODE,
  SpawnTimeoutError,
  spawn,
} from "../utils/subprocess.ts";
import {
  type AgentResult,
  type AgentRunContext,
  type AgentUsage,
  buildCommitPrompt,
  getGitStatus,
  hasPostRunIssues,
  MAX_POST_RUN_RETRIES,
  mergeAgentUsage,
  type PostRunIssues,
  type StopHookFailure,
} from "./shared.ts";

/**
 * derive "agent picked a review mode but never produced visible output" from
 * the literal facts on `toolState`. returns the selected mode when the gate
 * should fire, `null` otherwise — pure read, no side effects, safe to invoke
 * after every agent attempt.
 *
 * the gate normally follows `hadProgressComment` so silent runs (non-issue
 * events, dispatcher skipped seeding) don't fire a nudge there's no UI for.
 * `expectsReviewOutput` lets comment-free PR review runs retain the same final
 * review requirement without storing derived configuration in ToolState.
 *
 * `Review` and `IncrementalReview` have different valid exits:
 *   - Review: only `create_pull_request_review` counts. `report_progress` is
 *     not a substitute — a Review run that exits with just a summary comment
 *     has produced nothing reviewable on the PR. matches the hard-fail
 *     message at `expected = "create_pull_request_review"` below.
 *   - IncrementalReview: `report_progress` is a legitimate "no review
 *     warranted" exit, so either toolState flag short-circuits.
 * splitting per mode also closes the bypass where a subagent (e.g. a
 * `task`-dispatched `reviewfrog` lens) calls `report_progress` and silences
 * the gate even though the orchestrator never submitted a review.
 */
export function getUnsubmittedReview(
  toolState: ToolState,
  expectsReviewOutput = toolState.hadProgressComment
): "Review" | "IncrementalReview" | null {
  const mode = toolState.selectedMode;
  if (!expectsReviewOutput) return null;
  if (mode === "Review") return toolState.review ? null : "Review";
  if (mode === "IncrementalReview") {
    return toolState.review || toolState.finalSummaryWritten ? null : "IncrementalReview";
  }
  return null;
}

/**
 * hook output can flow into two size-sensitive places: the LLM resume prompt
 * (context window) and AgentResult.error (surfaced in GitHub comments capped
 * at 65535 chars). truncate the tail to keep both bounded; the tail is
 * usually the most actionable part of a failing script's output.
 */
const MAX_HOOK_OUTPUT_CHARS = 4096;

function truncateHookOutput(raw: string): string {
  if (raw.length <= MAX_HOOK_OUTPUT_CHARS) return raw;
  return `...(truncated, showing last ${MAX_HOOK_OUTPUT_CHARS} chars)\n${raw.slice(-MAX_HOOK_OUTPUT_CHARS)}`;
}

/**
 * run the user-configured stop hook.
 *
 * parallel to `executeLifecycleHook` (which soft-fails with a warning), but
 * returns structured output so agent harnesses can feed the failure back into
 * the session as a resume prompt.
 *
 * - non-zero exit → `StopHookFailure`, actionable: the output is fed to the
 *   agent so it can fix the underlying issue.
 * - timeout / spawn error → null, treated as passed: we can't usefully ask the
 *   agent to fix an infrastructure problem, and retrying would risk infinite
 *   loops.
 */
export async function executeStopHook(script: string): Promise<StopHookFailure | null> {
  log.info("» executing stop hook...");
  try {
    const result = await spawn({
      cmd: "bash",
      args: ["-c", script],
      env: process.env,
      timeout: LIFECYCLE_HOOK_TIMEOUT_MS,
      activityTimeout: 0,
      onStdout: (chunk) => process.stdout.write(chunk),
      onStderr: (chunk) => process.stderr.write(chunk),
    });
    if (result.exitCode === 0) {
      log.info("» stop hook passed");
      return null;
    }
    // include both streams — scripts often emit a benign warning to stderr
    // and the actionable error to stdout (or vice versa), and picking one
    // starves the agent of the diagnostic it needs. stderr-first so stdout
    // (typically longer, where truncation is more likely to bite) keeps its
    // tail — summaries/totals usually live at the end.
    const combined = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
    const output = truncateHookOutput(combined);
    log.info(`» stop hook failed with exit code ${result.exitCode}`);
    return { exitCode: result.exitCode, output };
  } catch (err) {
    const isTimeout =
      err instanceof SpawnTimeoutError &&
      (err.code === SPAWN_TIMEOUT_CODE || err.code === SPAWN_ACTIVITY_TIMEOUT_CODE);
    const msg = err instanceof Error ? err.message : String(err);
    log.warning(
      `stop hook ${isTimeout ? "timed out" : "failed to spawn"}: ${msg} — skipping retry`
    );
    return null;
  }
}

export function buildStopHookPrompt(failure: StopHookFailure): string {
  return [
    `STOP HOOK FAILED — the repo-configured stop hook exited with code ${failure.exitCode}. your work is not done until the hook exits cleanly. address the issue below and push any resulting changes to a pull request.`,
    "",
    "```",
    failure.output || "(no output)",
    "```",
  ].join("\n");
}

/** check whether the seeded summary file is byte-identical to its seed.
 * a missing or unreadable file returns false (don't nudge — the agent
 * may have legitimately deleted it, or the seed step failed; the read-
 * back path in main.ts handles both cases by skipping persist). */
async function isSummaryUnchanged(filePath: string, seed: string): Promise<boolean> {
  try {
    const current = await readFile(filePath, "utf8");
    return current === seed;
  } catch {
    return false;
  }
}

export function buildSummaryStalePrompt(filePath: string): string {
  return [
    `PR SUMMARY UNTOUCHED — the rolling PR summary file at \`${filePath}\` is byte-identical to its seed; this run did not edit it.`,
    "",
    "review the diff and update the file in place to reflect what changed in the PR. update intent, key changes, and any risks worth flagging — keep the existing section headings stable so incremental runs produce clean diffs.",
    "",
    "if the diff is genuinely too small or noisy to warrant rewriting (e.g. a one-line typo fix, a comment tweak, a formatting-only change), it's fine to leave the structure as-is — but at minimum confirm you considered it by appending one line to the appropriate section noting the run. silence is not an option; the snapshot is what the next review run reads as context.",
  ].join("\n");
}

export function buildUnsubmittedReviewPrompt(mode: "Review" | "IncrementalReview"): string {
  // mode-aware: Review mode's contract is "always submit one review" — its
  // mode prompt forbids `report_progress`, so the nudge here must not offer
  // it as an exit. IncrementalReview legitimately allows a report_progress
  // exit when there are no new issues since the last review (mode prompt
  // step 8), so the nudge mirrors that contract.
  if (mode === "Review") {
    return [
      `MISSING REVIEW OUTPUT — you selected Review mode but stopped without calling \`create_pull_request_review\`. the user has no visible signal that this run produced anything; the progress comment will be deleted on exit and no review will appear on the PR.`,
      "",
      "call `create_pull_request_review` now with your aggregated review (body + inline comments). pick the tier per the mode prompt — Review mode has no no-submit exit, so even informational `> ✅ No new issues found.` reviews must be submitted (with `approved: true`). the first call may error once with a diff-coverage nudge — retry the same call to proceed.",
      "",
      "do NOT stop again until `create_pull_request_review` has been called successfully.",
    ].join("\n");
  }
  return [
    `MISSING REVIEW OUTPUT — you selected IncrementalReview mode but stopped without calling \`create_pull_request_review\` or \`report_progress\`. the user has no visible signal that this run produced anything; the progress comment will be deleted on exit and no review will appear on the PR.`,
    "",
    "do exactly one of:",
    "- if you have findings: call `create_pull_request_review` now with your aggregated review (body + inline comments). the first call may error once with a diff-coverage nudge — retry the same call to proceed.",
    "- if there are genuinely no actionable findings since the last review (e.g. only formatting / comment / lockfile changes): call `report_progress` with a 1-2 sentence summary explaining that no review was warranted.",
    "",
    "do NOT stop again until one of those tools has been called successfully.",
  ].join("\n");
}

/**
 * check the post-run gates: did the stop hook pass, is the working tree
 * clean, and (when applicable) did the agent touch the rolling PR summary
 * snapshot or produce review output? returns everything that still needs
 * nudging so the caller can render a single combined resume prompt.
 *
 * reads run state directly off `ctx.toolState` so each invocation sees the
 * latest mutations from MCP tool calls. `skipSummaryStale` lets the loop
 * suppress the summary-stale check after the one-shot nudge has been
 * delivered (re-firing it would burn the retry budget on a soft gate the
 * agent has already decided not to act on).
 */
export async function collectPostRunIssues(
  ctx: AgentRunContext,
  options: { skipSummaryStale?: boolean } = {}
): Promise<PostRunIssues> {
  const issues: PostRunIssues = {};
  // stop hook is disabled — production audit (May 2026) showed 8/9 configured
  // scripts are foot-guns (duplicates of prepushScript, run on non-committing
  // modes against unchanged trees) burning the retry budget on un-fixable
  // gates. re-enable here + the dashboard block in `AgentSettings.tsx` once
  // we've decided on the right semantics (mode-gating vs. HEAD-changed gating
  // vs. deletion). see issue #714.
  // if (ctx.stopScript) {
  //   const failure = await executeStopHook(ctx.stopScript);
  //   if (failure) issues.stopHook = failure;
  // }
  // dirty-tree gate fires only in modes that legitimately commit. Review /
  // IncrementalReview / Plan complete via review submission or a Plan
  // comment, not by touching files — any tree dirt is incidental (e.g. a
  // tool-installed `node_modules/`) and the worktree is ephemeral, so
  // nudging the agent to commit it would produce a spurious PR. see
  // `NON_COMMITTING_MODES` in `action/modes.ts`.
  const status = getGitStatus();
  const mode = ctx.toolState.selectedMode;
  if (status) {
    if (mode && NON_COMMITTING_MODES.has(mode)) {
      log.info(`» dirty-tree gate suppressed: mode \`${mode}\` does not commit`);
    } else {
      issues.dirtyTree = status;
    }
  }
  const summaryFilePath = ctx.toolState.summaryFilePath;
  const summarySeed = ctx.toolState.summarySeed;
  if (!options.skipSummaryStale && summaryFilePath && summarySeed !== undefined) {
    const stale = await isSummaryUnchanged(summaryFilePath, summarySeed);
    if (stale) issues.summaryStale = { filePath: summaryFilePath };
  }
  const expectsReviewOutput =
    ctx.toolState.hadProgressComment ||
    (ctx.payload.progressComments === false &&
      ctx.payload.event.silent !== true &&
      ctx.payload.event.issue_number !== undefined);
  const unsubmittedMode = getUnsubmittedReview(ctx.toolState, expectsReviewOutput);
  if (unsubmittedMode) issues.unsubmittedReview = unsubmittedMode;
  return issues;
}

export function buildPostRunPrompt(issues: PostRunIssues): string {
  // order matches the terminal hard-fail order in `runPostRunRetryLoop` so
  // the prompt's emphasis (which gate the agent should fix first) lines up
  // with the user-visible failure message reported when retries exhaust.
  // both hard-fail gates first (`stopHook` → `unsubmittedReview`), then the
  // soft gates (`dirtyTree` → `summaryStale`).
  const parts: string[] = [];
  if (issues.stopHook) parts.push(buildStopHookPrompt(issues.stopHook));
  if (issues.unsubmittedReview) {
    parts.push(buildUnsubmittedReviewPrompt(issues.unsubmittedReview));
  }
  if (issues.dirtyTree) parts.push(buildCommitPrompt(issues.dirtyTree));
  if (issues.summaryStale) parts.push(buildSummaryStalePrompt(issues.summaryStale.filePath));
  return parts.join("\n\n---\n\n");
}

/**
 * terminal-only post-run finalize: re-checks the hard-fail gates after the
 * agent has exited and converts a successful result to a hard-fail when
 * `stopHook` or `unsubmittedReview` is still failing. used by harnesses
 * that inject follow-up turns via a mechanism other than the resume
 * callback (e.g. the Claude managed Stop hook + gate server). soft gates
 * (`dirtyTree`, `summaryStale`) are intentionally not re-checked here —
 * they never flip a successful run to failed.
 */
export async function finalizeAgentResult<R extends AgentResult>(params: {
  ctx: AgentRunContext;
  result: R;
}): Promise<R> {
  if (!params.result.success) return params.result;
  const issues = await collectPostRunIssues(params.ctx, { skipSummaryStale: true });
  if (issues.stopHook) {
    return {
      ...params.result,
      success: false,
      error: `stop hook failed (exit code ${issues.stopHook.exitCode}): ${issues.stopHook.output || "(no output)"}`,
    };
  }
  if (issues.unsubmittedReview) {
    const expected =
      issues.unsubmittedReview === "Review"
        ? "create_pull_request_review"
        : "create_pull_request_review or report_progress";
    return {
      ...params.result,
      success: false,
      error: `${issues.unsubmittedReview} mode finished without calling ${expected}`,
    };
  }
  return params.result;
}

/**
 * modes for which the post-run reflection turn is skipped. reflection costs a
 * full resume turn (~$0.50-0.80 per run on Opus, mostly cache-write) and only
 * pays for itself when the run actually produced novel, durable findings.
 *
 * `IncrementalReview` is the lowest-novelty mode — it's a tight delta review
 * against an existing PR with the prior summary already loaded as context.
 * the agent rarely discovers anything generalizable to next runs, so the
 * reflection turn is dead weight. initial `Review` still touches fresh PR
 * territory and benefits; `Build` / `Fix` / `AddressReviews` definitely do.
 */
const REFLECTION_SKIP_MODES: ReadonlySet<string> = new Set(["IncrementalReview"]);

function shouldRunReflection(mode: string | undefined): boolean {
  if (!mode) return true;
  return !REFLECTION_SKIP_MODES.has(mode);
}

/**
 * org-level analogue of `buildLearningsReflectionPrompt`, delivered on the same
 * reflection turn during --xrepo runs. nudges the agent to persist *structural*
 * cross-repo knowledge (how repos depend on each other, where shared code
 * lives, per-repo build/test entrypoints) — the durable map that makes the next
 * cross-repo run skip the rediscovery cost. deliberately scoped away from
 * single-repo facts, which belong in the per-repo learnings file.
 */
function buildXrepoLearningsReflectionPrompt(filePath: string): string {
  return [
    `CROSS-REPO REFLECTION — this was a cross-repo (--xrepo) run. did you discover anything about how these repos relate that a future cross-repo run would benefit from: dependency direction, where shared code / types / configs live, per-repo build & test entrypoints, or which repo owns a given concern?`,
    "",
    `the org-level cross-repo learnings file is at \`${filePath}\`. read it first if you haven't, then edit it in place — the server persists changes at end-of-run, there is no tool to call.`,
    "",
    `keep it STRUCTURAL and org-level. single-repo facts (one repo's test command, a local quirk) belong in that repo's own learnings file, not here. record the relationships between repos: "\`api\` consumes types from \`shared\`", "\`web\` and \`mobile\` both depend on \`design-system\`", "run \`pnpm -r build\` from \`platform\` before touching downstream repos".`,
    "",
    `same hygiene as the repo learnings file: \`## \` / \`### \` headings, one fact per \`- \` line ≤ 240 chars, evergreen only (no commit/PR/branch refs or line numbers), prune stale or wrong entries. if nothing structural is worth adding and the file looks healthy, leave it alone.`,
    "",
    `do NOT call \`set_output\` during this turn.`,
  ].join("\n");
}

/**
 * the combined post-run reflection nudge for a run: the repo-level learnings
 * reflection, plus the org-level cross-repo reflection when this is an --xrepo
 * run. each half is gated on its own seeded file — the two seeds are
 * independent best-effort steps in main.ts, so a failed repo-learnings seed
 * must not also suppress an org-level cross-repo reflection that did seed.
 * returns undefined when reflection should be skipped (neither file seeded, or
 * a reflection-skip mode like IncrementalReview).
 */
export function buildReflectionPrompt(toolState: ToolState): string | undefined {
  if (!shouldRunReflection(toolState.selectedMode)) return undefined;
  const parts: string[] = [];
  if (toolState.learningsFilePath) {
    parts.push(buildLearningsReflectionPrompt(toolState.learningsFilePath));
  }
  if (toolState.xrepoLearningsFilePath) {
    parts.push(buildXrepoLearningsReflectionPrompt(toolState.xrepoLearningsFilePath));
  }
  if (parts.length === 0) return undefined;
  return parts.join("\n\n---\n\n");
}

/**
 * prompt for a dedicated post-run reflection turn nudging the agent to edit
 * the rolling learnings file if it discovered anything worth persisting.
 *
 * this exists because passive "if you learned something, write it down"
 * instructions baked into mode checklists are frequently ignored — the agent
 * stays focused on the task and the meta-ask falls through. delivering it
 * as its own resume turn, with nothing competing for attention, raises the
 * fire rate substantially.
 *
 * the file is the single source of truth — there is no separate MCP tool
 * call. the server reads the file at end-of-run and persists any edits to
 * `Repo.learnings`.
 *
 * the prompt copy is shaped by repo-wide audits of the actual content the
 * agent has been writing (issue #619 in pullfrog/app). recurring failure
 * modes the framing pushes back on:
 *  - massive multi-paragraph "bullets" that are really mini-articles
 *  - facts anchored to moving repo state (PR / review / commit / branch
 *    refs, dates, version pins, line numbers) that decay within weeks
 *  - sections growing into giant flat lists with no internal structure,
 *    forcing future runs to read kilobytes to find one fact
 *
 * single litmus delivered in the prompt: "would a future run on this repo
 * do its work better because this bullet exists?". tool-quirk workarounds
 * are explicitly allowed when the agent burned calls discovering the
 * quirk this run — recording the workaround prevents next run from
 * repeating the waste. tradeoff: the same quirk gets duplicated across
 * repos, so when a quirk is fixed upstream in tool descriptions the
 * per-repo bullets go stale and we have no batch-invalidation path.
 */
function buildLearningsReflectionPrompt(filePath: string): string {
  return [
    `REFLECTION — before you finish, think back over this task: did you discover anything about this repo's setup, test commands, conventions, or patterns that is high-confidence and would reliably help future runs?`,
    "",
    `the rolling learnings file is at \`${filePath}\`. read it first if you haven't already, then edit it in place using your native file tools. the server reads this file at end-of-run and persists any changes — there is no tool to call.`,
    "",
    `structure:`,
    `- markdown hierarchy: \`## \` for top-level themes, \`### \` and deeper for sub-themes when a section grows. there is no fixed taxonomy — choose headings that fit THIS repo (e.g. for one repo \`## Migrations\` / \`## Local dev\` may make sense; for another, \`## API quirks\` / \`## Failure modes\`).`,
    `- **no section over ~300 lines.** when a section is approaching that, split it: introduce \`### \` subsections grouping related bullets, or hoist a coherent group into a new top-level \`## \` section. granular sections mean future runs read targeted line ranges instead of slurping the whole file. this is the most important hygiene rule on long-lived repos.`,
    `- if you find a flat unstructured list (legacy content from before this format), restructure it: read it, group related bullets, rewrite the file with \`## \` / \`### \` headings around them. don't preserve bad structure — fix it.`,
    "",
    `the only test: would a future run on this repo do its work better because this bullet exists? useful for future runs in this repo — prevent wasted tool calls, rabbit holes, and mistakes.`,
    "",
    `bullet hygiene:`,
    `- one fact per line starting with \`- \`, ≤ 240 chars.`,
    `- only add when high-confidence, broadly useful, evergreen.`,
    `- prune wrong or low-signal bullets; merge overlaps; dedupe across sections.`,
    "",
    `don't anchor facts to repo state that will move: PR / review / commit / branch refs, dates, version pins, line numbers. state the rule directly. if it needs the anchor to be load-bearing, it isn't evergreen.`,
    "",
    `tool-quirk bullets are fine when you burned calls discovering the quirk and a future run would repeat them. write the workaround, not the war story.`,
    "",
    `if you have nothing substantively new to add AND the existing entries still look healthy and well-structured, leave the file alone — just reply "done" and stop. silence is a valid outcome.`,
    "",
    `do NOT call \`set_output\` during this turn. the task's result output was already set on the previous turn; this reflection is a meta-turn for the learnings file only. ignore any standing instruction to call \`set_output\` "when done" — it does not apply here.`,
  ].join("\n");
}

/**
 * shared post-run retry loop used by every agent harness.
 *
 * checks the post-run gates (stop hook + dirty tree), and if either is
 * failing, invokes `resume` to let the agent fix and push in the same turn.
 * bails at `MAX_POST_RUN_RETRIES` attempts. the `canResume` predicate is
 * consulted before each retry — harnesses that can't re-enter the session
 * (e.g. claude without a sessionId) return false here.
 *
 * an optional `reflectionPrompt` fires exactly once, after the gates first
 * observe a clean state. it's a one-shot nudge (e.g. "update learnings if
 * relevant"), not a gate, so it does not consume the gate-retry budget. if
 * the reflection turn dirties the tree, the loop picks that up on the next
 * iteration via the normal dirty-tree gate.
 *
 * stop hook must pass for the run to succeed; persistent hook failures are
 * surfaced as `AgentResult.error`. dirty-tree-only failures preserve prior
 * behavior: they're logged but don't fail the run.
 */
export async function runPostRunRetryLoop<R extends AgentResult>(params: {
  ctx: AgentRunContext;
  initialResult: R;
  initialUsage: AgentUsage | undefined;
  resume: (context: { prompt: string; previousResult: R }) => Promise<R>;
  canResume?: ((result: R) => boolean) | undefined;
  reflectionPrompt?: string | undefined;
}): Promise<AgentResult> {
  let result = params.initialResult;
  let aggregatedUsage = params.initialUsage;
  let finalIssues: PostRunIssues = {};
  let gateResumeCount = 0;
  let pendingReflection = params.reflectionPrompt;
  // nudge for an untouched summary file fires AT MOST ONCE per run. once
  // delivered, subsequent collectPostRunIssues calls skip the check — the
  // agent may have legitimately decided no edit is warranted, and
  // re-prompting would burn the retry budget without adding signal.
  let summaryStaleNudged = false;

  while (gateResumeCount < MAX_POST_RUN_RETRIES) {
    if (!result.success) break;
    const issues = await collectPostRunIssues(params.ctx, {
      skipSummaryStale: summaryStaleNudged,
    });
    if (issues.summaryStale) summaryStaleNudged = true;
    finalIssues = issues;

    if (!hasPostRunIssues(issues)) {
      // gates are clean. if a reflection prompt is pending, deliver it once
      // and loop back to re-check — the reflection may have touched the tree.
      if (!pendingReflection) break;
      if (params.canResume && !params.canResume(result)) break;
      log.info("» post-run reflection: nudging agent to update learnings if relevant");
      const preReflection = result;
      // reflection is a meta-turn for editing the learnings file. it must not
      // affect the user-visible `result` output: some models (notably Gemini
      // Pro) re-trigger on the initial "call set_output when done" system
      // instruction during this turn and clobber the task-turn value with the
      // literal word "done". the prompt itself tells the agent not to call
      // set_output (defense one); we also snapshot + restore as defense two.
      const preReflectionOutput = params.ctx.toolState.output;
      const reflectionResult = await params.resume({
        prompt: pendingReflection,
        previousResult: result,
      });
      params.ctx.toolState.output = preReflectionOutput;
      aggregatedUsage = mergeAgentUsage(aggregatedUsage, reflectionResult.usage);
      pendingReflection = undefined;
      if (!reflectionResult.success) {
        // reflection is a best-effort nudge. its failure must not flip a
        // successful run to failed — the gated work is already done. keep
        // the pre-reflection result and exit without re-running the gates
        // (which would risk a flaky false-positive hook failure right after
        // it just passed).
        log.warning(
          `» reflection turn failed (${reflectionResult.error ?? "unknown error"}), preserving prior successful result`
        );
        result = preReflection;
        break;
      }
      // reflection replies are meta-asks ("done", "updated learnings with N
      // bullets") — not a task summary. keep the pre-reflection output so
      // the returned AgentResult still reflects what the run accomplished,
      // while inheriting reflection-specific fields the harness needs for
      // any subsequent gate retry (e.g. the new sessionId claude emits per
      // --resume invocation).
      // use `||` (not `??`) so an empty pre-reflection output falls through
      // to the reflection's reply. runs that only emit MCP tool calls and no
      // plain text leave result.output = "" — keeping "" would starve the
      // fallback path in handleAgentResult of anything to show.
      result = {
        ...reflectionResult,
        output: preReflection.output || reflectionResult.output,
      };
      continue;
    }

    // checks still ran even if we can't resume, so the failure gate below
    // can still catch a persistent stop-hook failure.
    if (params.canResume && !params.canResume(result)) {
      log.info("» post-run retry skipped: cannot resume agent session");
      break;
    }

    log.info(`» post-run retry (attempt ${gateResumeCount + 1}/${MAX_POST_RUN_RETRIES})`);
    const prompt = buildPostRunPrompt(issues);
    // summary-stale is a soft gate that must never flip a successful run to
    // failed. when it's the only issue and the resume itself errors out,
    // restore the pre-resume successful result and break — persistSummary
    // detects the unchanged file via its seed comparison and skips the DB
    // write on its own, so no further coordination is needed here.
    const onlySummaryStale =
      issues.summaryStale !== undefined &&
      issues.stopHook === undefined &&
      issues.dirtyTree === undefined;
    const preResume = result;
    result = await params.resume({ prompt, previousResult: result });
    aggregatedUsage = mergeAgentUsage(aggregatedUsage, result.usage);
    if (!result.success && onlySummaryStale) {
      log.warning(
        `» summary-stale resume turn failed (${result.error ?? "unknown error"}), preserving prior successful result`
      );
      result = preResume;
      break;
    }
    gateResumeCount++;
  }

  // we exhausted retries without observing a clean state — finalIssues
  // reflects pre-resume state, so re-check to see what the last resume
  // actually did. when the subprocess failed we skip: its own error is more
  // actionable than a stale "stop hook still failing" message. when the loop
  // already observed a clean state we skip: re-running the hook risks flaky
  // false-positive failures right after it just passed.
  if (gateResumeCount > 0 && result.success && hasPostRunIssues(finalIssues)) {
    // re-check the gates that can actually fail the run (stop hook /
    // dirty tree / unsubmitted review). summary-stale is intentionally
    // NOT re-checked here: we already delivered the one-shot nudge, and
    // a still-unchanged file at this point is the agent's deliberate
    // choice.
    finalIssues = await collectPostRunIssues(params.ctx, { skipSummaryStale: true });
  }

  if (result.success && finalIssues.stopHook) {
    const retryNote =
      gateResumeCount > 0
        ? ` after ${gateResumeCount} retry ${gateResumeCount === 1 ? "attempt" : "attempts"}`
        : "";
    return {
      ...result,
      success: false,
      error: `stop hook failed${retryNote} (exit code ${finalIssues.stopHook.exitCode}): ${finalIssues.stopHook.output || "(no output)"}`,
      usage: aggregatedUsage,
    };
  }

  if (result.success && finalIssues.unsubmittedReview) {
    const retryNote =
      gateResumeCount > 0
        ? ` after ${gateResumeCount} retry ${gateResumeCount === 1 ? "attempt" : "attempts"}`
        : "";
    // mode-aware: Review's contract requires a review submission; only
    // IncrementalReview accepts `report_progress` as an exit. mirroring
    // the nudge prompt avoids contradicting the agent-facing copy.
    const expected =
      finalIssues.unsubmittedReview === "Review"
        ? "create_pull_request_review"
        : "create_pull_request_review or report_progress";
    return {
      ...result,
      success: false,
      error: `${finalIssues.unsubmittedReview} mode finished without calling ${expected}${retryNote}`,
      usage: aggregatedUsage,
    };
  }

  return { ...result, usage: aggregatedUsage };
}
