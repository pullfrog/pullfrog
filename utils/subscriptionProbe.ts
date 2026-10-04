import { z } from "zod";
import { preflightClaudeSubscription } from "./claudeSubscription.ts";
import { parseCodexAuthBody } from "./codexOAuth.ts";
import { verifyCredential } from "./credentialCheck.ts";
import type { SubscriptionName } from "./subscriptionCredentials.ts";
import { parseXaiAuthBody } from "./xaiOAuth.ts";

const identitySchema = z.object({
  email: z.string().email().optional(),
  sub: z.string().optional(),
  user_id: z.string().optional(),
  account_id: z.string().optional(),
  email_verified: z.boolean().optional(),
});
const codexWindowSchema = z
  .object({ used_percent: z.number().optional(), reset_at: z.number().optional() })
  .nullish();
const codexUsageSchema = z.object({
  rate_limit: z
    .object({
      allowed: z.boolean(),
      limit_reached: z.boolean(),
      primary_window: codexWindowSchema,
      secondary_window: codexWindowSchema,
    })
    .optional(),
  credits: z
    .object({
      has_credits: z.boolean().optional(),
      unlimited: z.boolean().optional(),
      overage_limit_reached: z.boolean().optional(),
    })
    .nullish(),
  spend_control: z.object({ reached: z.boolean().optional() }).nullish(),
});

/**
 * the provider's answer about one credential. only `rejected` and `exhausted`
 * advance the chain; `unknown` never changes who pays.
 */
export type ProbeVerdict =
  | { status: "usable" }
  | { status: "unknown" }
  | { status: "rejected"; detail: string }
  | { status: "exhausted"; detail: string; resetAt: Date | undefined };

const unknown = { status: "unknown" } as const;

export class SubscriptionCredentialError extends Error {}

export async function subscriptionIdentity(input: { name: SubscriptionName; value: string }) {
  const empty = { email: null, subject: null };
  if (input.name === "CLAUDE_CODE_OAUTH_TOKEN") return empty;
  const codex = input.name === "CODEX_AUTH_JSON" ? parseCodexAuthBody(input.value) : null;
  const grok = input.name === "GROK_AUTH_JSON" ? parseXaiAuthBody(input.value) : null;
  const token = codex?.tokens.access_token ?? grok?.tokens.access_token;
  if (!token) throw new SubscriptionCredentialError("invalid subscription credential");
  const response = await readSubscriptionEndpoint({
    url: codex ? "https://chatgpt.com/backend-api/wham/usage" : "https://auth.x.ai/oauth2/userinfo",
    token,
    accountId: codex?.tokens.account_id,
  });
  if (response?.status === 401)
    throw new SubscriptionCredentialError("subscription credential was rejected");
  if (!response?.ok) return empty;
  const parsed = identitySchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return empty;
  const subject = parsed.data.sub ?? parsed.data.user_id;
  return {
    email: parsed.data.email_verified === false ? null : (parsed.data.email ?? null),
    subject: subject ? `${subject}:${parsed.data.account_id ?? ""}` : null,
  };
}

async function readSubscriptionEndpoint(input: {
  url: string;
  token: string;
  accountId?: string | undefined;
  grokBilling?: boolean;
}) {
  const headers = new Headers({ authorization: `Bearer ${input.token}` });
  if (input.accountId) headers.set("ChatGPT-Account-Id", input.accountId);
  if (input.grokBilling) headers.set("x-xai-token-auth", "xai-grok-cli");
  return fetch(input.url, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
}

/** unknown quota is not a reason to skip a credential or change who pays. */
export async function probeSubscription(input: {
  name: SubscriptionName;
  value: string;
  model?: string | undefined;
}): Promise<ProbeVerdict> {
  if (input.name === "CLAUDE_CODE_OAUTH_TOKEN") {
    const result = await preflightClaudeSubscription({ token: input.value, model: input.model });
    // preflight fails open on a 5xx or 400; only a 2xx says the token works
    if (result.usable)
      return result.status !== undefined && result.status < 300 ? { status: "usable" } : unknown;
    return result.status === 429
      ? { status: "exhausted", detail: result.reason, resetAt: result.resetAt }
      : { status: "rejected", detail: result.reason };
  }
  const codex = input.name === "CODEX_AUTH_JSON" ? parseCodexAuthBody(input.value) : null;
  const grok = input.name === "GROK_AUTH_JSON" ? parseXaiAuthBody(input.value) : null;
  const auth = codex ?? grok;
  if (!auth) return { status: "rejected", detail: "the stored credential is malformed" };
  if (auth.refresh_rejected_at)
    return { status: "rejected", detail: `refresh rejected at ${auth.refresh_rejected_at}` };
  if (grok && input.model)
    return probeInference({
      name: "XAI_API_KEY",
      value: grok.tokens.access_token,
      model: input.model,
    });
  const response = await readSubscriptionEndpoint({
    url: codex
      ? "https://chatgpt.com/backend-api/wham/usage"
      : "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
    token: auth.tokens.access_token,
    accountId: codex?.tokens.account_id,
    grokBilling: !!grok,
  });
  if (response?.status === 401) return { status: "rejected", detail: "rejected with 401" };
  if (!response?.ok) return unknown;
  const body: unknown = await response.json().catch(() => null);
  // billing balance is not the subscription's remaining allowance.
  if (!codex) return unknown;
  const parsed = codexUsageSchema.safeParse(body);
  const limit = parsed.success ? parsed.data.rate_limit : undefined;
  if (!limit) return unknown;
  if (limit.allowed && !limit.limit_reached) return { status: "usable" };
  // workspaces with credits keep serving requests past the plan window
  const credits = parsed.success ? parsed.data.credits : undefined;
  const spendCapped = parsed.success && parsed.data.spend_control?.reached === true;
  if (
    (credits?.has_credits || credits?.unlimited) &&
    !credits.overage_limit_reached &&
    !spendCapped
  )
    return { status: "usable" };
  // the full window decides when the plan works again
  const windows = [limit.primary_window, limit.secondary_window];
  const full = windows.filter((window) => (window?.used_percent ?? 0) >= 100);
  const resets = (full.length ? full : windows).flatMap((window) =>
    window?.reset_at ? [window.reset_at] : []
  );
  return {
    status: "exhausted",
    detail: "the ChatGPT plan's usage limit is reached",
    resetAt: resets.length ? new Date(Math.max(...resets) * 1000) : undefined,
  };
}

/** probe the chosen model, not a models-list permission a restricted key may lack. */
export async function probeInference(input: {
  name: string;
  value: string;
  model: string;
}): Promise<ProbeVerdict> {
  const anthropic = input.name === "ANTHROPIC_API_KEY";
  const openai = input.name === "OPENAI_API_KEY";
  if (!anthropic && !openai && input.name !== "XAI_API_KEY") {
    const result = await verifyCredential({ envVar: input.name, value: input.value });
    return result === "dead"
      ? { status: "rejected", detail: "rejected by its provider" }
      : result === "alive"
        ? { status: "usable" }
        : unknown;
  }
  const headers = new Headers({ "content-type": "application/json" });
  if (anthropic) {
    headers.set("x-api-key", input.value);
    headers.set("anthropic-version", "2023-06-01");
  } else headers.set("authorization", `Bearer ${input.value}`);
  const response = await fetch(
    anthropic
      ? "https://api.anthropic.com/v1/messages"
      : openai
        ? "https://api.openai.com/v1/responses"
        : "https://api.x.ai/v1/chat/completions",
    {
      method: "POST",
      headers,
      body: JSON.stringify(
        openai
          ? { model: input.model, input: "Reply OK.", max_output_tokens: 16, store: false }
          : {
              model: input.model,
              messages: [{ role: "user", content: "Reply OK." }],
              max_tokens: 1,
            }
      ),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    }
  ).catch(() => null);
  if (response?.status === 400 && input.name === "XAI_API_KEY") {
    const error = z
      .object({ error: z.string() })
      .safeParse(await response.json().catch(() => null));
    return error.success && error.data.error.startsWith("Incorrect API key provided.")
      ? { status: "rejected", detail: "rejected with 400: incorrect API key" }
      : unknown;
  }
  // a 429 is usually a rate limit, which the run itself can wait out; only a spent OpenAI quota is final
  if (response?.status === 429 && openai) {
    const error = z
      .object({ error: z.object({ code: z.string() }) })
      .safeParse(await response.json().catch(() => null));
    return error.success && error.data.error.code === "insufficient_quota"
      ? { status: "exhausted", detail: "refused with 429: insufficient quota", resetAt: undefined }
      : unknown;
  }
  await response?.body?.cancel();
  if (!response) return unknown;
  if (response.ok) return { status: "usable" };
  if (response.status === 401 || response.status === 403)
    return { status: "rejected", detail: `rejected with ${response.status}` };
  if (response.status === 402)
    return { status: "exhausted", detail: "refused with 402", resetAt: undefined };
  return unknown;
}
