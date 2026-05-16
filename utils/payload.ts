import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import * as core from "@actions/core";
import { type } from "arktype";
import type { AuthorPermission, PayloadEvent } from "../external.ts";
import packageJson from "../package.json" with { type: "json" };
import type { RepoSettings } from "./runContext.ts";
import { validateCompatibility } from "./versioning.ts";

// tool permission enum types for inputs
const ShellPermissionInput = type.enumerated("disabled", "restricted", "enabled");
const PushPermissionInput = type.enumerated("disabled", "restricted", "enabled");

// schema for JSON payload passed via prompt (internal dispatch invocation)
// note: permissions are intentionally NOT included here to prevent injection attacks
// permissions are derived from event.authorPermission instead
export const JsonPayload = type({
  "~pullfrog": "true",
  version: "string",
  "model?": "string | undefined",
  prompt: "string",
  "triggerer?": "string | undefined",

  "eventInstructions?": "string",
  "previousRunsNote?": "string",
  "event?": "object",
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
    throw new Error("Set exactly one of 'prompt' or 'prompt_file' inputs, not both.");
  }

  if (promptFile) {
    return resolvePromptFile(promptFile);
  }

  if (!promptInput) {
    throw new Error("One of 'prompt' or 'prompt_file' inputs is required.");
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

// matches runCli.ts:normalizePathForCompare — windows filesystems are
// case-insensitive but `resolve()` preserves input case, so we lowercase both
// sides before comparing.
function normalizePathForCompare(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function isOutsideWorkspace(candidate: string, workspace: string): boolean {
  const c = normalizePathForCompare(candidate);
  const w = normalizePathForCompare(workspace);
  return c !== w && !c.startsWith(w + sep);
}

function resolvePromptFile(input: string): string {
  const workspace = process.env.GITHUB_WORKSPACE;
  if (!workspace) {
    throw new Error("prompt_file is set but GITHUB_WORKSPACE is not defined.");
  }

  const resolvedWorkspace = resolve(workspace);
  const candidate = isAbsolute(input) ? resolve(input) : resolve(resolvedWorkspace, input);

  // lexical boundary check — fires before any filesystem call so a path like
  // "../triage.md" produces a clean "resolves outside" error instead of ENOENT.
  if (isOutsideWorkspace(candidate, resolvedWorkspace)) {
    throw new Error(`prompt_file ${JSON.stringify(input)} resolves outside GITHUB_WORKSPACE.`);
  }

  // expand symlinks and re-check. without this, a symlink committed inside the
  // workspace pointing to e.g. /etc/passwd would pass the lexical check and
  // get read by readFileSync. realpath both sides so macOS /var → /private/var
  // (and similar canonicalization) does not produce a false positive.
  let realCandidate: string;
  let realWorkspace: string;
  try {
    realCandidate = realpathSync(candidate);
    realWorkspace = realpathSync(resolvedWorkspace);
  } catch (error) {
    throw new Error(
      `Failed to read prompt_file ${JSON.stringify(input)}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  if (isOutsideWorkspace(realCandidate, realWorkspace)) {
    throw new Error(`prompt_file ${JSON.stringify(input)} resolves outside GITHUB_WORKSPACE.`);
  }

  let content: string;
  try {
    content = readFileSync(realCandidate, "utf-8");
  } catch (error) {
    throw new Error(
      `Failed to read prompt_file ${JSON.stringify(input)}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

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
  });
}

const isPullfrog = (actor: string | null | undefined): boolean => {
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

  // resolve event - use type guard for jsonPayload.event, fallback to unknown trigger
  const rawEvent = jsonPayload?.event;
  const event: PayloadEvent = isPayloadEvent(rawEvent) ? rawEvent : { trigger: "unknown" };

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
    prompt,
    triggerer:
      jsonPayload?.triggerer ??
      // it's not a common use case but GITHUB_ACTOR can be a user when the workflow is manually triggered by a user through GitHub Actions UI
      (!isPullfrog(process.env.GITHUB_ACTOR) ? process.env.GITHUB_ACTOR : undefined),
    eventInstructions: jsonPayload?.eventInstructions,
    previousRunsNote: jsonPayload?.previousRunsNote,
    event,
    timeout: inputs.timeout ?? jsonPayload?.timeout,
    cwd: resolveCwd(inputs.cwd),
    progressComment: jsonPayload?.progressComment,
    generateSummary: jsonPayload?.generateSummary,

    // permissions: inputs > repoSettings > fallbacks
    push: inputs.push ?? repoSettings.push ?? "restricted",
    shell: resolvedShell,

    // set by proxy logic in main.ts when routing through OpenRouter
    proxyModel: undefined as string | undefined,
  };
}

export type ResolvedPayload = ReturnType<typeof resolvePayload>;
