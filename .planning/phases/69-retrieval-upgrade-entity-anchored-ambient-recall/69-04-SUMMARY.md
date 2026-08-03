---
phase: 69-retrieval-upgrade-entity-anchored-ambient-recall
plan: 04
subsystem: retrieval
tags: [retrieval, ambient-recall, rendering, token-budget, honest-trace, sqlite]

# Dependency graph
requires:
  - phase: 69-02
    provides: "retrieveRanked opts.hopCollector — the single-pass hop hand-off from buildHonestOneHopTrace, and opts.anchoredIds"
  - phase: 69-03
    provides: "cwd-aware ambientRecall selection/ordering (reserved-slot selection, ordering-only scope nudge) that this plan builds rendering on top of, and anchoredById for provenance"
provides:
  - "renderAmbientBlock — a pure, exported, budget-enforcing renderer (fact lines, doc title+link mode, hop lines) with two knob-gated modes"
  - "AMBIENT_BLOCK_CHAR_BUDGET — the enforced ~5-lines-x-200-chars ambient token budget, no longer just an assumption"
  - "Doc-type rows render as title + recense://doc/<raw id> under ambientDocLinkRenderEnabled, replacing wasted truncated-body injections (F4)"
  - "Injected facts carry up to 2 real 1-hop rel+neighbour lines under ambientHopInjectionEnabled, attributed to the correct seed, budget-bounded (D-06: facts win)"
  - "Anchored-fact provenance (69-03's entityValue) renders inline as ', via <entity>'"
affects: [69-06]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Two-pass budget accounting: all fact lines are built and their content length summed FIRST (facts always win, D-06), THEN hop lines are appended per-fact against the real post-facts running total — avoids the bug where an early hop 'gets lucky' ahead of a later maximal-length fact filling the budget"
    - "Budget counts data-driven content only (scope marker + value/title, hop label) — not fixed per-line decoration (origin/score parenthetical, bullet glyphs) — mirroring MAX_VALUE_CHARS's own cap-the-data-not-the-format framing"
    - "Pure renderer / impure caller split: renderAmbientBlock takes a RenderRow[] with every DB-derived field pre-resolved by ambientRecall (docSlug read only for doc rows, hop neighbour labels resolved via the existing node-row cache) — the renderer itself touches no store/db/clock"

key-files:
  created: []
  modified:
    - src/adapter/ambient-recall.ts
    - tests/ambient-recall.test.ts

key-decisions:
  - "Budget is measured over the data-driven portion of each line (marker+value/title for facts, label for hops), not the full decorated line string — fixed format overhead (parenthetical score/origin, bullet glyphs) is treated as constant, not counted against AMBIENT_K*MAX_VALUE_CHARS. This makes the D-06 'facts win, hops drop first' guarantee exact and testable without contradiction: 5 maximal-length facts consume exactly the budget, leaving genuinely zero room for any hop."
  - "Facts are accounted for as a GROUP before any hop is considered (two-pass: build all fact lines + sum their content length, then attach hops per-fact against that total) rather than interleaving fact-then-hop-then-fact one row at a time. The interleaved approach would let early hops slip in before a later maximal-length fact fills the budget, silently violating D-06's stated intent that a budget-binding set of facts drops ALL hops, not just the last row's."
  - "Doc title derivation is purely a function of row.value (first non-empty line, leading '#' run stripped, whitespace collapsed, capped at DOC_TITLE_CHARS=80) with fallback to docSlug then raw id when the value is empty — never fabricates a title."
  - "Both tasks committed together (source + tests) as a single feat commit rather than three separate task commits: the three tasks are a tight, single-file refactor sequence (extract renderer -> add doc mode -> add hop mode) where each incremental commit would have left the file in an intermediate, not-independently-meaningful state. Deviates from the usual one-task-one-commit cadence; documented here per the deviation-tracking discipline even though it isn't a Rule 1-4 case."

requirements-completed: [RECALL-02, RECALL-03]

# Metrics
duration: ~35min
completed: 2026-08-03
---

# Phase 69 Plan 04: Budget-Enforced Ambient Rendering — Doc Links + Hop Injection Summary

**Extracted the ambient injection loop into a pure, budget-bounded `renderAmbientBlock`; doc-type nodes now render as title + `recense://doc/<id>` instead of a wasted truncated body, and each fact carries up to 2 real 1-hop relations the engine already computed — all inert at dark defaults.**

## Performance

- **Duration:** ~35 min
- **Tasks:** 3
- **Files modified:** 2

## Accomplishments
- `renderAmbientBlock(rows, opts)` is now an exported, pure function — every DB-derived field arrives pre-resolved on `RenderRow[]`; the function itself contains zero `store.`/`db.`/`clock.`/`Date.now` references (grep-verified and unit-tested against the actual function source).
- `AMBIENT_BLOCK_CHAR_BUDGET = AMBIENT_K * MAX_VALUE_CHARS` (1000) is now an enforced constant rather than an assumption. Budget accounting is a two-pass design: all fact lines render and their content length sums first (D-06: facts ALWAYS win), then hop lines are appended beneath their own fact only while the real post-facts running total leaves room — the first hop that would breach stops all further hop appending across the whole block, never a per-fact reset.
- Doc-type rows render as `<title> — recense://doc/<raw id> (doc, score X.XX)` under `ambientDocLinkRenderEnabled`, with the title derived purely from the value's first non-empty line (heading marker stripped, capped at 80 chars) — replacing F4's measured waste (a 200-char truncated hub-doc preamble with zero actionable content). `getNodeDoc` is read only for doc-type rows. With the knob dark, doc rows render byte-identical to pre-phase.
- `ambientRecall` threads a `hopCollector` into `retrieveRanked` only when `ambientHopInjectionEnabled` is true, groups the collected hops by their real `src` seed, keeps only hops whose src is a SELECTED row, resolves each neighbour's label via the existing node-row cache (no second edge-read pass — reuses 69-02's single-pass hand-off), drops hops whose neighbour is missing/tombstoned rather than rendering a placeholder, caps at 2 hop lines per fact, and renders `  ↳ <rel> <label>` with no score (hop scores are always `null`, WR-02 — printing a number would fabricate a magnitude).
- Anchored-fact provenance (69-03's `AnchoredFact.entityValue`, carried via `anchoredById`) now renders inline as `, via <entity>` inside the existing parenthetical, making a floor-exempt injected line visibly attributable.
- Verified end to end: `activation_trace` rows (seeds + hops JSON) are byte-identical whether `ambientHopInjectionEnabled` is on or off — the viz sink keeps receiving exactly what it received pre-phase (D-06).
- With both render knobs dark, the block is byte-identical to 69-03's output — the pre-existing `f.` byte-identity test continues to pass unmodified.

## Task Commits

Tasks 1–3 (extract pure renderer, doc-link rendering, hop injection) were implemented and tested as a tight sequence within the same two files and committed together — see the "Deviations" note below for why this departs from strict one-task-one-commit:

1. **Tasks 1–3: pure budget-enforcing renderer, doc-link rendering, hop injection** - `3a218ae` (feat)
2. **Deferred-items confirmation (pre-existing dist/-dependent failures unrelated)** - `149486a` (docs)

**Plan metadata:** commit pending (this SUMMARY + STATE/ROADMAP, owned by the orchestrator)

## Files Created/Modified
- `src/adapter/ambient-recall.ts` — new exports `RenderRow`, `renderAmbientBlock`, `AMBIENT_BLOCK_CHAR_BUDGET`; new private constants `DOC_TITLE_CHARS`, `MAX_HOP_LINES_PER_FACT`, `HOP_LABEL_CHARS`; `deriveDocTitle` helper; `ambientRecall`'s final render loop replaced by RenderRow construction + `renderAmbientBlock` call; `hopCollector` wired into the `retrieveRanked` opts when the knob is on
- `tests/ambient-recall.test.ts` — 9 new `renderAmbientBlock` unit cases (`m.`–`u.`: byte-identity, AMBIENT_K cap, purity, budget/hop-drop-first, hops-render-when-room, doc-link on/off, docLinks-doesn't-affect-non-doc-rows, anchored-via) plus 4 new end-to-end `ambientRecall` cases (doc-link wiring on/off, hop attribution + no-fabricated-score, tombstoned-neighbour hop dropped, `activation_trace` shape unaffected by the hop knob)

## Rendered Line Grammar (for 69-06's eval gate)

```
Fact (default):
- [scope-marker]<value up to 200 chars> (<origin>, score X.XX[, via <entity>])

Fact (doc mode, type==='doc' AND ambientDocLinkRenderEnabled):
- [scope-marker]<title up to 80 chars> — recense://doc/<raw id> (doc, score X.XX[, via <entity>])

Hop (ambientHopInjectionEnabled, up to 2 per fact, rendered directly beneath its fact):
  ↳ <rel> <neighbour label up to 60 chars>
```
`[scope-marker]` is `[<scope>] ` when the row's scope is non-global, else absent — unchanged from pre-phase. `, via <entity>` is present only when the row was floor-exempt anchored (69-03). Hop lines never carry a score.

## Decisions Made
- Budget-counting scope (data content only, not decoration) and the two-pass fact-then-hop accounting order — see `key-decisions` in the frontmatter for full rationale.
- Single combined commit for all three tasks — see `key-decisions` and the Deviations section.

## Deviations from Plan

### Process deviation (not a Rule 1–4 case, documented for transparency)

**1. Tasks 1–3 committed together instead of one commit per task**
- **Found during:** Task 2 (doc-link rendering directly extends Task 1's renderer signature; Task 3's hop wiring directly extends both)
- **Reasoning:** All three tasks touch the same two files in a tightly sequential refactor (extract pure renderer → add doc mode to that same function → add hop wiring that populates the same RenderRow shape). Committing after Task 1 alone would have shipped a renderer with `docLinks`/hop fields on the interface but no caller ever populating them; splitting further would not have produced independently meaningful, buildable intermediate states without either reverting/redoing work or leaving dead code between commits. Combined into one `feat` commit covering all three tasks' behavior, verified together (typecheck clean, 34/34 relevant tests passing).
- **Files modified:** `src/adapter/ambient-recall.ts`, `tests/ambient-recall.test.ts`
- **Verification:** `npm run typecheck` clean; `npx vitest run tests/ambient-recall.test.ts tests/honest-trace.test.ts` — 34/34 pass; full suite shows only the 8 pre-existing dist/-dependent files failing (unrelated, documented below).
- **Committed in:** `3a218ae`

### Implementation-discretion note (not a deviation from stated behavior, but worth flagging explicitly)

Task 1's `<behavior>` Test 2 describes the budget invariant as holding "for any input including 5 maximal 200-char values plus hops." Read literally against the FULL rendered line length (including the fixed `(origin, score X.XX)` decoration), this is mathematically unsatisfiable at `AMBIENT_BLOCK_CHAR_BUDGET = AMBIENT_K * MAX_VALUE_CHARS` — 5 decorated maximal lines alone exceed 1000 characters by the length of 5 parentheticals, and D-06 explicitly requires facts to render regardless. The implementation therefore measures the budget over the DATA-DRIVEN content only (value/title, hop label) — the actual attacker/data-controlled part MAX_VALUE_CHARS itself was already framed as capping — documented inline at `AMBIENT_BLOCK_CHAR_BUDGET`'s doc comment and exercised by test `p.` (5 maximal facts → zero hop lines added, all 5 facts still render). This is a Claude's-Discretion resolution of an internal tension in the plan's prose, not a scope or correctness deviation — the threat model's actual concern (T-69-04-BUDGET: an unbounded block is a cost/attention DoS) is fully addressed since the counted, budget-relevant content is hard-capped.

---

**Total deviations:** 1 process deviation (commit granularity), 1 implementation-discretion note (budget-counting scope)
**Impact on plan:** No scope change; all stated behaviors (facts win, hops drop first when budget binds, doc title+link, hop attribution, anchored provenance, dark-default byte-identity) are implemented and test-locked.

## Issues Encountered
- Same 24 pre-existing test failures across the same 8 files (`tests/adapter-capture.test.ts`, `tests/adapter-inject.test.ts`, `tests/drift-05-harness-smoke.test.ts`, `tests/episodic-dryrun-gate.test.ts`, `tests/eval-harness-smoke.test.ts`, `tests/locomo-harness.test.ts`, `tests/locomo-latency-curve.test.ts`, `tests/locomo-scorer.test.ts`) already logged from 69-01/69-02/69-03 — the recurring dist/-dependent environment gap (this worktree has no `dist/`; all 8 files spawn a compiled CLI). None reference `src/adapter/ambient-recall.ts`. Not fixed here, per the Scope Boundary rule; appended a short confirming note to `deferred-items.md`.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- The injected block's rendering grammar (fact / doc / hop line shapes, documented above) is stable for 69-06's eval gate to parse.
- All new behavior remains dark (`ambientDocLinkRenderEnabled:false`, `ambientHopInjectionEnabled:false`) until 69-06's eval gate passes (D-09) — no live behavior change ships in this plan.
- No blockers for 69-06.

## Self-Check: PASSED

All modified files confirmed present on disk; both commit hashes (`3a218ae`, `149486a`) confirmed present in `git log --oneline --all`.

---
*Phase: 69-retrieval-upgrade-entity-anchored-ambient-recall*
*Completed: 2026-08-03*
