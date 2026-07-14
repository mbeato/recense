---
task: 260714-g0s
description: move stats entry point from settings panel to HUD rail histogram button
status: complete
completed: 2026-07-14
key-files:
  created: []
  modified:
    - src/viz/index.html
    - src/viz/modules/hud.js
    - src/viz/modules/settings.js
    - src/viz/css/styles.css
    - tests/viz-settings-panel.test.ts
    - tests/viz-frontend-static.test.ts
---

# Quick Task 260714-g0s: Stats entry point → HUD rail

Founder decision (2026-07-14, post Phase-60 gap closure): "usage is fine — move it out
of settings and add it to the rail maybe with like histogram icon." Revises Phase 60
D-04 (settings-panel link) in favor of a first-class rail entry point.

## What was done

- **`#rail-stats` histogram button** added to `#hud-rail` in `index.html`, between
  `#rail-corpus` and `#rail-recenter` (view-opening cluster). 16x16 inline SVG,
  three vertical bars + baseline, stroke `currentColor` — matches the rail icon
  convention. `aria-label`/`title`: "Open usage stats".
- **Wiring** in `hud.js`: `btnStats` ref + click → `ctx.openStatsDashboard()` with a
  `typeof` guard (mirrors the `#btn-search` → `ctx.openPalette()` precedent). Opens
  on the Usage tab (dashboard default).
- **Settings link removed**: `.settings-usage-link` anchor creation/wiring deleted
  from `settings.js`; its CSS rule (+ `:hover`) deleted from `styles.css`. The
  per-toggle usage lines (`appendUsageLines`, 3 call sites) are untouched.
- **Tests**: `viz-settings-panel.test.ts` now asserts the link is GONE;
  `viz-frontend-static.test.ts` asserts `#rail-stats` exists in the markup and
  `hud.js` wires it to `openStatsDashboard`.
- No new CSS for the button itself — the existing `#hud-rail button` base styles
  apply, and the compact-popover rule (`#hud-rail button { display: none; }`, only
  `#rail-recenter` re-shown) auto-hides it in the tray popover.
- The ⌘K "Open stats" palette command is unchanged.

## Commits

- `d49d117` feat(260714-g0s): add #rail-stats histogram button wired to openStatsDashboard
- `f0c1ec5` fix(260714-g0s): remove settings-usage-link, entry point moved to rail
- `d00a5e9` test(260714-g0s): assert usage link gone, #rail-stats exists + wired

## Verification

- `npx tsc --noEmit` clean
- `viz-settings-panel`, `viz-frontend-static`, `viz-hud-palette`, `viz-stats-routes`: 92/92
- Post-merge on main tree: full suite 2673 passed / 3 skipped, build clean

## Deviations

None functional. One doc-comment addition to `hud.js`'s header for consistency.
Note: the executor's worktree SUMMARY.md was not rescued before worktree removal;
this summary was reconstructed by the orchestrator from the executor's final report.
