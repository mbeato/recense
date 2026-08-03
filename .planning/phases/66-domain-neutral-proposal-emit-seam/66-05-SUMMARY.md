---
phase: 66-domain-neutral-proposal-emit-seam
plan: 05
subsystem: testing
tags: [sqlite, vitest, sentinel, self-confirmation, llm-free, http]

requires:
  - phase: 66-domain-neutral-proposal-emit-seam (plans 03/04)
    provides: "action_proposal table + ActionProposalStore, memory-ops approve/reject, /v1/proposals routes, real ActionProposalSink wired into the consolidator"
provides:
  - "Named 'D-43-for-proposals' two-layer sentinel: static write-isolation scan over the three approve/reject-path modules + runtime whole-table byte-identity proof across a real approve and a real reject"
  - "D-13 online-LLM-free regression extended to GET/POST /v1/proposals with a stricter embedCount===0 bound"
affects: [67-reference-consumer-adapter, 68-telegram-hitl-belief-kind-extension]

tech-stack:
  added: []
  patterns:
    - "Exported-predicate / real-scan / planted-offender static guard shape (no-ats-domain-table.test.ts precedent), applied to a new belief-write-isolation token list"
    - "Anchor-then-balanced-block extraction with a line-end-anchored opening-brace search (handles inline type-literal braces like `Promise<{ status: string }>` that would defeat a naive forward brace search)"
    - "Runtime whole-table SELECT * toEqual comparison across a real write op, non-vacuous via a paired terminal-status assertion"

key-files:
  created:
    - tests/action-proposal-write-isolation.test.ts
  modified:
    - tests/online-llm-free-sentinel.test.ts

key-decisions:
  - "Proposal record timestamps (created_at/updated_at/expires_at) in both new test files are anchored to Date.now(), not a FakeClock instance — approveProposal's D-10 staleness gate is always checked against realClock.nowMs() inside memory-ops.ts (not injectable), so a FakeClock-anchored expires_at would spuriously read as expired"
  - "Each test file scoped its own tmp RECENSE_LOCK_PATH before calling ops.approveProposal/rejectProposal, mirroring the existing GET /v1/surface block's convention — the default lock path is a single shared /tmp file and would contend with unrelated tests"
  - "Task 2's new describe block splits the single HTTP round-trip into a shared beforeEach (one pass through GET + approve + reject) with 5 separate `it` assertions, rather than one bundled test, to satisfy the plan's explicit +4-test-cases acceptance bar while keeping the actual network activity to one pass per test"

requirements-completed: [EMIT-03, EMIT-05]

duration: 55min
completed: 2026-08-03
---

# Phase 66 Plan 05: Named D-43-for-proposals Sentinel + /v1/proposals LLM-Free Extension Summary

**Closed the milestone's largest correctness risk structurally: a two-layer sentinel proves a consumer's approve/reject decision can never write recense's belief graph, and the existing online-LLM-free regression now covers all three `/v1/proposals` routes with a stricter zero-embed bound.**

## Performance

- **Duration:** 55 min
- **Started:** 2026-08-03T05:24:10Z (approx, per STATE.md session continuity)
- **Completed:** 2026-08-03T07:26:43Z
- **Tasks:** 2/2 completed
- **Files modified:** 2 (1 created, 1 extended)

## Accomplishments

- Shipped `tests/action-proposal-write-isolation.test.ts`: the named `D-43-for-proposals` sentinel, greppable verbatim, with an exported static predicate (`findProposalWriteIsolationOffenders`) scanning the three real approve/reject-path modules (whole-file for `action-proposal-store.ts`; balanced function bodies for `memory-ops.ts`'s `approveProposal`/`rejectProposal`; balanced route blocks for `serve-cli.ts`'s two `/v1/proposals` handlers) plus a whole-table runtime proof (`node`/`edge` `SELECT *` byte-identical across a real `wireMemoryEngine` approve + reject, and across a stale-refused approve).
- Extended `tests/online-llm-free-sentinel.test.ts`'s D-13 regression with a fourth dynamic block covering `GET /v1/proposals`, `POST .../approve`, `POST .../reject` against a fail-if-called `ModelProvider`, asserting `embedCount === 0` exactly (tighter than the existing `/v1/surface` block, since the proposal routes make no retrieval call at all) and extending the structural half's scanned source set to `src/db/action-proposal-store.ts`.
- Performed the plan's mandated deliberate-offender check: temporarily added `UPDATE node SET s = 1` inside the real `approveProposal` in `src/adapter/memory-ops.ts`, confirmed BOTH layers failed, recorded the failure output below, and reverted (verified `git diff` on `memory-ops.ts` is empty post-revert).
- Full suite green post-plan: 3802 passed / 6 expected-fail / 4 skipped (225 files passed, 1 skipped) — no regressions versus the pre-plan baseline.

## Task Commits

Each task was committed atomically:

1. **Task 1: The named "D-43-for-proposals" two-layer sentinel** - `d44395a` (test)
2. **Task 2: Extend the D-13 online-LLM-free regression to /v1/proposals** - `02ca7a9` (test)

**Plan metadata:** (this commit, docs: complete plan)

## Files Created/Modified

- `tests/action-proposal-write-isolation.test.ts` - New. Exports `FORBIDDEN_BELIEF_WRITE_TOKENS`, `findProposalWriteIsolationOffenders`, `findProposalStoreImportOffenders`; 26 test cases (real-source scan, 5-anchor non-vacuousness assertion, `it.each`-driven planted-offender suite over all 13 forbidden tokens, comment-stripping + permitted-read cases, and two runtime whole-table isolation tests: one normal approve+reject pair, one stale-refusal variant).
- `tests/online-llm-free-sentinel.test.ts` - Extended. New `describe('EMIT-03/D-11: /v1/proposals is LLM-free')` block (5 `it` cases sharing one `beforeEach` HTTP pass); structural-half scan set gained `src/db/action-proposal-store.ts`; header's "PHASE 66 EXTENSION POINT" paragraph replaced with a discharge statement. Test count 6 → 11 (+5).

## Decisions Made

- **Timestamp anchoring:** both new test files mint `ActionProposalRecord.created_at/updated_at/expires_at` from real `Date.now()`, not the `FakeClock` instances used to seed graph state — `classifyProposalStaleness` inside `approveProposal` is gated on `realClock.nowMs()` (not dependency-injected), so a FakeClock anchor (e.g. `Date.UTC(2026,0,1)`) reads as already-expired against real wall-clock time. Discovered live when the first runtime test threw `ProposalStaleError: ... expired` unexpectedly.
- **Per-test lock path:** both files' HTTP/engine tests set `process.env['RECENSE_LOCK_PATH']` to a fresh tmp path per test (mirroring the existing `GET /v1/surface` block's own convention) — `acquireLockWithRetry()`'s default lock path is one shared `/tmp/recense-sleep.lock`, which produced a real `MemoryBusyError` under concurrent test execution before this was added.
- **Test-count structure for Task 2:** rather than one bundled `it` asserting all of GET/approve/reject/embedCount/no-throw sequentially, the new describe block uses a shared `beforeEach` running the HTTP sequence once, with 5 separate `it` blocks each asserting one facet — satisfies the plan's explicit "at least 4 test cases more than before" acceptance bar without running the network sequence more than once per assertion group.

## Deviations from Plan

None — plan executed exactly as written. Both tasks' acceptance criteria were met without needing Rule 1/2/3 auto-fixes; the two items above (FakeClock/realClock mismatch, shared lock path) were found and fixed during the SAME task's own execution/verification loop before either task's commit, not scope creep discovered later.

## Deliberate-Offender Check (Task 1 acceptance criteria — required)

Temporarily added `writeDb.prepare('UPDATE node SET s = 1').run();` as the first line of the real `approveProposal` function body in `src/adapter/memory-ops.ts`, then ran `npx vitest run tests/action-proposal-write-isolation.test.ts`. Both layers failed as required:

**Layer (a) failure:**
```
FAIL  tests/action-proposal-write-isolation.test.ts > D-43-for-proposals — layer (a): static write-isolation scan > findProposalWriteIsolationOffenders returns [] over the three real scan targets
AssertionError: expected [ Array(1) ] to deeply equal []
- Expected: []
+ Received: ["memory-ops.ts approveProposal: contains forbidden token \"UPDATE node\""]
```

**Layer (b) failure:**
```
FAIL  tests/action-proposal-write-isolation.test.ts > D-43-for-proposals — layer (b): runtime whole-table write isolation > approving one proposal and rejecting another leaves node and edge byte-identical, and the two proposals reach terminal statuses
AssertionError: expected [ Array(4) ] to deeply equal [ Array(4) ]
  (every seeded node's "s" column changed from its seeded varied value to 1, e.g. "s": 0.2 → "s": 1, "s": 0.6 → "s": 1, "s": 0.9 → "s": 1, "s": 0.05 → "s": 1)
```
(The stale-refusal variant test also failed with the same node-table `s`-column diff shape.)

The offender line was reverted immediately after capturing this output; `git diff` on `src/adapter/memory-ops.ts` shows zero changes post-revert, and the full `tests/action-proposal-write-isolation.test.ts` suite (26/26) passes clean.

## Verification Against Plan's `<verification>` Block

1. `npx vitest run tests/action-proposal-write-isolation.test.ts tests/online-llm-free-sentinel.test.ts` → 37/37 passed.
2. `npm test` → 3802 passed / 6 expected-fail / 4 skipped, no new failures versus pre-plan state.
3. `grep -rc 'D-43-for-proposals' tests/ src/` → present in `tests/action-proposal-write-isolation.test.ts`, `src/db/action-proposal-store.ts`, `src/adapter/memory-ops.ts` (and also `tests/proposal-routes.test.ts`, an existing 66-04 file) — lineage greppable across code and test.
4. Deliberate-offender check performed and both layers failed — see above.

## Known Stubs

None.

## Threat Flags

None — this plan added test coverage only; no new production surface, endpoint, or trust boundary was introduced.

## Self-Check: PASSED

- FOUND: tests/action-proposal-write-isolation.test.ts
- FOUND: tests/online-llm-free-sentinel.test.ts
- FOUND commit: d44395a
- FOUND commit: 02ca7a9
