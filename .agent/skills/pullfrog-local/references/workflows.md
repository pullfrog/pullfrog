# Local Pullfrog — workflow templates

Copy into a **target product repository**. Replace:

- `ACTION_REF` → `Weltel-repo/weltel-pullfrog@main` or `pullfrog/pullfrog@v0` or `./`
- `RUNNER` → `[self-hosted, Linux, X64]`
- `MENTION` → `@pullfrog` (escape carefully in `contains()`)

---

## `.github/pullfrog/config.yml`

Human-readable flags (workflows may duplicate critical `if:` — keep in sync).

```yaml
# Feature flags for local Pullfrog (no dashboard)
mention: "@pullfrog"
runner_labels: [self-hosted, Linux, X64]

features:
  dispatch: true
  mention_triggers: true
  pr_review:
    enabled: true
    include_drafts: false
    on_synchronize: true          # IncrementalReview
  issues:
    enabled: true
    mode: plan                    # plan | build | custom
    include_non_collaborators: true
  address_reviews:
    enabled: true
    only_bot_prs: true            # approximate “Pullfrog’s PRs”
  ci_fix:
    enabled: true
    only_bot_prs: true
    max_attempts_hint: 3

status_checks: false              # set true + action input when using branch protection
action_ref: "Weltel-repo/weltel-pullfrog@main"
```

## `.github/pullfrog/instructions/review.md`

```markdown
# Review instructions (local)

- Prefer findings with clear severity and file:line anchors.
- Flag missing tests for new logic, unsafe defaults, and authz gaps.
- Do not nitpick pure formatting if a linter owns it.
- Use Suggest changes for small mechanical fixes.
```

## `.github/pullfrog/instructions/build.md`

```markdown
# Build instructions (local)

- Match existing project patterns and package manager.
- Run the repo’s standard test/lint commands before pushing when available.
- Prefer small, focused commits/PRs.
- Never force-push to the default branch.
```

## `.github/pullfrog/instructions/plan.md`

```markdown
# Plan instructions (local)

- Post a structured plan: goal, approach, file touch list, risks, test plan.
- Ask clarifying questions only when blocked.
- Do not start implementation unless the user asked to Build.
```

---

## `.github/workflows/pullfrog.yml`

Reusable entry + manual dispatch.

```yaml
name: Pullfrog
run-name: ${{ inputs.name || github.workflow }}

on:
  workflow_dispatch:
    inputs:
      prompt:
        type: string
        description: Agent prompt
        required: true
      name:
        type: string
        description: Run name
        required: false
  workflow_call:
    inputs:
      prompt:
        type: string
        required: true
      name:
        type: string
        required: false
    secrets:
      PULLFROG_GITHUB_TOKEN:
        required: true
      ANTHROPIC_API_KEY:
        required: false
      OPENAI_API_KEY:
        required: false
      GEMINI_API_KEY:
        required: false
      OPENROUTER_API_KEY:
        required: false

permissions:
  contents: read

jobs:
  pullfrog:
    runs-on: [self-hosted, Linux, X64]
    timeout-minutes: 120
    permissions:
      contents: read
      id-token: write
    steps:
      - name: Checkout
        uses: actions/checkout@v6
        with:
          fetch-depth: 1

      - name: Run agent
        uses: Weltel-repo/weltel-pullfrog@main
        with:
          prompt: ${{ inputs.prompt }}
          # status_checks: enabled
        env:
          # Full-local auth: bypass Pullfrog.com OIDC — use PAT or App installation token
          GH_TOKEN: ${{ secrets.PULLFROG_GITHUB_TOKEN }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
```

> **Note:** For `workflow_dispatch` from the UI, map the same secrets via repo secrets
> (dispatch path does not use `workflow_call` secrets). Keep a single job env block.

If `workflow_call` secrets become painful, drop the `secrets:` block on
`workflow_call` and use `secrets: inherit` on all callers instead (simpler):

```yaml
# callers:
uses: ./.github/workflows/pullfrog.yml
with:
  prompt: ...
  name: ...
secrets: inherit
```

Then remove the `secrets:` schema under `workflow_call` in `pullfrog.yml`.

---

## `.github/workflows/pullfrog-triggers.yml`

`@pullfrog` anywhere (SaaS: tag agent).

```yaml
name: Pullfrog triggers

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  issues:
    types: [opened, edited]
  pull_request_review:
    types: [submitted]

concurrency:
  group: pullfrog-mention-${{ github.repository }}-${{ github.event.issue.number || github.event.pull_request.number || github.run_id }}
  cancel-in-progress: true

jobs:
  mention:
    if: |
      (github.event.comment && contains(github.event.comment.body, '@pullfrog')) ||
      (github.event.review && contains(github.event.review.body, '@pullfrog')) ||
      (github.event.issue && !github.event.comment && contains(github.event.issue.body, '@pullfrog'))
    permissions:
      contents: read
      id-token: write
    uses: ./.github/workflows/pullfrog.yml
    with:
      name: "@pullfrog"
      prompt: |
        You are Pullfrog running fully locally (no hosted dashboard).

        Before acting, read and follow any matching file under:
        `.github/pullfrog/instructions/` (review.md, build.md, plan.md).

        Use select_mode appropriately (Build, Plan, Review, IncrementalReview,
        Fix, AddressReviews, Task, ResolveConflicts).

        Special command conventions (approximate SaaS UI):
        - "@pullfrog fix all" → address every open review thread on the PR
        - "@pullfrog fix thumbs" → address only threads with a 👍 reaction

        Full GitHub event JSON:
        ${{ toJSON(github.event) }}
    secrets: inherit
```

---

## `.github/workflows/pullfrog-review.yml`

Auto review + re-review (SaaS: Reviews).

```yaml
name: Pullfrog PR review

on:
  pull_request:
    types: [opened, ready_for_review, synchronize, reopened]

concurrency:
  group: pullfrog-review-${{ github.repository }}-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    # Skip pure draft unless you set include_drafts
    if: github.event.pull_request.draft == false || github.event.action == 'ready_for_review'
    permissions:
      contents: read
      id-token: write
    uses: ./.github/workflows/pullfrog.yml
    with:
      name: "PR review #${{ github.event.pull_request.number }} (${{ github.event.action }})"
      prompt: |
        You are Pullfrog running fully locally (no hosted dashboard).
        Read `.github/pullfrog/instructions/review.md` if present and follow it.

        ${{ github.event.action == 'synchronize'
          && 'Mode hint: IncrementalReview — re-review only changes since the prior pullfrog review on this PR.'
          || 'Mode hint: Review — full initial PR review. Submit a proper GitHub pull request review with inline comments where useful.' }}

        After reviewing, if you would approve under project standards, you may approve
        only when there are no outstanding pullfrog findings.

        Full GitHub event JSON:
        ${{ toJSON(github.event) }}
    secrets: inherit
```

---

## `.github/workflows/pullfrog-issues.yml`

Issue enrichment (SaaS: Issues → Plan/Build).

```yaml
name: Pullfrog issues

on:
  issues:
    types: [opened]

concurrency:
  group: pullfrog-issue-${{ github.repository }}-${{ github.event.issue.number }}
  cancel-in-progress: true

jobs:
  enrich:
    permissions:
      contents: read
      id-token: write
    uses: ./.github/workflows/pullfrog.yml
    with:
      name: "Issue #${{ github.event.issue.number }} enrich"
      prompt: |
        You are Pullfrog running fully locally (no hosted dashboard).
        Read `.github/pullfrog/instructions/plan.md` and `build.md` if present.

        Mode hint: Plan — analyze this new issue and post an implementation plan
        as an issue comment. Also apply up to 3 existing repo labels that fit
        (do not invent labels). Do not open a PR unless the issue body clearly
        asks to implement immediately.

        Full GitHub event JSON:
        ${{ toJSON(github.event) }}
    secrets: inherit
```

To mimic **Build on open**, change the mode hint to Build and instruct to open a PR.

---

## `.github/workflows/pullfrog-address-reviews.yml`

Address reviews (SaaS: auto-address on agent PRs).

```yaml
name: Pullfrog address reviews

on:
  pull_request_review:
    types: [submitted]

concurrency:
  group: pullfrog-address-${{ github.repository }}-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  address:
    # Heuristic: review is changes_requested, and PR author looks like a bot / pullfrog
    if: |
      github.event.review.state == 'changes_requested' &&
      (
        contains(github.event.pull_request.user.login, '[bot]') ||
        contains(github.event.pull_request.user.login, 'pullfrog') ||
        contains(github.event.pull_request.user.login, 'weltel')
      )
    permissions:
      contents: read
      id-token: write
    uses: ./.github/workflows/pullfrog.yml
    with:
      name: "Address reviews #${{ github.event.pull_request.number }}"
      prompt: |
        You are Pullfrog running fully locally (no hosted dashboard).
        Read `.github/pullfrog/instructions/build.md` if present.

        Mode hint: AddressReviews — implement the feedback from this review and
        push commits to the PR branch. Resolve threads you fixed when possible.

        Full GitHub event JSON:
        ${{ toJSON(github.event) }}
    secrets: inherit
```

Tune the author `if:` to match your bot login / GitHub App slug.

---

## `.github/workflows/pullfrog-ci-fix.yml`

CI autofix (SaaS: Coding → fix CI).

```yaml
name: Pullfrog CI fix

on:
  check_suite:
    types: [completed]

concurrency:
  group: pullfrog-ci-${{ github.repository }}-${{ github.event.check_suite.head_sha }}
  cancel-in-progress: true

jobs:
  fix:
    if: |
      github.event.check_suite.conclusion == 'failure' &&
      github.event.check_suite.head_branch != github.event.repository.default_branch
    permissions:
      contents: read
      id-token: write
    uses: ./.github/workflows/pullfrog.yml
    with:
      name: "CI fix ${{ github.event.check_suite.head_sha }}"
      prompt: |
        You are Pullfrog running fully locally (no hosted dashboard).
        Read `.github/pullfrog/instructions/build.md` if present.

        Mode hint: Fix — a CI check suite failed. Inspect failed checks/logs,
        fix the root cause on the PR branch, push, and summarize.

        Guardrails:
        - Do nothing if failures are only on the default branch policy or required
          external services you cannot fix.
        - If the latest commit message already contains [pullfrog-ci-fix] more than
          twice in recent history, stop and comment that max attempts were reached.
        - Prefer a single focused fix commit message including [pullfrog-ci-fix].

        Check suite event:
        ${{ toJSON(github.event) }}
    secrets: inherit
```

`check_suite` payloads are coarse; if logs are hard to get, prefer
`workflow_run` on your main CI workflow with `conclusion == failure`.

---

## Secrets setup (gh CLI)

```bash
# Classic PAT or fine-grained token with repo contents/PR/issues/checks
gh secret set PULLFROG_GITHUB_TOKEN --repo OWNER/REPO < token.txt
gh secret set ANTHROPIC_API_KEY --repo OWNER/REPO

# Org-wide (optional)
# gh secret set PULLFROG_GITHUB_TOKEN --org Weltel-repo --visibility private
```

## Using your existing GitHub App instead of a PAT

If you already have App ID + installation ID + private key (runner deploy secrets):

1. Add a step **before** the action that mints an installation token.
2. Export it as `GH_TOKEN` for the action step only.
3. Prefer that over a long-lived PAT.

(Installation token minting can reuse the same JWT pattern as
`terraform/runners` `get-runner-token.js`, but call
`POST /app/installations/{id}/access_tokens` with PR/issues/contents permissions.)

## Future dashboard hook

Any UI you build later should only:

```http
POST /repos/{owner}/{repo}/actions/workflows/pullfrog.yml/dispatches
{ "ref": "main", "inputs": { "prompt": "...", "name": "..." } }
```

No change to feature workflows required.
