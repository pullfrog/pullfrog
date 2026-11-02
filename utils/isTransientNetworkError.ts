import * as yes from "yes";

/**
 * Predicate for transient network errors that should be retried (vs. fail fast
 * on explicit HTTP status / validation errors that carry their own message).
 *
 * Matches errors from `fetch` (`fetch failed`), TCP-level interruption
 * (`ECONNRESET`, `ETIMEDOUT`), and aborts — `AbortSignal.timeout` rejects with
 * `TimeoutError`, a manual abort with `AbortError` (#1354).
 * Callers may pass `extraPatterns` to whitelist additional transient
 * substrings on `error.message` (e.g. provider-specific framings).
 */
export function isTransientNetworkError(error: unknown, extraPatterns: string[] = []): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  const patterns = ["fetch failed", "ECONNRESET", "ETIMEDOUT", ...extraPatterns];
  return patterns.some((p) => error.message.includes(p));
}

/**
 * broader transient predicate for octokit calls: an HTTP 5xx (GitHub upstream
 * blip) OR a network-class error. distinct from `isTransientNetworkError` — an
 * HTTP 4xx (404/401/403/422) is deterministic and fails fast. the action
 * octokit carries only the throttling plugin + a 401 re-mint (no 5xx retry),
 * so callers on critical paths retry idempotent GitHub reads/dispatches with
 * this. mirrors the server's `isTransientUpstreamError`. see #999.
 */
export function isTransientOctokitError(error: unknown): boolean {
  if (
    error !== null &&
    typeof error === "object" &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    return error.status >= 500;
  }
  return isTransientNetworkError(error);
}

/** the `yes` retry for an octokit call: back off on a transient failure, give up on any other. */
export function retryTransientOctokit(error: unknown, attempt: number): number {
  return isTransientOctokitError(error) ? yes.backoff([500, 2000], attempt) : -1;
}
