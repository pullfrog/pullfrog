import { log } from "./cli.ts";
import { $ } from "./shell.ts";

type ComputeIncrementalDiffParams = {
  baseBranch: string;
  beforeSha: string;
  headSha: string;
  /** tips the base branch was force-pushed away from, which either version may still be built on */
  formerBaseTips: string[];
  /** on a partial clone, fetches the blobs `merge-tree` and `range-diff` would lazily miss (#1632) */
  prefetch: (revs: string[]) => Promise<void>;
};

/**
 * computes the incremental diff between two versions of a PR using range-diff
 * on virtual squash commits created via `git commit-tree`.
 *
 * each PR version is squashed into a single synthetic commit (merge-base → tip tree),
 * then range-diff compares those two single-commit ranges. this:
 * - isolates each version's net effect (base branch noise eliminated via per-version merge bases)
 * - avoids commit-matching issues that raw range-diff has with rebases/squashes/reordering
 * - creates only loose git objects, no branches or refs (unlike temp-branch squash approaches)
 *
 * unlike fetchAndFormatPrDiff/formatFilesWithLineNumbers, this output has no line numbers.
 * range-diff compares *patches* (diffs-of-diffs), not file trees — its hunk headers are
 * `@@ file.ts` breadcrumbs, not positional `@@ -X,Y +A,B @@` markers. reconstructing
 * line numbers would require cross-referencing with the v2 diff or content-matching against
 * file trees, both of which are fragile (duplicate lines, hunk boundary shifts after rebase).
 * a structured interdiff approach (diff two parsed patches, compare only +/- keys via Myers)
 * could approximate line numbers but loses semantic precision: range-diff understands patch
 * structure natively (rename detection, hunk-aware matching, dual-prefix inner/outer changes),
 * while flat key-sequence comparison can misalign duplicate lines and can't distinguish
 * "new addition to the PR" from "existing code newly modified by the PR". range-diff is the
 * right abstraction here — the incremental diff answers "how did the changeset evolve?",
 * not "where in the file is this?", and forcing positional line numbers onto it would be
 * semantically misleading.
 *
 * alternatives considered:
 * - plain git diff (two-tree or three-dot): includes base branch changes, no PR isolation
 * - patch-text diffing (interdiff / diff-of-diffs): fragile, hunk offset noise on rebase
 * - range-diff on raw commit ranges: confused by commit reorganization across force-pushes
 */
export type IncrementalDiffResult =
  /** range-diff ran and produced a delta */
  | { status: "ok"; diff: string }
  /** range-diff ran and the two versions are identical */
  | { status: "empty" }
  /** range-diff could not run — most often `beforeSha` has no ancestry to
   *  merge-base against on a shallow clone. distinct from "empty" on purpose:
   *  they were the same `null` before, so `checkout_pr` could not tell the
   *  agent whether there was nothing to see or whether we had simply failed.
   *  see #1139. */
  | { status: "unavailable"; reason: string };

export async function computeIncrementalDiff(
  params: ComputeIncrementalDiffParams
): Promise<IncrementalDiffResult> {
  try {
    const tips = [`origin/${params.baseBranch}`, ...params.formerBaseTips];
    const oldBase = versionBase({ sha: params.beforeSha, tips });
    const newBase = versionBase({ sha: params.headSha, tips });
    await params.prefetch([oldBase, newBase, params.beforeSha]);
    const replayed =
      oldBase === newBase ? null : replay({ sha: params.beforeSha, from: oldBase, onto: newBase });
    // $1/$2=the old version's base and tree (newBase and the replayed tree once replayed),
    // $3=newBase, $4=headSha. one commit per side, so a creation factor this high always pairs
    // them; the default 60 calls a reworked delta a rewrite and prints no patch
    const raw = $(
      "sh",
      [
        "-c",
        "git range-diff --no-color --creation-factor=1000 " +
          '"$1..$(git commit-tree "$2^{tree}" -p "$1" -m x)" ' +
          '"$3..$(git commit-tree "$4^{tree}" -p "$3" -m x)"',
        "--",
        replayed ? newBase : oldBase,
        replayed ?? params.beforeSha,
        newBase,
        params.headSha,
      ],
      { log: false }
    );

    const processed = postProcessRangeDiff(raw);
    return processed === null ? { status: "empty" } : { status: "ok", diff: processed };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    // `log.warning`, not `log.debug`: debug is gated on LOG_LEVEL/ACTIONS_STEP_DEBUG,
    // neither of which is set in production — so 174 of 744 IncrementalReview runs
    // lost their incremental diff completely silently. see #1139.
    log.warning(`» incremental diff unavailable: range-diff failed: ${reason}`);
    return { status: "unavailable", reason };
  }
}

function git(args: string[]): string {
  return $("git", args, { log: false }).trim();
}

/**
 * the base a version was built on. after the base branch is force-pushed (a restacked stacked PR)
 * a version still on the old branch has its merge base with `origin/<base>` fall back to the fork
 * point, dragging the whole old base branch into the delta, so the candidate leaving the fewest
 * commits under `sha` wins. a former tip that was never fetched has no merge base and drops out.
 */
function versionBase(params: { sha: string; tips: string[] }): string {
  let best: { tip: string; sha: string; commits: number } | undefined;
  for (const tip of params.tips) {
    let sha: string;
    try {
      sha = git(["merge-base", params.sha, tip]);
    } catch {
      continue;
    }
    const commits = Number(git(["rev-list", "--count", `${sha}..${params.sha}`]));
    if (!best || commits < best.commits) best = { tip, sha, commits };
  }
  if (!best) throw new Error(`no merge base between ${params.sha} and the base branch`);
  if (best.tip !== params.tips[0]) {
    log.info(`» incremental diff: ${params.sha.slice(0, 7)} sits on former base tip ${best.tip}`);
  }
  return best.sha;
}

/**
 * the old version's tree replayed onto the new base, so whatever the new base already carries drops
 * out: a parent PR squash-merged into it (no merge base reaches those commits), or main's own changes
 * near the PR's lines. null when the replay conflicts, and each version is compared on its own base.
 */
function replay(params: { sha: string; from: string; onto: string }): string | null {
  try {
    return git([
      "merge-tree",
      "--write-tree",
      `--merge-base=${params.from}`,
      params.onto,
      params.sha,
    ]);
  } catch {
    log.info(
      `» incremental diff: ${params.sha.slice(0, 7)} does not replay onto the new base; comparing each on its own`
    );
    return null;
  }
}

function isDiffPrefix(ch: string): boolean {
  return ch === " " || ch === "+" || ch === "-";
}

/**
 * transforms git range-diff output into a clean incremental diff.
 *
 * range-diff content lines have two prefix characters:
 *   1st (outer): range-diff level — space (same in both), + (new only), - (old only)
 *   2nd (inner): original diff level — space (context), + (added), - (removed)
 *
 * stripping the inner prefix produces a standard unified-diff-like output where
 * +/- means "changed between PR versions" rather than "changed vs base branch".
 *
 * uses a streaming approach: a ring buffer of before-context lines is flushed when
 * a change is hit, then afterCount lines of after-context are emitted directly.
 * nearest preceding ## / @@ headers are force-included when outside the context window,
 * and so is the outer `@@ <file>[: <function>]` hunk header, which is often the only
 * line naming the file a change belongs to.
 */
export function postProcessRangeDiff(raw: string, contextLines = 3): string | null {
  if (!raw.trim()) return null;
  if (/^\d+:\s+\w+\s+=\s+\d+:/m.test(raw)) return null;

  type Line = { prefix: string; from: number; to: number; seq: number };

  const beforeBuf: Line[] = [];
  let lastOuterHdr: Line | null = null;
  let outerHdrEmitted = true;
  let lastFileHdr: Line | null = null;
  let lastHunkHdr: Line | null = null;
  let fileHdrEmitted = true;
  let hunkHdrEmitted = true;

  let out = "";
  let afterRemaining = 0;
  let lastEmittedSeq = -2;
  let seq = 0;
  let hasChanges = false;

  function emit(line: Line) {
    if (lastEmittedSeq >= 0 && line.seq > lastEmittedSeq + 1) out += (out ? "\n" : "") + "...";
    out += (out ? "\n" : "") + line.prefix + raw.slice(line.from, line.to);
    lastEmittedSeq = line.seq;
    if (lastOuterHdr?.seq === line.seq) outerHdrEmitted = true;
    if (lastFileHdr?.seq === line.seq) fileHdrEmitted = true;
    if (lastHunkHdr?.seq === line.seq) hunkHdrEmitted = true;
  }

  function flushBefore() {
    const headers = [
      outerHdrEmitted ? null : lastOuterHdr,
      fileHdrEmitted ? null : lastFileHdr,
      hunkHdrEmitted ? null : lastHunkHdr,
    ].filter((line): line is Line => line !== null);
    // in line order, so emitting a header never skips the context above it
    const pending = [...headers, ...beforeBuf.filter((line) => line.seq > lastEmittedSeq)].sort(
      (a, b) => a.seq - b.seq
    );
    for (const [i, line] of pending.entries()) {
      if (pending[i - 1]?.seq !== line.seq) emit(line);
    }
    beforeBuf.length = 0;
  }

  function isFileHeader(pos: number): boolean {
    return raw.startsWith("## ", pos) && !raw.startsWith("## Commit message", pos);
  }

  function markFileHeader(line: Line, emitted: boolean) {
    lastFileHdr = line;
    fileHdrEmitted = emitted;
    lastHunkHdr = null;
    hunkHdrEmitted = true;
  }

  let cursor = 0;
  while (cursor < raw.length) {
    const eol = raw.indexOf("\n", cursor);
    const lineEnd = eol === -1 ? raw.length : eol;

    if (raw.charCodeAt(cursor) >= 48 && raw.charCodeAt(cursor) <= 57) {
      cursor = lineEnd + 1;
      continue;
    }

    if (raw.startsWith("    @@", cursor)) {
      // range-diff labels an outer hunk with its nearest section, which names no file when
      // that section is its own metadata or commit message
      const label = raw.slice(cursor + 4, lineEnd);
      lastOuterHdr =
        label === "@@ Metadata" || label === "@@ Commit message"
          ? null
          : { prefix: "", from: cursor + 4, to: lineEnd, seq };
      outerHdrEmitted = false;
      lastFileHdr = null;
      fileHdrEmitted = true;
      lastHunkHdr = null;
      hunkHdrEmitted = true;
      beforeBuf.length = 0;
      afterRemaining = 0;
      seq++;
    } else if (lineEnd - cursor >= 5 && raw.startsWith("    ", cursor)) {
      const prefix = raw[cursor + 4];
      if (isDiffPrefix(prefix)) {
        const contentPos = cursor + 5;
        const isOuterChange = prefix !== " ";
        let line: Line;
        let isChange = false;

        if (contentPos >= lineEnd) {
          line = { prefix, from: lineEnd, to: lineEnd, seq };
        } else if (isDiffPrefix(raw[contentPos])) {
          isChange = isOuterChange;
          line = { prefix, from: contentPos + 1, to: lineEnd, seq };
          // git prints a file header as inner context, `     ## <file> ##`
          if (raw[contentPos] === " " && isFileHeader(contentPos + 1)) {
            markFileHeader(line, isChange);
          }
        } else {
          line = { prefix, from: contentPos, to: lineEnd, seq };
          if (isFileHeader(contentPos)) {
            markFileHeader(line, false);
          } else if (
            raw.startsWith("@@", contentPos) &&
            !raw.startsWith("@@ Metadata", contentPos)
          ) {
            lastHunkHdr = line;
            hunkHdrEmitted = false;
          }
        }

        if (isChange) {
          hasChanges = true;
          flushBefore();
          emit(line);
          afterRemaining = contextLines;
        } else if (afterRemaining > 0) {
          emit(line);
          afterRemaining--;
        } else {
          if (beforeBuf.length >= contextLines) beforeBuf.shift();
          beforeBuf.push(line);
        }

        seq++;
      }
    }

    cursor = lineEnd + 1;
  }

  return hasChanges ? out : null;
}
