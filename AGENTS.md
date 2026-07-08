# Guidelines for Coding Agents (AGENTS.md)

Welcome! This repository (`Weltel-repo/weltel-pullfrog`) contains the open-source GitHub Action runner and CLI toolchain for Pullfrog. If you are an AI coding agent (such as Claude Code, Antigravity, or OpenCode) working on this codebase, please follow the guidelines in this document.

---

## 🏗️ Repository Architecture

Here is a high-level overview of the codebase to help you navigate and orient yourself:

*   **[main.ts](file:///C:/Weltel/weltel-pullfrog/main.ts)**: The primary entrypoint for the GitHub Action runtime. It sets up temporary workspaces, executes lifecycle hooks, manages credentials, starts the internal MCP servers, and orchestrates agent execution.
*   **[cli.ts](file:///C:/Weltel/weltel-pullfrog/cli.ts)**: The command-line interface entrypoint for local execution and debugging. It delegates subcommand routing to files under the `commands/` directory.
*   **[modes.ts](file:///C:/Weltel/weltel-pullfrog/modes.ts)**: Defines the structured execution modes (such as `Build`, `Plan`, `Fix`, `Review`, `PlanEdit`, etc.) and the detailed prompts/checklists delivered to agents.
*   **[agents/](file:///C:/Weltel/weltel-pullfrog/agents/index.ts)**: Contains the core agent integration code:
    *   **[claude.ts](file:///C:/Weltel/weltel-pullfrog/agents/claude.ts)**: Setup and integration for Claude-based agents.
    *   **[opencode.ts](file:///C:/Weltel/weltel-pullfrog/agents/opencode.ts)**: Setup and integration for OpenCode-based agents.
    *   **[reviewer.ts](file:///C:/Weltel/weltel-pullfrog/agents/reviewer.ts)**: Standard review logic.
*   **[mcp/](file:///C:/Weltel/weltel-pullfrog/mcp/server.ts)**: Handles the Model Context Protocol (MCP) server integration, including custom tools for reporting progress, dependency management, and commenting on GitHub resources.
*   **[utils/](file:///C:/Weltel/weltel-pullfrog/utils/cli.ts)**: Houses utilities for CLI formatting, secret sanitization, Git authentication servers, Node package manager detection, and other common helpers.

---

## 🛠️ Code & Testing Guidelines

> [!IMPORTANT]
> **Avoid Mock-Heavy Unit Tests**
> When writing tests in this codebase (powered by Vitest), be highly skeptical of mocks. As defined in [codexRefreshDetect.test.ts](file:///C:/Weltel/weltel-pullfrog/utils/codexRefreshDetect.test.ts#L4-L7), prefer testing pure logic and functional transformations. Avoid complex mock objects for disk and network calls; instead, isolate logic that can be tested deterministically or utilize lightweight fixtures.

> [!WARNING]
> **Configuration File Isolation**
> When setting up configuration files, hooks, or temporary agent plugins (e.g. inside [opencode.ts](file:///C:/Weltel/weltel-pullfrog/agents/opencode.ts#L1126-L1132)), you must write these files into the environment's isolated temporary directory (`tmpdir`). Never write runtime configuration plugins or credentials to the user's workspace repository tree, as they might be committed accidentally.

### Environment Variables & Secrets
*   Always use [normalizeEnv](file:///C:/Weltel/weltel-pullfrog/utils/normalizeEnv.ts) to handle case-insensitive or varying environment variable formats.
*   Ensure sensitive variables are sanitized before printout to prevent credential leakages. Refer to [secrets.ts](file:///C:/Weltel/weltel-pullfrog/utils/secrets.ts) for details.

---

## 💬 Social & Commenting Rules

If your task involves updating progress comments, posting reviews, or replying to issues, adhere to the following rules:

1.  **Professional Tone**: Write as a professional team member. Final comments must be clean, structured, and actionable. Avoid posting intermediate reasoning step-by-step logs to user comments.
2.  **No Unnecessary Mentions**: Never `@`-mention a GitHub username unless the exact handle was specified in the user's direct instruction or in the trigger's event context.
3.  **Correct Image Markdown**: When embedding screenshots or visual artifacts, use markdown image syntax: `![description](url)`. Do not paste raw, unformatted URLs.
4.  **Harness Progress Reporting**: Prefer writing via `report_progress` rather than attempting to construct custom comment blocks manually, unless specifically instructed by the mode checklists.

---

## 🚀 Development Workflow

To work with this repository locally, make sure you conform to the typical Node toolchain:

*   **Setup Dependencies**: Use `pnpm install` or `nub install`.
*   **Typecheck**: Run `pnpm typecheck` or `nub run typecheck` to verify types.
*   **Run Tests**: Run `pnpm test` or `nub run test`.
*   **Build**: Compile the CLI/action using `pnpm build` or `nub run build`.
*   **Commit Convention**: Use [Conventional Commits](https://www.conventionalcommits.org/) (e.g. `feat:`, `fix:`, `docs:`, `chore:`, `test:`).

Refer to the primary [README.md](file:///C:/Weltel/weltel-pullfrog/README.md) and [CONTRIBUTING.md](file:///C:/Weltel/weltel-pullfrog/CONTRIBUTING.md) for more details.
