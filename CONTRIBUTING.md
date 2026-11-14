# Contributing to ftms-js

Thanks for helping out. Bug reports, device reports and pull requests are all welcome.

## Setup

```sh
pnpm install
pnpm check   # typecheck, lint, tests, format
```

Use `pnpm test:coverage` to see coverage locally. CI uploads it to Codecov.

## Device reports

If your machine behaves oddly, open a [device report](https://github.com/Web3Dave/ftms-js/issues/new/choose)
and attach a capture exported from the [demo](https://web3dave.github.io/ftms-js/).

## Branch strategy

The project is trunk-based. `main` is always releasable, and there is no `develop` branch.

1. Branch from `main` using a short-lived topic branch: `feat/…`, `fix/…`, `docs/…` or `chore/…`.
2. Open a pull request into `main`. The `check` CI job must pass.
3. PRs are **squash merged**, so `main` has one commit per PR and the PR title becomes the commit message.
   Write the title as a short imperative summary, for example `Add rower stroke-rate field`.
4. The head branch is deleted after merge.

`main` is protected, so direct pushes are not allowed. Dependabot PRs follow the same flow.

## Releases

Maintainers cut releases from `main`: Actions → Release → Run workflow. It bumps the version,
publishes to npm with provenance, tags `vX.Y.Z` and creates a GitHub release.

If a fix is ever needed for an older version, branch `release/0.x` from the relevant tag and
open PRs against it. That branch is not created ahead of time.
