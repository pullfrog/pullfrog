import { existsSync, readdirSync, readFileSync } from "node:fs";
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

function readWorkflow(dir: string): Workflow {
  const p1 = join(dir, ".github/workflows/test.yml");
  const p2 = join(dir, ".github/workflows/test.yml.disabled");
  const file = existsSync(p1) ? p1 : (existsSync(p2) ? p2 : null);
  if (!file) {
    return { name: "", jobs: {} };
  }
  return parse(readFileSync(file, "utf-8")) as Workflow;
}

const rootWorkflowPath = existsSync(join(rootDir, ".github/workflows/test.yml"))
  ? join(rootDir, ".github/workflows/test.yml")
  : (existsSync(join(rootDir, ".github/workflows/test.yml.disabled"))
      ? join(rootDir, ".github/workflows/test.yml.disabled")
      : null);

const hasRootWorkflow = rootWorkflowPath !== null;

const rootWorkflow = hasRootWorkflow
  ? (parse(readFileSync(rootWorkflowPath, "utf-8")) as Workflow)
  : ({ name: "", jobs: {} } as Workflow);

const actionWorkflow = readWorkflow(actionDir);

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
// + GITHUB_TOKEN + model overrides
const expectedAgentEnvVars = [
  "GITHUB_TOKEN",
  ...new Set(
    Object.values(providers).flatMap((p) => [...p.envVars, ...(p.managedCredentials ?? [])])
  ),
  "PULLFROG_MODEL",
].sort();

const expectedAgnosticEnvVars = ["ANTHROPIC_API_KEY", "GITHUB_TOKEN"].sort();

describe("ci workflow consistency", () => {
  it("workflow names match", () => {
    if (!hasRootWorkflow) return;
    expect(rootWorkflow.name).toBe(actionWorkflow.name);
  });

  it("no duplicate test names across directories", () => {
    const allNames = [...crossagentTests, ...agnosticTests, ...adhocTests];
    const duplicates = allNames.filter((name, idx) => allNames.indexOf(name) !== idx);
    expect(duplicates).toEqual([]);
  });

  describe("cross-agent tests", () => {
    const rootJob = rootWorkflow.jobs["action-agents"] ?? { "runs-on": "" };
    const actionJob = actionWorkflow.jobs.agents;

    it("root agents matrix is wired to the dynamic matrix output", () => {
      if (!hasRootWorkflow) return;
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
      if (!hasRootWorkflow) return;
      expect(rootJob.permissions).toEqual(actionJob.permissions);
    });

    it("timeout-minutes match between root and action", () => {
      if (!hasRootWorkflow) return;
      expect(rootJob["timeout-minutes"]).toEqual(actionJob["timeout-minutes"]);
    });

    it("env vars match between root and action", () => {
      if (!hasRootWorkflow) return;
      expect(getEnvVarNames(rootJob)).toEqual(getEnvVarNames(actionJob));
    });

    it("env vars cover all provider API keys", () => {
      if (!hasRootWorkflow) return;
      expect(getEnvVarNames(rootJob)).toEqual(expectedAgentEnvVars);
    });

    it("fail-fast is enabled in both", () => {
      if (!hasRootWorkflow) return;
      expect(rootJob.strategy?.["fail-fast"]).toBe(true);
      expect(actionJob.strategy?.["fail-fast"]).toBe(true);
    });
  });

  describe("agnostic tests", () => {
    const rootJob = rootWorkflow.jobs["action-agnostic"] ?? { "runs-on": "" };
    const actionJob = actionWorkflow.jobs.agnostic;

    it("root agnostic matrix is wired to the dynamic matrix output", () => {
      if (!hasRootWorkflow) return;
      const include = rootJob.strategy?.matrix.include;
      expect(typeof include).toBe("string");
      expect(include as string).toContain("fromJSON(needs.changes.outputs.matrix).agnostic");
    });

    it("action test matrix matches agnostic/ directory", () => {
      expect((actionJob.strategy?.matrix.test as string[])?.slice().sort()).toEqual(agnosticTests);
    });

    it("permissions match between root and action", () => {
      if (!hasRootWorkflow) return;
      expect(rootJob.permissions).toEqual(actionJob.permissions);
    });

    it("timeout-minutes match between root and action", () => {
      if (!hasRootWorkflow) return;
      expect(rootJob["timeout-minutes"]).toEqual(actionJob["timeout-minutes"]);
    });

    it("env vars match between root and action", () => {
      if (!hasRootWorkflow) return;
      expect(getEnvVarNames(rootJob)).toEqual(getEnvVarNames(actionJob));
    });

    it("env vars are correct for agnostic tests", () => {
      if (!hasRootWorkflow) return;
      expect(getEnvVarNames(rootJob)).toEqual(expectedAgnosticEnvVars);
    });

    it("fail-fast is enabled in both", () => {
      if (!hasRootWorkflow) return;
      expect(rootJob.strategy?.["fail-fast"]).toBe(true);
      expect(actionJob.strategy?.["fail-fast"]).toBe(true);
    });
  });
});
