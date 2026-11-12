import { parseCustomHeaders } from "../models.ts";
import { log } from "./cli.ts";
import { maskSecret } from "./secretCommands.ts";
import { isSensitiveEnvName, isUnsendableSecret } from "./secrets.ts";

/**
 * Trim surrounding whitespace from a sensitive value and register it as a
 * GitHub Actions log mask. Trailing newlines from terminal-copy paste are a
 * common footgun: the value travels through GH Actions logs and any tool
 * that re-emits parts of it leaks the unmasked tail. Trimming canonicalises
 * the value so the mask matches exactly what downstream tools will print.
 *
 * Masking is delegated to `maskSecret` (not raw `console.log`) so the
 * toolkit percent-encodes `\r`/`\n`; the runner V2 parser decodes them and
 * registers the full value plus every non-empty line as separate masks. That
 * keeps us safe for embedded-newline values (PEMs, kubeconfigs, JSON blobs)
 * even though they aren't currently used.
 *
 * Returns the trimmed value, or `null` when the input was whitespace-only —
 * callers must leave `process.env` untouched in that case so a misconfigured
 * value surfaces as a clear "missing key" downstream rather than silently
 * mutating to the empty string.
 */
export function sanitizeSecret(key: string, value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    log.warning(
      `» ${key} is whitespace-only — leaving env var unchanged. check your secret value.`
    );
    return null;
  }
  // an interior control character can never be sent in an HTTP header, so the
  // provider rejects the request with `Header 'N' has invalid value` and the
  // run dies ~1s in — we already know here that it cannot succeed (#1162).
  // almost always a line-wrapped paste, and silently stripping would ship half
  // a key with a worse error, so refuse and let the missing-key path name the
  // fix.
  if (isUnsendableSecret(key, trimmed)) {
    log.warning(
      `» ${key} contains a line break, smart quote or other non-ASCII character and cannot be sent as an HTTP header — ` +
        "leaving env var unchanged. re-save the secret as plain text on one line."
    );
    return null;
  }
  if (trimmed !== value) {
    log.warning(
      `» stripped whitespace from ${key} (whitespace in secret values breaks GitHub Actions log masking)`
    );
  }
  maskSecret(trimmed);
  return trimmed;
}

/**
 * The request headers `envVar` holds, for a harness config. Each value is masked on its own: the
 * runner masks the variable whole and line by line, and neither matches a value printed apart from
 * its name. Under 8 characters is no credential, and masking `X-Tenant: 1` would blank every 1.
 */
export function readCustomHeaders(envVar: string): Record<string, string> {
  const parsed = parseCustomHeaders(process.env[envVar] ?? "");
  if (parsed.badLine) {
    throw new Error(
      `Line ${parsed.badLine} of \`${envVar}\` is not a header. Write one \`Name: Value\` per line, in ASCII. ` +
        "[Custom headers guide](https://docs.pullfrog.com/keys#custom-headers)"
    );
  }
  for (const value of Object.values(parsed.headers)) {
    if (value.length >= 8) maskSecret(value);
  }
  return parsed.headers;
}

/**
 * Normalize environment variables to uppercase.
 * This handles case-insensitive env var names (e.g., `anthropic_api_key` -> `ANTHROPIC_API_KEY`).
 *
 * If there are conflicts (same key with different capitalizations but different values),
 * logs a warning and keeps the uppercase version.
 *
 * Also trims and masks sensitive values so accidental trailing whitespace
 * doesn't defeat GitHub Actions log masking.
 */
export function normalizeEnv(): void {
  const upperKeys = new Map<string, string[]>();

  // group keys by their uppercase form
  for (const key of Object.keys(process.env)) {
    const upper = key.toUpperCase();
    const existing = upperKeys.get(upper) || [];
    existing.push(key);
    upperKeys.set(upper, existing);
  }

  // process each group
  for (const [upperKey, keys] of upperKeys) {
    if (keys.length === 1) {
      const key = keys[0];
      if (key !== upperKey) {
        // single key, just needs uppercasing
        process.env[upperKey] = process.env[key];
        delete process.env[key];
      }
      continue;
    }

    // multiple keys with different capitalizations
    const values = keys.map((k) => process.env[k]);
    const uniqueValues = new Set(values);

    if (uniqueValues.size > 1) {
      // conflict: different values for different capitalizations
      log.warning(
        `env var conflict: ${keys.join(", ")} have different values. using uppercase ${upperKey}.`
      );
    }

    // prefer the uppercase version if it exists, otherwise use the first one
    const preferredKey = keys.find((k) => k === upperKey) || keys[0];
    const preferredValue = process.env[preferredKey];

    // delete all variants
    for (const key of keys) {
      delete process.env[key];
    }

    // set the uppercase version
    process.env[upperKey] = preferredValue;
  }

  // trim + mask sensitive values after case normalisation so each key is
  // visited exactly once with its final, canonical value
  for (const key of Object.keys(process.env)) {
    if (!isSensitiveEnvName(key)) continue;
    const value = process.env[key];
    if (typeof value !== "string" || value.length === 0) continue;
    const sanitized = sanitizeSecret(key, value);
    if (sanitized !== null) process.env[key] = sanitized;
  }
}
