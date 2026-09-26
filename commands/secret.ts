import * as p from "@clack/prompts";
import arg from "arg";
import { z } from "zod";
import {
  configurationApi,
  confirmChange,
  readValueFile,
  resolveTarget,
  scopeArgs,
  targetName,
} from "./_configuration.ts";
import { CODEX_AUTH_SECRET, SUBSCRIPTION_SECRET_NAMES, shadowRefusal } from "./_shared.ts";

export const secretNamesSchema = z.object({
  target: z.string(),
  secrets: z.array(z.string()),
  inherited: z.array(z.string()),
  // `.default([])` so a CLI newer than its server — a preview deployment, a self-hosted
  // install — keeps working: every command parses this shape, not just `auth`.
  overrides: z.array(z.object({ name: z.string(), repo: z.string() })).default([]),
  writable: z.boolean(),
});

export async function runCli(input: { args: string[]; prog: string; showHelp?: boolean }) {
  const args = arg({ ...scopeArgs, "--file": String, "--yes": Boolean }, { argv: input.args });
  if (input.showHelp || args["--help"] || !args._.length) {
    console.log(`usage: ${input.prog} secret <list|set|delete> [NAME...]

  list                 list Pullfrog-stored secret names, never values
  set NAME [NAME...]    prompt for masked values; save the group together
  delete NAME          remove a secret from the selected scope

  --repo, -R OWNER/REPO   select a repository (default: GitHub origin)
  --org OWNER            select shared organization or personal-account secrets
  --file PATH            value for one secret; - reads stdin
  --yes                  acknowledge deleting a secret

values are never accepted as command arguments or printed.
use auth codex, auth claude or auth grok for subscription credentials.`);
    return;
  }
  const command = args._[0];
  const names = args._.slice(1);
  if (!["list", "set", "delete"].includes(command))
    throw new Error("expected secret list, set or delete");
  if (names.some((name) => !/^[A-Z][A-Z0-9_]{0,63}$/.test(name)))
    throw new Error(
      "secret names must be uppercase alphanumeric with underscores, max 64 characters"
    );
  if (new Set(names).size !== names.length) throw new Error("duplicate secret name");
  const target = resolveTarget({ org: args["--org"], repo: args["--repo"] });
  const data = secretNamesSchema.parse(await configurationApi({ target, path: "credentials" }));
  if (command === "list") {
    if (names.length || args["--file"] !== undefined) throw new Error("usage: secret list");
    console.log(data.target);
    for (const name of data.secrets) console.log(`${name}  [${target.repo ? "repo" : "org"}]`);
    for (const name of data.inherited)
      console.log(`${name}  [org${data.secrets.includes(name) ? ", overridden" : ", inherited"}]`);
    if (!data.secrets.length && !data.inherited.length) console.log("no Pullfrog-stored secrets");
    return;
  }
  if (!data.writable)
    throw new Error(
      target.repo ? "repo admin required to change secrets" : "org owner required to change secrets"
    );
  if (command === "delete") {
    if (names.length !== 1 || args["--file"] !== undefined)
      throw new Error("usage: secret delete NAME");
    if (!data.secrets.includes(names[0])) {
      throw new Error(
        `secret is not stored on ${data.target}${target.repo && data.inherited.includes(names[0]) ? "; use --org to manage the inherited secret" : ""}`
      );
    }
    await confirmChange({
      message: `${targetName(target)}: delete ${names[0]}${target.repo && data.inherited.includes(names[0]) ? " (the org credential will apply instead)" : ""}`,
      yes: args["--yes"] === true,
    });
    await configurationApi({
      target,
      path: "credentials",
      method: "DELETE",
      body: { name: names[0], confirmed: true },
    });
  } else {
    if (!names.length || names.length > 64) throw new Error("usage: secret set NAME [NAME...]");
    const file = args["--file"];
    if (file !== undefined && names.length !== 1)
      throw new Error("--file requires exactly one secret name");
    if (file === undefined && !process.stdin.isTTY)
      throw new Error("use --file PATH or --file - without a terminal");
    // the other door to the same account-level write `auth` guards. checked before any value
    // is prompted for, so nobody types a credential that would land in a shadow.
    const guarded = names.filter(
      (secret) =>
        SUBSCRIPTION_SECRET_NAMES.includes(secret) || secret.startsWith(`${CODEX_AUTH_SECRET}_`)
    );
    for (const name of guarded) {
      const refusal = shadowRefusal({ overrides: data.overrides, owner: target.owner, name });
      if (refusal) throw new Error(refusal);
    }
    const slot = names.find((name) => name.startsWith(`${CODEX_AUTH_SECRET}_`));
    if (slot && ![...names, ...data.secrets, ...data.inherited].includes(CODEX_AUTH_SECRET))
      throw new Error(
        `${slot} adds to ${CODEX_AUTH_SECRET}, which is not saved here. save ${CODEX_AUTH_SECRET} first.`
      );
    const secrets: { name: string; value: string }[] = [];
    for (const name of names) {
      const value =
        file === undefined
          ? await p.password({
              message: `${data.target}: ${name}${data.secrets.includes(name) ? " (replace)" : ""}`,
            })
          : await readValueFile(file);
      if (p.isCancel(value)) throw new Error("canceled; nothing changed");
      if (!value.trim() || Buffer.byteLength(value.trim(), "utf8") > 49152)
        throw new Error("secret must contain 1..49152 bytes");
      secrets.push({ name, value });
    }
    await configurationApi({ target, path: "credentials", method: "PUT", body: { secrets } });
  }
  console.log(`${data.target}: ${names.join(", ")} ${command === "delete" ? "deleted" : "saved"}`);
}
