---
phase: 66-domain-neutral-proposal-emit-seam
plan: 02
subsystem: consolidation
tags: [sink-pattern, deterministic-hash, dark-knob, action-proposal]

# Dependency graph
requires:
  - phase: 66-01
    provides: "action_proposal table (schema v17), ActionProposalStore, ACTION_PROPOSAL_FIELDS, PROPOSAL_TTL_MS"
provides:
  - "src/consolidation/action-proposal-sink.ts: ActionProposalSink interface, NoopActionProposalSink, SQLiteActionProposalSink, MockActionProposalSink, ActionProposalInput, proposalId(), BELIEF_CHANGE_FIELD_STATUS"
  - "src/lib/config.ts: actionProposalSinkEnabled dark knob (default false)"
affects: ["66-03 (consolidator wiring)", "66-04", "66-05", "67-reference-consumer-adapter"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Content-hash deterministic id via sha256(JSON.stringify([...])) over 5 keyed fields — replaces newId()/UUID for this one record type (D-07)"
    - "Sink triad copy-adapt: interface + Noop default + SQLite impl + Mock test helper, mirroring ConsolidationSink verbatim"
    - "Dark-knob convention: defaults OFF with explicit Reversibility: line, two independent Noop barriers (knob + constructor default)"

key-files:
  created:
    - src/consolidation/action-proposal-sink.ts
    - tests/action-proposal-sink.test.ts
  modified:
    - src/lib/config.ts

key-decisions:
  - "proposalId() takes no timestamp parameter at all (not just 'ignores' one) — the Pick type excludes belief_node_id/evidence_quote/confidence/entity_descriptor/timestamps entirely, making insensitivity structural rather than a runtime discipline"
  - "sha256(JSON.stringify([...])) written as a single-line array literal (not multi-line) so the plan's own grep acceptance gate (`sha256(JSON.stringify(\\[`) matches — doc comments were also reworded to avoid the literal substrings 'newId()' and 'await' that the plan's grep gates check for zero occurrences of"

requirements-completed: [EMIT-01, EMIT-04, EMIT-06]

# Metrics
duration: 25min
completed: 2026-08-03
---

# Phase 66 Plan 02: ActionProposalSink Triad + Deterministic proposalId() + Dark Knob Summary

**Copy-adapted the shipped `ConsolidationSink` triad into `ActionProposalSink` with one deliberate deviation — a `sha256`-content-hash id instead of `newId()` — plus the `actionProposalSinkEnabled` dark knob that will decide whether the live sleep pass gets the SQLite sink or the Noop.**

## Performance

- **Duration:** ~25 min
- **Completed:** 2026-08-03
- **Tasks:** 2
- **Files modified:** 3 (2 created, 1 modified)

## Accomplishments

- `src/consolidation/action-proposal-sink.ts` ships the full triad: `ActionProposalSink` interface, `SQLiteActionProposalSink` (mints `id = proposalId(...)`, `schema_version`, `status = 'pending'`, `created_at === updated_at === clock.nowMs()`, `expires_at = created_at + PROPOSAL_TTL_MS`), `NoopActionProposalSink` (empty body, verbatim copy of `NoopConsolidationSink`'s doc comment), `MockActionProposalSink` (public `proposals` array + `reset()`).
- `proposalId()` is a pure function over exactly five keyed fields (`entity_node_id`, `change_field`, `change_from`, `change_to`, `evidence_episode`), serialized via a locked `sha256(JSON.stringify([...]))` array encoding. Its `Pick<...>` type signature structurally excludes `belief_node_id`, `evidence_quote`, `confidence`, `entity_descriptor`, and any timestamp — insensitivity to those fields isn't a runtime check, it's unrepresentable in the type.
- `BELIEF_CHANGE_FIELD_STATUS = 'status'` exported with a doc comment explaining why this is not a Pitfall-10 consumer-schema leak.
- `tests/action-proposal-sink.test.ts` — 16 test cases covering every `<behavior>` bullet: determinism across repeated calls, 64-char lowercase-hex id shape, sensitivity to each of the five keyed fields individually, `null` vs `''` for `change_from` producing different ids, insensitivity to `belief_node_id`/`evidence_quote`/`confidence`/`entity_descriptor`, Noop writing nothing, SQLite sink stamping the four minted fields correctly, byte-identical `evidence_quote` round-trip with an injection-shaped payload (newlines, angle brackets, quotes, café/☕ non-ASCII), and EMIT-04's replay collapse (same input emitted twice → exactly one row).
- `actionProposalSinkEnabled: boolean` added to `EngineConfig`, defaulting `false` in `DEFAULT_CONFIG`, documented in the shipped dark-knob JSDoc style with an explicit `Reversibility:` line — the Consolidator's constructor default (`NoopActionProposalSink`, wired in 66-03) is the second independent Noop barrier.

## Task Commits

1. **Task 1: ActionProposalSink triad + deterministic proposalId()** - `00644eb` (feat)
2. **Task 2: actionProposalSinkEnabled dark knob** - `b4b3699` (feat)

## Files Created/Modified

- `src/consolidation/action-proposal-sink.ts` - `ActionProposalSink`, `NoopActionProposalSink`, `SQLiteActionProposalSink`, `MockActionProposalSink`, `ActionProposalInput`, `proposalId()`, `BELIEF_CHANGE_FIELD_STATUS`
- `tests/action-proposal-sink.test.ts` - 16 test cases (proposalId determinism/sensitivity, Noop no-write, Mock capture, SQLite minted-field correctness, verbatim evidence_quote, EMIT-04 replay collapse)
- `src/lib/config.ts` - `actionProposalSinkEnabled: boolean` on `EngineConfig` (placed adjacent to the Phase 65 v10.0 knobs, after `statusDriftEventTsGuard`), `actionProposalSinkEnabled: false` in `DEFAULT_CONFIG`

## Decisions Made

- Followed the plan's `<action>` instructions verbatim: interface/Noop/Mock copied structurally from `ConsolidationSink`'s trio; `SQLiteActionProposalSink` is the one deliberate deviation (deterministic hash id, not `newId()`).
- Two doc-comment wordings were adjusted from an initial draft to satisfy the plan's own literal-substring grep acceptance gates: a comment mentioning `newId()` (in prose, explaining why `belief_node_id` is excluded from the hash) was reworded to "a random UUID" so `grep -c 'newId()'` returns 0; a comment mentioning "async/await" was reworded to "async, no promises" so `grep -c 'await'` returns 0. Neither change altered the code's actual behavior or meaning — purely comment wording to keep the acceptance-criteria greps honest measures of the *code*, not comment prose.
- `sha256(JSON.stringify([...]))` is written as a single-statement call (not split across `sha256(\n  JSON.stringify([` lines) specifically so the plan's `grep -c "sha256(JSON.stringify(\[" `gate matches — this is cosmetic formatting, not a functional choice.

## Deviations from Plan

None beyond the two comment-wording adjustments documented above (made during Task 1's own acceptance-criteria verification, before commit — not a post-hoc fix).

## Issues Encountered

- `npx vitest run` (full suite) initially showed 24 failures across `tests/adapter-capture.test.ts`, `tests/adapter-inject.test.ts`, `tests/drift-05-harness-smoke.test.ts`, `tests/episodic-dryrun-gate.test.ts`, `tests/eval-harness-smoke.test.ts`, `tests/locomo-harness.test.ts`, `tests/locomo-latency-curve.test.ts`, `tests/locomo-scorer.test.ts` — all of these spawn a compiled CLI from `dist/`, which did not exist in this fresh worktree (no `npm run build` had run). This is an environment-setup gap, not caused by either of this plan's two tasks (a new isolated module + a config addition touch neither the CLI build pipeline nor those test files). Ran `npm run build` (gitignored `dist/`, nothing committed) to restore a buildable state, then re-ran the full suite: **3745 passed / 6 expected fail / 4 skipped, zero unexpected failures** — confirming no new regressions from this plan's changes.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

`ActionProposalSink`/`NoopActionProposalSink`/`SQLiteActionProposalSink`/`MockActionProposalSink`, `proposalId()`, and `actionProposalSinkEnabled` are ready for 66-03 (wiring the sink into `Consolidator`'s constructor and `applyDecision`'s decisive branches, gated on `isEmissionEligible` from Phase 65). No blockers.

## Self-Check: PASSED

- FOUND: src/consolidation/action-proposal-sink.ts
- FOUND: tests/action-proposal-sink.test.ts
- FOUND: src/lib/config.ts (actionProposalSinkEnabled present)
- FOUND: .planning/phases/66-domain-neutral-proposal-emit-seam/66-02-SUMMARY.md
- FOUND: 00644eb, b4b3699 (both task commits present in git log)

---
*Phase: 66-domain-neutral-proposal-emit-seam*
*Completed: 2026-08-03*
