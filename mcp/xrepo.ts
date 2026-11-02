import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type } from "arktype";
import { ensureRepoState, type RepoAccess, repoKey } from "../toolState.ts";
import { log } from "../utils/cli.ts";
import { $git, WORKING_TREE_GIT_ENV } from "../utils/gitAuth.ts";
import { configureRepoGit } from "../utils/setup.ts";
import { $ } from "../utils/shell.ts";
import { resolveRepoCtx } from "./resolveRepoCtx.ts";
import type { ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";

// bare repo name guard — owner-implicit, rejects path traversal + flag-injection.
function assertValidRepoName(name: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith("-") || name.includes("..")) {
    throw new Error(
      `invalid repo name "${name}" — expected a bare repo name (no owner, no slashes)`
    );
  }
}

// GitHub repo names are case-insensitive; the access sets carry GitHub's
// canonical casing while the agent may pass any casing, so compare folded.
const eqName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function accessFor(ctx: ToolContext, name: string): RepoAccess {
  if (eqName(name, ctx.repo.name)) return "primary";
  if (ctx.xrepo?.write.some((w) => eqName(w, name))) return "write";
  return "read";
}

export const ListRepos = type({});

export function ListReposTool(ctx: ToolContext) {
  return tool({
    name: "list_repos",
    annotations: { readOnlyHint: true },
    description:
      "List the repositories available for cross-repo (`--xrepo`) work in this run, with each repo's access tier (primary, write, or read) and whether it's already checked out. " +
      "Use this before `checkout_repo` to discover what you can reference or edit. Returns an empty set on single-repo runs.",
    parameters: ListRepos,
    execute: execute(async () => {
      if (!ctx.xrepo) {
        return {
          repos: [],
          note: "this run is single-repo; cross-repo (--xrepo) was not requested.",
        };
      }
      const repos = ctx.xrepo.read.map((name) => ({
        owner: ctx.repo.owner,
        name,
        access: accessFor(ctx, name),
        checkedOut: ctx.toolState.repos.has(repoKey(ctx.repo.owner, name)),
      }));
      // repos the triggerer named but couldn't be granted — surface so the
      // agent can tell the user instead of silently working a narrowed set.
      const unavailable = ctx.xrepo.unavailable ?? [];
      if (unavailable.length > 0) {
        return {
          repos,
          count: repos.length,
          unavailable,
          note: `requested but not granted (unknown repo, different owner, or you lack access): ${unavailable.join(", ")}`,
        };
      }
      return { repos, count: repos.length };
    }),
  });
}

export const CheckoutRepo = type({
  repo: type.string.describe("bare repo name to check out (same owner as the primary repo)"),
});

export function CheckoutRepoTool(ctx: ToolContext) {
  return tool({
    name: "checkout_repo",
    description:
      "Clone a secondary repository (from this run's cross-repo access set) into a temporary working tree and return its absolute path. " +
      "Edit files there by absolute path; run cross-repo git/PR tools by passing `repo`. Read-tier repos are reference-only (no push). " +
      "Idempotent — re-checking-out a repo returns the existing path. Only repos shown by `list_repos` can be checked out.",
    parameters: CheckoutRepo,
    execute: execute(async ({ repo }) => {
      if (!ctx.xrepo) {
        throw new Error(
          "cross-repo is not enabled for this run (no --xrepo). call list_repos to confirm."
        );
      }
      assertValidRepoName(repo);
      const owner = ctx.repo.owner;

      if (eqName(repo, ctx.repo.name)) {
        return {
          path: process.cwd(),
          access: "primary" satisfies RepoAccess,
          note: "primary repo is already checked out at the working directory.",
        };
      }

      if (!ctx.xrepo.read.some((r) => eqName(r, repo))) {
        throw new Error(
          `repo "${repo}" is not in this run's cross-repo access set. call list_repos to see what's available.`
        );
      }

      const existing = ctx.toolState.repos.get(repoKey(owner, repo));
      if (existing) {
        return { path: existing.dir, access: existing.access, note: "already checked out." };
      }

      const access = accessFor(ctx, repo);
      const dir = join(ctx.tmpdir, "xrepo", repo);
      mkdirSync(dir, { recursive: true });

      // register state first so resolveRepoCtx routes the right token tier.
      const state = ensureRepoState(ctx.toolState, { owner, name: repo, dir, access });
      const rc = resolveRepoCtx(ctx, repo);

      // a failed clone must not satisfy the idempotency guard above, or a
      // retry would return the broken checkout as "already checked out".
      try {
        const info = await rc.octokit.rest.repos.get({ owner, repo });
        const defaultBranch = info.data.default_branch;
        state.defaultBranch = defaultBranch;
        const url = `https://github.com/${owner}/${repo}.git`;

        $("git", ["init", "-q"], { cwd: dir });
        $("git", ["remote", "add", "origin", url], { cwd: dir });
        await $git("fetch", ["--depth=1", "--no-tags", "origin", defaultBranch], {
          token: rc.gitToken,
          cwd: dir,
        });
        $("git", ["checkout", "-B", defaultBranch, "FETCH_HEAD"], {
          cwd: dir,
          env: WORKING_TREE_GIT_ENV,
        });

        await configureRepoGit({
          dir,
          owner,
          name: repo,
          gitToken: rc.gitToken,
          refreshGitToken: rc.refreshGitToken,
          octokit: rc.octokit,
          toolState: ctx.toolState,
          shell: ctx.payload.shell,
          postCheckoutScript: null,
          botLogin: ctx.botLogin,
          botUserId: ctx.botUserId,
        });

        log.info(`» checked out secondary repo ${owner}/${repo} (${access}) → ${dir}`);
        return { path: dir, access, defaultBranch };
      } catch (err) {
        ctx.toolState.repos.delete(repoKey(owner, repo));
        rmSync(dir, { recursive: true, force: true });
        throw err;
      }
    }),
  });
}
