import { describe, expect, it } from "vitest";
import type { ResolvedPayload } from "./payload.ts";
import { resolveEffortForLog } from "./runStartupLog.ts";

// resolveEffortForLog reads only `effort` and `proxyModel` from the payload.
const payload = { effort: 1 } as unknown as ResolvedPayload;

describe("resolveEffortForLog", () => {
  it("defers to session start for an opencode model models.ts doesn't list", () => {
    expect(
      resolveEffortForLog({ payload, resolvedModel: "acme/model-x", agentName: "opencode" })
    ).toBe("pending — read from the model's opencode variants at session start");
  });

  it("still reports an unrecognized model as not applied for other agents", () => {
    expect(
      resolveEffortForLog({ payload, resolvedModel: "acme/model-x", agentName: "claude" })
    ).toBe("not applied — model not recognized");
  });
});
