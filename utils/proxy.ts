/**
 * Mint an OpenRouter proxy key via `/api/proxy-token` and inject it as
 * `OPENROUTER_API_KEY` for runs that route through Pullfrog Router (managed
 * billing accounts) or OSS-grant paths.
 *
 * Authenticates one of two ways:
 *   - production: GitHub Actions OIDC token minted from the stashed
 *     credentials via `fetchIdTokenFromStash` (env-free)
 *   - local dev (`API_URL` is localhost): `x-dev-repo` header bypass
 *
 * `runProxyResolution` is the entrypoint `main.ts` calls. It wraps
 * `resolveProxyModel` and renders the user-facing copy itself (job summary
 * + PR progress comment) before rethrowing the structured error — handled
 * here, not in the outer `main()` catch, because `toolContext` doesn't
 * exist yet at this point in the pipeline.
 *
 *   - 402 → `BillingError` (card declined, balance empty, 3DS, etc.)
 *   - 5xx → `TransientError` (the mint is down — retried in-run first)
 *   - 404 → `TransientError` (stale repo↔account link — re-homes on next webhook)
 */

import * as yes from "yes";
import { DEFAULT_PROXY_MODEL, isCardGatedModel, resolveOpenRouterModel } from "../models.ts";
import type { ToolState } from "../toolState.ts";
import { apiFetch } from "./apiFetch.ts";
import { isLocalApiUrl } from "./apiUrl.ts";
import {
  BillingError,
  formatBillingErrorSummary,
  formatTransientErrorSummary,
  TransientError,
} from "./billingErrors.ts";
import { log, writeSummary } from "./cli.ts";
import { reportErrorToComment } from "./errorReport.ts";
import { fetchIdTokenFromStash, isTransientTokenError, type OidcCredentials } from "./github.ts";
import type { ResolvedPayload } from "./payload.ts";
import { maskSecret } from "./secretCommands.ts";

/** which program pays for the minted key. the server re-derives entitlement for
 * every value of this — it is a request, never a claim. */
type FundingSource = "oss" | "router" | "trial";

async function mintProxyKey(ctx: {
  oidcCredentials: OidcCredentials | null;
  repo: { owner: string; name: string };
  fundingSource: FundingSource;
}): Promise<string | null> {
  try {
    const headers = await buildProxyTokenHeaders(ctx);
    if (!headers) return null;

    // 5xx = the mint is down, which is never a verdict about this user's
    // billing. 503 is the documented transient case (partial OpenRouter
    // failure, DB flake, in-flight top-up) and 500/502/504 are the same class:
    // they used to fall through to `return null`, which silently degraded the
    // run to BYOK — an OSS-grant repo then died telling its maintainers to add
    // the provider key the grant exists to replace (#1192). retry, then render
    // the "temporarily unavailable" copy instead of the "billing error" label
    // BillingError uses.
    const response = await yes.mutation({
      run: async () => {
        const r = await apiFetch({ path: "/api/proxy-token", method: "POST", headers });
        if (r.status >= 500) {
          const body = (await r.json().catch(() => null)) as { error?: string } | null;
          throw new TransientError(
            body?.error ?? "billing service temporarily unavailable — retry shortly"
          );
        }
        return r;
      },
      name: "proxy key mint",
      retry: (error, attempt) =>
        error instanceof TransientError ? yes.delay([1000, 2000], attempt) : -1,
    })();

    if (response.status === 402) {
      const body = (await response.json().catch(() => null)) as {
        error?: string;
        code?: string;
        declineCode?: string;
        needsReauthentication?: boolean;
      } | null;
      throw new BillingError(body?.error ?? "insufficient balance", {
        code: body?.code ?? null,
        declineCode: body?.declineCode ?? null,
        needsReauthentication: body?.needsReauthentication ?? false,
      });
    }

    // 404 = the server can't match this repo↔account pair. run-context set
    // `proxyModel` at dispatch, so this is stale linkage on our side (rename/
    // transfer race) — never a missing BYOK key. falling through to the no-key
    // error would misdirect the user to add a provider key (the ccusage churn).
    if (response.status === 404) {
      throw new TransientError(
        "Pullfrog couldn't match this repository to its account — it may have just been renamed or transferred. The link refreshes automatically on the next run; if it keeps failing, reinstall the GitHub App on the repo's current owner."
      );
    }

    // only 4xx other than 402/404 reaches here; the run degrades to whatever
    // BYOK credential it has, which is a real behavior change, so it is loud.
    if (!response.ok) {
      log.warning(
        `proxy key mint failed (${response.status}) — continuing on this repo's own provider credentials`
      );
      return null;
    }

    const data = (await response.json()) as { key: string };
    return data.key;
  } catch (error) {
    if (error instanceof BillingError) throw error;
    if (error instanceof TransientError) throw error;
    log.warning(`proxy key mint error: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * choose how to authenticate the `/api/proxy-token` request:
 *
 * - production: mint a fresh OIDC token from the stashed credentials and
 *   send as `Authorization: Bearer …` (the server verifies it
 *   cryptographically). env-free, so the agent never sees the credentials
 *   even transiently.
 * - local dev (no OIDC + `API_URL` is localhost): send `x-dev-repo:
 *   owner/repo` instead. the server-side route only honors this header
 *   when `NODE_ENV === "development"`, so prod is never reachable through
 *   this branch even if the action is misconfigured.
 *
 * returns null when neither path is available — caller treats as soft skip.
 */
async function buildProxyTokenHeaders(ctx: {
  oidcCredentials: OidcCredentials | null;
  repo: { owner: string; name: string };
  fundingSource: FundingSource;
}): Promise<Record<string, string> | null> {
  const fundingSource = ctx.fundingSource;
  if (ctx.oidcCredentials) {
    // retry transients — core.getIDToken (the previous mint path) retried
    // 5xx internally, and a soft-skip here degrades the run to BYOK
    const creds = ctx.oidcCredentials;
    const oidcToken = await yes.query({
      run: () => fetchIdTokenFromStash(creds),
      name: "ID token mint",
      retry: (error, attempt) =>
        isTransientTokenError(error) ? yes.delay([1000, 2000], attempt) : -1,
    })();
    return {
      Authorization: `Bearer ${oidcToken}`,
      "X-Pullfrog-Funding-Source": fundingSource,
    };
  }
  if (isLocalApiUrl()) {
    log.info(`» proxy: dev bypass (x-dev-repo) for ${ctx.repo.owner}/${ctx.repo.name}`);
    return {
      "x-dev-repo": `${ctx.repo.owner}/${ctx.repo.name}`,
      "X-Pullfrog-Funding-Source": fundingSource,
    };
  }
  return null;
}

/**
 * Decide whether this run needs a minted proxy key and, if so, mint and
 * inject it as `OPENROUTER_API_KEY`. Mutates `payload.proxyModel` on success.
 *
 * `ctx.proxyModel` IS the signal — the server (`run-context/route.ts`) is
 * the authority on "should this run use the Router". It already knows the
 * full picture (OSS, plan, wallet balance, modelAccessMode) and only sets
 * `proxyModel` when the gate passes. The action just trusts that signal
 * and mints. Re-deriving the gate locally was redundant and was strictly
 * more restrictive (no balance check), which made signup-credit runs on
 * no-card private repos silently fall through to BYOK.
 *
 * Skipped when:
 *   - `PULLFROG_MODEL` env override is set (BYOK escape hatch)
 *   - `proxyModel` is not set on the run context
 *   - no OIDC credentials available and not talking to a localhost API
 *
 * Throws `BillingError` (402) or `TransientError` (503); caller renders.
 */
async function resolveProxyModel(ctx: {
  payload: ResolvedPayload;
  oss: boolean;
  proxyModel?: string | undefined;
  oidcCredentials: OidcCredentials | null;
  repo: { owner: string; name: string };
  toolState: ToolState;
}): Promise<void> {
  // env override = BYOK escape hatch, don't proxy
  if (process.env.PULLFROG_MODEL?.trim()) return;

  if (!ctx.proxyModel) return;

  // dev affordance: when talking to a localhost API, the server-side
  // x-dev-repo bypass replaces OIDC verification, so a play run can
  // exercise the proxy/router/oss path without GitHub Actions OIDC.
  if (!ctx.oidcCredentials && !isLocalApiUrl()) {
    log.warning("» proxy requested but no OIDC credentials available — skipping");
    return;
  }

  const key = await mintProxyKey({
    oidcCredentials: ctx.oidcCredentials,
    repo: ctx.repo,
    fundingSource: ctx.oss ? "oss" : "router",
  });
  if (!key) return;

  process.env.OPENROUTER_API_KEY = key;
  maskSecret(key);
  ctx.payload.proxyModel = ctx.proxyModel;
  // reflect the effective (proxy) model now — an error comment built between
  // here and main.ts's post-resolution refinement would otherwise show the
  // stale configured slug (a clamped frontier pick rendering as if it ran).
  // main.ts re-sets this to the same value.
  ctx.toolState.model = ctx.proxyModel;
  const label = ctx.oss ? "oss" : "router";
  log.info(`» proxy: ${label} → ${ctx.proxyModel}`);

  // Router run with no model selected that landed on the cost-optimized
  // efficient default (Kimi K2) rather than a frontier model — nudge the user
  // to pick one. a card on file flips the auto default to the intelligent tier
  // (Opus), so `proxyModel !== DEFAULT_PROXY_MODEL` and we stay quiet: nudging
  // "pick a stronger model" while already on Opus would be nonsense. OSS
  // deliberately forces the default (cost-bounded, picker hidden), so exclude it.
  ctx.toolState.unselectedProxyDefault =
    !ctx.oss && !ctx.payload.model && ctx.proxyModel === DEFAULT_PROXY_MODEL;
  if (ctx.toolState.unselectedProxyDefault) {
    log.warning(
      `» no model selected — using the cost-optimized default (${ctx.proxyModel}); ` +
        "pick a model in your Pullfrog repo settings for stronger reviews."
    );
  }

  // Router account with a model (or the intelligent tier) selected that the
  // server clamped to the efficient default. record the configured slug + the
  // binding constraint so the footer can disclose the downgrade rather than
  // silently presenting Kimi as the model the user picked. mutually exclusive
  // with unselectedProxyDefault (that path requires no model selected). the
  // resolveOpenRouterModel guard skips no-op clamps — a pick that resolves to
  // the efficient default anyway (Kimi, `auto/efficient`) was not downgraded.
  // two distinct constraints:
  //   - "card": a Router-resolvable pick on a no-card account — custom picks
  //     are card-gated wholesale (no-card accounts run Auto only).
  //   - "noRouterPath": a pick with no openRouterResolve yet and no stored
  //     provider key (a model OpenRouter doesn't serve yet) — a card wouldn't
  //     change the outcome, so don't ask for one. free picks never reach this
  //     branch: run-context skips the mint for them, so they run as picked.
  if (
    ctx.payload.model &&
    ctx.proxyModel === DEFAULT_PROXY_MODEL &&
    resolveOpenRouterModel(ctx.payload.model) !== DEFAULT_PROXY_MODEL
  ) {
    // OSS forces the efficient default regardless of `repo.model` to keep
    // per-run subsidy spend bounded (see run-context route). that clamp is
    // deliberate, but it was previously invisible: the footer rendered only
    // "free via Pullfrog for OSS", so a maintainer who configured Opus saw
    // Kimi with no indication their pick was overridden or how to opt out.
    // 23 third-party OSS repos are running a model other than the one they
    // configured. disclose it; the precedence itself stays as-is.
    if (ctx.oss) {
      ctx.toolState.modelClamped = { from: ctx.payload.model, reason: "oss" };
      log.info(
        `» ${ctx.payload.model} overridden — it is not one of the models Pullfrog for OSS ` +
          `funds, so this run uses ${ctx.proxyModel}; pick a funded model in your Pullfrog ` +
          "settings, or add a provider key to run your own."
      );
    } else if (isCardGatedModel(ctx.payload.model)) {
      ctx.toolState.modelClamped = { from: ctx.payload.model, reason: "card" };
      log.warning(
        `» ${ctx.payload.model} needs a card on file — using the efficient default ` +
          `(${ctx.proxyModel}); add a card in your Pullfrog org billing settings.`
      );
    } else {
      ctx.toolState.modelClamped = { from: ctx.payload.model, reason: "noRouterPath" };
      log.warning(
        `» ${ctx.payload.model} has no Router path yet — using the efficient default ` +
          `(${ctx.proxyModel}); add its provider key in your Pullfrog settings to run it.`
      );
    }
  }
}

/**
 * Run `resolveProxyModel`; if it throws a Billing or Transient error, render
 * the user-facing summary, mirror it to the PR progress comment, and rethrow.
 *
 * The rethrow is intentional: these errors are terminal for the run, and
 * letting them surface lets `runMain` exit non-zero so GH Actions applies
 * the workflow's retry policy. We catch them *here* (before the main try)
 * because the outer catch needs `toolContext` (which isn't built yet) for
 * its general-purpose rendering path — a BillingError landing in the outer
 * catch would get rendered with `core.setFailed` only, losing the
 * actionable copy + the PR-comment mirror.
 */
export async function runProxyResolution(ctx: {
  payload: ResolvedPayload;
  oss: boolean;
  proxyModel?: string | undefined;
  oidcCredentials: OidcCredentials | null;
  repo: { owner: string; name: string };
  toolState: ToolState;
}): Promise<void> {
  try {
    await resolveProxyModel({
      payload: ctx.payload,
      oss: ctx.oss,
      proxyModel: ctx.proxyModel,
      oidcCredentials: ctx.oidcCredentials,
      repo: ctx.repo,
      toolState: ctx.toolState,
    });
  } catch (error) {
    if (error instanceof BillingError) {
      const summary = formatBillingErrorSummary(error, ctx.repo.owner);
      await writeSummary(summary).catch(() => {});
      // Mirror to the PR progress comment if the trigger created one (mention /
      // PR event). When the trigger is silent (IncrementalReview on
      // pull_request_synchronize), no progress comment exists; fall through to
      // creating a fresh issue comment so the user actually sees the
      // billing-exhaustion remediation copy. Without `createIfMissing`,
      // auto-reload declines on silent triggers are visible only in the GH job
      // summary, which most users never open — so back-to-back pushes silently
      // burn through dispatches with no PR-side signal. see #775.
      await reportErrorToComment({
        toolState: ctx.toolState,
        error: summary,
        createIfMissing: true,
      }).catch(() => {});
      throw error;
    }
    if (error instanceof TransientError) {
      const summary = formatTransientErrorSummary(error, ctx.repo.owner);
      await writeSummary(summary).catch(() => {});
      await reportErrorToComment({
        toolState: ctx.toolState,
        error: summary,
        createIfMissing: true,
      }).catch(() => {});
      throw error;
    }
    throw error;
  }
}

/**
 * Late fallback for a run inside the no-card trial whose own key search came up
 * dry. Mints a Pullfrog-funded key on the efficient tier so a new account's
 * first run produces a review rather than a credentials error.
 *
 * Deliberately runs AFTER `validateAgentApiKey` rather than beside the ordinary
 * proxy resolution: the server grants permission but cannot see workflow `env:`
 * keys, so only the runner knows whether anything else could have paid. Minting
 * eagerly would silently downgrade every account whose key lives in GitHub
 * Actions secrets.
 *
 * Returns false when the mint is unavailable (no OIDC, server declined), leaving
 * the caller to raise the original missing-key error unchanged.
 */
export async function resolveTrialFallback(ctx: {
  payload: ResolvedPayload;
  configuredModel: string | undefined;
  oidcCredentials: OidcCredentials | null;
  repo: { owner: string; name: string };
  toolState: ToolState;
}): Promise<boolean> {
  // an explicit operator override is a deliberate pin — usually set to
  // REPRODUCE a credential failure — so silently serving it from the subsidy
  // would mask the very run it was set to produce.
  if (process.env.PULLFROG_MODEL?.trim()) return false;
  if (!ctx.oidcCredentials && !isLocalApiUrl()) return false;

  const key = await mintProxyKey({
    oidcCredentials: ctx.oidcCredentials,
    repo: ctx.repo,
    fundingSource: "trial",
  });
  if (!key) return false;

  process.env.OPENROUTER_API_KEY = key;
  maskSecret(key);
  ctx.payload.proxyModel = DEFAULT_PROXY_MODEL;
  ctx.toolState.model = DEFAULT_PROXY_MODEL;
  // `from` is what the repo was configured to use, so the disclosure can name
  // what did NOT run. absent when the repo never picked a model at all.
  ctx.toolState.modelClamped = {
    from: ctx.configuredModel ?? DEFAULT_PROXY_MODEL,
    reason: "trial",
  };
  log.info(`» proxy: trial → ${DEFAULT_PROXY_MODEL}`);
  return true;
}
