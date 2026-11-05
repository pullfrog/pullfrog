// the PID+mount-namespace sandbox primitives, shared by the async shell path
// (action/mcp/shell.ts `spawnShell` / `runSandboxed`) and the sync MCP git path
// (action/utils/shell.ts `$`). changes here should be reflected in
// wiki/security.md and docs/security.mdx.
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { devNull, userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import {
  AGENT_BIN_DIR_RELPATH,
  HOOK_ASSET_TMPDIR_RELPATHS,
  OPENCODE_BIN_DIR_RELPATH,
} from "../agents/nativeFsDenies.ts";
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

/**
 * true when only root can change what `path` names: it, every parent and any symlink on the way
 * are root-owned and writable by nobody else. a sticky directory still protects its root-owned
 * entries, which is how `/nix/store` (1775) is laid out.
 */
function isRootControlled(path: string): boolean {
  try {
    const stat = lstatSync(path);
    if (stat.uid !== 0) return false;
    if (stat.isSymbolicLink()) {
      return (
        isRootControlled(dirname(path)) &&
        isRootControlled(resolve(dirname(path), readlinkSync(path)))
      );
    }
    const sticky = stat.isDirectory() && (stat.mode & 0o1000) !== 0;
    if ((stat.mode & 0o022) !== 0 && !sticky) return false;
    return dirname(path) === path || isRootControlled(dirname(path));
  } catch {
    return false;
  }
}

let rootControlledDirs: string[] | undefined;

/**
 * the PATH directories the sandboxed command cannot write, from the PATH the run started with. a
 * sticky parent is fine, but anyone can add a name to a sticky entry, and the setup shell looks
 * `mount` and `su` up on these, so the entry itself must be writable by root alone.
 */
function getRootControlledDirs(): string[] {
  rootControlledDirs ??= (process.env.PATH ?? "")
    .split(delimiter)
    .filter(
      (dir) => isAbsolute(dir) && isRootControlled(dir) && (statSync(dir).mode & 0o022) === 0
    );
  return rootControlledDirs;
}

/**
 * the absolute path of `name`, for anything run outside the namespace once the agent may have
 * planted a file. the sandboxed command can write PATH directories that sit ahead of `/usr/bin`
 * (`/usr/local/bin` is 777 on a GitHub-hosted runner), so a bare name runs whatever it put there.
 * resolving early is not enough, since the file can be replaced later: only location holds.
 * returns the path as found, not its realpath: a multicall binary dispatches on its own name.
 */
export function trustedBinary(name: string): string {
  const path = getRootControlledDirs()
    .map((dir) => join(dir, name))
    .find((candidate) => isRootControlled(candidate));
  if (!path) throw new Error(`no \`${name}\` on PATH in a directory only root can write`);
  return path;
}

/** the full PATH, restored for sandboxed commands, and the narrowed one it was swapped for. */
let fullPath: string | undefined;
let narrowedPath: string | undefined;

/**
 * from here on this process, and everything it starts outside the namespace, finds tools only where
 * the sandboxed command cannot write. a harness finds `git` and `rg` by name, Claude's gate and the
 * askpass script find `node`, and an install finds `tar`, all with the secrets in reach, so a planted
 * file in a writable PATH directory would run with them. sandboxed commands get the full PATH back
 * in `buildSandboxInvocation`, so they can still install there, as `pip install` does on most runners.
 *
 * `agent-bin` holds what may otherwise live only in such a directory, and every CLI we install. `node`
 * is a copy: a symlink follows whatever later replaces the original, and a hard link shares its inode,
 * leaving only the kernel's refusal to write to a running binary. `npm` and `npx` serve installs that
 * finish before the agent starts and a repo's own MCP servers, whose commands are not ours to pin. this
 * runs before the first sandboxed command, which could otherwise create these paths itself.
 */
export function narrowProcessPath(tempDir: string): void {
  if (process.env.CI !== "true" || process.platform !== "linux") return;
  const bin = join(tempDir, AGENT_BIN_DIR_RELPATH);
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(tempDir, OPENCODE_BIN_DIR_RELPATH), { recursive: true });
  copyFileSync(process.execPath, join(bin, "node"));
  const nodeDir = dirname(process.execPath);
  for (const name of ["npm", "npx"]) {
    if (existsSync(join(nodeDir, name))) symlinkSync(join(nodeDir, name), join(bin, name));
  }
  fullPath ??= process.env.PATH;
  narrowedPath = [bin, ...getRootControlledDirs()].join(delimiter);
  process.env.PATH = narrowedPath;
  // the same door by config: a harness's own `git` would run a hook a planted ~/.gitconfig names.
  // the sandbox's environment does not carry this, so a sandboxed git still reads the customer's.
  process.env.GIT_CONFIG_GLOBAL = devNull;
  // and by rc file: a `bash -c` on a socket stdin sources ~/.bashrc unless it is nested, and Claude
  // starts its gate that way on every tool call.
  process.env.SHLVL = "2";
}

/** the PATH a sandboxed command runs with: `path` with the narrowed part put back to the full one. */
function sandboxedPath(path: string): string {
  return narrowedPath && fullPath ? path.replace(narrowedPath, () => fullPath ?? "") : path;
}

/** `dir` first on sandboxed commands' PATH alone, for a tool only they run. */
export function prependSandboxedPath(dir: string): void {
  const path = fullPath ?? process.env.PATH ?? "";
  if (path.split(delimiter).includes(dir)) return;
  if (fullPath) fullPath = `${dir}${delimiter}${path}`;
  else process.env.PATH = `${dir}${delimiter}${path}`;
}

/** run `method`'s exact invocation, so a probe cannot pass where the real spawn would fail. */
function probeMethod(method: Exclude<SandboxMethod, "none">) {
  const invocation = buildSandboxInvocation({
    command: "true",
    seal: true,
    env: { PATH: process.env.PATH },
    method,
    // the `.git` bind would pin `resolveRepoRoot` before the workspace is settled
    gitWritable: true,
  });
  return spawnSync(invocation.bin, invocation.args, {
    env: invocation.env,
    timeout: 10_000,
    stdio: ["ignore", "ignore", "pipe"],
  });
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
  // each probe runs its branch's exact invocation, so a runner missing any part of
  // it falls through to the next method or the actionable CI-gate error instead of
  // failing every command.
  try {
    if (probeMethod("unshare").status === 0) {
      detectedSandboxMethod = "unshare";
      log.debug("PID namespace isolation enabled (unprivileged unshare)");
      return "unshare";
    }
  } catch {
    // continue to try sudo
  }

  // sudo unshare (works on GHA runners)
  try {
    if (probeMethod("sudo-unshare").status === 0) {
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
    const result = probeMethod("userns-unshare");
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
  } catch (error) {
    // no sandbox available: a required binary is missing or sits somewhere writable
    usernsProbeError = error instanceof Error ? error.message : String(error);
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
//   4. every directory from the tmpdir down to a sealed path, bound onto itself
//      (`sealedParentMounts`), then `cd "$PWD"`. the shell starts in the cwd
//      it inherited, which stays on the mount underneath anything bound over it
//      or above it, so without the `cd` a relative path walks past these binds.
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
function buildFsMounts(options: { gitWritable: boolean; shimWritable: boolean }): string {
  return [
    sealedParentMounts(),
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
    options.shimWritable ? "" : shimMount(),
    hookMounts(),
    `cd "$PWD" 2>/dev/null;`,
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
 * `sealedParentMounts` stops the agent renaming an owned ancestor dir away. */
function hookMounts(): string {
  const tempDir = process.env.PULLFROG_TEMP_DIR;
  if (!tempDir) return "";
  return HOOK_ASSET_TMPDIR_RELPATHS.map((rel) => {
    const path = join(tempDir, rel).replace(/'/g, "'\\''");
    return `[ -e '${path}' ] && mount --bind '${path}' '${path}' 2>/dev/null && mount -o remount,bind,ro '${path}' 2>/dev/null;`;
  }).join(" ");
}

const SHIM_DIR_RELPATH = "pm-bin";

/**
 * a read-only bind does not stop the sealed command renaming a directory above it: the mount goes
 * with the rename, and the action process, in the other namespace, then finds whatever was put at
 * the old path. a mountpoint cannot be renamed or removed (EBUSY), so every directory down to a
 * sealed path is bound onto itself, parents first, from the first one whose parent only root can
 * write: the tmpdir under /tmp, higher where $TMPDIR is $RUNNER_TEMP. --rbind keeps what is mounted
 * below, and a userns refuses a plain bind of a tree holding locked mounts.
 */
function sealedParentMounts(): string {
  const tempDir = process.env.PULLFROG_TEMP_DIR;
  if (!tempDir) return "";
  const parents = [SHIM_DIR_RELPATH, ...HOOK_ASSET_TMPDIR_RELPATHS].flatMap((rel) => {
    const parts = rel.split("/");
    return parts.map((_, depth) => join(tempDir, ...parts.slice(0, depth)));
  });
  for (let dir = tempDir; dirname(dir) !== "/" && !isRootControlled(dirname(dir)); ) {
    dir = dirname(dir);
    parents.push(dir);
  }
  return [...new Set(parents)]
    .sort((a, b) => a.length - b.length)
    .map(shQuote)
    .map((dir) => `[ -d ${dir} ] && mount --rbind ${dir} ${dir} 2>/dev/null;`)
    .join(" ");
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
  const bind = `[ -e '${escaped}/.git' ] && mount --bind '${escaped}/.git' '${escaped}/.git' 2>/dev/null && mount -o remount,bind,ro '${escaped}/.git' 2>/dev/null;`;
  if (!gitDirId) return bind;
  // after the bind, which pins whatever it found: once a directory is mounted, a rename takes the mount with it
  return `${bind} [ "$(stat -L -c %d:%i '${escaped}/.git' 2>/dev/null)" = ${gitDirId} ] || { echo ${shQuote(CHECKOUT_MOVED)} >&2; exit 1; };`;
}

export const CHECKOUT_MOVED =
  "the checkout or a directory above it was moved during this run, so its .git can no longer be trusted";

let gitDirId: string | undefined;

function readGitDirId(): string | undefined {
  const gitDir = join(resolveRepoRoot(), ".git");
  const result = spawnSync("stat", ["-L", "-c", "%d:%i", gitDir], { encoding: "utf-8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** called once the checkout exists, ahead of the setup hook and installs, which run repo code. */
export function recordGitDir(): void {
  gitDirId ??= readGitDirId();
}

/**
 * the `.git` bind goes with a rename of any directory above it, leaving the next shell free to write
 * the real one, and whatever is then put at the old path is what `$git` and a harness's own `git`
 * find. binding those directories too would stop the rename, but it makes the checkout its own mount,
 * and pnpm then moves its store into the checkout (wiki/security.md). so what uses `.git` next refuses
 * one that is no longer the one recorded.
 */
export function checkoutMoved(): boolean {
  return gitDirId !== undefined && readGitDirId() !== gitDirId;
}

/** read-only bind for the corepack shim dir, or "" when this run has no tmpdir. */
function shimMount(): string {
  const tempDir = process.env.PULLFROG_TEMP_DIR;
  if (!tempDir) return "";
  const dir = join(tempDir, SHIM_DIR_RELPATH).replace(/'/g, "'\\''");
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
  shimWritable?: boolean;
}): { bin: string; args: string[]; env: Record<string, string | undefined> } {
  const bash = trustedBinary("bash");
  const setpriv = shQuote(trustedBinary("setpriv"));
  const unshare = trustedBinary("unshare");
  // everything ahead of the seal runs on PATH directories the command cannot write. stdin closes
  // first because bash sources ~/.bashrc when stdin is a socket, as node's default pipe is, and
  // `su` starts a bash of its own that cannot be handed --norc.
  const setup =
    `exec </dev/null; export PATH=${shQuote(getRootControlledDirs().join(delimiter))}; ` +
    `${PROC_CLEANUP} ${SOCKET_CLEANUP} ${buildFsMounts({ gitWritable: params.gitWritable, shimWritable: params.shimWritable ?? false })}`;
  // the command's own PATH comes back only inside the seal
  const command = params.env.PATH
    ? `export PATH=${shQuote(sandboxedPath(params.env.PATH))}; ${params.command}`
    : params.command;
  const sealedBash = `${shQuote(bash)} -c ${shQuote(command)}`;

  if (params.method === "unshare") {
    // the job itself is root here, so sealing must drop capabilities, not just
    // block setuid — the same seal as the userns branch below.
    const sealed = params.seal
      ? `exec ${setpriv} ${DROP_ALL_PRIVS.join(" ")} ${sealedBash}`
      : command;
    return {
      bin: unshare,
      args: ["--pid", "--fork", "--mount-proc", bash, "--norc", "-c", `${setup} ${sealed}`],
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
    return {
      bin: unshare,
      args: [
        "--user",
        "--map-root-user",
        "--pid",
        "--fork",
        "--mount",
        bash,
        "--norc",
        "-c",
        `${setup} exec ${setpriv} ${DROP_ALL_PRIVS.join(" ")} ${sealedBash}`,
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
  // after `su`, which needs its own setuid privileges; the unprivileged user
  // cannot drop the bounding set, but no_new_privs alone blocks every setuid path.
  const sealed = params.seal ? `exec ${setpriv} --no-new-privs ${sealedBash}` : command;
  return {
    bin: trustedBinary("sudo"),
    args: [
      trustedBinary("env"),
      ...envArgs,
      unshare,
      "--pid",
      "--fork",
      "--mount-proc",
      bash,
      "--norc",
      "-c",
      `${setup} exec su -p -s ${shQuote(bash)} ${username} -c ${shQuote(sealed)}`,
    ],
    // env passes through `sudo env K=V`, and every binary is absolute, so sudo needs no PATH.
    env: {},
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
 * Build the `spawn` options for an ASYNC caller (e.g. `action/utils/subprocess.ts`
 * `spawn`) that run `cmd args` inside the sandbox, or `cmd args` themselves when no PID
 * namespace is available (where there is no namespace there is also no agent shell to
 * plant the config the sandbox defends against). `shimWritable` lifts the read-only bind
 * on the corepack shim dir for `corepack enable`, the one command that writes it.
 * The dependency installer routes its `pnpm/npm install` through this so
 * repo `postinstall` scripts run in a fresh PID namespace (cannot read the action
 * process's /proc) with the already-filtered env. `.git` stays writable: hook
 * managers (husky's `prepare`, lefthook, `pre-commit install`) write `.git/config`
 * or `.git/hooks`, and the read-only bind failed them silently (npm still exits 0).
 */
export function buildSandboxedCommand(params: {
  cmd: string;
  args: string[];
  env: Record<string, string | undefined>;
  shimWritable?: boolean;
}): { cmd: string; args: string[]; env: Record<string, string | undefined> } {
  const method = detectSandboxMethod();
  if (method === "none") {
    const path = params.env.PATH;
    return {
      cmd: params.cmd,
      args: params.args,
      env: path ? { ...params.env, PATH: sandboxedPath(path) } : params.env,
    };
  }
  const invocation = buildSandboxInvocation({
    command: execCommand(params.cmd, params.args),
    seal: true,
    env: params.env,
    method,
    gitWritable: true,
    shimWritable: params.shimWritable ?? false,
  });
  return { cmd: invocation.bin, args: invocation.args, env: invocation.env };
}
