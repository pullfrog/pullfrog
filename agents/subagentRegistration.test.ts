import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const claudeSource = readFileSync(join(__dirname, "claude.ts"), "utf-8");
const opencodeSharedSource = readFileSync(join(__dirname, "opencodeShared.ts"), "utf-8");
const opencodeV2Source = readFileSync(join(__dirname, "opencode_v2.ts"), "utf-8");

/**
 * The Claude Code `--agents` JSON and OpenCode `agent` config block are the
 * only places where per-subagent model overrides take effect. They're built
 * by string-only helpers we don't export, so this test reads the source and
 * asserts the literal model strings + agent names are wired in. A regression
 * here means the next review run silently runs lenses on Opus instead of
 * Sonnet.
 */
describe("subagent registration source asserts", () => {
  describe("claude.ts buildAgentsJson", () => {
    it("registers reviewfrog with sonnet model", () => {
      expect(claudeSource).toMatch(/\[REVIEWER_AGENT_NAME\]:\s*\{[^}]*model:\s*"claude-sonnet-5"/s);
    });
    it("imports the reviewer name constant", () => {
      expect(claudeSource).toMatch(/REVIEWER_AGENT_NAME/);
    });
  });

  describe("opencodeShared.ts buildReviewerAgentConfig", () => {
    it("registers reviewfrog with mode: subagent", () => {
      expect(opencodeSharedSource).toMatch(/\[REVIEWER_AGENT_NAME\]:[^}]*mode:\s*"subagent"/s);
    });
    it("uses deriveSubagentModels for the reviewer model override", () => {
      expect(opencodeSharedSource).toMatch(/deriveSubagentModels\(/);
      expect(opencodeSharedSource).toMatch(/overrides\.reviewer/);
    });
    it("v2 runner passes orchestrator model to buildReviewerAgentConfig", () => {
      expect(opencodeV2Source).toMatch(/buildReviewerAgentConfig\(params\.model\)/);
    });
  });
});
