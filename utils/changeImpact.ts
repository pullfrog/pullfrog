import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RestEndpointMethodTypes } from "@octokit/rest";
import type { ToolContext } from "../mcp/server.ts";
import { log } from "./cli.ts";
import { resolveEnv } from "./secrets.ts";

type PullFile = RestEndpointMethodTypes["pulls"]["listFiles"]["response"]["data"][number];

type ChangeLocation = {
  path: string;
  line: number;
  kind: "added" | "removed";
};

type AtomChange = {
  atom: string;
  confidence: number;
  added: ChangeLocation[];
  removed: ChangeLocation[];
};

type Reference = {
  path: string;
  line: number;
  text: string;
  truncated: boolean;
};

type ReferenceBucket = {
  count: number;
  samples: Reference[];
};

type ChangeCollection = {
  changes: Map<string, AtomChange>;
  addedLines: Set<string>;
};

type CreateChangeImpactParams = {
  files: PullFile[];
  pullNumber: number;
  baseSha: string;
  headSha: string;
  signal: AbortSignal;
};

type LookupReferencesParams = {
  candidates: AtomChange[];
  addedLines: Set<string>;
  treeish: string;
  signal: AbortSignal;
};

type ImpactEntry = {
  change: AtomChange;
  bucket: ReferenceBucket;
};

type GrepRecordState = {
  phase: "path" | "line" | "text";
  path: string;
  line: string;
  sample: string;
  truncated: boolean;
  searchTail: string;
  searchStart: number;
  matches: Set<string>;
};

type ChangeImpactResult = {
  path: string;
  candidateCount: number;
  renderedAtomCount: number;
  referenceCount: number;
  bytes: number;
};

const MAX_CANDIDATES = 24;
const MAX_ATOM_LENGTH = 128;
const MAX_ATOMS = 12;
const MAX_REFERENCES = 6;
const MAX_EXCERPT = 160;
const MAX_BYTES = 16_000;
const LOOKUP_BUDGET_MS = 60_000;

function isSymbolShaped(atom: string): boolean {
  return atom.length >= 4 && atom.length <= MAX_ATOM_LENGTH && /[A-Z_]/.test(atom);
}

function getAtomConfidence(params: { text: string; atom: string; index: number }): number {
  const before = params.text.slice(Math.max(0, params.index - 64), params.index);
  const after = params.text.slice(
    params.index + params.atom.length,
    params.index + params.atom.length + 16
  );
  if (/\b(?:class|interface|type|enum|function|def|func|fn|struct|trait)\s+$/.test(before))
    return 4;
  if (/\b(?:const|let|var)\s+$/.test(before) || /^\s*\??\s*[:(]/.test(after)) return 3;
  const quoted = /['"`]$/.test(before) && /^['"`]/.test(after);
  if (quoted || before.endsWith(".") || after.startsWith(".") || params.atom.includes("_"))
    return 2;
  return 1;
}

function getChangedAtoms(text: string): Map<string, number> {
  const atoms = new Map<string, number>();
  for (const match of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const atom = match[0];
    if (!isSymbolShaped(atom)) continue;
    const confidence = getAtomConfidence({ text, atom, index: match.index ?? 0 });
    atoms.set(atom, Math.max(atoms.get(atom) ?? 0, confidence));
  }
  return atoms;
}

function recordChange(params: {
  changes: Map<string, AtomChange>;
  location: ChangeLocation;
  text: string;
}) {
  for (const [atom, confidence] of getChangedAtoms(params.text)) {
    const change = params.changes.get(atom) ?? { atom, confidence, added: [], removed: [] };
    change.confidence = Math.max(change.confidence, confidence);
    change[params.location.kind].push(params.location);
    params.changes.set(atom, change);
  }
}

function locationKey(location: ChangeLocation | Reference): string {
  return `${location.path}\0${location.line}`;
}

function collectFileChanges(collection: ChangeCollection, file: PullFile): void {
  if (!file.patch) return;
  let oldLine = 0;
  let newLine = 0;

  for (const patchLine of file.patch.split("\n")) {
    const hunk = patchLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number.parseInt(hunk[1], 10);
      newLine = Number.parseInt(hunk[2], 10);
    } else if (patchLine.startsWith("+")) {
      const location: ChangeLocation = { path: file.filename, line: newLine++, kind: "added" };
      collection.addedLines.add(locationKey(location));
      recordChange({ changes: collection.changes, location, text: patchLine.slice(1) });
    } else if (patchLine.startsWith("-")) {
      const oldPath = file.previous_filename ?? file.filename;
      recordChange({
        changes: collection.changes,
        location: { path: oldPath, line: oldLine++, kind: "removed" },
        text: patchLine.slice(1),
      });
    } else if (!patchLine.startsWith("\\")) {
      oldLine++;
      newLine++;
    }
  }
}

function compareChanges(a: AtomChange, b: AtomChange): number {
  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
  const removedDelta = Number(b.removed.length > 0) - Number(a.removed.length > 0);
  if (removedDelta !== 0) return removedDelta;
  const aDelta = Math.abs(a.added.length - a.removed.length);
  const bDelta = Math.abs(b.added.length - b.removed.length);
  if (aDelta !== bDelta) return bDelta - aDelta;
  if (a.atom.length !== b.atom.length) return b.atom.length - a.atom.length;
  return a.atom < b.atom ? -1 : Number(a.atom > b.atom);
}

function getCandidates(files: PullFile[]) {
  const collection = {
    changes: new Map<string, AtomChange>(),
    addedLines: new Set<string>(),
  };
  for (const file of files) collectFileChanges(collection, file);
  const candidates = [...collection.changes.values()]
    .filter((change) => change.added.length !== change.removed.length)
    .sort(compareChanges);
  return {
    selected: candidates.slice(0, MAX_CANDIDATES),
    total: candidates.length,
    addedLines: collection.addedLines,
  };
}

function emptyBuckets(candidates: AtomChange[]): Map<string, ReferenceBucket> {
  return new Map(candidates.map((candidate) => [candidate.atom, { count: 0, samples: [] }]));
}

function createGrepRecordState(): GrepRecordState {
  return {
    phase: "path",
    path: "",
    line: "",
    sample: "",
    truncated: false,
    searchTail: "",
    searchStart: 0,
    matches: new Set<string>(),
  };
}

function resetGrepRecord(state: GrepRecordState): void {
  state.phase = "path";
  state.path = "";
  state.line = "";
  state.sample = "";
  state.truncated = false;
  state.searchTail = "";
  state.searchStart = 0;
  state.matches.clear();
}

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_]/.test(value);
}

function recordCandidateMatches(params: {
  text: string;
  minStart: number;
  maxStart: number;
  candidates: AtomChange[];
  matches: Set<string>;
}) {
  for (const candidate of params.candidates) {
    if (params.matches.has(candidate.atom)) continue;
    let index = params.text.indexOf(candidate.atom, params.minStart);
    while (index >= 0 && index < params.maxStart) {
      const before = params.text[index - 1];
      const after = params.text[index + candidate.atom.length];
      if (!isWordCharacter(before) && !isWordCharacter(after)) {
        params.matches.add(candidate.atom);
        break;
      }
      index = params.text.indexOf(candidate.atom, index + 1);
    }
  }
}

function consumeReferenceText(params: {
  state: GrepRecordState;
  text: string;
  candidates: AtomChange[];
  maxAtomLength: number;
  final: boolean;
}) {
  const remaining = MAX_EXCERPT - params.state.sample.length;
  params.state.sample += params.text.slice(0, Math.max(remaining, 0));
  if (params.text.length > remaining) params.state.truncated = true;

  const searchable = params.state.searchTail + params.text;
  const consumed = params.final
    ? searchable.length
    : Math.max(0, searchable.length - params.maxAtomLength - 2);
  recordCandidateMatches({
    text: searchable,
    minStart: params.state.searchStart,
    maxStart: consumed,
    candidates: params.candidates,
    matches: params.state.matches,
  });
  if (params.final) {
    params.state.searchTail = "";
    params.state.searchStart = 0;
    return;
  }
  const tailStart = Math.max(0, consumed - 1);
  params.state.searchTail = searchable.slice(tailStart);
  params.state.searchStart = consumed > 0 ? 1 : params.state.searchStart;
}

function recordGrepReference(params: {
  state: GrepRecordState;
  buckets: Map<string, ReferenceBucket>;
  addedLines: Set<string>;
  treeish: string;
}) {
  const prefix = `${params.treeish}:`;
  const path = params.state.path.startsWith(prefix)
    ? params.state.path.slice(prefix.length)
    : params.state.path;
  const line = Number.parseInt(params.state.line, 10);
  if (!Number.isFinite(line)) return;
  const reference = {
    path,
    line,
    text: params.state.sample,
    truncated: params.state.truncated,
  };
  if (params.addedLines.has(locationKey(reference))) return;
  for (const atom of params.state.matches) {
    const bucket = params.buckets.get(atom);
    if (!bucket) continue;
    bucket.count++;
    if (bucket.samples.length < MAX_REFERENCES) bucket.samples.push(reference);
  }
}

function consumeGrepChunk(params: {
  chunk: string;
  state: GrepRecordState;
  candidates: AtomChange[];
  maxAtomLength: number;
  buckets: Map<string, ReferenceBucket>;
  addedLines: Set<string>;
  treeish: string;
}) {
  let offset = 0;
  while (offset < params.chunk.length) {
    if (params.state.phase !== "text") {
      const end = params.chunk.indexOf("\0", offset);
      const value = end < 0 ? params.chunk.slice(offset) : params.chunk.slice(offset, end);
      params.state[params.state.phase] += value;
      if (end < 0) return;
      params.state.phase = params.state.phase === "path" ? "line" : "text";
      offset = end + 1;
      continue;
    }

    const end = params.chunk.indexOf("\n", offset);
    const final = end >= 0;
    const text = final ? params.chunk.slice(offset, end) : params.chunk.slice(offset);
    consumeReferenceText({
      state: params.state,
      text,
      candidates: params.candidates,
      maxAtomLength: params.maxAtomLength,
      final,
    });
    if (!final) return;
    recordGrepReference(params);
    resetGrepRecord(params.state);
    offset = end + 1;
  }
}

async function lookupReferences(params: LookupReferencesParams) {
  const buckets = emptyBuckets(params.candidates);
  if (params.candidates.length === 0) return { buckets, error: undefined };

  // ONE alternation, not an `-e` per atom: after every matching line git's look-ahead rescans each
  // pattern to EOF, so one absent atom made the grep quadratic (20+ min on a 644 MB tree, #1468).
  // atoms are word characters only, so they need no escaping.
  const pattern = params.candidates.map((candidate) => candidate.atom).join("|");
  const child = spawn(
    "git",
    [
      "grep",
      "--no-color",
      "--full-name",
      "-n",
      "-z",
      "-I",
      "-w",
      "-E",
      "-e",
      pattern,
      params.treeish,
      "--",
      ":(top)",
    ],
    { env: resolveEnv(undefined), stdio: ["ignore", "pipe", "pipe"], signal: params.signal }
  );
  const state = createGrepRecordState();
  const maxAtomLength = Math.max(...params.candidates.map((candidate) => candidate.atom.length));
  let spawnError: string | undefined;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    consumeGrepChunk({
      chunk,
      state,
      candidates: params.candidates,
      maxAtomLength,
      buckets,
      addedLines: params.addedLines,
      treeish: params.treeish,
    });
  });
  child.stderr.resume();
  const status = await new Promise<number | null>((resolve) => {
    child.once("error", (error) => {
      // an abort's `cause` is the signal's reason: the budget's TimeoutError or the checkout deadline
      spawnError = error.cause instanceof Error ? error.cause.message : error.message;
      resolve(null);
    });
    child.once("close", resolve);
  });

  if (spawnError || (status !== 0 && status !== 1)) {
    const error = spawnError ?? `git grep exit ${status ?? "unknown"}`;
    log.warning(`» change impact lookup failed: ${error}`);
    return { buckets: emptyBuckets(params.candidates), error };
  }
  if (state.phase === "text") {
    consumeReferenceText({
      state,
      text: "",
      candidates: params.candidates,
      maxAtomLength,
      final: true,
    });
    recordGrepReference({ state, buckets, addedLines: params.addedLines, treeish: params.treeish });
  } else if (state.phase !== "path" || state.path) {
    const error = "malformed git grep output";
    log.warning(`» change impact lookup failed: ${error}`);
    return { buckets: emptyBuckets(params.candidates), error };
  }
  return { buckets, error: undefined };
}

function formatReference(reference: Reference): string {
  const text = reference.text.trim();
  const excerpt = reference.truncated ? `${text.slice(0, MAX_EXCERPT - 1)}…` : text;
  return `- ${JSON.stringify(reference.path)}:${reference.line} ${JSON.stringify(excerpt)}`;
}

function formatChangedLocations(change: AtomChange): string {
  const selected = [change.removed[0], change.added[0]].filter(
    (location) => location !== undefined
  );
  const rendered = selected
    .map((location) => `${location.kind} ${JSON.stringify(location.path)}:${location.line}`)
    .join(", ");
  const omitted = change.removed.length + change.added.length - selected.length;
  return omitted > 0 ? `${rendered}; ${omitted} more changed location(s) omitted` : rendered;
}

function formatEntry(entry: ImpactEntry): string {
  const count = entry.bucket.count;
  const sampleNote =
    count > entry.bucket.samples.length
      ? `${count} matched line(s); first ${entry.bucket.samples.length} shown.`
      : `${count} matched line(s).`;
  return [
    `## \`${entry.change.atom}\``,
    "",
    `Changed at: ${formatChangedLocations(entry.change)}`,
    `Tracked references: ${sampleNote}`,
    "",
    ...entry.bucket.samples.map(formatReference),
  ].join("\n");
}

function formatArtifact(params: {
  entries: ImpactEntry[];
  candidateCount: number;
  totalCandidateCount: number;
  fileCount: number;
  baseSha: string;
  headSha: string;
  lookupError: string | undefined;
}) {
  const lines = [
    "# Change impact leads",
    "",
    "> Supplemental and explicitly incomplete. Read the authoritative `diffPath` TOC and raw lines first. Absence here is not evidence of no impact.",
    "",
    `Scope: base ${params.baseSha}, head ${params.headSha}; ${params.fileCount} changed file(s).`,
    "Generated from changed symbol-shaped identifiers, then one exact-word lookup pinned to the checked-out head across Git-tracked text files. Changed added lines are excluded; snippets are capped at 160 characters.",
    "",
    `Candidate atoms searched: ${params.candidateCount}/${params.totalCandidateCount}.`,
  ];
  if (params.lookupError) lines.push(`Tracked-file lookup unavailable: ${params.lookupError}.`);
  let content = `${lines.join("\n")}\n`;
  let renderedAtomCount = 0;
  let referenceCount = 0;

  for (const entry of params.entries.filter((candidate) => candidate.bucket.count > 0)) {
    if (renderedAtomCount >= MAX_ATOMS) break;
    const addition = `\n${formatEntry(entry)}\n`;
    if (Buffer.byteLength(content + addition) > MAX_BYTES) break;
    content += addition;
    renderedAtomCount++;
    referenceCount += entry.bucket.count;
  }
  if (renderedAtomCount === 0) {
    const empty =
      "\nNo bounded tracked references found. This is not evidence of no wider impact.\n";
    if (Buffer.byteLength(content + empty) <= MAX_BYTES) content += empty;
  }
  return { content, renderedAtomCount, referenceCount };
}

export async function createChangeImpactArtifact(
  ctx: ToolContext,
  params: CreateChangeImpactParams
): Promise<ChangeImpactResult> {
  const candidates = getCandidates(params.files);
  const lookup = await lookupReferences({
    candidates: candidates.selected,
    addedLines: candidates.addedLines,
    treeish: params.headSha,
    signal: AbortSignal.any([params.signal, AbortSignal.timeout(LOOKUP_BUDGET_MS)]),
  });
  // the checkout deadline drops the artifact; the lookup budget alone renders as "unavailable"
  params.signal.throwIfAborted();
  const artifact = formatArtifact({
    entries: candidates.selected.map((change) => {
      return { change, bucket: lookup.buckets.get(change.atom) ?? { count: 0, samples: [] } };
    }),
    candidateCount: candidates.selected.length,
    totalCandidateCount: candidates.total,
    fileCount: params.files.length,
    baseSha: params.baseSha,
    headSha: params.headSha,
    lookupError: lookup.error,
  });
  const path = join(ctx.tmpdir, `pr-${params.pullNumber}-${params.headSha.slice(0, 7)}-impact.md`);
  writeFileSync(path, artifact.content);
  return {
    path,
    candidateCount: candidates.selected.length,
    renderedAtomCount: artifact.renderedAtomCount,
    referenceCount: artifact.referenceCount,
    bytes: Buffer.byteLength(artifact.content),
  };
}
