import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import actionPackageJson from "./package.json" with { type: "json" };

interface RunPullfrogCliParams {
  cliArgs: string[];
  swallowErrors?: boolean;
}

interface RuntimeContext {
  actionRef: string | undefined;
  actionRepository: string | undefined;
  actionRoot: string;
  nodeBinDir: string;
  env: NodeJS.ProcessEnv;
}

const NPM_REGISTRY = "https://registry.npmjs.org";
const FALLBACK_PACKAGE_SPEC = `pullfrog@^${actionPackageJson.version}`;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function canAccessExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    if (process.platform !== "win32") {
      return false;
    }
  }

  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// reject PATH entries that an attacker can plausibly write to before pullfrog
// runs. specifically: relative entries (., bin, etc., which resolve against
// cwd), and anything inside the customer's checkout. an attacker who can land
// a malicious `npx` in the repo and prepend `$GITHUB_WORKSPACE/bin` to
// `GITHUB_PATH` from a prior workflow step would otherwise get full code
// execution under our action token.
//
// on Windows the filesystem is case-insensitive but `resolve()` preserves
// input case, so we lowercase both sides before comparing — otherwise an
// attacker can bypass the filter by varying the case of GITHUB_WORKSPACE in
// their injected PATH entry (`d:\a\repo` vs `D:\a\repo`).
function normalizePathForCompare(path: string): string {
  return process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
}

function isUntrustedPathEntry(entry: string, untrustedRoots: string[]): boolean {
  if (!isAbsolute(entry)) return true;
  const normalized = normalizePathForCompare(entry);
  for (const root of untrustedRoots) {
    if (normalized === root) return true;
    if (normalized.startsWith(root + sep)) return true;
  }
  return false;
}

function getUntrustedPathRoots(env: NodeJS.ProcessEnv): string[] {
  const roots: string[] = [];
  const workspace = env.GITHUB_WORKSPACE;
  if (workspace && isAbsolute(workspace)) roots.push(normalizePathForCompare(workspace));
  return roots;
}

/**
 * Existence + the execute bit is not proof a launcher WORKS. Self-hosted pools
 * ship partial `externals/node24` trees whose `npx` is a shim over a
 * `lib/cli.js` that isn't there: it passes every filesystem check and then dies
 * with a bare `MODULE_NOT_FOUND`. Probing `--version` is what lets
 * `resolveExecutable` keep walking PATH to the runner's working copy, and what
 * makes the corepack fallback reachable at all. See #1084.
 */
function isExecutableUsable(path: string, env: NodeJS.ProcessEnv): boolean {
  try {
    // MUST use the same env the real invocation gets. `context.env` prepends
    // `nodeBinDir` precisely because the action runtime's `node` may not be on
    // the ambient PATH — and a GHA runner's `npx` is a `#!/usr/bin/env node`
    // shebang, so probing with the inherited env exits 127 and would demote a
    // perfectly good launcher (then throw, when corepack fails the same way).
    execFileSync(path, ["--version"], { stdio: "ignore", env });
    return true;
  } catch {
    return false;
  }
}

function resolveExecutable(params: {
  command: string;
  env: NodeJS.ProcessEnv;
  /** probe each candidate before accepting it, and keep walking PATH if it fails */
  verify?: boolean;
}): string | null {
  const pathValue = params.env.PATH ?? "";
  const untrustedRoots = getUntrustedPathRoots(params.env);
  const pathEntries = pathValue
    .split(delimiter)
    .filter(Boolean)
    .filter((entry) => !isUntrustedPathEntry(entry, untrustedRoots));
  const extensions =
    process.platform === "win32"
      ? (params.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];

  for (const pathEntry of pathEntries) {
    for (const extension of extensions) {
      const candidate = join(pathEntry, `${params.command}${extension.toLowerCase()}`);
      if (!canAccessExecutable(candidate)) continue;
      if (params.verify && !isExecutableUsable(candidate, params.env)) {
        console.warn(`» ${candidate} is not runnable, continuing to search PATH`);
        continue;
      }
      return candidate;
    }
  }

  return null;
}

function createRuntimeContext(): RuntimeContext {
  const actionRoot = dirname(fileURLToPath(import.meta.url));
  const nodeBinDir = dirname(process.execPath);
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.npm_config_registry = NPM_REGISTRY;
  env.COREPACK_NPM_REGISTRY = NPM_REGISTRY;
  // bypass customer-side release-age gates (npm's `min-release-age`, pnpm's
  // `minimumReleaseAge`) so our bootstrap can resolve the latest publish.
  // pullfrog is our runtime, not a customer-vetted dep: every action ref, a
  // SHA pin included, tracks `^<version>` (wiki/action-bootstrap.md), so the
  // gate is the wrong affordance here. env beats .npmrc in both tools.
  // npm uses `npm_config_*`; pnpm v11+ requires `pnpm_config_*` (the v10→v11
  // migration renamed the prefix). tracked: #713
  env.npm_config_min_release_age = "0";
  env.pnpm_config_minimum_release_age = "0";
  // `prefer-offline` trusts a cached packument forever, so it would pin the
  // bootstrap to the newest version that packument lists, or ETARGET an exact one
  env.npm_config_prefer_offline = "false";
  const currentPath = process.env.PATH ?? "";
  env.PATH = currentPath ? `${nodeBinDir}${delimiter}${currentPath}` : nodeBinDir;

  return {
    actionRef: process.env.GITHUB_ACTION_REF,
    actionRepository: process.env.GITHUB_ACTION_REPOSITORY,
    actionRoot,
    nodeBinDir,
    env,
  };
}

// $GITHUB_WORKSPACE is the customer's repo. running `npx --yes pullfrog@…`
// there makes npm read THEIR `package.json` first, which on npm v11+ enforces
// `devEngines.packageManager` and aborts the bootstrap with EBADDEVENGINES
// before the agent ever boots. our bootstrap doesn't need anything from the
// customer's tree — a freshly-created tmpdir is package.json-free and
// parent-less, so npm walks up to `/` finding nothing. see #837.
//
// `mkdtempSync` (vs raw `tmpdir()`): `$TMPDIR` is overridable from a prior
// `$GITHUB_ENV` step, and a customer-authored or compromised prior step
// could plant `node_modules/pullfrog/` in the resolved tmpdir to hijack
// `npx --yes pullfrog@<version>` resolution. a fresh per-invocation
// subdirectory is mode 0700 and not pre-writable by anything earlier in
// the job.
function runCommand(params: { context: RuntimeContext; command: string; args: string[] }): void {
  execFileSync(params.command, params.args, {
    cwd: mkdtempSync(join(tmpdir(), "pullfrog-bootstrap-")),
    stdio: "inherit",
    env: params.context.env,
  });
}

// resolve a launcher binary by walking PATH (which already has the action
// runtime's nodeBinDir prepended). some hosted Node 24 runner pools ship
// `node` at `externals/node24/bin/node` without the sibling `npx`/`corepack`,
// so a hardcoded sibling path can't be relied on — fall back to whatever the
// runner image provides on PATH.
function requireExecutable(params: {
  context: RuntimeContext;
  command: string;
  purpose: string;
}): string {
  const resolved = resolveExecutable({ command: params.command, env: params.context.env });
  if (!resolved) {
    throw new Error(
      `could not find ${params.command} on PATH (needed to ${params.purpose}); ` +
        `runtime PATH was: ${params.context.env.PATH ?? "<empty>"}`
    );
  }
  return resolved;
}

// npm lists a new version before its CDN serves it, and the CDN then caches that
// 404 for five minutes; every run in that window died on 0.1.93. the 330s total
// outlasts a 404 this run's own first attempt cached. see wiki/action-bootstrap.md.
const PREFETCH_RETRY_SECONDS = [30, 60, 90, 150];

function isNotYetServed(error: unknown): boolean {
  if (!(error instanceof Error) || !("stderr" in error)) return false;
  const stderr = String(error.stderr);
  return (stderr.includes("E404") && stderr.includes(".tgz")) || stderr.includes("ETARGET");
}

/**
 * Download the package into npm's cache, retrying only a release npm lists but
 * does not serve yet, so the real run installs from the cache. Any other failure
 * is left for the real run to reproduce with its output visible.
 */
function prefetchPackage(params: {
  context: RuntimeContext;
  npxPath: string;
  packageSpec: string;
}): void {
  for (let attempt = 0; ; attempt++) {
    try {
      execFileSync(
        params.npxPath,
        ["--yes", "--package", params.packageSpec, "--", "node", "-e", "0"],
        {
          cwd: mkdtempSync(join(tmpdir(), "pullfrog-bootstrap-")),
          stdio: ["ignore", "ignore", "pipe"],
          env: params.context.env,
        }
      );
      return;
    } catch (error) {
      const delay = PREFETCH_RETRY_SECONDS[attempt];
      if (delay === undefined || !isNotYetServed(error)) return;
      console.warn(`» npm does not serve ${params.packageSpec} yet; retrying in ${delay}s`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay * 1000);
    }
  }
}

function compareReleases(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

/** `version` is a stable release satisfying `^<base>`: same major (same minor below 1.0), not older */
function satisfiesCaret(version: string, base: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(version) || compareReleases(version, base) < 0) return false;
  const [major, minor] = version.split(".");
  const [baseMajor, baseMinor] = base.split(".");
  return major === baseMajor && (baseMajor !== "0" || minor === baseMinor);
}

/**
 * npx before npm 11.2 reuses any cached install that satisfies a range, so on a
 * self-hosted runner's persistent `~/.npm/_npx` the range pins the first version
 * it ever installed. An exact version gets a fresh npx dir per release. Picks
 * the way npm does: `latest` if it satisfies the range, else the highest match.
 */
async function resolvePackageSpec(): Promise<string> {
  try {
    const response = await fetch(`${NPM_REGISTRY}/pullfrog`, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`registry answered ${response.status}`);
    const packument: { "dist-tags": { latest: string }; versions: Record<string, unknown> } =
      JSON.parse(await response.text());
    const matches = Object.keys(packument.versions)
      .filter((version) => satisfiesCaret(version, actionPackageJson.version))
      .sort((a, b) => compareReleases(b, a));
    const latest = packument["dist-tags"].latest;
    const picked = matches.includes(latest) ? latest : matches[0];
    if (!picked) throw new Error("no published version matches");
    return `pullfrog@${picked}`;
  } catch (error) {
    console.warn(
      `» could not resolve ${FALLBACK_PACKAGE_SPEC} (${getErrorMessage(error)}); using the range`
    );
    return FALLBACK_PACKAGE_SPEC;
  }
}

function runPackageCli(context: RuntimeContext, packageSpec: string, cliArgs: string[]): void {
  // `verify` here and not in `requireExecutable`: this is the one resolution
  // whose failure is unattributable, because a broken launcher dies before any
  // of our logging exists. see #1084.
  const npxPath = resolveExecutable({ command: "npx", env: context.env, verify: true });
  if (npxPath) {
    console.log(`» running ${packageSpec} via ${npxPath}`);
    prefetchPackage({ context, npxPath, packageSpec });
    runCommand({ context, command: npxPath, args: ["--yes", packageSpec, ...cliArgs] });
    return;
  }

  const corepackPath = resolveExecutable({ command: "corepack", env: context.env, verify: true });
  if (corepackPath) {
    console.warn("» npx not found, using corepack pnpm dlx");
    runCommand({ context, command: corepackPath, args: ["pnpm", "dlx", packageSpec, ...cliArgs] });
    return;
  }

  // `::error::` written directly rather than via @actions/core: this is the
  // bootstrap, deliberately dependency-light, and it runs before any of our
  // error plumbing is initialized. without it a runner with a broken launcher
  // fails with no annotation and no PR comment at all.
  console.log(
    `::error::Pullfrog could not start: no working npx or corepack on this runner's PATH. ` +
      `This usually means a self-hosted runner has an incomplete Node installation. PATH was: ${context.env.PATH ?? "<empty>"}`
  );
  throw new Error(
    `could not find a working npx or corepack on PATH to run ${packageSpec}; ` +
      `runtime PATH was: ${context.env.PATH ?? "<empty>"}`
  );
}

function ensureActionDependencies(context: RuntimeContext): void {
  const nodeModulesPath = join(context.actionRoot, "node_modules");
  if (existsSync(nodeModulesPath)) {
    return;
  }

  const corepackPath = requireExecutable({
    context,
    command: "corepack",
    purpose: "install action dependencies via pnpm",
  });
  const adjacentCorepack = join(
    context.nodeBinDir,
    process.platform === "win32" ? "corepack.cmd" : "corepack"
  );
  if (corepackPath !== adjacentCorepack) {
    // bad-runner case: GitHub's externals/node24/bin/ is missing the corepack
    // sibling, so we resolved via PATH instead. logging this lets us correlate
    // bootstrap path to runner pool when validating the fix.
    console.warn(
      `» nodeBinDir corepack missing (${adjacentCorepack}); using PATH-resolved ${corepackPath}`
    );
  }
  execFileSync(corepackPath, ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"], {
    cwd: context.actionRoot,
    stdio: "inherit",
    env: context.env,
  });
}

function runLocalCli(context: RuntimeContext, cliArgs: string[]): void {
  ensureActionDependencies(context);
  execFileSync(process.execPath, ["cli.ts", ...cliArgs], {
    cwd: context.actionRoot,
    stdio: "inherit",
    env: context.env,
  });
}

async function runPullfrogCliInner(context: RuntimeContext, cliArgs: string[]): Promise<void> {
  if (process.env.PULLFROG_FORCE_LOCAL_CLI === "1") {
    runLocalCli(context, cliArgs);
    return;
  }

  if (context.actionRef === "main" && context.actionRepository === "pullfrog/pullfrog") {
    runLocalCli(context, cliArgs);
    return;
  }

  runPackageCli(context, await resolvePackageSpec(), cliArgs);
}

// the inner CLI and the bootstrap install run with `stdio: "inherit"`, so on a
// non-zero exit they've already printed their own `##[error]` line. node turns
// that exit into a thrown `Error: Command failed…`; letting it bubble crashes
// the outer bootstrap with a `node:internal/errors` stack trace that buries the
// real failure (#862, #867). propagate the child's exit code silently instead;
// only genuine spawn failures (ENOENT, missing npx, …) still surface.
function propagateChildExit(error: unknown): never {
  if (error instanceof Error && "status" in error && typeof error.status === "number") {
    process.exit(error.status);
  }
  if (error instanceof Error && "signal" in error && error.signal != null) {
    process.exit(1);
  }
  throw error;
}

export async function runPullfrogCli(params: RunPullfrogCliParams): Promise<void> {
  const context = createRuntimeContext();

  if (params.swallowErrors) {
    try {
      await runPullfrogCliInner(context, params.cliArgs);
    } catch (error) {
      console.warn(`» pullfrog cleanup bootstrap failed: ${getErrorMessage(error)}`);
      // best-effort cleanup
    }
    return;
  }

  try {
    await runPullfrogCliInner(context, params.cliArgs);
  } catch (error) {
    propagateChildExit(error);
  }
}
