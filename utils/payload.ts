import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import * as core from "@actions/core";
import { type } from "arktype";
import type { AuthorPermission, PayloadEvent } from "../external.ts";
import packageJson from "../package.json" with { type: "json" };
import { log } from "./cli.ts";
import { deriveEventFromGithubActions } from "./githubEvent.ts";
import type { RepoSettings } from "./runContext.ts";
import { validateCompatibility } from "./versioning.ts";

// tool permission enum types for inputs
const ShellPermissionInput = type.enumerated("disabled", "restricted", "enabled");
const PushPermissionInput = type.enumerated("disabled", "restricted", "enabled");
// opt-in toggle for posting `pullfrog` / `pullfrog-approval` commit-status
// check-runs (branch protection). off by default — a new required-check
// surface must not silently turn on.
const StatusChecksInput = type.enumerated("disabled", "enabled");

// schema for JSON payload passed via prompt (internal dispatch invocation)
// note: permissions are intentionally NOT included here to prevent injection attacks
// permissions are derived from event.authorPermission instead
export const JsonPayload = type({
  "~pullfrog": "true",
  version: "string",
  "model?": "string | undefined",
  "modelExplicit?": "boolean | undefined",
  prompt: "string",
  "triggerer?": "string | undefined",

  "baseInstructions?": "string | undefined",
  "eventInstructions?": "string",
  "previousRunsNote?": "string",
  "event?": "object",
  "xrepo?": type({
    mode: "'all' | 'explicit'",
    read: "string[]",
    write: "string[]",
    // optional so a payload from an older server build (pre-`unavailable`)
    // still parses against a newer action across a rolling deploy.
    "unavailable?": "string[]",
  }).or("undefined"),
  "timeout?": "string | undefined",
  "progressComment?": type({
    id: "string",
    type: "'issue' | 'review'",
  }).or("undefined"),
  "generateSummary?": "boolean | undefined",
});

// permission levels that indicate collaborator status (have push access)
const COLLABORATOR_PERMISSIONS: AuthorPermission[] = ["admin", "maintain", "write"];

// check if the event author has collaborator-level permissions
function isCollaborator(event: PayloadEvent): boolean {
  const perm = event.authorPermission;
  return perm !== undefined && COLLABORATOR_PERMISSIONS.includes(perm);
}

// inputs schema - action inputs from core.getInput()
// note: tool permissions use .or("undefined") because getInput() || undefined
// explicitly sets the property to undefined when empty, which is different from
// the property being absent. arktype's "prop?" means "optional to include" but
// if included, must match the type - so we need to explicitly allow undefined.
export const Inputs = type({
  "prompt?": type.string.or("undefined"),
  "prompt_file?": type.string.or("undefined"),
  "model?": type.string.or("undefined"),
  "timeout?": type.string.or("undefined"),
  "push?": PushPermissionInput.or("undefined"),
  "shell?": ShellPermissionInput.or("undefined"),
  "status_checks?": StatusChecksInput.or("undefined"),
  "cwd?": type.string.or("undefined"),
  "output_schema?": type.string.or("undefined"),
});

export type Inputs = typeof Inputs.infer;

function isPayloadEvent(value: unknown): value is PayloadEvent {
  return typeof value === "object" && value !== null && "trigger" in value;
}

function resolveCwd(cwd: string | undefined): string | undefined {
  const workspace = process.env.GITHUB_WORKSPACE;
  if (!cwd) return workspace;
  if (isAbsolute(cwd)) return cwd;
  return workspace ? resolve(workspace, cwd) : cwd;
}

export type ResolvedPromptInput = string | typeof JsonPayload.infer;

export function resolvePromptInput(): ResolvedPromptInput {
  const promptInput = core.getInput("prompt");
  const promptFile = core.getInput("prompt_file");

  if (promptInput && promptFile) {
    throw new Error("set exactly one of 'prompt' or 'prompt_file' inputs, not both.");
  }

  // a prompt file holds a human-authored prompt, so it is returned verbatim and
  // never parsed as an internal pullfrog JSON dispatch payload.
  if (promptFile) {
    return resolvePromptFile(promptFile);
  }

  if (!promptInput) {
    throw new Error("one of 'prompt' or 'prompt_file' inputs is required.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(promptInput);
  } catch {
    // JSON parse error is fine (plain text prompt)
    return promptInput;
  }

  if (!parsed || typeof parsed !== "object" || !("~pullfrog" in parsed)) {
    // if it doesn't look like a pullfrog payload, return the plain text prompt
    return promptInput;
  }

  // validation errors should propagate
  const jsonPayload = JsonPayload.assert(parsed);
  validateCompatibility(jsonPayload.version, packageJson.version);
  return jsonPayload;
}

// the path is workflow-author-controlled (anyone who can set prompt_file can
// already run arbitrary job steps), so we resolve, read, and empty-check it
// without sandbox-grade path validation.
function resolvePromptFile(input: string): string {
  const workspace = process.env.GITHUB_WORKSPACE;
  const path = isAbsolute(input) ? input : workspace ? resolve(workspace, input) : resolve(input);
  const content = readFileSync(path, "utf-8");
  if (!content.trim()) {
    throw new Error(`prompt_file ${JSON.stringify(input)} is empty.`);
  }
  return content;
}

function resolveNonPromptInputs() {
  return Inputs.omit("prompt", "prompt_file").assert({
    model: core.getInput("model") || undefined,
    timeout: core.getInput("timeout") || undefined,
    cwd: core.getInput("cwd") || undefined,
    push: core.getInput("push") || undefined,
    shell: core.getInput("shell") || undefined,
    status_checks: core.getInput("status_checks") || undefined,
  });
}

/**
 * true when `actor` is Pullfrog's own GitHub identity — the bot login
 * (`pullfrog[bot]` / `pullfrogdev[bot]`) or the bare account. used to skip
 * self-triggered events and to recognize Pullfrog-originated review threads.
 */
export const isPullfrog = (actor: string | null | undefined): boolean => {
  actor = actor?.replace("[bot]", "");
  return !!actor && (actor === "pullfrog" || actor === "pullfrogdev");
};

export function resolvePayload(
  resolvedPromptInput: ResolvedPromptInput,
  repoSettings: RepoSettings
) {
  const [prompt, jsonPayload] =
    typeof resolvedPromptInput !== "string"
      ? [resolvedPromptInput.prompt, resolvedPromptInput]
      : [resolvedPromptInput, undefined];

  const inputs = resolveNonPromptInputs();

  // resolve event: SaaS JSON payload event wins; otherwise derive from the GHA
  // webhook (GITHUB_EVENT_PATH). local plain-text prompts have no ~pullfrog
  // event object — without this derivation, push_branch sees trigger:unknown
  // and blocks pr-N pushes even when the workflow was clearly on that PR
  // (issue_comment @pullfrog, check_suite, etc.).
  const rawEvent = jsonPayload?.event;
  let event: PayloadEvent;
  if (isPayloadEvent(rawEvent)) {
    event = rawEvent;
  } else {
    const derived = deriveEventFromGithubActions();
    if (derived) {
      log.info(
        `» derived run event from GITHUB_EVENT (${process.env.GITHUB_EVENT_NAME}): ` +
          `trigger=${derived.trigger}` +
          (derived.issue_number != null ? ` issue_number=${derived.issue_number}` : "") +
          (derived.is_pr ? " is_pr=true" : "")
      );
      event = derived;
    } else {
      event = { trigger: "unknown" };
    }
  }

  const model = jsonPayload?.model ?? inputs.model ?? repoSettings.model ?? undefined;

  // determine shell permission - strictest setting wins
  // precedence: disabled > restricted > enabled
  // non-collaborators always get at least "restricted"
  const isNonCollaborator = !isCollaborator(event);
  const repoShell = repoSettings.shell ?? "restricted";
  const inputShell = inputs.shell;

  // resolve shell: start with repo setting, then apply restrictions
  let resolvedShell = repoShell;

  // input can only make it stricter (disabled > restricted > enabled)
  if (inputShell === "disabled") {
    resolvedShell = "disabled";
  } else if (inputShell === "restricted" && resolvedShell === "enabled") {
    resolvedShell = "restricted";
  }

  // non-collaborators get at least "restricted" (can't have "enabled")
  if (isNonCollaborator && resolvedShell === "enabled") {
    resolvedShell = "restricted";
  }

  // build payload - precedence: inputs > repoSettings > fallbacks
  // note: modes are NOT in payload - they come from repoSettings in main()
  return {
    "~pullfrog": true as const,
    version: jsonPayload?.version ?? packageJson.version,
    model,
    // explicit only when the model came from a per-run override flag (carried on
    // the JSON payload). a GHA `model` input or the repo default is not explicit.
    modelExplicit: jsonPayload?.modelExplicit ?? false,
    prompt,
    triggerer:
      jsonPayload?.triggerer ??
      // it's not a common use case but GITHUB_ACTOR can be a user when the workflow is manually triggered by a user through GitHub Actions UI
      (!isPullfrog(process.env.GITHUB_ACTOR) ? process.env.GITHUB_ACTOR : undefined),
    baseInstructions: jsonPayload?.baseInstructions,
    eventInstructions: jsonPayload?.eventInstructions,
    previousRunsNote: jsonPayload?.previousRunsNote,
    event,
    xrepo: jsonPayload?.xrepo,
    timeout: inputs.timeout ?? jsonPayload?.timeout,
    cwd: resolveCwd(inputs.cwd),
    progressComment: jsonPayload?.progressComment,
    generateSummary: jsonPayload?.generateSummary,

    // permissions: inputs > repoSettings > fallbacks
    push: inputs.push ?? repoSettings.push ?? "restricted",
    shell: resolvedShell,

    // opt-in commit-status check-runs (branch protection). workflow-level
    // static input, off unless the repo's pullfrog.yml sets status_checks: enabled.
    statusChecks: inputs.status_checks === "enabled",

    // set by proxy logic in main.ts when routing through OpenRouter
    proxyModel: undefined as string | undefined,
  };
}

export type ResolvedPayload = ReturnType<typeof resolvePayload>;

/**
 * Parse and validate the optional `output_schema` action input. Returns the
 * parsed object when present, or `undefined` when absent. Throws on invalid
 * JSON or non-object payloads — these are workflow-author errors that should
 * surface immediately, not silently degrade to "no schema".
 */
export function resolveOutputSchema(): Record<string, unknown> | undefined {
  const raw = core.getInput("output_schema");
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`invalid output_schema: not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`invalid output_schema: must be a JSON object`);
  }
  log.info("» structured output schema provided — output will be required");
  return parsed as Record<string, unknown>;
}
