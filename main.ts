// changes to tool permissions should be reflected in wiki/granular-tools.md

import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { agents } from "./agents/index.ts";
import { reportProgress } from "./mcp/comment.ts";
import { startInstallation } from "./mcp/dependencies.ts";
import { startMcpHttpServer, type ToolContext } from "./mcp/server.ts";
import { computeModes } from "./modes.ts";
import { initToolState } from "./toolState.ts";
import {
  type ActivityTimeout,
  createProcessOutputActivityTimeout,
  DEFAULT_ACTIVITY_CHECK_INTERVAL_MS,
  DEFAULT_ACTIVITY_TIMEOUT_MS,
} from "./utils/activity.ts";
import { resolveAgent, resolveModel } from "./utils/agent.ts";
import { validateAgentApiKey } from "./utils/apiKeys.ts";
import { resolveBody } from "./utils/body.ts";
import { selectFallbackModelIfNeeded } from "./utils/byokFallback.ts";
import { log } from "./utils/cli.ts";
import { recordDiffReadFromToolUse } from "./utils/diffCoverage.ts";
import { onExitSignal } from "./utils/exitHandler.ts";
import { resolveGit, setGitAuthServer } from "./utils/gitAuth.ts";
import { startGitAuthServer } from "./utils/gitAuthServer.ts";
import { createOctokit, writeGitHubUsageSummaryToFile } from "./utils/github.ts";
import { resolveInstructions } from "./utils/instructions.ts";
import { persistLearnings, seedLearningsFile } from "./utils/learnings.ts";
import { describeSetupFailure, executeLifecycleHook } from "./utils/lifecycle.ts";
import { applyManagedAuthEnv, installManagedAuth } from "./utils/managedAuth.ts";
import { normalizeEnv, sanitizeSecret } from "./utils/normalizeEnv.ts";
import {
  captureAuthorizedModels,
  captureBaselineModels,
  getAuthorizedModels,
} from "./utils/openCodeModels.ts";
import { applyOverrides } from "./utils/overrides.ts";
import {
  ensurePackageManager,
  packageManagerBinDir,
  resolvePackageManagerSpec,
} from "./utils/packageManager.ts";
import { aggregateUsage, patchWorkflowRunFields } from "./utils/patchWorkflowRunFields.ts";
import { resolveOutputSchema, resolvePayload, resolvePromptInput } from "./utils/payload.ts";
import { type OidcCredentials, runProxyResolution } from "./utils/proxy.ts";
import { fetchPreviousSnapshot, persistSummary, seedSummaryFile } from "./utils/prSummary.ts";
import { handleAgentResult } from "./utils/run.ts";
import { resolveRunContextData } from "./utils/runContextData.ts";
import { renderRunError } from "./utils/runErrorRenderer.ts";
import {
  finalizeSuccessRun,
  persistRunArtifacts,
  writeRunErrorOutputs,
} from "./utils/runLifecycle.ts";
import { logRunStartup } from "./utils/runStartupLog.ts";
import { setEnvAllowlist } from "./utils/secrets.ts";
import { createTempDirectory, setupGit, wipeRunnerLeakSurface } from "./utils/setup.ts";
import { killTrackedChildren } from "./utils/subprocess.ts";
import { resolveTimeoutMs, TIMEOUT_DISABLED } from "./utils/time.ts";
import { Timer } from "./utils/timer.ts";
import { createTodoTracker } from "./utils/todoTracking.ts";
import { getJobToken, resolveTokens } from "./utils/token.ts";
import {
  cleanupVertexCredentials,
  materializeVertexCredentials,
  type VertexCredentials,
} from "./utils/vertex.ts";
import { resolveRun } from "./utils/workflow.ts";

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

  const toolState = initToolState({
    progressComment:
      typeof resolvedPromptInput !== "string" ? resolvedPromptInput.progressComment : undefined,
  });

  // resolve and fingerprint git binary before any agent code runs
  resolveGit();

  // get job token for initial API calls
  const jobToken = getJobToken();
  const initialOctokit = createOctokit(jobToken);
  const runContext = await resolveRunContextData({ octokit: initialOctokit, token: jobToken });
  timer.checkpoint("runContextData");

  // tmpdir hoisted out of the try block: `installFromNpmTarball` reads
  // PULLFROG_TEMP_DIR (set as a side effect of createTempDirectory) when
  // the opencode CLI install runs below for BYOK introspection. agent +
  // mcp server setup further down also consume the same tmpdir.
  const tmpdir = createTempDirectory();

  // install OpenCode + capture the BASELINE model set BEFORE dbSecrets and
  // Codex auth.json are in scope. this is the set of models OpenCode can
  // route from the runner's pre-existing environment alone (workflow
  // `env:` block + GH Actions secrets). install is fs-cached, so the
  // duplicate call inside the opencode agent's run() is a no-op.
  const opencodeCliPath = await agents.opencode.install();
  captureBaselineModels(opencodeCliPath);

  // inject account-level secrets into process.env (YAML secrets take precedence).
  // sanitizeSecret trims + masks so accidental trailing whitespace doesn't leak
  // through GitHub Actions' line-based log masking. whitespace-only values
  // return null and skip injection so the user sees a clear missing-key error.
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

  // materialize managed credentials (Codex today, other model auth shapes
  // later). this has to land BEFORE captureAuthorizedModels so OpenCode's
  // model introspection sees OAuth-routed models.
  const managedAuth = installManagedAuth();
  applyManagedAuthEnv(process.env, managedAuth.env);

  // capture the AUTHORIZED model set after dbSecrets + Codex auth.json are
  // applied. this is the authoritative source for the BYOK fallback
  // decision and the opencode-agent path of validateAgentApiKey — strictly
  // more accurate than the static envVars/managedCredentials catalog,
  // which can miss new auth shapes.
  captureAuthorizedModels(opencodeCliPath);

  // configure env allowlist for subprocess filtering
  if (runContext.repoSettings.envAllowlist) {
    setEnvAllowlist(runContext.repoSettings.envAllowlist);
  }

  // resolve payload to determine shell permission
  const payload = resolvePayload(resolvedPromptInput, runContext.repoSettings);
  toolState.model = payload.model;
  if (payload.event.trigger === "pull_request_synchronize") {
    toolState.beforeSha = payload.event.before_sha;
  }

  // resolve tokens first — acquireNewToken needs OIDC env vars for token exchange
  await using tokenRef = await resolveTokens({ push: payload.push });

  // wipe the GHA runner's known credential leak surface inside $RUNNER_TEMP
  // before the agent spawns. our installation token is already in memory
  // (tokenRef above), and setupGit's includeIf strip handles the matching
  // dangling references in the user's .git/config. see wipeRunnerLeakSurface
  // for the leak inventory and threat model.
  wipeRunnerLeakSurface();

  // stash OIDC credentials in memory before wiping from process.env
  // the agent's shell commands can't access JS variables, so this is safe
  const oidcCredentials: OidcCredentials | null =
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
      ? {
          requestUrl: process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
          requestToken: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
        }
      : null;

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

  // create octokit with MCP token for GitHub API calls
  const octokit = createOctokit(tokenRef.mcpToken);

  const runInfo = await resolveRun({ octokit });
  let toolContext: ToolContext | undefined;
  let progressCallbackDisabled = false;
  let todoTracker: ReturnType<typeof createTodoTracker> | undefined;
  let vertexCredentials: VertexCredentials | undefined;

  try {
    if (payload.cwd && process.cwd() !== payload.cwd) {
      process.chdir(payload.cwd);
    }

    const tmpdir = createTempDirectory();

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

    const initialResolvedModel = payload.proxyModel
      ? undefined
      : resolveModel({ slug: payload.model });

    // BYOK fallback: if the configured model needs a key the runner doesn't
    // have, swap to a free OpenCode model so the run can still produce
    // value. Without this, the agent launches with no key, the LLM provider
    // 401s, and the run dies in seconds with a synthetic "Invalid API key"
    // — exactly the silent-churn pattern that took out 15 accounts before
    // this landed. Router/proxy runs are skipped (Pullfrog mints the key);
    // see `selectFallbackModelIfNeeded` for the full skip set.
    const authorized = getAuthorizedModels();
    const fallback = selectFallbackModelIfNeeded({
      resolvedModel: initialResolvedModel,
      proxyModel: payload.proxyModel,
      authorized,
    });
    // when fallback engages we bypass `resolveModel` for the new slug —
    // `PULLFROG_MODEL` has higher priority than the slug arg inside that
    // helper and would otherwise re-override back to the unkeyed model.
    // the free fallback slug is already a CLI-ready specifier, so using
    // it verbatim is correct and avoids the override.
    const effectiveSlug = fallback.fallback ? fallback.to : payload.model;
    const resolvedModel = fallback.fallback ? fallback.to : initialResolvedModel;
    if (fallback.fallback) {
      log.warning(
        `» fell back from ${fallback.from} to ${fallback.to} — no BYOK key present in runner env. add a provider key in repo secrets to use ${fallback.from} instead.`
      );
      toolState.modelFallback = { from: fallback.from };
    }

    vertexCredentials = materializeVertexCredentials({ model: resolvedModel });

    const agent = resolveAgent({ model: resolvedModel });

    // surface the effective model in comment/review footers. payload.model is
    // just the stored slug (often undefined for router/oss runs that derive
    // the target from proxyModel). matching priority with resolveModelForLog
    // so the "Using `…`" badge reflects what actually ran.
    toolState.model = payload.proxyModel ?? resolvedModel ?? effectiveSlug;

    // skip validation when fallback engaged: the effective model is the
    // free fallback (`opencode/big-pickle`) and the fallback gate already
    // authoritatively decided "this model is OK to run". re-validating
    // would spuriously throw if `opencode models` doesn't list big-pickle.
    //
    // also skip when proxyModel is set: `runProxyResolution` already minted
    // OPENROUTER_API_KEY and the server-side gate (`run-context/route.ts`)
    // is the authority on "can this run use the router". the `authorized`
    // set was captured BEFORE the proxy mint, so it doesn't see the
    // openrouter slug — re-validating would spuriously throw. mirrors the
    // analogous `if (input.proxyModel) return { fallback: false }` skip in
    // `selectFallbackModelIfNeeded`.
    if (!fallback.fallback && !payload.proxyModel) {
      validateAgentApiKey({
        agent,
        model: payload.proxyModel ?? resolvedModel ?? effectiveSlug,
        authorized,
        owner: runContext.repo.owner,
        name: runContext.repo.name,
      });
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
    if (pmSpec) {
      await ensurePackageManager({ spec: pmSpec, binDir: packageManagerBinDir(tmpdir) });
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
    const modes = [...computeModes(agentId), ...runContext.repoSettings.modes];

    const outputSchema = resolveOutputSchema();

    // mcpServerUrl and tmpdir are set after server starts
    toolContext = {
      agentId,
      repo: runContext.repo,
      payload,
      octokit,
      githubInstallationToken: tokenRef.mcpToken,
      gitToken: tokenRef.gitToken,
      apiToken: runContext.apiToken,
      modes,
      postCheckoutScript: runContext.repoSettings.postCheckoutScript,
      prepushScript: runContext.repoSettings.prepushScript,
      prApproveEnabled: runContext.repoSettings.prApproveEnabled,
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
      learningsFilePath: toolState.learningsFilePath ?? null,
      learningsHeadings: runContext.repoSettings.learningsHeadings,
      setupHookFailure: describeSetupFailure(setupHook.failure),
    });
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
      timeoutMs: DEFAULT_ACTIVITY_TIMEOUT_MS,
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

    // when the agent subprocess is killed for inner activity timeout, stop
    // the MCP HTTP server so mcp-proxy's SSE reconnect attempts don't keep
    // the outer activity timer alive. start a short safety-net timer — if
    // the agent promise hasn't resolved within 5min after the inner kill,
    // force-reject the outer timer so the run can exit.
    let innerTimeoutFired = false;
    const onInnerActivityTimeout = () => {
      if (innerTimeoutFired) return;
      innerTimeoutFired = true;
      log.info(
        "» inner activity timeout fired — stopping MCP server and starting 5min safety-net timer"
      );
      // fire and forget — the server's dispose is idempotent so the
      // `await using` cleanup at block exit is still safe.
      mcpHttpServer[Symbol.asyncDispose]().catch((err) => {
        log.debug(
          `mcp server stop after inner kill failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });
      safetyNetTimer = setTimeout(
        () => {
          activityTimeout?.forceReject(
            "agent still pending 5min after inner activity kill — forcing exit"
          );
        },
        5 * 60 * 1000
      );
      safetyNetTimer.unref?.();
    };

    const agentPromise = agent.run({
      payload,
      resolvedModel,
      mcpServerUrl: mcpHttpServer.url,
      tmpdir,
      // managedAuth.secretDenyPaths holds Pullfrog-managed on-disk secrets
      // (Codex auth.json today, future provider auth files later). bash via
      // MCP tmpfs-overlays those paths; agent native FS tools deny them via
      // the same plumbing used for vertex creds. see wiki/security.md
      // "Filesystem Sandbox".
      secretDenyPaths: [
        ...managedAuth.secretDenyPaths,
        ...(vertexCredentials ? [vertexCredentials.secretDir] : []),
      ],
      instructions,
      todoTracker,
      stopScript: runContext.repoSettings.stopScript,
      toolState,
      apiToken: runContext.apiToken,
      onActivityTimeout: onInnerActivityTimeout,
      onToolUse: (event) => {
        const wasTracked = recordDiffReadFromToolUse({
          state: toolState.diffCoverage,
          toolName: event.toolName,
          input: event.input,
          cwd: process.cwd(),
        });
        if (!wasTracked) return;
        const trackedRanges = toolState.diffCoverage?.coveredRanges ?? [];
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
    });
    await writeRunErrorOutputs({ rendered, toolState });

    // best-effort cleanup: review dispatch, summary persist, learnings persist.
    // a partial edit before the crash is still worth keeping.
    if (toolContext) {
      await persistRunArtifacts(toolContext);
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
      if (Object.keys(patch).length > 0) {
        await patchWorkflowRunFields(toolContext, patch);
      }
    }
    cleanupVertexCredentials(vertexCredentials);
  }
}
