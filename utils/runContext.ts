import type { PushPermission, ShellPermission } from "../external.ts";
import { apiFetch } from "./apiFetch.ts";
import type { RepoContext } from "./github.ts";

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
  // already globally-gated server-side (run-context ANDs the per-repo toggle with
  // the `isAutonomousMaintenanceEnabled()` kill switch), so the runtime treats it
  // as the final "may auto-merge" verdict. see autoMergeAfterApprove.
  autoMergeEnabled: boolean;
  // opt-in for the EXPERIMENTAL codex harness, already ANDed server-side with
  // the `isCodexAgentEnabled()` kill switch — so the runtime treats it as the
  // final "may route to codex" verdict. see resolveAgent + wiki/codex-agent.md.
  codexAgent: boolean;
  // explicit user choice of agent harness. null = "auto" — the model-based
  // routing in utils/agent.ts decides (deepseek models route to dsh; everything
  // else as before). when set, the value must be compatible with the run's
  // resolved model — utils/agent.ts hard-fails before the agent starts
  // otherwise. server-authoritative: the console radio delivers this; the
  // server nulls it when the dsh kill switch is off.
  agent: "auto" | "claude" | "codex" | "opencode" | "dsh" | null;
  // server-side gate for the dsh harness, ANDed with the `isDshAgentEnabled()`
  // kill switch — the runtime treats it as the final "may route to dsh"
  // verdict. gates BOTH the auto route (deepseek -> dsh) and an explicit
  // agent: "dsh" pick (which hard-fails when disabled).
  dshEnabled: boolean;
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

/**
 * The org commercial gate's refusal (billing model v2). Set when run-context
 * returns 402 for a `paused`/`unpaid` org — the backstop for manual re-runs and
 * self-configured triggers that never hit reserveRun. main.ts stops before
 * installing the agent or loading account secrets and writes actionable copy.
 * A forked action can bypass this response, so proxy-token enforces the same
 * verdict before issuing a Pullfrog Router key.
 */
export type CommercialRefusal = "commercial" | "subscription_unpaid";

export interface RunContext {
  settings: RepoSettings;
  apiToken: string;
  oss: boolean;
  plan: AccountPlan;
  proxyModel?: string | undefined;
  dbSecrets?: Record<string, string> | undefined;
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
  autoMergeEnabled: false,
  agent: null,
  codexAgent: false,
  dshEnabled: false,
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
}): Promise<RunContext> {
  const timeoutMs = 30000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${params.token}`,
    };
    if (params.oidcToken) {
      headers["X-GitHub-OIDC-Token"] = params.oidcToken;
    }

    const response = await apiFetch({
      path: `/api/repo/${params.repoContext.owner}/${params.repoContext.name}/run-context`,
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
      const reason: CommercialRefusal =
        typeof body === "object" &&
        body !== null &&
        "reason" in body &&
        body.reason === "subscription_unpaid"
          ? "subscription_unpaid"
          : "commercial";
      return { ...defaultRunContext, commercialRefused: reason };
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
      secretsUnavailable?: boolean;
      routerUnfunded?: boolean;
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
      secretsUnavailable: data.secretsUnavailable,
      routerUnfunded: data.routerUnfunded,
    };
  } catch {
    // network drop, abort at the 30s timeout, or an unparseable body — we never
    // learned anything about this repo's stored secrets.
    clearTimeout(timeoutId);
    return unknownSecretsRunContext;
  }
}
