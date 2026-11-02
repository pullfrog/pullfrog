import { spawn } from "node:child_process";
import { dirname } from "node:path";
import * as core from "@actions/core";
import arg from "arg";
import { main } from "../main.ts";
import { runOAuthWriteback } from "../utils/oauthWriteback.ts";
import { maskSecret, saveSecretState, setSecretOutput } from "../utils/secretCommands.ts";
import { removeAbandonedTempDirectory } from "../utils/setup.ts";
import { acquireInstallationToken, revokeInstallationToken } from "../utils/token.ts";

// GitHub Actions runs the action entry point with the node24 binary specified
// in action.yml, but doesn't add that binary's directory to PATH. Without this,
// spawned processes (pnpm, npm, etc.) resolve to the runner's default node (v20).
process.env.PATH = `${dirname(process.execPath)}:${process.env.PATH}`;

const STATE_TOKEN = "token";

/** `runs.using: node24`; the runtime reaches node 22+ APIs (`Promise.withResolvers`, `Promise.try`) */
const MIN_NODE_MAJOR = 24;

/**
 * a Volta/asdf/mise `npx` shim answers `--version`, so the bootstrap's PATH walk accepts it,
 * then runs the CLI on its own default node. on node 20 the run worked until teardown threw
 * on `Promise.withResolvers` with every installation token still live (#1565). so re-run
 * under the bootstrap's own node; an older bootstrap that does not pass it fails up front.
 */
async function rerunOnBootstrapNode(args: string[]): Promise<void> {
  const node = process.env.PULLFROG_NODE;
  const found = `the runner's npx launched Pullfrog on Node ${process.versions.node} (${process.execPath}), which is below Node ${MIN_NODE_MAJOR}`;
  // equal to ours means the bootstrap itself ran on it, and re-running would loop
  if (!node || node === process.execPath) {
    // the post step must never fail a finished run (#815)
    if (args.includes("--post")) core.warning(found);
    else
      core.setFailed(
        `${found}. bump the Pullfrog action ref, or make the runner's npx use Node ${MIN_NODE_MAJOR}.`
      );
    return;
  }
  core.info(`» ${found}; re-running under ${node}`);
  const child = spawn(node, process.argv.slice(1), { stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => child.kill(signal));
  }
  process.exitCode = await new Promise<number>((resolve) =>
    child.on("exit", (code) => resolve(code ?? 1))
  );
}

interface GhaCliParams {
  args: string[];
  prog: string;
  showHelp?: boolean;
}

async function runMain(): Promise<void> {
  try {
    const result = await main();
    if (!result.success) {
      throw new Error(result.error || "agent execution failed");
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "unknown error occurred";
    core.setFailed(`action failed: ${errorMessage}`);
  }
}

async function tokenMain(): Promise<void> {
  const reposInput = core.getInput("repos");
  const additionalRepos = reposInput
    ? reposInput
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean)
    : [];

  const token = await acquireInstallationToken({ repos: additionalRepos });

  maskSecret(token);
  saveSecretState(STATE_TOKEN, token);
  setSecretOutput("token", token);

  const scope = additionalRepos.length
    ? `current repo + ${additionalRepos.join(", ")}`
    : "current repo only";
  core.info(`» installation token acquired (${scope})`);
}

async function tokenPost(): Promise<void> {
  const token = core.getState(STATE_TOKEN);
  if (!token) {
    core.debug("no token found in state, skipping revocation");
    return;
  }
  await revokeInstallationToken(token);
  core.info("» installation token revoked");
}

function printGhaUsage(params: { stream: typeof console.log; prog: string }): void {
  params.stream(`usage: ${params.prog} gha [subcommand]\n`);
  params.stream("run the github action runtime flow.");
  params.stream("");
  params.stream("subcommands:");
  params.stream("  token        acquire a github app installation token");
  params.stream("");
  params.stream("options:");
  params.stream("  -h, --help   show help");
  params.stream("  --post       run the post-step cleanup (post-step usage only)");
}

function printGhaTokenUsage(params: { stream: typeof console.log; prog: string }): void {
  params.stream(`usage: ${params.prog} gha token [--post]\n`);
  params.stream("acquire a github app installation token, or revoke it in the post step.");
  params.stream("");
  params.stream("options:");
  params.stream("  -h, --help   show help");
  params.stream("  --post       revoke the previously-acquired token (post-step usage only)");
}

function parseGhaArgs(args: string[]) {
  return arg(
    {
      "--help": Boolean,
      "--post": Boolean,
      "-h": "--help",
    },
    {
      argv: args,
      stopAtPositional: true,
    }
  );
}

function parseGhaTokenArgs(args: string[]) {
  return arg(
    {
      "--help": Boolean,
      "--post": Boolean,
      "-h": "--help",
    },
    {
      argv: args,
    }
  );
}

export async function runCli(params: GhaCliParams): Promise<void> {
  if (params.showHelp) {
    printGhaUsage({ stream: console.log, prog: params.prog });
    return;
  }

  let parsed: ReturnType<typeof parseGhaArgs>;
  try {
    parsed = parseGhaArgs(params.args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${message}\n`);
    printGhaUsage({ stream: console.error, prog: params.prog });
    process.exit(1);
  }

  if (parsed["--help"]) {
    printGhaUsage({ stream: console.log, prog: params.prog });
    return;
  }

  const positional = parsed._;
  const subcommand = positional[0];

  if (!subcommand) {
    await run(parsed["--post"] ? ["gha", "--post"] : ["gha"]);
    return;
  }

  if (subcommand !== "token") {
    console.error(`unknown gha subcommand: ${subcommand}\n`);
    printGhaUsage({ stream: console.error, prog: params.prog });
    process.exit(1);
  }

  // gha token [--post]
  let tokenParsed: ReturnType<typeof parseGhaTokenArgs>;
  try {
    tokenParsed = parseGhaTokenArgs(positional.slice(1));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${message}\n`);
    printGhaTokenUsage({ stream: console.error, prog: params.prog });
    process.exit(1);
  }

  if (tokenParsed["--help"]) {
    printGhaTokenUsage({ stream: console.log, prog: params.prog });
    return;
  }

  if (tokenParsed._.length > 0) {
    console.error(`unexpected positional arguments for gha token: ${tokenParsed._.join(" ")}\n`);
    printGhaTokenUsage({ stream: console.error, prog: params.prog });
    process.exit(1);
  }

  const normalizedArgs = ["gha", "token"];
  if (tokenParsed["--post"]) {
    normalizedArgs.push("--post");
  }
  await run(normalizedArgs);
}

export async function run(args: string[]) {
  if (Number(process.versions.node.split(".")[0]) < MIN_NODE_MAJOR) {
    await rerunOnBootstrapNode(args);
    return;
  }
  // the cleanup step runs after the agent has already exited, so it must never
  // reach `setFailed` below — a red X there flips a finished, successful run to
  // `failure` with nothing actionable in the comment. that is #815's shape.
  if (args.includes("--post") && !args.includes("token")) {
    await runOAuthWriteback().catch((error) => core.warning(`oauth post-hook: ${error}`));
    removeAbandonedTempDirectory();
    return;
  }

  try {
    if (args.includes("token")) {
      if (args.includes("--post")) {
        await tokenPost();
      } else {
        await tokenMain();
      }
    } else {
      await runMain();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(message);
  }
}
