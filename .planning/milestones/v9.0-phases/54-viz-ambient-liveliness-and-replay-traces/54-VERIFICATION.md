---
phase: 54-viz-ambient-liveliness-and-replay-traces
verified: 2026-06-30T22:01:15Z
status: passed
score: 5/5 must-haves verified
overrides_applied: 0
---

# Phase 54: Viz Ambient Liveliness and Replay Traces Verification Report

**Phase Goal:** Make `recense viz` feel alive and engaging when pinned while working, without
fabricating engine activity, via a three-layer activity hierarchy (live recall > replay echo >
twinkle) — presentation-layer only, preserving the Phase 52 honest-traces invariant and the
read-only/LLM-free server boundary.

**Verified:** 2026-06-30T22:01:15Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth (SC) | Status | Evidence |
|---|------------|--------|----------|
| SC1 | Alive at idle: twinkle + periodic replay echoes of real recent recalls | ✓ VERIFIED (structure) / FOUNDER-CONFIRMED (feel) | `twinkleTick` registered via `ctx.registerTick(twinkleTick)` (trace.js:561), runs on the non-sleeping master rAF loop; server `replayInterval` (server.ts:460-478) re-emits real `replayBuffer` rows tagged `replay:true` every `REPLAY_CADENCE_MS` after `REPLAY_IDLE_GAP_MS` of silence. Founder sign-off in 54-05-SUMMARY.md: "twinkle visible + replay echoes confirmed". |
| SC2 | Events pop: live flash clearly stronger than a replay echo at overview zoom | ✓ VERIFIED (structure) / FOUNDER-CONFIRMED (feel) | trace.js:408-409 wires `ACT_BRIGHTEN_GAIN`/`ACT_SCALE_GAIN` into the live-flash opacity/scale; founder tuned both upward from spec midpoints (0.55→0.95, 0.9→1.05) specifically because "live flash wasn't distinctly stronger than replay" — and confirmed the result ("there and distinct") in 54-05-SUMMARY.md. |
| SC3 | Honest hierarchy live > replay > twinkle; no fabricated edges | ✓ VERIFIED (machine) | `REPLAY_DIM = 0.4` (constants.js:344, `< 1` by construction — replay can never reach live intensity). Replay branch (trace.js:592-633) resolves hops via `traceEdgesFromHops(row, ctx.idMap)` only (no `ctx.adj` traversal) and calls `activate(node, intensity * REPLAY_DIM)`. Twinkle (trace.js:519-561) touches haze via `setColorAt` only — `setMatrixAt` appears nowhere as executable code in trace.js (only in comments), and the twinkle function body contains no `spawnPulse(` call. 43/43 `viz-ambient-liveliness.test.ts` guards pass; 39/39 `trace-honest-recall.test.ts` (Phase 52 honesty invariant) pass in the same run. |
| SC4 | Not distracting: ambient layers read as meaningful, not loud/noisy | FOUNDER-CONFIRMED (felt-quality, not machine-checkable) | 54-05-SUMMARY.md: "ambient reads as gentle baseline. Founder-confirmed." Twinkle bounded to `TWINKLE_AMP=0.18` (founder-raised from 0.15 because it was imperceptible, not because it was too loud) and `TWINKLE_COUNT=140` of ~15k nodes (~1%). |
| SC5 | Bounded + in-boundary: no frame-rate regression at ~15k; viz server read-only/LLM-free | ✓ VERIFIED (machine) | Exactly one executable `new Database(` call in server.ts (line 186; two other matches are comment lines). No `fetch(`/`embed(` in any executable line; the one `provider` match is a comment explicitly stating it is NOT used. Replay scheduler block (server.ts:460-478) contains zero `cursor =` assignments (verified both by source-text guard block-extraction in the test and by direct inspection — `cursor` is only assigned at line 387 declaration and line 405 forward-poll update, both outside the replay block). `replayInterval.unref()` present (line 479) + `clearInterval(replayInterval)` on server close (line 1217). |

**Score:** 5/5 SCs hold (3 machine-verified structurally + green tests; 2 felt-quality founder-confirmed per design — SC1/SC2's machine-checkable slice also verified, SC3's structural slice also verified).

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/viz/modules/constants.js` | 10 Phase-54 tunables, `REPLAY_DIM < 1` | ✓ VERIFIED | All 10 exports present (`grep -c` = 10); `REPLAY_DIM = 0.4` (founder-tuned from 0.5, still `< 1`). Values match 54-05-SUMMARY.md tuning table exactly (ACT_SCALE_GAIN=1.05, ACT_BRIGHTEN_GAIN=0.95, DECAY_ATTACK_MS=80, TWINKLE_AMP=0.18, TWINKLE_COUNT=140). |
| `src/viz/modules/trace.js` | Layer1 amplify + Layer2 replay branch + Layer3 twinkle | ✓ VERIFIED, WIRED | Imports all 10 constants (lines 31-47); gain tokens used in compound expressions (not just imported, actually multiplied into render math); `row.replay === true` branch present and reachable before kind dispatch; `twinkleTick` registered on master tick loop. |
| `src/viz/server.ts` | idle-replay scheduler, `replay:true`, read-only boundary | ✓ VERIFIED, WIRED | `replayBuffer` ring populated from live poll (lines 422-424); `replayInterval` scheduler broadcasts `replay:true` payload to SSE clients (lines 460-478); single read-only DB handle preserved; cursor never touched inside replay block. |
| `tests/viz-ambient-liveliness.test.ts` | Machine guards for SC1/SC3/SC5 | ✓ VERIFIED | 43/43 tests pass; covers all 10 constants + value invariant, compound gain-usage expressions, replay-branch honesty (traceEdgesFromHops + REPLAY_DIM), twinkle registration + no-spawnPulse, server boundary (single DB handle, no fetch/embed, replay:true present, cursor non-reassignment via correct block-extraction — not a trivially-defeatable whole-file count). |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| `trace.js` | `constants.js` | ESM import | ✓ WIRED | `import { ACT_SCALE_GAIN, ... } from './constants.js'` (trace.js:31-47); each constant used in live render math, not just imported-and-ignored. |
| `trace.js applyTrace` | `server.ts` `row.replay` flag | SSE row inspection | ✓ WIRED | Replay branch keys off `row.replay === true`, matching the `replay: true` field server.ts actually sets on broadcast rows (server.ts:473). |
| `trace.js twinkleTick` | master rAF loop | `ctx.registerTick` | ✓ WIRED | `ctx.registerTick(twinkleTick)` (trace.js:561) registers alongside the pre-existing main tick; confirmed non-sleeping at idle per Phase-54 research (IDLE_FPS=24). |
| `server.ts` live poll | `server.ts` replay scheduler | `replayBuffer` + `lastLiveRow` shared state | ✓ WIRED | Live poll pushes parsed rows into `replayBuffer` and updates `lastLiveRow`; replay scheduler reads both to gate emission and select rows — no second DB query, no duplicate data path. |

### Behavioral / Build Verification

| Check | Command | Result | Status |
|-------|---------|--------|--------|
| Build | `npm run build` | exit 0 (tsc + viz asset copy) | ✓ PASS |
| Phase-54 guard suite | `npx vitest run tests/viz-ambient-liveliness.test.ts tests/trace-honest-recall.test.ts tests/viz-layout-guards.test.ts` | 82/82 passed | ✓ PASS |
| Phase-54 guards alone | `npx vitest run tests/viz-ambient-liveliness.test.ts` | 43/43 passed | ✓ PASS |
| Full regression suite | `npx vitest run` | 2531 passed, 3 skipped, 0 failed (169 test files) | ✓ PASS — consistent with 54-04-SUMMARY's 2515/0-failed baseline (growth from later phases, no Phase-54 regression) |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (none) | — | No `TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/`PLACEHOLDER` markers in any Phase-54-modified file (`constants.js`, `trace.js`, `server.ts`, `viz-ambient-liveliness.test.ts`) | — | — |

Two unrelated "placeholder" string matches in `server.ts` (lines 692, 730) refer to the pre-existing `generate-doc` corpus-promotion eager-placeholder mechanism (Phase 27 era) — not Phase-54 code, not flagged.

### Requirements Coverage

`.planning/REQUIREMENTS.md` has no entries mapped to Phase 54 — this phase's plans reference ROADMAP Success Criteria directly (`requirements: [SC1, SC2, SC3, SC5]` in PLAN frontmatter) rather than a separate REQUIREMENTS.md ID scheme. No orphaned requirements.

### Deferred Items

| # | Item | Addressed In | Evidence |
|---|------|-------------|----------|
| 1 | Per-prompt ambient recalls emit `hops: []` so pathway-hop pulses are rare on the dominant live-trace source | Phase 55 | ROADMAP Phase 55 goal: "Make the viz show pathway-hop pulses on every recall... Root cause (Phase 54 debug, evidence-backed): ambient recall emits hops: [] by design." Explicitly scoped out of Phase 54 by founder decision in 54-05-SUMMARY.md ("this is a Phase-52 retrieval-engine change, not a Phase-54 dial → captured as a separate phase/plan"). |

This is not a Phase-54 gap — it is a known, evidence-backed, explicitly-deferred follow-up.

### Human Verification Required

None outstanding. SC1, SC2, SC4, and the visual half of SC3 required human/founder visual judgment by design (felt-quality, not machine-checkable) — this was already performed and documented as a blocking checkpoint in Plan 05 (`autonomous: false`, `checkpoint:human-verify` gate). The founder's "approved" sign-off is recorded in `54-05-SUMMARY.md` with per-SC confirmation notes and the final tuned constant values, which this verification confirmed are the exact values now live in `constants.js`. No further human verification is needed for this phase.

### Gaps Summary

No gaps found. All five ROADMAP success criteria hold: the three machine-checkable structural
invariants (SC3 honesty hierarchy, SC5 read-only/LLM-free boundary, plus the machine slices of
SC1/SC2) are verified directly against live source — not just SUMMARY claims — via grep/AST-style
inspection and a green 43-test guard suite plus the full 2531-test regression suite. The two
purely felt-quality criteria (SC4, and the visual confirmation of SC1/SC2/SC3) were correctly
routed through a blocking founder checkpoint (Plan 05) rather than claimed as machine-verified,
and the founder's sign-off plus exact tuned values are traceable in both the SUMMARY and the live
`constants.js`. The one open follow-up (ambient recall hops:[] limiting pathway visibility) was
deliberately and explicitly scoped to Phase 55, not silently dropped.

---

_Verified: 2026-06-30T22:01:15Z_
_Verifier: Claude (gsd-verifier)_
