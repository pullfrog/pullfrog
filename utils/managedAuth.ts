import { installCodexAuth, PULLFROG_DATA_DIR } from "./codexHome.ts";
import type { ManagedAuthWriteback } from "./managedAuthState.ts";

export interface ManagedAuthInstall {
  /** Env changes to apply to processes that need managed auth. `undefined` deletes a var. */
  env: Record<string, string | undefined>;
  /** Filesystem paths that native agent tools and MCP shell must not expose. */
  secretDenyPaths: string[];
  /** Post-hook persistence records for refreshable managed credentials. */
  writebacks: ManagedAuthWriteback[];
}

interface InstallManagedAuthParams {
  /** Present when the caller wants refresh write-back state for the post hook. */
  apiToken?: string | undefined;
}

export function installManagedAuth(params: InstallManagedAuthParams = {}): ManagedAuthInstall {
  const env: Record<string, string | undefined> = {};
  const writebacks: ManagedAuthWriteback[] = [];

  const codexAuth = installCodexAuth();
  if (codexAuth) {
    env.XDG_DATA_HOME = codexAuth.xdgDataHome;
    // OpenCode's provider merge can otherwise ambiguously prefer the API-key
    // path over Codex OAuth. Keep subscription auth deterministic.
    env.OPENAI_API_KEY = undefined;

    if (params.apiToken) {
      writebacks.push({
        kind: "codex",
        apiToken: params.apiToken,
        secretName: "CODEX_AUTH_JSON",
        authPath: codexAuth.authPath,
        originalRefresh: codexAuth.originalRefresh,
      });
    }
  }

  return {
    env,
    // /var/lib/pullfrog is the reserved home for Pullfrog-managed on-disk
    // secrets. It remains denied even when no credential is installed.
    secretDenyPaths: [PULLFROG_DATA_DIR],
    writebacks,
  };
}

export function applyManagedAuthEnv(
  env: Record<string, string | undefined>,
  changes: Record<string, string | undefined>
): void {
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
}
