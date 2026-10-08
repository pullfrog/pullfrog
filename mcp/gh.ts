import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type } from "arktype";
import { log } from "../utils/cli.ts";
import { formatPermissions, mirrorRolePermissions } from "../utils/roleMirror.ts";
import { filterEnvForUntrustedCode } from "../utils/secrets.ts";
import type { ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";
import { capOutput, runSandboxed } from "./shell.ts";

const GH_TIMEOUT_MS = 120_000;

export const GhParams = type({
  args: type.string
    .array()
    .describe(
      'gh arguments as an argv array, e.g. ["pr", "list", "--json", "number,title"] or ["api", "graphql", "-f", "query=..."]'
    ),
});

/** single-quote one argv element for `bash -c`, closing and reopening around any quote. */
function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * The GitHub CLI, authenticated with a token scoped to mirror the triggering
 * user's own repository role (see action/utils/roleMirror.ts).
 *
 * Registered only when that mirror yields a token — triage and above. Below
 * that the object-scoped tools are registered instead, because no GitHub
 * permission set can express "act only on the object you authored".
 *
 * There is deliberately NO subcommand allowlist. `gh auth token` prints its own
 * credential by design, `GH_DEBUG=api` dumps the Authorization header, and
 * aliases and extensions are general code execution — so containment of the
 * TOKEN is not achievable and is not attempted; correct scoping plus revocation
 * at run end is what makes a leak survivable.
 *
 * That last property is exactly why this runs through `runSandboxed` rather
 * than spawning directly: `gh alias set x '!<shell>'` is arbitrary code
 * execution, and outside the sandbox it would reach pullfrog-managed on-disk
 * secrets, the runner's workflow-command files and a writable `.git` — none of
 * which the token's scope bounds. Inside it, that capability is no more than
 * the `shell` tool already grants. See wiki/agent-github-access.md.
 */
export function GhTool(ctx: ToolContext) {
  const permissions = mirrorRolePermissions(ctx.payload.event.authorPermission);
  return tool({
    name: "gh",
    // denied to subagents. `shell` is deliberately unmarked because git is
    // blocked inside it, but `gh` reaches PR and issue state changes — the
    // shape of the 2026-05-18 cross-branch clobber the gate exists for.
    mutates: true,
    timeoutMs: GH_TIMEOUT_MS,
    description:
      `Run the GitHub CLI against ${ctx.repo.owner}/${ctx.repo.name}. ` +
      "Pass argv as an array — there is no shell, so pipes, redirects and `&&` do not work; " +
      "use gh's own `--json`/`--jq` flags instead. `gh api graphql` is available. " +
      `Authenticated with ${permissions ? formatPermissions(permissions) : "no permissions"} on this repo only; anything else 403s. ` +
      "Pushing, merging and ref writes are not available — use the git tools.",
    parameters: GhParams,
    execute: execute(async (params) => {
      // isolate from any gh config the runner already has: a self-hosted runner
      // can carry a real user's ~/.config/gh/hosts.yml, which we must not use.
      const configDir = join(ctx.tmpdir, "gh-config");
      mkdirSync(configDir, { recursive: true });

      const command = ["gh", ...params.args.map(shellQuote)].join(" ");
      const result = await runSandboxed({
        command,
        cwd: process.cwd(),
        timeout: GH_TIMEOUT_MS,
        // `gh` never needs root, and a shell alias would otherwise reach `sudo`
        seal: true,
        env: {
          ...filterEnvForUntrustedCode(),
          GH_TOKEN: ctx.ghToken,
          GH_CONFIG_DIR: configDir,
          GH_PROMPT_DISABLED: "1",
          GH_NO_UPDATE_NOTIFIER: "1",
        },
      });

      log.info(`» gh ${params.args.join(" ")} (exit ${result.exitCode})`);

      return {
        output: capOutput(result.output),
        exit_code: result.exitCode,
        timed_out: result.timedOut,
      };
    }, "gh"),
  });
}
