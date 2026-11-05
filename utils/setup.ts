import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@actions/core";
import type { ShellPermission } from "../external.ts";
import { requireRepoState, type ToolState } from "../toolState.ts";
import { log } from "./cli.ts";
import type { OctokitWithPlugins } from "./github.ts";
import { isInsideDocker } from "./globals.ts";
import { trustedBinary } from "./sandbox.ts";
import { saveSecretState } from "./secretCommands.ts";
import { $ } from "./shell.ts";

export interface SetupOptions {
  tempDir: string;
}

/** GHA state key for the per-run temp dir; `entryPost.ts` spells it literally. */
const TEMP_DIR_STATE = "temp_dir";

/**
 * Create a shared temp directory for the action, removed when the run's scope
 * exits. a persistent self-hosted runner never wipes `/tmp`, so every run used
 * to leave its tree (the OpenCode install alone is hundreds of MB) until the
 * disk filled and every job on the runner died.
 */
export function createTempDirectory(): { path: string; [Symbol.dispose]: () => void } {
  const path = mkdtempSync(join(tmpdir(), "pullfrog-"));
  process.env.PULLFROG_TEMP_DIR = path;
  log.info(`» created temp dir at ${path}`);
  // a cancelled run exits from its signal handler, which skips the disposer, so
  // the `post:` hook removes what it left. a GitHub-hosted VM is discarded anyway.
  const tracked = process.env.RUNNER_ENVIRONMENT !== "github-hosted";
  if (tracked) saveSecretState(TEMP_DIR_STATE, path);
  return {
    path,
    [Symbol.dispose]: () => {
      // cleared once removed, so a finished run skips the post hook's npm bootstrap.
      if (removeTempDirectory(path) && tracked) saveSecretState(TEMP_DIR_STATE, "");
    },
  };
}

/** the `post:` hook's half of `createTempDirectory`: removes the directory a cancelled run left. */
export function removeAbandonedTempDirectory(): void {
  const path = core.getState(TEMP_DIR_STATE);
  if (!path) return;
  log.info(`» removing temp dir left by an interrupted run at ${path}`);
  removeTempDirectory(path);
}

/**
 * best-effort: the disposer runs after the run's work has landed, so a throw
 * here would fail a green run. the agent's `HOME` is this directory, and Go
 * leaves its module cache read-only, so restore write bits before one retry.
 */
function removeTempDirectory(path: string): boolean {
  try {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      execFileSync(trustedBinary("chmod"), ["-R", "u+w", path], { env: {} });
      rmSync(path, { recursive: true, force: true });
    }
    log.debug(`» removed temp dir at ${path}`);
    return true;
  } catch (err) {
    log.warning(
      `» could not remove temp dir at ${path}: ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
}

/**
 * snapshot-and-delete the GHA runner's known credential leak surfaces inside
 * `$RUNNER_TEMP` before the agent spawns. without this, a shell-capable agent
 * can grep:
 *   - `_runner_file_commands/set_output_*` for `core.setOutput('token', ghs_…)`
 *     calls made by earlier composite-action steps (e.g.
 *     pullfrog/pullfrog/get-installation-token);
 *   - `<uuid>.sh` rendered step scripts whose `run: |` body embeds
 *     `${{ steps.token.outputs.token }}` literally (GHA expands BEFORE writing);
 *   - `git-credentials-*.config` written by `actions/checkout@v6` for the
 *     workflow GITHUB_TOKEN.
 *
 * the running bash process already has its own `.sh` open via fd, so the
 * unlink is safe — `unlink` removes the dirent, the kernel keeps reading.
 *
 * preserves every `_runner_file_commands/` file path the runner pre-allocated
 * for OUR step — `$GITHUB_OUTPUT`, `$GITHUB_ENV`, `$GITHUB_PATH`,
 * `$GITHUB_STATE`, `$GITHUB_STEP_SUMMARY`. those are read by the runner
 * AFTER we exit (or by our own `post:` hook), and wiping them would break
 * pullfrog's `result` output, `post:` state handoff, and job summary.
 *
 * silent no-op when `$RUNNER_TEMP` is unset (local dev, `pnpm play`).
 * per-file errors are tolerated — the runner may delete files between
 * our readdir and our unlink.
 */
export function wipeRunnerLeakSurface(): void {
  const runnerTemp = process.env.RUNNER_TEMP;
  if (!runnerTemp) return;

  const preserve = new Set<string>();
  for (const envVar of [
    "GITHUB_OUTPUT",
    "GITHUB_ENV",
    "GITHUB_PATH",
    "GITHUB_STATE",
    "GITHUB_STEP_SUMMARY",
  ]) {
    const path = process.env[envVar];
    if (!path) continue;
    try {
      preserve.add(realpathSync(path));
    } catch {
      // path may not exist yet — preserve the literal in case it gets created later
      preserve.add(path);
    }
  }

  const wiped: string[] = [];

  const tryUnlink = (path: string): void => {
    let resolved = path;
    try {
      resolved = realpathSync(path);
    } catch {
      // file may already be gone — fall through to unlink for the race-tolerant path
    }
    if (preserve.has(resolved) || preserve.has(path)) return;
    try {
      unlinkSync(path);
      wiped.push(path);
    } catch {
      // race-tolerant: file may have been deleted between readdir and unlink
    }
  };

  const listDir = (dir: string): string[] => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };

  const fileCommandsDir = join(runnerTemp, "_runner_file_commands");
  for (const entry of listDir(fileCommandsDir)) {
    tryUnlink(join(fileCommandsDir, entry));
  }

  for (const entry of listDir(runnerTemp)) {
    if (entry.endsWith(".sh") || /^git-credentials-.*\.config$/.test(entry)) {
      tryUnlink(join(runnerTemp, entry));
    }
  }

  if (wiped.length > 0) {
    log.info(`» wiped ${wiped.length} leak-surface file(s) from $RUNNER_TEMP`);
    log.debug(`» wiped paths: ${wiped.join(", ")}`);
  }
}

/**
 * Setup the test repository for running actions
 */
export function setupTestRepo(options: SetupOptions): void {
  const tempDir = options.tempDir;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error("GITHUB_REPOSITORY is required");
  log.info(`» cloning ${repo} into ${tempDir}...`);

  // use https with token in ci or when running inside docker
  if (process.env.CI || isInsideDocker) {
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    if (!token) {
      throw new Error("GITHUB_TOKEN or GH_TOKEN is required for https clone in ci or docker");
    }
    $("git", ["clone", `https://x-access-token:${token}@github.com/${repo}.git`, tempDir]);
  } else {
    $("git", ["clone", `git@github.com:${repo}.git`, tempDir]);
  }
}

/**
 * remove any `[includeIf ...]` entries from the local git config so that
 * actions/checkout-persisted credentials don't ride alongside ASKPASS-provided
 * auth for subsequent git operations.
 *
 * SECURITY: git config subsection values can contain arbitrary characters
 * including `$(...)` command substitutions, and `${IFS}` spacing tricks defeat
 * naive split-on-space filtering. we read keys via the `-z` (null-terminated)
 * output format and feed them to a spawn-array `git config --unset-all` so
 * the shell never interpolates key contents — closing the RCE path that a
 * string-interpolated `execSync(...)` would expose.
 */
export function removeIncludeIfEntries(repoDir: string): void {
  let configOutput: string;
  try {
    configOutput = $("git", ["config", "--local", "--get-regexp", "-z", "^includeif\\."], {
      cwd: repoDir,
      log: false,
    });
  } catch {
    log.debug("» no includeIf credential entries to remove");
    return;
  }
  const seen = new Set<string>();
  for (const entry of configOutput.split("\0")) {
    if (!entry) continue;
    // -z format: each entry is "<key>\n<value>". the key is up to the first newline.
    const nl = entry.indexOf("\n");
    const key = nl === -1 ? entry : entry.slice(0, nl);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    try {
      // `$` (not a shell string) so the key — which can contain arbitrary
      // characters including shell metacharacters and $() command substitutions
      // — stays one quoted argument and is never interpolated by a shell.
      // this is the load-bearing side of a9aa3b2b's injection fix.
      $("git", ["config", "--local", "--unset-all", key], { cwd: repoDir, log: false });
    } catch (error) {
      log.debug(
        `» failed to unset ${key}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (seen.size > 0)
    log.info(
      `» removed ${seen.size} includeIf credential ${seen.size === 1 ? "entry" : "entries"}`
    );
}

export interface GitContext {
  gitToken: string;
  /**
   * re-mint the git token when GitHub's git edge rejects the one we hold. the
   * fetch path had no re-mint at all, so `checkout_pr` died unrecoverably on a
   * bad token instance while `push_branch` recovered from the identical
   * failure. see #1115.
   */
  refreshGitToken?: ((stale: string) => Promise<string>) | undefined;
  owner: string;
  name: string;
  octokit: OctokitWithPlugins;
  toolState: ToolState;
  // shell permission level — controls hook and security behavior:
  //   enabled: full shell, hooks run, no restrictions
  //   restricted: MCP shell in stripped env, hooks run, token protection on auth ops
  //   disabled: no shell, hooks disabled globally, all code execution paths blocked
  shell: ShellPermission;
  postCheckoutScript: string | null;
  botLogin: string;
  botUserId: string;
}

export type SetupGitParams = GitContext;

/** GitContext plus an explicit working-tree directory (primary cwd or a
 * secondary clone under ctx.tmpdir/xrepo/<name>). */
export interface ConfigureRepoGitParams extends GitContext {
  dir: string;
}

/**
 * setup git configuration + authentication for the PRIMARY repo working tree
 * (process.cwd()). thin wrapper over configureRepoGit. preserves the existing
 * single-repo call shape in main.ts.
 */
export async function setupGit(params: SetupGitParams): Promise<void> {
  await configureRepoGit({ ...params, dir: process.cwd() });
}

/**
 * setup git configuration and authentication for a repository working tree at
 * `params.dir`. used for the primary repo (dir = cwd) and for secondary repos
 * cloned on demand by checkout_repo (dir = ctx.tmpdir/xrepo/<name>).
 * - configures git identity (user.email, user.name)
 * - sets up authentication via gitToken (minimal contents:write)
 * - records pushUrl + initialHead onto the repo's RepoToolState (must already
 *   be registered in toolState.repos)
 *
 * gitToken is a minimal-permission token (contents + workflows) used for git operations.
 * it is assumed to be potentially exfiltratable, so it has limited scope.
 */
export async function configureRepoGit(params: ConfigureRepoGitParams): Promise<void> {
  const repoDir = params.dir;
  const repoState = requireRepoState(params.toolState, params.owner, params.name);
  repoState.dir = repoDir;

  // 1. configure git identity
  log.info("» setting up git configuration...");
  try {
    // check current config - only set defaults if not configured or using generic bot
    let currentEmail = "";
    try {
      currentEmail = $("git", ["config", "user.email"], { cwd: repoDir, log: false });
    } catch {
      // not configured
    }

    const shouldSetDefaults =
      !currentEmail || currentEmail === "github-actions[bot]@users.noreply.github.com";

    if (shouldSetDefaults) {
      const email = `${params.botUserId}+${params.botLogin}@users.noreply.github.com`;
      $("git", ["config", "--local", "user.email", email], { cwd: repoDir, log: false });
      $("git", ["config", "--local", "user.name", params.botLogin], { cwd: repoDir, log: false });
      log.debug("» git user configured (using defaults)");
    } else {
      log.debug(`» git user already configured (${currentEmail}), skipping`);
    }

    // SECURITY: disable git hooks when shell is disabled to prevent code execution.
    // in restricted mode, hooks run in the stripped sandbox — that's fine.
    // in enabled mode, the agent has full shell anyway.
    // in disabled mode, hooks are the primary code-execution escape vector.
    if (params.shell === "disabled") {
      $("git", ["config", "--local", "core.hooksPath", "/dev/null"], { cwd: repoDir, log: false });
      log.debug("» git hooks disabled (shell=disabled)");
    }
  } catch (error) {
    // If git config fails, log warning but don't fail the action
    // This can happen if we're not in a git repo or git isn't available
    log.info(`Failed to set git config: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 2. setup authentication
  // remove existing git auth headers that actions/checkout might have set
  try {
    $("git", ["config", "--local", "--unset-all", "http.https://github.com/.extraheader"], {
      cwd: repoDir,
      log: false,
    });
    log.info("» removed existing authentication headers");
  } catch {
    log.debug("» no existing authentication headers to remove");
  }

  // remove includeIf entries that actions/checkout@v6 uses for credential persistence.
  // v6 stores credentials in an external file loaded via includeIf.gitdir, which our
  // --unset-all above doesn't catch. without this, stale credentials from actions/checkout
  // would be sent alongside ASKPASS-provided credentials.
  removeIncludeIfEntries(repoDir);

  // SECURITY: set origin URL without token - auth is injected via GIT_ASKPASS
  // in $git() calls. this prevents token leakage to git hooks and subprocesses.
  const originUrl = `https://github.com/${params.owner}/${params.name}.git`;
  $("git", ["remote", "set-url", "origin", originUrl], { cwd: repoDir });

  // `set-url` writes remote.origin.url only, but push_branch reads `get-url --push`, which
  // prefers a pre-existing remote.origin.pushurl and honours url.*.pushInsteadOf from the
  // runner's global config. --replace-all is exit-0 for absent, single- and multi-valued.
  $("git", ["config", "--local", "--replace-all", "remote.origin.pushurl", originUrl], {
    cwd: repoDir,
  });

  // initialize pushUrl to base repo - may be updated by checkout_pr for fork PRs
  repoState.pushUrl = originUrl;

  // disable credential helpers to prevent prompts and ensure clean auth state
  $("git", ["config", "--local", "credential.helper", ""], { cwd: repoDir });

  // pin the run-entry HEAD for the checkout_pr initial-branch invariant; see
  // captureInitialHead for the named-branch vs detached split and why it
  // matters (zed-industries/cloud 2026-05-18 cross-PR clobber shape).
  repoState.initialHead = captureInitialHead(repoDir);

  log.info("» git authentication configured");
}

/**
 * snapshot the current HEAD as either a branch name (when on a named branch)
 * or a literal SHA (when detached). used by setupGit to pin the run-entry
 * position and by checkout_pr to compare the live HEAD against it.
 *
 * splitting the two cases is load-bearing: `git rev-parse --abbrev-ref HEAD`
 * returns the sentinel string `"HEAD"` on detached entry — which is the
 * default `actions/checkout` state for `pull_request` events. storing that
 * raw string would make any future detached state (including a subagent's
 * `git checkout --detach <sha>`) compare equal.
 */
export function captureInitialHead(
  repoDir: string
): { kind: "branch"; name: string } | { kind: "detached"; sha: string } {
  try {
    const name = $("git", ["symbolic-ref", "--short", "HEAD"], {
      cwd: repoDir,
      log: false,
    }).trim();
    if (name) return { kind: "branch", name };
  } catch {
    // detached HEAD — fall through
  }
  const sha = $("git", ["rev-parse", "HEAD"], { cwd: repoDir, log: false }).trim();
  return { kind: "detached", sha };
}
