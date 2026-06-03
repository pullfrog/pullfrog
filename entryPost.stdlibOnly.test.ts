import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The GHA `post:` hook runs `node action/entryPost.ts` directly against the
// rsynced action checkout, which deliberately excludes `node_modules`. Any
// non-relative / non-`node:` import in entryPost.ts (or in its transitive
// imports) crashes the post-step with `ERR_MODULE_NOT_FOUND` AFTER the agent
// already exited 0, flipping the workflow to `failure`. see #834.
//
// This test parses the static-import graph rooted at entryPost.ts and refuses
// any specifier that isn't one of:
//   - node:* (stdlib)
//   - ./* or ../* (relative)
//
// Any other specifier (`@actions/core`, `pullfrog`, `zod`, etc.) means the
// post-hook will need a `node_modules` tree the rsync drops.

const ENTRY_FILE = resolve(import.meta.dirname, "entryPost.ts");

const IMPORT_RE = /^\s*(?:import|export)(?:\s+(?:type\s+)?[\s\S]*?)?\s+from\s+["']([^"']+)["']/gm;
const SIDE_EFFECT_RE = /^\s*import\s+["']([^"']+)["']/gm;
// `import.meta.glob` and friends are not used in entryPost.ts; the simple
// regex above is sufficient here. expand if a transitive dep starts using
// dynamic imports for stdlib-only logic.

function extractImports(filePath: string): string[] {
  const source = readFileSync(filePath, "utf8");
  const specs: string[] = [];
  for (const re of [IMPORT_RE, SIDE_EFFECT_RE]) {
    re.lastIndex = 0;
    for (const m of source.matchAll(re)) specs.push(m[1]);
  }
  return specs;
}

function isAllowed(spec: string): boolean {
  return spec.startsWith("node:") || spec.startsWith("./") || spec.startsWith("../");
}

type WalkResult = {
  visited: Set<string>;
  violations: { file: string; spec: string }[];
};

function walk(start: string): WalkResult {
  const visited = new Set<string>();
  const violations: WalkResult["violations"] = [];
  const queue: string[] = [start];

  while (queue.length > 0) {
    const file = queue.shift()!;
    if (visited.has(file)) continue;
    visited.add(file);

    for (const spec of extractImports(file)) {
      if (!isAllowed(spec)) {
        violations.push({ file, spec });
        continue;
      }
      if (spec.startsWith("node:")) continue;
      const resolved = resolve(dirname(file), spec);
      const candidate = resolved.endsWith(".ts") ? resolved : `${resolved}.ts`;
      try {
        readFileSync(candidate, "utf8");
        queue.push(candidate);
      } catch {
        // non-.ts (e.g. JSON `with { type: "json" }`) — already classified
        // as relative-allowed above. nothing further to walk.
      }
    }
  }
  return { visited, violations };
}

describe("entryPost.ts stdlib-only invariant (#834)", () => {
  it("only imports node: builtins and relative siblings (no node_modules deps)", () => {
    const result = walk(ENTRY_FILE);
    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
  });

  it("walks the full transitive graph (entryPost + 3 utils)", () => {
    const result = walk(ENTRY_FILE);
    expect(result.visited.size).toBeGreaterThanOrEqual(4);
  });

  it("matches the modules entryPost actually imports today", () => {
    const direct = extractImports(ENTRY_FILE).sort();
    expect(direct).toEqual([
      "./utils/codexRefreshDetect.ts",
      "./utils/ghaCore.ts",
      "./utils/managedAuthState.ts",
      "./utils/postApiFetch.ts",
      "node:fs",
    ]);
  });
});
