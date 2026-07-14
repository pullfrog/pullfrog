import { describe, expect, it } from "vitest";
import { mapGithubEvent } from "./githubEvent.ts";

describe("mapGithubEvent", () => {
  describe("issue_comment", () => {
    it("scopes PR conversation comments with is_pr + issue_number", () => {
      const event = mapGithubEvent("issue_comment", {
        action: "created",
        issue: {
          number: 156,
          title: "PL-6565: Add checkin frequency",
          pull_request: {
            url: "https://api.github.com/repos/o/r/pulls/156",
          },
        },
        comment: {
          id: 42,
          body: "@pullfrog fix all",
        },
      });

      expect(event).toEqual({
        trigger: "issue_comment_created",
        comment_id: 42,
        comment_type: "issue",
        body: "@pullfrog fix all",
        issue_number: 156,
        is_pr: true,
        title: "PL-6565: Add checkin frequency",
      });
      // push_branch run-scope check
      expect(event?.is_pr === true && event.issue_number === 156).toBe(true);
    });

    it("does not set is_pr for plain issue comments", () => {
      const event = mapGithubEvent("issue_comment", {
        action: "created",
        issue: {
          number: 99,
          title: "bug report",
        },
        comment: {
          id: 7,
          body: "@pullfrog help",
        },
      });

      expect(event).toEqual({
        trigger: "issue_comment_created",
        comment_id: 7,
        comment_type: "issue",
        body: "@pullfrog help",
        issue_number: 99,
      });
      expect(event?.is_pr).toBeUndefined();
    });
  });

  describe("pull_request_review_comment", () => {
    it("maps inline review comments as PR-scoped", () => {
      const event = mapGithubEvent("pull_request_review_comment", {
        action: "created",
        pull_request: {
          number: 12,
          title: "feat",
          head: { ref: "feature-x" },
        },
        comment: {
          id: 100,
          body: "nit",
        },
      });

      expect(event).toMatchObject({
        trigger: "pull_request_review_comment_created",
        issue_number: 12,
        is_pr: true,
        comment_id: 100,
        body: "nit",
        branch: "feature-x",
      });
    });
  });

  describe("pull_request", () => {
    it("maps opened / synchronize actions", () => {
      expect(
        mapGithubEvent("pull_request", {
          action: "opened",
          pull_request: {
            number: 3,
            title: "t",
            body: "b",
            head: { ref: "br" },
          },
        })
      ).toMatchObject({
        trigger: "pull_request_opened",
        issue_number: 3,
        is_pr: true,
        branch: "br",
      });

      expect(
        mapGithubEvent("pull_request", {
          action: "synchronize",
          before: "abc",
          pull_request: {
            number: 3,
            title: "t",
            body: null,
            head: { ref: "br" },
          },
        })
      ).toMatchObject({
        trigger: "pull_request_synchronize",
        issue_number: 3,
        is_pr: true,
        before_sha: "abc",
      });
    });
  });

  describe("check_suite", () => {
    it("scopes to the first associated PR", () => {
      const event = mapGithubEvent("check_suite", {
        action: "completed",
        check_suite: {
          id: 1,
          head_sha: "deadbeef",
          head_branch: "ci-branch",
          status: "completed",
          conclusion: "failure",
          url: "https://api.github.com/…",
          pull_requests: [{ number: 44, head: { ref: "ci-branch" } }],
        },
      });

      expect(event).toMatchObject({
        trigger: "check_suite_completed",
        issue_number: 44,
        is_pr: true,
        branch: "ci-branch",
      });
    });
  });

  describe("workflow_dispatch", () => {
    it("returns workflow_dispatch trigger", () => {
      expect(mapGithubEvent("workflow_dispatch", { inputs: {} })).toEqual({
        trigger: "workflow_dispatch",
      });
    });
  });

  it("returns null for unmapped event names", () => {
    expect(mapGithubEvent("push", { ref: "refs/heads/main" })).toBeNull();
  });
});
