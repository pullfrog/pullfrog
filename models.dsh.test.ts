import { describe, expect, it } from "vitest";
import { dshProviderForModel, isDshCompatibleModel, realProvider } from "./models.ts";

describe("realProvider / isDshCompatibleModel — openrouter tilde rolling pointer", () => {
  it("unwraps openrouter/~<provider>/* to the inner provider", () => {
    expect(realProvider("openrouter/~deepseek/deepseek-v4-flash-latest")).toBe("deepseek");
    expect(realProvider("openrouter/~anthropic/claude-opus-latest")).toBe("anthropic");
    expect(realProvider("openrouter/deepseek/deepseek-v4-pro-0813")).toBe("deepseek");
    expect(realProvider("deepseek/deepseek-v4-flash")).toBe("deepseek");
  });

  it("marks tilde and non-tilde deepseek models dsh-capable, others not", () => {
    expect(isDshCompatibleModel("openrouter/~deepseek/deepseek-v4-flash-latest")).toBe(true);
    expect(isDshCompatibleModel("openrouter/deepseek/deepseek-v4-pro-0813")).toBe(true);
    expect(isDshCompatibleModel("deepseek/deepseek-v4-pro")).toBe(true);
    expect(isDshCompatibleModel("openrouter/~anthropic/claude-opus-latest")).toBe(false);
    expect(isDshCompatibleModel("google/gemini-3.6-flash")).toBe(false);
  });

  it("maps direct deepseek to deepseek-official and openrouter to openrouter", () => {
    expect(dshProviderForModel("deepseek/deepseek-v4-flash")).toBe("deepseek-official");
    expect(dshProviderForModel("openrouter/~deepseek/deepseek-v4-flash-latest")).toBe("openrouter");
  });
});
