import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type } from "arktype";
import { log } from "../utils/cli.ts";
import { formatFilesWithLineNumbers } from "./checkout.ts";
import type { ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";

export const CommitInfo = type({
  sha: type.string.describe("the commit SHA, branch, or tag to fetch"),
});

export function CommitInfoTool(ctx: ToolContext) {
  return tool({
    name: "get_commit_info",
    description:
      "Retrieve commit metadata and diff via GitHub API. Use this instead of git show for reviewing commits - " +
      "it works with shallow clones and shows the actual changes in the commit. Returns diffPath pointing to formatted diff file. " +
      'Example: `get_commit_info({ sha: "2a6ab5d" })`.',
    parameters: CommitInfo,
    execute: execute(async ({ sha }) => {
      const response = await ctx.octokit.rest.repos.getCommit({
        owner: ctx.repo.owner,
        repo: ctx.repo.name,
        ref: sha,
      });

      const data = response.data;
      const files = data.files ?? [];

      // format diff with line numbers and write to file
      const formatResult = formatFilesWithLineNumbers(files);
      const tempDir = process.env.PULLFROG_TEMP_DIR;
      if (!tempDir) {
        throw new Error(
          "PULLFROG_TEMP_DIR not set - get_commit_info must run in pullfrog action context"
        );
      }
      // named from the resolved SHA: the input may be a branch like `chore/x` (#1577)
      const diffFile = join(tempDir, `commit-${data.sha.slice(0, 7)}.diff`);
      writeFileSync(diffFile, formatResult.content);
      log.debug(`wrote commit diff to ${diffFile} (${formatResult.content.length} bytes)`);

      return {
        sha: data.sha,
        message: data.commit.message,
        author: data.author?.login ?? null,
        committer: data.committer?.login ?? null,
        date: data.commit.author?.date ?? data.commit.committer?.date ?? "",
        url: data.html_url,
        parents: data.parents.map((p) => p.sha),
        stats: {
          additions: data.stats?.additions ?? 0,
          deletions: data.stats?.deletions ?? 0,
          total: data.stats?.total ?? 0,
        },
        fileCount: files.length,
        diffFile,
      };
    }),
  });
}
