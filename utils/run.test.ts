import type { AgentResult } from "../agents/shared.ts";
import type { ToolContext } from "../mcp/server.ts";
import type { ToolState } from "../toolState.ts";
import { handleAgentResult } from "./run.ts";

const mocks = vi.hoisted(() => ({
  reportProgress: vi.fn(),
  reportErrorToComment: vi.fn(),
}));

vi.mock("../mcp/comment.ts", () => ({ reportProgress: mocks.reportProgress }));
vi.mock("./errorReport.ts", () => ({ reportErrorToComment: mocks.reportErrorToComment }));

function makeParams(result: AgentResult) {
  const toolState = {
    hadProgressComment: true,
    progressComment: undefined,
  } as ToolState;
  const toolContext = { toolState } as ToolContext;
  return { result, toolContext, silent: false };
}

describe("handleAgentResult", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reportErrorToComment.mockResolvedValue(undefined);
  });

  it("creates a fallback comment when the agent returns no result", async () => {
    await handleAgentResult(makeParams({ success: true, output: "" }));

    expect(mocks.reportErrorToComment).toHaveBeenCalledWith(
      expect.objectContaining({ createIfMissing: true })
    );
  });

  it("creates a fallback comment when result delivery fails", async () => {
    mocks.reportProgress.mockRejectedValue(new Error("write failed"));

    await handleAgentResult(makeParams({ success: true, output: "Completed work" }));

    expect(mocks.reportErrorToComment).toHaveBeenCalledWith(
      expect.objectContaining({ createIfMissing: true })
    );
  });
});
