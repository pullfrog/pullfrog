/**
 * Billing-error classification + user-facing copy for `/api/proxy-token`
 * failures and OpenRouter mid-run exhaustion. Two error classes (Billing vs.
 * Transient) keep the framing honest: a card decline is *not* the same UX as
 * a 503 from the proxy service. Both originate in `utils/proxy.ts` (mint
 * failures) and `utils/runErrorRenderer.ts` (mid-run keylimit reclassify).
 *
 * Renderers return markdown bodies that are written into both the GitHub
 * Actions job summary and the PR progress comment.
 *
 * Lives outside `main.ts` so adding a new error `code` branch is a one-file
 * edit rather than an orchestrator edit (see wiki/main.md).
 */

import { renderFailure } from "./failureBody.ts";

/**
 * Billing-layer error surfaced from `/api/proxy-token` as a 402. User-actionable,
 * distinct from TransientError (503 / transient sync issue) so the job
 * summary + PR comment can use affirmative "you need to do X" copy rather than
 * the ambiguous "billing error" label that makes transient outages look like
 * the user's fault.
 *
 * `code` is a server-side discriminator: `router_requires_card` (no card + no
 * wallet balance on Router), or null for unclassified. `declineCode` is
 * Stripe's more specific sub-reason on `card_declined` (e.g.
 * `insufficient_funds`, `lost_card`). `needsReauthentication` is the 3DS case
 * broken out for convenience.
 */
export class BillingError extends Error {
  code: string | null;
  declineCode: string | null;
  needsReauthentication: boolean;

  constructor(
    message: string,
    opts: {
      code?: string | null;
      declineCode?: string | null;
      needsReauthentication?: boolean;
    } = {}
  ) {
    super(message);
    this.name = "BillingError";
    this.code = opts.code ?? null;
    this.declineCode = opts.declineCode ?? null;
    this.needsReauthentication = opts.needsReauthentication ?? false;
  }
}

/**
 * Transient service failures from `/api/proxy-token` (503: partial OpenRouter
 * usage sync, DB flake, in-flight payment intent). Not the user's fault, the
 * summary uses "temporarily unavailable" framing, and the non-zero exit lets
 * GH Actions apply whatever retry policy the workflow has configured.
 */
export class TransientError extends Error {
  /** the customer-facing follow-up to `message`, which is the headline. */
  detail: string;

  constructor(
    message: string,
    detail = "This is on our side, and nothing was billed. The next run should succeed; if it keeps failing, check [status.pullfrog.com](https://status.pullfrog.com)."
  ) {
    super(message);
    this.name = "TransientError";
    this.detail = detail;
  }
}

/**
 * Deep link into the billing section of the failing account's console. Since
 * the billing + model-costs cards were merged into one `#billing` section,
 * every billing CTA points here. `owner` is the GitHub login of the repo's
 * account, the org or user that pays for this repo's runs.
 */
function billingConsoleUrl(owner: string): string {
  return `https://pullfrog.com/console/${encodeURIComponent(owner)}#billing`;
}

/**
 * Why the org commercial gate refused a run (billing model v2), resolved by
 * `resolveTeamRunAccess` and carried unchanged through the paywall comment, the
 * run-context 402 and the proxy-token 402. `commercial`: the no-card trial
 * wound down to `paused`. `subscription_ended`: a paid subscription was
 * canceled and lapsed to `paused`. `subscription_unpaid`: the renewal failed
 * dunning.
 */
export type CommercialRefusal = "commercial" | "subscription_ended" | "subscription_unpaid";

/**
 * flat Pro price, $30/month per account — same price for both account types.
 * defined here, not in the server's billing module, so the paywall copy quotes
 * the price Stripe charges.
 */
export const TEAM_PRICE_CENTS = 3000;
/** post-trial grace window: keeps reviewing before the telegraphed pause. */
export const GRACE_DAYS = 7;

const ORGANIZATION_PLAN = `The Organization plan is $${TEAM_PRICE_CENTS / 100}/month for unlimited runs and unlimited members.`;

/**
 * the one-time notice a run posts on its PR or issue during the grace week, so the
 * people using Pullfrog see the pause coming, not only the contact the emails reach.
 */
export function graceNoticeBody(params: {
  ownerLogin: string;
  pausesAt: Date;
  url: string;
}): string {
  const date = params.pausesAt.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
  return [
    `**Pullfrog's free trial for ${params.ownerLogin} has ended.**`,
    "",
    `Pullfrog keeps running on private repos through ${date}, then pauses. An org owner can [subscribe](${params.url}) to keep it running. ${ORGANIZATION_PLAN}`,
  ].join("\n");
}

/**
 * Canonical paused-run paywall body (billing model v2). Single source of truth so
 * the two surfaces that show it can never drift: the trigger-time comment (a run
 * refused before it starts, `triggerWorkflow.postPaywallComment`) and the mid-run
 * 402 render (`formatBillingErrorSummary` via `renderRunError`). `url` is the
 * caller's billing surface (each passes its own, internal plan page vs console).
 */
export function commercialPaywallBody(params: {
  reason: CommercialRefusal;
  ownerLogin: string;
  url: string;
  freshReply?: boolean | undefined;
}): string {
  const resume = "to resume private-repo runs.";
  let detail: string;
  switch (params.reason) {
    case "commercial":
      detail = `The free trial and its ${GRACE_DAYS}-day grace period have ended. An org owner can [upgrade](${params.url}) ${resume} ${ORGANIZATION_PLAN}`;
      break;
    case "subscription_ended":
      detail = `The subscription has ended. An org owner can [resubscribe](${params.url}) ${resume} ${ORGANIZATION_PLAN}`;
      break;
    case "subscription_unpaid":
      detail = `The latest subscription payment failed. An org owner can [update billing](${params.url}) ${resume}`;
      break;
    default:
      return params.reason satisfies never;
  }
  return [
    `**Pullfrog is ${params.freshReply ? "still paused" : "paused"} for ${params.ownerLogin}.**`,
    "",
    detail,
  ].join("\n");
}

/**
 * commercial-gate copy for action runs, linked to the account billing card.
 *
 * if this fires on a `PullfrogDev/preview-*` repo it is an infrastructure bug, not
 * a billing state — those repos have no real billing state to refuse. the
 * original cause was the gate comparing the subscription's originating host
 * with strict equality, which no preview could satisfy against a cloned
 * production row; see `isSubscriptionHostTrusted` and wiki/billing-model-v2.md.
 */
export function formatCommercialGateSummary(params: {
  reason: CommercialRefusal;
  ownerLogin: string;
}): string {
  return commercialPaywallBody({
    reason: params.reason,
    ownerLogin: params.ownerLogin,
    url: billingConsoleUrl(params.ownerLogin),
  });
}

/**
 * Render a BillingError as user-facing markdown (shared between GH job summary
 * and the PR progress comment). Goals:
 *
 *   - quiet, not alarmist, bold first line instead of an `### ❌` H3, since
 *     the comment already has Pullfrog branding in the footer
 *   - actionable, every branch ends in a single CTA deep-linked to the
 *     correct section of the owner's console
 *   - honest, say what actually went wrong (card declined vs. balance
 *     empty vs. 3DS required), don't lump them under "billing error"
 *
 * Branches:
 *   - `router_requires_card`: user is on Router mode with no card AND no
 *     wallet balance. Frame as
 *     "add a card to continue", link to `#billing` where the Add
 *     Card flow lives.
 *   - `router_balance_exhausted`: user has a card on file but auto-reload is
 *     disabled and they've spent past their $5 overdraft buffer. Frame as
 *     "balance ran out" and surface both remediation paths (top up, or flip
 *     on auto-reload).
 *   - `router_keylimit_exhausted`: OpenRouter rejected mid-run because the
 *     per-run key budget was exhausted while the agent was working. The
 *     wallet is now negative; same remediation as `router_balance_exhausted`
 *     but framed for the after-the-fact case ("this run was cut short").
 *   - `needsReauthentication`: issuer requires 3DS on every off-session
 *     charge. Re-adding the card won't help, the only escape is a manual
 *     top-up where 3DS runs interactively in Stripe Checkout.
 *   - `declineCode` set: Stripe declined a real charge. Show the sub-code
 *     so support can act on it; tell the user we'll retry on next dispatch.
 *   - default: balance hit zero with no in-flight charge (auto-reload off
 *     or amount below threshold). Direct them to top up or enable auto-reload.
 */
export function formatBillingErrorSummary(error: BillingError, owner: string): string {
  const billing = { label: "Add credit", url: billingConsoleUrl(owner) };
  if (error.code === "router_requires_card") {
    return renderFailure({
      headline: "Your Pullfrog Router balance is empty.",
      detail:
        "Add a card to top it up, or connect your own provider key. Router usage is billed at provider cost with no markup.",
      links: [{ label: "Billing and providers", url: billingConsoleUrl(owner) }],
    });
  }

  if (error.code === "router_balance_exhausted") {
    return renderFailure({
      headline: "Your Pullfrog Router balance is used up.",
      detail:
        "Auto-reload is off, so runs paused once the balance passed its overdraft buffer. Add credit or turn on auto-reload.",
      links: [billing],
    });
  }

  if (error.code === "router_keylimit_exhausted") {
    return renderFailure({
      headline: "Your Pullfrog Router balance ran out partway through this run.",
      detail: "Add credit or turn on auto-reload to keep runs going.",
      links: [billing],
    });
  }

  if (error.code === "router_monthly_limit") {
    return renderFailure({
      headline:
        "Your Pullfrog Router balance is empty, and the monthly spend limit blocks the next auto-reload.",
      detail:
        "Add credit by hand, ask an org owner to raise the limit, or wait for it to reset at 00:00 UTC on the 1st.",
      links: [billing],
    });
  }

  // billing model v2 org commercial gate: the org's Team trial wound down to a
  // pause (or a paid renewal failed). Individual members keep Pullfrog free on
  // their own repos; only the org's runs are paused.
  // `#billing` (billingConsoleUrl) is the card-management surface, matching
  // router_requires_card; keep every commercial-gate CTA pointed there.
  if (error.code === "commercial_plan_required") {
    return formatCommercialGateSummary({
      reason: "commercial",
      ownerLogin: owner,
    });
  }

  if (error.code === "subscription_ended") {
    return formatCommercialGateSummary({
      reason: "subscription_ended",
      ownerLogin: owner,
    });
  }

  if (error.code === "subscription_unpaid") {
    return formatCommercialGateSummary({
      reason: "subscription_unpaid",
      ownerLogin: owner,
    });
  }

  if (error.needsReauthentication) {
    const code = error.declineCode ?? "authentication_required";
    return renderFailure({
      headline: `Your card issuer requires 3D Secure on every charge (\`${code}\`).`,
      detail:
        "Pullfrog can't complete a 3D Secure check from inside a workflow. Add credit once by hand, and later runs draw on that balance without another check.",
      links: [billing],
    });
  }

  if (error.declineCode) {
    return renderFailure({
      headline: `Your card was declined (\`${error.declineCode}\`).`,
      detail: "Update your payment method, and Pullfrog will retry on the next run.",
      links: [{ label: "Update payment method", url: billingConsoleUrl(owner) }],
    });
  }

  return renderFailure({
    headline: "Your Pullfrog balance is empty.",
    detail: "Add credit or turn on auto-reload to keep runs going.",
    links: [billing],
  });
}

/**
 * Render a TransientError as user-facing markdown. Distinct framing from
 * BillingError so the user doesn't read an alarm and assume their card
 * failed, this branch is "our fault, retry shortly", not theirs. Both parts are
 * ours and customer-ready; the server's own wording goes to the log.
 */
export function formatTransientErrorSummary(error: TransientError): string {
  return renderFailure({ headline: error.message, detail: error.detail });
}
