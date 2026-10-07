import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { DEFAULT_ACTIVITY_CHECK_INTERVAL_MS, DEFAULT_ACTIVITY_TIMEOUT_MS } from "./activity.ts";
import { log } from "./cli.ts";
import { onExitSignal } from "./exitHandler.ts";

export type TrackChildOptions = {
  child: ChildProcess;
  // if true, kill the entire process group (requires detached spawn)
  killGroup?: boolean;
};

// sentinel codes for timeout rejections — callers (e.g. lifecycle.ts) use
// these to distinguish timeouts from other errors without string-matching
// on the error message, which is fragile to rewording.
export const SPAWN_TIMEOUT_CODE = "E_SPAWN_TIMEOUT";
export const SPAWN_ACTIVITY_TIMEOUT_CODE = "E_SPAWN_ACTIVITY_TIMEOUT";

export class SpawnTimeoutError extends Error {
  readonly code: typeof SPAWN_TIMEOUT_CODE | typeof SPAWN_ACTIVITY_TIMEOUT_CODE;
  constructor(
    message: string,
    code: typeof SPAWN_TIMEOUT_CODE | typeof SPAWN_ACTIVITY_TIMEOUT_CODE
  ) {
    super(message);
    this.name = "SpawnTimeoutError";
    this.code = code;
  }
}

// track all spawned child processes for cleanup on Ctrl+C
const activeChildren = new Map<ChildProcess, boolean>();

// signal handler override (used by test runner for graceful shutdown)
export type SignalHandler = (signal: NodeJS.Signals) => void;
let externalSignalHandler: SignalHandler | null = null;

// track a child process for cleanup on Ctrl+C
export function trackChild(options: TrackChildOptions): void {
  // the signal handler cleans up all tracked children
  // so we only have to install it once some child gets tracked
  installSignalHandler();
  activeChildren.set(options.child, options.killGroup ?? false);
}

// untrack a child process
export function untrackChild(child: ChildProcess): void {
  activeChildren.delete(child);
}

// whether a child is still ours to reap: false once untracked or killed by `killTrackedChildren`
export function isTrackedChild(child: ChildProcess): boolean {
  return activeChildren.has(child);
}

// allow callers to override default signal handling
export function setSignalHandler(handler: SignalHandler | null): void {
  externalSignalHandler = handler;
}

// kill all tracked children without exiting
export function killTrackedChildren() {
  for (const entry of activeChildren) {
    const child = entry[0];
    const killGroup = entry[1];
    if (killGroup && child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
        continue;
      } catch {
        // fall through to direct kill
      }
    }
    child.kill("SIGKILL");
  }
  activeChildren.clear();
}

// install signal handlers once (call early in process lifecycle)
let handlersInstalled = false;
function installSignalHandler(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  onExitSignal((signal) => {
    if (externalSignalHandler) {
      externalSignalHandler(signal);
      return;
    }
    const count = activeChildren.size;
    if (count > 0) {
      log.info(`» received ${signal}, killing ${count} subprocess(es)...`);
    }
    killTrackedChildren();
  });
}

/**
 * Controls what the wrapper retains in memory across the child's lifetime
 * for the post-hoc `SpawnResult.stdout` / `SpawnResult.stderr` snapshots.
 *
 * Streaming callbacks (`onStdout` / `onStderr`) fire regardless — `retain`
 * only governs the buffered snapshot returned in `SpawnResult`.
 *
 * - `"tail"` (default): keep the last `maxRetainedBytes` UTF-16 code units
 *   of each stream. Once the cap is exceeded, oldest bytes are sliced off
 *   and the result is prefixed with a `... [N MiB truncated] ...` sentinel.
 *   Right default for short-lived commands whose failure mode is in their
 *   final output (git errors, install failures, hook scripts).
 * - `"none"`: skip the buffer entirely. `SpawnResult.stdout` / `.stderr`
 *   are empty strings. Use this for long-lived streaming agents that already
 *   drain via `onStdout` / `onStderr` and never read the buffered snapshot.
 *
 * Default cap is 8 MiB — well below V8's ~1 GiB `kMaxLength` so `+= chunk`
 * can never throw `RangeError: Invalid string length`.
 */
export type RetainMode = "tail" | "none";

export const DEFAULT_MAX_RETAINED_BYTES = 8 * 1024 * 1024;

export interface SpawnOptions {
  cmd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeout?: number;
  // activity timeout: kill process if no stdout for this many ms (default:
  // DEFAULT_ACTIVITY_TIMEOUT_MS, 0 to disable). only stdout resets the timer —
  // stderr (e.g. provider error retries) does not count as progress.
  activityTimeout?: number;
  // fired synchronously when the activity timeout kills the process. used by
  // callers (main.ts) to tear down shared resources like the MCP HTTP server
  // so that lingering SSE reconnects don't keep the outer activity timer
  // alive after the subprocess is already dead.
  onActivityTimeout?: (() => void) | undefined;
  cwd?: string;
  stdio?: ("pipe" | "ignore" | "inherit")[];
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  // when true, spawn the child detached (its own process group) and route all
  // kill paths (timeout, activity timeout, ctrl-c) through `process.kill(-pid, ...)`
  // so signals reach grandchildren too. critical for binaries that fork through
  // a shim (e.g. node_modules/opencode-ai/bin/opencode is a Node shim that
  // spawnSync's the native binary; without killGroup, SIGKILL only hits the
  // shim and the native binary is reparented to PID 1, holds our stdout pipe
  // open, keeps emitting NDJSON, and `child.on("close")` never fires —
  // producing zombie runs that hang until the GitHub Actions job timeout).
  killGroup?: boolean;
  retain?: RetainMode;
  maxRetainedBytes?: number;
  // abort terminates the child like `timeout` does, then rejects with `signal.reason` once it exits
  signal?: AbortSignal | undefined;
}

/**
 * Bounded string accumulator that keeps the tail of appended chunks.
 * Once the cap is exceeded, oldest bytes are sliced off and `toString()`
 * prefixes the survivors with a sentinel describing the elided byte count.
 *
 * Exported because long-lived agent runtimes (opencode, claude) also
 * accumulate per-run narration strings independently of the spawn wrapper
 * and need the same protection against V8's `kMaxLength`.
 */
export class TailBuffer {
  // explicit field declarations rather than constructor parameter properties:
  // node's strip-only TS loader (used by action/test/run.ts in CI) rejects
  // `constructor(private readonly cap: number)` with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX.
  private readonly cap: number;
  private buffer = "";
  private truncatedBytes = 0;

  constructor(cap: number) {
    this.cap = cap;
  }

  append(chunk: string): void {
    if (this.cap <= 0) return;
    this.buffer += chunk;
    if (this.buffer.length > this.cap) {
      const drop = this.buffer.length - this.cap;
      this.truncatedBytes += drop;
      this.buffer = this.buffer.slice(drop);
    }
  }

  toString(): string {
    if (this.truncatedBytes === 0) return this.buffer;
    const mib = (this.truncatedBytes / 1024 / 1024).toFixed(1);
    return `... [${mib} MiB truncated by retain:tail cap] ...\n${this.buffer}`;
  }
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

/**
 * Spawn a subprocess with streaming callbacks and buffered results
 */
export async function spawn(options: SpawnOptions): Promise<SpawnResult> {
  const activityTimeoutMs = options.activityTimeout ?? DEFAULT_ACTIVITY_TIMEOUT_MS;

  options.signal?.throwIfAborted();
  installSignalHandler();

  const startTime = performance.now();
  // capped accumulators — unbounded `+= chunk` previously crashed the wrapper
  // with `RangeError: Invalid string length` once V8's ~1 GiB kMaxLength was
  // breached on long-lived agent subprocesses (e.g. multi-lens opencode
  // Reviews on large monorepos). retain:"none" skips the buffer entirely
  // for callers that already drain via onStdout/onStderr.
  const retain: RetainMode = options.retain ?? "tail";
  const cap = options.maxRetainedBytes ?? DEFAULT_MAX_RETAINED_BYTES;
  const stdoutBuffer = retain === "none" ? null : new TailBuffer(cap);
  const stderrBuffer = retain === "none" ? null : new TailBuffer(cap);

  const killGroup = options.killGroup ?? false;

  return new Promise((resolve, reject) => {
    // security: caller must provide complete env object, not merged with process.env
    const child = nodeSpawn(options.cmd, options.args, {
      env: options.env || {
        PATH: process.env.PATH || "",
        HOME: process.env.HOME || "",
      },
      stdio: options.stdio || ["pipe", "pipe", "pipe"],
      cwd: options.cwd || process.cwd(),
      detached: killGroup,
    });

    // sends `signal` to the entire process group when killGroup is set, so
    // grandchildren (e.g. the native opencode binary spawned by the
    // opencode-ai Node shim) die with the parent. falls back to a direct
    // child kill if the process-group send fails (common when the child
    // already exited or was never made a process group leader).
    const killSelf = (signal: NodeJS.Signals): void => {
      if (killGroup && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // fall through to direct kill
        }
      }
      child.kill(signal);
    };

    // track child for cleanup on Ctrl+C
    trackChild({ child, killGroup });

    let timeoutId: NodeJS.Timeout | undefined;
    let sigkillEscalatorId: NodeJS.Timeout | undefined;
    let activityCheckIntervalId: NodeJS.Timeout | undefined;
    let isTimedOut = false;
    let isActivityTimedOut = false;
    let lastActivityTime = performance.now();
    // idle-ms snapshot taken at the moment the activity timer decides to kill.
    // we reuse it when composing the SpawnTimeoutError so a final stdout chunk
    // that races with `close` (and resets lastActivityTime via updateActivity)
    // can't make the error message contradict the "no output for Ns" log line.
    let killedAtIdleMs: number | undefined;

    // SIGTERM first: git deletes its own lockfiles on SIGTERM but leaves them on SIGKILL.
    // the escalator has no `child.killed` guard: that flag turns true once SIGTERM is sent.
    const terminate = (): void => {
      if (sigkillEscalatorId) return; // timeout and abort can both fire; arm one escalator
      killSelf("SIGTERM");

      // track the escalator so a graceful SIGTERM response (close fires
      // before the 5s elapses) can clear it. without capture, this timer
      // was orphaned in the event loop and kept node alive for up to 5s
      // past a timed-out subprocess's clean exit.
      sigkillEscalatorId = setTimeout(() => killSelf("SIGKILL"), 5000);
    };

    // overall timeout
    if (options.timeout) {
      timeoutId = setTimeout(() => {
        isTimedOut = true;
        terminate();
      }, options.timeout);
    }
    options.signal?.addEventListener("abort", terminate, { once: true });

    // activity timeout: kill if no output for too long
    if (activityTimeoutMs > 0) {
      log.debug(
        `spawn activity timer: pid=${child.pid} cmd=${options.cmd} timeout=${activityTimeoutMs}ms`
      );
      activityCheckIntervalId = setInterval(() => {
        const idleMs = performance.now() - lastActivityTime;
        log.debug(
          `spawn activity check: pid=${child.pid} idle=${Math.round(idleMs)}ms / ${activityTimeoutMs}ms`
        );
        if (idleMs > activityTimeoutMs) {
          isActivityTimedOut = true;
          killedAtIdleMs = idleMs;
          const idleSec = Math.round(idleMs / 1000);
          log.info(
            `no output for ${idleSec}s from pid=${child.pid} (${options.cmd}), killing process${killGroup ? " group" : ""}`
          );
          killSelf("SIGKILL");
          clearInterval(activityCheckIntervalId);
          try {
            options.onActivityTimeout?.();
          } catch (err) {
            log.debug(
              `spawn onActivityTimeout handler threw: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      }, DEFAULT_ACTIVITY_CHECK_INTERVAL_MS);
    }

    function updateActivity(): void {
      lastActivityTime = performance.now();
    }

    // wrap handlers in try/catch as defense in depth for synchronous throws
    // inside the listener body. the historical `+= chunk` RangeError was such
    // a throw — synchronous and fatal under node's default uncaught-exception
    // policy. with the TailBuffer cap in place the wrapper-side `append` can
    // no longer throw, but the catch keeps protecting against any future
    // synchronous regression in this path.
    //
    // note: this does NOT catch rejections from async user callbacks —
    // `options.onStdout?.(chunk)` returns a Promise in the agent callers
    // (claude.ts, opencode.ts) and a throw inside an async callback surfaces
    // as an unhandled Promise rejection, not a synchronous exception. agent
    // callers handle their own NDJSON-parse failures internally; the
    // synchronous protection here is what matters for the RangeError class
    // of bugs (issue #680).
    if (child.stdout) {
      child.stdout.on("data", (data: Buffer) => {
        try {
          updateActivity();
          const chunk = data.toString();
          stdoutBuffer?.append(chunk);
          options.onStdout?.(chunk);
        } catch (err) {
          log.debug(
            `spawn stdout handler threw: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (data: Buffer) => {
        try {
          const chunk = data.toString();
          stderrBuffer?.append(chunk);
          options.onStderr?.(chunk);
        } catch (err) {
          log.debug(
            `spawn stderr handler threw: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      });
    }

    child.on("close", (exitCode, signal) => {
      const durationMs = performance.now() - startTime;

      untrackChild(child);
      if (timeoutId) clearTimeout(timeoutId);
      if (sigkillEscalatorId) clearTimeout(sigkillEscalatorId);
      if (activityCheckIntervalId) clearInterval(activityCheckIntervalId);
      options.signal?.removeEventListener("abort", terminate);

      if (options.signal?.aborted) {
        reject(options.signal.reason);
        return;
      }

      if (isTimedOut) {
        reject(
          new SpawnTimeoutError(`process timed out after ${options.timeout}ms`, SPAWN_TIMEOUT_CODE)
        );
        return;
      }

      if (isActivityTimedOut) {
        // prefer the idle-ms captured when the kill fired (killedAtIdleMs).
        // recomputing from lastActivityTime here would be wrong if the child
        // emitted one final stdout chunk between SIGKILL and close — the
        // chunk's updateActivity() would reset lastActivityTime and the error
        // would report near-zero idle, contradicting the kill-site log line.
        const idleMs = killedAtIdleMs ?? performance.now() - lastActivityTime;
        const idleSec = Math.round(idleMs / 1000);
        reject(
          new SpawnTimeoutError(
            `activity timeout: no output for ${idleSec}s`,
            SPAWN_ACTIVITY_TIMEOUT_CODE
          )
        );
        return;
      }

      // when a child is killed by signal (OOM, segfault, external SIGTERM),
      // node delivers (code=null, signal=<name>). without this branch,
      // `exitCode || 0` coerced null to 0 and lifecycle hooks silently
      // appeared to succeed when they'd actually been killed — caller
      // checked `result.exitCode !== 0` and moved on.
      let resolvedExitCode = exitCode ?? 0;
      let resolvedStderr = stderrBuffer?.toString() ?? "";
      if (exitCode === null && signal) {
        const killMsg = `[spawn] ${options.cmd}: killed by signal ${signal}`;
        resolvedStderr = resolvedStderr ? `${resolvedStderr}\n${killMsg}` : killMsg;
        resolvedExitCode = 1;
      }

      resolve({
        stdout: stdoutBuffer?.toString() ?? "",
        stderr: resolvedStderr,
        exitCode: resolvedExitCode,
        durationMs,
      });
    });

    child.on("error", (error) => {
      const durationMs = performance.now() - startTime;

      untrackChild(child);
      if (timeoutId) clearTimeout(timeoutId);
      if (sigkillEscalatorId) clearTimeout(sigkillEscalatorId);
      if (activityCheckIntervalId) clearInterval(activityCheckIntervalId);
      options.signal?.removeEventListener("abort", terminate);

      // surface the spawn error in stderr so callers (e.g. lifecycle hook
      // warnings) don't just see "exit code 1, output: (empty)" when the
      // command was misspelled, missing, or unexecutable. without this a
      // user with a bad postCheckout script got an opaque failure, retried
      // per the guidance, and hit the same wall every run.
      const errMsg = `[spawn] ${options.cmd}: ${error.message}`;
      console.error(errMsg);
      const existingStderr = stderrBuffer?.toString() ?? "";
      const finalStderr = existingStderr ? `${existingStderr}\n${errMsg}` : errMsg;

      resolve({
        stdout: stdoutBuffer?.toString() ?? "",
        stderr: finalStderr,
        exitCode: 1,
        durationMs,
      });
    });

    if (options.input && child.stdin && options.stdio?.[0] !== "ignore") {
      child.stdin.write(options.input);
      child.stdin.end();
    }
  });
}
