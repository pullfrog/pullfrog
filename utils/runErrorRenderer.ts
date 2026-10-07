/**
 * Classify + render the error thrown out of the main run try-block into a
 * pair of user-facing markdown bodies — one for the GitHub Actions job
 * summary tab, one for the PR progress comment.
 *
 * Classifications, in dispatch order (first match wins; the api-key
 * branch additionally folds in the activity-timeout hang body as a
 * sub-source so a hang masking an api-key error still surfaces the api-key
 * CTA):
 *
 *   1. `BillingError` — either the proxy-token mint already threw one (402
 *      handled inline) or the agent runtime surfaced an OpenRouter
 *      "key budget exhausted" string mid-run. Both render via
 *      `formatBillingErrorSummary` so the user sees actionable copy.
 *
 *   1a. Pre-rendered bodies — a throw site that already built the markdown
 *      (`MODEL_ACCESS_MARKER`, `SECRETS_UNAVAILABLE_MARKER`,
 *      `ROUTER_UNFUNDED_MARKER`, `CREDENTIAL_REJECTED_MARKER`,
 *      `CREDENTIAL_POOL_REFUSED_MARKER`) passes through verbatim on both surfaces.
 *
 *   2. BYOK provider billing-exhausted (#835) — DeepSeek "Insufficient
 *      Balance", Anthropic "credit balance is too low", OpenCode Zen
 *      `CreditsError`, Gemini "spending cap". Checked before api-key auth
 *      because billing-exhausted responses often carry 401 status codes
 *      that `isApiKeyAuthError` would otherwise mis-classify.
 *
 *   2a. Provider usage limit (#1474) — a capped subscription window or a
 *      configured workspace limit; "wait or raise it", never "top up".
 *
 *   3. API-key auth error — `isApiKeyAuthError` sniffs the raw error string
 *      (or the activity-timeout hang body when present, since that's where
 *      the underlying provider error often lands); `formatApiKeyErrorSummary`
 *      renders provider + console-link copy.
 *
 *   4. ProviderModelNotFoundError — configured model id not in the OpenCode
 *      catalog (opencode ≥1.18 words it `Model not found: <id>`, #1470);
 *      renders a nudge to pick a different model.
 *
 *   4a. No-provider-available (#1077) — the model IS in the catalog but the
 *      provider declines to route it on this account's plan (OpenCode Zen's
 *      own refusal string). Same "pick another model" CTA, different reason.
 *
 *   4a'. Zen free-tier gate (#1377) — Zen 403s a free-tier request whose tool
 *      list is missing a built-in it expects. The harness keeps `bash` listed,
 *      but opencode's auto-compaction request carries no tools, so a long
 *      free-Zen run can still die mid-flight on the raw upstream string.
 *
 *   4b. Context-window overflow (#1116) — terminal `Prompt is too long` /
 *      `maximum context length is N tokens`. Actionable, so it renders on
 *      both surfaces rather than collapsing to the one-line comment.
 *
 *   4b'. Run time limit — the agent was still working when the run's own
 *      timeout fired. Actionable (raise the limit), so both surfaces.
 *
 *   4c. Transient upstream failure (#1173) — Anthropic `529 Overloaded`,
 *      OpenRouter `provider_unavailable` / `timeout`, Zen `Streaming response
 *      failed: [5xx]`. Last of the classified branches so every more specific
 *      one wins first. Renders on both surfaces: the remedy is re-triggering,
 *      which the user can only know if we say so.
 *
 *   5. Activity-timeout hang — `errorMessage` starts with
 *      `"activity timeout"` or `"agent still pending"` AND none of the
 *      above matched. The harness keeps structured diagnostic state on
 *      `toolState.agentDiagnostic`; `formatAgentHangBody` renders that into
 *      the job summary. The PR comment keeps that same body whenever the hang
 *      is EXPLAINED — a classified provider error (#778, #1183) or a provider
 *      that never returned a first token — and otherwise collapses to a
 *      one-line `**Run failed.** [View the logs →]`, because watchdog jargon,
 *      event counts and a benign stderr tail are operator-grade detail that
 *      only alarm the average user.
 *
 *   6. Unclassified provider error (#1474) — `errorMessage` starts with
 *      `provider error: `. opencode prefixes every provider-side turn failure
 *      with the provider's text; claude-code (a zero-event exit) and codex (no
 *      turn error, no stderr) prefix only our classifier label. Either names
 *      something the user can act on, so both surfaces get a lead line plus the
 *      raw text in a fenced block.
 *
 *   7. Default — the job summary gets a plain-English lead sentence plus the
 *      raw error in a fenced code block under the `### ❌ Pullfrog failed`
 *      banner; the PR comment collapses to the same one-line logs link as
 *      the hang case, since the raw internal string helps nobody on the PR.
 *
 * Net: the actionable classifications (billing, usage limit, API-key,
 * model-not-found, no-provider-available, context-overflow, run time limit,
 * transient-upstream, unclassified provider error) render identical bodies on
 * both surfaces; the non-actionable ones (unexplained hang, generic) keep the
 * forensics in the Actions job summary and show a calm one-liner in the PR
 * comment, whose footer already carries Pullfrog branding + rerun links.
 */

import type { AgentDiagnostic } from "./agentHangReport.ts";
import { formatAgentHangBody } from "./agentHangReport.ts";
import {
  CREDENTIAL_POOL_REFUSED_MARKER,
  CREDENTIAL_REJECTED_MARKER,
  formatApiKeyErrorSummary,
  isApiKeyAuthError,
  isByokSetupError,
  ROUTER_UNFUNDED_MARKER,
  SECRETS_UNAVAILABLE_MARKER,
} from "./apiKeys.ts";
import { getApiUrl } from "./apiUrl.ts";
import { BillingError, formatBillingErrorSummary } from "./billingErrors.ts";
import { MODEL_ACCESS_MARKER } from "./modelAccess.ts";
import { PROVIDER_DASHBOARDS } from "./providerDashboards.ts";
import {
  extractProviderId,
  findAnthropicSpendCap,
  isOpenRouterKeyLimitExceeded,
  isProviderBillingExhausted,
  isProviderMissingCredential,
  isProviderNoRoutableEndpoints,
  isProviderUsageLimit,
  isRouterKeylimitExhaustedError,
  isTransientUpstreamError,
} from "./providerErrors.ts";

export type RenderedRunError = {
  summary: string;
  comment: string;
};

/** opencode <1.18 names the error class; ≥1.18 only publishes `Model not found: <id>` (#1470). */
function isProviderModelNotFoundError(message: string): boolean {
  return /ProviderModelNotFoundError|\bModel not found: /.test(message);
}

/**
 * Terminal context-window overflow (#1116). The run did real work — 5-12
 * minutes of it — and then died with no review, so the generic branch's
 * one-line comment hides the only two levers the user has: a larger-context
 * model, or a smaller PR. Covers the Claude CLI (`Prompt is too long`), the
 * OpenRouter/opencode endpoint rejection (`maximum context length is N
 * tokens`), and opencode's post-compaction give-up.
 */
function isContextOverflowError(message: string): boolean {
  return (
    /Prompt is too long/i.test(message) ||
    /Input exceeds context window/i.test(message) ||
    /maximum context length is \d+ tokens/i.test(message) ||
    /Session too large to compact/i.test(message)
  );
}

/**
 * OpenCode Zen's own server-side refusal (its `zen.api.error.noProviderAvailable`
 * string), not a CLI or catalog fault: the model is real and listed, but the
 * account's plan cannot be routed to it. Distinct from
 * `ProviderModelNotFoundError`, where the id is gone from the catalog entirely.
 * Reached most often by auto-select landing on a Zen free-tier model for an
 * account with no Zen relationship. See #1077.
 */
function isNoProviderAvailableError(message: string): boolean {
  return /\bNo provider available\b/i.test(message);
}

/**
 * OpenCode Zen's free-tier request-shape gate (`FreeTierError`): since
 * 2026-09-17 Zen refuses a free-tier request whose tool list is missing any of
 * the built-in tools it expects — measured: `bash`, `glob`, `grep` and `read`
 * each trip it, while `list`, `edit`, `write`, `task`, `todowrite`, `skill`,
 * `webfetch`, `websearch` and `question` do not. The harness keeps `bash`
 * listed (blocked by the gate plugin) so the main turn passes, but opencode's
 * auto-compaction request carries no tools and trips the same gate mid-run
 * (anomalyco/opencode#49587), and a repo-root `opencode.json` denying one of
 * the four strips it from the first call. See wiki/models-catalog.md.
 */
function isZenFreeTierGateError(message: string): boolean {
  return /free tier can only be used from within OpenCode/i.test(message);
}

function formatZenFreeTierGateSummary(input: { owner: string; name: string; raw: string }): string {
  const settingsUrl = `${getApiUrl()}/console/${input.owner}/${input.name}`;
  return [
    "**Zen's free tier refused a request this run made.** OpenCode Zen currently rejects free-model requests whose tool list is missing one of the built-in tools it expects ([upstream issue](https://github.com/anomalyco/opencode/issues/49587)). Pullfrog sends all of them, but opencode's mid-run context-compaction request carries no tools at all, and a repo-level `opencode.json` that denies `bash`, `glob`, `grep` or `read` strips that tool from every request.",
    "",
    'Pick a paid model for this repo, drop any `"deny"` on `bash`, `glob`, `grep` or `read` from the repo\'s `opencode.json` if it sets one, or split the PR so the run stays under the compaction threshold and re-trigger.',
    "",
    `[Model settings →](${settingsUrl}) · [Ask in Discord →](https://discord.gg/8y96raFg8e)`,
    "",
    `\`\`\`\n${input.raw}\n\`\`\``,
  ].join("\n");
}

function formatNoProviderAvailableSummary(input: {
  owner: string;
  name: string;
  raw: string;
}): string {
  const settingsUrl = `${getApiUrl()}/console/${input.owner}/${input.name}`;
  return [
    "**The provider refused to serve this model.** It's listed in the catalog, but the account this run used has no access to it — so the request was accepted and then declined.",
    "",
    "This often happens when Pullfrog auto-selects a model your account can't reach. Pin an explicit model for this repo, or add credentials for the provider that was picked.",
    "",
    `[Model settings →](${settingsUrl}) · [Setup docs →](https://docs.pullfrog.com/keys) · [Ask in Discord →](https://discord.gg/8y96raFg8e)`,
    "",
    `\`\`\`\n${input.raw}\n\`\`\``,
  ].join("\n");
}

/**
 * The run's own time limit (`main.ts`), not a hang: the activity watchdog
 * kills a silent turn within minutes, so reaching the limit almost always
 * means the agent was still working. 393 runs across 88 accounts in 30 days
 * ended here with a bare `Run failed.`, while the fix is one flag.
 */
function isRunTimeoutError(message: string): boolean {
  return message.startsWith("agent run timed out after");
}

function formatRunTimeoutSummary(input: { owner: string; name: string; raw: string }): string {
  const settingsUrl = `${getApiUrl()}/console/${input.owner}/${input.name}`;
  return [
    "**This run hit its time limit while still working, so it stopped before finishing.**",
    "",
    "Give runs longer with `--timeout=2h` (or `--notimeout`) in this repo's instructions — or raise the workflow's `timeout` input if it sets one, since that input wins. A smaller PR or a lower effort also finishes sooner.",
    "",
    `[Repo settings →](${settingsUrl}) · [Flags →](https://docs.pullfrog.com/flags)`,
    "",
    `\`\`\`\n${input.raw}\n\`\`\``,
  ].join("\n");
}

function formatContextOverflowSummary(input: { owner: string; name: string; raw: string }): string {
  const settingsUrl = `${getApiUrl()}/console/${input.owner}/${input.name}`;
  return [
    "**This run exceeded the model's context window.** Pullfrog read more than the model could hold, so it stopped before finishing.",
    "",
    `Pick a model with a larger context window, or split this PR into smaller ones and re-trigger.`,
    "",
    `[Model settings →](${settingsUrl}) · [Ask in Discord →](https://discord.gg/8y96raFg8e)`,
    "",
    `\`\`\`\n${input.raw}\n\`\`\``,
  ].join("\n");
}

/**
 * Generic failure copy for any shape not caught by a more specific classifier
 * (billing / api-key / hang / model-not-found). A plain-English lead sentence
 * so the user isn't staring at a raw internal string like
 * `opencode prompt failed: fetch failed`, followed by the actual error in a
 * fenced code block for anyone who needs the detail. Shared by both surfaces;
 * the job summary adds the `### ❌ Pullfrog failed` banner on top.
 */
function formatGenericFailure(errorMessage: string): string {
  return [
    "Pullfrog ran into an unexpected error and couldn't finish this run. The underlying error is below — re-trigger Pullfrog to try again, and reach out to support if it keeps happening.",
    "",
    "```",
    errorMessage,
    "```",
  ].join("\n");
}

/**
 * Minimal PR-comment body for non-actionable failures (hangs, unexpected
 * errors). The forensic detail (event counts, stderr tail, raw error) stays
 * in the Actions job summary; the comment the average user sees is one calm
 * line plus a link to the logs. The footer appended by `reportErrorToComment`
 * already carries rerun / model context.
 */
function formatMinimalFailureComment(repo: { owner: string; name: string }): string {
  const runId = process.env.GITHUB_RUN_ID;
  if (!runId) return "**Run failed.**";
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const url = `${server}/${repo.owner}/${repo.name}/actions/runs/${runId}`;
  return `**Run failed.** [View the logs →](${url})`;
}

/**
 * Billing top-up URL per provider id, from the shared dashboard table. A
 * provider `detectProviderId` cannot name falls through to a generic CTA.
 */
const PROVIDER_BILLING_URLS: Record<string, string> = Object.fromEntries(
  Object.entries(PROVIDER_DASHBOARDS).map(([id, dashboard]) => [id, dashboard.billing])
);

/**
 * `extractProviderId` only fires when the harness emits `providerID=...`
 * (OpenCode log shape). Direct-provider errors (e.g. Anthropic SDK throwing
 * `"Your credit balance is too low to access the Anthropic API"`) carry no
 * such tag, so map their distinctive copy to a provider id here so the
 * dashboard link is reachable.
 *
 * Pattern is intentionally tight (Anthropic-specific phrasing only) to
 * avoid mis-tagging non-Anthropic billing-exhausted errors that happen to
 * mention `"Anthropic API"` in passing — the broader phrase appears in
 * fallback-chain agent prompt text and OpenCode harness logs.
 */
function detectProviderId(message: string): string | null {
  const harnessId = extractProviderId(message);
  if (harnessId) return harnessId;
  if (/credit balance is too low/i.test(message)) return "anthropic";
  // xAI's exhaustion arrives via the opencode `session.error` path, which
  // carries no `providerID=` tag. its team-scoped phrasing is distinctive
  // enough to map on its own. see #1076.
  if (/used all available credits/i.test(message)) return "xai";
  // same gap, and it is the ONLY path #1135 is about: `providerID=` is folded in
  // by `withServerStderr`, which runs only on a `session.create` failure, so a
  // mid-run credit exhaustion arrives as bare wire text. without this the BYOK
  // fall-through lands on the linkless generic copy and the openrouter entry in
  // PROVIDER_BILLING_URLS is dead. see #1135.
  if (/requires more credits|Key limit exceeded \(total limit\)|openrouter\.ai/i.test(message)) {
    return "openrouter";
  }
  if (/platform\.openai\.com/i.test(message)) return "openai";
  return null;
}

/** OpenRouter's data-policy page, which decides what it may route to. */
const OPENROUTER_PRIVACY_URL = "https://openrouter.ai/settings/privacy";

function formatProviderBillingExhausted(input: { errorMessage: string }): string {
  const providerId = detectProviderId(input.errorMessage);
  const dashboardUrl = providerId ? PROVIDER_BILLING_URLS[providerId] : undefined;

  // a per-key ceiling is not an empty wallet, and topping up alone does not
  // clear it — the affordable figure drifts run to run while the wallet holds
  // credit. name both levers, key limit first. see #1164.
  if (isOpenRouterKeyLimitExceeded(input.errorMessage)) {
    return [
      "**Your OpenRouter key's total limit is too low for this request.**",
      "",
      "OpenRouter refused the request against the key's own spending ceiling, not your account balance — raising or removing that limit is the fix, and topping up credits alone may not be.",
      "",
      `[Raise the key's limit →](${PROVIDER_DASHBOARDS.openrouter.keys}) · [Add credits →](${PROVIDER_BILLING_URLS.openrouter})`,
      "",
      `\`\`\`\n${input.errorMessage}\n\`\`\``,
    ].join("\n");
  }

  // a Console-set spend cap is not an empty wallet — topping up clears nothing,
  // and the provider already told us when access comes back. see #1208.
  const spendCap = findAnthropicSpendCap(input.errorMessage);
  if (spendCap) {
    const regains = spendCap.regainAt ? ` Access returns on **${spendCap.regainAt}**.` : "";
    return [
      `**Your \`anthropic\` account has reached its configured API usage limit.**${regains}`,
      "",
      "Anthropic refused the request against a spend limit set in your Console, not an empty balance — raise or remove that limit to run before it resets.",
      "",
      `[Anthropic billing settings →](${PROVIDER_BILLING_URLS.anthropic})`,
      "",
      `\`\`\`\n${input.errorMessage}\n\`\`\``,
    ].join("\n");
  }

  const headline = providerId
    ? `**Your \`${providerId}\` account is out of credit.**`
    : "**Your provider account is out of credit.**";
  const cta = dashboardUrl
    ? `[Top up \`${providerId}\` →](${dashboardUrl})`
    : "Top up your provider account, then re-trigger Pullfrog.";

  return [
    headline,
    "",
    "Pullfrog detected a billing-exhausted response from your provider — the agent stopped before completing this run.",
    "",
    cta,
    "",
    `\`\`\`\n${input.errorMessage}\n\`\`\``,
  ].join("\n");
}

/**
 * A transient upstream failure — the model provider 5xx'd or dropped the
 * stream. Nothing the user configured is wrong, so the only useful thing to
 * say is which provider, that it was upstream, and that re-triggering is the
 * remedy.
 */
function formatTransientUpstreamBody(errorMessage: string): string {
  const providerId = detectProviderId(errorMessage);
  const who = providerId ? `\`${providerId}\`` : "the model provider";
  return [
    `**${who} had a temporary upstream failure.**`,
    "",
    "The provider refused or dropped the request mid-run — nothing in your repo or your credentials is at fault. Re-trigger Pullfrog; if it keeps happening, check the provider's status page.",
    "",
    `\`\`\`\n${errorMessage}\n\`\`\``,
  ].join("\n");
}

/**
 * OpenRouter has nowhere it is permitted to route the picked model. Nothing is
 * billed and no key is at fault, so neither the billing nor the api-key copy
 * fits — both would send the user to fix something that is not broken.
 */
function formatProviderNoRoutableEndpoints(input: {
  owner: string;
  name: string;
  errorMessage: string;
}): string {
  return [
    "**OpenRouter can't route this model anywhere your account allows.**",
    "",
    "Your OpenRouter data policy excludes every provider currently serving the configured model, so the request was refused before any model work happened. Allow more providers, or pick a model your policy already covers.",
    "",
    `[OpenRouter data policy →](${OPENROUTER_PRIVACY_URL}) · [Configure model →](${getApiUrl()}/console/${input.owner}/${input.name})`,
    "",
    `\`\`\`\n${input.errorMessage}\n\`\`\``,
  ].join("\n");
}

function formatProviderMissingCredential(input: {
  owner: string;
  name: string;
  errorMessage: string;
}): string {
  return [
    "**No credential reached the model provider.**",
    "",
    "The run started without a key for the provider it ended up using, so the request was refused before any model work happened. Nothing was billed, and no key of yours was rejected — add a provider key, or pick a model you already have one for.",
    "",
    `[Configure model →](${getApiUrl()}/console/${input.owner}/${input.name})`,
    "",
    `\`\`\`\n${input.errorMessage}\n\`\`\``,
  ].join("\n");
}

/**
 * A BYOK provider setup is incomplete. The thrown message is already
 * customer-ready — what is missing, the remedy, a docs link — so it is passed
 * through verbatim under a headline and a console link rather than rewritten.
 */
function formatByokSetupSummary(input: { owner: string; name: string; raw: string }): string {
  return [
    "**This repo's model isn't fully set up yet.**",
    "",
    input.raw,
    "",
    `[Configure model →](${getApiUrl()}/console/${input.owner}/${input.name})`,
  ].join("\n");
}

function formatProviderModelNotFoundSummary(input: {
  owner: string;
  name: string;
  raw: string;
}): string {
  return (
    `The configured model is not in OpenCode's catalog. ` +
    `Pick a different model for \`${input.owner}/${input.name}\` where it is set — the Pullfrog console, ` +
    `the workflow's \`model\` input, or the \`PULLFROG_MODEL\` variable — ` +
    `or contact support if this persists.\n\n` +
    `\`\`\`\n${input.raw}\n\`\`\``
  );
}

/**
 * A capped usage window or a configured usage limit, not an empty wallet: the
 * billing copy's "top up" clears nothing. Codex/ChatGPT and Go plans reset on
 * their own; a Zen pay-as-you-go workspace limit is one the user set.
 */
function formatProviderUsageLimit(input: { owner: string; name: string; raw: string }): string {
  return [
    "**The provider's usage limit for this account has been reached.**",
    "",
    "A subscription window resets on its own, so re-trigger after it does; a limit set on a pay-as-you-go workspace has to be raised. A model on another provider can run in the meantime.",
    "",
    `[Model settings →](${getApiUrl()}/console/${input.owner}/${input.name}) · [Ask in Discord →](https://discord.gg/8y96raFg8e)`,
    "",
    `\`\`\`\n${input.raw}\n\`\`\``,
  ].join("\n");
}

/**
 * A `provider error: ` message is the harness's own marker that the failure came
 * from the model provider's side, carrying either the provider's text (opencode)
 * or our classifier label for it (`auth error (401)`, claude-code and codex). Unlike an internal string it
 * names something the user can act on, so it is never collapsed to `Run failed.`.
 */
function formatProviderErrorBody(input: { owner: string; name: string; raw: string }): string {
  return [
    "**The model provider returned an error, so this run stopped.**",
    "",
    "The error is below. If it names your key, plan or balance, fix that with the provider or pick another model before re-triggering.",
    "",
    `[Model settings →](${getApiUrl()}/console/${input.owner}/${input.name}) · [Ask in Discord →](https://discord.gg/8y96raFg8e)`,
    "",
    `\`\`\`\n${input.raw}\n\`\`\``,
  ].join("\n");
}

export function renderRunError(input: {
  errorMessage: string;
  repo: { owner: string; name: string };
  agentDiagnostic: AgentDiagnostic | undefined;
  /** the run is spending Pullfrog's Router wallet (a proxy key was minted), not
   * the user's own provider credential. `payload.proxyModel` at both call
   * sites. */
  routerActive: boolean;
}): RenderedRunError {
  // reclassify mid-run OpenRouter "key budget exhausted" as BillingError so
  // the user gets the same actionable copy as a /api/proxy-token 402.
  //
  // gated on `routerActive`: the identical wire text is emitted when a BYOK
  // customer's OWN OpenRouter wallet runs dry, and sending them to top up a
  // Pullfrog Router balance they don't use is advice that cannot work. on a BYOK
  // run this falls through to the provider-billing branch below, which now
  // matches the same shapes and links openrouter.ai instead. see #1135.
  const billingError =
    input.routerActive && isRouterKeylimitExhaustedError(input.errorMessage)
      ? new BillingError(input.errorMessage, { code: "router_keylimit_exhausted" })
      : null;

  if (billingError) {
    const body = formatBillingErrorSummary(billingError, input.repo.owner);
    return { summary: body, comment: body };
  }

  // model-access gate (explicit `--model`/family flag the run can't serve):
  // the thrown message already IS the rendered markdown body (built by
  // `buildModelAccessError`), so surface it verbatim on both surfaces.
  if (input.errorMessage.includes(MODEL_ACCESS_MARKER)) {
    return { summary: input.errorMessage, comment: input.errorMessage };
  }

  // run-context couldn't hand over Pullfrog-stored secrets. same verbatim
  // contract as the model-access body above, and checked before the api-key
  // branch below so it can't be rewritten into a "go add a key" CTA — the key
  // is already there.
  if (input.errorMessage.includes(SECRETS_UNAVAILABLE_MARKER)) {
    return { summary: input.errorMessage, comment: input.errorMessage };
  }

  // an unfunded Router account whose BYOK search also came up empty. same
  // verbatim contract, and likewise ahead of the api-key branch — that branch
  // rebuilds any body carrying `no API key found` into the generic
  // "add a provider key" copy, which is the exact wrong CTA here.
  if (input.errorMessage.includes(ROUTER_UNFUNDED_MARKER)) {
    return { summary: input.errorMessage, comment: input.errorMessage };
  }

  // a credential the provider rejected before the agent started. the body
  // already names the credential and its real remedy, and it QUOTES the
  // provider's wording — so without this guard the api-key branch below sniffs
  // that quote and rebuilds it into the generic "rotate your key" CTA.
  // the credential pool's refusal quotes one verdict per credential, same contract.
  if (
    input.errorMessage.includes(CREDENTIAL_REJECTED_MARKER) ||
    input.errorMessage.includes(CREDENTIAL_POOL_REFUSED_MARKER)
  ) {
    return { summary: input.errorMessage, comment: input.errorMessage };
  }

  // gated on isHang because the harness sets `agentDiagnostic` on entry, so
  // any non-hang throw that hits the outer catch (e.g. post-success
  // output_schema validator, or a late cleanup throw after the run already
  // succeeded) would otherwise render "Pullfrog failed" with stale event
  // counts and silently drop the real errorMessage.
  const isHang =
    input.errorMessage.startsWith("activity timeout") ||
    input.errorMessage.startsWith("agent still pending");
  const hangBody = isHang
    ? formatAgentHangBody({
        diagnostic: input.agentDiagnostic,
        isHang: true,
        errorMessage: input.errorMessage,
      })
    : null;

  // BYOK provider billing-exhausted (DeepSeek "Insufficient Balance",
  // Anthropic "credit balance is too low", OpenCode Zen `CreditsError` /
  // `FreeUsageLimitError`, Gemini "spending cap"). distinct from the Router
  // billing branches above — Router uses `BillingError`, this uses the agent
  // log payload classified by `isProviderBillingExhausted`. see #835.
  //
  // checked BEFORE api-key auth: providers commonly return 401 (DeepSeek,
  // Gemini) or include `"API Error: 401"` in the error body for billing
  // exhaustion, which `isApiKeyAuthError` would otherwise match — surfacing
  // a "rotate your key" CTA when the actual fix is "top up credits".
  if (isProviderBillingExhausted(input.errorMessage)) {
    const body = formatProviderBillingExhausted({ errorMessage: input.errorMessage });
    return { summary: `### ❌ Pullfrog failed\n\n${body}`, comment: body };
  }

  // routable-endpoint refusal, checked alongside the billing branch for the
  // same reason: it is user-fixable provider configuration, and the generic
  // renderer below would surface the raw wire text with no CTA at all.
  if (isProviderNoRoutableEndpoints(input.errorMessage)) {
    const body = formatProviderNoRoutableEndpoints({
      owner: input.repo.owner,
      name: input.repo.name,
      errorMessage: input.errorMessage,
    });
    return { summary: `### ❌ Pullfrog failed\n\n${body}`, comment: body };
  }

  // a usage window, not a wallet or a key — ahead of the api-key branch for the
  // same reason the billing branch is.
  if (isProviderUsageLimit(input.errorMessage)) {
    const body = formatProviderUsageLimit({
      owner: input.repo.owner,
      name: input.repo.name,
      raw: input.errorMessage,
    });
    return { summary: `### ❌ Pullfrog failed\n\n${body}`, comment: body };
  }

  // an ABSENT credential, not a rejected one — the remedies share nothing. neither pattern
  // matches `isApiKeyAuthError` today; both previously fell through to the generic renderer
  // with no CTA at all. checked ahead of the api-key branch so a later widening there cannot
  // start answering "rotate your key" to a run that never held one.
  if (isProviderMissingCredential(input.errorMessage)) {
    const body = formatProviderMissingCredential({
      owner: input.repo.owner,
      name: input.repo.name,
      errorMessage: input.errorMessage,
    });
    return { summary: `### ❌ Pullfrog failed\n\n${body}`, comment: body };
  }

  // both BYOK setup layers — `resolveSlug`'s routing-slug refusal and the
  // per-provider `validate*Setup` checks — already name what is missing, the
  // remedy and the docs page. none carries provider or status text, so nothing
  // above matches them and the generic branch below collapsed the comment to
  // `Run failed.`, writing the answer to the job summary and nowhere the
  // customer looks.
  if (isByokSetupError(input.errorMessage)) {
    const body = formatByokSetupSummary({
      owner: input.repo.owner,
      name: input.repo.name,
      raw: input.errorMessage,
    });
    return { summary: `### ❌ Pullfrog failed\n\n${body}`, comment: body };
  }

  const apiKeySource = hangBody ?? input.errorMessage;
  const apiKeyErrorSummary = isApiKeyAuthError(apiKeySource)
    ? formatApiKeyErrorSummary({
        owner: input.repo.owner,
        name: input.repo.name,
        raw: apiKeySource,
      })
    : null;

  if (apiKeyErrorSummary) {
    return { summary: apiKeyErrorSummary, comment: apiKeyErrorSummary };
  }

  if (isProviderModelNotFoundError(input.errorMessage)) {
    const body = formatProviderModelNotFoundSummary({
      owner: input.repo.owner,
      name: input.repo.name,
      raw: input.errorMessage,
    });
    return { summary: body, comment: body };
  }

  if (isNoProviderAvailableError(input.errorMessage)) {
    const body = formatNoProviderAvailableSummary({
      owner: input.repo.owner,
      name: input.repo.name,
      raw: input.errorMessage,
    });
    return { summary: `### ❌ Pullfrog failed\n\n${body}`, comment: body };
  }

  if (isZenFreeTierGateError(input.errorMessage)) {
    const body = formatZenFreeTierGateSummary({
      owner: input.repo.owner,
      name: input.repo.name,
      raw: input.errorMessage,
    });
    return { summary: `### ❌ Pullfrog failed\n\n${body}`, comment: body };
  }

  // actionable, so it renders identically on both surfaces rather than
  // collapsing the comment to the hang/generic one-liner. see #1116.
  if (isContextOverflowError(input.errorMessage)) {
    const body = formatContextOverflowSummary({
      owner: input.repo.owner,
      name: input.repo.name,
      raw: input.errorMessage,
    });
    return { summary: `### ❌ Pullfrog failed\n\n${body}`, comment: body };
  }

  if (isRunTimeoutError(input.errorMessage)) {
    const body = formatRunTimeoutSummary({
      owner: input.repo.owner,
      name: input.repo.name,
      raw: input.errorMessage,
    });
    return { summary: `### ❌ Pullfrog failed\n\n${body}`, comment: body };
  }

  // an upstream blip is not ours, but the silence about it was: the provider
  // handed us accurate, actionable copy and the comment said `Run failed.`
  // while up to 38 tool calls of finished review work went in the bin (#1173).
  // last of the classified branches, so every specific one still wins.
  if (isTransientUpstreamError(input.errorMessage)) {
    const body = formatTransientUpstreamBody(input.errorMessage);
    return { summary: `### ❌ Pullfrog failed\n\n${body}`, comment: body };
  }

  if (hangBody) {
    // a hang masking billing exhaustion (#778) renders an actionable top-up
    // CTA inside `hangBody` — keep that in the comment. every other hang is
    // non-actionable noise for the average user, so the comment collapses to
    // a one-liner and the diagnostic stays in the Actions job summary.
    //
    // the test is "did we classify the provider's own refusal", not the single
    // billing label: `quota error`, `rate limited` and the `auth error (*)`
    // family are as actionable as an empty wallet, and pinning it to one label
    // gave 17 customers a blank comment while we held a message naming their
    // quota's reset time (#1183). an unexplained hang still collapses.
    //
    // silence is explained too: whether opencode writes a `stream error` inside
    // the watchdog window is luck, so one Zen throttling episode rendered `rate
    // limited` on one run and a blank comment on the next in the same repo.
    // `sawModelOutput` is the condition itself rather than a trace of it.
    const explained =
      input.agentDiagnostic?.lastProviderError !== undefined ||
      input.agentDiagnostic?.sawModelOutput === false;
    return {
      summary: `### ❌ Pullfrog failed\n\n${hangBody}`,
      comment: explained ? hangBody : formatMinimalFailureComment(input.repo),
    };
  }

  // after every specific classifier, so it only catches the wording none of them
  // knows yet — which used to collapse to `Run failed.` (#1474).
  if (input.errorMessage.startsWith("provider error: ")) {
    const body = formatProviderErrorBody({
      owner: input.repo.owner,
      name: input.repo.name,
      raw: input.errorMessage,
    });
    return { summary: `### ❌ Pullfrog failed\n\n${body}`, comment: body };
  }

  const genericBody = formatGenericFailure(input.errorMessage);
  return {
    summary: `### ❌ Pullfrog failed\n\n${genericBody}`,
    comment: formatMinimalFailureComment(input.repo),
  };
}
