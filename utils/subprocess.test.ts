import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { spawn, TailBuffer } from "./subprocess.ts";

describe("spawn error path", () => {
  it("surfaces ENOENT-style spawn failures in stderr so callers can diagnose", async () => {
    // before this regression-test's fix, spawn resolved with exitCode=1 and
    // an empty stderr buffer when the command itself couldn't start —
    // lifecycle hook warnings then said "output: (empty)" and users had no
    // way to tell a broken script from a flaky one.
    const result = await spawn({
      cmd: "/nonexistent-command-for-spawn-test-xyz",
      args: [],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      activityTimeout: 0,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("/nonexistent-command-for-spawn-test-xyz");
    expect(result.stderr).toMatch(/ENOENT|not found/i);
  });

  it("clears the SIGKILL escalator when a timed-out child exits cleanly from SIGTERM", async () => {
    // regression: the overall-timeout path did
    //   setTimeout(() => { if (!child.killed) child.kill("SIGKILL") }, 5000)
    // without capturing the timer id. if the child responded to SIGTERM and
    // `close` fired promptly, the SIGKILL escalator stayed in the event loop
    // for up to 5 seconds — delaying any clean shutdown by that long.
    const beforeHandles = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

    // sleep does not install a TERM trap, so the default action (terminate)
    // fires immediately — `close` lands within ms of the SIGTERM, giving us
    // the orphaned-escalator window that the bug would have triggered.
    const result = await spawn({
      cmd: process.platform === "win32" ? "node" : "sleep",
      args: process.platform === "win32" ? ["-e", "setTimeout(() => {}, 30000)"] : ["30"],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      activityTimeout: 0,
      timeout: 200,
    }).catch((err) => err);

    // timed out, so we get the SpawnTimeoutError
    expect(result).toBeInstanceOf(Error);

    // the SIGKILL escalator (and any other timer spawn() owned) must be
    // cleared by the time the promise settles — active timer count should
    // not have grown past the pre-spawn baseline.
    const afterHandles = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    expect(afterHandles).toBeLessThanOrEqual(beforeHandles);
  });

  it("killGroup: true propagates SIGKILL to grandchildren so close fires promptly", async () => {
    // regression: node_modules/opencode-ai/bin/opencode is a Node shim that
    // spawnSyncs the native binary with stdio:"inherit". without killGroup,
    // child.kill("SIGKILL") hit only the shim — the native binary was
    // reparented to PID 1, kept holding our stdout pipe via the inherited
    // fds, and `child.on("close")` never fired (because pipes stayed open).
    // a 5-min outer safety-net timer eventually rejected the agent promise,
    // but the grandchild kept running until the GitHub Actions job-level
    // timeout. this test replicates the shape with bash + a backgrounded
    // sleep grandchild: with killGroup, close fires promptly after SIGKILL;
    // without it, the parent would wait for sleep to exit (30s).
    //
    // the activity-check interval is fixed at 5s so the earliest the kill
    // can fire is ~5s after start. budget 15s end-to-end.
    const before = performance.now();
    const result = await spawn({
      cmd: "bash",
      args: ["-c", "sleep 30 & wait"],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      activityTimeout: 1000,
      killGroup: true,
    }).catch((err) => err);
    const elapsed = performance.now() - before;

    expect(result).toBeInstanceOf(Error);
    // 10s ceiling: 5s activity-check tick + signal delivery. a regression
    // here (no killGroup) would hang for the full 30s sleep.
    expect(elapsed).toBeLessThan(10_000);
  }, 20_000);

  it('retain:"tail" caps stderr at maxRetainedBytes and prepends a truncation sentinel', async () => {
    // regression for issue #680: unbounded `stderrBuffer += chunk` previously
    // crashed the wrapper with `RangeError: Invalid string length` once V8's
    // ~1 GiB kMaxLength was breached on long-lived agent runs. the fix caps
    // retention with a TailBuffer; this test exercises the cap end-to-end by
    // emitting ~2 MiB of stderr against a 256 KiB ceiling and asserts the
    // wrapper does not crash, the result is bounded, and the sentinel is
    // present so downstream consumers can detect the truncation.
    const result = await spawn({
      cmd: "bash",
      // print ~2 MiB to stderr in 64 KiB chunks. `yes` + head gives us a
      // reliable byte budget that's well above the 256 KiB cap below.
      args: ["-c", "yes ABCDEFGH | head -c 2097152 1>&2"],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      activityTimeout: 0,
      maxRetainedBytes: 256 * 1024,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/truncated by retain:tail cap/);
    expect(result.stderr.length).toBeLessThan(256 * 1024 + 200);
  }, 15_000);

  it('retain:"none" returns empty stdout/stderr regardless of child output', async () => {
    // long-lived agent callers (opencode, claude) drain via onStdout/onStderr
    // and never read result.stdout/result.stderr — they pass retain:"none"
    // to skip the per-chunk concatenation entirely. assert that contract:
    // empty strings out, but onStdout still fires.
    const chunks: string[] = [];
    const result = await spawn({
      cmd: "bash",
      args: ["-c", "echo hello; echo world 1>&2"],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      activityTimeout: 0,
      retain: "none",
      onStdout: (chunk) => chunks.push(chunk),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(chunks.join("")).toContain("hello");
  });

  it('retain defaults to "tail" so short-lived callers keep failure-surfacing snapshots', async () => {
    // lock the default explicitly. gitAuth, package installs, and lifecycle
    // hooks all rely on `result.stderr` being non-empty on failure — flipping
    // the default to "none" would silently break their error messages while
    // all other tests in this file kept passing.
    const result = await spawn({
      cmd: "bash",
      args: ["-c", "echo -n diagnostic-output 1>&2; exit 7"],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      activityTimeout: 0,
    });

    expect(result.exitCode).toBe(7);
    expect(result.stderr).toBe("diagnostic-output");
  });

  it("TailBuffer drops oldest bytes once the cap is exceeded", () => {
    const buf = new TailBuffer(10);
    buf.append("0123456789");
    expect(buf.toString()).toBe("0123456789");
    buf.append("abcde");
    // 0-9 plus abcde = 15 chars; cap is 10, so we keep the last 10 = "56789abcde"
    expect(buf.toString()).toMatch(/truncated by retain:tail cap/);
    expect(buf.toString()).toContain("56789abcde");
  });

  it("reports signal-killed subprocesses as failures, not success", async () => {
    if (process.platform === "win32") return;
    // regression: before the fix, `child.on("close", (exitCode) => ...)`
    // discarded the signal parameter and `exitCode || 0` coerced the
    // node-delivered null to 0. lifecycle hooks killed by OOM, segfault,
    // or external SIGTERM were silently reported as exit code 0, and
    // lifecycle.ts's `if (result.exitCode !== 0)` skipped the warning —
    // so callers proceeded as if setup/post-checkout/prepush had succeeded.
    const result = await spawn({
      cmd: "bash",
      args: ["-c", "kill -KILL $$"],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      activityTimeout: 0,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/killed by signal/i);
    expect(result.stderr).toMatch(/SIGKILL/);
  });
});
