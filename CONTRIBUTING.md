# Contributing

The short version: **every change reaches `main` through a pull request that the CI
`test` job has passed.** Nothing is merged red, and nothing is batched onto `main`
off-CI.

## Why this exists

On 2026-06-25 the suite went red on `main` and stayed broken across two pushes. The
cause was a clean, intentional refactor (D-11, `9e6f309`) that moved doc-graph edge
derivation out of `CorpusPromoter` into `DocGraphDeriver` but left the old promoter
tests asserting the moved-away behavior. It was committed off the pushed timeline and
landed in a batch of ~135 commits with **no CI run on `main` for four days**, so the
breakage only surfaced when the batch was finally pushed — by which point an unrelated
docs commit looked like the culprit.

The fix is process, not vigilance: route changes through PRs so CI runs *before* merge.

## Workflow

1. **Branch off `main`** — never commit directly to it.
   ```
   git switch -c fix/short-description main
   ```
2. **Make the change.** If you change behavior, update the tests in the same PR. If a
   refactor *moves* behavior, move (or delete) the tests that asserted it in their old
   location — don't leave them behind.
3. **Run the gate locally before pushing** (mirrors `.github/workflows/ci.yml`):
   ```
   npm run build && npm test
   ```
   For full parity, also run the smoke steps CI runs after the suite:
   ```
   RECENSE_DB=:memory: node dist/src/adapter/recense.js doctor 2>&1 | grep -q "recense doctor:"
   node scripts/eval/correctness-harness.cjs --dry-run
   node scripts/eval/longmemeval-harness.cjs --dry-run --eval scripts/eval/fixtures/longmemeval-mini.jsonl
   ```
4. **Open a PR.** CI runs on `ubuntu-22.04` and `macos-15`. Merge only when both
   `test` checks are green and the branch is up to date with `main`.

## Commit messages

Conventional commits, matching the existing history:

```
type(scope): summary

type ∈ feat | fix | refactor | docs | chore | test
scope = phase/plan id or subsystem, e.g. (corpus), (39.2-02), (config)
```

Keep the body explaining *why*, not just *what* — the engine is correctness-critical and
the reasoning is the durable artifact.

## Maintainer setup (one-time)

Turn the existing CI workflow into an actual merge gate:

```
bash scripts/setup-branch-protection.sh
```

This protects `main`: PRs required, and the `test (ubuntu-22.04, 22)` +
`test (macos-15, 22)` checks must pass before merge. See the script header for the
`ENFORCE_ADMINS` toggle if you want the gate to bind admins too.
