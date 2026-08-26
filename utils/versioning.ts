import { findMinimumForRange, normalize, satisfies, tryParse } from "verkit";

type CompatibilityPolicy =
  /**
   * Strict policy: the action must support the same features as the payload version declares
   * @example Payload version 1.2.3 => ^1.2.0 range of action versions supported
   * @example Payload version 0.1.55 => ^0.1.55 range of action versions supported
   */
  | "same-features"
  /**
   * Loose policy: the action must have no breaking changes compared to the payload version
   * @example Payload version 1.2.3 => ^1.0.0 range of action versions supported
   * @example Payload version 0.1.55 => ^0.1.0 range of action versions supported
   */
  | "non-breaking";

const COMPATIBILITY_POLICY: CompatibilityPolicy = "non-breaking";

function minVersion(range: string): string {
  return normalize(findMinimumForRange(range)!)!;
}

/**
 * @throws Error if the action can't process payload
 * The compatibility is determined according to the COMPATIBILITY_POLICY above.
 * @param payloadVersion the version of the payload
 * @param actionVersion the version of the action (recipient)
 */
export function validateCompatibility(payloadVersion: string, actionVersion: string): void {
  const payloadSemVer = tryParse(payloadVersion);
  if (!payloadSemVer)
    throw new Error(`Payload version ${payloadVersion} is not a valid semantic version.`);
  const major = payloadSemVer.major;
  const minor = payloadSemVer.minor;
  const patch = payloadSemVer.patch;

  const compatibilityRange =
    COMPATIBILITY_POLICY === "same-features"
      ? `^${major}.${minor}.${major === 0 ? patch : 0}`
      : `^${major}.${major === 0 ? minor : 0}.${major === 0 ? "x" : 0}`; // non-breaking

  if (!satisfies(actionVersion, compatibilityRange)) {
    throw new Error(
      `Payload version ${payloadVersion} is incompatible with action version ${actionVersion}. ` +
        `Please update your workflow to use at least ${minVersion(compatibilityRange)} version of the action.`
    );
  }
}
