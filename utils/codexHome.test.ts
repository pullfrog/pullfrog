import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CodexQuota, codexQuota, pickCodexSlot, selectCodexAuth } from "./codexHome.ts";

const savedEnv = { ...process.env };

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("CODEX_AUTH_JSON")) delete process.env[key];
  }
});

afterEach(() => {
  process.env = { ...savedEnv };
});

function usage(overrides: Record<string, unknown>) {
  return {
    user_id: "user-1",
    account_id: "acc-1",
    plan_type: "pro",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 26,
        limit_window_seconds: 604800,
        reset_after_seconds: 453612,
        reset_at: 1790690623,
      },
      secondary_window: null,
    },
    credits: { has_credits: false, unlimited: false, balance: "0" },
    spend_control: { reached: false },
    rate_limit_reached_type: null,
    ...overrides,
  };
}

const limitReached = {
  allowed: false,
  limit_reached: true,
  primary_window: {
    used_percent: 100,
    limit_window_seconds: 18000,
    reset_after_seconds: 3600,
    reset_at: 1790100000,
  },
  secondary_window: null,
};

function rejectedBlob(id: string): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      id_token: `id_${id}`,
      access_token: `at_${id}`,
      refresh_token: `rt_${id}`,
      account_id: `acc_${id}`,
    },
    last_refresh: "2026-09-01T00:00:00.000Z",
    refresh_rejected_at: "2026-09-02T00:00:00.000Z",
  });
}

function blobWithoutIdToken(id: string): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: `at_${id}`, refresh_token: `rt_${id}`, account_id: `acc_${id}` },
    last_refresh: "2026-09-01T00:00:00.000Z",
  });
}

describe("codexQuota", () => {
  it("reads an account under its limits as available", () => {
    expect(codexQuota(usage({}))).toBe("available");
  });

  it("reads an account at its limit with no credits as exhausted", () => {
    const body = usage({
      rate_limit: limitReached,
      rate_limit_reached_type: { type: "rate_limit_reached" },
    });
    expect(codexQuota(body)).toBe("exhausted");
  });

  it("reads an account at its limit that holds credits as credits", () => {
    const body = usage({
      rate_limit: limitReached,
      credits: { has_credits: true, unlimited: false, balance: "12.5" },
    });
    expect(codexQuota(body)).toBe("credits");
  });

  it("reads a workspace limit as exhausted even when the rate limit allows the request", () => {
    const body = usage({ rate_limit_reached_type: { type: "workspace_member_credits_depleted" } });
    expect(codexQuota(body)).toBe("exhausted");
  });

  it("reads a reached spend cap as exhausted even with credits and an open rate limit", () => {
    const body = usage({
      credits: { has_credits: true, unlimited: false, balance: "12.5" },
      spend_control: { reached: true },
    });
    expect(codexQuota(body)).toBe("exhausted");
  });

  it("reads a payload with no rate limit block as available", () => {
    expect(codexQuota(JSON.parse('{"plan_type":"enterprise"}'))).toBe("available");
  });
});

describe("pickCodexSlot", () => {
  const slots = (...quotas: CodexQuota[]) =>
    quotas.map((quota, index) => ({ name: `slot-${index}`, quota }));

  it("prefers free quota, then credits, then an unanswered probe", () => {
    expect(pickCodexSlot(slots("exhausted", "unknown", "credits", "available")).name).toBe(
      "slot-3"
    );
    expect(pickCodexSlot(slots("unusable", "unknown", "credits")).name).toBe("slot-2");
    expect(pickCodexSlot(slots("unusable", "exhausted", "unknown")).name).toBe("slot-2");
  });

  it("keeps slot order between equal ranks", () => {
    expect(pickCodexSlot(slots("exhausted", "available", "available")).name).toBe("slot-1");
  });
});

describe("selectCodexAuth", () => {
  it("keeps the primary and removes every extra slot when none is usable", async () => {
    process.env.CODEX_AUTH_JSON = rejectedBlob("primary");
    process.env.CODEX_AUTH_JSON_2 = rejectedBlob("two");
    process.env.CODEX_AUTH_JSON_3 = "not json";
    process.env.CODEX_AUTH_JSON_4 = blobWithoutIdToken("four");
    await selectCodexAuth({ requireIdToken: true });
    expect(process.env.CODEX_AUTH_JSON).toBe(rejectedBlob("primary"));
    expect(process.env.CODEX_AUTH_JSON_2).toBeUndefined();
    expect(process.env.CODEX_AUTH_JSON_3).toBeUndefined();
    expect(process.env.CODEX_AUTH_JSON_4).toBeUndefined();
  });

  it("orders slots numerically when there is no primary", async () => {
    process.env.CODEX_AUTH_JSON_10 = rejectedBlob("ten");
    process.env.CODEX_AUTH_JSON_2 = rejectedBlob("two");
    await selectCodexAuth({ requireIdToken: true });
    expect(process.env.CODEX_AUTH_JSON).toBe(rejectedBlob("two"));
    expect(process.env.CODEX_AUTH_JSON_10).toBeUndefined();
    expect(process.env.CODEX_AUTH_JSON_2).toBeUndefined();
  });
});
