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
  getOpenCodeEnvVars,
  modelAliases,
  OPENAI_COMPATIBLE_PROVIDER,
  openAICompatibleEnv,
  providers,
  resolveDisplayAlias,
  TRIAL_FUNDED_USD_LIMIT,
  VERTEX_MODEL_ID_ENV,
} from "../models.ts";
import { getApiUrl } from "./apiUrl.ts";
import { PULLFROG_DATA_DIR, unhostedSubscriptions } from "./codexHome.ts";
import { DISCORD_LINK, type FailureLink, renderFailure } from "./failureBody.ts";
import { keylessRejection } from "./keylessAuth.ts";
import { getModelsFailure } from "./openCodeModels.ts";
import { PROVIDER_DASHBOARDS } from "./providerDashboards.ts";
import type { CredentialCandidate } from "./subscriptionCredentials.ts";
import type { ProbeVerdict } from "./subscriptionProbe.ts";
import {
  GOOGLE_CLOUD_PROJECT_ENV,
  readProjectIdFromVertexServiceAccountJson,
  VERTEX_LOCATION_ENV,
  VERTEX_SERVICE_ACCOUNT_JSON_ENV,
} from "./vertex.ts";

/** marker prefix on the throw message for the catch-side reclassification path */
const MISSING_KEY_MARKER = "No API key found";
/** shared sentence in the four `resolveSlug` routing-slug throws. */
export const BYOK_SLUG_MARKER = "must be set when the model is";
/** shared sentence in the four `validate*Setup` throws. */
export const BYOK_CONFIG_MARKER = "is missing required settings:";

/**
 * What an owned setup error looks like from character zero: an ALL-CAPS env var
 * name in a code span before the slug marker, or a capitalised provider name (up
 * to four words, for `Google Vertex AI`) before the config marker. Neither marker
 * contains a regex metacharacter, so both interpolate literally.
 */
const BYOK_SETUP_PATTERN = new RegExp(
  `^(?:\`[A-Z][A-Z0-9_]+\` ${BYOK_SLUG_MARKER}|[A-Z][\\w-]*(?: [\\w-]+){0,3} ${BYOK_CONFIG_MARKER})`
);

/**
 * A BYOK provider setup is incomplete, at either of the two points that catch it:
 * `resolveSlug` refusing a routing slug whose backing env var is unset, and the
 * per-provider `validate*Setup` check that runs once the slug resolves. All eight
 * messages already name what is missing, the remedy and a docs page, so the
 * renderer passes them through rather than rewriting them. Before this they
 * matched no branch at all, and `renderRunError` writes `errorMessage` to the job
 * summary but not to the comment — so the answer existed on every one of these
 * runs and the customer's PR comment read `Run failed.`
 *
 * Matched from character zero rather than searched anywhere in the text, because
 * a match publishes the WHOLE message verbatim to a customer's PR and
 * `errorMessage` is not always ours: `postRun` builds one out of a repo's own
 * stop-hook output, which is arbitrary text the customer's script printed. A
 * message that merely CONTAINS one of these errors is something quoting us, and
 * passing it through would republish everything around it.
 */
export function isByokSetupError(text: string): boolean {
  return BYOK_SETUP_PATTERN.test(text);
}

/**
 * marker for the distinct "run-context couldn't hand over your stored secrets"
 * body. surfaced verbatim by `runErrorRenderer` (same contract as
 * `MODEL_ACCESS_MARKER`) because blaming the user for a transient fetch failure
 * on our side is the wrong CTA — their key is configured and still stored.
 */
export const SECRETS_UNAVAILABLE_MARKER = "couldn't load your stored secrets";

/**
 * marker for the "your Router wallet is empty AND you have no provider key"
 * body. its own marker rather than the missing-key one because
 * `formatApiKeyErrorSummary` rebuilds any body carrying `MISSING_KEY_MARKER`
 * that doesn't start with it, which would silently discard this copy.
 */
export const ROUTER_UNFUNDED_MARKER = "Your Pullfrog Router balance is empty";

/**
 * marker for the body a trial account gets once its funded credits are spent:
 * at the late fallback, or when the funded key runs out mid-run. Without it the
 * first is told to add an API key and the second that a Router wallet it never
 * had went negative, and neither mentions the trial.
 */
export const TRIAL_SPENT_MARKER = "reached the limit of your free trial credits";

export function buildTrialSpentError(params: { owner: string }): string {
  return renderFailure({
    headline: `You've ${TRIAL_SPENT_MARKER}.`,
    detail: `Your $${TRIAL_FUNDED_USD_LIMIT} of trial usage credits have been used up, so you'll need to connect a provider to continue using Pullfrog.`,
    links: [providerLink(params.owner)],
  });
}

/** the repo's console page: its model, instructions and scripts. */
export function repoConsoleUrl(repo: { owner: string; name: string }): string {
  return `${getApiUrl()}/console/${repo.owner}/${repo.name}`;
}

export function pickModelLink(repo: { owner: string; name: string }): FailureLink {
  return { label: "Pick another model", url: repoConsoleUrl(repo) };
}

/** the account console's billing card: provider keys, subscriptions and Router credit. */
export function providerLink(owner: string): FailureLink {
  return { label: "Connect a provider", url: `${getApiUrl()}/console/${owner}#billing` };
}

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
 * marker for the credential pool's refusal: every configured credential for the
 * model was rejected or exhausted. verbatim for the same reason as
 * `CREDENTIAL_REJECTED_MARKER` — each bullet quotes the probe's verdict.
 */
export const CREDENTIAL_POOL_REFUSED_MARKER = "No configured credential can serve this run";

/** marker for keyless auth that nothing could stand in for. verbatim: its reason quotes the provider. */
export const KEYLESS_UNUSABLE_MARKER = "keyless auth could not be used";

/**
 * Three ways to arrive at "the runner has no key", each with a different CTA:
 * we couldn't read the key you stored, your Router wallet ran dry and you have
 * no key of your own, or you genuinely have no key. Every throw site picks by
 * these flags.
 */
/**
 * Nothing in the environment can pay for this run — as distinct from a
 * credential that IS configured but incompletely (the Bedrock/Vertex/Azure/
 * OpenAI-compatible setup validators), an agent that could not start
 * (`getModelsFailure`), or Pullfrog failing to hand its own secrets over.
 *
 * The trial fallback keys on this class, and that is the whole reason it
 * exists: every other failure in `validateAgentApiKey` means the user HAS
 * brought a key, so falling back would swap their model for a cheap one and
 * swallow the message telling them what to fix.
 */
export class NoUsableCredentialError extends Error {}

/**
 * The three ways a run reaches the agent with nothing to authenticate with.
 * Only two of them are the user's to fix, and only those two are a
 * `NoUsableCredentialError`: when `secretsUnavailable` is set we could not
 * READ their Pullfrog-stored credentials, so we do not know whether they have
 * one — and guessing costs them a downgraded run to cover our own outage.
 */
function throwKeyError(params: {
  owner: string;
  name: string;
  model?: string | undefined;
  secretsUnavailable?: boolean | undefined;
  routerUnfunded?: boolean | undefined;
}): never {
  // not a `NoUsableCredentialError`: the user brought a credential, it just failed
  const keyless = keylessRejection(params.model);
  if (keyless) throw new Error(buildKeylessRejectedError({ ...keyless, owner: params.owner }));
  if (params.secretsUnavailable) throw new Error(buildSecretsUnavailableError());
  if (params.routerUnfunded) throw new NoUsableCredentialError(buildRouterUnfundedError(params));
  throw new NoUsableCredentialError(buildMissingApiKeyError(params));
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
function buildRouterUnfundedError(params: { owner: string }): string {
  return renderFailure({
    headline: `${ROUTER_UNFUNDED_MARKER}, and this repo has no API key to fall back on.`,
    detail: "Add Router credit, or connect your own provider key or subscription.",
    links: [
      { label: "Billing and providers", url: `${getApiUrl()}/console/${params.owner}#billing` },
    ],
  });
}

export function buildSecretsUnavailableError(): string {
  return renderFailure({
    headline: `Pullfrog ${SECRETS_UNAVAILABLE_MARKER} for this run.`,
    detail:
      "They're still saved; this is a temporary failure on our side. Re-trigger to try again, and tell us in Discord if it keeps happening.",
    links: [DISCORD_LINK],
  });
}

/**
 * Markdown body used for both the thrown error and the formatted PR comment
 * summary. When the model is known, names it and the exact env var(s) it needs
 * so the user knows precisely what to fix; otherwise falls back to the generic
 * "any provider key" copy (auto-select path).
 *
 * The lead says "this run used" rather than "this repo is configured to use",
 * because the resolved model does not always come from the repo's config — a
 * trigger-time `--model=`, a `PULLFROG_MODEL` variable or a server-side canary
 * arm all land here too, and asserting provenance we do not have blames the
 * user's configuration for a model they never chose. A model canary did exactly
 * that to vite-hub/vitehub#1347 on 2026-09-08.
 */
function buildMissingApiKeyError(params: {
  owner: string;
  name: string;
  model?: string | undefined;
}): string {
  const envVars = params.model?.includes("/") ? getModelEnvVars(params.model) : [];
  const [primary, ...alternates] = envVars;
  const envVarList = primary
    ? `\`${primary}\`${alternates.length > 0 ? ` (or ${alternates.map((v) => `\`${v}\``).join(" / ")})` : ""}`
    : undefined;
  // the run passes the resolved id (`moonshotai/kimi-k2.7-code`); name the model as it was picked
  const alias = params.model
    ? (resolveDisplayAlias(params.model) ??
      modelAliases.find((a) => !a.fallback && a.resolve === params.model))
    : undefined;
  const modelName = params.model ? (alias?.displayName ?? `\`${params.model}\``) : undefined;

  const unhosted = params.model?.includes("/")
    ? getModelManagedCredentials(params.model).find((name) => unhostedSubscriptions.has(name))
    : undefined;
  const detail = unhosted
    ? `Your ${SUBSCRIPTION_CREDENTIALS[unhosted]?.label} is stored, but this runner has no passwordless \`sudo\`, which Pullfrog needs to keep it in \`${PULLFROG_DATA_DIR}\`, out of the agent's reach. Allow passwordless \`sudo\` for the runner user, run on a GitHub-hosted runner, or add an API key.`
    : envVarList
      ? `It needs ${envVarList}. Connect it in Pullfrog or add it as a GitHub Actions secret, or pick a model you already have a key for.`
      : "Pullfrog needs a key or subscription for at least one model provider. Connect one in Pullfrog, or add a key as a GitHub Actions secret.";

  return renderFailure({
    headline:
      envVarList && modelName
        ? `${MISSING_KEY_MARKER} for ${modelName}.`
        : `${MISSING_KEY_MARKER}.`,
    detail,
    links: [providerLink(params.owner), pickModelLink(params)],
  });
}

/** the setup copy's shared shape: what is missing, where to put it, the env block, a guide. */
function buildSetupError(params: {
  provider: string;
  missing: string[];
  where: string;
  env: string[];
  note?: string | undefined;
  guide: string;
}): string {
  const missing = params.missing.map((name) => `\`${name}\``).join(", ");
  return [
    `${params.provider} ${BYOK_CONFIG_MARKER} ${missing}. ${params.where}`,
    `\`\`\`yaml\n${params.env.join("\n")}\n\`\`\``,
    `${params.note ? `${params.note} ` : ""}[${params.provider} setup guide](${params.guide})`,
  ].join("\n\n");
}

function secretsUrl(params: { owner: string; name: string }): string {
  return `https://github.com/${params.owner}/${params.name}/settings/secrets/actions`;
}

function buildBedrockSetupError(params: {
  owner: string;
  name: string;
  missing: string[];
}): string {
  return buildSetupError({
    provider: "Amazon Bedrock",
    missing: params.missing,
    where: `Add them to [this repo's Actions secrets](${secretsUrl(params)}) and pass them in the workflow's \`env:\` block:`,
    env: [
      `AWS_BEARER_TOKEN_BEDROCK: \${{ secrets.AWS_BEARER_TOKEN_BEDROCK }}`,
      `AWS_REGION: \${{ secrets.AWS_REGION }}`,
      `${BEDROCK_MODEL_ID_ENV}: \${{ secrets.${BEDROCK_MODEL_ID_ENV} }}`,
    ],
    note: "`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (plus `AWS_SESSION_TOKEN` if you use one) can replace the bearer token.",
    guide: "https://docs.pullfrog.com/bedrock",
  });
}

function buildVertexSetupError(params: { owner: string; name: string; missing: string[] }): string {
  return buildSetupError({
    provider: "Google Vertex AI",
    missing: params.missing,
    where: `Add the service account to [this repo's Actions secrets](${secretsUrl(params)}) and set the rest in the workflow's \`env:\` block:`,
    env: [
      `${VERTEX_SERVICE_ACCOUNT_JSON_ENV}: \${{ secrets.${VERTEX_SERVICE_ACCOUNT_JSON_ENV} }}`,
      `${GOOGLE_CLOUD_PROJECT_ENV}: my-project`,
      `${VERTEX_LOCATION_ENV}: global`,
      `${VERTEX_MODEL_ID_ENV}: <vertex-model-id>`,
    ],
    guide: "https://docs.pullfrog.com/vertex",
  });
}

function buildOpenAICompatibleSetupError(params: {
  owner: string;
  name: string;
  missing: string[];
  env: ReturnType<typeof openAICompatibleEnv>;
}): string {
  return buildSetupError({
    provider: "OpenAI-compatible endpoint",
    missing: params.missing,
    where: `Set them on the OpenAI-compatible provider in [Pullfrog's provider settings](${getApiUrl()}/console/${params.owner}#billing), or in the workflow's \`env:\` block with the key as an [Actions secret](${secretsUrl(params)}):`,
    env: [
      `${params.env.baseUrl}: https://your-endpoint.example.com/v1`,
      `${params.env.apiKey}: \${{ secrets.${params.env.apiKey} }}`,
      `${params.env.model}: <model-id>`,
      `${params.env.context}: "128000"`,
      `${params.env.maxOutput}: "16384"`,
    ],
    note: "Use the real context and output limits of the model your endpoint serves: Pullfrog can't discover them, and without them long runs grow until the endpoint refuses them.",
    guide: "https://docs.pullfrog.com/openai-compatible",
  });
}

function buildAzureSetupError(params: { owner: string; name: string; missing: string[] }): string {
  return buildSetupError({
    provider: "Azure OpenAI",
    missing: params.missing,
    where: `Set them on the Azure OpenAI provider in [Pullfrog's provider settings](${getApiUrl()}/console/${params.owner}#billing), or in the workflow's \`env:\` block with the key as an [Actions secret](${secretsUrl(params)}):`,
    env: [
      `${AZURE_RESOURCE_NAME_ENV}: <name>`,
      `${AZURE_API_KEY_ENV}: \${{ secrets.${AZURE_API_KEY_ENV} }}`,
      `${AZURE_DEPLOYMENT_ENV}: <deployment-name>`,
      `${AZURE_CONTEXT_ENV}: "400000"`,
      `${AZURE_MAX_OUTPUT_ENV}: "128000"`,
    ],
    note: `\`${AZURE_RESOURCE_NAME_ENV}\` is the \`<name>\` in \`https://<name>.openai.azure.com\`, and \`${AZURE_DEPLOYMENT_ENV}\` is the deployment's name, not the model it serves. Use that model's real context and output limits: Pullfrog can't discover them, and without them long runs grow until Azure refuses them.`,
    guide: "https://docs.pullfrog.com/azure",
  });
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
 * `openai/gpt-6.1-sol`. Don't widen this to share it with the picker.
 */
function modelHasRuntimeAuth(model: string): boolean {
  const authVars = [...getOpenCodeEnvVars(model), ...getModelManagedCredentials(model)];
  return authVars.length === 0 || authVars.some(hasEnvVar);
}

/** the token limits are numbers, so presence isn't enough — `128k` must fail here. */
function hasPositiveNumberEnvVar(name: string): boolean {
  return Number(process.env[name]) > 0;
}

/** checks the run's endpoint under the names it is stored as: a named set's own variables
 * (`activateOpenAICompatibleSet` copied them into the bare ones), else the bare ones. */
function validateOpenAICompatibleSetup(params: {
  owner: string;
  name: string;
  set: string | undefined;
}): void {
  const env = openAICompatibleEnv(params.set);
  const missing: string[] = [];
  if (!hasEnvVar(env.baseUrl)) missing.push(env.baseUrl);
  if (!hasEnvVar(env.apiKey)) missing.push(env.apiKey);
  if (!hasEnvVar(env.model)) missing.push(env.model);
  // required, not optional: opencode has no catalog metadata for a user-supplied
  // endpoint, and an undeclared limit both caps completions at 32000 and disables
  // auto-compaction for the whole run. see openAICompatibleLimit().
  if (!hasPositiveNumberEnvVar(env.context)) missing.push(env.context);
  if (!hasPositiveNumberEnvVar(env.maxOutput)) missing.push(env.maxOutput);

  if (missing.length > 0) {
    throw new Error(
      buildOpenAICompatibleSetupError({ owner: params.owner, name: params.name, missing, env })
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
  /** the named OpenAI-compatible set the run is on, from `activateOpenAICompatibleSet`. */
  openAICompatibleSet?: string | undefined;
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
      validateOpenAICompatibleSetup({
        owner: params.owner,
        name: params.name,
        set: params.openAICompatibleSet,
      });
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
    // both sentinels are checked, because `resolveSlug` returns the env var's
    // value verbatim — so a slash-less model matching NEITHER did not come from
    // a routing slug at all. It is an unknown slug `resolveModel` passed through
    // (having already warned "agent will auto-select"), and answering that with
    // "Bedrock model selected but required configuration is missing" is advice
    // about a provider the user never picked. Falling through sends it to the
    // ordinary checks, where `getModelEnvVars` reports the actual `invalid
    // model slug`. That is still not a `NoUsableCredentialError`, so a trial
    // does not fund it — a typo'd slug is a fixable mistake, not a run nobody
    // can pay for.
    if (!params.model.includes("/")) {
      if (process.env[VERTEX_MODEL_ID_ENV]?.trim() === params.model) {
        validateVertexSetup({ owner: params.owner, name: params.name });
        return;
      }
      if (process.env[BEDROCK_MODEL_ID_ENV]?.trim() === params.model) {
        validateBedrockSetup({ owner: params.owner, name: params.name });
        return;
      }
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
      // trust the absence when the model's own env var is unset too. the rescue
      // asks `getOpenCodeEnvVars` because it is rescuing an OPENCODE run: a
      // Claude subscription token would otherwise wave through the very model
      // opencode is about to reject.
      if (getOpenCodeEnvVars(params.model).some(hasEnvVar)) return;
      throwKeyError({
        owner: params.owner,
        name: params.name,
        model: params.model,
        secretsUnavailable: params.secretsUnavailable,
        routerUnfunded: params.routerUnfunded,
      });
    }

    // claude / codex: single-provider check on that vendor's auth shapes.
    if (hasSingleProviderAuth(params.agent.name)) return;
    throwKeyError({
      owner: params.owner,
      name: params.name,
      model: params.model,
      secretsUnavailable: params.secretsUnavailable,
      routerUnfunded: params.routerUnfunded,
    });
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
    throwKeyError({
      owner: params.owner,
      name: params.name,
      secretsUnavailable: params.secretsUnavailable,
      routerUnfunded: params.routerUnfunded,
    });
  }
  if (hasSingleProviderAuth(params.agent.name)) return;
  throwKeyError({
    owner: params.owner,
    name: params.name,
    secretsUnavailable: params.secretsUnavailable,
    routerUnfunded: params.routerUnfunded,
  });
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
 *   - OpenAI rejected key: `Incorrect API key provided: sk-proj-***`, OpenAI's
 *     own wording for a revoked, rotated or wrong-project key. Absent from this
 *     list every such run rendered the generic one-line "Run failed." with no
 *     cause at all — measured on two accounts sitting at 100% failure, one of
 *     them for a week. Matched on the full phrase rather than "Incorrect API
 *     key" alone for the reason the markers above are phrased distinctively:
 *     this predicate short-circuits the whole rendering pipeline on a substring
 *     of arbitrary agent output.
 */
export function isApiKeyAuthError(text: string): boolean {
  if (!text) return false;
  return (
    text.includes(MISSING_KEY_MARKER) ||
    /Invalid API key/i.test(text) ||
    /Incorrect API key provided/i.test(text) ||
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
    isKimiPlanTierError(text) ||
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
    // the reversed word order: `Encountered invalidated oauth token for user` (#1474).
    /(?:expired|invalidated|revoked) (?:OAuth|authentication) token/i.test(text) ||
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
 * The probe sees the same denial as a 403, `OAuth authentication is currently
 * not allowed for this organization`, which used to be answered "sign in again".
 */
export function isClaudeSubscriptionDisabledError(text: string): boolean {
  return (
    /disabled Claude subscription access/i.test(text) ||
    /OAuth authentication is currently not allowed for this organization/i.test(text)
  );
}

/**
 * Kimi Code entitlement denial — the key is valid and the membership is live,
 * but the tier doesn't include the model or the context window the run asked
 * for (`k3` and `k3-256k` need Moderato, `kimi-for-coding-highspeed` and K3's
 * 1M window need Allegretto). Kimi answers all of them with **401**, the same
 * status as a revoked key, so nothing but the sentence tells them apart — and
 * without that the run renders "rotate the key in your provider dashboard",
 * which names three things that will not fix it.
 *
 * Both published shapes, parameterised over the clause that varies rather than
 * the model id inside it, per `isOAuthCredentialExpiredError`. Listed in
 * `isApiKeyAuthError` below so the branch is reachable whatever `type` Kimi
 * puts in the payload. See wiki/kimi-code.md.
 */
export function isKimiPlanTierError(text: string): boolean {
  return /Your current (?:subscription does not have access to|plan supports only)\b/i.test(text);
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
const SUBSCRIPTION_CREDENTIALS: Record<
  string,
  { label: string; command: string; provider: string }
> = {
  CLAUDE_CODE_OAUTH_TOKEN: {
    label: "Claude subscription",
    command: "pullfrog auth claude",
    provider: "anthropic",
  },
  CODEX_AUTH_JSON: {
    label: "ChatGPT subscription",
    command: "pullfrog auth codex",
    provider: "openai",
  },
  GROK_AUTH_JSON: {
    label: "Grok subscription",
    command: "pullfrog auth grok",
    provider: "xai",
  },
};

/** the subscription that serves `model`'s provider, named by the env var that carries it. */
export function subscriptionFor(model: string | undefined) {
  const provider = model?.split("/")[0];
  for (const [env, subscription] of Object.entries(SUBSCRIPTION_CREDENTIALS)) {
    if (subscription.provider === provider) return { env, ...subscription };
  }
  return undefined;
}

const SIGN_IN_AGAIN = (command: string) => `Sign in again by running \`${command}\` in a terminal`;

const CLAUDE_ORG_DISABLED = {
  headline: "Your Claude organization doesn't allow subscription sign-in for Claude Code.",
  detail:
    "Ask its admin to allow it in the Claude Console, or connect an Anthropic API key instead.",
};

/** a provider id's display name, e.g. `openai` → OpenAI. */
export function providerDisplayName(id: string | null | undefined): string | undefined {
  for (const [key, provider] of Object.entries(providers)) {
    if (key === id) return provider.displayName;
  }
  return undefined;
}

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
  const subscription = SUBSCRIPTION_CREDENTIALS[params.credential];
  const details = params.reason
    ? { summary: "The provider's response", text: params.reason }
    : undefined;

  if (subscription) {
    const orgDisabled =
      params.reason !== undefined && isClaudeSubscriptionDisabledError(params.reason);
    return renderFailure({
      headline: `Your ${subscription.label} ${CREDENTIAL_REJECTED_MARKER}.`,
      detail: orgDisabled
        ? `${CLAUDE_ORG_DISABLED.headline} ${CLAUDE_ORG_DISABLED.detail}`
        : `${SIGN_IN_AGAIN(subscription.command)}, or pick a model you have an API key for.`,
      details,
      links: [orgDisabled ? providerLink(params.owner) : pickModelLink(params)],
    });
  }

  const provider = credentialProvider(params.credential);
  const keysUrl = provider ? PROVIDER_DASHBOARDS[provider.id]?.keys : undefined;
  const update: FailureLink = params.inPullfrogStore
    ? {
        label: "Update it in Pullfrog",
        url: `${getApiUrl()}/console/${params.owner}/${params.name}`,
      }
    : { label: "Update the Actions secret", url: secretsUrl(params) };
  return renderFailure({
    headline: `Your ${provider ? `${provider.displayName} key` : "key"} \`${params.credential}\` ${CREDENTIAL_REJECTED_MARKER}.`,
    detail: `Issue a new key and update the copy ${params.inPullfrogStore ? "stored in Pullfrog" : "in this repo's GitHub Actions secrets"}.`,
    details,
    links: keysUrl ? [{ label: "Issue a new key", url: keysUrl }, update] : [update],
  });
}

/** keyless auth was set up for the provider, could not pay (refused, or set up incompletely), and nothing else could. */
function buildKeylessRejectedError(params: {
  provider: string;
  name: string;
  reason: string;
  owner: string;
}): string {
  const fix: FailureLink = {
    label: "Check keyless auth",
    url: `${getApiUrl()}/console/${params.owner}#billing`,
  };
  return renderFailure({
    headline: `Your ${params.name} ${KEYLESS_UNUSABLE_MARKER}.`,
    detail: `No other ${params.name} credential is set up to fall back to. If the provider refused the exchange, check that its rule matches this repo's Pullfrog runs.`,
    details: { summary: "Why", text: params.reason },
    links:
      params.provider === "anthropic"
        ? [
            {
              label: "Open the authentication history",
              url: "https://platform.claude.com/settings/workload-identity-federation?tab=history",
            },
            fix,
          ]
        : [fix],
  });
}

/**
 * The provider that owns this env var. First match wins, which only matters for
 * `OPENCODE_API_KEY` — Zen and Go share it, and both rows name the same keys
 * page, so the order is not load-bearing for `keys`.
 */
function credentialProvider(credential: string) {
  for (const [id, provider] of Object.entries(providers)) {
    if (provider.envVars.includes(credential)) return { id, displayName: provider.displayName };
  }
  return undefined;
}

export type RefusedCredential = {
  name: string;
  source: CredentialCandidate["source"] | "workflow";
  verdict: Extract<ProbeVerdict, { status: "rejected" | "exhausted" }>;
};

/**
 * The credential pool probed every credential configured for the model and
 * none can serve it. One sentence per credential, from its kind and status —
 * never inferred from the prose — with the probe's own verdicts collapsed below.
 */
export function buildCredentialPoolRefusedError(params: {
  model: string;
  refused: RefusedCredential[];
  owner: string;
  name: string;
}): string {
  const [first = "", second, ...rest] = params.refused.map((credential) =>
    describeRefusal({ credential, owner: params.owner, name: params.name })
  );
  return renderFailure({
    headline: `${CREDENTIAL_POOL_REFUSED_MARKER}.`,
    detail:
      second === undefined ? first : `Every credential for \`${params.model}\` was turned down:`,
    list: second === undefined ? undefined : [first, second, ...rest],
    details: {
      summary: "The providers' responses",
      text: params.refused
        .map((credential) => `${credential.name}: ${credential.verdict.detail}`)
        .join("\n"),
    },
    links: [pickModelLink(params)],
  });
}

function describeRefusal(params: { credential: RefusedCredential; owner: string; name: string }) {
  const credential = params.credential;
  const verdict = credential.verdict;
  const subscription = SUBSCRIPTION_CREDENTIALS[credential.name];
  const dashboard = PROVIDER_DASHBOARDS[credentialProvider(credential.name)?.id ?? ""];
  const what = subscription ? `Your ${subscription.label}` : `Your \`${credential.name}\``;
  if (verdict.status === "exhausted" && subscription) {
    const reset = verdict.resetAt
      ? `, which resets at **${verdict.resetAt.toISOString().slice(0, 16).replace("T", " ")} UTC**`
      : "";
    return `${what} has hit its usage limit${reset}. Re-trigger after it resets, or add an API key for this provider, which Pullfrog falls back to automatically.`;
  }
  if (verdict.status === "exhausted") {
    return `${what} is out of credit or quota. ${dashboard ? `[Add credit](${dashboard.billing})` : "Add credit"} with the provider, or raise its quota.`;
  }
  if (subscription && isClaudeSubscriptionDisabledError(verdict.detail)) {
    return `${CLAUDE_ORG_DISABLED.headline} ${CLAUDE_ORG_DISABLED.detail}`;
  }
  if (subscription) return `${what} was rejected. ${SIGN_IN_AGAIN(subscription.command)}.`;
  const issue = dashboard?.keys ? `[Issue a new key](${dashboard.keys})` : "Issue a new key";
  const where =
    credential.source === "workflow"
      ? `in [this repo's GitHub Actions secrets](${secretsUrl(params)})`
      : `in [Pullfrog](${getApiUrl()}/console/${params.owner}#billing)`;
  return `${what} was rejected. ${issue} and update it ${where}.`;
}

/**
 * Friendly Markdown summary for both the missing-key and invalid-key cases.
 * Used in the catch / result-failure paths in `main.ts` to overwrite the raw
 * agent error before it's posted to the PR progress comment. `model` names the
 * subscription in play — guessing it from the env once told a GPT run its Claude
 * subscription was rejected — and `output`, the provider's own words, is
 * collapsed under the copy.
 */
export function formatApiKeyErrorSummary(params: {
  owner: string;
  name: string;
  raw: string;
  model?: string | undefined;
  credential?: string | undefined;
  output?: string | undefined;
}): string {
  if (params.raw.includes(MISSING_KEY_MARKER)) {
    // a verbatim validateAgentApiKey throw is already the full rendered body
    // (model-specific copy included) — pass it through. only rebuild the
    // generic copy when the marker is embedded in surrounding noise (e.g. a
    // hang body that swallowed the original message).
    if (params.raw.startsWith(`**${MISSING_KEY_MARKER}`)) return params.raw;
    return buildMissingApiKeyError({ owner: params.owner, name: params.name });
  }

  const details = params.output
    ? { summary: "The provider's response", text: params.output }
    : undefined;
  const subscription = subscriptionFor(params.model);

  // the subscription hit its usage cap. checked before every credential branch
  // below: nothing is wrong with the token, so a "rotate your key" CTA would
  // send the user to fix something that isn't broken. lead with the reset time
  // — it's the only thing that stops them re-triggering into the same wall.
  if (isClaudeSessionLimitError(params.raw)) {
    const reset = CLAUDE_SESSION_LIMIT_PATTERN.exec(params.raw)?.[1]?.trim();
    return renderFailure({
      headline: "Your Claude subscription has hit its usage limit.",
      detail: `${reset ? `It resets at **${reset}**. ` : ""}Re-trigger after that, or connect an Anthropic API key, which Pullfrog falls back to automatically.`,
      details,
      links: [providerLink(params.owner)],
    });
  }

  // the value is unsendable rather than wrong, so every "rotate the key" CTA
  // below would send the user to replace a key that is probably fine.
  if (isMalformedKeyError(params.raw)) {
    return renderFailure({
      headline: "Your stored API key can't be sent as an HTTP header.",
      detail:
        "It contains a line break or control character, usually from a key pasted across several lines. Re-save it as a single line; the key itself is likely fine.",
      links: [
        {
          label: "Pullfrog provider settings",
          url: `${getApiUrl()}/console/${params.owner}#billing`,
        },
        { label: "GitHub Actions secrets", url: secretsUrl(params) },
      ],
    });
  }

  // an org admin disabled Claude Code subscription access — re-authenticating
  // can't clear an entitlement flag, so name the two remedies the provider's
  // own message spells out.
  if (isClaudeSubscriptionDisabledError(params.raw)) {
    return renderFailure({
      ...CLAUDE_ORG_DISABLED,
      details,
      links: [providerLink(params.owner)],
    });
  }

  // the Kimi membership doesn't cover the model that was asked for. same 401 a
  // revoked key returns, so it has to be checked before every rotate-the-key
  // branch below — the key is fine and there is nothing to re-issue.
  if (isKimiPlanTierError(params.raw)) {
    return renderFailure({
      headline: "Your Kimi membership doesn't include the model this run asked for.",
      detail:
        "Kimi K3 needs a Moderato plan or above, and K3's 1M context and Kimi K2 HighSpeed need Allegretto or above. Upgrade the membership, or switch this repo to **Kimi K2**, which every tier includes.",
      details,
      links: [
        { label: "Kimi plans", url: "https://www.kimi.com/membership/pricing" },
        pickModelLink(params),
      ],
    });
  }

  // OAuth-connection credentials (Codex / provider OAuth) aren't repo
  // secrets — "rotate the key, update the GitHub secret" is wrong advice.
  if (isOAuthCredentialExpiredError(params.raw)) {
    return renderFailure({
      headline: subscription
        ? `Your ${subscription.label}'s sign-in has expired or been revoked.`
        : "Your provider sign-in has expired or been revoked.",
      detail: subscription
        ? `${SIGN_IN_AGAIN(subscription.command)}, then re-trigger.`
        : "Sign in again with `pullfrog auth claude`, `pullfrog auth codex` or `pullfrog auth grok` in a terminal, whichever this repo uses, then re-trigger.",
      details,
      links: [pickModelLink(params)],
    });
  }

  // the provider's wording can't tell a revoked subscription token from a
  // rotated API key — both read `Invalid bearer token` — so fall back to the
  // credential actually in this run before assuming there is a key to rotate.
  // only reachable when a credential dies mid-run: a dead one is deleted from
  // env by `checkConfiguredCredentials` before the agent starts.
  if (subscription && hasEnvVar(subscription.env) && params.credential !== "api_key") {
    return renderFailure({
      headline: `Your ${subscription.label} was rejected during this run.`,
      detail: `${SIGN_IN_AGAIN(subscription.command)}, then re-trigger.`,
      details,
      links: [pickModelLink(params)],
    });
  }

  // unlike `buildRejectedCredentialError`, which probed a named credential, the
  // mid-run path only has the provider's wording — so it can't know which store
  // the rejected key came from. naming one sent a customer whose only copy lives
  // in Pullfrog's store to an empty GitHub Actions settings page.
  return renderFailure({
    headline: `Your ${providerDisplayName(params.model?.split("/")[0]) ?? "model provider"} API key was rejected.`,
    detail:
      "Issue a new key with the provider, then update the copy Pullfrog uses, in Pullfrog or in this repo's GitHub Actions secrets.",
    details,
    links: [
      {
        label: "Pullfrog provider settings",
        url: `${getApiUrl()}/console/${params.owner}#billing`,
      },
      { label: "GitHub Actions secrets", url: secretsUrl(params) },
    ],
  });
}
