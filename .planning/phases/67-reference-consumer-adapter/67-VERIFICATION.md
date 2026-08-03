---
phase: 67-reference-consumer-adapter
verified: 2026-08-03T09:26:15Z
status: passed
score: 17/17 must-haves verified
overrides_applied: 0
---

# Phase 67: Reference Consumer Adapter Verification Report

**Phase Goal:** A thin in-repo consumer proves the emit-seam contract works end-to-end without recense knowing the consumer's schema, and the pattern is documented well enough for a real third-party integration to be built against it.
**Verified:** 2026-08-03T09:26:15Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `clients/proposal-reference/` exists as structural sibling of `clients/telegram/`, own tsconfig with no `paths`/`references` into `src/` | VERIFIED | `grep -c '"paths"\|"references"' clients/proposal-reference/tsconfig.json` = 0; directory holds `config.ts`, `proposal-client.ts`, `local-store.ts`, `index.ts`, `tsconfig.json`, `tests/` matching plan's naming lock |
| 2 | Sibling import-boundary guard scans every `.ts` file under the adapter tree incl. its own `tests/`, runs under `npm test` | VERIFIED | `clients/proposal-reference/tests/import-boundary.test.ts` present, `vitest.config.ts:6` includes `'clients/proposal-reference/tests/**/*.test.ts'`; guard hardened post-review (WR-02) to catch bare-directory, `import()`, `.mts`/`.cts`/`.tsx` bypasses, with a `MIN_SCANNED_FILES` non-vacuousness floor and planted-offender tests; ran green: 3/3 in the file |
| 3 | Adapter configurable from env alone, fail-closed when Bearer token absent | VERIFIED | `config.ts` `loadAdapterConfig()`, `enabled = serveToken !== ''`; `main()` in `index.ts` checks `!config.enabled` and returns before constructing the HTTP client — logged, no network call |
| 4 | Adapter declares own local copy of 16-field proposal record, imports nothing from `src/` | VERIFIED | `proposal-client.ts` has zero `import`/`require` statements (`grep -c "^import..."` = 0); `grep -rn "from '.*/src/\|require(.*/src/" clients/proposal-reference/` returns nothing |
| 5 | Local store keys idempotency on the recense proposal id | VERIFIED | `local-store.ts` `findByProposalId(proposalId, storePath)`; `local-store.test.ts` covers replay case; `index.ts` calls `findByProposalId` pre-insert |
| 6 | Full outcome loop: list pending → map onto local rows keyed on `entity_descriptor` → approve/reject over HTTP | VERIFIED | `index.ts` `syncProposals()` (374 lines); e2e test "happy path" asserts DB rows `status='approved'`/`'rejected'` and local rows `applied` with matching `entity_descriptor` |
| 7 | Replayed proposal does not create a second local row / second HTTP call | VERIFIED | `sync-loop.test.ts` "Replay idempotency" case (no second POST on stub); e2e "replay safety" case — both green |
| 8 | 409-class refusal marks local row terminal, never retried | VERIFIED | `sync-loop.test.ts` "409 refusal is terminal" (no second POST on re-sync); e2e refusal round-trip; WR-01 fix distinguishes the ambiguous crash-resume 409 (`needs_reconciliation`, still terminal) from a normal first-attempt 409 (`refused`) — both paths never re-POST |
| 9 | Unrecognised `schema_version` stops the whole sync; unrecognised `kind` skips only that record | VERIFIED | `sync-loop.test.ts` schema-gate case (zero POSTs/zero rows for whole batch) and unknown-kind case (one POST, one row) both pass; `index.ts` implements schema gate before per-item loop |
| 10 | Adapter never renders `evidence_quote`/`change_from` as the decision surface | VERIFIED | Comment-stripped grep for `evidence_quote\|change_from` in `index.ts` = 0 (enforced by 67-02 acceptance criteria and still true post-fix); `sync-loop.test.ts` quote-injection sentinel test confirms the sentinel never reaches the persisted store |
| 11 | Fail-closed: no serve token → no network call at all | VERIFIED | Same as #3; `main()` returns before `createProposalClient()` is constructed when `!config.enabled` |
| 12 | Repo-level test seeds a real `action_proposal` row, serves it over the real HTTP surface, drives the adapter's own public entry — proving the contract end-to-end | VERIFIED | `tests/proposal-reference-e2e.test.ts` (339 lines) imports `initSchema`, `SemanticStore`, `ActionProposalStore`, `createBrainHttpServer` (engine side) and `syncProposals`/`listLocalRows`/`findByProposalId` from the adapter's public entry (consumer side); `grep -c "syncProposals"` ≥ 4, confirming every main assertion drives the loop rather than raw HTTP |
| 13 | E2E includes one full refusal round-trip: approve a proposal whose belief has moved → 409 → local row terminal → no retry | VERIFIED (with documented deviation) | `it('refusal round-trip...')` seeds `beliefTombstoned: true`, asserts local `refused`/`refusalReason: 'conflict'`, and asserts DB row is durably `'superseded'` (not the plan's literal "stays pending" wording) — this is the documented live-code-wins deviation, matching `ProposalStaleError` semantics and the sibling `proposal-routes.test.ts` EMIT-07 precedent; the "terminal, never retried" intent is proven, more strongly than the plan's literal wording |
| 14 | recense never learns the adapter's schema, adapter never imports an engine module | VERIFIED | Zero `src/` imports anywhere in `clients/proposal-reference/` (guard + grep, both hardened); engine imports exist only in `tests/proposal-reference-e2e.test.ts`, which is outside the scanned `clients/` tree — the only legal place both sides meet |
| 15 | `docs/reference-client.md` documents the contract for third-party buildability per the adopter-template pattern | VERIFIED | New `## Proposal reference client` heading (1 occurrence) placed after `## Telegram reference client`; new `### GET /v1/proposals` and `### POST /v1/proposals/:id/approve` / `.../reject` under `## API contract`; all 16 field names present; all four 409 detail literals present (5 occurrences ≥ 4) |
| 16 | Docs carry both mandatory carry-forwards: node ids not stable FKs (64 D-08), `change_from`/`change_to` asymmetric and must not be chained into a timeline (66-04) | VERIFIED | `grep -c "not a stable foreign key\|stable foreign keys"` = 1; `grep -c "change_from"` = 5, including an explicit no-chaining-into-a-timeline prohibition |
| 17 | Docs teach the fail-closed consumer posture: unknown `schema_version` → stop, unknown `kind` → skip, refusal → terminal, quote is data | VERIFIED | "Proposal consumer rules" sub-block inside existing `## Fail-closed pattern` section states all four rules; `schema_version` appears 3× including the stop rule |

**Score:** 17/17 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `clients/proposal-reference/tsconfig.json` | Paths-free compile boundary | VERIFIED | 0 `paths`/`references` keys; matches telegram's shape |
| `clients/proposal-reference/tests/import-boundary.test.ts` | CONSUME-02 sibling guard | VERIFIED | `collectTsFiles`, `expect(violations).toEqual([])`, `CONSUME-02` present; hardened post-review (WR-02), 3 passing tests incl. planted-offender + lawful-import coverage |
| `clients/proposal-reference/config.ts` | `AdapterConfig`/`loadAdapterConfig`, fail-closed gate | VERIFIED | 41 lines, `enabled = serveToken !== ''` |
| `clients/proposal-reference/proposal-client.ts` | HTTP consumer, locally-declared `ActionProposalRecord` | VERIFIED | 172 lines, zero imports, `Bearer`/`AbortSignal.timeout` present, sha256-hex id validation added post-review (WR-04) |
| `clients/proposal-reference/local-store.ts` | Adapter-owned local rows, idempotency key | VERIFIED | 251 lines, `findByProposalId`/`putLocalRow`/`listLocalRows`, corrupt-store fail-closed (WR-05) and cross-process lock (WR-06) added post-review |
| `clients/proposal-reference/index.ts` | `syncProposals`/`main` outcome loop | VERIFIED | 374 lines (≥ 90 min), exports `syncProposals`, `decideOutcome`, `main`; `require.main === module` guard present |
| `clients/proposal-reference/tests/sync-loop.test.ts` | HTTP-stub behavioral proof | VERIFIED | 456 lines, 9+ behavior cases, all passing |
| `tests/proposal-reference-e2e.test.ts` | Repo-level e2e proof | VERIFIED | 339 lines (≥ 120 min), 6 tests, all passing |
| `docs/reference-client.md` | Third-party-buildable contract doc | VERIFIED | 538 lines total, new sections confirmed above |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `vitest.config.ts` | `clients/proposal-reference/tests/` | include glob | WIRED | `include` array line 6 confirms the glob; `npx vitest run` (bare, whole-repo) discovers and runs the adapter's 3 in-dir suites |
| `clients/proposal-reference/proposal-client.ts` | `GET /v1/proposals` | fetch + Bearer header | WIRED | Confirmed live against `createBrainHttpServer` in the e2e (`GET /v1/proposals 200` in test output) |
| `clients/proposal-reference/index.ts` | `local-store.ts` | `findByProposalId` pre-insert idempotency | WIRED | Present in `index.ts`; exercised by replay tests |
| `clients/proposal-reference/index.ts` | `proposal-client.ts` | `createProposalClient(...)` | WIRED | Present in `main()`; exercised end-to-end |
| `tests/proposal-reference-e2e.test.ts` | `clients/proposal-reference/index.ts` | import of `syncProposals` | WIRED | `grep -c "syncProposals"` ≥ 4; every main assertion drives the real loop, not a reimplementation |
| `tests/proposal-reference-e2e.test.ts` | `ActionProposalStore` | engine-side seeding | WIRED | `seedProposal` helper cribbed from `tests/proposal-routes.test.ts`, uses real `ActionProposalStore`/`SemanticStore` |
| `docs/reference-client.md` | `src/db/action-proposal-store.ts` | verbatim 16-field transcription | WIRED | All 16 field names present and in the documented order; reviewed and confirmed exact-order match in 67-REVIEW.md |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Adapter's own boundary guard passes | `npx vitest run clients/proposal-reference/tests/` | 3 files, 25 tests passed | PASS |
| Repo-level e2e proves the loop live against a real HTTP server + real SQLite DB | `npx vitest run tests/proposal-reference-e2e.test.ts` | 6/6 passed (observed live `GET`/`POST .../approve` 200/409/401 traffic in server log output) | PASS |
| Zero engine imports (compile + static scan) | `npx tsc --noEmit -p clients/proposal-reference/tsconfig.json`; `grep -rn "from '.*/src/..." clients/proposal-reference/` | tsc exits 0; grep returns nothing | PASS |
| Full suite has no regression from this phase | `npx vitest run` (whole repo) | 230 files passed / 1 skipped; 3854 tests passed / 6 expected-fail / 3 skipped — matches documented baseline exactly, no `strip-hidden.test.ts` flake triggered | PASS |
| Root and tests tsconfig typecheck clean | `npx tsc --noEmit -p tsconfig.json`; `npx tsc --noEmit -p tests/tsconfig.json` | both exit 0 | PASS |
| CI wiring for adapter build script present | `grep -n "build:proposal-reference" package.json` | present, mirrors `build:client` precedent | PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| CONSUME-01 | 67-01, 67-02, 67-03 | In-repo reference consumer reads proposals, maps onto own local rows, proves contract e2e | SATISFIED | Truths #6, #7, #12, #13 above; e2e + sync-loop tests both green |
| CONSUME-02 | 67-01, 67-03 | Reference adapter imports no engine module, enforced by own tsconfig boundary + own import-boundary test | SATISFIED | Truths #1, #2, #4, #14 above; guard hardened post-review (WR-02) and verified in lockstep with the telegram sibling |
| CONSUME-03 | 67-03 | Contract documented well enough for third-party buildability, per adopter-template pattern | SATISFIED | Truths #15, #16, #17 above; all field/status/carry-forward greps pass |

**Note:** `.planning/REQUIREMENTS.md` still lists CONSUME-01/02/03 as `Pending` (checkboxes unchecked, tracking table unchanged) as of this verification. This is a bookkeeping gap, not a code gap — the project's own commit history (e.g. phase 64's `docs(phase-64): evolve PROJECT.md after phase completion` / `docs(state): record phase execution session`) shows this table is updated in a post-verification phase-completion step, which has not yet run for phase 67. No orphaned requirements found — all three CONSUME IDs from REQUIREMENTS.md are claimed and satisfied across the three plans.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| — | — | No `TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/`PLACEHOLDER` markers found in any phase-modified file | — | none |

Six Warning-level findings (WR-01 through WR-06) were raised in the standard-depth code review and **all six were fixed** on `main` prior to this verification (commits `0e5f736`, `adcd26a`, `97ec466`, `3d66e00`, `9573ac8`, `3a0d0f0`), independently confirmed above:
- WR-01 (crash-resume 409 mislabeled) → `needs_reconciliation` state added, distinct from `refused`
- WR-02 (import-boundary guard bypassable) → regex hardened, `.mts`/`.cts`/`.tsx` covered, non-vacuousness floor added, hardened in lockstep on the telegram sibling
- WR-03 (unchecked wire-shape cast crashes the sync) → object-shape gate added before the loop
- WR-04 (unvalidated id in POST path) → sha256-hex validation added, fail-closed on malformed id
- WR-05 (corrupt store silently overwritten) → `LocalStoreCorruptError`, fail-closed, quarantine-not-overwrite
- WR-06 (no concurrency guard) → O_EXCL cross-process lock file added

Six Info-level findings (IN-01 through IN-06) remain **open by design** (explicitly marked out of fix scope in 67-REVIEW.md, except the two docs-only fixes IN-02/IN-03 which were applied). None of IN-01/IN-04/IN-05/IN-06 block the phase goal — they are minor hardening/CI-coverage notes for a future pass, not correctness gaps in the shipped contract proof.

### Human Verification Required

None. This phase is fully backend/API surface with deterministic, automated test coverage at every layer (unit, in-dir behavioral, repo-level e2e against a real HTTP server + real SQLite DB). No UI, no visual rendering, no external service dependency outside the in-process test harness.

### Gaps Summary

No gaps. All three roadmap success criteria (CONSUME-01, CONSUME-02, CONSUME-03) and all 17 derived observable truths across the three plans are verified against live code, not SUMMARY.md claims. The one documented deviation (67-03's refusal-round-trip DB assertion: `'superseded'` instead of the plan's literal "stays pending") is a correct live-code-wins fix per this project's own CLAUDE.md rule, and it proves the "terminal, never retried" intent more strongly than the plan's original wording would have. The post-review fix pass closed all six Warning-level findings; the full suite (3854 passed / 6 expected-fail / 3 skipped) shows no regression against the documented baseline.

---

*Verified: 2026-08-03T09:26:15Z*
*Verifier: Claude (gsd-verifier)*
