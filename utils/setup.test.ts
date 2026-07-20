import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeIncludeIfEntries } from "./setup.ts";

describe("removeIncludeIfEntries", () => {
  let repoDir: string;

  // git push sets GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE for pre-push hooks
  // and those propagate to execSync's child processes by default. a `git init`
  // inheriting GIT_DIR from the outer repo modifies the outer repo's config
  // rather than creating one in `repoDir`, which makes subsequent writeFileSync
  // on `repoDir/.git/config` fail with ENOENT and masquerades as a test bug.
  // strip the git-specific env vars so this suite runs identically whether
  // invoked directly, via `pnpm -r test`, or via a pre-push hook.
  const cleanEnv = (() => {
    const next = { ...process.env };
    for (const k of Object.keys(next)) {
      if (k.startsWith("GIT_")) delete next[k];
    }
    return next;
  })();

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "pullfrog-setup-test-"));
    execSync("git init -q", { cwd: repoDir, env: cleanEnv });
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("removes a benign includeIf.gitdir entry", () => {
    execSync('git config --local "includeIf.gitdir:/work/.gitconfig" "/tmp/included-config"', {
      cwd: repoDir,
      env: cleanEnv,
    });
    expect(
      execSync('git config --local --get-all "includeIf.gitdir:/work/.gitconfig"', {
        cwd: repoDir,
        encoding: "utf-8",
        env: cleanEnv,
      }).trim()
    ).toBe("/tmp/included-config");

    removeIncludeIfEntries(repoDir);

    expect(() =>
      execSync('git config --local --get-all "includeIf.gitdir:/work/.gitconfig"', {
        cwd: repoDir,
        stdio: "pipe",
        env: cleanEnv,
      })
    ).toThrow();
  });

  it("does not execute $(...) command substitution embedded in a subsection name", () => {
    // regression: setup previously did
    //   execSync(`git config --local --unset "${key}"`)
    // where `key` was derived from `git config --get-regexp ^includeif\.` output.
    // a subsection like `gitdir:$(touch${IFS}/tmp/pwn)safe` bypasses the
    // split-on-space filter and, when interpolated into a shell command,
    // lets the shell evaluate the command substitution.
    const proof = join(repoDir, "pwn-proof.txt");
    expect(existsSync(proof)).toBe(false);

    const configPath = join(repoDir, ".git", "config");
    writeFileSync(
      configPath,
      [
        "[core]",
        "\trepositoryformatversion = 0",
        // space-free payload: ${IFS} expands to whitespace only if evaluated by a shell.
        // the subsection name is preserved literally by git.
        `[includeIf "gitdir:$(touch\${IFS}${proof})safe"]`,
        `\tpath = /tmp/unused`,
        "",
      ].join("\n")
    );

    removeIncludeIfEntries(repoDir);

    expect(existsSync(proof)).toBe(false);
  });

  it("handles keys containing whitespace in the subsection name", () => {
    // the old split-on-space approach truncated keys at the first space, so
    // subsections with internal whitespace survived cleanup. the -z path
    // reads keys whole.
    const configPath = join(repoDir, ".git", "config");
    writeFileSync(
      configPath,
      [
        "[core]",
        "\trepositoryformatversion = 0",
        '[includeIf "gitdir:/a b c"]',
        "\tpath = /tmp/unused",
        "",
      ].join("\n")
    );

    removeIncludeIfEntries(repoDir);

    let remaining = "";
    try {
      remaining = execSync("git config --local --get-regexp ^includeif\\.", {
        cwd: repoDir,
        encoding: "utf-8",
        env: cleanEnv,
      });
    } catch {
      // git config exits with 1 when no keys match
    }
    expect(remaining.trim()).toBe("");
  });

  it("is a no-op when no includeIf entries exist", () => {
    expect(() => removeIncludeIfEntries(repoDir)).not.toThrow();
  });
});
