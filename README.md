<!-- test preview system -->
<p align="center">
  <h1 align="center">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://pullfrog.com/frog-white-200px.png">
      <img src="https://pullfrog.com/frog-green-200px.png" width="25px" align="center" alt="Green Pullfrog logo" />
    </picture><br />
    Pullfrog
  </h1>
  <p align="center">
    Bring your favorite coding agent into GitHub
  </p>
</p>

<br/>

> **🚀 Pullfrog is now generally available!** [Get started →](https://pullfrog.com/console)

<br/>

## What is Pullfrog?

Pullfrog is a GitHub bot that brings the full power of your favorite coding agents into GitHub. It's open source and powered by GitHub Actions.

- **Tag `@pullfrog`** — Tag `@pullfrog` in a comment anywhere in your repo. It will pull in any relevant context using the action's internal MCP server and perform the appropriate task.
- **Prompt from the web** — Trigger arbitrary tasks from the Pullfrog dashboard
- **Automated triggers** — Configure Pullfrog to trigger agent runs in response to specific events. Each of these triggers can be associated with custom prompt instructions.
  - issue created
  - issue labeled
  - PR created
  - PR review created
  - PR review requested
  - and more...

Pullfrog is the bridge between your preferred coding agents and GitHub. Use it for:

- **🤖 Coding tasks** — Tell `@pullfrog` to implement something and it'll spin up a PR. If CI fails, it'll read the logs and attempt a fix automatically. It'll automatically address any PR reviews too.
- **🔍 PR review** — Coding agents are great at reviewing PRs. Using the "PR created" trigger, you can configure Pullfrog to auto-review new PRs.
- **🤙 Issue management** — Via the "issue created" trigger, Pullfrog can automatically respond to common questions, create implementation plans, and link to related issues/PRs. Or (if you're feeling lucky) you can prompt it to immediately attempt a PR addressing new issues.
- **Literally whatever** — Want to have the agent automatically add docs to all new PRs? Cut a new release with agent-written notes on every commit to `main`? Pullfrog lets you do it.

<!-- Features
- **Agent-agnostic** — Switch between agents with the click of a radio button.
- ** -->

<!--
## Get started

Install the Pullfrog GitHub App on your personal or organization account. During installation you can choose to limit access to a specific repo or repos. After installation, you'll be redirected to the Pullfrog dashboard where you'll see an onboarding flow. This flow will create your `pullfrog.yml` workflow and prompt you to set up API keys. Once you finish those steps (2 minutes) you're ready to rock.

[Add to GitHub ➜](https://github.com/apps/pullfrog/installations/new)

<details>
<summary><strong>Manual setup instructions</strong></summary>

You can also use the `pullfrog/pullfrog` Action without a GitHub App installation. This is more time-consuming to set up, and it places limitations on the actions your Agent will be capable of performing.

To manually set up the Pullfrog action, you need to set up two workflow files in your repository: `pullfrog.yml` (the execution logic) and `triggers.yml` (the event triggers).

#### 1. Create `pullfrog.yml`

Create a file at `.github/workflows/pullfrog.yml`. This is a reusable workflow that runs the Pullfrog action.

```yaml
# PULLFROG ACTION — DO NOT EDIT EXCEPT WHERE INDICATED
name: Pullfrog
on:
  workflow_dispatch:
    inputs:
      prompt:
        type: string
        description: 'Agent prompt'

permissions:
  contents: read

jobs:
  pullfrog:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - name: Checkout code
        uses: actions/checkout@v6
        with:
          fetch-depth: 1
      - name: Run agent
        uses: pullfrog/pullfrog@v0
        with:
          prompt: ${{ inputs.prompt }}
        env:
          # add API keys for the LLM provider(s) you want to use
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
          XAI_API_KEY: ${{ secrets.XAI_API_KEY }}
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
          MOONSHOT_API_KEY: ${{ secrets.MOONSHOT_API_KEY }}

```

#### OpenAI-compatible BYOK gateway

To use any OpenAI-compatible bring-your-own-key (BYOK) gateway, add these GitHub Actions secrets to your repository:

- `OPENAI_COMPATIBLE_API_KEY`
- `OPENAI_COMPATIBLE_BASE_URL` — must be an OpenAI-compatible `/v1` endpoint (for example, `https://gateway.example.com/v1`)
- `OPENAI_COMPATIBLE_MODEL_ID`

Then select the generic OpenAI-compatible BYOK model and pass the secrets to the action:

```yaml
env:
  PULLFROG_MODEL: openai-compatible/byok
  OPENAI_COMPATIBLE_API_KEY: ${{ secrets.OPENAI_COMPATIBLE_API_KEY }}
  OPENAI_COMPATIBLE_BASE_URL: ${{ secrets.OPENAI_COMPATIBLE_BASE_URL }}
  OPENAI_COMPATIBLE_MODEL_ID: ${{ secrets.OPENAI_COMPATIBLE_MODEL_ID }}
```

LiteLLM is a supported OpenAI-compatible gateway example, not a special provider.

To gate merges on Pullfrog with branch protection, add `status_checks: enabled` under `with:`. Each PR run then posts a `pullfrog` check (run completion — success when the run finishes, failure on error/timeout) and a `pullfrog-approval` check (whether Pullfrog would approve the PR), both requireable as status checks. See [PR reviews → Required status checks](https://docs.pullfrog.dev/pr-reviews#required-status-checks-branch-protection).

#### 2. Create `triggers.yml`

Create a file at `.github/workflows/triggers.yml`. This workflow listens for GitHub events and calls the `pullfrog.yml` workflow with the event data.

```yaml
name: Agent Triggers

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  issues:
    types: [opened, assigned]
  pull_request_review:
    types: [submitted]
  # add other triggers as needed


jobs:
  pullfrog:

    # trigger conditions (e.g. only run if @pullfrog is mentioned)
    if: contains(github.event.comment.body, '@pullfrog') || contains(github.event.issue.body, '@pullfrog')

    permissions:
      id-token: write
      contents: read
    uses: ./.github/workflows/pullfrog.yml
    with:
      # pass the full event payload as the prompt
      prompt: ${{ toJSON(github.event) }}
    secrets: inherit
```

</details>
-->

## Standalone Usage

You can also use `pullfrog/pullfrog` as a step in your own workflows. The action exposes a `result` output that can be consumed by subsequent steps.

### Example: Auto-generate release notes on new tags

```yaml
name: Release
on:
  push:
    tags: ['v*']

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Generate release notes
        id: notes
        uses: pullfrog/pullfrog@v0
        with:
          prompt: |
            Generate release notes for ${{ github.ref_name }}.
            Compare commits between this tag and the previous tag.
            Format as markdown: summary paragraph, then ### Features, ### Fixes, ### Breaking Changes sections.
            Omit empty sections. Be concise.
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}

      # write to file to avoid shell escaping issues with special characters
      - name: Create GitHub release
        run: |
          notesfile="$RUNNER_TEMP/release-notes-$GITHUB_RUN_ID.md"
          printf '%s' "$NOTES" > "$notesfile"
          gh release create ${{ github.ref_name }} --title "${{ github.ref_name }}" --notes-file "$notesfile"
        env:
          GH_TOKEN: ${{ github.token }}
          NOTES: ${{ steps.notes.outputs.result }}
```

### Example: Prompt from a file

For longer prompts you want to version and reuse, commit the prompt text to the repo and pass its path with `prompt_file` instead of inlining it. The path is resolved relative to `GITHUB_WORKSPACE`, and it is mutually exclusive with `prompt` — set exactly one.

```yaml
# .github/workflows/triage.yml
- uses: actions/checkout@v4
- uses: pullfrog/pullfrog@v0
  with:
    prompt_file: .github/pullfrog/triage.md
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

### Example: Structured Output with Zod Schema

You can force the agent to return structured JSON output by providing a JSON schema. This allows you to reliably parse and use the agent's response in subsequent workflow steps.

You can define your JSON schema directly or you can use any validation library that converts to JSON Schema. Here's an example using [Zod](https://zod.dev):

```yaml
name: Release Check
on:
  pull_request:
    types: [closed]

jobs:
  check-release:
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install dependencies
        run: npm install --no-save --no-package-lock zod @actions/core

      - name: Generate Schema
        id: schema
        run: |
          node -e '
            import { z } from "zod";
            import { setOutput } from "@actions/core";
            const schema = z.object({
              version: z.string().describe("Semantic version number (e.g. 1.0.0)"),
              isBreaking: z.boolean().describe("Whether this release contains breaking changes"),
              changelog: z.array(z.string()).describe("List of changes in this release"),
            });
            setOutput("schema", JSON.stringify(z.toJSONSchema(schema)));
          '

      - name: Analyze PR
        id: analysis
        uses: pullfrog/pullfrog@v0
        with:
          prompt: |
            Analyze this PR and determine semantic versioning impact.
            Return a JSON object matching the provided schema.
          output_schema: ${{ steps.schema.outputs.schema }}
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}

      - name: Process Result
        run: |
          # Parse the JSON result using fromJSON()
          echo "Version: ${{ fromJSON(steps.analysis.outputs.result).version }}"
          echo "Breaking: ${{ fromJSON(steps.analysis.outputs.result).isBreaking }}"
```
