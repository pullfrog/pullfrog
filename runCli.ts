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

function resolveExecutable(params: { command: string; env: NodeJS.ProcessEnv }): string | null {
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
      if (canAccessExecutable(candidate)) {
        return candidate;
      }
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
  // pullfrog's npm version is server-stamped from a SHA-pinned action ref the
  // customer already vets at the action layer — not a customer-vetted dep, so
  // the gate is the wrong affordance here. env beats .npmrc in both tools.
  // npm uses `npm_config_*`; pnpm v11+ requires `pnpm_config_*` (the v10→v11
  // migration renamed the prefix). tracked: #713
  env.npm_config_min_release_age = "0";
  env.pnpm_config_minimum_release_age = "0";
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

function runPackageCli(context: RuntimeContext, packageSpec: string, cliArgs: string[]): void {
  const npxPath = resolveExecutable({ command: "npx", env: context.env });
  if (npxPath) {
    runCommand({ context, command: npxPath, args: ["--yes", packageSpec, ...cliArgs] });
    return;
  }

  const corepackPath = resolveExecutable({ command: "corepack", env: context.env });
  if (corepackPath) {
    console.warn("» npx not found, using corepack pnpm dlx");
    runCommand({ context, command: corepackPath, args: ["pnpm", "dlx", packageSpec, ...cliArgs] });
    return;
  }

  throw new Error(
    `could not find npx or corepack on PATH to run ${packageSpec}; ` +
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

function runPullfrogCliInner(context: RuntimeContext, cliArgs: string[]): void {
  if (process.env.PULLFROG_FORCE_LOCAL_CLI === "1") {
    runLocalCli(context, cliArgs);
    return;
  }

  // Upstream `pullfrog/pullfrog@main` develops against the checked-out tree.
  // Forks (e.g. Weltel-repo/weltel-pullfrog) must also run the local tree —
  // otherwise npx pullfrog@^N ignores fork-only changes (Weltel footer branding,
  // local Fix links, etc.) and reverts to the published SaaS package.
  // Tagged upstream releases still use the npm package as the distribution path.
  if (
    context.actionRepository !== "pullfrog/pullfrog" ||
    context.actionRef === "main"
  ) {
    runLocalCli(context, cliArgs);
    return;
  }

  runPackageCli(context, FALLBACK_PACKAGE_SPEC, cliArgs);
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

export function runPullfrogCli(params: RunPullfrogCliParams): void {
  const context = createRuntimeContext();

  if (params.swallowErrors) {
    try {
      runPullfrogCliInner(context, params.cliArgs);
    } catch (error) {
      console.warn(`» pullfrog cleanup bootstrap failed: ${getErrorMessage(error)}`);
      // best-effort cleanup
    }
    return;
  }

  try {
    runPullfrogCliInner(context, params.cliArgs);
  } catch (error) {
    propagateChildExit(error);
  }
}
