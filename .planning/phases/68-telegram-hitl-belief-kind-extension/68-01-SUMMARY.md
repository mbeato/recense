---
phase: 68-telegram-hitl-belief-kind-extension
plan: 01
subsystem: api
tags: [telegram, http-client, discriminated-union, typescript, vitest]

# Dependency graph
requires:
  - phase: 66-domain-neutral-proposal-emit-seam
    provides: the frozen /v1/proposals HTTP contract (GET list, POST approve/reject) and ActionProposalRecord's 16-field shape
  - phase: 67-reference-consumer-adapter
    provides: the proven consumer pattern (zero-import HTTP client, 64-hex id gate, wire-shape gate) this plan mirrors
provides:
  - StoredProposal discriminated union (StoredToolProposal | StoredBeliefProposal) in clients/telegram/types.ts
  - Five isBeliefProposal guards at every tool-path load site in index.ts (T-68-01 mitigation)
  - belief-proposal-client.ts — zero-import HTTP bridge to /v1/proposals (list/approve/reject)
  - belief-bridge.ts — record→row mapping (toStoredBeliefProposal), beliefLocalId, isBeliefProposal
  - Zero-diff hash lock proving proposal-store.ts/proposal-engine.ts are byte-identical to base commit 561f9c8
affects: [68-02, 68-03]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Discriminated union extension with a kind literal to add a new proposal shape without touching the shared store/engine"
    - "Zero-import HTTP client factory (Bearer built once at factory scope, AbortSignal.timeout, throw ProposalHttpError on non-2xx)"
    - "sha256 hash-lock test asserting byte-identity of frozen files as a convention-enforced invariant"

key-files:
  created:
    - clients/telegram/belief-proposal-client.ts
    - clients/telegram/belief-bridge.ts
    - clients/telegram/tests/belief-proposal-client.test.ts
    - clients/telegram/tests/belief-union-store.test.ts
  modified:
    - clients/telegram/types.ts
    - clients/telegram/index.ts
    - clients/telegram/tests/approval-handler.test.ts
    - clients/telegram/tests/edit-path.test.ts
    - clients/telegram/tests/typed-confirm.test.ts
    - clients/telegram/tests/proposal-store.test.ts

key-decisions:
  - "StoredProposal's existing member became StoredToolProposal with an explicit kind:'tool' literal (the live file had no kind field before this plan, contrary to CONTEXT.md's hedge) — a small, mechanical, additive change to every existing literal, zero behavior change"
  - "StoredBeliefProposal carries dueAt/createdAt/maxTtlMs synthesized from the server record's expires_at at bridge time, making the two isExpired() conditions coincide exactly at expires_at — this is the concrete mechanism (not a promise) by which belief-kind rides proposal-store.ts with zero changes"
  - "beliefLocalId truncates the server's 64-hex sha256 id to 32 chars rather than minting a fresh id — makes re-listing idempotent for free (getProposal(beliefLocalId(id)) IS the dedup check) and keeps callback_data payloads under Telegram's 64-byte limit"
  - "belief-bridge.ts was written before Task 1's guards needed it to compile, then held uncommitted until its own Task 3 commit — task-file boundaries stayed atomic in git history despite the compile-time forward dependency"

patterns-established:
  - "isBeliefProposal(p) as the single type predicate all tool-path load sites import, rather than five inline kind==='belief' string comparisons"
  - "Refusal literal 'that decision is handled by the belief approval flow' reused verbatim at all five guard sites"

requirements-completed: [APPROVE-02]

# Metrics
duration: ~20min
completed: 2026-08-03
---

# Phase 68 Plan 01: StoredProposal Union Extension + Belief HTTP Bridge Summary

**Extended StoredProposal into a discriminated union with a belief-kind member that rides proposal-store.ts's isExpired/putProposal/getProposal/tryReserveProposalSlot completely unmodified, closed the T-68-01 forged-callback path at all five tool-execution load sites, and stood up a zero-import HTTP bridge to the frozen `/v1/proposals` contract — with proposal-store.ts and proposal-engine.ts proven byte-identical to base commit 561f9c8 by both a git-diff assertion and a sha256 hash lock.**

## Performance

- **Duration:** ~20 min
- **Tasks:** 3 completed
- **Files modified/created:** 10 (4 created, 6 modified)

## Accomplishments

- `StoredProposal` is now `StoredToolProposal | StoredBeliefProposal`, discriminated on `kind`; every existing tool-proposal literal and test factory updated to carry `kind: 'tool'` with zero behavior change
- Five `isBeliefProposal` guards close T-68-01 (forged `2|{beliefLocalId}|a` callback reaching `callServerTool` with an undefined tool name) at `executeStoredProposal`, `handleEditPatch`, and the reject/edit/approve branches of `handleProposalAction`
- `belief-proposal-client.ts` lists/approves/rejects against a stub serve with the 64-hex id gate proven to build zero requests on malformed input, and the Bearer token proven never to leak into a thrown Error message
- `belief-bridge.ts` maps `ActionProposalRecord` → `StoredBeliefProposal` so the two `isExpired()` conditions (dueAt-past, createdAt+maxTtlMs-exceeded) coincide exactly at the server's `expires_at`
- The zero-diff constraint is enforced twice: a `git diff --stat` assertion in the plan's verification AND a standing sha256 hash-lock test in `belief-union-store.test.ts` that will fail loudly if either frozen file is ever touched

## Task Commits

Each task was committed atomically (Tasks 2 and 3 used TDD — test commit then feat commit):

1. **Task 1: StoredProposal discriminated union + tool-path guards** - `65a330e` (feat)
2. **Task 2: Belief HTTP bridge client** - `ad38a43` (test, RED) → `758adfd` (feat, GREEN)
3. **Task 3: Record→row mapping + zero-diff lock** - `23973bd` (test, RED) → `ee4ea8c` (feat, GREEN)

## Files Created/Modified

- `clients/telegram/types.ts` - `StoredToolProposal`/`StoredBeliefProposal`/`StoredProposal` union, `ProposalStatus`
- `clients/telegram/index.ts` - `kind: 'tool'` on the two production literals, five `isBeliefProposal` refusal guards
- `clients/telegram/belief-proposal-client.ts` - zero-import HTTP bridge (`createBeliefProposalClient`, `ProposalHttpError`, `isInspectableProposalRecord`, `PROPOSAL_SCHEMA_VERSION`)
- `clients/telegram/belief-bridge.ts` - `toStoredBeliefProposal`, `beliefLocalId`, `isBeliefProposal`
- `clients/telegram/tests/belief-proposal-client.test.ts` - 8 stub-server behavioral tests
- `clients/telegram/tests/belief-union-store.test.ts` - 12 tests (field mapping, real-store round-trip, hash lock)
- `clients/telegram/tests/{approval-handler,edit-path,typed-confirm,proposal-store}.test.ts` - factory literals retyped to `StoredToolProposal`

## Decisions Made

- The live `StoredProposal` had no `kind` field at all before this plan (CONTEXT.md's hedge resolved in favor of the "add kind to both members" branch) — flagged as a genuinely-differing-from-hedge finding per the pattern map, not treated as a deviation since the plan's own D-01 anticipated this exact branch
- `belief-bridge.ts` was authored ahead of its own Task 3 slot (Task 1's guards need `isBeliefProposal` to compile) but held uncommitted in the working tree until Task 3's commit, so git history still reflects one file per its planned task

## Deviations from Plan

None — plan executed exactly as written, including the TDD RED/GREEN sequencing for Tasks 2 and 3 (implementation was moved aside, the test was confirmed failing on missing-module, then restored and confirmed passing).

## Issues Encountered

None. Worktree base was stale on start (forked from an older commit than the plan's expected base) — corrected via `git reset --hard` to `a634d2d` before any source reads, per the worktree branch check protocol.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `isBeliefProposal`, `toStoredBeliefProposal`, `beliefLocalId`, and `createBeliefProposalClient` are all in place for Plan 02 (poll loop + decision-surface rendering) and Plan 03 (batching + approval-rate self-report) to consume
- `proposal-store.ts` and `proposal-engine.ts` remain byte-identical to base commit 561f9c8, verified by both `git diff --stat` and the standing sha256 hash lock — Plans 02/03 must preserve this invariant
- No blockers for downstream plans in this phase

---
*Phase: 68-telegram-hitl-belief-kind-extension*
*Completed: 2026-08-03*

## Self-Check: PASSED

All created files verified present on disk (belief-proposal-client.ts, belief-bridge.ts,
tests/belief-proposal-client.test.ts, tests/belief-union-store.test.ts, this SUMMARY.md).
All 5 commits verified present in git log (65a330e, ad38a43, 758adfd, 23973bd, ee4ea8c).
