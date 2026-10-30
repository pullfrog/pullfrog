// @ts-check

import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));

rmSync("./dist", { recursive: true, force: true });
mkdirSync("./dist", { recursive: true });

// Plugin to strip shebangs from output files
/**
 * @type {import("esbuild").Plugin}
 */
const stripShebangPlugin = {
  name: "strip-shebang",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;

      // Strip shebang from the output file
      const outputFile = build.initialOptions.outfile;
      if (outputFile) {
        try {
          const content = readFileSync(outputFile, "utf8");
          // Remove shebang line from the beginning if present
          const withoutShebang = content.startsWith("#!")
            ? content.slice(content.indexOf("\n") + 1)
            : content;
          writeFileSync(outputFile, withoutShebang);
        } catch (error) {
          // File might not exist, ignore
        }
      }
    });
  },
};

/**
 * @type {import("esbuild").BuildOptions}
 */
const sharedConfig = {
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  minify: false,
  sourcemap: false,
  // Bundle all dependencies - GitHub Actions doesn't have node_modules
  // Only mark optional peer dependencies as external
  external: [
    "@valibot/to-json-schema",
    "effect",
    "sury",
  ],
  // Provide a proper require shim for CommonJS modules bundled into ESM
  // We use a unique variable name to avoid conflicts with bundled imports
  banner: {
    js: `import { createRequire as __createRequire } from 'module'; import { fileURLToPath as __fileURLToPath } from 'url'; import { dirname as __dirnameFn } from 'path'; const require = __createRequire(import.meta.url); const __filename = __fileURLToPath(import.meta.url); const __dirname = __dirnameFn(__filename);`,
  },
  // Enable tree-shaking to remove unused code
  treeShaking: true,
  // Drop console statements in production (but keep for debugging)
  drop: [],
};

// Build the CLI bundle (published to npm, used by npx)
await build({
  ...sharedConfig,
  entryPoints: ["./cli.ts"],
  outfile: "./dist/cli.mjs",
  target: "node20",
  plugins: [stripShebangPlugin],
  define: {
    "process.env.CLI_VERSION": JSON.stringify(pkg.version),
  },
});

// the codenav CLI runs as its own process in the agent's sandbox; utils/codenav.ts copies it onto PATH
await build({
  ...sharedConfig,
  entryPoints: ["./codenavCli.ts"],
  outfile: "./dist/codenav.mjs",
  target: "node20",
});

// Build ESM library entrypoints for programmatic imports
await build({
  ...sharedConfig,
  entryPoints: ["./index.ts"],
  outfile: "./dist/index.js",
  target: "node20",
});

await build({
  ...sharedConfig,
  entryPoints: ["./internal/index.ts"],
  outfile: "./dist/internal.js",
  target: "node20",
});

// prepend shebang after strip (esbuild banner can't guarantee line 1 placement)
const cliPath = "./dist/cli.mjs";
const cliContent = readFileSync(cliPath, "utf8");
writeFileSync(cliPath, `#!/usr/bin/env node\n${cliContent}`);

// copy bundled SKILL.md files into dist/ so the npm-published runtime can read
// them via readFileSync. source-mode runs (PULLFROG_FORCE_LOCAL_CLI=1) read
// directly from action/skills/ instead. see utils/skills.ts.
cpSync("./skills", "./dist/skills", { recursive: true });

console.log("» build completed successfully");
