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
  signedCommits: boolean;
  progressComments: boolean;
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
 * Account-level billing plan. Orthogonal to repo-level OSS status. Mirrors
 * the server's `AccountPlan` in `utils/billing.ts`. `"none"` = free tier,
 * `"payg"` = card on file / pay-as-you-go.
 */
export type AccountPlan = "none" | "payg";

export interface RunContext {
  settings: RepoSettings;
  apiToken: string;
  oss: boolean;
  plan: AccountPlan;
  proxyModel?: string | undefined;
  dbSecrets?: Record<string, string> | undefined;
}

const defaultSettings: RepoSettings = {
  model: null,
  modes: [],
  setupScript: null,
  postCheckoutScript: null,
  prepushScript: null,
  stopScript: null,
  push: "restricted",
  shell: "restricted",
  prApproveEnabled: false,
  autoMergeEnabled: false,
  signedCommits: false,
  progressComments: true,
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

    if (!response.ok) {
      return defaultRunContext;
    }

    const data = (await response.json()) as {
      settings: RepoSettings | null;
      apiToken: string;
      oss?: boolean;
      plan?: AccountPlan;
      proxyModel?: string;
      dbSecrets?: Record<string, string>;
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
    };
  } catch {
    clearTimeout(timeoutId);
    return defaultRunContext;
  }
}
