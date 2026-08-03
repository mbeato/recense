---
phase: 64-entity-resolution-hardening
plan: 03
subsystem: consolidation
tags: [consolidator, entity-resolution, wiring, resolution-branch, gmail]

# Dependency graph
requires:
  - phase: 64-entity-resolution-hardening
    plan: 01
    provides: "hoisted gmailSourced gate at all three claim-side intent fill sites"
  - phase: 64-entity-resolution-hardening
    plan: 02
    provides: "standalone EntityResolver (generateCandidates + resolve) and entityResolutionFloor/entityResolutionMargin config knobs"
provides:
  - "claimResolvedEntityId / claimResolvedEntityDescriptor on ClaimDecision — all-or-nothing (D-07), inert this phase (D-09)"
  - "Resolution branch inside consolidate()'s per-episode loop, positioned strictly after the WR-01/CR-01/ACT-03 hard stop and after all four intent fill sites"
  - "RESOLVE-64 observability log line (attempts/hits/abstains + per-channel candidate totals) emitted once per pass"
affects: [65-belief-gated-status-drift, 66-domain-neutral-proposal-emit-seam]

tech-stack:
  added: []
  patterns:
    - "Resolution branch as a single post-fill loop over decisionSlots, iterated once after all four claim-side fill sites (fast-path, auto-unrelated, pendingJudges push, post-judge fill) — one branch covers every decision route instead of four independent scans (Pitfall 6 / D-03 discipline extended one layer down)"
    - "claimVecs[i] reused as the dense-channel vec at the resolution call site — zero net-new embed call, index-aligned with decisionSlots by construction"
    - "bm25CandidateK: 0 as a test-harness isolation technique — disables ONLY the consolidator's own outer union-generator BM25 pass so a seeded entity node's FTS presence cannot accidentally escalate an intended auto-unrelated test case to judge; does not touch EntityResolver's independent internal BM25 channel"

key-files:
  created:
    - tests/consolidation-resolution.test.ts
    - tests/resolution-sentinels.test.ts
  modified:
    - src/consolidation/consolidator.ts

key-decisions:
  - "Resolution branch placed as a standalone loop over decisionSlots (not folded into the existing per-claim loop or the post-judge fill loop) — keeps 'one branch, not four' auditable via a single grep-verifiable call site (entityResolver.resolve( appears exactly once)"
  - "slot == null (not slot === null) used in the branch's skip guard — required for noUncheckedIndexedAccess (tsc flags decisionSlots[i] as possibly undefined in addition to the array's own null sentinel)"
  - "Test-harness dark-knob bm25CandidateK: 0 adopted across all three new test files to isolate the consolidator's own outer BM25 union pass from EntityResolver's independent internal BM25 channel — prevents a seeded entity node's FTS presence from silently escalating an intended auto-unrelated route to judge-escalation"

requirements-completed: [RESOLVE-01, RESOLVE-02, RESOLVE-03]

# Metrics
duration: 55min
completed: 2026-08-02
---

# Phase 64 Plan 03: Entity Resolution Wiring Summary

**Wired the Phase 64-02 `EntityResolver` into `consolidator.ts`'s per-episode loop via one resolution branch positioned after the inferred/echo/hitl hard stop and all four intent fill sites — two all-or-nothing in-memory fields, zero schema change, zero net-new provider calls, one observability log line per pass.**

## Performance

- **Duration:** ~55 min
- **Started:** 2026-08-02T19:XX (approx, first Read after worktree reset)
- **Completed:** 2026-08-02T20:02Z
- **Tasks:** 3
- **Files modified:** 3 (1 modified, 2 created)

## Accomplishments

- Threaded `claimResolvedEntityId?: string` / `claimResolvedEntityDescriptor?: string` onto the module-internal `ClaimDecision` interface, all-or-nothing (D-07), documented as recense-internal-lineage-only (not a stable consumer FK) and inert this phase (D-09).
- Instantiated `EntityResolver(db, store, config)` once in the `Consolidator` constructor (type-level D-04 guarantee: no `ModelProvider` parameter).
- Added a single resolution branch inside `consolidate()`'s per-episode loop, textually after the `episode.origin === 'inferred' || echoSourceId !== null || episode.source === 'hitl'` hard stop and after the post-judge fill loop — one branch covers all three decision routes (fast-path confirm, auto-unrelated, judge-escalated) rather than a fourth copy per route.
- Added `resolutionAttempts` / `resolutionHits` / `resolutionAbstains` + three per-channel candidate totals at `consolidate()` method scope, emitted as a single `RESOLVE-64` log line immediately after the existing `RECON-03` line.
- Wrote `tests/consolidation-resolution.test.ts` (8 cases): all three decision routes resolving through the real `consolidate()` path, unknown-entity abstain + no-mint proof, no-intent-fields zero-attempt counter check, near-duplicate separation, exact descriptor identity (`toBe`, mixed-case/punctuated value), and an all-or-nothing invariant looped over every captured decision in a mixed-route pass.
- Wrote `tests/resolution-sentinels.test.ts` (6 cases): hitl/inferred/echo hard-stop inheritance (D-03/Pitfall 6), WR-01 non-gmail smuggling against a resolvable seeded entity paired with a gmail positive control that DOES resolve (D-10, proves the negative case is non-vacuous), and provider call-count equality (embed/generate/judge/judgeBatch) between a resolving run and an `entityResolutionFloor: 2` control run (D-04 runtime belt to the type-level suspenders).

## Task Commits

Each task was committed atomically:

1. **Task 1: Thread resolved-entity fields and run the resolution branch inside the per-episode loop** - `8d41b76` (feat)
2. **Task 2: End-to-end resolution suite through consolidate()** - `9767e58` (test)
3. **Task 3: Sentinel suite — guard inheritance, WR-01 no-resolution, zero net-new LLM calls** - `a1e2e67` (test)

_Note: Tasks 2 and 3 are marked `tdd="true"` in the plan; per their own `<action>`/`<behavior>` blocks (fully specified test suites written against the already-shipped Task 1 wiring, not iteratively red→green), they landed as single `test` commits, each followed by its own mutation/paired-control check as the load-bearing verification method rather than a strict RED-then-GREEN split. This follows the same precedent 64-01/64-02 established for `tdd="true"` tasks in this phase._

## Files Created/Modified

- `src/consolidation/consolidator.ts` — added `import { EntityResolver } from './entity-resolution'`; added `claimResolvedEntityId?`/`claimResolvedEntityDescriptor?` to `ClaimDecision` (with full D-07/D-08/D-09 JSDoc, mirroring the CLASSIFY-02 block); added `private readonly entityResolver: EntityResolver` field + constructor instantiation `new EntityResolver(db, store, config)`; added six `consolidate()`-scope counters (`resolutionAttempts`/`Hits`/`Abstains` + `resolutionExactTotal`/`Bm25Total`/`DenseTotal`); added the resolution branch (a `for` loop over `decisionSlots`, positioned between the post-judge fill loop and `decisionSlots.filter(...)`); added the `RESOLVE-64` log line after `RECON-03`.
- `tests/consolidation-resolution.test.ts` — new file, 8 test cases proving RESOLVE-01/02/03 end-to-end through `consolidate()`.
- `tests/resolution-sentinels.test.ts` — new file, 6 test cases proving D-03/D-10/D-04 structurally.

## Decisions Made

- Resolution branch kept as a standalone post-fill loop (not merged into the earlier per-claim loop) so the acceptance-criteria grep (`entityResolver.resolve(` exactly once, positioned strictly between the hard stop and `decisionSlots.filter(`) is trivially and unambiguously satisfied.
- `slot == null` (loose equality) used instead of `slot === null` in the branch's skip guard — `tsc`'s `noUncheckedIndexedAccess` widens `decisionSlots[i]` to include `undefined` alongside the array's own `null` sentinel; `===` alone left two typecheck errors.
- Adopted `bm25CandidateK: 0` in all three new test-file harnesses (Phase 46 D-07 dark knob) to prevent a seeded entity node's `node_fts` presence from leaking into the consolidator's own outer union-generator BM25 pass and silently escalating an intended auto-unrelated test case to judge-escalation. Does not affect `EntityResolver`'s own independent internal BM25 channel (that module has no dependency on this config field).

## Mutation Check Result (Task 2, required by plan acceptance criteria)

Performed once: temporarily commented out `slot.claimResolvedEntityDescriptor = resolution.descriptor;` in the resolution branch (leaving only the id assignment), re-ran `npx vitest run tests/consolidation-resolution.test.ts`.

- **Result:** 6 of 8 tests failed (fast-path, auto-unrelated, judge-escalated, near-duplicate, descriptor-identity, and — critically — the all-or-nothing invariant loop). Only the unknown-entity-abstain and no-intent-fields cases (which never expect a descriptor) still passed.
- Restored the line; `git diff` against the committed Task 1 state confirmed empty; re-ran the suite — 8/8 pass again.

This confirms the all-or-nothing loop assertion is load-bearing, not vacuous.

## Observed RESOLVE-64 Log Line (real fixture run, required by plan `<output>`)

Ran a standalone fixture (one gmail episode, one seeded "Acme Corp" entity node, fast-path confirm route, resolution hit) through a real `Consolidator` instance with a custom log sink:

```
RESOLVE-64 attempts=1 hits=1 abstains=0 | exact=1 bm25=1 dense=1
```

(`exact=1` — the entity resolved via the exact-match channel; `bm25=1` — the same node's `node_fts` row also matched, channel-attribution is non-exclusive; `dense=1` — the dense channel's top-K scan surfaced the one embedded entity node, contributing `dense=0` score since it was seeded with a zero vector, consistent with "never dense-only".)

## Paired Provider Call Counts (Task 3, required by plan `<output>`)

Resolving run vs. `entityResolutionFloor: 2` control run, identical single-episode gmail input:

| Method | Resolving run | Control run (floor=2, abstains) |
|---|---|---|
| `embed` | equal | equal |
| `generate` | 1 | 1 |
| `judge` | 0 | 0 |
| `judgeBatch` | equal | equal |

All four counts equal between the two runs in both call-count sentinel tests — confirms `EntityResolver.resolve()` makes zero provider calls regardless of whether it resolves or abstains, consistent with its type-level guarantee (constructor takes no `ModelProvider`).

## Issues Encountered

**Worktree base mismatch at spawn.** Same class of issue as 64-01/64-02: the worktree's HEAD was on an unrelated commit (`f779bfb`, phase-45 content) rather than the expected phase-64 base. Per `<worktree_branch_check>`, ran `git reset --hard 37d254d9f0452e4c338753c457b413a5107ceac4` before any file reads — expected setup-step behavior, not a plan deviation.

**Plan acceptance criterion mismatch (documented, not fixed — out of this plan's scope).** The plan's Task 3 acceptance criteria state `grep -c "ModelProvider" src/consolidation/entity-resolution.ts` should return `0`. The live file (built in 64-02, unmodified by this plan) actually returns `2` — both occurrences are inside comments (`entity-resolution.ts:24` and `:145`) documenting the D-04 type-level guarantee in prose ("this module cannot call a provider... constructor MUST NOT accept a ModelProvider"), not an actual import, type reference, or usage. No `import type { ModelProvider }`, no constructor parameter, no runtime reference exists — the type-level guarantee itself holds exactly as designed; only the plan's literal grep count is stale against 64-02's already-shipped prose. Not modified here (64-02's file is out of this plan's `<files>` scope) — recorded as a discrepancy, not a defect.

**Pre-existing, out-of-scope test failures.** A full-suite `npx vitest run` (beyond the plan's own named verification set) surfaces 24 failures across the same 7 CLI-subprocess/timing-sensitive files flagged in 64-01/64-02 (`adapter-capture`, `adapter-inject`, `episodic-dryrun-gate`, `eval-harness-smoke`, `locomo-harness`, `locomo-latency-curve`, `locomo-scorer`), plus one intermittent `tests/viz-stats-routes.test.ts` failure under full-suite parallel execution that passes 14/14 in isolation (a clock/day-boundary flake, not a regression — this plan never touches viz routes or stats aggregation). None touch `consolidator.ts`'s resolution branch or `entity-resolution.ts`. Logged to `deferred-items.md` per the executor scope-boundary rule; not fixed. The plan's own required verification set (typecheck + the 9 named consolidation/intent/resolution test files, 118 tests) all pass green.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- `ClaimDecision.claimResolvedEntityId` / `claimResolvedEntityDescriptor` are threaded, all-or-nothing, and inert — Phase 65 (belief-gated status drift) is the first consumer.
- The `RESOLVE-64` log line gives Phase 65's DRIFT-05 honest-measurement pass real attempt/hit/abstain data to stand on.
- No blockers for Phase 65 or Phase 66.

## Self-Check: PASSED

- FOUND: tests/consolidation-resolution.test.ts
- FOUND: tests/resolution-sentinels.test.ts
- FOUND: commit 8d41b76 (Task 1)
- FOUND: commit 9767e58 (Task 2)
- FOUND: commit a1e2e67 (Task 3)

---
*Phase: 64-entity-resolution-hardening*
*Completed: 2026-08-02*
