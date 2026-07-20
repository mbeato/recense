---
phase: 56-spontaneous-1-hop-idle-activation
plan: 05
status: complete
completed: 2026-07-02
commits:
  - fe0e7d3 feat(56-05): founder-tuned spontaneous visuals — pastel lavender, denser lines, calmer density
---

# 56-05 SUMMARY — Founder visual checkpoint (approved)

## Outcome

**Founder sign-off: APPROVED (2026-07-02).** The spontaneous default-mode wandering
reads correctly on screen: distinct pastel-lavender hue (not recall amber, not replay
cyan), calm cadence, visible seed→hop pathway lines, density that fills idle emptiness
without clutter. Tray stays at rest on spontaneous events.

## Checkpoint findings (three real defects surfaced, all fixed)

1. **Stale processes masked the entire feature.** The founder's browser was connected
   to a viz server started before Phase 56 existed (tray D-07 attach-or-spawn had
   attached to the old process on port 7810; terminal restarts couldn't bind the
   occupied port). Additionally `dist/` was stale (executors ran `tsc --noEmit` +
   direct vitest, so nothing recompiled), and the packed tray `Recense.app` predated
   56-03. Resolution: `npm run build`, `apps/tray npm run pack`, kill stale 7810
   server, respawn from fresh dist. **Lesson for future viz phases: verification must
   include rebuild + process restart, not just tests.**
2. **Double-dim render bug.** Spontaneous seeds carry `score: 0` (no fabricated
   magnitude, WR-02), so the render's score-derived base (0.2) × SPONT_DIM (0.3)
   = 0.06 — below the visible floor. Fixed: full base (1.0) so SPONT_DIM is the sole
   dimmer, matching its documented semantics. Hop base 0.3 → 0.6.
3. **Saturated indigo is unrenderable at dim levels.** 0x8a7fff (luminance ≈138)
   scaled by any subordination factor vanished on the dark bg — thin additive lines
   need high luminance. Fixed by desaturating toward pastel: hue = identity,
   luminance = visibility.

## Final founder-tuned constants

| Constant | Shipped value | Location |
|----------|--------------|----------|
| `KIND_COLOR.spontaneous` | `0xc9b8ff` (pastel lavender, Y≈193) | constants.js |
| `SPONT_DIM` | `0.3` (unchanged — SC3 invariant `< REPLAY_DIM 0.4` holds) | constants.js |
| `SPONT_PULSE_SCALE` | `0.6` (new named constant — edge pulses only) | constants.js |
| `SPONT_CADENCE_MS` | `2500` (unchanged) | constants.js + server.ts (in sync) |
| `SPONT_HOP_TOPN` | `3` (was 6) | constants.js + server.ts (in sync) |
| `SPONT_SEED_COUNT` | `2` (was 3) | server.ts |

Cross-file sync verified; `SPONT_DIM < REPLAY_DIM` machine-checkable and intact.
Guard suites green after tuning: spontaneous-idle-activation (3) +
viz-ambient-liveliness (43) = 46/46.

## Deviations

- Render intensity fix (finding 2) touched `trace.js`'s spontaneous branch — a Plan 03
  artifact — under the checkpoint's tuning authority; the wire contract and honesty
  guards were untouched.
- `SPONT_PULSE_SCALE` is a NEW named constant, added because one knob (SPONT_DIM)
  serving both node halos and thin edge lines cannot satisfy both (lines need ~2×
  the luminance of halos to register). Named-tunable requirement (SPONT-06) upheld.
- Subordination rationale updated: replay and spontaneous never co-render (spontaneous
  fires only when the replay buffer is empty), so line-vs-line luminance ordering is
  not load-bearing; the SC3 machine invariant remains on node activation (SPONT_DIM).

## Follow-up queued

Founder requested a full viz activity-palette redesign phase (luminance-equalized
identity hues; salience via motion/scale, not brightness of saturated hues) — the
brightness-scaling salience model has now required founder rescue three times
(54 replay, 55 hops, 56 spontaneous).
