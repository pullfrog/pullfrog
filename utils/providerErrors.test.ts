import {
  detectProviderError,
  extractProviderId,
  findAnthropicSpendCap,
  findProviderErrorMatch,
  isProviderBillingExhausted,
  isProviderUsageLimit,
  isRouterKeylimitExhaustedError,
  isTransientUpstreamError,
} from "./providerErrors.ts";

describe("detectProviderError", () => {
  describe("false positives previously seen in production", () => {
    it("returns null for commit SHAs containing 429", () => {
      expect(detectProviderError("hash=7a46d89f505b36df49b4f54429daffa1a9459b11")).toBeNull();
      expect(detectProviderError("commit f609cc89e84596ab125d60dac568bfb2ef398396 429")).toBeNull();
    });

    it("classifies 401 + x-ratelimit-* headers as auth, not rate-limited", () => {
      // OpenRouter 401 responses bundle `x-ratelimit-*` rate-limit headers
      // alongside the auth error. the auth patterns must win — pre-fix this
      // got tagged as `rate limited` because of the loose `\brate[_ ]limit`
      // match against header names like `ratelimit-limit-requests`. note: in
      // OpenRouter's actual format the header name is `ratelimit` (one word),
      // but the dumped JSON sometimes contains `rate-limit` separators too.
      const stderr = JSON.stringify({
        error: { name: "APIError", statusCode: 401, message: "Invalid authentication credentials" },
        headers: {
          "x-ratelimit-limit-requests": 50,
          "x-ratelimit-remaining-requests": 49,
          "x-ratelimit-reset-tokens": "2025-01-01T00:00:00Z",
        },
      });
      expect(detectProviderError(stderr)).toBe("auth error (401)");
    });

    it("returns null for INTERNAL_SERVER_ERROR substring", () => {
      expect(detectProviderError("HTTP/1.1 500 INTERNAL_SERVER_ERROR")).toBeNull();
      expect(detectProviderError("expected: not INTERNAL_SERVER_ERROR")).toBeNull();
    });

    it("returns null for INTERNALS substring", () => {
      expect(detectProviderError("debugging INTERNALS of the parser")).toBeNull();
    });
  });

  describe("auth errors", () => {
    it("detects 401 / 403 status codes as auth errors", () => {
      expect(detectProviderError('{"statusCode": 401}')).toBe("auth error (401)");
      expect(detectProviderError('{"statusCode": 403}')).toBe("auth error (403)");
      expect(detectProviderError("status_code: 401")).toBe("auth error (401)");
    });

    it("detects OpenRouter 'User not found' (disabled/invalid key)", () => {
      // bare `"code":401` lacks a status-key prefix so the 401 status pattern
      // intentionally doesn't fire; the User-not-found pattern catches it.
      expect(detectProviderError('{"error":{"message":"User not found","code":401}}')).toBe(
        "auth error (invalid/disabled key)"
      );
      expect(detectProviderError("APIError: User not found.")).toBe(
        "auth error (invalid/disabled key)"
      );
    });

    it("detects 'Invalid authentication' phrasing", () => {
      expect(detectProviderError("Invalid authentication credentials")).toBe(
        "auth error (invalid credentials)"
      );
    });

    it("detects 'No auth credentials found' phrasing", () => {
      expect(detectProviderError("AI_APICallError: No auth credentials found")).toBe(
        "auth error (missing credentials)"
      );
    });
  });

  describe("billing exhaustion", () => {
    // see #778 — providers return 401 / 429 for billing/quota exhaustion
    // (OpenCode Zen `CreditsError` / `FreeUsageLimitError`, Gemini
    // `RESOURCE_EXHAUSTED` + spending cap, "Insufficient balance"). these
    // are non-retryable; status-code patterns must NOT win and surface the
    // misleading "auth error (401)" / "rate limited (429)" labels.
    it("classifies OpenCode Zen CreditsError as billing exhausted, not 401", () => {
      const stderr = JSON.stringify({
        statusCode: 401,
        responseBody:
          '{"type":"error","error":{"type":"CreditsError","message":"Insufficient balance. Manage your billing here: https://opencode.ai/workspace/x/billing"}}',
      });
      expect(detectProviderError(stderr)).toBe("provider billing exhausted");
    });

    it("classifies OpenCode Zen FreeUsageLimitError as billing exhausted, not 429", () => {
      const stderr = JSON.stringify({
        statusCode: 429,
        responseBody:
          '{"type":"error","error":{"type":"FreeUsageLimitError","message":"Rate limit exceeded. Please try again later."}}',
      });
      expect(detectProviderError(stderr)).toBe("provider billing exhausted");
    });

    it("classifies Gemini spending-cap RESOURCE_EXHAUSTED as billing exhausted, not 429", () => {
      const stderr =
        'statusCode: 429, body: {"code": 429, "status": "RESOURCE_EXHAUSTED", "message": "Your project has exceeded its monthly spending cap..."}';
      expect(detectProviderError(stderr)).toBe("provider billing exhausted");
    });

    it("classifies bare 'Insufficient balance' as billing exhausted", () => {
      expect(detectProviderError("error: Insufficient balance")).toBe("provider billing exhausted");
    });

    it("classifies Anthropic 'credit balance is too low' as billing exhausted (#835)", () => {
      // Anthropic-direct BYOK returns this string verbatim when the user's
      // Anthropic console credit balance can't cover the request. distinct
      // wording from "Insufficient balance" used by DeepSeek / OpenCode Zen.
      const stderr =
        "APIError: 400 Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";
      expect(detectProviderError(stderr)).toBe("provider billing exhausted");
    });

    it("classifies Gemini's free-tier quota cap as billing exhausted, not a bare quota error (#1114)", () => {
      const stderr =
        'error.error="AI_APICallError: You exceeded your current quota, please check your plan and billing details. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.5-flash"';
      expect(detectProviderError(stderr)).toBe("provider billing exhausted");
    });

    it("classifies Anthropic's Console spend cap as billing exhausted (#1208)", () => {
      const stderr =
        "API Error: 400 You have reached your specified API usage limits. You will regain access on 2026-09-01 at 00:00 UTC.";
      expect(detectProviderError(stderr)).toBe("provider billing exhausted");
      expect(findAnthropicSpendCap(stderr)?.regainAt).toBe("2026-09-01 at 00:00 UTC");
    });

    it("reads a spend cap with no regain date (#1208)", () => {
      expect(findAnthropicSpendCap("You have reached your specified API usage limits.")).toEqual({
        regainAt: null,
      });
    });
  });

  describe("real provider errors", () => {
    it("detects 429 only when adjacent to a status key", () => {
      expect(detectProviderError('{"statusCode": 429}')).toBe("rate limited (429)");
      expect(detectProviderError('{"status_code": 429, "message": "..."}')).toBe(
        "rate limited (429)"
      );
      expect(detectProviderError("http_status: 429")).toBe("rate limited (429)");
      expect(detectProviderError("status=429")).toBe("rate limited (429)");
    });

    it("detects rate_limit_error and rate_limit_exceeded", () => {
      expect(detectProviderError('{"type":"rate_limit_error"}')).toBe("rate limited");
      expect(detectProviderError("rate_limit_exceeded")).toBe("rate limited");
      expect(detectProviderError("plain rate limit reached")).toBe("rate limited");
    });

    it("detects rate-limit phrasing with trailing inflection", () => {
      expect(detectProviderError("Error: rate limited by provider")).toBe("rate limited");
      expect(detectProviderError("rate limits exceeded for this key")).toBe("rate limited");
    });

    it("detects RESOURCE_EXHAUSTED", () => {
      expect(detectProviderError('"status": "RESOURCE_EXHAUSTED"')).toBe("quota exhausted");
    });

    it("detects gRPC INTERNAL status as a whole word", () => {
      expect(detectProviderError('"status": "INTERNAL"')).toBe("provider internal error");
    });

    it("detects UNAVAILABLE as a whole word", () => {
      expect(detectProviderError('"status": "UNAVAILABLE"')).toBe("provider unavailable");
    });

    it("detects 500 / 503 only when adjacent to a status key", () => {
      expect(detectProviderError('"statusCode": 500')).toBe("provider 500 error");
      expect(detectProviderError('"statusCode": 503')).toBe("provider unavailable (503)");
      expect(detectProviderError("v1.503.0 release notes")).toBeNull();
    });

    it("detects quota and zero-quota responses", () => {
      expect(detectProviderError('"message": "quota exceeded"')).toBe("quota error");
      expect(detectProviderError('{"code":"insufficient_quota"}')).toBe("quota error");
      expect(detectProviderError('"error":"quota_exceeded"')).toBe("quota error");
      expect(detectProviderError('{"reason":"quotaExceeded"}')).toBe("quota error");
      expect(detectProviderError('{"limit": 0, "remaining": 0}')).toBe("zero quota");
      expect(detectProviderError('"time_limit": 0')).toBeNull();
    });
  });
});

describe("findProviderErrorMatch", () => {
  // regression for issue #703: when stderr arrives as a multi-KB buffer
  // (mcp tool-schema dump + the actual error message), the old
  // `chunk.substring(0, 500)` excerpt showed the head of the buffer
  // (schema) instead of the matched error text. the windowed excerpt
  // must center on the matched line.
  it("excerpt centers on the matched line, not the head of the buffer", () => {
    const schemaDump =
      "{".repeat(2000) +
      '"name":"pullfrog_create_pull_request_review","description":"Submit a review..."';
    const errorLine = "ERROR 2026-05-13 service=session error=rate_limit_exceeded retry-after=30";
    const chunk = `${schemaDump}\n${errorLine}\ncaller stack at handler.ts:42`;

    const match = findProviderErrorMatch(chunk);
    expect(match).not.toBeNull();
    expect(match?.label).toBe("rate limited");
    expect(match?.excerpt).toContain("rate_limit_exceeded");
    expect(match?.excerpt).toContain("retry-after=30");
    expect(match?.excerpt).not.toContain("pullfrog_create_pull_request_review");
  });

  it("includes a small surrounding-line window for stack-trace context", () => {
    const chunk =
      "» about to call session.processor\n" +
      "ERROR rate_limit_exceeded for key=abc\n" +
      "at handler.ts:42\n" +
      "at runtime.ts:88";
    const match = findProviderErrorMatch(chunk);
    expect(match?.excerpt).toContain("about to call session.processor");
    expect(match?.excerpt).toContain("rate_limit_exceeded");
    expect(match?.excerpt).toContain("handler.ts:42");
    expect(match?.excerpt).toContain("runtime.ts:88");
  });

  it("falls back to the matched line alone when adjacent lines are huge", () => {
    const giantPrefix = "x".repeat(5000);
    const errorLine = '"statusCode": 429, "message": "slow down"';
    const giantSuffix = "y".repeat(5000);
    const chunk = `${giantPrefix}\n${errorLine}\n${giantSuffix}`;

    const match = findProviderErrorMatch(chunk);
    expect(match?.label).toBe("rate limited (429)");
    expect(match?.excerpt).toBe(errorLine);
  });

  it("head-truncates the matched line if it alone exceeds the byte cap", () => {
    const padding = "z".repeat(700);
    const chunk = `${padding} "statusCode": 429 ${padding}`;
    const match = findProviderErrorMatch(chunk);
    expect(match?.label).toBe("rate limited (429)");
    expect(match?.excerpt.length).toBeLessThanOrEqual(600);
  });

  it("returns null when no pattern matches", () => {
    expect(findProviderErrorMatch("just some normal log line\nnothing wrong here")).toBeNull();
  });
});

describe("isProviderBillingExhausted (#835)", () => {
  it("matches DeepSeek 'Insufficient Balance' payloads", () => {
    expect(isProviderBillingExhausted("AI_APICallError: Insufficient Balance")).toBe(true);
  });

  it("matches Anthropic 'credit balance is too low' payloads", () => {
    expect(
      isProviderBillingExhausted("Your credit balance is too low to access the Anthropic API")
    ).toBe(true);
  });

  it("matches OpenCode Zen CreditsError / FreeUsageLimitError", () => {
    expect(isProviderBillingExhausted("CreditsError: out of credit")).toBe(true);
    expect(isProviderBillingExhausted("FreeUsageLimitError: limit hit")).toBe(true);
  });

  // #1474 — Zen and OpenAI wordings no earlier pattern reached
  it.each([
    "Upstream request failed: Insufficient account funds",
    "You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.",
  ])("matches %s", (text) => {
    expect(isProviderBillingExhausted(`provider error: ${text}`)).toBe(true);
  });

  it("returns false for unrelated provider errors", () => {
    expect(isProviderBillingExhausted('{"statusCode": 401}')).toBe(false);
    expect(isProviderBillingExhausted("rate_limit_exceeded")).toBe(false);
    expect(isProviderBillingExhausted("just some log noise")).toBe(false);
  });
});

describe("isProviderUsageLimit (#1474)", () => {
  it("matches the Codex / Zen usage cap and nothing billing-shaped", () => {
    expect(isProviderUsageLimit("provider error: The usage limit has been reached")).toBe(true);
    expect(isProviderUsageLimit("provider error: Insufficient account funds")).toBe(false);
  });
});

describe("extractProviderId", () => {
  it("parses providerID= from OpenCode harness logs", () => {
    expect(
      extractProviderId(
        'ERROR providerID=deepseek modelID=deepseek-v4-pro error={"name":"AI_APICallError"}'
      )
    ).toBe("deepseek");
  });

  it("lowercases the captured slug", () => {
    expect(extractProviderId("providerID=Anthropic modelID=claude")).toBe("anthropic");
  });

  it("returns null when providerID is absent", () => {
    expect(extractProviderId("APIError: Insufficient Balance")).toBeNull();
  });
});

describe("isRouterKeylimitExhaustedError", () => {
  it("matches the canonical OpenRouter mid-run error", () => {
    expect(
      isRouterKeylimitExhaustedError(
        "APIError: This request requires more credits, or fewer max_tokens. " +
          "You requested up to 32000 tokens, but can only afford 22800. " +
          "To increase, visit https://openrouter.ai/settings/keys and create a key with a higher total limit"
      )
    ).toBe(true);
    // #1071 cumulative-cap shape
    expect(
      isRouterKeylimitExhaustedError(
        "provider error: Key limit exceeded (total limit). Manage it using " +
          "https://openrouter.ai/workspaces/default/keys/74b744277d302df1904d3f0d"
      )
    ).toBe(true);
  });

  it("matches the 'requires more credits' phrasing on its own", () => {
    expect(
      isRouterKeylimitExhaustedError("This request requires more credits, or fewer max_tokens.")
    ).toBe(true);
  });

  it("matches the 'requested up to ... can only afford' phrasing on its own", () => {
    expect(
      isRouterKeylimitExhaustedError("You requested up to 8000 tokens but can only afford 1234")
    ).toBe(true);
  });

  it("does not match generic out-of-credit text", () => {
    expect(isRouterKeylimitExhaustedError("Your account has insufficient credits")).toBe(false);
    expect(isRouterKeylimitExhaustedError("rate_limit_exceeded")).toBe(false);
    expect(isRouterKeylimitExhaustedError('{"limit": 0}')).toBe(false);
  });

  it("does not match unrelated mentions of max_tokens", () => {
    expect(isRouterKeylimitExhaustedError("max_tokens parameter must be a positive integer")).toBe(
      false
    );
  });

  it("matches across newlines (defends against upstream wrapping/reformatting)", () => {
    expect(
      isRouterKeylimitExhaustedError(
        "APIError: This request requires more credits, or\nfewer max_tokens. You requested up to 32000 tokens"
      )
    ).toBe(true);
    expect(
      isRouterKeylimitExhaustedError("You requested up to 32000 tokens,\nbut can only afford 22800")
    ).toBe(true);
  });
});

describe("isTransientUpstreamError (#1173)", () => {
  it("matches the three observed transports", () => {
    expect(
      isTransientUpstreamError(
        "API Error: 529 Overloaded. This is a server-side issue, usually temporary."
      )
    ).toBe(true);
    expect(
      isTransientUpstreamError(
        'provider error: {"code":502,"message":"Upstream error from Ambient","metadata":{"error_type":"provider_unavailable"}}'
      )
    ).toBe(true);
    expect(isTransientUpstreamError("Streaming response failed: [500] error code: 500")).toBe(true);
  });

  it("leaves the classifications that own 4xx alone", () => {
    expect(isTransientUpstreamError("API Error: 401 unauthorized")).toBe(false);
    expect(isTransientUpstreamError("Insufficient balance")).toBe(false);
    expect(isTransientUpstreamError("You have reached your specified API usage limits.")).toBe(
      false
    );
  });
});
