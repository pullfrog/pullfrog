import { describe, expect, it } from "vitest";
import {
  type CommentableLines,
  commentableLinesForFile,
  type DroppedComment,
  duplicateReviewDecision,
  formatDroppedCommentsNote,
  MAX_DROPPED_COMMENT_LINES,
  type ReviewCommentInput,
  reviewSkipDecision,
  sealProgressAfterReview,
  validateInlineComments,
} from "./review.ts";
import type { ToolContext } from "./server.ts";

describe("sealProgressAfterReview", () => {
  it("seals comment-free disabled review runs", () => {
    const ctx = {
      payload: { progressComments: false },
      toolState: { progressComment: undefined },
    } as unknown as ToolContext;

    sealProgressAfterReview(ctx);

    expect(ctx.toolState.progressComment).toBeNull();
  });

  it("does not change enabled runs without a progress comment", () => {
    const ctx = {
      payload: { progressComments: true },
      toolState: { progressComment: undefined },
    } as unknown as ToolContext;

    sealProgressAfterReview(ctx);

    expect(ctx.toolState.progressComment).toBeUndefined();
  });
});

describe("commentableLinesForFile", () => {
  it("returns empty sets for missing patches (binary or no changes)", () => {
    const result = commentableLinesForFile(undefined);
    expect(result.LEFT.size).toBe(0);
    expect(result.RIGHT.size).toBe(0);
  });

  it("collects added lines on RIGHT, removed lines on LEFT, context on both", () => {
    const patch = ["@@ -10,3 +10,4 @@", " ctx1", "-old", "+new", "+new2", " ctx2"].join("\n");
    const { LEFT, RIGHT } = commentableLinesForFile(patch);
    expect([...LEFT].sort((a, b) => a - b)).toEqual([10, 11, 12]);
    expect([...RIGHT].sort((a, b) => a - b)).toEqual([10, 11, 12, 13]);
  });

  it("handles multiple hunks", () => {
    const patch = ["@@ -1,2 +1,2 @@", " a", "-b", "+B", "@@ -20,1 +20,2 @@", " x", "+y"].join("\n");
    const { LEFT, RIGHT } = commentableLinesForFile(patch);
    expect(RIGHT.has(2)).toBe(true); // +B
    expect(RIGHT.has(21)).toBe(true); // +y
    expect(LEFT.has(2)).toBe(true); // -b
    expect(LEFT.has(20)).toBe(true); // context x
    expect(RIGHT.has(20)).toBe(true); // context x
  });

  it("ignores the 'no newline at end of file' marker", () => {
    const patch = ["@@ -1,1 +1,1 @@", "-old", "\\ No newline at end of file", "+new"].join("\n");
    const { LEFT, RIGHT } = commentableLinesForFile(patch);
    expect(LEFT.has(1)).toBe(true);
    expect(RIGHT.has(1)).toBe(true);
    expect(LEFT.size).toBe(1);
    expect(RIGHT.size).toBe(1);
  });

  it("parses hunk headers without explicit counts", () => {
    // single-line hunks can omit ",<count>"
    const patch = ["@@ -5 +5 @@", "-old", "+new"].join("\n");
    const { LEFT, RIGHT } = commentableLinesForFile(patch);
    expect(LEFT.has(5)).toBe(true);
    expect(RIGHT.has(5)).toBe(true);
  });
});

function buildMap(entries: Array<[string, string]>): Map<string, CommentableLines> {
  const map = new Map<string, CommentableLines>();
  for (const [file, patch] of entries) {
    map.set(file, commentableLinesForFile(patch));
  }
  return map;
}

describe("validateInlineComments", () => {
  const patch = ["@@ -10,2 +10,3 @@", " ctx", "-old", "+new", "+new2"].join("\n");
  const diffMap = buildMap([["src/foo.ts", patch]]);

  const base = (overrides: Partial<ReviewCommentInput>): ReviewCommentInput => ({
    path: "src/foo.ts",
    line: 11,
    side: "RIGHT",
    body: "LGTM",
    ...overrides,
  });

  it("keeps comments anchored to added lines on RIGHT", () => {
    const result = validateInlineComments([base({ line: 12 })], diffMap);
    expect(result.valid).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
  });

  it("keeps comments anchored to removed lines on LEFT", () => {
    const result = validateInlineComments([base({ line: 11, side: "LEFT" })], diffMap);
    expect(result.valid).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
  });

  it("drops comments on files not in the diff", () => {
    const result = validateInlineComments([base({ path: "other/bar.ts" })], diffMap);
    expect(result.valid).toHaveLength(0);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].reason).toContain("file not in PR diff");
  });

  it("distinguishes binary/no-patch files from files with hunks", () => {
    // file present in the PR but with no patch data (binary file).
    const binaryMap = buildMap([
      ["src/foo.ts", patch],
      ["assets/logo.png", undefined as unknown as string],
    ]);
    const result = validateInlineComments([base({ path: "assets/logo.png", line: 1 })], binaryMap);
    expect(result.valid).toHaveLength(0);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].reason).toContain("no textual diff");
    expect(result.dropped[0].reason).not.toContain("not inside a diff hunk");
  });

  it("drops comments on lines outside diff hunks", () => {
    const result = validateInlineComments([base({ line: 500 })], diffMap);
    expect(result.valid).toHaveLength(0);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].reason).toContain("line 500");
    expect(result.dropped[0].reason).toContain("RIGHT");
  });

  it("drops comments whose side mismatches the hunk (added line on LEFT)", () => {
    // line 12 is "+new" — only in RIGHT. Asking for it on LEFT should drop.
    const result = validateInlineComments([base({ line: 12, side: "LEFT" })], diffMap);
    expect(result.valid).toHaveLength(0);
    expect(result.dropped).toHaveLength(1);
  });

  it("drops multi-line comments where start_line is out of range", () => {
    const result = validateInlineComments([base({ line: 12, start_line: 3 })], diffMap);
    expect(result.valid).toHaveLength(0);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].reason).toContain("start_line 3");
  });

  it("keeps multi-line comments fully inside a hunk", () => {
    const result = validateInlineComments([base({ line: 12, start_line: 11 })], diffMap);
    expect(result.valid).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
  });

  it("drops inverted ranges (start_line > line) with a precise reason", () => {
    // both 11 and 12 anchor in the hunk, but GitHub 422s with "invalid line
    // numbers" when start_line > line. dropping locally avoids the opaque
    // remote failure and tells the agent exactly what to fix.
    const result = validateInlineComments([base({ line: 11, start_line: 12 })], diffMap);
    expect(result.valid).toHaveLength(0);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].reason).toMatch(/start_line 12 is after line 11/);
    expect(result.dropped[0].reason).toMatch(/start_line <= line/);
  });

  it("partitions a batch — valid and invalid comments survive independently", () => {
    const result = validateInlineComments(
      [base({ line: 12 }), base({ line: 9999 }), base({ path: "missing.ts" })],
      diffMap
    );
    expect(result.valid).toHaveLength(1);
    expect(result.dropped).toHaveLength(2);
  });

  it("defaults side to RIGHT when omitted", () => {
    const result = validateInlineComments([{ path: "src/foo.ts", line: 12, body: "" }], diffMap);
    expect(result.valid).toHaveLength(1);
  });
});

describe("formatDroppedCommentsNote", () => {
  it("renders single-line dropped entries with `path:line`", () => {
    const dropped: DroppedComment[] = [
      {
        path: "src/foo.ts",
        line: 42,
        side: "RIGHT",
        reason: "line 42 (RIGHT) is not inside a diff hunk",
      },
    ];
    const note = formatDroppedCommentsNote(dropped);
    expect(note).toContain("**Note:** 1 inline comment(s) dropped");
    expect(note).toContain("`src/foo.ts:42` (RIGHT)");
    expect(note).toContain("line 42 (RIGHT) is not inside a diff hunk");
  });

  it("renders multi-line dropped entries with `path:start-end`", () => {
    const dropped: DroppedComment[] = [
      {
        path: "src/bar.ts",
        line: 20,
        startLine: 15,
        side: "LEFT",
        reason: "start_line 15 (LEFT) is not inside a diff hunk",
      },
    ];
    const note = formatDroppedCommentsNote(dropped);
    expect(note).toContain("`src/bar.ts:15-20` (LEFT)");
  });

  it("falls back to single-line format when startLine equals line", () => {
    const dropped: DroppedComment[] = [
      { path: "src/baz.ts", line: 7, startLine: 7, side: "RIGHT", reason: "file not in PR diff" },
    ];
    const note = formatDroppedCommentsNote(dropped);
    expect(note).toContain("`src/baz.ts:7` (RIGHT)");
    expect(note).not.toContain("7-7");
  });

  it("caps detail lines and reports the remainder so body stays under GitHub's size limit", () => {
    const overflow = MAX_DROPPED_COMMENT_LINES + 7;
    const dropped: DroppedComment[] = Array.from({ length: overflow }, (_, i) => ({
      path: `src/file${i}.ts`,
      line: i + 1,
      side: "RIGHT" as const,
      reason: "file not in PR diff",
    }));
    const note = formatDroppedCommentsNote(dropped);
    expect(note).toContain(`**Note:** ${overflow} inline comment(s) dropped`);
    // still reports the full count in the header
    expect(note).toContain(`${overflow} inline comment(s)`);
    // first entry shown, last entry elided
    expect(note).toContain("`src/file0.ts:1` (RIGHT)");
    expect(note).not.toContain(`src/file${overflow - 1}.ts`);
    expect(note).toContain("…and 7 more dropped comment(s) not shown");
  });

  it("does not add a truncation line when drops fit under the cap", () => {
    const dropped: DroppedComment[] = Array.from({ length: MAX_DROPPED_COMMENT_LINES }, (_, i) => ({
      path: `src/f${i}.ts`,
      line: i + 1,
      side: "RIGHT" as const,
      reason: "file not in PR diff",
    }));
    const note = formatDroppedCommentsNote(dropped);
    expect(note).not.toContain("more dropped comment(s) not shown");
  });
});

describe("reviewSkipDecision", () => {
  // GitHub 422s `event: "COMMENT"` reviews with no body + no comments
  // ("{\"message\":\"Unprocessable Entity\",\"errors\":[\"\"]}"). verified
  // empirically against repos/pullfrog/preview-546-run-issues-fixes/pulls/1
  // with and without commit_id set. the skip function must return a decision
  // for every shape that lands on that API call.

  it("skips with 'no-issues' when !approved + empty body + no comments", () => {
    const decision = reviewSkipDecision({
      approved: false,
      body: "",
      hasComments: false,
      prApproveEnabled: true,
    });
    expect(decision?.kind).toBe("no-issues");
    expect(decision?.reason).toContain("nothing to post");
  });

  it("treats null body the same as empty string", () => {
    const decision = reviewSkipDecision({
      approved: false,
      body: null,
      hasComments: false,
      prApproveEnabled: true,
    });
    expect(decision?.kind).toBe("no-issues");
  });

  it("treats undefined body the same as empty string", () => {
    const decision = reviewSkipDecision({
      approved: false,
      body: undefined,
      hasComments: false,
      prApproveEnabled: true,
    });
    expect(decision?.kind).toBe("no-issues");
  });

  it("skips with 'empty-downgraded-approve' when approved + !prApproveEnabled + empty", () => {
    // this is the F3 regression case — agent requests APPROVE, runtime
    // downgrades to COMMENT (prApproveEnabled off), and the empty COMMENT
    // 422s at GitHub. before this fix, the tool returned a stranded-success
    // shape that didn't map to any persisted review.
    const decision = reviewSkipDecision({
      approved: true,
      body: "",
      hasComments: false,
      prApproveEnabled: false,
    });
    expect(decision?.kind).toBe("empty-downgraded-approve");
    expect(decision?.reason).toContain("prApproveEnabled is disabled");
  });

  it("does NOT skip legitimate bare APPROVE (approved + prApproveEnabled + empty)", () => {
    // GitHub accepts empty APPROVE reviews — the stamp itself is the content.
    // skipping here would silently drop agents' real approvals.
    const decision = reviewSkipDecision({
      approved: true,
      body: "",
      hasComments: false,
      prApproveEnabled: true,
    });
    expect(decision).toBeNull();
  });

  it("does NOT skip when body is present (no-issues path)", () => {
    const decision = reviewSkipDecision({
      approved: false,
      body: "found some issues",
      hasComments: false,
      prApproveEnabled: true,
    });
    expect(decision).toBeNull();
  });

  it("does NOT skip when body is present (downgrade path)", () => {
    // approved+!prApproveEnabled with a body becomes a real COMMENT review
    // (downgrade + body). GitHub accepts those; don't skip.
    const decision = reviewSkipDecision({
      approved: true,
      body: "nits follow",
      hasComments: false,
      prApproveEnabled: false,
    });
    expect(decision).toBeNull();
  });

  it("does NOT skip when comments are present (no-issues path)", () => {
    const decision = reviewSkipDecision({
      approved: false,
      body: "",
      hasComments: true,
      prApproveEnabled: true,
    });
    expect(decision).toBeNull();
  });

  it("does NOT skip when comments are present (downgrade path)", () => {
    const decision = reviewSkipDecision({
      approved: true,
      body: "",
      hasComments: true,
      prApproveEnabled: false,
    });
    expect(decision).toBeNull();
  });
});

describe("duplicateReviewDecision", () => {
  // regression: colinhacks/zod#5897 had two reviews submitted from the same
  // workflow run 8 seconds apart — a substantive review followed by an empty
  // "No new issues found." follow-up. the agent re-classified the first
  // review's non-blocking observations as "no actionable issues" and
  // submitted the canonical body per modes.ts. this guard makes the second
  // call a no-op without burning a GitHub API call or polluting the PR.

  it("allows the first submission when no prior review exists", () => {
    const decision = duplicateReviewDecision({
      existing: undefined,
      currentCheckoutSha: "sha1",
    });
    expect(decision).toBeNull();
  });

  it("blocks a second submission when checkoutSha matches the prior reviewedSha", () => {
    // exact reproduction of the zod#5897 shape: same session, same checked-out
    // SHA, second create_pull_request_review call.
    const decision = duplicateReviewDecision({
      existing: { id: 100, reviewedSha: "sha1" },
      currentCheckoutSha: "sha1",
    });
    expect(decision?.kind).toBe("already-submitted");
    expect(decision?.reviewId).toBe(100);
    expect(decision?.reason).toContain("already submitted");
    expect(decision?.reason).toContain("checkout_pr");
  });

  it("allows a follow-up when checkoutSha advanced past the prior reviewedSha", () => {
    // the new-commits-mid-review path advances toolState.checkoutSha to the
    // new HEAD before returning, and the agent is told to call checkout_pr
    // again — both paths leave checkoutSha != reviewedSha. those are real
    // follow-up reviews and must go through.
    const decision = duplicateReviewDecision({
      existing: { id: 100, reviewedSha: "sha-old" },
      currentCheckoutSha: "sha-new",
    });
    expect(decision).toBeNull();
  });

  it("blocks when checkoutSha is missing — cannot prove the SHA moved", () => {
    // if the agent never called checkout_pr, we have no anchor to compare
    // against. assume duplicate rather than letting a second review through
    // — the prior review still satisfies the agent's intent.
    const decision = duplicateReviewDecision({
      existing: { id: 100, reviewedSha: "sha1" },
      currentCheckoutSha: undefined,
    });
    expect(decision?.kind).toBe("already-submitted");
  });

  it("blocks when prior reviewedSha is missing — cannot prove the SHA moved", () => {
    // belt-and-suspenders: if for any reason the prior review didn't capture
    // a reviewedSha, treat the second call as a duplicate to be safe.
    const decision = duplicateReviewDecision({
      existing: { id: 100, reviewedSha: undefined },
      currentCheckoutSha: "sha1",
    });
    expect(decision?.kind).toBe("already-submitted");
  });
});
