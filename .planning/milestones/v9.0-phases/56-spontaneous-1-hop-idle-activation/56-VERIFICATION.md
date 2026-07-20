---
phase: 56-spontaneous-1-hop-idle-activation
verified: 2026-07-02T16:30:00Z
status: passed
score: 6/6 must-haves verified
overrides_applied: 0
---

# Phase 56: Spontaneous 1-hop idle activation Verification Report

**Phase Goal:** Honest idle "default-mode" brain wandering for `recense viz` — during idle gaps the brain fires genuinely-new real 1-hop spreads (NOT replay echoes), so it feels alive even with an empty replay buffer / zero recent recalls, without fabricating any edge or activation.
**Verified:** 2026-07-02T16:30:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Note on requirement registration

SPONT-01..06 are NOT registered in `.planning/REQUIREMENTS.md` — per the task brief, this phase was added to the roadmap outside the formal v9.0 requirement set. Verified against ROADMAP.md's Phase 56 section requirement texts instead (confirmed present at ROADMAP.md:1077-1090). This is an **observation**, not a gap — the roadmap contract is the source of truth here and it is fully satisfied.

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria + requirement texts)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | SPONT-01: idle emitter picks a random LIVE node and reads REAL semantic (`PRED_SET`, `kind='relation'`) 1-hop out-edges via the same honest builder as ambient recall | VERIFIED | `src/retrieval/honest-trace.ts` extracted as single shared `buildHonestOneHopTrace`; `src/retrieval/engine.ts:380` delegates (`return buildHonestOneHopTrace(seeds, this.store, AMBIENT_HOP_TOPN)`); `src/viz/server.ts:562` calls the SAME function (`buildHonestOneHopTrace(seeds, spontaneousReader, SPONT_HOP_TOPN)`) over a read-only reader built from prepared SELECTs (server.ts:539-548). Eligible-seed pool (server.ts:518-534) samples only live nodes with ≥1 real PRED_SET out-edge. |
| 2 | SPONT-02: visually distinct color + trace `kind='spontaneous'`, never mistaken for a live query result | VERIFIED | `constants.js:172` `KIND_COLOR.spontaneous = 0xc9b8ff` (pastel lavender, founder-tuned), distinct from recall amber (`0xffb866`) and replay cyan (`0x66d9ff`); `trace.js:706` intercepts `row.kind === 'spontaneous'` before the ingestion dispatch and renders via `KIND_COLORS.spontaneous` + `SPONT_HOP_COLOR`. |
| 3 | SPONT-03: read-only, SSE-only, never writes `activation_trace`, no new `Database()` | VERIFIED | `server.ts` spontaneous region (513-573) uses only the existing `{readonly:true}` `db` handle + two prepared SELECTs; `grep -nE "INSERT INTO activation_trace|new Database\("` over the region returns nothing besides the original readonly open at server.ts:218. Locked by `tests/spontaneous-idle-activation.test.ts` static + dynamic no-write guards (both pass). |
| 4 | SPONT-04: activity ordering live > replay > spontaneous > twinkle; spontaneous preempted by live/replay, fires only after the idle gap | VERIFIED | `server.ts:555-558`: emitter returns early if `replayBuffer.length !== 0` (replay preempts) or `Date.now()-lastLiveRow < REPLAY_IDLE_GAP_MS` (live preempts) — same shared idle-gap constant as replay (D-01a), gate order verified by direct code read. |
| 5 | SPONT-05: tray does NOT pulse on spontaneous; `kind='spontaneous'` excluded from replay ring buffer | VERIFIED | `apps/tray/src/tray-icon.ts:166,170,179-182`: `isSpontaneous` parsed from `kind==='spontaneous'`, suppresses `pulse()`, preserves fail-toward-liveness on parse error. Ring-buffer exclusion holds by construction: `replayBuffer.push(...)` (server.ts:454) only fires from polled real `activation_trace` rows — since spontaneous never writes a row, it can never be polled into the buffer. Founder checkpoint (56-05) additionally confirmed on-screen: "Tray stays at rest on spontaneous events." |
| 6 | SPONT-06: machine guards — every hop is a real cross-checkable semantic out-edge; cadence/density are named tunables; founder checkpoint tunes density | VERIFIED | `tests/spontaneous-idle-activation.test.ts` (2 describe blocks, both pass): real-edge cross-check against `store.getOutEdgesWithRel`, structural/tombstoned-target exclusion at highest weight, top-N truncation, determinism, no-write proof, static source-text guard. Named tunables: `SPONT_CADENCE_MS`, `SPONT_SEED_COUNT`, `SPONT_HOP_TOPN`, `SPONT_POOL_REFRESH_MS` (server.ts) mirrored in `constants.js`. Founder checkpoint (56-05-SUMMARY.md) approved 2026-07-02, commit `fe0e7d3`. |

**Score:** 6/6 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/retrieval/honest-trace.ts` | `buildHonestOneHopTrace` + `HonestTraceReader`, single source of truth, read-only | VERIFIED | 65 lines, exports both names, imports `PRED_SET`, no INSERT/UPDATE/DELETE/new Database — grep-confirmed. |
| `src/retrieval/engine.ts` | delegates to shared helper, no drift | VERIFIED | Line 380 delegates; inline filter loop deleted; `AMBIENT_HOP_TOPN=6` retained. |
| `src/viz/server.ts` | eligible pool, `pickSpontaneousSeeds`, gated emitter, teardown | VERIFIED | Lines 71-77 (constants), 513-573 (pool+emitter), 1312 (`clearInterval(spontaneousInterval)`). |
| `src/viz/modules/constants.js` | SPONT_DIM, SPONT_CADENCE_MS, SPONT_HOP_TOPN, KIND_COLOR.spontaneous, SPONT_PULSE_SCALE | VERIFIED | Lines 148-172, 372-398. `SPONT_DIM=0.3 < REPLAY_DIM=0.4` confirmed numerically at runtime (`node -e` check: `true`). |
| `src/viz/modules/trace.js` | spontaneous render branch, pre-dimmed hop color | VERIFIED | Lines 249, 264-274, 702-763; intercepts before `_applyIngestion`, activates at `SPONT_DIM`, pulses at `SPONT_HOP_COLOR`. |
| `apps/tray/src/tray-icon.ts` | pulse suppression on `kind==='spontaneous'` | VERIFIED | Lines 154-185; parse-failure still pulses (fail-toward-liveness preserved). |
| `tests/spontaneous-idle-activation.test.ts` | SPONT-06 honesty + no-write regression lock | VERIFIED | 201 lines, 3 tests, all pass; `SPONT_HOP_TOPN` mirror confirmed synced to 3 (WR-01 fix, commit `c5b3cad`). |
| `tests/honest-trace.test.ts` | direct behavior tests for the shared helper | VERIFIED | Present, part of the 88-test targeted run, all passing. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `engine.ts` | `honest-trace.ts` | `buildHonestOneHopTrace(` import + call | WIRED | `engine.ts:29` import, `:380` call. |
| `server.ts` spontaneous emitter | `honest-trace.ts` | `buildHonestOneHopTrace(` over readonly reader | WIRED | `server.ts:562`; reader built from prepared SELECTs at 539-548, same shape as `SemanticStore`. |
| `server.ts` spontaneous emitter | `replayBuffer` / `lastLiveRow` | gate `replayBuffer.length !== 0` / idle-gap check | WIRED | `server.ts:557-558`. |
| `trace.js applyTrace` | `KIND_COLOR.spontaneous` / `SPONT_DIM` | render branch | WIRED | `trace.js:706-763`. |
| `tray-icon.ts` trace listener | `kind==='spontaneous'` | suppress pulse | WIRED | `tray-icon.ts:166-182`. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|---------------------|--------|
| `server.ts` spontaneous emitter | `spontaneousPool` | `SELECT DISTINCT e.src ... FROM edge e JOIN node n ...` (real prepared SQL) | Yes | FLOWING |
| `server.ts` spontaneous emitter | `hops` | `buildHonestOneHopTrace` over `stmtSpontOutEdges`/`stmtSpontGetNode` (real prepared SQL against readonly db) | Yes | FLOWING |
| `trace.js` render branch | SSE `row.hops`/`row.seeds` | real server-emitted payload traced above | Yes | FLOWING |

### Behavioral Spot-Checks

Step 7b: SKIPPED — exercising the live gate (`REPLAY_IDLE_GAP_MS=5000ms`, `SPONT_CADENCE_MS=2500ms`) requires starting the viz server and waiting out real timers, which the spot-check constraints (≤10s, no server starts) disallow. This exact path was instead verified via (a) the deterministic unit-level guard test exercising the same `pickSpontaneousSeeds`/`buildHonestOneHopTrace` call shape, and (b) the founder's live on-screen visual checkpoint (56-05, approved 2026-07-02) which specifically exercised the running server with an empty replay buffer and confirmed the spontaneous pathways, cadence, dim, and tray-rest behavior.

### Probe Execution

Step 7c: SKIPPED (no runnable probes declared for this phase; no `scripts/*/tests/probe-*.sh` conventional probes found; phase is not a migration/tooling phase).

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|--------------|-------------|--------------|--------|----------|
| SPONT-01 | 56-01, 56-02 | honest 1-hop shared builder + spontaneous read via it | SATISFIED | See Truth #1 |
| SPONT-02 | 56-03 | distinct color + `kind='spontaneous'` | SATISFIED | See Truth #2 |
| SPONT-03 | 56-02, 56-04 | read-only, SSE-only, no DB write | SATISFIED | See Truth #3 |
| SPONT-04 | 56-02 | activity ordering (SC3) | SATISFIED | See Truth #4 |
| SPONT-05 | 56-03 | tray suppression + ring-buffer exclusion | SATISFIED | See Truth #5 |
| SPONT-06 | 56-04, 56-05 | machine guards + founder checkpoint | SATISFIED | See Truth #6 |

**Note:** SPONT-01..06 do not appear in `.planning/REQUIREMENTS.md` (not registered — added to roadmap outside the formal v9.0 requirement set, per task brief). No orphaned-requirement gap raised for this — instructed to treat as an observation only.

### Anti-Patterns Found

No debt markers (`TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/`PLACEHOLDER`) found in any phase-modified file (`honest-trace.ts`, `engine.ts`, `server.ts`, `constants.js`, `trace.js`, `tray-icon.ts`, both new test files).

The phase's own code review (`56-REVIEW.md`, 2026-07-02, standard depth, 8 files) found **0 critical, 7 warnings, 4 info**. One warning (WR-01: test's `SPONT_HOP_TOPN` mirror drifted 6 vs 3 after founder tuning) has already been fixed (commit `c5b3cad`). The remaining 6 warnings are advisory/residual-risk items that do NOT block goal achievement (none are FAILED must-haves — they are quality/hardening suggestions the review itself classified as non-critical):

| File | Pattern | Severity | Impact |
|------|---------|----------|--------|
| `src/viz/modules/constants.js` | `SPONT_DIM < REPLAY_DIM` invariant has no vitest regression lock (only holds by current value, unlike Phase-54's `REPLAY_DIM<1` locked test) | WARNING (advisory) | Future tuning could silently violate SC3 subordination; currently holds (0.3<0.4, confirmed at runtime). |
| `src/viz/server.ts:518-521` | Eligible-seed pool checks only src liveness, not dst liveness — a seed whose only PRED_SET edges point at tombstoned dsts is pool-eligible but yields 0 hops, silently dropping that tick | WARNING (advisory) | Could rarely cause a "silent tick" in heavily-tombstoned corpora; does not fabricate anything, just occasionally under-delivers a tick. |
| `apps/tray/src/tray-icon.ts:164` | Dim-flag cleared without repainting icon/tooltip on replay/spontaneous rows if already dim | WARNING (pre-existing, surfaced by review) | Edge-case tray visual desync, not specific to spontaneous feature correctness. |
| `apps/tray/src/tray-icon.ts:211-241` | `powerMonitor.on('resume', ...)` listener not removed in `dispose()` | WARNING (pre-existing) | Potential listener leak on tray recreation; unrelated to honesty invariant. |
| `src/viz/modules/trace.js:766-771` | Spontaneous fade timeout clears global `traceNodes`/`traceLinks` sets, which could clobber a concurrent live trace arriving during the fade window | WARNING | Copied from the Phase-54 replay pattern; Phase 56 raises collision frequency somewhat. Visual-only risk, not an honesty violation. |
| `src/retrieval/engine.ts:306-332` | `retrieveCueless` trace emission is a third emitter bypassing `buildHonestOneHopTrace` (no PRED_SET/kind filter, numeric scores) | WARNING | Currently latent — wired only to the Noop sink in production paths — but contradicts the doc-comment's "single source of truth" claim if a non-Noop caller is ever added. |

These are consistent with the review's own "issues_found / 0 critical" classification — none rise to a level that blocks the Phase 56 goal ("honest idle wandering that doesn't fabricate"), since the core honesty guarantees (no fabricated edge, no fabricated magnitude, no DB write) are all independently machine-verified and pass.

### Human Verification Required

None outstanding. The one human-gated task in this phase (56-05, `checkpoint:human-verify`, non-autonomous) was already executed and approved by the founder on 2026-07-02 (commit `fe0e7d3`, `56-05-SUMMARY.md`), confirming on-screen: distinct pastel-lavender hue, calm cadence, visible seed→hop pathway lines, density without clutter, and tray-at-rest during spontaneous activity. No new human-verification items were identified during this verification pass.

### Gaps Summary

None. All 6 roadmap requirement texts (SPONT-01..06) and all 4 roadmap success criteria are verified against live code with passing automated tests (targeted run: 6 test files / 88 tests passed; full suite: 170 test files / 2558 tests passed, 3 skipped; `tsc --noEmit` clean). The one prior code-review warning that mapped to an actual regression-lock defect (WR-01, stale `SPONT_HOP_TOPN` test mirror) was already fixed before this verification ran. Remaining review warnings are advisory hardening suggestions, not goal-blocking gaps, and are surfaced above for founder awareness/backlog triage — not structured as `gaps:` since none corresponds to a failed must-have.

---

_Verified: 2026-07-02T16:30:00Z_
_Verifier: Claude (gsd-verifier)_
