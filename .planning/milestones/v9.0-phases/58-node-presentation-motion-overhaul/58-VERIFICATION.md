---
phase: 58-node-presentation-motion-overhaul
verified: 2026-07-05T20:35:00Z
status: human_needed
score: 13/15 must-haves verified
overrides_applied: 0
overrides:
  - must_have: "D-06: two-phase orbit-then-dolly camera focus with anticipation pull-back"
    reason: "Founder explicitly overrode D-06 live at the Stage-2 MOTION checkpoint (58-08, three review rounds, commit 099582d): the staged 3-phase flight read as '2 repositions' and its timers stomped manual drag input, so it was replaced with a single continuous damped camera move. Interruptibility-as-a-rule was kept and strengthened (commit 760b43b: manual orbit/zoom now releases the damp target entirely). This is a founder-authority in-session decision override, not an unresolved gap."
    accepted_by: "founder (Max), live checkpoint round 2 of 58-08"
    accepted_at: "2026-07-05"
human_verification:
  - test: "Capture fps at both tiers (overview-idle ~24fps target, focus-interaction ~60fps target) on the live install, one-line before/after comparison per D-16"
    expected: "No regression vs the pre-phase baseline; new shader/tick work (billboard impostor fragment shader, matcap onBeforeCompile extension, per-frame label distance-fade, damped camera/hover ticks) does not measurably drop frame rate at either tier"
    why_human: "Requires a live browser session with an fps overlay; not statically verifiable. Both 58-01-SUMMARY.md and 58-08-SUMMARY.md explicitly record that this was never captured — no before number, no after number, at any point in the phase."
  - test: "Capture screenshots (haze/labels/matcap) and short screen recordings (hover, focus flight, transition) as the durable D-14 approval record"
    expected: "Per-technique visual evidence exists on disk/in the planning record, not just a text approval"
    why_human: "The founder did review live and gave real verbal approval at both checkpoints (58-05: 'approved'; 58-08: 3 rounds, 2 fixes, final 'approved') — this is genuine human verification that already happened, not a missing test. But the specific D-14 artifact (screenshots + recordings) was never produced, so no durable visual record exists for a future reviewer who wasn't in the session. Lower priority than the fps check since the checkpoint's actual intent (founder judgment on the look/feel) was met."
---

# Phase 58: Node Presentation & Motion Overhaul Verification Report

**Phase Goal:** Nodes and interactions reach the July-2026 premium bar. Custom node presentation replaces default-orb feel per the research doc's ranked techniques: soft radial-falloff sprite impostors for the haze tier, matcap-mix on focus-tier nodes, SDF labels (troika) for schema super-nodes only; interaction motion gets a frame-rate-independent damped hover/selection grammar and two-phase orbit-then-dolly camera focus with interruptibility-as-a-rule. Everything stays cohesive with the LOCKED founder-approved desaturated palette, D-02 luminance band, 0.72 bloom threshold, and NoToneMapping. Stay WebGL2. Presentation only — honesty invariant untouched.

**Verified:** 2026-07-05T20:35:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | HAZE-IMPOSTOR: haze `InstancedMesh` renders as camera-facing billboard quads with radial-falloff, not opaque spheres | VERIFIED | `src/viz/modules/graph.js:48` (`_hazeQuadGeo = new THREE.PlaneGeometry(2,2)`), `:490-533` (billboard `ShaderMaterial`, `smoothstep(1.0,0.0,dist)` falloff, no `AdditiveBlending`), `:640-650` (`ctx.hazeRayProxy` invisible sphere proxy for raycast correctness). Tests: `viz-haze-activation.test.ts`, `viz-haze-selection.test.ts` pass (verified live). |
| 2 | D-01/D-02/D-03/D-04: diegetic SDF labels via vendored troika, top-N schemas by member count, appear-on-approach, depth-tested, slate, never amber | VERIFIED | `src/viz/modules/labels.js` (`initLabels`, `selectTopSchemas`), imports only `../vendor/troika/*` + `./constants.js` (no CDN). `text.material.depthTest = true`, opacity damped 0↔0.7 by `LABEL_DISTANCE_THRESHOLD`. `LABEL_COLOR` band + non-amber lock in `tests/viz-activity-palette-invariants.test.ts` (D-15 label color lock, passes live). Advisory: see CR-01 in Anti-Patterns. |
| 3 | D-09/D-10/D-11/D-12: focus-tier matcap mix, script-generated grayscale asset, selection+1-hop only, damped fade, 32-seg focus geometry | VERIFIED | `scripts/gen-matcap.mjs --check` passes live (grayscale, byte-identical). `graph.js:161-172` (`uMatcapTex`/`uMatcapMix` injected into shared `onBeforeCompile`, luminance-only mix). `graph.js:57` (`_focusGeo = SphereGeometry(1,32,32)`), `:195-210` (`focusNodeGeometry`/`unfocusNodeGeometry`). `detail.js` drives fade via `registerTick` + `THREE.MathUtils.damp`. Advisory: see WR-02 in Anti-Patterns. |
| 4 | HOVER-DAMP: frame-rate-independent damped hover, asymmetric (overshoot in, none out) | VERIFIED | `graph.js:681-753` — `setHoverTarget`, `_hoverSettling` Set, `THREE.MathUtils.damp(current, stepTarget, HOVER_LAMBDA, dt)`; overshoot-then-settle on grow leg, straight damp-to-1 on shrink leg. `HOVER_LAMBDA=10`, `HOVER_OVERSHOOT=1.05` in `constants.js`, founder-approved unchanged at Stage-2 (58-08). |
| 5 | D-05: one damped-target camera system drives ALL camera moves (focus, transition, recenter, search fly-to), interruptible by construction | VERIFIED | `src/viz/modules/camera.js` — `ctx.setCameraTarget(pos, lookAt)` + single `registerTick` writing `Graph.cameraPosition(dampedPos, dampedLookAt, 0)`. All 4 call sites migrated: `detail.js` focus, `graph.js` recenter (animated path), `transition.js` pullBack/dive, `search.js` (needs zero edits — routes through `selectNode`→`focusCamera`, confirmed by source scan). Interruptibility strengthened at 58-08: manual `OrbitControls` `'start'` event releases the `active` flag so user drag/zoom is never fought (commit `760b43b`); regression tests in `tests/viz-camera-damp.test.ts` pass live. |
| 6 | D-06: two-phase orbit-then-dolly camera focus — **superseded by founder override** | VERIFIED (as amended) | Founder explicitly rejected the staged 3-phase flight at 58-08 round 2 ("2 repositions", drag-while-focused broken) and replaced it with a single continuous `ctx.setCameraTarget` glide (commit `099582d`). Confirmed in code: `detail.js:489-498` (`focusCamera` = one `setCameraTarget` call), `FOCUS_ANTICIPATION_PCT`/`FOCUS_ORBIT_MS`/`FOCUS_DOLLY_MS` absent from `constants.js` (grep confirms zero occurrences). See `overrides` in frontmatter — this is a founder-authority decision, not a gap. |
| 7 | D-07: focus depth deepening — stronger non-neighbor dim + tightened fog near-plane while focused | VERIFIED (plain-node path); WARNING (schema path) | `detail.js` `applyFocusDim`/`clearFocusDim` save/tighten/restore `fog.near` via `FOCUS_FOG_NEAR` (`BRAIN_SCALE*1.4`) and `FOCUS_DIM_OPACITY` (0.035), founder-approved unchanged at 58-08. Schema-node selection's `clearFocusDim()` call (detail.js:643) reverts this before re-dimming only node materials — see WR-01 in Anti-Patterns; user-visible only on schema super-node selection specifically. |
| 8 | D-08: brain↔corpus transition re-driven through the new damped grammar; 4 patch-era lessons untouched | VERIFIED | `transition.js:41-60` — `pullBackCamera`/`diveCamera` call `ctx.setCameraTarget`; exact-home restore (`homeCam`), `markActive()` suppression, opacity-only fades, prepared-before-reveal sequencing all present in source, byte-diff limited to the camera-call lines per 58-06-SUMMARY.md's own claim (spot-checked: no other structural change). |
| 9 | D-13: two-stage founder checkpoint (LOOK then MOTION) both held and resolved | VERIFIED | 58-05-SUMMARY.md: Stage-1 LOOK — founder "approved", troika keep/kill = KEEP. 58-08-SUMMARY.md: Stage-2 MOTION — 3 rounds (2 rejected-with-fixes: camera snap-back fixed in `760b43b`, D-06 staged flight removed in `099582d`), final round "approved". Both are genuine conversational human-verification records, not fabricated. |
| 10 | D-14: evidence = screenshots + screen recordings as the durable approval record | **NOT MET** | No screenshots or recordings exist anywhere in the phase directory or repo for haze/labels/matcap/hover/focus-flight/transition. Both 58-05-SUMMARY.md and 58-08-SUMMARY.md explicitly and honestly record this gap rather than fabricate it. Routed to human_verification (lower priority — the checkpoint's substantive intent was met via live founder review). |
| 11 | D-15: machine locks for palette-touching constants only (label color band+non-amber, matcap grayscale-only, no LOCKED constant drift) | VERIFIED | `tests/viz-activity-palette-invariants.test.ts` "D-15 label color lock" describe block passes live (band + non-amber). `node scripts/gen-matcap.mjs --check` passes live (grayscale, byte-identical). Phase-57 LOCKED constants (`TYPE_COLOR`, `BG_COLOR`, `0.72` bloom threshold, `NoToneMapping`) unchanged in source (grep-confirmed) and existing Phase-57 invariant tests still pass in the full suite. |
| 12 | D-16: perf measured before/after (overview-idle ~24fps, focus-interaction ~60fps) at both tiers | **NOT MET** | 58-01-SUMMARY.md: pre-phase baseline "not captured". 58-08-SUMMARY.md ("Honest Evidence Gaps"): "No fps numbers reported... No before/after comparison exists." No fps measurement exists anywhere in the phase record. Routed to human_verification (higher priority — this is a genuine unmeasured perf-regression risk given the new per-frame shader/tick work). |
| 13 | Everything stays cohesive with LOCKED palette/D-02 band/0.72 bloom/NoToneMapping (no re-grading) | VERIFIED | `effects.js:162` — `0.72` threshold comment marked "LOCKED... Stage-2 57-07", unchanged. `graph.js:832` — `NoToneMapping` comment unchanged. `constants.js` `TYPE_COLOR`/`BG_COLOR` present, untouched by phase-58 diff (scoped diff `c96540d^..099582d` touches zero lines in the `TYPE_COLOR`/`BG_COLOR`/bloom declarations). |
| 14 | Stay WebGL2 — no WebGPU/TSL migration | VERIFIED | Zero occurrences of `WebGPU`/`TSL` in any first-party `src/viz/modules/*.js` file (grep confirmed); `THREE.ShaderMaterial`/`WebGLRenderer` (WebGL2 path) used throughout the new haze/matcap shader code. |
| 15 | Presentation only — honesty invariant untouched (no engine mechanism files touched) | VERIFIED | Scoped diff `c96540d^..099582d -- src/ scripts/ tests/` touches only `src/viz/modules/*`, `src/viz/vendor/*` (new vendored assets), `scripts/gen-matcap.mjs`, and `tests/viz-*.test.ts` — 23 files, zero engine/API/DB files. (An unrelated `src/model/claude-headless-client.ts` commit interleaves chronologically in the branch history but is a separate, non-phase-58 commit — confirmed by its own commit message referencing an unrelated thinking-tokens feature, not attributed to any 58-* plan.) |

**Score:** 13/15 truths fully verified; 2/15 (D-14, D-16) are honestly-documented evidence gaps routed to human verification rather than fabricated as closed.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/viz/modules/graph.js` | Haze billboard impostor, matcap injection, hover damp, focus geometry | VERIFIED | Substantive, wired, all four features present and source-confirmed |
| `src/viz/modules/labels.js` | Top-N SDF schema label layer | VERIFIED | Substantive (127 lines), wired into `app.js` init chain, unit-tested |
| `src/viz/modules/camera.js` | One damped-target camera system | VERIFIED | Substantive (149 lines new), wired into `app.js`, `detail.js`, `graph.js`, `transition.js`; unit-tested (`viz-camera-damp.test.ts`) |
| `src/viz/modules/detail.js` | Focus flight, matcap drive, focus dim/fog | VERIFIED | Modified in-place, D-06-override applied, D-07 fog/dim wired |
| `src/viz/modules/transition.js` | Damped re-drive of brain↔corpus transition | VERIFIED | 4 patch-era lessons intact, migrated to `ctx.setCameraTarget` |
| `src/viz/modules/constants.js` | New Phase-58 named constants, LOCKED constants untouched | VERIFIED | `HOVER_LAMBDA`, `HOVER_OVERSHOOT`, `CAM_POS_LAMBDA`, `CAM_LOOKAT_LAMBDA`, `LABEL_TOP_N`, `LABEL_DISTANCE_THRESHOLD`, `LABEL_COLOR`, `MATCAP_MIX_LAMBDA`, `ALPHA_TEST_THRESHOLD`, `FOCUS_DIM_OPACITY`, `FOCUS_FOG_NEAR` all present; `FOCUS_ANTICIPATION_PCT`/`FOCUS_ORBIT_MS`/`FOCUS_DOLLY_MS` correctly removed post-override |
| `src/viz/vendor/troika/*.esm.js` (5 files) | Vendored troika-three-text + deps, CDN fallback patched | VERIFIED, WARNING on one edge case | Vendored, patched (`getFontsForString` neutralized). CR-01: the patch's uncovered-glyph continuation never completes for non-Latin schema text — see Anti-Patterns |
| `src/viz/vendor/fonts/JetBrainsMono-Regular.ttf` | Vendored humanist mono font | VERIFIED | Present, 273900 bytes, OFL-1.1 per SUMMARY |
| `src/viz/vendor/matcaps/focus-matcap.png` | Script-generated grayscale matcap | VERIFIED | Present, 17072 bytes, `--check` passes live |
| `scripts/gen-matcap.mjs` | Regenerable matcap generator | VERIFIED | Runs and passes `--check` live |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `graph.js` haze hover/click raycast | `ctx.hazeRayProxy` | `intersectObject(ctx.hazeRayProxy, false)` | WIRED | Both call sites confirmed (lines 1071, 1156); no remaining `intersectObject(ctx.hazeMesh` |
| `labels.js` | `troika-three-text.esm.js` | `import { Text } from '../vendor/troika/...'` | WIRED | Confirmed; also imports `constants.js` only — no CDN |
| `app.js` | `labels.js` | `initLabels(ctx)` called after `initGraph`/`initLod` | WIRED | `app.js:28,237` |
| `detail.js` selectNode | `graph.js` matcap/focus-geo helpers | `setMatcapTarget`, `focusNodeGeometry` | WIRED (with WR-02 caveat) | Works for pre-existing meshes; same-click newly-revealed member meshes miss the uniform for one tick (see Anti-Patterns) |
| `detail.js`/`graph.js`/`transition.js` | `camera.js` | `ctx.setCameraTarget(pos, lookAt)` | WIRED | All 4 call sites confirmed via grep; `search.js` needs no change (routes through `selectNode`) |
| `camera.js` registerTick | `OrbitControls` | `'start'` event → `active = false` | WIRED | Confirmed present (line 124), regression-tested |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|---------------------|--------|
| `labels.js` | `schemaNodes` (top-N by member count) | `ctx.schemaMembers` (built in `lod.js` from real `abstracts` edges in the `/graph` payload) | Yes | FLOWING |
| `graph.js` matcap | `uMatcapMix` uniform | `detail.js` `registerTick` damp driven by real selection state | Yes | FLOWING |
| `camera.js` | damped position/lookAt | Real `ctx.setCameraTarget` calls from focus/recenter/transition, not static | Yes | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Vendored troika CDN fallback neutralized | `grep cdn.jsdelivr troika-three-text.esm.js` | Only occurrence is inside a commented-out debug block (line 1944); the live fallback path resolves via the patched factory (line 463-471) | PASS |
| Matcap asset grayscale + regenerable | `node scripts/gen-matcap.mjs --check` | `gen-matcap --check: OK — grayscale, byte-identical to the generator` | PASS |
| TypeScript clean | `npx tsc --noEmit` | Exit 0, no output | PASS |
| Scoped viz test suite | `npx vitest run tests/viz-camera-damp.test.ts tests/viz-detail-focus-camera.test.ts tests/viz-haze-activation.test.ts tests/viz-haze-selection.test.ts tests/viz-labels-selection.test.ts tests/viz-seed-determinism.test.ts tests/viz-activity-palette-invariants.test.ts` | 7 files / 62 tests passed | PASS |
| Full repo test suite | `npx vitest run` | 174 files passed / 1 skipped; 2615 tests passed / 3 skipped, 0 failed | PASS |
| D-06 override landed in code | `grep FOCUS_ORBIT_MS constants.js` | No matches (correctly removed) | PASS |

### Probe Execution

No `scripts/*/tests/probe-*.sh`-style probes declared or discovered for this phase. Skipped — not applicable (viz/frontend phase, not a migration/CLI-tooling phase).

### Requirements Coverage

REQUIREMENTS.md does not track this phase (v9.0 tracks the unrelated engine milestone, per phase instructions). Traced instead against `58-CONTEXT.md`'s D-01..D-16 decisions and the roadmap's `HAZE-IMPOSTOR`/`HOVER-DAMP` IDs — see Observable Truths table above for per-ID status. No orphaned requirement IDs found: all of D-01..D-16, HAZE-IMPOSTOR, HOVER-DAMP appear in at least one plan's `requirements-completed` frontmatter across the 8 SUMMARYs.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/viz/vendor/troika/troika-three-text.esm.js` | 463-471, 687-707 | CR-01 (58-REVIEW.md): neutralized CDN patch's `getFontsForString` resolves `fontUrls: []`, but `resolveFallbacks`'s `.then` handler only calls `allDone()` from inside a `fontUrls.forEach` loop — with zero URLs the loop body never runs, so `allDone()` never fires. Any label text with a codepoint outside JetBrains Mono (schema `node.value` is LLM-extracted from arbitrary user content per `labels.js:84`, so non-Latin text is reachable) silently wedges that `Text` instance's sync pipeline forever. | WARNING (advisory per phase context; recommend a near-term fix pass) | Confirmed still present and unfixed in current source (verified directly, not fixed by any commit after `9011a82`) |
| `src/viz/modules/detail.js` | 618-649 | WR-01 (58-REVIEW.md): schema-node selection's `clearFocusDim()` call reverts the D-07 haze-recede + fog-tightening before re-dimming only node materials — schema super-node selection (the most prominent node class) doesn't get the focus-depth cue every other selection gets | WARNING | Confirmed present in current source |
| `src/viz/modules/detail.js` / `src/viz/modules/graph.js` | 157-162 / 153-173 | WR-02 (58-REVIEW.md): `matcapMixUniform` is created at first-render (`onBeforeCompile`), so 1-hop member meshes newly revealed by the same schema-drill-in click miss the matcap fade for that selection (uniform doesn't exist yet when `setMatcapTarget` runs synchronously) | WARNING | Confirmed present in current source |
| `src/viz/modules/labels.js` | 38-39 | WR-03 (58-REVIEW.md): `FONT_URL` is document-relative, not module-relative as its comment claims; works today only because the app is served at origin root | WARNING | Confirmed present in current source; low risk while served at `/` |
| `src/viz/server.ts` | 192-197 | WR-04 (58-REVIEW.md): new `.png`/`.ttf` vendored assets served as `text/plain` (mime map has no png/ttf case); survives only via browser sniffing leniency | WARNING | Confirmed a real gap; not yet exploited/broken |
| Various | — | IN-01..IN-06 (58-REVIEW.md) | INFO | See 58-REVIEW.md for full detail; none block the phase goal |

No `TBD`/`FIXME`/`XXX` unresolved debt markers found in any phase-58-touched file (the review findings above are documented in `58-REVIEW.md`, not left as in-code markers).

### Human Verification Required

### 1. Before/after fps baseline (D-16)

**Test:** Load the live viz install, observe fps overlay at overview-idle and at focus-interaction (clicking/hovering nodes), record both numbers.
**Expected:** Overview-idle ~24fps, focus-interaction ~60fps, no measurable regression from the pre-phase state (targets stated in `58-CONTEXT.md` D-16).
**Why human:** Requires a live browser session with a frame-rate overlay; cannot be statically verified from source. Never captured at any point in the phase (58-01-SUMMARY.md and 58-08-SUMMARY.md both explicitly record this as not done) despite the new per-frame shader/tick work added (billboard fragment shader, matcap `onBeforeCompile` extension, label distance-fade tick, damped camera/hover ticks) creating genuine (if likely modest) perf risk at the stated 17k-node scale.

### 2. D-14 durable visual evidence (screenshots + recordings)

**Test:** Capture screenshots of haze/labels/matcap and short screen recordings of hover, focus flight, and the brain↔corpus transition.
**Expected:** Visual artifacts exist in the planning record for a future reviewer who wasn't present at the live checkpoints.
**Why human:** The founder already did review live and gave real, substantive approval at both checkpoints (58-05: blanket "approved"; 58-08: 3 rounds with 2 concrete fixes, final "approved") — this genuinely satisfies the checkpoint's intent. What's missing is only the specific artifact format (screenshots/recordings) the plan called for as the durable record. Lower priority than item 1 since the substantive human verification already happened.

### Gaps Summary

No functional truth failed: every rendering technique named in the phase goal (haze billboard impostors, troika SDF labels, focus-tier matcap, damped hover, damped interruptible camera, transition re-drive, focus depth deepening) is present in the codebase, wired end-to-end, unit-tested, and green across the full 2615-test suite plus `tsc --noEmit`. The founder's explicit in-session override of D-06 (two-phase orbit-then-dolly → single continuous damped move, 58-08 round 2) is treated as an accepted decision, not a gap, per the phase context supplied for this verification.

Two of the sixteen named decisions (D-14 evidence artifacts, D-16 perf measurement) were never fulfilled and are honestly recorded as such in the SUMMARYs rather than fabricated — routed to human verification above rather than blocking. A code review (`58-REVIEW.md`, dated after all 8 plans closed) found one still-unfixed Critical (CR-01: vendored troika's uncovered-glyph fallback path can permanently wedge a label's render pipeline for non-Latin schema text) and four Warnings (schema-selection focus-depth inconsistency, matcap same-click-reveal miss, font-URL fragility, asset MIME-type gap) — all confirmed still present in current source by this verification, all classified as advisory/WARNING per the phase's own framing that a fix pass may follow phase completion rather than block it.

---

_Verified: 2026-07-05T20:35:00Z_
_Verifier: Claude (gsd-verifier)_
