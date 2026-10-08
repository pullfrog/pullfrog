import * as yes from "yes";
import { autoSelectModel } from "../agents/opencodeShared.ts";
import {
  CLAUDE_CODE_ONLY_CREDENTIALS,
  getModelEnvVars,
  getModelProvider,
  getProviderGatewayUrl,
  modelAliases,
  resolveCliModel,
  stripProviderPrefix,
} from "../models.ts";
import { resolveAgent } from "./agent.ts";
import { apiFetch } from "./apiFetch.ts";
import { buildCredentialPoolRefusedError, type RefusedCredential } from "./apiKeys.ts";
import { log } from "./cli.ts";
import {
  canInstallSubscription,
  clearInstalledSubscription,
  installCodexAuth,
  installXaiAuth,
} from "./codexHome.ts";
import { sanitizeSecret } from "./normalizeEnv.ts";
import { authorizeModel } from "./openCodeModels.ts";
import type { RunContextData } from "./runContextData.ts";
import { maskSecret, saveSecretState } from "./secretCommands.ts";
import {
  type CredentialAccess,
  type CredentialCandidate,
  selectedCredentialSchema,
  subscriptionNameSchema,
} from "./subscriptionCredentials.ts";
import { type ProbeVerdict, probeInference, probeSubscription } from "./subscriptionProbe.ts";

const receipts: Record<string, string> = {};
const workflowCredentials: Record<string, string> = {};

function saveReceipts() {
  for (const receipt of Object.values(receipts)) maskSecret(receipt);
  saveSecretState("credential_receipts", JSON.stringify(receipts));
}

const select = yes.mutation({
  run: async (
    input: { access: CredentialAccess; candidate: CredentialCandidate },
    ctx: yes.ctx
  ) => {
    const response = await apiFetch({
      path: "/api/runtime/credentials",
      method: "POST",
      headers: {
        authorization: `Bearer ${input.access.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: input.candidate.id }),
      signal: ctx.signal,
    });
    if (response.status === 404) return null;
    if (!response.ok)
      throw new Error("could not load a configured credential; no fallback was charged", {
        cause: response.status,
      });
    return selectedCredentialSchema.parse(await response.json());
  },
  retry: (error, attempt) =>
    error instanceof Error &&
    typeof error.cause === "number" &&
    error.cause >= 400 &&
    error.cause < 500
      ? -1
      : yes.delay([250, 1000], attempt),
  timeout: 35_000,
});

function subscriptionForModel(model: string) {
  if (!model.includes("/")) return null;
  const provider = getModelProvider(model);
  return provider === "anthropic"
    ? "CLAUDE_CODE_OAUTH_TOKEN"
    : provider === "openai"
      ? "CODEX_AUTH_JSON"
      : provider === "xai"
        ? "GROK_AUTH_JSON"
        : null;
}

/**
 * load one subscription per provider for model discovery; keep the pool unflattened. runs
 * after the account secrets are injected: `injected` names the ones that came from storage,
 * so everything else set here is a workflow credential.
 */
export async function initializeCredentialPool(input: {
  ctx: RunContextData;
  slug: string | undefined;
  injected: string[];
}) {
  const access = input.ctx.credentialAccess;
  if (!access) return;
  const model = discoveryModel(input.slug);
  maskSecret(access.token);
  const names = new Set([
    ...access.candidates.map((candidate) => candidate.name),
    ...subscriptionNameSchema.options,
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "XAI_API_KEY",
  ]);
  for (const name of names) {
    const value = process.env[name];
    if (value && !input.injected.includes(name)) workflowCredentials[name] = value;
  }
  for (const name of subscriptionNameSchema.options) {
    if (model && subscriptionForModel(model) !== name) continue;
    if (workflowCredentials[name]) continue;
    const candidate = access.candidates.find((item) => item.name === name);
    if (!candidate) continue;
    const selected = await select({ access, candidate }).catch(() => {
      log.warning(`» could not load ${name} for model discovery; selection will retry if needed`);
      return null;
    });
    if (!selected) continue;
    const value = sanitizeSecret(name, selected.value);
    if (!value) continue;
    process.env[name] = value;
    receipts[name] = selected.receipt;
  }
  saveReceipts();
}

/**
 * the configured model, for choosing which subscription to load. unlike `resolveModel` it
 * never reads a routing slug's env var, so a missing one throws later inside main's error
 * rendering rather than here: a routing slug resolves to its bare sentinel and loads nothing.
 */
function discoveryModel(slug: string | undefined) {
  const value = process.env.PULLFROG_MODEL?.trim() || slug?.trim();
  if (!value) return undefined;
  return resolveCliModel(value) ?? (value.includes("/") ? value : undefined);
}

export function resolvePoolModel(input: { codexAgent: boolean }) {
  const agent = resolveAgent({
    model: undefined,
    proxyModel: undefined,
    codexAgent: input.codexAgent,
  });
  if (agent.name === "opencode") return autoSelectModel();
  const provider = agent.name === "claude" ? "anthropic" : "openai";
  return modelAliases.find(
    (alias) =>
      alias.provider === provider &&
      alias.preferred &&
      !alias.hidden &&
      !alias.fallback &&
      !alias.routing
  )?.resolve;
}

export async function selectConfiguredCredential(input: {
  ctx: RunContextData;
  model: string | undefined;
}) {
  const access = input.ctx.credentialAccess;
  const model = input.model;
  if (!access || !model?.includes("/") || getProviderGatewayUrl(model)) return false;
  const subscription = subscriptionForModel(model);
  const names = getModelEnvVars(model).filter((name) => name !== subscription);
  if (subscription) names.unshift(subscription);
  // a subscription this runner cannot install would displace a working API key, then fail as no key.
  // so would a Claude one under PULLFROG_AGENT=opencode, which reads only ANTHROPIC_API_KEY
  const opencodePinned = process.env.PULLFROG_AGENT?.trim() === "opencode";
  const presentable = (name: string) =>
    canInstallSubscription(name) &&
    !(opencodePinned && CLAUDE_CODE_ONLY_CREDENTIALS.includes(name));
  const candidates = access.candidates.filter(
    (candidate) => names.includes(candidate.name) && presentable(candidate.name)
  );
  // nothing stored to choose between: the workflow credential runs exactly as it did before pools
  if (!candidates.length) return false;
  // a subscription pays before any API key, whatever its scope: claude.ts has always stripped
  // the key once the subscription passes its preflight. the sort is stable, so the workflow
  // still leads within each group.
  const options = [
    ...names
      .filter((name) => workflowCredentials[name] && presentable(name))
      .map((name) => ({ name, candidate: undefined })),
    ...candidates.map((candidate) => ({ name: candidate.name, candidate })),
  ].sort((a, b) => Number(b.name === subscription) - Number(a.name === subscription));
  const refused: RefusedCredential[] = [];
  for (const option of options) {
    const selected = option.candidate
      ? await select({ access, candidate: option.candidate })
      : { name: option.name, value: workflowCredentials[option.name], receipt: undefined };
    if (!selected) continue;
    const from = option.candidate ? `${option.candidate.source} scope` : "the workflow";
    const verdict = await probe({ ...selected, model });
    if (selected.receipt) await reportVerdict({ receipt: selected.receipt, verdict });
    if (usable(verdict)) {
      activate({ names, ...selected, model });
      if (option.candidate) log.info(`» selected ${option.name} from ${from}`);
      return true;
    }
    refused.push({ name: option.name, source: option.candidate?.source ?? "workflow", verdict });
    log.info(`» ${option.name} from ${from} unavailable; trying the next credential`);
  }
  throw new Error(
    buildCredentialPoolRefusedError({
      model,
      refused,
      owner: input.ctx.repo.owner,
      name: input.ctx.repo.name,
    })
  );
}

async function probe(input: { name: string; value: string; model: string }) {
  const subscription = subscriptionNameSchema.safeParse(input.name);
  const model = stripProviderPrefix(input.model);
  return subscription.success
    ? probeSubscription({ name: subscription.data, value: input.value, model })
    : probeInference({ ...input, model });
}

function usable(
  verdict: ProbeVerdict
): verdict is Extract<ProbeVerdict, { status: "usable" | "unknown" }> {
  return verdict.status !== "rejected" && verdict.status !== "exhausted";
}

/** best-effort and bounded: a slow or failed report never fails the run. */
async function reportVerdict(input: { receipt: string; verdict: ProbeVerdict }) {
  if (input.verdict.status === "unknown") return;
  await apiFetch({
    path: "/api/runtime/credentials/status",
    method: "POST",
    headers: { authorization: `Bearer ${input.receipt}`, "content-type": "application/json" },
    body: JSON.stringify(input.verdict),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => log.debug("» could not record a credential verdict"));
}

function activate(input: {
  names: string[];
  name: string;
  value: string;
  receipt: string | undefined;
  model: string;
}) {
  for (const name of input.names) {
    delete process.env[name];
    delete receipts[name];
    if (name === "CODEX_AUTH_JSON" || name === "GROK_AUTH_JSON") clearInstalledSubscription(name);
  }
  const value = sanitizeSecret(input.name, input.value);
  if (!value) throw new Error("configured credential was empty");
  process.env[input.name] = value;
  if (input.receipt) receipts[input.name] = input.receipt;
  installCodexAuth();
  installXaiAuth();
  saveReceipts();
  authorizeModel(input.model);
}
