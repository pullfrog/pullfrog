import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatApiKeyErrorSummary, isApiKeyAuthError, validateAgentApiKey } from "./apiKeys.ts";

const savedEnv = { ...process.env };

const ENV_KEYS_TO_STRIP = [
  /_API_KEY$/,
  /^CLAUDE_CODE_OAUTH_TOKEN$/,
  /^CODEX_AUTH_JSON$/,
  /^AWS_BEARER_TOKEN_BEDROCK$/,
  /^AWS_ACCESS_KEY_ID$/,
  /^AWS_SECRET_ACCESS_KEY$/,
  /^AWS_SESSION_TOKEN$/,
  /^AWS_REGION$/,
  /^BEDROCK_MODEL_ID$/,
  /^GOOGLE_APPLICATION_CREDENTIALS$/,
  /^GOOGLE_CLOUD_PROJECT$/,
  /^VERTEX_SERVICE_ACCOUNT_JSON$/,
  /^VERTEX_LOCATION$/,
  /^VERTEX_MODEL_ID$/,
];

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (ENV_KEYS_TO_STRIP.some((re) => re.test(key))) delete process.env[key];
  }
});

afterEach(() => {
  process.env = { ...savedEnv };
});

const opencode = { name: "opencode" };
const claude = { name: "claude" };
const owner = "test-owner";
const name = "test-repo";

describe("validateAgentApiKey — opencode", () => {
  it("passes when the resolved model is in the authorized set", () => {
    expect(() =>
      validateAgentApiKey({
        agent: opencode,
        model: "anthropic/claude-opus-4-7",
        authorized: new Set(["anthropic/claude-opus-4-7"]),
        owner,
        name,
      })
    ).not.toThrow();
  });

  it("throws when the resolved model is absent from the authorized set", () => {
    expect(() =>
      validateAgentApiKey({
        agent: opencode,
        model: "anthropic/claude-opus-4-7",
        authorized: new Set(),
        owner,
        name,
      })
    ).toThrow("no API key found");
  });

  // `opencode models` can exit 0 having printed only an alphabetical prefix of
  // its catalog, so an absent entry proves nothing about the key. production
  // runs on one repo passed at 216 entries and failed at 197 purely on where
  // the configured slug sorted against the cut.
  it("passes when a truncated catalog omits the model but its env var is set", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
    expect(() =>
      validateAgentApiKey({
        agent: opencode,
        model: "openrouter/openai/gpt-6.1-sol",
        authorized: new Set([
          "openrouter/anthropic/claude-opus-5",
          "openrouter/google/gemma-3-12b",
        ]),
        owner,
        name,
      })
    ).not.toThrow();
  });

  it("still throws when a truncated catalog omits the model and the env var is unset", () => {
    expect(() =>
      validateAgentApiKey({
        agent: opencode,
        model: "openrouter/openai/gpt-6.1-sol",
        authorized: new Set(["openrouter/anthropic/claude-opus-5"]),
        owner,
        name,
      })
    ).toThrow("no API key found");
  });

  it("blames the fetch, not the user, when stored secrets were unreadable", () => {
    expect(() =>
      validateAgentApiKey({
        agent: opencode,
        model: "openrouter/openai/gpt-6.1-sol",
        authorized: new Set(),
        owner,
        name,
        secretsUnavailable: true,
      })
    ).toThrow("couldn't load your Pullfrog secrets");
  });

  it("passes the auto-select path when an authorized model's key is present", () => {
    process.env.OPENCODE_API_KEY = "sk-test";
    expect(() =>
      validateAgentApiKey({
        agent: opencode,
        model: undefined,
        authorized: new Set(["opencode/big-pickle"]),
        owner,
        name,
      })
    ).not.toThrow();
  });

  // opencode lists Zen's free models with no key at all, so a non-empty catalog
  // used to wave through runs that had nothing to authenticate with — they then
  // died at the provider on a bare `Missing Authentication header`.
  it("throws the auto-select path when the catalog is non-empty but unauthenticated", () => {
    expect(() =>
      validateAgentApiKey({
        agent: opencode,
        model: undefined,
        authorized: new Set(["opencode/big-pickle"]),
        owner,
        name,
      })
    ).toThrow("no API key found");
  });

  // `openai` is the one provider whose credential can live in
  // `managedCredentials`, so a `pullfrog auth codex` run has no OPENAI_API_KEY
  // and must not read as unservable.
  it("counts a managed credential as auth on the auto-select path", () => {
    process.env.CODEX_AUTH_JSON = '{"tokens":{}}';
    expect(() =>
      validateAgentApiKey({
        agent: opencode,
        model: undefined,
        authorized: new Set(["openai/gpt-6.1-sol"]),
        owner,
        name,
      })
    ).not.toThrow();
  });

  it("surfaces the Router-unfunded copy on the auto-select path", () => {
    expect(() =>
      validateAgentApiKey({
        agent: opencode,
        model: undefined,
        authorized: new Set(["opencode/big-pickle"]),
        owner,
        name,
        routerUnfunded: true,
      })
    ).toThrow("your Pullfrog Router balance is empty");
  });

  it("throws the auto-select path when the authorized set is empty", () => {
    expect(() =>
      validateAgentApiKey({
        agent: opencode,
        model: undefined,
        authorized: new Set(),
        owner,
        name,
      })
    ).toThrow("no API key found");
  });
});

describe("validateAgentApiKey — claude (static Anthropic check)", () => {
  it("passes when ANTHROPIC_API_KEY is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect(() =>
      validateAgentApiKey({
        agent: claude,
        model: "anthropic/claude-opus-4-7",
        authorized: new Set(),
        owner,
        name,
      })
    ).not.toThrow();
  });

  it("passes when CLAUDE_CODE_OAUTH_TOKEN is set", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-test";
    expect(() =>
      validateAgentApiKey({
        agent: claude,
        model: "anthropic/claude-opus-4-7",
        authorized: new Set(),
        owner,
        name,
      })
    ).not.toThrow();
  });

  it("throws when neither Anthropic credential is set", () => {
    expect(() =>
      validateAgentApiKey({
        agent: claude,
        model: "anthropic/claude-opus-4-7",
        authorized: new Set(),
        owner,
        name,
      })
    ).toThrow("no API key found");
  });
});

describe("validateAgentApiKey — Bedrock routing", () => {
  const params = { agent: opencode, authorized: new Set<string>(), owner, name };

  it("passes with AWS_BEARER_TOKEN_BEDROCK + AWS_REGION + BEDROCK_MODEL_ID", () => {
    process.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-token";
    process.env.AWS_REGION = "us-east-1";
    process.env.BEDROCK_MODEL_ID = "us.anthropic.claude-opus-4-7";
    expect(() => validateAgentApiKey({ ...params, model: "bedrock/byok" })).not.toThrow();
  });

  it("passes with AWS access keys + region + model id", () => {
    process.env.AWS_ACCESS_KEY_ID = "AKIA-test";
    process.env.AWS_SECRET_ACCESS_KEY = "secret-test";
    process.env.AWS_REGION = "us-east-1";
    process.env.BEDROCK_MODEL_ID = "amazon.nova-pro-v1:0";
    expect(() => validateAgentApiKey({ ...params, model: "bedrock/byok" })).not.toThrow();
  });

  it("throws when BEDROCK_MODEL_ID is missing", () => {
    process.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-token";
    process.env.AWS_REGION = "us-east-1";
    expect(() => validateAgentApiKey({ ...params, model: "bedrock/byok" })).toThrow(
      "BEDROCK_MODEL_ID"
    );
  });

  // regression: main.ts passes the post-resolveModel value into
  // validateAgentApiKey, which for Bedrock is the raw AWS model ID (no `/`).
  it("accepts a raw Bedrock model ID without throwing", () => {
    process.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-token";
    process.env.AWS_REGION = "us-east-1";
    process.env.BEDROCK_MODEL_ID = "us.anthropic.claude-opus-4-6-v1";
    expect(() =>
      validateAgentApiKey({ ...params, model: "us.anthropic.claude-opus-4-6-v1" })
    ).not.toThrow();
  });

  it("throws on raw Bedrock model ID when AWS auth is missing", () => {
    process.env.AWS_REGION = "us-east-1";
    process.env.BEDROCK_MODEL_ID = "us.anthropic.claude-opus-4-6-v1";
    expect(() =>
      validateAgentApiKey({ ...params, model: "us.anthropic.claude-opus-4-6-v1" })
    ).toThrow("AWS_BEARER_TOKEN_BEDROCK");
  });
});

describe("validateAgentApiKey — Vertex routing", () => {
  const params = { agent: opencode, authorized: new Set<string>(), owner, name };

  it("passes with service-account JSON + project + location + model id", () => {
    process.env.VERTEX_SERVICE_ACCOUNT_JSON = "{}";
    process.env.GOOGLE_CLOUD_PROJECT = "test-project";
    process.env.VERTEX_LOCATION = "us-east5";
    process.env.VERTEX_MODEL_ID = "claude-opus-4-1@20250805";
    expect(() => validateAgentApiKey({ ...params, model: "vertex/byok" })).not.toThrow();
  });

  it("throws when VERTEX_MODEL_ID is missing", () => {
    process.env.VERTEX_SERVICE_ACCOUNT_JSON = "{}";
    process.env.GOOGLE_CLOUD_PROJECT = "test-project";
    process.env.VERTEX_LOCATION = "us-east5";
    expect(() => validateAgentApiKey({ ...params, model: "vertex/byok" })).toThrow(
      "VERTEX_MODEL_ID"
    );
  });

  it("accepts a raw Vertex model ID without throwing", () => {
    process.env.VERTEX_SERVICE_ACCOUNT_JSON = "{}";
    process.env.GOOGLE_CLOUD_PROJECT = "test-project";
    process.env.VERTEX_LOCATION = "us-east5";
    process.env.VERTEX_MODEL_ID = "gemini-2.5-pro";
    expect(() => validateAgentApiKey({ ...params, model: "gemini-2.5-pro" })).not.toThrow();
  });

  it("throws on raw Vertex model ID when auth is missing", () => {
    process.env.GOOGLE_CLOUD_PROJECT = "test-project";
    process.env.VERTEX_LOCATION = "us-east5";
    process.env.VERTEX_MODEL_ID = "gemini-2.5-pro";
    expect(() => validateAgentApiKey({ ...params, model: "gemini-2.5-pro" })).toThrow(
      "VERTEX_SERVICE_ACCOUNT_JSON"
    );
  });
});

describe("isApiKeyAuthError", () => {
  it("matches the missing-key marker thrown by validateAgentApiKey", () => {
    expect(isApiKeyAuthError("no API key found. Pullfrog needs ...")).toBe(true);
  });

  it("matches Claude CLI 401 strings", () => {
    expect(isApiKeyAuthError("Invalid API key · Fix external API key")).toBe(true);
  });

  it("matches OpenAI / OpenRouter 401 phrasings", () => {
    expect(isApiKeyAuthError("ProviderAuthError: User not found")).toBe(true);
    expect(isApiKeyAuthError("401 Invalid authentication")).toBe(true);
  });

  // see #782 — direct-Anthropic 401 shape (revoked / mistyped / rotated
  // ANTHROPIC_API_KEY) reaches us via Claude CLI as a JSON dump, not as
  // any of the canonical "Invalid API key" strings.
  it("matches direct-Anthropic 401 shapes", () => {
    expect(
      isApiKeyAuthError(
        'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"}}'
      )
    ).toBe(true);
    expect(
      isApiKeyAuthError(
        "» Pullfrog result error: subtype=success, api_error_status=401, message=Failed to authenticate."
      )
    ).toBe(true);
  });

  // see #931 — expired-credential shapes observed in production: Bedrock
  // short-lived bearer token (403, not 401), OpenAI OAuth expiry, and the
  // Codex refresh chain failing with a bare 401.
  it("matches expired-credential shapes", () => {
    expect(
      isApiKeyAuthError(
        '##[error]action failed: Failed to authenticate. API Error: 403 {"Message":"*** has expired"}'
      )
    ).toBe(true);
    expect(
      isApiKeyAuthError(
        "» Pullfrog session error: Your authentication token has expired. Please try signing in again."
      )
    ).toBe(true);
    expect(isApiKeyAuthError("» Pullfrog session error: Token refresh failed: 401")).toBe(true);
    // #1041 server-side revocation ("been invalidated", not "expired")
    expect(
      isApiKeyAuthError(
        "provider error: Your authentication token has been invalidated. Please try signing in again."
      )
    ).toBe(true);
    // #1474 the reversed word order
    expect(
      isApiKeyAuthError(
        "provider error: Encountered invalidated oauth token for user, failing request"
      )
    ).toBe(true);
    // #1162 the value is unsendable, not wrong — a line-wrapped paste
    expect(isApiKeyAuthError("API Error: Header '14' has invalid value: '***'")).toBe(true);
    // #1180 OpenAI writes the copula as "is", not "has"
    expect(
      isApiKeyAuthError("» Pullfrog session error: Provided authentication token is expired.")
    ).toBe(true);
    // #1072 org-level entitlement denial carries no 401 and no auth keyword
    expect(
      isApiKeyAuthError(
        "Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access"
      )
    ).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isApiKeyAuthError("git fetch failed")).toBe(false);
    expect(isApiKeyAuthError("")).toBe(false);
    // GitHub-side token expiry is not an LLM key problem
    expect(isApiKeyAuthError("This installation access token has expired.")).toBe(false);
    // generic auth chatter (e.g. a customer test suite in agent stderr) must
    // not match — only the Claude CLI "Failed to authenticate. API Error:" shape
    expect(isApiKeyAuthError("Failed to authenticate with internal-service")).toBe(false);
  });
});

describe("formatApiKeyErrorSummary", () => {
  it("renders the missing-key body when the raw error contains the marker", () => {
    const msg = formatApiKeyErrorSummary({
      owner: "acme",
      name: "repo",
      raw: "no API key found in this run",
    });
    expect(msg).toContain("no API key found");
    expect(msg).toContain("https://github.com/acme/repo/settings/secrets/actions");
    expect(msg).toContain("/console/acme/repo");
    expect(msg).toContain("https://discord.gg/8y96raFg8e");
  });

  it("renders the invalid-key body for any other auth error", () => {
    const msg = formatApiKeyErrorSummary({
      owner: "acme",
      name: "repo",
      raw: "Invalid API key · Fix external API key",
    });
    expect(msg).toContain("rejected");
    expect(msg).toContain("https://github.com/acme/repo/settings/secrets/actions");
    // the key may live in Pullfrog's store instead, and only one of the two CTAs
    // can be right — so both have to be offered. assert the LABEL: the sibling
    // `Model settings` link is `/console/acme/repo`, so a bare `/console/acme`
    // substring passes against copy that never gained the store link at all.
    expect(msg).toContain("[Pullfrog secrets →](");
    expect(msg).toContain("https://discord.gg/8y96raFg8e");
  });

  // see #931 — OAuth-connection credentials aren't repo secrets, so the
  // rotate-the-secret copy is wrong advice for these shapes.
  it("renders re-authenticate copy for expired OAuth credentials", () => {
    const msg = formatApiKeyErrorSummary({
      owner: "acme",
      name: "repo",
      raw: "» Pullfrog session error: Token refresh failed: 401",
    });
    expect(msg).toContain("OAuth credential has expired");
    expect(msg).toContain("pullfrog auth");
    expect(msg).not.toContain("settings/secrets/actions");
    // #1072 — this shape rendered the rotate-your-repo-secret copy before
    const claudeCli = formatApiKeyErrorSummary({
      owner: "acme",
      name: "repo",
      raw: "Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.",
    });
    expect(claudeCli).toContain("OAuth credential has expired");
    expect(claudeCli).not.toContain("settings/secrets/actions");
  });

  // see #1072 — an org admin disabled Claude Code access; re-authenticating
  // can't clear an entitlement flag, so this shape gets its own remedy.
  it("renders org-disabled subscription copy instead of the re-auth CTA", () => {
    const msg = formatApiKeyErrorSummary({
      owner: "acme",
      name: "repo",
      raw: "Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access",
    });
    expect(msg).toContain("disabled Claude subscription access");
    expect(msg).toContain("ANTHROPIC_API_KEY");
    expect(msg).not.toContain("OAuth credential has expired");
    expect(msg).not.toContain("was rejected");
  });
});
