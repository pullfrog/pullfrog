import { renderFailure } from "./failureBody.ts";
import { PROVIDER_BILLING_EXHAUSTED_LABEL, PROVIDER_USAGE_LIMIT_LABEL } from "./providerErrors.ts";

const MAX_STDERR_BYTES = 3000;

/**
 * mutable per-run handle the agent harness writes to as a run progresses.
 * the action's outer try/catch in `main.ts` reads this off `toolState` when
 * the activity-timeout watchdog wins the race against the harness's own
 * catch — the bare timer reject reason ("activity timeout: no output for
 * 302s") tells the user nothing actionable, but `recentStderr` +
 * `lastProviderError` together usually point straight at the upstream cause.
 *
 * `recentStderr` is shared by reference with the harness's bounded ring
 * buffer, so the diagnostic always reflects the latest captured tail.
 */
export type AgentDiagnostic = {
  /** display label for the agent, e.g. "Pullfrog". used in the headline. */
  label: string;
  /** shared reference to the harness's bounded stderr ring buffer. */
  recentStderr: string[];
  /** most-recent provider-error label from `detectProviderError`, if any. */
  lastProviderError: string | undefined;
  /** count of stdout events successfully parsed before the failure. */
  eventCount: number;
  /**
   * idle span the watchdog measured, in seconds. set structurally because the
   * opencode harness's error string carries only prose — re-parsing it dropped
   * the duration from the rendered explanation entirely.
   */
  idleSec: number | undefined;
  /**
   * whether the model produced a part of its own before the stall. `eventCount`
   * cannot answer this: it counts every SSE event, and our own prompt echo plus
   * session lifecycle events land before the provider is contacted, so it is
   * never 0 on a live stream.
   */
  sawModelOutput: boolean;
};

/**
 * The body for a run the activity watchdog ended. Rendered into both the PR
 * progress comment and the job summary; `null` when the harness left no
 * diagnostic, so the caller falls back to its bare-error rendering.
 *
 * The headline says whose side went quiet, because a silent run is nearly
 * always the provider's and "Pullfrog stalled" read as ours. The agent's last
 * output goes in a collapsed section for whoever wants it.
 */
export function formatAgentHangBody(input: {
  diagnostic: AgentDiagnostic | undefined;
  errorMessage: string;
}): string | null {
  const diagnostic = input.diagnostic;
  if (!diagnostic) return null;
  const output = renderStderrTail(diagnostic.recentStderr);
  const details = output ? { summary: "Last agent output", text: output } : undefined;
  const idle = formatIdle(diagnostic.idleSec ?? parseIdleSec(input.errorMessage));

  // billing exhaustion (CreditsError / FreeUsageLimitError / spending cap /
  // Insufficient balance) is mis-classified as transient by upstream harnesses
  // and the run only ends when the activity-timeout watchdog fires (see #778).
  if (diagnostic.lastProviderError === PROVIDER_BILLING_EXHAUSTED_LABEL) {
    const billingUrl = extractBillingUrl(diagnostic.recentStderr);
    return renderFailure({
      headline: "Your model provider's account is out of credit.",
      detail:
        "The provider kept refusing the request, so Pullfrog stopped the run. Top up the account, then re-trigger.",
      details,
      links: billingUrl ? [{ label: "Top up", url: billingUrl }] : [],
    });
  }
  // a capped subscription window: re-triggering before it resets only burns another run (#1575)
  if (diagnostic.lastProviderError === PROVIDER_USAGE_LIMIT_LABEL) {
    return renderFailure({
      headline: "Your model provider's usage limit is reached.",
      detail:
        "The provider kept refusing the request until the limit resets, so Pullfrog stopped the run. Re-trigger once it resets, or pick another model.",
      details,
    });
  }
  if (diagnostic.lastProviderError) {
    return renderFailure({
      headline: "The model provider kept returning errors, so Pullfrog stopped this run.",
      detail: `The last one was \`${diagnostic.lastProviderError}\`. Re-trigger to try again.`,
      details,
    });
  }
  // the stall in #1120: the turn is under way but the model never produced a
  // part. keyed off `sawModelOutput`, not `eventCount` — see AgentDiagnostic.
  if (!diagnostic.sawModelOutput) {
    return renderFailure({
      headline: `The model never responded, so Pullfrog stopped this run${idle ? ` after ${idle}` : ""}.`,
      detail:
        "The request went out but nothing came back. This is usually temporary, so re-trigger to try again.",
      details,
    });
  }
  return renderFailure({
    headline: `The agent went quiet${idle ? ` for ${idle}` : ""}, so Pullfrog stopped this run.`,
    detail: "Re-trigger to try again.",
    details,
  });
}

function formatIdle(seconds: number | undefined): string | undefined {
  if (seconds === undefined) return undefined;
  if (seconds < 90) return `${seconds} seconds`;
  return `${Math.round(seconds / 60)} minutes`;
}

/** fallback for the v1 spawn path, whose reject string embeds the span. */
function parseIdleSec(message: string): number | undefined {
  const match = /no output for (\d+)s/.exec(message);
  return match ? Number(match[1]) : undefined;
}

function renderStderrTail(lines: readonly string[]): string {
  if (lines.length === 0) return "";
  const joined = lines.join("\n");
  if (joined.length <= MAX_STDERR_BYTES) return joined;
  return `... (older lines truncated)\n${joined.slice(-MAX_STDERR_BYTES)}`;
}

/**
 * Pull a billing URL out of the captured stderr if the provider helpfully
 * embedded one (OpenCode Zen does — Anthropic and Gemini do not). Restricted
 * to known billing/console hosts so a stray URL elsewhere in the buffer
 * can't masquerade as the remedy link.
 */
function extractBillingUrl(lines: readonly string[]): string | undefined {
  const urlPattern =
    /https:\/\/(?:opencode\.ai\/[^\s"]*billing[^\s"]*|console\.anthropic\.com[^\s"]*|console\.cloud\.google\.com[^\s"]*billing[^\s"]*)/i;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = urlPattern.exec(lines[i] ?? "");
    if (m) return m[0];
  }
  return undefined;
}
