/**
 * Classify + render the error thrown out of the main run try-block into the
 * markdown the user reads — the PR progress comment, and the same body under a
 * `### ❌ Pullfrog failed` banner in the GitHub Actions job summary.
 *
 * Every body names its cause, so none collapses to a bare "Run failed.": an
 * error nothing below recognizes is shown as-is under "An unrecognized error
 * occurred." The shape is `renderFailure`'s, so the copy rules hold for all of
 * them — see `failureBody.ts`.
 *
 * Classifications, in dispatch order (first match wins):
 *
 *   1. Trial credits — a trial key that ran out mid-run is the account's free
 *      credits running out, never the Router wallet the same wire text means
 *      on a Router run.
 *
 *   1a. `BillingError` — the agent runtime surfaced an OpenRouter "key budget
 *      exhausted" string mid-run on a Router run. Same copy as a proxy-token 402.
 *
 *   1b. Pre-rendered bodies — a throw site that already built the markdown
 *      (`MODEL_ACCESS_MARKER`, `SECRETS_UNAVAILABLE_MARKER`,
 *      `ROUTER_UNFUNDED_MARKER`, `TRIAL_SPENT_MARKER`,
 *      `CREDENTIAL_REJECTED_MARKER`, `CREDENTIAL_POOL_REFUSED_MARKER`,
 *      `KEYLESS_UNUSABLE_MARKER`) passes
 *      through verbatim.
 *
 *   2. BYOK provider billing-exhausted (#835) — DeepSeek "Insufficient
 *      Balance", Anthropic "credit balance is too low", OpenCode Zen
 *      `CreditsError`, Gemini "spending cap", a ChatGPT workspace out of
 *      credits. Checked before api-key auth because billing-exhausted responses
 *      often carry 401 status codes that `isApiKeyAuthError` would otherwise
 *      mis-classify.
 *
 *   2a. Provider usage limit (#1474) — a capped subscription window or a
 *      configured workspace limit; "wait or raise it", never "top up".
 *
 *   3. API-key auth error — `isApiKeyAuthError` sniffs the raw error string
 *      (or the activity-timeout hang body when present, since that's where
 *      the underlying provider error often lands).
 *
 *   4. Model not in OpenCode's catalog (opencode ≥1.18 words it `Model not
 *      found: <id>`, #1470), a provider declining the model (#1077), Zen's
 *      free-tier gate (#1377), context overflow (#1116), the run's time limit,
 *      the repo's stop script, and an agent that never posted its review.
 *
 *   4c. Transient upstream failure (#1173) — Anthropic `529 Overloaded`,
 *      OpenRouter `provider_unavailable` / `timeout`, Zen `Streaming response
 *      failed: [5xx]`, Codex's model at capacity. Last of the classified
 *      branches so every more specific one wins first.
 *
 *   5. Activity-timeout hang — `formatAgentHangBody` says whose side went
 *      quiet, with the agent's last output collapsed under it.
 *
 *   6. Unclassified provider error (#1474) — `errorMessage` starts with
 *      `provider error: `: the provider's own text, shown under a lead line.
 *
 *   7. Default — "An unrecognized error occurred." over the error itself.
 */

import type { AgentCredential } from "../agents/shared.ts";
import type { AgentDiagnostic } from "./agentHangReport.ts";
import { formatAgentHangBody } from "./agentHangReport.ts";
import {
  buildTrialSpentError,
  CREDENTIAL_POOL_REFUSED_MARKER,
  CREDENTIAL_REJECTED_MARKER,
  formatApiKeyErrorSummary,
  isApiKeyAuthError,
  isByokSetupError,
  KEYLESS_UNUSABLE_MARKER,
  pickModelLink,
  providerDisplayName,
  providerLink,
  ROUTER_UNFUNDED_MARKER,
  repoConsoleUrl,
  SECRETS_UNAVAILABLE_MARKER,
  subscriptionFor,
  TRIAL_SPENT_MARKER,
} from "./apiKeys.ts";
import { BillingError, formatBillingErrorSummary } from "./billingErrors.ts";
import { DISCORD_LINK, renderFailure } from "./failureBody.ts";
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

type RenderRunErrorInput = {
  errorMessage: string;
  repo: { owner: string; name: string };
  agentDiagnostic: AgentDiagnostic | undefined;
  /** the run is spending Pullfrog's Router wallet (a proxy key was minted), not
   * the user's own provider credential. `payload.proxyModel` at both call
   * sites. */
  routerActive: boolean;
  /** the model that ran: it names the provider, and the subscription when one is in play. */
  model?: string | undefined;
  credential?: AgentCredential | undefined;
  /** the run was served by the account's free trial credits. */
  trial?: boolean | undefined;
  /** why opencode's live model catalog could not be downloaded, leaving it on its build-time snapshot. */
  modelsCatalogFailure?: string | undefined;
};

/** who answered the request, as the customer knows them. */
type Account = {
  /** "OpenAI", "Codex / ChatGPT", or null when nothing names the provider. */
  name: string | null;
  /** "ChatGPT subscription", "OpenAI account" or "model provider account". */
  phrase: string;
  /** the account's billing page, when we know it. */
  billingUrl: string | undefined;
  subscription: boolean;
};

type RenderContext = RenderRunErrorInput & { account: Account };

/** opencode <1.18 names the error class; ≥1.18 only publishes `Model not found: <id>` (#1470). */
function isProviderModelNotFoundError(message: string): boolean {
  return /ProviderModelNotFoundError|\bModel not found: /.test(message);
}

/**
 * Terminal context-window overflow (#1116). The run did real work — 5-12
 * minutes of it — and then died with no review, so the two levers the user has
 * (a larger-context model, or a smaller PR) are the whole message. Covers the
 * Claude CLI (`Prompt is too long`), the OpenRouter/opencode endpoint rejection
 * (`maximum context length is N tokens`), and opencode's post-compaction give-up.
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

/**
 * The run's own time limit (`main.ts`), not a hang: the activity watchdog
 * kills a silent turn within minutes, so reaching the limit almost always
 * means the agent was still working. 393 runs across 88 accounts in 30 days
 * ended here with a bare `Run failed.`, while the fix is one flag.
 */
const RUN_TIMEOUT_PATTERN = /^agent run timed out after (\S+)/;

/** `postRun`'s gate: the repo's stop script still failed after the agent's retries. */
const STOP_SCRIPT_PATTERN = /^stop hook failed \(exit code (-?\d+)\): ([\s\S]*)$/;

/** `postRun`'s gate: a review-mode run ended without submitting its review. */
const UNSUBMITTED_REVIEW_PATTERN = /^\w+ mode finished without calling /;

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
  // PROVIDER_DASHBOARDS is dead. see #1135.
  if (/requires more credits|Key limit exceeded \(total limit\)|openrouter\.ai/i.test(message)) {
    return "openrouter";
  }
  if (/platform\.openai\.com/i.test(message)) return "openai";
  return null;
}

/**
 * The error's own provider when it names one, else the model's. A subscription
 * run is named by its plan — "Your ChatGPT subscription", with the plan's
 * billing page — because the API account's dashboard is the wrong place for it.
 */
function resolveAccount(input: RenderRunErrorInput): Account {
  const subscription =
    input.credential === "subscription" ? subscriptionFor(input.model) : undefined;
  if (subscription) {
    const plan = Object.values(PROVIDER_DASHBOARDS).find(
      (dashboard) => dashboard.credential === subscription.env
    );
    return {
      name: plan?.name ?? null,
      phrase: subscription.label,
      billingUrl: plan?.billing,
      subscription: true,
    };
  }
  const id = detectProviderId(input.errorMessage) ?? input.model?.split("/")[0] ?? null;
  const dashboard = id ? PROVIDER_DASHBOARDS[id] : undefined;
  const name = dashboard?.name ?? providerDisplayName(id) ?? null;
  return {
    name,
    phrase: name ? `${name} account` : "model provider account",
    billingUrl: dashboard?.billing,
    subscription: false,
  };
}

/** the provider's own words, collapsed under the copy. */
function providerResponse(ctx: RenderContext) {
  return {
    summary: ctx.account.name ? `${ctx.account.name}'s response` : "The provider's response",
    text: ctx.errorMessage,
  };
}

function formatProviderBillingExhausted(ctx: RenderContext): string {
  // a per-key ceiling is not an empty wallet, and topping up alone does not
  // clear it — the affordable figure drifts run to run while the wallet holds
  // credit. name both levers, key limit first. see #1164.
  if (isOpenRouterKeyLimitExceeded(ctx.errorMessage)) {
    const openrouter = PROVIDER_DASHBOARDS.openrouter;
    return renderFailure({
      headline: "Your OpenRouter key's spending limit is too low for this request.",
      detail:
        "OpenRouter checks the key's own limit as well as your balance, so raise or remove the limit; adding credit alone may not be enough.",
      details: providerResponse(ctx),
      links: openrouter?.keys
        ? [
            { label: "Raise the key's limit", url: openrouter.keys },
            { label: "Add credit", url: openrouter.billing },
          ]
        : [],
    });
  }

  // a Console-set spend cap is not an empty wallet — topping up clears nothing,
  // and the provider already told us when access comes back. see #1208.
  const spendCap = findAnthropicSpendCap(ctx.errorMessage);
  if (spendCap) {
    const regains = spendCap.regainAt ? `Access returns on **${spendCap.regainAt}**. ` : "";
    const anthropic = PROVIDER_DASHBOARDS.anthropic;
    return renderFailure({
      headline: "Your Anthropic account has reached its API spend limit.",
      detail: `${regains}This is a limit set in your Anthropic Console, not an empty balance; raise or remove it to run before then.`,
      details: providerResponse(ctx),
      links: anthropic ? [{ label: "Anthropic billing settings", url: anthropic.billing }] : [],
    });
  }

  return renderFailure({
    headline: `Your ${ctx.account.phrase} is out of credit.`,
    detail: "Top it up, then re-trigger Pullfrog.",
    details: providerResponse(ctx),
    links: ctx.account.billingUrl
      ? [{ label: `Top up ${ctx.account.name}`, url: ctx.account.billingUrl }]
      : [],
  });
}

/**
 * A capped usage window or a configured usage limit, not an empty wallet: the
 * billing copy's "top up" clears nothing. Codex/ChatGPT and Go plans reset on
 * their own; a Zen pay-as-you-go workspace limit is one the user set.
 */
function formatProviderUsageLimit(ctx: RenderContext): string {
  // the Codex CLI names the reset in the runner's own clock: `try again at 7:58 AM`.
  const tryAgainAt = /try again at (\d{1,2}:\d{2}\s*[AP]M)/i.exec(ctx.errorMessage)?.[1];
  const resets = tryAgainAt
    ? `${ctx.account.name ?? "The provider"} says to try again at ${tryAgainAt}. `
    : "";
  return renderFailure({
    headline: `Your ${ctx.account.phrase} has hit its usage limit.`,
    detail: ctx.account.subscription
      ? `${resets}It resets on its own, so re-trigger after that, or connect an API key, which Pullfrog falls back to automatically.`
      : `${resets}Raise the limit with the provider, or re-trigger once it resets.`,
    details: providerResponse(ctx),
    links: [providerLink(ctx.repo.owner), pickModelLink(ctx.repo)],
  });
}

/**
 * A transient upstream failure — the model provider 5xx'd, dropped the stream,
 * or has no capacity for the model. Nothing the user configured is wrong, so
 * the only useful thing to say is which provider, and that re-triggering is the
 * remedy.
 */
function formatTransientUpstreamBody(ctx: RenderContext): string {
  if (/\bmodel is at capacity\b/i.test(ctx.errorMessage)) {
    return renderFailure({
      headline: `${ctx.account.name ? `${ctx.account.name}'s model` : "The model"} is at capacity right now.`,
      detail: "Re-trigger in a few minutes, or pick another model.",
      details: providerResponse(ctx),
      links: [pickModelLink(ctx.repo)],
    });
  }
  return renderFailure({
    headline: `${ctx.account.name ?? "The model provider"} had a temporary failure.`,
    detail:
      "Nothing on your side is at fault. Re-trigger to try again; if it keeps happening, check the provider's status page.",
    details: providerResponse(ctx),
  });
}

/**
 * OpenRouter has nowhere it is permitted to route the picked model. Nothing is
 * billed and no key is at fault, so neither the billing nor the api-key copy
 * fits — both would send the user to fix something that is not broken.
 */
function formatProviderNoRoutableEndpoints(ctx: RenderContext): string {
  return renderFailure({
    headline: "OpenRouter can't route this model anywhere your account allows.",
    detail:
      "Your OpenRouter data policy excludes every provider serving it, so nothing ran and nothing was billed. Allow more providers, or pick a model your policy covers.",
    details: providerResponse(ctx),
    links: [
      { label: "OpenRouter data policy", url: "https://openrouter.ai/settings/privacy" },
      pickModelLink(ctx.repo),
    ],
  });
}

function formatProviderMissingCredential(ctx: RenderContext): string {
  return renderFailure({
    headline: "No credential reached the model provider.",
    detail:
      "The run used a provider it had no key for, so nothing was billed and no key of yours was rejected. Connect a key for that provider, or pick a model you have one for.",
    details: providerResponse(ctx),
    links: [providerLink(ctx.repo.owner), pickModelLink(ctx.repo)],
  });
}

function formatProviderModelNotFound(ctx: RenderContext): string {
  const model = /Model not found: (\S+?)\.?(?:\s|$)/.exec(ctx.errorMessage)?.[1];
  const suggestions = /Did you mean: ([^?\n]+)\?/
    .exec(ctx.errorMessage)?.[1]
    ?.split(",")
    .map((id) => `\`${id.trim()}\``);
  const suggested = suggestions?.length
    ? ` OpenCode suggests ${suggestions.slice(0, -1).join(", ")}${suggestions.length > 1 ? " or " : ""}${suggestions.at(-1)}.`
    : "";
  if (ctx.modelsCatalogFailure) {
    return renderFailure({
      headline: model
        ? `OpenCode couldn't download its model list, so it didn't recognize \`${model}\`.`
        : "OpenCode couldn't download its model list, so it didn't recognize this repo's model.",
      detail: `It fell back to the copy built into it, which lacks models released since that build. Re-run once the runner can reach OpenCode's model catalog, or pick an older model.${suggested}`,
      details: {
        summary: "Why the download failed",
        text: `${ctx.modelsCatalogFailure}\n\n${ctx.errorMessage}`,
      },
      links: [pickModelLink(ctx.repo)],
    });
  }
  return renderFailure({
    headline: model
      ? `\`${model}\` isn't in OpenCode's catalog.`
      : "This repo's model isn't in OpenCode's catalog.",
    detail: `Pick another model wherever this repo sets it: the Pullfrog console, the workflow's \`model\` input or the \`PULLFROG_MODEL\` variable.${suggested}`,
    details: { summary: "OpenCode's response", text: ctx.errorMessage },
    links: [pickModelLink(ctx.repo)],
  });
}

function formatNoProviderAvailable(ctx: RenderContext): string {
  return renderFailure({
    headline: "The provider won't serve this model to this account.",
    detail:
      "It's in the catalog, but this account's plan can't reach it, which often happens when Pullfrog auto-selects it. Pin a model for this repo, or connect the provider that was picked.",
    details: providerResponse(ctx),
    links: [pickModelLink(ctx.repo), providerLink(ctx.repo.owner)],
  });
}

function formatZenFreeTierGate(ctx: RenderContext): string {
  return renderFailure({
    headline: "OpenCode Zen's free tier refused a request from this run.",
    detail:
      "Zen rejects free-model requests that don't list its built-in tools, and OpenCode's mid-run context compaction sends none ([upstream issue](https://github.com/anomalyco/opencode/issues/49587)). Pick a paid model, or split the PR so the run finishes before compaction. If this repo's `opencode.json` denies `bash`, `glob`, `grep` or `read`, remove that too.",
    details: { summary: "OpenCode Zen's response", text: ctx.errorMessage },
    links: [pickModelLink(ctx.repo)],
  });
}

/** the unclassified fallback, shown as-is: the error is the only explanation there is. */
function formatUnrecognized(ctx: RenderContext): string {
  return renderFailure({
    headline: "An unrecognized error occurred.",
    detail: "The error is below.",
    error: ctx.errorMessage,
    links: [DISCORD_LINK],
  });
}

function renderRunErrorBody(ctx: RenderContext): string {
  const message = ctx.errorMessage;

  // a trial key that ran out mid-run IS the account's trial credits running
  // out — the mint is gated on credits left and the key's limit is the whole
  // trial — so the Router copy below, about a wallet the account never had,
  // would be false. ahead of it for that reason.
  if (ctx.trial && isRouterKeylimitExhaustedError(message)) {
    return buildTrialSpentError({ owner: ctx.repo.owner });
  }

  // reclassify mid-run OpenRouter "key budget exhausted" as BillingError so
  // the user gets the same actionable copy as a /api/proxy-token 402.
  //
  // gated on `routerActive`: the identical wire text is emitted when a BYOK
  // customer's OWN OpenRouter wallet runs dry, and sending them to top up a
  // Pullfrog Router balance they don't use is advice that cannot work. on a BYOK
  // run this falls through to the provider-billing branch below, which now
  // matches the same shapes and links openrouter.ai instead. see #1135.
  if (ctx.routerActive && isRouterKeylimitExhaustedError(message)) {
    return formatBillingErrorSummary(
      new BillingError(message, { code: "router_keylimit_exhausted" }),
      ctx.repo.owner
    );
  }

  // a throw site that already rendered its body (model access, stored secrets
  // unavailable, unfunded Router, spent trial, a credential rejected before the
  // agent started, the credential pool's refusal). ahead of the api-key branch,
  // which rebuilds any body carrying provider wording into the generic "rotate
  // your key" copy — and the rejection bodies QUOTE the provider's wording.
  if (
    [
      MODEL_ACCESS_MARKER,
      SECRETS_UNAVAILABLE_MARKER,
      ROUTER_UNFUNDED_MARKER,
      TRIAL_SPENT_MARKER,
      CREDENTIAL_REJECTED_MARKER,
      CREDENTIAL_POOL_REFUSED_MARKER,
      KEYLESS_UNUSABLE_MARKER,
    ].some((marker) => message.includes(marker))
  ) {
    return message;
  }

  // gated on isHang because the harness sets `agentDiagnostic` on entry, so
  // any non-hang throw that hits the outer catch (e.g. post-success
  // output_schema validator, or a late cleanup throw after the run already
  // succeeded) would otherwise render a stall with a stale diagnostic and
  // silently drop the real errorMessage.
  const isHang =
    message.startsWith("activity timeout") || message.startsWith("agent still pending");
  const hangBody = isHang
    ? formatAgentHangBody({ diagnostic: ctx.agentDiagnostic, errorMessage: message })
    : null;

  // BYOK provider billing-exhausted. distinct from the Router billing branch
  // above — Router uses `BillingError`, this uses the agent log payload
  // classified by `isProviderBillingExhausted`. see #835.
  //
  // checked BEFORE api-key auth: providers commonly return 401 (DeepSeek,
  // Gemini) or include `"API Error: 401"` in the error body for billing
  // exhaustion, which `isApiKeyAuthError` would otherwise match — surfacing
  // a "rotate your key" CTA when the actual fix is "top up credits".
  if (isProviderBillingExhausted(message)) return formatProviderBillingExhausted(ctx);

  // routable-endpoint refusal, checked alongside the billing branch for the
  // same reason: it is user-fixable provider configuration.
  if (isProviderNoRoutableEndpoints(message)) return formatProviderNoRoutableEndpoints(ctx);

  // a usage window, not a wallet or a key — ahead of the api-key branch for the
  // same reason the billing branch is.
  if (isProviderUsageLimit(message)) return formatProviderUsageLimit(ctx);

  // an ABSENT credential, not a rejected one — the remedies share nothing.
  // checked ahead of the api-key branch so a later widening there cannot start
  // answering "rotate your key" to a run that never held one.
  if (isProviderMissingCredential(message)) return formatProviderMissingCredential(ctx);

  // both BYOK setup layers — `resolveSlug`'s routing-slug refusal and the
  // per-provider `validate*Setup` checks — already name what is missing, the
  // remedy and the setup guide.
  if (isByokSetupError(message)) {
    return renderFailure({
      headline: "This repo's model isn't fully set up yet.",
      detail: message,
    });
  }

  const apiKeySource = hangBody ?? message;
  if (isApiKeyAuthError(apiKeySource)) {
    return formatApiKeyErrorSummary({
      owner: ctx.repo.owner,
      name: ctx.repo.name,
      raw: apiKeySource,
      model: ctx.model,
      credential: ctx.credential,
      output: hangBody ? undefined : message,
    });
  }

  if (isProviderModelNotFoundError(message)) return formatProviderModelNotFound(ctx);
  if (isNoProviderAvailableError(message)) return formatNoProviderAvailable(ctx);
  if (isZenFreeTierGateError(message)) return formatZenFreeTierGate(ctx);

  if (isContextOverflowError(message)) {
    return renderFailure({
      headline: "This run outgrew the model's context window.",
      detail:
        "Pick a model with a larger context window, or split the PR into smaller ones and re-trigger.",
      links: [pickModelLink(ctx.repo)],
    });
  }

  const timeout = RUN_TIMEOUT_PATTERN.exec(message)?.[1];
  if (timeout) {
    return renderFailure({
      headline: `This run hit its ${timeout} time limit while still working.`,
      detail:
        "Give runs longer with `--timeout=2h` (or `--notimeout`) in this repo's instructions, or raise the workflow's `timeout` input if it sets one, since that input wins. A smaller PR or a lower effort also finishes sooner.",
      links: [
        { label: "Repo settings", url: repoConsoleUrl(ctx.repo) },
        { label: "Flags", url: "https://docs.pullfrog.com/flags" },
      ],
    });
  }

  const stopScript = STOP_SCRIPT_PATTERN.exec(message);
  if (stopScript) {
    return renderFailure({
      headline: "This repo's stop script failed, so the run ended without finishing.",
      detail: `It exited with code ${stopScript[1]}. Fix the script in this repo's settings, or re-trigger if the failure was temporary.`,
      details: stopScript[2]?.trim()
        ? { summary: "Script output", text: stopScript[2].trim() }
        : undefined,
      links: [{ label: "Repo settings", url: repoConsoleUrl(ctx.repo) }],
    });
  }

  if (UNSUBMITTED_REVIEW_PATTERN.test(message)) {
    return renderFailure({
      headline: "The agent finished without posting its review.",
      detail: "It was reminded and still didn't, so the run stopped. Re-trigger to try again.",
    });
  }

  // an upstream blip is not ours, but the silence about it was: the provider
  // handed us accurate, actionable copy and the comment said `Run failed.`
  // while up to 38 tool calls of finished review work went in the bin (#1173).
  // last of the classified branches, so every specific one still wins.
  if (isTransientUpstreamError(message)) return formatTransientUpstreamBody(ctx);

  if (hangBody) return hangBody;

  // after every specific classifier, so it only catches the wording none of them
  // knows yet. the provider's text is the explanation, so it is shown open.
  if (message.startsWith("provider error: ")) {
    return renderFailure({
      headline: `${ctx.account.name ?? "The model provider"} returned an error, so this run stopped.`,
      detail:
        "If it names your key, plan or balance, fix that with the provider or pick another model.",
      error: message.slice("provider error: ".length),
      links: [pickModelLink(ctx.repo)],
    });
  }

  return formatUnrecognized(ctx);
}

export function renderRunError(input: RenderRunErrorInput): RenderedRunError {
  const body = renderRunErrorBody({ ...input, account: resolveAccount(input) });
  return { summary: `### ❌ Pullfrog failed\n\n${body}`, comment: body };
}
