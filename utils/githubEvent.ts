import { readFileSync } from "node:fs";
import type { PayloadEvent } from "../external.ts";
import { log } from "./cli.ts";

/**
 * Derive a structured PayloadEvent from the GitHub Actions webhook payload.
 *
 * SaaS dispatch injects a full `event` object on the JSON prompt payload.
 * Local GHA runs (e.g. Weltel mono) pass a plain-text prompt and only expose
 * the raw webhook via GITHUB_EVENT_PATH / GITHUB_EVENT_NAME. Without deriving
 * `is_pr` + `issue_number` here, push_branch treats the run as unscoped and
 * blocks legitimate pushes to pr-N → origin/<feature-branch>.
 *
 * Returns null when env is missing, unreadable, or the event cannot be mapped.
 */
export function deriveEventFromGithubActions(env: NodeJS.ProcessEnv = process.env): PayloadEvent | null {
  const eventName = env.GITHUB_EVENT_NAME;
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventName || !eventPath) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(eventPath, "utf-8"));
  } catch (err) {
    log.warning(
      `» failed to read GITHUB_EVENT_PATH (${eventPath}): ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
  if (!raw || typeof raw !== "object") return null;

  const event = raw as Record<string, unknown>;
  return mapGithubEvent(eventName, event);
}

/** pure mapper — exported for unit tests without touching the filesystem. */
export function mapGithubEvent(eventName: string, event: Record<string, unknown>): PayloadEvent | null {
  switch (eventName) {
    case "issue_comment":
      return mapIssueComment(event);
    case "pull_request_review_comment":
      return mapPullRequestReviewComment(event);
    case "pull_request_review":
      return mapPullRequestReview(event);
    case "pull_request":
      return mapPullRequest(event);
    case "issues":
      return mapIssues(event);
    case "check_suite":
      return mapCheckSuite(event);
    case "workflow_dispatch":
      return { trigger: "workflow_dispatch" };
    default:
      return null;
  }
}

function mapIssueComment(event: Record<string, unknown>): PayloadEvent | null {
  const issue = asRecord(event.issue);
  const comment = asRecord(event.comment);
  if (!issue || !comment) return null;

  const issue_number = asNumber(issue.number);
  const comment_id = asNumber(comment.id);
  if (issue_number === undefined || comment_id === undefined) return null;

  const base = {
    trigger: "issue_comment_created" as const,
    comment_id,
    comment_type: "issue" as const,
    body: asStringOrNull(comment.body),
    issue_number,
  };

  // PR conversation comments use the issues API; presence of pull_request marks a PR.
  if (issue.pull_request != null) {
    const branch = headRefFromPullRequest(asRecord(issue.pull_request));
    return {
      ...base,
      is_pr: true as const,
      title: asString(issue.title) ?? "",
      ...(branch !== undefined ? { branch } : {}),
    };
  }

  return base;
}

function mapPullRequestReviewComment(event: Record<string, unknown>): PayloadEvent | null {
  const pr = asRecord(event.pull_request);
  const comment = asRecord(event.comment);
  if (!pr || !comment) return null;

  const issue_number = asNumber(pr.number);
  const comment_id = asNumber(comment.id);
  if (issue_number === undefined || comment_id === undefined) return null;

  return {
    trigger: "pull_request_review_comment_created",
    issue_number,
    is_pr: true,
    title: asString(pr.title) ?? "",
    comment_id,
    body: asStringOrNull(comment.body),
    branch: headRefFromPullRequest(pr) ?? "",
  };
}

function mapPullRequestReview(event: Record<string, unknown>): PayloadEvent | null {
  const pr = asRecord(event.pull_request);
  const review = asRecord(event.review);
  if (!pr || !review) return null;

  const issue_number = asNumber(pr.number);
  const review_id = asNumber(review.id);
  if (issue_number === undefined || review_id === undefined) return null;

  return {
    trigger: "pull_request_review_submitted",
    issue_number,
    is_pr: true,
    review_id,
    body: asStringOrNull(review.body),
    review_state: asString(review.state) ?? "",
    branch: headRefFromPullRequest(pr) ?? "",
  };
}

function mapPullRequest(event: Record<string, unknown>): PayloadEvent | null {
  const pr = asRecord(event.pull_request);
  if (!pr) return null;

  const issue_number = asNumber(pr.number);
  if (issue_number === undefined) return null;

  const action = asString(event.action);
  const title = asString(pr.title) ?? "";
  const body = asStringOrNull(pr.body);
  const branch = headRefFromPullRequest(pr) ?? "";

  if (action === "opened") {
    return {
      trigger: "pull_request_opened",
      issue_number,
      is_pr: true,
      title,
      body,
      branch,
    };
  }
  if (action === "ready_for_review") {
    return {
      trigger: "pull_request_ready_for_review",
      issue_number,
      is_pr: true,
      title,
      body,
      branch,
    };
  }
  if (action === "synchronize") {
    return {
      trigger: "pull_request_synchronize",
      issue_number,
      is_pr: true,
      title,
      body,
      branch,
      before_sha: asString(event.before) ?? "",
    };
  }
  if (action === "review_requested") {
    return {
      trigger: "pull_request_review_requested",
      issue_number,
      is_pr: true,
      title,
      body,
      branch,
    };
  }

  // other PR actions (edited, labeled, …): still scope the run to the PR so
  // push_branch / status checks work; reuse opened-shaped fields.
  return {
    trigger: "pull_request_opened",
    issue_number,
    is_pr: true,
    title,
    body,
    branch,
  };
}

function mapIssues(event: Record<string, unknown>): PayloadEvent | null {
  const issue = asRecord(event.issue);
  if (!issue) return null;

  const issue_number = asNumber(issue.number);
  if (issue_number === undefined) return null;

  // comments on pure issues are handled by issue_comment; issues events that
  // target a PR number still exist via the issues API but usually lack pull_request.
  if (issue.pull_request != null) {
    // treat PR-shaped issues events as PR-scoped with a generic PR trigger shape
    return {
      trigger: "pull_request_opened",
      issue_number,
      is_pr: true,
      title: asString(issue.title) ?? "",
      body: asStringOrNull(issue.body),
      branch: headRefFromPullRequest(asRecord(issue.pull_request)) ?? "",
    };
  }

  const title = asString(issue.title) ?? "";
  const body = asStringOrNull(issue.body);
  const action = asString(event.action);

  if (action === "opened") {
    return { trigger: "issues_opened", issue_number, title, body };
  }
  if (action === "assigned") {
    return { trigger: "issues_assigned", issue_number, title, body };
  }
  if (action === "labeled") {
    return { trigger: "issues_labeled", issue_number, title, body };
  }

  return { trigger: "issues_opened", issue_number, title, body };
}

function mapCheckSuite(event: Record<string, unknown>): PayloadEvent | null {
  const checkSuite = asRecord(event.check_suite);
  if (!checkSuite) return null;

  const prs = Array.isArray(checkSuite.pull_requests) ? checkSuite.pull_requests : [];
  // also accept top-level pull_requests on some payloads
  const topPrs = Array.isArray(event.pull_requests) ? event.pull_requests : [];
  const firstPr = asRecord(prs[0] ?? topPrs[0]);
  if (!firstPr) return null;

  const issue_number = asNumber(firstPr.number);
  if (issue_number === undefined) return null;

  const head = asRecord(firstPr.head);
  const branch =
    asString(head?.ref) ??
    asString(checkSuite.head_branch) ??
    "";

  return {
    trigger: "check_suite_completed",
    issue_number,
    is_pr: true,
    title: "",
    body: null,
    pull_request: firstPr,
    branch,
    check_suite: {
      id: asNumber(checkSuite.id) ?? 0,
      head_sha: asString(checkSuite.head_sha) ?? "",
      head_branch: asString(checkSuite.head_branch) ?? null,
      status: asString(checkSuite.status) ?? null,
      conclusion: asString(checkSuite.conclusion) ?? null,
      url: asString(checkSuite.url) ?? "",
    },
  };
}

function headRefFromPullRequest(pr: Record<string, unknown> | null): string | undefined {
  if (!pr) return undefined;
  const head = asRecord(pr.head);
  return asString(head?.ref) ?? asString(pr.head_ref) ?? undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : null;
}
