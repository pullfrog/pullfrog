import type { Octokit } from "@octokit/rest";
import * as yes from "yes";
import type { RouterTier } from "../models.ts";
import packageJson from "../package.json" with { type: "json" };
import type { CommercialRefusal } from "./billingErrors.ts";
import { log } from "./cli.ts";
import { mintIdToken, type OctokitWithPlugins, parseRepoContext } from "./github.ts";
import { isTransientOctokitError } from "./isTransientNetworkError.ts";
import { type AccountPlan, fetchRunContext, type RepoSettings } from "./runContext.ts";
import type { CredentialAccess } from "./subscriptionCredentials.ts";

export interface RunContextData {
  credentialAccess?: CredentialAccess | undefined;
  repo: {
    owner: string;
    name: string;
    data: Awaited<ReturnType<Octokit["repos"]["get"]>>["data"];
  };
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
}

interface ResolveRunContextDataParams {
  octokit: OctokitWithPlugins;
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

  // the action octokit has no retry plugin (only a 401 re-mint), and this runs
  // BEFORE the clean-error surface in main.ts — so a transient GitHub 5xx here
  // would reject the Promise.all and hard-crash the run at startup (while its
  // sibling fetchRunContext degrades to defaults). retry the transient blip.
  // see #999.
  const [repoResponse, runContext] = await Promise.all([
    yes.query({
      run: () => params.octokit.repos.get({ owner: repoContext.owner, repo: repoContext.name }),
      name: "repos.get",
      retry: (error, attempt) =>
        isTransientOctokitError(error) ? yes.delay([100, 500], attempt) : -1,
    })(),
    fetchRunContext({
      token: params.token,
      repoContext,
      oidcToken,
      runType: params.runType,
      plainPrompt: params.plainPrompt,
      routedTier: params.routedTier,
    }),
  ]);

  return {
    repo: {
      owner: repoContext.owner,
      name: repoContext.name,
      data: repoResponse.data,
    },
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
  };
}
