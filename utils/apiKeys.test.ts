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
  /^OPENAI_COMPATIBLE_BASE_URL$/,
  /^OPENAI_COMPATIBLE_MODEL_ID$/,
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

  it("passes the auto-select path when the authorized set is non-empty", () => {
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

describe("validateAgentApiKey — OpenAI-compatible routing", () => {
  const params = { agent: opencode, authorized: new Set<string>(), owner, name };
  const setup = () => {
    process.env.OPENAI_COMPATIBLE_API_KEY = "openai-compatible-test-key";
    process.env.OPENAI_COMPATIBLE_BASE_URL = "https://gateway.example.com/v1";
    process.env.OPENAI_COMPATIBLE_MODEL_ID = "azure/gpt-5.6-production";
  };

  it("passes for the routing slug when all OpenAI-compatible configuration is present", () => {
    setup();
    expect(() =>
      validateAgentApiKey({ ...params, model: "openai-compatible/byok" })
    ).not.toThrow();
  });

  it.each(["OPENAI_COMPATIBLE_API_KEY", "OPENAI_COMPATIBLE_BASE_URL", "OPENAI_COMPATIBLE_MODEL_ID"])(
    "requires %s for the routing slug",
    (missing) => {
      setup();
      delete process.env[missing];
      expect(() => validateAgentApiKey({ ...params, model: "openai-compatible/byok" })).toThrow(
        missing
      );
    }
  );

  it.each(["OPENAI_COMPATIBLE_API_KEY", "OPENAI_COMPATIBLE_BASE_URL"])(
    "requires %s for the resolved OpenAI-compatible model",
    (missing) => {
      setup();
      delete process.env[missing];
      expect(() =>
        validateAgentApiKey({ ...params, model: "openai-compatible/azure/gpt-5.6-production" })
      ).toThrow(missing);
    }
  );
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
  });
});
