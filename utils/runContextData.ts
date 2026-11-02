import * as yes from "yes";
import { installProviders, type RouterTier } from "../models.ts";
import packageJson from "../package.json" with { type: "json" };
import type { CommercialRefusal } from "./billingErrors.ts";
import { log } from "./cli.ts";
import { mintIdToken, type OctokitWithPlugins, parseRepoContext } from "./github.ts";
import { retryTransientOctokit } from "./isTransientNetworkError.ts";
import {
  type AccountPlan,
  fetchRunContext,
  type ModelRegistry,
  type RepoSettings,
} from "./runContext.ts";
import { maskSecret } from "./secretCommands.ts";
import type { CredentialAccess } from "./subscriptionCredentials.ts";
import { getHarnessPins } from "./version.ts";

export interface RunContextData {
  credentialAccess?: CredentialAccess | undefined;
  repo: { owner: string; name: string };
  repoSettings: RepoSettings;
  apiToken: string;
  oss: boolean;
  plan: AccountPlan;
  proxyModel?: string | undefined;
  dbSecrets?: Record<string, string> | undefined;
  commercialRefused?: CommercialRefusal | undefined;
  /** stored secrets couldn't be materialized for this run — not the same as
   * the user having none. see `RunContext.secretsUnavailable`. */
  secretsUnavailable?: boolean | undefined;
  /** the Router was declined because the wallet is empty. see
   * `RunContext.routerUnfunded`. */
  routerUnfunded?: boolean | undefined;
  /** the account is inside its no-card trial and nothing else could fund this
   * run, so the runner MAY mint a subsidized key on the efficient tier if its
   * own key search comes up dry. a permission, not a routing decision — the
   * server cannot see workflow `env:` keys. see `RunContext.trialFallback`. */
  trialFallback?: boolean | undefined;
  /** see `RunContext.trialCreditsLeftUsd`. */
  trialCreditsLeftUsd?: number | undefined;
}

interface ResolveRunContextDataParams {
  token: string;
  /** the dispatch payload's run type, read before the payload is resolved
   * because run-context is fetched first and needs it to pick this trigger's
   * model override. */
  runType?: string | undefined;
  /** the prompt is plain text, never a Pullfrog dispatch payload. */
  plainPrompt: boolean;
  /** the model router's tier from the payload, forwarded so run-context applies it to the proxy mint. */
  routedTier?: RouterTier | undefined;
}

/**
 * Swaps in the deployed server's alias registry, so a merged `action/models.ts` change reaches this
 * run without waiting for a release. A registry written against other harness pins waits for the
 * release that carries them: a model bump that needs a newer CLI would otherwise reach this one.
 */
function installServedRegistry(served: ModelRegistry): void {
  const pins = getHarnessPins();
  const moved = Object.keys(pins).filter((name) => served.harnessPins[name] !== pins[name]);
  if (moved.length > 0) {
    const theirs = moved.map((name) => `${name}@${served.harnessPins[name]}`).join(", ");
    log.info(`» kept the bundled model registry: the server's is written for ${theirs}`);
    return;
  }
  try {
    installProviders(served.providers);
  } catch (error) {
    log.warning(
      `» kept the bundled model registry: the server's ${error instanceof Error ? error.message : error}`
    );
  }
}

/**
 * initialize run context data: parse context, fetch repo info and settings
 */
export async function resolveRunContextData(
  params: ResolveRunContextDataParams
): Promise<RunContextData> {
  // the ref is load-bearing, not decoration: a `@main` dogfood run prints the
  // un-bumped package version, so without it a run executing UNRELEASED code is
  // indistinguishable from one running the published release of the same number.
  // that ambiguity is what let 0.1.54 ship after main had already failed twice.
  const actionRef = process.env.GITHUB_ACTION_REF;
  log.info(
    `» running Pullfrog v${packageJson.version}${actionRef ? ` (ref: ${actionRef})` : ""}...`
  );

  const repoContext = parseRepoContext();

  // the mint is an HTTP call to the runner's token endpoint, and without the
  // token run-context withholds Pullfrog-stored secrets — so a transient blip
  // here costs the run its keys and reads downstream as "no API key found".
  // absent env means local dev / fork PR, where it can never succeed: one
  // attempt, no retry.
  let oidcToken: string | undefined;
  try {
    oidcToken = await yes.query({
      run: () => mintIdToken(),
      name: "OIDC mint",
      retry: process.env.ACTIONS_ID_TOKEN_REQUEST_URL ? [200, 1000] : [],
    })();
  } catch {
    // OIDC not available (local dev, non-actions environment, fork PRs)
  }

  const runContext = await fetchRunContext({
    token: params.token,
    repoContext,
    oidcToken,
    runType: params.runType,
    plainPrompt: params.plainPrompt,
    routedTier: params.routedTier,
  });

  if (runContext.apiToken) maskSecret(runContext.apiToken);
  if (runContext.modelRegistry) installServedRegistry(runContext.modelRegistry);
  return {
    repo: { owner: repoContext.owner, name: repoContext.name },
    repoSettings: runContext.settings,
    apiToken: runContext.apiToken,
    oss: runContext.oss,
    plan: runContext.plan,
    proxyModel: runContext.proxyModel,
    dbSecrets: runContext.dbSecrets,
    credentialAccess: runContext.credentialAccess,
    commercialRefused: runContext.commercialRefused,
    // a failed mint on a runner that should have been able to mint is the same
    // outcome as the server-side failure: the run never sees stored secrets.
    secretsUnavailable:
      runContext.secretsUnavailable ||
      (!!process.env.ACTIONS_ID_TOKEN_REQUEST_URL && oidcToken === undefined),
    routerUnfunded: runContext.routerUnfunded,
    trialFallback: runContext.trialFallback,
    trialCreditsLeftUsd: runContext.trialCreditsLeftUsd,
  };
}

/** the run's primary repo as the tools see it. */
export type RunRepo = RunContextData["repo"] & { defaultBranch: string };

/**
 * read on the installation token, never the job `GITHUB_TOKEN`: that shares a per-repo hourly
 * budget with the customer's CI, and a 403 on it here failed runs before they began (#1584).
 * the default branch guards restricted pushes and `delete_branch`, so it is never guessed.
 */
export async function getDefaultBranch(params: {
  octokit: OctokitWithPlugins;
  repo: RunContextData["repo"];
}): Promise<string> {
  const response = await yes.query({
    run: () => params.octokit.repos.get({ owner: params.repo.owner, repo: params.repo.name }),
    name: "repos.get",
    retry: retryTransientOctokit,
  })();
  return response.data.default_branch;
}
