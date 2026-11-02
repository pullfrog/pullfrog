const THUMBS_UP_QUERY = `
query ($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on PullRequestReviewComment {
      id
      reactions(content: THUMBS_UP, first: 100) { nodes { user { login } } }
    }
  }
}
`;

type ThumbsUpResponse = {
  nodes: ({
    id?: string;
    reactions?: { nodes: ({ user: { login: string } | null } | null)[] | null };
  } | null)[];
};

/** the slice of a run or webhook context the lookup needs — shared by the action and the server. */
type ThumbsUpCtx = {
  octokit: { graphql: <T>(query: string, variables: Record<string, unknown>) => Promise<T> };
};

/** the ids of the review comments `username` reacted 👍 to, one `nodes()` read per 100 (#1509). */
export async function getThumbsUpCommentIds(
  ctx: ThumbsUpCtx,
  params: { commentIds: string[]; username: string }
): Promise<Set<string>> {
  const needle = params.username.toLowerCase();
  const approved = new Set<string>();
  for (let i = 0; i < params.commentIds.length; i += 100) {
    const response = await ctx.octokit.graphql<ThumbsUpResponse>(THUMBS_UP_QUERY, {
      ids: params.commentIds.slice(i, i + 100),
    });
    for (const node of response.nodes) {
      const reactors = node?.reactions?.nodes ?? [];
      if (node?.id && reactors.some((r) => r?.user?.login.toLowerCase() === needle)) {
        approved.add(node.id);
      }
    }
  }
  return approved;
}
