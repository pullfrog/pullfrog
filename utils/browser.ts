import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { ToolState } from "../toolState.ts";
import { log } from "./cli.ts";
import { resolveNpm } from "./install.ts";
import { filterEnv } from "./secrets.ts";
import { getDevDependencyVersion } from "./version.ts";

// agent-browser already discovers chrome via `which` and the playwright cache as fallbacks,
// so this list only needs to cover the GHA ubuntu-latest runner where we know the exact path.
const CHROME_PATHS = ["/usr/bin/google-chrome-stable"];

let systemChromePath: string | undefined;

function findSystemChromePath(): string | undefined {
  if (typeof systemChromePath === "string") {
    // return cached result but normalize to undefined if empty
    return systemChromePath || undefined;
  }
  for (const p of CHROME_PATHS) {
    if (existsSync(p)) {
      systemChromePath = p;
      log.info(`found system chrome: ${p}`);
      return p;
    }
  }
  // set to an empty string to indicate no system chrome found
  // and to avoid repeated lookups
  systemChromePath = "";
  log.info(`no system chrome found (checked: ${CHROME_PATHS.join(", ")})`);
}

function buildEnv(): Record<string, string> {
  const env: Record<string, string> = { ...filterEnv() };
  const chromePath = findSystemChromePath();
  if (chromePath) {
    env.AGENT_BROWSER_EXECUTABLE_PATH = chromePath;
  }
  return env;
}

/**
 * ensure the agent-browser daemon is running by issuing a real command.
 *
 * agent-browser is stateful — it manages a persistent browser process via a
 * daemon that communicates over a Unix socket. we start the daemon here,
 * outside of ShellTool, because ShellTool's child process lifecycle would
 * kill it between invocations and the daemon must survive across calls.
 *
 * despite ShellTool commands running inside unshare-sandboxed namespaces,
 * they can still reach this daemon because the Unix socket is discoverable
 * regardless of unshare's PID/mount isolation. starting the daemon in the
 * host namespace keeps it alive while sandboxed shells come and go.
 *
 * agent-browser auto-starts its daemon on the first CLI invocation and
 * keeps it alive via the socket for subsequent commands.
 * we run `open about:blank` as the seed command to trigger this.
 * idempotent — only runs once.
 */
export function ensureBrowserDaemon(toolState: ToolState): string | undefined {
  if (toolState.browserDaemon) {
    return toolState.browserDaemon.error;
  }

  const agentBrowserVersion = getDevDependencyVersion("agent-browser");
  log.info(`installing agent-browser@${agentBrowserVersion}...`);
  const npm = resolveNpm();
  const install = spawnSync(
    npm.command,
    [...npm.args, "install", "-g", `agent-browser@${agentBrowserVersion}`],
    { stdio: "pipe", encoding: "utf-8" }
  );
  if (install.status !== 0) {
    const error = `agent-browser install failed: ${(install.stderr || install.stdout || "unknown error").trim()}`;
    log.error(error);
    toolState.browserDaemon = { error };
    return error;
  }
  log.info("agent-browser installed");

  let binDir: string;
  try {
    const binPath = execFileSync("which", ["agent-browser"], { encoding: "utf-8" }).trim();
    binDir = dirname(binPath);
    log.info(`agent-browser binary: ${binPath}`);
  } catch {
    const error = "agent-browser binary not found in PATH after install";
    log.error(error);
    toolState.browserDaemon = { error };
    return error;
  }

  const env = buildEnv();

  // `open about:blank` triggers daemon auto-start and returns once the daemon + browser are ready
  log.info("starting browser daemon...");
  const seed = spawnSync("agent-browser", ["open", "about:blank"], {
    env,
    stdio: "pipe",
    encoding: "utf-8",
    timeout: 30_000,
  });

  if (seed.status !== 0) {
    const output = (seed.stderr || seed.stdout || "unknown error").trim();
    const error = `agent-browser open about:blank failed (exit=${seed.status}): ${output}`;
    log.error(error);
    toolState.browserDaemon = { error };
    return error;
  }
  log.debug(`seed command done (exit=0): ${(seed.stdout || "").trim()}`);

  toolState.browserDaemon = { binDir };
  log.info("browser daemon ready");
}

export function closeBrowserDaemon(toolState: ToolState): void {
  if (!toolState.browserDaemon?.binDir) {
    delete toolState.browserDaemon;
    return;
  }
  delete toolState.browserDaemon;

  try {
    log.info("closing browser daemon...");
    spawnSync("agent-browser", ["close"], {
      env: filterEnv(),
      stdio: "pipe",
      timeout: 10_000,
    });
    log.info("browser daemon closed");
  } catch {
    // best-effort
  }
}
