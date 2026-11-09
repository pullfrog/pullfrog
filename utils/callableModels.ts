import { offeredRungs } from "../effort.ts";
import {
  getModelEffortLevels,
  getModelEnvVars,
  getModelManagedCredentials,
  getModelProvider,
  modelAliases,
  PROVIDER_GATEWAY_URL_ENV,
} from "../models.ts";
import { subscriptionNameSchema } from "./subscriptionCredentials.ts";

/** a model a run can put a question to with `ask_model`, and the credential that pays for it. */
export interface CallableModel {
  slug: string;
  displayName: string;
  resolve: string;
  credential: string;
  /** the effort levels it takes, by name: the console lists them and `ask_model` refuses any other. */
  effort: readonly string[];
}

const isSubscription = (name: string) => subscriptionNameSchema.safeParse(name).success;

/**
 * every catalog model one of `credentials` can serve, paired with the credential that would: a
 * subscription before an API key, the order startup selection pays in. routing entries (Bedrock,
 * Vertex, Azure, OpenAI-compatible) are left to the runner's `routedModels`, since their model id
 * often lives in the workflow, out of the console's sight. so is a provider behind a gateway (`ANTHROPIC_BASE_URL`, keyless included), whose base URL needs
 * opencode config `ask_model` does not write. the console lists the same thing from stored
 * credential names, the runner from what it holds.
 */
export function callableModels(credentials: readonly string[]): CallableModel[] {
  return modelAliases.flatMap((alias) => {
    if (alias.hidden || alias.fallback || alias.routing) return [];
    const gateway = PROVIDER_GATEWAY_URL_ENV[getModelProvider(alias.resolve)];
    if (gateway && credentials.includes(gateway)) return [];
    const credential = [...getModelManagedCredentials(alias.slug), ...getModelEnvVars(alias.slug)]
      .sort((a, b) => Number(isSubscription(b)) - Number(isSubscription(a)))
      .find((name) => credentials.includes(name));
    if (!credential) return [];
    const published = getModelEffortLevels({
      slug: alias.slug,
      useOpenRouter: getModelProvider(alias.resolve) === "openrouter",
    });
    return [
      {
        slug: alias.slug,
        displayName: alias.displayName,
        resolve: alias.resolve,
        credential,
        effort: offeredRungs(published ?? []),
      },
    ];
  });
}
