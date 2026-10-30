import { runPullfrogCli } from "../runCli.ts";

await runPullfrogCli({
  cliArgs: ["gha", "token", "--post"],
  swallowErrors: true,
});
