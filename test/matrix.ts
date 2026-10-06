/**
 * unified CI matrix builder. emits the four matrices consumed by
 * `.github/workflows/test.yml`:
 *
 *   - agents:    crossagent tests × eligible agents (fan-out)
 *   - agnostic:  agnostic infrastructure tests (run with opencode)
 *   - flagships: one harness smoke per provider (providers-live)
 *   - aliases:   one CLI smoke per model alias (models-live)
 *
 * these matrices run only on `workflow_dispatch` (the full matrix at each
 * release, scoped cells on a PR) — never on PR or `main` pushes (see test.yml for the spend history).
 * MATRIX_FILTER scopes a dispatch to the cells that matter: comma-separated
 * substrings, OR'd, matched against each entry's name and slug.
 *
 * usage:
 *   nub action/test/matrix.ts
 *   MATRIX_FILTER=codex,smoke nub action/test/matrix.ts
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAliasMatrix, buildFlagshipMatrix } from "./list-aliases.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

type AgentEntry = { agent: string; test: string; name: string };
type AgnosticEntry = { test: string; name: string };
type SlugEntry = { slug: string; agent: string; name: string };

type MatrixOutput = {
  agents: AgentEntry[];
  agnostic: AgnosticEntry[];
  flagships: SlugEntry[];
  aliases: SlugEntry[];
};

/**
 * extracted test metadata. parsed via regex from the test source — see
 * `parseTestFile`. dynamic-import is intentionally avoided: the GHA `changes`
 * job runs without `pnpm install`, and the real test modules transitively
 * import `@actions/core` etc. parsing keeps `matrix.ts` zero-dep.
 */
type ParsedTest = {
  name: string;
  agents: string[] | undefined;
};

const STRING_LITERAL = /"((?:\\.|[^"\\])*)"/g;

function extractStringLiterals(source: string): string[] {
  const out: string[] = [];
  STRING_LITERAL.lastIndex = 0;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex iteration
  while ((m = STRING_LITERAL.exec(source))) {
    out.push(m[1]);
  }
  return out;
}

/**
 * extract a `key: [...]` array literal of strings from a test object. matches
 * line-leading indented `key:` to avoid colliding with the same word inside
 * prompts / template literals.
 */
function extractStringArray(source: string, key: string): string[] | undefined {
  const re = new RegExp(`^\\s+${key}:\\s*\\[([\\s\\S]*?)\\]`, "m");
  const m = source.match(re);
  if (!m) return undefined;
  return extractStringLiterals(m[1]);
}

function parseTestFile(source: string): ParsedTest | null {
  // strip line comments — `//` inside string literals is rare in test files,
  // and the static parser doesn't need to be perfect.
  const stripped = source.replace(/\/\/[^\n]*$/gm, "");
  const nameMatch = stripped.match(/^\s+name:\s*"([^"]+)"/m);
  if (!nameMatch) return null;
  return {
    name: nameMatch[1],
    agents: extractStringArray(stripped, "agents"),
  };
}

function loadDir(dir: string): ParsedTest[] {
  const dirPath = join(__dirname, dir);
  if (!existsSync(dirPath)) return [];
  const files = readdirSync(dirPath).filter((f) => f.endsWith(".ts"));
  const out: ParsedTest[] = [];
  for (const file of files) {
    const source = readFileSync(join(dirPath, file), "utf8");
    const parsed = parseTestFile(source);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * derive the active agent list from `agents/index.ts` so adding a new harness
 * file automatically wires it into the matrix. avoids dynamic-import
 * (transitively pulls `@actions/core` etc. — would explode in the no-install
 * `changes` job) by regex-parsing the imports the same way `parseTestFile`
 * handles tests.
 */
function loadAgents(): string[] {
  const indexPath = join(__dirname, "..", "agents", "index.ts");
  const source = readFileSync(indexPath, "utf8");
  const out: string[] = [];
  const re = /^\s*import\s+\{\s*(\w+)\s*\}\s+from\s+"\.\/(\w+)\.ts"/gm;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex iteration
  while ((m = re.exec(source))) {
    if (m[2] === "shared") continue;
    out.push(m[1]);
  }
  return out.sort();
}

function buildAgentsMatrix(): AgentEntry[] {
  const tests = loadDir("crossagent");
  const allAgents = loadAgents();
  const out: AgentEntry[] = [];
  for (const t of tests) {
    const agents = t.agents ?? allAgents;
    for (const agent of agents) {
      out.push({ agent, test: t.name, name: `${t.name}-${agent}` });
    }
  }
  return out;
}

function buildAgnosticMatrix(): AgnosticEntry[] {
  return loadDir("agnostic").map((t) => ({ test: t.name, name: t.name }));
}

/** comma-separated MATRIX_FILTER terms; empty = keep everything. */
function parseFilter(): string[] {
  const raw = process.env.MATRIX_FILTER ?? "";
  return raw
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

function matchesFilter(terms: string[], fields: string[]): boolean {
  if (terms.length === 0) return true;
  return terms.some((t) => fields.some((f) => f.toLowerCase().includes(t)));
}

function main(): void {
  const terms = parseFilter();
  const output: MatrixOutput = {
    agents: buildAgentsMatrix().filter((e) => matchesFilter(terms, [e.name])),
    agnostic: buildAgnosticMatrix().filter((e) => matchesFilter(terms, [e.name])),
    flagships: buildFlagshipMatrix().filter((e) => matchesFilter(terms, [e.name, e.slug])),
    aliases: buildAliasMatrix().filter((e) => matchesFilter(terms, [e.name, e.slug])),
  };

  process.stdout.write(JSON.stringify(output));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
