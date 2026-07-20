---
phase: 54
slug: viz-ambient-liveliness-and-replay-traces
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-06-30
---

# Phase 54 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Presentation-only phase: machine guards cover the structural/honesty/boundary
> invariants (SC1, SC3-structure, SC5); felt-quality criteria (SC2, SC4, SC3-visual)
> are founder-confirmed at the live visual checkpoint (Phase 52/53 idiom).

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | `vitest.config.ts` (root) |
| **Quick run command** | `npx vitest run tests/viz-ambient-liveliness.test.ts tests/trace-honest-recall.test.ts` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~15 seconds (quick) / ~60 seconds (full) |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run tests/viz-ambient-liveliness.test.ts tests/trace-honest-recall.test.ts tests/viz-layout-guards.test.ts`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** ~15 seconds

The Phase 52 honesty regression (`tests/trace-honest-recall.test.ts`) re-runs after
every Wave 2 implementation task — it is the live guard that no implementation step
regresses the no-fabricated-edges invariant.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 54-01-01 | 01 | 1 | SC5 (constants exported) | — | 10 named tunables exported; no logic | source-text guard | `grep -c '^export const' src/viz/modules/constants.js` (≥10 new) | ❌ W3 guard | ⬜ pending |
| 54-02-01 | 02 | 2 | SC2 (events pop) | — | scale uses `a * ACT_SCALE_GAIN`, haze uses `a * ACT_HAZE_LERP`; setColorAt only | source-text guard + honesty re-run | `npx vitest run tests/trace-honest-recall.test.ts` | ✅ exists (regression) | ⬜ pending |
| 54-02-02 | 02 | 2 | SC1/SC3 (replay echo dimmer) | T-54-honesty | `row.replay===true` early-return; reuses real hops; REPLAY_DIM < 1 | source-text guard + honesty re-run | `npx vitest run tests/trace-honest-recall.test.ts` | ✅ exists (regression) | ⬜ pending |
| 54-02-03 | 02 | 2 | SC1 (twinkle / alive at idle) | T-54-honesty | neutral tint, no pulses/halos, no setMatrixAt; lazy haze init | source-text guard + honesty re-run | `npx vitest run tests/trace-honest-recall.test.ts` | ✅ exists (regression) | ⬜ pending |
| 54-03-01 | 03 | 2 | SC5 (read-only boundary) | T-54-boundary | one read-only `new Database(`; no fetch/embed/provider | source-text guard | `npx vitest run tests/viz-ambient-liveliness.test.ts` | ❌ W3 guard | ⬜ pending |
| 54-03-02 | 03 | 2 | SC1/SC5 (replay flag + cursor) | T-54-cursor | `replay:true` plumbed; no `cursor =` inside replay block | source-text guard | `npx vitest run tests/viz-ambient-liveliness.test.ts` | ❌ W3 guard | ⬜ pending |
| 54-04-01 | 04 | 3 | SC1/SC3/SC5 (machine guards) | T-54-all | guard suite asserts all invariants above | unit (new file) | `npx vitest run tests/viz-ambient-liveliness.test.ts` | ✅ created here | ⬜ pending |
| 54-04-02 | 04 | 3 | SC3 (no regression) | T-54-honesty | full-suite regression gate green | unit (full) | `npx vitest run` | ✅ exists | ⬜ pending |
| 54-05-01 | 05 | 4 | SC1–SC4 (live viz up) | — | viz serves; ambient layers render | manual (operational) | `recense viz` (founder runs) | N/A manual | ⬜ pending |
| 54-05-02 | 05 | 4 | SC2/SC4/SC3-visual | — | founder confirms felt-quality hierarchy | manual (human-verify) | founder visual checkpoint | N/A manual | ⬜ pending |
| 54-05-03 | 05 | 4 | — | — | final constant tuning committed; guards re-green | source-text guard | `npx vitest run tests/viz-ambient-liveliness.test.ts` | ✅ exists | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*
*"File Exists ❌ W3 guard" = the machine guard for this task lives in `tests/viz-ambient-liveliness.test.ts`, created in Wave 3 (Plan 04). Wave 2 tasks are guarded live by the existing `trace-honest-recall.test.ts` regression until then.*

---

## Wave 0 Requirements

- [ ] `tests/viz-ambient-liveliness.test.ts` — new file (created in Wave 3 / Plan 04); covers SC1, SC3-structure, SC5 machine guards (constants exported, replay flag plumbed, REPLAY_DIM < 1, read-only boundary, cursor not rewound inside replay block, twinkle/replay fabricate no edges).
- [ ] Framework: vitest already installed — no new framework needed.

*Note: this phase has no literal Wave 0; the new guard file is created in Wave 3 after the Wave 2 implementation it guards, which is correct for source-text guards. Sampling continuity holds because the Phase 52 honesty regression re-runs after every Wave 2 task.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Real recall pops at overview zoom, distinctly stronger than a replay echo | SC2 | Felt-quality / perceptual — not machine-assertable | Founder pins `recense viz`, triggers a real recall, confirms the live flash is clearly noticeable and visibly stronger than replay echoes |
| Ambient layers read as meaningful, not loud/noisy | SC4 | Felt-quality — founder aesthetic call | Founder observes idle viz over time; twinkle + periodic replay echoes feel alive but not distracting; tunes constants at checkpoint |
| Replays read as rehearsal, not live (visual half of SC3) | SC3 | Perceptual legibility of the live > replay > twinkle hierarchy | Founder confirms a replay echo is never mistaken for a fresh live recall |

*Structural half of SC3 (REPLAY_DIM < 1; replay reuses real hops; no fabricated edges) and all of SC1/SC5 are machine-verified by Plan 04's guard suite.*

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or are explicitly manual founder-checkpoint tasks
- [x] Sampling continuity: no 3 consecutive tasks without automated verify (Phase 52 honesty regression runs after every Wave 2 task)
- [x] Wave 0 / new-guard file covers all machine-checkable references
- [x] No watch-mode flags (all `vitest run`, never `vitest` watch)
- [x] Feedback latency < 15s (quick command)
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-06-30
