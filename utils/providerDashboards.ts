/**
 * Where each provider's own account lives, keyed by the provider id the rest of
 * the runtime already uses (`providers` in `models.ts`, `providerID=` in the
 * opencode log). Both failure surfaces read this one table — the per-run PR
 * comment for its top-up CTA, and the diagnosis agent's link registry — so a
 * host move is fixed in one place. Every catalog provider is here except
 * `openai-compatible`, whose endpoint is the customer's own and has no page.
 *
 * How each path is known (2026-09-14), because "checked" means three different
 * things here. Probed with a discriminating control — the path answers 200 and
 * a junk path on the same host 404s: `platform.claude.com`, `platform.kimi.ai`,
 * `www.kimi.com`, `dev.meta.ai`, `opencode.ai`, the AWS billing host.
 * Taken from the provider's own docs, because the host answers a probe with a
 * Cloudflare challenge or a catch-all login redirect that no junk path can
 * distinguish: OpenAI, xAI, DeepSeek, `claude.ai`, `chatgpt.com`, Google,
 * OpenRouter, Vercel, `grok.com`. Fragment routes (`#…`) never reach a server,
 * so those rest on the docs alone. `console.anthropic.com` and
 * `platform.moonshot.ai` both 301 now, so the entries name the hosts they land
 * on.
 *
 * The subscription rows are not providers in the catalog sense — a Claude,
 * ChatGPT or SuperGrok plan has a usage window and a plan page but no API key —
 * so they carry the `-plan` suffix, no `keys`, and the credential that proves
 * the plan is in play.
 */
export type ProviderDashboard = {
  /** the name a customer knows the account by */
  name: string;
  /** a plan row only: the stored credential whose presence means the plan is in use */
  credential?: string;
  /** the wallet, the card on file, a spend cap, or the plan itself */
  billing: string;
  /** spend to date, or a plan's limit window and its reset time */
  usage?: string;
  /** where an API key is created or rotated */
  keys?: string;
};

export const PROVIDER_DASHBOARDS: Record<string, ProviderDashboard> = {
  anthropic: {
    name: "Anthropic",
    billing: "https://platform.claude.com/settings/billing",
    usage: "https://platform.claude.com/usage",
    keys: "https://platform.claude.com/settings/keys",
  },
  "claude-plan": {
    name: "Claude",
    credential: "CLAUDE_CODE_OAUTH_TOKEN",
    billing: "https://claude.ai/settings/billing",
    usage: "https://claude.ai/settings/usage",
  },
  openai: {
    name: "OpenAI",
    billing: "https://platform.openai.com/settings/organization/billing/overview",
    usage: "https://platform.openai.com/settings/organization/usage",
    keys: "https://platform.openai.com/api-keys",
  },
  "codex-plan": {
    name: "ChatGPT/Codex",
    credential: "CODEX_AUTH_JSON",
    billing: "https://chatgpt.com/#settings/Subscription",
    usage: "https://chatgpt.com/codex/settings/usage",
  },
  google: {
    name: "Google AI Studio",
    // AI Studio's "Usage & billing" page is where the Gemini API plan lives;
    // the Cloud billing console is a level up and needs a project picked.
    billing: "https://aistudio.google.com/usage",
    keys: "https://aistudio.google.com/apikey",
  },
  vertex: {
    name: "Google Vertex AI",
    billing: "https://console.cloud.google.com/billing",
    usage: "https://console.cloud.google.com/vertex-ai",
  },
  xai: {
    name: "xAI",
    billing: "https://console.x.ai/team/default/billing",
    usage: "https://console.x.ai/team/default/usage",
    keys: "https://console.x.ai/team/default/api-keys",
  },
  "grok-plan": {
    name: "SuperGrok",
    credential: "GROK_AUTH_JSON",
    billing: "https://grok.com/?_s=billing",
  },
  deepseek: {
    name: "DeepSeek",
    billing: "https://platform.deepseek.com/top_up",
    usage: "https://platform.deepseek.com/usage",
    keys: "https://platform.deepseek.com/api_keys",
  },
  moonshotai: {
    name: "Moonshot (Kimi API)",
    billing: "https://platform.kimi.ai/console/pay",
    usage: "https://platform.kimi.ai/console/account",
    keys: "https://platform.kimi.ai/console/api-keys",
  },
  "kimi-for-coding": {
    name: "Kimi Code",
    billing: "https://www.kimi.com/membership/pricing",
    keys: "https://www.kimi.com/code/console",
  },
  meta: {
    name: "Meta Model API",
    billing: "https://dev.meta.ai/billing",
    usage: "https://dev.meta.ai/usage",
    keys: "https://dev.meta.ai/api-keys",
  },
  opencode: {
    name: "OpenCode Zen",
    billing: "https://opencode.ai/zen",
    keys: "https://opencode.ai/zen",
  },
  // Go is a separate plan on the same key, with its own usage cap that resets
  // on its own (wiki/opencode-silent-stall.md). Its page is the plan page; no
  // per-window usage page is documented.
  "opencode-go": {
    name: "OpenCode Go",
    billing: "https://opencode.ai/go",
    keys: "https://opencode.ai/zen",
  },
  openrouter: {
    name: "OpenRouter",
    billing: "https://openrouter.ai/settings/credits",
    usage: "https://openrouter.ai/activity",
    keys: "https://openrouter.ai/workspaces/default/keys",
  },
  vercel: {
    name: "Vercel AI Gateway",
    // `/d?to=` resolves `[team]` to whichever team the visitor is signed into.
    billing: "https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway",
    keys: "https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway%2Fapi-keys",
  },
  bedrock: {
    name: "Amazon Bedrock",
    billing: "https://console.aws.amazon.com/billing/home",
    keys: "https://us-east-1.console.aws.amazon.com/bedrock/home#/api-keys",
  },
  // Azure OpenAI keys are per-resource, so there is no stable keys page to name.
  azure: {
    name: "Azure OpenAI",
    billing: "https://portal.azure.com/#view/Microsoft_Azure_CostManagement/Menu/~/overview",
  },
};
