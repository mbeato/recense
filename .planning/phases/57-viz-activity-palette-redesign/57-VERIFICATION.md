---
phase: 57-viz-activity-palette-redesign
verified: 2026-07-03T19:15:00Z
status: gaps_found
score: 7/9 must-haves verified
overrides_applied: 0
gaps:
  - truth: "Amber (HOT_COLOR) is reserved exclusively for live retrieval/hover — the locked D-04 invariant restated in this very phase's constants.js"
    status: failed
    reason: "CR-02 (independently verified): server.ts's replay ring buffer (server.ts:488) accepts ANY row with non-empty seeds, including ingestion-kind rows (kind='oscillation'|'new_node'|'neutral'|'reconsolidation') written by the sleep pass. When such a row replays, trace.js's replay branch (trace.js:707-708) sets seedColor/hopColor to `undefined` for non-recall rows, and activate()'s fallback at trace.js:339/348/369 is `kindColor || HOT_COLOR` — so an idle replay of a consolidation event renders HOT amber at REPLAY_DIM 0.7 with a 0.75-scale halo, well above the visibility floor. This directly contradicts the inline comment claiming non-recall rows 'keep the neutral default activation' (the actual default is amber) and violates the D-04 guard documented at constants.js:126 in the same commit series."
    artifacts:
      - path: "src/viz/modules/trace.js"
        issue: "Lines 731-736: `seedColor = isRecallReplay ? KIND_COLORS.recall_seed : undefined` (same for hopColor); lines 339, 348, 369 activate()/halo fallback `kindColor || HOT_COLOR` resolves undefined to amber, not neutral"
      - path: "src/viz/server.ts"
        issue: "Line 488: `if (Array.isArray(seeds) && seeds.length > 0)` pushes any kind (including ingestion kinds) into the replay ring — no kind filter"
    missing:
      - "Make the stated intent real: `const seedColor = isRecallReplay ? KIND_COLORS.recall_seed : KIND_COLORS.neutral` (same pattern for hopColor)"
      - "Defense-in-depth (optional): filter non-recall rows out of the server replay buffer at server.ts:488 so replay only ever echoes recall rows, matching what TRIGGER-STEPS.md promises the founder"
      - "Add a regression test asserting a replayed ingestion-kind row never resolves to HOT_COLOR/amber"
  - truth: "Trace reveal/fade cleanup does not permanently leak node visibility state (the WR-06 rewrite must not trade a transient race for a permanent leak)"
    status: failed
    reason: "CR-01 (independently verified): the 57-06 fix correctly replaced the global `ctx.traceNodes.clear()` with own-trace-scoped `delete()` in the three explicitly-scoped branches (replay, spontaneous, live recall — confirmed 3 delete sites, 0 clear() calls). But `grep -n 'ctx.traceNodes.clear\\|traceLinks.clear' src/viz/modules/*.js` now returns ZERO matches anywhere in the codebase, while `ctx.traceNodes.add(...)` is called from 5 additional sites inside `_applyIngestion` (trace.js:973, 988, 1014, 1024, 1047 — new_node, oscillation, reconsolidation seed + candidate, neutral fallback) and from `detail.js:430` (focusNode) — none of which have ever had their own scoped delete, and previously relied on the now-removed global clear for incidental cleanup. Consequence: every sleep-pass consolidation event and every focusNode() call permanently adds its node id to `ctx.traceNodes`; `lod.js:192`'s visibility predicate (`traceNodes.has(n.id)`) keeps those nodes and links revealed forever until page reload — confirmed the detail.js:426 comment ('the next trace's fade-back may re-hide it') is now false, since nothing re-hides it. On an all-day tray install this accumulates monotonically, defeating the overview LOD."
    artifacts:
      - path: "src/viz/modules/trace.js"
        issue: "Lines 973, 988, 1014, 1024, 1047 (_applyIngestion): ctx.traceNodes.add() with no matching delete anywhere"
      - path: "src/viz/modules/detail.js"
        issue: "Line 430 (focusNode): ctx.traceNodes.add(node.id) with no matching delete; line 426 comment claims fade-back re-hides it, which is no longer true"
      - path: "src/viz/modules/lod.js"
        issue: "Line 192: traceNodes.has(n.id) visibility predicate keeps leaked ids revealed forever"
    missing:
      - "Give each _applyIngestion branch its own scoped fade (setTimeout deleting only the ids it added), mirroring the three already-fixed branches"
      - "Decide focusNode's reveal lifetime explicitly — a scoped timer in detail.js, or an honest comment update saying reveal is permanent until reload — rather than leaving the stale 'fade-back may re-hide it' claim in place"
      - "Add a regression test exercising an ingestion-kind trace (or focusNode) and asserting ctx.traceNodes is empty (or bounded) after its fade window elapses"
deferred: []
human_verification:
  - test: "Confirm the founder's verbal Stage-1 and Stage-2 approvals (recorded in docs/superpowers/evidence/57-stage1-palette/APPROVAL.md and 57-stage2-system/APPROVAL.md) are still the founder's genuine, current sign-off, given that the underlying constants.js/trace.js the founder approved now ships with the CR-01/CR-02 defects described above (the founder was not shown these leak/amber-flash behaviors — they require an idle replay-of-a-consolidation-event or an all-day-uptime LOD check to surface, neither of which the TRIGGER-STEPS.md walkthrough exercises)."
    expected: "Founder is made aware that the D-04 amber-exclusivity guarantee (which they were shown and approved) does not currently hold for replayed ingestion-kind rows, and that ctx.traceNodes leaks permanently — and either re-approves once fixed, or explicitly accepts the current state."
    why_human: "This is a visual/behavioral judgment (does the amber flash on an idle consolidation replay read as wrong to the founder) plus a repudiation-evidence question (the two Stage checkpoints have no screenshots, only verbal sign-off recorded post-hoc by the executor) — not something grep/test can resolve on its own."
---

# Phase 57: viz activity-palette redesign — Verification Report

**Phase Goal:** Redesign the viz activity color system so hue carries IDENTITY and salience comes from motion/scale/density — never from brightness-scaling saturated hues. Approach: (1) luminance-equalized identity palette in a bounded band with a new replay identity hue; (2) SC3 salience ordering (live > replay > spontaneous > twinkle) expressed through machine-checkable motion/scale constants; (3) one bloom/tone-mapping calibration pass against the real hull; (4) founder visual checkpoints close it. Honesty constraints untouched — presentation layer only.

**Verified:** 2026-07-03T19:15:00Z
**Status:** gaps_found
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | VIZ-PAL-01: Luminance-equalized identity palette — 8 KIND_COLOR entries (incl. new replay hue) all compute Rec.709 Y inside the locked [170,228] band; oscillation off amber-family | VERIFIED | `constants.js` KIND_COLOR entries confirmed (oscillation `0xe89c9c` coral, not amber; replay `0xb3ecf5` ice-cyan); `tests/viz-activity-palette-invariants.test.ts` D-02 band-membership suite passes (independently re-ran: 77/77 tests green across both invariants files) |
| 2 | VIZ-PAL-02: SC3 salience re-expressed as per-layer motion profiles (attack/halo/pulse) with monotonic ordering + floored dim factors; wired into actual render code, not just constants | VERIFIED | `constants.js` has DECAY_ATTACK_MS(80) < REPLAY_ATTACK_MS(200) < SPONT_ATTACK_MS(400) < TWINKLE_ATTACK_MS(500) and LIVE_HALO_SCALE(1.0) > REPLAY_HALO_SCALE(0.75) > SPONT_HALO_SCALE(0.55) > TWINKLE_HALO_SCALE(0.3); confirmed by direct grep that `trace.js:69-71` builds `LIVE_PROFILE`/`REPLAY_PROFILE`/`SPONT_PROFILE` and `activate(...)` calls at lines 733/736/819/822 actually pass them (not merely imported) — the wiring is real, not just authored. WR-03 (review, non-blocking) correctly notes no *behavioral* test locks this wiring against future silent deletion of the 4th arg. |
| 3 | VIZ-PAL-03: Single shared source of truth for scheduler constants (kills WR-01 mirror-drift) | VERIFIED | `server.ts` hand-mirrored const block removed; `parseSchedulerScalars()` reads `constants.js` via regex source-parse; D-10 tests pass |
| 4 | VIZ-PAL-04 (literal wording): own-trace-scoped fades in the three named branches (live, replay, spontaneous) — no global clear in those three | VERIFIED (narrow) | `grep -c 'ctx.traceNodes.clear()' src/viz/modules/trace.js` = 0; `grep -c 'ctx.traceNodes.delete(' src/viz/modules/trace.js` = 3, one per branch, confirmed |
| 5 | Trace reveal/fade cleanup does not trade the WR-06 race for a permanent leak (implied by D-11's own framing: "the phase rewrites fade mechanics anyway and must not inherit the known idle→live clobber race") | **FAILED** | **CR-01** — see Gaps. Zero `.clear()` calls remain anywhere in the module tree, yet 5 `_applyIngestion` add-sites (trace.js:973/988/1014/1024/1047) plus `detail.js:430` (focusNode) add to `ctx.traceNodes` with no delete anywhere in the codebase — independently confirmed via full-tree grep. Permanent leak, not a fix. |
| 6 | Amber stays reserved for live retrieval/hover (D-04) — no other activity kind, including replayed ingestion kinds, ever renders amber | **FAILED** | **CR-02** — see Gaps. `server.ts:488` replay buffer admits any non-empty-seeds row regardless of kind; `trace.js`'s non-recall replay branch resolves `undefined` seedColor/hopColor to `HOT_COLOR` (amber) via the `kindColor \|\| HOT_COLOR` fallback at lines 339/348/369 — independently confirmed by reading the exact code path. |
| 7 | VIZ-PAL-05: One dedicated invariants test file owns all palette/motion locks | VERIFIED | `tests/viz-activity-palette-invariants.test.ts` contains D-10/D-02/D-06/D-05 describe blocks; 31 tests, all passing (independently re-ran) |
| 8 | VIZ-PAL-06: Global bloom/tone-mapping calibration pass; single composer only, no selective bloom | VERIFIED | `effects.js` UnrealBloomPass args `0.6, 0.4, 0.72`; `grep -c 'new EffectComposer'` = 0; `ctx.bloomPass` assignment retained; `graph.js` documents (does not add) exposure knob |
| 9 | VIZ-PAL-07: Two-stage founder checkpoint (Stage-1 hue sign-off, Stage-2 full-system tune) with provisional values ratcheted to approved locks | PARTIAL (see human_verification) | Both checkpoints resolved and JSDoc ratcheted PROVISIONAL→LOCKED; `docs/superpowers/evidence/57-stage1-palette/` and `.../57-stage2-system/` both exist with `APPROVAL.md`+`TRIGGER-STEPS.md`, but **no screenshots were captured** despite being an explicit Task-2 acceptance criterion in both 57-03 and 57-07 (honestly disclosed in both SUMMARY.md files as a documented gap, not fabricated) |

**Score:** 7/9 truths verified (2 FAILED as BLOCKERs; 1 PARTIAL routed to human verification)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/viz/modules/constants.js` | 8-hue luminance-banded palette + 4 per-layer motion-profile blocks + floored dim factors | VERIFIED | All exports present and correctly valued; confirmed via direct read |
| `src/viz/modules/trace.js` | Replay identity hue wired; own-trace-scoped fades (3 branches); motion-profile consumption | VERIFIED (wiring) / **FAILED (correctness)** | Wiring present, but CR-01 (leak) and CR-02 (amber-fallback) are real defects in this exact file |
| `src/viz/modules/detail.js` | focusNode reveal lifetime | **FAILED (regression)** | `ctx.traceNodes.add()` at line 430 with no scoped delete; comment claiming "fade-back may re-hide it" is stale/false post-57-06 |
| `src/viz/server.ts` | Sole scheduler-scalar source-parse from constants.js; replay ring buffer | VERIFIED (source-parse) / **FAILED (kind filter)** | Source-parse mechanism correct; but replay buffer (line 488) admits ingestion-kind rows, feeding CR-02 |
| `src/viz/modules/effects.js` | Recalibrated bloom, single composer | VERIFIED | `0.6/0.4/0.72`, single `postProcessingComposer()`, `ctx.bloomPass` intact |
| `src/viz/modules/graph.js` | Exposure/tone-mapping calibration surface documented | VERIFIED | Comment block present at scene.background site; no unrequested behavior change |
| `tests/viz-activity-palette-invariants.test.ts` | D-10/D-02/D-06/D-05 invariants (31 tests) | VERIFIED | Re-ran independently: all green. Does NOT catch CR-01/CR-02 (constant-level locks only, per WR-03) |
| `docs/superpowers/evidence/57-stage1-palette/`, `.../57-stage2-system/` | Durable founder approval evidence incl. screenshots | PARTIAL | `APPROVAL.md`+`TRIGGER-STEPS.md` exist; screenshots absent (honestly documented, not fabricated) |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `server.ts` | `constants.js` | `fs.readFileSync` + export-const regex at `startVizServer` init | VERIFIED | `parseSchedulerScalars()` confirmed exported and used |
| `trace.js` | `constants.js` | `KIND_COLOR.replay` read into `KIND_COLORS.replay` | VERIFIED | `trace.js` pre-build map includes `replay: new THREE.Color(KIND_COLOR.replay)` |
| `trace.js` fade timeouts | `ctx.traceNodes` | `delete(id)` per added id (3 branches) | VERIFIED (narrow) / **INCOMPLETE (system-wide)** | The 3 named branches are correctly scoped; 6 other add-sites across `trace.js`/`detail.js` are unscoped and now unrecoverable (CR-01) |
| `server.ts` replay buffer | `trace.js` replay branch | non-recall `kind` rows | **NOT GUARDED** | No kind filter at either end — CR-02's root cause |

### Data-Flow Trace (Level 4)

Not applicable in the conventional sense (no DB-backed UI list/dashboard) — but the equivalent trace for this phase is the seed-color resolution path, which was walked end-to-end above (server.ts row → SSE payload → trace.js branch selection → activate() fallback) and found to resolve to unintended amber (CR-02), and the traceNodes lifecycle (add → visibility predicate → no delete) which was walked end-to-end and found to leak permanently (CR-01).

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| D-02 luminance-band + D-06 ordering + D-10 shared-source invariants | `npx vitest run tests/viz-activity-palette-invariants.test.ts tests/viz-ambient-liveliness.test.ts` | 77/77 tests passed | PASS (constants-level only — does not exercise CR-01/CR-02 code paths) |
| Global traceNodes.clear() fully removed | `grep -rn 'traceNodes.clear\|traceLinks.clear' src/viz/modules/*.js` | 0 matches | Confirms the WR-06 fix is complete for clear() removal, but by removing the ONLY cleanup path for 6 other add-sites, this is also the direct evidence for CR-01 |
| Replay buffer admits non-recall kinds | `sed -n '486-489p' src/viz/server.ts` | `if (Array.isArray(seeds) && seeds.length > 0)` — no kind check | Confirms CR-02's feeding path |

### Probe Execution

No dedicated probe scripts (`scripts/*/tests/probe-*.sh`) exist for this phase — SKIPPED (no runnable entry points beyond the vitest suite already exercised above).

### Requirements Coverage

Note: this phase's requirement IDs (`VIZ-PAL-01`..`07`) were derived at plan-phase time (2026-07-02) directly in `ROADMAP.md`'s Phase 57 entry, as a founder-requested insertion into an otherwise-unrelated v9.0 milestone. `.planning/REQUIREMENTS.md` is scoped entirely to the "v9.0 Memory Quality" milestone (RECON/RETR/HARD/SCALE/GATE) and contains **zero** VIZ-PAL entries or any Phase-57 traceability row — this is expected for an ad hoc, founder-triggered phase outside the milestone's requirement doc, not a planning omission (ROADMAP.md's own Phase 57 section is the authoritative requirement record here, and it fully enumerates VIZ-PAL-01..07 with descriptions). Flagged as informational, not a gap.

| Requirement | Source Plan | Description | Status | Evidence |
|---|---|---|---|---|
| VIZ-PAL-01 | 57-02, 57-03 | Luminance-equalized identity palette | SATISFIED | 8-hue band verified |
| VIZ-PAL-02 | 57-04, 57-06, 57-07 | Per-layer motion profiles + monotonic ordering + dim floors | SATISFIED (constants + wiring) | Verified above |
| VIZ-PAL-03 | 57-01 | Shared scheduler-constant source of truth | SATISFIED | Verified above |
| VIZ-PAL-04 | 57-06 | WR-06 own-trace-scoped fades, all 3 branches | SATISFIED (literal) / **BLOCKED (system property)** | CR-01 regression |
| VIZ-PAL-05 | 57-01, 57-02, 57-04 | Dedicated invariants test file | SATISFIED | Verified above |
| VIZ-PAL-06 | 57-05, 57-07 | Bloom/exposure calibration, single composer | SATISFIED | Verified above |
| VIZ-PAL-07 | 57-03, 57-07 | Two-stage founder checkpoint | PARTIAL | Screenshots missing (disclosed) |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/viz/modules/trace.js` | 707-708 | Comment claims non-recall replay rows "keep the neutral default activation" — actual default is amber (`kindColor \|\| HOT_COLOR`) | Blocker (CR-02) | Misleading inline documentation masks a real amber-exclusivity violation |
| `src/viz/modules/detail.js` | 426 | Comment claims "the next trace's fade-back may re-hide it" — no longer true after 57-06 removed the global clear this depended on | Blocker (CR-01) | Stale contract documentation; the described behavior does not occur |
| `src/viz/modules/trace.js` | 331-360 vs 365 | Halo coalesce path lacks the node-envelope's lower-level guard (WR-01, review) | Warning | Latent logic asymmetry; a lower-salience activation can shrink/recolor an in-flight higher-salience halo |
| `src/viz/modules/trace.js` | 754-759, 838-843, 942-947 | Own-trace-scoped fades are delete-by-id on a Set, not refcounted (WR-02, review) | Warning | Overlapping traces sharing a node id can clobber each other's fade; transient, not permanent |
| `tests/viz-activity-palette-invariants.test.ts` | whole file | No behavioral test asserts motion profiles are actually consumed by activate()/spawnPulse calls (WR-03, review) | Warning | Silently deleting the 4th arg from any activate() call would pass the full suite |

No `TBD`/`FIXME`/`XXX` debt markers found in any file modified by this phase.

### Human Verification Required

### 1. Founder re-review of Stage-1/Stage-2 approvals given CR-01/CR-02

**Test:** Show the founder an idle replay of a consolidation event (ingestion kind, e.g. `oscillation` or `neutral`) and confirm whether it flashes amber; separately, leave the tray running for several hours and check whether previously-revealed nodes/links accumulate and never fade back into the LOD-hidden state.
**Expected:** Neither behavior should occur — replay of non-recall events should render in the neutral/event hue (never amber), and revealed nodes should return to LOD-hidden after their fade window regardless of which code path revealed them.
**Why human:** The founder's existing Stage-1/Stage-2 sign-offs were given without these specific defects surfaced (the TRIGGER-STEPS.md walkthroughs don't exercise an idle replay-of-an-ingestion-event or an all-day uptime check) — closing CR-01/CR-02 changes the visual behavior the founder actually approved, so a fresh look (or an explicit "accept as known-issue") is warranted once fixed.

## Gaps Summary

Two Critical, independently-verified regressions block full phase-goal achievement, both introduced by the 57-06 WR-06 fix and confirmed by direct code reading (not just trusting REVIEW.md's narrative):

1. **CR-01 — `ctx.traceNodes` permanent leak.** The WR-06 fix correctly scoped fade-deletion in the three explicitly-targeted branches (live, replay, spontaneous — 0 `.clear()` calls, 3 `.delete()` sites, exactly as planned) but in doing so removed the only cleanup mechanism the five `_applyIngestion` add-sites and `detail.js`'s `focusNode` had ever relied on. Nothing in the current codebase deletes those six add-sites' ids from `ctx.traceNodes`, so `lod.js`'s visibility predicate keeps those nodes/links permanently revealed, defeating the overview LOD over long tray uptimes.
2. **CR-02 — replayed non-recall rows flash HOT amber.** The server's replay ring buffer accepts any row with a non-empty `seeds` array regardless of `kind`, so ingestion-kind rows (oscillation/new_node/reconsolidation/neutral) get replayed. The client's non-recall replay branch passes `undefined` for `seedColor`/`hopColor`, and `activate()`'s `kindColor || HOT_COLOR` fallback resolves that to live-amber — directly violating the D-04 amber-exclusivity guard this same phase's `constants.js` documents as locked, and contradicting the branch's own inline comment.

Both are real, load-bearing defects (not documentation drift, not test-coverage gaps) that a founder using the tray all day, or triggering an idle replay of a sleep-pass event, would actually observe. They are NOT caught by any of the 77 passing invariant/liveliness tests, because those tests lock constant *values*, not the code paths that select which constant is used (a gap the review's WR-03 finding independently flags as the phase's highest-value untested surface).

All other must-haves (palette, motion-profile wiring, shared-source-of-truth, bloom calibration, dedicated invariants file, founder checkpoints) are genuinely present and correctly implemented — this is not a wholesale rejection of the phase's work, but these two specific defects must be closed before the phase can be marked passed.

---

_Verified: 2026-07-03T19:15:00Z_
_Verifier: Claude (gsd-verifier)_
