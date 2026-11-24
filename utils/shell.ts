import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { confineGit } from "./pathSandbox.ts";
import { buildSandboxedCommand, getSandboxMethod, spawnGitSandboxedSync } from "./sandbox.ts";
import { type EnvMode, resolveEnv } from "./secrets.ts";
import { SpawnTimeoutError, spawn } from "./subprocess.ts";

interface ShellOptions {
  cwd?: string;
  encoding?:
    | "utf-8"
    | "utf8"
    | "ascii"
    | "base64"
    | "base64url"
    | "hex"
    | "latin1"
    | "ucs-2"
    | "ucs2"
    | "utf16le";
  log?: boolean;
  /**
   * env mode: "restricted" (default) filters secrets, "inherit" passes full env,
   * or provide a custom env object (merged with restricted base)
   */
  env?: EnvMode;
  onError?: (result: { status: number; stdout: string; stderr: string }) => void;
}

/**
 * Node's `spawnSync` default is 1MB, and hitting it is silent: the child is
 * SIGTERM'd, `status` comes back `null`, and the truncated buffer looks like
 * ordinary output. A large `git diff` therefore surfaced as a bogus
 * "exit code -1" whose detail was ~1MB of raw diff, which then went straight
 * into the model's context. 32MB is past any git output we expect, so the
 * common case now SUCCEEDS and flows through `spillGitOutput`'s file-backed
 * truncation instead of the failure path. see #1113.
 */
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/**
 * Hard cap on the error detail handed back to a caller (and, through
 * `handleToolError`, to the model). Comfortably above a real git diagnostic,
 * far below anything that would blow a context window.
 */
export const MAX_ERROR_DETAIL_CHARS = 20_000;

/**
 * Execute a shell command safely using spawnSync with argument arrays.
 * Prevents shell injection by avoiding string interpolation in shell commands.
 *
 * SECURITY: by default, env vars are filtered to remove secrets (tokens, keys, passwords).
 * this prevents malicious code (git hooks, npm scripts, etc.) from exfiltrating credentials.
 * use env: "inherit" only when absolutely necessary.
 *
 * @param cmd - The command to execute
 * @param args - Array of arguments to pass to the command
 * @param options - Optional configuration (cwd, encoding, onError)
 * @returns The trimmed stdout output
 * @throws Error if command fails and no onError handler is provided
 */
export function $(cmd: string, args: string[], options?: ShellOptions): string {
  const encoding = options?.encoding ?? "utf-8";
  const env = resolveEnv(options?.env);

  // route git through the PID+mount-namespace sandbox: a repo-planted hook /
  // filter / config (core.fsmonitor, core.hooksPath, filter.*.clean, diff.external)
  // that fires on the MCP server's own git call then runs in a FRESH PID namespace —
  // it cannot read the action process's /proc/<pid>/environ (OIDC mint ticket, job
  // token, customer `env:` secrets) and sees only the already-filtered env. a runner
  // with no namespace still has the MCP git tool, which can plant that config itself
  // (`git checkout-index --prefix=.git/`), so its git runs in the path sandbox
  // (action/utils/pathSandbox.ts) instead; main.ts refuses a CI runner with neither.
  // non-git commands keep the plain path. $git() (authenticated fetch/push) does not
  // go through here — see action/utils/gitAuth.ts.
  //
  // CRITICAL: use "ignore" for stdin instead of "inherit" to avoid breaking MCP transport
  // when running inside an MCP server, stdin is used for JSON-RPC protocol
  const sandboxMethod = getSandboxMethod();
  const isGit = basename(cmd) === "git";
  const confined = isGit && sandboxMethod === "none" ? confineGit({ args, env }) : undefined;
  const direct = confined ?? { cmd, args, env };
  const result =
    isGit && sandboxMethod !== "none"
      ? spawnGitSandboxedSync({
          cmd,
          args,
          env,
          cwd: options?.cwd,
          encoding,
          maxBuffer: MAX_BUFFER_BYTES,
          method: sandboxMethod,
        })
      : spawnSync(direct.cmd, direct.args, {
          stdio: ["ignore", "pipe", "pipe"],
          encoding,
          cwd: options?.cwd,
          env: direct.env,
          maxBuffer: MAX_BUFFER_BYTES,
        });

  return settle({ cmd, args, options, result });
}

/**
 * git off the event loop, for the commands the agent picks: one slow `git grep` held the
 * MCP server, every parallel tool call and the activity watchdog for 16 minutes (#1745).
 * same sandbox as `$`, and the command is killed at `timeoutMs`.
 */
export async function gitAsync(
  args: string[],
  options: ShellOptions & { cwd: string; timeoutMs: number }
): Promise<string> {
  const env = resolveEnv(options.env);
  const launch =
    getSandboxMethod() === "none"
      ? (confineGit({ args, env }) ?? { cmd: "git", args, env })
      : buildSandboxedCommand({ cmd: "git", args, env, deadlineMs: options.timeoutMs });
  // `maxBuffer`'s contract: past the cap, stop collecting and kill git. under sudo-unshare the
  // kill stops at `sudo`, so the sandbox's own `timeout` is what ends git there.
  const overflow = Object.assign(new Error("output over MAX_BUFFER_BYTES"), { code: "ENOBUFS" });
  const controller = new AbortController();
  const stdout: string[] = [];
  const stderr: string[] = [];
  let collected = 0;
  const collect = (chunks: string[]) => (chunk: string) => {
    if (controller.signal.aborted) return;
    collected += chunk.length;
    if (collected > MAX_BUFFER_BYTES) {
      controller.abort(overflow);
      return;
    }
    chunks.push(chunk);
  };
  const result = await spawn({
    cmd: launch.cmd,
    args: launch.args,
    env: launch.env,
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeoutMs,
    activityTimeout: 0,
    killGroup: true,
    retain: "none",
    signal: controller.signal,
    onStdout: collect(stdout),
    onStderr: collect(stderr),
  }).catch((error: unknown) => {
    if (error === overflow) return undefined;
    if (!(error instanceof SpawnTimeoutError)) throw error;
    throw new Error(
      `git ${args[0] ?? ""} did not finish in ${options.timeoutMs / 1000}s and was killed`
    );
  });
  if (!result)
    return settle({ cmd: "git", args, options, result: { status: null, error: overflow } });
  return settle({
    cmd: "git",
    args,
    options,
    // with `retain: "none"`, spawn's own stderr holds only its kill or launch-failure note
    result: {
      status: result.exitCode,
      stdout: stdout.join(""),
      stderr: stderr.join("") + result.stderr,
    },
  });
}

/** logs a finished command's output and turns a failure into `onError` or a thrown error. */
function settle(params: {
  cmd: string;
  args: string[];
  options: ShellOptions | undefined;
  result: { status: number | null; stdout?: string; stderr?: string; error?: Error };
}): string {
  const cmd = params.cmd;
  const args = params.args;
  const options = params.options;
  const result = params.result;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";

  // Write output to process streams so it behaves like stdio: "inherit"
  // CRITICAL: when running inside an MCP server, stdout is used for JSON-RPC protocol
  // so we must write to stderr instead to avoid corrupting the protocol
  // Only log if log option is not explicitly set to false
  if (options?.log !== false) {
    // if stdout is a TTY, it's safe to write to it; otherwise it's likely a pipe used for JSON-RPC
    const canWriteToStdout = process.stdout.isTTY === true;
    if (stdout) {
      if (canWriteToStdout) {
        process.stdout.write(stdout);
      } else {
        // stdout is a pipe (MCP context) - write to stderr instead
        process.stderr.write(stdout);
      }
    }
    if (stderr) {
      process.stderr.write(stderr);
    }
  }

  // Handle errors
  if (result.status !== 0) {
    // ENOBUFS means the child was killed for exceeding MAX_BUFFER_BYTES, so
    // `status` is null and there is no exit code to report. say what actually
    // happened rather than inventing "exit code -1" and pasting the truncated
    // buffer as if it were a diagnostic.
    if (result.error && "code" in result.error && result.error.code === "ENOBUFS") {
      throw new Error(
        `Command produced more than ${MAX_BUFFER_BYTES / 1024 / 1024}MB of output and was terminated: ${cmd} ${args.join(" ")}`
      );
    }

    const errorResult = {
      status: result.status ?? -1,
      stdout,
      stderr,
    };

    if (options?.onError) {
      options.onError(errorResult);
      return stdout.trim();
    }

    // many git subcommands write context-bearing diagnostics to stdout, not
    // stderr (merge conflicts, cherry-pick rejections, diff --exit-code,
    // ls-files --error-unmatch). Falling back to "Unknown error" robbed the
    // agent of any signal and forced an extra MCP round-trip. see #766.
    // capped because this string reaches the model verbatim via handleToolError.
    // a spawn that never started (ENOENT) has no output, only `result.error`.
    const detail = [stderr, stdout, result.error?.message ?? ""]
      .map((s) => s.trim())
      .filter(Boolean)
      .join("\n")
      .slice(0, MAX_ERROR_DETAIL_CHARS);
    throw new Error(
      `Command failed with exit code ${errorResult.status}: ${detail || "Unknown error"}`
    );
  }

  return stdout.trim();
}
