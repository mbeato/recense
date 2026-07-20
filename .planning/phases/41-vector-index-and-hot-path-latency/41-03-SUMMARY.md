---
phase: 41-vector-index-and-hot-path-latency
plan: 03
subsystem: retrieval
tags: [vector-index, latency, perf, equivalence, gate, cold-path, sidecar, benchmark]

# Dependency graph
requires:
  - phase: 41-02
    provides: "Persisted exact vector index (.vindex sidecar) behind CandidateRetriever.topk; built end-of-sleep-pass; read by 3 cold callers"
  - phase: 40
    provides: "Committed v7.0 baseline (warm 45/46 ms; LOCOMO J 86.0% / R@5 77.3%; KU w=0 77.8%) — the PERF-02/03 anchor"
provides:
  - "PERF-03(a): direct top-k equivalence gate — indexed topk byte-identical to brute-force cosineSimF32 (40/40, max|Δscore|=0)"
  - "PERF-02: live-brain latency delta vs baseline — warm 13/14 ms (~3.4×), cold 72/77 ms (−24/−22 ms vs same-run brute)"
  - "41-PERF-REPORT.md: honest gate verdicts + soft latency targets set after the numbers (D-08)"
  - "scripts/eval/41-topk-equivalence.cjs + 41-latency-after.cjs (read-only live-brain gate scripts)"
affects: ["43 (eval regression gates — these scripts + soft targets feed the CI sentinel)"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Read-only live-brain gate scripts: open DB readonly:true,fileMustExist:true; assert sidecar present before measuring (else vacuous self-comparison / brute-force fallback)"
    - "Cold latency via subprocess-per-query reading the persisted sidecar (the real session-start/recall path), NOT a from-scratch rebuild — isolates the D-06 persisted cold win"
    - "Embed-isolated mock-vector measurement so embed-network jitter does not swamp the index delta (spike methodology reused)"
    - "Boundary-tie equivalence allowance (D-10) — never exercised because the index is byte-exact"

key-files:
  created:
    - "scripts/eval/41-topk-equivalence.cjs"
    - "scripts/eval/41-latency-after.cjs"
    - ".planning/phases/41-vector-index-and-hot-path-latency/41-PERF-REPORT.md"
  modified: []

key-decisions:
  - "PERF-03 proven by construction via byte-exact top-k equivalence (max|Δscore|=0, mock + real embed) — the load-bearing accuracy proof; harness re-run is corroboration of an already-identical result"
  - "Cold measured by reading the PERSISTED sidecar (real cold path) not the spike's from-scratch build — this is what flipped the spike's ~20 ms-slower from-scratch cold into a ~24 ms-faster persisted cold (D-06 confirmed)"
  - "Soft targets set AFTER the numbers (D-08): warm ≤15 ms p95, cold ≤80 ms p95 wall (embed-isolated) — no pre-committed hard ms SLA"
  - "3-harness end-to-end re-run NOT completed in-session (hours-scale consolidation; harnesses run brute-force anyway) — recorded as OPEN/needs-approval, NOT papered over"

requirements-completed: [PERF-02]

# Metrics
duration: ~57min (dominated by consolidation-harness wait)
completed: 2026-06-24
---

# Phase 41 Plan 03: Vector Index Gates (PERF-02 / PERF-03) Summary

**Locked the two phase gates honestly on the live brain: PERF-03 proven by a direct, byte-exact top-k equivalence (indexed `topk` == brute-force `cosineSimF32`, 40/40 checks, max|Δscore|=0); PERF-02 measured as warm 13/14 ms (~3.4× under the 45/46 ms baseline) and cold 72/77 ms (−24/−22 ms vs same-run brute-force, beyond noise over 4 runs) — with the persisted `.vindex` sidecar built first so the cold path read a ready artifact instead of re-marshaling ~10k rows.**

## Performance

- **Duration:** ~57 min (the equivalence + latency work was minutes; ~45 min was waiting on the accuracy-harness consolidation, which then could not complete tonight — see Deviations)
- **Completed:** 2026-06-24
- **Tasks:** 2
- **Files created:** 3 (2 gate scripts + PERF-REPORT)

## Accomplishments

- **PERF-03(a) — byte-exact equivalence (the load-bearing accuracy proof).** Built `41-topk-equivalence.cjs` and ran it read-only on the live brain (10,192 embedded live nodes): for every query, indexed `CandidateRetriever.topk` (reading the persisted `.vindex`) vs brute-force `cosineSimF32`. **40/40 checks pass (20 queries × {candidateK=5, k=20}), 0 failures, max|Δscore| = 0.000e+0** — under BOTH mock unit-vector queries (deterministic, API-free) and real `text-embedding-3-small` queries. The index is exact (D-01), so PERF-03 holds by construction; the D-10 boundary-tie allowance was never needed (zero divergence).
- **Built the measurement prerequisite first (41-02's load-bearing flag).** Before any cold number, persisted the `.vindex` sidecar exactly as the sleep-pass hook does (`buildVectorIndex(db, vectorIndexPath(dbPath))`): 10,192 vectors, 63 MB, ~79 ms, **read-only** (live DB mtime unchanged). Verified present + non-empty before measuring.
- **PERF-02 — latency win vs the committed Phase-40 baseline.** Built `41-latency-after.cjs` (warm + cold, indexed vs same-run brute-force):
  - **Warm (serve/mcp):** indexed **13/14 ms** vs baseline 45/46 ms → **~3.4×, −32 ms**; same-run brute-force reproduces the baseline (44/45 ms).
  - **Cold (the D-08 felt headline — SessionStart-inject / recall-cli):** indexed wall **72/77 ms** vs same-run brute-force 96/99 ms → **−24/−22 ms**; the open+scan inner figure is 16 vs 54 ms (the index skips the ~38 ms row-marshal floor). Stable across **4 runs** (−22 to −25 ms p50, beyond the noise band).
  - This **confirmed D-06**: the spike's *from-scratch* cold was ~20 ms slower; the *persisted* cold here is ~24 ms faster — exactly what 41-02's persistence was built to deliver.
- **Honest cold disclosure.** With real embeddings the cold wall-clock (~361 vs ~375 ms) is dominated by the OpenAI embed round-trip; the index delta survives only in the embed-isolated inner figure. Reported the embed-isolated mock-cold as the index-contribution headline; the real-embed cold delta is **network-confounded and NOT claimed as the index win**.
- **Soft targets set after the fact (D-08).** Warm ≤15 ms p95, cold ≤80 ms p95 wall (embed-isolated) — regression sentinels for Phase 43, no pre-committed hard SLA.

## Task Commits

1. **Task 1: top-k equivalence gate (PERF-03 by construction)** — `0fec565` (test)
2. **Task 2: latency harness + PERF report (PERF-02/03)** — `36a1999` (perf)

**Plan metadata:** (this commit) `docs(41-03): complete vector-index gates plan`

## Files Created/Modified

- `scripts/eval/41-topk-equivalence.cjs` (created) — read-only live-brain (or fixture) check: indexed `topk` vs brute-force `cosineSimF32` set-identity per query, boundary-tie allowance (D-10), at candidateK and a larger k; asserts the sidecar is present (else the check would be vacuous); exits non-zero on real divergence. Writes `results/41-topk-equivalence.json` (gitignored).
- `scripts/eval/41-latency-after.cjs` (created) — warm + cold indexed latency vs same-run brute-force; cold via subprocess-per-query reading the persisted sidecar (the real session-start/recall cold path); ceil-percentile p50/p95; mock + real embed. Writes `results/41-latency-after.json` (gitignored).
- `.planning/phases/41-vector-index-and-hot-path-latency/41-PERF-REPORT.md` (created) — the gate verdicts: PERF-03(a) equivalence PASS, PERF-02 warm+cold PASS with disclosed noise, soft targets set after the fact, PERF-03(b) 3-harness re-run OPEN, honest-framing note.

## Decisions Made

- **PERF-03 by byte-exact equivalence, not eval re-run.** `max|Δscore|=0` means the indexed cosine scores are byte-identical to brute-force, so any harness fed the same query would score identically by construction. This is the stronger, cheaper proof; the end-to-end re-run is corroboration.
- **Cold measured against the PERSISTED sidecar.** The real cold callers (`session-start-cli:128`, `recall-cli:147`) construct `CandidateRetriever(db, { indexPath })`; the harness replicates exactly that in a fresh subprocess — measuring the D-06 persisted win, not the spike's from-scratch overstatement.
- **Embed-isolated headline.** Mock unit-vector queries (the spike's construction) isolate the index's contribution; real-embed cold is network-bound and reported only as a disclosure, never as the index win (no inflated metrics).

## Deviations from Plan

### [Rule 3 - Blocking] Rebuilt dist before measuring (stale build)

- **Found during:** Task 1 setup.
- **Issue:** `dist/src/retrieval/topk.js` predated 41-02's source changes (no `topkIndexed`/`buildVectorIndex`/`vectorIndexPath` in the compiled output). The gate scripts load from `dist/src`, so they would have measured the OLD brute-force-only code.
- **Fix:** `npm run build` (tsc) — dist now contains the indexed code (`grep` count 6). No source change.
- **Files modified:** none (build artifact only).

### Plan-acceptance gap: PERF-03(b) three-harness re-run NOT completed in-session (stated, not papered over)

- **What the plan asked:** re-run KU replay + LOCOMO + LongMemEval-S on the indexed path, show scores unchanged vs the Phase-40 baselines.
- **What happened:** `replay-ku-harness.cjs` was launched twice (full 18-case, then directional 2-case) on the subscription-billed `claude-headless` transport. Both **stalled inside case 1's consolidation** — case `6a1eabeb` consolidates 1,968 cached claims through Haiku+Sonnet and ran **>21 min without completing a single case** tonight (active `claude -p` child = working, not hung; likely subscription-side throttling). The full 18-case run aggregates 35,443 claims → an hours-scale job (Phase-40 noted ~7.37 hr full runs). LOCOMO/LongMemEval carry the same cost plus direct-API-$ over the plan's $3 gate. I stopped the runs rather than block the phase for hours.
- **Why this does not undermine PERF-03:** all three harnesses construct `CandidateRetriever` **without** `indexPath` (replay-ku:259, locomo:160/432, lme:217/710) — they exercise the **brute-force** scan, not the index. The indexed path's accuracy is proven byte-identical by PERF-03(a). The harness re-run would confirm the brute-force fallback is intact, which is corroboration of an already-exact result.
- **Disposition:** recorded in 41-PERF-REPORT.md as **OPEN — needs user approval** (run the harnesses accepting the hours-scale consolidation + paid-API cost, OR explicitly approve deferring the end-to-end confirmation to Phase 43's CI gate). Per the plan's own rule, "deferred, approval pending" is NOT a pass — so this is surfaced explicitly, not marked done.

## Issues Encountered

- The accuracy-harness consolidation was abnormally slow tonight (one ~2k-claim case > 21 min vs the typical), making even a 2-case directional run impractical in-session. The bottleneck is the LLM consolidation step, which is entirely unrelated to the retrieval-index change under test.

## Known Stubs

None. Both gate scripts run real read-only measurements over the live brain and the persisted sidecar; the equivalence result is byte-exact and the latency deltas are real, repeated, and noise-disclosed.

## User Setup Required

To close PERF-03(b): either approve running the three accuracy harnesses (subscription consolidation hours + LOCOMO/LME paid-API spend over the $3 gate), or explicitly approve deferring the end-to-end accuracy confirmation to Phase 43's CI regression gate (the mechanical byte-exact equivalence already proves no result change).

## Next Phase Readiness

- **Phase 43 (eval regression gates)** inherits both gate scripts and the soft targets (warm ≤15 ms p95, cold ≤80 ms p95 wall) as ready-made CI sentinels, plus the equivalence assertion as a mechanical no-accuracy-regression check.
- **Open for the founder:** the PERF-03(b) end-to-end harness re-run decision above. PERF-01 (index built) closed in 41-02; PERF-02 (latency win) is met; PERF-03(a) (equivalence) is met; PERF-03(b) (3-harness end-to-end) awaits the approval call.

## Self-Check: PASSED

- `scripts/eval/41-topk-equivalence.cjs` — FOUND
- `scripts/eval/41-latency-after.cjs` — FOUND
- `.planning/phases/41-vector-index-and-hot-path-latency/41-PERF-REPORT.md` — FOUND
- commit `0fec565` (test, equivalence gate) — FOUND
- commit `36a1999` (perf, latency + report) — FOUND
- live `recense.db` mtime unchanged (read-only); only `.vindex` sidecar written — VERIFIED

---
*Phase: 41-vector-index-and-hot-path-latency*
*Completed: 2026-06-24*
