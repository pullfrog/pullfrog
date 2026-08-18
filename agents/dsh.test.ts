import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCordisPatch, parseSessionUsage } from "../agents/dsh.ts";
import { pullfrogMcpName } from "../external.ts";

const JSONL = [
  { type: "session", version: 0, id: "s1", cwd: "/tmp" },
  { type: "turn/start", seq: 0, data: { turn: 1 } },
  {
    type: "assistant/message",
    seq: 1,
    data: {
      usage: { inputTokens: 100, outputTokens: 25, cacheReadTokens: 300, cacheWriteTokens: 50 },
    },
  },
  {
    type: "assistant/message",
    seq: 2,
    data: {
      usage: { inputTokens: 40, outputTokens: 10, cacheReadTokens: 900 },
    },
  },
  { type: "assistant/chunk", seq: 3, data: { chunk: { type: "text", text: "hi" } } },
  { type: "assistant/chunk", seq: 4, data: { chunk: { type: "usage", usage: { outputTokens: 1 } } } },
  { type: "garbage", data: { usage: "not-an-object" } },
];

describe("parseSessionUsage", () => {
  it("aggregates usage buckets across assistant/message events", () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-usage-"));
    mkdirSync(join(root, "sessions", "x", "s-1"), { recursive: true });
    writeFileSync(
      join(root, "sessions", "x", "s-1", "session.jsonl"),
      JSONL.map((l) => JSON.stringify(l)).join("\n")
    );
    const usage = parseSessionUsage(join(root, "sessions"));
    expect(usage).toEqual({
      agent: "dsh",
      inputTokens: 140,
      outputTokens: 36, // 25 + 10 + 1 from the usage chunk
      cacheReadTokens: 1200,
      cacheWriteTokens: 50,
    });
  });

  it("returns undefined with no usage events", () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-usage-"));
    mkdirSync(join(root, "sessions", "x"), { recursive: true });
    writeFileSync(join(root, "sessions", "x", "session.jsonl"), JSON.stringify({ type: "session" }));
    expect(parseSessionUsage(join(root, "sessions"))).toBeUndefined();
  });

  it("returns undefined for a missing sessions dir", () => {
    expect(parseSessionUsage(join(tmpdir(), "dsh-usage-does-not-exist-" + Math.random()))).toBeUndefined();
  });
});

describe("buildCordisPatch", () => {
  const base = { dshHome: "/tmp/home", mcpServerUrl: "http://127.0.0.1:9999/mcp" };

  it("configures the native deepseek provider for direct runs", () => {
    const yaml = buildCordisPatch({
      ...base,
      providerId: "deepseek-official",
      modelId: "deepseek-v4-pro",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      effortRung: "max",
    });
    expect(yaml).toContain("provider: deepseek-official");
    expect(yaml).toContain("model: deepseek-v4-pro");
    expect(yaml).toContain("apiKeyEnv: DEEPSEEK_API_KEY");
    expect(yaml).toContain("reasoningEffort: max");
    expect(yaml).toContain("id: deepseek-v4-pro");
    expect(yaml).toContain("compression: none");
  });

  it("configures the openrouter custom provider for proxy runs", () => {
    const yaml = buildCordisPatch({
      ...base,
      providerId: "openrouter",
      modelId: "deepseek/deepseek-v4-pro-0813",
      apiKeyEnv: "OPENROUTER_API_KEY",
      effortRung: "high",
    });
    expect(yaml).toContain("provider: openrouter");
    expect(yaml).toContain("baseURL: https://openrouter.ai/api/v1");
    expect(yaml).toContain("id: deepseek/deepseek-v4-pro-0813");
    expect(yaml).toContain("reasoning: high");
    expect(yaml).toContain("apiKeyEnv: OPENROUTER_API_KEY");
  });

  it("inserts the mcp-client plugin with the pullfrog server name and long tool timeout", () => {
    const yaml = buildCordisPatch({ ...base, providerId: "deepseek-official", modelId: "deepseek-v4-flash", apiKeyEnv: "DEEPSEEK_API_KEY", effortRung: undefined });
    expect(yaml).toContain("- insert:");
    expect(yaml).toContain("name: '@deepseek-ai/dsh-mcp-client'");
    expect(yaml).toContain(`serverName: ${pullfrogMcpName}`);
    expect(yaml).toContain("transport: streamable-http");
    expect(yaml).toContain("url: http://127.0.0.1:9999/mcp");
    expect(yaml).toContain("toolCallTimeoutMs: 660000");
    expect(yaml).toContain("failOnStartupError: true");
  });

  it("disables every native tool surface", () => {
    const yaml = buildCordisPatch({ ...base, providerId: "deepseek-official", modelId: "deepseek-v4-flash", apiKeyEnv: "DEEPSEEK_API_KEY", effortRung: undefined });
    for (const id of ["tool-bash", "tool-pwsh", "tool-jobs", "tool-fs", "tool-fs-search", "tool-str-replace-editor", "tool-web", "web-search-deepseek", "tool-skill", "skill-filesystem", "tool-subagent", "tool-subagent-fork", "tool-subagent-control", "tool-subagent-list-agents", "tool-subagent-report", "tool-workflow", "tool-ralph"]) {
      expect(yaml).toContain(`- id: ${id}\n  disabled: true`);
    }
    expect(yaml).not.toContain("id: tool-goal");
    // the old package-name id must not be used (matches nothing, fail-open)
    expect(yaml).not.toContain("tool-subagent-control/list-agents");
  });

  it("omits the effort key when no rung maps", () => {
    const yaml = buildCordisPatch({ ...base, providerId: "deepseek-official", modelId: "deepseek-v4-flash", apiKeyEnv: "DEEPSEEK_API_KEY", effortRung: undefined });
    expect(yaml).not.toContain("reasoningEffort");
  });
});
