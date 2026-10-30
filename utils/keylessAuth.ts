/**
 * Keyless auth: a run trades its GitHub OIDC token for a short-lived Anthropic
 * or OpenAI token (workload identity federation) instead of reading a stored key.
 *
 * Neither token outlives a run (Anthropic's lasts twice the JWT's remaining life,
 * about 10 minutes; OpenAI's never outlives the JWT), and codex and opencode read
 * their key once at spawn. So each keyless provider gets a localhost gateway
 * behind its `<PROVIDER>_BASE_URL`, which swaps a per-run placeholder key for a
 * token it re-exchanges before expiry. See wiki/keyless-auth.md.
 */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import * as yes from "yes";
import { z } from "zod";
import { getModelProvider, KEYLESS_AUTH_ENV } from "../models.ts";
import { log } from "./cli.ts";
import { fetchIdTokenFromStash, isTransientTokenError, type OidcCredentials } from "./github.ts";
import { maskSecret } from "./secretCommands.ts";

type KeylessConfig = {
  provider: string;
  name: string;
  /** the `aud` the GitHub JWT is minted for; the provider's rule must match it. */
  audience: string;
  upstream: string;
  tokenUrl: string;
  exchangeBody: (jwt: string) => Record<string, string>;
  keyEnv: string;
  baseUrlEnv: string;
  /** appended to the gateway origin to match the base-URL convention of `baseUrlEnv`. */
  baseUrlPath: string;
  /** credentials a harness would rank above the placeholder key. */
  displacedEnv: string[];
};

function read(name: string) {
  return process.env[name]?.trim() || undefined;
}

function anthropicConfig(): KeylessConfig {
  const ids: Record<string, string> = {
    federation_rule_id: read("ANTHROPIC_FEDERATION_RULE_ID") ?? "",
    organization_id: read("ANTHROPIC_ORGANIZATION_ID") ?? "",
    service_account_id: read("ANTHROPIC_SERVICE_ACCOUNT_ID") ?? "",
  };
  const workspace = read("ANTHROPIC_WORKSPACE_ID");
  if (workspace) ids.workspace_id = workspace;
  return {
    provider: "anthropic",
    name: "Anthropic",
    audience: KEYLESS_AUTH_ENV.anthropic.audience,
    upstream: "https://api.anthropic.com",
    tokenUrl: "https://api.anthropic.com/v1/oauth/token",
    exchangeBody: (jwt) => ({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
      ...ids,
    }),
    keyEnv: "ANTHROPIC_API_KEY",
    // claude-code and the SDKs append /v1 to ANTHROPIC_BASE_URL themselves
    baseUrlEnv: "ANTHROPIC_BASE_URL",
    baseUrlPath: "",
    // claude-code ranks both above ANTHROPIC_API_KEY
    displacedEnv: ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
  };
}

function openAIConfig(): KeylessConfig {
  const ids = {
    identity_provider_id: read("OPENAI_IDENTITY_PROVIDER_ID") ?? "",
    service_account_id: read("OPENAI_SERVICE_ACCOUNT_ID") ?? "",
  };
  return {
    provider: "openai",
    name: "OpenAI",
    audience: read("OPENAI_WIF_AUDIENCE") ?? KEYLESS_AUTH_ENV.openai.audience,
    upstream: "https://api.openai.com",
    tokenUrl: "https://auth.openai.com/oauth/token",
    exchangeBody: (jwt) => ({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      subject_token: jwt,
      ...ids,
    }),
    keyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    baseUrlPath: "/v1",
    // a ChatGPT subscription outranks OPENAI_API_KEY in both codex and opencode
    displacedEnv: ["CODEX_AUTH_JSON"],
  };
}

const CONFIGS: Record<string, () => KeylessConfig> = {
  anthropic: anthropicConfig,
  openai: openAIConfig,
};

/** a provider counts as keyless once any of its IDs is set, so a partial set is reported, not ignored. */
function readConfigs() {
  const configs: { config: KeylessConfig; missing: string[] }[] = [];
  for (const [provider, env] of Object.entries(KEYLESS_AUTH_ENV)) {
    const config = CONFIGS[provider];
    if (!config || !env.required.some((name) => read(name))) continue;
    configs.push({ config: config(), missing: env.required.filter((name) => !read(name)) });
  }
  return configs;
}

/** status-bearing, so a rejected rule (4xx) can be told from an outage. */
class KeylessExchangeError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status: number | undefined) {
    super(message);
    this.status = status;
  }
}

function isTransient(error: unknown) {
  if (!(error instanceof KeylessExchangeError)) return isTransientTokenError(error);
  return error.status === undefined || error.status >= 500 || error.status === 429;
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive().default(300),
});

/** refresh this long before expiry, or at half-life for a shorter token. */
const REFRESH_MARGIN_MS = 120_000;
/** past a failed refresh, the old token is served until this close to expiry. */
const EXPIRY_SAFETY_MS = 30_000;

type TokenSource = { get: () => Promise<string> };

function createTokenSource(input: { config: KeylessConfig; oidc: OidcCredentials }): TokenSource {
  const config = input.config;
  let cached: { token: string; refreshAt: number; expiresAt: number } | undefined;
  let inflight: Promise<string> | undefined;

  const exchange = yes.mutation({
    name: `${config.provider} keyless exchange`,
    // a fresh JWT on every attempt: Anthropic refuses a reused `jti`
    run: async () => {
      const jwt = await fetchIdTokenFromStash(input.oidc, config.audience);
      const response = await fetch(config.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(config.exchangeBody(jwt)),
        signal: AbortSignal.timeout(30_000),
      }).catch((error: unknown) => {
        throw new KeylessExchangeError(messageOf(error), undefined);
      });
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 500);
        throw new KeylessExchangeError(
          `${response.status} ${detail || response.statusText}`,
          response.status
        );
      }
      const body = tokenResponseSchema.parse(await response.json());
      maskSecret(body.access_token);
      const lifetimeMs = body.expires_in * 1000;
      const issuedAt = Date.now();
      cached = {
        token: body.access_token,
        refreshAt: issuedAt + lifetimeMs - Math.min(REFRESH_MARGIN_MS, lifetimeMs / 2),
        expiresAt: issuedAt + lifetimeMs,
      };
      return body.access_token;
    },
    retry: (error, attempt) => (isTransient(error) ? yes.backoff([1000, 2000], attempt) : -1),
  });

  return {
    get: () => {
      if (cached && Date.now() < cached.refreshAt) return Promise.resolve(cached.token);
      // concurrent requests during a refresh share one exchange
      if (!inflight) {
        inflight = exchange().finally(() => {
          inflight = undefined;
        });
        // a background refresh may have no caller awaiting it, so its failure is handled here
        if (cached) {
          inflight.catch((error: unknown) => {
            log.warning(`» ${config.name} keyless refresh failed: ${messageOf(error)}`);
          });
        }
      }
      // the refresh runs ahead of expiry, so a slow or failing token endpoint need not stall live calls
      if (cached && Date.now() < cached.expiresAt - EXPIRY_SAFETY_MS) {
        return Promise.resolve(cached.token);
      }
      return inflight;
    },
  };
}

/** hop-by-hop, recomputed by fetch, or the credential being swapped. */
const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "upgrade",
  "proxy-authorization",
  // fetch would decompress transparently, so ask upstream for identity bytes
  "accept-encoding",
  "x-api-key",
  "authorization",
]);

const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "content-encoding",
]);

function presentedKey(req: IncomingMessage) {
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string") return apiKey;
  const auth = req.headers.authorization;
  return auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7) : undefined;
}

function sendError(input: { res: ServerResponse; status: number; message: string }) {
  if (input.res.headersSent) {
    input.res.destroy();
    return;
  }
  input.res.writeHead(input.status, { "content-type": "application/json" });
  // Anthropic's error envelope; OpenAI clients read `error.message` from it too
  input.res.end(
    JSON.stringify({ type: "error", error: { type: "api_error", message: input.message } })
  );
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

type Gateway = { url: string; close: () => Promise<void> };

async function forward(input: {
  config: KeylessConfig;
  tokens: TokenSource;
  req: IncomingMessage;
  res: ServerResponse;
}) {
  const req = input.req;
  const res = input.res;
  // a protocol-relative or absolute-form target would carry the token to another host
  const target = new URL(req.url ?? "/", input.config.upstream);
  if (target.origin !== input.config.upstream) {
    sendError({ res, status: 400, message: "Pullfrog keyless auth: foreign request target" });
    return;
  }
  const token = await input.tokens.get().catch((error: unknown) => {
    log.warning(`» ${input.config.name} keyless auth: ${messageOf(error)}`);
    sendError({ res, status: 502, message: `Pullfrog keyless auth: ${messageOf(error)}` });
    return null;
  });
  if (token === null) return;

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || DROPPED_REQUEST_HEADERS.has(name)) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  headers.set("authorization", `Bearer ${token}`);

  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) abort.abort();
  });
  const method = req.method ?? "GET";
  const body = method === "GET" || method === "HEAD" ? null : await readBody(req);
  const upstream = await fetch(target, {
    method,
    headers,
    body,
    redirect: "manual",
    signal: abort.signal,
  }).catch((error: unknown) => {
    if (!abort.signal.aborted) {
      sendError({ res, status: 502, message: `Pullfrog keyless auth: ${messageOf(error)}` });
    }
    return null;
  });
  if (!upstream) return;

  const responseHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, name) => {
    if (!DROPPED_RESPONSE_HEADERS.has(name)) responseHeaders[name] = value;
  });
  res.writeHead(upstream.status, responseHeaders);
  if (!upstream.body) {
    res.end();
    return;
  }
  // streamed, so SSE reaches the agent as it arrives. pipe() does not forward a source
  // error, and an upstream dying mid-stream would otherwise hang the agent to its timeout
  Readable.fromWeb(upstream.body)
    .on("error", () => res.destroy())
    .pipe(res);
}

async function startGateway(input: {
  config: KeylessConfig;
  tokens: TokenSource;
  /** the placeholder the agent presents; anything else is refused. */
  clientKey: string;
}): Promise<Gateway> {
  const server = createServer((req, res) => {
    // localhost is reachable from the agent's own shell too: the placeholder is what gates it
    if (presentedKey(req) !== input.clientKey) {
      sendError({ res, status: 401, message: "Pullfrog keyless auth: unrecognized credential" });
      return;
    }
    // a client dropping mid-body rejects readBody; unhandled, that would end the run
    forward({ config: input.config, tokens: input.tokens, req, res }).catch((error: unknown) => {
      sendError({ res, status: 502, message: `Pullfrog keyless auth: ${messageOf(error)}` });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("keyless gateway failed to bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

type KeylessRejection = { provider: string; name: string; reason: string };

/** why a provider's keyless auth could not pay, kept so a run left with nothing else can say so. */
const rejections: KeylessRejection[] = [];

/** the keyless failure behind a missing credential: the model's provider's, or with no model the first. */
export function keylessRejection(model: string | undefined) {
  const provider = model ? getModelProvider(model) : rejections[0]?.provider;
  return rejections.find((rejection) => rejection.provider === provider);
}

/** one provider's gateway, or null when its exchange was refused and the next credential should pay. */
async function startProvider(input: {
  config: KeylessConfig;
  missing: string[];
  oidc: OidcCredentials | null;
}): Promise<Gateway | null> {
  const config = input.config;
  // like a wrong ID, a missing one is the provider's alone to fail: other providers' runs go on
  const reject = (reason: string) => {
    rejections.push({ provider: config.provider, name: config.name, reason });
    log.warning(`» ${config.name} keyless auth unavailable, trying the next credential: ${reason}`);
    return null;
  };
  if (input.missing.length > 0) return reject(`missing ${input.missing.join(", ")}`);
  if (read(config.baseUrlEnv)) {
    return reject(
      `${config.baseUrlEnv} is set too, and keyless auth talks to ${config.upstream} directly`
    );
  }
  if (!input.oidc) return reject("this run has no GitHub OIDC token (`id-token: write`)");
  const tokens = createTokenSource({ config, oidc: input.oidc });
  const failure = await tokens.get().then(
    () => null,
    (error: unknown) => error
  );
  if (failure && !isTransient(failure)) return reject(messageOf(failure));
  // an outage keeps keyless in place, so it neither changes who pays nor fails a
  // run on another provider: the first request re-exchanges, and its 502 fails the run
  if (failure)
    log.warning(
      `» ${config.name} keyless exchange failed, retrying on first use: ${messageOf(failure)}`
    );

  const clientKey = `pullfrog-keyless-${randomBytes(24).toString("hex")}`;
  maskSecret(clientKey);
  const gateway = await startGateway({ config, tokens, clientKey });
  for (const name of config.displacedEnv) delete process.env[name];
  process.env[config.keyEnv] = clientKey;
  process.env[config.baseUrlEnv] = `${gateway.url}${config.baseUrlPath}`;
  log.info(`» ${config.name}: keyless auth (OIDC)`);
  return gateway;
}

/** the subscriptions keyless auth displaced, which the credential pool must not load back. */
export type KeylessAuth = { suppressed: string[]; [Symbol.asyncDispose]: () => Promise<void> };

/**
 * Starts keyless auth for every provider whose IDs are set. It is the first
 * credential tried: a refused exchange or an incomplete setup falls through to
 * the provider's subscriptions and keys, as a rejected subscription does, while
 * an outage keeps keyless in place rather than silently changing who pays. Runs
 * after the stored secrets are injected, so stored IDs count, and before the
 * credential pool loads.
 */
export async function startKeylessAuth(ctx: {
  oidc: OidcCredentials | null;
}): Promise<KeylessAuth> {
  const gateways: Gateway[] = [];
  const auth: KeylessAuth = {
    suppressed: [],
    [Symbol.asyncDispose]: async () => {
      await Promise.all(gateways.map((gateway) => gateway.close()));
    },
  };
  try {
    for (const entry of readConfigs()) {
      const gateway = await startProvider({ ...entry, oidc: ctx.oidc });
      if (!gateway) continue;
      gateways.push(gateway);
      auth.suppressed.push(...entry.config.displacedEnv);
    }
  } catch (error) {
    // an earlier provider's open gateway would keep the process alive
    await auth[Symbol.asyncDispose]();
    throw error;
  }
  return auth;
}
