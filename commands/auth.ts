// `pullfrog auth <provider>` — manage credentials for a configured repo
// without going through the full `init` flow. currently supports:
//
//   pullfrog auth codex    mint a Codex subscription credential and save it
//                          as the `CODEX_AUTH_JSON` Pullfrog secret
//   pullfrog auth claude   save a Claude Code subscription OAuth token as
//                          the `CLAUDE_CODE_OAUTH_TOKEN` Pullfrog secret
//   pullfrog auth grok     mint a Grok (SuperGrok / X Premium) subscription
//                          credential and save it as `GROK_AUTH_JSON`
//
// the `codex` subcommand runs `codex login --device-auth` against an
// isolated `CODEX_HOME` (so the user's existing ~/.codex/auth.json is never
// touched), validates the resulting auth.json, and posts it to the Pullfrog
// secrets API. used both for first-time setup of a Codex subscription on a
// repo and for rotating a stale credential.
//
// the `claude` subcommand prompts the user to paste the long-lived OAuth
// token printed by `claude setup-token` and posts it to the same secrets
// API, which verifies it with Anthropic before storing it. unlike Codex, the
// token is static (no refresh chain), so there's no post-run write-back —
// see wiki/codex-auth.md "Claude sibling".
//
// the `grok` subcommand runs the RFC 8628 device-code grant against xAI
// directly — no second CLI to install, unlike codex. opencode consumes the
// resulting chain natively via its XaiAuthPlugin. like codex (and unlike
// claude) the refresh token rotates on every use, so the blob MUST live in
// Pullfrog's runtime-writable store and gets written back after every run.
// see wiki/grok-auth.md.

import { spawn } from "node:child_process";
import * as p from "@clack/prompts";
import arg from "arg";
import pc from "picocolors";
import { mintCodexAuth, refreshCodexAuth } from "../utils/codexAuth.ts";
import {
  pollXaiDeviceAuth,
  refreshXaiAuthBody,
  startXaiDeviceAuth,
  stringifyXaiAuthBody,
} from "../utils/xaiOAuth.ts";
import { configurationApi, resolveTarget, scopeArgs } from "./_configuration.ts";
import {
  bail,
  CLAUDE_OAUTH_SECRET,
  CODEX_AUTH_SECRET,
  describeSecretTarget,
  fetchStatus,
  GROK_AUTH_SECRET,
  getGhToken,
  handleCancel,
  PULLFROG_API_URL,
  promptScope,
  setActiveSpin,
  setPullfrogSecret,
  shadowRefusal,
} from "./_shared.ts";
import { secretNamesSchema } from "./secret.ts";

/** prefix on `claude setup-token` OAuth tokens (`sk-ant-oat01-…`). a
 * warn-on-mismatch shape check only; whether the token actually WORKS is
 * settled by the secrets API, which refuses a token Anthropic rejects. */
const CLAUDE_OAUTH_TOKEN_PREFIX = "sk-ant-oat";

/** strip CSI ANSI escapes (color, cursor) from a string so callers can re-style
 * the visible text without inheriting the source's formatting. covers what
 * Codex emits during device auth (mostly `\x1b[<digits>m` color codes).
 */
function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control chars by design
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

/** matches the Codex device-auth verification URL printed by `codex login
 * --device-auth`. captures the full URL (with query string) up to whitespace.
 */
const CODEX_DEVICE_URL_RE = /https:\/\/auth\.openai\.com\/codex\/device\S*/;

/** best-effort cross-platform "open URL in default browser". swallows
 * spawn errors and non-zero exits — the user can always copy-paste the URL
 * Codex already printed. on Linux, falls back to `wslview` when `xdg-open`
 * is missing (covers WSL where xdg-open isn't installed by default).
 */
function openInBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (platform === "win32") {
    // `start` is a cmd.exe builtin. the empty "" is the window title
    // (required when the next argument is quoted, which happens for
    // URLs with `&`).
    cmd = "cmd.exe";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => {
    if (platform !== "linux") return;
    const fallback = spawn("wslview", [url], { stdio: "ignore", detached: true });
    fallback.on("error", () => {});
    fallback.unref();
  });
  child.unref();
}

interface AuthCliParams {
  args: string[];
  prog: string;
  showHelp?: boolean;
}

function printAuthUsage(params: { stream: typeof console.log; prog: string }): void {
  params.stream(`usage: ${params.prog} auth <provider>\n`);
  params.stream("manage provider credentials for the current repository.");
  params.stream("");
  params.stream("providers:");
  params.stream("  codex    mint a Codex (ChatGPT) subscription credential");
  params.stream("  claude   save a Claude Code subscription OAuth token");
  params.stream("  grok     mint a Grok (SuperGrok / X Premium) subscription credential");
  params.stream("");
  params.stream("options:");
  params.stream("  --org OWNER | --repo OWNER/REPO   select the credential scope");
  params.stream("  -h, --help   show help");
}

function printCodexUsage(params: { stream: typeof console.log; prog: string }): void {
  params.stream(`usage: ${params.prog} auth codex [options]\n`);
  params.stream("mint a Codex subscription credential and save it as CODEX_AUTH_JSON.");
  params.stream("");
  params.stream("options:");
  params.stream("  --org OWNER | --repo OWNER/REPO   select the credential scope");
  params.stream("  --slot N   save an extra subscription as CODEX_AUTH_JSON_N (N is 2 or more)");
  params.stream("  -h, --help   show help");
}

function printClaudeUsage(params: { stream: typeof console.log; prog: string }): void {
  params.stream(`usage: ${params.prog} auth claude [options]\n`);
  params.stream("save a Claude Code subscription OAuth token as CLAUDE_CODE_OAUTH_TOKEN.");
  params.stream("");
  params.stream("options:");
  params.stream("  --org OWNER | --repo OWNER/REPO   select the credential scope");
  params.stream("  -h, --help   show help");
}

export async function runCli(params: AuthCliParams): Promise<void> {
  // route `auth --help` (no subcommand) to top-level usage. when the user
  // passes `auth codex --help`, we leave the flag in the rest args so the
  // subcommand's own parser handles it.
  const firstArg = params.args[0];
  const helpAtTopLevel =
    params.showHelp ||
    params.args.length === 0 ||
    (params.args.length === 1 && (firstArg === "--help" || firstArg === "-h"));
  if (helpAtTopLevel) {
    printAuthUsage({ stream: console.log, prog: params.prog });
    return;
  }

  const subcommand = firstArg;
  const rest = params.args.slice(1);

  if (subcommand === "codex") {
    await runCodex({ args: rest, prog: params.prog });
    return;
  }

  if (subcommand === "claude") {
    await runClaude({ args: rest, prog: params.prog });
    return;
  }

  if (subcommand === "grok") {
    await runGrok({ args: rest, prog: params.prog });
    return;
  }

  console.error(`unknown auth provider: ${pc.bold(subcommand)}\n`);
  printAuthUsage({ stream: console.error, prog: params.prog });
  process.exit(1);
}

interface CodexCliParams {
  args: string[];
  prog: string;
}

function parseCodexArgs(args: string[]) {
  return arg(
    {
      ...scopeArgs,
      "--slot": Number,
    },
    { argv: args }
  );
}

async function runCodex(params: CodexCliParams): Promise<void> {
  let parsed: ReturnType<typeof parseCodexArgs>;
  try {
    parsed = parseCodexArgs(params.args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${message}\n`);
    printCodexUsage({ stream: console.error, prog: params.prog });
    process.exit(1);
  }

  if (parsed["--help"]) {
    printCodexUsage({ stream: console.log, prog: params.prog });
    return;
  }

  if (parsed._.length) throw new Error("unexpected auth argument");
  const slot = parsed["--slot"];
  if (slot !== undefined && !(Number.isSafeInteger(slot) && slot >= 2)) {
    throw new Error("--slot must be an integer of 2 or more");
  }
  await runCodexAuth(
    parsed,
    slot === undefined ? CODEX_AUTH_SECRET : `${CODEX_AUTH_SECRET}_${slot}`
  );
}

/** checked before the sign-in, so nobody completes a device flow for a save that cannot land.
 * `secret set` guards the same write with the same message — see `shadowRefusal`. */
function refuseWhenRepoCopiesShadow(params: {
  access: ReturnType<typeof secretNamesSchema.parse>;
  owner: string;
  name: string;
}): void {
  const refusal = shadowRefusal({
    overrides: params.access.overrides,
    owner: params.owner,
    name: params.name,
  });
  if (!refusal) return;
  p.log.warn(refusal);
  bail("nothing saved.");
}

async function runCodexAuth(
  parsed: ReturnType<typeof parseCodexArgs>,
  name: string
): Promise<void> {
  p.intro(pc.bgGreen(pc.black(" pullfrog auth codex ")));

  const spin = p.spinner();
  setActiveSpin(spin);

  try {
    spin.start("authenticating with github");
    const token = getGhToken();
    spin.stop("github authenticated");

    spin.start("detecting repository");
    const selectedTarget = resolveTarget({ org: parsed["--org"], repo: parsed["--repo"] });
    const remote = { owner: selectedTarget.owner, repo: selectedTarget.repo ?? "" };
    spin.stop(`selected ${pc.cyan(remote.repo ? `${remote.owner}/${remote.repo}` : remote.owner)}`);

    spin.start("checking pullfrog app installation");
    const status =
      selectedTarget.repo && parsed["--repo"] === undefined
        ? await fetchStatus({ token, owner: remote.owner, repo: selectedTarget.repo })
        : {
            installed: true,
            isOrg: true,
            pullfrogSecrets: secretNamesSchema.parse(
              await configurationApi({ target: selectedTarget, path: "credentials", token })
            ).secrets,
          };
    if (!status.installed) {
      spin.stop(pc.red("pullfrog app not installed on this repo"));
      bail(
        `install pullfrog on ${pc.bold(`${remote.owner}/${remote.repo}`)} before configuring auth.\n` +
          `  ${pc.dim("run:")} ${pc.cyan(`npx pullfrog init`)}`
      );
    }
    spin.stop(`pullfrog app is installed on ${pc.cyan(`@${remote.owner}`)}`);

    // user-owned repos can only ever be "account" (Pullfrog has no per-repo
    // store for user accounts), so we never bother prompting. on org-owned
    // repos, prompt interactively — matches `init`'s behavior.
    // explicit scopes override the legacy no-flag selection above.
    const scope =
      parsed["--org"] !== undefined
        ? "account"
        : parsed["--repo"] !== undefined
          ? "repo"
          : status.isOrg
            ? await promptScope({ owner: remote.owner, repo: remote.repo })
            : "account";
    const access = secretNamesSchema.parse(
      await configurationApi({
        target: { owner: remote.owner, repo: scope === "repo" ? remote.repo : undefined },
        path: "credentials",
        token,
      })
    );
    if (!access.writable)
      bail(
        scope === "repo"
          ? "repo admin required to change secrets"
          : "org owner required to change secrets"
      );

    if (
      name !== CODEX_AUTH_SECRET &&
      !access.secrets.includes(CODEX_AUTH_SECRET) &&
      !access.inherited.includes(CODEX_AUTH_SECRET)
    ) {
      bail(
        `${pc.cyan(name)} adds to ${pc.cyan(CODEX_AUTH_SECRET)}, which is not saved here. ` +
          `run ${pc.cyan(`${process.env.PULLFROG_BIN_NAME || "pullfrog"} auth codex`)} first.`
      );
    }

    refuseWhenRepoCopiesShadow({ access, owner: remote.owner, name });

    if (access.secrets.includes(name)) {
      const overwrite = await p.select({
        message: `${pc.cyan(name)} is already configured — overwrite?`,
        options: [
          { value: true, label: "overwrite", hint: "rotate to a freshly minted credential" },
          { value: false, label: "cancel" },
        ],
      });
      handleCancel(overwrite);
      if (!overwrite) {
        p.cancel("canceled.");
        return;
      }
    }

    const slotFlag = parsed["--slot"] === undefined ? "" : ` --slot ${parsed["--slot"]}`;
    p.log.info(
      [
        `signing in via Codex device authorization. open the URL Codex prints`,
        `below, enter the one-time code, and approve in your browser.`,
        ``,
        `${pc.dim("note:")} if your ChatGPT account doesn't have device-code auth enabled,`,
        `Codex will exit early. enable it at ${pc.cyan(`https://chatgpt.com/#settings/Security`)}`,
        `then re-run ${pc.cyan(`${process.env.PULLFROG_BIN_NAME || "pullfrog"} auth codex${slotFlag}`)}.`,
      ].join("\n")
    );

    // tracks the most recent exit so the retry prompt can tell the user
    // *why* no auth.json was written (timeout vs. early-exit).
    let lastTimedOut = false;
    // gate so we don't re-launch the browser if Codex prints the URL
    // more than once (e.g. on a retry attempt within the same flow).
    let hasOpenedDeviceUrl = false;
    const auth = await mintCodexAuth({
      childStdio: "pipe",
      onChildLine: (line) => {
        // dim Codex's own colored output (URL/code in cyan, boilerplate in
        // gray) so the user reads it as sub-process noise, not Pullfrog's
        // own prompts. the rail char matches @clack/prompts so the column
        // reads as one continuous flow.
        const stripped = stripAnsi(line);
        process.stdout.write(`${pc.gray(p.S_BAR)}  ${pc.dim(stripped)}\n`);
        if (hasOpenedDeviceUrl) return;
        const match = stripped.match(CODEX_DEVICE_URL_RE);
        if (!match) return;
        hasOpenedDeviceUrl = true;
        const url = match[0];
        openInBrowser(url);
        process.stdout.write(
          `${pc.gray(p.S_BAR)}  ${pc.dim(`» opened ${url} in browser (paste manually if it didn't open)`)}\n`
        );
      },
      onProgress: (event) => {
        if (event.kind === "start") {
          lastTimedOut = false;
          if (event.attempt > 1) p.log.info(`retry attempt ${event.attempt}`);
          // shell-prompt style header so the user sees what Pullfrog is
          // about to spawn, with the rail to keep the visual column.
          process.stdout.write(`${pc.gray(p.S_BAR)}\n`);
          process.stdout.write(`${pc.gray(p.S_BAR)}  $ codex login --device-auth\n`);
        }
        if (event.kind === "exit") {
          if (event.timedOut) lastTimedOut = true;
          // trailing blank rail so the next clack prompt isn't crammed
          // against the last codex output line.
          process.stdout.write(`${pc.gray(p.S_BAR)}\n`);
        }
      },
      shouldRetry: async () => {
        const message = lastTimedOut
          ? "device authorization timed out — retry?"
          : "no auth.json was written — retry?";
        const retry = await p.select({
          message,
          options: [
            { value: true, label: "retry", hint: "after enabling device-code auth" },
            { value: false, label: "cancel" },
          ],
        });
        handleCancel(retry);
        return retry;
      },
    });

    // eager refresh: bump the OAuth chain once before persisting so the
    // saved token is one Pullfrog has used. otherwise the user's laptop's
    // codex CLI could refresh first and strand our copy.
    spin.start("refreshing token");
    let savable: typeof auth;
    try {
      savable = await refreshCodexAuth(auth);
      spin.stop("refreshed");
    } catch (err) {
      spin.stop(pc.yellow("refresh failed — saving minted token as-is"));
      p.log.warn(err instanceof Error ? err.message : String(err));
      savable = auth;
    }

    const target = describeSecretTarget({ owner: remote.owner, repo: remote.repo, scope });
    spin.start(`saving ${pc.cyan(name)} to ${target}`);
    const result = await setPullfrogSecret({
      token,
      owner: remote.owner,
      repo: remote.repo,
      name,
      value: savable.json,
      scope,
    });
    if (!result.saved) {
      spin.stop(pc.red("could not save secret"));
      p.log.warn(
        `${result.error}\n  ${pc.dim("set it manually at:")} ${PULLFROG_API_URL}/console/${remote.owner}`
      );
      process.exit(1);
    }
    spin.stop(`saved ${pc.cyan(name)} to ${target}`);
    setActiveSpin(null);
    p.outro("done.");
  } catch (error) {
    // mirror what `bail` does: stop the spinner with a red "failed" glyph
    // before clearing it, otherwise an in-flight spinner keeps animating
    // above the error message we're about to print.
    spin.stop(pc.red("failed"));
    setActiveSpin(null);
    const message = error instanceof Error ? error.message : String(error);
    p.log.error(message);
    process.exit(1);
  }
}

interface ClaudeCliParams {
  args: string[];
  prog: string;
}

function parseClaudeArgs(args: string[]) {
  return arg(
    {
      ...scopeArgs,
    },
    { argv: args }
  );
}

async function runClaude(params: ClaudeCliParams): Promise<void> {
  let parsed: ReturnType<typeof parseClaudeArgs>;
  try {
    parsed = parseClaudeArgs(params.args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${message}\n`);
    printClaudeUsage({ stream: console.error, prog: params.prog });
    process.exit(1);
  }

  if (parsed["--help"]) {
    printClaudeUsage({ stream: console.log, prog: params.prog });
    return;
  }

  if (parsed._.length) throw new Error("unexpected auth argument");
  await runClaudeAuth(parsed);
}

async function runClaudeAuth(parsed: ReturnType<typeof parseCodexArgs>): Promise<void> {
  p.intro(pc.bgGreen(pc.black(" pullfrog auth claude ")));

  const spin = p.spinner();
  setActiveSpin(spin);

  try {
    spin.start("authenticating with github");
    const token = getGhToken();
    spin.stop("github authenticated");

    spin.start("detecting repository");
    const selectedTarget = resolveTarget({ org: parsed["--org"], repo: parsed["--repo"] });
    const remote = { owner: selectedTarget.owner, repo: selectedTarget.repo ?? "" };
    spin.stop(`selected ${pc.cyan(remote.repo ? `${remote.owner}/${remote.repo}` : remote.owner)}`);

    spin.start("checking pullfrog app installation");
    const status =
      selectedTarget.repo && parsed["--repo"] === undefined
        ? await fetchStatus({ token, owner: remote.owner, repo: selectedTarget.repo })
        : {
            installed: true,
            isOrg: true,
            pullfrogSecrets: secretNamesSchema.parse(
              await configurationApi({ target: selectedTarget, path: "credentials", token })
            ).secrets,
          };
    if (!status.installed) {
      spin.stop(pc.red("pullfrog app not installed on this repo"));
      bail(
        `install pullfrog on ${pc.bold(`${remote.owner}/${remote.repo}`)} before configuring auth.\n` +
          `  ${pc.dim("run:")} ${pc.cyan(`npx pullfrog init`)}`
      );
    }
    spin.stop(`pullfrog app is installed on ${pc.cyan(`@${remote.owner}`)}`);

    // user-owned repos can only ever be "account" (Pullfrog has no per-repo
    // store for user accounts), so we never bother prompting. on org-owned
    // repos, prompt interactively — matches `init`'s behavior.
    // explicit scopes override the legacy no-flag selection above.
    const scope =
      parsed["--org"] !== undefined
        ? "account"
        : parsed["--repo"] !== undefined
          ? "repo"
          : status.isOrg
            ? await promptScope({ owner: remote.owner, repo: remote.repo })
            : "account";
    const access = secretNamesSchema.parse(
      await configurationApi({
        target: { owner: remote.owner, repo: scope === "repo" ? remote.repo : undefined },
        path: "credentials",
        token,
      })
    );
    if (!access.writable)
      bail(
        scope === "repo"
          ? "repo admin required to change secrets"
          : "org owner required to change secrets"
      );

    refuseWhenRepoCopiesShadow({ access, owner: remote.owner, name: CLAUDE_OAUTH_SECRET });

    if (access.secrets.includes(CLAUDE_OAUTH_SECRET)) {
      const overwrite = await p.select({
        message: `${pc.cyan(CLAUDE_OAUTH_SECRET)} is already configured — overwrite?`,
        options: [
          { value: true, label: "overwrite", hint: "replace with a freshly minted token" },
          { value: false, label: "cancel" },
        ],
      });
      handleCancel(overwrite);
      if (!overwrite) {
        p.cancel("canceled.");
        return;
      }
    }

    p.log.info(
      [
        `mint a long-lived Claude Code OAuth token, then paste it below.`,
        ``,
        `${pc.dim("run:")} ${pc.cyan("claude setup-token")}`,
        `it opens your browser, works with Pro/Max subscriptions, and prints a`,
        `token starting with ${pc.cyan("sk-ant-oat…")}. copy that token.`,
      ].join("\n")
    );

    const oauthToken = await p.password({
      message: `paste your Claude Code OAuth token ${pc.dim("(Enter to cancel)")}`,
      mask: "*",
    });
    handleCancel(oauthToken);

    if (!oauthToken) {
      p.cancel("canceled.");
      return;
    }

    // trim defensively — a trailing newline from a terminal copy breaks GitHub
    // Actions' line-based log masking downstream. the API trims too, but doing
    // it here keeps the prefix sanity check honest.
    const value = oauthToken.trim();
    if (!value.startsWith(CLAUDE_OAUTH_TOKEN_PREFIX)) {
      p.log.warn(
        `that doesn't look like a ${pc.cyan("claude setup-token")} token (expected ${pc.cyan(`${CLAUDE_OAUTH_TOKEN_PREFIX}…`)}). saving it anyway.`
      );
    }

    const target = describeSecretTarget({ owner: remote.owner, repo: remote.repo, scope });
    spin.start(`saving ${pc.cyan(CLAUDE_OAUTH_SECRET)} to ${target}`);
    const result = await setPullfrogSecret({
      token,
      owner: remote.owner,
      repo: remote.repo,
      name: CLAUDE_OAUTH_SECRET,
      value,
      scope,
    });
    if (!result.saved) {
      spin.stop(pc.red("could not save secret"));
      p.log.warn(
        `${result.error}\n  ${pc.dim("set it manually at:")} ${PULLFROG_API_URL}/console/${remote.owner}`
      );
      process.exit(1);
    }
    spin.stop(`saved ${pc.cyan(CLAUDE_OAUTH_SECRET)} to ${target}`);
    setActiveSpin(null);
    p.outro("done.");
  } catch (error) {
    // mirror what `bail` does: stop the spinner with a red "failed" glyph
    // before clearing it, otherwise an in-flight spinner keeps animating
    // above the error message we're about to print.
    spin.stop(pc.red("failed"));
    setActiveSpin(null);
    const message = error instanceof Error ? error.message : String(error);
    p.log.error(message);
    process.exit(1);
  }
}

interface GrokCliParams {
  args: string[];
  prog: string;
}

function printGrokUsage(params: { stream: typeof console.log; prog: string }): void {
  params.stream(`usage: ${params.prog} auth grok [options]\n`);
  params.stream("mint a Grok subscription credential and save it as GROK_AUTH_JSON.");
  params.stream("");
  params.stream("options:");
  params.stream("  --org OWNER | --repo OWNER/REPO   select the credential scope");
  params.stream("  -h, --help   show help");
}

async function runGrok(params: GrokCliParams): Promise<void> {
  let parsed: ReturnType<typeof parseClaudeArgs>;
  try {
    parsed = parseClaudeArgs(params.args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${message}\n`);
    printGrokUsage({ stream: console.error, prog: params.prog });
    process.exit(1);
  }

  if (parsed["--help"]) {
    printGrokUsage({ stream: console.log, prog: params.prog });
    return;
  }

  if (parsed._.length) throw new Error("unexpected auth argument");
  await runGrokAuth(parsed);
}

async function runGrokAuth(parsed: ReturnType<typeof parseCodexArgs>): Promise<void> {
  p.intro(pc.bgGreen(pc.black(" pullfrog auth grok ")));

  const spin = p.spinner();
  setActiveSpin(spin);

  try {
    spin.start("authenticating with github");
    const token = getGhToken();
    spin.stop("github authenticated");

    spin.start("detecting repository");
    const selectedTarget = resolveTarget({ org: parsed["--org"], repo: parsed["--repo"] });
    const remote = { owner: selectedTarget.owner, repo: selectedTarget.repo ?? "" };
    spin.stop(`selected ${pc.cyan(remote.repo ? `${remote.owner}/${remote.repo}` : remote.owner)}`);

    spin.start("checking pullfrog app installation");
    const status =
      selectedTarget.repo && parsed["--repo"] === undefined
        ? await fetchStatus({ token, owner: remote.owner, repo: selectedTarget.repo })
        : {
            installed: true,
            isOrg: true,
            pullfrogSecrets: secretNamesSchema.parse(
              await configurationApi({ target: selectedTarget, path: "credentials", token })
            ).secrets,
          };
    if (!status.installed) {
      spin.stop(pc.red("pullfrog app not installed on this repo"));
      bail(
        `install pullfrog on ${pc.bold(`${remote.owner}/${remote.repo}`)} before configuring auth.\n` +
          `  ${pc.dim("run:")} ${pc.cyan(`npx pullfrog init`)}`
      );
    }
    spin.stop(`pullfrog app is installed on ${pc.cyan(`@${remote.owner}`)}`);

    // user-owned repos can only ever be "account" (Pullfrog has no per-repo
    // store for user accounts), so we never bother prompting. on org-owned
    // repos, prompt interactively — matches `init`'s behavior.
    // explicit scopes override the legacy no-flag selection above.
    const scope =
      parsed["--org"] !== undefined
        ? "account"
        : parsed["--repo"] !== undefined
          ? "repo"
          : status.isOrg
            ? await promptScope({ owner: remote.owner, repo: remote.repo })
            : "account";
    const access = secretNamesSchema.parse(
      await configurationApi({
        target: { owner: remote.owner, repo: scope === "repo" ? remote.repo : undefined },
        path: "credentials",
        token,
      })
    );
    if (!access.writable)
      bail(
        scope === "repo"
          ? "repo admin required to change secrets"
          : "org owner required to change secrets"
      );

    refuseWhenRepoCopiesShadow({ access, owner: remote.owner, name: GROK_AUTH_SECRET });

    if (access.secrets.includes(GROK_AUTH_SECRET)) {
      const overwrite = await p.select({
        message: `${pc.cyan(GROK_AUTH_SECRET)} is already configured — overwrite?`,
        options: [
          { value: true, label: "overwrite", hint: "replace with a freshly minted credential" },
          { value: false, label: "cancel" },
        ],
      });
      handleCancel(overwrite);
      if (!overwrite) {
        p.cancel("canceled.");
        return;
      }
    }

    spin.start("requesting a device code from xAI");
    const device = await startXaiDeviceAuth();
    spin.stop("device code ready");

    p.log.info(
      [
        `approve the sign-in in your browser, then come back here.`,
        ``,
        `${pc.dim("url: ")}${pc.cyan(device.verificationUrl)}`,
        `${pc.dim("code:")} ${pc.bold(pc.cyan(device.userCode))}`,
        ``,
        `this uses your Grok subscription — no xAI API key and no per-token billing.`,
      ].join("\n")
    );
    openInBrowser(device.verificationUrl);

    spin.start("waiting for approval in the browser");
    const minted = await pollXaiDeviceAuth(device);
    spin.stop("signed in to Grok");

    // eager refresh before saving, mirroring `auth codex`. xAI rotates the
    // refresh token on every use, so storing the just-minted chain would hand
    // Pullfrog a token the local process already spent. round-tripping once
    // here means the stored chain is the freshest one in existence.
    spin.start("rotating the credential before saving");
    const fresh = await refreshXaiAuthBody(minted);
    spin.stop("credential rotated");

    const target = describeSecretTarget({ owner: remote.owner, repo: remote.repo, scope });
    spin.start(`saving ${pc.cyan(GROK_AUTH_SECRET)} to ${target}`);
    const result = await setPullfrogSecret({
      token,
      owner: remote.owner,
      repo: remote.repo,
      name: GROK_AUTH_SECRET,
      value: stringifyXaiAuthBody(fresh),
      scope,
    });
    if (!result.saved) {
      spin.stop(pc.red("could not save secret"));
      p.log.warn(
        `${result.error}\n  ${pc.dim("set it manually at:")} ${PULLFROG_API_URL}/console/${remote.owner}`
      );
      process.exit(1);
    }
    spin.stop(`saved ${pc.cyan(GROK_AUTH_SECRET)} to ${target}`);
    setActiveSpin(null);
    p.outro("done.");
  } catch (error) {
    spin.stop(pc.red("failed"));
    setActiveSpin(null);
    const message = error instanceof Error ? error.message : String(error);
    p.log.error(message);
    process.exit(1);
  }
}
