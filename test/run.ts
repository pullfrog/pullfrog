import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { killTrackedChildren, setSignalHandler } from "../utils/subprocess.ts";
import {
  type AgentResult,
  agents,
  getPrefix,
  isAgentTimeout,
  printResults,
  printSingleValidation,
  runAgentStreaming,
  type TestRunnerOptions,
  type TestTag,
  type ValidationResult,
  validateResult,
} from "./utils.ts";

/**
 * unified test runner for all agent tests.
 *
 * invoke from the repo root:
 *   pnpm runtest [filters…]            # host, in-process — fast iteration (default)
 *   pnpm runtest:docker [filters…]     # local docker container that mocks GHA
 *   pnpm docker test/run.ts [filters…] # explicit container form (equivalent to `pnpm runtest:docker`)
 *
 * filters can be test names, tags, or agent names:
 *   pnpm runtest                    # run all tests (excludes adhoc-tagged tests)
 *   pnpm runtest smoke              # run tests named "smoke" or tagged "smoke"
 *   pnpm runtest opencode           # run all tests for opencode only
 *   pnpm runtest security           # run all tests tagged "security"
 *   pnpm runtest agnostic           # run all agnostic-tagged tests (with opencode)
 *   pnpm runtest adhoc              # run all adhoc-tagged tests
 *   pnpm runtest smoke opencode     # run smoke tests for opencode only
 *
 * special tags:
 *   - "agnostic": runs with opencode only, excluded when filtering by agent
 *   - "adhoc": excluded from default runs, must be explicitly requested
 *
 * see wiki/docker.md for when host vs container matters.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
export const actionDir = join(__dirname, "..");

config({ path: join(actionDir, ".env") });
config({ path: join(actionDir, "..", ".env") });

const mcpPortBase = 49000;
let nextMcpPort = mcpPortBase;

function allocateMcpPort(): number {
  const port = nextMcpPort;
  nextMcpPort += 1;
  return port;
}

type TestInfo = {
  name: string;
  config: TestRunnerOptions;
};

type CancelState = {
  canceled: boolean;
  signal: NodeJS.Signals | null;
};

type TestModule = {
  test?: TestRunnerOptions;
  tests?: Record<string, TestRunnerOptions>;
};

// load all tests from all directories
async function loadAllTests(): Promise<TestInfo[]> {
  const testInfos: TestInfo[] = [];
  const dirs = ["crossagent", "agnostic", "adhoc"];

  for (const dir of dirs) {
    const dirPath = join(__dirname, dir);
    if (!existsSync(dirPath)) continue;

    const files = readdirSync(dirPath).filter((f) => f.endsWith(".ts"));
    for (const file of files) {
      const filePath = join(dirPath, file);
      const module = (await import(filePath)) as TestModule;

      if (module.test) {
        testInfos.push({ name: module.test.name, config: module.test });
      } else if (module.tests) {
        const entries = Object.entries(module.tests);
        for (const entry of entries) {
          testInfos.push({ name: entry[0], config: entry[1] });
        }
      }
    }
  }

  return testInfos;
}

// check if test has a specific tag
function hasTag(test: TestInfo, tag: TestTag): boolean {
  return test.config.tags?.includes(tag) ?? false;
}

type ParsedArgs = {
  filters: string[]; // test names or tags
  agentFilters: string[];
};

function parseArgs(args: string[], allTests: TestInfo[]): ParsedArgs {
  const testNames = new Set(allTests.map((t) => t.name));
  const allTags = new Set(allTests.flatMap((t) => t.config.tags ?? []));

  const filters: string[] = [];
  const agentFilters: string[] = [];

  for (const arg of args) {
    if (agents.includes(arg as (typeof agents)[number])) {
      agentFilters.push(arg);
    } else if (testNames.has(arg) || allTags.has(arg as TestTag)) {
      filters.push(arg);
    } else {
      console.error(`unknown argument: ${arg}`);
      console.error(`available tests: ${[...testNames].join(", ")}`);
      console.error(`available tags: ${[...allTags].join(", ")}`);
      console.error(`available agents: ${agents.join(", ")}`);
      process.exit(1);
    }
  }

  return { filters, agentFilters };
}

// filter tests based on filters (names or tags)
function filterTests(allTests: TestInfo[], filters: string[]): TestInfo[] {
  if (filters.length === 0) {
    // default: exclude adhoc tests
    return allTests.filter((t) => !hasTag(t, "adhoc"));
  }

  // match tests by name or tag
  return allTests.filter((t) => {
    for (const filter of filters) {
      if (t.name === filter || hasTag(t, filter as TestTag)) {
        return true;
      }
    }
    return false;
  });
}

type RunContext = {
  testInfo: TestInfo;
  agent: string;
  cancelState: CancelState;
  results: Map<string, ValidationResult>;
};

function getRunKey(test: string, agent: string): string {
  return `${test}::${agent}`;
}

type CanceledValidationContext = {
  testInfo: TestInfo;
  agent: string;
  signal: NodeJS.Signals;
};

function buildCanceledValidation(ctx: CanceledValidationContext): ValidationResult {
  return {
    test: ctx.testInfo.name,
    agent: ctx.agent,
    passed: false,
    canceled: true,
    checks: [{ name: "canceled", passed: false }],
    output: `canceled by ${ctx.signal}`,
  };
}

const MAX_RETRIES = 2;
const RATE_LIMIT_BACKOFF_MS = 60_000; // 1 minute for rate limits
const FLAKY_RETRY_BACKOFF_MS = 5_000; // 5 seconds for transient failures

type RetryDecision = { retry: false } | { retry: true; reason: string; backoffMs: number };

/**
 * determine if a failed test run should be retried.
 *
 * retryable (transient infrastructure failures):
 *   - rate limit errors from API providers
 *   - agent crashed/errored but no security-relevant checks failed
 *     (e.g., agent didn't call set_output due to MCP connection drop)
 *   - set_output not called — all output-dependent checks cascade fail
 *
 * NOT retryable (genuine test failures):
 *   - security checks failed (sandbox breach, token leak, etc.)
 *   - agent successfully ran and called set_output but produced wrong results
 */
// detect rate limit / quota errors across all providers. `\b429\b` uses word
// boundaries because a bare "429" substring false-matches UUIDs (e.g. MCP
// session ids like `...-4429-...`) and microsecond timestamps in agent stdout,
// which used to send transient failures down the 60s rate-limit retry path
// and push retries past the per-step CI timeout.
const RATE_LIMIT_PATTERNS: RegExp[] = [
  /rate limit reached/i, // anthropic
  /resource has been exhausted/i, // google/gemini
  /quota exceeded/i, // google/gemini
  /\b429\b/, // generic HTTP 429
  /too many requests/i, // generic
];

function isRateLimited(output: string): boolean {
  return RATE_LIMIT_PATTERNS.some((p) => p.test(output));
}

function shouldRetry(params: {
  result: AgentResult;
  validation: ValidationResult;
  retryOnTimeout: boolean;
}): RetryDecision {
  const result = params.result;
  const validation = params.validation;

  if (!params.retryOnTimeout && isAgentTimeout(result)) {
    return { retry: false };
  }

  // rate limit / quota exhaustion: agent never got to run properly
  if (!result.success && isRateLimited(result.output)) {
    return { retry: true, reason: "rate limited", backoffMs: RATE_LIMIT_BACKOFF_MS };
  }

  // already passed — no retry needed
  if (validation.passed) {
    return { retry: false };
  }

  // if the test has a set_output check and it failed, other check failures are
  // cascade failures — validators gate their checks on `setOutputCalled && ...`
  // so they always fail when there's no structured output.
  // security-relevant checks (like no_leak_filtered, native_blocked) are designed
  // to PASS when set_output wasn't called (defensive coding). so cascade failures
  // are never genuine security findings — they're transient instruction-following
  // issues (MCP connection drop, agent confusion, etc.).
  const setOutputCheck = validation.checks.find((c) => c.name === "set_output");
  if (setOutputCheck && !setOutputCheck.passed) {
    // if the output contains rate limit indicators, use the longer backoff
    // (the agent process may have succeeded but hit quota limits mid-run)
    const rateLimited = isRateLimited(result.output);
    return {
      retry: true,
      reason: rateLimited ? "rate limited (set_output cascade)" : "set_output not called (cascade)",
      backoffMs: rateLimited ? RATE_LIMIT_BACKOFF_MS : FLAKY_RETRY_BACKOFF_MS,
    };
  }

  // set_output was called (or test has no set_output check) — if any other check
  // failed, that's a genuine test failure with real data, not a cascade. don't retry.
  const otherCheckFailed = validation.checks.some((c) => !c.passed && c.name !== "set_output");
  if (otherCheckFailed) {
    return { retry: false };
  }

  // agent process failed (non-zero exit) but no structured output to validate
  if (!result.success) {
    return { retry: true, reason: "agent process failed", backoffMs: FLAKY_RETRY_BACKOFF_MS };
  }

  return { retry: false };
}

async function runTestForAgent(ctx: RunContext): Promise<ValidationResult> {
  const testConfig = ctx.testInfo.config;

  // runtime-evaluated skip: gate on env (e.g. CODEX_AUTH_JSON for codex-auth).
  // skipped runs short-circuit before any agent spawn AND count as passing so
  // a missing optional secret doesn't fail-fast cancel the rest of the matrix.
  const skipReason = testConfig.skipIf?.();
  if (skipReason) {
    const prefix = getPrefix({ test: ctx.testInfo.name, agent: ctx.agent });
    console.log(`${prefix} ⏭  skipped: ${skipReason}`);
    const skipped: ValidationResult = {
      test: ctx.testInfo.name,
      agent: ctx.agent,
      passed: true,
      canceled: false,
      checks: [],
      output: `skipped: ${skipReason}`,
      skipped: true,
      skipReason,
    };
    ctx.results.set(getRunKey(ctx.testInfo.name, ctx.agent), skipped);
    return skipped;
  }

  const env: Record<string, string> = {};
  if (testConfig.env) {
    const entries = Object.entries(testConfig.env);
    for (const entry of entries) {
      env[entry[0]] = entry[1];
    }
  }
  if (testConfig.agentEnv) {
    const agentEnv = testConfig.agentEnv.get(ctx.agent);
    if (agentEnv) {
      const entries = Object.entries(agentEnv);
      for (const entry of entries) {
        env[entry[0]] = entry[1];
      }
    }
  }

  env.PULLFROG_AGENT = ctx.agent;

  // override DB model to avoid mismatch when PULLFROG_AGENT forces a specific agent
  // (DB model may belong to a different provider than the forced agent supports).
  // precedence: testConfig.env > process.env.PULLFROG_MODEL > per-agent default.
  // the process.env pass-through lets CI (models-live matrix) pin an alias per job.
  if (!Object.hasOwn(env, "PULLFROG_MODEL")) {
    if (process.env.PULLFROG_MODEL) {
      env.PULLFROG_MODEL = process.env.PULLFROG_MODEL;
    } else {
      const defaultModels: Record<string, string> = {
        claude: "anthropic/claude-sonnet-4-6",
        opencode: "anthropic/claude-sonnet-4-6",
        // GPT-6.2 Sol declines the adversarial probes, so the fixtures pin a model that runs them
        codex: "openai/gpt-6.1-sol",
      };
      const model = defaultModels[ctx.agent];
      if (model) {
        env.PULLFROG_MODEL = model;
      }
    }
  }

  if (!Object.hasOwn(env, "PULLFROG_MCP_PORT")) {
    env.PULLFROG_MCP_PORT = String(allocateMcpPort());
  }

  // pass repo setup commands to play.ts for pre-agent execution
  if (testConfig.repoSetup) {
    env.PULLFROG_TEST_REPO_SETUP = testConfig.repoSetup;
  }

  // build file-based env vars for MCP servers that don't inherit parent env
  let fileEnv: Record<string, string> | undefined;
  if (testConfig.fileAgentEnv) {
    const agentFileEnv = testConfig.fileAgentEnv.get(ctx.agent);
    if (agentFileEnv) {
      fileEnv = {};
      const entries = Object.entries(agentFileEnv);
      for (const entry of entries) {
        fileEnv[entry[0]] = entry[1];
      }
    }
  }

  const prefix = getPrefix({ test: ctx.testInfo.name, agent: ctx.agent });

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (ctx.cancelState.canceled) break;

    // allocate a fresh port on retries (previous server is gone)
    if (attempt > 0) {
      env.PULLFROG_MCP_PORT = String(allocateMcpPort());
    }

    const result = await runAgentStreaming({
      test: ctx.testInfo.name,
      agent: ctx.agent,
      fixture: testConfig.fixture,
      env,
      fileEnv,
      isCanceled: () => ctx.cancelState.canceled,
    });

    const validation = validateResult(result, testConfig.validator, {
      test: ctx.testInfo.name,
      expectFailure: testConfig.expectFailure,
      passOnTimeout: testConfig.passOnTimeout,
    });

    // check if we should retry
    if (attempt < MAX_RETRIES) {
      const decision = shouldRetry({
        result,
        validation,
        retryOnTimeout: testConfig.retryOnTimeout ?? true,
      });
      if (decision.retry) {
        console.log(
          `\n${prefix} ${decision.reason} — retrying in ${decision.backoffMs / 1000}s (retry ${attempt + 1}/${MAX_RETRIES})...\n`
        );
        await new Promise((r) => setTimeout(r, decision.backoffMs));
        continue;
      }
    }

    ctx.results.set(getRunKey(ctx.testInfo.name, ctx.agent), validation);
    return validation;
  }

  // should not reach here, but handle canceled state
  return buildCanceledValidation({
    testInfo: ctx.testInfo,
    agent: ctx.agent,
    signal: ctx.cancelState.signal ?? "SIGTERM",
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const allTests = await loadAllTests();
  const parsed = parseArgs(args, allTests);

  // filter tests
  const filteredTests = filterTests(allTests, parsed.filters);

  if (filteredTests.length === 0) {
    console.error("no tests to run");
    process.exit(1);
  }

  // determine which agents to run
  const agentsToRun = parsed.agentFilters.length > 0 ? parsed.agentFilters : [...agents];

  // build list of test runs
  type TestRun = { testInfo: TestInfo; agent: string };
  const runs: TestRun[] = [];

  for (const testInfo of filteredTests) {
    const isAgnostic = hasTag(testInfo, "agnostic");

    if (isAgnostic) {
      // agnostic tests: skip if only filtering by agent, otherwise run with opencode
      if (parsed.filters.length === 0 && parsed.agentFilters.length > 0) {
        continue;
      }
      runs.push({ testInfo, agent: "opencode" });
    } else {
      // determine which agents to run for this test
      const testAgents = testInfo.config.agents ?? agents;
      const effectiveAgents = agentsToRun.filter((a) => testAgents.includes(a));
      for (const agent of effectiveAgents) {
        runs.push({ testInfo, agent });
      }
    }
  }

  if (runs.length === 0) {
    console.error("no test runs after filtering");
    process.exit(1);
  }

  // describe what we're running
  const runTestNames = [...new Set(runs.map((r) => r.testInfo.name))];
  const runAgentNames = [...new Set(runs.map((r) => r.agent))];
  console.log(`running ${runTestNames.join(", ")} for: ${runAgentNames.join(", ")}\n`);

  const cancelState: CancelState = { canceled: false, signal: null };
  const results = new Map<string, ValidationResult>();
  let resultsPrinted = false;

  function printAndExit(validations: ValidationResult[]): void {
    if (resultsPrinted) return;
    resultsPrinted = true;
    console.log();
    for (const v of validations) {
      printSingleValidation(v);
    }
    printResults(validations);
    const allPassed = validations.every((v) => v.passed);
    process.exit(allPassed ? 0 : 1);
  }

  function handleCancel(signal: NodeJS.Signals): void {
    if (cancelState.canceled) return;
    cancelState.canceled = true;
    cancelState.signal = signal;
    killTrackedChildren();

    const validations: ValidationResult[] = [];
    for (const run of runs) {
      const key = getRunKey(run.testInfo.name, run.agent);
      const existing = results.get(key);
      if (existing) {
        validations.push(existing);
      } else {
        validations.push(
          buildCanceledValidation({
            testInfo: run.testInfo,
            agent: run.agent,
            signal,
          })
        );
      }
    }
    printAndExit(validations);
  }

  setSignalHandler(handleCancel);

  // run tests with limited concurrency to avoid overwhelming agent APIs
  const maxConcurrency = 5;
  const validations = await runWithConcurrencyLimit(runs, maxConcurrency, (run) =>
    runTestForAgent({
      testInfo: run.testInfo,
      agent: run.agent,
      cancelState,
      results,
    })
  );

  if (!cancelState.canceled) {
    printAndExit(validations);
  }
}

// simple concurrency limiter
async function runWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  const executing: Promise<void>[] = [];

  for (const item of items) {
    const p = fn(item).then(
      (result) => {
        results.push(result);
      },
      (err: unknown) => {
        console.error("runWithConcurrencyLimit: fn rejected unexpectedly", err);
        throw err;
      }
    );

    const e = p.then(() => {
      executing.splice(executing.indexOf(e), 1);
    });
    executing.push(e);

    if (executing.length >= limit) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
}

main();
