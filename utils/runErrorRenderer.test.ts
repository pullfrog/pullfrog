import { describe, expect, it } from "vitest";
import { buildCredentialPoolRefusedError, type RefusedCredential } from "./apiKeys.ts";
import { renderRunError } from "./runErrorRenderer.ts";

const repo = { owner: "acme", name: "widget" };

describe("renderRunError BYOK provider billing exhausted (#835)", () => {
  const deepseekRaw =
    '» provider error detected (provider billing exhausted): ERROR providerID=deepseek modelID=deepseek-v4-pro error={"name":"AI_APICallError","message":"Insufficient Balance"}';

  const anthropicRaw =
    "APIError: Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";

  const opencodeZenRaw = "CreditsError: account out of free usage";

  it("renders DeepSeek billing-exhausted with provider-specific dashboard link", () => {
    const result = renderRunError({
      errorMessage: deepseekRaw,
      repo,
      agentDiagnostic: undefined,
      routerActive: false,
    });
    expect(result.summary).toContain("`deepseek` account is out of credit");
    expect(result.summary).toContain("https://platform.deepseek.com/top_up");
    expect(result.summary).toContain("### ❌ Pullfrog failed");
    expect(result.comment).toContain("`deepseek` account is out of credit");
    expect(result.comment).not.toContain("### ❌ Pullfrog failed");
  });

  it("matches Anthropic 'credit balance is too low' (#835 Anthropic case)", () => {
    const result = renderRunError({
      errorMessage: anthropicRaw,
      repo,
      agentDiagnostic: undefined,
      routerActive: false,
    });
    expect(result.comment).toContain("out of credit");
  });

  it("matches OpenCode Zen CreditsError shape", () => {
    const result = renderRunError({
      errorMessage: opencodeZenRaw,
      repo,
      agentDiagnostic: undefined,
      routerActive: false,
    });
    expect(result.comment).toContain("out of credit");
  });

  it("falls through to a generic CTA when providerID cannot be parsed", () => {
    const result = renderRunError({
      errorMessage: "Insufficient balance — provider response with no providerID tag",
      repo,
      agentDiagnostic: undefined,
      routerActive: false,
    });
    expect(result.comment).toContain("Your provider account is out of credit");
    expect(result.comment).not.toContain("Your your");
    expect(result.comment).toContain("Top up your provider account");
  });
});

describe("renderRunError ProviderModelNotFoundError (#816)", () => {
  const staleFreeRaw =
    'ProviderModelNotFoundError: {"providerID":"opencode","modelID":"retired-free-model","suggestions":["deepseek-v4-flash-free"]}';

  const bigPickleRaw =
    'ProviderModelNotFoundError: {"providerID":"opencode","modelID":"big-pickle","suggestions":[]}';

  it("renders actionable copy for a stale free model id", () => {
    const result = renderRunError({
      errorMessage: staleFreeRaw,
      repo,
      agentDiagnostic: undefined,
      routerActive: false,
    });
    expect(result.summary).toContain("not in OpenCode's catalog");
    expect(result.summary).toContain("`acme/widget`");
    expect(result.summary).toContain("retired-free-model");
    expect(result.comment).toBe(result.summary);
  });

  it("renders the same classifier when big-pickle is missing from opencode catalog", () => {
    const result = renderRunError({
      errorMessage: bigPickleRaw,
      repo,
      agentDiagnostic: undefined,
      routerActive: false,
    });
    expect(result.summary).toContain("not in OpenCode's catalog");
    expect(result.summary).toContain("big-pickle");
  });

  it("does not misclassify unrelated failures as model-catalog errors", () => {
    const result = renderRunError({
      errorMessage: "activity timeout after 900s",
      repo,
      agentDiagnostic: undefined,
      routerActive: false,
    });
    expect(result.summary).not.toContain("not in OpenCode's catalog");
  });

  // #1470 — opencode ≥1.18 publishes only the session.error wording
  it("matches opencode's `Model not found:` wording and points at every place the model is set", () => {
    const result = renderRunError({
      errorMessage:
        'opencode prompt failed: {"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.","ref":"err_27a81c03"}} — likely cause: Model not found: deepseek/deepseek-v4-flash. Did you mean: deepseek-flash, deepseek-v4-pro?',
      repo,
      agentDiagnostic: undefined,
      routerActive: false,
    });
    expect(result.comment).toContain("not in OpenCode's catalog");
    expect(result.comment).toContain("`PULLFROG_MODEL`");
    expect(result.comment).toContain("Did you mean: deepseek-flash, deepseek-v4-pro?");
  });
});

describe("renderRunError credential pool refusal (#1473)", () => {
  const resetAt = new Date("2026-10-06T14:00:00Z");
  const variants: RefusedCredential[] = [
    {
      name: "CLAUDE_CODE_OAUTH_TOKEN",
      source: "repo",
      verdict: {
        status: "exhausted",
        detail: "429: This request would exceed your account's rate limit. Please try again later.",
        resetAt,
      },
    },
    {
      name: "CODEX_AUTH_JSON",
      source: "account",
      verdict: {
        status: "exhausted",
        detail: "the ChatGPT plan's usage limit is reached",
        resetAt: undefined,
      },
    },
    {
      name: "GROK_AUTH_JSON",
      source: "account",
      verdict: { status: "rejected", detail: "rejected with 403" },
    },
    {
      name: "OPENAI_API_KEY",
      source: "account",
      verdict: { status: "rejected", detail: "rejected with 401" },
    },
    {
      name: "CODEX_AUTH_JSON",
      source: "repo",
      verdict: { status: "rejected", detail: "rejected with 401" },
    },
    {
      name: "CLAUDE_CODE_OAUTH_TOKEN",
      source: "account",
      verdict: {
        status: "rejected",
        detail: "403: OAuth authentication is currently not allowed for this organization.",
      },
    },
    {
      name: "CODEX_AUTH_JSON",
      source: "account",
      verdict: { status: "rejected", detail: "refresh rejected at 2026-09-30T12:00:00.000Z" },
    },
    {
      name: "CLAUDE_CODE_OAUTH_TOKEN",
      source: "account",
      verdict: { status: "rejected", detail: "401: OAuth access token has been revoked." },
    },
    {
      name: "OPENAI_API_KEY",
      source: "workflow",
      verdict: {
        status: "exhausted",
        detail: "refused with 429: insufficient quota",
        resetAt: undefined,
      },
    },
  ];
  const build = (refused: RefusedCredential[]) =>
    buildCredentialPoolRefusedError({ model: "openai/gpt-6.1-sol", refused, ...repo });

  it.each(variants)(
    "passes $name ($verdict.detail) through verbatim on both surfaces",
    (credential) => {
      const body = build([credential]);
      const result = renderRunError({
        errorMessage: body,
        repo,
        agentDiagnostic: undefined,
        routerActive: false,
      });
      expect(result.comment).toBe(body);
      expect(result.summary).toBe(body);
      expect(body).toContain(credential.verdict.detail);
    }
  );

  it("gives each verdict the remedy its credential kind calls for", () => {
    const body = build(variants);
    expect(body).toContain("it resets at **2026-10-06 14:00 UTC**");
    expect(body).toContain("`pullfrog auth codex`");
    expect(body).toContain("https://platform.openai.com/api-keys");
    expect(body).toContain("[Update it in Pullfrog →](");
    expect(body).toContain("https://platform.openai.com/settings/organization/billing/overview");
    expect(body.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(variants.length);
  });

  it("points a rejected workflow key at the GitHub Actions secret", () => {
    const body = build([
      {
        name: "OPENAI_API_KEY",
        source: "workflow",
        verdict: { status: "rejected", detail: "rejected with 401" },
      },
    ]);
    expect(body).toContain("https://github.com/acme/widget/settings/secrets/actions");
  });
});

describe("renderRunError provider-stated refusals (#1474)", () => {
  it.each([
    ["Upstream request failed: Invalid credential", "The model provider returned an error"],
    [
      "Upstream request failed: An active OpenCode Go subscription is required to use Go models.",
      "The model provider returned an error",
    ],
    ["The usage limit has been reached", "usage limit for this account has been reached"],
    // routes against Pullfrog's own OpenRouter balance on a Router run, so it gets no top-up copy
    [
      "This request would exceed your available credits given your current in-flight requests. Retry after in-flight requests settle, or add credits.",
      "The model provider returned an error",
    ],
    [
      "Upstream request failed: Insufficient account funds",
      "Your provider account is out of credit",
    ],
    [
      "Encountered invalidated oauth token for user, failing request",
      "OAuth credential has expired",
    ],
    [
      "You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.",
      "`openai` account is out of credit",
    ],
    // claude.ts / codex.ts put our classifier label, not the provider's wording, after the prefix
    ["auth error (401)", "The model provider returned an error"],
  ])("renders `provider error: %s` with its cause", (text, expected) => {
    const result = renderRunError({
      errorMessage: `provider error: ${text}`,
      repo,
      agentDiagnostic: undefined,
      routerActive: false,
    });
    expect(result.comment).toContain(expected);
    expect(result.comment).not.toContain("Run failed.");
    expect(result.summary).toContain(result.comment);
  });

  it("still collapses an unknown internal error to the one-line comment", () => {
    const result = renderRunError({
      errorMessage: "opencode prompt failed: fetch failed",
      repo,
      agentDiagnostic: undefined,
      routerActive: false,
    });
    expect(result.comment.startsWith("**Run failed.**")).toBe(true);
    expect(result.summary).toContain("opencode prompt failed: fetch failed");
  });
});
