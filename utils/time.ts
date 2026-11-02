/**
 * time string parsing utilities for timeout configuration.
 * supports formats like "10m", "1h30m", "10m12s", "30s".
 */

// special value indicating timeout is explicitly disabled via --notimeout flag
export const TIMEOUT_DISABLED = "none";

// time string regex: supports formats like "10m", "1h30m", "10m12s", "30s"
// at least one component (hours, minutes, or seconds) is required
const TIME_STRING_REGEX = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;

/**
 * parse a time string like "10m", "1h30m", "10m12s" into milliseconds.
 * returns null if the string is not a valid time format.
 */
export function parseTimeString(input: string): number | null {
  const match = input.match(TIME_STRING_REGEX);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;

  const hours = parseInt(match[1] || "0", 10);
  const minutes = parseInt(match[2] || "0", 10);
  const seconds = parseInt(match[3] || "0", 10);

  return (hours * 3600 + minutes * 60 + seconds) * 1000;
}

/**
 * check if a string is a valid time format.
 */
export function isValidTimeString(input: string): boolean {
  return parseTimeString(input) !== null;
}

/**
 * resolve a user-supplied timeout string into a setTimeout-safe number of
 * milliseconds, returning null when the input is unusable.
 *
 * "unusable" covers three cases that all cause setTimeout to misbehave if
 * passed through naively:
 *   - unparseable ("abc", "10x") — parseTimeString returns null.
 *   - zero ("0m", "0s") — setTimeout fires immediately, so the run would
 *     look like an insta-fail with the confusing message "timed out after 0m".
 *   - overflow (e.g. "999h") — node clamps any delay above 2^31-1 ms
 *     (~24.8 days) to 1 ms, so a user who asked for "596h" or more would
 *     get a timeout in a single tick instead of the multi-day window they
 *     requested. user almost certainly meant --notimeout.
 *
 * the caller should warn and fall back to its own default when this returns
 * null; the reason is always "the input can't be honored" regardless of
 * which branch triggered it.
 */
const TIMEOUT_MAX_MS = 2_147_483_647;
export function resolveTimeoutMs(input: string | undefined): number | null {
  if (!input) return null;
  const parsed = parseTimeString(input);
  if (parsed === null || parsed <= 0 || parsed > TIMEOUT_MAX_MS) return null;
  return parsed;
}

/**
 * the run timer, or undefined under --notimeout. resolveTimeoutMs rejects unparseable / zero /
 * setTimeout-overflow inputs so a bad string can't silently resolve to an instant timeout: those
 * fall back to the 1h default, flagged `invalid` for the caller to warn — users who want runtime
 * measured in weeks should use --notimeout.
 */
export function resolveRunTimeout(input: string | undefined) {
  if (input === TIMEOUT_DISABLED) return undefined;
  const ms = input ? resolveTimeoutMs(input) : null;
  if (input && ms !== null) return { ms, label: input, invalid: false };
  return { ms: 3_600_000, label: "1h", invalid: Boolean(input) };
}
