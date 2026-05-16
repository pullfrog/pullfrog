import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Inputs, JsonPayload, resolvePromptInput } from "./payload.ts";

const savedEnv = { ...process.env };

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "pullfrog-payload-test-"));
  process.env = { ...savedEnv };
  delete process.env.INPUT_PROMPT;
  delete process.env.INPUT_PROMPT_FILE;
  delete process.env.GITHUB_WORKSPACE;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

describe("Inputs schema", () => {
  it("accepts prompt inputs", () => {
    const result = Inputs.assert({ prompt: "test prompt" });
    expect(result).toEqual({ prompt: "test prompt" });
    expect(Inputs.assert({ prompt_file: ".github/pullfrog/triage.md" })).toEqual({
      prompt_file: ".github/pullfrog/triage.md",
    });
    expect(() => Inputs.assert({})).not.toThrow();
  });

  it.each([
    ["push", "enabled"],
    ["push", "disabled"],
    ["push", undefined],
    ["shell", "enabled"],
    ["shell", "restricted"],
    ["shell", "disabled"],
    ["shell", undefined],
    ["timeout", "10m"],
    ["timeout", "1h30m"],
    ["timeout", "30s"],
    ["timeout", undefined],
  ] as const)("should accept %s for %s", (prop, value) => {
    const input = { prompt: "test", [prop]: value };
    expect(() => Inputs.assert(input)).not.toThrow();
  });

  it.each([["push"], ["shell"]] as const)("should reject invalid %s values", (prop) => {
    const input = { prompt: "test", [prop]: "invalid" as any };
    expect(() => Inputs.assert(input)).toThrow();
  });
});

describe("resolvePromptInput", () => {
  it("returns the prompt input when only prompt is set", () => {
    process.env.INPUT_PROMPT = "test prompt";

    expect(resolvePromptInput()).toBe("test prompt");
  });

  it("reads prompt_file relative to GITHUB_WORKSPACE", () => {
    process.env.GITHUB_WORKSPACE = tempDir;
    process.env.INPUT_PROMPT_FILE = ".github/pullfrog/triage.md";
    const promptPath = join(tempDir, ".github", "pullfrog", "triage.md");
    mkdirSync(dirname(promptPath), { recursive: true });
    writeFileSync(promptPath, "triage prompt\n");

    expect(resolvePromptInput()).toBe("triage prompt\n");
  });

  it("throws when prompt and prompt_file are both set", () => {
    process.env.GITHUB_WORKSPACE = tempDir;
    process.env.INPUT_PROMPT = "test prompt";
    process.env.INPUT_PROMPT_FILE = ".github/pullfrog/triage.md";

    expect(() => resolvePromptInput()).toThrow(
      "Set exactly one of 'prompt' or 'prompt_file' inputs, not both."
    );
  });

  it("throws when neither prompt nor prompt_file is set", () => {
    expect(() => resolvePromptInput()).toThrow(
      "One of 'prompt' or 'prompt_file' inputs is required."
    );
  });

  it("throws when prompt_file resolves outside GITHUB_WORKSPACE", () => {
    const workspace = join(tempDir, "workspace");
    mkdirSync(workspace);
    process.env.GITHUB_WORKSPACE = workspace;
    process.env.INPUT_PROMPT_FILE = "../triage.md";

    expect(() => resolvePromptInput()).toThrow(
      'prompt_file "../triage.md" resolves outside GITHUB_WORKSPACE.'
    );
  });

  it("allows an absolute prompt_file path inside GITHUB_WORKSPACE", () => {
    process.env.GITHUB_WORKSPACE = tempDir;
    const promptPath = join(tempDir, ".github", "pullfrog", "triage.md");
    mkdirSync(dirname(promptPath), { recursive: true });
    writeFileSync(promptPath, "absolute prompt\n");
    process.env.INPUT_PROMPT_FILE = promptPath;

    expect(resolvePromptInput()).toBe("absolute prompt\n");
  });

  it("does not parse prompt_file contents as an internal JSON payload", () => {
    process.env.GITHUB_WORKSPACE = tempDir;
    const promptPath = join(tempDir, "prompt.json");
    const prompt = JSON.stringify({
      "~pullfrog": true,
      version: "0.1.6",
      prompt: "internal dispatch prompt",
    });
    writeFileSync(promptPath, prompt);
    process.env.INPUT_PROMPT_FILE = promptPath;

    expect(resolvePromptInput()).toBe(prompt);
  });

  it("rejects a symlink that resolves outside GITHUB_WORKSPACE", () => {
    // workspace lives under a sibling directory; the symlink itself is inside
    // workspace but points to an "outside" target. lexical check passes
    // (`.github/escape.md` does not traverse out of workspace), so only the
    // realpath check can catch the bypass.
    const workspace = join(tempDir, "workspace");
    const outside = join(tempDir, "outside");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const outsideFile = join(outside, "secret.md");
    writeFileSync(outsideFile, "secret\n");
    const symlinkDir = join(workspace, ".github");
    mkdirSync(symlinkDir, { recursive: true });
    symlinkSync(outsideFile, join(symlinkDir, "escape.md"));

    process.env.GITHUB_WORKSPACE = workspace;
    process.env.INPUT_PROMPT_FILE = ".github/escape.md";

    expect(() => resolvePromptInput()).toThrow(
      'prompt_file ".github/escape.md" resolves outside GITHUB_WORKSPACE.'
    );
  });

  it("allows a symlink that resolves inside GITHUB_WORKSPACE", () => {
    // sanity check the symlink path: a symlink whose realpath stays inside
    // the workspace should still be readable.
    const workspace = realpathSync(tempDir);
    const target = join(workspace, "shared", "triage.md");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "shared prompt\n");
    const linkDir = join(workspace, ".github", "pullfrog");
    mkdirSync(linkDir, { recursive: true });
    symlinkSync(target, join(linkDir, "triage.md"));

    process.env.GITHUB_WORKSPACE = workspace;
    process.env.INPUT_PROMPT_FILE = ".github/pullfrog/triage.md";

    expect(resolvePromptInput()).toBe("shared prompt\n");
  });

  it("throws when prompt_file is empty", () => {
    process.env.GITHUB_WORKSPACE = tempDir;
    const promptPath = join(tempDir, "empty.md");
    writeFileSync(promptPath, "");
    process.env.INPUT_PROMPT_FILE = "empty.md";

    expect(() => resolvePromptInput()).toThrow('prompt_file "empty.md" is empty.');
  });

  it("throws when prompt_file is whitespace-only", () => {
    process.env.GITHUB_WORKSPACE = tempDir;
    const promptPath = join(tempDir, "blank.md");
    writeFileSync(promptPath, "   \n\t\n");
    process.env.INPUT_PROMPT_FILE = "blank.md";

    expect(() => resolvePromptInput()).toThrow('prompt_file "blank.md" is empty.');
  });

  it.runIf(process.platform === "win32")(
    "matches GITHUB_WORKSPACE case-insensitively on Windows",
    () => {
      // on Windows the filesystem is case-insensitive but `resolve()` preserves
      // input case, so without normalization a mixed-case GITHUB_WORKSPACE
      // would falsely reject paths that genuinely live inside it.
      process.env.GITHUB_WORKSPACE = tempDir.toUpperCase();
      const promptPath = join(tempDir, "triage.md");
      writeFileSync(promptPath, "windows prompt\n");
      process.env.INPUT_PROMPT_FILE = promptPath;

      expect(resolvePromptInput()).toBe("windows prompt\n");
    }
  );
});

describe("JsonPayload schema", () => {
  it("requires ~pullfrog and version and prompt", () => {
    const result = JsonPayload.assert({
      "~pullfrog": true,
      version: "1.2.3",
      prompt: "test prompt",
    });
    expect(result).toMatchObject({ "~pullfrog": true, version: "1.2.3", prompt: "test prompt" });
    expect(() => JsonPayload.assert({})).toThrow();
    expect(() => JsonPayload.assert({ "~pullfrog": true })).toThrow();
    expect(() => JsonPayload.assert({ version: "1.2.3" })).toThrow();
  });

  it.each([
    ["timeout", "10m"],
    ["timeout", "1h30m"],
    ["timeout", "30s"],
    ["model", "anthropic/claude-opus"],
    ["event", { trigger: "unknown" }],
  ] as const)("should accept optional %s with value %s", (prop, value) => {
    const input = { "~pullfrog": true, version: "1.2.3", prompt: "test prompt", [prop]: value };
    expect(() => JsonPayload.assert(input)).not.toThrow();
  });
});
