import * as core from "@actions/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeEnv, sanitizeSecret } from "./normalizeEnv.ts";
import { isSensitiveEnvName } from "./secrets.ts";

/**
 * These tests pin the load-bearing invariants of secret sanitisation:
 *   - sensitive values are trimmed before downstream code reads them
 *   - whitespace-only values are NOT silently zeroed (leave env unchanged)
 *   - case normalisation still happens
 *   - masking is applied to everything except an explicit config allowlist
 *
 * We don't re-test what `core.setSecret` does with a value (that's the
 * toolkit's job), but we do assert *whether* we call it: the decision of what
 * counts as maskable is ours, and getting it wrong either leaks a credential
 * or blanks out unrelated log text.
 */
vi.mock("@actions/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@actions/core")>()),
  setSecret: vi.fn(),
}));

describe("normalizeEnv: process.env state contract", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // normalizeEnv() iterates the entire process.env, so the test must
    // control it. snapshot + full wipe + restore is the cleanest isolation.
    originalEnv = { ...process.env };
    for (const k of Object.keys(process.env)) delete process.env[k];
  });

  afterEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, originalEnv);
  });

  it("trims trailing newline from sensitive env vars", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-secret-value\n";
    normalizeEnv();
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-secret-value");
  });

  it("trims surrounding whitespace including \\r\\n and spaces", () => {
    process.env.OPENAI_API_KEY = "  sk-openai-value\r\n  ";
    normalizeEnv();
    expect(process.env.OPENAI_API_KEY).toBe("sk-openai-value");
  });

  it("leaves clean sensitive values untouched", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-clean";
    normalizeEnv();
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-clean");
  });

  it("ignores non-sensitive env vars", () => {
    process.env.NODE_ENV = "production\n";
    normalizeEnv();
    expect(process.env.NODE_ENV).toBe("production\n");
  });

  it("canonicalises case and trims the value", () => {
    process.env.anthropic_api_key = "sk-ant-lowercase\n";
    normalizeEnv();
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-lowercase");
    expect(process.env.anthropic_api_key).toBeUndefined();
  });

  it("preserves whitespace-only values rather than silently zeroing them", () => {
    // contract: don't mutate when value is whitespace-only. caller sees the
    // misconfigured value verbatim and either fails clearly downstream or
    // logs a missing-key error.
    process.env.ANTHROPIC_API_KEY = "   \n  ";
    normalizeEnv();
    expect(process.env.ANTHROPIC_API_KEY).toBe("   \n  ");
  });

  it("preserves embedded newlines (toolkit masks each line)", () => {
    // multi-line PEMs aren't used in practice, but if one slipped in via a
    // DB secret we don't want to silently mutate it. trim() only touches
    // the ends; @actions/core handles per-line masking via the runner.
    process.env.ANTHROPIC_API_KEY = "line1\nline2";
    normalizeEnv();
    expect(process.env.ANTHROPIC_API_KEY).toBe("line1\nline2");
  });
});

describe("sanitizeSecret return value", () => {
  it("returns the trimmed value for a sensitive secret with trailing newline", () => {
    expect(sanitizeSecret("ANTHROPIC_API_KEY", "sk-ant-secret\n")).toBe("sk-ant-secret");
  });

  it("returns the value unchanged when no trimming is needed", () => {
    expect(sanitizeSecret("ANTHROPIC_API_KEY", "sk-ant-clean")).toBe("sk-ant-clean");
  });

  it("returns null for whitespace-only input so caller can skip injection", () => {
    expect(sanitizeSecret("ANTHROPIC_API_KEY", "   \n")).toBeNull();
  });

  // #1162 — an interior newline survives trim() and is unsendable as an HTTP
  // header, so the provider rejects it ~1s in with an unclassifiable error.
  it("returns null for an api key with an interior line break", () => {
    expect(sanitizeSecret("ANTHROPIC_API_KEY", "sk-ant-part\none\ntwo")).toBeNull();
  });

  it("leaves a JSON-blob credential's newlines alone", () => {
    expect(sanitizeSecret("CODEX_AUTH_JSON", '{\n  "refresh": "x"\n}')).toBe(
      '{\n  "refresh": "x"\n}'
    );
  });
});

describe("sanitizeSecret masking policy", () => {
  const setSecret = vi.mocked(core.setSecret);

  beforeEach(() => {
    setSecret.mockClear();
  });

  it("masks credential-shaped keys", () => {
    sanitizeSecret("ANTHROPIC_API_KEY", "sk-ant-secret");
    expect(setSecret).toHaveBeenCalledWith("sk-ant-secret");
  });

  it("masks unrecognised keys — the allowlist fails closed", () => {
    sanitizeSecret("SOME_FUTURE_PROVIDER_CREDS", "hunter2");
    expect(setSecret).toHaveBeenCalledWith("hunter2");
  });

  it("masks VERTEX_SERVICE_ACCOUNT_JSON even though it matches no sensitive suffix", () => {
    // regression guard for the tempting "just gate on isSensitiveEnvName"
    // refactor: this key is a real credential protected *only* by
    // mask-by-default, so narrowing the gate would silently unmask it.
    expect(isSensitiveEnvName("VERTEX_SERVICE_ACCOUNT_JSON")).toBe(false);
    sanitizeSecret("VERTEX_SERVICE_ACCOUNT_JSON", '{"private_key":"pk"}');
    expect(setSecret).toHaveBeenCalledWith('{"private_key":"pk"}');
  });

  it("does not mask non-secret config values", () => {
    // masking is by value: setSecret("global") would rewrite every unrelated
    // occurrence of "global" in the run log to ***.
    sanitizeSecret("VERTEX_LOCATION", "global");
    expect(setSecret).not.toHaveBeenCalled();
  });

  it("still trims non-secret config values", () => {
    // a trailing newline on a model id breaks the exact-match authorization
    // lookup, so trimming has to happen whether or not we mask.
    expect(sanitizeSecret("PULLFROG_MODEL", "azure/gpt-5.6-sol\n")).toBe("azure/gpt-5.6-sol");
    expect(setSecret).not.toHaveBeenCalled();
  });

  it("matches config names case-insensitively", () => {
    sanitizeSecret("aws_region", "us-east-1");
    expect(setSecret).not.toHaveBeenCalled();
  });

  it("does not mask the Azure config values", () => {
    // the console flow stores all five Azure values in the account-secret
    // channel, and these carry the worst mask-by-value collateral: "128000"
    // and "true" appear all over an ordinary run log.
    sanitizeSecret("AZURE_RESOURCE_NAME", "my-resource");
    sanitizeSecret("AZURE_DEPLOYMENT", "prod-reasoning");
    sanitizeSecret("AZURE_CONTEXT", "400000");
    sanitizeSecret("AZURE_MAX_OUTPUT", "128000");
    sanitizeSecret("AZURE_USE_CHAT_COMPLETIONS", "true");
    expect(setSecret).not.toHaveBeenCalled();
  });

  it("masks OPENAI_COMPATIBLE_BASE_URL even though its siblings are config", () => {
    // gateway URLs can carry account ids or embedded credentials in the path,
    // so the base URL stays off the allowlist while model/context/max-output
    // are unmasked.
    sanitizeSecret("OPENAI_COMPATIBLE_MODEL", "my-model");
    expect(setSecret).not.toHaveBeenCalled();
    sanitizeSecret("OPENAI_COMPATIBLE_BASE_URL", "https://gw.example.com/v1");
    expect(setSecret).toHaveBeenCalledWith("https://gw.example.com/v1");
  });
});
