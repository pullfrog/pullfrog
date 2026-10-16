# `pullfrog/get-installation-token`

Get a GitHub App installation token in a workflow job. This convenience action makes it easier to integrate Pullfrog into existing CI workflows.

This action:

- Provides a GitHub App installation token for later workflow steps.
- Works for the current repository out of the box.
- Can optionally include additional repositories.
- Masks the token in logs.
- Revokes the token automatically in the post step.

## Requirements

- Workflow or job permissions must include `id-token: write`.
- The Pullfrog GitHub App must be installed on the target repositories.
- If you pass `repos`, each repository must be installed for the same app installation.

## Inputs

| Name | Required | Description |
| --- | --- | --- |
| `repos` | no | Comma-separated additional repo names to include, for example: `repo1,repo2`. The current repo is always included. |

## Outputs

| Name | Description |
| --- | --- |
| `token` | GitHub App installation token |

## Usage

### Basic (current repo only)

```yaml
permissions:
  id-token: write
  contents: read

jobs:
  example:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - name: Get installation token
        id: token
        uses: ./action/get-installation-token

      - name: Call GitHub API with token
        run: gh api repos/${{ github.repository }}
        env:
          GH_TOKEN: ${{ steps.token.outputs.token }}
```

### Include extra repositories

```yaml
permissions:
  id-token: write
  contents: read

jobs:
  example:
    runs-on: ubuntu-latest
    steps:
      - name: Get token for current repo plus extra repos
        id: token
        uses: ./action/get-installation-token
        with:
          repos: pullfrog,app

      - name: Checkout another repo with installation token
        uses: actions/checkout@v6
        with:
          repository: pullfrog/pullfrog
          token: ${{ steps.token.outputs.token }}
          path: action-repo
```

## Notes

- `repos` expects repository names, not `owner/repo`.
- Token lifetime is managed by GitHub, but this action also revokes the token during post-run cleanup.
- Prefer step output usage (`${{ steps.<id>.outputs.token }}`) rather than writing tokens to files.

## Troubleshooting

- `Error: id-token permission is required`:
  Add `id-token: write` in workflow or job permissions.
- Token works for current repo but not an extra repo:
  Ensure that repository is listed in `repos` and the app installation has access to it.
