import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { modelAliases } from "../models.ts";
import { geminiHighThinkingOverrides } from "./opencode.ts";
import { azureBaseUrlOverrides } from "./opencodeShared.ts";

describe("geminiHighThinkingOverrides", () => {
  // Expected truth pulled the same way the helper does — both must derive from
  // the registry so the test exercises the wiring, not a hand-maintained list.
  const expectedApiIds = modelAliases
    .filter((a) => a.provider === "google")
    .map((a) => a.resolve.replace(/^google\//, ""));
  const overrides = geminiHighThinkingOverrides();

  it("covers every direct-Google alias in the registry", () => {
    expect(Object.keys(overrides).sort()).toEqual([...expectedApiIds].sort());
  });

  it("is non-empty (catches accidental whole-provider removal)", () => {
    expect(Object.keys(overrides).length).toBeGreaterThan(0);
  });

  it("strips the `google/` prefix from each resolve to get the bare API id", () => {
    for (const id of Object.keys(overrides)) {
      expect(id).not.toMatch(/^google\//);
    }
  });

  it("pins every entry to thinkingLevel: high", () => {
    for (const [id, value] of Object.entries(overrides)) {
      expect(value, `entry for ${id}`).toEqual({
        options: { thinkingConfig: { thinkingLevel: "high" } },
      });
    }
  });
});

describe("azureBaseUrlOverrides", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    delete process.env.AZURE_BASE_URL;
    delete process.env.AZURE_COGNITIVE_SERVICES_BASE_URL;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it("contributes nothing when neither var is set", () => {
    // spread into `provider`, so an empty object has to be the unset default
    expect(azureBaseUrlOverrides()).toEqual({});
  });

  it("maps AZURE_BASE_URL onto the azure provider", () => {
    process.env.AZURE_BASE_URL = "https://my-resource.openai.azure.com/openai";
    expect(azureBaseUrlOverrides()).toEqual({
      azure: { options: { baseURL: "https://my-resource.openai.azure.com/openai" } },
    });
  });

  it("maps the cognitive-services var onto its own provider id", () => {
    process.env.AZURE_COGNITIVE_SERVICES_BASE_URL = "https://foo.cognitiveservices.azure.com/openai";
    expect(azureBaseUrlOverrides()).toEqual({
      "azure-cognitive-services": {
        options: { baseURL: "https://foo.cognitiveservices.azure.com/openai" },
      },
    });
  });

  it("carries both providers independently", () => {
    process.env.AZURE_BASE_URL = "https://a.openai.azure.com/openai";
    process.env.AZURE_COGNITIVE_SERVICES_BASE_URL = "https://b.cognitiveservices.azure.com/openai";
    expect(Object.keys(azureBaseUrlOverrides()).sort()).toEqual(["azure", "azure-cognitive-services"]);
  });

  it("trims surrounding whitespace", () => {
    process.env.AZURE_BASE_URL = "  https://my-resource.openai.azure.com/openai\n";
    expect(azureBaseUrlOverrides().azure?.options.baseURL).toBe(
      "https://my-resource.openai.azure.com/openai"
    );
  });

  it("treats a whitespace-only value as unset", () => {
    process.env.AZURE_BASE_URL = "   ";
    expect(azureBaseUrlOverrides()).toEqual({});
  });
});
