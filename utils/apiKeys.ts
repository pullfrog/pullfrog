import {
  AZURE_API_KEY_ENV,
  AZURE_CONTEXT_ENV,
  AZURE_DEPLOYMENT_ENV,
  AZURE_MAX_OUTPUT_ENV,
  AZURE_PROVIDER,
  AZURE_RESOURCE_NAME_ENV,
  BEDROCK_MODEL_ID_ENV,
  getModelEnvVars,
  getModelManagedCredentials,
  OPENAI_COMPATIBLE_API_KEY_ENV,
  OPENAI_COMPATIBLE_BASE_URL_ENV,
  OPENAI_COMPATIBLE_CONTEXT_ENV,
  OPENAI_COMPATIBLE_MAX_OUTPUT_ENV,
  OPENAI_COMPATIBLE_MODEL_ENV,
  OPENAI_COMPATIBLE_PROVIDER,
  resolveDisplayAlias,
  VERTEX_MODEL_ID_ENV,
} from "../models.ts";
import { getApiUrl } from "./apiUrl.ts";
import { getModelsFailure } from "./openCodeModels.ts";
import {
  GOOGLE_CLOUD_PROJECT_ENV,
  readProjectIdFromVertexServiceAccountJson,
  VERTEX_LOCATION_ENV,
  VERTEX_SERVICE_ACCOUNT_JSON_ENV,
} from "./vertex.ts";

/** marker prefix on the throw message for the catch-side reclassification path */
const MISSING_KEY_MARKER = "no API key found";

/**
 * marker for the distinct "run-context couldn't hand over your stored secrets"
 * body. surfaced verbatim by `runErrorRenderer` (same contract as
 * `MODEL_ACCESS_MARKER`) because blaming the user for a transient fetch failure
 * on our side is the wrong CTA — their key is configured and still stored.
 */
export const SECRETS_UNAVAILABLE_MARKER = "couldn't load your Pullfrog secrets";

/**
 * marker for the "your Router wallet is empty AND you have no provider key"
 * body. its own marker rather than the missing-key one because
 * `formatApiKeyErrorSummary` rebuilds any body carrying `MISSING_KEY_MARKER`
 * that doesn't start with it, which would silently discard this copy.
 */
export const ROUTER_UNFUNDED_MARKER = "your Pullfrog Router balance is empty";

/**
 * marker for a credential the provider explicitly REJECTED before the agent
 * started. needs a verbatim guard for the same reason as its three siblings,
 * and more sharply: the body quotes the provider's own wording, which is
 * exactly what `isApiKeyAuthError` sniffs — so an Anthropic error whose JSON
 * carries `authentication_error` would be rebuilt into the generic
 * "rotate the key, update the GitHub Actions secret" copy. That is #782
 * verbatim, on the code path built to stop it.
 *
 * Phrased distinctively for the same reason as its siblings: `runErrorRenderer`
 * short-circuits the whole rendering pipeline on a SUBSTRING match against
 * arbitrary agent output, so a marker short enough to occur by accident would
 * hand that agent the ability to suppress every other error body.
 */
export const CREDENTIAL_REJECTED_MARKER = "was rejected by its provider";

/**
 * Three ways to arrive at "the runner has no key", each with a different CTA:
 * we couldn't read the key you stored, your Router wallet ran dry and you have
 * no key of your own, or you genuinely have no key. Every throw site picks by
 * these flags.
 */
function buildKeyError(params: {
  owner: string;
  name: string;
  model?: string | undefined;
  secretsUnavailable?: boolean | undefined;
  routerUnfunded?: boolean | undefined;
}): string {
  if (params.secretsUnavailable) return buildSecretsUnavailableError(params);
  if (params.routerUnfunded) return buildRouterUnfundedError(params);
  return buildMissingApiKeyError(params);
}

/**
 * The account is on the Router, its wallet hit zero, and run-context therefore
 * declined the mint — so the run fell through to BYOK and found nothing.
 * `router_requires_card` (the 402 with this copy) is only reachable on the one
 * run whose balance crosses zero; every run after it lands here, and before
 * this body they were all told to go add an `OPENAI_API_KEY`. Leads with the
 * funding remedy because that is the one that matches how the account is
 * actually configured.
 */
function buildRouterUnfundedError(params: {
  owner: string;
  name: string;
  model?: string | undefined;
}): string {
  const billingUrl = `${getApiUrl()}/console/${params.owner}#billing`;
  const settingsUrl = `${getApiUrl()}/console/${params.owner}/${params.name}`;
  const modelClause = params.model ? ` \`${params.model}\` never ran.` : " The agent never ran.";

  return [
    `**${ROUTER_UNFUNDED_MARKER}**, and this repo has no provider key to fall back on, so${modelClause}`,
    "",
    "**To fix, any one of:** add a payment method or top up your Router balance · add a provider API key (GitHub Actions secret or Pullfrog secret) · switch this repo to a free model.",
    "",
    `[Top up Router →](${billingUrl}) · [Model settings →](${settingsUrl}) · [Setup docs →](https://docs.pullfrog.com/keys) · [Ask in Discord →](https://discord.gg/8y96raFg8e)`,
  ].join("\n");
}

function buildSecretsUnavailableError(params: {
  owner: string;
  name: string;
  model?: string | undefined;
}): string {
  const settingsUrl = `${getApiUrl()}/console/${params.owner}/${params.name}`;
  const modelClause = params.model ? ` needed for \`${params.model}\`` : "";

  return [
    `**Pullfrog ${SECRETS_UNAVAILABLE_MARKER}${modelClause} on this run.** The key is still stored — the runner just couldn't fetch it, so this is a transient failure on our side, not a missing key.`,
    "",
    "**To fix:** re-run the job. If it keeps happening, tell us in Discord.",
    "",
    `[Model settings →](${settingsUrl}) · [Setup docs →](https://docs.pullfrog.com/keys) · [Ask in Discord →](https://discord.gg/8y96raFg8e)`,
  ].join("\n");
}

/**
 * Markdown body used for both the thrown error and the formatted PR comment
 * summary. When the configured model is known, names it and the exact env
 * var(s) it needs so the user knows precisely what to fix; otherwise falls
 * back to the generic "any provider key" copy (auto-select path).
 */
function buildMissingApiKeyError(params: {
  owner: string;
  name: string;
  model?: string | undefined;
}): string {
  const githubSecretsUrl = `https://github.com/${params.owner}/${params.name}/settings/secrets/actions`;
  const settingsUrl = `${getApiUrl()}/console/${params.owner}/${params.name}`;

  const envVars = params.model?.includes("/") ? getModelEnvVars(params.model) : [];
  const [primary, ...alternates] = envVars;
  const envVarList = primary
    ? `\`${primary}\`${alternates.length > 0 ? ` (or ${alternates.map((v) => `\`${v}\``).join(" / ")})` : ""}`
    : undefined;

  const lead = envVarList
    ? `**${MISSING_KEY_MARKER}** — this repo is configured to use \`${params.model}\`, which needs ${envVarList}, but the runner has no key for it.`
    : `**${MISSING_KEY_MARKER}** — Pullfrog needs at least one LLM provider API key (e.g. \`ANTHROPIC_API_KEY\`, \`OPENAI_API_KEY\`, \`GEMINI_API_KEY\`) configured as a GitHub Actions secret.`;

  return [
    lead,
    "",
    "**To fix:** add the key as a GitHub Actions secret (referenced from your workflow's `env:` block) or as a Pullfrog secret in the console — or switch this repo to a different model (free models need no key).",
    "",
    `[Open repo secrets →](${githubSecretsUrl}) · [Configure model →](${settingsUrl}) · [Setup docs →](https://docs.pullfrog.com/keys) · [Ask in Discord →](https://discord.gg/8y96raFg8e)`,
  ].join("\n");
}

function buildBedrockSetupError(params: {
  owner: string;
  name: string;
  missing: string[];
}): string {
  const githubSecretsUrl = `https://github.com/${params.owner}/${params.name}/settings/secrets/actions`;

  return `Bedrock model selected but required configuration is missing: ${params.missing.join(", ")}.

add the missing secret(s) to your GitHub repository at ${githubSecretsUrl}, then reference them in your workflow's \`env:\` block:

  AWS_BEARER_TOKEN_BEDROCK: \${{ secrets.AWS_BEARER_TOKEN_BEDROCK }}
  AWS_REGION: \${{ secrets.AWS_REGION }}
  ${BEDROCK_MODEL_ID_ENV}: \${{ secrets.${BEDROCK_MODEL_ID_ENV} }}

\`AWS_BEARER_TOKEN_BEDROCK\` may be substituted with \`AWS_ACCESS_KEY_ID\` + \`AWS_SECRET_ACCESS_KEY\` (and optional \`AWS_SESSION_TOKEN\`) if you prefer access keys.

for full setup instructions, see https://docs.pullfrog.com/bedrock`;
}

function buildVertexSetupError(params: { owner: string; name: string; missing: string[] }): string {
  const githubSecretsUrl = `https://github.com/${params.owner}/${params.name}/settings/secrets/actions`;

  return `Google Vertex AI model selected but required configuration is missing: ${params.missing.join(", ")}.

add the missing secret(s) to your GitHub repository at ${githubSecretsUrl}, then reference them in your workflow's \`env:\` block:

  ${VERTEX_SERVICE_ACCOUNT_JSON_ENV}: \${{ secrets.${VERTEX_SERVICE_ACCOUNT_JSON_ENV} }}
  ${GOOGLE_CLOUD_PROJECT_ENV}: my-project
  ${VERTEX_LOCATION_ENV}: global
  ${VERTEX_MODEL_ID_ENV}: <vertex-model-id>

for full setup instructions, see https://docs.pullfrog.com/vertex`;
}

function buildOpenAICompatibleSetupError(params: {
  owner: string;
  name: string;
  missing: string[];
}): string {
  const githubSecretsUrl = `https://github.com/${params.owner}/${params.name}/settings/secrets/actions`;

  return `OpenAI-compatible model selected but required configuration is missing: ${params.missing.join(", ")}.

only the API key is sensitive — add it as a secret at ${githubSecretsUrl}. everything else is plain workflow \`env:\`:

  ${OPENAI_COMPATIBLE_BASE_URL_ENV}: https://your-endpoint.example.com/v1
  ${OPENAI_COMPATIBLE_API_KEY_ENV}: \${{ secrets.${OPENAI_COMPATIBLE_API_KEY_ENV} }}
  ${OPENAI_COMPATIBLE_MODEL_ENV}: <model-id>
  ${OPENAI_COMPATIBLE_CONTEXT_ENV}: "128000"
  ${OPENAI_COMPATIBLE_MAX_OUTPUT_ENV}: "16384"

set the last two to the real limits of the model your endpoint serves. Pullfrog can't
discover them — your endpoint owns the model catalog — and without them completions are
capped at 32000 tokens (rejected outright by models with a smaller cap) and
auto-compaction is disabled, so long runs grow until your endpoint refuses them.

for full setup instructions, see https://docs.pullfrog.com/openai-compatible`;
}

function buildAzureSetupError(params: { owner: string; name: string; missing: string[] }): string {
  const githubSecretsUrl = `https://github.com/${params.owner}/${params.name}/settings/secrets/actions`;

  return `Azure OpenAI selected but required configuration is missing: ${params.missing.join(", ")}.

only the API key is sensitive — add it as a secret at ${githubSecretsUrl}. the rest is plain workflow \`env:\`:

  ${AZURE_RESOURCE_NAME_ENV}: <name>
  ${AZURE_API_KEY_ENV}: \${{ secrets.${AZURE_API_KEY_ENV} }}
  ${AZURE_DEPLOYMENT_ENV}: <deployment-name>
  ${AZURE_CONTEXT_ENV}: "400000"
  ${AZURE_MAX_OUTPUT_ENV}: "128000"

${AZURE_RESOURCE_NAME_ENV} is the \`<name>\` in your endpoint https://<name>.openai.azure.com.
${AZURE_DEPLOYMENT_ENV} is the name of the deployment, which is not necessarily the name of
the model it serves — Azure routes on the deployment name.

set the last two to the real limits of whichever model your deployment serves. Pullfrog can't
discover them — a deployment name carries no catalog metadata — and without them completions
are capped at 32000 tokens (rejected outright by models with a smaller cap) and auto-compaction
is disabled, so long runs grow until Azure refuses them.

for full setup instructions, see https://docs.pullfrog.com/azure`;
}

function hasEnvVar(name: string): boolean {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0;
}

/**
 * Whether this run actually holds a credential that can serve `model`.
 * Managed credentials count: `openai` carries `CODEX_AUTH_JSON`, so a run
 * authenticated by `pullfrog auth codex` has no `OPENAI_API_KEY` and would
 * otherwise read as unservable on every `openai/*` entry. A model with no
 * declared credential at all (off-registry provider) stays eligible rather
 * than being refused on our own ignorance.
 *
 * Private on purpose. `autoSelectModel`'s `servable` looks like a duplicate
 * but asks a stricter question — "may I PIN this alias?" — and must stay
 * conservative about managed credentials: Codex eligibility is a separate
 * upstream allow list that `opencode models` doesn't honor, so a
 * `CODEX_AUTH_JSON` run is better left to opencode's own pick than handed
 * `openai/gpt-5.6-sol`. Don't widen this to share it with the picker.
 */
function modelHasRuntimeAuth(model: string): boolean {
  const authVars = [...getModelEnvVars(model), ...getModelManagedCredentials(model)];
  return authVars.length === 0 || authVars.some(hasEnvVar);
}

/** the token limits are numbers, so presence isn't enough — `128k` must fail here. */
function hasPositiveNumberEnvVar(name: string): boolean {
  return Number(process.env[name]) > 0;
}

function validateOpenAICompatibleSetup(params: { owner: string; name: string }): void {
  const missing: string[] = [];
  if (!hasEnvVar(OPENAI_COMPATIBLE_BASE_URL_ENV)) missing.push(OPENAI_COMPATIBLE_BASE_URL_ENV);
  if (!hasEnvVar(OPENAI_COMPATIBLE_API_KEY_ENV)) missing.push(OPENAI_COMPATIBLE_API_KEY_ENV);
  if (!hasEnvVar(OPENAI_COMPATIBLE_MODEL_ENV)) missing.push(OPENAI_COMPATIBLE_MODEL_ENV);
  // required, not optional: opencode has no catalog metadata for a user-supplied
  // endpoint, and an undeclared limit both caps completions at 32000 and disables
  // auto-compaction for the whole run. see openAICompatibleLimit().
  if (!hasPositiveNumberEnvVar(OPENAI_COMPATIBLE_CONTEXT_ENV))
    missing.push(OPENAI_COMPATIBLE_CONTEXT_ENV);
  if (!hasPositiveNumberEnvVar(OPENAI_COMPATIBLE_MAX_OUTPUT_ENV))
    missing.push(OPENAI_COMPATIBLE_MAX_OUTPUT_ENV);

  if (missing.length > 0) {
    throw new Error(
      buildOpenAICompatibleSetupError({ owner: params.owner, name: params.name, missing })
    );
  }
}

function validateAzureSetup(params: { owner: string; name: string }): void {
  const missing: string[] = [];
  if (!hasEnvVar(AZURE_API_KEY_ENV)) missing.push(AZURE_API_KEY_ENV);
  if (!hasEnvVar(AZURE_RESOURCE_NAME_ENV)) missing.push(AZURE_RESOURCE_NAME_ENV);
  if (!hasEnvVar(AZURE_DEPLOYMENT_ENV)) missing.push(AZURE_DEPLOYMENT_ENV);
  // required for the same reason openai-compatible requires its pair: a deployment
  // name carries no catalog metadata, so `azureProvider()` has to declare the
  // limits itself or opencode falls back to 32000 max_tokens with no compaction.
  if (!hasPositiveNumberEnvVar(AZURE_CONTEXT_ENV)) missing.push(AZURE_CONTEXT_ENV);
  if (!hasPositiveNumberEnvVar(AZURE_MAX_OUTPUT_ENV)) missing.push(AZURE_MAX_OUTPUT_ENV);

  if (missing.length > 0) {
    throw new Error(buildAzureSetupError({ owner: params.owner, name: params.name, missing }));
  }
}

function validateBedrockSetup(params: { owner: string; name: string }): void {
  const hasAuth =
    hasEnvVar("AWS_BEARER_TOKEN_BEDROCK") ||
    (hasEnvVar("AWS_ACCESS_KEY_ID") && hasEnvVar("AWS_SECRET_ACCESS_KEY"));

  const missing: string[] = [];
  if (!hasAuth)
    missing.push("AWS_BEARER_TOKEN_BEDROCK (or AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY)");
  if (!hasEnvVar("AWS_REGION")) missing.push("AWS_REGION");
  if (!hasEnvVar(BEDROCK_MODEL_ID_ENV)) missing.push(BEDROCK_MODEL_ID_ENV);

  if (missing.length > 0) {
    throw new Error(buildBedrockSetupError({ owner: params.owner, name: params.name, missing }));
  }
}

function validateVertexSetup(params: { owner: string; name: string }): void {
  const hasAuth = hasEnvVar(VERTEX_SERVICE_ACCOUNT_JSON_ENV);
  const hasProject =
    hasEnvVar(GOOGLE_CLOUD_PROJECT_ENV) ||
    readProjectIdFromVertexServiceAccountJson() !== undefined;

  const missing: string[] = [];
  if (!hasAuth) missing.push(VERTEX_SERVICE_ACCOUNT_JSON_ENV);
  if (!hasProject) missing.push(GOOGLE_CLOUD_PROJECT_ENV);
  if (!hasEnvVar(VERTEX_LOCATION_ENV)) missing.push(VERTEX_LOCATION_ENV);
  if (!hasEnvVar(VERTEX_MODEL_ID_ENV)) missing.push(VERTEX_MODEL_ID_ENV);

  if (missing.length > 0) {
    throw new Error(buildVertexSetupError({ owner: params.owner, name: params.name, missing }));
  }
}

/**
 * The single-vendor harnesses each accept one API key or one subscription
 * credential, so "can this agent authenticate at all" is a fixed-env-var check.
 * OpenCode is the exception and answers from its own model introspection.
 *
 * `ANTHROPIC_AUTH_TOKEN` is claude-code's gateway credential — the same value as
 * `ANTHROPIC_API_KEY` but sent as `Authorization: Bearer` instead of `x-api-key`,
 * and the one Anthropic tells gateway users to reach for first. It is recognised
 * HERE only, never in `providers.anthropic.envVars`: that list feeds
 * `getModelEnvVars`, so adding it there would wave an opencode run through
 * validation on a variable opencode cannot use.
 */
function hasSingleProviderAuth(agentName: string): boolean {
  if (agentName === "codex") {
    return hasEnvVar("OPENAI_API_KEY") || hasEnvVar("CODEX_AUTH_JSON");
  }
  if (agentName === "dsh") {
    return hasEnvVar("DEEPSEEK_API_KEY");
  }
  return (
    hasEnvVar("ANTHROPIC_API_KEY") ||
    hasEnvVar("ANTHROPIC_AUTH_TOKEN") ||
    hasEnvVar("CLAUDE_CODE_OAUTH_TOKEN")
  );
}

/**
 * Validate that the resolved model can actually be served by the chosen
 * agent. For routing slugs (Bedrock / Vertex) the auth shape is multi-var
 * (auth + region/location + model-id) and `opencode models` doesn't catch
 * gaps in the latter two — keep dedicated setup validators. For the
 * opencode path, the authoritative answer comes from OpenCode's own model
 * introspection (`authorized` set captured in `openCodeModels.ts`). For
 * the claude path, fall back to the static check (`ANTHROPIC_API_KEY` /
 * `CLAUDE_CODE_OAUTH_TOKEN`).
 */
export function validateAgentApiKey(params: {
  agent: { name: string };
  model: string | undefined;
  authorized: Set<string>;
  owner: string;
  name: string;
  /** run-context couldn't hand over Pullfrog-stored secrets, so a missing key
   * says nothing about what the user actually configured. */
  secretsUnavailable?: boolean | undefined;
  routerUnfunded?: boolean | undefined;
}): void {
  if (params.model) {
    const alias = resolveDisplayAlias(params.model);
    if (alias?.routing === "bedrock") {
      validateBedrockSetup({ owner: params.owner, name: params.name });
      return;
    }
    if (alias?.routing === "vertex") {
      validateVertexSetup({ owner: params.owner, name: params.name });
      return;
    }

    // openai-compatible keeps its `openai-compatible/` provider prefix through
    // resolution (slug `openai-compatible/byok` → specifier
    // `openai-compatible/<OPENAI_COMPATIBLE_MODEL>`), so one prefix check covers
    // both forms. its custom provider isn't in the opencode `authorized`
    // snapshot (it's injected into OPENCODE_CONFIG_CONTENT only at run time), so
    // validate the env-supplied base URL / key / model directly.
    if (params.model.startsWith(`${OPENAI_COMPATIBLE_PROVIDER}/`)) {
      validateOpenAICompatibleSetup({ owner: params.owner, name: params.name });
      return;
    }

    // azure resolves to `azure/<deployment>`, and a deployment name that isn't
    // also a models.dev azure model id is absent from the `authorized` snapshot
    // however correct the credentials are — so the prefix check has to precede
    // it, same as openai-compatible above.
    if (params.model.startsWith(`${AZURE_PROVIDER}/`)) {
      validateAzureSetup({ owner: params.owner, name: params.name });
      return;
    }

    // raw backend model IDs (post-resolveModel for routing slugs) have no
    // `/`. discriminate by the env-var sentinel, then run the matching
    // setup validator — `opencode models` doesn't help here because the
    // Bedrock/Vertex provider plugins need region/location/model-id wired
    // through env regardless of CLI-side auth.
    if (!params.model.includes("/")) {
      if (process.env[VERTEX_MODEL_ID_ENV]?.trim() === params.model) {
        validateVertexSetup({ owner: params.owner, name: params.name });
        return;
      }
      validateBedrockSetup({ owner: params.owner, name: params.name });
      return;
    }

    if (params.agent.name === "opencode") {
      if (params.authorized.has(params.model)) return;
      // an empty authorized set means either "no auth" or "opencode couldn't
      // start" — an unloadable repo config being the usual second case. prefer
      // opencode's own reason over sending the user to their secrets page.
      const reason = getModelsFailure();
      if (reason) throw new Error(reason);
      // `opencode models` can exit 0 having printed only a prefix of its
      // catalog, so a missing entry is not proof the key is absent — a run
      // failed or passed purely on where its slug sorted against the cut. only
      // trust the absence when the model's own env var is unset too.
      if (getModelEnvVars(params.model).some(hasEnvVar)) return;
      throw new Error(
        buildKeyError({
          owner: params.owner,
          name: params.name,
          model: params.model,
          secretsUnavailable: params.secretsUnavailable,
          routerUnfunded: params.routerUnfunded,
        })
      );
    }

    // claude / codex: single-provider check on that vendor's auth shapes.
    if (hasSingleProviderAuth(params.agent.name)) return;
    throw new Error(
      buildKeyError({
        owner: params.owner,
        name: params.name,
        model: params.model,
        secretsUnavailable: params.secretsUnavailable,
        routerUnfunded: params.routerUnfunded,
      })
    );
  }

  // no model configured (auto-select path).
  if (params.agent.name === "opencode") {
    // a non-empty catalog is NOT proof of a credential: opencode lists Zen's
    // free models with no key at all, so `size > 0` waved through exactly the
    // runs that had nothing to authenticate with, and `autoSelectModel` then
    // handed the pick to opencode, which died at the provider with a bare
    // `Missing Authentication header`. require what the configured-model branch
    // above requires — a model whose own env var is actually set. an
    // off-registry provider yields `[]` and stays eligible, so a key we don't
    // catalog still passes.
    if ([...params.authorized].some(modelHasRuntimeAuth)) return;
    // same reasoning as the configured-model branch above: an unloadable repo
    // config empties the model set, and it is the likelier cause here too.
    const reason = getModelsFailure();
    if (reason) throw new Error(reason);
    throw new Error(
      buildKeyError({
        owner: params.owner,
        name: params.name,
        secretsUnavailable: params.secretsUnavailable,
        routerUnfunded: params.routerUnfunded,
      })
    );
  }
  if (hasSingleProviderAuth(params.agent.name)) return;
  throw new Error(
    buildKeyError({
      owner: params.owner,
      name: params.name,
      secretsUnavailable: params.secretsUnavailable,
      routerUnfunded: params.routerUnfunded,
    })
  );
}

/**
 * Detect agent-runtime auth failures that should be reformatted as an actionable
 * key-fix CTA before being shown to the user. Covers the shapes we see:
 *   - missing key (validateAgentApiKey throw): contains MISSING_KEY_MARKER
 *   - revoked / invalid key (Claude CLI 401 surfaced via api_error_status):
 *     "Invalid API key · Fix external API key" + similar provider variants
 *   - direct-Anthropic 401 (`Failed to authenticate. API Error: 401 ...
 *     {"type":"error","error":{"type":"authentication_error", ...
 *     "Invalid bearer token"}}`) emitted by the Claude CLI for revoked /
 *     mistyped / rotated `ANTHROPIC_API_KEY`. see #782.
 *   - expired credentials (#931): Bedrock 403 `Failed to authenticate. API
 *     Error: 403 {"Message":"*** has expired"}` (short-lived bearer tokens),
 *     OpenAI OAuth "Your authentication token has expired", and Codex
 *     "Token refresh failed: 401". the Bedrock pattern is anchored to the
 *     Claude CLI emission ("Failed to authenticate. API Error:") so generic
 *     auth chatter in agent stderr can't misclassify a hang as a key error.
 *   - DeepSeek invalid key (#960): `Authentication Fails, Your api key:
 *     ****XXXX is invalid`. anchored to "Your api key: ... is invalid" so it
 *     can't collide with DeepSeek's already-handled `Insufficient balance`
 *     billing shape (which routes to formatProviderBillingExhausted).
 *   - org-disabled Claude subscription (#1072): `Your organization has
 *     disabled Claude subscription access for Claude Code`, an entitlement
 *     denial with its own remedy — see isClaudeSubscriptionDisabledError.
 */
export function isApiKeyAuthError(text: string): boolean {
  if (!text) return false;
  return (
    text.includes(MISSING_KEY_MARKER) ||
    /Invalid API key/i.test(text) ||
    /\bUser not found\b/i.test(text) ||
    /\bInvalid authentication\b/i.test(text) ||
    /authentication_error/i.test(text) ||
    /Invalid bearer token/i.test(text) ||
    /api_error_status\s*=\s*401/i.test(text) ||
    /API Error:\s*401/i.test(text) ||
    /Failed to authenticate\. API Error:/i.test(text) ||
    /Your api key:.*is invalid/i.test(text) ||
    isMalformedKeyError(text) ||
    isClaudeSubscriptionDisabledError(text) ||
    isClaudeSessionLimitError(text) ||
    isOAuthCredentialExpiredError(text)
  );
}

/**
 * Dead OAuth-connection credential — the provider is telling us the token
 * itself is finished (expired, invalidated, revoked, or unrecognised), and the
 * only fix is to re-authenticate the connection (`pullfrog auth <provider>`),
 * never to rotate a repo-secret API key. `formatApiKeyErrorSummary` renders
 * distinct copy for the whole class.
 *
 * Match the SHAPE, not the sentence. Four prior issues (#931, #1041, #1072,
 * #1122) each landed one more literal and the next provider rewording walked
 * straight through, so these patterns are parameterised over the two things
 * that vary — which token noun the provider uses, and which terminal state it
 * reports. Still deliberately narrow on the noun ("authentication token" /
 * "OAuth access token", never bare "token") so a GitHub installation-token
 * expiry can't be misread as an LLM credential problem.
 */
export function isOAuthCredentialExpiredError(text: string): boolean {
  return (
    // the copula is parameterised for the same reason the noun and the state
    // are: OpenAI writes `Provided authentication token IS expired.` (#1180).
    // the noun list stays narrow so a GitHub installation-token expiry can
    // still never be misread as an LLM credential problem.
    /(?:authentication|OAuth access) token (?:has |is |was )?(?:expired|been (?:invalidated|revoked))/i.test(
      text
    ) ||
    // the provider no longer recognises the token at all (#1086) — same dead
    // credential, phrased as a lookup miss rather than a state transition.
    /Could not find the appropriate key in your authentication token/i.test(text) ||
    /Token refresh failed/i.test(text)
  );
}

/**
 * The key itself is unsendable, not wrong: a line-wrapped paste leaves an
 * interior newline, and the provider SDK refuses to serialize the header
 * (`API Error: Header '14' has invalid value`). The only member of the
 * credential-error family whose remedy is NOT "rotate the key" — re-saving the
 * same value on one line fixes it. See #1162.
 */
export function isMalformedKeyError(text: string): boolean {
  return /Header '\d+' has invalid value/i.test(text);
}

/**
 * Anthropic entitlement denial for Claude Pro/Max subscription auth (#1072):
 * an org admin turned off Claude Code subscription access. no credential the
 * user controls fixes it, so it gets its own copy instead of the re-auth CTA.
 */
export function isClaudeSubscriptionDisabledError(text: string): boolean {
  return /disabled Claude subscription access/i.test(text);
}

/**
 * Claude Pro/Max usage cap (#1104): `You've hit your session limit · resets
 * 9:20pm (UTC)`. A quota condition, not a credential one — the subscription is
 * healthy and will work again at the reset.
 *
 * The rungs are ENUMERATED rather than matched with a wildcard. A `[A-Za-z]+`
 * slot also swallows OpenAI Codex's `You've hit your usage limit.`, and the copy
 * this gates hardcodes "Your Claude subscription" and an `ANTHROPIC_API_KEY`
 * remedy — so a ChatGPT-subscription run (a supported configuration; see
 * `installCodexAuth`) would be told to fix a subscription it does not have.
 * That is the exact wrong-CTA defect this classifier exists to prevent.
 *
 * Capture group 1 is the reset stamp when present, bounded by quote/newline
 * because the message often arrives inside a JSON dump — a greedy `.+` there
 * renders `9:20pm (UTC)","type":...` into the user-facing copy.
 */
const CLAUDE_SESSION_LIMIT_PATTERN =
  /hit your (?:session|weekly|five-hour|Opus|Sonnet|Haiku)\s+limit(?:\s*·\s*resets\s+([^"\n]+))?/i;

export function isClaudeSessionLimitError(text: string): boolean {
  return CLAUDE_SESSION_LIMIT_PATTERN.test(text);
}

/**
 * Subscription credentials are re-authenticated, never rotated: there is no
 * provider dashboard to visit and no API key to paste. Telling their owner to
 * "rotate the key in your provider dashboard, then update the matching GitHub
 * Actions secret" names three things that do not exist for them — which is what
 * a revoked `CLAUDE_CODE_OAUTH_TOKEN` was answered with 47 times in a row
 * before this existed, because Anthropic's rejection reads `Invalid bearer
 * token` and that is also what a rotated `ANTHROPIC_API_KEY` reads (#782).
 * The credential in play is knowable, so it decides the copy — never the prose.
 */
const SUBSCRIPTION_CREDENTIALS: Record<string, { label: string; command: string; docs: string }> = {
  CLAUDE_CODE_OAUTH_TOKEN: {
    label: "Claude Pro/Max subscription",
    command: "pullfrog auth claude",
    docs: "https://docs.pullfrog.com/claude-auth",
  },
  CODEX_AUTH_JSON: {
    label: "ChatGPT subscription",
    command: "pullfrog auth codex",
    docs: "https://docs.pullfrog.com/codex-auth",
  },
};

/**
 * The provider rejected a credential we checked before the agent started, and
 * nothing else on the account can serve this run. Names the credential and the
 * place it actually lives, rather than guessing from the provider's wording.
 */
export function buildRejectedCredentialError(params: {
  credential: string;
  /** the provider's own message, when it gave one worth quoting. */
  reason: string | undefined;
  owner: string;
  name: string;
  /** stored in Pullfrog (console / `pullfrog auth`) rather than a GitHub Actions secret. */
  inPullfrogStore: boolean;
}): string {
  const settingsUrl = `${getApiUrl()}/console/${params.owner}/${params.name}`;
  const subscription = SUBSCRIPTION_CREDENTIALS[params.credential];
  const detail = params.reason ? ` (\`${params.reason}\`)` : "";

  if (subscription) {
    return [
      `**Your ${subscription.label} ${CREDENTIAL_REJECTED_MARKER}**${detail}, so the agent never ran.`,
      "",
      `**To fix:** re-authenticate with \`${subscription.command}\`. A subscription credential can't be rotated from a provider dashboard — it has to be re-issued. You can also switch this repo to a model you hold an API key for.`,
      "",
      `[Re-authenticate →](${subscription.docs}) · [Model settings →](${settingsUrl}) · [Ask in Discord →](https://discord.gg/8y96raFg8e)`,
    ].join("\n");
  }

  const where = params.inPullfrogStore
    ? `[Update it in Pullfrog →](${settingsUrl})`
    : `[Update the GitHub Actions secret →](https://github.com/${params.owner}/${params.name}/settings/secrets/actions)`;

  return [
    `**Your \`${params.credential}\` ${CREDENTIAL_REJECTED_MARKER}**${detail}, so the agent never ran.`,
    "",
    `**To fix:** issue a new key in your provider dashboard and update the copy Pullfrog uses${params.inPullfrogStore ? " in the console" : " in your repo's GitHub Actions secrets"}.`,
    "",
    `${where} · [Model settings →](${settingsUrl}) · [Setup docs →](https://docs.pullfrog.com/keys) · [Ask in Discord →](https://discord.gg/8y96raFg8e)`,
  ].join("\n");
}

/**
 * Friendly Markdown summary for both the missing-key and invalid-key cases.
 * Used in the catch / result-failure paths in `main.ts` to overwrite the raw
 * agent error before it's posted to the PR progress comment.
 */
export function formatApiKeyErrorSummary(params: {
  owner: string;
  name: string;
  raw: string;
}): string {
  if (params.raw.includes(MISSING_KEY_MARKER)) {
    // a verbatim validateAgentApiKey throw is already the full rendered body
    // (model-specific copy included) — pass it through. only rebuild the
    // generic copy when the marker is embedded in surrounding noise (e.g. a
    // hang body that swallowed the original message).
    if (params.raw.startsWith(`**${MISSING_KEY_MARKER}**`)) return params.raw;
    return buildMissingApiKeyError({ owner: params.owner, name: params.name });
  }

  const githubSecretsUrl = `https://github.com/${params.owner}/${params.name}/settings/secrets/actions`;
  const settingsUrl = `${getApiUrl()}/console/${params.owner}/${params.name}`;

  // the subscription hit its usage cap. checked before every credential branch
  // below: nothing is wrong with the token, so a "rotate your key" CTA would
  // send the user to fix something that isn't broken. lead with the reset time
  // — it's the only thing that stops them re-triggering into the same wall.
  if (isClaudeSessionLimitError(params.raw)) {
    const reset = CLAUDE_SESSION_LIMIT_PATTERN.exec(params.raw)?.[1]?.trim();
    const resets = reset ? ` It resets at **${reset}**.` : "";
    return [
      `**Your Claude subscription has hit its usage limit.**${resets} Re-trigger Pullfrog after the reset, or add an \`ANTHROPIC_API_KEY\` repo secret — Pullfrog routes around an exhausted subscription automatically when one is present.`,
      "",
      `[Add repo secret →](${githubSecretsUrl}) · [Model settings →](${settingsUrl}) · [Setup docs →](https://docs.pullfrog.com/keys) · [Ask in Discord →](https://discord.gg/8y96raFg8e)`,
    ].join("\n");
  }

  // the value is unsendable rather than wrong, so every "rotate the key" CTA
  // below would send the user to replace a key that is probably fine.
  if (isMalformedKeyError(params.raw)) {
    return [
      "**Your stored API key can't be sent as an HTTP header.** It contains a line break or control character — usually a key pasted across several lines. Re-save it as a single line; the key itself is likely fine.",
      "",
      `[Pullfrog secrets →](${getApiUrl()}/console/${params.owner}) · [Repo secrets →](${githubSecretsUrl}) · [Ask in Discord →](https://discord.gg/8y96raFg8e)`,
    ].join("\n");
  }

  // an org admin disabled Claude Code subscription access — re-authenticating
  // can't clear an entitlement flag, so name the two remedies the provider's
  // own message spells out.
  if (isClaudeSubscriptionDisabledError(params.raw)) {
    return [
      `**Your organization has disabled Claude subscription access for Claude Code.** Ask your Claude organization's admin to re-enable it in the Claude Console, or set an \`ANTHROPIC_API_KEY\` for this repo instead, then re-trigger the run.`,
      "",
      `[Add repo secret →](${githubSecretsUrl}) · [Model settings →](${settingsUrl}) · [Setup docs →](https://docs.pullfrog.com/keys) · [Ask in Discord →](https://discord.gg/8y96raFg8e)`,
    ].join("\n");
  }

  // OAuth-connection credentials (Codex / provider OAuth) aren't repo
  // secrets — "rotate the key, update the GitHub secret" is wrong advice.
  if (isOAuthCredentialExpiredError(params.raw)) {
    return [
      `**Your provider OAuth credential has expired or been revoked.** Re-authenticate the provider connection (e.g. \`pullfrog auth claude\` / \`pullfrog auth codex\`), then re-trigger the run.`,
      "",
      `[Claude subscription →](https://docs.pullfrog.com/claude-auth) · [ChatGPT subscription →](https://docs.pullfrog.com/codex-auth) · [Model settings →](${settingsUrl}) · [Ask in Discord →](https://discord.gg/8y96raFg8e)`,
    ].join("\n");
  }

  // the provider's wording can't tell a revoked subscription token from a
  // rotated API key — both read `Invalid bearer token` — so fall back to the
  // credential actually in this run's env before assuming there is a key to
  // rotate. only reachable when a credential dies mid-run: a dead one is
  // deleted from env by `checkConfiguredCredentials` before the agent starts.
  const subscription = Object.keys(SUBSCRIPTION_CREDENTIALS).find(hasEnvVar);
  if (subscription && !hasEnvVar("ANTHROPIC_API_KEY")) {
    const details = SUBSCRIPTION_CREDENTIALS[subscription];
    return [
      `**Your ${details?.label} was rejected during this run.** Re-authenticate with \`${details?.command}\` and re-trigger — a subscription credential can't be rotated from a provider dashboard.`,
      "",
      `[Re-authenticate →](${details?.docs}) · [Model settings →](${settingsUrl}) · [Ask in Discord →](https://discord.gg/8y96raFg8e)`,
    ].join("\n");
  }

  return [
    `**Your LLM provider API key was rejected.** Rotate the key in your provider dashboard, then update the matching GitHub Actions secret.`,
    "",
    `[Update repo secret →](${githubSecretsUrl}) · [Model settings →](${settingsUrl}) · [Setup docs →](https://docs.pullfrog.com/keys) · [Ask in Discord →](https://discord.gg/8y96raFg8e)`,
  ].join("\n");
}
