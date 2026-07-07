---
phase: 59-hud-integration-visible-but-belong
verified: 2026-07-07T16:40:00Z
status: gaps_found
score: 19/21 must-haves verified
overrides_applied: 0
gaps:
  - truth: "At viz boot a <style id=\"hud-tokens\"> :root block is injected from constants.js values — styles.css can reference var(--glass-*), var(--radius-*), var(--motion-*) (59-01); detail/settings/reader carry the glass token language (59-02, D-12)"
    status: failed
    reason: "emitHudTokens() is called only inside the graph-boot else-branch of app.js's DETAIL_ID mode switch (app.js:235, inside the else{} opened at line 54). The /?detail=<id> boot path (app.js:49-53 — the tray shell's adjacent detail window, documented in detail-page.js's own header) returns from renderDetailPage() before that else-branch is ever reached, so emitHudTokens() never runs in that mode. Plan 02 migrated 100% of styles.css's color/glass/radius declarations to var(--token) with zero raw-literal fallback (confirmed: html,body { background: var(--bg-scene); color: var(--text-body); }, styles.css:19-24; .detail-page #detail scrollbar rules at styles.css:607-630 also var()-only). With no :root block injected, every var(--...) in that document resolves to nothing: the shipped tray detail window renders as an unstyled white page with UA-default black text, no glass, no borders, no scrollbar theming. This is a real, guaranteed (not edge-case) regression of a working pre-phase surface — the same #detail panel that 59-02's must-have explicitly claims carries 'the glass token language' — confirmed by direct source read, not just REVIEW.md's claim (independently reproduced by tracing app.js:22-258 and styles.css)."
    artifacts:
      - path: "src/viz/modules/app.js"
        issue: "emitHudTokens() call at line 235 sits inside the else-branch of the DETAIL_ID mode switch (opened line 54, closes line 258+); the detail-page branch (lines 49-53) returns without ever calling it"
    missing:
      - "Call emitHudTokens() unconditionally before the DETAIL_ID branch splits (app.js) — or decouple token emission into a small head-of-document <script type=module> that only imports css-tokens.js, per REVIEW.md WR-01's fix option 1 — so both boot paths inject the :root token block"
      - "A regression test that boots/simulates the detail-page path and asserts #hud-tokens exists (or that a var(--...) resolves), so this can't silently regress again — none of Plan 01/02's D-10/D-11/D-14 locks are source-text checks and none exercise the detail-page boot path"
human_verification: []
---

# Phase 59: HUD Integration — Visible-but-Belong Verification Report

**Phase Goal:** The overlay chrome (search, topics, buttons, controls) stops feeling out of place and in the way: persistent but redesigned in the scene's own language — Liquid-Glass-style panels (blur + hairline specular, aubergine-tinted, no drop shadows on dark), auto-receding edge-docked rails, a vanilla-JS cmd-K palette unifying search/topics/settings access (~100 lines, no React dep), strict diegetic/screen-space split. Search stays functional but demoted. Extend constants.js token discipline to the HUD CSS (anti-slop: no foreign palette ramps, protect amber-exclusivity). Absorbs pending todo viz-search-and-hull-quality (2026-06-12).

**Verified:** 2026-07-07
**Status:** gaps_found
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Every HUD design token (glass, radii, motion) has a single authored home in `constants.js` | ✓ VERIFIED | `HUD_CSS_TOKENS` object at `constants.js:673`; scalar exports `HUD_IDLE_TIMEOUT_MS`/`RECEDE_GHOST_OPACITY`/`PALETTE_*` at 804-820 |
| 2 | At viz boot a `<style id="hud-tokens">` `:root` block is injected — `styles.css` can reference `var(--glass-*)`, `var(--radius-*)`, `var(--motion-*)` | ✗ FAILED | Only true on the main-window boot path (`app.js:235`). The `/?detail=<id>` tray-detail boot path returns at `app.js:53` and never reaches it (CR-01). See gap. |
| 3 | Vendored JetBrains Mono is available to CSS as `font-family: 'JetBrains Mono HUD'` | ✓ VERIFIED | `@font-face` block, `styles.css:11-16`, points at vendored `../vendor/fonts/JetBrainsMono-Regular.ttf`, no CDN |
| 4 | Every color literal in `styles.css` is a `var(--token)` reference, sole authored home is `constants.js` | ✓ VERIFIED | D-14-A test (`viz-activity-palette-invariants.test.ts:403`) passes; manual grep found zero raw hex/rgba in color-bearing declarations |
| 5 | The 3 elevation box-shadows on `#reader`/`#settings-panel`/`#index-panel` are gone, replaced by hairline-border only | ✓ VERIFIED | No `box-shadow: ... rgba(0,0,0,0.35)` literal remains; `#reader`/`#settings-panel`/`#index-panel` blocks inspected directly, no dark elevation shadow present |
| 6 | `#detail`/`#settings-panel`/`#reader` carry the D-12 glass token language; `#tooltip` is token-migrated but keeps zero `backdrop-filter` (Pitfall-1 exception) | ✗ FAILED (partial) | Correct on the main window. On the tray's `/?detail=<id>` window the same `#detail` panel renders fully unstyled because no tokens are injected there — same root cause as truth #2 (CR-01). D-14-C allow-list test still passes because it's a static-text CSS scan, not a boot-path test. |
| 7 | Pressing ⌘K (or Ctrl-K) opens a single-input palette with Nodes / Topics / Commands sections | ✓ VERIFIED | `#palette`/`#palette-backdrop` DOM (`index.html:151-152`); `palette.js` (234 lines) implements sectioned render; 10 unit tests pass (`viz-hud-palette.test.ts`) |
| 8 | Typing filters all three sections; selecting a node closes the palette and fly-tos via `ctx.selectNode`; selecting a command executes immediately | ✓ VERIFIED | Command registry + fuzzy matcher present and tested; WR-03 (stale in-flight response on query-clear/close) is a real gap but does not break the base behavior — classified WARNING, not BLOCKER |
| 9 | Node matching reuses the existing debounced `/search` BM25 fetch (with its sequence-guard); Topics/Commands use client-side fuzzy matcher | ✓ VERIFIED | `ctx.searchNodes` reused from `search.js`; palette adds its own `searchSeq` guard layered on top (`palette.js:131,207,210`) |
| 10 | Event log and tombstone toggle are palette commands (`ctx.toggleLog`/`ctx.toggleTombstones`), not buttons | ✓ VERIFIED | Commands array (`palette.js:92-95`); old `#btn-log`/`#btn-tombstones` DOM confirmed absent from `index.html` |
| 11 | D-06: palette works across brain/corpus/reader views — fly-to switches back to brain first; Commands adapt to current view | ✓ VERIFIED | `flyToNode()` closes reader then checks `isCorpusOpen`/`showBrainFromCorpus` before `ctx.selectNode` (`palette.js:122-124`); WR-04 ("Open reader" command ignores view provenance) is a real gap, WARNING not BLOCKER |
| 12 | A status chip (SSE dot + node count, hover-fold legend) sits top-left; scene center stays clear | ✓ VERIFIED | `#hud-chip` at `index.html:45` |
| 13 | One vertical icon rail docked mid-right holds the core actions; the two floating corner buttons are gone | ✓ VERIFIED | `#hud-rail` at `index.html:67`; `#rail-corpus`/`#rail-recenter` absorb the old `#btn-corpus`/`#btn-recenter`; reader icon was later removed at the D-15 checkpoint (founder-directed, documented deviation) — rail now 4 icons (settings/corpus/recenter/search) |
| 14 | A slim topics rail on the left edge expands on hover and highlights regions via `ctx.selectNode` | ✓ VERIFIED | `#topics-rail` at `index.html:107` |
| 15 | The old always-open search field, results list, event-log button and tombstone button are deleted from the DOM | ✓ VERIFIED | `grep` for `id="panel"`/`id="search-wrap"`/`id="btn-tombstones"`/`id="btn-log"`/`id="topic-wrap"` returns zero matches in `index.html` |
| 16 | Chrome fades to hairline ghost opacity after ~4s idle or during camera flight; mouse move restores it instantly | ✓ VERIFIED | `hud-recede.js` (61 lines): `idle = ctx.msSinceActive() > HUD_IDLE_TIMEOUT_MS`, `inFlight = ctx.isCameraInFlight()`, toggles `.hud-receded` |
| 17 | Focus/detail-open deepens recede immediately | ✓ VERIFIED | `focused = detailEl.classList.contains('panel-open')`; `.hud-recede-fast` toggled on `receded && focused` |
| 18 | Recede is opacity-only, no layout shift; live SSE trace activity does not force recede | ✓ VERIFIED | `hud-recede.js` reads no SSE/trace state (module header explicitly documents this exclusion, reworded post-Plan-05's own verify gate); CSS rules confirmed opacity-only |
| 19 | The full glass + rails + palette + recede feel is judged together on the live install by the founder | ✓ VERIFIED (human gate resolved) | `59-EVIDENCE.md`: "Approved live on the packed `recense viz` app install, 2026-07-07" following a 4-commit fix cycle (`861da79`,`1f2cb10`,`fd8f224`,`064a4a6`, all confirmed present in `git log`). Not re-litigated per task instructions. |
| 20 | The evidence record (checklist + anti-slop pass/fail) is captured | ✓ VERIFIED | `59-EVIDENCE.md` complete: automated-gate table, checkpoint narrative, anti-slop checklist both PASS, ratcheted tunables recorded |
| 21 | The full vitest suite is green before the qualitative gate | ✓ VERIFIED | Re-ran independently: `npm test` → **2643 passed / 3 skipped** (177 files passed, 1 skipped) — exact match to the evidence record's claimed count |

**Score:** 19/21 truths verified (2 FAILED, same CR-01 root cause)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/viz/modules/constants.js` | `HUD_CSS_TOKENS` + scalar exports | ✓ VERIFIED | Present, exhaustive (glass/radius/motion + ~67 content-color tokens + palette-only tier added at D-15) |
| `src/viz/modules/css-tokens.js` | `emitHudTokens()` | ✓ VERIFIED (exists, substantive) — ⚠️ wiring incomplete on one of two boot paths | Function correct; call-site coverage is the gap (see truth #2/#6) |
| `src/viz/css/styles.css` | `@font-face` + var()-only glass system | ✓ VERIFIED | Font-face present; zero raw literals (D-14-A); box-shadows removed |
| `src/viz/modules/palette.js` | ⌘K palette, ≥90 lines, exports `initPalette` | ✓ VERIFIED | 234 lines, exports present, wired in `app.js:251` |
| `tests/viz-hud-palette.test.ts` | matcher unit tests | ✓ VERIFIED | 10 tests, all pass |
| `src/viz/index.html` | `#palette`/`#hud-rail`/`#hud-chip`/`#topics-rail` DOM | ✓ VERIFIED | All present, old DOM confirmed deleted |
| `src/viz/modules/hud-recede.js` | idle+flight+focus opacity driver, ≥30 lines, exports `initHudRecede` | ✓ VERIFIED | 61 lines, exports present, wired last in `app.js:255` |
| `src/viz/modules/camera.js` | `ctx.isCameraInFlight()` | ✓ VERIFIED | Present, plus D-15 checkpoint fix reading real `controls.target` |
| `src/viz/modules/stats.js` | `ctx.msSinceActive()` | ✓ VERIFIED | Present, decoupled from the 1200ms scene-drift threshold |
| `.planning/phases/.../59-EVIDENCE.md` | D-15 evidence record | ✓ VERIFIED | Complete, founder-approved |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `css-tokens.js` | `constants.js` | ESM import of `HUD_CSS_TOKENS` | ✓ WIRED | `import { HUD_CSS_TOKENS } from './constants.js'` |
| `app.js` (main-window path) | `css-tokens.js` | `emitHudTokens()` called before styled DOM | ✓ WIRED | `app.js:235` |
| `app.js` (detail-page path) | `css-tokens.js` | `emitHudTokens()` | ✗ NOT WIRED | Never called on the `/?detail=<id>` branch — CR-01 |
| `index.html` `#hud-rail` magnifier | `ctx.openPalette` | click → open palette | ✓ WIRED | `hud.js` wires `#btn-search` click to `ctx.openPalette()` |
| `palette.js` | `/search?q=` | reused debounced fetch + sequence-guard | ✓ WIRED | `ctx.searchNodes` reused, own `searchSeq` layered on top |
| `palette.js` | `ctx.selectNode` | select-and-go fly-to | ✓ WIRED | via `flyToNode()` |
| `palette.js` | `ctx.showBrainFromCorpus`/`ctx.closeReader` (D-06) | pre-selectNode view switch | ✓ WIRED | `flyToNode()` lines 122-124 |
| `hud-recede.js` | `ctx.msSinceActive()`/`ctx.isCameraInFlight()` | recede decision | ✓ WIRED | `hud-recede.js` tick function |
| `hud-recede.js` | chip/rail/topics-rail | `classList.toggle('hud-receded', ...)` | ✓ WIRED | Confirmed |

### Data-Flow Trace (Level 4)

Not applicable in the traditional DB-backed sense (this phase is client-side chrome, not a data dashboard). The one meaningful data-flow-equivalent check — does the injected `:root` token block actually reach every DOM context that consumes it — is exactly where the gap was found: it flows correctly on the main-window boot path and is disconnected on the detail-page boot path (see CR-01 above).

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full test suite green | `npm test` | 2643 passed / 3 skipped | ✓ PASS |
| Phase-specific test files | `npx vitest run tests/viz-activity-palette-invariants.test.ts tests/viz-hud-palette.test.ts tests/viz-idle-drift-camera-flight.test.ts tests/viz-frontend-static.test.ts tests/viz-corpus-graph.test.ts` | 131/131 passed (5 files) | ✓ PASS |
| TypeScript strict check | `npx tsc --noEmit -p .` | Clean, no errors | ✓ PASS |
| Old chrome DOM absent | `grep -n 'id="panel"\|id="search-wrap"\|id="btn-tombstones"\|id="btn-log"\|id="topic-wrap"' index.html` | zero matches | ✓ PASS |
| Elevation box-shadows removed | grep for `rgba(0,0,0,0.35)` box-shadow literal in styles.css | zero matches | ✓ PASS |
| `emitHudTokens()` reachable on detail-page boot path | traced `app.js:22-258` source | unreachable — inside `else` branch the detail path never enters | ✗ FAIL |
| Commits referenced in SUMMARY/EVIDENCE exist | `git log --oneline \| grep -E "861da79\|1f2cb10\|fd8f224\|064a4a6\|b60af3b"` | all 5 found | ✓ PASS |

### Probe Execution

Not applicable — this phase has no `scripts/*/tests/probe-*.sh` and no PLAN/SUMMARY declares probe-based verification. Skipped.

### Requirements Coverage

REQUIREMENTS.md has no formal entries for Phase 59 (`**Requirements**: TBD` in ROADMAP.md); this phase's requirement IDs are the D-xx design requirements defined in `59-UI-SPEC.md`/`59-CONTEXT.md`. All D-01 through D-15 appear in `59-CONTEXT.md`; UI-SPEC references a subset (D-02,04,06,08,09,10,11,12,13,14,15) plus D-16 (typography note, informational, not a `requirements-completed` target of any plan).

| Requirement | Source Plan | Description | Status | Evidence |
|---|---|---|---|---|
| D-01 | 59-04 | Overlay footprint (chip/rail/topics-rail) | ✓ SATISFIED | DOM present, old chrome deleted |
| D-02 | 59-03, 59-04 | Rail icon set / commands | ✓ SATISFIED | Commands registry + rail icons present |
| D-03 | 59-03, 59-04 | Single search surface (palette absorbs search) | ✓ SATISFIED | Old search box deleted, magnifier opens palette |
| D-04 | 59-03 | Palette matching behavior | ✓ SATISFIED | fuzzy matcher, tested |
| D-05 | 59-03 | No preview-on-arrow (palette doesn't auto-preview) | ✓ SATISFIED | No preview call found on hover/arrow |
| D-06 | 59-03 | View-switch before fly-to | ✓ SATISFIED | `flyToNode()` verified; WR-04 gap on one command (WARNING) |
| D-07 | 59-03 | (Palette scope item, folded into 59-03 accomplishments) | ✓ SATISFIED | Palette module complete |
| D-08 | 59-05 | Idle/flight recede | ✓ SATISFIED | `hud-recede.js` verified |
| D-09 | 59-05 | Focus-deepens-recede, opacity-only | ✓ SATISFIED | Verified |
| D-10 | 59-01, 59-05 | Single-source token discipline; SSE never forces recede | ⚠️ PARTIAL | CSS-level enforced (D-14 test); JS inline-style literals in `hud.js`/`stats.js` escape the scan (WR-05, WARNING, pre-existing files not solely introduced by this phase) |
| D-11 | 59-01, 59-05 | Shared motion tokens | ✓ SATISFIED | D-11 invariant test passes |
| D-12 | 59-02 | Glass reskin of detail/settings/reader/tooltip | ✗ BLOCKED (partial) | Correct on main window; broken on tray detail window (CR-01) |
| D-13 | 59-04 | Diegetic/screen-space split (chip legend, etc.) | ✓ SATISFIED | Verified in DOM/CSS |
| D-14 | 59-01, 59-02, 59-04 | Machine-checked anti-slop CSS scan | ✓ SATISFIED | All D-14-A/B/C tests pass |
| D-15 | 59-06 | Founder closing checkpoint | ✓ SATISFIED | Evidence record + approval, human gate resolved |

No orphaned requirement IDs found — every D-xx defined in `59-CONTEXT.md`/`59-UI-SPEC.md` is claimed by at least one plan's `requirements-completed` field.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/viz/modules/app.js` | 51-54, 235 | `emitHudTokens()` unreachable on detail-page boot path | 🛑 BLOCKER | CR-01 — see gap above |
| `src/viz/modules/palette.js` | 222-231 (+ reader.js/settings.js/detail.js Escape handlers) | Palette Escape also closes the panel stacked underneath it | ⚠️ WARNING | Confirmed reproducible (WR-02 in REVIEW.md); UX bug, not a goal-breaking defect |
| `src/viz/modules/palette.js` | 194-215 | Stale in-flight search response not invalidated on query-clear/close | ⚠️ WARNING | Confirmed (WR-03); narrow race window |
| `src/viz/modules/palette.js` | 98-99 | "Open reader" command ignores view provenance from corpus | ⚠️ WARNING | Confirmed (WR-04) |
| `src/viz/modules/hud.js` | 62-64 | Hardcoded `#d9a05c`/`#7fae93` literals bypass the D-14 CSS-only scan | ⚠️ WARNING | Confirmed (WR-05); duplicates token values, drift risk, not currently wrong |
| `src/viz/modules/stats.js` | 132 | `color:#00d4b0` cyan literal in dev-only stats overlay, violates the file's own "never reintroduce cyan/teal" header rule | ⚠️ WARNING | Confirmed (WR-05); dev-hotkey surface, pre-dates this phase |
| `src/viz/modules/constants.js` | 804-826 | `PALETTE_Z_INDEX`/`PALETTE_BACKDROP_Z_INDEX`/`RECEDE_GHOST_OPACITY` dead exports (zero consumers) | ℹ️ INFO | Confirmed (IN-01); dead code, not user-facing |
| `src/viz/modules/search.js` | 78-223 | ~145 lines dead code (DOM half unreachable since Plan 04 deleted the search box) | ℹ️ INFO | Confirmed (IN-02) |
| `src/viz/css/styles.css` | 454-479 | Palette open/close opacity transition is a no-op (display:none/block pairing skips the transition) | ℹ️ INFO | Confirmed (IN-03) |
| `src/viz/modules/palette.js` | 154-186 | No keyboard row-selection (Enter/arrows inert) despite `role="listbox"` markup | ℹ️ INFO | Confirmed (IN-04); a11y gap |
| `tests/viz-idle-drift-camera-flight.test.ts` | 56-70 | Global `setTimeout` permanently stubbed, never restored | ℹ️ INFO | Confirmed (IN-05); test-hygiene only |

No `TBD`/`FIXME`/`XXX` debt markers found in any file this phase touched.

### Human Verification Required

None. The phase's single closing founder checkpoint (D-15) is already resolved — approved live on 2026-07-07 per `59-EVIDENCE.md`, following a documented fix cycle (4 commits, all verified present in git log). Per task instructions, this human gate is not re-litigated here.

### Gaps Summary

One root-cause defect (CR-01, from the committed `59-REVIEW.md` code review, independently reproduced during this verification) blocks two of this phase's own must-have truths:

- **Plan 01's truth** ("at viz boot a `:root` token block is injected") is only true for the main-window boot path.
- **Plan 02's truth** ("detail/settings/reader carry the glass token language") is false for the `#detail` panel specifically when rendered via the tray's `/?detail=<id>` adjacent window — the exact surface `detail-page.js`'s own header comment documents as a real, shipped feature ("the shell's adjacent detail window opened by the tray shell next to the compact popover").

`app.js`'s `emitHudTokens()` call sits inside the `else` branch of the `DETAIL_ID` mode switch and is never reached by the detail-page path. Because Plan 02 deliberately removed every raw color/glass literal from `styles.css` (the correct, intended migration), that surface now has literally nothing to fall back on when the token injection is skipped — it renders as an unstyled white page. This is a genuine functional regression traced directly to this phase's own work (pre-phase, the CSS literals styled this surface correctly), not a pre-existing or adjacent-feature defect, and not addressed by any later-phase roadmap item (Phase 60 is settings dashboards, Phase 61 is corpus-view chrome — neither touches the tray detail-window boot path).

The fix is small and already scoped in `59-REVIEW.md`'s CR-01 section (move/duplicate the `emitHudTokens()` call ahead of the `DETAIL_ID` branch, or decouple it into a lightweight head-of-document script) — this does not require re-opening the founder's D-15 qualitative judgment, since the founder was never shown the broken surface (the live checkpoint judged the main app install, not the tray detail window).

The 5 WARNING-level findings (WR-02 through WR-05) and 5 INFO-level findings (IN-01 through IN-05) from `59-REVIEW.md` were independently spot-checked and confirmed accurate; none of them block the phase goal on their own and are left to the team's discretion for a follow-up cleanup pass rather than gap-closure of this phase.

Everything else — the token vocabulary, the exhaustive CSS migration (main window), the glass reskin, the ⌘K palette, the chip/rail/topics-rail restructure, the auto-recede system, and the founder's D-15 approval — is verified present, substantive, and wired in the codebase, with the full 2643/3-skipped test suite independently re-confirmed green.

---

_Verified: 2026-07-07_
_Verifier: Claude (gsd-verifier)_
