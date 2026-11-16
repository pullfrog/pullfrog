import { isGatewayCredential } from "../models.ts";
import { preflightClaudeSubscription } from "./claudeSubscription.ts";

/**
 * What the provider itself says about a credential. `unknown` is the safe
 * default and covers every outcome that isn't the provider explicitly
 * rejecting it — no probe for this env var, a network failure, a timeout, a
 * 404, a 5xx. Callers must treat `unknown` as "carry on as before": only
 * `dead` is positive evidence, and acting on anything weaker would let a
 * provider outage rewrite a working account's configuration.
 */
export type CredentialVerdict = "alive" | "dead" | "unknown";

type Probe = {
  /** built from the credential so key-in-query providers (Gemini) fit too. */
  request: (value: string) => { url: string; headers: Record<string, string> };
  /**
   * providers that answer a bad credential with something other than 401/403
   * declare their own tell. Gemini returns 400 `API_KEY_INVALID`, which is
   * indistinguishable from a malformed request by status alone.
   */
  deadWhen?: (status: number, body: string) => boolean;
};

/**
 * Only providers whose live-key 200 and bad-key rejection have both been
 * measured. An unlisted credential returns `unknown`, which is exactly the
 * behaviour that existed before this file — so the table grows by adding a
 * verified entry, never by guessing at one. `CODEX_AUTH_JSON` is deliberately
 * absent: it is an OAuth blob whose only check is a token refresh, which would
 * mutate the very credential being probed. `OPENAI_API_KEY` is absent for a
 * different reason — `GET /v1/models` needs the `Models: Read` scope, so a
 * restricted inference-only key 401s there while working perfectly for real
 * requests, and refusing it at paste time would be worse than not checking.
 */
const PROBES: Record<string, Probe> = {
  ANTHROPIC_API_KEY: {
    request: (value) => ({
      url: "https://api.anthropic.com/v1/models",
      headers: { "x-api-key": value, "anthropic-version": "2023-06-01" },
    }),
  },
  OPENROUTER_API_KEY: {
    request: (value) => ({
      url: "https://openrouter.ai/api/v1/key",
      headers: { authorization: `Bearer ${value}` },
    }),
  },
  GEMINI_API_KEY: {
    request: (value) => ({
      url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(value)}`,
      headers: {},
    }),
    deadWhen: (status, body) => status === 400 && body.includes("API_KEY_INVALID"),
  },
};

PROBES.GOOGLE_GENERATIVE_AI_API_KEY = PROBES.GEMINI_API_KEY;

/**
 * The Pro/Max subscription token rides an OAuth surface that a plain
 * `/v1/models` call doesn't exercise, and `preflightClaudeSubscription` already
 * speaks it — so delegate rather than keep a second Anthropic OAuth probe that
 * could drift from the first. The interpretation differs from the run-time one
 * on purpose: a 429 means the subscription is at its limit, which makes it
 * unusable for a run but does NOT make it an invalid credential to store.
 */
async function verifyClaudeSubscription(value: string): Promise<CredentialVerdict> {
  const preflight = await preflightClaudeSubscription({ token: value, model: undefined });
  if (preflight.status === undefined) return "unknown";
  return preflight.status === 401 ? "dead" : "alive";
}

/**
 * Whether asking the provider about this credential would tell us anything —
 * the paste-time gate, where the caller stores a secret and cannot see the run
 * env. A credential a gateway can be sent is excluded here and stays probeable
 * at run time, because only the runner knows whether a gateway is in play: the
 * base URL usually lives in the workflow file, which the console never reads,
 * and a gateway token is 401 at the vendor while working perfectly at the gateway.
 */
export function isCredentialProbeable(envVar: string): boolean {
  if (envVar === "CLAUDE_CODE_OAUTH_TOKEN") return true;
  return PROBES[envVar] !== undefined && !isGatewayCredential(envVar);
}

/**
 * Ask the provider whether it still accepts this credential. Used at the two
 * points that were each getting it wrong on their own: the run-time fallback
 * decision, and the console/CLI paste flow that previously stored a dead token
 * without comment.
 */
export async function verifyCredential(params: {
  envVar: string;
  value: string;
}): Promise<CredentialVerdict> {
  // trimmed, not `sanitizeSecret`d: this module runs on a Vercel lambda and in
  // the CLI as well as on a runner, and `sanitizeSecret` reaches for
  // `@actions/core` to register a GHA log mask — which is meaningless off a
  // runner and drags node builtins into the console's client bundle. the
  // masking still happens where it matters, at the run-time env injection.
  const value = params.value.trim();
  if (value.length === 0) return "dead";

  if (params.envVar === "CLAUDE_CODE_OAUTH_TOKEN") return verifyClaudeSubscription(value);

  const probe = PROBES[params.envVar];
  if (!probe) return "unknown";

  const request = probe.request(value);
  try {
    const response = await fetch(request.url, {
      headers: request.headers,
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) return "alive";
    if (probe.deadWhen) {
      return probe.deadWhen(response.status, await response.text()) ? "dead" : "unknown";
    }
    // 401 ONLY. a 403 is nearly always a SCOPE answer — "this key is real but
    // may not touch this endpoint/model" — and reading it as a dead credential
    // would refuse a working key at paste time, a worse failure than the one
    // this exists to catch. 429/404/5xx are about the moment or the endpoint.
    return response.status === 401 ? "dead" : "unknown";
  } catch {
    return "unknown";
  }
}
