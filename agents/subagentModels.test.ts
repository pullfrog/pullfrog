import { describe, expect, it } from "vitest";
import { deriveSubagentModels } from "./subagentModels.ts";

describe("deriveSubagentModels", () => {
  it("returns no override when orchestrator is undefined", () => {
    expect(deriveSubagentModels(undefined)).toEqual({ reviewer: undefined });
  });

  it("returns no override when orchestrator slug isn't registered", () => {
    expect(deriveSubagentModels("nonexistent/model")).toEqual({ reviewer: undefined });
  });

  describe("anthropic family — opus → sonnet", () => {
    it("direct anthropic opus", () => {
      expect(deriveSubagentModels("anthropic/claude-opus-5-5")).toEqual({
        reviewer: "anthropic/claude-sonnet-5-5",
      });
    });
    it("opencode-vendored opus stays on opencode prefix", () => {
      expect(deriveSubagentModels("opencode/claude-opus-5-5")).toEqual({
        reviewer: "opencode/claude-sonnet-5-5",
      });
    });
    it("openrouter-anthropic-opus-via-anthropic-direct hits anthropic alias's openRouterResolve", () => {
      // both the anthropic alias and the opencode alias have the same
      // openRouterResolve. first-match-wins by alias declaration order
      // (anthropic declared first in providers).
      expect(deriveSubagentModels("openrouter/anthropic/claude-opus-5.5")).toEqual({
        reviewer: "openrouter/anthropic/claude-sonnet-5.5",
      });
    });
    it("sonnet has no further downshift", () => {
      expect(deriveSubagentModels("anthropic/claude-sonnet-5-5")).toEqual({ reviewer: undefined });
      expect(deriveSubagentModels("opencode/claude-sonnet-5-5")).toEqual({ reviewer: undefined });
    });
    it("haiku has no downshift", () => {
      expect(deriveSubagentModels("anthropic/claude-haiku-5-5")).toEqual({ reviewer: undefined });
    });
  });

  describe("openai family", () => {
    it.each(["openai", "opencode", "openrouter/openai", "vercel/openai"])(
      "Astra uses Sol on the same route (%s)",
      (route) => {
        expect(deriveSubagentModels(`${route}/gpt-6-astra`)).toEqual({
          reviewer: `${route}/gpt-6.1-sol`,
        });
      }
    );
    it("gpt → gpt-terra (direct)", () => {
      expect(deriveSubagentModels("openai/gpt-6.1-sol")).toEqual({
        reviewer: "openai/gpt-5.6-terra",
      });
    });
    it("gpt → gpt-terra (opencode-vendored)", () => {
      expect(deriveSubagentModels("opencode/gpt-6.1-sol")).toEqual({
        reviewer: "opencode/gpt-5.6-terra",
      });
    });
    it("gpt → gpt-terra (openrouter)", () => {
      expect(deriveSubagentModels("openrouter/openai/gpt-6.1-sol")).toEqual({
        reviewer: "openrouter/openai/gpt-5.6-terra",
      });
    });
    // gpt-pro's direct-key resolve is plain Sol (no -pro id on models.dev), so it
    // collides with `gpt` and downshifts to Terra like Sol; only the OpenRouter
    // sol-pro route is distinct, and its subagent is the flagship Sol.
    it("gpt-pro → gpt (openrouter sol-pro route)", () => {
      expect(deriveSubagentModels("openrouter/openai/gpt-6.1-sol-pro")).toEqual({
        reviewer: "openrouter/openai/gpt-6.1-sol",
      });
    });
    it("gpt-terra itself (the subagent target) has no further downshift", () => {
      expect(deriveSubagentModels("openai/gpt-5.6-terra")).toEqual({ reviewer: undefined });
    });
    it("gpt-mini has no downshift", () => {
      expect(deriveSubagentModels("openai/gpt-6-luna")).toEqual({ reviewer: undefined });
    });
  });

  describe("google (gemini) — inherit (Pro for both orchestrator and lenses)", () => {
    // pro → flash was a meaningful capability cliff (Flash missed catastrophic
    // cross-file bugs the v4 e2e test surfaced); Pro is cost-effective enough
    // to keep on for lenses too. Google has no in-between tier.
    it("direct google pro inherits", () => {
      expect(deriveSubagentModels("google/gemini-3.1-pro-preview")).toEqual({
        reviewer: undefined,
      });
    });
    it("opencode-vendored gemini-pro inherits", () => {
      expect(deriveSubagentModels("opencode/gemini-3.1-pro")).toEqual({
        reviewer: undefined,
      });
    });
    it("openrouter gemini-pro inherits", () => {
      expect(deriveSubagentModels("openrouter/google/gemini-3.1-pro-preview")).toEqual({
        reviewer: undefined,
      });
    });
    it("flash has no downshift", () => {
      expect(deriveSubagentModels("google/gemini-3-flash-preview")).toEqual({
        reviewer: undefined,
      });
    });
  });

  describe("providers / models without a subagentModel — inherit", () => {
    it("xai grok (already cheap flagship)", () => {
      expect(deriveSubagentModels("xai/grok-4.7")).toEqual({ reviewer: undefined });
    });
    it("deepseek", () => {
      expect(deriveSubagentModels("deepseek/deepseek-v4-pro")).toEqual({ reviewer: undefined });
    });
    it("moonshot kimi", () => {
      expect(deriveSubagentModels("moonshotai/kimi-k2.7-code")).toEqual({ reviewer: undefined });
    });
    it("opencode big-pickle", () => {
      expect(deriveSubagentModels("opencode/big-pickle")).toEqual({ reviewer: undefined });
    });
    it("legacy fallback aliases (gpt-codex, deepseek-reasoner)", () => {
      expect(deriveSubagentModels("openai/gpt-5.3-codex")).toEqual({ reviewer: undefined });
      expect(deriveSubagentModels("deepseek/deepseek-reasoner")).toEqual({ reviewer: undefined });
    });
  });
});
