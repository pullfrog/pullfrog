import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { isValid, satisfies } from "verkit";
import { log } from "./cli.ts";
import { filterEnvForUntrustedCode } from "./secrets.ts";
import { spawn } from "./subprocess.ts";

export type SupportedPackageManager = "npm" | "pnpm" | "yarn" | "bun";

const SUPPORTED_NAMES: readonly SupportedPackageManager[] = ["npm", "pnpm", "yarn", "bun"];

// corepack ships pnpm + yarn shims out of the box. it does not ship bun or
// npm (npm comes with node). callers fall back to the legacy npm-install-g
// path for managers outside this set.
const COREPACK_MANAGED: readonly SupportedPackageManager[] = ["pnpm", "yarn"];

export interface PackageManagerSpec {
  name: SupportedPackageManager;
  /**
   * either a concrete semver (e.g. "11.1.1") or a range (e.g. "^11.0.0").
   * `concrete` distinguishes — corepack only accepts concrete versions.
   */
  version: string;
  concrete: boolean;
  /** which package.json field this came from */
  source: "devEngines" | "packageManager";
}

interface PackageJson {
  packageManager?: string;
  devEngines?: {
    packageManager?: {
      name?: string;
      version?: string;
      onFail?: string;
    };
  };
}

function isSupported(name: string): name is SupportedPackageManager {
  return (SUPPORTED_NAMES as readonly string[]).includes(name);
}

function parsePackageManagerField(value: string): PackageManagerSpec | null {
  // npm spec form is "name@version[+integrity]" — corepack adds the integrity
  // suffix; we strip it because it's not a semver.
  const withoutHash = value.split("+")[0];
  const at = withoutHash.lastIndexOf("@");
  if (at <= 0) return null;
  const name = withoutHash.slice(0, at);
  const version = withoutHash.slice(at + 1);
  if (!isSupported(name)) {
    log.warning(`» unknown packageManager in package.json: ${value}`);
    return null;
  }
  return {
    name,
    version,
    concrete: isValid(version),
    source: "packageManager",
  };
}

function parseDevEnginesField(
  field: NonNullable<NonNullable<PackageJson["devEngines"]>["packageManager"]>
): PackageManagerSpec | null {
  if (!field.name || !field.version) return null;
  if (!isSupported(field.name)) {
    log.warning(`» unknown devEngines.packageManager.name in package.json: ${field.name}`);
    return null;
  }
  const version = field.version.trim();
  return {
    name: field.name,
    version,
    concrete: isValid(version),
    source: "devEngines",
  };
}

/**
 * resolve the project's intended package manager from package.json. precedence
 * matches pnpm 11+: `devEngines.packageManager` wins over `packageManager`.
 * when both are present, a concrete `packageManager` that satisfies a
 * `devEngines` range is preferred (we can pin it via corepack); otherwise
 * we warn on disagreement and stick with `devEngines`.
 */
export async function resolvePackageManagerSpec(cwd: string): Promise<PackageManagerSpec | null> {
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) return null;

  let pkg: PackageJson;
  try {
    pkg = JSON.parse(await readFile(pkgPath, "utf-8")) as PackageJson;
  } catch (err) {
    log.warning(
      `» failed to parse package.json for package manager resolution: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }

  const devSpec = pkg.devEngines?.packageManager
    ? parseDevEnginesField(pkg.devEngines.packageManager)
    : null;
  const pmSpec = pkg.packageManager?.trim()
    ? parsePackageManagerField(pkg.packageManager.trim())
    : null;

  if (!devSpec) return pmSpec;
  if (!pmSpec) return devSpec;

  if (devSpec.name !== pmSpec.name) {
    log.warning(
      `» devEngines.packageManager (${devSpec.name}) disagrees with packageManager (${pmSpec.name}); using devEngines per pnpm 11 precedence`
    );
    return devSpec;
  }

  // same manager — try to land on a concrete version we can pin via corepack.
  if (devSpec.concrete) {
    if (pmSpec.concrete && devSpec.version !== pmSpec.version) {
      log.warning(
        `» devEngines.packageManager (${devSpec.version}) disagrees with packageManager (${pmSpec.version}); using devEngines per pnpm 11 precedence`
      );
    }
    return devSpec;
  }

  if (pmSpec.concrete && satisfies(pmSpec.version, devSpec.version)) {
    return pmSpec;
  }

  if (pmSpec.concrete) {
    log.warning(
      `» packageManager (${pmSpec.version}) does not satisfy devEngines range (${devSpec.version}); using devEngines`
    );
  }
  return devSpec;
}

interface CorepackResult {
  exitCode: number;
  stderr: string;
}

async function runCorepack(args: string[]): Promise<CorepackResult> {
  const result = await spawn({
    cmd: "corepack",
    args,
    env: { ...filterEnvForUntrustedCode(), COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
    onStdout: (chunk) => process.stdout.write(chunk),
    onStderr: (chunk) => process.stderr.write(chunk),
  });
  return { exitCode: result.exitCode, stderr: result.stderr };
}

async function currentVersion(name: SupportedPackageManager): Promise<string | null> {
  const result = await spawn({
    cmd: name,
    args: ["--version"],
    env: filterEnvForUntrustedCode(),
  });
  if (result.exitCode !== 0) return null;
  return result.stdout.trim();
}

/** the per-run directory the corepack shim is installed into. deliberately
 * NOT the node bin dir: that's npm's `-g` target, and a corepack shim sitting
 * there makes a customer setup script's `npm i -g pnpm` abort with EEXIST
 * (npm refuses to clobber a binary it doesn't own). lives under the run
 * tmpdir so it's cleaned up with everything else. */
export function packageManagerBinDir(tmpdir: string): string {
  return join(tmpdir, "pm-bin");
}

export interface EnsurePackageManagerParams {
  spec: PackageManagerSpec;
  /** directory to install the corepack shim into (see `packageManagerBinDir`).
   * prepended to PATH so the pinned binary resolves by name. */
  binDir: string;
}

/**
 * ensure the requested package manager is on PATH at the declared version,
 * provisioning via corepack when applicable. returns true if PATH now
 * resolves to that version, false if we couldn't pin it (in which case
 * the caller should treat PATH as untrusted and may fall back to its
 * legacy install path).
 *
 * the corepack shim is installed into `params.binDir` (prepended to PATH),
 * not the node bin dir, so a later `npm i -g pnpm` in a setup hook can't
 * collide with it. our dir wins the PATH lookup, so the pinned version is
 * also what resolves even if that `npm i -g` succeeds into the node bin dir.
 *
 * never throws: network failure, missing corepack, range-only versions —
 * all degrade to "log warning, return false". the existing PATH binary
 * still works; we just don't get our version guarantee.
 */
export async function ensurePackageManager(params: EnsurePackageManagerParams): Promise<boolean> {
  const spec = params.spec;
  if (spec.name === "npm") return true;

  if (!(COREPACK_MANAGED as readonly string[]).includes(spec.name)) {
    return false;
  }

  if (!spec.concrete) {
    log.warning(
      `» ${spec.name} ${spec.source} version is a range (${spec.version}); corepack requires a concrete pin. leaving PATH unchanged.`
    );
    return false;
  }

  const existing = await currentVersion(spec.name);
  if (existing === spec.version) {
    log.info(`» ${spec.name}@${spec.version} already active`);
    return true;
  }

  log.info(
    `» corepack prepare ${spec.name}@${spec.version} --activate (shim dir: ${params.binDir})`
  );

  await mkdir(params.binDir, { recursive: true });
  const enable = await runCorepack(["enable", "--install-directory", params.binDir, spec.name]);
  if (enable.exitCode !== 0) {
    log.warning(
      `» corepack enable failed (exit ${enable.exitCode}); leaving ${spec.name} from PATH. stderr: ${enable.stderr.trim() || "(empty)"}`
    );
    return false;
  }

  // shim dir first so `pnpm` resolves to the pinned binary and shadows any
  // `pnpm` a later `npm i -g pnpm` drops into the node bin dir.
  process.env.PATH = `${params.binDir}${delimiter}${process.env.PATH ?? ""}`;

  const prepare = await runCorepack(["prepare", `${spec.name}@${spec.version}`, "--activate"]);
  if (prepare.exitCode !== 0) {
    log.warning(
      `» corepack prepare ${spec.name}@${spec.version} failed (exit ${prepare.exitCode}); leaving ${spec.name} from PATH. stderr: ${prepare.stderr.trim() || "(empty)"}`
    );
    return false;
  }

  const after = await currentVersion(spec.name);
  if (after !== spec.version) {
    log.warning(
      `» corepack activated ${spec.name}@${spec.version} but PATH still resolves to ${after ?? "(missing)"}; continuing anyway`
    );
  }

  return true;
}

/** `SupportedPackageManager` plus deno, which corepack never manages. */
export type ProvisionablePackageManager = SupportedPackageManager | "deno";

async function isCommandAvailable(command: string): Promise<boolean> {
  const result = await spawn({ cmd: "which", args: [command], env: filterEnvForUntrustedCode() });
  return result.exitCode === 0;
}

/**
 * Install a manager corepack doesn't ship a shim for. pnpm and yarn go through
 * `ensurePackageManager`; bun and deno fall through to here.
 */
async function installFallback(
  name: ProvisionablePackageManager,
  installSpec: string
): Promise<string | null> {
  if (name === "npm") return null;
  log.info(`» installing ${installSpec} via npm install -g (corepack does not manage ${name})`);
  const args =
    name === "deno"
      ? ["-c", "curl -fsSL https://deno.land/install.sh | sh"]
      : ["install", "-g", installSpec];
  const cmd = name === "deno" ? "sh" : "npm";
  const result = await spawn({
    cmd,
    args,
    env: filterEnvForUntrustedCode(),
    onStderr: (chunk) => process.stderr.write(chunk),
  });
  if (result.exitCode !== 0) return result.stderr || `failed to install ${name}`;
  if (name === "deno") {
    const denoPath = join(process.env.HOME || "", ".deno", "bin");
    process.env.PATH = `${denoPath}:${process.env.PATH}`;
  }
  log.info(`» installed ${name}`);
  return null;
}

/**
 * Put the project's package manager on PATH, by whichever route provisions it —
 * corepack for pnpm/yarn, `npm i -g` for bun, the install script for deno.
 * Returns an error string on failure, else null.
 *
 * Callers must gate this on shell being enabled; provisioning executes code.
 *
 * Idempotent by construction (`isCommandAvailable` short-circuits and
 * `ensurePackageManager` caches on a `--version` match), which is what lets
 * `main.ts` call it BEFORE the `setup` lifecycle hook and the prep phase call it
 * again later for the cost of one `which`. That ordering is the point: a `setup`
 * hook running `bun install` used to die with `bun: command not found` 0.8s
 * before Pullfrog installed bun itself, because the pre-hook site only ever
 * asked corepack — which ignores bun and deno entirely. See #1121.
 */
export async function provisionPackageManager(params: {
  name: ProvisionablePackageManager;
  declared: PackageManagerSpec | null;
  binDir: string;
}): Promise<string | null> {
  if (await isCommandAvailable(params.name)) {
    // already on PATH, but possibly the wrong version.
    if (params.declared) {
      await ensurePackageManager({ spec: params.declared, binDir: params.binDir });
    }
    return null;
  }
  if (params.declared) {
    const activated = await ensurePackageManager({ spec: params.declared, binDir: params.binDir });
    if (activated) return null;
  }
  const spec = params.declared ? `${params.declared.name}@${params.declared.version}` : params.name;
  return installFallback(params.name, spec);
}
