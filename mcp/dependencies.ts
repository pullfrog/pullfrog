import type { PrepOptions, PrepResult } from "../prep/index.ts";
import { runPrepPhase } from "../prep/index.ts";
import { packageManagerBinDir } from "../utils/packageManager.ts";
import type { ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";

/**
 * format prep results into agent-friendly message
 */
function formatPrepResults(results: PrepResult[]): string {
  if (results.length === 0) {
    return `No supported language detected in this repository (checked for package.json, requirements.txt, pyproject.toml, etc.).

Inspect the repository structure to determine how dependencies should be installed, then use shell to install them.`;
  }

  const lines: string[] = [];

  for (const result of results) {
    if (result.language === "unknown") {
      continue;
    }

    const langDisplay = result.language === "node" ? "Node.js" : "Python";

    if (result.dependenciesInstalled) {
      if (result.language === "node") {
        lines.push(
          `${langDisplay} dependencies installed successfully via ${result.packageManager}.`
        );
      } else if (result.language === "python") {
        lines.push(
          `${langDisplay} dependencies installed successfully via ${result.packageManager} (from ${result.configFile}).`
        );
      }
    } else {
      const errorMsg = result.issues.length > 0 ? result.issues.join("\n") : "unknown error";

      if (result.language === "node") {
        lines.push(`${langDisplay} dependency installation failed via ${result.packageManager}.

Error:
${errorMsg}

Use shell or other tools at your disposal to diagnose and resolve the issue, then install dependencies manually.`);
      } else if (result.language === "python") {
        lines.push(`${langDisplay} dependency installation failed via ${result.packageManager} (from ${result.configFile}).

Error:
${errorMsg}

Use shell or other tools at your disposal to diagnose and resolve the issue, then install dependencies manually.`);
      }
    }
  }

  if (lines.length === 0) {
    return `No supported language detected in this repository (checked for package.json, requirements.txt, pyproject.toml, etc.).

Inspect the repository structure to determine how dependencies should be installed, then use shell to install them.`;
  }

  return lines.join("\n\n");
}

/**
 * start dependency installation in the background (non-blocking, idempotent).
 * called eagerly from main.ts at startup and also available via MCP tools.
 */
export function startInstallation(ctx: ToolContext): void {
  // already started or completed - do nothing
  if (ctx.toolState.dependencyInstallation) {
    return;
  }

  // SECURITY: when shell is disabled, suppress lifecycle scripts to prevent
  // agents from using package.json scripts as a backdoor for code execution
  const prepOptions: PrepOptions = {
    ignoreScripts: ctx.payload.shell === "disabled",
    binDir: packageManagerBinDir(ctx.tmpdir),
  };

  // initialize state and start installation
  const promise = runPrepPhase(prepOptions);
  ctx.toolState.dependencyInstallation = {
    status: "in_progress",
    promise,
    results: undefined,
  };

  // when promise completes, update state
  promise.then(
    (results) => {
      if (ctx.toolState.dependencyInstallation) {
        const hasFailure = results.some((r) => !r.dependenciesInstalled && r.issues.length > 0);
        ctx.toolState.dependencyInstallation.status = hasFailure ? "failed" : "completed";
        ctx.toolState.dependencyInstallation.results = results;
      }
    },
    () => {
      if (ctx.toolState.dependencyInstallation) {
        ctx.toolState.dependencyInstallation.status = "failed";
      }
    }
  );
}

export function StartDependencyInstallationTool(ctx: ToolContext) {
  return tool({
    name: "start_dependency_installation",
    mutates: true,
    description:
      "Start installing project dependencies in the background. This is non-blocking and returns immediately. Call this early (right after branch checkout) if you anticipate needing to run tests, builds, or other commands that require dependencies. Idempotent - safe to call multiple times.",
    execute: execute(async () => {
      const state = ctx.toolState.dependencyInstallation;

      // already completed
      if (state?.status === "completed" || state?.status === "failed") {
        return {
          status: state.status,
          message: `Dependency installation already completed.`,
          summary: formatPrepResults(state.results || []),
        };
      }

      // already in progress
      if (state?.status === "in_progress") {
        return {
          status: "in_progress",
          message:
            "Dependency installation is already in progress. Call await_dependency_installation when you need to use them.",
        };
      }

      // start installation
      startInstallation(ctx);

      return {
        status: "started",
        message:
          "Dependency installation started in background. Continue with other tasks and call await_dependency_installation when you need to run tests, builds, or other commands that require dependencies.",
      };
    }),
  });
}

export function AwaitDependencyInstallationTool(ctx: ToolContext) {
  return tool({
    name: "await_dependency_installation",
    description:
      "Wait for dependency installation to complete and get the results. If installation hasn't been started yet, this will start it automatically. Call this before running tests, builds, or other commands that require dependencies.",
    execute: execute(async () => {
      // auto-start if not started
      if (!ctx.toolState.dependencyInstallation) {
        startInstallation(ctx);
      }

      const state = ctx.toolState.dependencyInstallation;
      if (!state) {
        throw new Error("failed to initialize dependency installation state");
      }

      // if already completed, return cached results
      if (state.status === "completed" || state.status === "failed") {
        return {
          status: state.status,
          message: formatPrepResults(state.results || []),
        };
      }

      // await the promise
      if (!state.promise) {
        throw new Error("dependency installation state is corrupted - no promise found");
      }

      const results = await state.promise;

      return {
        status: state.status,
        message: formatPrepResults(results),
      };
    }),
  });
}
