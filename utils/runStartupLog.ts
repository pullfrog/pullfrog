/**
 * Startup log formatting for the resolver pipeline. Computes the
 * "model / effort / agent / push / shell / timeout" block that main.ts prints
 * after resolving the agent + model + payload.
 */

import { log } from "./cli.ts";
import type { ResolvedPayload } from "./payload.ts";
import { resolveRunEffort } from "./runEffort.ts";
import { TIMEOUT_DISABLED } from "./time.ts";

function resolveTimeoutForLog(timeout: string | undefined): string {
  if (!timeout) return "1h (default)";
  if (timeout === TIMEOUT_DISABLED) return "none (disabled)";
  return timeout;
}

function resolveModelForLog(ctx: {
  payload: ResolvedPayload;
  resolvedModel: string | undefined;
}): string {
  const envModel = process.env.PULLFROG_MODEL?.trim();
  if (envModel) return `${envModel} (override via PULLFROG_MODEL)`;
  if (ctx.payload.proxyModel) return `${ctx.payload.proxyModel} (proxy)`;
  if (ctx.resolvedModel && ctx.payload.model && ctx.payload.model !== ctx.resolvedModel) {
    return `${ctx.resolvedModel} (resolved from ${ctx.payload.model})`;
  }
  if (ctx.resolvedModel) return ctx.resolvedModel;
  if (ctx.payload.model) return `${ctx.payload.model} (unresolved)`;
  return "auto";
}

/**
 * a run must never silently pay for a level that didn't apply, so surface the
 * level the harness actually sends and say so when it isn't the one requested.
 * "no effort control" and "model we don't recognize" are distinct causes and
 * read very differently to whoever pastes this line into a support thread.
 */
export function resolveEffortForLog(ctx: {
  payload: ResolvedPayload;
  resolvedModel: string | undefined;
  agentName: string;
}): string {
  const effort = resolveRunEffort(ctx);
  // this block prints before the agent starts, so an auto-select run has no
  // model yet — the harness prints the real rung once it picks one.
  if (!ctx.resolvedModel && !ctx.payload.proxyModel) return "pending — model not chosen yet";
  // the opencode harness reads an uncatalogued model's variants once its
  // session exists (resolveDeclaredRung) and prints the rung it sends then.
  if (!effort.alias && ctx.agentName === "opencode") {
    return "pending — read from the model's opencode variants at session start";
  }
  if (!effort.alias) return "not applied — model not recognized";
  if (!effort.rung) return "n/a (model has no effort control)";
  return effort.configured ? effort.rung : `${effort.rung} (default)`;
}

function resolveAgentForLog(ctx: { agentName: string; resolvedModel: string | undefined }): string {
  const envAgent = process.env.PULLFROG_AGENT?.trim();
  if (envAgent && envAgent === ctx.agentName) {
    return `${ctx.agentName} (override via PULLFROG_AGENT)`;
  }
  if (ctx.agentName === "claude" && ctx.resolvedModel) {
    return `${ctx.agentName} (auto-selected for ${ctx.resolvedModel})`;
  }
  return ctx.agentName;
}

/**
 * Emit the startup block ("» model / effort / agent / push / shell / timeout")
 * after the agent and model are resolved. Single side-effect; no return.
 */
export function logRunStartup(ctx: {
  payload: ResolvedPayload;
  resolvedModel: string | undefined;
  agentName: string;
}): void {
  log.info(
    `» model:   ${resolveModelForLog({ payload: ctx.payload, resolvedModel: ctx.resolvedModel })}`
  );
  log.info(
    `» effort:  ${resolveEffortForLog({ payload: ctx.payload, resolvedModel: ctx.resolvedModel, agentName: ctx.agentName })}`
  );
  const routing = ctx.payload.routing;
  if (routing) {
    log.info(
      `» routed:  ${routing.tier} (${routing.source}: stakes ${routing.stakes}, workload ${routing.workload}) — ${routing.rationale}`
    );
  }
  log.info(
    `» agent:   ${resolveAgentForLog({ agentName: ctx.agentName, resolvedModel: ctx.resolvedModel })}`
  );
  log.info(`» push:    ${ctx.payload.push}`);
  log.info(`» shell:   ${ctx.payload.shell}`);
  log.info(`» timeout: ${resolveTimeoutForLog(ctx.payload.timeout)}`);
}
