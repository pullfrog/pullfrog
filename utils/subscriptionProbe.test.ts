import { afterEach, describe, expect, it, vi } from "vitest";
import { probeSubscription } from "./subscriptionProbe.ts";

const codexAuth = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: { access_token: "access", refresh_token: "refresh", account_id: "account" },
});

const limitReached = {
  allowed: false,
  limit_reached: true,
  primary_window: { used_percent: 100, reset_at: 1_790_926_798 },
  secondary_window: { used_percent: 16, reset_at: 1_791_513_598 },
};

function probeWithUsage(usage: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(usage)));
  return probeSubscription({ name: "CODEX_AUTH_JSON", value: codexAuth });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("probeSubscription (Codex)", () => {
  it("treats a reached plan limit with workspace credits as usable", async () => {
    const verdict = await probeWithUsage({
      rate_limit: limitReached,
      credits: { has_credits: true, unlimited: false, overage_limit_reached: false },
      spend_control: { reached: false },
    });
    expect(verdict).toEqual({ status: "usable" });
  });

  it("treats a reached plan limit without credits as exhausted", async () => {
    const verdict = await probeWithUsage({
      rate_limit: limitReached,
      credits: { has_credits: false, unlimited: false, balance: "0" },
    });
    expect(verdict).toMatchObject({ status: "exhausted" });
  });

  it("treats spent credits as exhausted", async () => {
    const verdict = await probeWithUsage({
      rate_limit: limitReached,
      credits: { has_credits: true, unlimited: false, overage_limit_reached: true },
    });
    expect(verdict).toMatchObject({ status: "exhausted" });
  });

  it("treats a reached spend cap as exhausted even with credits", async () => {
    const verdict = await probeWithUsage({
      rate_limit: limitReached,
      credits: { has_credits: true, unlimited: false, overage_limit_reached: false },
      spend_control: { reached: true },
    });
    expect(verdict).toMatchObject({ status: "exhausted" });
  });
});
