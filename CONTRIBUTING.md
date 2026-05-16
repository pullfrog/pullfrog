# Contributing to Pullfrog

Thanks for your interest in contributing!

## Prerequisites

- Node.js (see `.node-version` for the exact version)
- [pnpm](https://pnpm.io/) - `npm install -g pnpm`

## Setup

```bash
git clone https://github.com/<your-username>/pullfrog.git
cd pullfrog
pnpm install
```

## Running tests

```bash
pnpm test
pnpm typecheck
```

All tests should pass before opening a PR.

## Commit conventions

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `chore:`, `test:`.

Example: `feat(action): add prompt_file input`

## Opening a PR

1. Fork the repo
2. Create a branch: `git checkout -b feat/your-feature`
3. Make your changes
4. Run `pnpm typecheck && pnpm test`
5. Push and open a PR against `main`

## Questions?

Open an issue or reach out at [team@pullfrog.com](mailto:team@pullfrog.com).
