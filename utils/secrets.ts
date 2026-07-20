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
  // OAuth auth.json blobs (CODEX_AUTH_JSON, GROK_AUTH_JSON)
  /_AUTH_JSON$/i,
];

export function isSensitiveEnvName(key: string): boolean {
  return SENSITIVE_PATTERNS.some((p) => p.test(key));
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
