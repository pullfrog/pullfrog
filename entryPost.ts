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
// Today's managed-auth job: detect refreshes for any installed managed
// credential and write the rotated secret back to Pullfrog. Codex is the
// first provider: diff the on-disk auth.json against the original refresh
// token, convert OpenCode's auth shape back to Codex CLI shape, and PUT it
// to /api/runtime/secret.
//
// Silent no-op when the main step didn't materialize Codex auth (no state
// saved). Best-effort: failures are logged but never throw — the workflow
// is already done, and a missed refresh write-back means the user re-runs
// `pullfrog auth codex` next time the chain breaks.
//
// Imports here MUST stay stdlib-only — GHA runs this file directly from the
// checked-out action repo, which has no node_modules for sha-pinned consumers.

import { existsSync, readFileSync } from "node:fs";
import { detectCodexRefresh } from "./utils/codexRefreshDetect.ts";
import * as core from "./utils/ghaCore.ts";
import {
  MANAGED_AUTH_WRITEBACK_STATE,
  type ManagedAuthWriteback,
  parseManagedAuthWritebacks,
} from "./utils/managedAuthState.ts";
import { postApiFetch } from "./utils/postApiFetch.ts";

async function main(): Promise<void> {
  const writebacks = readWritebackState();
  if (writebacks.length === 0) {
    core.info("managed-auth post-hook: no writeback state — skipping");
    return;
  }

  for (const writeback of writebacks) {
    await handleWriteback(writeback);
  }
}

function readWritebackState(): ManagedAuthWriteback[] {
  const raw = core.getState(MANAGED_AUTH_WRITEBACK_STATE);
  if (raw) {
    const writebacks = parseManagedAuthWritebacks(raw);
    if (!writebacks) {
      core.warning("managed-auth post-hook: malformed writeback state — skipping");
      return [];
    }
    return writebacks;
  }

  const legacy = core.getState("codex_writeback");
  if (!legacy) return [];

  let state: { apiToken?: unknown; authPath?: unknown; originalRefresh?: unknown };
  try {
    state = JSON.parse(legacy) as typeof state;
  } catch (err) {
    core.warning(`codex post-hook: malformed legacy writeback state — ${err}`);
    return [];
  }

  if (
    typeof state.apiToken !== "string" ||
    typeof state.authPath !== "string" ||
    typeof state.originalRefresh !== "string" ||
    state.apiToken.length === 0 ||
    state.authPath.length === 0 ||
    state.originalRefresh.length === 0
  ) {
    core.warning("codex post-hook: incomplete legacy writeback state — skipping");
    return [];
  }

  return [
    {
      kind: "codex",
      apiToken: state.apiToken,
      secretName: "CODEX_AUTH_JSON",
      authPath: state.authPath,
      originalRefresh: state.originalRefresh,
    },
  ];
}

async function handleWriteback(writeback: ManagedAuthWriteback): Promise<void> {
  switch (writeback.kind) {
    case "codex":
      await handleCodexWriteback(writeback);
      return;
  }
}

async function handleCodexWriteback(writeback: Extract<ManagedAuthWriteback, { kind: "codex" }>) {
  if (!existsSync(writeback.authPath)) {
    core.info(`codex post-hook: ${writeback.authPath} not found — nothing to write back`);
    return;
  }

  let authFileContent: string;
  try {
    authFileContent = readFileSync(writeback.authPath, "utf8");
  } catch (err) {
    core.warning(`codex post-hook: cannot read ${writeback.authPath} — ${err}`);
    return;
  }

  const refreshedCodexJson = detectCodexRefresh({
    authFileContent,
    originalRefresh: writeback.originalRefresh,
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
        authorization: `Bearer ${writeback.apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: writeback.secretName, value: refreshedCodexJson }),
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

main().catch((err) => {
  core.warning(`codex post-hook: unexpected error — ${err}`);
});
