/**
 * the path sandbox: Landlock on Linux, Seatbelt on macOS. a git call in it writes only the checkouts
 * and a private temp dir, reads only what git needs, cannot read another process's environment and,
 * on Linux, cannot reach a unix socket such as docker.sock. it stands in for the namespace sandbox
 * (`sandbox.ts`) on a runner that cannot provide one, and confines every authenticated `$git`, whose
 * hooks and config run while the token is live. changes here should be reflected in wiki/security.md.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_BIN_DIR_RELPATH } from "../agents/nativeFsDenies.ts";
import { renderFailure } from "./failureBody.ts";
import { log } from "./log.ts";
import { resolveRepoRoot } from "./sandbox.ts";
import { filterEnv, proxyEnv } from "./secrets.ts";

export type PathSandbox = "landlock" | "seatbelt" | "none";

type Env = Record<string, string | undefined>;

type Invocation = { cmd: string; args: string[]; env: Env };

/** what a confined git may read (on Linux also run), write, and on macOS run. */
type Rules = { read: string[]; write: string[]; exec: string[] };

const LINUX_READ = [
  "/usr",
  "/etc",
  "/bin",
  "/sbin",
  "/lib",
  "/lib32",
  "/lib64",
  "/proc",
  "/sys/devices/system/cpu",
  // a symlink into /run on systemd hosts
  "/etc/resolv.conf",
];

const DARWIN_READ = [
  "/usr",
  "/bin",
  "/System",
  "/Library",
  "/opt/homebrew",
  "/private/etc",
  "/private/var/db",
  "/private/var/select",
];

/** git's TMPDIR, private to the run. */
const GIT_TMP_RELPATH = "git-tmp";

/** a public repo the probe lists over https, which `git --version` never touches. */
const HTTPS_PROBE_URL = "https://github.com/pullfrog/pullfrog";

/** CA bundles a customer may point git's TLS at, besides the system's own. */
const CA_ENV = [
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "GIT_SSL_CAINFO",
  "GIT_SSL_CAPATH",
  "CURL_CA_BUNDLE",
];

let detected: PathSandbox | undefined;
let probeError: string | undefined;
let tempDir: string | undefined;
let gitPath: string | undefined;
let baseRules: Rules | undefined;
let checkoutDir: string | undefined;

/**
 * the git every call runs, resolved once at startup. Apple's `/usr/bin/git` is an xcrun shim that
 * writes a cache into the user's temp dir, so the sandbox runs the binary it would pick.
 */
export function realGit(): string {
  if (gitPath) return gitPath;
  // a Windows runner's `which` is MSYS's, whose `/cmd/git` no Windows path API resolves
  const lookup = process.platform === "win32" ? "where" : "which";
  const [first = ""] = execFileSync(lookup, ["git"], { encoding: "utf-8" }).split(/\r?\n/);
  const found = realpathSync(first.trim());
  gitPath =
    process.platform === "darwin" && found === "/usr/bin/git"
      ? realpathSync(execFileSync("xcrun", ["--find", "git"], { encoding: "utf-8" }).trim())
      : found;
  return gitPath;
}

/** the path sandbox this runner supports, probed once by running git in it, over https too. */
export function getPathSandbox(params?: { cwd: string | undefined }): PathSandbox {
  checkoutDir ??= params?.cwd ?? resolveRepoRoot();
  detected ??= detectPathSandbox();
  return detected;
}

/** the comment for a CI runner where neither this nor the namespace sandbox works. */
export function unsandboxedRunnerSummary(namespaceError: string | undefined): string {
  return renderFailure({
    headline: "This runner cannot sandbox Pullfrog's git commands",
    detail:
      "Pullfrog runs each git command in a PID namespace or, where the runner allows none, in Landlock on Linux or Seatbelt on macOS. Neither works here, so the run stopped before the agent started.",
    error: [namespaceError, probeError].filter(Boolean).join("\n") || undefined,
    links: [
      {
        label: "Self-hosted runners",
        url: "https://docs.pullfrog.com/security#self-hosted-runners",
      },
    ],
  });
}

function detectPathSandbox(): PathSandbox {
  const method =
    process.platform === "linux" ? "landlock" : process.platform === "darwin" ? "seatbelt" : "none";
  tempDir = process.env.PULLFROG_TEMP_DIR;
  if (process.env.CI !== "true" || !tempDir) return "none";
  if (method === "none") {
    probeError = `${process.platform} has neither Landlock nor Seatbelt`;
    return "none";
  }
  try {
    if (method === "landlock") installHelper();
    probeError = probeGit({ method, args: ["--version"] }) ?? probeHttps(method);
  } catch (error) {
    probeError = error instanceof Error ? error.message : String(error);
  }
  if (!probeError) {
    log.debug(`» git path sandbox: ${method}`);
    return method;
  }
  log.info(`» git path sandbox (${method}) not available: ${probeError}`);
  return "none";
}

/**
 * a fetch loads what `git --version` does not: the TLS stack, the CA store (which can link out of
 * the read set, as openSUSE's does) and DNS. one that fails only in the sandbox means the sandbox
 * breaks https; one that fails both ways is the network's, and decides nothing.
 */
function probeHttps(method: Exclude<PathSandbox, "none">): string | undefined {
  const args = ["ls-remote", HTTPS_PROBE_URL, "HEAD"];
  const error = probeGit({ method, args });
  return error && !probeGit({ args }) ? error : undefined;
}

/** runs git in `method`'s sandbox, or plainly without one; the failure, if any. */
function probeGit(params: {
  method?: Exclude<PathSandbox, "none">;
  args: string[];
}): string | undefined {
  // the runner's egress proxy too, which filterEnv leaves out: without it a runner that reaches
  // GitHub only through one fails the listing both ways, and the probe decides nothing
  const env = { ...filterEnv(), ...proxyEnv(), GIT_TERMINAL_PROMPT: "0" };
  const probe = params.method
    ? buildInvocation({ method: params.method, args: params.args, env, run: [] })
    : { cmd: realGit(), args: params.args, env };
  const result = spawnSync(probe.cmd, probe.args, {
    // git reads its working directory, which has to be one the sandbox allows
    cwd: join(scratchDir(), GIT_TMP_RELPATH),
    env: probe.env,
    timeout: 10_000,
    stdio: ["ignore", "ignore", "pipe"],
    encoding: "utf-8",
  });
  if (result.status === 0) return undefined;
  return result.stderr.trim() || result.error?.message || `git exited ${result.status}`;
}

/**
 * `git args` in the path sandbox, for the caller's spawn, or undefined where there is none. `auth`
 * is what an authenticated call runs besides git: its askpass script and the hooks it pins.
 */
export function confineGit(params: {
  args: string[];
  env: Env;
  auth?: { askpass: string; hooks: string };
}): Invocation | undefined {
  const method = getPathSandbox();
  if (method === "none") return undefined;
  if (!params.auth) return buildInvocation({ method, args: params.args, env: params.env, run: [] });
  const node = askpassNode();
  return buildInvocation({
    method,
    args: params.args,
    // the askpass script starts `env node`. a version manager's shim would run a node the sandbox
    // does not name, so this one comes first
    env: { ...params.env, PATH: [dirname(node), params.env.PATH].filter(Boolean).join(delimiter) },
    run: [params.auth.askpass, params.auth.hooks, node, "/usr/bin/env"],
  });
}

/** agent-bin's copy where `narrowProcessPath` made one, which nothing the agent runs can replace. */
function askpassNode(): string {
  const copy = join(scratchDir(), AGENT_BIN_DIR_RELPATH, "node");
  return existsSync(copy) ? copy : process.execPath;
}

function findOnPath(name: string, path = ""): string[] {
  const found = path
    .split(delimiter)
    .map((dir) => join(dir, name))
    .find((candidate) => isAbsolute(candidate) && existsSync(candidate));
  return found ? [found] : [];
}

function buildInvocation(params: {
  method: Exclude<PathSandbox, "none">;
  args: string[];
  env: Env;
  run: string[];
}): Invocation {
  const rules = getBaseRules();
  const run = params.run.map(canonical);
  const env = { ...params.env, TMPDIR: join(scratchDir(), GIT_TMP_RELPATH) };
  if (params.method === "landlock") {
    return {
      cmd: helperPath(),
      args: [
        ...[...rules.read, ...run].flatMap((path) => ["--ro", path]),
        ...rules.write.flatMap((path) => ["--rw", path]),
        "--",
        realGit(),
        ...params.args,
      ],
      env,
    };
  }
  const profile = seatbeltProfile({
    read: [...rules.read, ...run],
    write: rules.write,
    exec: [...rules.exec, ...run],
  });
  return { cmd: "/usr/bin/sandbox-exec", args: ["-p", profile, realGit(), ...params.args], env };
}

/**
 * resolved once, before the agent can change anything it reads. the repo's own config is never
 * read for paths, since the agent can write it.
 */
function getBaseRules(): Rules {
  if (baseRules) return baseRules;
  const dir = scratchDir();
  const git = realGit();
  const execPath = execFileSync(git, ["--exec-path"], { encoding: "utf-8" }).trim();
  const home = homedir();
  const scratch = [GIT_TMP_RELPATH, "xrepo"].map((rel) => join(dir, rel));
  for (const path of scratch) mkdirSync(path, { recursive: true });
  const lfs = findOnPath("git-lfs", process.env.PATH);
  const repo = gitDirs();
  baseRules = {
    read: [
      ...(process.platform === "darwin" ? DARWIN_READ : LINUX_READ),
      "/dev/urandom",
      "/dev/random",
      dirname(dirname(git)),
      execPath,
      join(home, ".gitconfig"),
      join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "git"),
      ...CA_ENV.flatMap((name) => process.env[name] ?? []),
      ...configuredPaths(git),
      ...alternateStores(repo),
      ...lfs,
    ].map(canonical),
    write: [...scratch, resolveRepoRoot(), ...repo.dirs, "/dev/null"].map(canonical),
    // a hook, and a filter such as `git-lfs filter-process`, runs through `sh`, which on macOS
    // starts the shell `/private/var/select/sh` names
    exec: [git, execPath, "/bin/sh", "/private/var/select/sh", ...lfs].map(canonical),
  };
  return baseRules;
}

/**
 * the files the system and global git config read, includes too, and the CA bundles they name,
 * so a runner's corporate CA or an included config still loads.
 */
function configuredPaths(git: string): string[] {
  const listed = spawnSync(git, ["config", "--list", "--null", "--show-scope", "--show-origin"], {
    encoding: "utf-8",
  });
  const fields = (listed.stdout ?? "").split("\0");
  const paths: string[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    if (fields[i] !== "system" && fields[i] !== "global") continue;
    if (fields[i + 1]?.startsWith("file:")) paths.push(fields[i + 1]?.slice(5) ?? "");
    const [key = "", value = ""] = fields[i + 2]?.split("\n") ?? [];
    if (/^http\..*sslca(info|path)$/.test(key)) paths.push(value.replace(/^~\//, `${homedir()}/`));
  }
  return paths.filter((path) => isAbsolute(path));
}

/**
 * the checkout's git dir and common dir, which a worktree, `--separate-git-dir` or a symlink puts
 * outside the workspace, and its object store.
 */
function gitDirs(): { dirs: string[]; objects: string | undefined } {
  const result = spawnSync(
    realGit(),
    ["rev-parse", "--path-format=absolute", "--absolute-git-dir", "--git-common-dir"],
    { cwd: checkoutDir, encoding: "utf-8" }
  );
  const [gitDir, commonDir] = result.status === 0 ? result.stdout.split("\n") : [];
  if (!gitDir || !commonDir) return { dirs: [], objects: undefined };
  const objects = join(commonDir, "objects");
  return { dirs: [gitDir, commonDir, objects], objects };
}

/**
 * object stores the checkout borrows from (a self-hosted runner's git cache, a `--reference`
 * clone), read before the agent can edit the alternates file. a store's own repo too, whose refs
 * a fetch or push reads through `core.alternateRefsCommand`.
 */
function alternateStores(repo: { objects: string | undefined }): string[] {
  const fromEnv = (process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((entry) => resolve(checkoutDir ?? "", entry));
  const listed = repo.objects ? listedAlternates({ objects: repo.objects, depth: 0 }) : [];
  return [
    ...fromEnv,
    ...fromEnv.flatMap((objects) => listedAlternates({ objects, depth: 1 })),
    ...listed,
  ].flatMap((store) => (basename(store) === "objects" ? [store, dirname(store)] : [store]));
}

/** the stores `objects/info/alternates` names, and theirs, as deep as git follows them. */
function listedAlternates(params: { objects: string; depth: number }): string[] {
  const file = join(params.objects, "info", "alternates");
  if (params.depth > 5 || !existsSync(file)) return [];
  const stores = readFileSync(file, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => resolve(params.objects, line));
  return stores.flatMap((objects) => [
    objects,
    ...listedAlternates({ objects, depth: params.depth + 1 }),
  ]);
}

/** the helper, copied where nothing the agent runs can replace it before the first confined call. */
function installHelper(): void {
  const name = `pullfrog-landlock-${process.arch}`;
  const here = dirname(fileURLToPath(import.meta.url));
  const source = [join(here, "..", "sandbox", name), join(here, "sandbox", name)].find((path) =>
    existsSync(path)
  );
  if (!source) throw new Error(`no Landlock helper for ${process.arch}`);
  mkdirSync(dirname(helperPath()), { recursive: true });
  copyFileSync(source, helperPath());
  chmodSync(helperPath(), 0o755);
}

function helperPath(): string {
  return join(scratchDir(), AGENT_BIN_DIR_RELPATH, "pullfrog-landlock");
}

function scratchDir(): string {
  if (!tempDir) throw new Error("PULLFROG_TEMP_DIR is not set");
  return tempDir;
}

/**
 * Seatbelt cannot stop a same-user process reading another's environment through
 * `sysctl(KERN_PROCARGS2)`, which is what `ps eww` does, so nothing runs but what `exec` names.
 */
function seatbeltProfile(rules: Rules): string {
  const paths = (list: string[]) =>
    list.map((path) => `(subpath ${JSON.stringify(path)})`).join(" ");
  return [
    "(version 1)",
    "(deny default)",
    '(import "system.sb")',
    "(allow process-fork)",
    "(allow signal (target same-sandbox))",
    "(allow process-info* (target same-sandbox))",
    "(allow file-read-metadata)",
    `(allow process-exec ${paths(rules.exec)})`,
    `(allow file-map-executable ${paths(rules.read)})`,
    `(allow file-read* ${paths([...rules.read, ...rules.write])})`,
    `(allow file-write* ${paths(rules.write)})`,
    '(allow network-outbound (remote ip) (literal "/private/var/run/mDNSResponder"))',
    "(allow network-inbound (local ip))",
    "(allow system-socket)",
  ].join("\n");
}

/** Seatbelt matches resolved paths, and Landlock rules land on the target anyway. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
