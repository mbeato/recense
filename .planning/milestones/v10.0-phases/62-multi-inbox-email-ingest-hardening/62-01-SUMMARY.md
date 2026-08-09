---
phase: 62-multi-inbox-email-ingest-hardening
plan: 01
subsystem: infra
tags: [gmail, oauth, config, ingest, recense-doctor]

# Dependency graph
requires: []
provides:
  - "resolveGoogleAccounts(env) — env-driven multi-account resolution (RECENSE_GOOGLE_ACCOUNTS, RECENSE_GMAIL_QUERY_<UPPER_ID>)"
  - "EngineConfig.googleAccounts widened to Array<{ id: string; query?: string }> with an honest backfill-only doc comment"
  - "resolveAccountQuery(config, accountId) — per-account Gmail query with fallback to gmail.query"
  - "GmailAdapter.pull() resolves its own account's query instead of the global gmail.query"
  - "ingest-cli.ts main() wires googleAccounts: resolveGoogleAccounts() — a second account is now reachable purely from sleep.env"
  - "recense doctor dimension 9 (checkGmailAccounts) — per-account refresh-token presence + backfill-only limitation, no secret leak"
affects: [62-02, 62-03, 62-04, 62-05]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Env-driven config resolution with a fail-safe posture (never throw; invalid/absent input falls back to today's single-account default) mirroring resolveEnabledSources"
    - "Account-id charset /^[a-z][a-z0-9_]{0,31}$/ shared with the onboarding flow (plan 62-02) for unambiguous uppercase env-key derivation"
    - "Doc comments and doctor output both carry the literal 'backfill only' limitation so it is never implied away or hidden by a green check"

key-files:
  created:
    - tests/google-accounts-config.test.ts
    - tests/gmail-per-account-query.test.ts
    - tests/recense-doctor-gmail-accounts.test.ts
  modified:
    - src/lib/config.ts
    - src/adapter/runtime-config.ts
    - src/adapter/ingest-cli.ts
    - src/source/gmail-adapter.ts
    - src/adapter/recense-doctor.ts

key-decisions:
  - "resolveGoogleAccounts hardcodes the [{ id: 'default' }] fallback rather than importing DEFAULT_CONFIG, keeping runtime-config.ts's hook-load-path import surface to Node builtins only; a dedicated anti-drift test guards against divergence."
  - "Per-account query scoping is documented and enforced as backfill-only everywhere it surfaces (config doc comment, resolveAccountQuery JSDoc, recense doctor output) rather than worked around, per the locked EMAIL-02 decision."
  - "checkGmailAccounts stays fully offline (no live getProfile probe) — reports configuration presence only, explicitly deferring liveness verification."

requirements-completed: [EMAIL-02]

# Metrics
duration: ~20min
completed: 2026-07-29
---

# Phase 62 Plan 01: Per-Account Gmail Query Scoping + Honest Doctor Dimension Summary

**Env-driven multi-Google-account resolution (`resolveGoogleAccounts`) plus a per-account Gmail backfill query (`resolveAccountQuery`), wired into `GmailAdapter.pull()` and `ingest-cli.ts`, with a ninth `recense doctor` dimension reporting per-account refresh-token presence and the backfill-only limitation.**

## Performance

- **Duration:** ~20 min
- **Completed:** 2026-07-29
- **Tasks:** 3 (all `type="auto"`, no checkpoints)
- **Files modified:** 5 (+3 new test files)

## Accomplishments

- A second Google account is now reachable purely from `sleep.env` (`RECENSE_GOOGLE_ACCOUNTS=default,work`) with zero source-code edits — closes the "compile-time literal" gap the plan was written to fix.
- Each account can carry its own Gmail search query for its **initial backfill** (`RECENSE_GMAIL_QUERY_<UPPER_ID>`), resolved by `resolveAccountQuery` inside `GmailAdapter.pull()`.
- The backfill-only limitation (Gmail's `users.history.list` accepts no `q`) is stated in three places: the `googleAccounts` doc comment (`src/lib/config.ts`), `resolveAccountQuery`'s JSDoc, and every `recense doctor` run — never implied away.
- `recense doctor` gained a ninth dimension that fails when an enabled account is missing its refresh token (closing Pitfall 16's silent-per-account-credential-death, previously just a `/tmp/recense-ingest.log` line) while never printing a token value or query string.

## Task Commits

Each task was committed atomically:

1. **Task 1: Per-account config shape + env-driven resolution with honest limitation comment** — `9cf59de` (feat)
2. **Task 2: GmailAdapter resolves its own account's query; ingest-cli feeds accounts from env; incremental-branch no-`q` regression lock** — `4c248d6` (feat)
3. **[Deviation fix — Rule 1] Literal "backfill only" substring in config.ts doc comment** — `f26dba9` (fix)
4. **Task 3: `recense doctor` dimension 9 — per-account token presence and the stated backfill-only limitation** — `7f32fc2` (feat)

**Plan metadata:** (this SUMMARY commit, made by the orchestrator/executor immediately after this file)

## Files Created/Modified

- `src/lib/config.ts` — widened `EngineConfig.googleAccounts` to `Array<{ id: string; query?: string }>`, with the honest backfill-only doc comment naming `users.history.list`, `resolveGoogleAccounts`, and both env-var names.
- `src/adapter/runtime-config.ts` — added `resolveGoogleAccounts(env)`, mirroring `resolveEnabledSources`'s fail-safe posture exactly (no new imports beyond Node builtins).
- `src/adapter/ingest-cli.ts` — `main()`'s config literal now sets `googleAccounts: resolveGoogleAccounts()`.
- `src/source/gmail-adapter.ts` — added `resolveAccountQuery(config, accountId)`; `GmailAdapter.pull()` now calls it instead of reading `this.config.gmail.query` directly; the `users.history.list` call site is annotated as deliberately query-free.
- `src/adapter/recense-doctor.ts` — added `checkGmailAccounts(envPath)` as dimension 9, registered in `runDoctor`; header updated to 9-dimension with a `T-62-04` mitigation line.
- `tests/google-accounts-config.test.ts` (new) — 9 tests covering the `DEFAULT_CONFIG.googleAccounts` anti-drift guard, id validation/dedup, query attachment, and no-throw/no-mutation.
- `tests/gmail-per-account-query.test.ts` (new) — 7 tests covering per-account/fallback/independent-cursor query resolution plus the Pitfall-8 regression lock (history.list carries no `q`; messages.list does).
- `tests/recense-doctor-gmail-accounts.test.ts` (new) — 7 tests covering not-enabled pass, ok/fail token presence, secret-leak absence (token and query), backfill-only on both paths, and missing-env-file no-throw.

## Decisions Made

- `resolveGoogleAccounts` hardcodes `[{ id: 'default' }]` rather than importing `DEFAULT_CONFIG` from `../lib/config`, preserving `runtime-config.ts`'s Node-builtins-only import surface (it sits on the hook load path). The anti-drift test (`resolveGoogleAccounts({})` deep-equals `DEFAULT_CONFIG.googleAccounts`) is the tripwire against future divergence.
- `checkGmailAccounts` is placed physically between dimension 6 (`Serve token`) and the original dimension 7 (`Billing`) in the source file, per the plan's explicit "placed after checkServeToken" instruction — the numbered dimension list in the header comment still reads 1–9 in logical order.
- No active `getProfile` liveness probe was added to the doctor dimension — deliberately deferred per the plan (Pitfall 16's own suggestion), documented in the JSDoc so nobody later assumes liveness was verified.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] config.ts doc comment used uppercase "INITIAL BACKFILL ONLY" instead of the literal lowercase substring the acceptance criteria/verification grep requires**
- **Found during:** Post-Task-2 verification pass (running the plan's own `grep -n "backfill only" src/lib/config.ts src/adapter/recense-doctor.ts` check)
- **Issue:** The doc comment I wrote for `EngineConfig.googleAccounts` stated the limitation using the phrase `INITIAL BACKFILL ONLY` (uppercase for emphasis), which does not match the plan's required literal substring `backfill only` (case-sensitive grep). `src/adapter/recense-doctor.ts` already had the correct casing from Task 3.
- **Fix:** Reworded the doc comment to lead with the literal lowercase phrase `backfill only` before restating the emphasized uppercase form, so both the grep and the readability intent are satisfied.
- **Files modified:** `src/lib/config.ts`
- **Verification:** `grep -n "backfill only" src/lib/config.ts src/adapter/recense-doctor.ts` now returns a hit in both files; `npx tsc --noEmit` and `npx vitest run tests/google-accounts-config.test.ts tests/ingest-cli-multiaccount.test.ts` still pass.
- **Committed in:** `f26dba9`

---

**Total deviations:** 1 auto-fixed (1 bug — Rule 1)
**Impact on plan:** Cosmetic doc-comment wording fix required by the plan's own verification grep; no behavior change, no scope creep.

## Issues Encountered

None beyond the deviation above.

## Verification Results

- `npx tsc --noEmit` — exits 0.
- `npx vitest run tests/google-accounts-config.test.ts tests/gmail-per-account-query.test.ts tests/recense-doctor-gmail-accounts.test.ts` — 23/23 pass.
- Full suite `npx vitest run`:
  - **Pre-plan baseline** (verified by archiving base commit `b66acadae8910a6b79b3208e81332ee4e78d982a` into a scratch dir sharing this worktree's `node_modules`): **23 failed / 2687 passed / 9 skipped** (the raw archived run showed 25 failed/2685 passed, but 2 of those failures — `tests/ingest-project-reingest.test.ts` git-fingerprint helpers — are artifacts of running from a `git archive` extraction with no `.git` directory, not real baseline failures; excluding them gives 23 failed / 2687 passed).
  - **Post-plan (this branch):** **23 failed / 2710 passed / 9 skipped.**
  - **Diff:** the same 23 pre-existing failures in both runs (all subprocess-spawning CLI tests — `adapter-capture`, `adapter-inject`, `episodic-dryrun-gate`, `eval-harness-smoke`, `locomo-harness`, `locomo-latency-curve`, `locomo-scorer` — environment-flaky, unrelated to any file this plan touched). **Zero new failures.** The +23 passed delta is exactly the three new test files added by this plan.
- `resolveGoogleAccounts` anti-drift assertion against `DEFAULT_CONFIG.googleAccounts`: **in place** (`tests/google-accounts-config.test.ts` — "absent var returns `[{ id: 'default' }]` and deep-equals `DEFAULT_CONFIG.googleAccounts`").
- `grep -n "backfill only" src/lib/config.ts src/adapter/recense-doctor.ts` — hit in both files.
- `grep -n "config.gmail.query" src/source/gmail-adapter.ts` — only appears in comments/JSDoc and inside `resolveAccountQuery`'s fallback return; `GmailAdapter.pull()` no longer references it directly.
- Net-zero new runtime dependencies: `git diff` across all commits touches no `package.json`/`package-lock.json`.

## Env-Var Contract (for plan 62-02 to consume)

- `RECENSE_GOOGLE_ACCOUNTS` — comma-separated account ids, e.g. `default,work`. Absent/empty/all-invalid → `[{ id: 'default' }]`.
- `RECENSE_GMAIL_QUERY_<UPPER_ID>` — optional per-account Gmail search query, e.g. `RECENSE_GMAIL_QUERY_WORK`. Attached only when its trimmed value is non-empty; bounds that account's initial backfill only.
- Account-id charset: `/^[a-z][a-z0-9_]{0,31}$/` (lowercase-only, no commas/`=`/newlines) — shared contract with plan 62-02's onboarding flow.

## User Setup Required

None — no external service configuration required. (Populating `RECENSE_GOOGLE_ACCOUNTS`/`RECENSE_GMAIL_QUERY_*` in `sleep.env` is an operator action, not a code-level setup step; plan 62-02 builds the guided onboarding flow that writes these.)

## Next Phase Readiness

- The env-var contract (`RECENSE_GOOGLE_ACCOUNTS`, `RECENSE_GMAIL_QUERY_<UPPER_ID>`, the shared id charset) is locked and ready for plan 62-02's onboarding flow to write into `sleep.env`.
- `recense doctor`'s dimension 9 gives plan 62-02 (and any future onboarding UX) a ready-made audit surface for "is this new account's token actually there."
- No blockers for 62-02/62-03/62-04/62-05.

---
*Phase: 62-multi-inbox-email-ingest-hardening*
*Completed: 2026-07-29*
