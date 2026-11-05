// in-process fixture runner used by `play.ts` (and any future host-side
// runner). does NOT know about Docker — that's `docker.ts`'s job. when run
// inside the local docker container, this is what executes after the entrypoint.
import { execFileSync, execSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentResult } from "../agents/shared.ts";
import { type Inputs, main } from "../main.ts";
import { log } from "./cli.ts";
import { ensureGitHubToken } from "./github.ts";
import { trustedBinary } from "./sandbox.ts";
import { setupTestRepo } from "./setup.ts";
import { $ } from "./shell.ts";

export async function run(inputsOrPrompt: Inputs | string): Promise<AgentResult> {
  await ensureGitHubToken();

  // play.ts is a CI-emulator — isolate it from the developer's user- and
  // system-scope gitconfig so checks like `validatePushDestination` see the
  // raw stored remote URL instead of values mutated by `url.*.insteadOf`
  // rewrites (a common SSH-auth convenience on dev boxes). CI runners have
  // empty gitconfigs so this is a no-op there; locally it makes `pnpm play`
  // and real runs produce identical git state. `os.devNull` canonicalizes
  // the null device across Unix (`/dev/null`) and Windows (`\\.\nul`).
  process.env.GIT_CONFIG_GLOBAL = devNull;
  process.env.GIT_CONFIG_SYSTEM = devNull;

  const tempParent = await mkdtemp(join(tmpdir(), "pullfrog-play-"));
  const tempDir = join(tempParent, "repo");
  const originalCwd = process.cwd();

  try {
    setupTestRepo({ tempDir });

    // FIDELITY: production never starts `main()` inside the checkout. `runCli.ts`
    // launches the CLI from a fresh empty tmpdir (published path) or `actionRoot`
    // (a tarball action checkout with no `.git`), and only `payload.cwd` gets it
    // into the repo. Starting here from inside the repo hid a fatal bug: a
    // `git diff` added before that chdir passed every local test and then failed
    // 100% of production runs with "Not a git repository" (0.1.54).
    process.chdir(await mkdtemp(join(tmpdir(), "pullfrog-bootstrap-")));

    // optional pre-agent setup (e.g. seed symlinks for adversarial fixtures).
    if (process.env.PULLFROG_TEST_REPO_SETUP) {
      log.info("» running repo setup commands...");
      execSync(process.env.PULLFROG_TEST_REPO_SETUP, { cwd: tempDir, stdio: "pipe" });
    }

    // tell main() to use the cloned tempDir instead of the GHA workspace path.
    process.env.GITHUB_WORKSPACE = tempDir;

    const inputs: Inputs =
      typeof inputsOrPrompt === "string" ? { prompt: inputsOrPrompt } : inputsOrPrompt;

    for (const [key, value] of Object.entries(inputs)) {
      if (value !== undefined && value !== null) {
        process.env[`INPUT_${key.toUpperCase()}`] = String(value);
      }
    }

    const result: AgentResult = await main();
    // #1151 regression surface: the runtime must leave the checkout as it found
    // it, or `checkout_pr` refuses for the rest of the run and every Review
    // silently loses the authoritative diff. a fixture whose agent edits files
    // legitimately ends dirty, so this reports rather than fails — but a run
    // that dirties tracked files it did NOT mean to now says so out loud.
    const finalDirty = $("git", ["status", "--porcelain"], { cwd: tempDir, log: false });
    if (finalDirty) log.info(`» final worktree state (dirty):\n${finalDirty}`);
    process.chdir(originalCwd);

    if (result.success) {
      log.success("Action completed successfully");
      return { success: true, output: result.output || undefined, error: undefined };
    }
    log.error(`Action failed: ${result.error || "Unknown error"}`);
    return { success: false, error: result.error || undefined, output: undefined };
  } catch (err) {
    const errorMessage = (err as Error).message;
    log.error(`Error: ${errorMessage}`);
    return { success: false, error: errorMessage, output: undefined };
  } finally {
    process.chdir(originalCwd);
    // sandbox isolation may create files with non-host ownership; rmSync
    // can't always delete those, so escalate.
    try {
      execFileSync(trustedBinary("sudo"), ["rm", "-rf", tempParent], { stdio: "ignore" });
    } catch {
      // best-effort cleanup.
    }
  }
}
