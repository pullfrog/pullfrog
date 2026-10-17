import { describe, expect, it } from "vitest";
import { type DeclaredProvider, resolveDeclaredRung } from "./runEffort.ts";

const providers: DeclaredProvider[] = [
  {
    id: "acme",
    models: {
      "model-x": { variants: { low: {}, high: {}, max: {} } },
      "model-no-variants": {},
    },
  },
];

describe("resolveDeclaredRung", () => {
  it("lands the position on the variants opencode declares", () => {
    expect(resolveDeclaredRung({ model: "acme/model-x", position: 1, providers })).toBe("max");
    expect(resolveDeclaredRung({ model: "acme/model-x", position: 0.5, providers })).toBe("high");
    expect(resolveDeclaredRung({ model: "acme/model-x", position: 0, providers })).toBe("low");
  });

  it("rounds down between variants, as for catalogued models", () => {
    expect(resolveDeclaredRung({ model: "acme/model-x", position: 0.99, providers })).toBe("high");
  });

  it("sends nothing for a model opencode doesn't list", () => {
    // opencode may be unable to place such a model, and a variant it can't
    // place can hang the run.
    expect(resolveDeclaredRung({ model: "acme/other", position: 1, providers })).toBeUndefined();
    expect(resolveDeclaredRung({ model: "other/model-x", position: 1, providers })).toBeUndefined();
  });

  it("sends nothing for a model without declared variants", () => {
    expect(
      resolveDeclaredRung({ model: "acme/model-no-variants", position: 1, providers })
    ).toBeUndefined();
  });

  it("sends nothing for a specifier without a provider", () => {
    expect(resolveDeclaredRung({ model: "model-x", position: 1, providers })).toBeUndefined();
  });
});
