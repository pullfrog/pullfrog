import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { detectCodexRefresh } from "../../utils/codexRefreshDetect.ts";
import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import { defineFixture } from "../utils.ts";

/**
 * codex-auth test — end-to-end Codex ChatGPT-subscription auth smoke.
 *
 * Pins the raw `openai/gpt-5.5` specifier — one of the ids in upstream
 * opencode's Codex `ALLOWED_MODELS` allow list — NOT the `openai/gpt` alias,
 * which now rolls to gpt-6.1-sol. This test validates the model-agnostic
 * auth-refresh chain, so it stays on a stable allow-listed model rather than
 * following the flagship roll. Runs the full opencode harness against the
 * developer's / CI's `CODEX_AUTH_JSON`. Exercises:
 *
 *   - installCodexAuth() materializes auth.json at $HOME/.local/share/opencode/
 *     with `expires: 0` (forces refresh on first request).
 *   - opencode's CodexAuthPlugin routes openai requests through the ChatGPT
 *     subscription instead of needing OPENAI_API_KEY.
 *   - the refresh chain advances during the run (proving the refresh path
 *     works end-to-end against live Codex auth servers).
 *   - detectCodexRefresh() would surface the rotation to entryPost.ts for
 *     write-back to Pullfrog's secret store.
 *
 * the post-hook itself runs in a separate GHA `post:` step and is not
 * invoked by `pnpm runtest`. instead, this test asserts the on-disk auth.json
 * state that the post-hook would consume, which is the genuine integration
 * boundary (everything past `detectCodexRefresh` is a single fetch + unit-
 * tested in codexRefreshDetect.test.ts).
 *
 * requires `CODEX_AUTH_JSON` in the environment. dev-local: put it in
 * `.env`. CI: provisioned as `secrets.CODEX_AUTH_JSON` and forwarded by the
 * `action-agents` job env block in `.github/workflows/test.yml`.
 */

const token = randomUUID();

const fixture = defineFixture(
  {
    prompt: `Call set_output with exactly this token and nothing else: ${token}`,
    shell: "restricted",
    push: "disabled",
    timeout: "4m",
  },
  { localOnly: true }
);

function parseOriginalRefresh(): string | null {
  const raw = process.env.CODEX_AUTH_JSON;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { tokens?: { refresh_token?: unknown } };
    const rt = parsed?.tokens?.refresh_token;
    return typeof rt === "string" && rt.length > 0 ? rt : null;
  } catch {
    return null;
  }
}

function validator(result: AgentResult): ValidationCheck[] {
  const setOutputCalled = result.structuredOutput !== null;
  const tokenMatches = result.structuredOutput === token;

  // installCodexAuth() emits this log line with the absolute path; we use it
  // to find the per-test HOME (randomized inside runAgentStreaming).
  const pathMatch = result.output.match(/installed Codex auth at (\S+)/);
  const authPath = pathMatch?.[1];

  let authMaterialized = false;
  let refreshRotated = false;

  if (authPath) {
    try {
      const content = readFileSync(authPath, "utf8");
      authMaterialized = true;
      const originalRefresh = parseOriginalRefresh();
      if (originalRefresh) {
        refreshRotated = detectCodexRefresh({ authFileContent: content, originalRefresh }) !== null;
      }
    } catch {
      // authMaterialized stays false
    }
  }

  return [
    { name: "set_output", passed: setOutputCalled },
    { name: "token_matches", passed: tokenMatches },
    { name: "auth_materialized", passed: authMaterialized },
    { name: "refresh_rotated", passed: refreshRotated },
  ];
}

export const test: TestRunnerOptions = {
  name: "codex-auth",
  fixture,
  validator,
  agents: ["opencode"],
  env: {
    PULLFROG_MODEL: "openai/gpt-5.5",
    PULLFROG_DISABLE_SECURITY_INSTRUCTIONS: "1",
  },
  // forks + contributors without the Codex secret skip cleanly rather than
  // failing on `auth_materialized=✗` and (with fail-fast: true) cascading
  // cancellation across the rest of the matrix. CI on `pullfrog/app` and
  // dev-local with `.env` both have the secret and run the test as normal.
  skipIf: () => (process.env.CODEX_AUTH_JSON ? null : "CODEX_AUTH_JSON unset"),
};
