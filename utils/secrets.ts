/**
 * Secret detection and env filtering utilities
 *
 * subprocess env filtering: default-deny allowlist model.
 * only vars in the safe set or user allowlist are passed to child processes.
 *
 * log redaction: SENSITIVE_PATTERNS are used to identify secret values
 * for redaction in logs and GHA masking (independent of subprocess filtering).
 */

// --- log redaction (unchanged, independent of subprocess filtering) ---

// patterns for sensitive env var names (used by normalizeEnv)
export const SENSITIVE_PATTERNS = [
  /_KEY$/i,
  /_SECRET$/i,
  /_TOKEN$/i,
  /_PASSWORD$/i,
  /_CREDENTIAL$/i,
];

export function isSensitiveEnvName(key: string): boolean {
  return SENSITIVE_PATTERNS.some((p) => p.test(key));
}

// Config-shaped vars that arrive through the same account-secret channel as real
// credentials but carry no secret material: model specifiers, regions, project and
// location identifiers. GitHub Actions masks by *value*, so masking these is
// actively harmful — a short, common value (VERTEX_LOCATION=global) rewrites every
// unrelated occurrence of that word in the run log to ***, and a masked model id
// makes the "which model ran?" lines unreadable exactly when someone is debugging
// why the wrong model ran.
//
// Deliberately an explicit allowlist rather than a suffix rule, so masking stays
// fail-closed: an unrecognised key is still treated as a secret. In particular
// VERTEX_SERVICE_ACCOUNT_JSON must NOT be added here — it matches none of
// SENSITIVE_PATTERNS, so unconditional masking is the only thing protecting it.
// OPENAI_COMPATIBLE_BASE_URL is also deliberately absent: gateway URLs can carry
// account ids or embedded credentials in the path, so it stays masked.
const NON_SECRET_CONFIG_NAMES = new Set([
  "PULLFROG_MODEL",
  "PULLFROG_AGENT",
  "AWS_REGION",
  "BEDROCK_MODEL_ID",
  "VERTEX_MODEL_ID",
  "VERTEX_LOCATION",
  "GOOGLE_CLOUD_PROJECT",
  // Azure OpenAI — everything but AZURE_API_KEY is plain config, and the
  // console flow stores all of it in the account-secret channel. The limits
  // ("128000") and the Chat Completions flag ("true") are the worst offenders
  // if masked: those values appear all over an ordinary run log.
  "AZURE_RESOURCE_NAME",
  "AZURE_DEPLOYMENT",
  "AZURE_CONTEXT",
  "AZURE_MAX_OUTPUT",
  "AZURE_USE_CHAT_COMPLETIONS",
  // OpenAI-compatible — same shape, minus the base URL (see above).
  "OPENAI_COMPATIBLE_MODEL",
  "OPENAI_COMPATIBLE_CONTEXT",
  "OPENAI_COMPATIBLE_MAX_OUTPUT",
]);

export function isNonSecretConfigName(key: string): boolean {
  return NON_SECRET_CONFIG_NAMES.has(key.toUpperCase());
}

// --- subprocess env filtering ---

// prefixes whose vars are safe to pass through (runner metadata, workflow context).
// GITHUB_TOKEN/GH_TOKEN match the GITHUB_ prefix but are still filtered by default because
// isSensitiveEnvName() catches the _TOKEN suffix; users can opt in explicitly via the allowlist.
const SAFE_ENV_PREFIXES = ["GITHUB_", "RUNNER_", "JAVA_HOME_", "GOROOT_"];

// exact var names safe to pass through (system + runner image toolchain)
const SAFE_ENV_NAMES = new Set([
  // system
  "CI",
  "HOME",
  "LANG",
  "LOGNAME",
  "PATH",
  "SHELL",
  "SHLVL",
  "TERM",
  "TMPDIR",
  "TZ",
  "USER",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  "DEBIAN_FRONTEND",
  // runner image toolchain
  "ACCEPT_EULA",
  "AGENT_TOOLSDIRECTORY",
  "ANDROID_HOME",
  "ANDROID_NDK",
  "ANDROID_NDK_HOME",
  "ANDROID_NDK_LATEST_HOME",
  "ANDROID_NDK_ROOT",
  "ANDROID_SDK_ROOT",
  "ANT_HOME",
  "AZURE_EXTENSION_DIR",
  "BOOTSTRAP_HASKELL_NONINTERACTIVE",
  "CHROME_BIN",
  "CHROMEWEBDRIVER",
  "CONDA",
  "DOTNET_MULTILEVEL_LOOKUP",
  "DOTNET_NOLOGO",
  "DOTNET_SKIP_FIRST_TIME_EXPERIENCE",
  "EDGEWEBDRIVER",
  "GECKOWEBDRIVER",
  "GHCUP_INSTALL_BASE_PREFIX",
  "GRADLE_HOME",
  "JAVA_HOME",
  "HOMEBREW_CLEANUP_PERIODIC_FULL_DAYS",
  "HOMEBREW_NO_AUTO_UPDATE",
  "ImageOS",
  "ImageVersion",
  "NVM_DIR",
  "PIPX_BIN_DIR",
  "PIPX_HOME",
  "PSModulePath",
  "SELENIUM_JAR_PATH",
  "SGX_AESM_ADDR",
  "SWIFT_PATH",
  "VCPKG_INSTALLATION_ROOT",
]);

let _userAllowlist: Set<string> | null = null;

export function setEnvAllowlist(raw: string): void {
  const names = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  _userAllowlist = new Set(names);
}

function isSafeEnvVar(key: string): boolean {
  if (SAFE_ENV_NAMES.has(key)) return true;
  return SAFE_ENV_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * GitHub Actions workflow-command FILE paths. Writing to any of them mutates the
 * job itself — `$GITHUB_ENV` injects env into later steps, `$GITHUB_PATH`
 * prepends to PATH, `$GITHUB_OUTPUT` forges step outputs. They pass
 * `isSafeEnvVar` on the `GITHUB_`/`RUNNER_` prefix and carry no secret, so
 * they were never the allowlist's concern — but a package manager running a
 * third-party `postinstall` is arbitrary code execution OUTSIDE the shell tool's
 * mount namespace (see wiki/security.md), which is exactly the boundary those
 * files let it cross. Handing it the exact paths is strictly worse than making
 * it guess them.
 */
const WORKFLOW_COMMAND_ENV_NAMES = [
  "GITHUB_ENV",
  "GITHUB_PATH",
  "GITHUB_OUTPUT",
  "GITHUB_STATE",
  "GITHUB_STEP_SUMMARY",
  // dropping the five paths above but keeping RUNNER_TEMP would be theatre:
  // the file-command files live in `$RUNNER_TEMP/_runner_file_commands/`, so the
  // directory is one `ls` away. nothing in the install path reads it (only our
  // own leak-surface wipe in `setup.ts`, which runs in the parent), and package
  // managers use TMPDIR.
  "RUNNER_TEMP",
];

/**
 * `filterEnv()` minus the workflow-command file paths. For subprocesses that
 * execute third-party code we do not sandbox — the dependency installers.
 */
export function filterEnvForUntrustedCode(): Record<string, string> {
  const env = filterEnv();
  for (const name of WORKFLOW_COMMAND_ENV_NAMES) delete env[name];
  return env;
}

/** filter env vars using default-deny allowlist: safe set + user allowlist */
export function filterEnv(): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const userAllowed = _userAllowlist?.has(key) ?? false;
    if (isSensitiveEnvName(key) && !userAllowed) continue;
    if (isSafeEnvVar(key) || userAllowed) {
      filtered[key] = value;
    }
  }
  return filtered;
}

export type EnvMode = "restricted" | "inherit" | Record<string, string>;

/**
 * resolve env mode to actual env object
 * - "restricted" (default): filterEnv() — only safe set + user allowlist
 * - "inherit": full process.env
 * - object: custom env merged with restricted base
 */
export function resolveEnv(mode: EnvMode | undefined): Record<string, string | undefined> {
  if (mode === "inherit") {
    return process.env;
  }
  if (mode === "restricted" || mode === undefined) {
    return filterEnv();
  }
  // custom env object - merge with restricted base
  return { ...filterEnv(), ...mode };
}
