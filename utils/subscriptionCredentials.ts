import { z } from "zod";

export const subscriptionNameSchema = z.enum([
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CODEX_AUTH_JSON",
  "GROK_AUTH_JSON",
]);
export type SubscriptionName = z.infer<typeof subscriptionNameSchema>;

export const subscriptionSchema = z.object({
  id: z.string(),
  credentialId: z.string(),
  name: subscriptionNameSchema,
  label: z.string(),
  owner: z.string(),
  inherited: z.boolean(),
  shared: z.boolean(),
  registeredAt: z.string(),
  /** the provider's last verdict on the current value; null = usable or never checked. */
  status: z.enum(["rejected", "exhausted"]).nullish(),
  resetAt: z.string().nullish(),
});
export type Subscription = z.infer<typeof subscriptionSchema>;

export const subscriptionListSchema = z.object({
  subscriptions: z.array(subscriptionSchema),
  writable: z.boolean(),
});

export const subscriptionInputSchema = z.object({
  name: subscriptionNameSchema,
  value: z
    .string()
    .trim()
    .min(1)
    .refine((value) => Buffer.byteLength(value, "utf8") <= 49152),
  replaceId: z.string().optional(),
});

export const credentialCandidateSchema = z.object({
  id: z.string(),
  name: z.string(),
  source: z.enum(["repo", "account", "personal"]),
});
export type CredentialCandidate = z.infer<typeof credentialCandidateSchema>;
export const credentialAccessSchema = z.object({
  token: z.string(),
  candidates: z.array(credentialCandidateSchema),
});
export type CredentialAccess = z.infer<typeof credentialAccessSchema>;

export const selectedCredentialSchema = z.object({
  name: z.string(),
  value: z.string(),
  receipt: z.string(),
});

/** ChatGPT plan ids whose name is not the id read aloud. OpenAI sells `prolite` and `pro` both as Pro. */
const PLAN_NAMES: Record<string, string> = {
  prolite: "Pro",
  pro: "Pro",
  promax: "Pro Max",
  self_serve_business_prolite: "Business",
  self_serve_business_usage_based: "Business",
  ent26: "Enterprise",
  enterprise_cbp_automation: "Enterprise",
  enterprise_cbp_usage_based: "Enterprise",
  sci: "Academic Researchers",
  sci_plus: "Academic Researchers Plus",
};

/** `plan` is a ChatGPT plan id: the one `wham/usage` last reported, else the token's own claim. */
export function subscriptionLabel(input: {
  email: string | null;
  suffix: string;
  plan: string | null;
}) {
  const account = input.email ?? `•••• ${input.suffix}`;
  if (!input.plan) return account;
  // an id not in the table is read aloud (`edu_plus` → "Edu Plus"), so a new plan needs no code
  const plan =
    PLAN_NAMES[input.plan] ??
    input.plan
      .split("_")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  return `${plan} · ${account}`;
}

/** the provider's last verdict on a subscription, or null when it last worked. */
export function subscriptionStatusText(subscription: Subscription): string | null {
  if (subscription.status === "rejected") return "Rejected";
  if (subscription.status !== "exhausted") return null;
  if (!subscription.resetAt) return "Limit reached";
  const resetAt = new Date(subscription.resetAt);
  // a window that has reopened is usable again until a run says otherwise
  if (resetAt.getTime() <= Date.now()) return null;
  return `Limit reached · resets ${resetAt.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
}

/**
 * Subscription credentials are re-authenticated, never rotated: there is no
 * provider dashboard to visit and no API key to paste. Telling their owner to
 * "rotate the key in your provider dashboard, then update the matching GitHub
 * Actions secret" names three things that do not exist for them — which is what
 * a revoked `CLAUDE_CODE_OAUTH_TOKEN` was answered with 47 times in a row
 * before this existed, because Anthropic's rejection reads `Invalid bearer
 * token` and that is also what a rotated `ANTHROPIC_API_KEY` reads (#782).
 * The credential in play is knowable, so it decides the copy — never the prose.
 */
export const SUBSCRIPTION_CREDENTIALS: Record<
  string,
  { label: string; command: string; provider: string }
> = {
  CLAUDE_CODE_OAUTH_TOKEN: {
    label: "Claude subscription",
    command: "pullfrog auth claude",
    provider: "anthropic",
  },
  CODEX_AUTH_JSON: {
    label: "ChatGPT subscription",
    command: "pullfrog auth codex",
    provider: "openai",
  },
  GROK_AUTH_JSON: {
    label: "Grok subscription",
    command: "pullfrog auth grok",
    provider: "xai",
  },
};

/** the subscription that serves `model`'s provider, named by the env var that carries it. */
export function subscriptionFor(model: string | undefined) {
  const provider = model?.split("/")[0];
  for (const [env, subscription] of Object.entries(SUBSCRIPTION_CREDENTIALS)) {
    if (subscription.provider === provider) return { env, ...subscription };
  }
  return undefined;
}
