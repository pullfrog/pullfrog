// Codex-to-OpenCode auth bridging for the action runtime.
//
// `pullfrog auth codex` stores a Codex CLI `auth.json` blob in the Pullfrog
// per-org secret store (production Postgres) — NOT a GitHub Actions secret.
// This is non-negotiable: the OAuth refresh chain rotates on every use, and
// `entryPost.ts` writes the rotated chain back via `PUT /api/runtime/secret`
// after each run. GH Actions secrets are immutable at runtime, so a token
// stashed there silently expires on the first refresh (~1h). See
// wiki/codex-auth.md for the full constraint.
//
// At runtime, `CODEX_AUTH_JSON` lands in process.env via `runContext.dbSecrets`
// merged in main.ts — sourced from Pullfrog Postgres through the OIDC-validated
// run-context endpoint, never from `${{ secrets.CODEX_AUTH_JSON }}` in
// workflow yaml.
//
// The run-context endpoint calls `maybeRotateCodexSecret` (see
// `utils/codexSecretRotation.ts`) inside a Postgres row lock just before
// decrypting + returning dbSecrets. That serializes concurrent rotations
// across the fleet: the first concurrent run rotates the token; the rest
// see the just-written value and skip. Result: the token in
// `process.env.CODEX_AUTH_JSON` is guaranteed fresh for at least the
// rotation safety margin (~50min) when this code runs. No action-side
// pre-flight refresh is needed.
//
// This utility then:
//   1. parses + validates the env value
//   2. decodes the access_token JWT's `exp` claim so opencode knows how
//      long to trust the token before its CodexAuthPlugin attempts its
//      own mid-run refresh
//   3. converts Codex's shape `{ auth_mode, tokens: { access_token,
//      refresh_token, id_token?, account_id? } }` into OpenCode's shape
//      `{ openai: { type: "oauth", refresh, access, expires, accountId } }`
//   4. materializes it to disk under a path the MCP-shell mount-namespace
//      sandbox can hide from bash: `/var/lib/pullfrog/opencode/auth.json` in
//      CI (sudo-bootstrapped, fail-closed if sudo unavailable),
//      `$HOME/.local/share/opencode/auth.json` locally (sandbox is no-op
//      locally so the path is irrelevant to security)
//   5. returns the path + the original refresh token so the post-run hook
//      can detect a mid-run rotation and write back to Pullfrog
//
// Why `/var/lib/pullfrog/` and not `$HOME` in CI: bash via MCP runs inside a
// mount namespace that overlays tmpfs on `/var/lib/pullfrog/` (see FS_MOUNTS
// in action/mcp/shell.ts), so bash sees an empty dir while opencode's
// internal auth module — which runs in the agent process outside that
// namespace — reads/writes the real file. `$HOME` can't be tmpfs-overlaid
// without breaking the agent's legitimate need to access ~/.npm, ~/.cache,
// etc.
//
// See [wiki/codex-auth.md] for the full data-flow picture.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { log } from "./cli.ts";
import { type CodexAuthBody, parseCodexAuthBody, stringifyCodexAuthBody } from "./codexOAuth.ts";
import { decodeJwtExpMs } from "./oauthShared.ts";
import { parseXaiAuthBody, type XaiAuthBody } from "./xaiOAuth.ts";

const CODEX_AUTH_ENV = "CODEX_AUTH_JSON";
const XAI_AUTH_ENV = "GROK_AUTH_JSON";

let selectedCodexSecret = CODEX_AUTH_ENV;

/** sandbox-hidden home for pullfrog-managed on-disk secrets in CI. bash via
 * MCP shell tmpfs-overlays this path; opencode's internal auth module
 * bypasses external_directory and reaches the real file. mirrors the
 * pattern in action/agents/claude.ts installManagedSettings.
 *
 * not used for codex auth in local dev — the sandbox is no-op there, so
 * the path doesn't matter. local dev keeps the existing $HOME path. */
export const PULLFROG_DATA_DIR = "/var/lib/pullfrog";

interface OpenCodeOAuthEntry {
  type: "oauth";
  refresh: string;
  access: string;
  expires: number;
  accountId?: string;
}

/** opencode keys auth.json by provider id — `openai` for the Codex chain,
 * `xai` for the Grok chain. An account can hold both, so entries are merged
 * into whatever is already on disk rather than overwriting the file. */
type OpenCodeAuthFile = Record<string, OpenCodeOAuthEntry>;

/** the server latches `refresh_rejected_at` when OpenAI rejects the refresh —
 * the rotation is one-shot, so a rejection is PERMANENT until the user re-runs
 * `pullfrog auth codex` (see utils/codexSecretRotation.ts and #1101). the
 * latched blob still reaches the runner, and materializing it buys nothing: it
 * dies at the first model call, having already displaced an `OPENAI_API_KEY`
 * that would have served the run. */
function isRejectedChain(body: CodexAuthBody): boolean {
  if (!body.refresh_rejected_at) return false;
  log.warning(
    `» ${selectedCodexSecret} was rejected by OpenAI at ${body.refresh_rejected_at} and cannot be ` +
      `refreshed — re-run \`npx pullfrog auth codex\`. skipping it for this run.`
  );
  return true;
}

export interface InstalledCodexAuth {
  /** absolute path of the auth.json we wrote — caller passes this to the
   * post-hook via core.saveState for refresh-detection later. */
  authPath: string;
  /** value to set as XDG_DATA_HOME for the OpenCode subprocess. */
  xdgDataHome: string;
  /** refresh_token from the env at materialization time. post-hook
   * compares against the on-disk file after the run to detect whether
   * OpenCode refreshed during the session (only happens on long runs
   * that span >50min — see wiki/codex-auth.md "Concurrency"). */
  originalRefresh: string;
  /** id_token from the env at materialization time. OpenCode's auth file has
   * no slot for it, so the post-hook has to re-attach this one or the written
   * back blob loses it — and the Codex CLI REFUSES an auth.json without
   * `tokens.id_token` (measured: `missing field 'id_token'`), so dropping it
   * silently disqualifies the account from the codex harness forever. */
  originalIdToken: string | undefined;
  secretName: string;
}

/** materialize CODEX_AUTH_JSON from env into a disk path OpenCode reads from.
 * returns null when the env var is absent, malformed, or wrong auth mode —
 * caller treats null as "no codex auth, fall through to API key flow".
 *
 * The env value is server-side guaranteed fresh by `maybeRotateCodexSecret`
 * in the run-context endpoint. We parse + write it here and set
 * `process.env.XDG_DATA_HOME` so every opencode subprocess discovers the
 * auth.json; no refresh, no DB interaction. */
export function installCodexAuth(): InstalledCodexAuth | null {
  const raw = process.env[CODEX_AUTH_ENV];
  if (!raw) return null;

  const body = parseCodexAuthBody(raw);
  if (!body) {
    log.warning(`» ${selectedCodexSecret} present but malformed; ignoring`);
    return null;
  }
  if (isRejectedChain(body)) return null;

  // decode the access_token's JWT exp so opencode trusts the token until
  // its real expiry (no need to refresh on first request). null exp ->
  // fall back to "expires: 0" so opencode refreshes immediately on first
  // request (the old behavior).
  const expiresMs = decodeJwtExpMs(body.tokens.access_token) ?? 0;

  const xdgDataHome = resolveDataHome();
  const opencodeDir = join(xdgDataHome, "opencode");
  const authPath = join(opencodeDir, "auth.json");

  writeOpenCodeAuthEntry({
    opencodeDir,
    authPath,
    provider: "openai",
    entry: {
      type: "oauth",
      refresh: body.tokens.refresh_token,
      access: body.tokens.access_token,
      expires: expiresMs,
      ...(body.tokens.account_id ? { accountId: body.tokens.account_id } : {}),
    },
  });

  // point every opencode subprocess in this run (agent spawn + `opencode
  // models` introspection) at this auth.json. only opencode reads
  // XDG_DATA_HOME and this only fires on codex runs, so the blast radius is
  // exactly the subprocesses that must discover the OAuth-routed openai/* models.
  process.env.XDG_DATA_HOME = xdgDataHome;

  log.info(`» installed Codex auth at ${authPath}`);

  return {
    authPath,
    xdgDataHome,
    originalRefresh: body.tokens.refresh_token,
    originalIdToken: body.tokens.id_token,
    secretName: selectedCodexSecret,
  };
}

/** merge one provider entry into opencode's auth.json, preserving any other
 * provider already there. An account can hold both a Codex and a Grok
 * credential, and both install into the same file — a wholesale write would
 * silently drop whichever ran first. Unreadable or malformed existing content
 * is replaced rather than merged: it is opencode's own cache, not a credential
 * we can recover, and a stale half-file would break the run either way. */
function writeOpenCodeAuthEntry(params: {
  opencodeDir: string;
  authPath: string;
  provider: string;
  entry: OpenCodeOAuthEntry;
}): void {
  let existing: OpenCodeAuthFile = {};
  if (existsSync(params.authPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(params.authPath, "utf8"));
      if (parsed && typeof parsed === "object") existing = parsed as OpenCodeAuthFile;
    } catch {
      log.warning(`» ${params.authPath} was unreadable; rewriting it`);
    }
  }
  const merged: OpenCodeAuthFile = { ...existing, [params.provider]: params.entry };
  mkdirSync(params.opencodeDir, { recursive: true });
  writeFileSync(params.authPath, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
}

export interface InstalledXaiAuth {
  /** absolute path of the auth.json we wrote — the post-hook diffs it. */
  authPath: string;
  /** value to set as XDG_DATA_HOME for the OpenCode subprocess. */
  xdgDataHome: string;
  /** refresh_token at materialization time. opencode's XaiAuthPlugin rotates
   * in-process on a long run, so the post-hook compares against this to decide
   * whether anything needs writing back. */
  originalRefresh: string;
}

/** materialize GROK_AUTH_JSON from env into opencode's auth.json.
 *
 * opencode ships xAI Grok OAuth natively (`XaiAuthPlugin`, added upstream
 * 2026-05-21, present in our pinned 1.18.5) against the same public
 * Grok-CLI OAuth client we mint with, so the stored chain drops straight in.
 * The plugin sends the token to `api.x.ai/v1` — it deliberately sets no
 * baseURL — so there is no CLI proxy and no client-version header in play.
 *
 * returns null when the env var is absent or malformed; caller treats null as
 * "no grok subscription auth, fall through to XAI_API_KEY". */
export function installXaiAuth(): InstalledXaiAuth | null {
  const raw = process.env[XAI_AUTH_ENV];
  if (!raw) return null;

  const body = parseXaiAuthBody(raw);
  if (!body) {
    log.warning(`» ${XAI_AUTH_ENV} present but malformed; ignoring`);
    return null;
  }
  if (isXaiRejectedChain(body)) return null;

  const xdgDataHome = resolveDataHome();
  const opencodeDir = join(xdgDataHome, "opencode");
  const authPath = join(opencodeDir, "auth.json");

  writeOpenCodeAuthEntry({
    opencodeDir,
    authPath,
    provider: "xai",
    // opencode refreshes when `expires` is inside its skew window, and falls
    // back to the JWT's own exp when the stored value is absent. Decoding it
    // here means the first request uses the token we already hold instead of
    // burning a rotation on startup.
    entry: {
      type: "oauth",
      refresh: body.tokens.refresh_token,
      access: body.tokens.access_token,
      expires: decodeJwtExpMs(body.tokens.access_token) ?? 0,
    },
  });

  process.env.XDG_DATA_HOME = xdgDataHome;
  log.info(`» installed Grok auth at ${authPath}`);

  return { authPath, xdgDataHome, originalRefresh: body.tokens.refresh_token };
}

/** the server latches `refresh_rejected_at` when xAI rejects the refresh.
 * rotation is one-shot, so the rejection is permanent until the user re-runs
 * `pullfrog auth grok`. materializing a latched blob buys nothing — it dies at
 * the first model call, having already displaced an `XAI_API_KEY` that would
 * have served the run. */
function isXaiRejectedChain(body: XaiAuthBody): boolean {
  if (!body.refresh_rejected_at) return false;
  log.warning(
    `» ${XAI_AUTH_ENV} was rejected by xAI at ${body.refresh_rejected_at} and cannot be ` +
      `refreshed — re-run \`npx pullfrog auth grok\`. skipping it for this run.`
  );
  return true;
}

export interface InstalledCodexHome {
  /** value to set as CODEX_HOME for the codex subprocess. holds auth.json,
   * config.toml and the session rollouts the resume path reads. */
  codexHome: string;
  /** absolute path of the auth.json we wrote. the codex CLI rewrites this file
   * in place when it refreshes, so the post-hook diffs it for a rotation. */
  authPath: string;
  originalRefresh: string;
  secretName: string;
}

/**
 * materialize CODEX_AUTH_JSON into a CODEX_HOME the codex CLI reads directly.
 * unlike {@link installCodexAuth} there is no shape conversion — the stored
 * blob IS the codex CLI's own `auth.json`, so it round-trips verbatim.
 *
 * returns null when the env var is absent, malformed, or carries no
 * `tokens.id_token`. that last one is not defensive: the CLI's `TokenData`
 * makes `id_token` a required field with a JWT deserializer, so an auth.json
 * without it fails to load with `missing field 'id_token'` before any model
 * call. callers treat null as "codex CLI can't use this credential".
 */
export function installCodexHome(): InstalledCodexHome | null {
  const raw = process.env[CODEX_AUTH_ENV];
  if (!raw) return null;

  const body = parseCodexAuthBody(raw);
  if (!body) {
    log.warning(`» ${selectedCodexSecret} present but malformed; ignoring`);
    return null;
  }
  if (isRejectedChain(body)) return null;
  if (!body.tokens.id_token) {
    log.warning(
      `» ${selectedCodexSecret} carries no id_token — the codex CLI cannot load it. ` +
        `re-run \`npx pullfrog auth codex\` to mint a complete credential.`
    );
    return null;
  }

  const codexHome = join(resolveDataHome(), "codex");
  const authPath = join(codexHome, "auth.json");

  mkdirSync(codexHome, { recursive: true });
  writeFileSync(authPath, stringifyCodexAuthBody(body), { mode: 0o600 });

  log.info(`» installed Codex auth at ${authPath}`);

  return {
    codexHome,
    authPath,
    originalRefresh: body.tokens.refresh_token,
    secretName: selectedCodexSecret,
  };
}

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

const CODEX_QUOTA_PREFERENCE = [
  "available",
  "credits",
  "unknown",
  "exhausted",
  "unusable",
] as const;

export type CodexQuota = (typeof CODEX_QUOTA_PREFERENCE)[number];

export interface CodexUsage {
  rate_limit?: { allowed?: boolean; limit_reached?: boolean } | null;
  rate_limit_reached_type?: unknown;
  credits?: { has_credits?: boolean; unlimited?: boolean } | null;
  spend_control?: { reached?: boolean } | null;
}

export function codexQuota(usage: CodexUsage): CodexQuota {
  if (usage.spend_control?.reached) return "exhausted";
  const reached =
    usage.rate_limit?.allowed === false ||
    usage.rate_limit?.limit_reached === true ||
    Boolean(usage.rate_limit_reached_type);
  if (!reached) return "available";
  return usage.credits?.has_credits || usage.credits?.unlimited ? "credits" : "exhausted";
}

export function pickCodexSlot<T extends { quota: CodexQuota }>(slots: T[]): T {
  return slots.reduce((best, slot) =>
    CODEX_QUOTA_PREFERENCE.indexOf(slot.quota) < CODEX_QUOTA_PREFERENCE.indexOf(best.quota)
      ? slot
      : best
  );
}

async function probeCodexQuota(raw: string, requireIdToken: boolean): Promise<CodexQuota> {
  const body = parseCodexAuthBody(raw);
  if (!body || body.refresh_rejected_at) return "unusable";
  if (requireIdToken && !body.tokens.id_token) return "unusable";
  try {
    const response = await fetch(CODEX_USAGE_URL, {
      headers: {
        authorization: `Bearer ${body.tokens.access_token}`,
        ...(body.tokens.account_id ? { "chatgpt-account-id": body.tokens.account_id } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return "unknown";
    return codexQuota((await response.json()) as CodexUsage);
  } catch {
    return "unknown";
  }
}

export async function selectCodexAuth(params: { requireIdToken: boolean }): Promise<void> {
  const slots = Object.keys(process.env)
    .filter((name) => name.startsWith(`${CODEX_AUTH_ENV}_`))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  if (slots.length === 0) return;

  const names = process.env[CODEX_AUTH_ENV] ? [CODEX_AUTH_ENV, ...slots] : slots;
  const probed = await Promise.all(
    names.map(async (name) => {
      const raw = process.env[name] ?? "";
      return { name, raw, quota: await probeCodexQuota(raw, params.requireIdToken) };
    })
  );
  const chosen = pickCodexSlot(probed);

  process.env[CODEX_AUTH_ENV] = chosen.raw;
  for (const slot of slots) delete process.env[slot];
  selectedCodexSecret = chosen.name;
  log.info(
    `» Codex subscriptions: ${probed.map((slot) => `${slot.name} ${slot.quota}`).join(", ")}; using ${chosen.name}`
  );
}

/** pick the XDG_DATA_HOME for codex auth.
 *
 * - **local dev (CI != true)**: use $HOME. mount-namespace sandbox is no-op
 *   locally so the file isn't protected from bash either way; codex auth on
 *   a developer's machine is the developer's responsibility.
 * - **CI**: bootstrap /var/lib/pullfrog via sudo. MCP shell's mount namespace
 *   tmpfs-overlays this path, and claude managed-settings + opencode
 *   external_directory both deny it — three independent layers.
 *
 * **fail closed in CI** when the sudo bootstrap fails. falling back to
 * $HOME silently strips two of the three protection layers — the wiki
 * claims three layers; degrading to one without a hard error contradicts
 * that claim and is exactly the kind of silent security regression the
 * reviewer should never have to catch. operators on locked-down runners
 * that can't passwordless-sudo should re-provision sudo or remove
 * `CODEX_AUTH_JSON` from the run entirely. */
function resolveDataHome(): string {
  if (process.env.CI !== "true") return join(homedir(), ".local", "share");
  bootstrapPullfrogDataDir();
  return PULLFROG_DATA_DIR;
}

function bootstrapPullfrogDataDir(): void {
  const user = userInfo().username;
  // `id -gn $user` resolves the user's primary group name correctly even on
  // self-hosted images where the group isn't `<user>:<user>` (e.g., `runner`
  // belongs to `runner`, but a self-hosted setup might use `users`, `docker`,
  // or a project-specific gid). avoids the brittle "group has same name as
  // user" assumption.
  let primaryGroup: string;
  try {
    primaryGroup = execFileSync("id", ["-gn", user], { stdio: "pipe", encoding: "utf-8" }).trim();
  } catch {
    primaryGroup = user;
  }
  // `-n` (non-interactive) makes sudo fail-fast on locked-down runners
  // instead of prompting and timing out.
  try {
    execFileSync("sudo", ["-n", "mkdir", "-p", PULLFROG_DATA_DIR], { stdio: "pipe" });
    execFileSync("sudo", ["-n", "chown", `${user}:${primaryGroup}`, PULLFROG_DATA_DIR], {
      stdio: "pipe",
    });
    execFileSync("sudo", ["-n", "chmod", "700", PULLFROG_DATA_DIR], { stdio: "pipe" });
  } catch (err) {
    throw new Error(
      `failed to bootstrap ${PULLFROG_DATA_DIR} (required for codex auth in CI): ${err instanceof Error ? err.message : String(err)}. ` +
        `the MCP shell's mount-namespace sandbox cannot protect the auth file when it lives under $HOME, ` +
        `and silently falling back would contradict the "three independent layers" claim in wiki/codex-auth.md. ` +
        `passwordless sudo is required for codex auth on this runner — either configure it, or remove ` +
        `CODEX_AUTH_JSON from the run.`
    );
  }
}
