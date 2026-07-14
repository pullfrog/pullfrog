import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    exclude: [
      "**/node_modules/**",
      "**/.temp/**",
      "**/.pnpm-store/**",
      "**/.terraform/**",
      // *.main.test.ts files run only on main (e.g. catalog drift against
      // models.dev + OpenRouter). run them via `pnpm test:catalog`, which
      // points at vitest.main.config.ts.
      "**/*.main.test.ts",
    ],
    globalSetup: ["./vitest.global-setup.ts"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
