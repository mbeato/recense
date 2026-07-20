---
phase: 57-viz-activity-palette-redesign
plan: 02
subsystem: viz-client
tags: [viz, palette, luminance, D-01, D-02, D-03, D-04, D-12, invariants-test]
dependency_graph:
  requires:
    - viz-activity-palette-invariants-test-file (57-01)
  provides:
    - luminance-equalized-KIND_COLOR-palette
    - replay-identity-hue
    - D-02-luminance-band-invariant
  affects:
    - src/viz/modules/constants.js
    - src/viz/modules/trace.js
    - tests/viz-activity-palette-invariants.test.ts
tech_stack:
  added: []
  patterns:
    - "Rec.709 relative luminance (0.2126/0.7152/0.0722) as the D-02 colorimetric metric"
    - "source-parse regex on KIND_COLOR entries (mirrors the D-10 scheduler-scalar harness from 57-01)"
key_files:
  created: []
  modified:
    - tests/viz-activity-palette-invariants.test.ts
    - src/viz/modules/constants.js
    - src/viz/modules/trace.js
decisions:
  - "Chose Rec.709 relative luminance Y=0.2126R+0.7152G+0.0722B (not OKLCH L) as the D-02 metric — matches the existing bloom-shader convention in the codebase's vendored Three.js files and is trivial to compute from a raw hex without a color-space library."
  - "Provisional band [170, 235] anchored directly to 56-05 evidence (pastel lavender Y≈193 survived; saturated indigo Y≈138 vanished; HOT amber Y≈193 anchor) rather than picking round numbers."
  - "oscillation moved to a true coral-red (0xe89c9c, R dominant, G≈B, hue≈0°) rather than a different warm-orange shade — deliberately avoids ANY R≈G>B amber-family signature per D-03(b), not just a slightly-different amber."
  - "reconsolidation and neutral kept their original channel-ordering identity (R>B>G rose-mauve; B>G>R slate) while only lifting lightness — same 56-05 pastel-lavender technique (preserve hue, raise luminance)."
  - "trace.js Task 3 changed ONLY the pulse COLOR construction (KIND_COLORS.replay replaces the REPLAY_HOP_COLOR bit-shift); the node-activation seedColor/hopColor branch (which still reads KIND_COLORS.recall_seed/recall_hop for isRecallReplay rows) and the REPLAY_DIM intensity multiplier were left untouched per the plan's explicit scope note (REPLAY_DIM node-activation floor is retuned in 57-04, not here)."
metrics:
  duration_min: 20
  completed: 2026-07-03
  tasks: 3
  files_touched: 3
---

# Phase 57 Plan 02: Luminance-Band Palette Redesign + Replay Identity Hue Summary

Redesigned every `KIND_COLOR` activity hue into a Rec.709 luminance-band-tested identity palette (all 8 entries, including a brand-new `replay` identity hue), moved `oscillation` off the amber family per D-03(b), and rewired `trace.js` so replay pulses read their own in-band identity hue instead of a bit-shift-dimmed copy of live cyan — closing the exact bug class (dimming a saturated hue drives it below the perceptual floor) that required founder rescue three times in Phases 54/55/56.

## What Was Built

**Task 1 — D-02 luminance-band invariant, written RED first (commit `22a0191`):**
Extended `tests/viz-activity-palette-invariants.test.ts` with a `describe('D-02 luminance-band membership', ...)` block: a `relativeLuminance(hex)` helper using the Rec.709 weights (0.2126/0.7152/0.0722), named `Y_MIN=170`/`Y_MAX=235` constants documented as PROVISIONAL (ratchet at Stage 1, D-09), and one `it()` per identity key across all 8 entries (`recall_seed`, `recall_hop`, `new_node`, `reconsolidation`, `oscillation`, `neutral`, `spontaneous`, `replay`) that regex-parses the hex straight out of `constants.js` source text. Ran RED as designed: 4 failures (reconsolidation Y≈146, oscillation Y≈141, neutral Y≈146 all below band; replay entry not found yet), 21 pre-existing D-10 tests still green.

**Task 2 — Redesign the 8 identity hues into the band (commit `0b5bc09`):**
In `constants.js` `KIND_COLOR`:
- Added `replay: 0xb3ecf5` — pale ice-cyan, a cooler/paler sibling of `recall_hop`'s saturated cyan per the D-04 semantic-hue-family rule (Y≈225, in-band).
- Retuned `reconsolidation` `0xc481a4 → 0xd9a0bd` (Y≈146→174) — lifted lightness, kept the rose-mauve channel-ordering identity (R>B>G).
- Retuned `oscillation` `0xc9824e → 0xe89c9c` (Y≈141→172) — moved fully off the amber family (D-03b): the new hue is a true coral-red (R dominant, G≈B, hue≈0°), not merely a lighter amber. The old hue had an R≈G>B warm-orange signature; the new one does not.
- Retuned `neutral` `0x8a93a6 → 0xaab3c4` (Y≈146→178) — lifted lightness, kept the slate channel-ordering identity (B>G>R).
- Left `recall_seed`, `recall_hop`, `new_node`, `spontaneous` untouched (already in-band from prior phases).
- Each changed/added entry got a JSDoc comment in the 56-05 template style (identity, computed Y, PROVISIONAL/Stage-1-ratchet note, subordination-via-motion note).
- `TYPE_COLOR`, `BG_COLOR`, `HOT` verified byte-for-byte unchanged.

The D-02 test suite went fully green (8/8 identity keys in band).

**Task 3 — Wire replay identity hue through trace.js (commit `d8bac7c`):**
Added `replay: new THREE.Color(KIND_COLOR.replay)` to the `KIND_COLORS` pre-build map in `initTrace`. Removed the `REPLAY_HOP_COLOR` bit-shift-dim-from-`recall_hop` construction and its `_rh` temp entirely. Updated the replay-branch pulse call (`spawnPulse(srcNode, node, REPLAY_HOP_COLOR)` → `spawnPulse(srcNode, node, KIND_COLORS.replay)`) so replay's line brightness now comes from its own in-band identity hue rather than a dimmed copy of live cyan. Updated the stale comment on `SPONT_HOP_COLOR` that referenced the now-removed `REPLAY_HOP_COLOR` construction, and the comment above the replay pulse call. Per the plan's explicit scope note, only the pulse COLOR construction changed — the node-activation `seedColor`/`hopColor` branch (which still reads `KIND_COLORS.recall_seed`/`recall_hop` for recall-kind replay rows) and the `REPLAY_DIM` intensity multiplier on node activation are unchanged (REPLAY_DIM's node-activation floor is retuned in Plan 57-04, not this plan).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `npx tsc --noEmit` failed on a strict-null-check error in the new test helper**
- **Found during:** Task 3 verification (`npx tsc --noEmit clean` acceptance criterion)
- **Issue:** `parseKindColorHex`'s `parseInt(match![1], 16)` — TypeScript's regex-match typing makes capture groups `string | undefined`, and `parseInt` requires `string`. This didn't surface during Task 1's `npx vitest run` (RED confirmation), only when Task 3's `tsc --noEmit` check ran over the whole test suite.
- **Fix:** Added a non-null assertion (`match![1]!`), matching the existing `parseFromConstantsJs` helper's convention in the same file's D-10 block (which uses `Number(match![1])`, not directly type-checked the same way — this one needed the explicit `!`).
- **Files modified:** `tests/viz-activity-palette-invariants.test.ts`
- **Commit:** `d8bac7c` (bundled with the Task 3 trace.js commit since it was found during Task 3's tsc verification step)

None of the plan's acceptance criteria required a different mechanism — this is a type-strictness fix, not a behavior change.

## Verification

- `npx vitest run tests/viz-activity-palette-invariants.test.ts` — 25/25 passing (17 D-10 + 8 D-02 luminance-band)
- `npx tsc --noEmit` — clean (exit 0)
- `npx vitest run tests/viz-ambient-liveliness.test.ts` — 43/43 passing (no regression; the `REPLAY_DIM` source-text guard at line ~348 still passes because `REPLAY_DIM` remains used for node-activation intensity — only the pulse-color construction changed)
- `npm test` (full suite) — 171 files passed / 1 skipped, 2582 tests passed / 4 skipped (up from 2574 at 57-01 close; +8 new D-02 tests, no failures)
- `grep -c 'REPLAY_HOP_COLOR' src/viz/modules/trace.js` → 0
- `grep -c 'replay:' src/viz/modules/constants.js` → 2 (the KIND_COLOR entry + its JSDoc reference)
- `TYPE_COLOR` (`0x9c7080`/`0x6d7890`/`0x82698c`), `BG_COLOR` (`0x170f1d`), `HOT` (`0xffb866`) confirmed byte-for-byte unchanged via grep

## Known Stubs

None — no stubs introduced. This plan only changes hex color values and one color-construction call site.

## Threat Flags

None — this plan only changes `KIND_COLOR` hex values and `trace.js` color construction (client-side render-only). No new network endpoints, auth paths, file-access patterns, or schema changes. Matches the plan's own threat register (T-57-03 palette hues: accept, decorative chrome only; T-57-SC: n/a, no package installs).

## Self-Check: PASSED

All modified files verified present (`tests/viz-activity-palette-invariants.test.ts`, `src/viz/modules/constants.js`, `src/viz/modules/trace.js`); all 3 commits (`22a0191`, `0b5bc09`, `d8bac7c`) verified present in git log.
