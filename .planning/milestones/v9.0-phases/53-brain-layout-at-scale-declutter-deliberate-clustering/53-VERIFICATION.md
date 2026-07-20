---
phase: 53-brain-layout-at-scale-declutter-deliberate-clustering
verified: 2026-06-30T13:46:00Z
status: passed
score: 8/8 must-haves verified
overrides_applied: 0
re_verification:
  previous_status: none
  note: initial verification
notes:
  - "Presentation-layer phase: recense viz is decorative chrome; node positions are NOT semantic (CLAUDE.md). Engine-faithfulness constraints do not apply."
  - "Founder visual checkpoint (53-03 Task 3) APPROVED at ~15.4k live nodes — authoritative sign-off for human-gated SC1/SC2/SC3; not re-raised as human_needed."
  - "WR-01 (dead settle mechanism) and WR-02 (cap can be exceeded by K member-less schemas) recorded below as noted warnings — neither blocks the approved, shipping outcome."
---

# Phase 53: Brain Layout at Scale (declutter + deliberate clustering) Verification Report

**Phase Goal:** Rework the `recense viz` brain layout so it declutters and reads as deliberately clustered at scale (~15k nodes) — gridlines gone (SC1), not-too-full / readable (SC2), clustered/deliberate + no frame-rate regression (SC3), all machine-guarded (SC4).
**Verified:** 2026-06-30T13:46:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | SC1 — No visible lattice/gridlines: placement fills space continuously, not snapped to voxel centres (D-04) | VERIFIED | `halton()`/`sampleInHull()` (graph.js:176-216) generate continuous in-hull points via Halton low-discrepancy + `brainOccupied` rejection; voxel grid used only as inside/outside test. Applied in BOTH `placeInHull` (303-314) and `buildHazeLayer` (473-481) — the latter was the dominant haze cloud the gap-fix (commit 02a09f9/25b03ac) de-latticed. Founder approved "gridlines gone" at ~15.4k. |
| 2 | SC3 — Related nodes start clustered by schema membership (D-01/D-02) | VERIFIED | Pass-2 member placement (graph.js:328-357) biases each member toward its schema hub world position within `CLUSTER_RADIUS = 0.12*BRAIN_SCALE`, validated in-hull via `invRotMat`/`brainOccupied`. `viz-seed-determinism.test.ts` asserts members land within per-axis cluster radius of their hub. Founder approved "clustering reads." |
| 3 | D-08 — Layout deterministic across reloads, no persistent cache | VERIFIED | brainVol path has zero `Math.random` (grep: 240-242 are the null-fallback branch only); all randomness from `halton()` (fixed contiguous counter start `{v:1}` / `{v:HAZE_INDEX_OFFSET}`) and `_hashIndex` (Knuth hash on node index). `viz-seed-determinism.test.ts` asserts byte-identical x/y/z across two runs. |
| 4 | D-03 — Settle wall-clock bounded, never hangs at 15k | VERIFIED (outcome) | `cooldownTicks(12)` removed; `setTimeout(revealSettled, SETTLE_BUDGET_MS)` wired (graph.js:754,770). Outcome (bounded, never hangs) satisfied. NOTE WR-01: `cooldownTicks(0)` makes `onEngineStop` win at frame ~1, so the SETTLE_BUDGET_MS timeout + per-tick containment are effectively inert — render is the pure Halton seed. Outcome met, named mechanism vestigial. Recorded, not a gap (founder-approved static result). |
| 5 | D-07 — Reveal UX unchanged: canvas opacity 0 during settle then fades in; revealSettled() body locked | VERIFIED | revealSettled() body (graph.js:759-767) retains `n.fx=n.x` pin + `opacity 0.35s ease` fade verbatim; `viz-layout-guards.test.ts` asserts both tokens. 59/59 Phase 52 viz tests green. |
| 6 | SC2 / D-05 — Overview fullness held in calibrated band regardless of corpus size | VERIFIED | `OVERVIEW_NODE_CAP = 3000` (constants.js:238); lod.js:121-134 suppresses surplus haze into `suppressedHaze` Set when `overviewCount > cap`; `nodeVisible` hides them (lod.js:187). `viz-lod-density.test.ts` asserts visible overview ≤ cap. Founder approved fullness. NOTE WR-02 below. |
| 7 | D-06 — Long tail dropped deliberately: schema super-nodes kept, haze fills remainder, surplus suppressed; drill-in/trace unaffected | VERIFIED | lod.js keeps all `__cat==='schema'` nodes, admits `OVERVIEW_NODE_CAP - schemaCount` haze, suppresses rest via Set (not `__cat` mutation) so trace-reveal + hazeOpacityScale paths untouched. Test asserts all schema survive + under-cap no-op. |
| 8 | SC4 / D-09 — Invariants machine-guarded; Phase 52 honest-traces still render | VERIFIED | `tests/viz-layout-guards.test.ts` asserts BRAIN_SCALE=460 + SETTLE_BUDGET_MS + OVERVIEW_NODE_CAP exported, `setTimeout(revealSettled, SETTLE_BUDGET_MS)` present, `cooldownTicks(12)` absent, revealSettled fade+pin intact, nodeRadius magnitudes intact, no Math.random in brainVol seed branch. Full viz suite 94/94 green (35 + 59 verified this run). |

**Score:** 8/8 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/viz/modules/graph.js` | seedNodePositions continuous+clustered+deterministic (exported); wall-clock settle; Halton sampler; buildHazeLayer de-latticed | VERIFIED | `export function seedNodePositions` (236); `halton`/`sampleInHull` (176-216); three-pass placement (316-364); settle block (754-770). Substantive, wired, data flows. |
| `src/viz/modules/lod.js` | OVERVIEW_NODE_CAP enforcement, schema-first ranking, suppressedHaze | VERIFIED | imports + uses OVERVIEW_NODE_CAP (39,122); suppressedHaze Set wired into nodeVisible (121-187,298). |
| `src/viz/modules/constants.js` | SETTLE_BUDGET_MS + OVERVIEW_NODE_CAP named tunables; BRAIN_SCALE=460 intact | VERIFIED | BRAIN_SCALE=460 (184), OVERVIEW_NODE_CAP=3000 (238), SETTLE_BUDGET_MS=250 (251). |
| `tests/viz-layout-guards.test.ts` | machine-checkable locked-anchor + seed/settle guards | VERIFIED | present; green; asserts all locked invariants with comment-stripping. |
| `tests/viz-seed-determinism.test.ts` | determinism + clustering behavioral test | VERIFIED | present; green (determinism, cluster radius, in-hull, null-fallback). |
| `tests/viz-lod-density.test.ts` | overview-cap cases + existing band assertions | VERIFIED | present; green; over-cap ≤ cap, all-schema-survive, under-cap no-op. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| graph.js seedNodePositions | node.__schemaId / __cat (initLod) | schema-hub centroid lookup | WIRED | nodeMap hub lookup at 331; Pass-1/2/3 keyed on `__cat`/`__schemaId`. |
| graph.js settle block | SETTLE_BUDGET_MS (constants.js) | setTimeout(revealSettled, SETTLE_BUDGET_MS) | WIRED (inert) | Imported (27), used (770). See WR-01 — wired but vestigial at runtime. |
| lod.js density block | OVERVIEW_NODE_CAP (constants.js) | import + cap check after overviewCount | WIRED | Imported (39), branch at 122. |
| lod.js cap ranking | schemaMembers Map (.size) | largest-schema-first survive-ranking | WIRED | schemaMembers built 59-67; ranking idiom present 140. |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Phase 53 guard/determinism/density suite | `vitest run viz-layout-guards viz-seed-determinism viz-lod-density` | 35/35 passed | PASS |
| Phase 52 + corpus viz no-regress | `vitest run viz-haze-activation viz-haze-selection remember-viz-bridge sleep-pass-viz-lighting viz-corpus-graph` | 59/59 passed | PASS |
| Combined viz total | (35 + 59) | 94/94 | PASS (matches SUMMARY claim) |
| No Math.random in brainVol seed path | `grep Math.random graph.js` | only null-fallback branch (240-242) + comments | PASS |
| No cooldownTicks(12) in graph.js | `grep cooldownTicks(12) src/` | only constants.js JSDoc (stripped by guard) | PASS |

### Requirements Coverage

D-01..D-09 are presentation-layer requirements defined in the ROADMAP/CONTEXT (not in REQUIREMENTS.md, which tracks engine HARD-* / numbered reqs). Mapped to truths above.

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| D-01 | 53-01 | seed-then-cluster hybrid | SATISFIED | Truth 2 |
| D-02 | 53-01 | schema-membership grouping | SATISFIED | Truth 2 |
| D-03 | 53-01 | bounded wall-clock settle | SATISFIED (outcome) | Truth 4 (WR-01 noted) |
| D-04 | 53-01 | continuous placement, no lattice | SATISFIED | Truth 1 |
| D-05 | 53-02 | overview node cap | SATISFIED | Truth 6 (WR-02 noted) |
| D-06 | 53-02 | schema-first survive ranking | SATISFIED | Truth 7 |
| D-07 | 53-01 | revealSettled body locked | SATISFIED | Truth 5 |
| D-08 | 53-01 | deterministic, no cache | SATISFIED | Truth 3 |
| D-09 | 53-03 | machine guards + founder checkpoint | SATISFIED | Truth 8 + founder approval |

### Anti-Patterns / Noted Findings

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| src/viz/modules/graph.js | 754-770 | WR-01: `cooldownTicks(0)` makes `onEngineStop` fire at frame ~1; SETTLE_BUDGET_MS timeout, force tuning, `d3ReheatSimulation`, and per-tick `brainContainment` never run | WARNING | Outcome (bounded settle, never hangs) trivially met; named mechanism + a block of force-settle code are dead. Render = pure Halton seed, which the founder approved. Misleading comments for next maintainer. Not a goal gap. |
| src/viz/modules/lod.js | 122-134 | WR-02: cap budgets `schemaMembers.keys()` (schemas with ≥1 member) but `nodeVisible` keeps ALL `__cat==='schema'` visible; K member-less schemas exceed cap by K | WARNING | Visible overview can be `OVERVIEW_NODE_CAP + K`. Edge case (member-less schemas rare); founder approved actual fullness at 15.4k. Guard-set ≠ ship-set drift. |
| src/viz/modules/graph.js | 359-364 | IN-01: Pass-3 haze placement is dead work in brainVol path (overwritten by buildHazeLayer) | INFO | Wasted compute; positions consumed only by null-brainVol path. |
| src/viz/modules/lod.js | 153-158 | IN-02: hazeOpacityScale computed from pre-cap overviewCount, double-attenuates capped haze | INFO | Minor visual inconsistency only. |
| src/viz/modules/graph.js | 238-248 | IN-03: null-brainVol fallback uses Math.random (non-deterministic) | INFO | Documented, intentional; guard test explicitly excludes this branch. |

No debt markers (TBD/FIXME/XXX) introduced in modified files. No stubs. No blocker anti-patterns.

### Human Verification Required

None outstanding. The founder visual checkpoint (53-03 Task 3, the human-gated SC1/SC2/SC3 felt qualities + reload-stability + Phase 52 flash sanity) was **APPROVED at ~15.4k live nodes** after iteration — gridlines gone, fullness acceptable, clustering reads. This is the authoritative sign-off; not re-raised.

### Gaps Summary

No gaps blocking goal achievement. All four ROADMAP success criteria are met: SC1 (gridlines gone — continuous Halton in both seed and haze paths, founder-confirmed), SC2 (not-too-full — OVERVIEW_NODE_CAP enforced, founder-confirmed), SC3 (clustered + no frame-rate regression — schema-centroid bias, and the settle is instantaneous so no added per-frame cost, founder-confirmed), SC4 (machine-guarded — viz-layout-guards green, 94/94 viz suite green, engine/data-model untouched).

Two WARNING-level findings are recorded for maintainer awareness but do not constitute gaps: WR-01 documents that the named `SETTLE_BUDGET_MS` wall-clock mechanism is vestigial at runtime (the outcome it was meant to guarantee is met trivially by the instant stop, and the approved render is the pure seed layout); WR-02 documents that the overview cap can be exceeded by the count of member-less schemas. Both are presentation-layer, neither breaks the approved, shipping visual. Recommend a follow-up cleanup ticket for WR-01 (delete dead force-settle code or implement a real `cooldownTime` budget) and WR-02 (count the kept schema set, not `schemaMembers`).

---

_Verified: 2026-06-30T13:46:00Z_
_Verifier: Claude (gsd-verifier)_
