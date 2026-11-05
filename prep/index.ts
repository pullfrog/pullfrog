import { performance } from "node:perf_hooks";
import { log } from "../utils/cli.ts";
import { dirtyTrackedPaths, restoreDirtiedSince } from "../utils/worktree.ts";
import { installNodeDependencies } from "./installNodeDependencies.ts";
import { installPythonDependencies } from "./installPythonDependencies.ts";
import type { PrepDefinition, PrepOptions, PrepResult } from "./types.ts";

export type { PrepOptions, PrepResult } from "./types.ts";

// register all prep steps here
const prepSteps: PrepDefinition[] = [installNodeDependencies, installPythonDependencies];

/**
 * run all prep steps sequentially.
 * failures are logged as warnings but don't stop the run.
 */
export async function runPrepPhase(options: PrepOptions): Promise<PrepResult[]> {
  log.debug("» starting prep phase...");
  const startTime = performance.now();
  const results: PrepResult[] = [];

  // prep is non-mutating by contract; snapshot so any tracked drift from
  // lifecycle scripts can be attributed to prep and restored, even when a
  // step fails partway through.
  const preDirty = dirtyTrackedPaths();

  try {
    for (const step of prepSteps) {
      const shouldRun = await step.shouldRun();
      if (!shouldRun) {
        log.debug(`» skipping ${step.name} (not applicable)`);
        continue;
      }

      log.debug(`» running ${step.name}...`);
      const result = await step.run(options);
      results.push(result);

      if (result.dependenciesInstalled) {
        log.debug(`» ${step.name}: dependencies installed`);
      } else if (result.issues.length > 0) {
        log.warning(`» ${step.name}: ${result.issues[0]}`);
      }
    }
  } finally {
    // #906: frozen installs run package lifecycle scripts that rewrite tracked
    // generated files (the msw worker, etc.), and the resulting dirt makes
    // `checkout_pr` refuse for the rest of the run.
    restoreDirtiedSince({ before: preDirty, actor: "prep" });
  }

  const totalDurationMs = performance.now() - startTime;
  log.debug(`» prep phase completed (${Math.round(totalDurationMs)}ms)`);

  return results;
}
