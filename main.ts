// changes to tool permissions should be reflected in wiki/granular-tools.md

import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { detect } from "package-manager-detector";
import { agents } from "./agents/index.ts";
import { subagentDeniedToolNames } from "./agents/subagentToolGates.ts";
import { findDanglingPromptToolRefs } from "./external.ts";
import { reportProgress } from "./mcp/comment.ts";
import { startInstallation } from "./mcp/dependencies.ts";
import { startMcpHttpServer, type ToolContext } from "./mcp/server.ts";
import { getSandboxMethod } from "./mcp/shell.ts";
import { computeModes } from "./modes.ts";
import { initToolState, primaryRepoState } from "./toolState.ts";
import {
  type ActivityTimeout,
  AGENT_ACTIVITY_TIMEOUT_MS,
  createProcessOutputActivityTimeout,
  DEFAULT_ACTIVITY_CHECK_INTERVAL_MS,
} from "./utils/activity.ts";
import { resolveAgent, resolveModel } from "./utils/agent.ts";
import {
  buildRejectedCredentialError,
  NoUsableCredentialError,
  validateAgentApiKey,
} from "./utils/apiKeys.ts";
import { formatCommercialGateSummary } from "./utils/billingErrors.ts";
import { resolveBody } from "./utils/body.ts";
import { log } from "./utils/cli.ts";
import { installCodexAuth, installXaiAuth, PULLFROG_DATA_DIR } from "./utils/codexHome.ts";
import { checkConfiguredCredentials } from "./utils/credentialFallback.ts";
import { recordDiffReadFromToolUse } from "./utils/diffCoverage.ts";
import { onExitSignal } from "./utils/exitHandler.ts";
import { resolveGit, setGitAuthServer } from "./utils/gitAuth.ts";
import { startGitAuthServer } from "./utils/gitAuthServer.ts";
import {
  createOctokit,
  type OidcCredentials,
  writeGitHubUsageSummaryToFile,
} from "./utils/github.ts";
import { resolveInstructions } from "./utils/instructions.ts";
import {
  persistLearnings,
  persistXrepoLearnings,
  seedLearningsFile,
  seedXrepoLearningsFile,
} from "./utils/learnings.ts";
import { describeSetupFailure, executeLifecycleHook } from "./utils/lifecycle.ts";
import { buildModelAccessError, decideModelAccess } from "./utils/modelAccess.ts";
import { normalizeEnv, sanitizeSecret } from "./utils/normalizeEnv.ts";
import {
  captureAuthorizedModels,
  captureBaselineModels,
  getAuthorizedModels,
} from "./utils/openCodeModels.ts";
import { applyOverrides } from "./utils/overrides.ts";
import {
  type ProvisionablePackageManager,
  packageManagerBinDir,
  provisionPackageManager,
  resolvePackageManagerSpec,
} from "./utils/packageManager.ts";
import { aggregateUsage, patchWorkflowRunFields } from "./utils/patchWorkflowRunFields.ts";
import { resolveOutputSchema, resolvePayload, resolvePromptInput } from "./utils/payload.ts";
import { resolveTrialFallback, runProxyResolution } from "./utils/proxy.ts";
import { fetchPreviousSnapshot, persistSummary, seedSummaryFile } from "./utils/prSummary.ts";
import { handleAgentResult } from "./utils/run.ts";
import { isActionPinnedToSha, resolveRunContextData } from "./utils/runContextData.ts";
import { ossEffortFloor } from "./utils/runEffort.ts";
import { renderRunError } from "./utils/runErrorRenderer.ts";
import {
  finalizeSuccessRun,
  persistRunArtifacts,
  writeRunErrorOutputs,
} from "./utils/runLifecycle.ts";
import { logRunStartup } from "./utils/runStartupLog.ts";
import { setEnvAllowlist } from "./utils/secrets.ts";
import { createTempDirectory, setupGit, wipeRunnerLeakSurface } from "./utils/setup.ts";
import { reportStatusChecks } from "./utils/statusChecks.ts";
import { killTrackedChildren } from "./utils/subprocess.ts";
import { resolveTimeoutMs, TIMEOUT_DISABLED } from "./utils/time.ts";
import { Timer } from "./utils/timer.ts";
import { createTodoTracker } from "./utils/todoTracking.ts";
import {
  getGitHubInstallationToken,
  getJobToken,
  getMcpTokenRefresh,
  resolveTokens,
} from "./utils/token.ts";
import {
  cleanupVertexCredentials,
  materializeVertexCredentials,
  type VertexCredentials,
} from "./utils/vertex.ts";
import { resolveRun } from "./utils/workflow.ts";
import { dirtyTrackedPaths, restoreDirtiedSince } from "./utils/worktree.ts";

export { Inputs } from "./utils/payload.ts";

export interface MainResult {
  success: boolean;
  output?: string | undefined;
  error?: string | undefined;
  result?: string | undefined;
}

export async function main(): Promise<MainResult> {
  // normalize env var names to uppercase (handles case-insensitive workflow files)
  normalizeEnv();

  // apply caller-supplied env overrides — JSON object forwarded as the
  // UNSAFE_OVERRIDES env var (NOT a `with:` input). gated by `actions:write`
  // on the repo and refuses integrity-critical names; see utils/overrides.ts
  // for the deny-list and wiki/e2e-testing.md for usage + threat model.
  // the `unsafe` prefix is intentional: GH echoes the env-block value in the
  // step-header log, so the raw JSON is visible to anyone with `actions:read`.
  const overridesRaw = process.env.UNSAFE_OVERRIDES ?? "";
  if (overridesRaw.trim()) {
    const result = applyOverrides({ raw: overridesRaw, env: process.env });
    if (result.applied.length > 0) {
      log.info(`» applied ${result.applied.length} env override(s): ${result.applied.join(", ")}`);
    }
    if (result.denied.length > 0) {
      log.warning(
        `» refused to override ${result.denied.length} protected env var(s): ${result.denied.join(", ")}`
      );
    }
  }

  // write usage summary on SIGINT/SIGTERM so the worker can read it after sandbox.exec
  const usageSummaryPath = process.env.PULLFROG_USAGE_SUMMARY_PATH;
  if (usageSummaryPath) {
    onExitSignal(() => writeGitHubUsageSummaryToFile(usageSummaryPath));
  }

  const timer = new Timer();
  let activityTimeout: ActivityTimeout | null = null;
  let safetyNetTimer: NodeJS.Timeout | undefined;

  // parse prompt early to extract progressComment for toolState
  const resolvedPromptInput = resolvePromptInput();

  // resolve and fingerprint git binary before any agent code runs
  resolveGit();

  // get job token for initial API calls
  const jobToken = getJobToken();
  const initialOctokit = createOctokit(jobToken);
  const runContext = await resolveRunContextData({
    octokit: initialOctokit,
    token: jobToken,
    runType: typeof resolvedPromptInput === "string" ? undefined : resolvedPromptInput.type,
  });
  timer.checkpoint("runContextData");

  const payload = resolvePayload(resolvedPromptInput, runContext.repoSettings);

  // seed toolState with the primary repo (keyed in `repos`). dir is the
  // run-entry cwd; configureRepoGit refreshes it after any payload.cwd chdir.
  const toolState = initToolState({
    progressComment:
      typeof resolvedPromptInput !== "string" ? resolvedPromptInput.progressComment : undefined,
    owner: runContext.repo.owner,
    name: runContext.repo.name,
    dir: process.cwd(),
  });
  toolState.model = payload.model;
  toolState.oss = runContext.oss;
  toolState.shaPinned = isActionPinnedToSha();
  // seed the comment target before every terminal branch. `reportErrorToComment`
  // reads only toolState, so silent triggers otherwise have nowhere to post.
  if (payload.event.issue_number !== undefined) {
    primaryRepoState(toolState).issueNumber = payload.event.issue_number;
  }
  if (payload.event.trigger === "pull_request_synchronize") {
    primaryRepoState(toolState).beforeSha = payload.event.before_sha;
  }

  // stash OIDC credentials before any early return. refused runs need a scoped
  // comment token; normal runs reuse the snapshot after the restricted env wipe.
  const oidcCredentials: OidcCredentials | null =
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
      ? {
          requestUrl: process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
          requestToken: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
        }
      : null;

  if (runContext.commercialRefused) {
    // gate-refusal path: posts one comment and exits, so no agent and no gh token
    await using _commentTokenRef = await resolveTokens({
      push: "disabled",
      authorPermission: undefined,
      oidc: oidcCredentials,
    });
    const errorMessage =
      runContext.commercialRefused === "subscription_unpaid"
        ? "Pro renewal failed for this organization"
        : "Pro plan required for this organization";
    log.error(errorMessage);
    const body = formatCommercialGateSummary({
      reason: runContext.commercialRefused,
      ownerLogin: runContext.repo.owner,
    });
    await writeRunErrorOutputs({ rendered: { summary: body, comment: body }, toolState });
    return { success: false, error: errorMessage };
  }

  // tmpdir hoisted out of the try block: `installFromNpmTarball` reads
  // PULLFROG_TEMP_DIR (set as a side effect of createTempDirectory) when
  // the opencode CLI install runs below for BYOK introspection. agent +
  // mcp server setup further down also consume the same tmpdir.
  //
  // the return value is reused below rather than calling again: every call
  // `mkdtempSync`s a NEW directory and overwrites PULLFROG_TEMP_DIR, and the
  // installers key their fs cache off that variable *at call time* — so a
  // second call silently invalidated the cache and re-downloaded plus
  // re-extracted the whole opencode tarball on every run.
  const tmpdir = createTempDirectory();

  // install OpenCode + capture the BASELINE model set BEFORE dbSecrets and
  // Codex auth.json are in scope. this is the set of models OpenCode can
  // route from the runner's pre-existing environment alone (workflow
  // `env:` block + GH Actions secrets). install is fs-cached, so the
  // duplicate call inside the opencode agent's run() is a no-op.
  //
  // one restore window straddling both `opencode models` captures (#1151):
  // nothing between them writes to the worktree, and both finish before any
  // agent tool exists, so the #1146 "don't discard the agent's own work" hazard
  // cannot apply.
  //
  // keyed on `payload.cwd`, NOT `process.cwd()`. that is the whole lesson of
  // 0.1.54: this code runs BEFORE the chdir below, and `runCli.ts` starts the
  // CLI outside the checkout (a bootstrap tmpdir, or an action checkout with no
  // `.git`), so reading `process.cwd()` here made git exit 129 and throw — every
  // customer run died before the agent started. with no repo dir resolved there
  // is nothing to protect, so the window simply does not open.
  const repoDir = payload.cwd;
  const preIntrospectionDirty = repoDir ? await dirtyTrackedPaths({ cwd: repoDir }) : null;
  const opencodeCliPath = await agents.opencode.install();
  captureBaselineModels(opencodeCliPath);

  // inject account-level secrets into process.env (YAML secrets take precedence).
  // sanitizeSecret trims + masks so accidental trailing whitespace doesn't leak
  // through GitHub Actions' line-based log masking. whitespace-only values
  // return null and skip injection so the user sees a clear missing-key error.
  // this channel also carries non-credential config (model ids, regions,
  // locations); sanitizeSecret trims those but skips masking, since masking is
  // by value and would blank out unrelated log text. see isNonSecretConfigName.
  if (runContext.dbSecrets) {
    for (const [key, value] of Object.entries(runContext.dbSecrets)) {
      if (!process.env[key]) {
        const sanitized = sanitizeSecret(key, value);
        if (sanitized !== null) process.env[key] = sanitized;
      }
    }
    const count = Object.keys(runContext.dbSecrets).length;
    if (count > 0) log.info(`» ${count} db secret(s) loaded`);
  }

  // materialize the subscription auth.json entries (idempotent — the opencode
  // agent re-calls both inside run() and writes the same file; the writer
  // merges per provider so neither clobbers the other). this has to land
  // BEFORE captureAuthorizedModels so OpenCode's model introspection sees the
  // OAuth-routed models: measured, `opencode models` lists 0 `xai/*` entries
  // without the Grok credential on disk and 12 with it, so skipping this
  // would read a subscription-only account as unable to run its own models
  // and fall the run back to the free tier.
  installCodexAuth();
  installXaiAuth();

  // capture the AUTHORIZED model set after dbSecrets + Codex auth.json are
  // applied. this is the authoritative source for the BYOK fallback
  // decision and the opencode-agent path of validateAgentApiKey — strictly
  // more accurate than the static envVars/managedCredentials catalog,
  // which can miss new auth shapes.
  captureAuthorizedModels(opencodeCliPath);

  // close the window opened before the baseline capture.
  if (preIntrospectionDirty && repoDir) {
    await restoreDirtiedSince({
      before: preIntrospectionDirty,
      actor: "model introspection",
      cwd: repoDir,
    });
  }

  // configure env allowlist for subprocess filtering
  if (runContext.repoSettings.envAllowlist) {
    setEnvAllowlist(runContext.repoSettings.envAllowlist);
  }

  // surface a narrowed cross-repo request in the run output (not just the
  // server-side dispatch log) so the triggerer sees what wasn't granted.
  const xrepoUnavailable = payload.xrepo?.unavailable ?? [];
  if (xrepoUnavailable.length > 0) {
    log.warning(
      `» --xrepo: requested but not granted: ${xrepoUnavailable.join(", ")} (unknown repo, different owner, or you lack access)`
    );
  }

  // resolve tokens first — acquireNewToken needs OIDC env vars for token exchange
  await using tokenRef = await resolveTokens({
    push: payload.push,
    authorPermission: payload.event.authorPermission,
    xrepo: payload.xrepo,
    xrepoGrant: payload.xrepoGrant,
    oidc: oidcCredentials,
  });

  // wipe the GHA runner's known credential leak surface inside $RUNNER_TEMP
  // before the agent spawns. our installation token is already in memory
  // (tokenRef above), and setupGit's includeIf strip handles the matching
  // dangling references in the user's .git/config. see wipeRunnerLeakSurface
  // for the leak inventory and threat model.
  wipeRunnerLeakSurface();

  // probe the sandbox ONCE, here, rather than lazily inside the first
  // `spawnShell`. on an unprivileged Kubernetes/ARC runner every PID-namespace
  // method fails, so every `pullfrog_shell` call throws — but detection used to
  // happen minutes in, the tool stayed registered, and the prompt kept telling
  // the agent it was the only sanctioned way to run anything. 192 runs / 757
  // dead tool calls in 24h, all green, with agents submitting reviews whose
  // tests they had decided to run and could not (#1093). resolving it to
  // `disabled` up front makes the tool set and the prompt agree with reality,
  // and gives the operator one line they can act on.
  if (payload.shell === "restricted" && getSandboxMethod() === "none") {
    payload.shell = "disabled";
    log.warning(
      "» shell commands are disabled for this run: this runner provides no PID-namespace isolation " +
        "(unprivileged unshare, sudo unshare and userns-nested unshare all failed). " +
        "on a self-hosted Kubernetes/ARC runner, allow user-namespace creation in the pod's seccomp " +
        "profile — see https://docs.pullfrog.com/security#self-hosted-runners"
    );
  }

  // clear OIDC env vars in restricted mode to prevent agent from minting tokens
  if (payload.shell !== "enabled") {
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  }

  // Proxy decision: mint an OpenRouter key for OSS repos or managed billing
  // accounts. BillingError (402) and TransientError (503) get rendered inside
  // `runProxyResolution` before being rethrown — handled here (not in the
  // outer catch) because the outer catch needs `toolContext` (not yet built)
  // for its general-purpose error path.
  await runProxyResolution({
    payload,
    oss: runContext.oss,
    proxyModel: runContext.proxyModel,
    oidcCredentials,
    repo: runContext.repo,
    toolState,
  });

  // create octokit with MCP token for GitHub API calls.
  // the refresh handles mid-run token invalidation (#891)
  const octokit = createOctokit(tokenRef.mcpToken, getMcpTokenRefresh());

  const runInfo = await resolveRun({ octokit });
  let toolContext: ToolContext | undefined;
  let progressCallbackDisabled = false;
  let todoTracker: ReturnType<typeof createTodoTracker> | undefined;
  let vertexCredentials: VertexCredentials | undefined;

  try {
    if (payload.cwd && process.cwd() !== payload.cwd) {
      process.chdir(payload.cwd);
    }

    // resolve body - fetches body_html and converts to markdown if images present
    // this ensures agents receive markdown with working signed image URLs
    const originalBody = payload.event.body;
    const resolvedBody = await resolveBody({
      event: payload.event,
      octokit,
      repo: runContext.repo,
      tmpdir,
      githubToken: tokenRef.mcpToken,
    });
    if (resolvedBody !== originalBody) {
      payload.event.body = resolvedBody;
      // also update prompt if original body was included there
      if (originalBody && payload.prompt.includes(originalBody)) {
        payload.prompt = payload.prompt.replace(originalBody, resolvedBody ?? "");
      }
    }

    await using gitAuthServer = await startGitAuthServer(tmpdir);
    setGitAuthServer(gitAuthServer);

    // model-access gate: an explicitly-requested per-run model (`--opus`,
    // `--model=<slug>`) that this run can't serve hard-fails here, before the
    // agent starts. standing defaults keep `modelExplicit = false` and fall
    // through to `validateAgentApiKey`'s missing-key error below (#938).
    // proxy / byok decisions mutate `payload.proxyModel` so the resolution
    // beneath sees the corrected routing.
    const access = decideModelAccess({
      modelExplicit: payload.modelExplicit ?? false,
      model: payload.model,
      oss: runContext.oss,
      proxyActive: !!payload.proxyModel,
      subsidyTarget: runContext.proxyModel,
      resolvedModel: resolveModel({ slug: payload.model }),
      authorized: getAuthorizedModels(),
    });
    if (access.kind === "error") {
      throw new Error(
        buildModelAccessError({
          reason: access.reason,
          model: payload.model ?? "(unknown)",
          owner: runContext.repo.owner,
          name: runContext.repo.name,
        })
      );
    }
    if (access.kind === "proxy") payload.proxyModel = access.target;
    if (access.kind === "byok") payload.proxyModel = undefined;

    // a subsidised run is Pullfrog's spend, so it is pinned to `high` on
    // whatever ladder the funded model publishes — matching what every OSS run
    // got before this setting existed. see `ossEffortFloor` for why this asks
    // for the rung by name rather than taking position 0.
    if (runContext.oss && payload.proxyModel) {
      payload.effort = ossEffortFloor({ payload });
    }

    const configuredModel = payload.proxyModel ? undefined : resolveModel({ slug: payload.model });

    // ask the providers whether the configured model's credentials still work
    // before committing to it. a rejected credential becomes either a run on
    // whatever the account CAN still route or an accurate error naming
    // the credential — never the 401-three-seconds-in that used to send users
    // to a GitHub Actions secrets page they had never put a key in. skipped
    // for proxy runs for the same reason validateAgentApiKey is: the server
    // minted the key and is the authority on it.
    const credentials = payload.proxyModel
      ? { kind: "ok" as const }
      : await checkConfiguredCredentials({
          model: configuredModel,
          authorized: getAuthorizedModels(),
        });
    if (credentials.kind === "dead") {
      throw new Error(
        buildRejectedCredentialError({
          credential: credentials.credential,
          reason: credentials.reason,
          owner: runContext.repo.owner,
          name: runContext.repo.name,
          inPullfrogStore: credentials.credential in (runContext.dbSecrets ?? {}),
        })
      );
    }
    if (credentials.kind === "fellBack" && configuredModel) {
      log.warning(
        `» ${credentials.credential} was rejected by its provider — running ${credentials.replacement} instead of ${configuredModel}`
      );
      toolState.modelFallback = { from: configuredModel };
    }
    // the replacement is a concrete resolve target, not `undefined`: leaving it
    // unset would let `effectiveModel` fall through to `payload.model` (the
    // ALIAS slug), which `authorized` doesn't hold and whose env vars were just
    // deleted — so `validateAgentApiKey` would throw the missing-key error with
    // the very GitHub-secrets CTA this whole change exists to stop showing.
    const resolvedModel =
      credentials.kind === "fellBack" ? credentials.replacement : configuredModel;

    vertexCredentials = materializeVertexCredentials({ model: resolvedModel });

    let agent = resolveAgent({
      model: resolvedModel,
      proxyModel: payload.proxyModel,
      // the account opt-in and the canary arm are both admissions to codex, so
      // they OR: an account that opted in explicitly always gets it, and the
      // canary widens the pool without ever demoting a run that already had it.
      codexAgent: runContext.repoSettings.codexAgent || payload.codexArm === true,
    });

    // record the harness that actually ran. `agent` is what the run DID;
    // `WorkflowRun.codexArm` is what it was ASSIGNED — comparing arms on the
    // assignment is what keeps runs that die before this PATCH in the analysis.
    toolState.agent = agent.name;

    // agent-agnostic best-effort for the model that ran: proxy spec for
    // router/oss runs, else the resolved model, else the slug.
    // payload.model is just the stored slug (often undefined for router/oss
    // runs that derive the target from proxyModel). matching priority with
    // resolveModelForLog so the "Using `…`" badge reflects what actually ran.
    // the opencode agent refines this from `rawModel` once it auto-selects (a
    // pick main.ts can't know — see opencode.ts), so auto-select runs persist
    // their real model rather than this placeholder.
    const effectiveModel = payload.proxyModel ?? resolvedModel ?? payload.model;
    // surface it in comment/review footers and persist it on the end-of-run PATCH.
    toolState.model = effectiveModel;

    // fail fast when the configured model needs a key the runner doesn't
    // have. the thrown markdown is mirrored by `renderRunError` →
    // `writeRunErrorOutputs` to both the PR/issue comment (when the run has
    // issue context) and the GHA job summary, with model-specific fix
    // instructions. Without this, the agent launches with no key, the LLM
    // provider 401s, and the run dies in seconds with a synthetic "Invalid
    // API key" — the silent-churn pattern that took out 15 accounts
    // pre-launch.
    //
    // skipped when proxyModel is set: `runProxyResolution` already minted
    // OPENROUTER_API_KEY and the server-side gate (`run-context/route.ts`)
    // is the authority on "can this run use the router". the `authorized`
    // set was captured BEFORE the proxy mint, so it doesn't see the
    // openrouter slug — validating would spuriously throw.
    if (!payload.proxyModel) {
      try {
        validateAgentApiKey({
          agent,
          model: effectiveModel,
          authorized: getAuthorizedModels(),
          owner: runContext.repo.owner,
          name: runContext.repo.name,
          secretsUnavailable: runContext.secretsUnavailable,
          routerUnfunded: runContext.routerUnfunded,
        });
      } catch (missingKey) {
        // the trial fallback fires HERE and nowhere earlier: this is the first
        // moment anything knows that no credential could pay for the run.
        // `validateAgentApiKey` has just searched everything the server cannot
        // see — workflow `env:`, GitHub Actions secrets, the harness-specific
        // shapes — so an earlier mint would have downgraded accounts that were
        // fine. the server only granted permission; the verdict is here.
        //
        // and only THAT verdict: the same function also throws when opencode
        // could not start, when a Bedrock/Vertex/Azure/OpenAI-compatible setup
        // is half-wired, and when we could not read our own stored secrets.
        // every one of those means the user HAS brought a credential, so
        // falling back would swap their model for a cheap one and swallow the
        // message that says what to fix.
        const funded =
          runContext.trialFallback && missingKey instanceof NoUsableCredentialError
            ? await resolveTrialFallback({
                payload,
                configuredModel: effectiveModel,
                oidcCredentials,
                repo: runContext.repo,
                toolState,
              })
            : false;
        if (!funded) throw missingKey;
        // the run is now Router-served, and only opencode speaks that provider —
        // the harness picked above was chosen for a credential that does not
        // exist. re-resolving is not optional bookkeeping: leaving `agent` alone
        // sends a proxy run to claude-code or codex, which then dies on the same
        // missing key this branch just worked around.
        agent = resolveAgent({
          model: resolvedModel,
          proxyModel: payload.proxyModel,
          codexAgent: runContext.repoSettings.codexAgent || payload.codexArm === true,
        });
        toolState.agent = agent.name;
      }
    }

    await setupGit({
      gitToken: tokenRef.gitToken,
      owner: runContext.repo.owner,
      name: runContext.repo.name,
      octokit,
      toolState,
      shell: payload.shell,
      postCheckoutScript: runContext.repoSettings.postCheckoutScript,
    });
    timer.checkpoint("git");

    // pin the project's package manager via corepack BEFORE the setup hook
    // runs. without this, a customer setup script like `npm i -g pnpm &&
    // pnpm install` installs whatever pnpm is "latest" today and writes
    // unrelated lockfile drift (e.g. the `packageManagerDependencies`
    // block pnpm 11.3 added) into our commit — see #844. resolution
    // honors pnpm 11+ precedence (`devEngines.packageManager` over
    // `packageManager`); failure is non-fatal — we fall back to whatever
    // is on PATH with a warning. the shim lands in a private bin dir
    // (prepended to PATH), not the node bin dir, so a setup `npm i -g pnpm`
    // can't collide with it.
    const pmSpec = await resolvePackageManagerSpec(process.cwd());
    // resolve the manager the same way the prep phase will (declared spec first,
    // then lockfile) and provision it by whatever route it needs. asking corepack
    // alone was the bug: it manages pnpm and yarn and ignores bun and deno, so a
    // `setup` hook running `bun install` died with `bun: command not found` 0.8s
    // before Pullfrog installed bun itself. see #1121.
    const pmDetected = await detect({ cwd: process.cwd(), strategies: ["lockfile"] });
    const pmName = pmSpec?.name ?? (pmDetected?.name as ProvisionablePackageManager) ?? "npm";
    // provisioning executes code, so it is gated on shell exactly like the prep phase.
    if (payload.shell !== "disabled") {
      const pmError = await provisionPackageManager({
        name: pmName,
        declared: pmSpec,
        binDir: packageManagerBinDir(tmpdir),
      });
      if (pmError) log.warning(`» could not provision ${pmName}: ${pmError}`);
    }
    timer.checkpoint("packageManager");

    // execute the setup lifecycle hook (runs once at initialization). best-effort:
    // a failure no longer aborts the run — we warn the operator and surface it to
    // the agent via the SETUP HOOK FAILED banner so it can verify the env and adapt.
    const setupHook = await executeLifecycleHook({
      event: "setup",
      script: runContext.repoSettings.setupScript,
      normalizeWorkingTreeAfter: true,
    });
    if (setupHook.warning) {
      log.warning(setupHook.warning);
    }
    timer.checkpoint("lifecycleHooks::setup");

    const agentId = agent.name;
    const modes = [
      ...computeModes(agentId, runContext.repoSettings.signedCommits),
      ...runContext.repoSettings.modes,
    ];

    const outputSchema = resolveOutputSchema();

    // mcpServerUrl and tmpdir are set after server starts
    toolContext = {
      agentId,
      repo: runContext.repo,
      payload,
      octokit,
      // live getter so raw-token consumers (asset fetches, plan/summary-comment
      // GETs) see the refreshed MCP token after a mid-run re-acquisition (#891)
      get githubInstallationToken() {
        return getGitHubInstallationToken();
      },
      // live getter, same reason as #891 above — reads the current git token
      // (canonical rationale on TokenRef.gitToken). see #964.
      get gitToken() {
        return tokenRef.gitToken;
      },
      refreshGitToken: tokenRef.refreshGitToken,
      readToken: tokenRef.readToken,
      ghToken: tokenRef.ghToken,
      xrepo: payload.xrepo,
      apiToken: runContext.apiToken,
      modes,
      postCheckoutScript: runContext.repoSettings.postCheckoutScript,
      prepushScript: runContext.repoSettings.prepushScript,
      prApproveEnabled: runContext.repoSettings.prApproveEnabled,
      autoMergeEnabled: runContext.repoSettings.autoMergeEnabled,
      signedCommits: runContext.repoSettings.signedCommits,
      repoIntelligence: runContext.repoSettings.repoIntelligence,
      modeInstructions: runContext.repoSettings.modeInstructions,
      toolState,
      runId: runInfo.runId,
      jobId: runInfo.jobId,
      mcpServerUrl: "",
      tmpdir,
      oss: runContext.oss,
      plan: runContext.plan,
      resolvedModel,
    };
    await using mcpHttpServer = await startMcpHttpServer(toolContext, { outputSchema });
    toolContext.mcpServerUrl = mcpHttpServer.url;
    log.info(`» MCP server started at ${mcpHttpServer.url}`);
    timer.checkpoint("mcpServer");

    // derive the subagent deny list from the same tool set the server just
    // registered, so the gate can never drift from the registered tools.
    const subagentDeniedTools = subagentDeniedToolNames(toolContext, outputSchema);

    // seed the rolling repo-level learnings tmpfile for every run. the
    // agent reads the file at startup (path is surfaced in the LEARNINGS
    // section of the prompt) and may edit it during the post-run
    // reflection turn. persistLearnings reads it back at end-of-run and
    // PATCHes any changes to Repo.learnings, byte-trim equality against
    // the seed gates the API call. always-seed (vs gated): learnings are
    // universal — any run can produce them, and gating just hides the
    // affordance.
    //
    // wrapped in best-effort try/catch: this block runs unconditionally,
    // and an unwrapped filesystem failure (ENOSPC, EACCES, hostile sandbox)
    // would unwind into the outer main() catch and flip an otherwise-
    // successful run to "❌ Pullfrog failed" before the agent even starts.
    // on failure toolState.learningsFilePath stays unset, and downstream
    // consumers (`persistLearnings`, agent harnesses, `resolveInstructions`)
    // all treat undefined as "no learnings affordance this run".
    try {
      const learningsPath = await seedLearningsFile({
        tmpdir,
        current: runContext.repoSettings.learnings,
      });
      toolState.learningsFilePath = learningsPath;
      // file on disk is the verbatim DB body, so the seed used for
      // change-detection is just `current ?? ""` (trimmed). persistLearnings
      // byte-compares against the trimmed read-back to skip no-op PATCHes.
      toolState.learningsSeed = (runContext.repoSettings.learnings ?? "").trim();
      log.info(
        `» learnings seeded at ${learningsPath} (existing=${runContext.repoSettings.learnings ? "yes" : "no"})`
      );
      const ctxForExit = toolContext;
      onExitSignal(() => persistLearnings(ctxForExit));
    } catch (err) {
      log.warning(
        `» learnings seed failed: ${err instanceof Error ? err.message : String(err)} — continuing without learnings file`
      );
    }

    // on --xrepo runs, seed the org-level cross-repo learnings tmpfile too.
    // same lifecycle as repo learnings (read at startup, agent-editable,
    // persisted at end), but org-scoped and only present cross-repo.
    if (payload.xrepo) {
      try {
        const xrepoPath = await seedXrepoLearningsFile({
          tmpdir,
          current: runContext.repoSettings.xrepoLearnings,
        });
        toolState.xrepoLearningsFilePath = xrepoPath;
        toolState.xrepoLearningsSeed = (runContext.repoSettings.xrepoLearnings ?? "").trim();
        log.info(
          `» xrepo learnings seeded at ${xrepoPath} (existing=${runContext.repoSettings.xrepoLearnings ? "yes" : "no"})`
        );
        const ctxForExit = toolContext;
        onExitSignal(() => persistXrepoLearnings(ctxForExit));
      } catch (err) {
        log.warning(
          `» xrepo learnings seed failed: ${err instanceof Error ? err.message : String(err)} — continuing without xrepo learnings file`
        );
      }
    }

    // seed the rolling PR summary tmpfile when the dispatcher requested it.
    // gated on event being a PR — issue/workflow_dispatch runs have no
    // summarySnapshot to maintain. file path is exposed to the agent via
    // the select_mode response addendum (action/mcp/selectMode.ts).
    if (payload.generateSummary && payload.event.is_pr && payload.event.issue_number) {
      const previousSnapshot = await fetchPreviousSnapshot(toolContext, payload.event.issue_number);
      const filePath = await seedSummaryFile({ tmpdir, previousSnapshot });
      toolState.summaryFilePath = filePath;
      // capture the exact bytes the agent will see at startup. used by
      // the post-run retry loop to detect the agent forgetting to edit
      // the file (byte-identical to seed → nudge once via resume turn)
      // and by persistSummary to skip the DB write when nothing changed.
      try {
        toolState.summarySeed = await readFile(filePath, "utf8");
      } catch {
        // intentionally empty — summarySeed stays undefined
      }
      log.info(
        `» summary snapshot seeded at ${filePath} (previous=${previousSnapshot ? "yes" : "no"})`
      );
      // on SIGINT/SIGTERM we still want to persist whatever the agent has
      // written so far. handler is best-effort: any failure inside is
      // swallowed by Promise.allSettled in exitHandler.ts, and the
      // summaryPersistAttempted guard prevents double-execution if the
      // signal arrives after the normal path already persisted. capture a
      // narrowed reference so the closure doesn't depend on the outer
      // `toolContext` variable being defined later.
      const ctxForExit = toolContext;
      onExitSignal(() => persistSummary(ctxForExit));
    }

    startInstallation(toolContext);

    logRunStartup({ payload, resolvedModel, agentName: agent.name });

    const instructions = resolveInstructions({
      payload,
      repo: runContext.repo,
      modes,
      agentId,
      outputSchema,
      signedCommits: runContext.repoSettings.signedCommits,
      repoIntelligence: runContext.repoSettings.repoIntelligence,
      learningsFilePath: toolState.learningsFilePath ?? null,
      learningsHeadings: runContext.repoSettings.learningsHeadings,
      setupHookFailure: describeSetupFailure(setupHook.failure),
      xrepoBrief: runContext.repoSettings.xrepoBrief,
      xrepoLearningsFilePath: toolState.xrepoLearningsFilePath ?? null,
      xrepoLearningsHeadings: runContext.repoSettings.xrepoLearningsHeadings,
    });
    // the prompt and the tool registry are decided in different files off
    // overlapping conditions; this is what stops them disagreeing silently.
    // WARNS, never throws: the prompt embeds customer-authored text (repo
    // instructions, an issue body), so a customer who merely writes a prefixed
    // token controls this predicate — throwing let them fail every run on their
    // own repo (`arcainc/arca`, 0.1.56).
    const danglingToolRefs = findDanglingPromptToolRefs({
      agentId,
      prompt: instructions.full,
      toolNames: mcpHttpServer.toolNames,
    });
    if (danglingToolRefs.length > 0) {
      log.warning(
        `» prompt advertises ${danglingToolRefs.length} tool(s) the MCP server did not register: ${danglingToolRefs.join(", ")}`
      );
    }
    const logParts = [
      instructions.eventInstructions
        ? `EVENT-LEVEL INSTRUCTIONS:\n${instructions.eventInstructions}`
        : null,
      instructions.user ? `USER REQUEST:\n${instructions.user}` : null,
      instructions.event,
    ].filter(Boolean);
    log.box(logParts.join("\n\n---\n\n"), {
      title: "Instructions",
    });
    log.group("View full prompt", () => {
      log.info(instructions.full);
    });

    // OpenCode loads .opencode/plugin/ files at startup. if the repo has any,
    // eagerly await dependency installation so plugin imports can resolve.
    if (agentId === "opencode") {
      const pluginDir = join(process.cwd(), ".opencode", "plugin");
      const hasPlugins =
        existsSync(pluginDir) && readdirSync(pluginDir).some((f) => /\.[jt]sx?$/.test(f));
      if (hasPlugins && toolState.dependencyInstallation?.promise) {
        log.info(
          "» .opencode/plugin/ detected — awaiting dependency installation before agent start"
        );
        await toolState.dependencyInstallation.promise.catch(() => {});
        timer.checkpoint("awaitDepsForPlugins");
      }
    }

    // run agent, optionally with timeout enforcement
    activityTimeout = createProcessOutputActivityTimeout({
      timeoutMs: AGENT_ACTIVITY_TIMEOUT_MS,
      checkIntervalMs: DEFAULT_ACTIVITY_CHECK_INTERVAL_MS,
    });
    activityTimeout.promise.catch(() => {}); // prevent unhandled rejection if agent wins race
    todoTracker = createTodoTracker(async (body) => {
      if (progressCallbackDisabled || !toolContext) return;
      try {
        // liveProgress: this is the auto-rendered checklist, not a deliberate
        // final answer — must not flip wasUpdated / lastProgressBody (see #868).
        await reportProgress(toolContext, { body, liveProgress: true });
      } catch (err) {
        log.debug(`progress update failed: ${err}`);
      }
    });
    toolState.todoTracker = todoTracker;

    // on cancellation, stop scheduling new tracker writes immediately. without this, a
    // debounced write queued just before SIGTERM could land at GitHub *after* the
    // workflow_run.completed webhook has already replaced the comment with the
    // "This run was cancelled" body, clobbering it back to the task list. we can't
    // await in-flight writes (the process is exiting), but cancelling the timer
    // shrinks the race window.
    onExitSignal(() => {
      todoTracker?.cancel();
    });

    // when the agent is killed for inner activity timeout, start a short
    // safety-net timer — if the agent promise hasn't resolved within 5min after
    // the inner kill, stop the MCP HTTP server (so mcp-proxy's SSE reconnect
    // attempts don't keep the outer activity timer alive) and force-reject the
    // outer timer so the run can exit.
    //
    // both were previously done the instant the watchdog fired, which is what
    // made the salvage in `opencode.ts` impossible: the re-prompt landed on a
    // dead MCP server, so the agent could not call `create_pull_request_review`
    // and the "recovery" produced a confidently toolless turn. deferring costs
    // nothing — `forceReject` ends the run directly, so it never depended on
    // the teardown, and `onTurnRecovered` cancels the whole thing the moment a
    // turn actually comes back. see #1085.
    let innerTimeoutFired = false;
    const onInnerActivityTimeout = () => {
      if (innerTimeoutFired) return;
      innerTimeoutFired = true;
      log.info("» inner activity timeout fired — starting 5min safety-net timer");
      safetyNetTimer = setTimeout(
        () => {
          // fire and forget — the server's dispose is idempotent so the
          // `await using` cleanup at block exit is still safe.
          mcpHttpServer[Symbol.asyncDispose]().catch((err) => {
            log.debug(
              `mcp server stop after inner kill failed: ${err instanceof Error ? err.message : String(err)}`
            );
          });
          activityTimeout?.forceReject(
            "agent still pending 5min after inner activity kill — forcing exit"
          );
        },
        5 * 60 * 1000
      );
      safetyNetTimer.unref?.();
    };

    // the aborted turn came back, so the harness is salvaging rather than dying.
    // the net only exists to catch an abort opencode ignored; leaving it armed
    // would force-exit a run that is legitimately working again. re-arming is
    // safe because the watchdog fires per turn. see #1085.
    const onTurnRecovered = () => {
      if (!innerTimeoutFired) return;
      innerTimeoutFired = false;
      if (safetyNetTimer) clearTimeout(safetyNetTimer);
      safetyNetTimer = undefined;
      // the one observable for this handshake, and the counterpart to the
      // `log.info` above. only reachable on a run that already stalled, so it
      // costs nothing on a healthy one — and without it, production `.logs/`
      // show the net armed and then nothing, leaving "stood down"
      // indistinguishable from "still counting, the run just ended". see #1085.
      log.info("» inner activity safety net stood down — turn recovered");
    };

    const agentPromise = agent.run({
      payload,
      resolvedModel,
      mcpServerUrl: mcpHttpServer.url,
      tmpdir,
      subagentDeniedTools,
      // PULLFROG_DATA_DIR (/var/lib/pullfrog) holds codex auth.json + any
      // future pullfrog-managed on-disk secrets. bash via MCP tmpfs-overlays
      // it; agent native FS tools deny it via the same secretDenyPaths plumbing
      // used for vertex creds. see wiki/security.md "Filesystem Sandbox".
      secretDenyPaths: [
        PULLFROG_DATA_DIR,
        ...(vertexCredentials ? [vertexCredentials.secretDir] : []),
      ],
      instructions,
      todoTracker,
      stopScript: runContext.repoSettings.stopScript,
      toolState,
      apiToken: runContext.apiToken,
      onActivityTimeout: onInnerActivityTimeout,
      onTurnRecovered,
      onToolUse: (event) => {
        const wasTracked = recordDiffReadFromToolUse({
          state: primaryRepoState(toolState).diffCoverage,
          toolName: event.toolName,
          input: event.input,
          cwd: process.cwd(),
        });
        if (!wasTracked) return;
        const trackedRanges = primaryRepoState(toolState).diffCoverage?.coveredRanges ?? [];
        log.debug(
          `» diff coverage tracked from tool ${event.toolName} (${trackedRanges.length} merged range${trackedRanges.length === 1 ? "" : "s"})`
        );
      },
    });
    // symmetric with the activityTimeout/timeoutPromise catches below: if a
    // timeout wins the race, agentPromise is stranded and its later rejection
    // becomes an unhandled rejection. node 15+ terminates the process on
    // unhandled rejection by default, which would kill main() mid-cleanup and
    // lose the error-reporting / usage-summary work that follows. the race
    // still sees the rejection (the original promise is shared); this catch
    // only keeps node from treating a post-race rejection as unobserved.
    agentPromise.catch(() => {});

    // timeout enforcement: default is 1 hour, but can be overridden via flags in the prompt:
    // - --timeout=2h (or any duration like "--timeout=30m", "--timeout=1h30m") to set a custom timeout
    // - --notimeout to disable timeout entirely
    let result: Awaited<typeof agentPromise>;
    if (payload.timeout === TIMEOUT_DISABLED) {
      result = await Promise.race([agentPromise, activityTimeout.promise]);
    } else {
      // resolveTimeoutMs rejects unparseable / zero / setTimeout-overflow inputs
      // so a bad string can't silently resolve to an instant timeout. fall back
      // to the 1h default with a warning — users who want runtime measured in
      // weeks should use --notimeout.
      const usable = resolveTimeoutMs(payload.timeout);
      if (payload.timeout && usable === null) {
        log.warning(`invalid timeout "${payload.timeout}" (use --notimeout to disable), using 1h`);
      }
      const timeoutMs = usable ?? 3600000;
      const actualTimeout = usable !== null ? payload.timeout : "1h";
      let timeoutId: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`agent run timed out after ${actualTimeout}`));
        }, timeoutMs);
      });
      timeoutPromise.catch(() => {}); // prevent unhandled rejection if agent wins race
      try {
        result = await Promise.race([agentPromise, timeoutPromise, activityTimeout.promise]);
      } finally {
        clearTimeout(timeoutId);
      }
    }

    // accumulate top-level agent usage
    if (result.usage) {
      toolState.usageEntries.push(result.usage);
    }

    // validate this before writing job summary to avoid masking the error
    if (outputSchema && !toolState.output) {
      throw new Error(
        "output_schema was provided but agent did not call set_output — structured output is required"
      );
    }

    // success-path cleanup: postReview → persistSummary → persistLearnings →
    // failure-error-report → stranded-comment cleanup → job summary → output
    // marker. each step is best-effort; see `finalizeSuccessRun` for ordering
    // rationale (notably: progress-comment deletion lives in
    // create_pull_request_review for review-mode runs, so deletion here
    // covers the non-review success paths).
    await finalizeSuccessRun({ toolContext, toolState, result, repo: runContext.repo });

    return await handleAgentResult({
      result,
      toolContext,
      silent: payload.event.silent ?? false,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "unknown error occurred";
    progressCallbackDisabled = true;
    todoTracker?.cancel();
    killTrackedChildren();
    log.error(errorMessage);

    // classify (BillingError reclassification + hang detection + API-key auth
    // detection) and render to {summary, comment} markdown bodies.
    const rendered = renderRunError({
      errorMessage,
      repo: runContext.repo,
      agentDiagnostic: toolState.agentDiagnostic,
      routerActive: !!payload.proxyModel,
    });
    await writeRunErrorOutputs({ rendered, toolState });

    // best-effort cleanup: review dispatch, summary persist, learnings persist.
    // a partial edit before the crash is still worth keeping.
    if (toolContext) {
      await persistRunArtifacts(toolContext);
      // failed/timed-out run → post `pullfrog` = failure (and `pullfrog-approval`
      // if a verdict landed before the crash). own best-effort guard internally.
      await reportStatusChecks(toolContext, { runSucceeded: false });
    }

    return {
      success: false,
      error: errorMessage,
    };
  } finally {
    activityTimeout?.stop();
    if (safetyNetTimer) clearTimeout(safetyNetTimer);
    // also reap on the success-with-failure path (agent returned
    // `{success: false}`) which skips the catch above and would otherwise hang
    // ~60s on the eager dep install. idempotent SIGKILL. see #862.
    killTrackedChildren();
    if (usageSummaryPath) {
      // a write error here (ENOSPC, EACCES, dirname removed) must not mask
      // either the try's successful return or the catch's error return.
      // the summary is informational — log and move on.
      try {
        await writeGitHubUsageSummaryToFile(usageSummaryPath);
      } catch (err) {
        log.debug(
          `failed to write usage summary to ${usageSummaryPath}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // persist aggregated token + cost usage to the WorkflowRun row.
    // this is the single shared cleanup path across every agent implementation:
    // each agent harness returns a single AgentUsage from agent.run() that
    // already aggregates its internal retries via mergeAgentUsage, and the
    // success branch above pushes that entry into toolState.usageEntries.
    // aggregateUsage sums across those entries (one per agent.run()).
    //
    // caveat: if the agent promise rejected (timeout or uncaught throw) the
    // usage was never pushed, so nothing gets persisted for that run. runs
    // that returned AgentResult with success=false still report their partial
    // usage because the harness populates AgentUsage before returning.
    if (toolContext) {
      const patch = aggregateUsage(toolState.usageEntries);
      // persist the resolved/effective model (what actually ran) so per-model
      // cost analytics don't have to parse the audit-only payload.
      if (toolState.model) patch.model = toolState.model;
      if (toolState.agent) patch.agent = toolState.agent;
      if (toolState.credential) patch.credential = toolState.credential;
      if (Object.keys(patch).length > 0) {
        await patchWorkflowRunFields(toolContext, patch);
      }
    }
    cleanupVertexCredentials(vertexCredentials);
  }
}
