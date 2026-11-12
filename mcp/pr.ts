import { type } from "arktype";
import { buildPullfrogFooter, stripExistingFooter } from "../utils/buildPullfrogFooter.ts";
import { log } from "../utils/cli.ts";
import { fixDoubleEscapedString } from "../utils/fixDoubleEscapedString.ts";
import { patchWorkflowRunFields } from "../utils/patchWorkflowRunFields.ts";
import { $ } from "../utils/shell.ts";
import { assertNotReaderRun, assertOwnTarget } from "./currentObject.ts";
import { resolveRepoCtx } from "./resolveRepoCtx.ts";
import type { ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";

export const PullRequest = type({
  title: type.string.describe("the title of the pull request"),
  body: type.string.describe("the body content of the pull request"),
  base: type.string.describe("the base branch to merge into (e.g., 'main')"),
  "draft?": type.boolean.describe(
    "if true, create the pull request as a draft. use when the user explicitly asks for a draft PR."
  ),
  "repo?": type.string.describe(
    "cross-repo runs only: the writable secondary repo to open this PR on (bare name, from list_repos). omit to target the primary repo."
  ),
});

function buildPrBodyWithFooter(ctx: ToolContext, body: string): string {
  const footer = buildPullfrogFooter({
    triggeredBy: true,
    workflowRun: ctx.runId
      ? { owner: ctx.repo.owner, repo: ctx.repo.name, runId: ctx.runId, jobId: ctx.jobId }
      : undefined,
    model: ctx.toolState.model,
    clamped: ctx.toolState.modelClamped,
    unselectedProxyDefault: ctx.toolState.unselectedProxyDefault,
    oss: ctx.oss,
    owner: ctx.repo.owner,
  });

  const bodyWithoutFooter = stripExistingFooter(fixDoubleEscapedString(body));
  return `${bodyWithoutFooter}${footer}`;
}

export const UpdatePullRequestBody = type({
  pull_number: type.number.describe("the pull request number to update"),
  body: type.string.describe("the new body content for the pull request"),
});

export function UpdatePullRequestBodyTool(ctx: ToolContext) {
  return tool({
    name: "update_pull_request_body",
    mutates: true,
    description: "Update the body/description of an existing pull request",
    parameters: UpdatePullRequestBody,
    execute: execute(async (params) => {
      assertOwnTarget(ctx, params.pull_number);
      const bodyWithFooter = buildPrBodyWithFooter(ctx, params.body);

      const result = await ctx.octokit.rest.pulls.update({
        owner: ctx.repo.owner,
        repo: ctx.repo.name,
        pull_number: params.pull_number,
        body: bodyWithFooter,
      });
      log.info(`» updated pull request #${result.data.number}`);

      ctx.toolState.wasUpdated = true;

      return {
        success: true,
        number: result.data.number,
        url: result.data.html_url,
      };
    }),
  });
}

export function CreatePullRequestTool(ctx: ToolContext) {
  return tool({
    name: "create_pull_request",
    mutates: true,
    description: "Create a pull request from the current branch",
    parameters: PullRequest,
    execute: execute(async (params) => {
      assertNotReaderRun(ctx, "open a pull request");
      const rc = resolveRepoCtx(ctx, params.repo);
      if (rc.access === "read") {
        throw new Error(
          `cannot open a pull request on read-only repo ${rc.owner}/${rc.name} — it's reference-only in this run.`
        );
      }
      const currentBranch = $("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: rc.dir,
        log: false,
      });
      log.debug(`Current branch: ${currentBranch}`);

      const bodyWithFooter = buildPrBodyWithFooter(ctx, params.body);

      const result = await rc.octokit.rest.pulls.create({
        owner: rc.owner,
        repo: rc.name,
        title: params.title,
        body: bodyWithFooter,
        head: currentBranch,
        base: params.base,
        draft: params.draft ?? false,
      });
      log.info(`» created pull request ${rc.name}#${result.data.number} (id ${result.data.id})`);

      // best-effort: request review from the user who triggered the workflow
      const reviewer = ctx.payload.triggerer;
      if (reviewer) {
        try {
          log.debug(`requesting review from ${reviewer} on PR #${result.data.number}`);
          await rc.octokit.rest.pulls.requestReviewers({
            owner: rc.owner,
            repo: rc.name,
            pull_number: result.data.number,
            reviewers: [reviewer],
          });
        } catch {
          log.info(`failed to request review from ${reviewer} on PR #${result.data.number}`);
        }
      }

      // workflow-run linkage only tracks the PRIMARY repo's PR (the run lives there).
      if (
        rc.access === "primary" &&
        typeof result.data.node_id === "string" &&
        result.data.node_id.length > 0
      ) {
        await patchWorkflowRunFields(ctx, {
          prNodeId: result.data.node_id,
        });
      }

      return {
        success: true,
        pullRequestId: result.data.id,
        number: result.data.number,
        url: result.data.html_url,
        title: result.data.title,
        head: result.data.head.ref,
        base: result.data.base.ref,
      };
    }),
  });
}
