import { isValid } from "verkit";
import packageJson from "../package.json" with { type: "json" };

export function getDevDependencyVersion(name: keyof typeof packageJson.devDependencies): string {
  const version = packageJson.devDependencies[name];
  if (!isValid(version)) {
    throw new Error(`dev dependency "${name}" must be a pinned version, got "${version}"`);
  }
  return version;
}

const HARNESS_PACKAGES = ["@anthropic-ai/claude-code", "@openai/codex", "opencode-ai"] as const;

/** the CLIs the harnesses install. a model registry is written against these, so a served one applies only where they match. */
export function getHarnessPins(): Record<string, string> {
  return Object.fromEntries(HARNESS_PACKAGES.map((name) => [name, getDevDependencyVersion(name)]));
}
