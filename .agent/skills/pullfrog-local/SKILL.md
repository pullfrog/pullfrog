---
name: pullfrog-local
description: >
  Scaffold and operate a full-local Pullfrog stack (no pullfrog.com dashboard)
  that approximates SaaS features via GitHub Actions: @mention agent, auto PR
  review / re-review, issue enrichment, address-reviews, CI autofix, manual
  dispatch, and mode instructions. Use when the user wants local Pullfrog,
  self-hosted agent, SaaS-like features without console, DIY orchestration,
  pullfrog workflows on EC2, or runs /pullfrog-local.
metadata:
  short-description: "Local Pullfrog (SaaS features via Actions)"
---

# /pullfrog-local - Full-local Pullfrog (no dashboard)

Implement a **dashboard-free** Pullfrog that still covers SaaS behaviors by
encoding them as **GitHub Actions workflows + secrets + prompt contracts**.
The open-source action (`Weltel-repo/weltel-pullfrog` or this fork) remains the
**runtime**; you own **orchestration**.

Do **not** re-enable upstream product CI files (`publish.yml`, `trigger-sync.yml`,
`test.yml`) unless the user is maintaining the action itself. Agent UX lives in
**target product repos** (or a dedicated agent-home repo).

## Architecture (mental model)

```
GitHub events / @mention / workflow_dispatch / check_suite
        │
        ▼
.github/workflows/*  (YOUR orchestration — replaces console toggles)
        │  workflow_call → pullfrog.yml
        ▼
pullfrog action on self-hosted runner  [self-hosted, Linux, X64]
        │  modes: Review | IncrementalReview | Build | Fix | Plan | …
        ▼
GitHub API (comments, reviews, PRs, pushes) via GH_TOKEN or App tokens
```

| SaaS piece | Local replacement |
|------------|-------------------|
| Console toggles | Workflow `if:` + enable/disable workflow files |
| Mode instructions | Files under `.github/pullfrog/instructions/` injected into prompts |
| Dashboard dispatch | `workflow_dispatch` on `pullfrog.yml` |
| `@pullfrog` webhooks | `triggers.yml` on comment/issue/review events |
| Auto PR review | `pullfrog-review.yml` on `pull_request` |
| Re-review on push | Same workflow on `synchronize` + IncrementalReview prompt |
| Issue enrichment | `pullfrog-issues.yml` on `issues: opened` |
| Address reviews | `pullfrog-address-reviews.yml` on `pull_request_review` |
| CI autofix | `pullfrog-ci-fix.yml` on `check_suite` / `workflow_run` |
| Pullfrog secrets / Router | GitHub Actions secrets (BYOK) |
| App OIDC via pullfrog.com | **`GH_TOKEN`** (PAT or your GitHub App installation token) |

## Non-negotiables

1. **Runner** — jobs use `runs-on: [self-hosted, Linux, X64]` (or labels you configured).
2. **Auth for write** — without official Pullfrog App + OIDC to their API, set:
   ```yaml
   env:
     GH_TOKEN: ${{ secrets.PULLFROG_GITHUB_TOKEN }}
   ```
   Token must allow: `contents`, `pull_requests`, `issues`, `checks`, `actions:read`
   (classic PAT scopes or fine-grained equivalents; prefer a **GitHub App
   installation token** minted in a prior step if you already have App ID + key).
3. **LLM keys** — at least one of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
   `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, etc. in the `env:` block.
4. **Omit** `API_URL` / `VERCEL_AUTOMATION_BYPASS_SECRET` unless you intentionally
   talk to a hosted Pullfrog API.
5. **Single reusable entrypoint** — all features `workflow_call` into `pullfrog.yml`.
6. **Prompt contract** — always pass either:
   - raw text for dispatch, or
   - `toJSON(github.event)` plus a short **mode hint** so the agent picks Review / Build / Plan reliably.

## When invoked — do this

### Step 0: Clarify scope

Ask only if missing:

- **Target repo** (path or `owner/name`) — product repo that will get workflows.
- **Action source**: `Weltel-repo/weltel-pullfrog@main` vs `pullfrog/pullfrog@v0` vs `./`.
- **Features to enable** (default: **all** listed below).
- **Runner labels** (default: `[self-hosted, Linux, X64]`).
- **Mention handle** (default: `@pullfrog`).

### Step 1: Scaffold files

Create (or update) these under the **target** repo. Full YAML lives in
[references/workflows.md](references/workflows.md) — copy from there; do not invent
divergent shapes.

```text
.github/
  workflows/
    pullfrog.yml                 # reusable + workflow_dispatch entry
    pullfrog-triggers.yml        # @mention / general agent
    pullfrog-review.yml          # auto review + re-review
    pullfrog-issues.yml          # issue enrich (plan/build/label)
    pullfrog-address-reviews.yml # address human review on agent PRs
    pullfrog-ci-fix.yml          # autofix failed CI
  pullfrog/
    config.yml                   # feature flags + defaults (documentation + prompt hints)
    instructions/
      review.md
      build.md
      plan.md
```

If the target is **this** action repo, still put product-facing agent workflows
in a product repo unless the user explicitly wants self-dogfood here.

### Step 2: Secrets checklist

Ensure (org or repo Actions secrets):

| Secret | Purpose |
|--------|---------|
| `PULLFROG_GITHUB_TOKEN` | PAT or long-lived bot token **or** install a prior step that mints App token into `GH_TOKEN` |
| `ANTHROPIC_API_KEY` (or other) | Model access |
| Optional model keys | Multi-provider |

Document required secrets in the PR description when scaffolding.

### Step 3: Feature flag matrix (SaaS parity)

Encode SaaS toggles in `.github/pullfrog/config.yml` and/or workflow `if:`.

| SaaS feature | Local trigger | Mode / prompt hint |
|--------------|---------------|--------------------|
| Manual / dashboard prompt | `workflow_dispatch` | free text |
| Tag agent anywhere | `issue_comment`, `pull_request_review_comment`, issue body | event JSON; agent `select_mode` |
| Auto-review new PRs | `pull_request` opened / ready_for_review | **Review** |
| Re-review on new commits | `pull_request` synchronize | **IncrementalReview** |
| Include drafts | `if:` allow `draft == true` | same |
| Issue enrich → Plan | `issues` opened | **Plan** |
| Issue enrich → Build | `issues` opened | **Build** |
| Auto-label issues | same job or separate prompt | label-only instructions |
| Address reviews (agent PRs) | `pull_request_review` submitted | **AddressReviews** |
| `@pullfrog` fix request | comment contains `@pullfrog` | Build / AddressReviews |
| Fix CI on agent PRs | `check_suite` completed failure | **Fix** |
| Fix CI on reviewed PRs | same + “prior pullfrog review exists” heuristic in prompt | **Fix** |
| Status checks | `status_checks: enabled` on action | `pullfrog` + `pullfrog-approval` |
| Mode instructions | prepend files from `instructions/*.md` | — |

**Honest gaps** (call out; do not fake):

- **Fix all / Fix 👍s UI buttons** — need comment-body conventions or a small bot later; approximate with:
  - `@pullfrog fix all`
  - `@pullfrog fix thumbs` (agent lists 👍-reacted threads)
- **Exact re-review coalescing** (SaaS merges in-flight reviews) — use `concurrency:` groups per PR.
- **Pullfrog Router billing** — N/A; BYOK only.
- **Console-stored mode instructions** — files under `.github/pullfrog/instructions/`.

### Step 4: Concurrency & runaway protection

Always set on feature workflows:

```yaml
concurrency:
  group: pullfrog-${{ github.workflow }}-${{ github.event.pull_request.number || github.event.issue.number || github.ref }}
  cancel-in-progress: true
```

CI-fix workflow: limit retries (e.g. skip if last commit message contains
`[pullfrog-ci-fix]` or if author is the bot and fix count ≥ N — encode in `if:`
or prompt guardrails).

### Step 5: Verify

1. Confirm runner online: org/repo **Settings → Actions → Runners**.
2. Dispatch `Pullfrog` with prompt: `List top-level dirs and summarize the stack.`
3. Open a throwaway PR → expect Review comment/review.
4. Comment `@pullfrog what is this PR doing?` → expect reply.
5. Open a bare issue → expect plan comment if issues enrichment enabled.

### Step 6: Report to user

Summarize:

- Files created/updated
- Secrets still missing
- Which SaaS features are live vs approximate
- How to toggle features (disable workflow or edit `config.yml` + `if:`)
- Next step for a future dashboard (events already standardized: all call `pullfrog.yml` with `prompt` + `name`)

## Implementation rules for the agent

- Prefer **editing existing** scaffold files over duplicating workflows.
- Keep `pullfrog.yml` as the **only** place that invokes the action + env keys.
- Inject instructions:

  ```yaml
  prompt: |
    ## Mode instructions (Review)
    ${{ hashFiles('.github/pullfrog/instructions/review.md') && format('{0}', '') }}
  ```

  Prefer an explicit step that reads files:

  ```yaml
  - id: instr
    run: |
      {
        echo "review<<PULLFROG_EOF"
        cat .github/pullfrog/instructions/review.md 2>/dev/null || true
        echo "PULLFROG_EOF"
      } >> "$GITHUB_OUTPUT"
  ```

  then pass `${{ steps.instr.outputs.review }}` into the composite prompt (only
  on the leaf job in `pullfrog.yml`, or pass path and have the action prompt
  include “read `.github/pullfrog/instructions/…`”).

  **Simplest reliable approach:** tell the agent in the prompt text:

  > Before acting, read `.github/pullfrog/instructions/{mode}.md` if present and follow it.

- Use `uses: Weltel-repo/weltel-pullfrog@main` unless user specified fork/`./`.
- Permissions on the **caller** job: `contents: read` is enough when `GH_TOKEN`
  is a PAT/App token; still set `id-token: write` if you later switch to OIDC.
- Do not commit real secrets. Do not paste private keys into skill output.
- Conventional commits if you commit: `feat(ci): add local pullfrog agent workflows`.

## Default feature set when user says “full SaaS-like local”

Enable all of:

1. `workflow_dispatch` general agent  
2. `@pullfrog` triggers  
3. Auto PR review + re-review (`concurrency` per PR)  
4. Issue opened → Plan  
5. Address reviews when review state is changes_requested / commented on bot PRs  
6. CI failure → Fix (bot PRs first; optional second workflow for all PRs)  
7. Instruction files for review/build/plan  
8. `status_checks: enabled` optional (off by default; mention for branch protection)

## Slash / usage

- `/pullfrog-local` — scaffold or update full stack on a target repo  
- `/pullfrog-local review-only` — only review workflows  
- `/pullfrog-local status` — check runner, secrets names, workflow files present  

## References

- Workflow templates: [references/workflows.md](references/workflows.md)
- Upstream docs (behavior reference, not required hosting): https://docs.pullfrog.com/
- Action inputs: repo `action.yml`
- Modes: repo `modes.ts` (Review, IncrementalReview, Build, Fix, Plan, AddressReviews, …)
