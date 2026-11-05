import { existsSync, readdirSync, readFileSync } from "node:fs";
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

/** where V1 loads a checkout's code from: V2 skips a V1 plugin and has no custom-tool directory. */
const V1_CODE_DIRS = ["plugin", "plugins", "tool", "tools"];

let decided: OpencodeGeneration | undefined;

type GenerationInput = { cwd: string; rollouts: readonly string[] };

/**
 * Which OpenCode drives the run. V2 (`@opencode/cli`) is the default; V1 (`opencode-ai`) runs when
 * `PULLFROG_OPENCODE_VERSION=1` pins it, when the checkout carries code only V1 can run, or when the
 * server assigned the run to the `opencode-v1` rollout. Decided once per run: main.ts calls this with
 * the checkout before anything installs opencode. See wiki/opencode-v2.md.
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
  const v1Code = findV1Code(input.cwd);
  if (v1Code) return { generation: 1, reason: `the checkout's ${v1Code} needs V1` };
  const rollback: Rollout = "opencode-v1";
  if (input.rollouts.includes(rollback)) return { generation: 1, reason: `rollout ${rollback}` };
  return { generation: 2, reason: "default" };
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

/**
 * The code in a checkout that stops running on V2, if any. Everything else in a V1 setup keeps
 * working: V2 reads its agents, commands and skills, and migrates its config in memory.
 */
function findV1Code(cwd: string): string | undefined {
  for (const file of CONFIG_FILES) {
    const config = readJsonc(join(cwd, file));
    if (isObject(config) && Array.isArray(config.plugin) && config.plugin.length > 0) {
      return `${file} \`plugin\``;
    }
  }
  for (const dir of V1_CODE_DIRS) {
    const path = join(".opencode", dir);
    const source = readSources(join(cwd, path)).find(
      (file) => !file.text.includes("@opencode/plugin")
    );
    if (source) return join(path, source.name);
  }
  return undefined;
}

/** the `.ts` and `.js` files directly inside `dir`, as V1 discovers them. unreadable is no signal. */
function readSources(dir: string): { name: string; text: string }[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.[jt]s$/.test(entry.name))
      .map((entry) => ({ name: entry.name, text: readFileSync(join(dir, entry.name), "utf-8") }));
  } catch {
    return [];
  }
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
