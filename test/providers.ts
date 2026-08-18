/**
 * provider catalog — the source of truth for `providers-live` (full harness
 * smoke per provider) and the per-provider coverage globs that scope `models-live`
 * (per-alias CLI smoke).
 *
 * each entry pins one standard-tier flagship slug per provider — not the
 * pro/opus tier (too expensive for per-push) and not the free/experimental
 * tier (too flaky). these flagships catch provider-class regressions like
 * Gemini schema sanitization or OpenAI tool-call format drift that the cheap
 * per-alias CLI smoke can't see.
 *
 * `coverage` lists the source files that, when changed, should rerun this
 * provider's flagship + every alias of this provider. `action/models.ts` is
 * included on every entry — touching the resolution table reruns all model
 * tests (simple model; matches the per-PR-precision answer from planning).
 *
 * adding a new provider:
 *   1. add an entry here with the flagship slug, agent harness, coverage globs
 *   2. add a row to wiki/models-catalog.md "To add a provider"
 *   3. CI picks it up automatically — no workflow change
 */

export type ProviderEntry = {
  name: string;
  /** flagship slug for `providers-live` full-harness smoke. */
  flagship: string;
  /** harness used by the runtime for this provider's models. */
  agent: "claude" | "opencode" | "dsh";
  /** repo-relative globs that invalidate this provider's matrix entries. */
  coverage: string[];
};

const SHARED_OPENCODE_COVERAGE = [
  "action/models.ts",
  "action/agents/opencode.ts",
  "action/agents/opencodePlugin.ts",
];

export const providers: ProviderEntry[] = [
  {
    name: "anthropic",
    flagship: "anthropic/claude-sonnet",
    agent: "claude",
    coverage: ["action/models.ts", "action/agents/claude.ts"],
  },
  {
    name: "openai",
    flagship: "openai/gpt-sol",
    agent: "opencode",
    coverage: SHARED_OPENCODE_COVERAGE,
  },
  {
    name: "google",
    flagship: "google/gemini-pro",
    agent: "opencode",
    coverage: [...SHARED_OPENCODE_COVERAGE, "action/mcp/geminiSanitizer.ts"],
  },
  {
    name: "xai",
    flagship: "xai/grok",
    agent: "opencode",
    coverage: SHARED_OPENCODE_COVERAGE,
  },
  {
    name: "deepseek",
    flagship: "deepseek/deepseek-pro",
    agent: "dsh",
    coverage: ["action/models.ts", "action/agents/dsh.ts"],
  },
  {
    name: "moonshotai",
    flagship: "moonshotai/kimi-k2",
    agent: "opencode",
    coverage: SHARED_OPENCODE_COVERAGE,
  },
  {
    name: "opencode",
    flagship: "opencode/big-pickle",
    agent: "opencode",
    coverage: SHARED_OPENCODE_COVERAGE,
  },
  {
    name: "openrouter",
    flagship: "openrouter/claude-sonnet",
    agent: "opencode",
    coverage: SHARED_OPENCODE_COVERAGE,
  },
];
