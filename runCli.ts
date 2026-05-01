import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
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

function createRuntimeContext(): RuntimeContext {
  const actionRoot = dirname(fileURLToPath(import.meta.url));
  const nodeBinDir = dirname(process.execPath);
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.npm_config_registry = NPM_REGISTRY;
  env.COREPACK_NPM_REGISTRY = NPM_REGISTRY;
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

function resolveNpxCommand(context: RuntimeContext): { command: string; prefixArgs: string[] } {
  // Prefer invoking npm's npx-cli.js directly via the current node executable. This avoids
  // ENOENT when the npx shim is not on PATH or alongside the node binary, and guarantees we
  // use the same node runtime that's executing this script.
  const npxCliCandidates = [
    // Unix: <prefix>/bin/node + <prefix>/lib/node_modules/npm/bin/npx-cli.js
    join(context.nodeBinDir, "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"),
    // Windows: <prefix>/node.exe + <prefix>/node_modules/npm/bin/npx-cli.js
    join(context.nodeBinDir, "node_modules", "npm", "bin", "npx-cli.js"),
  ];
  for (const candidate of npxCliCandidates) {
    if (existsSync(candidate)) {
      return { command: process.execPath, prefixArgs: [candidate] };
    }
  }

  // Fall back to the npx shim alongside node.
  const npxShim =
    process.platform === "win32"
      ? join(context.nodeBinDir, "npx.cmd")
      : join(context.nodeBinDir, "npx");
  return { command: npxShim, prefixArgs: [] };
}

function runNpx(context: RuntimeContext, packageSpec: string, cliArgs: string[]): void {
  const { command, prefixArgs } = resolveNpxCommand(context);
  // Run from actionRoot rather than GITHUB_WORKSPACE so that npm's devEngines check (which
  // reads cwd's package.json) doesn't reject the install when the workspace's package.json
  // pins a non-npm package manager. The pullfrog CLI itself reads GITHUB_WORKSPACE from env.
  execFileSync(command, [...prefixArgs, "--yes", packageSpec, ...cliArgs], {
    cwd: context.actionRoot,
    stdio: "inherit",
    env: context.env,
  });
}

function ensureActionDependencies(context: RuntimeContext): void {
  const nodeModulesPath = join(context.actionRoot, "node_modules");
  if (existsSync(nodeModulesPath)) {
    return;
  }

  const corepackPath =
    process.platform === "win32"
      ? join(context.nodeBinDir, "corepack.cmd")
      : join(context.nodeBinDir, "corepack");
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

  if (context.actionRef === "main" && context.actionRepository === "pullfrog/pullfrog") {
    runLocalCli(context, cliArgs);
    return;
  }

  runNpx(context, FALLBACK_PACKAGE_SPEC, cliArgs);
}

export function runPullfrogCli(params: RunPullfrogCliParams): void {
  const context = createRuntimeContext();

  if (params.swallowErrors) {
    try {
      runPullfrogCliInner(context, params.cliArgs);
    } catch {
      // best-effort cleanup
    }
    return;
  }

  runPullfrogCliInner(context, params.cliArgs);
}
