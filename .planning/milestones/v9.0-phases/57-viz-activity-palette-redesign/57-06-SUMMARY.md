---
phase: 57-viz-activity-palette-redesign
plan: 06
subsystem: viz-client
tags: [viz, motion-profile, trace-fade, WR-06, D-06, D-08, D-11, SC3]
dependency_graph:
  requires:
    - four-per-layer motion-profile constants in constants.js (live/replay/spontaneous/twinkle attack-ms/halo-scale/pulse-thickness) (57-04)
    - luminance-equalized KIND_COLOR palette + replay identity hue (57-02)
  provides:
    - trace.js consumes per-layer motion profiles (attack ms, halo/scale, pulse thickness) for live/replay/spontaneous; twinkle attack-ramp on subset rotation
    - own-trace-scoped fade deletion in all three fade branches (replay, spontaneous, live recall) — closes WR-06
  affects: []
tech_stack:
  added: []
  patterns:
    - "activate(node, level, kindColor, profile) / spawnPulse(from, to, color, thickness) accept an optional per-layer motion-profile object; omitted arg defaults to LIVE_PROFILE / LIVE_PULSE_THICKNESS for pixel-equivalence (D-08)"
    - "per-node __actAttackMs stored at activation time so evalEnvelope's ramp phase reads the node's own layer profile instead of a single global constant"
    - "own-trace-scoped fade: capture addedIds = pathNodes.map(n => n.id) before scheduling setTimeout; the timeout deletes only those ids, never global-clears the shared ctx.traceNodes/ctx.traceLinks sets"
key_files:
  created: []
  modified:
    - src/viz/modules/trace.js
    - tests/viz-ambient-liveliness.test.ts
decisions:
  - "Body-scale pulse (ACT_SCALE_GAIN) stays a single global gain shared by all activated nodes regardless of layer — constants.js only defines one ACT_SCALE_GAIN (no per-layer variants), so the halo glow-orb radius (HALO_RADIUS * haloScale) is the per-layer 'scale' differentiator, not the node's own body-mesh scale."
  - "Hold/fade durations (DECAY_HOLD_MS/DECAY_FADE_MS/DECAY_FLOOR) stay global across all layers — only the attack-ms channel varies per node (via the new __actAttackMs), matching constants.js's D-06 scope (only attack-ms and halo/scale are locked as monotonic ordering channels; hold/fade are not per-layer constants)."
  - "Twinkle consumes only its ATTACK_MS channel: subset rotations now ramp breathe amplitude in from 0 over TWINKLE_ATTACK_MS instead of snapping to full amplitude on each rotation, giving twinkle its documented 'slowest/least-sharp' character. TWINKLE_HALO_SCALE and TWINKLE_PULSE_THICKNESS are left unconsumed — twinkle has no halo or edge-pulse mechanic (setColorAt-only per its own invariants), and 57-04 explicitly documented both consts as reserved for a possible future twinkle micro-pulse/halo, not required for this plan."
  - "ctx.traceLinks.clear() is dropped entirely from all three fade timeouts rather than converted to scoped deletion: grepping trace.js confirmed this module never calls ctx.traceLinks.add(...) anywhere — it draws pathway lines as animated wavefronts (spawnPulse), not persistent LOD links — so there are no ids for these branches to 'own' in that set. Global-clearing a set this module never populates was exactly the WR-06-class clobber the plan targets; simply not touching it is the correct scoped behavior."
  - "Split the interleaved Task 1 (motion-profile wiring) and Task 2 (own-trace-scoped fades) edits into two atomic commits by reconstructing the Task-1-only intermediate state (fade blocks temporarily reverted to global clear() while keeping the attack-ms swaps), verifying it independently (42/42 tests, tsc clean), committing it, then reapplying the exact Task 2 diff and verifying/committing again — since both tasks touched adjacent lines inside the same fade blocks in trace.js, this reconstruction was needed to keep per-task commit granularity from the execution protocol."
metrics:
  duration_min: 35
  completed: 2026-07-03
  tasks: 2
  files_touched: 2
---

# Phase 57 Plan 06: Trace.js Motion-Profile Consumption + Own-Trace-Scoped Fades (WR-06/D-11) Summary

Rewrote `trace.js` so all four activity layers (live/replay/spontaneous/twinkle) render from the per-layer motion profiles authored in 57-04 — salience now reads from attack sharpness, halo/scale, and pulse thickness rather than dimming a saturated hue — and fixed the WR-06 live race by making all three fade branches (replay, spontaneous, live recall) delete only the node ids each trace itself added instead of globally clearing the shared `ctx.traceNodes`/`ctx.traceLinks` sets.

## What Was Built

**Task 1 — Per-layer motion-profile consumption (commit `b708291`):**

- `activate(node, level, kindColor, profile)` and `spawnPulse(from, to, color, thickness)` gained a 4th parameter carrying a per-layer motion profile (`{ attackMs, haloScale }`) / thickness multiplier. Omitting the argument defaults to `LIVE_PROFILE` / `LIVE_PULSE_THICKNESS` (both effectively `1.0`/`DECAY_ATTACK_MS`), so every pre-existing call site — the Phase-02 recall path and all four ingestion event kinds (`new_node`, `oscillation`, `reconsolidation`, neutral fallback) — is pixel-equivalent to pre-57-06 behavior (D-08).
- `evalEnvelope`'s linear-attack phase now reads a per-node `attackMs` argument (defaulting to `DECAY_ATTACK_MS`) instead of always using the global constant. `activate()` stores this on `node.__actAttackMs` at fire time; `tick()`'s both branches (haze InstancedMesh path and regular mesh path) pass `node.__actAttackMs` into `evalEnvelope` and use it in the expiry check, and reset it to `undefined` on expiry alongside the other `__act*` fields.
- The node-flash halo (FIX-52A) now scales its radius by `HALO_RADIUS * haloScale` where `haloScale` comes from the activation's profile, stored per-halo-record and updated on coalesce/re-trigger.
- `spawnPulse`'s traveling wavefront now scales its XZ radius by the pulse's own `thickness` (default `LIVE_PULSE_THICKNESS`), replacing the previously-fixed `scale.set(1, len, 1)`.
- Replay branch: `activate()` calls now pass `REPLAY_PROFILE`; its `spawnPulse` call passes `REPLAY_PULSE_THICKNESS`; its `markAnimating`/fade-window computations swap `DECAY_ATTACK_MS` for `REPLAY_ATTACK_MS`.
- Spontaneous branch: same wiring with `SPONT_PROFILE`/`SPONT_PULSE_THICKNESS`/`SPONT_ATTACK_MS`.
- Twinkle: subset rotations now record a `twinkleSubsetT0` timestamp; each frame computes `attackFactor = min(1, (now - twinkleSubsetT0) / TWINKLE_ATTACK_MS)` and multiplies it into the breathe amplitude, so a freshly-rotated subset ramps in over `TWINKLE_ATTACK_MS` (500ms) rather than popping to full amplitude — twinkle's documented "slowest/least-sharp" character. `TWINKLE_HALO_SCALE`/`TWINKLE_PULSE_THICKNESS` remain unconsumed (twinkle has no halo/pulse mechanic; reserved per 57-04).
- `REPLAY_DIM`/`SPONT_DIM` intensity multipliers are unchanged in the activate() calls — they remain the bounded secondary dim cue (D-05); the new profile args are the primary subordination signal.

**Task 2 — Own-trace-scoped fades in all three branches (commit `677f8af`):**

- Replay, spontaneous, and live-recall fade timeouts each now capture `const addedIds = pathNodes.map(n => n.id)` before scheduling `setTimeout`, and the timeout body does `addedIds.forEach(id => ctx.traceNodes.delete(id))` instead of `ctx.traceNodes.clear()`.
- `ctx.traceLinks.clear()` is removed entirely from all three timeouts (not converted to scoped deletion) — a grep confirmed `trace.js` never calls `ctx.traceLinks.add(...)` anywhere in the module (pathway lines are drawn as animated wavefronts via `spawnPulse`, not persistent LOD links held in that set), so there are no ids for these branches to own; global-clearing a set this module never populates was exactly the clobber class this plan targets.
- Added a `WR-06 / D-11 — own-trace-scoped fades` describe block to `tests/viz-ambient-liveliness.test.ts`: two source-guards (zero global `traceNodes.clear()`, zero `traceLinks.clear()` in fade timeouts, ≥3 scoped `traceNodes.delete(` sites) and one behavioral regression test that captures scheduled `setTimeout` callbacks (bypassing the file-level no-op `setTimeout` stub) to simulate the exact WR-06 race: a spontaneous trace fires and schedules its fade; a live recall arrives before that fade fires, adding its own node id to the same shared `ctx.traceNodes`; the spontaneous fade timeout is then invoked and asserted to delete only its own id, leaving the live trace's id intact.

## Deviations from Plan

### Auto-fixed Issues

None — both tasks executed per the plan's action text and interface sketches.

### Process Note — Commit Splitting

The plan's two tasks touch adjacent lines inside the same three fade blocks in `trace.js` (Task 1's `REPLAY_ATTACK_MS`/`SPONT_ATTACK_MS` swap in the `fadeMs` computation sits directly above Task 2's `clear()` → scoped-`delete()` swap in the same `setTimeout` body). To preserve per-task atomic commits as required by the execution protocol, the Task-1-only intermediate state was reconstructed (fade bodies temporarily reverted to `ctx.traceNodes.clear(); ctx.traceLinks.clear();` while keeping the attack-ms swaps and all other Task 1 wiring), independently verified (42/42 `viz-ambient-liveliness` tests, `tsc --noEmit` clean), committed, then the exact Task 2 diff was reapplied from a saved final snapshot and verified/committed again. Not a plan deviation — a mechanical commit-history technique, documented here for traceability.

## Verification

- `npx vitest run tests/viz-ambient-liveliness.test.ts` — 42/42 passing at the Task 1 checkpoint; 46/46 passing after Task 2 (4 new WR-06/D-11 tests added)
- `npx tsc --noEmit` — clean (exit 0) at both checkpoints
- `node -e "..."` (Task 2 acceptance script) — `all three fades own-trace-scoped: 3 delete sites, 0 global clears`
- `grep -c 'ctx.traceNodes.clear()' src/viz/modules/trace.js` → 0
- `grep -c 'ctx.traceLinks.clear()' src/viz/modules/trace.js` → 0
- `grep -c 'ctx.traceNodes.delete(' src/viz/modules/trace.js` → 3
- `npm test` (full suite) — 171 files passed / 1 skipped, 2591 tests passed / 4 skipped (up from 2587 at 57-04 close; +4 net new WR-06/D-11 tests, no failures)
- Live behavior confirmed pixel-equivalent: all pre-existing compound source-text guards in `viz-ambient-liveliness.test.ts` still pass byte-for-byte (`1 + a * ACT_SCALE_GAIN`, `a * ACT_BRIGHTEN_GAIN`, `a * ACT_HAZE_LERP`, `* REPLAY_DIM`), confirming the live regular-node scale/opacity/haze-lerp formulas and the replay `REPLAY_DIM` multiplier are untouched by this plan

## Known Stubs

None — no stubs introduced. All motion-profile consumption is real, wired render logic; the WR-06 fix is a real behavioral change (verified by the concurrent-fade regression test), not a placeholder.

## Threat Flags

None — this plan only changes client-side render/fade wiring in `trace.js` (attack-ms/halo-scale/pulse-thickness consumption + own-trace-scoped fade deletion) and adds test coverage. No new network endpoints, auth paths, file-access patterns, or schema changes. Matches the plan's own threat register: T-57-07 (concurrent-trace clobber, WR-06 race) is mitigated via own-trace-scoped deletion in all three branches, verified by the zero-global-clear source-guards plus the concurrent-fade behavioral regression test; T-57-08 (leftover ids in shared sets) is accepted per the plan's disposition — scoped deletion removes exactly the ids a trace added.

## Self-Check: PASSED

- `src/viz/modules/trace.js` — FOUND
- `tests/viz-ambient-liveliness.test.ts` — FOUND
- Commit `b708291` — FOUND in git log
- Commit `677f8af` — FOUND in git log

---
*Phase: 57-viz-activity-palette-redesign*
*Completed: 2026-07-03*
