/**
 * Materialize GROK_AUTH_JSON into the on-disk auth path that Grok Build CLI
 * reads for non-interactive OAuth sessions.
 *
 * Layout (per xAI Grok Build CI docs):
 *   ~/.grok/auth.json
 *
 * The CI secret is typically a Base64 encoding of the local `auth.json`
 * contents; local `.env` / Pullfrog db secrets may also store raw JSON.
 * Callers must set HOME to an isolated tmpdir so credentials never land in
 * the workspace or the runner's real home.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./cli.ts";

export const GROK_AUTH_JSON_ENV = "GROK_AUTH_JSON";

/** relative path under HOME where grok caches the OAuth session */
export const GROK_AUTH_REL_PATH = join(".grok", "auth.json");

export interface InstalledGrokAuth {
  /** absolute path of the auth.json written under `home` */
  authPath: string;
}

/**
 * Decode a GROK_AUTH_JSON secret into the UTF-8 JSON body of auth.json.
 *
 * Accepts:
 *   - raw JSON (trimmed value starts with `{`)
 *   - standard Base64 of that JSON (CI-documented form)
 *
 * Returns null when the value cannot be decoded into non-empty JSON text.
 */
export function decodeGrokAuthJson(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // raw JSON is convenient for local .env and Pullfrog-stored secrets
  if (trimmed.startsWith("{")) {
    return trimmed;
  }

  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8").trim();
    if (!decoded.startsWith("{")) {
      log.warning(`» ${GROK_AUTH_JSON_ENV} base64-decoded but does not look like JSON; ignoring`);
      return null;
    }
    return decoded;
  } catch {
    log.warning(`» ${GROK_AUTH_JSON_ENV} present but could not be base64-decoded; ignoring`);
    return null;
  }
}

/**
 * Write `GROK_AUTH_JSON` from env into `$home/.grok/auth.json`.
 * Returns null when the env var is absent, empty, or malformed.
 */
export function installGrokAuth(home: string): InstalledGrokAuth | null {
  const raw = process.env[GROK_AUTH_JSON_ENV];
  if (typeof raw !== "string" || raw.trim().length === 0) return null;

  const json = decodeGrokAuthJson(raw);
  if (!json) return null;

  const authPath = join(home, GROK_AUTH_REL_PATH);
  mkdirSync(join(home, ".grok"), { recursive: true });
  writeFileSync(authPath, json, { mode: 0o600, encoding: "utf8" });
  log.debug(`» wrote Grok Build auth.json to ${authPath}`);
  return { authPath };
}
