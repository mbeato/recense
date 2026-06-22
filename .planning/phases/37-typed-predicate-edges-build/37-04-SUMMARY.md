---
phase: 37-typed-predicate-edges-build
plan: 04
subsystem: testing
tags: [eval-harness, typed-edges, precision-gate, nodes-to-answer, payload-size, claude-headless]

# Dependency graph
requires:
  - phase: 37-02
    provides: folded typed-triple extraction (typed `relation` edges minted offline)
  - phase: 37-03
    provides: live typedReach / typed-path recall the harness measures
provides:
  - "37-precision-harness.cjs — deterministic NTA/top-3 + payload-size + 3x-majority compose gate"
  - "queries-37.json — 24-query, 2-per-predicate, founder-signed single-hop set (D-05)"
  - "live precision gate result: typed top-3 83.3% / lift +45.8pts / payload 3.8 vs 20 nodes (GO)"
affects: [phase-40-bench, phase-42-cost, typed-recall-default]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "value->id resolution at the harness boundary: query sets store human-readable node VALUES (founder-signable); the harness resolves them to live UUIDs and scores golds by value (entity-fragmentation-safe)"
    - "PRIMARY deterministic metric is the merge gate; LLM-compose labeled SECONDARY/confirmation-only, never gates (Pitfall 5 / D-04)"

key-files:
  created:
    - scripts/eval/derive-queries-37.cjs
    - _extract37.ts
  modified:
    - scripts/eval/37-precision-harness.cjs
    - scripts/eval/queries-37.json

key-decisions:
  - "Re-derived the query set from post-fix live-extracted typed edges (4,619 relation edges in /tmp/scratch-live-37.db) rather than signing off the pre-fix set committed last night"
  - "Score golds by VALUE, not id — harness resolves anchor value -> all matching node ids (union) and ranks the first returned id whose value matches the gold; survives the UUID-keyed live DB and entity fragmentation"
  - "Founder signed off all 24 queries as-is (D-05); flagged q02/q22/q24 reviewed and kept"
  - "GO on the PRIMARY deterministic gate (D-04): typed top-3 83.3% >= 75% AND lift +45.8pts >= +20pts"

patterns-established:
  - "Harness anchor/gold are node values; id plumbing lives in the harness (resolveIds + rankOfValue), keeping the query set human-readable and interview-defensible"

requirements-completed: [TYPED-02]

# Metrics
duration: ~1h (interactive completion session)
completed: 2026-06-21
---

# Phase 37 Plan 04: Precision Gate Summary

**Live typed-recall precision gate cleared GO — deterministic answer-in-top-3 83.3% vs 37.5% untyped (+45.8pts), payload 3.8 vs 20 nodes (−81% token win), on a founder-signed 24-query set.**

## Performance

- **Duration:** ~1h interactive (original harness+queries committed 2026-06-21 00:28; completed via interactive resume session)
- **Completed:** 2026-06-22T00:03Z (gate run)
- **Tasks:** 5 (T1 build, T2 derive, T3 sign-off, T4 gate, T5 GO/NO-GO)
- **Files modified:** 4 (2 modified, 2 new helpers)

## Accomplishments

- **Live PRIMARY gate (D-04) — GO:** typed answer-in-top-3 **83.3%** (≥75%) AND lift **+45.8pts** (≥+20). Rank-1: 54.2% typed vs 12.5% untyped. Mean NTA 2.5 vs 9.6.
- **Token win:** typed payload mean **3.8 nodes** vs neighborhood K=20 — ~81% fewer nodes-to-answer, interview-defensible (no-inflated-metrics).
- **SECONDARY compose (confirmation only, 3× majority, never the gate):** typed 98.6% vs untyped 34.7% (+63.9pts) — independently confirms.
- **Beats the spike anchor** (+29.5pts deterministic / +22.8pts compose) on the live engine.
- **Founder-signed query set (D-05):** 24 queries, 2 per predicate across all 12, golds re-derived from live edges.

## Task Commits

1. **Task 1: build 37-precision-harness** — `b126e18` (feat) + harness value↔id fix (this closeout commit)
2. **Task 2: derive queries-37.json** — `c590caa` (feat) + regeneration from post-fix live edges (this closeout commit)
3. **Task 3: founder sign-off (D-05)** — checkpoint, **approved as-is**; stamped in `queries-37.json` `_meta.founder_signoff`
4. **Task 4: run the gate** — results at `scripts/eval/results/37-precision-LATEST.json` (gitignored; numbers recorded here)
5. **Task 5: GO/NO-GO (D-04)** — checkpoint, **GO — gate cleared**

## Files Created/Modified

- `scripts/eval/37-precision-harness.cjs` — deterministic NTA/top-3 + payload + secondary compose harness; fixed to resolve query values → live node ids
- `scripts/eval/queries-37.json` — regenerated 24-query founder-signed set + sign-off stamp
- `scripts/eval/derive-queries-37.cjs` — re-derives the predicate-balanced query set from live typed edges (D-05 reproducibility)
- `_extract37.ts` — extraction-only typed-edge minter that populated the live scratch DB (D-08-faithful: judge-skipped, edges byte-identical to the full pipeline)

## Decisions Made

- **Re-derive over reuse:** the query set committed last night predated today's two extraction fixes (fence + resolver); re-derived from the post-fix live edges before sign-off rather than signing a stale set.
- **Value-based scoring:** the committed harness keyed traversal and gold-rank on the anchor/gold *string* (a spike-DB convention where node id == lowercased value). Against the UUID-keyed live DB this zeroed both arms. Fixed by resolving anchor value → all matching node ids and ranking the gold by value-of-returned-id — keeps the query set human-readable/founder-signable while plumbing ids inside the harness.

## Deviations from Plan

### Auto-fixed Issues

**1. [Correctness — Blocking] Harness value↔id resolution broken on the live DB**
- **Found during:** Task 4 prep (dry-run against `/tmp/scratch-live-37.db`)
- **Issue:** `typedReach`/`untypedTopK`/`rankOf` treated the query `anchor`/`gold` *values* as node ids. Works on the spike scratch.db (ids == lowercased values) but returns **zero reach for every query** on the UUID-keyed live DB — the gate would have been meaningless (both arms 0%).
- **Fix:** added `resolveIds(value)` (value → all matching node ids, union; falls back to the normalized value for the spike DB) and `rankOfValue(ids, goldValue)` (rank by first returned id whose value matches the gold); generalized both traversal arms and both payload builders to seed on an anchor-id set.
- **Files modified:** `scripts/eval/37-precision-harness.cjs`
- **Verification:** dry-run reach went 0/24 → non-zero on all 24 (matches derive frontiers, e.g. Max/works_on → 12); `--no-compose` PRIMARY run reproduces the gate; metric semantics (NTA/top-3/payload/compose) unchanged.
- **Committed in:** this closeout commit

---

**Total deviations:** 1 auto-fixed (1 blocking correctness). Plus the founder-directed re-derivation of the query set (resume decision, not a defect).
**Impact on plan:** the fix was load-bearing — without it the gate produces all-zeros on the live DB. No metric-design change; no scope creep.

## Issues Encountered

- **Resume anomaly:** 37-04 had production commits (harness + queries) but no SUMMARY, and STATE.md had rolled forward to Phase 39 — the safe-resume gate fired. Resolved interactively with founder: re-derive query set, fix harness, run gate, GO.
- **Gate runtime:** the SECONDARY compose is 144 sequential headless-Haiku calls (~694s). Subscription-billed; marginal $ ~0 but real token usage.

## User Setup Required

None — no external service configuration. The gate run used `RECENSE_MODEL_PROVIDER=claude-headless` (founder's Max subscription) against a copy of the live DB; the live `recense.db` was never mutated (read-only harness).

## Next Phase Readiness

- TYPED-02 proven on the live engine — typed recall ready to promote as default; `RECENSE_TYPED_EXTRACTION_MODE` remains the documented revert.
- Reproduce: `node scripts/eval/37-precision-harness.cjs --db /tmp/scratch-live-37.db [--no-compose]` (re-derive edges via `_extract37.ts` + `derive-queries-37.cjs` if the scratch DB is gone).
- Phase 37 complete (37-01 → 37-04 all done). Feeds Phase 40 (benchmark baseline) and Phase 42 (cost/token efficiency).

---
*Phase: 37-typed-predicate-edges-build*
*Completed: 2026-06-21*
