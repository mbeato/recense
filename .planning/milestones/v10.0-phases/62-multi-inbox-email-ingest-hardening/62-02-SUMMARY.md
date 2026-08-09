---
phase: 62-multi-inbox-email-ingest-hardening
plan: 02
subsystem: infra
tags: [gmail, oauth, loopback, cli, security]

# Dependency graph
requires:
  - phase: 62-01
    provides: "RECENSE_GOOGLE_ACCOUNTS / RECENSE_GMAIL_QUERY_<UPPER_ID> env contract, resolveGoogleAccounts(env), the shared account-id charset /^[a-z][a-z0-9_]{0,31}$/"
provides:
  - "recense gmail-auth <account-id> [--force] — guided loopback OAuth onboarding CLI that mints a Gmail refresh token and registers the account"
  - "GMAIL_OAUTH_SCOPES / validateAccountId / envTokenKey / mergeAccountList / buildRedirectUri / parseOAuthCallback / startLoopbackCatcher / planEnvUpdate — exported, unit-tested, no-network helper core"
  - "dispatcher case 'gmail-auth' in recense.ts, wired into the Commands usage line"
affects: [62-03, 62-04, 62-05]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Loopback OAuth redirect catcher (node:http, ephemeral port, 127.0.0.1-only, state-validated, bounded lifetime) as the CLI-side alternative to the dead OOB flow — reusable pattern for any future onboarding CLI that needs a Google/OAuth grant"
    - "planEnvUpdate-style pure orchestration helper: decides an env mutation as a plain object with an exact key set, so writeEnvFile's side effects stay fully unit-testable without touching a real file or a real OAuth exchange"

key-files:
  created:
    - src/adapter/gmail-auth-cli.ts
    - tests/gmail-auth-cli.test.ts
    - tests/gmail-auth-loopback.test.ts
  modified:
    - src/adapter/recense.ts

key-decisions:
  - "State comparison uses crypto.timingSafeEqual behind an explicit length-equality guard (timingSafeEqual throws on mismatched buffer lengths); a length mismatch is itself classified as state_mismatch rather than a thrown error, keeping parseOAuthCallback's return type total over every input shape."
  - "startLoopbackCatcher settles its result promise and self-closes on the FIRST request it receives (success or failure) rather than staying open for the full timeout — any request after that gets a bare 400 and is otherwise ignored, and the timeout only fires when zero requests ever arrive."
  - "Source-assertion tests exclude comment lines (mirroring the plan's own `grep -v '^\\s*[*/#]'` verification convention) before checking for the forbidden substrings 0.0.0.0/gmail.modify/https://mail.google.com/ — the file's own threat-mitigation doc comments legitimately name those strings to explain why they're absent from the code."
  - "Shared OAuth client credentials (GOOGLE_CLIENT_ID/SECRET with the legacy GMAIL_* fallback) are read from process.env, not the parsed sleep.env Map — this mirrors RealGmailFetcher.getClient() exactly and relies on the existing dispatcher-level hydrateRuntimeEnv() (recense.ts) plus spawnSync's default env inheritance to make sleep.env's values visible to this subprocess, so no new env-loading path was introduced."

requirements-completed: [EMAIL-01]

# Metrics
duration: ~35min
completed: 2026-07-30
---

# Phase 62 Plan 02: Guided Gmail Account Onboarding (Loopback OAuth) Summary

**`recense gmail-auth <account-id>` mints a Gmail refresh token via a local 127.0.0.1-only loopback redirect with `crypto.timingSafeEqual`-validated state, then registers the account through the existing `writeEnvFile`/`RECENSE_GOOGLE_ACCOUNTS` contract — no hand-rolled OAuth, no hand-edited files, and zero new runtime dependencies.**

## Performance

- **Duration:** ~35 min
- **Completed:** 2026-07-30
- **Tasks:** 2 (both `type="auto"`, no checkpoints)
- **Files modified:** 4 (1 new source file, 2 new test files, 1 dispatcher edit)

## Accomplishments

- Closed the onboarding gap plan 62-01 left open: minting `GOOGLE_<ID>_REFRESH_TOKEN` for a second Google account no longer requires running someone else's OAuth snippet and hand-editing a chmod-600 file — `recense gmail-auth work` does the whole thing.
- The command surface: `recense gmail-auth <account-id> [--force]`. `<account-id>` must satisfy `/^[a-z][a-z0-9_]{0,31}$/` — byte-identical to plan 62-01's `resolveGoogleAccounts` regex (verified by both files' JSDoc cross-references and a shared behavioral test suite; a divergence would let this CLI mint a token under a key `resolveGoogleAccounts` then silently drops). `--force` is required to re-mint over an existing token (T-62-14): without it, the command prints a message and exits 0, leaving the prior grant untouched.
- Loopback redirect on the Desktop OAuth client type recense already uses (`http://127.0.0.1:<ephemeral-port>`) replaces the dead OOB flow. The catcher binds `127.0.0.1` only (never `0.0.0.0` — asserted by both a runtime connection test and a comment-excluded source grep), validates a 32-byte `randomBytes` state with `timingSafeEqual` behind a length guard (a length mismatch is itself `state_mismatch`, and `ok` is never returned on a bad state even with a valid-looking code present), and has a **bounded 300-second lifetime** (`CATCHER_TIMEOUT_MS = 300_000`, a named module constant) after which it self-closes and settles `{ ok: false, reason: 'timeout' }`.
- Scope is frozen to exactly `https://www.googleapis.com/auth/gmail.readonly` (`GMAIL_OAUTH_SCOPES`) — a source assertion (excluding this file's own doc comments) fails if `gmail.modify` or `https://mail.google.com/` ever appears in the code.
- Token persistence goes through the existing `writeEnvFile` (0o600, atomic tmp→rename) exclusively — this plan adds no `writeFileSync`/`chmodSync` of its own. `planEnvUpdate` is the pure decision function (existing env Map, account id, refresh token → exactly `{ GOOGLE_<ID>_REFRESH_TOKEN, RECENSE_GOOGLE_ACCOUNTS }`), unit-tested end-to-end against a temp env file containing a comment line and an unrelated `OPENAI_API_KEY` — both survive, and the resulting file's mode is asserted `0o600`.
- No refresh token, authorization code, or client secret ever reaches stdout or the `/tmp/recense-gmail-auth.log` file — enforced by a source-assertion test regex over every `console.log`/`process.stdout.write`/`process.stderr.write`/`appendFileSync` call site in the file.
- `recense.ts` gained `case 'gmail-auth'` (dispatched via `spawnScript` with `process.argv.slice(3)` — not the local `rest`/`slice(4)`, per the existing H-1 note, so the account-id positional survives) and `gmail-auth` is now listed in the `Usage:` `Commands:` string.

## Task Commits

Each task was committed atomically:

1. **Task 1: Pure OAuth helper core + the bounded, state-validating loopback catcher** — `fc3a875` (feat)
2. **Task 2: Interactive flow — token exchange, env write, account registration, dispatcher wiring** — `1661a3a` (feat)

**Plan metadata:** (this SUMMARY commit, made by the orchestrator/executor immediately after this file)

## Files Created/Modified

- `src/adapter/gmail-auth-cli.ts` (new) — `GMAIL_OAUTH_SCOPES`, `validateAccountId`, `envTokenKey`, `mergeAccountList`, `buildRedirectUri`, `parseOAuthCallback`, `startLoopbackCatcher`, `planEnvUpdate`, and the `require.main === module`-guarded interactive `main()` spine (id validation → shared-client-credential resolution → force-gated re-mint short-circuit → bounded loopback catcher → `generateAuthUrl` with `access_type: 'offline'`/`prompt: 'consent'` → callback await → `getToken` exchange → `writeEnvFile` → secret-free completion summary, all steps 4-8 wrapped in `try/finally` so the catcher is always torn down).
- `src/adapter/recense.ts` — added `case 'gmail-auth': spawnScript('gmail-auth-cli.js', process.argv.slice(3))` next to the other guarded-CLI dispatch cases, and added `gmail-auth` to the default-case `Commands:` usage string.
- `tests/gmail-auth-cli.test.ts` (new) — 32 tests: `validateAccountId`/`envTokenKey`/`mergeAccountList`/`buildRedirectUri`/`parseOAuthCallback` pure-helper coverage (including the state-mismatch-fails-closed cases and a different-length state), `planEnvUpdate` coverage (empty map, existing list, idempotent re-run, exact-two-keys, and an end-to-end temp-file `writeEnvFile` round trip asserting mode `0o600` + comment/unrelated-key survival), and source assertions (scope lockdown, `prompt`/`access_type` presence, `writeEnvFile`-only persistence, no `writeFileSync`/`chmodSync`, no secret-value interpolation in any output/log call, and the literal `backfill only` phrase in the completion summary).
- `tests/gmail-auth-loopback.test.ts` (new) — 6 tests: live-localhost coverage of `startLoopbackCatcher` (successful callback → 200 + `{ ok: true, code }`, wrong-state callback → 400 + `state_mismatch`, a `timeoutMs: 50` catcher settling `timeout` and the port refusing further connections, idempotent `close()`), plus a source assertion for the literal `127.0.0.1` listen-host argument and the absence of `0.0.0.0` in code.

## Decisions Made

- **State comparison order and fail-closed semantics:** `parseOAuthCallback` checks `error` → `state` presence → `state` match (length-guarded `timingSafeEqual`) → `code` presence, in that exact order, and a length mismatch on `state` is folded into `state_mismatch` rather than allowed to throw — keeps the function total and matches the plan's literal acceptance criterion (`parseOAuthCallback('/?code=abc&state=WRONG', 'RIGHT')` → `state_mismatch`).
- **Catcher settles on first request, not after the full timeout:** matches the plan's description ("resolve once ... and then closes the server") — a catcher that received a valid callback does not sit open for the remaining 300 seconds.
- **Comment-excluded source assertions:** both test files filter out comment lines before asserting the absence of `0.0.0.0`/`gmail.modify`/`https://mail.google.com/`, mirroring the plan's own `verification` section (`grep -v '^\s*[*/#]'`) — the file's threat-mitigation doc comments legitimately name these forbidden strings to explain the mitigation, and a naive `.not.toContain` against the raw file would false-positive on that prose.
- **Client credential resolution stays on `process.env`, not the parsed sleep.env Map**, deliberately mirroring `RealGmailFetcher.getClient()` byte-for-byte (same two-tier `GOOGLE_*`/`GMAIL_*` fallback). This works because `recense.ts`'s dispatcher already calls `hydrateRuntimeEnv()` before any `spawnScript` dispatch, and `spawnSync` inherits the parent's `process.env` by default — so no new env-file-reading code path was needed for credential resolution (only the token/account-list mutation reads/writes the file directly, via `resolveExistingEnv`/`writeEnvFile`).

## Deviations from Plan

None — plan executed exactly as written. Two source-assertion tests were added with a comment-line exclusion filter rather than the naive substring check the plan's <action> prose might read as literal; this exactly matches the plan's own <verification> section, which specifies the same `grep -v` exclusion, so this is not a deviation from the plan's actual intent — it's implementing the plan's stated verification method precisely rather than a stricter (and self-contradicting) reading of it.

## Issues Encountered

None.

## Verification Results

- `npx vitest run tests/gmail-auth-cli.test.ts tests/gmail-auth-loopback.test.ts` — 38/38 pass (32 + 6), no open-handle warning.
- `npx tsc --noEmit` — exits 0.
- Full suite `npx vitest run` — **186 test files passed / 1 skipped, 2770 tests passed / 4 skipped, 0 failed.** (No pre-existing-flaky failures reproduced in this run; the 62-01 baseline noted these as environment-flaky subprocess-spawning CLI tests, not caused by this plan's files.)
- `git diff package.json` — no change (`googleapis` was already a dependency at `^173.0.0`; no new runtime dependency added).
- Built `dist/` via `npx tsc` and ran the compiled dispatcher directly:
  - `node dist/src/adapter/recense.js` (no args) prints a usage line containing `gmail-auth`.
  - `node dist/src/adapter/recense.js gmail-auth` (no account-id) exits 1, prints the usage message, and `~/.config/recense/sleep.env`'s mtime is unchanged before/after (verified via `stat -f %m`) — confirms id validation runs before any file access.
- `grep -n "case 'gmail-auth'" src/adapter/recense.ts` — exactly one hit.
- Source greps (comment-excluded) for `0.0.0.0`, `gmail.modify`, `https://mail.google.com/` against `src/adapter/gmail-auth-cli.ts` — no match in code.

## Env-Var / Command Contract (for downstream plans)

- Command: `recense gmail-auth <account-id> [--force]`.
- `<account-id>` charset: `/^[a-z][a-z0-9_]{0,31}$/` — identical to plan 62-01's `resolveGoogleAccounts` regex; both files cross-reference each other in JSDoc as the shared-contract owners.
- On success, writes exactly two keys via `writeEnvFile`: `GOOGLE_<UPPER_ID>_REFRESH_TOKEN` and an updated `RECENSE_GOOGLE_ACCOUNTS` (comma-joined, order-preserving, idempotent).
- Requires `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (or the legacy `GMAIL_CLIENT_ID`/`GMAIL_CLIENT_SECRET`) already present in the ambient environment — the same shared Desktop OAuth client account 1 already uses; this CLI does not create a new OAuth client.
- Bounded catcher lifetime: `CATCHER_TIMEOUT_MS = 300_000` (300s), a private module constant in `gmail-auth-cli.ts`.
- Completion output reminds the operator: set the optional `RECENSE_GMAIL_QUERY_<UPPER_ID>` (backfill-only, per plan 62-01), ensure `gmail` is in `RECENSE_ENABLED_SOURCES`, and run `recense doctor` to verify (dimension 9, shipped in 62-01, will now report this account's token as present).

## Deferred / Explicitly Out of Scope

- **A live `getProfile` per-account liveness probe remains deferred** (Pitfall 16.2 partial) — this plan (like 62-01's doctor dimension 9) verifies token *presence*, not that the token is still valid against Google's servers. A revoked-but-present token will not be caught until the next real ingest attempt fails.
- Calendar OAuth onboarding is untouched — `CalendarAdapter` stays behind `calendar.enabled: false` per the founder's 2026-07-29 scope decision (tracked in STATE.md, not this plan's concern).

## Next Phase Readiness

- No blockers for 62-03/62-04/62-05. This plan's files (`src/adapter/gmail-auth-cli.ts`, `tests/gmail-auth-cli.test.ts`, `tests/gmail-auth-loopback.test.ts`) are disjoint from 62-03's declared files (`src/source/gmail-adapter.ts`, `src/source/strip-hidden.ts`).
- The onboarding CLI and plan 62-01's `resolveGoogleAccounts`/doctor dimension 9 now form a complete loop: mint → register → verify-presence, closing EMAIL-01 fully.

---
*Phase: 62-multi-inbox-email-ingest-hardening*
*Completed: 2026-07-30*

## Self-Check: PASSED

- FOUND: src/adapter/gmail-auth-cli.ts
- FOUND: tests/gmail-auth-cli.test.ts
- FOUND: tests/gmail-auth-loopback.test.ts
- FOUND: src/adapter/recense.ts
- FOUND: .planning/phases/62-multi-inbox-email-ingest-hardening/62-02-SUMMARY.md
- FOUND commit: fc3a875 (Task 1)
- FOUND commit: 1661a3a (Task 2)
