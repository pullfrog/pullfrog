import type { ToolState } from "../toolState.ts";
import type { TodoTracker } from "../utils/todoTracking.ts";
import { deleteProgressComment, reportProgress, ReportProgressTool } from "./comment.ts";
import type { ToolContext } from "./server.ts";

describe("reportProgress", () => {
  it("skips live progress comments when they are disabled", async () => {
    const toolState = {} as ToolState;
    const ctx = {
      payload: { progressComments: false, event: {} },
      toolState,
    } as ToolContext;

    await expect(
      reportProgress(ctx, { body: "Reviewing the diff", liveProgress: true })
    ).resolves.toEqual({
      body: "Reviewing the diff",
      action: "skipped",
    });
    expect(toolState.lastProgressBody).toBeUndefined();
  });

  it("still publishes final result comments with task details", async () => {
    const todoTracker = {
      cancel: vi.fn(),
      settled: vi.fn().mockResolvedValue(undefined),
      renderCollapsible: vi.fn().mockReturnValue("<details>Task list</details>"),
    } as unknown as TodoTracker;
    const toolState = { todoTracker } as ToolState;
    const createComment = vi.fn().mockResolvedValue({
      data: { id: 123, body: "Review complete", html_url: "https://example.com/comment/123" },
    });
    const ctx = {
      payload: { progressComments: false, event: { issue_number: 42 } },
      repo: { owner: "pullfrog", name: "pullfrog" },
      octokit: { rest: { issues: { createComment } } },
      toolState,
    } as unknown as ToolContext;
    const tool = ReportProgressTool(ctx);

    await (tool.execute as (params: unknown, context: unknown) => Promise<unknown>)(
      { body: "Review complete" },
      {} as Parameters<NonNullable<typeof tool.execute>>[1]
    );

    expect(createComment).toHaveBeenCalledOnce();
    expect(createComment.mock.calls[0][0].body).toContain("<details>Task list</details>");
    expect(todoTracker.cancel).toHaveBeenCalledOnce();
    expect(toolState.finalSummaryWritten).toBe(true);
  });

  it("leaves reporting open when no comment exists to delete", async () => {
    const toolState = {} as ToolState;
    const ctx = { toolState } as ToolContext;

    await expect(deleteProgressComment(ctx)).resolves.toBe(false);
    expect(toolState.progressComment).toBeUndefined();
  });

  it("treats an already-deleted progress comment as successfully removed", async () => {
    const toolState = {
      progressComment: { id: 123, type: "issue" },
    } as ToolState;
    const deleteComment = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
    const ctx = {
      repo: { owner: "pullfrog", name: "pullfrog" },
      octokit: { rest: { issues: { deleteComment } } },
      toolState,
    } as unknown as ToolContext;

    await expect(deleteProgressComment(ctx)).resolves.toBe(true);
    expect(toolState.progressComment).toBeNull();
  });
});
