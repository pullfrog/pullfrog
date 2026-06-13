// Shared helpers for the OpenCode agent harnesses (`./opencode.ts` v1 and
// `./opencode_v2.ts` v2). Pure config / model-registry / install glue —
// nothing here touches the NDJSON event loop, which differs between v1 and v2.
//
// Once v1 is deleted post-burn-in this module collapses back into v2; until
// then it keeps both runners synchronized so a config drift can't make v1 a
// silently-broken fallback.

import { modelAliases } from "../models.ts";
import { log } from "../utils/cli.ts";
import { installFromNpmTarball } from "../utils/install.ts";
import { getAuthorizedModels } from "../utils/openCodeModels.ts";
import { getDevDependencyVersion } from "../utils/version.ts";
import { REVIEWER_AGENT_NAME, REVIEWER_SYSTEM_PROMPT } from "./reviewer.ts";
import { deriveSubagentModels } from "./subagentModels.ts";

// ── config ─────────────────────────────────────────────────────────────────────

export type OpenCodeConfig = {
  mcp?: Record<string, unknown>;
  permission?: Record<string, unknown>;
  provider?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  experimental?: Record<string, unknown>;
  model?: string;
  enabled_providers?: string[];
  [key: string]: unknown;
};

/**
 * Build the `provider.google.models[id].options` map that pins every direct-Google
 * Gemini alias to `thinkingLevel: "high"`. Sourced from the model registry so
 * adding/renaming a Google alias in `action/models.ts` flows through automatically.
 */
export function geminiHighThinkingOverrides(): Record<string, { options: object }> {
  return Object.fromEntries(
    modelAliases
      .filter((a) => a.provider === "google")
      .map((a) => [
        a.resolve.replace(/^google\//, ""),
        { options: { thinkingConfig: { thinkingLevel: "high" } } },
      ])
  );
}

/**
 * OpenAI-compatible Qwen provider, materialized into the action-owned
 * OPENCODE_CONFIG_CONTENT. The models map is derived from the qwen aliases in
 * models.ts so a `resolve` bump (e.g. via models-bump) flows through without an
 * edit here. Key/baseURL come from QWEN_* → DASHSCOPE_* → LLM_* (LLM_* as a
 * generic OpenAI-compatible fallback), defaulting to the DashScope intl URL.
 */
export function qwenProviderConfig(): Record<string, unknown> {
  const apiKey =
    process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? process.env.LLM_API_KEY;
  const baseURL =
    process.env.QWEN_BASE_URL ??
    process.env.DASHSCOPE_BASE_URL ??
    process.env.LLM_BASE_URL ??
    "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
  const models = Object.fromEntries(
    modelAliases
      .filter((a) => a.provider === "qwen")
      .map((a) => [a.resolve.replace(/^qwen\//, ""), { name: a.displayName }])
  );
  return {
    npm: "@ai-sdk/openai-compatible",
    name: "Qwen",
    options: { baseURL, ...(apiKey ? { apiKey } : {}) },
    models,
  };
}

/**
 * Read-only `reviewfrog` subagent for lens-based review. Non-mutative +
 * non-recursive — enforced by the system prompt in reviewer.ts.
 *
 * Per-subagent `model:` override is driven by the registry in
 * `action/models.ts` via each alias's `subagentModel` field. Currently wired:
 * Anthropic opus → sonnet, OpenAI gpt-pro → gpt and gpt → gpt-5.4, Google
 * gemini-pro → gemini-flash. Other providers inherit (no override).
 */
export function buildReviewerAgentConfig(
  orchestratorModel: string | undefined
): Record<string, unknown> {
  const overrides = deriveSubagentModels(orchestratorModel);
  return {
    [REVIEWER_AGENT_NAME]: {
      description:
        "Read-only review subagent for lens-based code review (correctness, security, billing-subsystem, etc.). " +
        "Reads only — no writes, no state-changing shell or MCP calls, no nested subagent dispatch.",
      mode: "subagent",
      prompt: REVIEWER_SYSTEM_PROMPT,
      ...(overrides.reviewer !== undefined ? { model: overrides.reviewer } : {}),
    },
  };
}

// ── install ────────────────────────────────────────────────────────────────────

/**
 * Install the opencode-ai npm tarball and return the path to the executable.
 *
 * The bin path differs by version: v1.4.x and earlier shipped `bin/opencode`;
 * v1.14+ renames the platform-specific binary to `bin/opencode.exe` for every
 * OS via the postinstall script. Callers pass the binPath that matches their
 * pinned version so a v1↔v2 swap can't silently install the wrong file.
 */
export async function installOpencodeCli(params: { binPath: string }): Promise<string> {
  return await installFromNpmTarball({
    packageName: "opencode-ai",
    version: getDevDependencyVersion("opencode-ai"),
    executablePath: params.binPath,
    installDependencies: true,
  });
}

// ── model auto-select fallback ──────────────────────────────────────────────────
//
// steps 1–2 of model resolution (PULLFROG_MODEL env, slug resolution) happen
// in resolveModel() in utils/agent.ts before the agent runs. this is step 3:
// auto-select using the authorized model set captured in main.ts via
// `opencode models` introspection.

const AUTO_SELECT_WARNING =
  "select a model explicitly in the Pullfrog console (https://pullfrog.com/console) to avoid this.";

export function autoSelectModel(): string | undefined {
  const authorized = getAuthorizedModels();
  if (authorized.size > 0) {
    // skip hidden aliases (internal subagent-tier targets like
    // opencode/gpt-5.4) — they should never surface as a user-facing
    // orchestrator pick. mirrors the selectable-list filter in
    // components/ModelSelector.tsx and action/commands/init.ts.
    const match =
      modelAliases.find((a) => !a.hidden && a.preferred && authorized.has(a.resolve)) ??
      modelAliases.find((a) => !a.hidden && authorized.has(a.resolve));
    if (match) {
      log.info(
        `» model: ${match.resolve} (auto-selected${match.preferred ? " — preferred" : ""} curated match)`
      );
      log.warning(`» model auto-selected. ${AUTO_SELECT_WARNING}`);
      return match.resolve;
    }
    log.info(
      `» opencode has ${authorized.size} models but none match curated aliases — letting OpenCode auto-select`
    );
  }

  log.warning(`» no model resolved. letting OpenCode auto-select. ${AUTO_SELECT_WARNING}`);
  return undefined;
}
