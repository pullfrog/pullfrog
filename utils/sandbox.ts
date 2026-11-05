// the PID+mount-namespace sandbox primitives, shared by the async shell path
// (action/mcp/shell.ts `spawnShell` / `runSandboxed`) and the sync MCP git path
// (action/utils/shell.ts `$`). changes here should be reflected in
// wiki/security.md and docs/security.mdx.
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { join } from "node:path";
import { HOOK_ASSET_TMPDIR_RELPATHS } from "../agents/nativeFsDenies.ts";
import { log } from "./log.ts";

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

/** the userns probe's own stderr, for the CI-gate error assembled in spawnShell. */
export function getUsernsProbeError(): string | undefined {
  return usernsProbeError;
}

/** get the current sandbox method (for testing/diagnostics) */
export function getSandboxMethod(): SandboxMethod {
  return detectSandboxMethod();
}

/** detect which sandbox method is available on this system */
export function detectSandboxMethod(): SandboxMethod {
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
//      A blanket ro-bind is free: nothing legitimately writes .git from the
//      agent's bash — the MCP git tool's commits go through `$()`, which runs in
//      its OWN gitWritable sandbox (see below), not this shell namespace, so it's
//      unaffected; the agent's bash `git` can only read. It
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
//      the `gitWritable` profile OMITS this bind: the MCP git path (action/utils/
//      shell.ts `$`) and the dependency installers run sandboxed so a commit/
//      checkout/merge, or husky's `prepare`, can write .git, and their isolation
//      comes from the PID namespace + filtered env, not a read-only .git. a
//      planted hook/filter still fires there, but in a fresh PID namespace with
//      no action PID to read and no secret in its env.
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
function buildFsMounts(options: { gitWritable: boolean }): string {
  return [
    `mkdir -p /var/lib/pullfrog 2>/dev/null;`,
    `mount -t tmpfs tmpfs /var/lib/pullfrog 2>/dev/null;`,
    `[ -n "$RUNNER_TEMP" ] && [ -d "$RUNNER_TEMP/_runner_file_commands" ] && mount -t tmpfs tmpfs "$RUNNER_TEMP/_runner_file_commands" 2>/dev/null;`,
    // the .git ro-bind (point 3 above). omitted for `gitWritable` so sandboxed
    // MCP git can write .git; isolation there is the PID namespace, not a ro .git.
    options.gitWritable ? "" : gitReadOnlyMount(),
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

/** the `.git` read-only bind. resolves the repo root only here: `resolveRepoRoot` memoizes
 * its first answer, and a git call needing no bind can run before the workspace is settled
 * (`runFixture` sets it after cloning), which pinned the wrong root and left `.git` writable. */
function gitReadOnlyMount(): string {
  // shell-escape via single-quote wrap; bash interprets \' as the escape
  // for a single quote inside a single-quoted string by closing-and-reopening.
  // repoDir paths in practice are GHA workspace paths (no quotes), but the
  // escape keeps us correct against arbitrary user-configured workspaces.
  const escaped = resolveRepoRoot().replace(/'/g, "'\\''");
  return `[ -e '${escaped}/.git' ] && mount --bind '${escaped}/.git' '${escaped}/.git' 2>/dev/null && mount -o remount,bind,ro '${escaped}/.git' 2>/dev/null;`;
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
export function resolveRepoRoot(): string {
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

/** shell-escape one argument by single-quote wrapping (close-and-reopen on `'`). */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** `exec`-prefixed shell command that runs `cmd args` as the sandbox's final
 * process, so the inner process's exit status propagates out through the
 * unshare/sudo/bash exec chain unchanged. */
function execCommand(cmd: string, args: string[]): string {
  return `exec ${shQuote(cmd)} ${args.map(shQuote).join(" ")}`;
}

/**
 * Assemble the `(bin, args, env)` that launches `command` inside the detected
 * PID+mount-namespace sandbox. Shared by `spawnShell` (async `spawn`, the shell
 * tool + lifecycle hooks) and `spawnGitSandboxedSync` (sync `spawnSync`, the MCP
 * git path) so both reuse ONE copy of the security-critical invocation.
 *
 * `seal` sets no_new_privs + drops caps so a root command inside the namespace
 * cannot re-elevate and unmount the protective mounts (false only for trusted
 * `shell: enabled`). `gitWritable` drops the `.git` read-only bind so sandboxed
 * `git` can write `.git`.
 */
export function buildSandboxInvocation(params: {
  command: string;
  seal: boolean;
  env: Record<string, string | undefined>;
  method: Exclude<SandboxMethod, "none">;
  gitWritable: boolean;
}): { bin: string; args: string[]; env: Record<string, string | undefined> } {
  const fsMounts = buildFsMounts({ gitWritable: params.gitWritable });

  if (params.method === "unshare") {
    // the job itself is root here, so sealing must drop capabilities, not just
    // block setuid — the same seal as the userns branch below.
    const command = params.seal
      ? `exec setpriv ${DROP_ALL_PRIVS.join(" ")} bash -c '${params.command.replace(/'/g, "'\\''")}'`
      : params.command;
    return {
      bin: "unshare",
      args: [
        "--pid",
        "--fork",
        "--mount-proc",
        "bash",
        "-c",
        `${PROC_CLEANUP} ${SOCKET_CLEANUP} ${fsMounts} ${command}`,
      ],
      env: params.env,
    };
  }

  if (params.method === "userns-unshare") {
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
    return {
      bin: "unshare",
      args: [
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
      env: params.env,
    };
  }

  // sudo-unshare
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
  // after `su`, which needs its own setuid privileges; the unprivileged user
  // cannot drop the bounding set, but no_new_privs alone blocks every setuid path.
  const sealed = params.seal
    ? `exec setpriv --no-new-privs bash -c '${params.command.replace(/'/g, "'\\''")}'`
    : params.command;
  // the restore leads, so `setpriv` and `bash` resolve on it too (NixOS keeps both in the store)
  const escaped = (pathRestore + sealed).replace(/'/g, "'\\''");
  envArgs.push(`SANDBOX_PATH=${params.env.PATH ?? ""}`);
  return {
    bin: "sudo",
    args: [
      "env",
      ...envArgs,
      "unshare",
      "--pid",
      "--fork",
      "--mount-proc",
      "bash",
      "-c",
      `${PROC_CLEANUP} ${SOCKET_CLEANUP} ${fsMounts} exec su -p -s "$(command -v bash)" ${username} -c '${escaped}'`,
    ],
    // env passes through `sudo env K=V`, so the spawned process env carries only PATH:
    // sudoers without `secure_path` resolves `env` from it ("sudo: env: command not found").
    env: { PATH: params.env.PATH },
  };
}

/**
 * Run `git` (or a caller-chosen git binary) through the PID+mount-namespace
 * sandbox, synchronously, so a repo-planted hook / filter / config that fires on
 * the MCP server's own git call runs in a FRESH PID namespace — it cannot read
 * the action process's `/proc/<pid>/environ` (the OIDC mint ticket, the job
 * token, customer `env:` secrets) and sees only the caller's already-filtered
 * env. The git profile omits the `.git` read-only bind so commits still write
 * `.git`. The caller passes the detected `method` (already known non-"none") so
 * we never sandbox when no namespace is available.
 */
export function spawnGitSandboxedSync(params: {
  cmd: string;
  args: string[];
  env: Record<string, string | undefined>;
  cwd: string | undefined;
  encoding: BufferEncoding;
  maxBuffer: number;
  method: Exclude<SandboxMethod, "none">;
}): SpawnSyncReturns<string> {
  const invocation = buildSandboxInvocation({
    command: execCommand(params.cmd, params.args),
    seal: true,
    env: params.env,
    method: params.method,
    gitWritable: true,
  });
  return spawnSync(invocation.bin, invocation.args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: params.encoding,
    cwd: params.cwd,
    env: invocation.env,
    maxBuffer: params.maxBuffer,
  });
}

/**
 * Build a `(bin, args, env)` for an ASYNC caller (e.g. `action/utils/subprocess.ts`
 * `spawn`) that runs `cmd args` inside the sandbox, or `null` when no PID namespace
 * is available (the caller then runs `cmd`/`args` directly — where there is no
 * namespace there is also no agent shell to plant the config the sandbox defends
 * against). The dependency installer routes its `pnpm/npm install` through this so
 * repo `postinstall` scripts run in a fresh PID namespace (cannot read the action
 * process's /proc) with the already-filtered env. `.git` stays writable: hook
 * managers (husky's `prepare`, lefthook, `pre-commit install`) write `.git/config`
 * or `.git/hooks`, and the read-only bind failed them silently (npm still exits 0).
 */
export function buildSandboxedCommand(params: {
  cmd: string;
  args: string[];
  env: Record<string, string | undefined>;
}): { bin: string; args: string[]; env: Record<string, string | undefined> } | null {
  const method = detectSandboxMethod();
  if (method === "none") return null;
  return buildSandboxInvocation({
    command: execCommand(params.cmd, params.args),
    seal: true,
    env: params.env,
    method,
    gitWritable: true,
  });
}
