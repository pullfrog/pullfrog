/**
 * Materialize ANTIGRAVITY_TOKEN into the on-disk OAuth cache path that the
 * Antigravity CLI (`agy`) reads in headless / CI environments.
 *
 * Layout (per Google Antigravity CI docs):
 *   ~/.gemini/antigravity-cli/antigravity-oauth-token
 *
 * Callers must set HOME (and typically XDG_CONFIG_HOME) to an isolated tmpdir
 * so credentials never land in the workspace or the runner's real home.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./cli.ts";

export const ANTIGRAVITY_TOKEN_ENV = "ANTIGRAVITY_TOKEN";

/** relative path under HOME where agy caches the OAuth session token */
export const ANTIGRAVITY_TOKEN_REL_PATH = join(
  ".gemini",
  "antigravity-cli",
  "antigravity-oauth-token"
);

export interface InstalledAntigravityAuth {
  /** absolute path of the token file written under `home` */
  tokenPath: string;
}

/**
 * Write `ANTIGRAVITY_TOKEN` from env into `$home/.gemini/antigravity-cli/antigravity-oauth-token`.
 * Returns null when the env var is absent or empty — caller treats that as
 * "no subscription auth".
 */
export function installAntigravityAuth(home: string): InstalledAntigravityAuth | null {
  const raw = process.env[ANTIGRAVITY_TOKEN_ENV];
  if (typeof raw !== "string" || raw.trim().length === 0) return null;

  const token = raw.trim();
  const tokenPath = join(home, ANTIGRAVITY_TOKEN_REL_PATH);
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  writeFileSync(tokenPath, token, { mode: 0o600, encoding: "utf8" });
  log.debug(`» wrote Antigravity OAuth token to ${tokenPath}`);
  return { tokenPath };
}
