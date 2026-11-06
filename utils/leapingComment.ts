import { stripExistingFooter } from "./buildPullfrogFooter.ts";

/**
 * The prefix text for the initial "leaping into action" comment.
 * Used to detect whether a progress comment is still in its initial state
 * and hasn't been updated with real progress or error messages.
 *
 * Lives in `utils/` (not `mcp/`) so it can be re-exported via `pullfrog/internal`
 * without dragging the MCP server's transitive imports into the Next.js app's
 * type-check graph.
 */
export const LEAPING_INTO_ACTION_PREFIX = "Leaping into action";

export function isLeapingIntoActionCommentBody(body: string): boolean {
  const content = stripExistingFooter(body).trimStart();
  const firstLine = content.split(/\r?\n/, 1)[0]?.trimEnd() ?? "";
  return new RegExp(`(^|\\s)${LEAPING_INTO_ACTION_PREFIX}(\\.\\.\\.)?$`).test(firstLine);
}

/** the spinner on a to-do list's in-progress item. */
export const TODO_SPINNER_URL = "https://pullfrog.com/todo-spinner.svg";

/** the spinner earlier releases still write, so a run on one of them is a live list too. */
const LEGACY_TODO_SPINNER_URL = "https://uploads.pullfrog.com/Progress%20Indicator.gif";

/**
 * A live to-do list: one item still carries the spinner. Every finished body — a
 * final summary, a salvaged answer, an error report — renders with in-progress
 * items completed, so the spinner is only ever on a list whose run is still going
 * or died without writing again.
 */
export function isLiveChecklistCommentBody(body: string): boolean {
  return body.includes(TODO_SPINNER_URL) || body.includes(LEGACY_TODO_SPINNER_URL);
}
