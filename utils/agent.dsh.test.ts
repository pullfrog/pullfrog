import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agents } from "../agents/index.ts";
import { assertAgentModelCompatible, resolveAgent } from "./agent.ts";
import { formatMcpToolRef, extractMcpToolRefs } from "../external.ts";

describe("resolveAgent — dsh routing", () => {
  afterEach(() => {
    delete process.env.PULLFROG_AGENT;
    delete process.env.DEEPSEEK_API_KEY;
  });

  it("routes deepseek direct models to dsh when enabled + key present", () => {
    process.env.DEEPSEEK_API_KEY = "sk-test";
    const agent = resolveAgent({
      model: "deepseek/deepseek-v4-flash",
      dshEnabled: true,
    });
    expect(agent.name).toBe("dsh");
  });

  it("routes deepseek pro direct to dsh too", () => {
    process.env.DEEPSEEK_API_KEY = "sk-test";
    const agent = resolveAgent({
      model: "deepseek/deepseek-v4-pro",
      dshEnabled: true,
    });
    expect(agent.name).toBe("dsh");
  });

  it("stays on opencode for deepseek when the kill switch is off", () => {
    process.env.DEEPSEEK_API_KEY = "sk-test";
    const agent = resolveAgent({ model: "deepseek/deepseek-v4-flash", dshEnabled: false });
    expect(agent.name).toBe("opencode");
  });

  it("routes openrouter-served deepseek models to dsh on proxy runs", () => {
    const agent = resolveAgent({
      proxyModel: "openrouter/deepseek/deepseek-v4-pro-0813",
      dshEnabled: true,
    });
    expect(agent.name).toBe("dsh");
  });

  it("keeps non-deepseek proxy models on opencode", () => {
    const agent = resolveAgent({
      proxyModel: "openrouter/anthropic/claude-opus-5",
      dshEnabled: true,
    });
    expect(agent.name).toBe("opencode");
  });

  it("does not route deepseek to dsh without the direct key", () => {
    const agent = resolveAgent({ model: "deepseek/deepseek-v4-flash", dshEnabled: true });
    expect(agent.name).toBe("opencode");
  });

  it("honors an explicit agent: opencode pick over the deepseek auto route", () => {
    process.env.DEEPSEEK_API_KEY = "sk-test";
    const agent = resolveAgent({
      model: "deepseek/deepseek-v4-flash",
      dshEnabled: true,
      agent: "opencode",
    });
    expect(agent.name).toBe("opencode");
  });

  it("hard-fails an explicit dsh pick when the kill switch is off", () => {
    expect(() =>
      resolveAgent({ model: "deepseek/deepseek-v4-flash", dshEnabled: false, agent: "dsh" })
    ).toThrow(/not enabled/);
  });

  it("PULLFROG_AGENT=dsh bypasses the kill switch (escape hatch)", () => {
    process.env.PULLFROG_AGENT = "dsh";
    const agent = resolveAgent({ model: "anthropic/claude-opus-5", dshEnabled: false });
    expect(agent.name).toBe("dsh");
  });
});

describe("assertAgentModelCompatible — explicit agent compatibility gate", () => {
  it("allows opencode for any model", () => {
    expect(() => assertAgentModelCompatible("opencode", "deepseek/deepseek-v4-flash")).not.toThrow();
    expect(() => assertAgentModelCompatible("opencode", "google/gemini-3.6-flash")).not.toThrow();
  });

  it("allows dsh only for deepseek models (direct and openrouter)", () => {
    expect(() => assertAgentModelCompatible("dsh", "deepseek/deepseek-v4-pro")).not.toThrow();
    expect(() =>
      assertAgentModelCompatible("dsh", "openrouter/deepseek/deepseek-v4-flash-latest")
    ).not.toThrow();
    expect(() => assertAgentModelCompatible("dsh", "anthropic/claude-opus-5")).toThrow(/cannot run model/);
    expect(() => assertAgentModelCompatible("dsh", "google/gemini-3.6-flash")).toThrow();
  });

  it("allows claude only for anthropic models", () => {
    expect(() => assertAgentModelCompatible("claude", "anthropic/claude-opus-5")).not.toThrow();
    expect(() => assertAgentModelCompatible("claude", "deepseek/deepseek-v4-flash")).toThrow();
  });

  it("allows codex only for openai models", () => {
    expect(() => assertAgentModelCompatible("codex", "openai/gpt-5.6-sol")).not.toThrow();
    expect(() => assertAgentModelCompatible("codex", "deepseek/deepseek-v4-flash")).toThrow();
  });

  it("allows every explicit agent when no model is configured (harness auto-selects)", () => {
    for (const name of ["claude", "codex", "opencode", "dsh"] as const) {
      expect(() => assertAgentModelCompatible(name, undefined)).not.toThrow();
    }
  });
});

describe("formatMcpToolRef / extractMcpToolRefs — dsh naming", () => {
  it("formats dsh tool refs as mcp__pullfrog__<tool>", () => {
    expect(formatMcpToolRef("dsh", "select_mode")).toBe("mcp__pullfrog__select_mode");
  });

  it("extracts dsh tool refs without colliding with claude-style prefixes", () => {
    const text = "use mcp__pullfrog__checkout_pr and mcp__pullfrog__shell";
    expect(extractMcpToolRefs("dsh", text)).toEqual(["checkout_pr", "shell"]);
  });
});

describe("agent registry", () => {
  it("registers the dsh harness", () => {
    expect(agents.dsh).toBeDefined();
    expect(agents.dsh.name).toBe("dsh");
  });
});

describe("resolveAgent — openrouter tilde rolling pointer", () => {
  afterEach(() => {
    delete process.env.DEEPSEEK_API_KEY;
  });

  it("routes openrouter/~deepseek rolling-pointer models to dsh on proxy runs", () => {
    process.env.DEEPSEEK_API_KEY = "sk-test";
    const agent = resolveAgent({
      proxyModel: "openrouter/~deepseek/deepseek-v4-flash-latest",
      dshEnabled: true,
    });
    expect(agent.name).toBe("dsh");
  });

  it("keeps non-deepseek proxy runs on opencode even through the tilde unwrap", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    // claude-code does not speak OpenRouter, and the tilde unwrap routes by the
    // INNER provider's capability — openrouter/~anthropic/... is not deepseek,
    // so it stays on opencode exactly as other proxy models do.
    const agent = resolveAgent({
      proxyModel: "openrouter/~anthropic/claude-opus-latest",
      dshEnabled: true,
    });
    expect(agent.name).toBe("opencode");
  });
});

describe("assertAgentModelCompatible — openrouter route consistency", () => {
  it("allows claude pick for openrouter-served anthropic models (tilde and non-tilde)", () => {
    expect(() => assertAgentModelCompatible("claude", "openrouter/anthropic/claude-opus-5")).not.toThrow();
    expect(() =>
      assertAgentModelCompatible("claude", "openrouter/~anthropic/claude-opus-latest")
    ).not.toThrow();
  });

  it("allows dsh pick for openrouter-served deepseek models including the tilde rolling pointer", () => {
    expect(() =>
      assertAgentModelCompatible("dsh", "openrouter/~deepseek/deepseek-v4-flash-latest")
    ).not.toThrow();
    expect(() =>
      assertAgentModelCompatible("dsh", "openrouter/deepseek/deepseek-v4-pro-0813")
    ).not.toThrow();
  });

  it("still rejects dsh for openrouter-served anthropic models", () => {
    expect(() =>
      assertAgentModelCompatible("dsh", "openrouter/~anthropic/claude-opus-latest")
    ).toThrow();
  });
});
