// `pullfrog watch <owner>/<repo> --pr <N>` — subscribe to a PR's activity and
// emit one structured JSON line per new review / comment / inline review thread
// / PR state change / check-suite completion, WITHOUT polling GitHub. the server
// fans these out from the webhook pipeline it already receives, so latency is
// sub-second and there is no per-event GitHub API spend.
//
// transport is cursor-based long-poll: each request holds open on the server
// until new events land (or a short window elapses), then the client
// immediately re-requests with the returned cursor.
//
// two shapes, because agent harnesses differ. the default is a daemon whose
// stdout Claude Code's Monitor can consume. `--once` blocks for a single server
// window and exits, which is the only shape Codex and opencode can consume —
// neither has an affordance that reads a stream, but every harness can call a
// command that returns. see `pullfrog mcp` for the same primitive as a tool.

import arg from "arg";
import pc from "picocolors";
import * as yes from "yes";
import {
  isTerminal,
  type PrTarget,
  pollPrEvents,
  resolveCursor,
  SERVER_POLL_WINDOW_MS,
  type StreamEvent,
  waitForPrEvents,
  writeCursor,
} from "./_prEvents.ts";
import { bail, getGhToken, parseGitRemote } from "./_shared.ts";

function parseWatchArgs(args: string[]) {
  return arg(
    {
      "--pr": Number,
      "--pretty": Boolean,
      "--since": String,
      "--once": Boolean,
      "--help": Boolean,
      "-h": "--help",
      "-p": "--pretty",
    },
    { argv: args }
  );
}

function printUsage(prog: string, stream: typeof console.log): void {
  stream(`usage: ${prog} watch [<owner>/<repo>] --pr <number> [options]\n`);
  stream("subscribe to a PR's activity and print one JSON line per event.\n");
  stream("arguments:");
  stream("  <owner>/<repo>   target repo (defaults to the current git remote)");
  stream("");
  stream("options:");
  stream("  --pr <number>    pull request number to watch (required)");
  stream("  --once           wait for one batch of events, print it, and exit");
  stream("  --since <cursor> resume from a cursor instead of the saved position");
  stream("  -p, --pretty     human-readable output instead of JSON lines");
  stream("  -h, --help       show help");
}

function resolveRepo(positional: string | undefined): { owner: string; repo: string } {
  if (!positional) return parseGitRemote();
  const match = positional.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) bail(`invalid repo "${positional}" — expected <owner>/<repo>`);
  return { owner: match[1], repo: match[2] };
}

function formatPretty(event: StreamEvent): string {
  const time = new Date(event.createdAt).toLocaleTimeString();
  const action = typeof event.data.action === "string" ? event.data.action : "";
  const actor =
    typeof event.data.author === "string"
      ? event.data.author
      : typeof event.data.reviewer === "string"
        ? event.data.reviewer
        : "";
  const detail = [action, actor && pc.dim(`by ${actor}`)].filter(Boolean).join(" ");
  return `${pc.dim(time)} ${pc.cyan(event.kind)} ${pc.bold(`#${event.pr}`)} ${detail}`.trimEnd();
}

function emit(events: StreamEvent[], pretty: boolean): void {
  for (const event of events) {
    process.stdout.write(pretty ? `${formatPretty(event)}\n` : `${JSON.stringify(event)}\n`);
  }
}

export async function runCli(input: { args: string[]; prog: string; showHelp: boolean }) {
  let parsed: ReturnType<typeof parseWatchArgs>;
  try {
    parsed = parseWatchArgs(input.args);
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n`);
    printUsage(input.prog, console.error);
    process.exit(1);
  }

  if (input.showHelp || parsed["--help"]) {
    printUsage(input.prog, console.log);
    process.exit(0);
  }

  const target = resolveRepo(parsed._[0]);
  const pr = parsed["--pr"];
  if (pr === undefined || !Number.isInteger(pr) || pr <= 0) {
    bail("--pr <number> is required");
  }

  const token = getGhToken();
  const pretty = parsed["--pretty"] === true;
  const watched = { ...target, pr };

  let cursor: string;
  try {
    cursor = await resolveCursor({ ...watched, token, since: parsed["--since"] });

    // `--once`: one bounded wait, then exit — the shape a harness can call as
    // a tool. the daemon below is the shape only a stream reader can consume.
    if (parsed["--once"] === true) {
      const result = await waitForPrEvents({
        ...watched,
        token,
        cursor,
        maxWaitMs: SERVER_POLL_WINDOW_MS,
      });
      emit(result.events, pretty);
      return;
    }
  } catch (error) {
    if (isTerminal(error)) bail(error.message);
    throw error;
  }

  // narrowed past `pollPrEvents`'s optional `signal`, which a query cannot key
  const poll = yes.query({
    run: (input: PrTarget & { token: string; cursor: string }) => pollPrEvents(input),
    name: "pr-events poll",
    retry: (error, attempt) =>
      isTerminal(error) ? -1 : yes.delay([1000, 2000, 5000, 10_000, 15_000], attempt),
  });

  // daemon loop — the loop is the whole command. the query smooths transient
  // network blips within a cycle. a longer outage that exhausts the op's
  // retries must NOT kill the watcher, so we back off and keep going rather
  // than crash; only a terminal auth/access answer exits.
  for (;;) {
    try {
      const result = await poll({ ...watched, token, cursor });
      cursor = result.cursor;
      writeCursor(watched, cursor);
      emit(result.events, pretty);
    } catch (error) {
      if (isTerminal(error)) bail(error.message);
      const message = error instanceof Error ? error.message : String(error);
      console.error(pc.dim(`watch: ${message} — retrying in 30s`));
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
  }
}
