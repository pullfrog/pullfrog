import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeEnv, sanitizeSecret } from "./normalizeEnv.ts";

/**
 * These tests pin the load-bearing invariants of secret sanitisation:
 *   - sensitive values are trimmed before downstream code reads them
 *   - whitespace-only values are NOT silently zeroed (leave env unchanged)
 *   - case normalisation still happens
 *
 * Masking (`core.setSecret`) is delegated to `@actions/core` and trusted to
 * work as documented — we don't spy on stdout to re-test the toolkit.
 */

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
    if (process.platform !== "win32") {
      expect(process.env.anthropic_api_key).toBeUndefined();
    }
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
});
