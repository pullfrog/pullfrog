/**
 * provider catalog — the source of truth for `providers-live` (full harness
 * smoke per provider).
 *
 * each entry pins one standard-tier flagship slug per provider — not the
 * pro/opus tier (too expensive) and not the free/experimental tier (too
 * flaky). these flagships catch provider-class regressions like Gemini schema
 * sanitization or OpenAI tool-call format drift that the cheap per-alias CLI
 * smoke can't see.
 *
 * adding a new provider:
 *   1. add an entry here with the flagship slug and agent harness
 *   2. add a row to wiki/models-catalog.md "To add a provider"
 *   3. CI picks it up automatically — no workflow change
 */

export type ProviderEntry = {
  name: string;
  /** flagship slug for `providers-live` full-harness smoke. */
  flagship: string;
  /** harness used by the runtime for this provider's models. */
  agent: "claude" | "opencode";
  /**
   * CI holds no credential for this provider, so `models-live` and
   * `providers-live` emit no cell for it — every cell would fail on auth
   * rather than on anything the smoke is asking about.
   *
   * Deliberately a per-provider opt-out and NOT "skip whenever the env var is
   * missing": the second one also swallows a rotation accident on a provider we
   * do hold a key for, which is exactly what these jobs exist to catch. Delete
   * the flag the moment the secret lands — the rest of the entry is already
   * correct and the cells arm themselves.
   */
  noCiCredential?: true;
  /**
   * CI holds a working credential but deliberately spends it elsewhere, so
   * `models-live` and `providers-live` emit no cell for this provider.
   *
   * Distinct from `noCiCredential` on purpose: that one means the cells CANNOT
   * run, this one means they are not worth what they cost. Collapsing the two
   * would make a rotation accident look like a budget decision. Delete the flag
   * to arm the cells again — the rest of the entry stays correct.
   */
  ciCostExcluded?: true;
  /**
   * A mirror route: `providers-live` keeps its flagship cell, the one check that the
   * harness talks to this route at all, and `models-live` emits no cell for its metered
   * aliases. Each alias on a mirror goes through the same harness path, and
   * `test:catalog` already checks every mirrored id against the route's own published
   * list with no LLM call, so a per-alias smoke there repeats the flagship.
   */
  flagshipOnly?: true;
};

export const providers: ProviderEntry[] = [
  {
    name: "anthropic",
    flagship: "anthropic/claude-sonnet",
    agent: "claude",
  },
  {
    name: "openai",
    flagship: "openai/gpt-sol",
    agent: "opencode",
  },
  {
    name: "google",
    flagship: "google/gemini-pro",
    agent: "opencode",
  },
  {
    name: "xai",
    flagship: "xai/grok",
    agent: "opencode",
  },
  {
    // the other account the 2 September runaway drained, and the only thing
    // left keeping the nightly red once Zen is out. not a spend of Zen's size —
    // 4 metered aliases — so this is the cheapest exclusion here to undo:
    // refill the account, delete the flag, and all 5 cells arm themselves.
    // `openrouter/*` and `vercel/*` mirror 3 of the 4 meanwhile; only
    // `deepseek-reasoner` goes fully dark.
    name: "deepseek",
    flagship: "deepseek/deepseek-pro",
    agent: "opencode",
    ciCostExcluded: true,
  },
  {
    name: "moonshotai",
    flagship: "moonshotai/kimi-k3",
    agent: "opencode",
  },
  {
    // the flagship is the all-tier model on purpose: K3 and HighSpeed 401 on a
    // membership below Moderato / Allegretto, so any lower-tier CI key would
    // fail them for a reason the smoke isn't testing.
    name: "kimi-for-coding",
    flagship: "kimi-for-coding/kimi-k2",
    agent: "opencode",
    noCiCredential: true,
  },
  {
    // no META_MODEL_API_KEY in CI yet. `openrouter/muse-spark` and
    // `vercel/muse-spark` keep the model itself under test meanwhile.
    name: "meta",
    flagship: "meta/muse-spark",
    agent: "opencode",
    noCiCredential: true,
  },
  {
    // one gateway key fronts every vendor; sonnet is the standard tier there too.
    name: "vercel",
    flagship: "vercel/claude-sonnet",
    agent: "opencode",
    flagshipOnly: true,
  },
  {
    // Zen is the largest model spend in CI: 39 metered alias cells, more than
    // any other provider, fanned out over the whole funded OSS menu. 30 of them
    // are mirrored by `openrouter/*` or `vercel/*` and stay under test there.
    // the flagship survives the exclusion because `big-pickle` is free.
    name: "opencode",
    flagship: "opencode/big-pickle",
    agent: "opencode",
    ciCostExcluded: true,
  },
  {
    name: "openrouter",
    flagship: "openrouter/claude-sonnet",
    agent: "opencode",
    flagshipOnly: true,
  },
  {
    // the Go endpoint is a different base URL on the SAME `OPENCODE_API_KEY`
    // and the same Zen balance, so excluding `opencode` above without this one
    // would leave 15 cells still drawing on the account it was meant to stop
    // spending from. every model here is metered, so unlike `opencode` this
    // entry loses its flagship cell too.
    name: "opencode-go",
    flagship: "opencode-go/glm",
    agent: "opencode",
    ciCostExcluded: true,
  },
];
