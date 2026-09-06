/**
 * Codex agent — secure harness around the `codex` CLI (`codex exec --json`).
 *
 * Security model, mirroring the opencode and claude harnesses:
 * - native exec surfaces (`shell_tool`, `unified_exec`, code-mode, browser /
 *   computer use, plugins, lifecycle hooks) are turned off in `config.toml`'s
 *   `[features]` table. shell goes through the MCP `shell` tool, which runs
 *   with a filtered, secret-free env.
 * - subagent fan-out (`multi_agent*`) is off: codex exposes no pre-tool hook
 *   carrying a subagent marker, so there is no way to reproduce the
 *   mutating-MCP-tool gate the other two harnesses enforce on subagents. an
 *   ungated subagent could call `checkout_pr` / `push_branch` behind the
 *   orchestrator's back — see action/agents/subagentToolGates.ts.
 * - the sandbox stays ON (`approval_policy = "never"` rather than
 *   `--dangerously-bypass-approvals-and-sandbox`), so the native `apply_patch`
 *   tool is confined to the workspace even if the agent ignores instructions.
 * - `CODEX_HOME` holds auth.json under PULLFROG_DATA_DIR, which the MCP shell's
 *   mount namespace tmpfs-overlays. NOTE codex exposes no path-deny surface of
 *   its own, so unlike claude this harness does NOT consume
 *   `ctx.secretDenyPaths` — the namespace overlay is the only layer here.
 *
 * Feature toggles never use `--enable` / `--disable`: an unrecognized name is a
 * HARD arg-parse error on those (measured: `Error: Unknown feature flag`) but an
 * ignored key in the config table, so a codex version that drops a flag would
 * otherwise brick every run at startup.
 *
 * The boundary itself is held by `writeCodexConfig` marking the checkout
 * `trust_level = "untrusted"`, which stops codex loading the repo's own
 * `.codex/config.toml` — a layer that OUTRANKS ours and could otherwise
 * re-enable the native shell from a file in the untrusted tree. The same
 * settings also ride as `-c` flags (`securityOverrideFlags`) as defence in
 * depth, since those outrank every layer and cost nothing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import * as core from "@actions/core";
import type { ThreadEvent, ThreadItem } from "@openai/codex-sdk";
import { pullfrogMcpName } from "../external.ts";
import { getModelProvider, stripProviderPrefix } from "../models.ts";
import { AGENT_ACTIVITY_TIMEOUT_MS, getIdleMs, markActivity } from "../utils/activity.ts";
import { log } from "../utils/cli.ts";
import { installCodexHome } from "../utils/codexHome.ts";
import type { OAuthWriteback } from "../utils/codexRefreshDetect.ts";
import { installFromNpmTarball } from "../utils/install.ts";
import { findProviderErrorMatch } from "../utils/providerErrors.ts";
import { resolveRunEffort } from "../utils/runEffort.ts";
import { filterEnv } from "../utils/secrets.ts";
import {
  DEFAULT_MAX_RETAINED_BYTES,
  SPAWN_ACTIVITY_TIMEOUT_CODE,
  SpawnTimeoutError,
  spawn,
  TailBuffer,
} from "../utils/subprocess.ts";
import { ThinkingTimer } from "../utils/timer.ts";
import type { TodoTracker } from "../utils/todoTracking.ts";
import { getDevDependencyVersion } from "../utils/version.ts";
import { buildReflectionPrompt, runPostRunRetryLoop } from "./postRun.ts";
import {
  type AgentResult,
  type AgentRunContext,
  type AgentUsage,
  agent,
  logTokenTable,
  MAX_STDERR_LINES,
} from "./shared.ts";

/** rust target triples keyed `${process.platform}-${process.arch}`, mirroring
 * `PLATFORM_PACKAGE_BY_TARGET` in the package's own `bin/codex.js`. */
const CODEX_TARGETS: Record<string, string> = {
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
};

/**
 * Install the codex CLI and return the path to the NATIVE binary, not to the
 * `bin/codex.js` shim that would otherwise front it.
 *
 * Spawning the shim means spawning `node`, which inherits `NODE_OPTIONS` and
 * `PATH` from the run env — and a toolchain that injects a `--require` preload
 * there (nub does exactly this locally) makes the shim exit 1 before codex ever
 * starts, with a diagnostic about the WRAPPER's project rather than ours. The
 * binary is what we actually want to run, and the other two harnesses spawn
 * theirs directly for the same reason.
 */
async function installCodexCli(): Promise<string> {
  const target = CODEX_TARGETS[`${process.platform}-${process.arch}`];
  if (!target) {
    throw new Error(`the codex CLI ships no binary for ${process.platform}-${process.arch}`);
  }
  const binary = process.platform === "win32" ? "codex.exe" : "codex";
  return await installFromNpmTarball({
    packageName: "@openai/codex",
    version: getDevDependencyVersion("@openai/codex"),
    executablePath: `node_modules/@openai/codex-${process.platform}-${process.arch}/vendor/${target}/bin/${binary}`,
    installDependencies: true,
  });
}

// ── config ─────────────────────────────────────────────────────────────────────

/**
 * `[features]` entries written on every run: every ON-BY-DEFAULT surface that
 * executes code or reaches outside the run, plus the subagent fan-out we have
 * no gate for. Keys codex no longer recognizes are ignored (verified against
 * 0.147.0), so this list is safe to carry forward across CLI bumps — but
 * REVALIDATE IT ON EVERY BUMP: a NEW exec-capable feature defaulting to `true`
 * is a hole this list can't know about. `codex features list` prints the live
 * set with its stage and default.
 *
 * Only defaults-on flags belong here. `code_mode` is already off by default and
 * turning off its `code_mode_host` companion makes codex emit a loud
 * "Code Mode is unavailable… enable `features.code_mode_host`" error item into
 * the agent's own transcript, so the exec surface stays closed by leaving both
 * alone.
 */
const CODEX_DISABLED_FEATURES = [
  // browser / desktop control — network reach and arbitrary JS
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "in_app_browser",
  // third-party code loaded into the agent process
  "plugins",
  "remote_plugin",
  "plugin_sharing",
  "skill_mcp_dependency_install",
  // lifecycle hooks run commands sourced from repo config, which a PR can edit
  "hooks",
  // connectors
  "apps",
  // ungated subagent fan-out (see the file header)
  "multi_agent",
  "multi_agent_v2",
] as const;

/** exec surfaces gated on `payload.shell` rather than always-off. */
const CODEX_SHELL_FEATURES = ["shell_tool", "unified_exec"] as const;

function tomlBool(entries: readonly string[], value: boolean): string {
  return entries.map((name) => `${name} = ${value}`).join("\n");
}

/**
 * The security boundary, as `-c` overrides rather than config-file entries.
 *
 * `$CODEX_HOME/config.toml` is NOT the last word. Codex ranks its config layers
 * by an explicit integer ladder (`config/src/config_layer_source.rs`): our user
 * layer is **20**, the repo's own `.codex/config.toml` is **25**, and `-c`
 * session flags are **30**. So the checkout outranks us — and
 * `sanitize_project_config`'s denylist strips only base-URL / provider / notify
 * / profile / otel keys, NOT `sandbox_mode`, `approval_policy` or `features`.
 *
 * Which means a fork PR shipping a `.codex/config.toml` could re-enable
 * `shell_tool` and hand itself a native shell with the full run env — the exact
 * boundary this harness exists to hold, defeated by a file in the untrusted
 * tree. Measured at 0.147.0: with `model` set in both layers the REPO's value
 * won; with the same key passed as `-c`, ours won.
 *
 * These keys therefore ride at precedence 30 on every invocation, `exec` and
 * `exec resume` alike — belt to the braces of the untrusted checkout, which is
 * what actually stops the repo layer loading.
 *
 * SINCE `writeCodexConfig` MARKS THE CHECKOUT UNTRUSTED, the project layer no
 * longer loads at all, and these flags are defence in depth rather than the
 * boundary itself — they survive a change in trust semantics, and cost nothing.
 * The notes below describe why enumeration alone was never going to be enough,
 * which is what motivated finding the structural fix.
 *
 * THIS PIN IS NOT COMPLETE, and the shape of the gap matters more than the
 * length of the list. `RawMcpServerConfig` alone carries ~26 fields and none is
 * in the denylist, so enumerating keys can only ever chase the exploitable
 * ones. What is pinned is what was measured to ESCALATE — take over the
 * sandbox, widen its extent, redirect our server, or silently remove it. The
 * residue is denial-of-service on the repo's own run (`enabled_tools`,
 * per-tool approval), which costs that repo its own agent and gains it nothing.
 *
 * THE ENTRY IS WRITTEN EXPLICITLY rather than omitted, and the reason is not
 * the one an earlier version of this comment gave. Absent and `untrusted` are
 * equivalent for layer ADMISSION — `is_trusted()` is `matches!(.., Some(Trusted))`
 * and `disabled_reason_for_decision` returns a reason for every other value, so
 * a missing entry disables the layer just as well. What omitting it loses is
 * INHERITANCE: `decision_for_dir` falls back from the cwd keys to the project
 * root and then the repo root, so a grant on an ancestor would decide for us.
 * Our exact-cwd key is consulted first and settles it.
 *
 * Verify with the probe in wiki/codex-agent.md on every codex bump — a layer
 * ladder is exactly the kind of thing a major version reorders.
 */
function securityOverrideFlags(params: {
  ctx: AgentRunContext;
  sandboxMode: string;
  repoDir: string;
  mcpServerUrl: string;
  model: string | undefined;
  effortRung: string | undefined;
}): string[] {
  const shellEnabled = params.ctx.payload.shell === "enabled";
  const features = [
    ...CODEX_DISABLED_FEATURES.map((name) => `${name}=false`),
    ...CODEX_SHELL_FEATURES.map((name) => `${name}=${shellEnabled}`),
  ];
  return [
    "-c",
    `approval_policy=${JSON.stringify("never")}`,
    "-c",
    `sandbox_mode=${JSON.stringify(params.sandboxMode)}`,
    // the sandbox's EXTENT has to be locked too, not just its mode: a repo
    // setting `writable_roots = ["/"]` walked straight out of the checkout with
    // `sandbox_mode` already flag-locked (measured — apply_patch wrote a file
    // under $HOME).
    "-c",
    `sandbox_workspace_write.writable_roots=[${JSON.stringify(params.repoDir)}]`,
    "-c",
    "sandbox_workspace_write.network_access=true",
    // our own MCP server, for a third time in the same class: a repo pointing
    // `mcp_servers.pullfrog.url` at its own endpoint (measured — `codex mcp get`
    // reported the repo's URL) turns every pullfrog tool call into an
    // exfiltration channel, carrying diffs, file contents and cross-repo
    // learnings to whoever it names.
    "-c",
    `mcp_servers.${pullfrogMcpName}.url=${JSON.stringify(params.mcpServerUrl)}`,
    "-c",
    `mcp_servers.${pullfrogMcpName}.${APPROVAL_MODE_KEY}=${JSON.stringify("approve")}`,
    "-c",
    `mcp_servers.${pullfrogMcpName}.required=true`,
    "-c",
    `mcp_servers.${pullfrogMcpName}.tool_timeout_sec=660`,
    // `enabled` closes the silent-DoS variant: a repo setting it false would
    // otherwise strip every GitHub tool and leave the agent narrating failure.
    "-c",
    `mcp_servers.${pullfrogMcpName}.enabled=true`,
    // not a boundary, but the same override: a repo silently re-pointing the
    // model spends the account's money on a pick it never made, and makes the
    // "Using `…`" run footer a lie about what actually ran.
    ...(params.model ? ["-c", `model=${JSON.stringify(params.model)}`] : []),
    ...(params.effortRung
      ? ["-c", `model_reasoning_effort=${JSON.stringify(params.effortRung)}`]
      : []),
    ...features.flatMap((entry) => ["-c", `features.${entry}`]),
  ];
}

/**
 * levels `model_reasoning_effort` accepts, verbatim from the pinned CLI's
 * `ModelReasoningEffort` (codex-sdk 0.147.0). rungs come from models.dev, a
 * different source, so the two are free to drift — anything outside this set is
 * dropped rather than sent. REVALIDATE ON EVERY codex BUMP.
 */
const CODEX_EFFORTS: readonly string[] = ["minimal", "low", "medium", "high", "xhigh"];

/**
 * The bare model id to pin, or undefined to let codex pick its own default.
 *
 * Only an OpenAI specifier is passed through. `resolveAgent` already routes on
 * provider, so a non-OpenAI model reaches this harness exactly one way — the
 * `PULLFROG_AGENT=codex` escape hatch, on a repo whose stored model is
 * something else. Forwarding it there is a guaranteed
 * `model_not_found` 400 before the first turn; falling back to codex's default
 * makes the override do the thing the operator asked for.
 */
function resolveCodexModel(ctx: AgentRunContext): string | undefined {
  const specifier = ctx.payload.proxyModel ?? ctx.resolvedModel;
  if (!specifier) return undefined;
  try {
    if (getModelProvider(specifier) === "openai") return stripProviderPrefix(specifier);
  } catch {
    // unparseable specifier — treat it the same as a foreign one.
  }
  log.warning(`» ${specifier} isn't an OpenAI model — running codex on its own default instead`);
  return undefined;
}

const APPROVAL_MODE_KEY = "default_tools_approval_mode";
const APPROVE_TOOLS = `${APPROVAL_MODE_KEY} = "approve"`;

/**
 * Re-emit every `[mcp_servers.*]` section from the repo's own
 * `.codex/config.toml` with tool approval forced on.
 *
 * This copying is the ONLY way a repo's own MCP servers get registered, because
 * `writeCodexConfig` marks the checkout untrusted and codex therefore never
 * loads that file itself. It was not written for that reason: codex DID load
 * it, and this existed only to fix approval — those servers keep codex's
 * PROMPTING default, and `codex exec` has nobody to answer, so every call to a
 * repo-provided tool came back `user cancelled MCP tool call`. The trust fix
 * later disabled the layer wholesale and quietly promoted this function from an
 * ergonomic fix to the feature itself. The other two
 * harnesses merge repo MCP config without adding a second confirmation, and a
 * prompt in a non-interactive run isn't a security boundary, it's a guaranteed
 * failure — the boundary is which servers the repo owner configured.
 *
 * THAT BOUNDARY RESTS ENTIRELY ON WHEN THIS RUNS, so do not move the call.
 * A copied `[mcp_servers.x]` is unsandboxed native code execution holding named
 * run credentials: codex connects every enabled server eagerly at session
 * startup (`connection_manager.rs` filters on `enabled()` and spawns, nothing
 * waits for the model), the spawn is a plain `Command::new` with NO sandbox
 * wrapper of any kind (`stdio_server_launcher.rs`), and `create_env_for_mcp_server`
 * resolves each name in `env_vars` straight out of OUR process env.
 * What keeps that the repo OWNER's choice and not a fork author's is that the
 * read happens before the agent's first turn: runs are dispatched at
 * `ref: defaultBranch` (`utils/github/triggerWorkflow.ts`) and `writeCodexConfig`
 * is called once at harness start, so the tree here is always the default
 * branch. Fork content arrives later, via `checkout_pr`, and is never re-read —
 * codex cannot load it itself either, because the checkout is untrusted.
 * Re-reading this file after a checkout, or rewriting the config per turn,
 * turns a fork PR into arbitrary code execution with our credentials.
 *
 * The approval mode has to travel WITH a transport: an `[mcp_servers.<name>]`
 * table carrying only `default_tools_approval_mode` fails bootstrap outright
 * (`invalid transport in mcp_servers.<name>`), and a `-c` dotted override fails
 * the same way, because each config layer is validated on its own before the
 * layers merge. Copying the section verbatim into our layer is what works — the
 * duplicate definitions merge, transport and all.
 *
 * Sections are copied by line rather than parsed: the transport shape varies
 * (`command`/`args`/`env`, `url`/`bearer_token_env_var`, sub-tables) and none of
 * it needs interpreting. Our key goes immediately after the server's own header
 * so a following sub-table can't capture it, and is skipped entirely when the
 * repo already set one — TOML forbids a duplicate key in a table, and a repo
 * that made an explicit choice should keep it.
 */
function repoMcpApprovals(repoDir: string): string[] {
  const path = join(repoDir, ".codex", "config.toml");
  if (!existsSync(path)) return [];

  const out: string[] = [];
  let section: string[] = [];
  let isServerTable = false;

  function flush(): void {
    if (section.length === 0) return;
    const declared = section.some((line) => line.trimStart().startsWith(APPROVAL_MODE_KEY));
    if (isServerTable && !declared) section.splice(1, 0, APPROVE_TOOLS);
    out.push(...section, "");
    section = [];
  }

  for (const line of readFileSync(path, "utf8").split("\n")) {
    const header = line.trim().match(/^\[(?<key>[^\]]+)\]$/);
    if (!header?.groups) {
      if (section.length > 0) section.push(line);
      continue;
    }
    flush();
    const key = header.groups.key.trim();
    if (!key.startsWith("mcp_servers.")) continue;
    // `mcp_servers.name` is the server's own table; `mcp_servers.name.env` and
    // strip surrounding quotes off the first segment: TOML treats
    // `[mcp_servers."pullfrog"]` as identical to the bare form, so a quoted
    // spelling would slip past the skip below and reproduce the duplicate-table
    // parse error it exists to prevent.
    const name = key.slice("mcp_servers.".length).replace(/^"([^"]*)"/, "$1");
    // our own `[mcp_servers.pullfrog]` is already in this document, and the
    // cross-LAYER merge that makes the rest of this work does not apply within
    // one file: TOML forbids defining a table twice, and codex refuses the
    // whole config with `duplicate key` rather than merging. skip the name and
    // its sub-tables, which would otherwise graft an `env` onto our server.
    if (name === pullfrogMcpName || name.startsWith(`${pullfrogMcpName}.`)) continue;
    // `mcp_servers.name` is the server's own table; `mcp_servers.name.env` and
    // deeper are sub-tables, which must be copied but must not take our key.
    isServerTable = !name.includes(".");
    section = [line.trim()];
  }
  flush();
  return out;
}

/**
 * Warn about the one configuration where codex has no way to change a file.
 *
 * On Linux the native write path does not work at all: enforcement goes through
 * the bundled bubblewrap, which cannot create its namespace on Ubuntu 24.04
 * (`kernel.apparmor_restrict_unprivileged_userns=1`) — the OS every
 * GitHub-hosted runner now uses. `apply_patch` answers `Failed to write file`
 * for ANY path, including a plain file at the repo root. Upstream:
 * https://github.com/openai/codex/issues/29908, open and unfixed. Both
 * plausible remedies were tried on a real runner and measured NOT to help
 * (`writable_roots`, `use_legacy_landlock`).
 *
 * With a shell the agent still works — it edits through the MCP `shell` tool,
 * which is how every green e2e on this harness has actually been writing files.
 * With `shell: disabled` it has no way to change a file at all.
 *
 * This WARNS rather than refuses, because plenty of work needs no file write: a
 * review that only comments, a question answered through `report_progress`, any
 * read-only task. The first cut threw, and took out the cross-agent deny tests
 * (`nobash`, `gitwrite`, `mcpmerge`) — which run `shell: disabled` precisely
 * because that is the configuration under test. Whether a run needs to write is
 * also not knowable here: the mode is chosen mid-run by `select_mode`. So the
 * run proceeds, and a write that does come will fail with codex's own message
 * on top of this line in the log.
 */
function warnIfNativeEditsUnavailable(ctx: AgentRunContext): void {
  if (process.platform !== "linux" || ctx.payload.shell !== "disabled") return;
  log.warning(
    "» this run cannot change files: codex's native write tool depends on bubblewrap, " +
      "which Ubuntu 24.04 blocks (https://github.com/openai/codex/issues/29908), and the " +
      "MCP shell is disabled for this repo. read-only work is unaffected — set " +
      "`shell: restricted` if the agent needs to edit anything."
  );
}

/**
 * Write `$CODEX_HOME/config.toml`. `auth.json` already sits in this directory
 * (installCodexHome), so codex discovers both from the one env var.
 *
 * Everything the run needs lives here rather than in argv — including model,
 * sandbox and effort, which all have flags. `codex exec resume` is a SUBCOMMAND
 * with its own narrower option set (no `--sandbox` at all), so a config-only
 * shape is the one that provably applies identically to the first turn and to
 * every post-run gate retry.
 */
function writeCodexConfig(params: {
  ctx: AgentRunContext;
  codexHome: string;
  model: string | undefined;
  effortRung: string | undefined;
}): void {
  const shellEnabled = params.ctx.payload.shell === "enabled";
  const sandboxMode = params.ctx.payload.push === "disabled" ? "read-only" : "workspace-write";
  const repoDir = process.cwd();

  const config = [
    "# written by pullfrog",
    // "never" keeps the run non-interactive WITHOUT
    // --dangerously-bypass-approvals-and-sandbox, which would also switch the
    // sandbox off and let the native apply_patch tool write anywhere.
    'approval_policy = "never"',
    `sandbox_mode = ${JSON.stringify(sandboxMode)}`,
    // matches opencode's `webfetch: "allow"` — research is part of the job and
    // neither harness gates it on a permission.
    'web_search = "live"',
    ...(params.model ? [`model = ${JSON.stringify(params.model)}`] : []),
    ...(params.effortRung ? [`model_reasoning_effort = ${JSON.stringify(params.effortRung)}`] : []),
    "",
    "[features]",
    tomlBool(CODEX_DISABLED_FEATURES, false),
    tomlBool(CODEX_SHELL_FEATURES, shellEnabled),
    "",
    "[sandbox_workspace_write]",
    "network_access = true",
    // the checkout, named explicitly rather than left to `workspace-write` to
    // imply. does NOT fix the Linux native-write failure — nothing here does;
    // see wiki/codex-agent.md "The Linux native-write blocker".
    `writable_roots = [${JSON.stringify(repoDir)}]`,
    "",
    `[mcp_servers.${pullfrogMcpName}]`,
    `url = ${JSON.stringify(params.ctx.mcpServerUrl)}`,
    // codex's default MCP approval mode PROMPTS for anything it can't read as
    // read-only, and a `codex exec` run has nobody to answer — the call comes
    // back "user cancelled MCP tool call" and the agent silently accomplishes
    // nothing. our own server is the trusted one; the boundary is what we
    // register, not a second confirmation.
    APPROVE_TOOLS,
    // a run whose GitHub tools never registered can't do its job, so fail loudly
    // rather than let the agent improvise without them.
    "required = true",
    // mirrors the opencode harness's 660s: `checkout_pr` runs a multi-minute
    // fetch on large repos and enforces its own 600s deadline, so a shorter
    // client abort turns a working checkout into a spurious tool error.
    "tool_timeout_sec = 660",
    "",
    ...repoMcpApprovals(repoDir),
    // UNTRUSTED, deliberately, and this one line is the whole config-precedence
    // boundary. Codex loads `<repo>/.codex/config.toml` as a layer that
    // OUTRANKS ours (project 25 vs user 20), and its denylist strips none of
    // `sandbox_mode`, `approval_policy`, `features` or `mcp_servers` — so a
    // fork PR could ship a config re-enabling the native shell. Marking the
    // checkout untrusted makes that layer load `disabled`, closing the class
    // outright rather than key by key: `RawMcpServerConfig` alone has ~26
    // fields and enumeration can never finish.
    //
    // It costs nothing. `codex exec`'s only startup gate is a GIT-REPO check
    // (`exec/src/lib.rs:796` — `get_git_repo_root(...).is_none()`, whose error
    // text unhelpfully says "Not inside a trusted directory"), so an untrusted
    // checkout still runs. And the repo's own MCP servers survive, because
    // `repoMcpApprovals` above copies them into OUR layer — which is why that
    // copying exists at all.
    //
    // Measured both ways at 0.147.0: `trusted` → the repo's `model` won;
    // `untrusted` → it did not, and the run proceeded normally.
    `[projects.${JSON.stringify(repoDir)}]`,
    'trust_level = "untrusted"',
    "",
  ].join("\n");

  writeFileSync(join(params.codexHome, "config.toml"), config, { mode: 0o600 });
  log.info(`» codex config: sandbox=${sandboxMode}, nativeShell=${shellEnabled}`);
}

// ── runner ─────────────────────────────────────────────────────────────────────

type RunParams = {
  cliPath: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** bare OpenAI model id, used only to price the run — the model itself reaches
   * the CLI through `args`/config, not from here. */
  model?: string | undefined;
  todoTracker?: TodoTracker | undefined;
  onActivityTimeout?: (() => void) | undefined;
  onToolUse?: ((event: { toolName: string; input: unknown }) => void) | undefined;
};

type CodexRunResult = AgentResult & { threadId?: string | undefined };

/** codex emits its running plan as a `todo_list` item; the tracker speaks
 * claude's TodoWrite shape, so translate rather than teach it a second one. */
function toTodoWriteInput(item: Extract<ThreadItem, { type: "todo_list" }>): unknown {
  return {
    todos: item.items.map((todo, index) => ({
      id: String(index),
      content: todo.text,
      status: todo.completed ? "completed" : "pending",
    })),
  };
}

/**
 * Per-million-token USD list prices for the OpenAI models codex can run,
 * mirrored from models.dev — the same catalog the `reasoning_options` effort
 * ladders come from — rather than fetched, so a run still costs no network call.
 *
 * This table exists because codex is the one harness that cannot report its own
 * cost: claude-code gets `total_cost_usd` from Anthropic and opencode prices each
 * part itself, but the Codex SDK's `Usage` carries TOKENS ONLY and no cost field.
 * Without it every codex run persists a null `costUsd` and contributes $0 to
 * every spend surface (`runAnalytics` simply sums the column).
 *
 * A model absent here yields `undefined`, never 0 — an unknown price must not
 * read as free, which would silently understate real spend.
 *
 * These are LIST prices, and two caveats ride with them. A run on a ChatGPT
 * subscription (`CODEX_AUTH_JSON`) spends no per-token money at all, so its
 * figure is what the run WOULD have cost on the API — consistent with
 * `WorkflowRun.costUsd` being modelled rather than invoiced. And these are the
 * base tier: OpenAI bills roughly double above a 200k context, so a
 * long-context turn is under-counted here.
 */
const CODEX_MODEL_PRICING: Record<
  string,
  { input: number; cacheRead: number; cacheWrite: number; output: number }
> = {
  "gpt-6-astra": { input: 10, cacheRead: 1, cacheWrite: 12.5, output: 50 },
  "gpt-5.6-sol": { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 30 },
  "gpt-5.6-luna": { input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 1.2 },
  "gpt-5.6-terra": { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 12 },
};

/** modelled USD for a codex run; `undefined` when we hold no price for the model. */
function codexCostUsd(params: {
  model: string | undefined;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}): number | undefined {
  const price = params.model ? CODEX_MODEL_PRICING[params.model] : undefined;
  if (!price) return undefined;
  // `input_tokens` is INCLUSIVE of BOTH cache figures (see the accumulator
  // below), so the three slices PARTITION it and each carries its own rate.
  // cache writes bill at 1.25x uncached input, so folding them into `fresh`
  // understates every cache-writing run.
  const fresh = Math.max(0, params.input - params.cacheRead - params.cacheWrite);
  const usd =
    (fresh * price.input +
      params.cacheRead * price.cacheRead +
      params.cacheWrite * price.cacheWrite +
      params.output * price.output) /
    1_000_000;
  return usd > 0 ? usd : undefined;
}

async function runCodex(params: RunParams): Promise<CodexRunResult> {
  const startTime = performance.now();
  const thinkingTimer = new ThinkingTimer();
  const output = new TailBuffer(DEFAULT_MAX_RETAINED_BYTES);
  const recentStderr: string[] = [];

  let eventCount = 0;
  let finalOutput = "";
  let threadId: string | undefined;
  let turnError: string | null = null;
  let lastProviderError: string | null = null;
  let stdoutBuffer = "";

  // codex fires `turn.completed` once PER TURN, not once at the end, so usage
  // accumulates.
  //
  // OpenAI's `input_tokens` is INCLUSIVE of both cache figures, where
  // Anthropic's is disjoint from them: one measured turn reported
  // input=106224, cached=83128, cache_write=23081 — cached + the 23096 fresh
  // tokens is exactly `input_tokens`, and the write is that same fresh slice
  // going into the cache. So `input_tokens` IS the billable input total, and
  // adding either cache number to it double-counts. `cacheWriteTokens` is
  // deliberately left unset for the same reason — `AgentUsage` and
  // `logTokenTable` both define it as an ADDITIVE column.
  const tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

  function buildUsage(): AgentUsage | undefined {
    if (tokens.input === 0 && tokens.output === 0) return undefined;
    return {
      agent: "codex",
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      cacheReadTokens: tokens.cacheRead || undefined,
      costUsd: codexCostUsd({ model: params.model, ...tokens }),
    };
  }

  function onItem(item: ThreadItem, phase: "started" | "completed"): void {
    switch (item.type) {
      case "agent_message":
        if (phase === "completed" && item.text.trim()) {
          finalOutput = item.text.trim();
          log.box(finalOutput, { title: "Pullfrog" });
        }
        return;
      case "reasoning":
        if (phase === "completed" && item.text.trim()) {
          log.box(item.text.trim(), { title: "Pullfrog" });
        }
        return;
      case "command_execution":
        if (phase === "started") {
          thinkingTimer.markToolCall();
          log.toolCall({ toolName: "shell", input: { command: item.command } });
          return;
        }
        thinkingTimer.markToolResult();
        log.startGroup("shell output");
        log.info(item.aggregated_output || "");
        log.endGroup();
        return;
      case "mcp_tool_call":
        if (phase === "started") {
          thinkingTimer.markToolCall();
          params.onToolUse?.({ toolName: item.tool, input: item.arguments });
          log.toolCall({ toolName: `${item.server}__${item.tool}`, input: item.arguments });
          // an explicit report_progress supersedes plan-derived tracking, same
          // rule the other harnesses apply.
          if (item.tool.includes("report_progress")) params.todoTracker?.cancel();
          return;
        }
        thinkingTimer.markToolResult();
        if (item.error) log.info(`» tool error: ${item.error.message}`);
        return;
      case "file_change":
        if (phase === "completed") {
          const paths = item.changes.map((c) => `${c.kind} ${c.path}`).join(", ");
          log.info(`» apply_patch (${item.status}): ${paths}`);
        }
        return;
      case "web_search":
        if (phase === "started") log.toolCall({ toolName: "web_search", input: item.query });
        return;
      case "todo_list":
        if (params.todoTracker?.enabled) params.todoTracker.update(toTodoWriteInput(item));
        return;
      case "error":
        log.info(`» ${item.message}`);
        return;
      default:
        item satisfies never;
    }
  }

  function onEvent(event: ThreadEvent): void {
    switch (event.type) {
      case "thread.started":
        threadId = event.thread_id;
        return;
      case "turn.completed":
        tokens.input += event.usage.input_tokens ?? 0;
        tokens.cacheRead += event.usage.cached_input_tokens ?? 0;
        // pricing only. deliberately NOT surfaced as `cacheWriteTokens`, which
        // `AgentUsage` and `logTokenTable` both define as an ADDITIVE column.
        tokens.cacheWrite += event.usage.cache_write_input_tokens ?? 0;
        tokens.output += event.usage.output_tokens ?? 0;
        return;
      case "turn.failed":
        turnError = event.error.message;
        log.info(`» turn failed: ${turnError}`);
        return;
      case "error":
        turnError = event.message;
        log.info(`» codex error: ${event.message}`);
        return;
      case "item.started":
        onItem(event.item, "started");
        return;
      case "item.completed":
        onItem(event.item, "completed");
        return;
      case "item.updated":
        // in-progress snapshots; the plan is the one worth streaming.
        if (event.item.type === "todo_list") onItem(event.item, "started");
        return;
      case "turn.started":
        return;
      default:
        event satisfies never;
    }
  }

  try {
    const result = await spawn({
      cmd: params.cliPath,
      args: params.args,
      cwd: params.cwd,
      env: params.env,
      activityTimeout: AGENT_ACTIVITY_TIMEOUT_MS,
      onActivityTimeout: params.onActivityTimeout,
      // stdin MUST be `ignore`: codex reads a piped stdin as an extra `<stdin>`
      // prompt block and blocks on EOF, so an inherited pipe hangs the run
      // before the first model call.
      stdio: ["ignore", "pipe", "pipe"],
      killGroup: true,
      retain: "none",
      onStdout: (chunk) => {
        output.append(chunk);
        markActivity();

        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let event: ThreadEvent;
          try {
            event = JSON.parse(trimmed) as ThreadEvent;
          } catch {
            log.debug(`» non-JSON stdout line: ${trimmed.substring(0, 200)}`);
            continue;
          }
          eventCount++;
          log.debug(JSON.stringify(event, null, 2));
          const idleMs = getIdleMs();
          if (idleMs > 10_000) {
            log.info(
              `» no activity for ${(idleMs / 1000).toFixed(1)}s (${eventCount} events processed so far)`
            );
          }
          markActivity();
          onEvent(event);
        }
      },
      onStderr: (chunk) => {
        const trimmed = chunk.trim();
        if (!trimmed) return;
        recentStderr.push(trimmed);
        if (recentStderr.length > MAX_STDERR_LINES) recentStderr.shift();
        const match = findProviderErrorMatch(trimmed);
        if (match) {
          lastProviderError = match.label;
          log.info(`» provider error detected (${match.label}): ${match.excerpt}`);
        } else {
          log.debug(trimmed);
        }
      },
    });

    const duration = performance.now() - startTime;
    log.info(`» codex completed in ${Math.round(duration)}ms with exit code ${result.exitCode}`);

    const usage = buildUsage();
    if (usage) {
      // Cache Write stays 0: the table's Total is the sum of its columns, and
      // codex's write figure is a subset of the fresh input already counted in
      // the Input column (see the accumulator comment).
      logTokenTable({
        input: tokens.input - tokens.cacheRead,
        cacheRead: tokens.cacheRead,
        cacheWrite: 0,
        output: tokens.output,
      });
    }

    if (result.exitCode !== 0 || turnError) {
      const stderrSnapshot = recentStderr.join("\n");
      const error =
        turnError ||
        stderrSnapshot ||
        (lastProviderError && `provider error: ${lastProviderError}`) ||
        `unknown error - no output from Codex CLI (exit ${result.exitCode})`;
      log.error(`codex exited with code ${result.exitCode}: ${error}`);
      return { success: false, output: finalOutput || output.toString(), error, usage, threadId };
    }

    return { success: true, output: finalOutput || output.toString(), usage, threadId };
  } catch (error) {
    const duration = performance.now() - startTime;
    const message = error instanceof Error ? error.message : String(error);
    const isActivityTimeout =
      error instanceof SpawnTimeoutError && error.code === SPAWN_ACTIVITY_TIMEOUT_CODE;
    const diagnosis = lastProviderError
      ? `likely cause: ${lastProviderError}`
      : eventCount === 0
        ? "codex produced 0 stdout events - check if the API is reachable"
        : `${eventCount} events were processed before the hang`;
    log.info(
      `» codex ${isActivityTimeout ? "hung" : "failed"} after ${(duration / 1000).toFixed(1)}s: ${message}`
    );
    log.info(`» diagnosis: ${diagnosis}`);
    if (recentStderr.length > 0) log.info(`» recent stderr:\n${recentStderr.join("\n")}`);
    return {
      success: false,
      output: finalOutput || output.toString(),
      error: `${message} [${diagnosis}]`,
      usage: buildUsage(),
      threadId,
    };
  }
}

// ── agent ──────────────────────────────────────────────────────────────────────

export const codex = agent({
  name: "codex",
  install: installCodexCli,
  run: async (ctx) => {
    const cliPath = await installCodexCli();

    // the ChatGPT-subscription credential. absent means an OPENAI_API_KEY run,
    // which codex reads straight from env — resolveAgent has already checked
    // that one of the two is present.
    warnIfNativeEditsUnavailable(ctx);

    const codexHomeAuth = installCodexHome();
    const codexHome = codexHomeAuth?.codexHome ?? join(ctx.tmpdir, ".codex");
    mkdirSync(codexHome, { recursive: true });

    const effort = resolveRunEffort(ctx);
    if (effort.rung && !CODEX_EFFORTS.includes(effort.rung)) {
      log.warning(`» effort ${effort.rung} not sent — codex doesn't accept that level`);
    }
    writeCodexConfig({
      ctx,
      codexHome,
      model: resolveCodexModel(ctx),
      effortRung: effort.rung && CODEX_EFFORTS.includes(effort.rung) ? effort.rung : undefined,
    });

    if (codexHomeAuth) {
      // the CLI rewrites auth.json in place when the chain rotates; the post
      // hook diffs it and PUTs the new blob back to Pullfrog. see
      // wiki/codex-auth.md — a rotation we fail to persist expires in ~1h.
      core.saveState(
        "oauth_writeback",
        JSON.stringify({
          apiToken: ctx.apiToken,
          entries: [
            {
              secretName: "CODEX_AUTH_JSON",
              provider: "openai",
              authPath: codexHomeAuth.authPath,
              originalRefresh: codexHomeAuth.originalRefresh,
            },
          ] satisfies OAuthWriteback[],
        })
      );
    }

    // the agent process needs the LLM credential and PATH; the boundary is the
    // tool layer, not the process env. when the native shell is off we hand it
    // a filtered env anyway — defense in depth for a feature flag we don't own,
    // with the OpenAI credential added back because codex needs it.
    const baseEnv = ctx.payload.shell === "enabled" ? process.env : filterEnv();
    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
      CODEX_HOME: codexHome,
      PWD: process.cwd(),
    };
    // codex authenticates from `CODEX_API_KEY`, NOT `OPENAI_API_KEY` —
    // `read_codex_api_key_from_env` is the only env path into `CodexAuth`, and a
    // run carrying only `OPENAI_API_KEY` 401s with "Missing bearer or basic
    // authentication in header" (measured on 0.147.0). that env key also
    // OUTRANKS auth.json, so the subscription run has to clear it rather than
    // merely not set it — a workflow `env:` block could have supplied one.
    delete env.CODEX_API_KEY;
    if (codexHomeAuth) {
      delete env.OPENAI_API_KEY;
    } else if (process.env.OPENAI_API_KEY) {
      env.CODEX_API_KEY = process.env.OPENAI_API_KEY;
    }

    // the two arms above are mutually exclusive, so which one ran IS the answer
    // to "did this run spend per-token money": a ChatGPT subscription spends
    // none, and `CODEX_MODEL_PRICING` therefore prices it at what it WOULD have
    // cost on the API. recorded rather than re-derived later, because nothing
    // downstream can see this env.
    if (codexHomeAuth) {
      ctx.toolState.credential = "subscription";
    } else if (env.CODEX_API_KEY) {
      ctx.toolState.credential = "api_key";
    }

    // defence in depth behind the untrusted checkout: these outrank every config
    // layer, so the boundary holds even if trust semantics change. see
    // securityOverrideFlags.
    const securityFlags = securityOverrideFlags({
      ctx,
      sandboxMode: ctx.payload.push === "disabled" ? "read-only" : "workspace-write",
      repoDir: process.cwd(),
      mcpServerUrl: ctx.mcpServerUrl,
      model: resolveCodexModel(ctx),
      effortRung: effort.rung && CODEX_EFFORTS.includes(effort.rung) ? effort.rung : undefined,
    });

    const runnerArgs = {
      cliPath,
      cwd: process.cwd(),
      env,
      todoTracker: ctx.todoTracker,
      model: resolveCodexModel(ctx),
    };
    const initial = await runCodex({
      ...runnerArgs,
      args: [...securityFlags, "exec", "--json", ctx.instructions.full],
      onActivityTimeout: ctx.onActivityTimeout,
      onToolUse: ctx.onToolUse,
    });

    const result = await runPostRunRetryLoop({
      ctx,
      initialResult: initial,
      initialUsage: initial.usage,
      reflectionPrompt: buildReflectionPrompt(ctx.toolState),
      // a resume needs the thread codex recorded. without one there is nothing
      // to continue, and `resume --last` would be worse than not resuming: it
      // picks the newest recorded session in this cwd, which on a self-hosted
      // runner with a shared CODEX_HOME is somebody else's run.
      canResume: (r) => r.threadId !== undefined,
      resume: async (c) =>
        runCodex({
          ...runnerArgs,
          args: [
            ...securityFlags,
            "exec",
            "resume",
            "--json",
            c.previousResult.threadId ?? "",
            c.prompt,
          ],
        }),
    });

    if (result.success) {
      await ctx.todoTracker?.flush();
    } else {
      ctx.todoTracker?.cancel();
    }
    return result;
  },
});
