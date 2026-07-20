import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decodeGrokAuthJson,
  GROK_AUTH_JSON_ENV,
  GROK_AUTH_REL_PATH,
  installGrokAuth,
} from "./grokAuth.ts";

const saved = process.env[GROK_AUTH_JSON_ENV];
const sampleJson = '{"tokens":{"access_token":"a","refresh_token":"r"}}';

beforeEach(() => {
  delete process.env[GROK_AUTH_JSON_ENV];
});

afterEach(() => {
  if (saved === undefined) delete process.env[GROK_AUTH_JSON_ENV];
  else process.env[GROK_AUTH_JSON_ENV] = saved;
});

describe("decodeGrokAuthJson", () => {
  it("accepts raw JSON", () => {
    expect(decodeGrokAuthJson(sampleJson)).toBe(sampleJson);
  });

  it("accepts base64-encoded JSON", () => {
    const b64 = Buffer.from(sampleJson, "utf8").toString("base64");
    expect(decodeGrokAuthJson(b64)).toBe(sampleJson);
  });

  it("returns null for non-json garbage", () => {
    expect(decodeGrokAuthJson("not-json-and-not-base64-of-json!!!")).toBeNull();
  });
});

describe("installGrokAuth", () => {
  it("returns null when env is unset", () => {
    const home = mkdtempSync(join(tmpdir(), "grok-auth-"));
    try {
      expect(installGrokAuth(home)).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("writes auth.json from raw JSON secret", () => {
    process.env[GROK_AUTH_JSON_ENV] = sampleJson;
    const home = mkdtempSync(join(tmpdir(), "grok-auth-"));
    try {
      const installed = installGrokAuth(home);
      expect(installed).not.toBeNull();
      expect(installed!.authPath).toBe(join(home, GROK_AUTH_REL_PATH));
      expect(readFileSync(installed!.authPath, "utf8")).toBe(sampleJson);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("writes auth.json from base64 secret", () => {
    process.env[GROK_AUTH_JSON_ENV] = Buffer.from(sampleJson, "utf8").toString("base64");
    const home = mkdtempSync(join(tmpdir(), "grok-auth-"));
    try {
      const installed = installGrokAuth(home);
      expect(installed).not.toBeNull();
      expect(readFileSync(installed!.authPath, "utf8")).toBe(sampleJson);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
