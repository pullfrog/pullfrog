import type { AuthorPermission } from "../external.ts";
import type { GitHubAppPermissions } from "./github.ts";

/**
 * The token every shell gets for `gh`, whatever the triggerer's role. Read-only, so it
 * can reach no further than a reader of this repo already can, and a subagent
 * holding it can change nothing. See wiki/agent-github-access.md.
 */
export const shellTokenPermissions = {
  actions: "read",
  checks: "read",
  contents: "read",
  issues: "read",
  pull_requests: "read",
} as const satisfies GitHubAppPermissions;

/**
 * The installation-token permission set that mirrors the triggering user's own
 * repository role, or `null` when the role sits below the threshold at which
 * the agent is handed a GitHub CLI credential at all.
 *
 * The invariant this exists to hold: **a leaked run token must never grant more
 * than the triggering user already has on that repo.** `gh` can print its own
 * credential (`gh auth token`), dump it via `GH_DEBUG=api`, and reach arbitrary
 * code through aliases and extensions, so containment is not achievable and is
 * not attempted — correct scoping plus revocation at run end is what makes a
 * leak survivable. See wiki/agent-github-access.md.
 *
 * The mirror is exact from `triage` up. At `read`/`none` no permission set
 * expresses "comment, and act only on objects you authored", because GitHub
 * permissions have no object granularity — so those runs get no token and use
 * the object-scoped MCP tools instead.
 *
 * `role` is the triggerer's EFFECTIVE permission on THIS repo, and where it
 * came from is deliberately not asked. `getCollaboratorPermissionLevel` already
 * folds direct grants, team grants and the org base permission into one answer,
 * so an org member who is `write` org-wide and a user with a single direct
 * grant resolve identically — which is correct, because on this repo they can
 * do the same things. Nothing in the action queries org membership.
 *
 * The token is then scoped to the current repo UNCONDITIONALLY: `resolveTokens`
 * passes no `repos`, and `acquireTokenViaOIDC` always appends
 * `$GITHUB_REPOSITORY`, so the list is exactly `[this repo]` even when the
 * triggerer holds org-wide admin over hundreds. That asymmetry is deliberate
 * margin — the invariant is "never MORE than the user has", and one repo out of
 * many satisfies it with room to spare.
 *
 * The set is a strict SUBSET of what any qualifying role holds, so the mirror
 * is one-directional by construction — it can never over-grant:
 *
 * - `contents` is **never** `write`, at any tier. That is what keeps the repo's
 *   `push` setting meaningful (a `push: "disabled"` repo must not receive a
 *   write credential by another door) and what keeps `gh pr merge` and
 *   `gh api` ref writes structurally unavailable — merging is authorized by
 *   `contents:write`, so withholding it is what makes
 *   wiki/autonomous-maintenance.md's "no injected instruction can cause a
 *   merge" still true. Legitimate pushes go through `push_branch`, which
 *   enforces the branch rules.
 * - `checks` is `read`, never `write`, for the same class of reason: every role
 *   can read a PR's check runs, but no human role can write one, and write would
 *   let the agent post its own passing `pullfrog-approval` status
 *   (see wiki/review-approval.md).
 * - Every qualifying role therefore receives the SAME set. The role decides
 *   whether a token is minted at all, not how wide it is — `admin`, `maintain`
 *   and `write` could not be told apart anyway, because everything that
 *   separates them needs the `administration` permission the app deliberately
 *   does not request (see wiki/app-permissions.md).
 */
export function mirrorRolePermissions(
  role: AuthorPermission | undefined
): GitHubAppPermissions | null {
  switch (role) {
    case "admin":
    case "maintain":
    case "write":
    case "triage":
      return { checks: "read", contents: "read", issues: "write", pull_requests: "write" };
    case "read":
    case "none":
    case undefined:
      return null;
    default:
      return role satisfies never;
  }
}

/** render a permission set as `contents:write, issues:write` for logs and the prompt. */
export function formatPermissions(permissions: GitHubAppPermissions): string {
  return Object.entries(permissions)
    .map((entry) => entry.join(":"))
    .join(", ");
}
