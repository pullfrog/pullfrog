// changes to shell security (filterEnv, spawnShell) should be reflected in wiki/security.md and docs/security.mdx
import { type ChildProcess, type StdioOptions, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { closeSync, existsSync, openSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type } from "arktype";
import { HOOK_ASSET_TMPDIR_RELPATHS } from "../agents/nativeFsDenies.ts";
import { ensureBrowserDaemon } from "../utils/browser.ts";
import { log } from "../utils/log.ts";
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
    "Timeout in MILLISECONDS (not seconds). Default 30000 (30s), max 120000 (2m). e.g. timeout: 180000 for 3 minutes; timeout: 180 means 180ms and will kill the process almost immediately."
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

export type SandboxMethod = "unshare" | "sudo-unshare" | "userns-unshare" | "none";

/** `setpriv` args that leave a root process no capabilities and no way to regain one. */
const DROP_ALL_PRIVS = [
  "--no-new-privs",
  "--bounding-set",
  "-all",
  "--inh-caps",
  "-all",
  "--ambient-caps",
  "-all",
];

/** cached result of sandbox capability check */
let detectedSandboxMethod: SandboxMethod | undefined;

/** stderr from the userns probe, surfaced in the CI-gate error so an operator sees
 * which wall they actually hit rather than our guess at one. */
let usernsProbeError: string | undefined;

/** get the current sandbox method (for testing/diagnostics) */
export function getSandboxMethod(): SandboxMethod {
  return detectSandboxMethod();
}

/** detect which sandbox method is available on this system */
function detectSandboxMethod(): SandboxMethod {
  if (detectedSandboxMethod !== undefined) {
    return detectedSandboxMethod;
  }

  // only attempt in CI environments - sandbox has overhead and is primarily for untrusted code
  if (process.env.CI !== "true") {
    detectedSandboxMethod = "none";
    log.debug("sandbox disabled (CI !== true)");
    return "none";
  }

  // try unprivileged unshare first (works where the job already runs as root).
  // each probe runs the `setpriv` its branch exec's, so a runner without it falls
  // through to the actionable CI-gate error instead of failing every command.
  try {
    const result = spawnSync(
      "unshare",
      ["--pid", "--fork", "--mount-proc", "setpriv", ...DROP_ALL_PRIVS, "true"],
      { timeout: 5000, stdio: "ignore" }
    );
    if (result.status === 0) {
      detectedSandboxMethod = "unshare";
      log.debug("PID namespace isolation enabled (unprivileged unshare)");
      return "unshare";
    }
  } catch {
    // continue to try sudo
  }

  // sudo unshare (works on GHA runners)
  try {
    const result = spawnSync(
      "sudo",
      ["unshare", "--pid", "--fork", "--mount-proc", "setpriv", "--no-new-privs", "true"],
      { timeout: 5000, stdio: "ignore" }
    );
    if (result.status === 0) {
      detectedSandboxMethod = "sudo-unshare";
      log.debug("PID namespace isolation enabled (sudo unshare)");
      return "sudo-unshare";
    }
  } catch {
    // continue to try userns
  }

  // userns-nested PID namespace: the fallback for containerized / Kubernetes
  // self-hosted runners (no host CAP_SYS_ADMIN, no passwordless sudo). creating a
  // user namespace first grants CAP_SYS_ADMIN scoped to that userns — enough for the
  // nested --pid and the mount namespace — without any host capability.
  //
  // deliberately NOT --mount-proc: every OCI runtime masks paths under /proc, which
  // makes the visible procfs not "fully visible", so mnt_already_visible() refuses a
  // fresh procfs from a non-initial userns. that is true of EVERY k8s pod, so
  // --mount-proc would fail-close this path everywhere it is meant to help.
  // it is not needed: two independent locks block the /proc/<pid>/environ read this
  // sandbox exists to stop, and only the second survives in a pod —
  //   1. the PID namespace (needs the procfs remount, impossible here)
  //   2. the userns credential boundary — a process in a child userns lacks
  //      CAP_SYS_PTRACE in the target's userns, so ptrace_may_access denies the read
  //      even for the same uid on a fully visible target
  // PROC_CLEANUP still runs in spawnShell as a best-effort attempt at lock 1, which
  // succeeds on runners whose /proc is unmasked. see wiki/userns-sandbox.md.
  //
  // the probe exercises the FULL sealed pipeline including the `setpriv` cap-drop that
  // spawnShell exec's unconditionally — so a runner with capable unshare but a
  // missing/incapable setpriv (e.g. busybox on Alpine images, which lacks
  // --ambient-caps) fails over to "none" + the actionable error rather than caching
  // userns-unshare and then breaking every shell command on the unrunnable setpriv.
  try {
    const result = spawnSync(
      "unshare",
      [
        "--user",
        "--map-root-user",
        "--pid",
        "--fork",
        "--mount",
        "setpriv",
        ...DROP_ALL_PRIVS,
        "true",
      ],
      { timeout: 5000, stdio: ["ignore", "ignore", "pipe"] }
    );
    if (result.status === 0) {
      detectedSandboxMethod = "userns-unshare";
      log.debug("PID namespace isolation enabled (unprivileged userns unshare)");
      return "userns-unshare";
    }
    // keep the probe's own words: the walls (seccomp / CAP_SETFCAP / node kernel /
    // a missing binary) are indistinguishable from the outside, so a guessed cause
    // in the CI-gate error sends operators to change a setting that cannot help them.
    // spawnSync does not throw on ENOENT — it returns status null with no stderr and
    // the reason in `error`, which is the whole clue when unshare/setpriv is absent.
    usernsProbeError = result.stderr?.toString().trim() || result.error?.message;
  } catch {
    // no sandbox available
  }

  detectedSandboxMethod = "none";
  log.info("PID namespace isolation not available");
  return "none";
}

// strip inherited proc mount that sits underneath --mount-proc's overlay.
// --mount-proc mounts fresh proc on top, but `umount /proc` peels it off and exposes the
// host's proc with all host PIDs — allowing /proc/<pid>/environ exfiltration.
// drain every proc layer, then a clean mount gives only sandbox PIDs. `-R` is
// load-bearing: GitHub runners carry a binfmt_misc submount under the host's proc,
// so a plain `umount /proc` on that layer fails EBUSY and leaves it in place.
// on unprivileged systems where umount fails, --mount-proc still provides isolation
// (the agent also can't umount in that case).
const PROC_CLEANUP =
  "for i in 1 2 3 4; do grep -q ' - proc ' /proc/self/mountinfo 2>/dev/null || break; " +
  "umount -R /proc 2>/dev/null || break; done; mount -t proc proc /proc 2>/dev/null;";

// block container-runtime sockets that would otherwise grant a PID-namespace
// escape: `docker run --pid=host --privileged busybox cat /proc/<pid>/environ`
// reads the parent action process's env (which contains user secrets) even
// though the sandbox itself is unsharing PIDs. GHA `ubuntu-latest` puts the
// `runner` user in the `docker` group by default, so the socket is reachable
// without sudo. bind-mounting /dev/null on top inside the sandbox's mount
// namespace makes the socket unreachable from sandboxed shells without
// touching the host runner (so it doesn't break user workflow steps that
// run before/after pullfrog and legitimately need docker). same trick for
// podman/containerd/cri-o sockets — all silent-fail if the path is missing.
const SOCKET_CLEANUP = [
  "/var/run/docker.sock",
  "/run/docker.sock",
  "/var/run/podman/podman.sock",
  "/run/podman/podman.sock",
  "/run/containerd/containerd.sock",
  "/var/run/crio/crio.sock",
]
  .map((path) => `mount --bind /dev/null ${path} 2>/dev/null;`)
  .join(" ");

// extend the mount-namespace isolation that PROC_CLEANUP and SOCKET_CLEANUP
// already establish. these mounts hide pullfrog-managed on-disk secrets,
// block env-injection into subsequent workflow steps, and make git's
// code-execution config read-only inside the bash subprocess.
//
//   1. tmpfs over /var/lib/pullfrog/ — codex auth.json and any future
//      pullfrog-managed on-disk secret live here (see action/utils/codexHome.ts
//      PULLFROG_DATA_DIR). opencode's internal auth module runs in the agent
//      process outside this namespace and reads the real file via bypass of
//      external_directory; bash sees an empty tmpfs. mkdir -p the path
//      first so the tmpfs always engages — without that, runs without
//      CODEX_AUTH_JSON wouldn't have bootstrapped the dir, the mountpoint
//      wouldn't exist, and `mount -t tmpfs` would silent-fail. precreate
//      keeps the overlay active for any future on-disk secret that lands
//      under /var/lib/pullfrog regardless of which install path created it.
//   2. tmpfs over $RUNNER_TEMP/_runner_file_commands/ — anything bash writes
//      to $GITHUB_ENV / $GITHUB_PATH / $GITHUB_OUTPUT / $GITHUB_STATE lands in
//      a per-namespace tmpfs that the GHA runner never sees. our own action
//      process writes core.setOutput / core.saveState outside the namespace,
//      so legitimate outputs are unaffected. requires RUNNER_TEMP to be set.
//   3. self-bind + remount-ro on the ENTIRE <repoRoot>/.git directory.
//      A blanket ro-bind is free: nothing legitimately writes .git from
//      bash (commits go through our $git(), whose binary runs OUTSIDE this
//      namespace, so it's unaffected; bash `git` is already blocked). It
//      robustly covers every code-exec surface an enumerated list would miss
//      — .git/config, .git/config.worktree, .git/modules/*/config (all carry
//      core.hooksPath / filter / alias / credential.helper exec vectors),
//      plus .git/hooks/* and .git/info/attributes. Prevents agent-planted git
//      filters / hooks from firing in downstream workflow steps (the threat
//      survives ASKPASS because hooks fire after auth and our $git() uses -c
//      core.hooksPath to override its own hooks, but downstream `git`
//      invocations in later steps DON'T get that protection — see
//      wiki/security.md "Filesystem Sandbox"). CONSEQUENCE: .git/info/exclude
//      (a legit per-repo ignore file) is now read-only too — accepted, the
//      narrow earlier bind list left it writable. Does not cover `~/.gitconfig`
//      or `/etc/gitconfig` — see "Scope and Limitations" in wiki/security.md.
//
// these mounts run as root inside the namespace (before `exec su -p` drops
// to runner). after the drop, runner has no CAP_SYS_ADMIN in the host, so
// can't undo from outside. intra-namespace sudo CAN undo them — a sealed
// command (`no_new_privs`, see SpawnParams.seal) cannot regain root; `enabled`
// mode keeps sudo on trust. see wiki/security.md "sudo inside the sandbox".
//
// in the unprivileged-unshare path (a job running as root: Docker --privileged
// test environments and root self-hosted images), the command holds
// CAP_SYS_ADMIN and could `umount` these unless sealed. seals: sudo-unshare via
// the `su -p` drop plus no_new_privs, and unshare / userns-unshare via the
// `setpriv` cap-drop (plus MNT_LOCKED on every inherited mount for userns).
//
// repoDir is interpolated by the action process from resolveRepoRoot() —
// NOT $PWD — because spawnShell's cwd is agent-controllable via
// `working_directory` AND the action's process.cwd() may have been chdir'd
// to payload.cwd (monorepo subdir support in main.ts). using either would
// let the agent bypass the .git/* binds. resolveRepoRoot pins the actual
// repo root once at startup via $GITHUB_WORKSPACE or `git rev-parse`.
function buildFsMounts(repoDir: string): string {
  // shell-escape via single-quote wrap; bash interprets \' as the escape
  // for a single quote inside a single-quoted string by closing-and-reopening.
  // repoDir paths in practice are GHA workspace paths (no quotes), but the
  // escape keeps us correct against arbitrary user-configured workspaces.
  const escaped = repoDir.replace(/'/g, "'\\''");
  return [
    `mkdir -p /var/lib/pullfrog 2>/dev/null;`,
    `mount -t tmpfs tmpfs /var/lib/pullfrog 2>/dev/null;`,
    `[ -n "$RUNNER_TEMP" ] && [ -d "$RUNNER_TEMP/_runner_file_commands" ] && mount -t tmpfs tmpfs "$RUNNER_TEMP/_runner_file_commands" 2>/dev/null;`,
    `[ -e '${escaped}/.git' ] && mount --bind '${escaped}/.git' '${escaped}/.git' 2>/dev/null && mount -o remount,bind,ro '${escaped}/.git' 2>/dev/null;`,
    // the corepack shim dir sits FIRST on PATH (utils/packageManager.ts) and
    // PATH survives filterEnv, so a writable pm-bin lets sandboxed code plant
    // a `git`/`pnpm` that a later UNSANDBOXED spawn resolves with the parent
    // env. read-only closes that for every sandboxed command at once.
    //
    // the path is interpolated HERE rather than read as `$PULLFROG_TEMP_DIR`
    // inside the sandbox: that name is not on the `filterEnv` safe list, so in
    // restricted mode it expands to empty and the mount silently no-ops in the
    // one tier it exists to protect. `$RUNNER_TEMP` above is safe only because
    // `RUNNER_` is an allowed prefix.
    shimMount(),
    hookMounts(),
  ]
    .filter(Boolean)
    .join(" ");
}

/** pullfrog-managed hook/gate scripts live in the per-run HOME (tmpdir) and
 * execute with the agent's full environment. the agent runs the sandboxed
 * shell as the uid that OWNS them, so the no_new_privs seal does not stop it
 * rewriting one to capture that env — a leak a token-exfil run found in July.
 * ro-bind each (the names are deterministic under PULLFROG_TEMP_DIR; the action
 * writes them before the first shell call) so the sandboxed shell cannot. the
 * action process writes them OUTSIDE this namespace, so our own writes are
 * unaffected. native FS tools are denied separately (claude settings deny,
 * opencode external_directory deny) since they run outside this sandbox.
 *
 * this leaf ro-bind does NOT stop the agent renaming an owned ancestor dir
 * (tmpdir, `.config/opencode`) and planting a tampered asset — a known, open
 * gap (see wiki/security.md "Scope and Limitations"); the direct rewrite is
 * sealed, the rename variant is not. */
function hookMounts(): string {
  const tempDir = process.env.PULLFROG_TEMP_DIR;
  if (!tempDir) return "";
  return HOOK_ASSET_TMPDIR_RELPATHS.map((rel) => {
    const path = join(tempDir, rel).replace(/'/g, "'\\''");
    return `[ -e '${path}' ] && mount --bind '${path}' '${path}' 2>/dev/null && mount -o remount,bind,ro '${path}' 2>/dev/null;`;
  }).join(" ");
}

/** read-only bind for the corepack shim dir, or "" when this run has no tmpdir. */
function shimMount(): string {
  const tempDir = process.env.PULLFROG_TEMP_DIR;
  if (!tempDir) return "";
  const dir = join(tempDir, "pm-bin").replace(/'/g, "'\\''");
  return `[ -d '${dir}' ] && mount --bind '${dir}' '${dir}' 2>/dev/null && mount -o remount,bind,ro '${dir}' 2>/dev/null;`;
}

/** locate the repo root once at action startup. process.cwd() is unreliable
 * because main.ts may `process.chdir(payload.cwd)` for monorepo subdirs;
 * the agent's `working_directory` shell param also moves spawn cwd. we need
 * the actual git working tree root for the .git/* binds. memoized for the
 * lifetime of the action process. */
let _repoRoot: string | undefined;
function resolveRepoRoot(): string {
  if (_repoRoot) return _repoRoot;
  const fromEnv = process.env.GITHUB_WORKSPACE;
  if (fromEnv) {
    _repoRoot = fromEnv;
    return _repoRoot;
  }
  // fallback: `git rev-parse --show-toplevel` from process.cwd(). only used
  // outside GHA (local dev, custom runners). swallow errors and fall back
  // to process.cwd() so we never throw from the shell-tool init path.
  try {
    _repoRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    }).stdout?.trim();
  } catch {
    // intentionally empty — fall through to process.cwd()
  }
  if (!_repoRoot) _repoRoot = process.cwd();
  return _repoRoot;
}

function spawnShell(params: SpawnParams): ChildProcess {
  const spawnOpts = { env: params.env, cwd: params.cwd, stdio: params.stdio, detached: true };
  const sandboxMethod = detectSandboxMethod();
  const ci = process.env.CI === "true";

  if (ci && sandboxMethod === "none") {
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

  // resolve the actual git repo root (NOT params.cwd which is
  // agent-controllable via `working_directory`, NOT process.cwd() which may
  // have been chdir'd to payload.cwd in main.ts). resolveRepoRoot prefers
  // $GITHUB_WORKSPACE in CI and falls back to `git rev-parse`.
  const repoRoot = resolveRepoRoot();
  const fsMounts = buildFsMounts(repoRoot);

  if (sandboxMethod === "unshare") {
    // the job itself is root here, so sealing must drop capabilities, not just
    // block setuid — the same seal as the userns branch below.
    const command = params.seal
      ? `exec setpriv ${DROP_ALL_PRIVS.join(" ")} bash -c '${params.command.replace(/'/g, "'\\''")}'`
      : params.command;
    return spawn(
      "unshare",
      [
        "--pid",
        "--fork",
        "--mount-proc",
        "bash",
        "-c",
        `${PROC_CLEANUP} ${SOCKET_CLEANUP} ${fsMounts} ${command}`,
      ],
      spawnOpts
    );
  }

  if (sandboxMethod === "userns-unshare") {
    // --user --map-root-user creates a user namespace and makes us root inside it,
    // which grants the in-userns CAP_SYS_ADMIN that the nested --pid and --mount
    // require — no host capability needed. the setup (PROC_CLEANUP / SOCKET_CLEANUP /
    // fsMounts) runs with that in-userns root, then `setpriv` drops the entire
    // bounding set + sets no_new_privs before the untrusted command (the userns
    // analog of the sudo path's `su -p` seal). uid 0-in-userns maps to the action's
    // real uid outside, so created files are owned correctly and no su drop is needed.
    //
    // TWO mechanisms keep the untrusted command off the mounts, and the cap-drop is
    // only the first. it does NOT survive a nested userns: the kernel hands out a
    // full capability set on every CLONE_NEWUSER regardless of the bounding set, so
    // the sealed command can re-acquire CAP_SYS_ADMIN in a userns of its own. what
    // stops it there is that ns_capable() only walks ancestor-ward — a descendant
    // userns confers nothing over the mount namespace its parent owns — and that
    // `unshare --mount` marks every inherited mount MNT_LOCKED. the cap-drop still
    // earns its place: without it the command holds CAP_SYS_ADMIN in the userns that
    // OWNS this mount namespace, where the binds we just made are not locked.
    //
    // --mount is EXPLICIT and load-bearing: it is normally implied by --mount-proc,
    // which detectSandboxMethod deliberately omits (see there). without it there is
    // no mount namespace at all and fsMounts silently no-ops — the tmpfs over
    // /var/lib/pullfrog and the .git ro-bind just vanish, taking the filesystem
    // sandbox with them while every other guarantee still appears to hold.
    // --map-current-user is NOT a substitute for --map-root-user: mapping a non-zero
    // uid makes execve use non-root capability rules, so the setup lands with an
    // empty effective set and every mount fails.
    const escaped = params.command.replace(/'/g, "'\\''");
    return spawn(
      "unshare",
      [
        "--user",
        "--map-root-user",
        "--pid",
        "--fork",
        "--mount",
        "bash",
        "-c",
        `${PROC_CLEANUP} ${SOCKET_CLEANUP} ${fsMounts} ` +
          `exec setpriv ${DROP_ALL_PRIVS.join(" ")} ` +
          `bash -c '${escaped}'`,
      ],
      spawnOpts
    );
  }

  if (sandboxMethod === "sudo-unshare") {
    const envArgs: string[] = [];
    for (const [k, v] of Object.entries(params.env)) {
      if (v !== undefined) {
        envArgs.push(`${k}=${v}`);
      }
    }
    // drop back to original user after PROC_CLEANUP / FS_MOUNTS so files aren't
    // owned by root. sudo is only needed for unshare + the mount setup; the
    // actual command should run as the normal user to avoid ownership
    // mismatches with files created by the Node.js parent process.
    const username = userInfo().username;
    // su -p resets PATH on many Linux systems (ALWAYS_SET_PATH in /etc/login.defs).
    // restore it from the SANDBOX_PATH env var that survives the su transition.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: we need to restore the PATH variable
    const pathRestore = 'export PATH="${SANDBOX_PATH:-$PATH}"; ';
    const command = pathRestore + params.command;
    // after `su`, which needs its own setuid privileges; the unprivileged user
    // cannot drop the bounding set, but no_new_privs alone blocks every setuid path.
    const sealed = params.seal
      ? `exec setpriv --no-new-privs bash -c '${command.replace(/'/g, "'\\''")}'`
      : command;
    const escaped = sealed.replace(/'/g, "'\\''");
    envArgs.push(`SANDBOX_PATH=${params.env.PATH ?? ""}`);
    return spawn(
      "sudo",
      [
        "env",
        ...envArgs,
        "unshare",
        "--pid",
        "--fork",
        "--mount-proc",
        "bash",
        "-c",
        `${PROC_CLEANUP} ${SOCKET_CLEANUP} ${fsMounts} exec su -p -s /bin/bash ${username} -c '${escaped}'`,
      ],
      { ...spawnOpts, env: {} }
    );
  }

  return spawn("bash", ["-c", params.command], spawnOpts);
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

/** detect git as a command invocation (not as part of another word like .gitignore) */
function isGitCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed === "git" || trimmed.startsWith("git ")) return true;
  if (trimmed.startsWith("sudo git")) return true;
  return /[;&|]\s*(?:sudo\s+)?git(?:\s|$)/.test(trimmed);
}

export function ShellTool(ctx: ToolContext) {
  return tool({
    name: "shell",
    timeoutMs: 120_000,
    description: `Execute shell commands securely.${ctx.payload.shell === "restricted" ? " Environment is filtered to remove API keys and secrets." : ""}

Example: \`shell({ command: "pnpm test", description: "run the test suite" })\`.

Use this tool to:
- Run shell commands (ls, cat, grep, find, etc.)
- Execute build tools (npm, pnpm, cargo, make, etc.)
- Run tests and linters

Output is capped at ${MAX_OUTPUT_CHARS} chars: if exceeded, only the tail is returned and the captured output is saved to a tempfile (path included in the response). Re-read the tempfile with cat/tail/grep when you need more.

Do NOT use this tool for git commands — use the dedicated git tools instead.`,
    parameters: ShellParams,
    execute: execute(async (params) => {
      if (isGitCommand(params.command)) {
        throw new Error(
          "git commands are not allowed in the shell tool. use the dedicated git tools instead:\n" +
            // the bare tool name here was the on-ramp to malformed `git` calls:
            // models read it as a command word and sent `command: "git"` (#1199).
            '- git: local operations, e.g. git({ command: "log", args: ["--oneline"] }) — `command` is the subcommand ONLY\n' +
            "- push_branch: push to remote (handles authentication)\n" +
            "- git_fetch: fetch from remote (handles authentication)\n" +
            "- checkout_pr: check out PR branches"
        );
      }

      const timeout = Math.min(params.timeout ?? 30000, 120000);
      const cwd = params.working_directory ?? process.cwd();
      // checked here, not left to spawn: its ENOENT names the sandbox binary, not the directory.
      if (!existsSync(cwd)) throw new Error(`working_directory does not exist: ${cwd}`);
      const env = resolveEnv(ctx.payload.shell === "enabled" ? "inherit" : "restricted");
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
