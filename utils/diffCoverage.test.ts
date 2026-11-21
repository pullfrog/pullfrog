import { describe, expect, it } from "vitest";
import {
  createDiffCoverageState,
  getDiffCoverageBreakdown,
  parseDiffTocEntries,
  recordDiffReadFromToolUse,
} from "./diffCoverage.ts";

const diffPath = "/tmp/pr-1.diff";
const toc = `## Files (2)
- src/a.ts → lines 5-10
- yarn.lock → lines 12-20

---
`;
const tocEntries = parseDiffTocEntries({ toc });

describe("diff coverage line checker", () => {
  it("treats a Read offset of 0 as the first line", () => {
    const state = createDiffCoverageState({
      diffPath,
      totalLines: 30,
      tocEntries,
    });

    const tracked = recordDiffReadFromToolUse({
      state,
      toolName: "Read",
      input: {
        filePath: diffPath,
        offset: 0,
        limit: 3,
      },
      cwd: "/",
    });

    expect(tracked).toBe(true);
    const breakdown = getDiffCoverageBreakdown({ state });
    expect(breakdown.coveredRanges).toEqual([{ startLine: 1, endLine: 3 }]);
  });

  it("treats ReadFile offsets as one based", () => {
    const state = createDiffCoverageState({
      diffPath,
      totalLines: 30,
      tocEntries,
    });

    const tracked = recordDiffReadFromToolUse({
      state,
      toolName: "ReadFile",
      input: {
        path: diffPath,
        offset: 1,
        limit: 2,
      },
      cwd: "/",
    });

    expect(tracked).toBe(true);
    const breakdown = getDiffCoverageBreakdown({ state });
    expect(breakdown.coveredRanges).toEqual([{ startLine: 1, endLine: 2 }]);
  });

  it("supports negative offsets from file end", () => {
    const state = createDiffCoverageState({
      diffPath,
      totalLines: 30,
      tocEntries,
    });

    const tracked = recordDiffReadFromToolUse({
      state,
      toolName: "Read",
      input: {
        path: diffPath,
        offset: -2,
        limit: 2,
      },
      cwd: "/",
    });

    expect(tracked).toBe(true);
    const breakdown = getDiffCoverageBreakdown({ state });
    expect(breakdown.coveredRanges).toEqual([{ startLine: 29, endLine: 30 }]);
  });

  it("parses TOC lines that include the ` · diff-<sha256>` anchor emitted by checkout_pr", () => {
    const productionToc = `## Files (2)
- src/format.ts → lines 9-32 · diff-41c7b3ac268a3a1ae5c7be92f1230f600013b7170e44a693570ccbdb183ea36b
- test/math.test.ts → lines 81-93 · diff-44b3f515a5c787743d239052db11d740d691e8bef711c2427bb2b9752a4103a9

---
`;
    const entries = parseDiffTocEntries({ toc: productionToc });
    expect(entries).toEqual([
      { filename: "src/format.ts", startLine: 9, endLine: 32 },
      { filename: "test/math.test.ts", startLine: 81, endLine: 93 },
    ]);
  });

  it("carries forward coveragePreflightRan from a previous state across checkout refreshes", () => {
    const previous = createDiffCoverageState({ diffPath, totalLines: 30, tocEntries });
    previous.coveragePreflightRan = true;
    previous.coveredRanges = [{ startLine: 5, endLine: 10 }];

    const next = createDiffCoverageState({ diffPath, totalLines: 50, tocEntries, previous });

    expect(next.coveragePreflightRan).toBe(true);
    // coveredRanges are tied to the previous diff content and must not leak forward
    expect(next.coveredRanges).toEqual([]);
    expect(next.totalLines).toBe(50);
  });

  it("defaults coveragePreflightRan to false when no previous state is provided", () => {
    const state = createDiffCoverageState({ diffPath, totalLines: 30, tocEntries });
    expect(state.coveragePreflightRan).toBe(false);
  });

  it("computes per-file unread ranges from tracked reads", () => {
    const state = createDiffCoverageState({
      diffPath,
      totalLines: 30,
      tocEntries,
    });

    recordDiffReadFromToolUse({
      state,
      toolName: "Read",
      input: {
        path: diffPath,
        start_line: 5,
        end_line: 6,
      },
      cwd: "/",
    });

    recordDiffReadFromToolUse({
      state,
      toolName: "Read",
      input: {
        path: diffPath,
        start_line: 12,
        end_line: 14,
      },
      cwd: "/",
    });

    const breakdown = getDiffCoverageBreakdown({ state });
    const firstFile = breakdown.files[0];
    const secondFile = breakdown.files[1];

    expect(firstFile.filename).toBe("src/a.ts");
    expect(firstFile.coveredRanges).toEqual([{ startLine: 5, endLine: 6 }]);
    expect(firstFile.unreadRanges).toEqual([{ startLine: 7, endLine: 10 }]);

    expect(secondFile.filename).toBe("yarn.lock");
    expect(secondFile.coveredRanges).toEqual([{ startLine: 12, endLine: 14 }]);
    expect(secondFile.unreadRanges).toEqual([{ startLine: 15, endLine: 20 }]);
  });
});
