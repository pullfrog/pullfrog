import { existsSync } from "node:fs";
import { join } from "node:path";
import { detect } from "package-manager-detector";
import { resolveCommand } from "package-manager-detector/commands";
import { log } from "../utils/cli.ts";
import { provisionPackageManager, resolvePackageManagerSpec } from "../utils/packageManager.ts";
import { buildSandboxedCommand } from "../utils/sandbox.ts";
import { filterEnvForUntrustedCode } from "../utils/secrets.ts";
import { spawn } from "../utils/subprocess.ts";
import type { NodePackageManager, NodePrepResult, PrepDefinition, PrepOptions } from "./types.ts";

async function isCommandAvailable(command: string): Promise<boolean> {
  const result = await spawn({
    cmd: "which",
    args: [command],
    env: filterEnvForUntrustedCode(),
  });
  return result.exitCode === 0;
}

export const installNodeDependencies: PrepDefinition = {
  name: "installNodeDependencies",

  shouldRun: () => {
    const packageJsonPath = join(process.cwd(), "package.json");
    return existsSync(packageJsonPath);
  },

  run: async (options: PrepOptions): Promise<NodePrepResult> => {
    // prefer the project's declared spec (devEngines.packageManager wins over
    // packageManager). fall back to lockfile detection when nothing is declared.
    // restrict detect() to the lockfile strategy: `detected` here doubles as
    // the lockfile-presence gate below, and the default strategy set also
    // returns positives off `packageManager`/`devEngines` fields (which would
    // mask the very case we're trying to detect — declared manager but no
    // lockfile committed).
    const declared = await resolvePackageManagerSpec(process.cwd());
    const detected = await detect({ cwd: process.cwd(), strategies: ["lockfile"] });

    const packageManager: NodePackageManager =
      declared?.name ?? (detected?.name as NodePackageManager) ?? "npm";
    const agent = detected?.agent ?? packageManager;

    if (declared) {
      log.info(
        `» using ${packageManager}@${declared.version} from package.json (${declared.source})`
      );
    } else if (detected) {
      log.info(`» detected package manager: ${packageManager} (${agent})`);
    } else {
      log.info(`» no package manager declared, defaulting to npm`);
    }

    // provisioning: corepack for pnpm/yarn, legacy npm-install-g for bun/deno.
    // when shell is disabled we can't run installers (they execute code), so
    // we require the binary to already be on PATH.
    if (options.ignoreScripts) {
      if (!(await isCommandAvailable(packageManager))) {
        return {
          language: "node",
          packageManager,
          dependenciesInstalled: false,
          issues: [
            `${packageManager} is not available and cannot be installed when shell is disabled (would execute code)`,
          ],
        };
      }
    } else {
      // idempotent, and main.ts already ran this before the setup hook — so on
      // the common path this costs one `which`. see #1121.
      const installError = await provisionPackageManager({
        name: packageManager,
        declared,
        binDir: options.binDir,
      });
      if (installError) {
        return {
          language: "node",
          packageManager,
          dependenciesInstalled: false,
          issues: [installError],
        };
      }
    }

    // frozen-lockfile install only. eager prep is non-mutating by contract:
    // we run it before the agent starts and any artifact it leaves in the
    // tree (e.g. a generated `package-lock.json`) trips the dirty-tree
    // post-run gate and produces a spurious PR. `frozen` commands
    // (`npm ci`, `pnpm install --frozen-lockfile`, etc.) were assumed to
    // fail cleanly without a lockfile — that assumption is false for
    // pnpm 11.1.1 against a no-deps `package.json` (it silently writes an
    // empty `pnpm-lock.yaml` despite the flag). gate on `detect()` having
    // found a lockfile; it walks up the tree (so monorepo subpackages
    // resolve to the workspace-root lockfile) and recognizes every
    // manager's accepted lockfile variants (`bun.lockb` + `bun.lock`,
    // `npm-shrinkwrap.json` + `package-lock.json`, etc.). when none is
    // present, the project either has no installable dependencies or
    // opts into install via a `setup` lifecycle hook
    // (`action/utils/lifecycle.ts`); either way, eager prep should skip.
    if (!detected) {
      log.info(
        `» skipping ${packageManager} install: no lockfile found (would otherwise risk lockfile drift)`
      );
      return { language: "node", packageManager, dependenciesInstalled: false, issues: [] };
    }

    const resolved = resolveCommand(agent, "frozen", []);
    if (!resolved) {
      return {
        language: "node",
        packageManager,
        dependenciesInstalled: false,
        issues: [`no frozen-install command available for ${agent}`],
      };
    }

    // SECURITY: when shell is disabled, suppress lifecycle scripts to prevent
    // agents from injecting arbitrary code execution via package.json scripts
    if (options.ignoreScripts) {
      resolved.args.push("--ignore-scripts");
      log.info("» --ignore-scripts enabled (shell disabled)");
    }

    const fullCommand = `${resolved.command} ${resolved.args.join(" ")}`;
    log.info(`» running: ${fullCommand}`);
    // the installer executes arbitrary repo postinstall scripts, so run it inside
    // the PID+mount-namespace sandbox: those scripts land in a fresh PID namespace
    // (cannot read the action process's /proc/<pid>/environ) and see only the
    // already-filtered env. no namespace available → run directly (there is no
    // agent shell to plant malicious scripts in that case either).
    const env = filterEnvForUntrustedCode();
    const sandboxed = buildSandboxedCommand({
      cmd: resolved.command,
      args: resolved.args,
      env,
    });
    const result = await spawn(
      sandboxed
        ? { cmd: sandboxed.bin, args: sandboxed.args, env: sandboxed.env }
        : { cmd: resolved.command, args: resolved.args, env }
    );

    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    if (output) {
      log.startGroup(`${fullCommand} output`);
      log.info(output);
      log.endGroup();
    }

    if (result.exitCode !== 0) {
      const errorMessage = output || `exited with code ${result.exitCode}`;
      return {
        language: "node",
        packageManager,
        dependenciesInstalled: false,
        issues: [`\`${fullCommand}\` failed:\n${errorMessage}`],
      };
    }

    return {
      language: "node",
      packageManager,
      dependenciesInstalled: true,
      issues: [],
    };
  },
};
