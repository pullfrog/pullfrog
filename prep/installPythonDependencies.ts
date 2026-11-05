import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../utils/cli.ts";
import { buildSandboxedCommand } from "../utils/sandbox.ts";
import { filterEnvForUntrustedCode } from "../utils/secrets.ts";
import { spawn } from "../utils/subprocess.ts";
import type {
  PrepDefinition,
  PrepOptions,
  PythonPackageManager,
  PythonPrepResult,
} from "./types.ts";

interface PythonConfig {
  file: string;
  tool: PythonPackageManager;
  installCmd: string[];
  /** extra applicability check beyond file existence (defaults to always applies). */
  applies?: (path: string) => boolean;
}

/**
 * heuristic proxy for "this pyproject.toml is a distributable package."
 *
 * `[build-system]` is NOT a pip requirement — pip treats a pyproject without it
 * as the legacy `setuptools.build_meta:__legacy__` backend and proceeds. but
 * modern scaffolds (hatchling/flit/poetry-core/setuptools>=61) all emit
 * `[build-system]`, so its presence is a good signal. gating on it trades a rare
 * false-negative (a hand-written PEP 621 package that omits `[build-system]` is
 * skipped) to kill the common false-positive: a tooling-only pyproject (ruff/mypy,
 * PEP 735 dependency groups under uv) where `pip install .` triggers setuptools
 * flat-layout auto-discovery and hard-fails on a non-package repo like hey-api
 * (root holds web/, packages/, node_modules/).
 */
function declaresBuildSystem(path: string): boolean {
  return /^\s*\[\s*build-system\s*\]/m.test(readFileSync(path, "utf8"));
}

function configApplies(config: PythonConfig, cwd: string): boolean {
  const path = join(cwd, config.file);
  return existsSync(path) && (config.applies?.(path) ?? true);
}

// python dependency file patterns in priority order
const PYTHON_CONFIGS: PythonConfig[] = [
  {
    file: "requirements.txt",
    tool: "pip",
    installCmd: ["pip", "install", "-r", "requirements.txt"],
  },
  {
    file: "pyproject.toml",
    tool: "pip",
    installCmd: ["pip", "install", "."],
    applies: declaresBuildSystem,
  },
  {
    file: "Pipfile",
    tool: "pipenv",
    installCmd: ["pipenv", "install"],
  },
  {
    file: "Pipfile.lock",
    tool: "pipenv",
    installCmd: ["pipenv", "sync"],
  },
  {
    file: "poetry.lock",
    tool: "poetry",
    installCmd: ["poetry", "install", "--no-interaction"],
  },
  {
    file: "setup.py",
    tool: "pip",
    installCmd: ["pip", "install", "-e", "."],
  },
];

// tool install commands (via pip)
const TOOL_INSTALL_COMMANDS: Record<string, string[]> = {
  pipenv: ["pip", "install", "pipenv"],
  poetry: ["pip", "install", "poetry"],
};

async function isCommandAvailable(command: string): Promise<boolean> {
  const result = await spawn(
    buildSandboxedCommand({ cmd: "which", args: [command], env: filterEnvForUntrustedCode() })
  );
  return result.exitCode === 0;
}

async function installTool(name: string): Promise<string | null> {
  const installCmd = TOOL_INSTALL_COMMANDS[name];
  if (!installCmd) {
    // tool doesn't need installation (e.g., pip)
    return null;
  }

  log.info(`» installing ${name}...`);
  const [cmd, ...args] = installCmd;
  // sandbox tool provisioning too: a repo pip.conf can repoint the index at an
  // attacker sdist whose setup.py runs during `pip install poetry`.
  const result = await spawn({
    ...buildSandboxedCommand({ cmd, args, env: filterEnvForUntrustedCode() }),
    onStderr: (chunk) => process.stderr.write(chunk),
  });

  if (result.exitCode !== 0) {
    return result.stderr || `failed to install ${name}`;
  }

  log.info(`» installed ${name}`);
  return null;
}

export const installPythonDependencies: PrepDefinition = {
  name: "installPythonDependencies",

  shouldRun: async () => {
    // check if python is available
    const hasPython = (await isCommandAvailable("python3")) || (await isCommandAvailable("python"));
    if (!hasPython) {
      return false;
    }

    // check if any applicable python config file exists
    const cwd = process.cwd();
    return PYTHON_CONFIGS.some((config) => configApplies(config, cwd));
  },

  run: async (options: PrepOptions): Promise<PythonPrepResult> => {
    const cwd = process.cwd();

    // find the first applicable config
    const config = PYTHON_CONFIGS.find((c) => configApplies(c, cwd));
    if (!config) {
      return {
        language: "python",
        packageManager: "pip",
        configFile: "unknown",
        dependenciesInstalled: false,
        issues: ["no python config file found"],
      };
    }

    log.info(`» detected python config: ${config.file} (using ${config.tool})`);

    // SECURITY: when shell is disabled, skip ALL python dependency installation.
    // every python install path can potentially execute arbitrary code:
    //   - setup.py / pyproject.toml: directly execute build backends
    //   - requirements.txt: can contain "-e ." or local path references that
    //     trigger setup.py execution
    //   - Pipfile/poetry.lock: can contain path dependencies pointing to local
    //     directories with malicious setup.py
    //   - source distributions from PyPI also execute setup.py
    // there is no equivalent of npm's --ignore-scripts for pip.
    if (options.ignoreScripts) {
      log.info(
        `» skipping python install (shell disabled, python packages can execute arbitrary code)`
      );
      return {
        language: "python",
        packageManager: config.tool,
        configFile: config.file,
        dependenciesInstalled: false,
        issues: [
          `skipped: python dependency installation can execute arbitrary code (setup.py, build backends, local path references), which is blocked when shell is disabled`,
        ],
      };
    }

    // check if the tool is available, install if needed
    const isAvailable = await isCommandAvailable(config.tool);
    if (!isAvailable) {
      log.info(`» ${config.tool} not found, attempting to install...`);
      const installError = await installTool(config.tool);
      if (installError) {
        return {
          language: "python",
          packageManager: config.tool,
          configFile: config.file,
          dependenciesInstalled: false,
          issues: [installError],
        };
      }
    }

    // run the install command
    const [cmd, ...args] = config.installCmd;
    const fullCommand = `${cmd} ${args.join(" ")}`;
    log.info(`» running: ${fullCommand}`);
    // setup.py / build backends / local path deps execute arbitrary code, so run
    // the install in a fresh PID namespace (no action /proc to read) with filtered
    // env. python has no --ignore-scripts, so this is the only lever here.
    const result = await spawn(
      buildSandboxedCommand({ cmd, args, env: filterEnvForUntrustedCode() })
    );

    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    if (output) {
      log.startGroup(`${fullCommand} output`);
      log.info(output);
      log.endGroup();
    }

    if (result.exitCode !== 0) {
      return {
        language: "python",
        packageManager: config.tool,
        configFile: config.file,
        dependenciesInstalled: false,
        issues: [output || `${cmd} exited with code ${result.exitCode}`],
      };
    }

    return {
      language: "python",
      packageManager: config.tool,
      configFile: config.file,
      dependenciesInstalled: true,
      issues: [],
    };
  },
};
