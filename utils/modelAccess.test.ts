import { describe, expect, it } from "vitest";
import { decideModelAccess } from "./modelAccess.ts";

const base = {
  modelExplicit: true,
  oss: false,
  proxyActive: false,
  subsidyTarget: undefined,
  authorized: new Set<string>(),
};

describe("decideModelAccess — routing slugs", () => {
  it("passes openai-compatible/byok even though the resolved specifier is slashed and unauthorized", () => {
    // the opencode `authorized` snapshot can't contain the dynamically-injected
    // openai-compatible provider — the slug's own setup checks validate auth.
    expect(
      decideModelAccess({
        ...base,
        model: "openai-compatible/byok",
        resolvedModel: "openai-compatible/azure/gpt-5.6-production",
      })
    ).toEqual({ kind: "ok" });
  });

  it("passes openai-compatible/byok as byok when a proxy is active", () => {
    expect(
      decideModelAccess({
        ...base,
        proxyActive: true,
        model: "openai-compatible/byok",
        resolvedModel: "openai-compatible/azure/gpt-5.6-production",
      })
    ).toEqual({ kind: "byok" });
  });

  it("still rejects a non-routing slashed model that isn't authorized", () => {
    expect(
      decideModelAccess({
        ...base,
        model: "anthropic/claude-opus-4-8",
        resolvedModel: "anthropic/claude-opus-4-8",
      })
    ).toEqual({ kind: "error", reason: "byok_no_key" });
  });

  it("still passes slash-less bedrock/vertex backend IDs", () => {
    expect(
      decideModelAccess({
        ...base,
        model: "bedrock/byok",
        resolvedModel: "eu.anthropic.claude-opus-4-8-v1",
      })
    ).toEqual({ kind: "ok" });
  });
});
