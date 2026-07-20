import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ANTIGRAVITY_TOKEN_ENV,
  ANTIGRAVITY_TOKEN_REL_PATH,
  installAntigravityAuth,
} from "./antigravityAuth.ts";

const saved = process.env[ANTIGRAVITY_TOKEN_ENV];

beforeEach(() => {
  delete process.env[ANTIGRAVITY_TOKEN_ENV];
});

afterEach(() => {
  if (saved === undefined) delete process.env[ANTIGRAVITY_TOKEN_ENV];
  else process.env[ANTIGRAVITY_TOKEN_ENV] = saved;
});

describe("installAntigravityAuth", () => {
  it("returns null when env is unset", () => {
    const home = mkdtempSync(join(tmpdir(), "agy-auth-"));
    try {
      expect(installAntigravityAuth(home)).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("writes the token file under the isolated home", () => {
    process.env[ANTIGRAVITY_TOKEN_ENV] = "  oauth-token-value  ";
    const home = mkdtempSync(join(tmpdir(), "agy-auth-"));
    try {
      const installed = installAntigravityAuth(home);
      expect(installed).not.toBeNull();
      expect(installed!.tokenPath).toBe(join(home, ANTIGRAVITY_TOKEN_REL_PATH));
      expect(readFileSync(installed!.tokenPath, "utf8")).toBe("oauth-token-value");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
