import { createSign } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as core from "@actions/core";
import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";
import * as yes from "yes";
import { apiFetch } from "./apiFetch.ts";
import { maskSecret } from "./secretCommands.ts";

/** OIDC audience for Pullfrog API token exchanges */
const OIDC_AUDIENCE = "pullfrog-api";

/** GitHub Actions OIDC request credentials, stashed before env wipes */
export interface OidcCredentials {
  requestUrl: string;
  requestToken: string;
}

function isObject(value: unknown) {
  return typeof value === "object" && value !== null;
}

// we don't get access to the actual class from @octokit/rest
// it's reachable from @octokit/request-error but we'd have to add a dependency on it
// and it would pose a risk of accidentally pulling a different version of that class (node_modules dep graphs ❤️)
// so it's safer to ducktype this
interface OctokitResponseShim {
  headers: Record<string, string | number | undefined>;
}

export interface InstallationToken {
  token: string;
  expires_at: string;
  installation_id: number;
  repository: string;
  ref: string;
  runner_environment: string;
  owner?: string;
}

interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  repoOwner: string;
  repoName: string;
}

interface Installation {
  id: number;
  account: {
    login: string;
    type: string;
  };
}

interface Repository {
  owner: {
    login: string;
  };
  name: string;
}

interface InstallationTokenResponse {
  token: string;
  expires_at: string;
}

interface RepositoriesResponse {
  repositories: Repository[];
}

function isOIDCAvailable(): boolean {
  // OIDC requires both env vars to be set (only in real GitHub Actions with id-token permission)
  return Boolean(
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  );
}

type ReadWrite = "read" | "write";
type WriteOnly = "write";

/**
 * GitHub App installation access token permissions.
 * passed to `POST /app/installations/{id}/access_tokens` to scope the token.
 * fields and allowed values come from the `app-permissions` OpenAPI schema.
 * @see https://docs.github.com/en/rest/apps/installations#create-an-installation-access-token-for-an-app
 * @see https://github.com/github/rest-api-description — components.schemas.app-permissions
 */
export type GitHubAppPermissions = {
  actions?: ReadWrite;
  artifact_metadata?: ReadWrite;
  attestations?: ReadWrite;
  checks?: ReadWrite;
  contents?: ReadWrite;
  deployments?: ReadWrite;
  discussions?: ReadWrite;
  issues?: ReadWrite;
  packages?: ReadWrite;
  pages?: ReadWrite;
  pull_requests?: ReadWrite;
  security_events?: ReadWrite;
  statuses?: ReadWrite;
  workflows?: WriteOnly;
};

type AcquireTokenOptions = {
  repos?: string[] | undefined;
  /**
   * handle to the server-persisted cross-repo grant, required whenever `repos`
   * names anything beyond the primary. the server bounds the request against
   * the sets IT stored, so this cannot widen the token by itself.
   */
  xrepoGrant?: string | undefined;
  permissions?: GitHubAppPermissions;
  /**
   * stashed OIDC credentials for minting after restricted mode deletes
   * ACTIONS_ID_TOKEN_REQUEST_* from process.env (mid-run token refresh)
   */
  oidc?: OidcCredentials | undefined;
};

/**
 * Thrown when a token-exchange or OIDC ID-token request returns a non-2xx
 * response. The retry policy in `acquireNewToken` looks for this concrete
 * type to skip retries — 4xx is terminal user state (not-installed,
 * not-authorized) and 5xx is rare enough that re-running the workflow is the
 * right escape hatch. Genuine network failures throw plain `Error` and stay
 * retryable.
 */
class TokenExchangeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "TokenExchangeError";
    this.status = status;
  }
}

/**
 * mint a GitHub Actions OIDC ID token from stashed credentials without
 * touching process.env — `core.getIDToken` reads the env vars directly,
 * which restricted mode has already deleted by the time a refresh runs.
 * throws TokenExchangeError on HTTP errors and a "timed out" Error on
 * timeout so `acquireNewToken`'s retry predicate treats 5xx/429/timeouts
 * as transient.
 */
export async function fetchIdTokenFromStash(creds: OidcCredentials): Promise<string> {
  const url = new URL(creds.requestUrl);
  url.searchParams.set("audience", OIDC_AUDIENCE);
  const timeoutMs = 30000;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${creds.requestToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error(`ID token request timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
  if (!response.ok) {
    throw new TokenExchangeError(
      response.status,
      `Failed to get ID token: ${response.status} ${response.statusText}`
    );
  }
  const body = (await response.json()) as { value?: string };
  if (!body.value) {
    throw new Error("ID token response has no value field");
  }
  maskSecret(body.value);
  return body.value;
}

/**
 * `core.getIDToken` re-wraps an HTTP failure as a plain `Error` with the status
 * stringified into the body (`Error Code : 503`), so `isTransientTokenError`
 * saw no status, `acquireNewToken` bailed on attempt 1, and its `[1000, 2000]`
 * backoff was dead code on this path — while the stashed-credentials sibling
 * retried the identical upstream 503. translating restores one predicate for
 * both paths. see #1182.
 */
function translateIdTokenError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const status = error.message.match(/Error Code\s*:\s*(\d{3})/)?.[1];
  if (!status) return error;
  return new TokenExchangeError(Number(status), error.message);
}

/**
 * One ID token per run for our single audience. `acquireTokenViaOIDC` runs two
 * to four times per run (git token, MCP token, xrepo read token) on top of
 * `resolveRunContextData`'s own mint, and each call used to hit the runner's
 * OIDC endpoint again — back-to-back requests are exactly what provoked the
 * Envoy load-shed (`reset reason: overflow`) that killed 19 runs in 24h, all of
 * them AFTER setup had already succeeded (#1182). The token is valid for
 * minutes, so the TTL costs nothing; failures are never cached, so a caller's
 * own retry still re-mints. Mid-run refreshes take the stashed-credentials path
 * (`opts.oidc`) and deliberately bypass this.
 */
export const mintIdToken = yes.query({
  run: async () => {
    try {
      return await core.getIDToken(OIDC_AUDIENCE);
    } catch (error) {
      throw translateIdTokenError(error);
    }
  },
  ttl: 60_000,
  name: "OIDC ID token",
});

async function acquireTokenViaOIDC(opts?: AcquireTokenOptions): Promise<string> {
  const oidcToken = opts?.oidc ? await fetchIdTokenFromStash(opts.oidc) : await mintIdToken();

  const repos = [...(opts?.repos ?? [])];
  const targetRepo = process.env.GITHUB_REPOSITORY?.split("/")[1];
  if (targetRepo) {
    repos.push(targetRepo);
  }
  const reposParam = repos.length ? `?repos=${repos.join(",")}` : "";

  const timeoutMs = 30000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const tokenResponse = await apiFetch({
      path: `/api/github/installation-token${reposParam}`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${oidcToken}`,
        "Content-Type": "application/json",
        ...(opts?.xrepoGrant ? { "x-pullfrog-xrepo-grant": opts.xrepoGrant } : {}),
      },
      body: opts?.permissions ? JSON.stringify({ permissions: opts.permissions }) : undefined,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!tokenResponse.ok) {
      // prefer the server-side `error` field — it's the single source of
      // truth for the install URL (uses GITHUB_APP_INSTALL_URL, which
      // varies per env / GITHUB_APP_SLUG). fall back to a generic message
      // if the body isn't JSON or doesn't carry an `error` field.
      let serverMessage: string | undefined;
      try {
        const body = (await tokenResponse.json()) as { error?: unknown };
        if (typeof body.error === "string") serverMessage = body.error;
      } catch {
        // body wasn't JSON — fall through to the generic message
      }
      throw new TokenExchangeError(
        tokenResponse.status,
        serverMessage ??
          `Token exchange failed: ${tokenResponse.status} ${tokenResponse.statusText}`
      );
    }

    const tokenData = (await tokenResponse.json()) as InstallationToken;
    return tokenData.token;
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Token exchange timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
}

const base64UrlEncode = (str: string): string => {
  return Buffer.from(str)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
};

const generateJWT = (appId: string, privateKey: string): string => {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60,
    exp: now + 5 * 60,
    iss: appId,
  };

  const header = {
    alg: "RS256",
    typ: "JWT",
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signaturePart = `${encodedHeader}.${encodedPayload}`;

  const signature = createSign("RSA-SHA256")
    .update(signaturePart)
    .sign(privateKey, "base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  return `${signaturePart}.${signature}`;
};

const githubRequest = async <T>(
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {}
): Promise<T> => {
  const { method = "GET", headers = {}, body } = options;

  const url = `https://api.github.com${path}`;
  const requestHeaders = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "Pullfrog-Installation-Token-Generator/1.0",
    ...headers,
  };

  const response = await fetch(url, {
    method,
    headers: requestHeaders,
    ...(body && { body }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `GitHub API request failed: ${response.status} ${response.statusText}\n${errorText}`
    );
  }

  return response.json() as T;
};

const checkRepositoryAccess = async (
  token: string,
  repoOwner: string,
  repoName: string
): Promise<boolean> => {
  try {
    const response = await githubRequest<RepositoriesResponse>("/installation/repositories", {
      headers: { Authorization: `token ${token}` },
    });

    const ownerLower = repoOwner.toLowerCase();
    const nameLower = repoName.toLowerCase();
    return response.repositories.some(
      (repo) =>
        repo.owner.login.toLowerCase() === ownerLower && repo.name.toLowerCase() === nameLower
    );
  } catch {
    return false;
  }
};

const createInstallationToken = async (
  jwt: string,
  installationId: number,
  permissions?: GitHubAppPermissions
): Promise<string> => {
  const requestOpts: { method: string; headers: Record<string, string>; body?: string } = {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
  };
  if (permissions) {
    requestOpts.body = JSON.stringify({ permissions });
  }
  const response = await githubRequest<InstallationTokenResponse>(
    `/app/installations/${installationId}/access_tokens`,
    requestOpts
  );

  return response.token;
};

const findInstallationId = async (
  jwt: string,
  repoOwner: string,
  repoName: string
): Promise<number> => {
  const installations = await githubRequest<Installation[]>("/app/installations", {
    headers: { Authorization: `Bearer ${jwt}` },
  });

  for (const installation of installations) {
    try {
      const tempToken = await createInstallationToken(jwt, installation.id);
      const hasAccess = await checkRepositoryAccess(tempToken, repoOwner, repoName);

      if (hasAccess) {
        return installation.id;
      }
    } catch {}
  }

  throw new Error(
    `No installation found with access to ${repoOwner}/${repoName}. ` +
      "Ensure the GitHub App is installed on the target repository."
  );
};

// for local development only
async function acquireTokenViaGitHubApp(opts?: AcquireTokenOptions): Promise<string> {
  if (!process.env.GITHUB_APP_ID || !process.env.GITHUB_PRIVATE_KEY) {
    throw new Error(
      "cannot acquire token via GitHub App: GITHUB_APP_ID and GITHUB_PRIVATE_KEY must be set"
    );
  }

  const repoContext = parseRepoContext();

  const config: GitHubAppConfig = {
    appId: process.env.GITHUB_APP_ID,
    privateKey: process.env.GITHUB_PRIVATE_KEY.replace(/\\n/g, "\n"),
    repoOwner: repoContext.owner,
    repoName: repoContext.name,
  };

  const jwt = generateJWT(config.appId, config.privateKey);
  const installationId = await findInstallationId(jwt, config.repoOwner, config.repoName);
  return await createInstallationToken(jwt, installationId, opts?.permissions);
}

/**
 * ensure a GitHub token is available in the environment.
 *
 * when OIDC is available (CI), always mints a fresh token scoped to
 * GITHUB_REPOSITORY — overriding any inherited GITHUB_TOKEN that may
 * be scoped to the wrong repo.
 *
 * otherwise falls back to GitHub App credentials for local development.
 *
 * only called from play.ts (test/dev path) — the live action calls
 * main() directly and never calls this.
 */
export async function ensureGitHubToken(): Promise<void> {
  // when OIDC is available, always mint a fresh token scoped to
  // GITHUB_REPOSITORY. the inherited GITHUB_TOKEN may be scoped to a
  // different repo (e.g., runner token for pullfrog/app when tests
  // target pullfrog/test-repo).
  if (isOIDCAvailable()) {
    const token = await acquireNewToken();
    process.env.GITHUB_TOKEN = token;
    return;
  }

  if (!process.env.GITHUB_TOKEN && !process.env.GH_TOKEN) {
    const token = await acquireNewToken();
    process.env.GITHUB_TOKEN = token;
  }
}

/**
 * retry predicate shared by token mints: 4xx is terminal user state (app not
 * installed, permissions wrong) — retrying just triples our log noise and the
 * user's CI bill (see #693). 5xx/429 and network failures are transient
 * (vercel cold start, github outage, rate limit) and should ride the backoff.
 */
export function isTransientTokenError(error: unknown): boolean {
  if (error instanceof TokenExchangeError) return error.status >= 500 || error.status === 429;
  return (
    error instanceof Error &&
    (error.message.includes("timed out") ||
      error.message.includes("fetch failed") ||
      error.message.includes("ECONNRESET") ||
      error.message.includes("ETIMEDOUT"))
  );
}

export async function acquireNewToken(opts?: AcquireTokenOptions): Promise<string> {
  if (opts?.oidc || isOIDCAvailable()) {
    return await yes.mutation({
      run: () => acquireTokenViaOIDC(opts),
      name: "token exchange",
      retry: (error, attempt) =>
        isTransientTokenError(error) ? yes.delay([1000, 2000], attempt) : -1,
    })();
  }
  // running inside GitHub Actions but the OIDC env vars are absent — the
  // workflow is missing `permissions: id-token: write`. surface an
  // actionable, customer-facing message; the GitHub-App branch below is
  // local-dev only. see #739.
  if (process.env.GITHUB_ACTIONS === "true") {
    throw new Error(
      "missing `permissions: id-token: write` on the Pullfrog workflow job.\n" +
        "\n" +
        "Pullfrog mints short-lived GitHub App installation tokens via OIDC and\n" +
        "requires `id-token: write` to be granted at the job level. add the\n" +
        "following to your workflow yaml:\n" +
        "\n" +
        "  jobs:\n" +
        "    pullfrog:\n" +
        "      permissions:\n" +
        "        id-token: write   # mint Pullfrog installation tokens via OIDC\n" +
        "        contents: read    # for actions/checkout\n" +
        "\n" +
        "see https://docs.pullfrog.com/headless-action#required-permissions for the full template."
    );
  }
  // local development via GitHub App
  return await acquireTokenViaGitHubApp(opts);
}

export interface RepoContext {
  owner: string;
  name: string;
}

/**
 * Parse repository context from GITHUB_REPOSITORY environment variable.
 */
export function parseRepoContext(): RepoContext {
  const githubRepo = process.env.GITHUB_REPOSITORY;
  if (!githubRepo) {
    throw new Error("GITHUB_REPOSITORY environment variable is required");
  }

  const [owner, name] = githubRepo.split("/");
  if (!owner || !name) {
    throw new Error(`Invalid GITHUB_REPOSITORY format: ${githubRepo}. Expected 'owner/repo'`);
  }

  return { owner, name };
}

export type OctokitWithPlugins = InstanceType<
  ReturnType<typeof Octokit.plugin<typeof Octokit, [typeof throttling]>>
>;

export interface ResourceUsage {
  requestCount: number;
  rateLimitRemaining: number | null;
  rateLimitResetMs: number | null;
}

function emptyResourceUsage(): ResourceUsage {
  return {
    requestCount: 0,
    rateLimitRemaining: null,
    rateLimitResetMs: null,
  };
}

const usageByResource: Record<string, ResourceUsage> = {
  core: emptyResourceUsage(),
  graphql: emptyResourceUsage(),
};

export interface UsageSummary {
  version: 1;
  github: {
    core: ResourceUsage;
    graphql: ResourceUsage;
  };
}

function getGitHubUsageSummary(): UsageSummary {
  return {
    version: 1,
    github: {
      core: usageByResource.core,
      graphql: usageByResource.graphql,
    },
  };
}

export async function writeGitHubUsageSummaryToFile(path: string): Promise<void> {
  const summary = getGitHubUsageSummary();
  const tmpPath = join(dirname(path), `.usage-summary-${process.pid}.tmp`);
  await writeFile(tmpPath, JSON.stringify(summary));
  await rename(tmpPath, path);
}

/** longest single throttle sleep we will sit through inside a caller's request. */
const MAX_THROTTLE_WAIT_SECONDS = 30;

export function createOctokit(
  token: string,
  refreshAuth?: (stale: string) => Promise<string>
): OctokitWithPlugins {
  let currentToken = token;
  // `OctokitWithPlugins` initialization based on https://github.com/actions/toolkit/blob/2506e78e82fbd2f9e94d63e75f5309118c8de1b1/packages/github/src/github.ts#L15-L22
  // we can't use it directly because it's stuck on `@octokit/core@v5` and we use the hottest `@octokit/core@v7`
  const OctokitWithPlugins = Octokit.plugin(throttling);
  // auth is applied in the request hook below (not via the `auth` option) so a
  // refreshed token takes effect on the retry and all subsequent requests
  const octokit = new OctokitWithPlugins({
    throttle: {
      // `retryCount <= 2` bounds ATTEMPTS, not duration: an exhausted
      // installation bucket hands back a `retry-after` measured in minutes and
      // the plugin sleeps for all of it, inside whatever tool call is holding
      // the request. that is a silent multi-minute stall no caller can see or
      // attribute (#1154), so cap how long a single wait may be — beyond the
      // cap, failing fast lets the caller's own retry/classification run.
      onRateLimit: (retryAfter, _options, _octokit, retryCount) => {
        return retryCount <= 2 && retryAfter <= MAX_THROTTLE_WAIT_SECONDS;
      },
      onSecondaryRateLimit: (retryAfter, _options, _octokit, retryCount) => {
        return retryCount <= 2 && retryAfter <= MAX_THROTTLE_WAIT_SECONDS;
      },
    },
  });

  const onResponse = (response: OctokitResponseShim) => {
    const resource = response.headers["x-ratelimit-resource"];
    if (!resource) {
      return response;
    }
    usageByResource[resource] ??= emptyResourceUsage();
    const usage = usageByResource[resource];
    usage.requestCount++;
    const remaining = response.headers["x-ratelimit-remaining"];
    const reset = response.headers["x-ratelimit-reset"];
    if (remaining !== undefined) {
      usage.rateLimitRemaining = Number(remaining);
    }
    if (reset !== undefined) {
      usage.rateLimitResetMs = Number(reset) * 1000;
    }
    return response;
  };

  octokit.hook.wrap("request", async (request, options) => {
    const sentToken = currentToken;
    options.headers.authorization = `token ${sentToken}`;
    try {
      const response = await request(options);
      onResponse(response);
      return response;
    } catch (error) {
      if (
        isObject(error) &&
        "response" in error &&
        isObject(error.response) &&
        "headers" in error.response &&
        isObject(error.response.headers)
      ) {
        onResponse(error.response as OctokitResponseShim);
      }
      // GitHub can invalidate an installation token mid-run (#891): re-acquire
      // once and retry. passing the token this request was sent with lets the
      // refresher hand back an already-minted replacement instead of minting
      // again. if the refresh itself fails, that (actionable) error surfaces
      // instead of the raw 401.
      if (refreshAuth && isObject(error) && "status" in error && error.status === 401) {
        currentToken = await refreshAuth(sentToken);
        options.headers.authorization = `token ${currentToken}`;
        const response = await request(options);
        onResponse(response);
        return response;
      }
      throw error;
    }
  });

  return octokit;
}
