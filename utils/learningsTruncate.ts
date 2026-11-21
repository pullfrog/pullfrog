/**
 * pure string helpers for capping and line-boundary-truncating the
 * `Repo.learnings` body. lives in its own module (vs alongside
 * `learnings.ts`) so the proprietary root app can re-export it through
 * `action/internal/index.ts` without dragging the entire MCP type graph
 * along — `learnings.ts` imports `ToolContext` for its runtime helpers,
 * and pulling that into the SDK-facing `internal` barrel expands the
 * type graph reachable from root `tsc` to every tool module under
 * `action/mcp/`. keeping these helpers MCP-free is the
 * cheap structural fix.
 *
 * see `action/utils/learnings.ts` for the full learnings-file lifecycle.
 */

/** maximum size of `Repo.learnings` body in chars. action truncates the
 * read-back BEFORE the PATCH to avoid sending an oversized payload; the
 * server applies the same truncation as a defense-in-depth backstop (any
 * caller that misses the client-side step would otherwise persist a
 * mid-line tail, breaking the next-run TOC parse).
 *
 * raised from 10k → 100k once the TOC affordance landed: with line-range
 * reads via the server-parsed TOC the agent doesn't ingest the whole
 * file, so the cap is governed by curation discipline rather than a
 * tight byte ceiling. 100k holds ~400-500 short bullets. */
export const MAX_LEARNINGS_LENGTH = 100_000;

/** past this size the reflection turn must shrink the file before adding to it. half the cap,
 * because a file that reaches the cap loses its tail on every write: 310 repos sat there, where
 * 89% of additions did not survive to the next run. see wiki/learnings.md. */
export const LEARNINGS_BUDGET = 50_000;

/** truncate at the last newline boundary before `cap` so we don't leave
 * a partial line at the tail (a half-truncated `## Headi` confuses the
 * server's next-seed TOC parse and shrinks visible structure). falls
 * back to a hard `slice` when the line boundary would discard a large
 * run of content — i.e. when the tail of `head` is one giant line (rare:
 * minified pastes, fenced log dumps). losing a partial last line is
 * preferable to losing kilobytes of body. */
const TRUNCATION_LINE_BOUNDARY_TOLERANCE = 4096;
export function truncateAtLineBoundary(body: string, cap: number): string {
  if (body.length <= cap) return body;
  const head = body.slice(0, cap);
  const lastNewline = head.lastIndexOf("\n");
  if (lastNewline <= 0) return head;
  if (cap - lastNewline > TRUNCATION_LINE_BOUNDARY_TOLERANCE) return head;
  return head.slice(0, lastNewline);
}
