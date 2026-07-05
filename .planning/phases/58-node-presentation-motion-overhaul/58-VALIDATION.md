---
phase: 58
slug: node-presentation-motion-overhaul
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-07-04
---

# Phase 58 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.8 (`vitest run` via `npm test`) |
| **Config file** | none dedicated — vitest runs against the project tsconfig / `tests/*.test.ts` glob |
| **Quick run command** | `npx vitest run tests/viz-activity-palette-invariants.test.ts` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~30–60 seconds (full suite ~2400 tests) |

---

## Sampling Rate

- **After every task commit:** Run the task's targeted command (see map below) — typically a scoped `npx vitest run tests/viz-*.test.ts` or a `node -e` source-scan / `node scripts/gen-matcap.mjs --check`
- **After every plan wave:** Run `npm test` (full suite — catches regressions in viz-haze-*, viz-seed-determinism, viz-layout-guards)
- **Before `/gsd:verify-work`:** Full suite green + both founder checkpoints (Stage 1 look, Stage 2 motion) signed off
- **Max feedback latency:** ~60 seconds (full suite)

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 58-01-01 | 01 | 1 | D-01 | T-58-SC | 5 [ASSUMED] packages human-verified before vendoring | manual (blocking-human gate) | — (not auto-approvable) | N/A | ⬜ pending |
| 58-01-02 | 01 | 1 | D-01/D-04 | T-58-SC | vendored files present; package.json untouched | source-scan | `test -f src/viz/vendor/troika/troika-three-text.esm.js && grep -q troika-three-text src/viz/index.html` | ✅ | ⬜ pending |
| 58-01-03 | 01 | 1 | D-01 | T-58-01 | troika CDN fallback patched to no-op | source-scan | `node -e "...getFontsForString no-op + T-10-10 marker..."` | ✅ | ⬜ pending |
| 58-02-01 | 02 | 1 | HAZE-IMPOSTOR | T-58-02 | alphaTest+normal blend (no additive stacking past 0.72) | source-scan | `node -e "ShaderMaterial+PlaneGeometry+discard, no AdditiveBlending, hazeRayProxy"` | ✅ | ⬜ pending |
| 58-02-02 | 02 | 1 | HAZE-IMPOSTOR | T-58-02 | haze mocks updated; no LOCKED drift | unit | `npm test -- tests/viz-haze-activation.test.ts tests/viz-haze-selection.test.ts` | ✅ | ⬜ pending |
| 58-03-01 | 03 | 2 | D-01..D-04 | T-58-03 | Text.text plain-string only (no HTML API) | source-scan | `node -e "initLabels+troika import+depthTest+.text=+schemaMembers+LABEL_COLOR+app wiring"` | ✅ | ⬜ pending |
| 58-03-02 | 03 | 2 | D-02/D-15 | — | LABEL_COLOR in-band + non-amber; top-N unit-tested | unit | `npm test -- tests/viz-activity-palette-invariants.test.ts tests/viz-labels-selection.test.ts` | ❌ W0 (new test files) | ⬜ pending |
| 58-04-01 | 04 | 3 | D-09/D-15 | T-58-04 | matcap PNG grayscale (R≈G≈B) | script self-check | `node scripts/gen-matcap.mjs --check` | ❌ W0 (new script) | ⬜ pending |
| 58-04-02 | 04 | 3 | D-10/D-12 | T-58-04 | matcap on shared node program only (not haze); 32-seg geo | source-scan | `node -e "uMatcapMix+uMatcapTex+vViewNormal+_focusGeo, none in buildHazeLayer"` | ✅ | ⬜ pending |
| 58-04-03 | 04 | 3 | D-10/D-11 | — | matcap only on focus+1-hop; damped fade | source-scan + suite | `node -e "detail matcapMix+registerTick+damp+_focusGeo+MATCAP_MIX_LAMBDA"` then `npm test` | ✅ | ⬜ pending |
| 58-05-01 | 05 | 4 | D-13/D-14/D-16 | T-58-01 | Stage-1 look; DevTools zero cdn.jsdelivr.net | manual (founder checkpoint) | — (screenshots + verdict are the record) | N/A | ⬜ pending |
| 58-06-01 | 06 | 5 | D-05 | T-58-05 | one damp system; ms=0 branch; interruptible | unit | `npm test -- tests/viz-camera-damp.test.ts` | ❌ W0 (new test file) | ⬜ pending |
| 58-06-02 | 06 | 5 | D-06 | T-58-05 | orbit-then-dolly; no nonzero-ms in detail | source-scan + suite | `node -e "detail+graph setCameraTarget, no ...800, FOCUS_ORBIT_MS"` then `npm test` | ✅ | ⬜ pending |
| 58-06-03 | 06 | 5 | D-08 | T-58-05 | transition re-drive; 4 lessons intact; search free | source-scan + suite | `node -e "transition setCameraTarget+homeCam+markActive, no search cameraPosition"` then `npm test` | ✅ | ⬜ pending |
| 58-07-01 | 07 | 6 | HOVER-DAMP | — | asymmetric damped hover; frame-rate-independent | source-scan + suite | `node -e "__hoverTarget+registerTick+damp, no HOVER_SCALE snap, HOVER_LAMBDA/OVERSHOOT"` then `npm test` | ✅ | ⬜ pending |
| 58-07-02 | 07 | 6 | D-07 | T-58-06 | dim/fog deepen on focus; restore on deselect | source-scan + suite | `node -e "FOCUS_FOG_NEAR+moved FOCUS_DIM_OPACITY+fog save/restore"` then `npm test` | ✅ | ⬜ pending |
| 58-08-01 | 08 | 7 | D-13/D-14/D-16 | T-58-15 | Stage-2 motion; before/after fps; locks green | manual + suite gate | `npm test` && `node scripts/gen-matcap.mjs --check` (machine locks); recordings are the feel record | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

New test/script scaffolds created inside their owning plans (tightly coupled to the constants/assets they check):

- [ ] `tests/viz-labels-selection.test.ts` — top-N-by-member-count selection (Plan 03 Task 2)
- [ ] `tests/viz-activity-palette-invariants.test.ts` — extend with the D-15 LABEL_COLOR band + non-amber `describe` block (Plan 03 Task 2)
- [ ] `scripts/gen-matcap.mjs --check` — grayscale self-verify mode (Plan 04 Task 1)
- [ ] `tests/viz-camera-damp.test.ts` — damp convergence + mid-flight interruptibility (Plan 06 Task 1)
- [ ] Haze test mocks — add a `PlaneGeometry` stub to `tests/viz-haze-activation.test.ts` and `tests/viz-haze-selection.test.ts` (Plan 02 Task 2)

Existing infrastructure (Vitest + the viz-* test suite) covers all other phase requirements.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Haze reads as atmosphere; no fake flare / rectangular occlusion | HAZE-IMPOSTOR | Visual GPU rendering | Stage-1 checkpoint (Plan 05) — dense-cluster + occlusion screenshots |
| Labels crisp on approach, slate, node-occluded, overview-free | D-01..D-04 | Visual | Stage-1 checkpoint — approach + overview screenshots; troika keep/kill |
| Focus matcap = lit bead on own hue; overview unaffected | D-10 | Visual | Stage-1 checkpoint — selection screenshot |
| No cdn.jsdelivr.net request with labels visible | D-01 / T-58-01 | Requires live DevTools Network panel | Stage-1 checkpoint — record Network result |
| Asymmetric hover (overshoot in, clean out), tier-independent | HOVER-DAMP | Motion feel | Stage-2 checkpoint (Plan 08) — screen recording |
| Orbit-then-dolly focus + mid-flight interruptibility | D-05/D-06 | Motion feel | Stage-2 checkpoint — screen recording (click B mid-flight to A) |
| Transition brain-recedes-first preserved; no idle-drift fight | D-08 | Motion feel | Stage-2 checkpoint — screen recording |
| Before/after fps at both tiers | D-16 | Requires live `S` overlay | Stage-2 checkpoint — one-line comparison vs Plan-01 baseline |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or an explicit MISSING-with-manual-record justification (D-15 UNLOCKED feel constants / founder checkpoints)
- [x] Sampling continuity: no 3 consecutive code tasks without automated verify (every code task has a source-scan or suite command)
- [x] Wave 0 covers all new test/script scaffolds (labels-selection, camera-damp, gen-matcap --check, PlaneGeometry mocks, invariants extension)
- [x] No watch-mode flags
- [x] Feedback latency < 60s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** ready
