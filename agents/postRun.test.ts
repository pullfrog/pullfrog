import { describe, expect, it } from "vitest";
import type { ToolState } from "../toolState.ts";
import type { AgentRunContext } from "./shared.ts";
import { collectPostRunIssues, getUnsubmittedReview } from "./postRun.ts";

function makeToolState(overrides: Partial<ToolState> = {}): ToolState {
  return {
    repos: new Map([["o/r", { owner: "o", name: "r", dir: "/tmp/r", access: "primary" }]]),
    primaryRepoKey: "o/r",
    progressComment: undefined,
    hadProgressComment: true,
    prepushFailureCount: 0,
    backgroundProcesses: new Map(),
    usageEntries: [],
    ...overrides,
  };
}

describe("getUnsubmittedReview", () => {
  it("returns null when mode is not a review mode", () => {
    expect(getUnsubmittedReview(makeToolState({ selectedMode: "Build" }))).toBeNull();
    expect(getUnsubmittedReview(makeToolState())).toBeNull();
  });

  it("returns null when a review was already submitted", () => {
    expect(
      getUnsubmittedReview(
        makeToolState({
          selectedMode: "Review",
          review: { id: 1, nodeId: "n", reviewedSha: undefined },
        })
      )
    ).toBeNull();
  });

  it("fires for Review even when report_progress wrote a final summary", () => {
    // Review's only valid exit is `create_pull_request_review`. a summary
    // comment is not a substitute, and accepting it here previously let
    // subagent-flipped `finalSummaryWritten` silence the gate.
    expect(
      getUnsubmittedReview(makeToolState({ selectedMode: "Review", finalSummaryWritten: true }))
    ).toBe("Review");
  });

  it("returns null for IncrementalReview when report_progress wrote a final summary", () => {
    // IncrementalReview treats `report_progress` as a legitimate
    // "no review warranted" exit, matching the post-failure error message.
    expect(
      getUnsubmittedReview(
        makeToolState({ selectedMode: "IncrementalReview", finalSummaryWritten: true })
      )
    ).toBeNull();
  });

  it("returns null when there is no progress comment to anchor the failure to", () => {
    expect(
      getUnsubmittedReview(makeToolState({ selectedMode: "Review", hadProgressComment: false }))
    ).toBeNull();
  });

  it("still requires a review in comment-free review runs", () => {
    expect(
      getUnsubmittedReview(
        makeToolState({ selectedMode: "Review", hadProgressComment: false }),
        true
      )
    ).toBe("Review");
  });

  it("returns the selected mode when the gate should fire", () => {
    expect(getUnsubmittedReview(makeToolState({ selectedMode: "Review" }))).toBe("Review");
    expect(getUnsubmittedReview(makeToolState({ selectedMode: "IncrementalReview" }))).toBe(
      "IncrementalReview"
    );
  });
});

describe("collectPostRunIssues", () => {
  it("does not require output from silent comment-free review runs", async () => {
    const ctx = {
      payload: { progressComments: false, event: { is_pr: true, silent: true } },
      toolState: makeToolState({
        selectedMode: "IncrementalReview",
        hadProgressComment: false,
      }),
    } as unknown as AgentRunContext;

    const issues = await collectPostRunIssues(ctx);

    expect(issues.unsubmittedReview).toBeUndefined();
  });

  it("requires output from non-silent comment-free review runs without is_pr", async () => {
    const ctx = {
      payload: { progressComments: false, event: { issue_number: 42 } },
      toolState: makeToolState({ selectedMode: "Review", hadProgressComment: false }),
    } as unknown as AgentRunContext;

    const issues = await collectPostRunIssues(ctx);

    expect(issues.unsubmittedReview).toBe("Review");
  });

  it("does not require review output from plain-prompt runs without a target", async () => {
    const ctx = {
      payload: { progressComments: false, event: { trigger: "unknown" } },
      toolState: makeToolState({ selectedMode: "Review", hadProgressComment: false }),
    } as unknown as AgentRunContext;

    const issues = await collectPostRunIssues(ctx);

    expect(issues.unsubmittedReview).toBeUndefined();
  });
});
