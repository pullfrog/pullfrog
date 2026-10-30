#!/usr/bin/env node

import { runPullfrogCli } from "./runCli.ts";

await runPullfrogCli({
  cliArgs: ["gha"],
});
