import {
  CLAUDE_PRETOOL_GATE_FILENAME,
  CLAUDE_SETTINGS_FILENAME,
  CLAUDE_STOP_HOOK_FILENAME,
} from "./claudePretoolGate.ts";

// Canonical native-FS-tool deny set shared by the OpenCode and Claude harnesses.
//
// The agent's NATIVE FS tools (Read/Write/Edit/Glob/Grep) run in the agent
// process OUTSIDE the bash mount-namespace sandbox (FS_MOUNTS in
// action/mcp/shell.ts), so they need an independent deny — without it a
// prompt-injected agent could plant a git filter or hook via the native edit
// tool, bypassing the shell sandbox entirely. See wiki/security.md "Native
// Tool Filesystem Sandbox".
//
// WRITES are denied across ALL of .git, READS only on .git/config:
//   - nothing legitimately WRITES under .git via native tools — real commits
//     go through the MCP git tools, which run in the action process OUTSIDE
//     this permission gate. so a blanket write-deny is free, and it robustly
//     covers every code-exec surface an enumerated list would miss:
//     .git/config, .git/config.worktree, .git/modules/*/config (all carry the
//     same core.hooksPath / clean+smudge filter / alias / credential.helper
//     exec vectors) plus .git/hooks/* and .git/info/attributes. the deny also
//     covers the `.git` gitfile itself and nested `*/.git` gitfiles (worktree /
//     submodule layouts), whose `gitdir:` pointer is the same exec surface.
//   - READS stay narrow (.git/config only) because over-blocking .git reads
//     would break legit native orientation reads (.git/HEAD, refs), and the
//     read threat is low — ASKPASS keeps live tokens out of .git/config.
//
// The two agents express denies differently, so the surfaces are encoded once
// here and formatted per-agent:
//   - OpenCode: worktree-relative patterns under the per-tool `read`/`edit`
//     permission keys (Wildcard dialect: `*` is regex `.*`, matching `/`
//     recursively). The `external_directory` gate can't restrict within-project
//     paths (it short-circuits inside the repo root via Instance.containsPath),
//     and the `grep`/`glob` permissions match the search pattern rather than a
//     filepath — so only `read` and `edit` can path-deny within the project.
//   - Claude: gitignore-style globs (`**` = recursive) per (tool, path) in
//     managed-settings `permissions.deny`.

/** worktree-relative blanket WRITE deny for the entire `.git` tree, in
 * OpenCode Wildcard dialect (`*` compiles to regex `.*`, matching `/`
 * recursively — see packages/core/src/util/wildcard.ts). spread into the
 * `edit` ruleset after a `"*": "allow"` baseline — `evaluate` is
 * last-match-wins by key order, so the deny keys must follow the wildcard
 * allow.
 *
 * four patterns, because the root-anchored descendants glob only matches
 * paths under a root `.git` *directory* — it misses `.git` when it's a gitfile
 * (worktree / submodule layouts: a regular file whose `gitdir:` line redirects
 * git metadata) and misses nested gitfiles (a `.git` inside a subdirectory).
 * rewriting either pointer is the same code-exec surface (`core.hooksPath`,
 * clean/smudge filters, credential.helper) the blanket deny exists to seal, so
 * we cover the gitfile itself and any nested `.git` too. */
export const GIT_NATIVE_WRITE_DENY_OPENCODE: Record<string, "deny"> = {
  ".git": "deny",
  ".git/*": "deny",
  "*/.git": "deny",
  "*/.git/*": "deny",
};

/** worktree-relative narrow READ deny (`.git/config` only), in OpenCode
 * Wildcard dialect. spread into the `read` ruleset after the `"*": "allow"`
 * baseline. */
export const GIT_NATIVE_READ_DENY_OPENCODE: Record<string, "deny"> = {
  ".git/config": "deny",
};

/** native FS tools Claude exposes that can read or enumerate files. */
const CLAUDE_READ_TOOLS = ["Read", "Grep", "Glob"] as const;

/** Claude `permissions.deny` entries for the blanket `.git` WRITE deny —
 * mirrors {@link GIT_NATIVE_WRITE_DENY_OPENCODE}. `**` is recursive. the exact
 * `.git` entry plus the recursive-prefix gitfile entry cover the gitfile
 * pointer (root + nested) that the root-anchored descendants glob alone misses;
 * the recursive-prefix descendants entry covers nested gitdirs. */
export const GIT_NATIVE_WRITE_DENY_CLAUDE: string[] = [
  "Edit(.git)",
  "Edit(.git/**)",
  "Edit(**/.git)",
  "Edit(**/.git/**)",
];

/** Claude `permissions.deny` entries for the narrow `.git/config` READ deny,
 * one per read/enumerate tool — mirrors {@link GIT_NATIVE_READ_DENY_OPENCODE}. */
export const GIT_NATIVE_READ_DENY_CLAUDE: string[] = CLAUDE_READ_TOOLS.map(
  (tool) => `${tool}(.git/config)`
);

// Pullfrog-managed hook/gate/plugin scripts. They live in the per-run tmpdir
// (== the agent's HOME) and EXECUTE with the agent's full, secret-bearing
// environment — the Claude PreToolUse gate + Stop hook, and the OpenCode
// plugins. A prompt-injected agent that rewrites one to print the env exfils
// every secret, which a token-exfil run did in July 2026. The agent owns these
// files, so the no_new_privs shell seal does not stop a shell rewrite (no root
// needed); and the native FS tools run outside the shell sandbox entirely. So
// two independent seals, mirroring `.git`: a sandbox read-only bind on every
// asset (MCP shell, both agents — see buildFsMounts in action/mcp/shell.ts) and
// a native-tool deny (Claude settings deny / OpenCode external_directory deny).
// Nothing legitimately writes these at runtime: the action process writes them
// once before the agent starts, OUTSIDE the sandbox, so the binds never block
// our own writes.

/** Claude hook assets, relative to the per-run tmpdir (== HOME). */
export const CLAUDE_HOOK_ASSET_RELPATHS: readonly string[] = [
  CLAUDE_PRETOOL_GATE_FILENAME,
  CLAUDE_STOP_HOOK_FILENAME,
  CLAUDE_SETTINGS_FILENAME,
];

/** OpenCode auto-discovers every plugin in this dir (relative to tmpdir); seal
 * the whole dir so both bundled plugins and any future one are covered. */
export const OPENCODE_PLUGIN_DIR_RELPATH = ".config/opencode/plugin" as const;

/** every hook asset, tmpdir-relative — the read-only-bind set for the MCP
 * shell, which both agents share. dir entries bind recursively like `.git`. */
export const HOOK_ASSET_TMPDIR_RELPATHS: readonly string[] = [
  ...CLAUDE_HOOK_ASSET_RELPATHS,
  OPENCODE_PLUGIN_DIR_RELPATH,
];
