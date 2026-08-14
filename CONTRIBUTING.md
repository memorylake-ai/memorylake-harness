# Contributing

## One-time setup

Activate the repository's git hooks after cloning:

```bash
git config core.hooksPath .githooks
```

The `pre-commit` hook blocks staged content this repo must never ship:
credential-shaped strings, personal identifiers, Chinese text (the repo is
English-only), internal planning documents, and shell syntax errors. The
`pre-push` hook blocks direct pushes to `main`.

## Workflow

- `main` only moves through reviewed pull requests — never push to it
  directly. Branch, push, and `gh pr create`.
- Bump the affected plugin's `version` in its plugin manifest whenever
  behavior or user-facing text changes; installed copies only update when
  the version moves.
- Scripts target bash 3.2+ (macOS ships it); run `bash -n` and shellcheck
  before pushing.
