---
phase: 66-domain-neutral-proposal-emit-seam
verified: 2026-08-03T04:05:00Z
status: passed
score: 5/5 roadmap success criteria verified (7/7 EMIT requirement IDs satisfied)
overrides_applied: 0
notes:
  - "D-02a amendment (belief_node_id, a 16th column beyond CONTEXT.md D-02's original list) is live in the DDL, the TS record type, and the /v1/proposals GET response payload. It is recense-internal lineage (same namespace as entity_node_id), deliberately excluded from the proposalId() hash, and reviewed as sound by the plan-checker per 66-CONTEXT.md. Flagging per the phase CONTEXT's own instruction — not a gap, a founder-visible design note."
  - "REQUIREMENTS.md still shows EMIT-01..07 as unchecked `[ ]` (lines 56-62) while the DRIFT items above them are `[x]`. This is a documentation-staleness gap in REQUIREMENTS.md itself, not a code gap — all 7 EMIT requirements are satisfied in the live codebase (see Requirements Coverage below). Recommend updating the checkboxes as a housekeeping follow-up; not blocking."
  - "3 Info-level findings from 66-REVIEW.md (IN-01 dead ActionProposalStore.clock field references, IN-02 stale JSDoc on applySecondaryContradiction, IN-03 contract test uses a locally-derived id hash rather than the real proposalId()) remain open by the review's own classification (Info, out of scope for the fix pass). Confirmed still present; none affect correctness or the must-haves below."
---

# Phase 66: Domain-Neutral Proposal Emit Seam Verification Report

**Phase Goal:** `ActionProposalSink` + `action_proposal` table + `/v1/proposals` routes; a named "D-43-for-proposals" sentinel test closes the milestone's largest correctness risk structurally.
**Verified:** 2026-08-03T04:05:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Proposals are emitted through a new `ActionProposalSink` (Noop default, mirroring `ConsolidationSink`) into an additive `action_proposal` table — zero cost when unconfigured (EMIT-01) | VERIFIED | `src/consolidation/action-proposal-sink.ts` ships the full triad (`ActionProposalSink`, `NoopActionProposalSink`, `SQLiteActionProposalSink`, `MockActionProposalSink`). `src/lib/config.ts:935` `actionProposalSinkEnabled: false` (dark default). `src/consolidation/run-sleep-pass.ts:542-544` selects Noop unless the knob is true — two independent Noop barriers (knob + `Consolidator` constructor default, `consolidator.ts` param `= new NoopActionProposalSink()`). `action_proposal` DDL is additive-only: `schema.ts:226` `CREATE TABLE IF NOT EXISTS`, `SCHEMA_VERSION = 17` (`schema.ts:12`), `git diff` shows zero changes to any pre-existing table (confirmed by 66-01-SUMMARY's acceptance run and independently re-checked: `grep -c 'CREATE TABLE IF NOT EXISTS action_proposal' src/db/schema.ts` → 1). |
| 2 | A consumer can list pending proposals and record approve/reject over the existing authenticated `recense serve` surface; each proposal is a flat domain-neutral record with no consumer-specific fields and a deterministic id (EMIT-02, EMIT-03, EMIT-04) | VERIFIED | `GET /v1/proposals` + `POST /v1/proposals/:id/approve\|reject` land in `serve-cli.ts` textually after `checkAuth` (confirmed: both route blocks appear after the `!checkAuth` guard; 401 tests in `tests/proposal-routes.test.ts` prove auth fires before body parse). Record shape is flat (`id, kind, entity_node_id, entity_descriptor, belief_node_id, change_field, change_from, change_to, evidence_episode, evidence_quote, confidence, schema_version, status, created_at, updated_at, expires_at`) — no JSON Patch, no consumer vocabulary; locked three ways in `tests/action-proposal-contract.test.ts` (literal array / `ACTION_PROPOSAL_FIELDS` satisfies-map / live `PRAGMA table_info`). `proposalId()` (`action-proposal-sink.ts`) is `sha256(JSON.stringify([entity_node_id, change_field, change_from, change_to, evidence_episode]))` — deterministic, timestamp- and `belief_node_id`-insensitive; replay-collapse proven at store level (`action-proposal-contract.test.ts`), sink level (`action-proposal-sink.test.ts`), and through a real `consolidate()` re-run (`action-proposal-emission.test.ts`). |
| 3 | Approving or rejecting writes only proposal status — never `node.s`/`node.c` — proven by a named "D-43-for-proposals" sentinel (EMIT-05) | VERIFIED | `tests/action-proposal-write-isolation.test.ts` exists (24KB, 26 test cases claimed/confirmed passing), exports `FORBIDDEN_BELIEF_WRITE_TOKENS`, `findProposalWriteIsolationOffenders`, `findProposalStoreImportOffenders`; string `D-43-for-proposals` greps to exactly `tests/action-proposal-write-isolation.test.ts`, `src/db/action-proposal-store.ts`, `src/adapter/memory-ops.ts`, and `tests/proposal-routes.test.ts` (lineage confirmed live, not just claimed). Layer (a) static scan and Layer (b) runtime whole-table `node`/`edge` `SELECT *` snapshot both pass (`npx vitest run tests/action-proposal-write-isolation.test.ts` → 26/26 green, verified directly). Post-review CR-01 fix independently re-read in `memory-ops.ts:576-671` and `action-proposal-store.ts:189-231`: `updateStatus` was replaced by `transitionFromPending` (CAS: `UPDATE ... WHERE id=@id AND status='pending'`, `.changes === 1`), and both `approveProposal`/`rejectProposal` now re-run every decisive check (`getById`, pending check, EMIT-07 staleness) **under** `acquireLockWithRetry()`, closing the check-then-act race the review flagged — confirmed by direct code read, not just the REVIEW.md narrative. |
| 4 | A proposal carries its raw quoted evidence verbatim alongside the structured change (EMIT-06) | VERIFIED | `evidence_quote` is threaded from `episode.content` (the exact post-strip-hidden/redact/capContent row the consolidation loop already holds) into `maybeEmitProposal` (`consolidator.ts`), with zero formatter/summariser/`ModelProvider` on the path. Byte-identical round-trip proven with an injection-shaped payload (newlines, angle brackets, quotes, non-ASCII) in `tests/action-proposal-sink.test.ts` and against the real DDL/DB in `tests/action-proposal-emission.test.ts`. |
| 5 | A stale or superseded proposal is detected and refused before an approval can apply it (EMIT-07) | VERIFIED | `classifyProposalStaleness` (pure, `action-proposal-store.ts`) implements the `entity_gone > superseded > expired` precedence; `approveProposal` calls it **under the lock** (post CR-01 fix) before any status transition, writing a durable terminal status via CAS before throwing `ProposalStaleError`. WR-01 fix confirmed live: null staleness inputs (inner-join miss) now classify as `entity_gone` rather than fail-open `'ok'` (`memory-ops.ts:608-615`). WR-03 fix confirmed live: `listPending` filters `expires_at > @now` (`action-proposal-store.ts:162`), preventing expired-row list starvation. All three refusal branches (entity tombstoned, belief tombstoned, expired) covered end-to-end in `tests/proposal-routes.test.ts`. |

**Score:** 5/5 roadmap success criteria verified (all 7 EMIT-01..07 requirement IDs satisfied — see Requirements Coverage below)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/db/schema.ts` | `action_proposal` DDL, v17 migration, `SCHEMA_VERSION=17` | VERIFIED | 16 frozen columns confirmed at schema.ts:226-253 (read directly); `SCHEMA_VERSION = 17` at line 12; three indexes present; no ALTER on any existing table. |
| `src/db/action-proposal-store.ts` | `ActionProposalRecord`, `ACTION_PROPOSAL_FIELDS`, `ActionProposalStore`, `classifyProposalStaleness`, `PROPOSAL_TTL_MS`, `PROPOSAL_LIST_LIMIT` | VERIFIED | All exports present and read directly (10148 bytes); sole `UPDATE` is the CAS `transitionFromPending`; `listPending` has the WR-03 expiry filter. |
| `tests/action-proposal-contract.test.ts` | frozen-contract lock, replay proof, staleness table | VERIFIED | Exists, passes (part of the 106/106 targeted run). |
| `src/consolidation/action-proposal-sink.ts` | `ActionProposalSink` triad + `proposalId()` | VERIFIED | Exists (7674 bytes), exports confirmed, `newId()` count 0, `await` count 0 (synchronous per D-06). |
| `src/lib/config.ts` | `actionProposalSinkEnabled` dark knob, default false | VERIFIED | Line 208 (interface), line 935 (`false` default), line 1083 (WR-04 fix: added to the typed `SettingsFile.overrides` Pick). |
| `tests/action-proposal-sink.test.ts` | Noop/determinism/verbatim-quote proofs | VERIFIED | Exists, passes. |
| `src/adapter/memory-ops.ts` | `listProposals`/`approveProposal`/`rejectProposal` + 3 typed errors | VERIFIED | Confirmed at memory-ops.ts:561-680; CR-01 CAS fix confirmed live by direct read. |
| `src/adapter/serve-cli.ts` | `GET /v1/proposals` + `POST /v1/proposals/:id/approve\|reject` | VERIFIED | Both routes present after auth gate (confirmed by passing 401-before-parse tests). |
| `tests/proposal-routes.test.ts` | auth/contract/refusal-matrix integration suite | VERIFIED | Exists, passes (14+ cases). |
| `src/consolidation/consolidator.ts` | `proposalSink` param, `maybeEmitProposal`, 9 gated call sites | VERIFIED | `grep -c '^\s*this\.maybeEmitProposal('` → 9; `grep -c 'this.proposalSink.emit('` → 1; `isEmissionEligible` imported and used (never re-derived). |
| `src/consolidation/run-sleep-pass.ts` | config-gated sink injection | VERIFIED | Lines 542-544, 610 confirmed. |
| `src/adapter/recense-doctor.ts` | dimension 10 — proposal sink posture | VERIFIED | `checkProposalSink` exported, registered in `dimensions` array (line 599). |
| `tests/action-proposal-emission.test.ts` | emission behavioral suite | VERIFIED | Exists (32KB), passes. |
| `tests/emission-hold-sentinel.test.ts` | Phase 65 sentinel extended + narrowed to real sink | VERIFIED | Exists, passes; `maybeEmitProposal` in `FORBIDDEN_EMISSION_IDENTIFIERS`; narrowed anchor confirmed. |
| `tests/action-proposal-write-isolation.test.ts` | named D-43-for-proposals two-layer sentinel | VERIFIED | Exists (24KB, ≥150 lines), passes, string verbatim confirmed. |
| `tests/online-llm-free-sentinel.test.ts` | D-13 extension to `/v1/proposals` | VERIFIED | Exists, passes; `embedCount === 0` assertion present in the run output. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `action-proposal-store.ts` | `action_proposal` table | prepared statements, named bound params | WIRED | Confirmed — zero `${` template interpolation in the module. |
| `run-sleep-pass.ts` | `config.actionProposalSinkEnabled` | ternary sink selection | WIRED | `run-sleep-pass.ts:542-544` confirmed. |
| `consolidator.ts` | `status-drift.ts` (`isEmissionEligible`) | import, never re-derived | WIRED | `consolidator.ts:50` import; `:1325` `if (!isEmissionEligible(eventType)) return;`; zero locally re-declared `new Set<ConsolidationEventType>`. |
| `consolidator.ts` | `action-proposal-sink.ts` | `this.proposalSink.emit` inside `applyDecision` | WIRED | Exactly 1 call site, funneled through `maybeEmitProposal`, called from 9 gated sites. |
| `serve-cli.ts` | `ops.listProposals/approveProposal/rejectProposal` | authenticated route handlers | WIRED | Confirmed via passing integration tests exercising real HTTP round-trips. |
| `memory-ops.ts` | `ActionProposalStore.transitionFromPending` (post CR-01, was `updateStatus`) | the single write in approve/reject | WIRED | Confirmed by direct code read — CAS transition used in both functions and in the stale-terminal-write branch. |
| `memory-ops.ts` | `classifyProposalStaleness` | pre-status-transition staleness gate, now under the lock | WIRED | Confirmed — gate re-checked under `acquireLockWithRetry()` per CR-01 fix. |

### Data-Flow Trace (Level 4)

Not primarily applicable — this phase is backend CRUD/HTTP surface, not a UI component rendering fetched state. The closest analogue (does the served `items` array reflect real DB rows, not a static stub) is covered directly: `GET /v1/proposals` → `ops.listProposals()` → `proposalReadStore.listPending()` → real `SELECT ... FROM action_proposal WHERE status='pending' AND expires_at > @now` — proven non-vacuous by `tests/proposal-routes.test.ts` (seeded rows appear in the response) and `tests/online-llm-free-sentinel.test.ts` (positive-completion assertion: non-empty `items` array, not a short-circuited empty response).

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full targeted phase-66 test suite | `npx vitest run tests/action-proposal-contract.test.ts tests/action-proposal-sink.test.ts tests/proposal-routes.test.ts tests/action-proposal-emission.test.ts tests/emission-hold-sentinel.test.ts tests/action-proposal-write-isolation.test.ts tests/online-llm-free-sentinel.test.ts` | 7 files / 106 tests passed | PASS |
| Typecheck | `npm run typecheck` | exits 0 | PASS |
| Full suite regression | `npm test` | 226 files passed \| 1 skipped; 3815 tests passed \| 6 expected fail \| 3 skipped | PASS — matches the SUMMARY/REVIEW-claimed baseline exactly, independently re-run, not taken on faith |
| 9 gated emission call sites | `grep -c '^\s*this\.maybeEmitProposal(' src/consolidation/consolidator.ts` | 9 | PASS |
| Single emit funnel | `grep -c 'this.proposalSink.emit(' src/consolidation/consolidator.ts` | 1 | PASS |
| D-43-for-proposals lineage greppable | `grep -rn 'D-43-for-proposals' tests/ src/` | 4 files (store, memory-ops, write-isolation sentinel, proposal-routes) | PASS |

### Probe Execution

Step 7c: SKIPPED — no `scripts/*/tests/probe-*.sh` files exist in this repository and none are declared in the phase's plans/summaries.

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|---|---|---|---|---|
| EMIT-01 | 66-02, 66-04 | Noop-default sink, zero cost unconfigured | SATISFIED | Dark knob defaults false; two independent Noop barriers; live sleep-pass injection gated correctly. |
| EMIT-02 | 66-01 | Flat, domain-neutral record, no consumer fields | SATISFIED | 16-field frozen contract, no CHECK on change_* columns, three-way lock non-vacuous (proven by mutation test in 66-01-SUMMARY). |
| EMIT-03 | 66-03, 66-05 | Authenticated list/approve/reject mirroring `/v1/surface` | SATISFIED | Routes land after auth gate, zero new auth code; D-13 LLM-free regression extended with embedCount===0. |
| EMIT-04 | 66-01, 66-02 | Deterministic id, replay cannot apply twice | SATISFIED | `proposalId()` content-hash + `INSERT OR IGNORE`; replay collapse proven at 3 levels (store, sink, real consolidate() re-run). |
| EMIT-05 | 66-03, 66-05 | Approve/reject writes only status, D-43-for-proposals sentinel | SATISFIED | Named sentinel exists and passes; CR-01 race fix independently confirmed live in code, not just claimed in REVIEW.md. |
| EMIT-06 | 66-02, 66-04 | Raw quoted evidence verbatim | SATISFIED | `evidence_quote` threaded from the exact post-processing episode row; byte-identical round-trip tests with injection-shaped payloads. |
| EMIT-07 | 66-01, 66-03 | Stale/superseded proposal refused before approval | SATISFIED | `classifyProposalStaleness` precedence; WR-01 fail-closed fix and WR-03 listPending expiry filter both confirmed live. |

No orphaned requirements — REQUIREMENTS.md's EMIT-01..07 section (lines 56-62) matches exactly the 7 IDs declared across the five plans' frontmatter. (REQUIREMENTS.md's checkbox column itself is stale — see notes in frontmatter above; this is a documentation housekeeping item, not a coverage gap.)

### Anti-Patterns Found

None. Scanned all 16 phase-modified/created files (9 src, 7 test) for `TBD|FIXME|XXX|TODO|HACK|PLACEHOLDER` — zero matches. The three Info-level findings from `66-REVIEW.md` (IN-01 dead `.clock`/`.db` field references — partially resolved as a WR-03 side effect since `listPending` now reads `this.clock`; IN-02 stale JSDoc on `applySecondaryContradiction`; IN-03 contract test's locally-derived id hash differs from the real `proposalId()` encoding) remain open, confirmed present, and are correctly classified Info (documentation/hygiene only, no correctness impact) — none touch a must-have.

### Human Verification Required

None. This phase is backend HTTP/DB surface with no UI, no real-time behavior, and no external service dependency. Every must-have is covered by automated tests that were independently re-run during this verification (not accepted from SUMMARY narration).

### Gaps Summary

No gaps. All 5 ROADMAP success criteria and all 7 EMIT-01..07 requirement IDs are verified against live code, not SUMMARY claims:

- The 5 post-review fix commits (CR-01, WR-01, WR-02, WR-03, WR-04) were independently re-read in the current source (not re-derived from `66-REVIEW.md`'s prose) and confirmed present exactly as described: CAS `transitionFromPending` replacing the unconditional `updateStatus`, fail-closed null-staleness handling, eviction-sweep terminal-row child-wipe for `action_proposal`, `listPending`'s `expires_at > @now` filter, and the typed `SettingsFile.overrides` Pick gaining `actionProposalSinkEnabled`.
- The named `D-43-for-proposals` sentinel exists, is greppable across the expected 4 files, and both its static and runtime layers pass.
- `npm test` was independently re-run and reproduced the exact claimed baseline (3815 passed / 6 expected-fail / 3 skipped / 226 files passed, 1 skipped) — not merely copied from the SUMMARY.
- `npm run typecheck` independently re-run, exits 0.
- Two informational (non-blocking) items are carried in this report's frontmatter `notes:` per the phase's own instruction to surface them: the D-02a `belief_node_id` 16th-column amendment (already plan-checker-reviewed, working as intended), and REQUIREMENTS.md's stale unchecked `[ ]` boxes for EMIT-01..07 (a documentation-only gap, contradicted by the live, tested code).

---

*Verified: 2026-08-03T04:05:00Z*
*Verifier: Claude (gsd-verifier)*
