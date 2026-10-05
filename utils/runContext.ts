import { randomUUID } from "node:crypto";
import type { PushPermission, ShellPermission } from "../external.ts";
import type { RouterTier } from "../models.ts";
import { apiFetch } from "./apiFetch.ts";
import type { CommercialRefusal } from "./billingErrors.ts";
import type { RepoContext } from "./github.ts";
import type { CredentialAccess } from "./subscriptionCredentials.ts";

/**
 * One per process, which is one start of the action within its GitHub run. Sent to run-context
 * first, so a custom run's start is recorded before it reports, and then on each workflow-run PATCH.
 */
export const START_KEY = randomUUID();

export interface Mode {
  id: string;
  name: string;
  description: string;
  prompt: string;
}

/**
 * server-parsed TOC entry for `Repo.learnings`. depth is 1-6 (h1-h6),
 * line numbers are 1-indexed against the raw body. computed by
 * `parseLearningsHeadings` in `utils/learningsToc.ts` (server side) and
 * shipped over the run-context JSON boundary; the canonical declaration
 * lives there. duplicated here because the action runtime can't reach
 * across into the proprietary root-level codebase, and the JSON wire
 * means typecheck can't enforce shape equality across both sides.
 */
export interface LearningsHeading {
  depth: 1 | 2 | 3 | 4 | 5 | 6;
  title: string;
  startLine: number;
  endLine: number;
}

export interface RepoSettings {
  model: string | null;
  // reasoning-effort position on [0,1], landed on the running model's own
  // published ladder at resolve time. see action/effort.ts.
  effort: number | null;
  modes: Mode[];
  setupScript: string | null;
  postCheckoutScript: string | null;
  prepushScript: string | null;
  stopScript: string | null;
  push: PushPermission;
  shell: ShellPermission;
  prApproveEnabled: boolean;
  // "Include draft PRs": the post-run safety net re-reviews a moved draft only when set.
  reviewDrafts: boolean;
  // already globally-gated server-side (run-context ANDs the per-repo toggle with
  // the `isAutonomousMaintenanceEnabled()` kill switch), so the runtime treats it
  // as the final "may auto-merge" verdict. see autoMergeAfterApprove.
  autoMergeEnabled: boolean;
  // opt-in for the EXPERIMENTAL codex harness, already ANDed server-side with
  // the `isCodexAgentEnabled()` kill switch — so the runtime treats it as the
  // final "may route to codex" verdict. see resolveAgent + wiki/codex-agent.md.
  codexAgent: boolean;
  signedCommits: boolean;
  repoIntelligence: boolean;
  // false suppresses the "Leaping into action..." comment (server-side, before
  // dispatch) and the live task-list updates. see mcp/comment.ts reportProgress.
  progressComments: boolean;
  // false suppresses the `pullfrog` run-lifecycle check-run (server-side at dispatch,
  // action-side at run end). see utils/runStatusCheck.ts.
  statusChecks: boolean;
  // true posts the `pullfrog-approval` verdict check. off by default — it is a merge
  // gate, so it must never turn itself on.
  approvalCheck: boolean;
  modeInstructions: Record<string, string>;
  learnings: string | null;
  learningsHeadings: LearningsHeading[];
  envAllowlist: string | null;
  // org-level cross-repo context (only used on --xrepo runs). xrepoBrief is
  // operator-authored (never agent-edited); xrepoLearnings is agent-curated
  // across runs (org-level analogue of `learnings`).
  xrepoBrief: string | null;
  xrepoLearnings: string | null;
  xrepoLearningsHeadings: LearningsHeading[];
}

/**
 * Account-level card signal. Orthogonal to repo-level OSS and Pro status.
 * Mirrors the server's legacy-named `AccountPlan` in `utils/billing.ts`.
 * `"none"` = no card; `"payg"` = card on file.
 */
export type AccountPlan = "none" | "payg";

export interface RunContext {
  credentialAccess?: CredentialAccess | undefined;
  settings: RepoSettings;
  apiToken: string;
  oss: boolean;
  plan: AccountPlan;
  proxyModel?: string | undefined;
  dbSecrets?: Record<string, string> | undefined;
  /**
   * The org commercial gate's refusal (billing model v2). Set when run-context
   * returns 402 for a `paused`/`unpaid` org — the backstop for manual re-runs and
   * self-configured triggers that never hit reserveRun. main.ts stops before
   * installing the agent or loading account secrets and writes actionable copy.
   * A forked action can bypass this response, so proxy-token enforces the same
   * verdict before issuing a Pullfrog Router key.
   */
  commercialRefused?: CommercialRefusal | undefined;
  /**
   * the server tried and failed to materialize Pullfrog-stored secrets (or we
   * never got a usable response at all). distinct from an absent `dbSecrets`,
   * which legitimately means the user has none stored — without the
   * distinction a transient failure renders as "you have no API key".
   */
  secretsUnavailable?: boolean | undefined;
  /**
   * the Router was this account's funding path and its wallet is empty, so the
   * server declined the mint rather than 402ing — the run falls through to
   * BYOK, which is the documented affordance for a router-mode account whose
   * key lives in workflow `env:`. only meaningful when the key search then
   * comes up dry, where it turns "go add an API key" into copy that also names
   * topping up. defaults false: an unreachable server must not assert a
   * funding state. see wiki/billing.md.
   */
  routerUnfunded?: boolean | undefined;
  /** the account is inside its no-card trial and nothing else could fund this
   * run — the runner may mint a subsidized efficient-tier key if, and only if,
   * its own key search comes up dry. see the run-context route. */
  trialFallback?: boolean | undefined;
}

const defaultSettings: RepoSettings = {
  model: null,
  effort: null,
  modes: [],
  setupScript: null,
  postCheckoutScript: null,
  prepushScript: null,
  stopScript: null,
  push: "restricted",
  shell: "restricted",
  prApproveEnabled: false,
  reviewDrafts: false,
  autoMergeEnabled: false,
  codexAgent: false,
  signedCommits: false,
  repoIntelligence: false,
  progressComments: true,
  statusChecks: true,
  approvalCheck: false,
  modeInstructions: {},
  learnings: null,
  learningsHeadings: [],
  envAllowlist: null,
  xrepoBrief: null,
  xrepoLearnings: null,
  xrepoLearningsHeadings: [],
};

const defaultRunContext: RunContext = {
  settings: defaultSettings,
  apiToken: "",
  oss: false,
  plan: "none",
};

/**
 * used only when we never got an answer at all (5xx, network drop, timeout):
 * stored secrets are unknown rather than known-absent, so the run must not
 * blame the user. a definitive 4xx keeps `defaultRunContext` — promising that a
 * re-run will find secrets we were authoritatively told don't apply is worse
 * than the missing-key copy it replaces.
 */
const unknownSecretsRunContext: RunContext = {
  ...defaultRunContext,
  secretsUnavailable: true,
};

/**
 * fetch run context from Pullfrog API
 * returns settings + API token for subsequent calls
 * returns defaults if fetch fails
 */
export async function fetchRunContext(params: {
  token: string;
  repoContext: RepoContext;
  oidcToken?: string | undefined;
  /** `payload.type` — lets the server apply this repo's per-trigger model
   * override, which it cannot derive from owner/repo alone. */
  runType?: string | undefined;
  /** a plain-text prompt, which no Pullfrog dispatch sends — so the server
   * can record this run without waiting for a reservation to claim it. */
  plainPrompt: boolean;
  /** `payload.routing.tier` — the model router's tier, which run-context
   * applies to the Router proxy mint the same way it applies `runType`. */
  routedTier?: RouterTier | undefined;
}): Promise<RunContext> {
  const timeoutMs = 30000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${params.token}`,
      "X-Pullfrog-Credential-Pools": "1",
    };
    if (params.oidcToken) {
      headers["X-GitHub-OIDC-Token"] = params.oidcToken;
    }

    const query = new URLSearchParams({ start: START_KEY });
    if (params.runType) query.set("type", params.runType);
    if (params.plainPrompt) query.set("prompt", "plain");
    if (params.routedTier) query.set("tier", params.routedTier);
    const search = query.toString();
    const response = await apiFetch({
      path: `/api/repo/${params.repoContext.owner}/${params.repoContext.name}/run-context${search ? `?${search}` : ""}`,
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // commercial gate refusal (billing model v2): a 402 means the org's Pro
    // plan is paused/unpaid. Surface it so main.ts stops the run — every
    // other non-ok still degrades to defaults (transient server blip must not
    // block runs).
    if (response.status === 402) {
      const body: unknown = await response.json().catch(() => null);
      const reason =
        typeof body === "object" && body !== null && "reason" in body ? body.reason : null;
      const commercialRefused: CommercialRefusal =
        reason === "subscription_unpaid" || reason === "subscription_ended" ? reason : "commercial";
      return { ...defaultRunContext, commercialRefused };
    }

    if (!response.ok) {
      // 404 (repo not found / app not installed) and 403 (token rejected) are
      // definitive; only 5xx leaves the secret state genuinely unknown.
      return response.status >= 500 ? unknownSecretsRunContext : defaultRunContext;
    }

    const data = (await response.json()) as {
      settings: RepoSettings | null;
      apiToken: string;
      oss?: boolean;
      plan?: AccountPlan;
      proxyModel?: string;
      dbSecrets?: Record<string, string>;
      credentialAccess?: CredentialAccess;
      secretsUnavailable?: boolean;
      routerUnfunded?: boolean;
      trialFallback?: boolean;
    } | null;

    if (data === null) {
      return defaultRunContext;
    }

    return {
      settings: {
        ...defaultSettings,
        ...data.settings,
        modes: data.settings?.modes ?? [],
        setupScript: data.settings?.setupScript ?? null,
        postCheckoutScript: data.settings?.postCheckoutScript ?? null,
        prepushScript: data.settings?.prepushScript ?? null,
        stopScript: data.settings?.stopScript ?? null,
        learningsHeadings: data.settings?.learningsHeadings ?? [],
        xrepoBrief: data.settings?.xrepoBrief ?? null,
        xrepoLearnings: data.settings?.xrepoLearnings ?? null,
        xrepoLearningsHeadings: data.settings?.xrepoLearningsHeadings ?? [],
      },
      apiToken: data.apiToken,
      oss: data.oss ?? false,
      plan: data.plan ?? "none",
      proxyModel: data.proxyModel,
      dbSecrets: data.dbSecrets,
      credentialAccess: data.credentialAccess,
      secretsUnavailable: data.secretsUnavailable,
      routerUnfunded: data.routerUnfunded,
      trialFallback: data.trialFallback,
    };
  } catch {
    // network drop, abort at the 30s timeout, or an unparseable body — we never
    // learned anything about this repo's stored secrets.
    clearTimeout(timeoutId);
    return unknownSecretsRunContext;
  }
}
