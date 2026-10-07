import { existsSync, readFileSync, rmSync } from "node:fs";
import * as core from "@actions/core";
import { z } from "zod";
import { apiFetch } from "./apiFetch.ts";
import { detectCodexRefresh, detectXaiRefresh, type OAuthWriteback } from "./codexRefreshDetect.ts";

/** GHA state key the agent harnesses write their pending write-backs to.
 *
 * `entryPost.ts` gates on the `STATE_oauth_writeback` env var GHA derives from
 * this name, and it spells the key literally rather than importing this
 * constant — importing it would drag this module (and `@actions/core`) into the
 * post-hook's stdlib-only import graph and bring back #815. Keep the two in
 * sync by hand; `entryPost.stdlibOnly.test.ts` guards the reason they differ. */
export const OAUTH_WRITEBACK_STATE = "oauth_writeback";

/** GHA state key for the run's subscription data dir (codexHome.ts); `entryPost.ts` spells it literally too. */
export const SUBSCRIPTION_DATA_DIR_STATE = "subscription_data_dir";

/**
 * Persist any OAuth refresh chain the run rotated, back into Pullfrog's own
 * secret store.
 *
 * Runs from the action's `post:` hook, which GitHub executes regardless of how
 * the main step ended — that's the contract this needs: if OpenCode refreshed
 * the Codex auth.json mid-run, the rotated token must land back in Pullfrog
 * even when the main step was cancelled or timed out.
 *
 * THIS IS WHY `CODEX_AUTH_JSON` HAS TO LIVE IN PULLFROG'S OWN SECRET STORE,
 * NOT IN GITHUB ACTIONS SECRETS. The refresh chain rotates on every use; this
 * PUTs the rotated chain back to Pullfrog Postgres so the next run starts from
 * a fresh token. GH Actions secrets are read-only at runtime — there is no API
 * to write them back from inside a job — so a token stashed there silently
 * goes stale on the first refresh and the next run fails. See wiki/codex-auth.md.
 *
 * Then removes the run's subscription data dir (codexHome.ts), which holds the
 * auth.json diffed here.
 *
 * Best-effort throughout: a missed write-back costs the user one
 * `pullfrog auth codex` re-run, while a throw here would fail a workflow whose
 * agent already succeeded.
 */
export async function runOAuthWriteback(): Promise<void> {
  await writeBackEntries();
  // last: the writeback diffs the auth.json inside this per-run dir (codexHome.ts, #1475).
  const dataDir = core.getState(SUBSCRIPTION_DATA_DIR_STATE);
  if (!dataDir) return;
  rmSync(dataDir, { recursive: true, force: true });
  core.info(`oauth post-hook: removed ${dataDir}`);
}

async function writeBackEntries(): Promise<void> {
  const raw = core.getState(OAUTH_WRITEBACK_STATE);
  if (!raw) {
    core.info("oauth post-hook: no writeback state — skipping");
    return;
  }

  let state: { apiToken: string; entries: OAuthWriteback[] };
  try {
    state = JSON.parse(raw) as typeof state;
  } catch (err) {
    core.warning(`oauth post-hook: malformed writeback state — ${err}`);
    return;
  }
  if (!state.apiToken || !Array.isArray(state.entries)) {
    core.warning("oauth post-hook: incomplete writeback state — skipping");
    return;
  }

  for (const entry of state.entries) {
    await writeBackEntry(state.apiToken, entry);
  }
}

/** Persist one provider's rotated chain. Each entry is independent — a
 * failure on one must not strand the other, so this never throws. */
async function writeBackEntry(apiToken: string, entry: OAuthWriteback): Promise<void> {
  if (!entry.secretName || !entry.authPath || !entry.originalRefresh) {
    core.warning("oauth post-hook: incomplete writeback entry — skipping");
    return;
  }
  if (!existsSync(entry.authPath)) {
    core.info(`oauth post-hook: ${entry.authPath} not found — nothing to write back`);
    return;
  }

  let authFileContent: string;
  try {
    authFileContent = readFileSync(entry.authPath, "utf8");
  } catch (err) {
    core.warning(`oauth post-hook: cannot read ${entry.authPath} — ${err}`);
    return;
  }

  const refreshed =
    entry.provider === "xai"
      ? detectXaiRefresh({
          authFileContent,
          originalRefresh: entry.originalRefresh,
        })
      : detectCodexRefresh({
          authFileContent,
          originalRefresh: entry.originalRefresh,
          originalIdToken: entry.originalIdToken,
        });
  if (!refreshed) {
    core.info(`oauth post-hook: ${entry.secretName} chain unchanged — no writeback needed`);
    return;
  }

  try {
    const poolState = core.getState("credential_receipts");
    const receipts = z.record(z.string(), z.string()).parse(JSON.parse(poolState || "{}"));
    const receipt = receipts[entry.secretName];
    if (poolState && !receipt) return;
    const response = await apiFetch({
      path: receipt ? "/api/runtime/credentials" : "/api/runtime/secret",
      method: "PUT",
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: entry.secretName, value: refreshed, receipt }),
      // the workflow is already finished; a hung write-back would hold the
      // runner open for nothing.
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      core.warning(`oauth post-hook: writeback returned ${response.status}: ${body}`);
      return;
    }
    core.info(`oauth post-hook: refreshed ${entry.secretName} persisted to Pullfrog`);
  } catch (err) {
    core.warning(`oauth post-hook: writeback failed — ${err}`);
  }
}
