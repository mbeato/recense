---
phase: 34-visual-polish-pass
plan: "01"
subsystem: viz
tags: [css, html, polish, reader, hud, spacing]
requires: []
provides: [sticky-reader-head, hud-declutter-expanded, detail-spacing-normalized]
affects: [src/viz/css/styles.css, src/viz/index.html]
tech_stack:
  added: []
  patterns: [position-sticky-with-bleed-margins, mode-window-display-gate]
key_files:
  created: []
  modified:
    - src/viz/css/styles.css
    - src/viz/index.html
decisions:
  - "margin-bottom: 6px on #reader-head preserves the preexisting sm 'tight gap' exception, not normalized to 8px"
  - "#reader-close and :hover left byte-for-byte unchanged (palette guard — muted mauve/slate, no amber)"
  - ".mode-window #btn-log { display:none } added right after .mode-window #search-wrap block (logical grouping)"
  - "Task 3 plan verify grep used [^}]* multi-line regex that always fails on multi-line CSS — values confirmed correct by direct grep"
metrics:
  duration: "~12 min"
  completed: "2026-06-21"
  tasks_completed: 3
  files_changed: 2
---

# Phase 34 Plan 01: Visual Polish Pass — R1/B2/Detail Spacing Summary

CSS + HTML polish landing sticky reader close, HUD expanded-mode declutter, and 4px-scale spacing normalization in the detail panel.

## Tasks Completed

| # | Name | Commit | Files |
|---|------|--------|-------|
| 1 | R1 — sticky reader close button | b746f83 | src/viz/css/styles.css |
| 2 | B2 — HUD declutter in expanded mode | 1409f11 | src/viz/index.html, src/viz/css/styles.css |
| 3 | Detail panel spacing normalization | 84f890b | src/viz/css/styles.css |

## What Was Built

**Task 1 (R1):** `#reader` padding changed from `22px 26px 40px` to `0 26px 40px` (top relocated into the sticky head). `#reader-head` gains `position: sticky; top: 0; z-index: 1; background: rgba(20, 14, 26, 0.97)` plus bleed margins (`margin-left/right: -26px`) and carries the original top padding (`padding-top: 20px`). The close `×` now stays in view while scrolling long documents. `#reader-close` and its `:hover` state are byte-for-byte unchanged.

**Task 2 (B2):** `<button id="btn-test-trace">` and its HTML comment removed from `.actions-row` in `index.html`. `.mode-window #btn-log { display: none; }` added to CSS — Log hidden in window mode, visible in tray/popover. `#topic-wrap` updated: `margin-top` 12px → 16px (lg token), `border-top: 1px solid rgba(140, 150, 165, 0.08)` and `padding-top: 12px` (md token) added. Expanded-mode actions row now shows only `[Show tombstones] [Reader]`.

**Task 3 (detail spacing):** `.divider` margin normalized from `10px 0` to `12px 0` (md token). `#detail-title` bottom margin normalized from `6px` to `8px` (base token). Both are ≤2px adjustments, no visual regression risk.

## Deviations from Plan

### Auto-fixed Issues

None.

### Notes

- Task 3's plan verification grep (`grep -Eq '\.divider[^}]*margin: 12px 0;'`) assumes a single-line rule. The live CSS is multi-line, so the regex never matches. Values were confirmed correct via direct `grep -n`. No code deviation — the grep was a false-fail in the plan spec.

## Threat Flags

None — pure CSS edits plus one static HTML button removal. No new inputs, endpoints, auth paths, or data flows introduced.

## Known Stubs

None.

## Self-Check: PASSED

- `src/viz/css/styles.css` exists with `position: sticky`, `padding: 0 26px 40px`, `rgba(20, 14, 26, 0.97)`, `.mode-window #btn-log`, `margin-top: 16px`, `margin: 12px 0`, `margin: 8px 0 8px` — all confirmed.
- `src/viz/index.html` does NOT contain `btn-test-trace` — confirmed.
- Commits b746f83, 1409f11, 84f890b exist on main — confirmed.
- No amber added on any rest selector — confirmed (border tint is muted slate rgba(140,150,165,0.08)).
