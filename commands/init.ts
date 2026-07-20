import { execFileSync } from "node:child_process";
import * as p from "@clack/prompts";
import arg from "arg";
import pc from "picocolors";
import { modelAliases, type ProviderConfig, providers, resolveDisplayAlias } from "../models.ts";

const PULLFROG_API_URL = (process.env.PULLFROG_API_URL || "https://pullfrog.com").replace(
  /\/+$/,
  ""
);

function link(text: string, url: string): string {
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

type CliProvider = {
  id: string;
  name: string;
  envVars: readonly string[];
  models: { value: string; label: string; hint?: string | undefined }[];
};

function buildProviders(): CliProvider[] {
  return Object.entries(providers)
    .filter(([key]) => key !== "opencode" && key !== "openrouter" && key !== "bedrock")
    .map(([key, config]: [string, ProviderConfig]) => {
      // bedrock requires multi-secret setup (auth + region + model id) that
      // doesn't fit the single-paste flow below — direct users to
      // https://docs.pullfrog.com/bedrock instead. revisit once the init flow
      // supports multi-value setup. `hidden` excludes internal-only subagent
      // targets (e.g. openai/gpt-5.4) per #710.
      const aliases = modelAliases.filter(
        (a) => a.provider === key && !a.fallback && !a.routing && !a.hidden
      );
      const recommended = aliases.find((a) => a.preferred);
      const sorted = [...aliases].sort((a, b) => {
        if (a.preferred && !b.preferred) return -1;
        if (!a.preferred && b.preferred) return 1;
        return 0;
      });
      return {
        id: key,
        name: config.displayName,
        envVars: config.envVars,
        models: sorted.map((a) => ({
          value: a.slug,
          label: a.displayName,
          hint: a === recommended ? "recommended" : undefined,
        })),
      };
    });
}

const CLI_PROVIDERS = buildProviders();

function resolveModelProvider(slug: string): CliProvider | null {
  const providerId = slug.split("/")[0];
  return CLI_PROVIDERS.find((p) => p.id === providerId) ?? null;
}

// ── helpers ──

// active spinner reference so bail/catch can clean up the terminal
let activeSpin: ReturnType<typeof p.spinner> | null = null;

function bail(msg: string): never {
  if (activeSpin) {
    activeSpin.stop(pc.red("failed"));
    activeSpin = null;
  }
  p.cancel(msg);
  process.exit(1);
}

function handleCancel<T>(value: T | symbol): asserts value is T {
  if (p.isCancel(value)) {
    if (activeSpin) {
      activeSpin.stop(pc.red("canceled."));
      activeSpin = null;
    }
    p.cancel("canceled.");
    process.exit(0);
  }
}

function getGhToken(): string {
  let token: string;
  try {
    token = execFileSync("gh", ["auth", "token"], { encoding: "utf-8" }).trim();
  } catch {
    bail(
      `gh cli not found or not authenticated.\n` +
        `  ${pc.dim("install:")} https://cli.github.com\n` +
        `  ${pc.dim("then:")}    gh auth login`
    );
  }
  if (!token) {
    bail(
      `gh cli returned an empty token. try re-authenticating:\n` +
        `  ${pc.dim("run:")} gh auth login`
    );
  }
  return token;
}

type GhApiResult<T = unknown> = { data: T; scopes: string | null };

async function ghApi<T = unknown>(path: string, token: string): Promise<GhApiResult<T>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`github api ${path} returned ${response.status}: ${body}`);
    }

    const data = (await response.json().catch(() => {
      throw new Error(`github api ${path} returned non-JSON response`);
    })) as T;
    return { data, scopes: response.headers.get("x-oauth-scopes") };
  } finally {
    clearTimeout(timeout);
  }
}

function parseGitRemote(): { owner: string; repo: string } {
  let url: string;
  try {
    url = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf-8" }).trim();
  } catch {
    bail("not a git repository or no 'origin' remote found.");
  }

  const match = url.match(/github\.com(?::\d+)?[:/]+([^/]+)\/(.+?)(?:\.git)?(?:\/)?$/);
  if (!match) bail(`could not parse github owner/repo from remote: ${url}`);
  return { owner: match[1], repo: match[2] };
}

function openBrowser(url: string) {
  try {
    const platform = process.platform;
    if (platform === "darwin") execFileSync("open", [url], { stdio: "ignore" });
    else if (platform === "win32")
      execFileSync("cmd", ["/c", "start", "", url], { stdio: "ignore" });
    else execFileSync("xdg-open", [url], { stdio: "ignore" });
  } catch {
    // headless/SSH — user will open the URL manually
  }
}

// ── Pullfrog API ──

type SecretsApiData = {
  error?: string;
  appSlug?: string;
  installationId?: number | null;
  repositorySelection?: string | null;
  isOrg?: boolean;
  accessible?: boolean;
  repoSecrets?: string[];
  orgSecrets?: string[];
  pullfrogSecrets?: string[];
  repoStatus?: string | null;
  repoModel?: string | null;
  hasRuns?: boolean;
};

type SecretsInfo = {
  isOrg: boolean;
  installationId: number | null;
  secretsAccessible: boolean;
  repoSecrets: string[];
  orgSecrets: string[];
  pullfrogSecrets: string[];
  model: string | null;
  hasRuns: boolean;
};

type InstallationNotFound = {
  appSlug: string;
  installationId: number | null;
  repositorySelection: "all" | "selected" | null;
  isOrg: boolean;
};

type StatusResult =
  | ({ installed: true } & SecretsInfo)
  | ({ installed: false } & InstallationNotFound);

type SessionApiData = {
  id?: string;
  installed?: boolean;
  error?: string;
};

type SetupApiData = {
  error?: string;
  success?: boolean;
  already_existed?: boolean;
  pull_request_url?: string;
  commit_url?: string;
  hash?: string;
};

type DispatchApiData = {
  error?: string;
  url?: string;
};

type ApiResult<T = Record<string, unknown>> = { ok: boolean; status: number; data: T };

async function pullfrogApi<T = Record<string, unknown>>(ctx: {
  path: string;
  token: string;
  method?: string;
  body?: Record<string, unknown>;
}): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { authorization: `Bearer ${ctx.token}` };
  if (ctx.body) headers["content-type"] = "application/json";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${PULLFROG_API_URL}${ctx.path}`, {
      method: ctx.method || "GET",
      headers,
      body: ctx.body ? JSON.stringify(ctx.body) : null,
      signal: controller.signal,
    });
    const data = (await response.json().catch(() => ({}))) as T;
    return { ok: response.ok, status: response.status, data };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchStatus(ctx: {
  token: string;
  owner: string;
  repo: string;
}): Promise<StatusResult> {
  const result = await pullfrogApi<SecretsApiData>({
    path: `/api/cli/secrets?owner=${encodeURIComponent(ctx.owner)}&repo=${encodeURIComponent(ctx.repo)}`,
    token: ctx.token,
  });

  if (!result.ok) {
    const errorMsg = result.data.error || "";
    if (result.status === 401) bail("invalid or expired github token.");
    if (result.status === 404) {
      const sel = result.data.repositorySelection;
      if (!result.data.appSlug) bail("server did not return appSlug");
      return {
        installed: false,
        appSlug: result.data.appSlug,
        installationId:
          typeof result.data.installationId === "number" ? result.data.installationId : null,
        repositorySelection: sel === "all" || sel === "selected" ? sel : null,
        isOrg: result.data.isOrg === true,
      };
    }
    bail(errorMsg || `secrets check failed (${result.status})`);
  }

  return {
    installed: true,
    isOrg: result.data.isOrg === true,
    installationId:
      typeof result.data.installationId === "number" ? result.data.installationId : null,
    secretsAccessible: result.data.accessible !== false,
    repoSecrets: result.data.repoSecrets || [],
    orgSecrets: result.data.orgSecrets || [],
    pullfrogSecrets: result.data.pullfrogSecrets || [],
    model: result.data.repoModel ?? null,
    hasRuns: result.data.hasRuns === true,
  };
}

// ── sessions ──

async function createSession(ctx: {
  token: string;
  owner: string;
  repo: string;
}): Promise<string | null> {
  try {
    const result = await pullfrogApi<SessionApiData>({
      path: "/api/cli/session",
      token: ctx.token,
      method: "POST",
      body: { owner: ctx.owner.toLowerCase(), repo: ctx.repo.toLowerCase() },
    });
    if (!result.ok || !result.data.id) return null;
    return result.data.id;
  } catch {
    return null;
  }
}

type PollResult = "installed" | "pending" | "expired";

async function pollSession(ctx: { token: string; sessionId: string }): Promise<PollResult> {
  const result = await pullfrogApi<SessionApiData>({
    path: `/api/cli/session/${ctx.sessionId}`,
    token: ctx.token,
  });
  if (result.status === 410) return "expired";
  if (!result.ok) return "pending";
  return result.data.installed === true ? "installed" : "pending";
}

function cleanupSession(ctx: { token: string; sessionId: string }) {
  void pullfrogApi({
    path: `/api/cli/session/${ctx.sessionId}`,
    token: ctx.token,
    method: "DELETE",
  }).catch(() => {});
}

// ── installation ──

const SESSION_POLL_MS = 750;
const FALLBACK_POLL_MS = 5_000;
const HINT_AFTER_MS = 10_000;
const TIMEOUT_MS = 3 * 60 * 1000;

function listenForKey(key: string) {
  let triggered = false;
  const onData = (data: Buffer) => {
    if (data.toString().toLowerCase() === key) triggered = true;
  };
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.on("data", onData);
  return {
    consume() {
      if (!triggered) return false;
      triggered = false;
      return true;
    },
    stop() {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
    },
  };
}

function installationConfigUrl(ctx: { owner: string; installationId: number; isOrg: boolean }) {
  return ctx.isOrg
    ? `https://github.com/organizations/${ctx.owner}/settings/installations/${ctx.installationId}`
    : `https://github.com/settings/installations/${ctx.installationId}`;
}

async function ensureInstallation(ctx: {
  token: string;
  owner: string;
  repo: string;
}): Promise<SecretsInfo> {
  activeSpin!.start("checking pullfrog app installation");

  const initial = await fetchStatus(ctx);
  if (initial.installed) {
    activeSpin!.stop(`pullfrog app is installed on ${pc.cyan(`@${ctx.owner}`)}`);
    if (initial.installationId) {
      const configUrl = installationConfigUrl({
        owner: ctx.owner,
        installationId: initial.installationId,
        isOrg: initial.isOrg,
      });
      process.stdout.write(`${pc.gray(p.S_BAR)}    ${link(pc.dim(configUrl), configUrl)}\n`);
    }
    return initial;
  }

  const sessionId = await createSession(ctx);

  if (initial.installationId) {
    const repoRef = pc.bold(`${ctx.owner}/${ctx.repo}`);
    const configUrl = installationConfigUrl({
      owner: ctx.owner,
      installationId: initial.installationId,
      isOrg: initial.isOrg,
    });
    activeSpin!.stop(`pullfrog is installed on selected repos, but ${repoRef} is not included.`);
    p.log.info(
      `add it under "Repository access" on the installation config page.\n  ${pc.dim(configUrl)}`
    );
    const openIt = await p.confirm({ message: "open browser?", active: "yes", inactive: "no" });
    handleCancel(openIt);
    if (openIt) openBrowser(configUrl);
  } else {
    activeSpin!.stop("pullfrog app not installed");
    const installUrl = `https://github.com/apps/${initial.appSlug}/installations/select_target?state=cli`;
    p.log.info(`opening browser to install...\n  ${pc.dim(installUrl)}`);
    openBrowser(installUrl);
  }

  const isRepoAccessUpdate = !!initial.installationId;
  const baseMsg = isRepoAccessUpdate
    ? "once you've added the repo, onboarding will proceed automatically"
    : "once you've installed the app, onboarding will proceed automatically";
  activeSpin!.start(baseMsg);

  let activeSessionId = sessionId;
  let pollMs = activeSessionId ? SESSION_POLL_MS : FALLBACK_POLL_MS;
  const listener = listenForKey("r");
  const startedAt = Date.now();
  let hintShown = false;

  try {
    while (Date.now() - startedAt < TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, pollMs));

      if (!hintShown && Date.now() - startedAt > HINT_AFTER_MS) {
        activeSpin!.message(`${baseMsg} ${pc.dim("(press r to recheck manually)")}`);
        hintShown = true;
      }

      const doneMsg = isRepoAccessUpdate ? "repo access confirmed" : "pullfrog app installed";

      if (listener.consume()) {
        activeSpin!.message("rechecking via GitHub API");
        try {
          const status = await fetchStatus(ctx);
          if (status.installed) {
            if (activeSessionId) cleanupSession({ token: ctx.token, sessionId: activeSessionId });
            activeSpin!.stop(doneMsg);
            return status;
          }
        } catch {
          // network error — keep going
        }
        activeSpin!.message(`${baseMsg} ${pc.dim("(press r to recheck manually)")}`);
        continue;
      }

      if (activeSessionId) {
        // fast path: lightweight DB session poll (no GitHub API calls)
        try {
          const result = await pollSession({ token: ctx.token, sessionId: activeSessionId });
          if (result === "expired") {
            activeSessionId = null;
            pollMs = FALLBACK_POLL_MS;
            continue;
          }
          if (result === "installed") {
            const status = await fetchStatus(ctx);
            if (status.installed) {
              cleanupSession({ token: ctx.token, sessionId: activeSessionId });
              activeSpin!.stop(doneMsg);
              return status;
            }
          }
        } catch {
          // transient error — keep polling
        }
      } else {
        // no session available — poll fetchStatus directly at slower interval
        try {
          const status = await fetchStatus(ctx);
          if (status.installed) {
            activeSpin!.stop(doneMsg);
            return status;
          }
        } catch {
          // transient error — keep polling
        }
      }
    }
  } finally {
    listener.stop();
  }

  if (activeSessionId) cleanupSession({ token: ctx.token, sessionId: activeSessionId });
  bail(
    isRepoAccessUpdate
      ? "timed out waiting for repo access.\n" +
          `  ${pc.dim("add the repo, then re-run:")} npx pullfrog init`
      : "timed out waiting for app installation.\n" +
          `  ${pc.dim("if your org requires admin approval, ask an admin to approve,")}\n` +
          `  ${pc.dim("then re-run:")} npx pullfrog init`
  );
}

// ── secret management ──

type StorageMethod = "pullfrog" | "github";
type SecretScope = "account" | "repo";

type SecretSetResult = { saved: boolean; orgFailed: boolean };

function setGhSecret(ctx: {
  name: string;
  value: string;
  org: string | null;
  repoSlug: string;
}): SecretSetResult {
  let orgFailed = false;

  if (ctx.org) {
    try {
      execFileSync("gh", ["secret", "set", ctx.name, "--org", ctx.org, "--visibility", "all"], {
        input: ctx.value,
        stdio: ["pipe", "ignore", "pipe"],
        encoding: "utf-8",
      });
      return { saved: true, orgFailed: false };
    } catch {
      orgFailed = true;
    }
  }

  try {
    execFileSync("gh", ["secret", "set", ctx.name, "--repo", ctx.repoSlug], {
      input: ctx.value,
      stdio: ["pipe", "ignore", "pipe"],
      encoding: "utf-8",
    });
    return { saved: true, orgFailed };
  } catch {
    return { saved: false, orgFailed };
  }
}

type PullfrogSecretResult = { saved: boolean; error: string };

async function setPullfrogSecret(ctx: {
  token: string;
  owner: string;
  repo: string;
  name: string;
  value: string;
  scope: SecretScope;
}): Promise<PullfrogSecretResult> {
  const result = await pullfrogApi<{ success?: boolean; error?: string }>({
    path: "/api/cli/secrets",
    token: ctx.token,
    method: "POST",
    body: {
      owner: ctx.owner,
      repo: ctx.repo,
      name: ctx.name,
      value: ctx.value,
      scope: ctx.scope,
    },
  });
  if (result.ok && result.data.success === true) {
    return { saved: true, error: "" };
  }
  return { saved: false, error: result.data.error || `api returned ${result.status}` };
}

async function promptScope(ctx: { owner: string; repo: string }): Promise<SecretScope> {
  const scope = await p.select<SecretScope>({
    message: "secret scope",
    options: [
      { value: "account", label: `${ctx.owner} organization`, hint: "shared across repos" },
      { value: "repo", label: `${ctx.owner}/${ctx.repo} only` },
    ],
  });
  handleCancel(scope);
  return scope;
}

async function handleSecret(ctx: {
  token: string;
  owner: string;
  repo: string;
  provider: CliProvider;
  secrets: SecretsInfo;
}): Promise<void> {
  const repoSecretsUrl = `https://github.com/${ctx.owner}/${ctx.repo}/settings/secrets/actions`;

  const matches: { name: string; source: string }[] = [];
  for (const v of ctx.provider.envVars) {
    if (ctx.secrets.pullfrogSecrets.includes(v)) matches.push({ name: v, source: "pullfrog" });
    else if (ctx.secrets.secretsAccessible && ctx.secrets.orgSecrets.includes(v))
      matches.push({ name: v, source: "org secret" });
    else if (ctx.secrets.secretsAccessible && ctx.secrets.repoSecrets.includes(v))
      matches.push({ name: v, source: "repo secret" });
  }

  if (matches.length > 0) {
    activeSpin!.start("");
    activeSpin!.stop("secrets already configured");
    for (const m of matches) {
      process.stdout.write(
        `${pc.gray(p.S_BAR)}    ${pc.cyan(m.name)} ${pc.dim(`(${m.source})`)}\n`
      );
    }
    return;
  }

  if (!ctx.secrets.secretsAccessible) {
    p.log.info(`could not verify GitHub secrets (app lacks permission)`);
  }

  // subscription-OAuth env vars offered alongside API keys for providers that
  // ship a first-class CLI harness (Claude Code, Antigravity, Grok Build).
  type CredChoice = {
    oauthEnv: string;
    oauthLabel: string;
    oauthHint: string;
    apiLabel: string;
    apiHint: string;
  };
  const oauthChoices: CredChoice[] = [];
  if (ctx.provider.envVars.includes("CLAUDE_CODE_OAUTH_TOKEN")) {
    oauthChoices.push({
      oauthEnv: "CLAUDE_CODE_OAUTH_TOKEN",
      oauthLabel: "Claude Code OAuth token",
      oauthHint: `run ${pc.cyan("claude setup-token")} — works with Pro/Max subscriptions`,
      apiLabel: "Anthropic API key",
      apiHint: "from console.anthropic.com",
    });
  }
  if (ctx.provider.envVars.includes("ANTIGRAVITY_TOKEN")) {
    oauthChoices.push({
      oauthEnv: "ANTIGRAVITY_TOKEN",
      oauthLabel: "Antigravity OAuth token",
      oauthHint: "local agy login cache — Google AI Pro/Ultra subscription",
      apiLabel: "Gemini API key",
      apiHint: "from aistudio.google.com / Google AI Studio",
    });
  }
  if (ctx.provider.envVars.includes("GROK_AUTH_JSON")) {
    oauthChoices.push({
      oauthEnv: "GROK_AUTH_JSON",
      oauthLabel: "Grok Build auth.json (base64)",
      oauthHint: "cat ~/.grok/auth.json | base64 — SuperGrok / X Premium+",
      apiLabel: "xAI API key",
      apiHint: "from console.x.ai",
    });
  }

  let envVar = ctx.provider.envVars[0];
  // prefer the first non-OAuth key as the default API option when listing
  const apiEnvDefault =
    ctx.provider.envVars.find(
      (v) =>
        v !== "CLAUDE_CODE_OAUTH_TOKEN" && v !== "ANTIGRAVITY_TOKEN" && v !== "GROK_AUTH_JSON"
    ) ?? ctx.provider.envVars[0];

  if (oauthChoices.length > 0) {
    // when a provider has exactly one OAuth shape, offer oauth vs api.
    // (providers currently ship at most one subscription credential.)
    const choice = oauthChoices[0];
    const authMethod = await p.select({
      message: "which credential do you want to use?",
      options: [
        {
          value: "oauth",
          label: choice.oauthLabel,
          hint: choice.oauthHint,
        },
        {
          value: "api",
          label: choice.apiLabel,
          hint: choice.apiHint,
        },
      ],
    });
    handleCancel(authMethod);
    envVar = authMethod === "oauth" ? choice.oauthEnv : apiEnvDefault;
  }

  const method = await p.select<StorageMethod>({
    message: `where should ${pc.cyan(envVar)} be stored?`,
    options: [
      {
        value: "pullfrog",
        label: "Pullfrog",
        hint: "recommended — auto-injected, no workflow changes",
      },
      {
        value: "github",
        label: "GitHub Actions secret",
        hint: "requires env block in pullfrog.yml",
      },
    ],
  });
  handleCancel(method);

  const pasteLabel =
    envVar === "CLAUDE_CODE_OAUTH_TOKEN" || envVar === "ANTIGRAVITY_TOKEN"
      ? "OAuth token"
      : envVar === "GROK_AUTH_JSON"
        ? "base64 auth.json"
        : `${ctx.provider.name} API key`;
  const apiKey = await p.password({
    message: `paste your ${pasteLabel} ${pc.dim("(Enter to skip)")}`,
    mask: "*",
    validate: () => undefined,
  });
  handleCancel(apiKey);

  if (!apiKey) {
    p.log.info(
      `skipped — set it manually at:\n  ${pc.dim(method === "pullfrog" ? `${PULLFROG_API_URL}/console/${ctx.owner}` : repoSecretsUrl)}`
    );
    return;
  }

  if (method === "pullfrog") {
    const scope: SecretScope = ctx.secrets.isOrg ? await promptScope(ctx) : "account";

    activeSpin!.start(`saving ${envVar}`);
    let saveResult: PullfrogSecretResult;
    try {
      saveResult = await setPullfrogSecret({
        token: ctx.token,
        owner: ctx.owner,
        repo: ctx.repo,
        name: envVar,
        value: apiKey,
        scope,
      });
    } catch (error) {
      activeSpin!.stop(pc.red("could not save secret"));
      p.log.warn(
        `${error instanceof Error ? error.message : "network error"}\n  set it manually at: ${pc.dim(`${PULLFROG_API_URL}/console/${ctx.owner}`)}`
      );
      return;
    }

    if (saveResult.saved) {
      activeSpin!.stop(`saved ${pc.cyan(envVar)} to Pullfrog`);
    } else {
      activeSpin!.stop(pc.red("could not save secret"));
      p.log.warn(
        `${saveResult.error}\n  set it manually at: ${pc.dim(`${PULLFROG_API_URL}/console/${ctx.owner}`)}`
      );
    }
    return;
  }

  // github actions secret path
  let org: string | null = null;
  if (ctx.secrets.isOrg) {
    const scope = await promptScope(ctx);
    org = scope === "account" ? ctx.owner : null;
  }

  const secretsUrl = org
    ? `https://github.com/organizations/${org}/settings/secrets/actions`
    : repoSecretsUrl;

  activeSpin!.start(`saving ${envVar}`);
  const secretResult = setGhSecret({
    name: envVar,
    value: apiKey,
    org,
    repoSlug: `${ctx.owner}/${ctx.repo}`,
  });
  if (secretResult.saved) {
    activeSpin!.stop(
      `saved ${pc.cyan(envVar)} to ${org && !secretResult.orgFailed ? `${pc.dim(ctx.owner)} org secret` : "GitHub Actions secret"}`
    );
    if (secretResult.orgFailed) {
      p.log.warn("org secret failed (admin access required) — saved as repo secret instead");
    }
  } else {
    activeSpin!.stop(pc.red("could not set secret"));
    p.log.warn(`set it manually at:\n  ${pc.dim(secretsUrl)}`);
  }
}

async function promptTestRun(ctx: { token: string; owner: string; repo: string }): Promise<void> {
  const proceed = await p.select({
    message: "test your installation?",
    options: [
      { value: true, label: "yes", hint: "dispatches a test run in your GitHub Actions" },
      { value: false, label: "skip" },
    ],
  });
  handleCancel(proceed);
  if (!proceed) return;

  activeSpin!.start("dispatching test run");
  const result = await pullfrogApi<DispatchApiData>({
    path: "/api/cli/dispatch",
    token: ctx.token,
    method: "POST",
    body: { owner: ctx.owner, repo: ctx.repo, prompt: "Tell me a joke" },
  });

  if (!result.ok) {
    activeSpin!.stop(pc.red("could not dispatch"));
    p.log.warn(result.data.error || `dispatch failed (${result.status})`);
    return;
  }

  activeSpin!.stop("dispatched test run");
  if (result.data.url) {
    process.stdout.write(
      `${pc.gray(p.S_BAR)}    ${link(pc.dim(result.data.url), result.data.url)}\n`
    );
    openBrowser(result.data.url);
  }
}

// ── main ──

async function main() {
  p.intro(pc.bgGreen(pc.black(" pullfrog ")));

  const spin = p.spinner();
  activeSpin = spin;

  // 1. authenticate
  spin.start("authenticating with github");
  const token = getGhToken();
  const userResult = await ghApi<{ login: string }>("/user", token);
  const user = userResult.data;

  // gho_ tokens from `gh auth login` expose scopes via x-oauth-scopes header.
  // fine-grained PATs (github_pat_) don't return scopes — they pass this check.
  // split on ", " and match exact scope — .includes("repo") would false-positive on "public_repo"
  const scopeSet = userResult.scopes !== null ? new Set(userResult.scopes.split(", ")) : null;
  if (scopeSet !== null && !scopeSet.has("repo")) {
    bail(
      `your token is missing the ${pc.bold('"repo"')} scope.\n` +
        `  ${pc.dim("run:")} gh auth refresh --scopes repo\n` +
        `  ${pc.dim("then:")} npx pullfrog init`
    );
  }

  spin.stop(`hello, ${pc.cyan(`@${user.login}`)}`);

  // 2. detect repo
  spin.start("detecting repository");
  const remote = parseGitRemote();
  spin.stop(`detected repo ${pc.cyan(`${remote.owner}/${remote.repo}`)}`);

  // 3. ensure app installation + check secrets
  const secrets = await ensureInstallation({ token, owner: remote.owner, repo: remote.repo });

  // 4. select provider + model (skip if already set)
  let model: string;
  let provider: CliProvider;

  if (secrets.model) {
    model = secrets.model;
    const resolved = resolveModelProvider(secrets.model);
    if (!resolved) bail(`unknown model provider: ${secrets.model}`);
    provider = resolved;
    // walk the fallback chain so a deprecated stored slug shows the model
    // the run will actually execute against (e.g. "GPT", not "GPT Codex").
    const displayAlias = resolveDisplayAlias(secrets.model);
    const label = displayAlias ? displayAlias.displayName : secrets.model;
    spin.start("");
    spin.stop(`using model ${pc.cyan(label)}`);
  } else {
    const providerId = await p.select({
      message: "select your preferred model provider",
      options: CLI_PROVIDERS.map((cp) => ({
        value: cp.id,
        label: cp.name,
      })),
    });
    handleCancel(providerId);

    const found = CLI_PROVIDERS.find((cp) => cp.id === providerId);
    if (!found) bail(`unknown provider: ${providerId}`);
    provider = found;

    if (provider.models.length === 1) {
      model = provider.models[0].value;
      spin.start("");
      spin.stop(`using ${pc.bold(provider.models[0].label)}`);
    } else {
      const recommendedModel = provider.models.find((m) => m.hint === "recommended");
      const options = provider.models.map((m) => {
        if (m.hint) return { value: m.value, label: m.label, hint: m.hint };
        return { value: m.value, label: m.label };
      });
      const selected = await p.select(
        recommendedModel
          ? { message: "select model", initialValue: recommendedModel.value, options }
          : { message: "select model", options }
      );
      handleCancel(selected);
      model = selected;
    }
  }

  // 5. check/set secret
  await handleSecret({ token, owner: remote.owner, repo: remote.repo, provider, secrets });

  // 6. create workflow
  spin.start("creating pullfrog.yml workflow");

  const result = await pullfrogApi<SetupApiData>({
    path: "/api/cli/setup",
    token,
    method: "POST",
    body: { owner: remote.owner, repo: remote.repo, model },
  });

  if (!result.ok) {
    bail(result.data.error || `api returned ${result.status}`);
  }

  let skipTestRun = false;

  if (result.data.already_existed) {
    spin.stop("pullfrog.yml already exists");
  } else if (result.data.pull_request_url) {
    spin.stop("opened pull request with pullfrog.yml");
    process.stdout.write(
      `${pc.gray(p.S_BAR)}    ${link(pc.dim(result.data.pull_request_url), result.data.pull_request_url)}\n`
    );
    openBrowser(result.data.pull_request_url);

    const merged = await p.select({
      message: "merge the PR to activate pullfrog, then continue",
      options: [
        { value: true, label: "continue", hint: "PR has been merged" },
        { value: false, label: "skip" },
      ],
    });
    handleCancel(merged);
    if (!merged) skipTestRun = true;
  } else {
    const short = result.data.hash?.slice(0, 7);
    spin.stop(
      short ? `committed pullfrog.yml to repo ${pc.dim(short)}` : "committed pullfrog.yml to repo"
    );
  }

  if (!skipTestRun && !secrets.hasRuns) {
    await promptTestRun({ token, owner: remote.owner, repo: remote.repo });
  }

  const consoleUrl = `${PULLFROG_API_URL}/console/${remote.owner}/${remote.repo}`;
  spin.start("");
  spin.stop("repo is configurable via the Pullfrog dashboard");
  process.stdout.write(`${pc.gray(p.S_BAR)}    ${link(pc.dim(consoleUrl), consoleUrl)}\n`);
  activeSpin = null;
  p.outro("done.");
}

interface InitCliParams {
  args: string[];
  prog: string;
  showHelp?: boolean;
}

function printInitUsage(params: { stream: typeof console.log; prog: string }): void {
  params.stream(`usage: ${params.prog} init\n`);
  params.stream("set up pullfrog on the current repository.");
  params.stream("");
  params.stream("options:");
  params.stream("  -h, --help   show help");
}

function parseInitArgs(args: string[]) {
  return arg(
    {
      "--help": Boolean,
      "-h": "--help",
    },
    {
      argv: args,
    }
  );
}

export async function runCli(params: InitCliParams): Promise<void> {
  if (params.showHelp) {
    printInitUsage({ stream: console.log, prog: params.prog });
    return;
  }

  let parsed: ReturnType<typeof parseInitArgs>;
  try {
    parsed = parseInitArgs(params.args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${message}\n`);
    printInitUsage({ stream: console.error, prog: params.prog });
    process.exit(1);
  }

  if (parsed["--help"]) {
    printInitUsage({ stream: console.log, prog: params.prog });
    return;
  }

  if (parsed._.length > 0) {
    console.error(`unexpected positional arguments for init: ${parsed._.join(" ")}\n`);
    printInitUsage({ stream: console.error, prog: params.prog });
    process.exit(1);
  }

  await run();
}

export async function run() {
  try {
    await main();
  } catch (error) {
    if (activeSpin) {
      activeSpin.stop(pc.red("failed"));
      activeSpin = null;
    }
    const msg =
      error instanceof Error && error.name === "AbortError"
        ? "request timed out — check your network connection and try again"
        : error instanceof Error
          ? error.message
          : String(error);
    p.log.error(msg);
    process.exit(1);
  }
}
