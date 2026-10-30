// `pullfrog auth <provider>` — manage credentials for a configured repo
// without going through the full `init` flow. currently supports:
//
//   pullfrog auth codex    mint a Codex subscription credential and save it
//                          as the `CODEX_AUTH_JSON` Pullfrog secret
//   pullfrog auth claude   mint a Claude Code subscription OAuth token and save
//                          it as the `CLAUDE_CODE_OAUTH_TOKEN` Pullfrog secret
//   pullfrog auth grok     mint a Grok (SuperGrok / X Premium) subscription
//                          credential and save it as `GROK_AUTH_JSON`
//
// the `codex` subcommand runs `codex login` against an isolated `CODEX_HOME`
// (so the user's existing ~/.codex/auth.json is never touched), validates the
// resulting auth.json, and posts it to the Pullfrog secrets API. used both for
// first-time setup of a Codex subscription on a repo and for rotating a stale
// credential. the login is Codex's browser redirect by default and its device
// code under `--device-auth`, which is the one that works when the browser is
// on another machine. see wiki/codex-auth.md.
//
// the `claude` subcommand runs the sign-in `claude setup-token` runs and mints
// the same long-lived OAuth token, so Claude Code need not be installed; with
// `--paste-token` (or no browser on this machine) the user pastes one that
// `claude setup-token` printed instead. either way it goes to the same secrets
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
//
// everything around the sign-in — scope, authority, add-or-replace, the save
// and what it reports — is one flow shared by all three (`connect`); a provider
// is its `mint` step and the copy that names it.

import { spawn } from "node:child_process";
import * as p from "@clack/prompts";
import arg from "arg";
import pc from "picocolors";
import { signInToClaude } from "../utils/claudeOAuth.ts";
import { mintCodexAuth, refreshCodexAuth } from "../utils/codexAuth.ts";
import type { SubscriptionName } from "../utils/subscriptionCredentials.ts";
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
  promptScope,
  type SecretScope,
  setActiveSpin,
} from "./_shared.ts";
import {
  chooseSubscription,
  manageSubscriptions,
  type SubscriptionChoice,
  saveSubscription,
} from "./_subscriptions.ts";
import { secretNamesSchema } from "./secret.ts";

const BIN = process.env.PULLFROG_BIN_NAME || "pullfrog";

/** prefix on `claude setup-token` OAuth tokens (`sk-ant-oat01-…`). a
 * warn-on-mismatch shape check only; whether the token actually WORKS is
 * settled by the secrets API, which refuses a token Anthropic rejects. */
const CLAUDE_OAUTH_TOKEN_PREFIX = "sk-ant-oat";

/** strip CSI ANSI escapes (color, cursor) from a string so callers can re-style
 * the visible text without inheriting the source's formatting. covers what
 * Codex emits during login (mostly `\x1b[<digits>m` color codes).
 */
function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control chars by design
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

/** best-effort cross-platform "open URL in default browser". swallows
 * spawn errors and non-zero exits — the user can always copy-paste the URL
 * already printed. on Linux, falls back to `wslview` when `xdg-open`
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
    // not `cmd /c start`: Node quotes no URL without a space, so cmd splits it
    // at every `&`. rundll32 hands it to the default browser verbatim.
    cmd = "rundll32.exe";
    args = ["url.dll,FileProtocolHandler", url];
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

type Spinner = ReturnType<typeof p.spinner>;

const authArgs = { ...scopeArgs, "--device-auth": Boolean, "--paste-token": Boolean };
type AuthArgs = arg.Result<typeof authArgs>;

interface MintContext {
  args: AuthArgs;
  spin: Spinner;
}

interface Provider {
  id: "codex" | "claude" | "grok";
  secret: SubscriptionName;
  /** what the subcommand does, under its `usage:` line. */
  summary: string;
  /** the option only this provider takes, and its usage line. */
  option: { flag: "--device-auth" | "--paste-token"; usage: string } | null;
  /** how to come back as a different account, shown when the sign-in landed
   * on one that was already connected. */
  switchAccount: string;
  /** the credential to save, or null when the user backed out. */
  mint: (ctx: MintContext) => Promise<string | null>;
}

const providers: Provider[] = [
  {
    id: "codex",
    secret: CODEX_AUTH_SECRET,
    summary: "mint a Codex subscription credential and save it as CODEX_AUTH_JSON.",
    option: {
      flag: "--device-auth",
      usage: "  --device-auth   sign in with a one-time code, for a browser on another machine",
    },
    switchAccount: [
      "to add a different ChatGPT account, sign out of ChatGPT in that browser or open",
      "the sign-in link in a private window, then run this command again.",
    ].join("\n"),
    mint: mintCodex,
  },
  {
    id: "claude",
    secret: CLAUDE_OAUTH_SECRET,
    summary: "mint a Claude subscription OAuth token and save it as CLAUDE_CODE_OAUTH_TOKEN.",
    option: {
      flag: "--paste-token",
      usage:
        "  --paste-token   paste a token from claude setup-token, for a browser on another machine",
    },
    switchAccount: [
      `to add a different Claude account, run ${pc.cyan("claude setup-token")} signed in to it,`,
      "then run this command again and paste that token.",
    ].join("\n"),
    mint: mintClaude,
  },
  {
    id: "grok",
    secret: GROK_AUTH_SECRET,
    summary: "mint a Grok subscription credential and save it as GROK_AUTH_JSON.",
    option: null,
    switchAccount: [
      "to add a different Grok account, sign out of Grok in that browser or open the",
      "sign-in link in a private window, then run this command again.",
    ].join("\n"),
    mint: mintGrok,
  },
];

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
  params.stream("  codex    mint a Codex / ChatGPT subscription credential");
  params.stream("  claude   mint a Claude subscription OAuth token");
  params.stream("  grok     mint a Grok (SuperGrok / X Premium) subscription credential");
  params.stream("  list     list subscriptions and their IDs");
  params.stream("  remove   remove a subscription by binding ID");
  params.stream("  share | unshare   grant or revoke personal subscription access (--from OWNER)");
  params.stream("");
  params.stream("options:");
  params.stream("  --org OWNER | --repo OWNER/REPO   select the credential scope");
  params.stream("  -h, --help   show help");
}

interface ProviderCliParams {
  provider: Provider;
  args: string[];
  prog: string;
}

function printProviderUsage(params: ProviderCliParams & { stream: typeof console.log }): void {
  params.stream(`usage: ${params.prog} auth ${params.provider.id} [options]\n`);
  params.stream(params.provider.summary);
  params.stream("");
  params.stream("options:");
  params.stream("  --org OWNER | --repo OWNER/REPO   select the credential scope");
  if (params.provider.option) params.stream(params.provider.option.usage);
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
  if (["list", "remove", "share", "unshare"].includes(subcommand)) {
    await manageSubscriptions({ command: subcommand, args: rest });
    return;
  }

  const provider = providers.find((candidate) => candidate.id === subcommand);
  if (provider) {
    await runProvider({ provider, args: rest, prog: params.prog });
    return;
  }

  console.error(`unknown auth provider: ${pc.bold(subcommand)}\n`);
  printAuthUsage({ stream: console.error, prog: params.prog });
  process.exit(1);
}

function parseProviderArgs(params: ProviderCliParams): AuthArgs {
  try {
    const parsed = arg(authArgs, { argv: params.args });
    const foreign = providers
      .flatMap((other) => (other.option ? [other.option.flag] : []))
      .find((flag) => parsed[flag] && flag !== params.provider.option?.flag);
    if (foreign) throw new Error(`unknown or unexpected option: ${foreign}`);
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${message}\n`);
    printProviderUsage({ ...params, stream: console.error });
    process.exit(1);
  }
}

async function runProvider(params: ProviderCliParams): Promise<void> {
  const args = parseProviderArgs(params);
  if (args["--help"]) {
    printProviderUsage({ ...params, stream: console.log });
    return;
  }
  if (args._.length) throw new Error("unexpected auth argument");

  p.intro(pc.bgGreen(pc.black(` pullfrog auth ${params.provider.id} `)));
  const spin = p.spinner();
  setActiveSpin(spin);
  try {
    await connect({ provider: params.provider, args, spin });
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

interface ConnectContext extends MintContext {
  provider: Provider;
}

/** where a credential is saved. `repo` is "" under `--org`, which is always account scope. */
interface Destination {
  owner: string;
  repo: string;
  scope: SecretScope;
}

async function resolveDestination(ctx: ConnectContext & { token: string }): Promise<Destination> {
  ctx.spin.start("detecting repository");
  const selectedTarget = resolveTarget({ org: ctx.args["--org"], repo: ctx.args["--repo"] });
  const remote = { owner: selectedTarget.owner, repo: selectedTarget.repo ?? "" };
  ctx.spin.stop(
    `selected ${pc.cyan(remote.repo ? `${remote.owner}/${remote.repo}` : remote.owner)}`
  );

  ctx.spin.start("checking pullfrog app installation");
  const status =
    selectedTarget.repo && ctx.args["--repo"] === undefined
      ? await fetchStatus({ token: ctx.token, owner: remote.owner, repo: selectedTarget.repo })
      : {
          installed: true,
          isOrg: true,
          pullfrogSecrets: secretNamesSchema.parse(
            await configurationApi({
              target: selectedTarget,
              path: "credentials",
              token: ctx.token,
            })
          ).secrets,
        };
  if (!status.installed) {
    ctx.spin.stop(pc.red("pullfrog app not installed on this repo"));
    bail(
      `install pullfrog on ${pc.bold(`${remote.owner}/${remote.repo}`)} before configuring auth.\n` +
        `  ${pc.dim("run:")} ${pc.cyan(`npx pullfrog init`)}`
    );
  }
  ctx.spin.stop(`pullfrog app is installed on ${pc.cyan(`@${remote.owner}`)}`);

  // user-owned repos can only ever be "account" (Pullfrog has no per-repo
  // store for user accounts), so we never bother prompting. on org-owned
  // repos, prompt interactively — matches `init`'s behavior.
  // explicit scopes override the legacy no-flag selection above.
  const scope =
    ctx.args["--org"] !== undefined
      ? "account"
      : ctx.args["--repo"] !== undefined
        ? "repo"
        : status.isOrg
          ? await promptScope({ owner: remote.owner, repo: remote.repo })
          : "account";
  const access = secretNamesSchema.parse(
    await configurationApi({
      target: { owner: remote.owner, repo: scope === "repo" ? remote.repo : undefined },
      path: "credentials",
      token: ctx.token,
    })
  );
  if (!access.writable)
    bail(
      scope === "repo"
        ? "repo admin required to change secrets"
        : "org owner required to change secrets"
    );
  return { owner: remote.owner, repo: remote.repo, scope };
}

type SavedSubscription = Awaited<ReturnType<typeof saveSubscription>>;

/** the binding the save landed on says what happened; the choice only says
 * what was asked for, and the account that signed in can disagree with it. */
function describeOutcome(params: {
  choice: SubscriptionChoice;
  result: SavedSubscription;
  where: string;
}): string {
  const label = pc.cyan(params.result.label);
  const replaced = params.choice.replace;
  if (replaced && replaced.id !== params.result.id)
    return `replaced ${pc.cyan(replaced.label)} with ${label} on ${params.where}`;
  return `${params.result.reconnected ? "reconnected" : "added"} ${label} to ${params.where}`;
}

async function connect(ctx: ConnectContext): Promise<void> {
  ctx.spin.start("authenticating with github");
  const token = getGhToken();
  ctx.spin.stop("github authenticated");

  const destination = await resolveDestination({ ...ctx, token });
  const target = {
    owner: destination.owner,
    repo: destination.scope === "repo" ? destination.repo : undefined,
  };
  const choice = await chooseSubscription({ target, token, name: ctx.provider.secret });
  if (!choice) {
    p.cancel("canceled.");
    return;
  }

  const value = await ctx.provider.mint(ctx);
  if (value === null) {
    p.cancel("canceled.");
    return;
  }

  const where = describeSecretTarget(destination);
  ctx.spin.start(`saving ${pc.cyan(ctx.provider.secret)} to ${where}`);
  const result = await saveSubscription({
    token,
    target,
    name: ctx.provider.secret,
    value,
    replaceId: choice.replace?.id,
  });
  ctx.spin.stop(describeOutcome({ choice, result, where }));
  setActiveSpin(null);

  // "add another" that landed on a connection already here added nothing.
  if (!choice.replace && choice.current.some((row) => row.id === result.id)) {
    p.log.warn(
      [
        `${pc.cyan(result.label)} was already connected here, so no subscription was added.`,
        ctx.provider.switchAccount,
      ].join("\n")
    );
    p.outro("no subscription added.");
    return;
  }
  p.outro("done.");
}

/** the Codex and Claude browser sign-ins redirect to localhost on THIS machine,
 * so they need a browser here: not over SSH, and not on a Linux box with no
 * display (WSL hands the URL to Windows, which reaches back over localhost). */
function lacksLocalBrowser(): boolean {
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return true;
  if (process.platform !== "linux" || process.env.WSL_DISTRO_NAME) return false;
  return !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
}

function codexLoginCopy(args: AuthArgs) {
  if (!(args["--device-auth"] ?? lacksLocalBrowser()))
    return {
      deviceAuth: false,
      command: "codex login",
      intro: [
        `signing in via the Codex browser login. approve the sign-in in the browser`,
        `window Codex opens, then come back here.`,
        ``,
        `${pc.dim("note:")} if the browser is on another machine, cancel and run`,
        `${pc.cyan(`${BIN} auth codex --device-auth`)} instead.`,
      ],
      timedOut: "browser sign-in timed out — retry?",
      unfinished: "the browser sign-in did not finish — retry?",
      retryHint: "or re-run with --device-auth if the browser is on another machine",
    };
  const rerun = args["--device-auth"] ? "auth codex --device-auth" : "auth codex";
  return {
    deviceAuth: true,
    command: "codex login --device-auth",
    intro: [
      `signing in via Codex device authorization. open the URL Codex prints`,
      `below, enter the one-time code, and approve in your browser.`,
      ``,
      `${pc.dim("note:")} ChatGPT accepts the code only once device-code sign-in is on: in`,
      `${pc.cyan("https://chatgpt.com/#settings/Security")} for a personal account, or turned on by a`,
      `workspace owner at ${pc.cyan("https://chatgpt.com/admin/permissions")}. if the page refuses`,
      `the code, turn it on, then re-run ${pc.cyan(`${BIN} ${rerun}`)}.`,
    ],
    timedOut: "device authorization timed out — retry?",
    unfinished: "no auth.json was written — retry?",
    retryHint: "after enabling device-code auth",
  };
}

async function mintCodex(ctx: MintContext): Promise<string> {
  const copy = codexLoginCopy(ctx.args);
  p.log.info(copy.intro.join("\n"));

  // tracks the most recent exit so the retry prompt can tell the user
  // *why* no auth.json was written (timeout vs. early-exit).
  let lastTimedOut = false;
  const auth = await mintCodexAuth({
    deviceAuth: copy.deviceAuth,
    childStdio: "pipe",
    // pass-through only: Codex's copy changes without notice, so nothing here
    // may branch on, scrape or rewrite what it prints. auth.json is the result.
    onChildLine: (line) => {
      // dim Codex's own colored output (URL/code in cyan, boilerplate in
      // gray) so the user reads it as sub-process noise, not Pullfrog's
      // own prompts. the rail char matches @clack/prompts so the column
      // reads as one continuous flow.
      process.stdout.write(`${pc.gray(p.S_BAR)}  ${pc.dim(stripAnsi(line))}\n`);
    },
    onProgress: (event) => {
      if (event.kind === "start") {
        lastTimedOut = false;
        if (event.attempt > 1) p.log.info(`retry attempt ${event.attempt}`);
        // shell-prompt style header so the user sees what Pullfrog is
        // about to spawn, with the rail to keep the visual column.
        process.stdout.write(`${pc.gray(p.S_BAR)}\n`);
        process.stdout.write(`${pc.gray(p.S_BAR)}  $ ${copy.command}\n`);
      }
      if (event.kind === "exit") {
        if (event.timedOut) lastTimedOut = true;
        // trailing blank rail so the next clack prompt isn't crammed
        // against the last codex output line.
        process.stdout.write(`${pc.gray(p.S_BAR)}\n`);
      }
    },
    shouldRetry: async () => {
      const retry = await p.select({
        message: lastTimedOut ? copy.timedOut : copy.unfinished,
        options: [
          { value: true, label: "retry", hint: copy.retryHint },
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
  ctx.spin.start("refreshing token");
  try {
    const refreshed = await refreshCodexAuth(auth);
    ctx.spin.stop("refreshed");
    return refreshed.json;
  } catch (err) {
    ctx.spin.stop(pc.yellow("refresh failed — saving minted token as-is"));
    p.log.warn(err instanceof Error ? err.message : String(err));
    return auth.json;
  }
}

/** the sign-in redirects to localhost here, so a browser elsewhere pastes a
 * token minted there by `claude setup-token` instead. */
async function mintClaude(ctx: MintContext): Promise<string | null> {
  if (ctx.args["--paste-token"] ?? lacksLocalBrowser()) return pasteClaudeToken();
  const minted = await signInToClaude({
    onUrl: (url) => {
      p.log.info(
        [
          `approve the sign-in in your browser, then come back here.`,
          ``,
          `${pc.dim("url:")} ${pc.cyan(url)}`,
          ``,
          `${pc.dim("note:")} if the browser is on another machine, cancel and run`,
          `${pc.cyan(`${BIN} auth claude --paste-token`)} instead.`,
        ].join("\n")
      );
      openInBrowser(url);
      ctx.spin.start("waiting for approval in the browser");
    },
  });
  ctx.spin.stop(`signed in to Claude${minted.email ? ` as ${pc.cyan(minted.email)}` : ""}`);
  return minted.token;
}

async function pasteClaudeToken(): Promise<string | null> {
  p.log.info(
    [
      `mint a long-lived Claude Code OAuth token, then paste it below.`,
      ``,
      `${pc.dim("run:")} ${pc.cyan("claude setup-token")}`,
      `it opens your browser, works with Claude subscriptions, and prints a`,
      `token starting with ${pc.cyan("sk-ant-oat…")}. copy that token.`,
    ].join("\n")
  );

  const oauthToken = await p.password({
    message: `paste your Claude Code OAuth token ${pc.dim("(Enter to cancel)")}`,
    mask: "*",
  });
  handleCancel(oauthToken);
  if (!oauthToken) return null;

  // trim defensively — a trailing newline from a terminal copy breaks GitHub
  // Actions' line-based log masking downstream. the API trims too, but doing
  // it here keeps the prefix sanity check honest.
  const value = oauthToken.trim();
  if (!value.startsWith(CLAUDE_OAUTH_TOKEN_PREFIX)) {
    p.log.warn(
      `that doesn't look like a ${pc.cyan("claude setup-token")} token (expected ${pc.cyan(`${CLAUDE_OAUTH_TOKEN_PREFIX}…`)}). saving it anyway.`
    );
  }
  return value;
}

async function mintGrok(ctx: MintContext): Promise<string> {
  ctx.spin.start("requesting a device code from xAI");
  const device = await startXaiDeviceAuth();
  ctx.spin.stop("device code ready");

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

  ctx.spin.start("waiting for approval in the browser");
  const minted = await pollXaiDeviceAuth(device);
  ctx.spin.stop("signed in to Grok");

  // eager refresh before saving, mirroring `auth codex`. xAI rotates the
  // refresh token on every use, so storing the just-minted chain would hand
  // Pullfrog a token the local process already spent. round-tripping once
  // here means the stored chain is the freshest one in existence.
  ctx.spin.start("rotating the credential before saving");
  const fresh = await refreshXaiAuthBody(minted);
  ctx.spin.stop("credential rotated");
  return stringifyXaiAuthBody(fresh);
}
