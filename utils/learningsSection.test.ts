import { describe, expect, it } from "vitest";
import { buildLearningsSection } from "./instructions.ts";

describe("buildLearningsSection", () => {
  it("returns empty string when no file path (seed step failed)", () => {
    expect(buildLearningsSection({ filePath: null })).toBe("");
  });

  it("names the file without listing its headings", () => {
    const out = buildLearningsSection({ filePath: "/tmp/run-1/pullfrog-learnings.md" });
    expect(out).toContain("************* LEARNINGS *************");
    expect(out).toContain("/tmp/run-1/pullfrog-learnings.md");
    expect(out).not.toMatch(/\(L\d+-L\d+\)/);
  });

  it("intro phrasing does not assert prior runs — works for fresh empty repos too", () => {
    const out = buildLearningsSection({ filePath: "/tmp/run-1/pullfrog-learnings.md" });
    // load-bearing: fresh repos have zero previous runs. the prior copy
    // ("accumulated by previous agent runs") was a lie in that case.
    expect(out).not.toContain("accumulated by previous agent runs");
    expect(out).toContain("maintained across runs");
  });
});
