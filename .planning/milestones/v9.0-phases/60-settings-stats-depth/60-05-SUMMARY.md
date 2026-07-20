---
phase: 60-settings-stats-depth
plan: 05
subsystem: ui
tags: [vanilla-js, viz, settings-panel, command-palette, stats-dashboard]

requires:
  - phase: 60-03
    provides: "ctx.openStatsDashboard(tab)/closeStatsDashboard()/isStatsDashboardOpen() — stats takeover open/close plumbing — 60-03-SUMMARY.md"
provides:
  - "src/viz/modules/settings.js: initSettings(ctx) threads ctx through render(); the standalone 30d/all-time usage readout is replaced by a single textContent-only 'View usage stats →' link that calls ctx.openStatsDashboard() — per-toggle appendUsageLines (D-09) and fmtTokens are unchanged"
  - "src/viz/modules/palette.js: new 'open-stats' command (label 'Open stats', visibleIn brain/reader/corpus) calling ctx.openStatsDashboard(); currentView() gains a 'stats' branch (checked first, gated on ctx.isStatsDashboardOpen) so the command self-hides while the dashboard is already open"
affects: [60-06]

tech-stack:
  added: []
  patterns:
    - "D-04 single-source-of-truth link pattern: a panel that previously duplicated a number readout now renders a one-line CTA (.settings-usage-link, textContent-only) whose click handler preventDefault()s and calls a ctx-exposed open function guarded by typeof-function check — reusable for any future panel→takeover navigation edge"

key-files:
  created: []
  modified:
    - src/viz/modules/settings.js
    - src/viz/modules/palette.js
    - tests/viz-settings-panel.test.ts

key-decisions:
  - "Updated tests/viz-settings-panel.test.ts's Task 2 describe block (not in the plan's declared files_modified) because the pre-existing 44-06-era tests asserted directly on the now-intentionally-removed .settings-usage-headline/.settings-usage-feature-line/.settings-usage-alltime/.settings-usage-empty elements from appendFullUsageReadout — those elements no longer exist after the D-04 edit, so the tests would fail on old, now-superseded behavior rather than the new link. Replaced with tests asserting the 3 per-toggle .settings-usage-line lines stay, the new .settings-usage-link renders verbatim text and calls ctx.openStatsDashboard on click, and the old readout classes are confirmed absent."
  - "Added an optional 'stats' branch to palette.js's currentView() (Claude's Discretion per plan text), checked before corpus/reader so the open-stats command's visibleIn:['brain','reader','corpus'] naturally excludes it and the command self-hides while the takeover is already open — mirrors the existing corpus/reader precedence pattern, no new coupling beyond the existing ctx.isStatsDashboardOpen accessor from 60-03"
  - "Did not touch src/viz/css/styles.css — PATTERNS.md's snippet comment ('styled per Phase 59 tokens') is aspirational styling guidance, but styles.css is outside this plan's declared files_modified (settings.js, palette.js only) and no acceptance criterion or test requires visual styling; the link renders with browser-default anchor styling until a future plan/founder pass adds the CSS rule"

requirements-completed: [D-04]

duration: ~15min
completed: 2026-07-11
---

# Phase 60 Plan 05: Settings + Palette Stats Entry Points Summary

**Wired both D-04 navigation entry points into the Phase 60-03 stats takeover — settings.js's standalone 30d/all-time usage readout is replaced by a single "View usage stats →" link, and the ⌘K palette gained an "Open stats" command — establishing one source of truth for usage numbers (the dashboard) instead of two.**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-07-11T20:40:00Z (approx.)
- **Completed:** 2026-07-11T20:54:46Z
- **Tasks:** 2 completed
- **Files modified:** 3 (2 declared + 1 test file, see Deviations)

## Accomplishments
- `settings.js`'s `initSettings(_ctx)` renamed to `initSettings(ctx)` and threaded through to `render()`; the duplicate `appendFullUsageReadout` 30d/all-time number block (80 lines) is gone, replaced by a single `.settings-usage-link` anchor with verbatim text `View usage stats →` whose click handler `preventDefault()`s and calls `ctx.openStatsDashboard()` behind a `typeof`-function guard
- Per-toggle `appendUsageLines` (D-09, three call sites: core extract+judge, schema, corpus) is untouched — the settings panel still shows toggle-adjacent cost context, it just no longer duplicates the full 30d/all-time ledger the dashboard now owns
- `palette.js`'s command registry gained `open-stats` (label `Open stats`, `visibleIn: ['brain','reader','corpus']`) calling `ctx.openStatsDashboard()`; `currentView()` gained a `stats` branch (checked first, gated on `ctx.isStatsDashboardOpen`) so the command hides itself once the dashboard is already open — same self-hiding pattern the existing `recenter`/`open-corpus` visibleIn entries establish

## Task Commits

Each task was committed atomically:

1. **Task 1: settings.js D-04 link replacement** - `c5a7ce0` (feat)
2. **Task 2: palette.js Open stats command** - `1d6691f` (feat)

**Plan metadata:** (this commit, pending)

## Files Created/Modified
- `src/viz/modules/settings.js` - `initSettings(_ctx)` → `initSettings(ctx)`; render() call site replaces `appendFullUsageReadout(bodyEl, usageData)` with the `.settings-usage-link` CTA; the 80-line `appendFullUsageReadout` function body deleted; `appendUsageLines`/`fmtTokens` unchanged
- `src/viz/modules/palette.js` - appended `open-stats` command entry; `currentView()` gained a `stats` branch gated on `ctx.isStatsDashboardOpen`
- `tests/viz-settings-panel.test.ts` - Task 2 describe block rewritten: removed assertions on the deleted `.settings-usage-headline`/`.settings-usage-feature-line`/`.settings-usage-alltime`/`.settings-usage-empty` elements, added assertions for the 3 per-toggle `.settings-usage-line` lines, the new `.settings-usage-link` verbatim text + click→`ctx.openStatsDashboard` wiring, a no-throw guard when `ctx.openStatsDashboard` is absent, and an explicit "old readout classes absent" check

## Decisions Made
- See `key-decisions` in frontmatter above (test-file update rationale, `currentView()` stats-branch addition, CSS scope boundary)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Updated tests/viz-settings-panel.test.ts's Task 2 suite to match the D-04 behavior change**
- **Found during:** Task 1 (settings.js D-04 link replacement) verification
- **Issue:** The plan's own verify step requires `npx vitest run tests/viz-settings-panel.test.ts` to pass, but the pre-existing test file (written for the 44-06 `appendFullUsageReadout` feature) asserted directly on `.settings-usage-headline`, `.settings-usage-feature-line`, `.settings-usage-alltime`, and `.settings-usage-empty` — all elements that only existed inside the function this plan's own must_haves require deleting. Six of the Task 2 tests would fail deterministically after the correctly-implemented D-04 edit, not because of a bug but because they encode the exact old behavior the plan supersedes.
- **Fix:** Rewrote the "token-usage readout (Task 2)" describe block: kept the `/usage` fetch-on-open test unchanged; added a test asserting the 3 per-toggle `.settings-usage-line` elements still render (D-09); added a new test asserting `.settings-usage-link` renders verbatim `View usage stats →` and its click handler invokes `ctx.openStatsDashboard`; added a no-throw guard test for when `ctx.openStatsDashboard` is absent; added an explicit test that the old readout-block classes no longer render; kept the textContent/no-innerHTML security test; adapted the k/M-abbreviation test to check the per-toggle line text instead of the deleted headline/all-time elements (all-time is no longer rendered by settings.js at all — that data now lives only in the 60-03 dashboard).
- **Files modified:** `tests/viz-settings-panel.test.ts` (not in the plan's declared `files_modified`, which only listed `settings.js`/`palette.js`)
- **Verification:** `npx vitest run tests/viz-settings-panel.test.ts` — 22/22 pass; `npx tsc --noEmit` clean; `npx vitest run tests/viz-settings-panel.test.ts tests/viz-hud-palette.test.ts tests/settings-call-sites.test.ts tests/viz-activity-palette-invariants.test.ts` — 87/87 pass
- **Committed in:** `c5a7ce0` (Task 1 commit, bundled with the settings.js source change since the two are inseparable — a source-only commit would leave the suite red)

---

**Total deviations:** 1 auto-fixed (1 blocking — test-file update required to keep the plan's own verification gate green after the intentional D-04 behavior change)
**Impact on plan:** Necessary and narrowly scoped: only the Task 2 describe block (token-usage readout tests) changed; Task 1 tests (preset/toggle/save behavior, panel guard, show/hide, Escape) are untouched. No test coverage was removed without replacement — every deleted assertion on old readout-block elements has a corresponding new assertion confirming the D-04 replacement behavior (link render + click wiring) or an explicit "old element absent" check.

## Issues Encountered
None beyond the test-file deviation documented above.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None. Both entry points are fully wired to the live `ctx.openStatsDashboard`/`ctx.isStatsDashboardOpen` contract exposed by 60-03; no placeholder data or empty-props components introduced.

## Next Phase Readiness
- Both D-04 navigation entry points (settings-panel link, ⌘K palette command) are live and call the real `ctx.openStatsDashboard()` from 60-03 — no further wiring needed
- `src/viz/css/styles.css` has no `.settings-usage-link` rule yet (out of this plan's declared scope) — a future plan or founder pass can add Phase-59-token styling without any structural change here
- No blockers for 60-06

---
*Phase: 60-settings-stats-depth*
*Completed: 2026-07-11*

## Self-Check: PASSED

- FOUND: src/viz/modules/settings.js
- FOUND: src/viz/modules/palette.js
- FOUND: tests/viz-settings-panel.test.ts
- FOUND: .planning/phases/60-settings-stats-depth/60-05-SUMMARY.md
- FOUND commit: c5a7ce0
- FOUND commit: 1d6691f
- FOUND commit: d07d349
