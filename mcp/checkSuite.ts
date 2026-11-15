import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type } from "arktype";
import { log } from "../utils/log.ts";
import type { ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";

export const GetCheckSuiteLogs = type({
  check_suite_id: type.number.describe("the id from check_suite.id"),
});

type LogLine = {
  line: number;
  content: string;
  type: "error" | "warning" | "failure" | "trace";
};

type LogAnalysis = {
  totalLines: number;
  index: LogLine[];
  excerpt: {
    content: string;
    startLine: number;
    endLine: number;
  };
};

function analyzeLog(logs: string, excerptLines = 80): LogAnalysis {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape codes use control chars
  const clean = logs.replace(/\x1b\[[0-9;]*m/g, "");
  const lines = clean.split("\n");
  const totalLines = lines.length;

  const index: LogLine[] = [];

  const patterns: Array<{ type: LogLine["type"]; pattern: RegExp; skip?: RegExp }> = [
    { type: "error", pattern: /##\[error\]/i },
    { type: "error", pattern: /\bError:/i },
    { type: "error", pattern: /\bERR_/i },
    { type: "error", pattern: /exit code [1-9]/i },
    { type: "warning", pattern: /##\[warning\]/i },
    { type: "warning", pattern: /\bWARN\b/i, skip: /apt|dpkg|Reading package/i },
    { type: "failure", pattern: /\d+ failed/i },
    { type: "failure", pattern: /FAIL\b/i },
    { type: "failure", pattern: /✕|✗|×/ },
    { type: "trace", pattern: /^\s+at\s+/i },
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    for (const p of patterns) {
      if (p.pattern.test(line)) {
        if (p.skip?.test(line)) continue;

        // dedupe consecutive traces
        if (p.type === "trace" && index.length > 0 && index[index.length - 1].type === "trace") {
          continue;
        }

        // truncate long lines
        const truncated = line.length > 120 ? line.slice(0, 117) + "..." : line;

        index.push({
          line: i + 1,
          content: truncated.trim(),
          type: p.type,
        });
        break;
      }
    }
  }

  // find excerpt range: focus on LAST ##[error] line
  let errorLine = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/##\[error\]/i.test(lines[i])) {
      errorLine = i;
      break;
    }
  }

  let start: number;
  let end: number;

  if (errorLine === -1) {
    start = Math.max(0, totalLines - excerptLines);
    end = totalLines;
  } else {
    const contextAfter = 5;
    const contextBefore = excerptLines - contextAfter;
    start = Math.max(0, errorLine - contextBefore);
    end = Math.min(totalLines, errorLine + contextAfter);
  }

  return {
    totalLines,
    index,
    excerpt: {
      content: lines.slice(start, end).join("\n"),
      startLine: start + 1,
      endLine: end,
    },
  };
}

type JobLogResult = {
  job_id: number;
  job_name: string;
  job_url: string;
  failed_steps: string[];
  log_index: LogLine[];
  excerpt: {
    start_line: number;
    end_line: number;
    total_lines: number;
    content: string;
  };
  full_log_path: string;
};

export function GetCheckSuiteLogsTool(ctx: ToolContext) {
  return tool({
    name: "get_check_suite_logs",
    description:
      "get workflow run logs for a failed check suite. returns a log_index of interesting lines, " +
      "a curated excerpt, and full_log_path for deeper investigation. " +
      "pass check_suite.id from the webhook payload.",
    parameters: GetCheckSuiteLogs,
    execute: execute(async (params) => {
      const check_suite_id = params.check_suite_id;

      // get workflow runs for this specific check suite
      const workflowRuns = await ctx.octokit.paginate(
        ctx.octokit.rest.actions.listWorkflowRunsForRepo,
        {
          owner: ctx.repo.owner,
          repo: ctx.repo.name,
          check_suite_id,
          per_page: 100,
          request: { signal: AbortSignal.timeout(10_000) },
        }
      );

      const failedRuns = workflowRuns.filter((run) => run.conclusion === "failure");

      if (failedRuns.length === 0) {
        return {
          check_suite_id,
          message: "no failed workflow runs found for this check suite",
          failed_jobs: [],
        };
      }

      // setup logs directory
      const tempDir = process.env.PULLFROG_TEMP_DIR;
      if (!tempDir) {
        throw new Error("PULLFROG_TEMP_DIR not set");
      }
      const logsDir = join(tempDir, "ci-logs");
      mkdirSync(logsDir, { recursive: true });

      const jobResults: JobLogResult[] = [];

      // get logs for each failed run
      for (const run of failedRuns) {
        const jobs = await ctx.octokit.paginate(ctx.octokit.rest.actions.listJobsForWorkflowRun, {
          owner: ctx.repo.owner,
          repo: ctx.repo.name,
          run_id: run.id,
          request: { signal: AbortSignal.timeout(10_000) },
        });

        // only process failed jobs
        const failedJobs = jobs.filter((job) => job.conclusion === "failure");

        for (const job of failedJobs) {
          try {
            const logsResponse = await ctx.octokit.rest.actions.downloadJobLogsForWorkflowRun({
              owner: ctx.repo.owner,
              repo: ctx.repo.name,
              job_id: job.id,
              request: { signal: AbortSignal.timeout(10_000) },
            });

            const logsUrl = logsResponse.url;
            const logsResult = await fetch(logsUrl, { signal: AbortSignal.timeout(10_000) });
            if (!logsResult.ok) {
              throw new Error(
                `failed to fetch logs: ${logsResult.status} ${logsResult.statusText}`
              );
            }
            const logsText = await logsResult.text();

            // write full log to disk
            const logPath = join(logsDir, `job-${job.id}.log`);
            writeFileSync(logPath, logsText);
            ctx.toolState.handedOver.add(logPath);

            // analyze log
            const analysis = analyzeLog(logsText, 80);

            // get failed steps
            const failedSteps =
              job.steps
                ?.filter((s) => s.conclusion === "failure")
                .map((s) => `Step ${s.number}: ${s.name}`) ?? [];

            jobResults.push({
              job_id: job.id,
              job_name: job.name,
              job_url: job.html_url ?? "",
              failed_steps: failedSteps,
              log_index: analysis.index,
              excerpt: {
                start_line: analysis.excerpt.startLine,
                end_line: analysis.excerpt.endLine,
                total_lines: analysis.totalLines,
                content: analysis.excerpt.content,
              },
              full_log_path: logPath,
            });

            log.debug(`analyzed logs for job ${job.name}: ${analysis.index.length} indexed lines`);
          } catch (error) {
            log.info(`failed to fetch logs for job ${job.id}: ${error}`);
          }
        }
      }

      return {
        _instructions: {
          overview:
            "this result contains CI failure information. use log_index to find interesting lines, then read full_log_path for details.",
          fields: {
            log_index:
              "array of interesting lines (errors, warnings, failures) with line numbers. use these to navigate the full log.",
            excerpt:
              "a curated ~80 line window around the last error. may not show all failures if they occur in different places.",
            full_log_path:
              "path to the complete log file. read specific line ranges using the line numbers from log_index.",
            failed_steps:
              "which CI steps failed. read the workflow yml to understand what commands these steps run.",
          },
          workflow: [
            "1. scan log_index to see where errors/warnings/failures are located",
            "2. read excerpt for immediate context",
            "3. if excerpt doesn't show what you need, read specific line ranges from full_log_path",
            "4. check failed_steps to understand what command failed",
          ],
        },
        check_suite_id,
        repo: `${ctx.repo.owner}/${ctx.repo.name}`,
        failed_jobs: jobResults,
      };
    }),
  });
}
