---
phase: "44"
plan: "06"
subsystem: viz-frontend
tags: [settings-panel, cost-controls, frontend, esm, no-ipc]
dependency_graph:
  requires: [44-05]
  provides: [viz-settings-panel, viz-usage-readout]
  affects: [src/viz/modules/settings.js, src/viz/modules/app.js, src/viz/index.html, src/viz/css/styles.css]
tech_stack:
  added: []
  patterns:
    - "reader.js module pattern (initFoo(ctx), panel guard, show/hide, loaded guard, non-fatal fetch)"
    - "formFields closure avoids querySelectorAll in save()"
    - "textContent-only for all server-sourced values (T-44-19)"
    - "FakeEl DOM shim with real textContent getter/setter semantics for Node tests"
key_files:
  created:
    - src/viz/modules/settings.js
    - tests/viz-settings-panel.test.ts
  modified:
    - src/viz/modules/app.js
    - src/viz/index.html
    - src/viz/css/styles.css
decisions:
  - "D-02: Zero new IPC — settings panel is plain frontend ESM + HTTP only"
  - "D-11: Preset + overrides model; header shows 'Standard (modified)' when overrides non-empty"
  - "D-12: Core (extract + reconsolidation) always-on row, no toggle, enforced in render()"
  - "D-09: Each usage readout line placed adjacent to its controlling toggle"
  - "D-10: Rolling 30d headline + all-time total rendered via appendFullUsageReadout"
  - "T-44-19: textContent-only for all dynamic values; Object.defineProperty innerHTML trap confirms zero writes in tests"
  - "flush() over vi.waitFor(): explicit microtask drain (8 rounds + macrotask) is more reliable than polling for async render chains in a Node shim environment"
metrics:
  duration_minutes: ~90
  completed: "2026-06-25T00:44:08Z"
  tasks_completed: 2
  tasks_total: 3
  files_created: 2
  files_modified: 3
---

# Phase 44 Plan 06: In-App Settings Panel Summary

In-app cost-controls panel for the viz frontend — settings and token-usage readout exposed entirely as browser ESM + HTTP routes (no Electron IPC, no new preload surface, D-02).

## What Was Built

**Task 1 — Settings panel + wiring (ec71266)**

New `src/viz/modules/settings.js` mirrors the `reader.js` module pattern exactly:
- `initSettings(ctx)` with panel guard, show/hide on `btn-settings` click, Escape key, loaded guard (no re-fetch on second open)
- Preset selector (`<select>` with lite/standard/full options)
- Header divergence label: "Standard" vs "Standard (modified)" when overrides are non-empty (D-11)
- Core row: static "core: extract + reconsolidation — always on" label, no checkbox (D-12)
- Schema abstraction and corpus docs toggle rows (`makeToggleRow`) — optional features
- Tuning number inputs for consolSkipThreshold, consolSkipThresholdAssistant, corpusSubjectDriftThreshold, sleepFrequencyHours
- `formFields` array populated during `render()` closure, consumed by `save()` without querySelectorAll
- Save: POST /settings with {preset, overrides}, re-renders from returned effective config
- All server-sourced values rendered via `.textContent` only — zero `.innerHTML` writes (T-44-19)

Wiring:
- `src/viz/modules/app.js`: `import { initSettings }` + `initSettings(ctx)` call at end of module list
- `src/viz/index.html`: `<button id="btn-settings">` in toolbar, `<div id="settings-panel">` with head/body divs
- `src/viz/css/styles.css`: slide-in panel `translateX(-102%) → translateX(0)`, z-index 41 (above reader's 40), graph saturation dim when panel open, all panel internals and usage readout styles

**Task 2 — Token-usage readout (ec71266, same commit)**

Inside `settings.js`:
- `fetchUsage()`: non-fatal GET /usage → null on error
- `appendUsageLines(parent, usageData, featureTags)`: compact per-feature 30d line adjacent to each toggle (D-09)
- `appendFullUsageReadout(parent, usageData)`: full section — 30d headline ("this period you spent 24.0k tokens"), per-feature breakdown (extraction / judging / schema abstraction / corpus docs), all-time total line (D-10)
- Empty-state "no usage recorded yet" when usageData is null or both totals are zero
- `fmtTokens(n)`: 1.5M / 34.5k / plain integer abbreviation

**Test file — 23 tests (ed585a4)**

`tests/viz-settings-panel.test.ts` — minimal FakeEl DOM shim (no jsdom/happy-dom):
- `textContent` getter/setter mirrors real DOM: setter clears `_children`, enabling correct re-render assertions
- `flush()` helper: 8 microtask rounds + setTimeout(0) + 4 more rounds drains the async load/fetch/render chain reliably
- `openAndRender()` shared helper eliminates per-test boilerplate
- Covers: panel guard, show/hide, toggle, Escape, loaded guard, header divergence, core row no-toggle, save POST, re-render, 30d headline, per-feature lines, all-time total, empty-state, k/M abbreviation, no-innerHTML assertion

## Verification

```
✓ 23/23 tests pass: npx vitest run tests/viz-settings-panel.test.ts
✓ tsc --noEmit exits 0 (no type errors)
✓ fetch('/settings') call count ≥ 2 (fetchSettings + save)
✓ fetch('/usage') call count ≥ 1 (fetchUsage)
✓ zero innerHTML writes confirmed by Object.defineProperty trap in T-44-19 test
✓ initSettings imported and called in app.js (grep verified)
✓ #settings-panel in index.html and styles.css (grep verified)
```

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] vi.waitFor DOM polling unreliable in Node.js test environment**
- **Found during:** Task 1 test writing
- **Issue:** Tests using `vi.waitFor(() => findFirst(fakeBody, '.class') !== null)` timed out even when the element was present — the async render chain spans 4+ promise hops (fetch → json × 2 → Promise.all → render) and vi.waitFor's poll interval races against microtask scheduling without a real event loop
- **Fix:** Replaced vi.waitFor with `flush()` helper (8 × Promise.resolve + setTimeout(0) + 4 × Promise.resolve) to explicitly drain the microtask queue; replaced inline vi.waitFor patterns with the `openAndRender()` shared helper
- **Files modified:** tests/viz-settings-panel.test.ts
- **Commit:** ed585a4

**2. [Rule 2 - Missing FakeEl semantics] textContent setter did not clear children**
- **Found during:** "re-renders from the returned effective config after save" test
- **Issue:** Real DOM `element.textContent = ''` removes all child nodes; FakeEl's plain `textContent = ''` property did not, so a second `render()` call appended children ON TOP of the first render instead of replacing them — `findFirst` found the old header from render #1 instead of the new one
- **Fix:** Replaced `textContent = ''` class field with `get textContent()/set textContent(v)` accessor that clears `_children` on every write
- **Files modified:** tests/viz-settings-panel.test.ts
- **Commit:** ed585a4

**3. [Rule 1 - Bug] TypeScript strict checks on regex exec array indices and mock.calls tuples**
- **Found during:** Task 1 + 2 post-commit tsc verification
- **Issue:** `m[1]` typed as `string | undefined` in TS 5.x regex matches; `([url]: [string])` destructuring in `.find`/`.some` callbacks rejected by tsc (array elements are `any[]`, not `[string]` tuples)
- **Fix:** `m[1] ?? ''` for attr; `(args: any[]) => args[0] === ...` for mockFetch.mock.calls callbacks; `get firstChild(): FakeEl | null` explicit return type
- **Files modified:** tests/viz-settings-panel.test.ts
- **Commit:** ed585a4 (amend — same file, test-only)

## Task 3 — PENDING Orchestrator-Driven Human Verification

**Task 3 was intentionally NOT executed.** It is a `checkpoint:human-verify` step with `gate="blocking-human"` requiring a human to visually verify the live panel in a running browser. The orchestrator owns this gate after merge.

**What needs verification:**
- Browser at http://127.0.0.1:7810 — click "Settings" button → panel slides in from left
- Preset selector shows "Standard", toggles show current values from GET /settings
- Save button posts and re-renders with returned effective config
- Token usage section shows 30d headline, per-feature lines, all-time total
- Panel closes on close button, second click on "Settings", and Escape key
- Zero console errors; no innerHTML violations (CSP report check)

**Resume signal:** After human verification, the orchestrator should mark 44-06 complete and advance STATE.md.

## Threat Flags

None — no new network endpoints, no new auth paths, no schema changes. All settings/usage routes were established in 44-05. The only new surface is the frontend panel which reads from those existing routes via plain fetch.

## Self-Check: PASSED

- [x] `src/viz/modules/settings.js` exists: confirmed (created in ec71266)
- [x] `tests/viz-settings-panel.test.ts` exists: confirmed (created in ed585a4)
- [x] `src/viz/modules/app.js` modified: confirmed
- [x] `src/viz/index.html` modified: confirmed
- [x] `src/viz/css/styles.css` modified: confirmed
- [x] Commit ec71266 exists in git log: confirmed
- [x] Commit ed585a4 exists in git log: confirmed
- [x] 23/23 tests pass: confirmed
- [x] tsc --noEmit exits 0: confirmed

## Task 3 — Human visual verification: APPROVED (2026-06-24)

Operator verified the live panel at http://127.0.0.1:7810: panel opens, preset/toggle round-trips with "(modified)" divergence label, Save persists, core shown always-on with no toggle, and the token readout populates by feature. A bug found during verify (per-feature lines rendered 0 because settings.js read a phantom `row.total_tokens`; the /usage route emits `input_tokens`+`output_tokens`) was fixed and re-verified — extraction ~2.5M (~$11.28), judging ~54k (~$0.70), schema/corpus legitimately 0 (no ledger rows yet).
