/**
 * `codenav`: a language server's answers without a language server. each call is one short process in
 * the agent's own sandbox, TypeScript through the compiler API and Python through jedi, over only the
 * files the query needs: the target's imports for `def`, and the files `git grep` finds the name in for
 * the rest. nothing stays resident between calls. bundled to `dist/codenav.mjs` and put on the shell's
 * PATH by `utils/codenav.ts`; see wiki/codenav.md.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import type * as TS from "typescript";

const OPS = ["def", "impl", "refs", "callers"] as const;
type Op = (typeof OPS)[number];

const USAGE = `usage: codenav <def|impl|refs|callers> <file>:<line>[:<col>] [<symbol>]
  def      where the symbol is defined
  impl     implementations of an interface or abstract member (TypeScript)
  refs     references to the symbol
  callers  functions that call it
covers TypeScript/JavaScript and Python; <file> is relative to the current directory.`;

const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const PY_EXTENSIONS = [".py", ".pyi"];
const MAX_HITS = 200;
const CACHE = process.env.CODENAV_CACHE || join(tmpdir(), "codenav");

type Query = {
  op: Op;
  file: string;
  line: number;
  /** where the symbol may be on the line, tried in order */
  columns: number[];
  symbol: string;
  root: string;
};

/** zero-based; `caller` is set for `callers`, empty at module scope */
type Hit = { file: string; line: number; column: number; caller?: string | undefined };

/** call-hierarchy kinds for a file's top level, whose callers print no name */
const MODULE_KINDS: string[] = ["module", "script"];

function parse(argv: string[]): Query {
  const op = OPS.find((candidate) => candidate === argv[0]);
  if (!op)
    throw new Error(`${argv[0] ? `unknown operation "${argv[0]}"` : "no operation"}\n${USAGE}`);
  const target = /^(.+?):(\d+)(?::(\d+))?$/.exec(argv[1] ?? "");
  if (!target?.[1] || !target[2]) throw new Error(`expected <file>:<line>\n${USAGE}`);
  if (!target[3] && !argv[2]) throw new Error(`give a <symbol> or a :<col>\n${USAGE}`);
  const file = resolve(target[1]);
  const ext = extname(file);
  if (!TS_EXTENSIONS.includes(ext) && !PY_EXTENSIONS.includes(ext)) {
    throw new Error(`no navigation for ${ext || "extensionless"} files`);
  }
  if (op === "impl" && PY_EXTENSIONS.includes(ext)) throw new Error("impl is TypeScript-only");
  const line = Number(target[2]) - 1;
  const lineText = readFileSync(file, "utf8").split("\n")[line];
  if (lineText === undefined) throw new Error(`${target[1]} has no line ${target[2]}`);
  const columns = target[3] ? [Number(target[3]) - 1] : symbolColumns(lineText, argv[2] ?? "");
  if (columns.length === 0) {
    throw new Error(`"${argv[2]}" is not on ${target[1]}:${target[2]}: ${lineText.trim()}`);
  }
  // a column inside an identifier names all of it, which is what `git grep -w` has to find
  const start = lineText.slice(0, columns[0]).search(/[\w$]*$/);
  const symbol = /^[\w$]+/.exec(lineText.slice(start))?.[0];
  if (!symbol) throw new Error(`no identifier at ${argv[1]}`);
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: dirname(file),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  return { op, file, line, columns, symbol, root };
}

/** every whole-identifier match of the symbol's last segment, so `client.request` finds `request` */
function symbolColumns(lineText: string, symbol: string): number[] {
  const name = symbol.split(".").pop() ?? "";
  const columns: number[] = [];
  // `indexOf("")` never advances past the end of the line
  if (!name) return columns;
  const identifier = /[\w$]/;
  for (let i = lineText.indexOf(name); i !== -1; i = lineText.indexOf(name, i + 1)) {
    const before = lineText[i - 1] ?? "";
    const after = lineText[i + name.length] ?? "";
    if (!identifier.test(before) && !identifier.test(after)) columns.push(i);
  }
  return columns;
}

/**
 * one program per tsconfig, as tsserver keeps one per project: a caller in another package of a
 * monorepo reaches the target through its own package's paths and export conditions, which the
 * target's options would resolve to a `.d.ts` instead. the target's own project goes first.
 */
function typescript(query: Query): Hit[] {
  const ts = loadTypescript(query.file);
  const projects = new Map([[findConfig(ts, query.file), new Set([query.file])]]);
  for (const file of query.op === "def" ? [] : grepFiles(query, TS_EXTENSIONS)) {
    const configPath = findConfig(ts, file);
    projects.set(configPath, (projects.get(configPath) ?? new Set([query.file])).add(file));
  }
  const hits: Hit[] = [];
  for (const [configPath, roots] of projects) {
    hits.push(...askProject(ts, { query, configPath, roots: [...roots] }));
    if (hits.length > MAX_HITS) break;
  }
  return hits;
}

function findConfig(ts: typeof TS, file: string): string | undefined {
  const dir = dirname(file);
  return (
    ts.findConfigFile(dir, ts.sys.fileExists) ??
    ts.findConfigFile(dir, ts.sys.fileExists, "jsconfig.json")
  );
}

function askProject(
  ts: typeof TS,
  params: { query: Query; configPath: string | undefined; roots: string[] }
): Hit[] {
  const query = params.query;
  const config = params.configPath
    ? ts.getParsedCommandLineOfConfigFile(
        params.configPath,
        {},
        {
          ...ts.sys,
          onUnRecoverableConfigFileDiagnostic: () => {},
        }
      )
    : undefined;
  const service = ts.createLanguageService(
    {
      // a JavaScript target or candidate loads even where the project leaves allowJs off
      getCompilationSettings: () => ({ ...config?.options, allowJs: true }),
      getScriptFileNames: () => params.roots,
      getScriptVersion: () => "0",
      getScriptSnapshot: (name) => {
        const text = ts.sys.readFile(name);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => dirname(params.configPath ?? query.file),
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      fileExists: ts.sys.fileExists,
      // a symlink out of node_modules is a workspace package, which would otherwise load as a second
      // copy; one within it is a dependency, whose own (megabytes of `@octokit/types`) is not needed
      realpath: (path) => {
        const real = ts.sys.realpath?.(path) ?? path;
        return real.includes(`${sep}node_modules${sep}`) ? path : real;
      },
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    },
    ts.createDocumentRegistry()
  );
  const source = service.getProgram()?.getSourceFile(query.file);
  if (!source) throw new Error(`TypeScript could not load ${query.file}`);
  const hit = (fileName: string, start: number, caller?: string): Hit => {
    const at = service.getProgram()?.getSourceFile(fileName)?.getLineAndCharacterOfPosition(start);
    return { file: fileName, line: at?.line ?? 0, column: at?.character ?? 0, caller };
  };
  for (const column of query.columns) {
    const position = source.getPositionOfLineAndCharacter(query.line, column);
    const hits = askTypescript(service, { op: query.op, file: query.file, position, hit });
    if (hits.length) return hits;
  }
  return [];
}

function askTypescript(
  service: TS.LanguageService,
  params: {
    op: Op;
    file: string;
    position: number;
    hit: (fileName: string, start: number, caller?: string) => Hit;
  }
): Hit[] {
  const at = (span: { fileName: string; textSpan: TS.TextSpan }) =>
    params.hit(span.fileName, span.textSpan.start);
  switch (params.op) {
    case "def":
      return (service.getDefinitionAtPosition(params.file, params.position) ?? []).map(at);
    case "impl":
      return (service.getImplementationAtPosition(params.file, params.position) ?? []).map(at);
    case "refs":
      return (service.findReferences(params.file, params.position) ?? []).flatMap((symbol) =>
        symbol.references.filter((ref) => !ref.isDefinition).map(at)
      );
    case "callers":
      return [service.prepareCallHierarchy(params.file, params.position) ?? []]
        .flat()
        .flatMap((item) =>
          service.provideCallHierarchyIncomingCalls(item.file, item.selectionSpan.start)
        )
        .flatMap((call) =>
          call.fromSpans.map((span) =>
            params.hit(
              call.from.file,
              span.start,
              MODULE_KINDS.includes(call.from.kind) ? "" : call.from.name
            )
          )
        );
    default:
      return params.op satisfies never;
  }
}

/** the repository's own TypeScript when it has 4–6, else a pinned 5.9: TS7 has no JS API and drops `baseUrl` */
function loadTypescript(file: string): typeof TS {
  try {
    const ts: typeof TS = createRequire(file)("typescript");
    const major = Number(ts.version.split(".")[0]);
    if (major >= 4 && major <= 6) return ts;
  } catch {
    // not installed: a review checkout rarely has its dependencies
  }
  const dir = installOnce("typescript", (staging) =>
    run("npm", [
      "install",
      "--prefix",
      staging,
      "--no-save",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      "--loglevel=error",
      "typescript@5.9.3",
    ])
  );
  return createRequire(join(dir, "package.json"))("typescript");
}

/**
 * jedi, rather than pyright: pyright answers only as a server, and its cold start is the cost this
 * avoids. jedi's own reference search stops after 30 parsed files, so references are found the way
 * TypeScript's are: `git grep` for the name, then jedi resolves each occurrence.
 */
function python(query: Query): Hit[] {
  const dir = installOnce("jedi", (staging) => {
    run("python3", ["-m", "venv", staging]);
    run(join(staging, "bin", "python"), [
      "-m",
      "pip",
      "install",
      "--quiet",
      "--disable-pip-version-check",
      "jedi==0.19.2",
    ]);
  });
  const output = run(join(dir, "bin", "python"), [
    "-c",
    JEDI,
    query.op,
    query.file,
    String(query.line + 1),
    query.columns.join(","),
    query.symbol,
    query.root,
    String(MAX_HITS + 1),
  ]);
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const hit: { file: string; line: number; column: number; caller: string | null } =
        JSON.parse(line);
      return {
        file: hit.file,
        line: hit.line - 1,
        column: hit.column,
        caller: hit.caller ?? undefined,
      };
    });
}

const JEDI = `
import json, re, subprocess, sys
import jedi

op, path, line, columns, symbol, root, limit = sys.argv[1:]
project = jedi.Project(root)
scripts = {}

def script(file):
    if file not in scripts:
        scripts[file] = jedi.Script(path=file, project=project)
    return scripts[file]

def emit(file, line, column, caller=None):
    print(json.dumps({"file": file, "line": line, "column": column, "caller": caller}))

for column in map(int, columns.split(",")):
    targets = [d for d in script(path).goto(int(line), column, follow_imports=True) if d.module_path]
    if not targets:
        continue
    if op == "def":
        for d in targets:
            emit(str(d.module_path), d.line, d.column)
        break
    keys = {(str(d.module_path), d.line, d.column) for d in targets}
    grep = subprocess.run(["git", "grep", "-n", "-z", "-w", "-F", "--untracked", "-e", symbol, "--", "*.py", "*.pyi"], cwd=root, capture_output=True, text=True).stdout
    found = 0
    for entry in grep.splitlines():
        rel, at, text = entry.split("\\0", 2)
        file, at = f"{root}/{rel}", int(at)
        for match in re.finditer(rf"\\b{re.escape(symbol)}\\b", text):
            if (file, at, match.start()) in keys:
                continue
            # a call or a decorator, as TypeScript's call hierarchy counts them; an import or an assignment is neither
            if op == "callers" and not text[match.end():].lstrip().startswith("(") and not re.search(r"@[\\w.]*$", text[:match.start()]):
                continue
            try:
                if not any((str(d.module_path), d.line, d.column) in keys for d in script(file).goto(at, match.start(), follow_imports=True)):
                    continue
                context = script(file).get_context(at, match.start()) if op == "callers" else None
            except Exception:
                continue
            emit(file, at, match.start(), None if context is None else "" if context.type == "module" else context.name)
            found += 1
            if found >= int(limit):
                sys.exit(0)
    break
`;

function grepFiles(query: Query, extensions: string[]): string[] {
  const result = spawnSync(
    "git",
    [
      "grep",
      "-l",
      "-z",
      "-w",
      "-F",
      "--untracked",
      "-e",
      query.symbol,
      "--",
      ...extensions.map((e) => `*${e}`),
    ],
    { cwd: query.root, encoding: "utf8" }
  );
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .map((path) => join(query.root, path));
}

/**
 * installs into the run's cache once, staging and renaming so a call killed mid-install (the shell
 * tool's timeout) leaves nothing half-made, and two calls racing both end up using one copy
 */
function installOnce(name: string, build: (staging: string) => void): string {
  const dir = join(CACHE, name);
  if (existsSync(dir)) return dir;
  // not the pid: each sandboxed shell command is its own PID namespace, so concurrent calls can share one
  mkdirSync(CACHE, { recursive: true });
  const staging = mkdtempSync(`${dir}.`);
  build(staging);
  try {
    renameSync(staging, dir);
  } catch {
    // another call finished first
    rmSync(staging, { recursive: true, force: true });
  }
  return dir;
}

function run(command: string, argv: string[]): string {
  const result = spawnSync(command, argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status === 0) return result.stdout;
  const detail = (result.stderr || result.error?.message || "")
    .trim()
    .split("\n")
    .slice(-10)
    .join("\n");
  throw new Error(`${command} ${argv[0]} failed: ${detail}`);
}

function dedupe(hits: Hit[]): Hit[] {
  const seen = new Set<string>();
  return hits.filter((hit) => {
    const key = `${hit.file}:${hit.line}:${hit.column}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** grep-like `path:line:col: [caller: ]source`; paths outside the repository stay absolute */
function format(query: Query, hits: Hit[]): string {
  const files = new Map<string, string[]>();
  const lines = hits.slice(0, MAX_HITS).map((hit) => {
    let text = files.get(hit.file);
    if (!text) {
      text = existsSync(hit.file) ? readFileSync(hit.file, "utf8").split("\n") : [];
      files.set(hit.file, text);
    }
    const path = hit.file.startsWith(query.root + sep)
      ? relative(process.cwd(), hit.file)
      : hit.file;
    const caller = hit.caller ? `${hit.caller}: ` : "";
    return `${path}:${hit.line + 1}:${hit.column + 1}: ${caller}${(text[hit.line] ?? "").trim()}\n`;
  });
  const more = hits.length > MAX_HITS ? `codenav: first ${MAX_HITS} shown\n` : "";
  return lines.join("") + more;
}

/** a runner short of memory kills this process (and jedi under it) before the agent */
function deprioritize(): void {
  if (process.platform !== "linux") return;
  try {
    writeFileSync("/proc/self/oom_score_adj", "1000");
  } catch {
    // raising it needs no privilege, but a sandbox may mount /proc read-only
  }
}

/** one line per call, which the action logs at the end of the run */
function record(): void {
  try {
    mkdirSync(CACHE, { recursive: true });
    appendFileSync(
      join(CACHE, "calls"),
      `${args[0] ?? ""} exited ${exitCode} in ${Date.now() - started}ms\n`
    );
  } catch {
    // telemetry never fails the command
  }
}

// last, so every declaration above is initialized when it runs
const started = Date.now();
const args = process.argv.slice(2);
let exitCode = 2;
try {
  deprioritize();
  const query = parse(args);
  const hits = dedupe(
    PY_EXTENSIONS.includes(extname(query.file)) ? python(query) : typescript(query)
  );
  exitCode = hits.length ? 0 : 1;
  if (hits.length) process.stdout.write(format(query, hits));
  else process.stderr.write("codenav: no results\n");
} catch (error) {
  process.stderr.write(`codenav: ${error instanceof Error ? error.message : String(error)}\n`);
}
record();
process.exitCode = exitCode;
