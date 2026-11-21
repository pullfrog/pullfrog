import { isAbsolute, normalize, resolve } from "node:path";

export type DiffLineRange = {
  startLine: number;
  endLine: number;
};

export type DiffTocEntry = {
  filename: string;
  startLine: number;
  endLine: number;
};

export type DiffCoverageFileBreakdown = {
  filename: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  coveredLines: number;
  coveredRanges: DiffLineRange[];
  unreadRanges: DiffLineRange[];
};

export type DiffCoverageBreakdown = {
  totalLines: number;
  coveredLines: number;
  unreadLines: number;
  coveragePercent: number;
  coveredRanges: DiffLineRange[];
  unreadRanges: DiffLineRange[];
  files: DiffCoverageFileBreakdown[];
};

export type DiffCoverageState = {
  diffPath: string;
  totalLines: number;
  tocEntries: DiffTocEntry[];
  coveredRanges: DiffLineRange[];
  coveragePreflightRan: boolean;
};

type ReadTarget = {
  path: string;
  offset?: number | undefined;
  limit?: number | undefined;
  startLine?: number | undefined;
  endLine?: number | undefined;
};

export function countLines(params: { content: string }): number {
  const content = params.content;
  if (content.length === 0) return 0;
  return content.split("\n").length;
}

export function parseDiffTocEntries(params: { toc: string }): DiffTocEntry[] {
  const lines = params.toc.split("\n");
  const entries: DiffTocEntry[] = [];
  // production TOC lines (see formatFilesWithLineNumbers in checkout.ts) append
  // ` · diff-<sha256>` so the agent has the GitHub "Files Changed" anchor
  // precomputed. accept that suffix optionally so we also parse the shorter
  // shape used in tests and in reviewComments.
  for (const line of lines) {
    const match = line.match(
      /^- (.+) (?:→|->) lines (\d+)-(\d+)(?: · diff-[0-9a-f]+)?(?: · generated)?$/
    );
    if (!match) continue;
    const startLine = Number.parseInt(match[2], 10);
    const endLine = Number.parseInt(match[3], 10);
    if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) continue;
    entries.push({ filename: match[1], startLine, endLine });
  }
  return entries;
}

/**
 * one entry per section of an incremental (range-diff) diff, which opens on an
 * `@@ <file>[: <function>]` hunk header or a `## <file>[ (new)] ##` file header,
 * either of which may be the only line naming its file.
 */
export function parseIncrementalDiffEntries(params: { content: string }): DiffTocEntry[] {
  const lines = params.content.split("\n");
  const entries: DiffTocEntry[] = [];
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^@@ (.+)$|^[ +-]## (.+) ##$/);
    if (!match) continue;
    const previous = entries.at(-1);
    if (previous) previous.endLine = index;
    const filename = (match[1] ?? match[2]).replace(/(: | \().*$/, "");
    entries.push({ filename, startLine: index + 1, endLine: lines.length });
  }
  return entries;
}

export function createDiffCoverageState(params: {
  diffPath: string;
  totalLines: number;
  tocEntries: DiffTocEntry[];
  previous?: DiffCoverageState | undefined;
}): DiffCoverageState {
  return {
    diffPath: params.diffPath,
    totalLines: params.totalLines,
    tocEntries: params.tocEntries,
    coveredRanges: [],
    // carry forward across checkout_pr refreshes so the nudge stays "once per
    // review session". coveredRanges are intentionally not carried because
    // line numbers are tied to the previous diff's content.
    coveragePreflightRan: params.previous?.coveragePreflightRan ?? false,
  };
}

export function recordDiffReadFromToolUse(params: {
  state: DiffCoverageState | undefined;
  toolName: string;
  input: unknown;
  cwd: string;
}): boolean {
  const state = params.state;
  if (!state) return false;
  if (!isReadTool(params.toolName)) return false;
  const readTarget = extractReadTarget({ input: params.input });
  if (!readTarget) return false;

  const normalizedReadPath = normalizePath({ path: readTarget.path, cwd: params.cwd });
  const normalizedDiffPath = normalize(state.diffPath);
  if (normalizedReadPath !== normalizedDiffPath) return false;

  const range = resolveReadRange({
    totalLines: state.totalLines,
    offset: readTarget.offset,
    limit: readTarget.limit,
    startLine: readTarget.startLine,
    endLine: readTarget.endLine,
  });
  if (!range) return false;

  state.coveredRanges = mergeRanges({ ranges: state.coveredRanges, nextRange: range });
  return true;
}

export function getDiffCoverageBreakdown(params: {
  state: DiffCoverageState;
}): DiffCoverageBreakdown {
  const state = params.state;
  const coveredRanges = mergeRangesList({ ranges: state.coveredRanges });
  const unreadRanges = invertRanges({ totalLines: state.totalLines, coveredRanges });
  const coveredLines = countLinesInRanges({ ranges: coveredRanges });
  const unreadLines = Math.max(0, state.totalLines - coveredLines);
  const coveragePercent = state.totalLines
    ? Number(((coveredLines / state.totalLines) * 100).toFixed(2))
    : 100;

  const files: DiffCoverageFileBreakdown[] = [];
  for (const entry of state.tocEntries) {
    const fileRange: DiffLineRange = { startLine: entry.startLine, endLine: entry.endLine };
    const coveredInFile = intersectRangesWithRange({ ranges: coveredRanges, target: fileRange });
    const unreadInFile = intersectRangesWithRange({ ranges: unreadRanges, target: fileRange });
    const totalFileLines = Math.max(0, entry.endLine - entry.startLine + 1);
    const fileCoveredLines = countLinesInRanges({ ranges: coveredInFile });
    files.push({
      filename: entry.filename,
      startLine: entry.startLine,
      endLine: entry.endLine,
      totalLines: totalFileLines,
      coveredLines: fileCoveredLines,
      coveredRanges: coveredInFile,
      unreadRanges: unreadInFile,
    });
  }

  return {
    totalLines: state.totalLines,
    coveredLines,
    unreadLines,
    coveragePercent,
    coveredRanges,
    unreadRanges,
    files,
  };
}

function isReadTool(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  if (lower === "read" || lower === "readfile") return true;
  if (lower.endsWith(".read") || lower.endsWith(".readfile")) return true;
  return false;
}

function extractReadTarget(params: { input: unknown }): ReadTarget | null {
  const inputRecord = asRecord(params.input);
  if (!inputRecord) return null;

  const direct = extractReadTargetFromRecord({ record: inputRecord });
  if (direct) return direct;

  const nestedCandidates = [inputRecord.args, inputRecord.params, inputRecord.input];
  for (const candidate of nestedCandidates) {
    const nestedRecord = asRecord(candidate);
    if (!nestedRecord) continue;
    const nested = extractReadTargetFromRecord({ record: nestedRecord });
    if (nested) return nested;
  }

  return null;
}

function extractReadTargetFromRecord(params: {
  record: Record<string, unknown>;
}): ReadTarget | null {
  const record = params.record;
  const pathValue =
    readString({ value: record.path }) ??
    readString({ value: record.file_path }) ??
    readString({ value: record.filePath }) ??
    readString({ value: record.filepath }) ??
    readString({ value: record.file }) ??
    readString({ value: record.target_file });

  if (!pathValue) return null;

  const offset = readNumber({ value: record.offset });
  const limit = readNumber({ value: record.limit });
  const startLine =
    readNumber({ value: record.start_line }) ??
    readNumber({ value: record.startLine }) ??
    readNumber({ value: record.line_start });
  const endLine =
    readNumber({ value: record.end_line }) ??
    readNumber({ value: record.endLine }) ??
    readNumber({ value: record.line_end });

  return { path: pathValue, offset, limit, startLine, endLine };
}

function resolveReadRange(params: {
  totalLines: number;
  offset?: number | undefined;
  limit?: number | undefined;
  startLine?: number | undefined;
  endLine?: number | undefined;
}): DiffLineRange | null {
  const totalLines = params.totalLines;
  if (totalLines <= 0) return null;

  if (params.startLine !== undefined || params.endLine !== undefined) {
    const rawStart = params.startLine ?? 1;
    const rawEnd = params.endLine ?? totalLines;
    const startLine = clampLine({ value: rawStart, totalLines });
    const endLine = clampLine({ value: rawEnd, totalLines });
    if (endLine < startLine) return null;
    return { startLine, endLine };
  }

  let startLine = 1;
  if (params.offset !== undefined) {
    if (params.offset >= 0) {
      // every read tool counts lines from 1 (OpenCode since its #13198); 0 means the first line too
      const normalizedOffset = params.offset === 0 ? 1 : params.offset;
      startLine = clampLine({ value: normalizedOffset, totalLines });
    } else {
      startLine = clampLine({ value: totalLines + params.offset + 1, totalLines });
    }
  }

  let endLine = totalLines;
  if (params.limit !== undefined) {
    if (params.limit <= 0) return null;
    endLine = clampLine({ value: startLine + params.limit - 1, totalLines });
  }

  if (endLine < startLine) return null;
  return { startLine, endLine };
}

function normalizePath(params: { path: string; cwd: string }): string {
  if (isAbsolute(params.path)) return normalize(params.path);
  return normalize(resolve(params.cwd, params.path));
}

function mergeRanges(params: {
  ranges: DiffLineRange[];
  nextRange: DiffLineRange;
}): DiffLineRange[] {
  return mergeRangesList({ ranges: [...params.ranges, params.nextRange] });
}

function mergeRangesList(params: { ranges: DiffLineRange[] }): DiffLineRange[] {
  if (params.ranges.length === 0) return [];
  const sorted = [...params.ranges].sort((a, b) => a.startLine - b.startLine);
  const merged: DiffLineRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (!last) {
      merged.push({ startLine: range.startLine, endLine: range.endLine });
      continue;
    }
    if (range.startLine <= last.endLine + 1) {
      if (range.endLine > last.endLine) {
        last.endLine = range.endLine;
      }
      continue;
    }
    merged.push({ startLine: range.startLine, endLine: range.endLine });
  }
  return merged;
}

function invertRanges(params: {
  totalLines: number;
  coveredRanges: DiffLineRange[];
}): DiffLineRange[] {
  if (params.totalLines <= 0) return [];
  if (params.coveredRanges.length === 0) {
    return [{ startLine: 1, endLine: params.totalLines }];
  }

  const unread: DiffLineRange[] = [];
  let cursor = 1;
  for (const range of params.coveredRanges) {
    if (cursor < range.startLine) {
      unread.push({ startLine: cursor, endLine: range.startLine - 1 });
    }
    cursor = Math.max(cursor, range.endLine + 1);
  }
  if (cursor <= params.totalLines) {
    unread.push({ startLine: cursor, endLine: params.totalLines });
  }
  return unread;
}

function intersectRangesWithRange(params: {
  ranges: DiffLineRange[];
  target: DiffLineRange;
}): DiffLineRange[] {
  const intersections: DiffLineRange[] = [];
  for (const range of params.ranges) {
    if (range.endLine < params.target.startLine) continue;
    if (range.startLine > params.target.endLine) continue;
    const startLine = Math.max(range.startLine, params.target.startLine);
    const endLine = Math.min(range.endLine, params.target.endLine);
    if (endLine >= startLine) {
      intersections.push({ startLine, endLine });
    }
  }
  return intersections;
}

export function countLinesInRanges(params: { ranges: DiffLineRange[] }): number {
  let total = 0;
  for (const range of params.ranges) {
    total += range.endLine - range.startLine + 1;
  }
  return total;
}

function clampLine(params: { value: number; totalLines: number }): number {
  if (params.value < 1) return 1;
  if (params.value > params.totalLines) return params.totalLines;
  return params.value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value));
}

function readString(params: { value: unknown }): string | undefined {
  if (typeof params.value === "string") return params.value;
  return undefined;
}

function readNumber(params: { value: unknown }): number | undefined {
  if (typeof params.value === "number" && Number.isFinite(params.value)) return params.value;
  if (typeof params.value === "string") {
    const parsed = Number.parseInt(params.value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
