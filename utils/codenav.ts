/**
 * puts `codenav` on the shell's PATH. the CLI (`codenavCli.ts`) runs one process per query in the
 * agent's own sandbox, so nothing here outlives the call that installs it. see wiki/codenav.md.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./cli.ts";
import { packageManagerBinDir } from "./packageManager.ts";

/**
 * the pm-bin dir is on PATH and read-only inside the sandbox (shimMount), so the agent cannot swap in
 * a `codenav` that a later unsandboxed spawn would resolve. the cache, where the CLI installs
 * TypeScript or jedi on first use and logs each call, is the agent's to write.
 */
export function installCodenav(tmpdir: string): void {
  const binDir = packageManagerBinDir(tmpdir);
  mkdirSync(binDir, { recursive: true });
  const source = resolveCli();
  const cli = join(binDir, `codenav${extname(source)}`);
  copyFileSync(source, cli);
  const cache = join(tmpdir, "codenav");
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, "calls"), "");
  const shim = join(binDir, "codenav");
  writeFileSync(
    shim,
    `#!/bin/sh\nCODENAV_CACHE=${quote(cache)} exec node --disable-warning=ExperimentalWarning ${quote(cli)} "$@"\n`
  );
  chmodSync(shim, 0o755);
  if (!process.env.PATH?.split(delimiter).includes(binDir)) {
    process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
  }
  log.info("» codenav on PATH");
}

/** the run log's record of how the agent used it, which is the `codenav` rollout's evidence */
export function logCodenavCalls(tmpdir: string): void {
  const file = join(tmpdir, "codenav", "calls");
  if (!existsSync(file)) return;
  const calls = readFileSync(file, "utf8").split("\n").filter(Boolean);
  log.info(`» codenav: ${calls.length} call(s)${calls.length ? `: ${calls.join("; ")}` : ""}`);
}

/** `dist/codenav.mjs` when published; the TypeScript source when run from source, which node strips */
function resolveCli(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "codenav.mjs"), join(here, "..", "codenavCli.ts")];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`codenav CLI not found (looked in ${candidates.join(", ")})`);
  return found;
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
