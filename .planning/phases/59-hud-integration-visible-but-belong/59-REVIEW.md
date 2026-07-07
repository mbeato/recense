---
phase: 59-hud-integration-visible-but-belong
reviewed: 2026-07-07T00:00:00Z
depth: standard
files_reviewed: 21
files_reviewed_list:
  - src/viz/css/styles.css
  - src/viz/index.html
  - src/viz/modules/app.js
  - src/viz/modules/camera.js
  - src/viz/modules/constants.js
  - src/viz/modules/corpus.js
  - src/viz/modules/css-tokens.js
  - src/viz/modules/detail.js
  - src/viz/modules/graph.js
  - src/viz/modules/hud-recede.js
  - src/viz/modules/hud.js
  - src/viz/modules/palette.js
  - src/viz/modules/reader.js
  - src/viz/modules/search.js
  - src/viz/modules/stats.js
  - src/viz/modules/topics.js
  - tests/viz-activity-palette-invariants.test.ts
  - tests/viz-corpus-graph.test.ts
  - tests/viz-frontend-static.test.ts
  - tests/viz-hud-palette.test.ts
  - tests/viz-idle-drift-camera-flight.test.ts
findings:
  critical: 1
  warning: 5
  info: 5
  total: 11
status: issues_found
---

# Phase 59: Code Review Report

**Reviewed:** 2026-07-07
**Depth:** standard
**Files Reviewed:** 21
**Status:** issues_found

## Summary

Phase 59 moves every color/glass/radius/motion value in `styles.css` behind runtime-injected CSS custom properties (`HUD_CSS_TOKENS` → `emitHudTokens()`), adds the ⌘K palette, restructures the HUD into chip/rail/topics-rail, adds auto-recede, and fixes two real camera regressions (idle-drift vs. in-flight writer fight; the synthetic `lookAt` settle wedge). The camera fixes are correct and well-tested — the vendor-faithful mock in `viz-idle-drift-camera-flight.test.ts` reproduces the actual root cause rather than mocking it away.

The token migration, however, has a structural hole: the stylesheet is now 100% dependent on a runtime JS injection that only happens on one of the two boot paths, and only *after* the heavy top-level awaits. The detail-page mode (`/?detail=<id>`, the tray's adjacent window) never injects tokens at all — every `var(--…)` in the stylesheet is undefined there, so that entire surface ships unthemed (CR-01). The main window also renders its static chrome unstyled until the three.js import + UMD injection + `/graph` fetch complete (WR-01).

The palette is XSS-safe (textContent/createElement throughout, verified) but has three behavioral gaps: uncoordinated Escape handling across stacked surfaces (WR-02), a stale in-flight search response that can render results under an empty query (WR-03) — the exact hazard the old `search.js` `clearSearch()` handled with `seq++` — and an "Open reader" command that ignores view provenance (WR-04).

## Critical Issues

### CR-01: Detail-page mode never injects HUD tokens — the entire tray detail window renders unthemed

**File:** `src/viz/modules/app.js:51-54, 235` (with `src/viz/modules/detail-page.js`, `src/viz/css/styles.css`)
**Issue:** `emitHudTokens()` is called only inside the graph-boot `else` branch (`app.js:235`). The `/?detail=<id>` branch (`app.js:51-53`) loads `detail-page.js` and returns without ever emitting the `:root` token block. After Plan 02's migration, `styles.css` contains **zero** literal colors — `html, body { background: var(--bg-scene); color: var(--text-body); }`, every `.detail-page #detail` text/scrollbar color, all of it resolves through custom properties that now do not exist in this mode. Every `var(--…)` is invalid at computed-value time → properties fall back to `unset`: white page background, UA-default black text, no scrollbar/border/divider theming. This is a guaranteed (not edge-case) visual regression of a shipped surface — the tray shell's adjacent detail window (see `detail-page.js` header comment). Pre-phase, the literals in `styles.css` styled this mode correctly (the old `viz-frontend-static.test.ts` asserted `background: #170f1d` as a raw literal). No test catches it: all Plan 01/02 locks are source-text pattern checks on `styles.css`/`constants.js`, none exercise the detail-page boot path.
**Fix:**
```js
// app.js — emit tokens BEFORE the mode branch, not inside the graph-boot arm:
window.THREE = THREE;
emitHudTokens();   // both boot paths need the :root token block

const DETAIL_ID = new URLSearchParams(location.search).get('detail');
if (DETAIL_ID !== null) { ... }
```
(This also partially mitigates WR-01; see below for the full fix.) Add a regression lock: a static test asserting `emitHudTokens` is reachable on the detail-page path (e.g., it appears before the `DETAIL_ID` branch in `app.js` source), or a jsdom test that boots the detail path and asserts `#hud-tokens` exists.

## Warnings

### WR-01: Token injection is sequenced after the heavy top-level awaits — unstyled chrome on every boot, and permanent unstyled page if the UMD load fails

**File:** `src/viz/modules/app.js:22, 60-66, 102-108, 235`
**Issue:** The comment on `app.js:235` ("inject :root HUD token block before any styled DOM renders") is false. `#hud-chip` ("connecting… · — nodes"), `#hud-rail` (4 icons), `#topics-rail`, and `#hull-credit` are static HTML rendered at parse time; `emitHudTokens()` runs only after (a) `three.module.js` finishes loading (static import — even moving the call to the top of `app.js` cannot beat this), (b) the 3d-force-graph UMD injection await, and (c) the `Promise.allSettled` around the `/graph` fetch. Until then the page is white with black default-styled chrome — a flash on every open, growing with corpus size. Worse failure mode: if the 3d-force-graph UMD script errors, the promise at `app.js:60-66` **rejects**, the top-level await throws, module evaluation aborts, and `emitHudTokens()`/`initHud()` never run — permanently unstyled white page with the D-14 error-surfacing handlers never registered. Pre-phase, a failed boot still left a correctly dark-themed page.
**Fix:** Decouple token emission from the app module graph. Either (1) add a tiny dedicated entry in `index.html` head that loads before `app.js` and imports only `css-tokens.js` (which pulls `constants.js` but not three.js):
```html
<script type="module">
  import { emitHudTokens } from './modules/css-tokens.js';
  emitHudTokens();
</script>
```
or (2) generate a static `tokens.css` from `HUD_CSS_TOKENS` (served by `server.ts` or emitted at build time), keeping the existing sync test as the drift lock. Option 1 also fixes CR-01 for free.

### WR-02: Escape with the palette open also closes the reader/settings/detail panel underneath it

**File:** `src/viz/modules/palette.js:222-231` (with `reader.js:195-197`, `settings.js:62-65`, `detail.js:729-734`)
**Issue:** The palette adds a fourth independent document-level Escape listener. The three pre-existing ones fire unconditionally whenever their own surface is open — they have no knowledge of the palette stacked above them (z:50 over reader z:40 / settings z:41 / detail z:10). The palette explicitly supports being opened over these surfaces (D-06 view detection, commands visible in reader view). Reproduction: open the reader (or a node detail) → ⌘K → Esc. Expected: palette closes. Actual: palette *and* the reader/detail both close. `stopPropagation()` in the palette handler would not help — all four listeners are bubble-phase on the same `document` node, and registration order puts the palette last.
**Fix:** The palette already maintains a dedicated signal — `document.documentElement.classList.contains('palette-open')`. Guard the other three handlers with it:
```js
// reader.js / settings.js / detail.js Escape handlers:
if (ev.key === 'Escape'
    && !document.documentElement.classList.contains('palette-open')
    && panel.classList.contains('open')) hide();
```
Alternatively, register the palette's listener in the capture phase and call `ev.stopPropagation()` when it consumes the Escape (capture on `document` fires before the existing bubble listeners).

### WR-03: Stale in-flight palette search is never invalidated on query-clear or close — old node results render under an empty (or reopened) palette

**File:** `src/viz/modules/palette.js:194-215, 147-151`
**Issue:** `searchSeq` is incremented only inside the debounce callback of a *new non-empty* query. Two paths leave an in-flight response valid when it should be dead:
1. Type "abc" → debounce fires → `mySeq = ++searchSeq` → fetch in flight → user selects-all + deletes → `onQueryChange('')` sets `nodeResults = []`, renders, returns — but the pending fetch resolves with `mySeq === searchSeq`, passes the guard, and renders the "abc" node results under an empty input.
2. Same shape across close/reopen: `close()` cancels nothing; a pending debounce timer still fires (network fetch against a closed palette), and a pending resolve can land after `open()`'s `onQueryChange('')` reset, showing the previous session's results.
The module this code was extracted from handles exactly this: `search.js:178-184` `clearSearch()` does `seq++; // invalidate any in-flight response`. The palette dropped that half of the pattern.
**Fix:**
```js
if (!query) { searchSeq++; nodeResults = []; render(); return; }
// and in close():
function close() {
  if (debounceId) { clearTimeout(debounceId); debounceId = null; }
  searchSeq++;   // invalidate any in-flight response
  ...
}
```

### WR-04: Palette "Open reader" ignores view provenance — over the corpus it opens with `from:'brain'`, driving graph focus on the hidden brain and breaking close-returns-to-corpus

**File:** `src/viz/modules/palette.js:98-99` (with `reader.js:224-246, 140-174`)
**Issue:** The `open-reader` command has no `visibleIn` (shown in corpus view) and calls `c.openReader()` with no opts → `reader.js` defaults `openFrom = 'brain'`. Consequences when invoked from corpus view: (a) `show()` runs `applyGraphFocus(citedFactIds)` — the brain-only enhancement (dim + focus on the hidden 3D canvas) that `reader.js:151-154` explicitly says is "pointless" when the brain is hidden, and which contradicts this module's own D-06 discipline ("the damped camera never animates on a hidden canvas"); (b) `hide()` takes the brain branch, skipping `ctx.returnToCorpus()`, so the corpus-shown state (corpus button/chip/chapter-toggle assertions) is not re-asserted on close. Every other corpus-context caller (`corpus.js:453`, `index.js:120`) passes `{ from: 'corpus' }`.
**Fix:**
```js
{ id: 'open-reader', label: 'Open reader',
  run: c => { if (c.openReader) c.openReader(null,
    { from: currentView() === 'corpus' ? 'corpus' : 'brain' }); } },
```

### WR-05: D-14 literal-ban guard-set ≠ ship-set — JS inline styles still ship raw color literals, including a duplicated amber and a founder-banned cyan

**File:** `src/viz/modules/hud.js:62-64`; `src/viz/modules/stats.js:126-140`
**Issue:** The D-14 machine lock (`viz-activity-palette-invariants.test.ts` "D-14-A/B") scans `styles.css` only, but colors also reach the DOM through JS inline styles, which the guard cannot see:
- `hud.js:62-64` `setSSEStatus` hardcodes `'#d9a05c'` — byte-identical to `HUD_CSS_TOKENS['accent-amber-solid']` — and `'#7fae93'` — identical to `'text-stat'`. If the amber family is ever retuned at a founder checkpoint, the SSE dot silently keeps the stale hue: exactly the mirror-drift shape D-10/D-14 exists to kill, one file away from the single source.
- `stats.js:132` ships `color:#00d4b0` (cyan/teal) in the stats overlay's cssText — the stylesheet header says "Never reintroduce cyan/teal" (founder-locked). Dev-only hotkey surface, but it is chrome rendered in the shipped page.
Both predate Phase 59, but this phase's stated deliverable was the exhaustive color-literal migration and its machine lock; these escape both.
**Fix:** Reference the tokens instead of literals (`sseDotEl.style.background = 'var(--accent-amber-solid)'`; the tokens are in `:root`, so inline `var()` resolves), and extend the D-14 test to grep `src/viz/modules/*.js` for `#[0-9a-f]{6}`/`rgba(` in style-assignment lines (allow-listing `constants.js`).

## Info

### IN-01: Dead constants duplicating literals they claim to source — `PALETTE_Z_INDEX`, `PALETTE_BACKDROP_Z_INDEX`, `RECEDE_GHOST_OPACITY`

**File:** `src/viz/modules/constants.js:804-826`
**Issue:** All three exports have zero consumers (verified by grep across `src/` and `tests/`). `styles.css:449/459` hardcodes `z-index: 49`/`50` as its own literals; `RECEDE_GHOST_OPACITY` duplicates `HUD_CSS_TOKENS['recede-ghost-opacity']` with a comment promising manual sync ("Kept in sync … same 0.12 literal") — the manual-mirror anti-pattern this phase's D-10 work eliminates elsewhere.
**Fix:** Delete the three dead exports; if the z-indices should be single-sourced, add them to `HUD_CSS_TOKENS` and reference `var(--z-palette)` in the stylesheet.

### IN-02: ~145 lines of permanently unreachable code in search.js

**File:** `src/viz/modules/search.js:78-223`
**Issue:** Plan 04 removed `#search-wrap`/`#search-input` from `index.html` in **all** modes, so the guard at line 79 always returns. Everything below — `runSearch`, `renderResults`, keyboard scrubbing, `clearSearch`, `ctx.clearSearch` — is dead. `detail.js:643`'s `if (ctx.clearSearch) ctx.clearSearch()` now silently no-ops (harmless: there is no search box left to clear), but the dead block will mislead future readers into thinking two search surfaces coexist.
**Fix:** Reduce `initSearch` to the `ctx.searchNodes` helper and delete the DOM half (and the `detail.js` call site).

### IN-03: Palette open/close fade never actually animates

**File:** `src/viz/css/styles.css:454-479`; `src/viz/modules/palette.js:137-151`
**Issue:** `#palette` transitions opacity, but `.open` also flips `display: none → block` in the same style recalc; a newly-displayed element skips transitions (and removal to `display:none` kills the close fade). The D-09/D-11 "opacity-only motion" on this panel is a no-op — it pops. `#detail` avoids this via its slide-in pattern only because of the transform pairing; the palette has no equivalent.
**Fix:** Either keep the element rendered (`visibility: hidden; pointer-events: none` instead of `display: none`), use `@starting-style`, or add the `.open` class in a second rAF after clearing `display`.

### IN-04: Palette has no keyboard selection despite being keyboard-summoned

**File:** `src/viz/modules/palette.js:154-186, 222-231`
**Issue:** Enter and ArrowUp/Down do nothing; results are mouse-click-only. `role="listbox"`/`role="option"` markup implies keyboard operability (no `aria-activedescendant`, no active-row state). "No preview-on-arrow" (D-05) forbids previewing, not selecting — a ⌘K palette where Enter is inert is a functional gap, and an a11y one.
**Fix:** Track an active row index; Enter picks it (default: first result); arrows move it (without invoking preview/activate); mirror to `aria-activedescendant`.

### IN-05: Test file permanently replaces global `setTimeout` with a no-op for its worker

**File:** `tests/viz-idle-drift-camera-flight.test.ts:56-70`
**Issue:** `vi.hoisted` assigns `(globalThis as any).setTimeout = () => 0` and never restores it. Safe today only because vitest isolates files per worker; it silently breaks any timer-dependent test later appended to this file, and would leak across files if `isolate: false` is ever enabled.
**Fix:** Use `vi.stubGlobal('setTimeout', …)` + `vi.unstubAllGlobals()` in `afterAll`, or scope the stub inside the stats-drift describe block.

---

_Reviewed: 2026-07-07_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
