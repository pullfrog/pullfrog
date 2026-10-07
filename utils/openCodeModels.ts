// OpenCode-as-source-of-truth for BYOK detection.
//
// `opencode models` returns the `provider/model` specifiers that OpenCode
// can actually route given the current env (workflow env block + GH Actions
// secrets) and `auth.json` (Codex / future managed credentials). This is
// authoritative — strictly more accurate than the static
// `provider.envVars + provider.managedCredentials` catalog in `models.ts`
// for the "do we have BYOK auth?" gate. The catalog can (and will) miss
// new auth shapes; OpenCode itself can't.
//
// Two captures per run:
//   1. `captureBaselineModels` — called BEFORE Pullfrog-stored credentials
//      (dbSecrets + Codex auth.json) land in the env. The set OpenCode can
//      serve from the runner's pre-existing environment alone.
//   2. `captureAuthorizedModels` — called AFTER dbSecrets merge + Codex
//      auth.json materialization. The authoritative set for BYOK
//      decisions (validateAgentApiKey).
//
// The set difference (`authorized - baseline`) is the contribution of
// Pullfrog-stored auth to this run — logged once for operator visibility
// and reserved for a future server-side "OSS proxy opt-out" detection.
//
// Memoized at module scope so the two consumers
// (`validateAgentApiKey` + `autoSelectModel`) share one shell-out.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { log } from "./cli.ts";
import { getSubscriptionDataHome } from "./codexHome.ts";

let baseline: Set<string> | undefined;
let authorized: Set<string> | undefined;
let failure: string | undefined;

// the CLI paints its errors; these get re-rendered into a PR comment where raw
// SGR escapes read as literal `[91m` noise.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR escapes is the point
const ANSI_PATTERN = /\[[0-9;]*m/g;

/**
 * HOME and XDG dirs for every opencode subprocess, all inside this run. the runner user's own
 * are shared by every run on a self-hosted host, and so is opencode's SQLite db in them (#1475).
 */
export function openCodeHomeEnv(tmpdir: string) {
  return {
    HOME: tmpdir,
    XDG_CONFIG_HOME: join(tmpdir, ".config"),
    XDG_DATA_HOME: getSubscriptionDataHome() ?? join(tmpdir, ".local", "share"),
    XDG_CACHE_HOME: join(tmpdir, ".cache"),
    XDG_STATE_HOME: join(tmpdir, ".local", "state"),
  };
}

function readModels(params: { cliPath: string; tmpdir: string }): Set<string> {
  // spawnSync, not execFileSync: we want opencode's stderr as a value rather
  // than a throw, and `stdio` keeps it out of the job log (execFileSync leaks
  // it to the parent, so a config error printed once per capture).
  const result = spawnSync(params.cliPath, ["models"], {
    encoding: "utf-8",
    timeout: 30_000,
    env: { ...process.env, ...openCodeHomeEnv(params.tmpdir) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    // a timeout or spawn failure kills the child before it writes stderr, so
    // `result.error` carries the only reason there is. without folding it in,
    // `failure` stays undefined and the empty set reaches validateAgentApiKey
    // as a bare "you have no key" verdict for what is really a runner problem.
    const stderr = (result.stderr ?? "").replace(ANSI_PATTERN, "").trim();
    failure = stderr || result.error?.message;
    log.debug(`» \`opencode models\` failed (${result.status}): ${failure}`);
    return new Set();
  }
  failure = undefined;
  return new Set(
    result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
  );
}

/**
 * Why the last `opencode models` came back empty, in opencode's own words.
 *
 * An unloadable repo config (`opencode.json`, `.opencode/**`) is the common cause
 * and is fatal — opencode's schema is strict, so every later invocation fails the
 * same way. Without this the empty set reaches `validateAgentApiKey` and the run
 * dies telling the user to go add provider secrets, which is a false lead.
 */
export function getModelsFailure(): string | undefined {
  return failure;
}

/** Snapshot the set of models OpenCode can serve from the current env, BEFORE
 * Pullfrog-stored credentials are merged in. Call once early in `main.ts`. */
export function captureBaselineModels(params: { cliPath: string; tmpdir: string }): void {
  baseline = readModels(params);
  log.debug(`» opencode baseline: ${baseline.size} models`);
}

/** Snapshot the set of models OpenCode can serve AFTER dbSecrets +
 * Codex auth.json are in place. Logs the diff against the baseline as
 * `» BYOK auth enabled N model(s): …`. */
export function captureAuthorizedModels(params: { cliPath: string; tmpdir: string }): void {
  authorized = readModels(params);
  const base = baseline;
  if (base) {
    const diff = [...authorized].filter((m) => !base.has(m));
    if (diff.length > 0) {
      log.info(`» BYOK auth enabled ${diff.length} model(s): ${diff.join(", ")}`);
    }
  }
  log.debug(`» opencode authorized: ${authorized.size} models`);
}

/** A model whose credential the pool just probed. Added directly: a second
 * `opencode models` would run inside the checkout and load the repo's own
 * `.opencode` plugins, which can outlast its timeout and empty the set. */
export function authorizeModel(model: string): void {
  getAuthorizedModels().add(model);
}

/** Authorized set captured after Pullfrog-stored auth is applied. Throws if
 * called before `captureAuthorizedModels` — the call sites (api-key
 * validation, auto-select) all run strictly after capture. */
export function getAuthorizedModels(): Set<string> {
  if (!authorized) {
    throw new Error("getAuthorizedModels called before captureAuthorizedModels");
  }
  return authorized;
}
