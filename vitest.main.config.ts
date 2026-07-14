import { defineConfig } from "vitest/config";

// config for main-only tests (see *.main.test.ts). runs the catalog drift
// suite explicitly; the default vitest.config.ts excludes these files so PR
// CI stays unaffected by upstream catalog changes.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.main.test.ts"],
    exclude: ["**/node_modules/**", "**/.temp/**", "**/.pnpm-store/**", "**/.terraform/**"],
    globalSetup: ["./vitest.global-setup.ts"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
