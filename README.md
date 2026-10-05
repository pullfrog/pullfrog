<p align="center">
  <h1 align="center">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://pullfrog.com/frog-white-200px.png">
      <img src="https://pullfrog.com/frog-green-200px.png" width="25px" align="center" alt="Green Pullfrog logo" />
    </picture><br />
    Pullfrog
  </h1>
  <p align="center">
    The BYOK CodeRabbit that runs in your GitHub Actions
  </p>
</p>

<p align="center">
  <a href="https://pullfrog.com">pullfrog.com</a> · <a href="https://docs.pullfrog.com">Docs</a> · <a href="https://pullfrog.com/console">Console</a> · <a href="https://discord.gg/8y96raFg8e">Discord</a>
</p>

<br/>

> **New** — Pullfrog is now [free for personal and open-source usage](https://pullfrog.com/blog/free-for-open-source).

## What is Pullfrog?

Pullfrog is the BYOK CodeRabbit that runs in your GitHub Actions. It listens for GitHub events — PRs opened, issues created, reviews submitted, CI failures — and triggers agent runs based on your configuration, via a `pullfrog.yml` workflow that uses this open-source action. You control the infrastructure, the keys, and the costs.

Pullfrog is not an agent itself. It wraps vanilla **[Claude Code](https://github.com/anthropics/claude-code)**, **[Codex](https://github.com/openai/codex)**, and **[OpenCode](https://github.com/anomalyco/opencode)**, selecting the one that matches your BYOK or bring-your-own-subscription configuration — so every run uses the vendor's real agent, and it reads the repo-level config you already keep for it: `CLAUDE.md` or `AGENTS.md`, skills, custom commands, and repo-level MCP servers.

Out of the box, it can:

- **Review new PRs** — auto-review every incoming PR; the review verdict can gate merges via requireable status checks.
- **Address reviews** — leave review comments on a Pullfrog PR as you would for a human colleague, and it addresses them.
- **Autofix CI** — Pullfrog detects CI failures on its own PRs and attempts a fix. It can be configured to fix human PRs too.
- **Autofix merge conflicts** — keep PRs mergeable without hand-resolving.
- **Triage issues** — respond to common questions, apply labels, link related issues and PRs, or draft implementation plans.
- **Anything ad hoc** — tag `@pullfrog` in any issue, PR, or comment. It pulls in the surrounding context and figures out what to do. Prompt from the [console](https://pullfrog.com/console) for anything else.

Each automation can be toggled from the dashboard and customized with per-trigger instructions.

## Get started

Run one command in any local repo:

```sh
npx pullfrog init
```

Or [install from the browser](https://pullfrog.com/console). Setup takes about two minutes: install the GitHub App, add the `pullfrog.yml` workflow with one click, and pick a model. See [getting started](https://docs.pullfrog.com/getting-started).

## Runs on the subscription you already pay for

No API key required. Connect a coding-agent plan once and every run bills against it:

| Plan | Connect with |
| --- | --- |
| [Claude Pro/Max](https://docs.pullfrog.com/claude-auth) | `npx pullfrog auth claude` |
| [ChatGPT Codex](https://docs.pullfrog.com/codex-auth) | `npx pullfrog auth codex` |
| [Grok](https://docs.pullfrog.com/grok-auth) | `npx pullfrog auth grok` |
| [Kimi Code](https://docs.pullfrog.com/kimi-code) | a Kimi Code key as `KIMI_API_KEY` |
| [OpenCode Go](https://docs.pullfrog.com/models#opencode-zen-and-opencode-go) | an OpenCode key as `OPENCODE_API_KEY` |

## Or bring your own model

Pullfrog works with any LLM provider: Anthropic, OpenAI, Google, xAI, Mistral, DeepSeek, OpenRouter, and more. Switch models with a config change. Two more ways to pay for tokens:

- **Your own API key** — stored in Pullfrog's encrypted secret store or in GitHub Actions secrets, your choice.
- **Router** — Pullfrog's built-in model access, billed at raw provider cost with no markup.

## Batteries included

- 🛠️ **MCP tools for GitHub** — a purpose-built MCP server for git and GitHub operations: creating PRs, leaving reviews and comments, reading CI logs, managing issues. Every operation goes through Pullfrog's permission layer.
- 🛡️ **Secure shell access** — shell commands run in an isolated subprocess without access to sensitive environment variables.
- 🌐 **Headless browser** — for end-to-end tests, screenshots, and UI iteration, with screenshot uploads out of the box.
- 🔑 **Short-lived credentials** — all GitHub operations use an installation token that is auto-revoked when the run completes. Keys are auto-masked in logs, and only the minimum necessary environment variables pass through to the agent.
- 🪝 **Hooks** — setup, post-checkout, pre-push, and stop scripts that run inside the agent's permission boundary. A stop script that exits non-zero resumes the agent with the failure as context, so it fixes its own broken push instead of opening a red PR.
- 🔐 **GitHub-native permissions** — GitHub remains the single source of truth for access control. Users only see repos they already have access to; org settings require an org owner.

## Pricing

Pullfrog is free for developers on personal GitHub accounts and free for open-source repos. Pro is $30/month for the whole organization with no per-run or per-seat billing — required for an org's private repos, optional everywhere else. Pullfrog also covers model cost for impactful open-source projects — [apply here](https://pullfrog.com/for-oss).

## Standalone usage

The same `pullfrog/pullfrog@v0` action that powers the automations above also works as a step in your own workflows — an agent as one stage of a larger pipeline. The action takes a `prompt` and the provider key of your choice; the only permission it needs is `id-token: write`, which lets it mint its own short-lived GitHub token.

```yaml
# .github/workflows/agent.yml — run any prompt on demand
name: Agent
on:
  workflow_dispatch:
    inputs:
      prompt:
        description: What should the agent do?
        required: true

jobs:
  agent:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: pullfrog/pullfrog@v0
        with:
          prompt: ${{ inputs.prompt }}
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

The action also exposes a `result` output that subsequent steps can consume. See [CI integration](https://docs.pullfrog.com/headless-action) for the full guide.

<details>
<summary><strong>Example: auto-generate release notes on new tags</strong></summary>

```yaml
name: Release
on:
  push:
    tags: ['v*']

permissions:
  id-token: write
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

</details>

<details>
<summary><strong>Example: prompt from a file</strong></summary>

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

</details>

<details>
<summary><strong>Structured output</strong></summary>

Pass a JSON Schema via the `output_schema` input to make the agent's output required and validated — the bridge between an agent's reasoning and the hard steps that follow it. See [capturing agent output](https://docs.pullfrog.com/headless-action#capturing-agent-output) for the details and a worked example.

</details>
