import { lstat, readlink } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./cli.ts";
import { $ } from "./shell.ts";

/**
 * commit creation via the GitHub REST git-database API (blob → tree → commit
 * → ref). commits created with an installation token and no custom
 * author/committer are signed server-side by GitHub and show as Verified —
 * this is how Dependabot, Renovate (platformCommit), and claude-code-action
 * satisfy "require signed commits" branch protection. design adapted from
 * anthropics/claude-code-action's github-file-ops server (MIT), with modes
 * read via lstat (their stat() call can never detect symlinks) and blob
 * content routed through `git hash-object` so clean filters and text/eol
 * normalization apply exactly as a local `git commit` would.
 */

const GITHUB_API = "https://api.github.com";

/** undocumented create-blob ceiling is ~40MiB per prior art
 * (IAreKyleW00t/verified-bot-commit); refuse before uploading so the agent
 * gets an actionable error instead of a proxy-level 413. */
const MAX_BLOB_BYTES = 30 * 1024 * 1024;

const BLOB_UPLOAD_CONCURRENCY = 8;

/** one working-tree change to include in an API commit. */
export type ChangedFile = { path: string; deleted: boolean };

/** paths from git plumbing are repo-root-relative regardless of cwd, and
 * monorepo runs chdir into payload.cwd — resolve fs access against the root. */
function getRepoRoot(): string {
  return $("git", ["rev-parse", "--show-toplevel"], { log: false }).trim();
}

async function gh(params: {
  token: string;
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: unknown;
}): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${GITHUB_API}${params.path}`, {
    method: params.method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${params.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: params.body === undefined ? null : JSON.stringify(params.body),
  });
  const text = await response.text();
  // proxy-level failures (413, secondary-limit blocks) can be HTML/plain text
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text.slice(0, 500);
  }
  return { status: response.status, json };
}

function ghError(method: string, path: string, result: { status: number; json: unknown }): Error {
  return new Error(`${method} ${path} failed (${result.status}): ${JSON.stringify(result.json)}`);
}

function isRetryable(status: number): boolean {
  return status === 403 || status === 429 || status >= 500;
}

/**
 * all working-tree changes vs HEAD: tracked changes (committed-to-index,
 * staged, and unstaged all collapse into `git diff HEAD`) plus untracked
 * files from `git status`. respects .gitignore. throws on unresolved
 * conflicts — the caller's guidance is to resolve and `git add` first.
 */
export function detectWorkingTreeChanges(): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>();
  const diff = $("git", ["diff", "--name-status", "--no-renames", "-z", "HEAD"], { log: false });
  const tokens = diff.split("\0").filter((t) => t.length > 0);
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const status = tokens[i];
    const path = tokens[i + 1];
    if (status === undefined || path === undefined) break;
    if (status === "U") {
      throw new Error(
        `'${path}' has unresolved merge conflicts. resolve the conflicts, stage the result with git add, then retry.`
      );
    }
    byPath.set(path, { path, deleted: status === "D" });
  }
  const porcelain = $("git", ["status", "--porcelain=v1", "-z", "-uall", "--no-renames"], {
    log: false,
  });
  for (const entry of porcelain.split("\0")) {
    // skip paths already seen via the diff: `git rm --cached <f>` reports the
    // path as both deleted (index) and untracked (worktree) — the deletion
    // entry alone reproduces the untrack-but-keep intent remotely.
    if (entry.startsWith("?? ") && !byPath.has(entry.slice(3))) {
      const path = entry.slice(3);
      byPath.set(path, { path, deleted: false });
    }
  }
  return [...byPath.values()];
}

/**
 * refuse content the API path cannot faithfully commit: git-lfs files (the
 * pointer would be committed without the lfs object upload that the git
 * pre-push hook performs) and directories (nested repositories / submodule
 * pointers). other clean filters are fine — blob content goes through
 * `git hash-object`, which applies them exactly like a local commit.
 */
export async function assertApiCommittable(files: ChangedFile[]): Promise<void> {
  const present = files.filter((f) => !f.deleted).map((f) => f.path);
  if (present.length === 0) return;
  const root = getRepoRoot();
  // absolute paths: check-attr resolves relative args against cwd, which is
  // payload.cwd in monorepo runs — not the repo root the paths come from
  const attrs = $(
    "git",
    ["check-attr", "filter", "-z", "--", ...present.map((p) => join(root, p))],
    { log: false }
  );
  const parts = attrs.split("\0");
  for (let i = 0; i + 2 < parts.length; i += 3) {
    if (parts[i + 2] === "lfs") {
      throw new Error(
        `'${parts[i]}' is tracked by git-lfs, which signed commits can't upload. remove it from the change set or ask the user to disable signed commits for this repo.`
      );
    }
  }
  for (const path of present) {
    const stat = await lstat(join(root, path));
    if (stat.isDirectory()) {
      throw new Error(
        `'${path}' is a directory (nested repository or submodule?) — signed commits only support files and symlinks.`
      );
    }
  }
}

/** upload one file as a blob and return its tree entry. content comes from
 * `git hash-object -w` + `cat-file blob`, so clean filters and text/eol
 * normalization match a local commit byte-for-byte (and the post-commit
 * resync leaves git status clean); modes come from lstat so executables
 * (100755) and symlinks (120000) round-trip correctly. */
async function createBlobEntry(params: {
  token: string;
  repoPath: string;
  repoRoot: string;
  path: string;
}): Promise<{ path: string; mode: string; type: "blob"; sha: string }> {
  const absPath = join(params.repoRoot, params.path);
  const stat = await lstat(absPath);
  if (stat.size > MAX_BLOB_BYTES) {
    throw new Error(
      `'${params.path}' is ${Math.round(stat.size / 1024 / 1024)}MB — too large for signed commits (the GitHub blob API rejects large uploads). use git-lfs for large assets or ask the user to disable signed commits for this repo.`
    );
  }
  let mode: string;
  let content: Buffer;
  if (stat.isSymbolicLink()) {
    mode = "120000";
    // read the link target as raw bytes — a UTF-8 round-trip would corrupt
    // non-UTF-8 targets and break the byte-exact guarantee
    content = await readlink(absPath, { encoding: "buffer" });
  } else {
    mode = stat.mode & 0o100 ? "100755" : "100644";
    const cleanSha = $("git", ["hash-object", "-w", "--", absPath], { log: false }).trim();
    // base64 because `$` hands back a trimmed string, which would corrupt the bytes
    content = Buffer.from(
      $("git", ["cat-file", "blob", cleanSha], {
        cwd: params.repoRoot,
        encoding: "base64",
        log: false,
      }),
      "base64"
    );
  }

  const path = `${params.repoPath}/git/blobs`;
  let result: { status: number; json: unknown } | undefined;
  for (const delayMs of [0, 1000, 3000]) {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    result = await gh({
      token: params.token,
      method: "POST",
      path,
      body: { content: content.toString("base64"), encoding: "base64" },
    });
    if (result.status === 201) {
      const blob = result.json as { sha: string };
      return { path: params.path, mode, type: "blob", sha: blob.sha };
    }
    if (!isRetryable(result.status)) break;
    log.info(`blob upload for ${params.path} got ${result.status}, retrying`);
  }
  if (!result) throw new Error(`POST ${path} failed`);
  throw ghError("POST", path, result);
}

/** intermittent 403s on ref updates ("Resource not accessible by
 * integration") are a known transient GitHub API failure mode — observed in
 * production by claude-code-action. retry those, 429, and 5xx with backoff. */
async function updateRefWithRetry(params: {
  token: string;
  repoPath: string;
  remoteBranch: string;
  sha: string;
}): Promise<void> {
  const path = `${params.repoPath}/git/refs/heads/${encodeBranchPath(params.remoteBranch)}`;
  let lastResult: { status: number; json: unknown } | undefined;
  for (const delayMs of [0, 1000, 3000]) {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    const result = await gh({
      token: params.token,
      method: "PATCH",
      path,
      body: { sha: params.sha, force: false },
    });
    if (result.status === 200) return;
    // 422 covers more than non-fast-forward (deleted ref, ruleset
    // rejections) — only emit the concurrent-push recovery when the body
    // says so; otherwise surface the raw error.
    if (result.status === 422) {
      const detail = JSON.stringify(result.json);
      if (/fast.forward/i.test(detail)) {
        throw new Error(
          `the remote branch '${params.remoteBranch}' moved while committing (concurrent push). ` +
            `fetch it with git_fetch, integrate with git merge --no-commit origin/${params.remoteBranch}, ` +
            `resolve any conflicts, git add the results, then retry commit_changes.`
        );
      }
      throw ghError("PATCH", path, result);
    }
    lastResult = result;
    if (!isRetryable(result.status)) break;
    log.info(`ref update got ${result.status}, retrying`);
  }
  if (lastResult) throw ghError("PATCH", path, lastResult);
  throw new Error(`PATCH ${path} failed`);
}

/** branch names land inside REST URL paths. reject anything git's own
 * check-ref-format forbids that could also confuse a URL or smuggle a
 * traversal, then percent-encode per segment (slashes stay literal). */
function encodeBranchPath(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

function validateRemoteBranch(branch: string): void {
  // SECURITY: a tampered branch config could otherwise retarget the REST
  // calls (e.g. heads/x/../../tags/v1 PATCHes a tag, bypassing the
  // push_tags permission gate).
  const bad =
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    /[\s~^:?*[\]\\]/.test(branch);
  if (bad) throw new Error(`invalid remote branch name '${branch}'`);
}

/**
 * create one GitHub-signed commit on `remoteBranch` containing `files` read
 * from the working tree, parented on `parents` (first parent supplies the
 * base tree; a second parent — MERGE_HEAD — makes it a true merge commit so
 * base-branch integration doesn't pollute the PR diff). empty `files` with
 * two parents concludes a merge that resolved to the first parent's tree.
 * creates the remote branch at the new commit when it doesn't exist yet.
 */
export async function createSignedCommit(params: {
  token: string;
  owner: string;
  repo: string;
  remoteBranch: string;
  message: string;
  parents: string[];
  files: ChangedFile[];
}): Promise<{ sha: string; createdBranch: boolean }> {
  validateRemoteBranch(params.remoteBranch);
  const repoPath = `/repos/${params.owner}/${params.repo}`;
  const branchPath = `${repoPath}/git/ref/heads/${encodeBranchPath(params.remoteBranch)}`;

  // freshness: when the branch exists remotely, its tip must be one of the
  // new commit's parents — otherwise we'd build on a stale base and the
  // non-fast-forward ref update below would reject anyway. failing here
  // gives the agent targeted recovery guidance before any upload work.
  const refResult = await gh({ token: params.token, method: "GET", path: branchPath });
  const branchExists = refResult.status === 200;
  if (branchExists) {
    const ref = refResult.json as { object: { sha: string } };
    const remoteTip = ref.object.sha;
    if (!params.parents.includes(remoteTip)) {
      throw new Error(
        isAncestorOfHead(remoteTip)
          ? `your local branch has commits that were never pushed — signed-commits mode can't push local commits. ` +
              `run git reset --mixed ${remoteTip} (keeps every change in the working tree), then retry commit_changes.`
          : `the remote branch '${params.remoteBranch}' has commits you don't have locally (tip ${remoteTip.slice(0, 7)}). ` +
              `fetch it with git_fetch, integrate with git merge --no-commit origin/${params.remoteBranch}, ` +
              `resolve any conflicts, git add the results, then retry commit_changes.`
      );
    }
  } else if (refResult.status !== 404) {
    throw ghError("GET", branchPath, refResult);
  }

  const baseParent = params.parents[0];
  if (!baseParent) throw new Error("createSignedCommit requires at least one parent");
  const baseTree = $("git", ["rev-parse", `${baseParent}^{tree}`], { log: false }).trim();

  let treeSha = baseTree;
  if (params.files.length > 0) {
    const repoRoot = getRepoRoot();
    const additions = params.files.filter((f) => !f.deleted);
    const blobEntries: Awaited<ReturnType<typeof createBlobEntry>>[] = [];
    for (let i = 0; i < additions.length; i += BLOB_UPLOAD_CONCURRENCY) {
      const chunk = additions.slice(i, i + BLOB_UPLOAD_CONCURRENCY);
      blobEntries.push(
        ...(await Promise.all(
          chunk.map((f) =>
            createBlobEntry({ token: params.token, repoPath, repoRoot, path: f.path })
          )
        ))
      );
    }
    const deletionEntries = params.files
      .filter((f) => f.deleted)
      .map((f) => ({ path: f.path, mode: "100644", type: "blob" as const, sha: null }));

    const treeResult = await gh({
      token: params.token,
      method: "POST",
      path: `${repoPath}/git/trees`,
      body: { base_tree: baseTree, tree: [...blobEntries, ...deletionEntries] },
    });
    if (treeResult.status !== 201) {
      throw wrapUnknownBaseError("POST", `${repoPath}/git/trees`, treeResult, params.remoteBranch);
    }
    treeSha = (treeResult.json as { sha: string }).sha;
  }

  // no author/committer fields: that's the documented condition for GitHub
  // to sign the commit server-side as the app (author = pullfrog[bot]).
  const commitResult = await gh({
    token: params.token,
    method: "POST",
    path: `${repoPath}/git/commits`,
    body: { message: params.message, tree: treeSha, parents: params.parents },
  });
  if (commitResult.status !== 201) {
    throw wrapUnknownBaseError(
      "POST",
      `${repoPath}/git/commits`,
      commitResult,
      params.remoteBranch
    );
  }
  const commit = commitResult.json as { sha: string };

  if (branchExists) {
    await updateRefWithRetry({
      token: params.token,
      repoPath,
      remoteBranch: params.remoteBranch,
      sha: commit.sha,
    });
  } else {
    const createResult = await gh({
      token: params.token,
      method: "POST",
      path: `${repoPath}/git/refs`,
      body: { ref: `refs/heads/${params.remoteBranch}`, sha: commit.sha },
    });
    if (createResult.status !== 201) {
      throw ghError("POST", `${repoPath}/git/refs`, createResult);
    }
  }

  return { sha: commit.sha, createdBranch: !branchExists };
}

function isAncestorOfHead(sha: string): boolean {
  try {
    $("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { log: false });
    return true;
  } catch {
    return false;
  }
}

/** tree/commit creation 404/422s usually mean the base tree or parent isn't
 * on the remote — i.e. the agent created local commits, which this mode
 * can't push. attach the recovery instead of a bare API error. */
function wrapUnknownBaseError(
  method: string,
  path: string,
  result: { status: number; json: unknown },
  remoteBranch: string
): Error {
  if (result.status === 404 || result.status === 422) {
    return new Error(
      `${ghError(method, path, result).message}\n\n` +
        `this usually means your local branch has commits that were never pushed — signed-commits mode can't push local commits. ` +
        `run git reset --mixed origin/${remoteBranch} (or the commit you branched from; this keeps every change in the working tree), then retry commit_changes.`
    );
  }
  return ghError(method, path, result);
}
