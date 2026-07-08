import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./cli.ts";
import { getDevDependencyVersion } from "./version.ts";

const skillsVersion = getDevDependencyVersion("skills");

/**
 * skills bundled with the action runtime. the SKILL.md files live in
 * `action/skills/<name>/SKILL.md` and are read at runtime — no esbuild loader,
 * no codegen. this matters because the preview / oss path runs `cli.ts` from
 * source (see `runCli.ts#runLocalCli`) where esbuild loaders don't apply.
 */
const BUNDLED_SKILL_NAMES = ["git-archaeology", "caveman"] as const;

/**
 * resolve the on-disk path of a bundled SKILL.md by checking the two locations
 * the file may live in:
 *   - source mode (`runLocalCli`): `<actionRoot>/skills/<name>/SKILL.md`,
 *     reached as `../skills/...` from `utils/skills.ts`.
 *   - bundled mode (npx published package): `<distDir>/skills/<name>/SKILL.md`,
 *     reached as `./skills/...` from `dist/cli.mjs`.
 *
 * the bundled-mode copy is produced by an esbuild post-build step in
 * `esbuild.config.js`.
 */
function resolveSkillPath(name: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "skills", name, "SKILL.md"),
    join(here, "skills", name, "SKILL.md"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`bundled skill not found: ${name} (looked in ${candidates.join(", ")})`);
}

/**
 * each agent has its own auto-scan dir under HOME. we write to all of them so
 * the same `installBundledSkills` call works regardless of which agent is
 * running, without coupling skills.ts to agent identity.
 *
 * verified empirically (PR #565):
 *   - OpenCode registers skills from `$HOME/.agents/skills/` and `.opencode/skills/`.
 *   - Claude Code only registers skills from `$HOME/.claude/skills/` —
 *     it does NOT scan `.agents/skills/`, so writing only there leaves the
 *     skill on disk but invisible to Claude's `Skill` tool.
 */
const SKILL_TARGET_DIRS = [".opencode/skills", ".claude/skills", ".agents/skills"] as const;

/**
 * write all bundled skills into the fake HOME so OpenCode / Claude Code discover
 * them via their auto-scan directories.
 *
 * called once per agent run from each agent's `run()`. cheap (small file
 * writes), no network, idempotent.
 */
export function installBundledSkills(params: { home: string }): void {
  for (const name of BUNDLED_SKILL_NAMES) {
    const content = readFileSync(resolveSkillPath(name), "utf8");
    for (const targetDir of SKILL_TARGET_DIRS) {
      const skillDir = join(params.home, targetDir, name);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), content);
    }
  }
  log.success(`installed bundled skills: ${BUNDLED_SKILL_NAMES.join(", ")}`);
}

/**
 * install a skill globally via the `skills` CLI.
 *
 * runs `npx skills add <ref> --skill <name> -g` with `cwd` set to os tmpdir
 * so npm doesn't walk up and find a project-level `.npmrc` with pnpm-specific
 * settings (e.g. `public-hoist-pattern`) that break npx binary resolution.
 * the `-g` flag writes to `$HOME/.agents/skills/` which is controlled by
 * `params.env.HOME` (the fake HOME), so cwd has no effect on install location.
 */
export function addSkill(params: {
  ref: string;
  skill: string;
  env: Record<string, string>;
  agent: string;
}): void {
  const result = spawnSync(
    "npx",
    [
      "-y",
      `skills@${skillsVersion}`,
      "add",
      params.ref,
      "--skill",
      params.skill,
      "-g",
      "-a",
      params.agent,
      "-y",
    ],
    {
      cwd: tmpdir(),
      env: { ...process.env, ...params.env },
      stdio: "pipe",
      timeout: 30_000,
    }
  );
  if (result.status === 0) {
    log.success(`installed ${params.skill} skill (${params.agent})`);
    return;
  }
  // skills CLI uses a Clack-style TUI that prints errors to stdout (alongside
  // spinner output), not stderr. report exit code + both streams + spawn
  // error so failures aren't silent. tail-truncate streams to keep CI logs
  // bounded.
  const stdout = (result.stdout?.toString() || "").trim();
  const stderr = (result.stderr?.toString() || "").trim();
  const parts = [
    `exit=${result.status ?? "null"} signal=${result.signal ?? "null"}`,
    result.error ? `spawn error: ${result.error.message}` : null,
    stderr ? `stderr:\n${tailLines(stderr, 20)}` : null,
    stdout ? `stdout:\n${tailLines(stdout, 20)}` : null,
  ].filter(Boolean);
  log.warning(`${params.skill} skill install failed — ${parts.join(" | ")}`);
}

function tailLines(text: string, n: number): string {
  const lines = text.split("\n");
  if (lines.length <= n) return text;
  return `...(truncated, last ${n} of ${lines.length} lines)\n${lines.slice(-n).join("\n")}`;
}
