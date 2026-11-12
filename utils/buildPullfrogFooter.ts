import {
  isAutoTier,
  modelAliases,
  modelIdLabel,
  resolveDisplayAlias,
  TRIAL_FUNDED_USD_LIMIT,
  TRIAL_PROXY_DISPLAY_NAME,
} from "../models.ts";

export const PULLFROG_DIVIDER = "<!-- PULLFROG_DIVIDER_DO_NOT_REMOVE_PLZ -->";

/** on a review GitHub took as a comment because it refused the verdict (`isAwaitingApproval`). */
export const VERDICT_REFUSED_MARKER = "<!-- PULLFROG_VERDICT_REFUSED -->";

const FROG_LOGO = `<a href="https://pullfrog.com"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pullfrog.com/logos/frog-white-full-18px.png"><img src="https://pullfrog.com/logos/frog-green-full-18px.png" width="9px" height="9px" style="vertical-align: middle; " alt="Pullfrog"></picture></a>`;

/**
 * A run whose configured model was swapped for one Pullfrog could fund. `trial`
 * carries the account's remaining trial credits, as run-context counted them
 * when the run started, so the disclosure can say how much is left; undefined
 * when the server predates the figure.
 */
export type ModelClamp =
  | { from: string; reason: "card" | "noRouterPath" | "oss" }
  | { from: string; reason: "trial"; creditsLeftUsd: number | undefined };

export interface WorkflowRunFooterInfo {
  owner: string;
  repo: string;
  runId: number;
  /** optional job ID - if provided, will append /job/{jobId} to the workflow run URL */
  jobId?: string | undefined;
}

export interface BuildPullfrogFooterParams {
  /** add "via Pullfrog" link */
  triggeredBy?: boolean;
  /** add "View workflow run" link */
  workflowRun?: WorkflowRunFooterInfo | undefined;
  /** alternative: just pass a pre-built URL directly (for shortlinks etc.) */
  workflowRunUrl?: string | undefined;
  /** arbitrary custom parts (e.g., action links) */
  customParts?: string[] | undefined;
  /** model slug from payload (e.g., "anthropic/claude-opus"). shown in footer as the model it runs: "Using `claude-opus-5-5`" */
  model?: string | undefined;
  /**
   * When a Router account had a model (or the intelligent tier) selected that
   * the server clamped to the efficient default — custom picks are card-gated
   * wholesale. `from` is the configured slug (e.g. "anthropic/claude-opus");
   * `reason` names the binding constraint — "card" (no card on file) renders
   * `Using <kimi-k2> (<Claude Opus> needs a card on file)`, "noRouterPath"
   * (no openRouterResolve yet and no stored provider key) renders a
   * provider-key nudge — so the downgrade is visible rather than silently
   * presenting Kimi as the pick.
   */
  clamped?: ModelClamp | undefined;
  /**
   * true when the run used the default proxy model only because no model was
   * selected (Router billing + "auto"). the footer appends a note nudging the
   * user to pick a model — the cost-optimized default is a weaker reviewer
   * than a frontier model.
   */
  unselectedProxyDefault?: boolean | undefined;
  /**
   * true when the run's model costs are covered by the Pullfrog for OSS
   * program — the footer renders `Using <model> (free via Pullfrog for OSS)`
   * with the phrase linking to the OSS application page.
   */
  oss?: boolean | undefined;
  /** repo owner, used to deep-link the trial disclosure at that account's own
   * console rather than the generic landing page. */
  owner?: string | undefined;
  /** a failure comment: no 𝕏 link, model nudge or trial disclosure under an error. */
  failed?: boolean | undefined;
}

function formatModelLabel(params: {
  model: string;
  clamped?: ModelClamp | undefined;
  unselectedProxyDefault?: boolean | undefined;
  oss?: boolean | undefined;
}): string {
  const slugAlias = resolveDisplayAlias(params.model);
  const alias =
    slugAlias ??
    // reverse-lookup: when the caller passes an effective model (proxy or
    // resolved target like "openrouter/anthropic/claude-opus-4.7") instead of
    // a stored alias slug, find the alias whose resolve target matches.
    modelAliases.find((a) => a.resolve === params.model || a.openRouterResolve === params.model);
  // name the model that ran, not its alias: an alias moves to newer versions,
  // so its name would misdescribe this run once it does. a routing alias's
  // target is a sentinel, so it keeps its name.
  const modelName = slugAlias?.routing
    ? slugAlias.displayName
    : modelIdLabel(slugAlias?.resolve ?? params.model);
  // OSS runs have their model costs covered by the program — surface that
  // (and link to the application) instead of the BYOK `(free)` note. an OSS
  // run that overrode a configured pick must say so here: this branch returns
  // before the generic clamp rendering below, so without this the maintainer
  // sees a model they never chose with no indication their pick was ignored.
  if (params.oss) {
    const ossBase = `\`${modelName}\` (free via [Pullfrog for OSS](https://pullfrog.com/for-oss))`;
    if (params.clamped?.reason !== "oss") return ossBase;
    const configured = isAutoTier(params.clamped.from)
      ? "the intelligent tier"
      : `\`${resolveDisplayAlias(params.clamped.from)?.displayName ?? params.clamped.from}\``;
    // the clamp only fires for an OFF-allowlist pick now, so switching to a
    // funded model is the cheap remedy and has to be named first — naming only
    // BYOK is what left maintainers thinking the console offered them nothing.
    return `${ossBase} (${configured} not used — pick one of the [funded models](https://docs.pullfrog.com/models#pullfrog-for-oss) or add a [provider key](https://docs.pullfrog.com/keys) to run your own)`;
  }
  const base = alias?.isFree ? `\`${modelName}\` (free)` : `\`${modelName}\``;
  if (params.clamped?.reason === "trial") {
    // short form only: the IMPORTANT call-out above the footer already explains
    // what the trial is and how to leave it. repeating it here would say the
    // same thing twice in one comment.
    return `${base} (free trial credits)`;
  }
  if (params.clamped) {
    // name the tier (not its backing model) when the user picked a tier, so the
    // public copy reads right and doesn't couple to the tier's current target.
    const target = isAutoTier(params.clamped.from)
      ? "the intelligent tier"
      : `\`${resolveDisplayAlias(params.clamped.from)?.displayName ?? params.clamped.from}\``;
    return params.clamped.reason === "card"
      ? `${base} (${target} needs a [card on file](https://docs.pullfrog.com/models))`
      : `${base} (${target} needs a [provider key](https://docs.pullfrog.com/models) — no Router support yet)`;
  }
  if (params.unselectedProxyDefault) {
    return `${base} (default — [pick a model](https://docs.pullfrog.com/models) for stronger reviews)`;
  }
  return base;
}

/**
 * Bottom-of-comment disclosure for a run served by the free trial subsidy.
 *
 * Deliberately NOT a footer part: the `<sup>` line is where every other model
 * substitution is disclosed, and a trial review is a different claim — the
 * reader is being asked to discount findings about their own code, which a
 * subscript pipe-separated fragment cannot carry.
 *
 * Emitted AFTER `PULLFROG_DIVIDER` so `stripExistingFooter` removes it on every
 * edit. The progress comment is rewritten many times per run; anything placed
 * before the marker would survive each strip and accumulate.
 *
 * The rule is a top-level `---`, not `> ---` — inside the blockquote it would
 * render as a line across the middle of the alert instead of a separator above it.
 *
 * The copy names the RUN rather than a review, because one footer builder feeds
 * three surfaces — a review, a plan or issue comment, and a created PR body —
 * and only the first of those is a review at all. A failure comment omits it.
 */
function buildTrialDisclosure(params: {
  owner: string | undefined;
  creditsLeftUsd: number | undefined;
}): string {
  // a literal rather than `getApiUrl()`: this module is re-exported through
  // `action/internal/index.ts` into CLIENT components, and `apiUrl.ts` reaches
  // `@actions/core` through `cli.ts` — importing it here pulls node builtins
  // into the browser bundle and fails the Turbopack build. every other link in
  // this footer is already an absolute pullfrog.com URL for the same reason.
  const consoleUrl = params.owner
    ? `https://pullfrog.com/console/${params.owner}#billing`
    : "https://pullfrog.com/console";
  const left =
    params.creditsLeftUsd === undefined
      ? ""
      : ` ($${Math.max(0, params.creditsLeftUsd).toFixed(2)} of $${TRIAL_FUNDED_USD_LIMIT} left)`;
  return [
    "---",
    "",
    "> [!IMPORTANT]",
    `> **This run used your free trial credits**${left} on \`${TRIAL_PROXY_DISPLAY_NAME}\`, a fast, lightweight model. ` +
      `[Connect a provider →](${consoleUrl}) to run the model you choose.`,
  ].join("\n");
}

/**
 * build a pullfrog footer with configurable parts
 * always includes: frog logo at start and X link at end
 * order: action links (customParts) > workflow run > model > attribution > reference links
 */
export function buildPullfrogFooter(params: BuildPullfrogFooterParams): string {
  const parts: string[] = [];

  if (params.customParts) {
    parts.push(...params.customParts);
  }

  if (params.workflowRunUrl) {
    parts.push(`[View workflow run](${params.workflowRunUrl})`);
  } else if (params.workflowRun) {
    const baseUrl = `https://github.com/${params.workflowRun.owner}/${params.workflowRun.repo}/actions/runs/${params.workflowRun.runId}`;
    const url = params.workflowRun.jobId ? `${baseUrl}/job/${params.workflowRun.jobId}` : baseUrl;
    parts.push(`[View workflow run](${url})`);
  }

  if (params.triggeredBy) {
    parts.push("via [Pullfrog](https://pullfrog.com)");
  }

  if (params.model) {
    parts.push(
      `Using ${formatModelLabel({
        model: params.model,
        clamped: params.clamped,
        unselectedProxyDefault: params.unselectedProxyDefault && !params.failed,
        oss: params.oss,
      })}`
    );
  }

  const allParts = params.failed ? parts : [...parts, "[𝕏](https://x.com/pullfrogai)"];

  const disclosure =
    params.clamped?.reason === "trial" && !params.failed
      ? `${buildTrialDisclosure({ owner: params.owner, creditsLeftUsd: params.clamped.creditsLeftUsd })}\n\n`
      : "";

  return `\n\n${PULLFROG_DIVIDER}\n${disclosure}<sup>${FROG_LOGO}&nbsp;&nbsp;｜ ${allParts.join(" ｜ ")}</sup>`;
}

/**
 * strip any existing pullfrog footer from a comment body
 */
export function stripExistingFooter(body: string): string {
  const dividerIndex = body.indexOf(PULLFROG_DIVIDER);
  if (dividerIndex === -1) {
    return body;
  }
  return body.substring(0, dividerIndex).trimEnd();
}
