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
  /_HEADERS$/i,
];

export function isSensitiveEnvName(key: string): boolean {
  return SENSITIVE_PATTERNS.some((p) => p.test(key));
}

/**
 * Whether a credential sent as an HTTP header holds a character no header can carry: a C0 control
 * from a line-wrapped paste (#1162), or a smart quote or zero-width space from a document (#1621).
 * JSON-blob credentials (`CODEX_AUTH_JSON`) legitimately carry newlines, so they never match.
 */
export function isUnsendableSecret(name: string, value: string): boolean {
  if (!name.endsWith("_API_KEY") && name !== "CLAUDE_CODE_OAUTH_TOKEN") return false;
  return [...value].some((ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || code > 0x7e;
  });
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
  // a runner's shared object store: without it, the commits it holds read as `bad object HEAD`
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
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

const PROXY_ENV_NAMES = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_USE_ENV_PROXY",
];

/**
 * the runner's egress proxy, for an agent process that reaches its model through it, as opencode
 * and claude already do by inheriting `process.env` (#1677). kept out of SAFE_ENV_NAMES because a
 * proxy URL can carry credentials: the shell gets it only through the user allowlist.
 */
export function proxyEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PROXY_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
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
