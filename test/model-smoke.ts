/**
 * model-smoke: per-alias resolution + auth check that bypasses the Pullfrog
 * harness. resolves a model alias to its concrete provider/model + agent CLI,
 * invokes the CLI directly with a trivial "reply OK" prompt, and asserts the
 * provider replied. validates exactly the surface that changes when models.ts
 * changes — alias → resolve mapping, agent classification, env-var wiring —
 * without booting Docker, MCP, or the full agent runtime.
 *
 * tool-calling correctness is a property of the underlying model, not the
 * alias; the `providers-live` job runs the full harness smoke once per
 * provider (one standard-tier model each), which is enough.
 *
 * usage:
 *   node action/test/model-smoke.ts --slug openai/gpt
 *   PULLFROG_MODEL=openai/gpt node action/test/model-smoke.ts
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "dotenv";
import { opencodeGeneration } from "../agents/opencodeGeneration.ts";
import { installOpencodeCli } from "../agents/opencodeShared.ts";
import { modelAliases, resolveCliModel } from "../models.ts";
import { installFromNpmTarball } from "../utils/install.ts";
import { openCodeHomeEnv, seedModelsCatalog } from "../utils/openCodeModels.ts";
import { getDevDependencyVersion } from "../utils/version.ts";

config({ path: join(import.meta.dirname, "..", ".env") });
config({ path: join(import.meta.dirname, "..", "..", ".env") });

const PROMPT = "Reply with exactly OK and nothing else.";
// leading `\b` only. it carries the whole guard — it rejects the "ok" inside
// `broken` / `token` / `invoke` — while the trailing `\b` rejected nothing but
// legitimate replies: `OKOK` (a model repeating itself) and `OKAY` both failed,
// which is the recurring one-cell red in models-live. what this test validates
// is alias → resolve mapping, agent classification and env wiring, not whether
// a model obeys "and nothing else".
const MATCH = /\bOK/i;
// Sized off the slowest model actually measured, not the slowest provider.
// xai/grok-4.3 lands at 42-67s wall time (vs 23-41s for most), which is what
// the old 120s was built for — but opencode/claude-opus measured 133s SOLO,
// on a warm local machine with no CI burst, so it crossed the old ceiling on
// its own and failed intermittently for no reason this test cares about. The
// smoke asks "does this alias resolve and authenticate", never "is it fast",
// so a timeout here is a false negative.
//
// MUST stay strictly below the job's `timeout-minutes` in test.yml. The two
// used to be equal at 2 minutes and raced: when GitHub won you got
// "The action ... has timed out after 2 minutes" and NO diagnostic; when this
// timer won you got "timed out after 120s" plus the captured output. Both were
// observed across one commit pair. This timer fires first now, always.
const TIMEOUT_MS = 240_000;

function parseSlug(): string {
  const argIdx = process.argv.indexOf("--slug");
  if (argIdx >= 0 && process.argv[argIdx + 1]) return process.argv[argIdx + 1];
  if (process.env.PULLFROG_MODEL) return process.env.PULLFROG_MODEL;
  throw new Error("model-smoke: pass --slug <alias> or set PULLFROG_MODEL");
}

type Plan =
  | { agent: "opencode"; cliPath: string; args: string[] }
  | { agent: "claude"; cliPath: string; args: string[] };

async function plan(slug: string): Promise<Plan> {
  const alias = modelAliases.find((a) => a.slug === slug);
  if (!alias) throw new Error(`model-smoke: unknown alias "${slug}"`);
  if (alias.routing) {
    throw new Error(
      `model-smoke: ${slug} is a routing slug (no fixed model). pass an explicit Bedrock model ID via PULLFROG_MODEL or the workflow env block.`
    );
  }

  // walk the fallback chain so deprecated aliases (those with `fallback` set,
  // e.g. opencode/mimo-v2-pro-free → opencode/big-pickle) hit their replacement
  // instead of the dead resolve target. mirrors production via resolveCliModel.
  const cliModel = resolveCliModel(slug);
  if (!cliModel) throw new Error(`model-smoke: fallback chain for "${slug}" is broken or cyclic`);

  // anthropic/* aliases run through claude-code in production; everything else
  // (openai, google, xai, deepseek, moonshot, opencode, openrouter) runs through
  // opencode. mirrors the inline classification in list-aliases.ts toMatrixEntry().
  if (slug.startsWith("anthropic/")) {
    const cliPath = await installFromNpmTarball({
      packageName: "@anthropic-ai/claude-code",
      version: getDevDependencyVersion("@anthropic-ai/claude-code"),
      // 2.1.113+ ships a native binary (bin/claude.exe) wired up from
      // platform-specific optionalDependencies by the package postinstall;
      // installDependencies runs that postinstall. mirrors opencode below.
      executablePath: "bin/claude.exe",
      installDependencies: true,
    });
    // claude expects a bare model id (e.g. "claude-sonnet-5"), not "anthropic/claude-sonnet-5"
    const bareModel = cliModel.split("/").slice(1).join("/");
    // mirror production: claude.ts passes `--effort <level>` for every model with
    // an effort ladder. newer Opus (4.8+) rejects the CLI's legacy
    // `thinking.type.enabled` shape with a 400 — `--effort` only sets
    // `output_config.effort`, but on a model whose capabilities the CLI knows,
    // passing it means the CLI is on the adaptive-thinking path too.
    return {
      agent: "claude",
      cliPath,
      args: ["-p", PROMPT, "--model", bareModel, "--effort", "high"],
    };
  }

  // without --standalone, V2 starts a detached `serve --service` daemon that outlives the command.
  const standalone = opencodeGeneration() === 2 ? ["--standalone"] : [];
  return {
    agent: "opencode",
    cliPath: await installOpencodeCli(),
    args: ["run", ...standalone, "--model", cliModel, PROMPT],
  };
}

/**
 * OpenCode Zen and Go share `OPENCODE_API_KEY` but bill separately, and Go is a
 * subscription with a 5-hour rolling usage cap. a spent cap refuses every model
 * on the tier with a 429, which opencode retries above the AI SDK while emitting
 * no output — so the run presents as a bare 240s stall, identical to a broken
 * alias. that is what makes all 15 `opencode-go/*` cells go red at once and read
 * as a regression in whatever touched models.ts. see wiki/opencode-silent-stall.md.
 */
const OPENCODE_TIER_BASE: Record<string, string> = {
  opencode: "https://opencode.ai/zen/v1",
  "opencode-go": "https://opencode.ai/zen/go/v1",
};

/** a refusal answers in milliseconds, so this only has to outlast a slow TLS
 * handshake. it must never approach the gap between TIMEOUT_MS and the job's own
 * `timeout-minutes`, or diagnosing the failure costs us the failure. */
const REFUSAL_PROBE_TIMEOUT_MS = 10_000;

/**
 * ask the tier directly why a failed run failed. costs nothing on the happy path
 * — only a failure asks — and a refusal names the condition and, for a usage cap,
 * when it resets.
 *
 * every path returns rather than throws, including the body read: the captured
 * CLI output is the more valuable artifact, and it is printed AFTER this call, so
 * a throw here would suppress the very thing we are trying to explain.
 */
async function tierRefusal(cliModel: string): Promise<string | undefined> {
  const base = OPENCODE_TIER_BASE[cliModel.slice(0, cliModel.indexOf("/"))];
  const key = process.env.OPENCODE_API_KEY;
  if (!base || !key) return undefined;
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: cliModel.slice(cliModel.indexOf("/") + 1),
        max_tokens: 8,
        messages: [{ role: "user", content: "ok" }],
      }),
      signal: AbortSignal.timeout(REFUSAL_PROBE_TIMEOUT_MS),
    });
    if (res.ok) return undefined;
    const body = (await res.text()).slice(0, 300).replace(/\s+/g, " ");
    // a bare probe has no `tools`, and the free tier refuses that shape before any
    // cap check — so this 403 describes the probe, never the run. say so instead
    // of quoting it: the quoted body is the exact line #1377 removed.
    if (body.includes("FreeTierError")) {
      return `${res.status} FreeTierError — the free tier refuses a bare probe before any cap check, so this names nothing about the run`;
    }
    return `${res.status} ${body}`;
  } catch {
    return undefined;
  }
}

type SpawnResult = { ok: boolean; output: string; reason: string };

function runCli(p: Plan, env: NodeJS.ProcessEnv): Promise<SpawnResult> {
  // both claude (2.1.113+) and opencode ship native binaries now, so we invoke
  // the resolved executable directly.
  const command = p.cliPath;

  return new Promise((resolve) => {
    const child = spawn(command, p.args, { env, stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, TIMEOUT_MS);

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const output = stdout + (stderr ? `\n---stderr---\n${stderr}` : "");
      if (signal === "SIGKILL") {
        resolve({ ok: false, output, reason: `timed out after ${TIMEOUT_MS / 1000}s` });
        return;
      }
      if (code !== 0) {
        resolve({ ok: false, output, reason: `exit ${code}` });
        return;
      }
      // a mute model and a chatty one are different failures — "no OK in stdout"
      // for both is what made three unrelated causes read as one flake.
      if (stdout.trim().length === 0) {
        resolve({ ok: false, output, reason: "model exited 0 but returned no output" });
        return;
      }
      if (!MATCH.test(stdout)) {
        resolve({ ok: false, output, reason: "no OK in stdout" });
        return;
      }
      resolve({ ok: true, output, reason: "ok" });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: stderr, reason: `spawn error: ${err.message}` });
    });
  });
}

async function main(): Promise<void> {
  const slug = parseSlug();
  const tempDir = mkdtempSync(join(tmpdir(), "model-smoke-"));
  const homeDir = join(tempDir, "home");

  // installFromNpmTarball reads PULLFROG_TEMP_DIR from process.env, not from
  // the spawn env, so we mutate process.env up-front. HOME/XDG_CONFIG_HOME are
  // redirected to keep the agent CLIs from picking up the dev user's config.
  process.env.PULLFROG_TEMP_DIR = tempDir;
  process.env.HOME = homeDir;
  process.env.XDG_CONFIG_HOME = join(homeDir, ".config");
  // opencode reads GOOGLE_GENERATIVE_AI_API_KEY for gemini; mirror the harness fallback.
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY && process.env.GEMINI_API_KEY) {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = process.env.GEMINI_API_KEY;
  }

  console.log(`» model-smoke ${slug}`);
  const p = await plan(slug);
  console.log(`» agent=${p.agent} cmd=${[p.cliPath, ...p.args].join(" ")}`);

  // production's catalog and data dirs: V2 otherwise serves the snapshot built into its binary.
  await seedModelsCatalog(homeDir);
  const result = await runCli(p, { ...process.env, ...openCodeHomeEnv(homeDir) });
  if (result.ok) {
    console.log(`✓ ${slug} (${p.agent})`);
    process.exit(0);
  }

  console.error(`✗ ${slug} (${p.agent}): ${result.reason}`);
  const refusal = await tierRefusal(resolveCliModel(slug) ?? slug);
  if (refusal) console.error(`» the tier refused a direct request too: ${refusal}`);
  if (result.output) console.error(result.output);
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
