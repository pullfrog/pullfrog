import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { agents } from "../agents/index.ts";
import type { WorkflowPermissions } from "../external.ts";
import { providers } from "../models.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const actionDir = join(__dirname, "..");
const rootDir = join(actionDir, "..");

type WorkflowJob = {
  "runs-on": string;
  "timeout-minutes"?: number;
  permissions?: WorkflowPermissions;
  strategy?: { "fail-fast": boolean; matrix: Record<string, unknown> };
  env?: Record<string, string>;
  steps?: unknown[];
};

type Workflow = {
  name: string;
  jobs: Record<string, WorkflowJob>;
};

const rootWorkflow = parse(
  readFileSync(join(rootDir, ".github/workflows/test.yml"), "utf-8")
) as Workflow;
const actionWorkflow = parse(
  readFileSync(join(actionDir, ".github/workflows/test.yml"), "utf-8")
) as Workflow;

function getTestNamesFromDir(dir: string): string[] {
  const dirPath = join(__dirname, dir);
  const files = readdirSync(dirPath).filter((f) => f.endsWith(".ts"));
  const names: string[] = [];

  for (const file of files) {
    const content = readFileSync(join(dirPath, file), "utf-8");
    const match = content.match(/^\s+name:\s*"([^"]+)"/m);
    if (match) {
      names.push(match[1]);
    }
  }

  return names.sort();
}

function getEnvVarNames(job: WorkflowJob): string[] {
  return Object.keys(job.env ?? {}).sort();
}

const expectedAgents = Object.keys(agents).sort();
const crossagentTests = getTestNamesFromDir("crossagent");
const agnosticTests = getTestNamesFromDir("agnostic");
const adhocTests = getTestNamesFromDir("adhoc");

// all provider API key names + managed credentials (e.g. Codex auth blob)
// + GITHUB_TOKEN + model overrides. byok-only providers (e.g. qwen) are excluded:
// Pullfrog holds no managed key for them, so there's nothing in the CI env blocks.
const isByokOnlyProvider = (p: (typeof providers)[keyof typeof providers]) =>
  Object.values(p.models).every((m) => m.byok);
const expectedAgentEnvVars = [
  "GITHUB_TOKEN",
  ...new Set(
    Object.values(providers)
      .filter((p) => !isByokOnlyProvider(p))
      .flatMap((p) => [...p.envVars, ...(p.managedCredentials ?? [])])
  ),
  "PULLFROG_MODEL",
].sort();

const expectedAgnosticEnvVars = ["ANTHROPIC_API_KEY", "GITHUB_TOKEN"].sort();

describe("ci workflow consistency", () => {
  it("workflow names match", () => {
    expect(rootWorkflow.name).toBe(actionWorkflow.name);
  });

  it("no duplicate test names across directories", () => {
    const allNames = [...crossagentTests, ...agnosticTests, ...adhocTests];
    const duplicates = allNames.filter((name, idx) => allNames.indexOf(name) !== idx);
    expect(duplicates).toEqual([]);
  });

  describe("cross-agent tests", () => {
    const rootJob = rootWorkflow.jobs["action-agents"];
    const actionJob = actionWorkflow.jobs.agents;

    it("root agents matrix is wired to the dynamic matrix output", () => {
      const include = rootJob.strategy?.matrix.include;
      expect(typeof include).toBe("string");
      expect(include as string).toContain("fromJSON(needs.changes.outputs.matrix).agents");
    });

    it("action agent matrix matches agents map", () => {
      expect((actionJob.strategy?.matrix.agent as string[])?.slice().sort()).toEqual(
        expectedAgents
      );
    });

    it("action test matrix matches crossagent/ directory", () => {
      expect((actionJob.strategy?.matrix.test as string[])?.slice().sort()).toEqual(
        crossagentTests
      );
    });

    it("permissions match between root and action", () => {
      expect(rootJob.permissions).toEqual(actionJob.permissions);
    });

    it("timeout-minutes match between root and action", () => {
      expect(rootJob["timeout-minutes"]).toEqual(actionJob["timeout-minutes"]);
    });

    it("env vars match between root and action", () => {
      expect(getEnvVarNames(rootJob)).toEqual(getEnvVarNames(actionJob));
    });

    it("env vars cover all provider API keys", () => {
      expect(getEnvVarNames(rootJob)).toEqual(expectedAgentEnvVars);
    });

    it("fail-fast is enabled in both", () => {
      expect(rootJob.strategy?.["fail-fast"]).toBe(true);
      expect(actionJob.strategy?.["fail-fast"]).toBe(true);
    });
  });

  describe("agnostic tests", () => {
    const rootJob = rootWorkflow.jobs["action-agnostic"];
    const actionJob = actionWorkflow.jobs.agnostic;

    it("root agnostic matrix is wired to the dynamic matrix output", () => {
      const include = rootJob.strategy?.matrix.include;
      expect(typeof include).toBe("string");
      expect(include as string).toContain("fromJSON(needs.changes.outputs.matrix).agnostic");
    });

    it("action test matrix matches agnostic/ directory", () => {
      expect((actionJob.strategy?.matrix.test as string[])?.slice().sort()).toEqual(agnosticTests);
    });

    it("permissions match between root and action", () => {
      expect(rootJob.permissions).toEqual(actionJob.permissions);
    });

    it("timeout-minutes match between root and action", () => {
      expect(rootJob["timeout-minutes"]).toEqual(actionJob["timeout-minutes"]);
    });

    it("env vars match between root and action", () => {
      expect(getEnvVarNames(rootJob)).toEqual(getEnvVarNames(actionJob));
    });

    it("env vars are correct for agnostic tests", () => {
      expect(getEnvVarNames(rootJob)).toEqual(expectedAgnosticEnvVars);
    });

    it("fail-fast is enabled in both", () => {
      expect(rootJob.strategy?.["fail-fast"]).toBe(true);
      expect(actionJob.strategy?.["fail-fast"]).toBe(true);
    });
  });
});
