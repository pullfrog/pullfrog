// changes to mode definitions should be reflected in docs/modes.mdx
import { REVIEWER_AGENT_NAME } from "./agents/reviewer.ts";
import { type AgentId, formatMcpToolRef, pullfrogMcpName } from "./external.ts";

export interface Mode {
  name: string;
  description: string;
  // step-by-step guidance returned when the agent calls select_mode.
  // custom user-defined modes supply this; built-in modes define it here.
  prompt?: string | undefined;
}

// Default user-facing summary format embedded in BOTH Review and
// IncrementalReview review bodies. The two modes share the preamble +
// cross-cutting + nitpicks shape; the only difference is scope (full PR for
// Review vs delta against the prior pullfrog review for IncrementalReview).
// Distinct from the agent-internal snapshot (action/utils/prSummary.ts) which
// has its own stable scaffold and is never shaped by user instructions — see
// selectMode.ts for the firewall.
const PR_SUMMARY_FORMAT = `### Default format

The body has at most three parts, in this order:

1. **Reviewed changes preamble** — a bolded \`**Reviewed changes**\` lead-in with one sentence on what was reviewed in this run (for \`IncrementalReview\`: what changed since the prior pullfrog review), then a bullet list of the substantive changes — short bolded title, one sentence each. A reviewer should understand the full reviewed scope from this list alone. Close the preamble with the metadata comment below.
2. **Cross-cutting issue sections** (zero or more) — one \`### {emoji} {what's wrong, not what to do}\` heading per concern.
3. **\`### ℹ️ Nitpicks\`** at the very bottom, if any — a flat bullet list, no technical-details block.

**Inline vs. body.** Concerns that anchor to a specific line go inline (the \`comments\` parameter), even when their implications are broad. Body \`### \` sections are reserved for concerns that have **no line to anchor to** — *absence* (something the diff should have done but didn't), *sequencing* (rollout / deletion / migration order), *design decisions only the human can make*, or *scope questions the diff raises but doesn't address*. With no non-anchorable concerns, the body is just the preamble + metadata.

**Severity emoji** on every \`### \` heading, and nowhere else: 🚨 critical (blocks merge — data loss, security, broken core flow) · ⚠️ important (must address before merging) · ℹ️ informational (mergeable as-is).

**Blank line between every block-level element.** GitHub's markdown parser requires one before and after HTML tags (\`<details>\`, \`<summary>\`, \`<sub>\`, \`<br/>\`) — without it GitHub treats what follows as a continuation of the HTML block and renders your markdown as literal text. This is a parser quirk, not a style preference, and it permanently breaks the posted review.

## Metadata comment

Fill every field from the \`checkout_pr\` response — never count files or commits by hand. For \`IncrementalReview\`, fill \`Prior pullfrog review\` from \`list_pull_request_reviews\`.

\`\`\`
<!--
Pullfrog review metadata. These findings were written against {head_sha_short};
if commits have landed on {head_ref} since, treat every specific bug, file, or
line callout as POTENTIALLY STALE and re-diff before acting on it.

- Mode: Review (initial)   or   IncrementalReview (delta against prior pullfrog review)
- Files reviewed: {file_count}
- Commits reviewed: {commit_count}
- Base: {base_ref} ({base_sha_short})
- Head: {head_ref} ({head_sha_short})
- Reviewed commits:
  - {sha_short} — {commit_subject}
- Prior pullfrog review: none   or   {prior_sha_short} ({prior_review_html_url})
-->
\`\`\`

## Technical details

Every body \`### \` section carries one; an inline comment carries one when its fix is non-trivial or spans files. The visible part above it states the PROBLEM in 2-3 sentences — what's broken and what the blast radius is. Asks, fixes, and open questions live inside the block, which a downstream fix-agent pulls down as its brief, so \`file:line\` refs and identifier density belong here.

\`\`\`
<details><summary>Technical details</summary>

\\\`\\\`\\\`\\\`markdown
# {title}

## Affected sites
- {file path:line} — {what's wrong there}

## Required outcome
- {what the fix needs to achieve, not how to achieve it}

## Suggested approach (optional)
## Open questions for the human (optional)
\\\`\\\`\\\`\\\`

</details>
\`\`\`

The 4-backtick fence lets the block hold its own 3-backtick fences and stay one-click copyable. Skip the optional sections when they'd add nothing.

Backtick-wrap identifiers and file names. Don't repeat diff content, don't include raw \`+123 / -45\` stats, no changelog, no horizontal rules, and no \`### Key changes\` / \`### Issues found\` / \`<b>TL;DR</b>\` heading — each \`### \` heading IS the issue.`;

export function computeModes(agentId: AgentId, signedCommits = false): Mode[] {
  const t = (toolName: string) => formatMcpToolRef(agentId, toolName);
  // signed-commits mode swaps the local-commit + push flow for the
  // commit_changes tool (API-created, GitHub-signed commits — no push step)
  const commitStep = signedCommits
    ? `commit via \`${t("commit_changes")}\` — it lands a GitHub-signed commit directly on the remote branch (no push step)`
    : `commit locally via shell (\`git add . && git commit -m "..."\`)`;
  const finalizeStep = signedCommits
    ? `confirm a clean working tree (\`git status\`) — your \`${t("commit_changes")}\` calls already landed the work on the remote`
    : `confirm a clean working tree, then push via \`${t("push_branch")}\``;
  // the dsh harness ships with every native tool disabled (see agents/dsh.ts):
  // all file I/O and shell go through the pullfrog MCP tools. the mode
  // guidance must say so or the agent burns turns looking for tools that
  // aren't registered.
  const buildStep =
    agentId === "dsh"
      ? `4. **build**: implement changes via the pullfrog MCP tools — this harness has NO native file or shell tools, so every file read/write and every command runs through \`${t("shell")}\` (and \`${t("git")}\` for git plumbing):
   - follow the plan (if you ran a plan phase)
   - plan your approach before writing code: identify which files need to change, key design decisions, and edge cases. for non-trivial changes, consider whether there's a more elegant approach.
   - run relevant tests/lints before committing`
      : `4. **build**: implement changes using your native file and shell tools:
   - follow the plan (if you ran a plan phase)
   - plan your approach before writing code: identify which files need to change, key design decisions, and edge cases. for non-trivial changes, consider whether there's a more elegant approach.
   - run relevant tests/lints before committing`;
  return [
    {
      name: "Build",
      description:
        "Implement, build, create, or develop code changes; make specific changes to files or features; execute a plan; or handle tasks with specific implementation details",
      prompt: `### Checklist

1. **task list**: create your task list for this run as your first action.

2. **plan** (optional, for complex tasks): analyze requirements, read AGENTS.md and relevant code, produce a step-by-step implementation plan.

3. **setup**: checkout or create the branch:
   - **PR event, modifying the existing PR**: call \`${t("checkout_pr")}\`
   - **new branch**: use \`${t("git")}\` to create a branch (\`git checkout -b pullfrog/branch-name\`)

${buildStep}

5. **self-review**: unless the diff has no behavioral surface at all — docs, comments, whitespace, import reordering, lockfile or generated-code regeneration, a mechanical rename, a trusted dep patch bump — dispatch the \`${REVIEWER_AGENT_NAME}\` subagent to review it with fresh eyes against YOUR TASK. Line count is not the signal: a one-line change to auth, money, SQL, a comparison operator, a redirect, or a config default earns a pass. When in doubt, run it — a false-positive dispatch costs cents, a missed bug costs much more.

   Before dispatching, make \`origin/<base>\` available: \`git fetch --no-tags --deepen=1000 origin <base>:refs/remotes/origin/<base>\`. The explicit destination refspec is required — a shallow single-branch checkout otherwise only updates \`FETCH_HEAD\` and never creates the tracking ref. The reviewer is read-only by contract, so fetching is your job.

   In the dispatch prompt: say this is a PRE-COMMIT self-review whose work is uncommitted in the working tree, give the branch and base, name \`git diff --merge-base origin/<base>\` as the canonical diff command, paste YOUR TASK, and summarize any build-phase failures. If that diff comes back empty, there is nothing to review — stop.

   Give it the diff and the task, nothing else. Do not summarize what you implemented, curate a reading list of files, or pre-shape the output with a severity schema — each biases the reviewer toward validating your solution instead of questioning it. Where the diff rests on third-party API, SDK, framework, or DB-engine semantics, tell it to verify load-bearing claims by web search and quote sources.

   Treat what comes back as hypotheses, not directives: verify each against the code before applying, and reject findings that would add ceremony without correctness — defensive checks for cases that cannot happen, single-use abstractions, comments restating code, tautological tests. After applying what you accept, re-read your own diff and revert anything that turned out to be bloat. Then ${commitStep}.

6. **finalize**:
   - ${finalizeStep} (see *SYSTEM* Git rules if this fails — prepush errors are usually the repo's tests/lint, not infra timeouts)
   - create a PR via \`${t("create_pull_request")}\`
   - call \`${t("report_progress")}\` with the PR link or the exact error if push/PR failed

### Notes

For simple, well-defined tasks, skip the plan phase and go straight to build.`,
    },
    {
      name: "AddressReviews",
      description:
        "Address PR review feedback; respond to reviewer comments; make requested changes to an existing PR",
      prompt: `### Checklist

1. **task list**: create your task list for this run as your first action.

2. Checkout the PR branch via \`${t("checkout_pr")}\`.

3. Fetch review comments via \`${t("get_review_comments")}\`.

4. For each comment:
   - understand the feedback
   - **verify the finding yourself** against the actual code before deciding whether to apply — every comment (human or agent) is a hypothesis, not a directive. agent reviewers especially are fallible.
   - you are searching for a solution that is **complete, minimal, and elegant** — you may need to think hard to find it. do not over-engineer, do not be over-defensive, **do not write AI slop**. reviewers bias toward *recommending additions*, and that bias has a recognizable slop texture: defensive checks for impossible cases, extra abstractions used once, comments restating obvious code, tests asserting tautologies, "just-in-case" guards, error handlers for cases the type system already rules out. reject those. evaluate whether applying the finding would leave the code more **sound, correct, AND elegant**; two-out-of-three is a signal to look harder for a fix that gets all three. if a request would add bloat — ceremony without commensurate correctness benefit — push back in your reply rather than mechanically applying it.
   - if the request stands, make the code change via the pullfrog MCP tools (\`${t("shell")}\` etc. — this harness has no native tools); otherwise reply explaining why
   - record what was done (or why nothing was done)

5. Quality check:
   - test changes, then review the diff before committing — verify only intended changes are present, no debug artifacts remain, no fix turned out to be bloat in context (revert any that did), and the changes are clean enough that a senior engineer would approve without hesitation
   - ${commitStep}

6. Finalize. Reply + resolve are paired write actions: do BOTH or NEITHER for each thread.
   - ${finalizeStep} (same push/prepush guidance as Build mode in *SYSTEM*)
   - **if the push/commit fails**, call \`${t("report_progress")}\` with the exact error and STOP — do NOT reply or resolve any thread until the fix is live on the remote. Resolving a thread without the fix landing misleads the reviewer.
   - **once the fix is live on the remote**, for each thread you acted on:
     - reply ONCE via \`${t("reply_to_review_comment")}\`. The \`comment_id\` parameter takes the root comment's numeric \`id=\` (from the first \`comment author=...\` tag in the \`${t("get_review_comments")}\` output) — NOT the \`thread=\` value; that's a separate GraphQL ID used by resolve. The runtime dedupes identical bodies within a session.
     - **immediately** call \`${t("resolve_review_thread")}\` with that thread's \`thread=\` value as \`thread_id\`. Resolve every thread where you (a) made the requested code change in full — partial fixes leave the thread open — OR (b) replied with a substantive answer the user explicitly asked for. Do NOT resolve threads where you pushed back on the request and the disagreement is unresolved; leave those open for the human to mediate.
   - call \`${t("report_progress")}\` with a brief summary`,
    },
    // Review and IncrementalReview route the minimum reviewfrog specialists
    // needed to cover unresolved, disposition-changing hypotheses. Most runs
    // use zero or one; multiple orthogonal hypotheses dispatch in parallel.
    //
    // Build mode self-review is a different problem shape: the orchestrator
    // wrote the code, so bias-mitigation comes from delegating to one
    // fresh-eyes subagent that doesn't share the implementation context. A
    // single subagent there is appropriate. Review-mode specialist routing
    // instead scales with the unresolved hypotheses in someone else's diff.
    //
    // Severity categorization is split across two surfaces: the opening
    // callout (CAUTION/IMPORTANT/ℹ️/✅) sets the review's overall tier, and
    // per-bullet emoji prefixes (🚨/⚠️/ℹ️ in PR_SUMMARY_FORMAT) tag
    // individual points inside summary sections — scoping severity to the
    // specific bullet rather than the whole section keeps a section that
    // mixes a 🚨 and an ℹ️ from being mislabeled by either of them.
    {
      name: "Review",
      description:
        "Review code, PRs, or implementations; provide feedback or suggestions; identify issues; or check code quality, style, and correctness",
      prompt: `### Checklist

1. **task list**: create your task list for this run as your first action.

2. **checkout**: call \`${t("checkout_pr")}\` — this returns PR metadata, a \`diffPath\`, and a supplemental \`impactPath\` when change-impact extraction is enabled. read the complete raw diff end-to-end, beginning with the TOC and using its file line ranges as your coverage checklist. only after that, use \`impactPath\` as an explicitly incomplete list of reference leads; it never replaces raw-diff reading or establishes coverage.

3. **triage**: orient yourself on the PR — identify *what kind of thing this is* (domain it touches, seams it crosses, external contracts it depends on, user-facing surfaces it changes). pull as much context as you need to render a confident, well-grounded review: read related files, grep for callers of changed symbols, check tests that exercise the touched paths, fetch related GitHub state. **you are the synthesizer** — never delegate understanding to subagents.

   when the diff adds or changes a test, check that it can actually fail: a test that would still pass with the bug present is theatre, not coverage. the usual tell is a loose assertion standing where an exact one belongs — \`>=\` or a truthiness check over an expected value, or a snapshot that absorbs whatever it is handed. read the assertion against the behavior it claims to pin, not against whether it currently passes.

   skip the deeper pass and submit a \`No new issues found.\` review per step 7 only when the diff has **no behavioral surface at all** — doc typos, whitespace/formatting, lockfile or generated-code regeneration, a mechanical rename whose only effect is import-path updates. line count is not the signal: a one-line change to auth, money, SQL, a comparison operator, a redirect, or a config default is not trivial.

4. **specialist decision**: after reading the complete diff, name the questions you still cannot answer confidently yourself, and dispatch one \`${REVIEWER_AGENT_NAME}\` specialist per question. a question qualifies only when a specialist could return evidence that **changes your disposition** on the PR — generic requests for another look, extra confidence, or polish do not. most reviews need zero or one; some need several.

   **There is NO one-specialist cap or fixed maximum.** cover every orthogonal question that remains; do not collapse several real questions into one broad prompt just to reduce the count. there is no file-count, line-count, or budget threshold either — diff size is not a proxy for review uncertainty.

   frame each question through the lens that primes the right failure modes. for high-stakes subsystems, lead with the **domain** ("the billing lens", "the auth lens", "the schema-migration lens") rather than the generic equivalent ("correctness on billing code") — the domain framing makes the subagent recall double-charges, refund races, currency rounding, and dispute flows that a generic lens misses.

   you remain the synthesizer: reading the complete raw diff, investigating surrounding code, validating every returned finding, and writing the review are yours. specialist reads supplement that work; they never satisfy your own coverage obligation.

5. **dispatch specialists (only if step 4 found unresolved questions)**: for 2+ questions, emit every Task tool_use block **IN A SINGLE ASSISTANT TURN** before reading any result, so the investigations run in parallel rather than serially. your own \`read\` / \`grep\` / \`webfetch\` calls can ride in that same turn at zero extra wall time.

   if a specialist errors out, times out, or returns nothing usable, retry it once. if it still fails, resolve the question yourself; if it remains disposition-changing and unresolved, surface the limitation and do not approve. each dispatch carries:
   - **the absolute \`diffPath\` (and \`incrementalDiffPath\` if available) from step 2's \`${t("checkout_pr")}\` return, named verbatim in the dispatch prompt** (e.g. \`diffPath: /tmp/pullfrog-XXXX/pr-NNN-SHA.diff\`). the reviewer's baked-in system prompt selects its FIRST action on this token — paraphrasing ("review the diff", "look at this PR") sends it down a \`git diff origin/<base>\` fallback that fails on shallow GHA checkouts. it \`read\`s those files for scope and must NOT re-derive the diff itself; reading and codebase exploration are still its job.
   - **exactly one falsifiable question with explicit scope boundaries** — ask for evidence that supports or refutes it, never a broad "review for X, Y, and Z" prompt.
   - **a Task \`description\` set to a short hypothesis label** (e.g. \`"webhook-replay"\`, \`"billing-rounding"\`) — the harness reads this field to label the subagent's log lines so parallel runs can be told apart. without it, every subagent shows up as \`subagent#N\`.
   - if the question touches third-party API, SDK, or framework contracts, instruct the subagent to verify load-bearing claims via web search and quote source URLs rather than trust training data. action runs are non-interactive — nobody is in the loop to catch "I'm pretty sure Stripe does X."
   - ask for findings with file paths and NEW line numbers from the diff so you can validate and anchor them.

   delegation discipline: do NOT summarize the PR for them (a lossy summary biases toward a validation frame; the raw diff is the source), do NOT hand them a curated reading list, do NOT pre-shape their output with a finding schema, and do NOT mention the other specialists — independence is the point, and overlapping findings are a strong signal.

6. **aggregate & draft**: when specialist results land, merge findings; de-dup overlaps (two specialists catching the same issue = higher-confidence signal); trace each finding yourself before accepting it. drop praise, style preferences, speculative/unverified claims, findings about pre-existing code unrelated to the PR (heuristic: if the finding's root cause lives in lines this PR added or modified, it's in scope; otherwise drop unless the PR plausibly introduced or amplified the regression), and anything not actionable. also drop **bloat-shaped findings** — proposed fixes that would add defensive checks for cases that can't happen, abstractions used once, comments restating obvious code, tests asserting tautologies, or "just-in-case" guards. subagents are fallible and bias toward recommending changes; the bar for an actionable inline comment is sound + correct + elegant. recommending a change that improves only one of the three (or worse, degrades elegance to nominally improve correctness) makes the codebase worse, not better.

   **Hunt for non-anchored concerns before drafting.** After collecting your anchored findings, deliberately scan for concerns that have no specific line to point at — typically: deletion / cleanup plans for code the diff replaces or shadows; rollout sequencing (what happens to in-flight state during deploy / revert?); coverage gaps the diff implies but doesn't add; scope questions that only the human can answer (e.g. is the legacy path going away or is this a long-term dual track?); architectural risks the diff opens up that aren't a single-line bug. On substantial PRs (migrations, refactors, multi-file rewrites, version bumps that change runtime semantics), at least one such concern almost always exists; if you can't think of any, your bar is probably too high.

   for surviving findings, draft inline comments with NEW line numbers from the diff — attach a \`<details>Technical details</details>\` block to any inline comment whose fix is non-trivial or has cross-file implications (see Inline technical details in the format below). every comment must be actionable, 2-3 sentences max in the visible part. use GitHub permalink format for code references. for impact-analysis findings (stale references after rename/remove), report them in the review body ordered by severity (runtime breakage > incorrect docs > stale comments) rather than as inline comments unless they're anchored to a specific line.

7. **submit**: ALWAYS submit exactly one review via \`${t("create_pull_request_review")}\`. Do NOT call \`report_progress\` — the review is the final record and the progress comment will be cleaned up automatically.

   note: the first create_pull_request_review submission may error with a one-time diff-coverage nudge listing unread TOC regions. retry the same call to proceed — optionally after reading the listed ranges. the pre-flight will not block again this session.

   The review body is structured as: \`[optional alert blockquote]\` → \`[PR summary using the default format below]\`. Inline comments are passed via the \`comments\` parameter, not in the body.

   The opening callout is what the author sees first — pick the one that matches what you want them to do. Five tiers, from loudest to friendliest:

   - \`[!CAUTION]\` — large red banner. Reads as "this will break something."
   - \`[!IMPORTANT]\` — large purple banner. Reads as "you need to look at this before merging."
   - \`> ℹ️ ...\` — informational blockquote. Reads as "minor suggestions, nothing blocking."
   - \`> ✅ ...\` — green friendly blockquote. Reads as "no concerns, mergeable."

   Two reinforcing levers: callout intensity (above) and \`approved\` (which gates the footer Fix-button affordance — Fix renders on every non-approving review, so \`approved: true\` suppresses it). Wrapping mergeable feedback in \`[!IMPORTANT]\` trains users to click Fix on reviews that don't need fixing. Pick the tier the author's actual next action justifies.

   - **critical issues** (blocks merge — bugs, security, data loss, broken core flows):
     \`approved: false\`. Body opens with \`> [!CAUTION]\\n> This PR introduces ...\`, followed by the PR summary. Include all inline comments via \`comments\`.
   - **must-address non-critical findings** (real consequences if shipped — incorrect behavior in non-critical paths, missing validation on user input, regressions the author should fix before merge):
     \`approved: false\`. Body opens with \`> [!IMPORTANT]\\n> ...\`, followed by the PR summary. Reserve this tier for findings with concrete fallout — do NOT use \`[!IMPORTANT]\` for nits, style preferences, or "consider also" suggestions. Include all inline comments via \`comments\`.
   - **minor suggestions only** (single-line nits, doc/comment polish, defer-able observations, "rough edges"):
     \`approved: false\`. Body opens with \`> ℹ️ No critical issues — minor suggestions inline.\\n\\n\` followed by the PR summary. Include all inline comments via \`comments\`. Vary the wording after the emoji to fit the review (e.g. "Minor suggestions only.", "Two rough edges worth a look."), but always keep the ℹ️ prefix and keep it short.
   - **informational observations** (mergeable as-is, nothing actionable — e.g. prior feedback addressed cleanly, surfacing a minor stale doc reference, calling out something noteworthy without recommending a change):
     \`approved: true\`. Body opens with \`> ✅ No new issues found.\\n\\n\` followed by the PR summary. Do NOT include inline \`comments\` — the ✅ signals "no action needed", which contradicts an actionable anchor; if a point is concrete enough to anchor to a line, downgrade the whole review to "minor suggestions only" (\`approved: false\`) instead.
   - **no actionable issues**:
     \`approved: true\`. Body opens with \`> ✅ No new issues found.\\n\\n\` followed by the PR summary.

${PR_SUMMARY_FORMAT}`,
    },
    // IncrementalReview shares Review's minimum hypothesis-covering specialist
    // routing and body format, scoped to the incremental delta against the
    // prior Pullfrog review. The "issues must be NEW since the last Pullfrog
    // review" filter lives at aggregation time, NOT in the subagent
    // prompt — pushing the filter into subagents matches the canonical anneal
    // anti-pattern of "list known pre-existing failures — don't flag these"
    // and suppresses signal on regressions the new commits amplified. A
    // separate "Prior review feedback" checklist would duplicate the rolling
    // PR summary snapshot's record of what earlier runs already addressed and
    // add noise to the user-facing body. Same opening-callout + per-bullet
    // emoji severity split as Review.
    {
      name: "IncrementalReview",
      description:
        "Re-review a PR after new commits are pushed; focus on new changes since the last review",
      prompt: `### Checklist

1. **task list**: create your task list for this run as your first action.

2. **checkout**: call \`${t("checkout_pr")}\` — this returns PR metadata, \`diffPath\` (full diff), \`incrementalDiffPath\` (changes since last reviewed version, if available), and a supplemental \`impactPath\` when change-impact extraction is enabled.

3. **incremental scope**: if \`incrementalDiffPath\` is present, read it FIRST to see what changed since the last review. this is a range-diff that isolates the net changes, filtering out base branch noise. then read the authoritative full diff end-to-end, beginning with the TOC and using its line ranges as your coverage checklist. if no incremental diff is present, start with the full-diff TOC, determine what changed since Pullfrog's most recent review, and complete the raw-diff read. only after establishing that authoritative scope and completing raw-diff coverage, use \`impactPath\` as an explicitly incomplete list of reference leads; it never replaces raw-diff reading or establishes coverage.

4. **prior feedback — read AND retire it**: fetch previous reviews via \`${t("list_pull_request_reviews")}\`, then call \`${t("get_review_comments")}\` on each prior Pullfrog review. Each thread renders as a section whose first line is a fenced tag \`comment author=<login> id=<fullDatabaseId> review=<reviewId> thread=<graphqlId>\`; section headers carry \`[RESOLVED]\` / \`[OUTDATED]\` when relevant. For every **open, Pullfrog-originated** thread, decide and act:

   - **Pullfrog-originated** means the FIRST \`comment author=...\` tag in the section is \`author=pullfrog[bot]\`. The \`*\` marker on individual comments is unrelated — it flags whether a comment belongs to the queried review, not whether it is the thread root.
   - **addressed?** read the file at the thread's anchor and judge whether the substantive concern is now resolved by the new commits. Lines being modified isn't enough: reformatting, renaming, or moving the same code elsewhere doesn't address a concern. If the comment raised multiple distinct concerns, ALL must be addressed. The \`[OUTDATED]\` tag means GitHub moved the anchor (line shift, force-push, rename) — it does NOT mean the concern was addressed; re-read the code at its new location before deciding.
   - **if addressed**: call \`${t("reply_to_review_comment")}\` with the root tag's numeric \`id=\` as \`comment_id\` (NOT the \`thread=\` value — that's a separate GraphQL ID used only by resolve) and a one-line body (e.g. \`Addressed in <short-sha>.\`), then call \`${t("resolve_review_thread")}\` with the root tag's \`thread=\` value as \`thread_id\`. Do this BEFORE drafting the new review so the GitHub thread state aligns with the new review by the time it lands.
   - **if uncertain or partially addressed**: leave open. False-positive resolutions erode trust faster than false negatives.
   - **scope**: only retire Pullfrog-originated threads. Threads from human reviewers belong to those humans to resolve, even if the commit happened to address them.

   The remaining open threads feed step 8's dedup filter — anything already flagged and unchanged by the new commits should not be re-raised. The rolling PR summary snapshot is the durable record of retire activity; you don't need to surface it in the review body.

5. **triage**: orient on the *incremental* changes — domain, seams, external contracts, user-facing surfaces. pull as much context as you need to render a confident review: read related files, grep for callers of changed symbols, check tests that exercise the touched paths. **you are the synthesizer.**

   a test added or changed in this delta must be able to fail — one that would still pass with the bug present is theatre, not coverage. the tell is a loose assertion where an exact one belongs (\`>=\` or a truthiness check over an expected value, a snapshot that absorbs whatever it is handed).

   skip the deeper pass and jump to step 10's non-substantive path (do NOT submit a review) only when the incremental changes have **no behavioral surface at all** — formatting, comment tweaks, import reordering, lockfile regen, a mechanical rename of import paths. line count is not the signal: a one-line change to auth, money, SQL, a comparison operator, a redirect, or a config default is not trivial.

6. **specialist decision**: after covering the incremental and full diffs, name the questions about the new changes that you still cannot answer confidently yourself, and dispatch one \`${REVIEWER_AGENT_NAME}\` specialist per question. a question qualifies only when a specialist could return evidence that **changes your disposition** on the PR — generic requests for another look, extra confidence, or polish do not. most incremental reviews need zero or one, especially thread-reply re-reviews; some need several.

   **There is NO one-specialist cap or fixed maximum.** cover every orthogonal question that remains; do not collapse several real questions into one broad prompt just to reduce the count. there is no file-count, line-count, or budget threshold either — diff size is not a proxy for review uncertainty.

   frame each question through the lens that primes the right failure modes. for high-stakes subsystems, lead with the **domain** ("the billing lens", "the auth lens", "the schema-migration lens") rather than the generic equivalent — the domain framing makes the subagent recall failure modes a generic lens misses.

   you remain the synthesizer: reading the complete raw full diff plus the incremental diff, investigating surrounding code, validating every returned finding, and writing the review are yours. specialist reads supplement that work; they never satisfy your own coverage obligation.

7. **dispatch specialists (only if step 6 found unresolved questions)**: for 2+ questions, emit every Task tool_use block **IN A SINGLE ASSISTANT TURN** before reading any result, so the investigations run in parallel rather than serially. your own \`read\` / \`grep\` / \`webfetch\` calls can ride in that same turn.

   if a specialist errors out, times out, or returns nothing usable, retry it once. if it still fails, resolve the question yourself; if it remains disposition-changing and unresolved, surface the limitation and do not approve. each dispatch carries:
   - **the absolute diff path(s) from step 2's \`${t("checkout_pr")}\` return, named verbatim in the dispatch prompt.** when \`incrementalDiffPath\` is present, name BOTH (\`incrementalDiffPath: /tmp/.../pr-NNN-SHA-incremental.diff\` then \`diffPath: /tmp/.../pr-NNN-SHA.diff\`) — the reviewer's baked-in prompt reads incremental first and uses full for context; when only \`diffPath\` exists, name it alone. it \`read\`s those files and must NOT re-derive the diff itself; paraphrasing ("review the new commits") sends it down a \`git diff\` fallback that fails on shallow GHA checkouts. do NOT tell them to skip pre-existing issues — that suppresses regressions the new commits amplified; the "issues must be NEW" filter lives at aggregation time (step 8), not in the subagent prompt.
   - **exactly one falsifiable question with explicit scope boundaries** — ask for evidence that supports or refutes it, never a broad "review for X, Y, and Z" prompt.
   - **a Task \`description\` set to a short hypothesis label** — the harness reads this field to label log lines so parallel runs can be told apart.
   - if the question touches third-party API, SDK, or framework contracts, instruct the subagent to verify load-bearing claims via web search and quote source URLs.
   - ask for findings with file paths and NEW line numbers from the full PR diff so you can validate and anchor them.

   delegation discipline: do NOT summarize the changes for them (a lossy summary biases toward a validation frame; the raw diff is the source), do NOT hand them a curated reading list, do NOT pre-shape their output with a finding schema, and do NOT mention the other specialists — independence is the point.

8. **aggregate, draft, self-critique**: merge findings (yours + output from every specialist you dispatched); de-dup overlaps; trace each finding yourself. drop praise, style preferences, speculative/unverified claims, findings about pre-existing code unrelated to the new commits, anything not actionable, and anything that re-states prior review feedback (heuristic: if the finding's root cause lives in lines the *new commits* added or modified, it's in scope; otherwise drop). also drop **bloat-shaped findings** — proposed fixes that would add defensive checks for cases that can't happen, abstractions used once, comments restating obvious code, tests asserting tautologies, or "just-in-case" guards. subagents are fallible and bias toward recommending changes; the bar for an actionable inline comment is sound + correct + elegant. recommending a change that improves only one of the three (or degrades elegance to nominally improve correctness) makes the codebase worse, not better. To compute "lines the new commits added or modified": if \`incrementalDiffPath\` from step 2 is present, use it directly. Otherwise, take the prior Pullfrog review's \`commit_id\` (returned alongside each entry from \`${t("list_pull_request_reviews")}\` in step 4) and run \`git diff <prior-review-sha>..HEAD\` to isolate the lines added since that review.

   **Hunt for non-anchored concerns before drafting.** After collecting your anchored findings, deliberately scan for concerns that have no specific line to point at — typically: deletion / cleanup plans for code the new commits replace or shadow; rollout sequencing (what happens to in-flight state during deploy / revert?); coverage gaps the new commits imply but don't add; scope questions that only the human can answer (e.g. is the legacy path going away or is this a long-term dual track?); architectural risks the new commits open up that aren't a single-line bug. On substantial incremental diffs (migrations, refactors, multi-file rewrites, version bumps that change runtime semantics), at least one such concern almost always exists; if you can't think of any, your bar is probably too high.

   draft inline comments with NEW line numbers from the full PR diff — attach a \`<details>Technical details</details>\` block to any inline comment whose fix is non-trivial or has cross-file implications (see Inline technical details in the format below). every comment must be actionable, 2-3 sentences max in the visible part.

9. **build the review body**: use the same default format as Review mode (preamble + optional cross-cutting \`### \` sections + optional \`### ℹ️ Nitpicks\`) — scoped to the **incremental delta**, not the full PR. The "Reviewed changes" bullets describe what changed since the prior pullfrog review (each bullet starts with a past-tense verb, e.g. \`- Extracted shared CLI runtime into a single module\`). Do NOT include a separate "Prior review feedback" checklist — that's tracked in the rolling PR summary snapshot for the next agent run, and surfacing it in the user-facing body is noise (changes that addressed prior feedback are already covered by the Reviewed-changes bullets). In some cases you may receive a complete diff for the whole PR instead of an incremental one; when this happens, determine what changed since Pullfrog's most recent review yourself before drafting bullets.

10. Submit — every run must end with EXACTLY ONE of \`${t("create_pull_request_review")}\` (substantive review) or \`${t("report_progress")}\` (no-review acknowledgement). do NOT call \`create_issue_comment\` for review output.

   Same callout ladder as Review mode — \`[!CAUTION]\` (red, "will break") → \`[!IMPORTANT]\` (purple, "must address before merging") → \`> ℹ️ ...\` (informational, "minor suggestions only") → \`> ✅ ...\` (green friendly, "no concerns"). Same Fix-button lever: the footer renders a Fix button on every non-approving review, so \`approved: true\` suppresses it. Wrapping mergeable feedback in \`[!IMPORTANT]\` trains users to click Fix on reviews that don't need fixing — pick the tier the author's actual next action justifies.

   Follow these rules:
   - note: the first create_pull_request_review submission may error with a one-time diff-coverage nudge listing unread TOC regions. retry the same call to proceed — optionally after reading the listed ranges. the pre-flight will not block again this session.
   - IF NO NEW ISSUES, NON-SUBSTANTIVE CHANGES ONLY (trivial formatting, import reordering, comment tweaks): do NOT submit a review. Instead call \`${t("report_progress")}\` with a 1-2 sentence note explaining no review was warranted (e.g. "No new issues. Changes since last review are formatting-only."). this leaves a visible signal that the run completed.
   - ELSE IF NEW CRITICAL ISSUES (blocks merge — bugs, security, data loss, broken core flows): call \`${t("create_pull_request_review")}\` with \`approved: false\`, all comments, and the review body. body opens with \`> [!CAUTION]\\n> This PR introduces ...\`, followed by the PR summary using the default format below.
   - ELSE IF NEW MUST-ADDRESS NON-CRITICAL FINDINGS (real consequences if shipped — incorrect behavior, missing validation, regressions the author should fix before merge): call \`${t("create_pull_request_review")}\` with \`approved: false\`, all comments, and the review body. body opens with \`> [!IMPORTANT]\\n> ...\`, followed by the PR summary using the default format below. Do NOT use this tier for nits, style preferences, or "consider also" suggestions.
   - ELSE IF NEW MINOR SUGGESTIONS ONLY (single-line nits, doc/comment polish, defer-able observations, "rough edges"): call \`${t("create_pull_request_review")}\` with \`approved: false\`, all comments, and the review body. body opens with \`> ℹ️ No critical issues — minor suggestions inline.\\n\\n\` (vary the wording after ℹ️ to fit the review), followed by the PR summary using the default format below.
   - ELSE IF INFORMATIONAL OBSERVATIONS (mergeable as-is, but worth surfacing — e.g. prior feedback addressed cleanly with one minor stale doc reference, or a noteworthy positive observation): call \`${t("create_pull_request_review")}\` with \`approved: true\`, NO inline comments, and the review body. body opens with \`> ✅ No new issues found.\\n\\n\` (or similar friendly green opener), followed by the PR summary using the default format below. If a point is concrete enough to anchor to a line, downgrade the whole review to "minor suggestions only" (\`approved: false\`) instead — the ✅ signals "no action needed", which contradicts an actionable anchor.
   - ELSE IF NO NEW ISSUES, SUBSTANTIVE CHANGES (new functionality, behavior changes, or fixes to prior review feedback): call \`${t("create_pull_request_review")}\` to create a PR review. If all previous reviews have been properly addressed and no new issues were discovered, set \`approved: true\`. body opens with \`> ✅ No new issues found.\\n\\n\`, followed by the PR summary using the default format below.

${PR_SUMMARY_FORMAT}`,
    },
    {
      name: "Plan",
      description:
        "Create plans, break down tasks, outline steps, analyze requirements, understand scope of work, or provide task breakdowns",
      prompt: `### Checklist

1. **task list**: create your task list for this run as your first action.

2. Analyze the task and gather context:
   - read AGENTS.md and relevant codebase files
   - understand the architecture and constraints

3. Produce a structured, actionable plan with clear milestones.

4. Call \`${t("report_progress")}\` with the plan body. Do NOT set \`target_plan_comment\` — that flag is exclusively for revising an existing plan, and \`${t("select_mode")}\` will route you to a separate PlanEdit checklist when a prior plan comment exists for this issue.`,
    },
    {
      name: "Fix",
      description:
        "Fix CI failures; debug failing tests or builds; investigate and resolve check suite failures",
      prompt: `### Checklist

1. **task list**: create your task list for this run as your first action.

2. Checkout the PR branch via \`${t("checkout_pr")}\`.

3. Fetch check suite logs via \`${t("get_check_suite_logs")}\`.

4. **CRITICAL**: verify the failure was INTRODUCED BY THIS PR before fixing. If unrelated, abort and report.

5. Diagnose and fix:
   - read the workflow file, reproduce locally with the EXACT same commands CI runs
   - fix the issue using your native file and shell tools
   - verify the fix by re-running the exact CI command
   - review the diff before committing — verify only the fix is present, no debug artifacts, no unrelated changes. the fix should be clean enough that a senior engineer would approve without hesitation.
   - ${commitStep}

6. Finalize:
   - ${finalizeStep} (same push/prepush guidance as Build mode in *SYSTEM*)
   - call \`${t("report_progress")}\` with the diagnosis and fix summary (or the exact push error if push failed)`,
    },
    {
      name: "ResolveConflicts",
      description: "Resolve merge conflicts in a PR branch against the base branch",
      prompt: `### Checklist

1. **task list**: create your task list for this run as your first action.

2. **Setup**:
   - Call \`${t("checkout_pr")}\` to get the PR branch.
   - Call \`${t("get_pull_request")}\` to identify the base branch (e.g., 'main').
   - Call \`${t("git_fetch")}\` to fetch the base branch.

3. **Merge Attempt**:
   - Run \`git merge ${signedCommits ? "--no-commit " : ""}origin/<base_branch>\` via shell.
   - If it succeeds automatically, ${signedCommits ? `conclude it via \`${t("commit_changes")}\` (it turns the pending merge into a signed merge commit on the remote)` : `confirm a clean working tree, push via \`${t("push_branch")}\` (same push/prepush guidance as Build mode in *SYSTEM*)`}, and call \`${t("report_progress")}\` with a brief success note or the exact error if it failed — **then stop; do not run steps 4–5.**
   - If it fails (conflicts), resolve them manually (continue to steps 4–5).

4. **Resolve Conflicts**:
   - Run \`git status\` or parse the merge output to find the list of conflicting files.
   - For each conflicting file: read it, find the conflict markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`), understand the code context, and rewrite the file with the correct resolution. Remove all markers.
   - Verify the file syntax is correct after resolution.

5. **Finalize**:
   - Run a final verification (build/test) to ensure the resolution works.
   - ${signedCommits ? `\`git add .\`, then conclude via \`${t("commit_changes")}\` with message "resolve merge conflicts"` : `\`git add . && git commit -m "resolve merge conflicts"\``}
   - ${finalizeStep} (same push/prepush guidance as Build mode in *SYSTEM*)
   - Call \`${t("report_progress")}\` with a summary of what was resolved (or the exact push error if push failed)`,
    },
    {
      name: "Task",
      description:
        "General-purpose tasks that don't fit other modes: answering questions, adding comments, labeling, running ad-hoc commands, or any direct request",
      prompt: `### Checklist

1. **task list**: create your task list for this run as your first action.

2. Analyze the task. For simple operations (labeling, answering questions, running a single command), handle directly — but your answer only reaches the user through \`${t("report_progress")}\` (step 4); raw assistant text is discarded. If a standalone comment on the current issue/PR is the task's sole requested deliverable, create that comment directly and skip \`${t("report_progress")}\`.

3. For substantial work — code changes across multiple files, multi-step investigations:
   - plan your approach before starting
   - use native file and shell tools for local operations
   - use ${pullfrogMcpName} MCP tools for GitHub/git operations
   - if code changes are needed: review your own diff before committing — verify only intended changes are present, no debug artifacts remain, and the changes are clean enough that a senior engineer would approve without hesitation

4. Finalize:
   - if code changes were made, get them onto a pull request (new or existing) using ${signedCommits ? `\`${t("commit_changes")}\`` : `\`${t("push_branch")}\``} and \`${t("create_pull_request")}\` as needed. \`git status\` must be clean before you finish (see *SYSTEM* Git rules if this fails).
   - call \`${t("report_progress")}\` once with results — include exact tool errors if push or PR creation failed. skip this only when a standalone comment on the current target was the task's sole requested deliverable
   - if the task involved labeling or other GitHub operations, perform those directly`,
    },
  ];
}

// static export for UI display — uses opencode format as the readable default.
// materializes at import, so it carries the BUILD-time prompt profile (env unset → `lean`).
// its only consumer is the console's built-in-prompt viewer, a client bundle that could never
// reflect a per-run profile anyway; the run path resolves the profile fresh in `main()`.
export const modes: Mode[] = computeModes("opencode");

/**
 * modes that legitimately never modify the working tree. used by the post-run
 * dirty-tree gate to suppress the "commit and push" nudge — those modes
 * complete by submitting a review (`Review` / `IncrementalReview`) or by
 * posting a Plan comment (`Plan`), not by touching files. any leftover in the
 * tree at end-of-run is incidental tool noise (e.g. a `node_modules/` from a
 * stray install attempt) on an ephemeral worktree; nudging the agent to
 * commit it would produce a spurious PR.
 */
export const NON_COMMITTING_MODES: ReadonlySet<string> = new Set([
  "Review",
  "IncrementalReview",
  "Plan",
]);
