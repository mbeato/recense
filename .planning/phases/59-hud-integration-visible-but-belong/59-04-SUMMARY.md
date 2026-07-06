---
phase: 59-hud-integration-visible-but-belong
plan: 04
subsystem: ui
tags: [dom-restructure, glass-morphism, viz, vanilla-css, command-palette]

# Dependency graph
requires:
  - phase: 59-01
    provides: HUD_CSS_TOKENS single-source object, emitHudTokens() runtime :root injector
  - phase: 59-02
    provides: Exhaustive var()-token stylesheet, D-12 glass recipe proven on #detail/#settings-panel/#reader
  - phase: 59-03
    provides: "⌘K palette (ctx.openPalette), ctx.toggleLog/ctx.toggleTombstones/ctx.listTopics/ctx.selectNode reusable callables"
provides:
  - "D-01 overlay footprint live: #hud-chip (top-left status), #hud-rail (mid-right icon rail), #topics-rail (left-edge hover-expand schema browser)"
  - "Old #panel/#search-wrap/#topic-wrap/#btn-tombstones/#btn-log/.legend DOM fully deleted"
  - "#btn-corpus/#btn-recenter renamed into the rail as #rail-corpus/#rail-recenter, absorbing both former floating corner buttons"
  - "Rail magnifier wired to ctx.openPalette (D-03 single search surface)"
affects: [59-05, 59-06]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Icon-only rail buttons keep their pre-existing element ids where the plan's verify gate allowed it (#btn-reader/#btn-settings unchanged) but renamed ids where the gate explicitly required deletion (#btn-corpus -> #rail-corpus, #btn-recenter -> #rail-recenter) — the rename ripples through the owning module's getElementById lookup + its CSS selectors + any test asserting the literal id, all updated together in one commit to keep the suite green at every commit boundary"
    - "Icon-only reader toggle communicates open/closed state via aria-label/title updates instead of textContent, since overwriting textContent on an SVG-only button would destroy the icon"

key-files:
  created: []
  modified: [src/viz/index.html, src/viz/modules/hud.js, src/viz/modules/topics.js, src/viz/css/styles.css, src/viz/modules/corpus.js, src/viz/modules/graph.js, src/viz/modules/reader.js, src/viz/modules/app.js, src/viz/modules/detail.js, tests/viz-corpus-graph.test.ts, tests/viz-frontend-static.test.ts, tests/viz-activity-palette-invariants.test.ts]

key-decisions:
  - "#btn-corpus -> #rail-corpus and #btn-recenter -> #rail-recenter: the plan's own Task 1 verify script asserts id=\"btn-corpus\"/id=\"btn-recenter\" are ABSENT from index.html, which is incompatible with reusing those exact ids inside the rail; renamed instead, with corpus.js/graph.js's DOM lookups, the corresponding CSS selectors, and the 3 tests that asserted the old literal id all updated in the same logical commit"
  - "#btn-reader/#btn-settings ids left unchanged (not in the plan's delete-list) — only their markup became icon-only and their position moved into #hud-rail; reader.js's open/close label swap was changed from textContent (would have overwritten the SVG) to aria-label/title updates"
  - "#panel deleted outright (not kept as an empty compat container) — its status/actions/search/topic internals are now three independent elements (#hud-chip/#hud-rail/#topics-rail); corpus.js's setTopicsSearchHidden (which hid #panel/#topic-wrap/#search-wrap while the corpus view is open) was re-targeted to #hud-chip/#topics-rail to preserve the no-overlap-with-index-sidebar behavior"
  - "Compact/popover media query: #hud-chip and #topics-rail are hidden outright; #hud-rail's own glass chrome (background/border/blur/shadow) is collapsed to nothing but #rail-recenter is kept reachable with its own fixed position, replicating the pre-Phase-59 standalone #btn-recenter popover exception the RESEARCH doc explicitly called out (Pitfall 7)"
  - "D-14-C backdrop-filter allow-list test (from Plan 02) updated from its placeholder-guessed selector names (#chip/#rail/#rails) to the actual #hud-chip/#hud-rail/#topics-rail this plan landed"

requirements-completed: [D-01, D-02, D-03, D-13]

duration: ~11min
completed: 2026-07-06
---

# Phase 59 Plan 04: Chip/Rail/Topics-Rail DOM Restructure Summary

**Overlay DOM restructured into the D-01 footprint — top-left #hud-chip status, mid-right #hud-rail icon rail absorbing both former floating corner buttons, left-edge #topics-rail — with the old #panel/search-box/topic-list/dev-button DOM fully deleted and every glass surface on the UI-SPEC ambient-tier token recipe**

## Performance

- **Duration:** ~11 min
- **Completed:** 2026-07-06T03:50:51Z
- **Tasks:** 3 completed
- **Files modified:** 12 (3 planned + 9 consequential deviation fixes)

## Accomplishments
- `#hud-chip` (top-left): SSE dot + live node count + a hover-fold legend (absorbed from the old bottom-left `.legend` pill) — recedes to ambient opacity, reveals on hover (D-13)
- `#hud-rail` (mid-right, docked): 5 icon buttons — reader/settings/corpus/recenter/search — one glass surface absorbing what used to be two separate floating corner buttons (`#btn-corpus`/`#btn-recenter`) plus the panel's text-label reader/settings buttons; the new search magnifier opens the ⌘K palette (D-03 single search surface)
- `#topics-rail` (left edge): slim collapsed strip that expands on hover, rendering `ctx.listTopics()` rows and routing selection through `ctx.selectNode`
- Old chrome fully deleted: `#panel`, `#search-wrap`/`#search-results`, `#topic-wrap`/`#topic-header`/`#topic-list`, `#btn-tombstones`, `#btn-log`, the bottom-left `.legend` block — their surviving logic (SSE status, event log, tombstone filter, schema browsing) now lives entirely behind `ctx.toggleLog`/`ctx.toggleTombstones`/`ctx.listTopics` (Plan 03) with zero DOM-button ownership
- All three new surfaces use the ambient-tier glass recipe (`var(--glass-bg-ambient)`/`var(--glass-border)`/`blur(var(--glass-blur-sm))`/`var(--glass-specular)`/`var(--radius-md)`), currentColor icons (never amber), and are fully reachable by the compact `@media` popover gate (Pitfall 7) — except `#rail-recenter`, which stays reachable in the tray popover exactly as the old standalone `#btn-recenter` did

## Task Commits

Each task was committed atomically:

1. **Task 1: index.html DOM restructure — add chip/rail/topics-rail, delete old chrome** - `2ea57c5` (feat)
2. **Task 2: Re-home hud.js status to chip; wire rail icons; render topics rail** - `66cefaf` (feat)
3. **Task 3: Chip/rail/topics-rail glass CSS + dock positions + compact gating** - `d66dd54` (feat, bundles the consequential id-rename ripple — see Deviations)
4. **Doc fix: stale comment cleanup** - `1351a77` (docs)

## Files Created/Modified
- `src/viz/index.html` - New `#hud-chip`/`#hud-rail`/`#topics-rail` DOM; deleted `#panel`, `#search-wrap`/`#search-results`, `#topic-wrap`, `#btn-tombstones`, `#btn-log`, `.legend`; renamed `#btn-corpus`→`#rail-corpus`, `#btn-recenter`→`#rail-recenter` inside the rail; `#btn-reader`/`#btn-settings` converted to icon-only markup, same ids
- `src/viz/modules/hud.js` - Removed dev-button click bindings (`#btn-log`/`#btn-tombstones` no longer exist); wired the rail magnifier (`#btn-search`) to `ctx.openPalette()`; SSE-dot/node-count writes unchanged (same element ids, now inside `#hud-chip`)
- `src/viz/modules/topics.js` - Renders `ctx.listTopics()` rows directly into `#topics-rail` (was `#topic-wrap`/`#topic-list`)
- `src/viz/css/styles.css` - New `#hud-chip`/`#hud-rail`/`#topics-rail` ambient-glass rules + hover-fold/expand behavior; removed the dead `#panel`/`.legend`/`#search-*`/`#topic-wrap`/`#topic-header`/old-`#btn-corpus`/old-`#btn-recenter` rules; rewrote the compact `@media` block for the new chrome with the `#rail-recenter`-stays-reachable exception; `.stat` now uses the vendored `JetBrains Mono HUD` font
- `src/viz/modules/corpus.js` - `getElementById('btn-corpus')` → `getElementById('rail-corpus')`; `setTopicsSearchHidden` re-targeted from the deleted `#panel`/`#topic-wrap`/`#search-wrap` to `#hud-chip`/`#topics-rail`
- `src/viz/modules/graph.js` - `getElementById('btn-recenter')` → `getElementById('rail-recenter')`
- `src/viz/modules/reader.js` - Icon-only `#btn-reader` toggle now updates `aria-label`/`title` on open/close instead of `textContent` (which would have overwritten the SVG icon)
- `src/viz/modules/app.js`, `src/viz/modules/detail.js` - Stale comments referencing the old `#btn-corpus`/`#btn-recenter`/`#btn-tombstones` ids updated
- `tests/viz-corpus-graph.test.ts` - 3 assertions updated from the literal `btn-corpus` string to `rail-corpus`/`#hud-rail`
- `tests/viz-frontend-static.test.ts` - Chrome-id-skeleton test updated from `id="panel"` to `id="hud-chip"`/`id="hud-rail"`/`id="topics-rail"`
- `tests/viz-activity-palette-invariants.test.ts` - D-14-C backdrop-filter allow-list updated from Plan 02's placeholder-guessed selector names to the actual `#hud-chip`/`#hud-rail`/`#topics-rail`

## Decisions Made
See `key-decisions` in frontmatter. In short: renamed `#btn-corpus`/`#btn-recenter` (the plan's own verify gate required their absence) while leaving `#btn-reader`/`#btn-settings` untouched; deleted `#panel` outright rather than keeping an empty compat shell; re-targeted `corpus.js`'s HUD-hiding logic to the new elements; preserved the tray-popover recenter exception; updated the one pre-existing test whose selector allow-list had only guessed at this plan's eventual naming.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `#btn-corpus`/`#btn-recenter` rename required updating `corpus.js`/`graph.js`'s DOM lookups**
- **Found during:** Task 1 verification — the plan's own automated check explicitly asserts `id="btn-corpus"` and `id="btn-recenter"` are ABSENT from `index.html` after the restructure, which is incompatible with moving those exact buttons into the rail unchanged.
- **Fix:** Renamed the ids to `#rail-corpus`/`#rail-recenter` in `index.html`, and updated `corpus.js`'s and `graph.js`'s `getElementById` calls to match. Icon markup, click-handler logic, and toggle behavior (book/brain icon swap, `corpus-active` class) are unchanged — only the id + its two lookup sites moved.
- **Files modified:** `src/viz/modules/corpus.js`, `src/viz/modules/graph.js` (plus their referencing CSS/tests, see below)
- **Verification:** `npm test` full suite green; manual grep confirms zero remaining `getElementById('btn-corpus')`/`getElementById('btn-recenter')` calls
- **Committed in:** `2ea57c5` (id rename in HTML), `d66dd54` (JS lookup + CSS + test updates)

**2. [Rule 1 - Bug] Icon-only `#btn-reader` toggle would have destroyed its own SVG icon**
- **Found during:** Task 1/2 — converting `#btn-reader` from a text button ("Reader"/"Brain") to an icon-only rail button
- **Issue:** `reader.js`'s `show()`/`hide()` set `btn.textContent = 'Brain'`/`'Reader'` on open/close. Once the button became icon-only, this would silently overwrite the SVG with plain text on the very first toggle.
- **Fix:** Replaced the `textContent` writes with `aria-label`/`title` updates ("Open reader"/"Close reader"), preserving the icon and improving the accessible name to reflect state.
- **Files modified:** `src/viz/modules/reader.js`
- **Verification:** `npm test` full suite green (no test asserted the old textContent values — the "Show tombstones"/"Hide tombstones" exact-copy assertions were already dropped per `viz-frontend-static.test.ts`'s own header note; no equivalent existed for reader's label)
- **Committed in:** `d66dd54`

**3. [Rule 1 - Bug] `corpus.js`'s HUD-hiding logic silently broke once `#panel`/`#topic-wrap`/`#search-wrap` were deleted**
- **Found during:** Task 1 — reviewing `corpus.js`'s `setTopicsSearchHidden` (hides the brain's HUD while the corpus/index-sidebar view is open, so they don't overlap)
- **Issue:** The function looked up `#panel`/`#topic-wrap`/`#search-wrap` by id; all three were deleted by this plan's DOM restructure. The lookups already null-guarded (no crash), but the hide/show behavior would have become a silent no-op — the new `#hud-chip`/`#topics-rail` would stay visible on top of the index sidebar in corpus view, a visual regression directly caused by this plan's own restructure.
- **Fix:** Re-targeted the function to `#hud-chip`/`#topics-rail` (the elements that now hold the content the old function was hiding).
- **Files modified:** `src/viz/modules/corpus.js`
- **Verification:** `npm test` full suite green; behavior preserved by inspection (same hide/show semantics, new element ids)
- **Committed in:** `d66dd54`

**4. [Rule 1 - Bug] Pre-existing tests broken by the intentional DOM/CSS rename**
- **Found during:** Task 3 verification pass (`npm test`)
- **Issue:** Three tests asserted literal strings tied to the DOM this plan intentionally restructured: `tests/viz-corpus-graph.test.ts` asserted `'btn-corpus'`/`'#btn-corpus'`/`.mode-window #btn-corpus`; `tests/viz-frontend-static.test.ts` asserted `id="panel"`; `tests/viz-activity-palette-invariants.test.ts`'s D-14-C backdrop-filter allow-list only included Plan 02's placeholder-guessed names (`#chip`/`#rail`/`#rails`), not the actual `#hud-chip`/`#hud-rail`/`#topics-rail` this plan landed.
- **Fix:** Updated all three to assert the new/renamed selectors, preserving each test's original verification intent (corpus button ownership, chrome-id skeleton, glass-surface allow-list).
- **Files modified:** `tests/viz-corpus-graph.test.ts`, `tests/viz-frontend-static.test.ts`, `tests/viz-activity-palette-invariants.test.ts`
- **Verification:** `npm test` — full suite 2639 passed / 4 skipped (same count as pre-Plan-04 baseline + the 10 Plan-03 palette tests), `npx tsc --noEmit -p .` clean
- **Committed in:** `d66dd54`

---

**Total deviations:** 4 auto-fixed (2 blocking id-rename ripples, 2 bug fixes directly caused by this plan's own DOM restructure)
**Impact on plan:** All four are necessary consequences of the plan's own explicit instructions (Task 1's verify gate requires the old ids gone; the DOM restructure itself orphans corpus.js's hide-logic and reader.js's textContent toggle). No scope creep beyond what the restructure required — every touched file traces directly to an id this plan renamed or deleted.

## Issues Encountered

`.planning/phases/59-hud-integration-visible-but-belong/59-UI-SPEC.md` and `59-PATTERNS.md` (referenced by the plan's `<context>` block) are not tracked in git and were absent from this worktree at spawn time (`.planning/` is gitignored; only specific plan/summary files are force-added). Read directly from the main checkout (`/Users/vtx/brain-memory/.planning/...`) instead — both files existed there and matched what Plans 01-03's summaries described consuming.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- The D-01 chrome footprint (chip/rail/topics-rail) is fully live and glass-styled; Plan 05/06 can build directly on `#hud-chip`/`#hud-rail`/`#topics-rail` for any remaining recede/idle-timeout or ratchet-tuning work without further DOM changes
- Manual/live verification (scene center clear, chip hover-legend, all 5 rail icons working, topics-rail hover-expand, nothing in the tray popover except the recenter icon) was not performed live in this automated pass — this plan is fully autonomous with no checkpoint; all acceptance criteria are machine-verified (grep gates, D-14/D-11/D-10 invariants, full suite, tsc). The phase's closing founder checkpoint is the natural point for this live check.
- No blockers.

---
*Phase: 59-hud-integration-visible-but-belong*
*Completed: 2026-07-06*

## Self-Check: PASSED

All 12 created/modified files found on disk; all 4 commits (2ea57c5, 66cefaf, d66dd54, 1351a77) verified present in git log.
