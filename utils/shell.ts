import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { getSandboxMethod, spawnGitSandboxedSync } from "./sandbox.ts";
import { type EnvMode, resolveEnv } from "./secrets.ts";

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
  // token, customer `env:` secrets) and sees only the already-filtered env. where no
  // namespace is available (local dev, CI=false, a runner without unshare) there is
  // no shell for the agent to plant such config either, so fall back to a plain spawn.
  // non-git commands keep the plain path. $git() (authenticated fetch/push) does not
  // go through here — see action/utils/gitAuth.ts.
  //
  // CRITICAL: use "ignore" for stdin instead of "inherit" to avoid breaking MCP transport
  // when running inside an MCP server, stdin is used for JSON-RPC protocol
  const sandboxMethod = getSandboxMethod();
  const result =
    basename(cmd) === "git" && sandboxMethod !== "none"
      ? spawnGitSandboxedSync({
          cmd,
          args,
          env,
          cwd: options?.cwd,
          encoding,
          maxBuffer: MAX_BUFFER_BYTES,
          method: sandboxMethod,
        })
      : spawnSync(cmd, args, {
          stdio: ["ignore", "pipe", "pipe"],
          encoding,
          cwd: options?.cwd,
          env,
          maxBuffer: MAX_BUFFER_BYTES,
        });

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
    const detail = [stderr, stdout]
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
