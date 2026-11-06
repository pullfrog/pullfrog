import { type } from "arktype";
import { log } from "../utils/cli.ts";
import { mirrorRolePermissions } from "../utils/roleMirror.ts";
import type { ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";

/**
 * Authority to act on the issue or PR this run was triggered on.
 *
 * GitHub's permission model has no object granularity, so "the author of an
 * issue may close that issue" is not expressible as a token scope — it has to
 * be enforced here. Two ways to hold it: the triggerer already has repo-wide
 * rights (triage and above, the same threshold that mints a `gh` token), or the
 * triggerer authored the object.
 *
 * The authorship half matters because a non-collaborator commenting
 * `@pullfrog close this` on someone ELSE's issue has no such authority — the
 * naive "is it the current object?" check would grant it.
 *
 * The REFUSAL branch is the security-relevant one, so it is the one an e2e run
 * has to exercise. Confirming the tool merely appears in the agent's tool list
 * proves registration, not authority.
 */
async function resolveCurrentObject(ctx: ToolContext) {
  const issueNumber = ctx.payload.event.issue_number;
  if (!issueNumber) {
    throw new Error("this run was not triggered on an issue or pull request");
  }

  if (mirrorRolePermissions(ctx.payload.event.authorPermission)) {
    return { issueNumber, isPr: ctx.payload.event.is_pr === true };
  }

  const issue = await ctx.octokit.rest.issues.get({
    owner: ctx.repo.owner,
    repo: ctx.repo.name,
    issue_number: issueNumber,
  });
  const author = issue.data.user?.login;
  const triggerer = ctx.payload.triggerer;
  if (!author || !triggerer || author.toLowerCase() !== triggerer.toLowerCase()) {
    throw new Error(
      `${triggerer ?? "the triggering user"} did not open #${issueNumber} and has no write access to ${ctx.repo.owner}/${ctx.repo.name}, so this run cannot change its state.`
    );
  }
  return { issueNumber, isPr: issue.data.pull_request !== undefined };
}

export const CloseCurrent = type({
  state_reason: type
    .enumerated("completed", "not_planned", "duplicate")
    .describe(
      "why it is being closed: 'completed' (resolved), 'not_planned' (won't fix, out of scope), or 'duplicate' (already tracked elsewhere). ignored for pull requests."
    ),
});

export function CloseCurrentTool(ctx: ToolContext) {
  return tool({
    name: "close_current",
    mutates: true,
    description:
      "Close the issue or pull request this run was triggered on. " +
      'Example: `close_current({ state_reason: "duplicate" })`. ' +
      "Comment first to explain the decision — closing alone is opaque to the author.",
    parameters: CloseCurrent,
    execute: execute(async (params) => {
      const target = await resolveCurrentObject(ctx);

      const result = target.isPr
        ? await ctx.octokit.rest.pulls.update({
            owner: ctx.repo.owner,
            repo: ctx.repo.name,
            pull_number: target.issueNumber,
            state: "closed",
          })
        : await ctx.octokit.rest.issues.update({
            owner: ctx.repo.owner,
            repo: ctx.repo.name,
            issue_number: target.issueNumber,
            state: "closed",
            state_reason: params.state_reason,
          });

      ctx.toolState.wasUpdated = true;
      log.info(`» closed #${target.issueNumber} (${params.state_reason})`);

      return {
        success: true,
        number: result.data.number,
        url: result.data.html_url,
        state: result.data.state,
      };
    }, "close_current"),
  });
}

export function ReopenCurrentTool(ctx: ToolContext) {
  return tool({
    name: "reopen_current",
    mutates: true,
    description: "Reopen the issue or pull request this run was triggered on.",
    execute: execute(async () => {
      const target = await resolveCurrentObject(ctx);

      const result = target.isPr
        ? await ctx.octokit.rest.pulls.update({
            owner: ctx.repo.owner,
            repo: ctx.repo.name,
            pull_number: target.issueNumber,
            state: "open",
          })
        : await ctx.octokit.rest.issues.update({
            owner: ctx.repo.owner,
            repo: ctx.repo.name,
            issue_number: target.issueNumber,
            state: "open",
          });

      ctx.toolState.wasUpdated = true;
      log.info(`» reopened #${target.issueNumber}`);

      return {
        success: true,
        number: result.data.number,
        url: result.data.html_url,
        state: result.data.state,
      };
    }, "reopen_current"),
  });
}
