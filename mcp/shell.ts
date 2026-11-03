// changes to shell security (filterEnv, spawnShell) should be reflected in wiki/security.md and docs/security.mdx
import { type ChildProcess, type StdioOptions, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { closeSync, existsSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type } from "arktype";
import { ensureBrowserDaemon } from "../utils/browser.ts";
import { log } from "../utils/log.ts";
import { formatPermissions, shellTokenPermissions } from "../utils/roleMirror.ts";
import {
  buildSandboxInvocation,
  detectSandboxMethod,
  getUsernsProbeError,
} from "../utils/sandbox.ts";
import { resolveEnv } from "../utils/secrets.ts";
import { DEFAULT_MAX_RETAINED_BYTES, TailBuffer } from "../utils/subprocess.ts";
import type { ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";

export const ShellParams = type({
  command: "string",
  // advisory and unread — no code path consumes it. kept in the schema only
  // because it nudges the model to state intent before running a command;
  // REQUIRING it cost a full rejected turn every time one was omitted. #1140.
  "description?": "string",
  "timeout?": type.number.describe(
    "Timeout in MILLISECONDS (not seconds). Default 30000 (30s), max 120000 (2m); timeout: 120 means 120ms. For longer commands use background: true."
  ),
  "working_directory?": "string",
  "background?": "boolean",
});

type SpawnParams = {
  command: string;
  env: Record<string, string | undefined>;
  cwd: string;
  stdio: StdioOptions;
  /** set no_new_privs on the command so setuid `sudo` cannot re-elevate to root
   * inside the namespace and unmount the protective mounts. false only for
   * `shell: enabled`, whose users are trusted and may need `sudo apt-get`. */
  seal: boolean;
};

/** Launch one command inside the mandatory PID+mount-namespace sandbox.
 *
 * The invocation (unshare / sudo-unshare / userns-unshare argv + env) is built by
 * `buildSandboxInvocation` in utils/sandbox.ts, shared with the sync MCP git path
 * so both carry one copy of the security-critical wrapper. The shell profile keeps
 * the `.git` read-only bind (gitWritable: false). */
function spawnShell(params: SpawnParams): ChildProcess {
  const spawnOpts = { cwd: params.cwd, stdio: params.stdio, detached: true };
  const sandboxMethod = detectSandboxMethod();
  const ci = process.env.CI === "true";

  if (ci && sandboxMethod === "none") {
    const usernsProbeError = getUsernsProbeError();
    throw new Error(
      "PID-namespace isolation is required in CI but unavailable: unprivileged unshare, sudo unshare, " +
        "and userns-nested unshare all failed. " +
        (usernsProbeError ? `userns probe said: ${usernsProbeError}. ` : "") +
        "on a containerized / Kubernetes self-hosted runner the cause is usually one of: the pod's " +
        "seccomp profile blocks user-namespace creation (Pod Security Standards baseline/restricted); " +
        "the pod runs as root without CAP_SETFCAP, which the kernel requires to map uid 0; or the node " +
        "kernel disallows unprivileged user namespaces (Ubuntu >= 23.10, Bottlerocket, Talos). " +
        "elsewhere, check that `unshare` and `setpriv` (util-linux >= 2.31, which is what " +
        "added --ambient-caps) are on PATH. " +
        "see https://docs.pullfrog.com/security#self-hosted-runners"
    );
  }

  if (sandboxMethod === "none") {
    return spawn("bash", ["-c", params.command], { ...spawnOpts, env: params.env });
  }

  const invocation = buildSandboxInvocation({
    command: params.command,
    seal: params.seal,
    env: params.env,
    method: sandboxMethod,
    gitWritable: false,
  });
  return spawn(invocation.bin, invocation.args, { ...spawnOpts, env: invocation.env });
}

/** kill process and its entire process group */
async function killProcessGroup(proc: ChildProcess): Promise<void> {
  if (!proc.pid) return;
  try {
    process.kill(-proc.pid, "SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }
}

function getTempDir(): string {
  const tempDir = process.env.PULLFROG_TEMP_DIR;
  if (!tempDir) {
    throw new Error("PULLFROG_TEMP_DIR not set");
  }
  return tempDir;
}

/** chars of shell output kept inline in the agent reply. anything past this
 * blows the agent's context budget on commands that dump big logs (test
 * runners, build tools, grep on large trees), so the overflow is spilled
 * to a tempfile the agent can re-read selectively (cat/tail/grep). */
export const MAX_OUTPUT_CHARS = 5000;

const SHELL_MAX_TIMEOUT_MS = 120_000;

/**
 * Added to a sandboxed tool's fastmcp `timeoutMs`. That timeout is a `Promise.race`
 * (see `CHECKOUT_DEADLINE_MS`): tied with our own command timeout it wins by a few ms
 * and the agent gets fastmcp's generic error instead of the captured output (#1489).
 */
export const SANDBOX_RESPONSE_HEADROOM_MS = 10_000;

/** if `output` exceeds `MAX_OUTPUT_CHARS`, persist the full body to a
 * tempfile and return the last `MAX_OUTPUT_CHARS` prefixed with a sentinel
 * pointing at the saved path. otherwise return as-is. */
/**
 * Run one command inside the mandatory shell sandbox and collect its output.
 *
 * Shared by `shell` and `gh` so that agent-initiated process execution carries
 * the same mount- and PID-namespace guarantees no matter which tool starts it.
 * A bare `spawnSync` here would escape `PROC_CLEANUP`, `SOCKET_CLEANUP` and
 * `buildFsMounts` — i.e. the tmpfs over `/var/lib/pullfrog` (codex `auth.json`),
 * the tmpfs over `$RUNNER_TEMP/_runner_file_commands`, and the `.git` ro-bind —
 * none of which any token's scope bounds.
 */
export async function runSandboxed(params: {
  command: string;
  env: Record<string, string | undefined>;
  cwd: string;
  timeout: number;
  seal: boolean;
  /** live-stream chunks as they arrive, on top of the buffered `output`.
   * lifecycle hooks use this to keep a long `pnpm test` visible in the
   * workflow log instead of silent until it exits. */
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}): Promise<{ output: string; exitCode: number; timedOut: boolean }> {
  const proc = spawnShell({
    command: params.command,
    env: params.env,
    cwd: params.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    seal: params.seal,
  });

  // bounded: agent-chosen output accumulates in OUR process, and a `data`
  // handler sits outside `execute()`'s try/catch — so an unbounded string
  // killed the whole run past V8's limit (pullfrog/pullfrog#91).
  const stdout = new TailBuffer(DEFAULT_MAX_RETAINED_BYTES);
  const stderr = new TailBuffer(DEFAULT_MAX_RETAINED_BYTES);
  let timedOut = false,
    exited = false,
    spawnError = "";
  proc.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stdout.append(text);
    params.onStdout?.(text);
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stderr.append(text);
    params.onStderr?.(text);
  });

  const timeoutId = setTimeout(async () => {
    if (!exited) {
      timedOut = true;
      await killProcessGroup(proc);
    }
  }, params.timeout);

  const exitCode = await new Promise<number | null>((resolve) => {
    const done = (code: number | null) => {
      exited = true;
      clearTimeout(timeoutId);
      resolve(code);
    };
    proc.on("exit", done);
    // surface the spawn failure itself — without it an absent binary (ENOENT on
    // a self-hosted runner without `gh`) is indistinguishable from a timeout.
    proc.on("error", (err: Error) => {
      spawnError = err.message;
      done(null);
    });
  });

  // `exit` fires when the direct `bash -c` child dies, but the stdout/stderr
  // pipes stay open as long as any self-daemonized descendant still holds the
  // inherited write end — and our `data` listeners keep those read streams
  // referenced, so the event loop never drains and the action hangs after
  // `Task complete.` (measured: up to 5.3h of billed runner time). dropping
  // our own read ends releases the handles without killing a descendant the
  // user deliberately backgrounded. see #1087.
  proc.stdout?.destroy();
  proc.stderr?.destroy();

  const outText = stdout.toString();
  const errText = stderr.toString();
  let output = errText ? (outText ? `${outText}\n${errText}` : errText) : outText;
  if (spawnError) output = output ? `${output}\n${spawnError}` : spawnError;
  if (timedOut)
    output = output
      ? `${output}\n[timed out after ${params.timeout}ms]`
      : `[timed out after ${params.timeout}ms]`;

  return {
    output: output.trim(),
    exitCode: exitCode ?? (timedOut ? 124 : -1),
    timedOut,
  };
}

export function capOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  const fullPath = join(getTempDir(), `shell-${randomUUID().slice(0, 8)}.log`);
  writeFileSync(fullPath, output);
  const elided = output.length - MAX_OUTPUT_CHARS;
  return `... [${elided} chars truncated; output saved to ${fullPath}] ...\n${output.slice(-MAX_OUTPUT_CHARS)}`;
}

function shellEnv(ctx: ToolContext) {
  // copied: under `enabled` resolveEnv hands back process.env itself
  const env = { ...resolveEnv(ctx.payload.shell === "enabled" ? "inherit" : "restricted") };
  // a GitHub token the repo allowlisted into the shell stays the one `gh` uses
  if (ctx.shellToken && !env.GH_TOKEN && !env.GITHUB_TOKEN) env.GH_TOKEN = ctx.shellToken;
  return env;
}

/** spelled out so the agent never has to probe what `gh` can do */
function describeGh(ctx: ToolContext): string {
  if (!ctx.shellToken || shellEnv(ctx).GH_TOKEN !== ctx.shellToken) return "";
  return ` \`gh\` is authenticated for ${ctx.repo.owner}/${ctx.repo.name} with a token limited to ${formatPermissions(shellTokenPermissions)}.`;
}

export function ShellTool(ctx: ToolContext) {
  return tool({
    name: "shell",
    timeoutMs: SHELL_MAX_TIMEOUT_MS + SANDBOX_RESPONSE_HEADROOM_MS,
    description: `Execute shell commands securely.${ctx.payload.shell === "restricted" ? " Environment is filtered to remove API keys and secrets." : ""}

Example: \`shell({ command: "pnpm test", description: "run the test suite" })\`.

Use this tool to:
- Run shell commands (ls, cat, grep, find, etc.)
- Execute build tools (npm, pnpm, cargo, make, etc.)
- Run tests and linters

Output is capped at ${MAX_OUTPUT_CHARS} chars: if exceeded, only the tail is returned and the captured output is saved to a tempfile (path included in the response). Re-read the tempfile with cat/tail/grep when you need more.

\`git\` works here, but \`.git\` is mounted read-only.${describeGh(ctx)}`,
    parameters: ShellParams,
    execute: execute(async (params) => {
      const timeout = Math.min(params.timeout ?? 30000, SHELL_MAX_TIMEOUT_MS);
      const cwd = params.working_directory ?? process.cwd();
      // checked here, not left to spawn: its ENOENT names the sandbox binary, not the directory.
      if (!existsSync(cwd)) throw new Error(`working_directory does not exist: ${cwd}`);
      const env = shellEnv(ctx);
      const seal = ctx.payload.shell !== "enabled";

      if (params.command.includes("agent-browser")) {
        const daemonError = ensureBrowserDaemon(ctx.toolState);
        if (daemonError) {
          return {
            output: `browser daemon unavailable: ${daemonError}`,
            exit_code: 1,
            timed_out: false,
          };
        }
        const binDir = ctx.toolState.browserDaemon?.binDir;
        if (binDir) {
          env.PATH = `${binDir}:${env.PATH ?? ""}`;
        }
      }

      if (params.background) {
        const tempDir = getTempDir();
        const handle = `bg-${randomUUID().slice(0, 8)}`;
        const outputPath = join(tempDir, `${handle}.log`);
        const pidPath = join(tempDir, `${handle}.pid`);
        const logFd = openSync(outputPath, "a");
        let proc: ChildProcess;
        try {
          proc = spawnShell({
            command: params.command,
            env,
            cwd,
            stdio: ["ignore", logFd, logFd],
            seal,
          });
        } finally {
          closeSync(logFd);
        }
        if (!proc.pid) {
          // a spawn failure arrives as a later `error` event, which crashes the action unless handled.
          const [error] = await once(proc, "error");
          throw new Error(`failed to start background process: ${error.message}`);
        }
        proc.unref();
        writeFileSync(pidPath, `${proc.pid}\n`);
        ctx.toolState.backgroundProcesses.set(handle, { pid: proc.pid, outputPath, pidPath });
        return {
          handle,
          outputPath,
          pidPath,
          message: `started background process ${handle} (pid ${proc.pid})`,
        };
      }

      const result = await runSandboxed({ command: params.command, env, cwd, timeout, seal });

      if (result.exitCode !== 0) {
        log.info(`shell command failed with exit code ${result.exitCode}: ${params.command}`);
        if (result.output) log.info(`output: ${result.output}`);
      }

      return {
        output: capOutput(result.output),
        exit_code: result.exitCode,
        timed_out: result.timedOut,
      };
    }),
  });
}

export const KillBackgroundParams = type({
  handle: type.string.describe("The handle of the background process to kill (e.g., bg-a1b2c3d4)"),
});

export function KillBackgroundTool(ctx: ToolContext) {
  return tool({
    name: "kill_background",
    mutates: true,
    description: `Kill a background process by its handle. Use this to stop dev servers or other long-running processes started with shell({ background: true }).`,
    parameters: KillBackgroundParams,
    execute: execute(async (params) => {
      const proc = ctx.toolState.backgroundProcesses.get(params.handle);
      if (!proc) {
        return {
          success: false,
          message: `no background process with handle ${params.handle}`,
        };
      }

      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch {
        // already dead
      }
      await sleep(200);
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        // already dead
      }

      ctx.toolState.backgroundProcesses.delete(params.handle);
      return {
        success: true,
        message: `killed background process ${params.handle} (pid ${proc.pid})`,
      };
    }),
  });
}
