import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { type } from "arktype";
import { primaryRepoState } from "../toolState.ts";
import type { ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";

const DEFAULT_LINES = 2000;
const MAX_CHARS = 100_000;

export const ReadFile = type({
  path: type.string.describe("absolute, or relative to the primary checkout"),
  "offset?": type("number.integer >= 1").describe("first line to return, 1-based (default 1)"),
  "limit?": type("number.integer >= 1").describe(`lines to return (default ${DEFAULT_LINES})`),
});

/** inside a checkout, or a file a tool handed over. */
function isReadable(ctx: ToolContext, real: string): boolean {
  for (const repo of ctx.toolState.repos.values()) {
    const rel = relative(realpathSync(repo.dir), real);
    if (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return true;
  }
  const state = ctx.toolState;
  return [
    ...state.handedOver,
    state.summaryFilePath,
    state.learningsFilePath,
    state.xrepoLearningsFilePath,
  ].some((path) => path !== undefined && existsSync(path) && realpathSync(path) === real);
}

/** a checkout's `.git/config` (the native read deny), matched by inode so a case variant on a
 * case-insensitive volume (`.GIT/CONFIG`), a short name or a hard link cannot dodge it. */
function isGitConfig(ctx: ToolContext, fd: number): boolean {
  const opened = fstatSync(fd, { bigint: true });
  return [...ctx.toolState.repos.values()].some((repo) => {
    const config = statSync(join(repo.dir, ".git", "config"), {
      bigint: true,
      throwIfNoEntry: false,
    });
    return config?.dev === opened.dev && config.ino === opened.ino;
  });
}

/** the path `fd` is actually open on. on Linux it comes from the descriptor itself, so a symlink
 * swapped in after the check cannot redirect the read. */
function openedPath(fd: number, real: string): string {
  return process.platform === "linux" ? readlinkSync(`/proc/self/fd/${fd}`) : real;
}

function numberLines(params: { text: string; offset: number; limit: number }) {
  const lines = params.text.replace(/\n$/, "").split("\n");
  const start = params.offset - 1;
  let content = "";
  let end = start;
  for (const line of lines.slice(start, start + params.limit)) {
    const next = `${end + 1}\t${line}\n`;
    if (content && content.length + next.length > MAX_CHARS) break;
    content += next.length > MAX_CHARS ? `${next.slice(0, MAX_CHARS)} [line truncated]\n` : next;
    end++;
  }
  return { totalLines: lines.length, startLine: params.offset, endLine: end, content };
}

/**
 * codex has no native read tool, so without the MCP shell it could not open a file at all
 * (#1623). reach is the checkouts plus what Pullfrog's own tools wrote for it — never the rest
 * of the tmpdir (askpass codes, the codex home) or anything else the action process can see.
 */
export function ReadFileTool(ctx: ToolContext) {
  return tool({
    name: "read_file",
    description:
      "Read a file (numbered lines) or list a directory. Reaches the repository checkouts and the " +
      "files Pullfrog tools hand you (diffs, CI logs, review threads, the summary and learnings files).",
    parameters: ReadFile,
    execute: execute(async (params) => {
      const requested = resolve(primaryRepoState(ctx.toolState).dir, params.path);
      const real = realpathSync(requested);
      if (!isReadable(ctx, real)) {
        throw new Error(
          `${params.path} is not readable: read_file reaches the checkouts (except .git/config) and the files Pullfrog tools handed over`
        );
      }
      const fd = openSync(real, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      try {
        if (openedPath(fd, real) !== real) throw new Error(`${params.path} changed while opening`);
        if (isGitConfig(ctx, fd))
          throw new Error(`${params.path} is not readable: it is a checkout's .git/config`);
        if (fstatSync(fd).isDirectory()) {
          // listed through the descriptor on Linux, so a swap after the check is not followed
          const entries = readdirSync(process.platform === "linux" ? `/proc/self/fd/${fd}` : real, {
            withFileTypes: true,
          });
          return {
            path: real,
            entries: entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)),
          };
        }
        const bytes = readFileSync(fd);
        if (bytes.subarray(0, 8000).includes(0)) throw new Error(`${params.path} is a binary file`);
        return {
          path: real,
          ...numberLines({
            text: bytes.toString("utf8"),
            offset: params.offset ?? 1,
            limit: params.limit ?? DEFAULT_LINES,
          }),
        };
      } finally {
        closeSync(fd);
      }
    }),
  });
}
