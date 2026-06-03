import { describe, expect, it } from "vitest";
import {
  MANAGED_AUTH_WRITEBACK_STATE,
  parseManagedAuthWritebacks,
  stringifyManagedAuthWritebacks,
  type ManagedAuthWriteback,
} from "./managedAuthState.ts";

describe("managed auth writeback state", () => {
  const codex: ManagedAuthWriteback = {
    kind: "codex",
    apiToken: "pullfrog-runtime-token",
    secretName: "CODEX_AUTH_JSON",
    authPath: "/var/lib/pullfrog/opencode/auth.json",
    originalRefresh: "rt_original",
  };

  it("uses a stable GitHub Actions state key", () => {
    expect(MANAGED_AUTH_WRITEBACK_STATE).toBe("managed_auth_writebacks");
  });

  it("round-trips codex writeback records", () => {
    const raw = stringifyManagedAuthWritebacks([codex]);

    expect(parseManagedAuthWritebacks(raw)).toEqual([codex]);
  });

  it("accepts an empty list", () => {
    expect(parseManagedAuthWritebacks("[]")).toEqual([]);
  });

  it("rejects malformed JSON", () => {
    expect(parseManagedAuthWritebacks("{not-json")).toBeNull();
  });

  it("rejects non-list state", () => {
    expect(parseManagedAuthWritebacks(JSON.stringify(codex))).toBeNull();
  });

  it("rejects unsupported provider records", () => {
    expect(parseManagedAuthWritebacks(JSON.stringify([{ kind: "some-future-provider" }]))).toBeNull();
  });

  it("rejects incomplete codex records", () => {
    expect(
      parseManagedAuthWritebacks(
        JSON.stringify([{ ...codex, originalRefresh: "", authPath: "/tmp/auth.json" }])
      )
    ).toBeNull();
  });

  it("rejects codex records pointed at a different secret", () => {
    expect(
      parseManagedAuthWritebacks(JSON.stringify([{ ...codex, secretName: "OPENAI_API_KEY" }]))
    ).toBeNull();
  });
});
