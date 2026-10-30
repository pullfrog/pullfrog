import { randomUUID } from "node:crypto";
import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import { defineFixture, getAgentOutput } from "../utils.ts";

const skillName = "pullfrog-skill-check";
const token = randomUUID();

const fixture = defineFixture(
  {
    prompt: `Do not modify any files.

Use the skill tool to load ${skillName}.
Then call set_output with exactly this token and nothing else: ${token}`,
    shell: "restricted",
    push: "disabled",
    timeout: "4m",
  },
  { localOnly: true }
);

const repoSetup = `mkdir -p .claude/skills/${skillName} .opencode/skills/${skillName} && printf '%s\\n' '---' 'name: ${skillName}' 'description: local skill test token source' '---' '' 'token: ${token}' > .claude/skills/${skillName}/SKILL.md && cp .claude/skills/${skillName}/SKILL.md .opencode/skills/${skillName}/SKILL.md`;

function validator(result: AgentResult): ValidationCheck[] {
  const setOutputCalled = result.structuredOutput !== null;
  const tokenMatches = result.structuredOutput === token;

  const agentOutput = getAgentOutput(result);
  // V1's skill tool takes `name`, V2's `id`
  const skillInvoked = /skill\(\{[^)]*"(name|id)":"pullfrog-skill-check"/.test(agentOutput);

  return [
    { name: "set_output", passed: setOutputCalled },
    { name: "token_matches", passed: tokenMatches },
    { name: "skill_invoked", passed: skillInvoked },
  ];
}

export const test: TestRunnerOptions = {
  name: "skill-invoke-opencode",
  fixture,
  validator,
  agents: ["opencode"],
  repoSetup,
  env: {
    PULLFROG_DISABLE_SECURITY_INSTRUCTIONS: "1",
    PULLFROG_MODEL: "anthropic/claude-sonnet-4-6",
  },
};
