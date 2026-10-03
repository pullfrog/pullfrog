import { describe, expect, it } from "vitest";
import { resolveCarriedApproval } from "./statusChecks.ts";

type CheckRun = { conclusion: string; completed_at: string; app: { slug: string } };

function makeCtx(params: {
  commits: string[];
  checks: Record<string, CheckRun[]>;
  outstanding?: number;
}) {
  const refsQueried: string[] = [];
  const ctx = {
    repo: { owner: "o", name: "r" },
    octokit: {
      graphql: async <T>(query: string): Promise<T> => {
        if (query.includes("reviewThreads")) {
          const nodes = Array.from({ length: params.outstanding ?? 0 }, () => ({
            isResolved: false,
            comments: { nodes: [{ author: { login: "pullfrog[bot]" } }] },
          }));
          return {
            repository: {
              pullRequest: {
                reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
              },
            },
          } as T;
        }
        return {
          repository: {
            pullRequest: {
              commits: { nodes: params.commits.map((oid) => ({ commit: { oid } })) },
            },
          },
        } as T;
      },
      rest: {
        checks: {
          listForRef: async ({ ref }: { ref: string }) => {
            refsQueried.push(ref);
            return { data: { check_runs: params.checks[ref] ?? [] } };
          },
        },
      },
    },
  };
  return { ctx, refsQueried };
}

const pullfrogRun = (conclusion: string, completed_at = "2026-10-01T00:00:00Z"): CheckRun => ({
  conclusion,
  completed_at,
  app: { slug: "pullfrog" },
});

describe("resolveCarriedApproval", () => {
  it("carries a prior approval forward when no Pullfrog thread is open", async () => {
    const { ctx } = makeCtx({ commits: ["a", "b"], checks: { a: [pullfrogRun("success")] } });
    const result = await resolveCarriedApproval(ctx, { pullNumber: 1, sha: "b", beforeSha: "a" });
    expect(result).toEqual({ wouldApprove: true, carriedFrom: "a" });
  });

  it("downgrades a prior approval while a Pullfrog thread is still open", async () => {
    const { ctx } = makeCtx({
      commits: ["a", "b"],
      checks: { a: [pullfrogRun("success")] },
      outstanding: 1,
    });
    const result = await resolveCarriedApproval(ctx, { pullNumber: 1, sha: "b", beforeSha: "a" });
    expect(result).toEqual({ wouldApprove: false, carriedFrom: "a" });
  });

  it("never upgrades a prior rejection, even with zero open threads", async () => {
    const { ctx } = makeCtx({ commits: ["a", "b"], checks: { a: [pullfrogRun("failure")] } });
    const result = await resolveCarriedApproval(ctx, { pullNumber: 1, sha: "b", beforeSha: "a" });
    expect(result).toEqual({ wouldApprove: false, carriedFrom: "a" });
  });

  it("uses the latest verdict when a commit carries several", async () => {
    const { ctx } = makeCtx({
      commits: ["a", "b"],
      checks: {
        a: [
          pullfrogRun("success", "2026-10-01T00:00:00Z"),
          pullfrogRun("failure", "2026-10-02T00:00:00Z"),
        ],
      },
    });
    const result = await resolveCarriedApproval(ctx, { pullNumber: 1, sha: "b", beforeSha: "a" });
    expect(result).toEqual({ wouldApprove: false, carriedFrom: "a" });
  });

  it("ignores pullfrog-approval rows posted by GitHub Actions", async () => {
    const { ctx } = makeCtx({
      commits: ["a", "b"],
      checks: { a: [{ ...pullfrogRun("success"), app: { slug: "github-actions" } }] },
    });
    const result = await resolveCarriedApproval(ctx, { pullNumber: 1, sha: "b", beforeSha: "a" });
    expect(result).toBeUndefined();
  });

  it("walks back past unreviewed commits to the most recent verdict", async () => {
    const { ctx, refsQueried } = makeCtx({
      commits: ["a", "b", "c", "d"],
      checks: { a: [pullfrogRun("failure")], b: [pullfrogRun("success")] },
    });
    const result = await resolveCarriedApproval(ctx, {
      pullNumber: 1,
      sha: "d",
      beforeSha: undefined,
    });
    expect(result).toEqual({ wouldApprove: true, carriedFrom: "b" });
    expect(refsQueried).toEqual(["d", "c", "b"]);
  });

  it("skips commits pushed after the assessed sha", async () => {
    const { ctx } = makeCtx({
      commits: ["a", "b", "c"],
      checks: { a: [pullfrogRun("failure")], c: [pullfrogRun("success")] },
    });
    const result = await resolveCarriedApproval(ctx, {
      pullNumber: 1,
      sha: "b",
      beforeSha: undefined,
    });
    expect(result).toEqual({ wouldApprove: false, carriedFrom: "a" });
  });

  it("finds the pre-force-push head through beforeSha", async () => {
    const { ctx } = makeCtx({ commits: ["x", "y"], checks: { old: [pullfrogRun("success")] } });
    const result = await resolveCarriedApproval(ctx, { pullNumber: 1, sha: "y", beforeSha: "old" });
    expect(result).toEqual({ wouldApprove: true, carriedFrom: "old" });
  });

  it("treats an unresolvable force-pushed beforeSha as no verdict", async () => {
    const { ctx } = makeCtx({ commits: ["a", "b"], checks: { a: [pullfrogRun("success")] } });
    const listForRef = ctx.octokit.rest.checks.listForRef;
    ctx.octokit.rest.checks.listForRef = async (params) => {
      if (params.ref === "gone") throw new Error("No commit found for SHA: gone");
      return listForRef(params);
    };
    const result = await resolveCarriedApproval(ctx, {
      pullNumber: 1,
      sha: "b",
      beforeSha: "gone",
    });
    expect(result).toEqual({ wouldApprove: true, carriedFrom: "a" });
  });

  it("aborts rather than skip a PR commit whose verdict could not be read", async () => {
    const { ctx } = makeCtx({ commits: ["a", "b", "c"], checks: { a: [pullfrogRun("success")] } });
    const listForRef = ctx.octokit.rest.checks.listForRef;
    ctx.octokit.rest.checks.listForRef = async (params) => {
      if (params.ref === "b") throw new Error("502");
      return listForRef(params);
    };
    await expect(
      resolveCarriedApproval(ctx, { pullNumber: 1, sha: "c", beforeSha: "b" })
    ).rejects.toThrow("502");
  });

  it("posts nothing when the assessed sha already has a verdict", async () => {
    const { ctx } = makeCtx({
      commits: ["a", "b"],
      checks: { a: [pullfrogRun("failure")], b: [pullfrogRun("success")] },
    });
    const result = await resolveCarriedApproval(ctx, { pullNumber: 1, sha: "b", beforeSha: "a" });
    expect(result).toBeUndefined();
  });

  it("posts nothing when no commit carries a verdict", async () => {
    const { ctx } = makeCtx({ commits: ["a", "b"], checks: {} });
    const result = await resolveCarriedApproval(ctx, { pullNumber: 1, sha: "b", beforeSha: "a" });
    expect(result).toBeUndefined();
  });
});
