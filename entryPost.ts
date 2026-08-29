#!/usr/bin/env node
//
// GitHub Actions `post:` entry point. Runs after the main step regardless of
// exit status (cancellation, timeout, unhandled error) — that's the contract
// we need for credential persistence: if OpenCode refreshed the Codex
// auth.json during the run, the refreshed token must land back in Pullfrog
// even when the main step died unexpectedly.
//
// THIS IS WHY `CODEX_AUTH_JSON` HAS TO LIVE IN PULLFROG'S OWN SECRET STORE,
// NOT IN GITHUB ACTIONS SECRETS. The refresh chain rotates on every use; this
// hook PUTs the rotated chain back to Pullfrog Postgres so the next run starts
// from a fresh token. GH Actions secrets are read-only at runtime — there is
// no API to write them back from inside a job — so a token stashed there
// silently goes stale on the first refresh and the next run fails. See
// wiki/codex-auth.md.
//
// Today's only job: detect a Codex auth refresh by diffing the on-disk
// auth.json against the original refresh token (saved to GH Actions state
// by action/agents/opencode.ts — see also the legacy v1 file kept as
// reference at action/agents/opencode.ts), convert OpenCode's auth shape
// back to Codex CLI shape, and PUT it to /api/runtime/secret.
//
// Silent no-op when the main step didn't materialize Codex auth (no state
// saved). Best-effort: failures are logged but never throw — the workflow
// is already done, and a missed refresh write-back means the user re-runs
// `pullfrog auth codex` next time the chain breaks.
//
// Imports here MUST stay stdlib-only — GHA runs this file directly from the
// checked-out action repo, which has no node_modules for sha-pinned consumers.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { detectCodexRefresh } from "./utils/codexRefreshDetect.ts";
import * as core from "./utils/ghaCore.ts";
import { postApiFetch } from "./utils/postApiFetch.ts";

async function main(): Promise<void> {
  const raw = core.getState("codex_writeback");
  if (!raw) {
    core.info("codex post-hook: no writeback state — skipping");
    return;
  }

  let state: {
    apiToken: string;
    authPath: string;
    originalRefresh: string;
    originalIdToken?: string;
  };
  try {
    state = JSON.parse(raw) as typeof state;
  } catch (err) {
    core.warning(`codex post-hook: malformed writeback state — ${err}`);
    return;
  }
  if (!state.apiToken || !state.authPath || !state.originalRefresh) {
    core.warning("codex post-hook: incomplete writeback state — skipping");
    return;
  }

  if (!existsSync(state.authPath)) {
    core.info(`codex post-hook: ${state.authPath} not found — nothing to write back`);
    return;
  }

  let authFileContent: string;
  try {
    authFileContent = readFileSync(state.authPath, "utf8");
  } catch (err) {
    core.warning(`codex post-hook: cannot read ${state.authPath} — ${err}`);
    return;
  }

  const refreshedCodexJson = detectCodexRefresh({
    authFileContent,
    originalRefresh: state.originalRefresh,
    originalIdToken: state.originalIdToken,
  });
  if (!refreshedCodexJson) {
    core.info("codex post-hook: refresh chain unchanged — no writeback needed");
    return;
  }

  try {
    const response = await postApiFetch({
      path: "/api/runtime/secret",
      method: "PUT",
      headers: {
        authorization: `Bearer ${state.apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "CODEX_AUTH_JSON", value: refreshedCodexJson }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      core.warning(`codex post-hook: writeback returned ${response.status}: ${body}`);
      return;
    }
    core.info("codex post-hook: refreshed CODEX_AUTH_JSON persisted to Pullfrog");
  } catch (err) {
    core.warning(`codex post-hook: writeback failed — ${err}`);
  }
}

/**
 * Delete the shared temp directory created by `createTempDirectory()`.
 *
 * `mkdtempSync(join(tmpdir(), "pullfrog-"))` had no counterpart anywhere in
 * the action, so every run left its checkout behind. On GitHub-hosted runners
 * that is invisible — the VM is destroyed with the job — but a self-hosted
 * runner accumulates one clone per run forever. It is worst when `/tmp` is a
 * tmpfs: the leak is then RAM, not disk. One host reached 58 leaked clones
 * (12 GB, `/tmp` 100% full) in a single day, which starved the box badly
 * enough that the kernel OOM-killed unrelated jobs.
 *
 * Runs from `post:` rather than a `finally` in the main step so it also fires
 * on cancellation, timeout, and unhandled errors — the paths that leak most.
 * Best-effort by design: a failure here must never fail the job.
 */
function cleanupTempDir(): void {
  const dir = core.getState("pullfrog_temp_dir");
  // Only ever remove a directory we recognise as ours. The leaf is split by
  // hand rather than with `basename` to keep entryPost's locked import
  // surface (`node:fs` plus relative siblings) unchanged — see #834.
  const leaf = dir.split(/[\\/]/).pop() ?? "";
  if (!dir || !leaf.startsWith("pullfrog-")) return;
  try {
    rmSync(dir, { recursive: true, force: true });
    core.info(`pullfrog post-hook: removed temp dir ${dir}`);
  } catch (err) {
    core.warning(`pullfrog post-hook: temp dir cleanup failed — ${err}`);
  }
}

// Cleanup runs last so nothing `main()` reads can be pulled out from under it,
// and on both paths because the leak is the whole point of the hook firing.
main()
  .catch((err) => {
    core.warning(`codex post-hook: unexpected error — ${err}`);
  })
  .finally(cleanupTempDir);
