#!/usr/bin/env node
//
// GitHub Actions `post:` entry point — a bootstrap and nothing else. GHA runs
// this file straight from the checked-out action ref, so anything real here is
// frozen forever for SHA-pinned consumers; the cleanup logic ships in the npm
// package and floats with it. Full rationale in wiki/action-bootstrap.md.
//
// Two rules, both load-bearing. Imports stay stdlib-only: a bare specifier
// crashes the post-step with ERR_MODULE_NOT_FOUND after the agent already
// exited 0, which is #815. And the state gate stays, so the runs that rotate
// no credential never pay an npm bootstrap to find that out —
// `STATE_oauth_writeback` is exactly what `core.getState` reads, without
// needing `@actions/core` to resolve. `STATE_subscription_data_dir` is the
// per-run dir a subscription run must not leave behind (#1475).

import { runPullfrogCli } from "./runCli.ts";

if (process.env.STATE_oauth_writeback || process.env.STATE_subscription_data_dir) {
  runPullfrogCli({
    cliArgs: ["gha", "--post"],
    // the workflow is over; a bootstrap failure here must not turn a finished
    // run red. a missed write-back costs one `pullfrog auth codex` re-run.
    swallowErrors: true,
  });
} else {
  // keep this line. it is the only evidence the hook ran at all, so without it
  // a gate that silently stops matching (a renamed state key) is
  // indistinguishable from a run that legitimately had nothing to persist —
  // and the failure surfaces as a dead Codex chain days later.
  console.log("oauth post-hook: no writeback state — skipping");
}
