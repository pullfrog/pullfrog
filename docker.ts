// run any node script inside the pullfrog local docker container that
// mocks the GHA `ubuntu-24.04` runner environment. NOT a real GitHub
// Actions runner — for the real thing, see `.github/workflows/*.yml`
// and `action/commands/gha.ts` (the action's GHA entry point).
//
// usage:
//   pnpm docker <script> [args…]    # run script in container
//   pnpm docker --shell             # interactive bash (requires TTY)
//   pnpm docker --build [--no-cache] # force-rebuild image
//   pnpm docker --clean             # prune orphan images/volumes
//   pnpm docker --doctor            # versions of every baked tool
//
// the action's two main entrypoints default to the host (fast iteration).
// `:docker` suffix wraps this script:
//   pnpm play [args…]               # host (this is the fast default)
//   pnpm play:docker [args…]        # === pnpm docker play.ts [args…]
//   pnpm runtest [filters…]         # host
//   pnpm runtest:docker [filters…]  # === pnpm docker test/run.ts [filters…]
//
// the container is a baked ubuntu:24.04 image (see Dockerfile) with the
// same toolset as GHA `ubuntu-24.04` runners. host env passes through
// verbatim — no allowlist. multi-line values (RSA keys) handled via -e
// fallback; everything else flows through `--env-file` for cleanliness.
//
// host services are reachable at `host.docker.internal:<port>` (works on
// both linux and macOS — see --add-host below).
//
// rebuild is content-hash gated on Dockerfile + docker-entrypoint.sh.
//
// design rationale + gaps: wiki/docker.md.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
const actionDir = __dirname;
const repoRoot = join(actionDir, "..");

config({ path: join(actionDir, ".env") });
config({ path: join(repoRoot, ".env") });

// host env vars that would actively conflict with the container's own
// configuration (paths, identity, shell, and outer-CI workflow-run identifiers
// that don't apply to whatever repo the harness is acting against). everything
// else passes through.
const HOST_ONLY_VARS = new Set([
  // paths / identity / shell — would clobber the container's testuser setup
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "OLDPWD",
  "TMPDIR",
  "TMP",
  "TEMP",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "_",
  "SHLVL",
  "PS1",
  "PS2",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TERM_SESSION_ID",
  "__CF_USER_TEXT_ENCODING",
  "XPC_SERVICE_NAME",
  "XPC_FLAGS",
  "Apple_PubSub_Socket_Render",
  "COMMAND_MODE",
  "COLORTERM",
  "ITERM_PROFILE",
  "ITERM_SESSION_ID",
  // nub preloads a module from the host's cache, which the container's node cannot find
  "NODE_OPTIONS",
  // outer-CI workflow-run identifiers — when the test suite runs inside
  // pullfrog/app's CI, these refer to pullfrog/app's run, NOT the test repo
  // the harness is acting against (e.g. pullfrog/test-repo). Anything inside
  // the action that uses them as keys to look up state on the test repo (most
  // notably `resolveRun()`'s `actions.listJobsForWorkflowRun(...)` call) will
  // 404. Filtering them here means the action sees them as undefined and
  // skips the lookup, instead of misdirecting it. `GITHUB_REPOSITORY` and
  // `GITHUB_TOKEN` are NOT filtered — those are genuinely needed inside.
  "GITHUB_RUN_ID",
  "GITHUB_RUN_NUMBER",
  "GITHUB_RUN_ATTEMPT",
  "GITHUB_JOB",
  "GITHUB_WORKFLOW",
  "GITHUB_ACTION",
  "GITHUB_REF",
  "GITHUB_SHA",
  "GITHUB_HEAD_REF",
  "GITHUB_BASE_REF",
  "GITHUB_TRIGGERING_ACTOR",
]);

type Args = {
  forceBuild: boolean;
  noCache: boolean;
  shell: boolean;
  clean: boolean;
  doctor: boolean;
  passthrough: string[];
};

/**
 * parses docker-level flags up to (but not including) the first positional
 * argument. anything after the first positional, or after a literal `--`,
 * passes through verbatim to the inner script. this prevents
 * `pnpm docker test/run.ts --build` from intercepting `--build` as a
 * docker flag.
 */
function parseArgs(argv: string[]): Args {
  const out: Args = {
    forceBuild: false,
    noCache: false,
    shell: false,
    clean: false,
    doctor: false,
    passthrough: [],
  };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--") {
      out.passthrough.push(...argv.slice(i + 1));
      return out;
    }
    if (a === "--build") out.forceBuild = true;
    else if (a === "--no-cache") {
      out.forceBuild = true;
      out.noCache = true;
    } else if (a === "--shell") out.shell = true;
    else if (a === "--clean") out.clean = true;
    else if (a === "--doctor") out.doctor = true;
    else if (a === "--help" || a === "-h") {
      showHelp();
      process.exit(0);
    } else {
      // first positional — script name and everything after passes through.
      out.passthrough.push(...argv.slice(i));
      return out;
    }
    i++;
  }
  return out;
}

function showHelp(): void {
  process.stdout.write(`Usage: pnpm docker <script> [args…]
       pnpm docker --shell
       pnpm docker --build [--no-cache]
       pnpm docker --clean
       pnpm docker --doctor

Run a node script inside the pullfrog local docker container that mocks
the GHA ubuntu-24.04 runner toolset (gh, jq, python3, sudo, +
build-essential / wget / xz / file). Host env passes through verbatim.
The host is reachable from inside the container at host.docker.internal
(useful for scripts that hit your local dev server).

The action's two main entrypoints have host (fast) and docker variants:
  pnpm play [args…]               # host — the fast default
  pnpm play:docker [args…]        # === pnpm docker play.ts [args…]
  pnpm runtest [filters…]         # host
  pnpm runtest:docker [filters…]  # === pnpm docker test/run.ts [filters…]

Options:
  --build      rebuild the current image (otherwise rebuilt automatically
               when Dockerfile or docker-entrypoint.sh content changes).
               on its own, builds and exits.
  --no-cache   pair with --build to also bust docker's layer cache;
               useful when an apt mirror or base image changed.
  --shell      drop into an interactive bash inside the container.
               requires a TTY.
  --clean      prune orphaned pullfrog-docker:* images and node_modules
               volumes whose hash doesn't match the current Dockerfile.
  --doctor     print version info for tools inside the container (node,
               pnpm, gh, jq, git, python3, ssh, …). useful for diagnosing
               "works in CI fails locally" or vice versa.
  -h, --help   show this message.

Pass-through:
  Anything after the first positional argument (or after a literal \`--\`)
  goes to the inner script verbatim. so \`pnpm docker test/run.ts --build\`
  passes \`--build\` to test/run.ts, not to docker.

Examples:
  pnpm docker play.ts
  pnpm docker play.ts --raw '{"prompt":"hi"}'
  pnpm docker test/run.ts smoke
  pnpm docker --shell
  pnpm docker --build              # build image, then exit
  pnpm docker --build --no-cache   # rebuild from scratch
  pnpm docker --clean              # reclaim disk from old image hashes
  pnpm docker --doctor             # fidelity audit
`);
}

function ensureDocker(): void {
  if (platform() === "win32") {
    fail("pnpm docker is not supported on native windows. use wsl2.");
  }
  const probe = spawnSync("docker", ["info"], { stdio: "ignore" });
  if (probe.status !== 0) {
    fail("docker is not running. start docker desktop and retry.");
  }
}

function fail(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

type ImageRef = { tag: string; volumeName: string };

function imageRefFor(ctx: { dockerfile: string; entrypoint: string }): ImageRef {
  const hash = createHash("sha256")
    .update(readFileSync(ctx.dockerfile))
    .update(readFileSync(ctx.entrypoint))
    .digest("hex")
    .slice(0, 12);
  return {
    tag: `pullfrog-docker:${hash}`,
    // version the volume by image hash so a stale node_modules cache from
    // an old image (e.g. different node major) can't poison a new image.
    volumeName: `pullfrog-docker-node-modules-${hash}`,
  };
}

/**
 * remove pullfrog-docker:* images and pullfrog-docker-node-modules-* volumes
 * whose hash doesn't match the current Dockerfile + entrypoint. each
 * Dockerfile/entrypoint edit creates a fresh hash and orphans the prior
 * pair; without periodic cleanup these accumulate (~600MB image + ~200MB
 * node_modules each).
 */
function cleanOrphans(currentRef: ImageRef): void {
  const imgList = spawnSync("docker", ["image", "ls", "--format", "{{.Repository}}:{{.Tag}}"], {
    encoding: "utf8",
  });
  const images = (imgList.stdout ?? "")
    .split("\n")
    .filter((s) => s.startsWith("pullfrog-docker:") && s !== currentRef.tag);
  if (images.length > 0) {
    process.stderr.write(`» removing ${images.length} orphan image(s): ${images.join(", ")}\n`);
    spawnSync("docker", ["image", "rm", "-f", ...images], { stdio: "inherit" });
  }
  const volList = spawnSync("docker", ["volume", "ls", "-q"], { encoding: "utf8" });
  const volumes = (volList.stdout ?? "")
    .split("\n")
    .filter((s) => s.startsWith("pullfrog-docker-node-modules-") && s !== currentRef.volumeName);
  if (volumes.length > 0) {
    process.stderr.write(`» removing ${volumes.length} orphan volume(s): ${volumes.join(", ")}\n`);
    spawnSync("docker", ["volume", "rm", ...volumes], { stdio: "inherit" });
  }
  if (images.length === 0 && volumes.length === 0) {
    process.stderr.write("» no orphans to clean (all matching current image hash)\n");
  }
}

function buildImageIfNeeded(ctx: {
  ref: ImageRef;
  force: boolean;
  noCache: boolean;
  dockerfile: string;
}): void {
  if (!ctx.force) {
    const inspect = spawnSync("docker", ["image", "inspect", ctx.ref.tag], { stdio: "ignore" });
    if (inspect.status === 0) return;
  }
  process.stderr.write(
    `» building ${ctx.ref.tag}${ctx.noCache ? " (--no-cache)" : ""} (one-time, ~30-60s)…\n`
  );
  const buildArgs = ["build", "-t", ctx.ref.tag, "-f", ctx.dockerfile];
  if (ctx.noCache) buildArgs.push("--no-cache");
  buildArgs.push(actionDir);
  const build = spawnSync("docker", buildArgs, { stdio: "inherit" });
  if (build.status !== 0) {
    fail("image build failed");
  }
}

/**
 * print versions of every tool we expect to be available, so contributors
 * can sanity-check fidelity with the GHA `ubuntu-24.04` runner when a test
 * passes locally but fails in CI (or vice versa).
 */
function runDoctor(ref: ImageRef): void {
  // multi-line bash script; spawnSync passes the whole thing as one argv
  // entry so there's no nested-shell quoting to worry about, and `do` is
  // not followed by a stray semicolon.
  const script = `set +e
echo '--- container ---'
grep -E '^(NAME|VERSION)=' /etc/os-release
echo "arch=$(uname -m)"

echo
echo '--- runtimes ---'
echo "node $(node --version)"
if cd /app/action 2>/dev/null; then
  echo "pnpm $(corepack pnpm --version)  (corepack-resolved from packageManager)"
else
  echo "pnpm $(pnpm --version)  (system fallback — /app/action not mounted?)"
fi
python3 --version

echo
echo '--- tools ---'
for t in gh jq git ssh curl wget tar gzip xz unzip file make gcc g++ sudo unshare awk sed grep find xargs; do
  if ! command -v "$t" >/dev/null 2>&1; then
    printf '  %-10s MISSING\\n' "$t"
    continue
  fi
  case "$t" in
    ssh|unzip) v=$("$t" -V 2>&1 | head -1) ;;
    *) v=$("$t" --version 2>&1 | head -1) ;;
  esac
  printf '  %-10s %s\\n' "$t" "$v"
done

echo
echo '--- env ---'
echo "CI=$CI HOME=$HOME TMPDIR=$TMPDIR"
echo "doctor runs as: $(whoami) (uid=$(id -u) gid=$(id -g))"
echo "tests run as:   testuser (uid remapped to host uid at entrypoint)"
echo "host.docker.internal -> $(getent hosts host.docker.internal | awk '{print $1}' || echo UNRESOLVED)"
`;
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "-v",
      `${actionDir}:/app/action:cached`,
      "--add-host=host.docker.internal:host-gateway",
      "--entrypoint",
      "/bin/bash",
      ref.tag,
      "-c",
      script,
    ],
    { stdio: "inherit" }
  );
  process.exit(result.status ?? 1);
}

function volumeExists(name: string): boolean {
  return spawnSync("docker", ["volume", "inspect", name], { stdio: "ignore" }).status === 0;
}

function initVolumeOwnership(ctx: { ref: ImageRef; uid: number; gid: number }): void {
  // a fresh named volume is owned by root; chown once on creation. on warm
  // runs the volume already has the right ownership and `docker run … chown`
  // is sub-second pure overhead — skip it.
  if (volumeExists(ctx.ref.volumeName)) return;
  spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--entrypoint",
      "chown",
      "-v",
      `${ctx.ref.volumeName}:/app/action/node_modules`,
      ctx.ref.tag,
      "-R",
      `${ctx.uid}:${ctx.gid}`,
      "/app/action/node_modules",
    ],
    { stdio: "ignore" }
  );
}

type EnvParts = { envFile: string; multiLineFlags: string[] };

function buildEnvParts(env: NodeJS.ProcessEnv): EnvParts {
  const dir = join(tmpdir(), "pullfrog-docker");
  mkdirSync(dir, { recursive: true });
  const envFile = join(dir, `env-${process.pid}-${Date.now()}.list`);
  const lines: string[] = [];
  const multiLineFlags: string[] = [];
  for (const key of Object.keys(env)) {
    if (HOST_ONLY_VARS.has(key)) continue;
    const value = env[key];
    if (value === undefined) continue;
    // docker --env-file is line-oriented and does not support multi-line
    // values. fall back to -e for those (RSA keys, multi-line PEMs, etc.).
    if (value.includes("\n") || value.includes("\r")) {
      multiLineFlags.push("-e", `${key}=${value}`);
    } else {
      lines.push(`${key}=${value}`);
    }
  }
  writeFileSync(envFile, `${lines.join("\n")}\n`, { mode: 0o600 });
  return { envFile, multiLineFlags };
}

function buildSshFlags(home: string | undefined): string[] {
  const flags: string[] = [];
  if (!home) return flags;
  if (platform() === "darwin") {
    const knownHosts = join(home, ".ssh", "known_hosts");
    if (existsSync(knownHosts)) {
      flags.push("-v", `${knownHosts}:/tmp/home/.ssh/known_hosts:ro`);
    }
    flags.push(
      "-v",
      "/run/host-services/ssh-auth.sock:/run/host-services/ssh-auth.sock",
      "-e",
      "SSH_AUTH_SOCK=/run/host-services/ssh-auth.sock"
    );
  } else {
    const sshDir = join(home, ".ssh");
    if (existsSync(sshDir)) {
      flags.push("-v", `${sshDir}:/tmp/.ssh-host:ro`);
    }
  }
  return flags;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  ensureDocker();

  const dockerfile = join(actionDir, "Dockerfile");
  const entrypoint = join(actionDir, "docker-entrypoint.sh");
  const ref = imageRefFor({ dockerfile, entrypoint });

  if (args.clean) {
    cleanOrphans(ref);
    if (!args.shell && !args.doctor && args.passthrough.length === 0 && !args.forceBuild) {
      process.exit(0);
    }
  }

  buildImageIfNeeded({ ref, force: args.forceBuild, noCache: args.noCache, dockerfile });

  if (args.doctor) {
    runDoctor(ref);
    // runDoctor exits; unreachable.
  }

  // standalone `--build`: image's done, nothing to run.
  if (!args.shell && args.passthrough.length === 0) {
    if (!args.forceBuild) {
      showHelp();
      process.exit(1);
    }
    process.exit(0);
  }

  // node sets isTTY to `true` for a terminal stdin, `undefined` otherwise
  // (never `false`). check truthiness, not equality.
  if (args.shell && !process.stdin.isTTY) {
    fail("--shell needs a TTY (stdin is not a terminal). run from an interactive shell.");
  }

  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  initVolumeOwnership({ ref, uid, gid });

  const envParts = buildEnvParts(process.env);
  const sshFlags = buildSshFlags(process.env.HOME);

  const runArgs: string[] = [
    "run",
    "--rm",
    // `--init` uses tini as PID 1, which forwards signals (SIGINT/SIGTERM)
    // to our entrypoint and reaps zombies. Without it, bash-as-PID-1
    // swallows Ctrl-C during the pre-exec warmup phase.
    "--init",
    args.shell ? "-it" : "-t",
    "--privileged",
    // make the host reachable from inside the container at a stable name
    // (macOS Docker Desktop bakes this in; the flag makes Linux match,
    // matters when scripts hit local dev servers like API_URL=
    // http://host.docker.internal:3100).
    "--add-host=host.docker.internal:host-gateway",
    "-v",
    `${actionDir}:/app/action:cached`,
    "-v",
    `${ref.volumeName}:/app/action/node_modules`,
    "-w",
    "/app/action",
    "--env-file",
    envParts.envFile,
    "-e",
    `HOST_UID=${uid}`,
    "-e",
    `HOST_GID=${gid}`,
    ...envParts.multiLineFlags,
    ...sshFlags,
    ref.tag,
  ];

  if (args.shell) {
    runArgs.push("--shell");
  } else {
    // resolve script paths relative to actionDir (matches `pnpm -C action`
    // mental model). absolute paths and bare flags pass through unchanged.
    const [script, ...rest] = args.passthrough;
    if (script === undefined) {
      fail("internal: passthrough empty");
    }
    runArgs.push("node", script, ...rest);
  }

  let exitCode = 1;
  try {
    const result = spawnSync("docker", runArgs, { stdio: "inherit" });
    exitCode = result.status ?? 1;
  } finally {
    try {
      unlinkSync(envParts.envFile);
    } catch {
      // best-effort; tmpdir is GC'd by the OS regardless.
    }
  }
  process.exit(exitCode);
}

const isDirectExecution = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (isDirectExecution) {
  main();
}
