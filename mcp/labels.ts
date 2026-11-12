import { type } from "arktype";
import { log } from "../utils/cli.ts";
import { assertNotReaderRun, assertOwnTarget } from "./currentObject.ts";
import type { ToolContext } from "./server.ts";
import { execute, getHttpStatus, tool } from "./shared.ts";

/**
 * a reader may add labels only to their own issue, which `autoLabelIssues` needs. a PR label can
 * gate fork code onto secrets ("safe to test"); an issue label can still fire an `issues: labeled`
 * workflow, but one running the default branch's code, which is the accepted trade.
 */
function assertReaderMayLabel(ctx: ToolContext, issueNumber: number): void {
  assertOwnTarget(ctx, issueNumber);
  if (ctx.payload.event.is_pr) assertNotReaderRun(ctx, "label a pull request");
}

export const AddLabelsParams = type({
  issue_number: type.number.describe("the issue or PR number to add labels to"),
  labels: type.string.array().atLeastLength(1).describe("array of label names to add"),
});

export function AddLabelsTool(ctx: ToolContext) {
  return tool({
    name: "add_labels",
    mutates: true,
    description:
      "Add labels to a GitHub issue or pull request. Only use labels that already exist in the repository.",
    parameters: AddLabelsParams,
    execute: execute(async ({ issue_number, labels }) => {
      assertReaderMayLabel(ctx, issue_number);
      const result = await ctx.octokit.rest.issues.addLabels({
        owner: ctx.repo.owner,
        repo: ctx.repo.name,
        issue_number,
        labels,
      });
      log.info(`» added labels [${labels.join(", ")}] to issue #${issue_number}`);

      return {
        success: true,
        labels: result.data.map((label) => label.name),
      };
    }),
  });
}

export const RemoveLabelsParams = type({
  issue_number: type.number.describe("the issue or PR number to remove labels from"),
  labels: type.string.array().atLeastLength(1).describe("array of label names to remove"),
});

export function RemoveLabelsTool(ctx: ToolContext) {
  return tool({
    name: "remove_labels",
    mutates: true,
    description:
      "Remove labels from a GitHub issue or pull request. Labels not currently applied are silently ignored.",
    parameters: RemoveLabelsParams,
    execute: execute(async (params) => {
      // a read-role issue author cannot remove a maintainer's label, so neither can their run
      assertNotReaderRun(ctx, "remove labels");
      // confirm the issue/PR exists first, so a wrong issue_number is a hard error
      // rather than a swallowed 404 that masquerades as success.
      await ctx.octokit.rest.issues.get({
        owner: ctx.repo.owner,
        repo: ctx.repo.name,
        issue_number: params.issue_number,
      });

      // removeLabel deletes one label per call; with the issue confirmed to exist, a
      // 404 here means the label simply wasn't applied — fine to ignore.
      const removed: string[] = [];
      for (const name of params.labels) {
        try {
          await ctx.octokit.rest.issues.removeLabel({
            owner: ctx.repo.owner,
            repo: ctx.repo.name,
            issue_number: params.issue_number,
            name,
          });
          removed.push(name);
        } catch (error) {
          if (getHttpStatus(error) !== 404) throw error;
        }
      }
      if (removed.length > 0) ctx.toolState.wasUpdated = true;
      log.info(`» removed labels [${removed.join(", ")}] from issue #${params.issue_number}`);

      return {
        success: true,
        removed,
      };
    }),
  });
}
