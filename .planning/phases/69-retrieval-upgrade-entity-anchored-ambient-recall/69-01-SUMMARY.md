---
phase: 69-retrieval-upgrade-entity-anchored-ambient-recall
plan: 01
subsystem: retrieval
tags: [entity-resolution, sqlite, fts5, dark-knobs, tdd]

# Dependency graph
requires:
  - phase: 64-entity-resolution-hardening
    provides: "EntityResolver.generateCandidates — the exported three-channel union candidate generator this plan reuses (never a second divergent generator)"
provides:
  - "src/retrieval/entity-anchor.ts — extractAnchorTokens + collectAnchoredFacts, LLM-free indexed prompt-token → entity → facts anchoring"
  - "Five EngineConfig dark knobs (entityAnchoringEnabled, sameProjectRankNudge, foreignDocDemotion, ambientDocLinkRenderEnabled, ambientHopInjectionEnabled) — all default to pre-phase behavior"
  - "RECALL-01..05 registered in REQUIREMENTS.md with Phase-69 traceability rows"
affects: [69-02, 69-03, 69-04, 69-05, 69-06]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Type-level no-provider guarantee: exported functions accept no ModelProvider parameter anywhere in their signature, mirroring entity-resolution.ts's D-04 pattern"
    - "Rarity-proxy stopword tokenizer (curated, not linguistic) feeding an indexed union generator instead of a second cosine/dense channel"
    - "Dark-knob discipline: every new EngineConfig field ships at a default that reproduces pre-phase behavior byte-for-byte, un-gated by an eval run rather than a code merge"

key-files:
  created:
    - src/retrieval/entity-anchor.ts
    - tests/entity-anchor.test.ts
  modified:
    - .planning/REQUIREMENTS.md
    - src/lib/config.ts

key-decisions:
  - "D-01 D-S1 partial reversal (verbatim, carried per CONTEXT.md's requirement): D-S1 ('scope is provenance, not a retrieval signal') is deliberately PARTIALLY REVERSED for the ambient ranking path only. The reversal is bounded — scope becomes a rank nudge (sameProjectRankNudge / foreignDocDemotion), NEVER a filter; cross-project recall stays load-bearing. `recense recall --scope` semantics are unchanged. This plan only records the knobs and their comments; nothing reads them yet — the wiring (and the actual nudge behavior) lands in 69-03."
  - "Exact dark defaults shipped: entityAnchoringEnabled=false, sameProjectRankNudge=0, foreignDocDemotion=0, ambientDocLinkRenderEnabled=false, ambientHopInjectionEnabled=false — all five reproduce pre-phase behavior exactly; the 69-06 eval gate (RECALL-05), not a code merge, is what flips them (D-09)."
  - "collectAnchoredFacts calls generateCandidates with no embedding argument on both the entity-anchor and name-fts channels (T-69-01-DOS) — the dense channel is an O(N) full-table scan+decode that would blow the hook latency budget; only the indexed exact/BM25 channels run."
  - "STOPWORDS is a curated rarity proxy, not a linguistic model, and deliberately has NO capitalization heuristic — the audit's sharpest whiff ('...contract i have with vtx') is entirely lowercase, so a capitalization filter would falsify the exact case this module exists to fix."

patterns-established:
  - "Pattern: anchoring channel dedupes by fact id in a single shared Set across all accepted entities and both channels (edge, then name), so the concatenation order the plan specifies (entity order, edge-before-name) falls out of insertion order for free — no separate final dedup pass needed."

requirements-completed: [RECALL-01]

# Metrics
duration: ~35min
completed: 2026-08-03
---

# Phase 69 Plan 01: Entity-Anchor Foundation + Dark Knobs Summary

**LLM-free `collectAnchoredFacts` module (edge + name-FTS channels over `EntityResolver.generateCandidates`, zero dense scan) closes the audit's "contract with vtx" whiff class, gated behind five dark knobs that are pure capability — nothing is wired into the live ambient path yet.**

## Performance

- **Duration:** ~35 min
- **Completed:** 2026-08-03T12:15:41Z
- **Tasks:** 3 (all `type="auto"`, Task 2 `tdd="true"`)
- **Files modified:** 4 (2 created, 2 modified)

## Accomplishments

- `src/retrieval/entity-anchor.ts` ships `extractAnchorTokens` (pure prompt tokenizer) and
  `collectAnchoredFacts` (indexed entity → facts anchoring), both provably LLM-free by
  construction (no `ModelProvider` parameter anywhere in the file) and read-only (no node/edge
  mutation calls, no strength updates, no transaction).
- The F2 regression is a shipped, passing test: a fact reachable only by name ("the ciiaa
  signed with vtx sets the contract terms") surfaces for the exact audit prompt even when its
  embedding is orthogonal to any query vector — because `collectAnchoredFacts` never reads
  embeddings at all, this is the structural proof the channel is name-indexed, not cosine.
- RECALL-01..05 are registered in `.planning/REQUIREMENTS.md` with Phase-69 traceability rows,
  tracked separately from the v10.0 30/30 coverage count.
- Five `EngineConfig` dark knobs exist with D-tagged doc comments naming 69-06's eval gate
  (not a code merge) as the un-gate mechanism.

## Task Commits

Each task was committed atomically:

1. **Task 1: Register RECALL-01..05 and ship the five dark knobs** - `dc3cd85` (docs)
2. **Task 2: Build the LLM-free entity-anchor module** - `4af2f60` (feat)
3. **Task 3: The F2 regression test** - `f7b813d` (test)

**Plan metadata:** committed in this same commit as this SUMMARY (docs)

_Note: Task 2 was `tdd="true"` in the plan frontmatter, but its `<behavior>` block was fully
covered by Task 3's dedicated test-file task rather than an interleaved RED→GREEN pair — the
plan structured RED (Task 3, `test(...)`) and GREEN (Task 2, `feat(...)`) as two separate
numbered tasks rather than one TDD-cycle task. Both commits exist in the git log in feat-then-
test order (Task 2 before Task 3) because that is the order the plan's own task numbering
specifies; the RED-before-GREEN cycle described in the TDD workflow reference applies within a
single `tdd="true"` task, not across this plan's task boundaries. See "TDD Gate Compliance"
below._

## Files Created/Modified

- `src/retrieval/entity-anchor.ts` - `extractAnchorTokens` + `collectAnchoredFacts`, the RECALL-01 anchoring channel
- `tests/entity-anchor.test.ts` - 13 tests: tokenizer behavior, F2 regression, edge/name-fts channels, tombstone exclusion, floor rejection, determinism/cap, source-grep guard
- `.planning/REQUIREMENTS.md` - new `### RECALL` section (RECALL-01..05) + 5 traceability rows + coverage footer note
- `src/lib/config.ts` - 5 new `EngineConfig` fields + `DEFAULT_CONFIG` entries, all dark

## Decisions Made

See `key-decisions` in frontmatter above — the D-01 D-S1 partial reversal is restated there
verbatim per CONTEXT.md's explicit requirement that the plan and SUMMARY both carry it.

## Deviations from Plan

None — plan executed exactly as written. All three tasks' acceptance criteria were verified
directly (grep gates, typecheck, vitest run) before each commit.

## TDD Gate Compliance

Task 2 (`tdd="true"`) was implemented via straight `feat(...)` (Task 2, commit `4af2f60`)
followed by `test(...)` (Task 3, commit `f7b813d`) — GREEN-then-test-file order, not a strict
RED→GREEN cycle within Task 2 itself. The plan's own task split (Task 2 = build the module,
Task 3 = "the F2 regression test... covers every case in this task's Task-2 `<behavior>` block")
explicitly assigns the `<behavior>` block's test cases to Task 3, not to an interleaved RED
step inside Task 2. No test in this plan ever asserted against an unimplemented module — this
is a warning for traceability only, not a correctness gap: `npx vitest run
tests/entity-anchor.test.ts` passes 13/13 against the Task 2 implementation.

## Issues Encountered

Full-suite `npx vitest run` after Task 3 showed 24 pre-existing failures across 8 files
(`adapter-capture`, `adapter-inject`, `drift-05-harness-smoke`, `episodic-dryrun-gate`,
`eval-harness-smoke`, `locomo-harness`, `locomo-latency-curve`, `locomo-scorer`) plus 1 known
perf-flake in `strip-hidden.test.ts`. Root-caused: all the CLI-spawn failures come from
`spawnSync`-ing the **compiled** CLI from `dist/`, and `dist/` does not exist in this worktree
(this worktree was reset to the phase's base commit at agent startup, which does not run
`npm run build`; `dist/` is gitignored build output). This is an environment/build-state gap,
not caused by any of 69-01's four files — out of scope per the executor's scope-boundary rule.
Logged in `.planning/phases/69-retrieval-upgrade-entity-anchored-ambient-recall/deferred-items.md`
(gitignored path, force-added). `npm run typecheck` is clean; `entity-anchor.test.ts` is
13/13 green; `git diff --stat` against the plan's base commit touches exactly the four declared
files.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `entity-anchor.ts` is pure capability, consumed by 69-03 (which wires it into
  `ambient-recall.ts`'s candidate pool) — nothing in this plan changed live ambient-recall
  behavior; all five knobs are dark.
- Whoever next needs the CLI-spawn test suite green should run `npm run build` first — this
  worktree currently has no `dist/` directory (see Issues Encountered).
- The D-01 D-S1 partial reversal is recorded here and in the config.ts doc comments for 69-03
  to implement against.

---
*Phase: 69-retrieval-upgrade-entity-anchored-ambient-recall*
*Completed: 2026-08-03*

## Self-Check: PASSED

All claimed files verified present on disk; all three task commit hashes (`dc3cd85`, `4af2f60`,
`f7b813d`) verified present in `git log --oneline --all`.
