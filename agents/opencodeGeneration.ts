import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Rollout } from "../external.ts";
import { log } from "../utils/cli.ts";

export type OpencodeGeneration = 1 | 2;

const CONFIG_FILES = [
  "opencode.json",
  "opencode.jsonc",
  ".opencode/opencode.json",
  ".opencode/opencode.jsonc",
];

/** top-level keys only V2 reads: V1 refuses `permissions` and silently ignores the rest. */
const V2_CONFIG_KEYS = [
  "permissions",
  "agents",
  "providers",
  "plugins",
  "policies",
  "snapshots",
  "media",
  "commands",
];

let decided: OpencodeGeneration | undefined;

type GenerationInput = { cwd: string; rollouts: readonly string[] };

/**
 * Which OpenCode drives the run. V1 (`opencode-ai`) is the default; V2 (`@opencode/cli`) runs when
 * `PULLFROG_OPENCODE_VERSION=2` opts in, when the checkout's own OpenCode setup is written for V2, or
 * when the server assigned the run to the `opencode-v2` rollout. Decided once per run: main.ts calls
 * this with the checkout before anything installs opencode. See wiki/opencode-v2.md.
 */
export function opencodeGeneration(
  input: GenerationInput = { cwd: process.cwd(), rollouts: [] }
): OpencodeGeneration {
  if (decided) return decided;
  const pick = decide(input);
  decided = pick.generation;
  log.info(`» opencode: V${pick.generation} (${pick.reason})`);
  return decided;
}

function decide(input: GenerationInput): { generation: OpencodeGeneration; reason: string } {
  const pinned = process.env.PULLFROG_OPENCODE_VERSION?.trim();
  if (pinned === "1") return { generation: 1, reason: "PULLFROG_OPENCODE_VERSION=1" };
  if (pinned === "2") return { generation: 2, reason: "PULLFROG_OPENCODE_VERSION=2" };
  if (pinned) log.warning(`» PULLFROG_OPENCODE_VERSION=${pinned} is not 1 or 2; ignoring it`);
  for (const file of CONFIG_FILES) {
    const key = v2ConfigKey(readJsonc(join(input.cwd, file)));
    if (key) return { generation: 2, reason: `${file} sets V2's \`${key}\`` };
  }
  if (dependsOnV2Plugin(readJsonc(join(input.cwd, ".opencode", "package.json")))) {
    return { generation: 2, reason: ".opencode/package.json depends on @opencode/plugin" };
  }
  const rollout: Rollout = "opencode-v2";
  if (input.rollouts.includes(rollout)) {
    // the rollout measures our harness on V2, not how V2 reads a setup written for V1
    const own = [...CONFIG_FILES, ".opencode"].find((path) => existsSync(join(input.cwd, path)));
    if (!own) return { generation: 2, reason: `rollout ${rollout}` };
    return { generation: 1, reason: `rollout ${rollout} skipped: the checkout has its own ${own}` };
  }
  return { generation: 1, reason: "default" };
}

function v2ConfigKey(config: unknown): string | undefined {
  if (!isObject(config)) return undefined;
  const key = V2_CONFIG_KEYS.find((name) => name in config);
  if (key) return key;
  // V1's `skills` is `{ paths, urls }`; V2 made it one list
  if (Array.isArray(config.skills)) return "skills";
  if (isObject(config.mcp) && "servers" in config.mcp) return "mcp.servers";
  return undefined;
}

/** V1 plugins import `@opencode-ai/plugin`; V2 renamed the package. */
function dependsOnV2Plugin(manifest: unknown): boolean {
  if (!isObject(manifest)) return false;
  return [manifest.dependencies, manifest.devDependencies].some(
    (dependencies) => isObject(dependencies) && "@opencode/plugin" in dependencies
  );
}

const STRING = /"(?:\\.|[^"\\])*"/.source;
const COMMENT = new RegExp(`(${STRING})|//[^\\n]*|/\\*[\\s\\S]*?\\*/`, "g");
const TRAILING_COMMA = new RegExp(`(${STRING})|,(?=\\s*[}\\]])`, "g");

/** JSON with comments and trailing commas, as opencode reads it. unreadable is no signal. */
function readJsonc(path: string): unknown {
  if (!existsSync(path)) return undefined;
  const keepStrings = (_match: string, string: string | undefined) => string ?? "";
  try {
    const text = readFileSync(path, "utf-8").replace(COMMENT, keepStrings);
    return JSON.parse(text.replace(TRAILING_COMMA, keepStrings));
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
