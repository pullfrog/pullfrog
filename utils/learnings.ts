import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentToolUseEvent } from "../agents/shared.ts";
import type { Payload, Rollout } from "../external.ts";
import type { ToolContext } from "../mcp/server.ts";
import type { ToolState } from "../toolState.ts";
import { apiFetch } from "./apiFetch.ts";
import { log } from "./cli.ts";
import {
  countLines,
  createDiffCoverageState,
  type DiffCoverageState,
  getDiffCoverageBreakdown,
  recordDiffReadFromToolUse,
} from "./diffCoverage.ts";
import {
  LEARNINGS_BUDGET,
  MAX_LEARNINGS_LENGTH,
  truncateAtLineBoundary,
} from "./learningsTruncate.ts";
import type { LearningsHeading } from "./runContext.ts";

export { LEARNINGS_BUDGET, MAX_LEARNINGS_LENGTH, truncateAtLineBoundary };

/**
 * Repo-level learnings — operational facts about a repo (setup steps, test
 * commands, conventions, gotchas) that accumulate across agent runs and feed
 * back into future runs as durable context. Modeled on the PR-summary tmpfile
 * pattern (see action/utils/prSummary.ts):
 *
 *   1. server seeds `pullfrog-learnings.md` with the verbatim body of
 *      `Repo.learnings` (or empty for fresh repos), and parses headings
 *      server-side (`utils/learningsToc.ts`), which the runner uses only to
 *      count the sections a run read
 *   2. the LEARNINGS prompt section names the file and tells the agent to
 *      search it rather than read it whole; its headings are not listed
 *   3. agent edits the file in place at end-of-run during the reflection
 *      turn (see action/agents/postRun.ts buildLearningsReflectionPrompt)
 *   4. main.ts reads the file back at end-of-run and PATCHes
 *      `/api/repo/[owner]/[repo]/learnings` if the body changed
 *
 * Edit-in-place avoids stuffing the entire learnings list into both the
 * prompt context and an `update_learnings` MCP tool call (which previously
 * required passing the FULL merged list as a string parameter — an
 * output-token tax that grew linearly with the learnings size).
 *
 * Section structure is agent-curated. The reflection prompt teaches
 * hierarchy + a soft 300-line-per-section cap to keep sections small
 * enough to read whole on long-lived repos; there is no fixed taxonomy.
 *
 * The PATCH carries the seed beside the edited body, so the server merges the
 * run's edit into whatever another run stored meanwhile instead of replacing
 * it. Every run ends on one `» learnings:` line saying what it read and
 * changed. See wiki/learnings.md.
 */

export const LEARNINGS_FILE_NAME = "pullfrog-learnings.md";
export const XREPO_LEARNINGS_FILE_NAME = "pullfrog-xrepo-learnings.md";

export function learningsFilePath(tmpdir: string): string {
  return join(tmpdir, LEARNINGS_FILE_NAME);
}

export function xrepoLearningsFilePath(tmpdir: string): string {
  return join(tmpdir, XREPO_LEARNINGS_FILE_NAME);
}

/** seed the rolling learnings tmpfile with the verbatim DB body (or empty
 * string for fresh repos). returns the absolute path. the parsed headings
 * are carried separately via `RepoSettings.learningsHeadings`, so the file on
 * disk is just the body — no markers, no scaffold, no in-file TOC. */
export async function seedLearningsFile(params: {
  tmpdir: string;
  current: string | null;
}): Promise<string> {
  const path = learningsFilePath(params.tmpdir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, params.current ?? "", "utf8");
  return path;
}

/** seed the org-level cross-repo learnings tmpfile (--xrepo runs only). */
export async function seedXrepoLearningsFile(params: {
  tmpdir: string;
  current: string | null;
}): Promise<string> {
  const path = xrepoLearningsFilePath(params.tmpdir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, params.current ?? "", "utf8");
  return path;
}

/** the `no-learnings` rollout's holdout arm: the run gets no learnings file, so runs with and
 * without one can be compared. see wiki/learnings.md. */
export function learningsWithheld(payload: Payload): boolean {
  return (payload.rollouts ?? []).includes("no-learnings" satisfies Rollout);
}

/** start counting which lines of the seeded file the agent reads, section by section. */
export function trackLearningsReads(params: {
  path: string;
  body: string;
  headings: LearningsHeading[];
}): DiffCoverageState {
  return createDiffCoverageState({
    diffPath: params.path,
    totalLines: countLines({ content: params.body }),
    tocEntries: params.headings.map((heading) => ({
      filename: heading.title,
      startLine: heading.startLine,
      endLine: heading.endLine,
    })),
  });
}

/** count a read of the learnings file. reads in the reflection turn are the edit, not use. */
export function recordLearningsRead(toolState: ToolState, event: AgentToolUseEvent): void {
  if (toolState.learningsReflected) return;
  const read = recordDiffReadFromToolUse({
    state: toolState.learningsReads,
    toolName: event.toolName,
    input: event.input,
    cwd: process.cwd(),
  });
  // a search or shell command naming the file shows it was consulted, though not which lines
  if (!read && JSON.stringify(event.input ?? null).includes(LEARNINGS_FILE_NAME)) {
    toolState.learningsLookups = (toolState.learningsLookups ?? 0) + 1;
  }
}

/** the agent-edited file, capped. `cut` is how many characters the cap dropped from its tail. */
type LearningsFile = { body: string; cut: number };

async function loadLearningsFile(path: string): Promise<LearningsFile | null> {
  let raw: string;
  try {
    raw = (await readFile(path, "utf8")).trim();
  } catch {
    return null;
  }
  const body = truncateAtLineBoundary(raw, MAX_LEARNINGS_LENGTH);
  return { body, cut: raw.length - body.length };
}

/** read the agent-edited learnings file. returns null when the file is
 * missing or unreadable (treated as "no change"). caps content at the
 * server's max length to avoid a 400 round-trip. */
export async function readLearningsFile(path: string): Promise<string | null> {
  const file = await loadLearningsFile(path);
  return file ? file.body : null;
}

/** how many bullets of `from` are absent from `other`, counted as a multiset. */
function countBulletsMissing(params: { from: string; other: string }): number {
  const remaining = new Map<string, number>();
  for (const line of params.other.split("\n")) {
    remaining.set(line, (remaining.get(line) ?? 0) + 1);
  }
  let missing = 0;
  for (const line of params.from.split("\n")) {
    if (!/^\s*- /.test(line)) continue;
    const count = remaining.get(line) ?? 0;
    if (count === 0) missing++;
    else remaining.set(line, count - 1);
  }
  return missing;
}

function describeReads(toolState: ToolState): string {
  // codex reads files through its shell, which reports no file or line range
  if (!toolState.learningsReads || toolState.agent === "codex") return "reads untracked";
  const coverage = getDiffCoverageBreakdown({ state: toolState.learningsReads });
  const sections = coverage.files.filter((section) => section.coveredLines > 0).length;
  const n = toolState.learningsLookups ?? 0;
  const lookups = n ? `, ${n} other tool call${n === 1 ? "" : "s"}` : "";
  return `read ${sections}/${coverage.files.length} sections (${coverage.coveredLines}/${coverage.totalLines} lines)${lookups}`;
}

function describeEdit(params: { seed: string; file: LearningsFile }): string {
  const added = countBulletsMissing({ from: params.file.body, other: params.seed });
  const removed = countBulletsMissing({ from: params.seed, other: params.file.body });
  const cut = params.file.cut > 0 ? `, ${params.file.cut} chars cut at the cap` : "";
  return `+${added} -${removed} bullets, ${params.seed.length} -> ${params.file.body.length} chars${cut}`;
}

/**
 * PATCH an edited body together with the seed the run started from, which is what lets the
 * server merge it into whatever another run stored meanwhile. Best-effort: a failure is logged
 * and returned as the outcome the run's log line reports.
 */
async function saveLearnings(
  ctx: ToolContext,
  params: { label: string; path: string; body: string; seed: string }
): Promise<string> {
  // an empty apiToken means run-context never authenticated this run (a 404
  // degrades to `defaultRunContext`), so this PATCH is a guaranteed 401 — it
  // was the single largest source of production 401s. skip it and say why
  // once, rather than firing a request we already know cannot succeed (#1198).
  if (!ctx.apiToken) {
    log.warning(
      `» ${params.label} not persisted: this run has no Pullfrog API token (run-context did not authenticate it)`
    );
    return "not saved (no API token)";
  }
  try {
    const response = await apiFetch({
      path: params.path,
      method: "PATCH",
      headers: {
        authorization: `Bearer ${ctx.apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ learnings: params.body, seed: params.seed }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const error = await response.text().catch(() => "(no body)");
      // promoted from debug → warning: this path means the agent edited the
      // file (we already short-circuited the unchanged-from-seed case above)
      // but the PATCH dropped it on the floor. silently losing real work is
      // worse than the noise of a CI warning.
      log.warning(`${params.label} persist failed (${response.status}): ${error}`);
      return `not saved (${response.status})`;
    }
    return "saved";
  } catch (err) {
    log.warning(
      `${params.label} persist failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return "not saved";
  }
}

/**
 * Read the agent-edited repo-level learnings tmpfile and PATCH it to
 * `Repo.learnings`.
 *
 * Best-effort: any failure is logged and does not affect the run's success
 * status. Skips the PATCH when the file is byte-trim-identical to its seed —
 * the agent didn't touch it, so writing the same content back would just
 * burn an API round-trip.
 *
 * `learningsPersistAttempted` guards against double-execution between the
 * normal end-of-run path and the SIGINT/SIGTERM handler.
 *
 * Ends on the run's `» learnings:` line: what it read before the reflection
 * turn, what it changed, and whether that was saved.
 */
export async function persistLearnings(ctx: ToolContext): Promise<void> {
  const state = ctx.toolState;
  if (!state.learningsFilePath || state.learningsPersistAttempted) return;
  state.learningsPersistAttempted = true;
  const file = await loadLearningsFile(state.learningsFilePath);
  if (!file) {
    log.debug(
      `learnings tmpfile missing or unreadable at ${state.learningsFilePath} — skipping persist`
    );
    return;
  }
  const seed = state.learningsSeed?.trim() ?? "";
  let outcome = "unchanged";
  if (state.learningsLocked) outcome = "locked";
  else if (file.body !== seed) {
    outcome = await saveLearnings(ctx, {
      label: "learnings",
      path: `/api/repo/${ctx.repo.owner}/${ctx.repo.name}/learnings`,
      body: file.body,
      seed,
    });
  }
  log.info(`» learnings: ${describeReads(state)}, ${describeEdit({ seed, file })}, ${outcome}`);
}

/**
 * Read the agent-edited cross-repo learnings tmpfile and PATCH it to
 * `Account.xrepoLearnings`. Org-level analogue of `persistLearnings` —
 * same best-effort + unchanged-from-seed gating. Only seeded on --xrepo runs,
 * so this is a no-op when `xrepoLearningsFilePath` is unset.
 */
export async function persistXrepoLearnings(ctx: ToolContext): Promise<void> {
  const state = ctx.toolState;
  if (!state.xrepoLearningsFilePath || state.learningsLocked) return;
  if (state.xrepoLearningsPersistAttempted) return;
  state.xrepoLearningsPersistAttempted = true;
  const file = await loadLearningsFile(state.xrepoLearningsFilePath);
  const seed = state.xrepoLearningsSeed?.trim() ?? "";
  if (!file || file.body === seed) {
    log.debug("xrepo learnings tmpfile missing or unchanged from seed — skipping persist");
    return;
  }
  const outcome = await saveLearnings(ctx, {
    label: "xrepo learnings",
    path: `/api/account/${ctx.repo.owner}/xrepo-learnings`,
    body: file.body,
    seed,
  });
  if (outcome === "saved") log.info("» xrepo learnings updated");
}
