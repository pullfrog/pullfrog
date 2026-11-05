import { log } from "./cli.ts";
import { $ } from "./shell.ts";

/**
 * tracked paths with staged or unstaged modifications.
 *
 * `cwd` is not optional decoration: the CLI does NOT start inside the checkout.
 * `runCli.ts` launches it from a bootstrap tmpdir (published) or `actionRoot` (a
 * tarball action checkout with no `.git`), and `main.ts` only chdirs into the
 * repo later. A caller that runs before that chdir and relies on `process.cwd()`
 * gets `exit 129 — Not a git repository` and, since this throws, kills the run:
 * that is exactly what 0.1.54 did to every customer. Pass the repo dir.
 */
export function dirtyTrackedPaths(params: { cwd?: string } = {}): Set<string> {
  const output = $("git", ["diff", "--name-only", "HEAD"], {
    cwd: params.cwd ?? process.cwd(),
    log: false,
  });
  return new Set(output.split("\n").filter(Boolean));
}

/**
 * discard tracked-file mods that appeared since the `before` snapshot, so the
 * customer checkout is clean before agent tools run — any dirt makes
 * `checkout_pr` refuse for the rest of the run. paths already dirty at snapshot
 * time are left alone, and untracked files (`node_modules`, etc.) are never
 * touched.
 *
 * attribution is by WINDOW, not by writer: every tracked path dirtied while the
 * window was open gets reverted, whoever wrote it. a caller must therefore close
 * its window before the agent can write, or it will discard the agent's own work
 * (#1146 — background prep cannot make that guarantee).
 *
 * `actor` names the phase that owns the window and is what the log line blames.
 */
export function restoreDirtiedSince(params: {
  before: Set<string>;
  actor: string;
  cwd?: string;
}): void {
  const cwd = params.cwd ?? process.cwd();
  const dirtied = [...dirtyTrackedPaths({ cwd })].filter((path) => !params.before.has(path));
  if (dirtied.length === 0) return;
  let failed = false;
  $("git", ["restore", "--staged", "--worktree", "--", ...dirtied], {
    cwd,
    log: false,
    onError: (result) => {
      failed = true;
      log.warning(
        `» failed to restore ${dirtied.length} tracked file(s) modified by ${params.actor}: ${result.stderr.trim() || "(no stderr)"}`
      );
    },
  });
  if (failed) return;
  log.info(
    `» restored ${dirtied.length} tracked file(s) modified by ${params.actor}: ${dirtied.join(", ")}`
  );
}
