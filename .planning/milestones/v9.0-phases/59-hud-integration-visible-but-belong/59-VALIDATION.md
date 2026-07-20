---
phase: 59
slug: hud-integration-visible-but-belong
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-07-05
---

# Phase 59 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Populated from 59-RESEARCH.md § "Validation Architecture" and the six plans' actual `<automated>` commands.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (existing — `vitest.config.ts` present; `tests/viz-activity-palette-invariants.test.ts` already uses `describe/it/expect` from `vitest`) |
| **Config file** | `vitest.config.ts` (repo root) |
| **Quick run command** | `npx vitest run tests/viz-activity-palette-invariants.test.ts` |
| **Full suite command** | `npm test` (runs `vitest run`, per `package.json` `"test": "vitest run"`) |
| **Estimated runtime** | ~15 seconds (quick invariants file ~3s; full suite ~15s) |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run tests/viz-activity-palette-invariants.test.ts` (plus the task's own `<automated>` grep/node check)
- **After every plan wave:** Run `npm test` (full suite — this phase mutates shared `constants.js` and `styles.css`, so the full suite guards Phase 57/58's existing locks)
- **Before `/gsd:verify-work`:** Full suite must be green; D-15 founder checkpoint is the qualitative gate on top
- **Max feedback latency:** ~15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 59-01-01 | 01 | 1 | D-11 / D-14 | — | N/A | unit (ESM import) | `node -e "import('./src/viz/modules/constants.js')…"` | ✅ (extend constants.js) | ⬜ pending |
| 59-01-02 | 01 | 1 | D-10 / D-14 | — | N/A | unit (grep) | `grep hud-tokens / emitHudTokens / @font-face` | ✅ (new css-tokens.js) | ⬜ pending |
| 59-01-03 | 01 | 1 | D-11 / D-10 | — | N/A | unit (source-parse) | `npx vitest run …invariants… -t "D-11"` | ❌ W0 (new describe block) | ⬜ pending |
| 59-02-01 | 02 | 2 | D-14 | — | N/A | unit (ESM import) | `node -e "…HUD_CSS_TOKENS…"` | ✅ (extend constants.js) | ⬜ pending |
| 59-02-02 | 02 | 2 | D-12 / D-14 | — | N/A | unit (CSS source-parse) | `bash -c '…grep unmigrated literals + box-shadow removal…'` | ✅ (styles.css) | ⬜ pending |
| 59-02-03 | 02 | 2 | D-14 | — | N/A | unit (source-parse) | `npx vitest run …invariants… -t "D-14"` | ❌ W0 (new describe block) | ⬜ pending |
| 59-03-01 | 03 | 3 | D-02 / D-03 / D-07 | T-59-03 | textContent-only fetch helpers | unit (grep) | `grep ctx.searchNodes / ctx.listTopics / ctx.toggle*` | ✅ (search/topics/hud.js) | ⬜ pending |
| 59-03-02 | 03 | 3 | D-04 / D-05 / D-06 / D-07 | T-59-03 | textContent/createElement render; no innerHTML | unit (matcher) + grep | `npx vitest run tests/viz-hud-palette.test.ts` + D-06 view-switch grep | ❌ W0 (new test file) | ⬜ pending |
| 59-03-03 | 03 | 3 | D-13 / D-14 | — | N/A | unit (grep + invariants) | `bash -c '…#palette glass + compact gate…'` + invariants | ✅ (styles.css) | ⬜ pending |
| 59-04-01 | 04 | 4 | D-01 / D-02 / D-03 | T-59-05 | N/A | unit (grep) | `bash -c '…chip/rail/topics-rail added, old chrome deleted…'` | ✅ (index.html) | ⬜ pending |
| 59-04-02 | 04 | 4 | D-01 / D-02 | T-59-05 | textContent-only chip/topics render | unit (grep) | `bash -c '…hud-chip re-home, btn bindings gone…'` | ✅ (hud/topics.js) | ⬜ pending |
| 59-04-03 | 04 | 4 | D-01 / D-12 / D-13 / D-14 | — | N/A | unit (grep + invariants) | `bash -c '…chip/rail glass, compact gate, no preserve-3d…'` + invariants | ✅ (styles.css) | ⬜ pending |
| 59-05-01 | 05 | 5 | D-08 | — | N/A | unit (grep) | `bash -c '…isCameraInFlight / msSinceActive / 1200 unchanged…'` | ✅ (camera/stats.js) | ⬜ pending |
| 59-05-02 | 05 | 5 | D-08 / D-09 / D-10 | — | N/A | unit (grep) | `bash -c '…initHudRecede, no SSE/trace read…'` | ✅ (new hud-recede.js) | ⬜ pending |
| 59-05-03 | 05 | 5 | D-09 / D-11 | — | N/A | unit (grep) | `bash -c '…hud-receded opacity-only, no layout props…'` | ✅ (styles.css) | ⬜ pending |
| 59-06-01 | 06 | 6 | all | T-59-SC | full-suite green + anti-slop scans | integration (full suite) | `bash -c 'npm test … invariants … emoji scan'` | ✅ | ⬜ pending |
| 59-06-02 | 06 | 6 | D-15 | — | founder eyeball | manual (checkpoint) | manual-only — D-15 live-install founder judgment + evidence capture | n/a | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*
*Sampling continuity: no run of 3 consecutive tasks lacks an `<automated>` verify (only 59-06-02 is manual, and it is terminal).*

---

## Wave 0 Requirements

- [ ] `tests/viz-hud-palette.test.ts` — NEW file created in 59-03 Task 2; unit tests for the palette `fuzzyScore`/`filterSection` pure functions (this is the Wave 0 gap for 59-03-02).
- [ ] `tests/viz-activity-palette-invariants.test.ts` — EXTEND (not new file) with `describe('D-11 …')` (59-01 Task 3) and `describe('D-14 …')` (59-02 Task 3) blocks; canonical_refs direct extension of the existing Phase-57 invariants file.
- [ ] No framework install needed — Vitest already present and configured.

*Note: the two invariants `describe` blocks (D-11, D-14) are authored in Wave 1/2 as part of their own plans; downstream tasks that assert `-t "D-11"` / `-t "D-14"` depend on those blocks existing first.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Auto-recede *feel* — chrome fades to hairline ghosts on idle + camera-flight, returns instantly on mouse-move | D-08 / D-09 | Timing/opacity feel is a founder-tunable eyeball judgment; CONTEXT.md D-15 designates it a live-install checkpoint, not an automated pixel test (Phase 57 D-15 precedent rejects flaky visual assertions). The *structural* guarantee (opacity-only, no layout-shift properties in the recede CSS rule) IS machine-checked in 59-05 Task 3. | On the live install: stop moving the mouse ~4s → chip/rails fade to ghost; move mouse → instant return; trigger a camera fly-to → chrome recedes during flight. |
| Diegetic/screen-space split — only troika labels live in-scene; chip/rails/palette/tooltip are flat glass | D-13 | Visual judgment that nothing *looks* fake-3D. The *structural* guarantee (no `preserve-3d`/`transform-style`/`perspective` CSS3D on any HUD selector) IS machine-checked by the added grep in 59-04 Task 3. | On the live install: confirm no HUD element has fake parallax/CSS3D depth; only the schema labels are in-scene. |
| Glass look + rails + palette + recede judged together on the live install | D-15 | CONTEXT.md D-15 is an explicit single closing founder checkpoint — qualitative aesthetic sign-off, not automatable. | 59-06 Task 2: launch `recense viz`, judge glass/rails/palette/recede; capture screenshots + a short screen recording of recede/palette motion as the evidence record. |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies (only terminal 59-06-02 is manual, by D-15 design)
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references (new palette test file + two invariants `describe` blocks)
- [x] No watch-mode flags (`vitest run`, not `vitest --watch`)
- [x] Feedback latency < 15s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-07-05
