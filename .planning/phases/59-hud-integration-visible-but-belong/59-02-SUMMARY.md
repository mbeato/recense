---
phase: 59-hud-integration-visible-but-belong
plan: 02
subsystem: ui
tags: [css-custom-properties, design-tokens, viz, glass-morphism, vanilla-css]

# Dependency graph
requires:
  - phase: 59-01
    provides: HUD_CSS_TOKENS single-source object, emitHudTokens() runtime :root injector, D-10/D-11 invariant harness
provides:
  - Every color literal in styles.css migrated to var(--token), sourced exclusively from constants.js's HUD_CSS_TOKENS
  - ~67 new semantic content-color tokens (text/surface/amber/rose/error/hairline families)
  - D-12 glass reskin of #detail/#settings-panel/#reader (background/border/backdrop-filter/specular/radius-lg/motion-slow); 3 elevation box-shadows removed
  - #tooltip token-migrated with zero backdrop-filter/specular (Pitfall 1 deliberate exception)
  - D-14 CSS-scan invariants (literal ban, amber-exclusivity allow-list, backdrop-filter selector allow-list)
affects: [59-03, 59-04, 59-05, 59-06]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Full stylesheet color migration done via a scripted exact-value substitution (literal string -> var(--token)) rather than hand-editing ~1350 lines — safe because every distinct literal was deduped and grouped by exact value first, so the same token is referenced everywhere that value appeared"
    - "Token-per-distinct-value floor honored (not aggressively consolidated to 30-40): ~67 new tokens for ~80 remaining literals, prioritizing zero unintended visual drift over token-count minimalism — the plan's '30-40 is fine' framing is permissive, not a hard ceiling"
    - "box-shadow property REPURPOSED (not just removed) on #detail/#settings-panel/#reader: the old dark elevation shadow becomes the D-12 specular inset top-highlight (var(--glass-specular)); #index-panel (not in the full reskin list) has its box-shadow removed outright with border-right value swapped to var(--glass-border-focused)"

key-files:
  created: []
  modified: [src/viz/modules/constants.js, src/viz/css/styles.css, tests/viz-activity-palette-invariants.test.ts, tests/viz-frontend-static.test.ts]

key-decisions:
  - "Amber family (rgba(217,160,92,*)/#d9a05c) split into a small named set (accent-amber-solid/-tint/-tint-soft/-tint-strong) rather than one single token, per the interfaces note's explicit 'or a small named set' allowance — the D-14-B test allow-lists exactly this set"
  - "Pre-existing gold doc-progress active-step accent (#c8a94a / rgba(200,169,74,*)) tokenized separately (accent-gold-active/-fill) since it's a distinct RGB triple outside the canonical amber-family definition the D-14-B test targets"
  - "#tooltip's border migrated to var(--glass-border) per the plan's explicit interface directive, even though its pre-migration literal (rgba(140,150,165,0.16)) exactly matched glass-border-focused — a minor, plan-directed value change, not a bug"
  - "#reader/#settings-panel border-radius: var(--radius-lg) added (they had no radius before) per the plan's bundled 'apply border-radius var(--radius-lg)' instruction for all three reskinned panels"

requirements-completed: [D-12, D-14]

duration: ~35min
completed: 2026-07-06
---

# Phase 59 Plan 02: Exhaustive CSS Token Migration + Glass Reskin Summary

**Every color literal in styles.css (~80 deduped values) migrated to var(--token) sourced from constants.js's HUD_CSS_TOKENS; #detail/#settings-panel/#reader reskinned with the D-12 glass recipe (3 elevation box-shadows removed, replaced by a specular top-highlight); D-14 CSS-scan invariants lock the discipline machine-checked**

## Performance

- **Duration:** ~35 min
- **Completed:** 2026-07-06
- **Tasks:** 3 completed
- **Files modified:** 4 (3 planned + 1 deviation fix)

## Accomplishments
- `HUD_CSS_TOKENS` in `constants.js` extended with ~67 new semantic content-color tokens (text/surface/amber/gold/type/rose/error/hairline families), covering every distinct color literal found in the pre-migration `styles.css` dedup scan
- Every color-bearing declaration (`background`/`color`/`border`/`box-shadow`/`fill`/`stroke`) in `styles.css` now resolves through `var(--token)` — zero raw hex/rgba literals remain (machine-verified)
- `#detail`, `#settings-panel`, `#reader` reskinned with the full D-12 glass recipe: `background: var(--glass-bg-focused)`, `border(-right): var(--glass-border-focused)`, `backdrop-filter: blur(var(--glass-blur-md))`, `box-shadow: var(--glass-specular)` (repurposing the old elevation-shadow property into the specular top-highlight), `border-radius: var(--radius-lg)`, `transition: var(--motion-slow) var(--ease-out-soft)`
- The 3 elevation drop-shadows (`2px 0 24-28px rgba(0,0,0,0.35)`) at `#reader`/`#settings-panel`/`#index-panel` are gone; `#index-panel` (outside the full reskin list) simply drops its box-shadow and gets its existing `border-right` value swapped to `var(--glass-border-focused)`
- `#tooltip` token-migrated (background/border/radius) with **zero** `backdrop-filter`/`--glass-specular` — the deliberate Pitfall-1 contrast-first exception, comment updated to state this explicitly
- D-14 CSS-scan invariants added to `tests/viz-activity-palette-invariants.test.ts`: literal ban (with a RED-under-injection regression proof), amber-exclusivity (confined to the named `accent-amber-*` set), and backdrop-filter selector allow-list (asserting `#tooltip` has none) — 45/45 tests green in that file, full suite 2629 passed / 4 skipped

## Task Commits

Each task was committed atomically:

1. **Task 1: Catalog + tokenize every remaining color literal in constants.js** - `77434c0` (feat)
2. **Task 2: Migrate styles.css literals to var(); remove box-shadows; glass reskin panels** - `4e6838f` (feat)
3. **Task 3: D-14 CSS-scan invariants** - `9d575b7` (test)

## Files Created/Modified
- `src/viz/modules/constants.js` - Adds ~67 new semantic content-color tokens to `HUD_CSS_TOKENS`, grouped by role (text neutrals, amber/gold accents, type-dot colors, rose/error families, hairline/border families); no runtime behaviour added
- `src/viz/css/styles.css` - Every color literal replaced with `var(--token)`; `#detail`/`#settings-panel`/`#reader` reskinned per D-12; `#tooltip` token-migrated with the Pitfall-1 exception preserved and documented; `#index-panel`'s elevation box-shadow removed
- `tests/viz-activity-palette-invariants.test.ts` - Adds `describe('D-14 CSS token discipline', ...)` with D-14-A (literal ban + injection proof), D-14-B (amber-exclusivity), D-14-C (backdrop-filter allow-list, `#tooltip` explicitly asserted clean)
- `tests/viz-frontend-static.test.ts` - Rule 1 fix: updated a pre-existing test that asserted the raw `#170f1d` literal directly in `styles.css` (now migrated to `var(--bg-scene)`) to check the var reference plus the token's authored value in `constants.js`

## Decisions Made
See `key-decisions` in frontmatter above. In short: amber split into a small named set (not one token) per the interfaces note's explicit allowance; the pre-existing gold doc-progress accent kept separate since it's a different RGB family; `#tooltip`'s border follows the plan's literal directive (`var(--glass-border)`) even though it's a small value change from its pre-migration literal; `#reader`/`#settings-panel` gained `border-radius: var(--radius-lg)` (new, per the plan's bundled reskin instruction).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed a test broken by the (intended) literal-migration**
- **Found during:** Task 2 (styles.css literal migration) — full suite run after the migration
- **Issue:** `tests/viz-frontend-static.test.ts` asserted `expect(css).toMatch(/background\s*:\s*#170f1d/i)` directly against the raw literal in `styles.css`. Migrating that literal to `var(--bg-scene)` (the whole point of this plan) made the assertion fail — the literal itself is gone by design.
- **Fix:** Updated the test to assert `background: var(--bg-scene)` in `styles.css`, plus a companion assertion that `HUD_CSS_TOKENS['bg-scene']` in `constants.js` still equals `'#170f1d'` — preserving the original "brand field" verification intent through the new single-source-of-truth path.
- **Files modified:** `tests/viz-frontend-static.test.ts`
- **Verification:** `npm test` — full suite 2629 passed / 4 skipped, no failures
- **Committed in:** `4e6838f` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug fix, directly caused by this plan's intended change)
**Impact on plan:** Necessary correctness fix to keep the suite green after the deliberate literal migration. No scope creep — no other files touched beyond the plan's declared scope.

## Issues Encountered

Token-count discretion: the plan's interfaces note frames "30-40 semantic tokens" as sufficient ("is fine") while also requiring every distinct deduped literal to get a token (the floor). Since ~80 distinct literals remained after the Plan-01 recipe tokens, honoring the floor without forcing artificial visual consolidation of near-duplicate grays/hairlines produced ~67 new tokens. This was a deliberate choice (documented in `key-decisions`) favoring zero unintended visual drift over hitting the lower token-count target — no test or acceptance criterion constrains the token count itself.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- `styles.css` is now a clean var()-only consumer of `constants.js`'s token vocabulary — Plans 03-06 can add new chrome (chip/rails/palette) using the same token set without introducing new raw literals
- The D-12 glass recipe is proven end-to-end on 3 real panels (`#detail`/`#settings-panel`/`#reader`) plus the tooltip exception — future plans building `#palette`/rail chrome have a working reference implementation
- D-14's backdrop-filter allow-list already includes placeholder entries for the not-yet-built `#chip`/`.rail`/`#topics-rail`/`#palette` selectors, so Plans 03-06 building those elements won't need to touch this test
- No blockers. Manual visual verification (load `recense viz`, confirm detail/settings/reader render with glass borders and no drop shadows; tooltip stays a crisp opaque card) was not performed live in this automated pass — this plan is fully autonomous with no checkpoint, and the acceptance criteria are otherwise machine-verified (grep gate, D-14 tests, full suite green)

---
*Phase: 59-hud-integration-visible-but-belong*
*Completed: 2026-07-06*
