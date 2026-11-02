import { describe, expect, it } from "vitest";
import { checkoutPrBranch, type PrData } from "./checkout.ts";
import {
  AUTH_REQUIRED_REDIRECT,
  DeleteBranchTool,
  NOSHELL_BLOCKED_ARGS,
  NOSHELL_BLOCKED_SUBCOMMANDS,
  rejectIfLeadingDash,
  rejectSpecialRef,
  validateTagName,
} from "./git.ts";
import type { ToolContext } from "./server.ts";

// ─── git tool security tests ────────────────────────────────────────────
//
// the validation function below mirrors the logic in GitTool.execute, but
// imports the AUTH/NOSHELL tables directly from git.ts so tests don't silently
// drift if the runtime messages are edited. if the *algorithm* in git.ts
// changes, validateGitCommand needs to be updated here too.

type ShellPermission = "disabled" | "restricted" | "enabled";

type ValidateGitParams = {
  command: string;
  args: string[];
  shellPermission: ShellPermission;
};

// matches the arkregex pattern used in the Git schema
const SUBCOMMAND_PATTERN = /^[a-z][a-z0-9-]*$/;

// mirrors the validation logic in GitTool.execute
function validateGitCommand(params: ValidateGitParams): string | null {
  // schema-level regex validation — applies in ALL modes
  if (!SUBCOMMAND_PATTERN.test(params.command)) {
    return `command must be Git subcommand (was "${params.command}")`;
  }

  const redirect = AUTH_REQUIRED_REDIRECT[params.command];
  if (redirect) {
    return `git ${params.command} requires authentication. ${redirect}`;
  }

  // subcommand and arg blocking only applies when shell is disabled
  if (params.shellPermission === "disabled") {
    const blocked = NOSHELL_BLOCKED_SUBCOMMANDS[params.command];
    if (blocked) {
      return blocked;
    }

    for (const arg of params.args) {
      const isBlocked = NOSHELL_BLOCKED_ARGS.some(
        (flag) => arg === flag || arg.startsWith(flag + "=")
      );
      if (isBlocked) {
        return `Blocked: '${arg}' flag can execute arbitrary code and is not allowed.`;
      }
    }
  }

  return null; // no error
}

describe("git tool security - subcommand regex validation", () => {
  it("blocks -c flag as subcommand in ALL modes (alias injection)", () => {
    const modes: ShellPermission[] = ["disabled", "restricted", "enabled"];
    for (const mode of modes) {
      const error = validateGitCommand({
        command: "-c",
        args: ["alias.x=!evil-command", "x"],
        shellPermission: mode,
      });
      expect(error).toContain("Git subcommand");
    }
  });

  it("blocks --exec-path as subcommand", () => {
    const error = validateGitCommand({
      command: "--exec-path=/malicious",
      args: ["status"],
      shellPermission: "disabled",
    });
    expect(error).toContain("Git subcommand");
  });

  it("blocks -C as subcommand (change directory)", () => {
    const error = validateGitCommand({
      command: "-C",
      args: ["/tmp", "init"],
      shellPermission: "disabled",
    });
    expect(error).toContain("Git subcommand");
  });

  it("blocks --config-env as subcommand", () => {
    const error = validateGitCommand({
      command: "--config-env",
      args: ["core.pager=PATH", "log"],
      shellPermission: "disabled",
    });
    expect(error).toContain("Git subcommand");
  });

  it("blocks all flags starting with - as subcommand", () => {
    const flags = ["-c", "-C", "-p", "--paginate", "--git-dir", "--work-tree", "--bare"];
    for (const flag of flags) {
      const error = validateGitCommand({
        command: flag,
        args: [],
        shellPermission: "disabled",
      });
      expect(error).toContain("Git subcommand");
    }
  });

  it("blocks uppercase subcommands", () => {
    const error = validateGitCommand({
      command: "STATUS",
      args: [],
      shellPermission: "disabled",
    });
    expect(error).toContain("Git subcommand");
  });

  it("blocks subcommands with special characters", () => {
    const bad = ["git;evil", "status$(cmd)", "log|cat", "diff&bg"];
    for (const sub of bad) {
      const error = validateGitCommand({
        command: sub,
        args: [],
        shellPermission: "disabled",
      });
      expect(error).toContain("Git subcommand");
    }
  });

  it("allows valid subcommands", () => {
    const safe = ["status", "log", "diff", "show", "branch", "tag", "stash", "blame"];
    for (const sub of safe) {
      const error = validateGitCommand({
        command: sub,
        args: [],
        shellPermission: "disabled",
      });
      expect(error).toBeNull();
    }
  });

  it("allows hyphenated subcommands", () => {
    const safe = ["filter-branch", "update-index", "ls-remote", "ls-files", "rev-parse"];
    for (const sub of safe) {
      const error = validateGitCommand({
        command: sub,
        args: [],
        shellPermission: "enabled",
      });
      expect(error).toBeNull();
    }
  });
});

describe("git tool security - blocked subcommands (disabled mode only)", () => {
  it("blocks config in disabled mode", () => {
    const error = validateGitCommand({
      command: "config",
      args: ["core.hooksPath", "./hooks"],
      shellPermission: "disabled",
    });
    expect(error).toContain("git config");
  });

  it("allows config in restricted mode (agent has shell)", () => {
    const error = validateGitCommand({
      command: "config",
      args: ["filter.evil.clean", "bash -c 'evil'"],
      shellPermission: "restricted",
    });
    expect(error).toBeNull();
  });

  it("blocks submodule in disabled mode", () => {
    const error = validateGitCommand({
      command: "submodule",
      args: ["add", "https://evil.com/repo.git"],
      shellPermission: "disabled",
    });
    expect(error).toContain("submodule");
  });

  it("allows submodule in restricted mode", () => {
    const error = validateGitCommand({
      command: "submodule",
      args: ["add", "https://example.com/repo.git"],
      shellPermission: "restricted",
    });
    expect(error).toBeNull();
  });

  it("blocks rebase in disabled mode", () => {
    const error = validateGitCommand({
      command: "rebase",
      args: ["--exec", "evil-command", "HEAD~1"],
      shellPermission: "disabled",
    });
    expect(error).toContain("rebase");
  });

  it("allows rebase in restricted mode", () => {
    const error = validateGitCommand({
      command: "rebase",
      args: ["main"],
      shellPermission: "restricted",
    });
    expect(error).toBeNull();
  });

  it("blocks bisect in disabled mode", () => {
    const error = validateGitCommand({
      command: "bisect",
      args: ["run", "evil-command"],
      shellPermission: "disabled",
    });
    expect(error).toContain("bisect");
  });

  it("blocks filter-branch in disabled mode", () => {
    const error = validateGitCommand({
      command: "filter-branch",
      args: ["--tree-filter", "evil-command", "HEAD"],
      shellPermission: "disabled",
    });
    expect(error).toContain("filter-branch");
  });

  // regression: NOSHELL_BLOCKED_ARGS matches only the long `--extcmd` /
  // `--extcmd=...` forms. `git difftool -x <cmd>` is the short form and
  // slipped through — verified executing a canary via
  // `yes | git difftool -x 'echo PWN' HEAD~1 HEAD` on a real repo.
  // globally blocking `-x` would false-positive on `git cherry-pick -x`
  // (a metadata-appending flag, not code exec), so difftool is blocked
  // at the subcommand level instead.
  it("blocks difftool in disabled mode (closes -x short-form bypass)", () => {
    const error = validateGitCommand({
      command: "difftool",
      args: ["-x", "evil-command", "HEAD~1", "HEAD"],
      shellPermission: "disabled",
    });
    expect(error).toContain("difftool");
  });

  it("blocks difftool even with --extcmd long form (subcommand-level stops it first)", () => {
    const error = validateGitCommand({
      command: "difftool",
      args: ["--extcmd=evil-command", "HEAD"],
      shellPermission: "disabled",
    });
    expect(error).toContain("difftool");
  });

  it("blocks mergetool in disabled mode (configured tool commands execute code)", () => {
    const error = validateGitCommand({
      command: "mergetool",
      args: [],
      shellPermission: "disabled",
    });
    expect(error).toContain("mergetool");
  });

  it("allows blocked subcommands in enabled mode", () => {
    const blocked = [
      "config",
      "submodule",
      "rebase",
      "bisect",
      "filter-branch",
      "difftool",
      "mergetool",
    ];
    for (const sub of blocked) {
      const error = validateGitCommand({
        command: sub,
        args: [],
        shellPermission: "enabled",
      });
      expect(error).toBeNull();
    }
  });

  it("allows blocked subcommands in restricted mode (stripped env is security boundary)", () => {
    const blocked = [
      "config",
      "submodule",
      "rebase",
      "bisect",
      "filter-branch",
      "difftool",
      "mergetool",
    ];
    for (const sub of blocked) {
      const error = validateGitCommand({
        command: sub,
        args: [],
        shellPermission: "restricted",
      });
      expect(error).toBeNull();
    }
  });
});

describe("git tool security - blocked arg flags (disabled mode only)", () => {
  it("blocks --exec in args (disabled)", () => {
    const error = validateGitCommand({
      command: "log",
      args: ["--exec", "evil-command"],
      shellPermission: "disabled",
    });
    expect(error).toContain("arbitrary code");
  });

  it("blocks --exec= in args (disabled)", () => {
    const error = validateGitCommand({
      command: "log",
      args: ["--exec=evil-command"],
      shellPermission: "disabled",
    });
    expect(error).toContain("arbitrary code");
  });

  it("blocks --extcmd in args (disabled) — on a subcommand that isn't blocked at the subcommand level", () => {
    // difftool itself is now blocked at the subcommand level (closes the `-x`
    // short-form bypass), so the arg-level check never runs for difftool in
    // disabled mode. use `log --extcmd=...` to exercise the arg-level code
    // path: `log` isn't in NOSHELL_BLOCKED_SUBCOMMANDS, so validation falls
    // through to the arg scan and the --extcmd block triggers.
    const error = validateGitCommand({
      command: "log",
      args: ["--extcmd=evil-command", "HEAD~1"],
      shellPermission: "disabled",
    });
    expect(error).toContain("arbitrary code");
  });

  it("blocks --upload-pack in args (disabled)", () => {
    const error = validateGitCommand({
      command: "ls-remote",
      args: ["--upload-pack=evil"],
      shellPermission: "disabled",
    });
    expect(error).toContain("arbitrary code");
  });

  it("allows --exec in restricted mode (agent has shell)", () => {
    const error = validateGitCommand({
      command: "rebase",
      args: ["--exec", "npm test", "HEAD~1"],
      shellPermission: "restricted",
    });
    expect(error).toBeNull();
  });

  it("allows --extcmd in restricted mode", () => {
    const error = validateGitCommand({
      command: "difftool",
      args: ["--extcmd=less"],
      shellPermission: "restricted",
    });
    expect(error).toBeNull();
  });

  it("allows blocked args in enabled mode", () => {
    const error = validateGitCommand({
      command: "difftool",
      args: ["--extcmd=less"],
      shellPermission: "enabled",
    });
    expect(error).toBeNull();
  });

  it("allows normal args in disabled mode", () => {
    const error = validateGitCommand({
      command: "log",
      args: ["--oneline", "-10", "--format=%H %s"],
      shellPermission: "disabled",
    });
    expect(error).toBeNull();
  });

  it("does not false-positive on --exclude-standard (not --exec)", () => {
    const error = validateGitCommand({
      command: "ls-files",
      args: ["--exclude-standard"],
      shellPermission: "disabled",
    });
    expect(error).toBeNull();
  });

  it("does not false-positive on --execute (not --exec=)", () => {
    const error = validateGitCommand({
      command: "log",
      args: ["--execute-something"],
      shellPermission: "disabled",
    });
    expect(error).toBeNull();
  });

  it("does not false-positive on -c (combined diff format for git log)", () => {
    const error = validateGitCommand({
      command: "log",
      args: ["-c", "--oneline"],
      shellPermission: "disabled",
    });
    expect(error).toBeNull();
  });
});

describe("git tool security - auth redirect", () => {
  it("redirects push in all modes", () => {
    const modes: ShellPermission[] = ["disabled", "restricted", "enabled"];
    for (const mode of modes) {
      const error = validateGitCommand({
        command: "push",
        args: [],
        shellPermission: mode,
      });
      expect(error).toContain("authentication");
    }
  });

  it("redirects fetch", () => {
    const error = validateGitCommand({
      command: "fetch",
      args: [],
      shellPermission: "enabled",
    });
    expect(error).toContain("authentication");
  });

  it("redirects pull", () => {
    const error = validateGitCommand({
      command: "pull",
      args: [],
      shellPermission: "enabled",
    });
    expect(error).toContain("authentication");
  });

  it("pull redirect recommends merge (not rebase) regardless of shell mode", () => {
    // F5 regression: the redirect previously suggested "or 'rebase' unless
    // shell is disabled", which was misleading noise under shell=disabled
    // (rebase is blocked by NOSHELL_BLOCKED_SUBCOMMANDS there) and redundant
    // under other modes (agents can invoke rebase directly if they want).
    // the current redirect names only merge — the one alternative that
    // works in every shell mode.
    for (const mode of ["disabled", "restricted", "enabled"] as ShellPermission[]) {
      const error = validateGitCommand({
        command: "pull",
        args: [],
        shellPermission: mode,
      });
      expect(error).toContain("merge");
      expect(error).not.toMatch(/rebase/i);
    }
  });

  it("redirects clone", () => {
    const error = validateGitCommand({
      command: "clone",
      args: [],
      shellPermission: "enabled",
    });
    expect(error).toContain("authentication");
  });
});

// ─── dependency install security tests ──────────────────────────────────

// mirrors the logic in dependencies.ts startInstallation()
function shouldIgnoreScripts(shellPermission: ShellPermission): boolean {
  return shellPermission === "disabled";
}

describe("git tool security - rejectIfLeadingDash", () => {
  it("rejects refs starting with --", () => {
    expect(() => rejectIfLeadingDash("--upload-pack=evil", "ref")).toThrow(
      /Blocked: ref '--upload-pack=evil' starts with '-'/
    );
  });

  it("rejects refs starting with a single -", () => {
    expect(() => rejectIfLeadingDash("-c", "ref")).toThrow(/starts with '-'/);
  });

  it("allows normal branch names", () => {
    expect(() => rejectIfLeadingDash("main", "ref")).not.toThrow();
    expect(() => rejectIfLeadingDash("feature/foo", "ref")).not.toThrow();
    expect(() => rejectIfLeadingDash("pull/123/head", "ref")).not.toThrow();
    expect(() => rejectIfLeadingDash("release-1.2", "ref")).not.toThrow();
  });

  it("allows branch names containing dashes (not leading)", () => {
    expect(() => rejectIfLeadingDash("feat-x", "branchName")).not.toThrow();
  });

  it("customizes the kind label in the error", () => {
    expect(() => rejectIfLeadingDash("-evil", "branchName")).toThrow(/branchName '-evil'/);
  });
});

describe("git tool security - rejectSpecialRef (default-branch bypass)", () => {
  // an agent in restricted mode normally can't push to the default branch —
  // PushBranchTool compares the resolved remoteBranch against defaultBranch
  // and blocks the match. before this guard, passing `branchName:
  // "refs/heads/main"` bypassed the check (the exact-string compare fails
  // because "refs/heads/main" !== "main") while git still pushed to main.
  it("rejects fully-qualified refs/heads/... branch names", () => {
    expect(() => rejectSpecialRef("refs/heads/main", "branch")).toThrow(/fully-qualified ref path/);
    expect(() => rejectSpecialRef("refs/heads/feature/foo", "branch")).toThrow(
      /fully-qualified ref path/
    );
  });

  it("rejects refs/tags/... and refs/remotes/... forms too", () => {
    // push_branch only pushes branches, so every refs/-prefixed form is
    // illegitimate here — no need to whitelist refs/heads/ alone.
    expect(() => rejectSpecialRef("refs/tags/v1", "branch")).toThrow(/fully-qualified ref path/);
    expect(() => rejectSpecialRef("refs/remotes/origin/main", "branch")).toThrow(
      /fully-qualified ref path/
    );
  });

  it("rejects symbolic refs that resolve to arbitrary commits", () => {
    // `git push origin HEAD` and friends pick up whatever commit those refs
    // point at — not what the agent named, and not constrained by the
    // default-branch guard either.
    for (const ref of ["HEAD", "FETCH_HEAD", "ORIG_HEAD", "MERGE_HEAD"]) {
      expect(() => rejectSpecialRef(ref, "branch")).toThrow(/symbolic ref/);
    }
  });

  it("still rejects leading-dash (inherits rejectIfLeadingDash)", () => {
    expect(() => rejectSpecialRef("-evil", "branch")).toThrow(/starts with '-'/);
  });

  it("allows bare branch names including ones with slashes", () => {
    for (const b of ["main", "pr-123", "feature/foo", "release/v2", "user/name/topic"]) {
      expect(() => rejectSpecialRef(b, "branch")).not.toThrow();
    }
  });

  // refspec syntax: git push accepts `[+]src[:dst]`. without these checks an
  // agent under push:restricted smuggles a full refspec through branchName,
  // and the downstream exact-string default-branch guard misses because the
  // value isn't literally "main". these are the exact attacks the new
  // rejection closes.
  it("rejects ':' (refspec src:dst split that targets main)", () => {
    expect(() => rejectSpecialRef("evil:refs/heads/main", "branch")).toThrow(
      /refspec\/revision syntax/
    );
  });

  it("rejects leading ':' (delete-ref refspec deletes remote main)", () => {
    expect(() => rejectSpecialRef(":refs/heads/main", "branch")).toThrow(
      /refspec\/revision syntax/
    );
  });

  it("rejects leading '+' (force-push refspec prefix)", () => {
    expect(() => rejectSpecialRef("+main", "branch")).toThrow(/refspec\/revision syntax/);
  });

  it("rejects '~' and '^' (revision modifiers that resolve to parents)", () => {
    expect(() => rejectSpecialRef("main~1", "branch")).toThrow(/refspec\/revision syntax/);
    expect(() => rejectSpecialRef("main^", "branch")).toThrow(/refspec\/revision syntax/);
  });

  it("rejects whitespace (not permitted in git branch names)", () => {
    expect(() => rejectSpecialRef("main other", "branch")).toThrow(/refspec\/revision syntax/);
    expect(() => rejectSpecialRef("foo\tbar", "branch")).toThrow(/refspec\/revision syntax/);
  });

  it("rejects shell/glob metacharacters forbidden in branch names", () => {
    for (const b of ["main?", "main*", "main[", "main\\x"]) {
      expect(() => rejectSpecialRef(b, "branch")).toThrow(/refspec\/revision syntax/);
    }
  });
});

describe("git tool security - validateTagName (push_tags refspec injection)", () => {
  it("rejects tags containing ':' (refspec src:dst split)", () => {
    // without this, "foo:refs/heads/main" would push the local refs/tags/foo's
    // commit to remote main and bypass the push_branch default-branch guard.
    expect(() => validateTagName("foo:refs/heads/main")).toThrow(/could be parsed as a refspec/);
    expect(() => validateTagName("v1.0:bar")).toThrow(/refspec/);
  });

  it("rejects tags with leading '-' (flag injection)", () => {
    expect(() => validateTagName("-c")).toThrow(/starts with '-'/);
    expect(() => validateTagName("--upload-pack=evil")).toThrow(/starts with '-'/);
  });

  it("rejects tags with whitespace or control chars", () => {
    expect(() => validateTagName("foo bar")).toThrow(/could be parsed/);
    expect(() => validateTagName("foo\nrefs/heads/main")).toThrow(/could be parsed/);
  });

  it("rejects tags with shell / refspec metacharacters", () => {
    const bad = ["foo~1", "foo^", "foo?", "foo*", "foo[", "foo\\bar", "foo;evil"];
    for (const t of bad) {
      expect(() => validateTagName(t)).toThrow(/could be parsed/);
    }
  });

  it("allows plausible tag names", () => {
    const ok = ["v1.0.0", "release-2024-01", "feature/thing", "v1", "hotfix_1"];
    for (const t of ok) {
      expect(() => validateTagName(t)).not.toThrow();
    }
  });

  it("rejects empty tag", () => {
    expect(() => validateTagName("")).toThrow(/could be parsed/);
  });
});

describe("DeleteBranchTool - default-branch guard", () => {
  // push: enabled authorizes pushes — not wholesale removal of the repo's
  // primary branch. GitHub branch protection usually blocks this at the
  // remote, but not every repo has protection on, so guard locally too.
  function makeCtx(defaultBranch: string): ToolContext {
    return {
      payload: { push: "enabled" },
      repo: { defaultBranch },
      gitToken: "test-token",
    } as unknown as ToolContext;
  }

  it("blocks deletion of the default branch even with push: enabled", async () => {
    const tool = DeleteBranchTool(makeCtx("main"));
    const result = (await (tool.execute as (p: unknown, ctx: unknown) => Promise<unknown>)(
      { branchName: "main" },
      {} as Parameters<NonNullable<typeof tool.execute>>[1]
    )) as { content: [{ text: string }]; isError?: boolean };
    /* cast: FastMCP execute returns a union of content shapes; these tests
       always return the handleToolError envelope, which matches this shape. */
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/default branch/i);
  });

  it("honors the repo's actual default branch name (not just 'main')", async () => {
    const tool = DeleteBranchTool(makeCtx("trunk"));
    const result = (await (tool.execute as (p: unknown, ctx: unknown) => Promise<unknown>)(
      { branchName: "trunk" },
      {} as Parameters<NonNullable<typeof tool.execute>>[1]
    )) as { content: [{ text: string }]; isError?: boolean };
    /* cast: FastMCP execute returns a union of content shapes; these tests
       always return the handleToolError envelope, which matches this shape. */
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/default branch 'trunk'/);
  });

  it("still blocks when the agent tries the refs/heads/... bypass", async () => {
    // rejectSpecialRef catches this before the default-branch check, but the
    // test asserts the chain stops it — either error is acceptable, just not
    // a successful delete.
    const tool = DeleteBranchTool(makeCtx("main"));
    const result = (await (tool.execute as (p: unknown, ctx: unknown) => Promise<unknown>)(
      { branchName: "refs/heads/main" },
      {} as Parameters<NonNullable<typeof tool.execute>>[1]
    )) as { content: [{ text: string }]; isError?: boolean };
    /* cast: FastMCP execute returns a union of content shapes; these tests
       always return the handleToolError envelope, which matches this shape. */
    expect(result.isError).toBe(true);
  });
});

describe("git tool security - checkoutPrBranch rejects malicious PR refs", () => {
  // PR head/base ref names are attacker-controlled on forks (PR author picks
  // headRef freely, and baseRef could be a maliciously-named branch on the
  // target repo). they flow into `git fetch origin <ref>` and similar, so a
  // ref starting with '-' would be parsed as a flag, not a refspec.
  // checkoutPrBranch validates them up-front with rejectIfLeadingDash.
  const basePr: PrData = {
    number: 1,
    headSha: "a".repeat(40),
    headRef: "feature",
    headRepoFullName: "user/repo",
    baseRef: "main",
    baseRepoFullName: "user/repo",
    maintainerCanModify: false,
  };
  // checkoutPrBranch validates before any async call, so the params never get
  // dereferenced — a cast is enough to satisfy the type checker.
  const dummyParams = {} as Parameters<typeof checkoutPrBranch>[1];

  it("rejects a leading-dash headRef before any git call", async () => {
    await expect(
      checkoutPrBranch({ ...basePr, headRef: "-upload-pack=evil" }, dummyParams)
    ).rejects.toThrow(/PR head ref.*starts with '-'/);
  });

  it("rejects a leading-dash baseRef before any git call", async () => {
    await expect(
      checkoutPrBranch({ ...basePr, baseRef: "--config-env=FOO=BAR" }, dummyParams)
    ).rejects.toThrow(/PR base ref.*starts with '-'/);
  });
});

describe("dependency install - ignore-scripts logic", () => {
  it("ignoreScripts is true when shell is disabled", () => {
    expect(shouldIgnoreScripts("disabled")).toBe(true);
  });

  it("ignoreScripts is false when shell is restricted (scripts run in stripped env)", () => {
    expect(shouldIgnoreScripts("restricted")).toBe(false);
  });

  it("ignoreScripts is false when shell is enabled", () => {
    expect(shouldIgnoreScripts("enabled")).toBe(false);
  });
});
