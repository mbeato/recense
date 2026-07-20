---
phase: 59-hud-integration-visible-but-belong
reviewed: 2026-07-08T02:51:25Z
depth: standard
files_reviewed: 9
files_reviewed_list:
  - src/viz/css/styles.css
  - src/viz/index.html
  - src/viz/modules/app.js
  - src/viz/modules/camera.js
  - src/viz/modules/constants.js
  - src/viz/modules/reader.js
  - src/viz/modules/stats.js
  - tests/viz-detail-page-token-injection.test.ts
  - tests/viz-idle-drift-camera-flight.test.ts
findings:
  critical: 0
  warning: 5
  info: 3
  total: 8
status: issues_found
---

# Phase 59: Code Review Report (re-review after gap-closure plan 59-07)

**Reviewed:** 2026-07-08T02:51:25Z
**Depth:** standard
**Files Reviewed:** 9
**Status:** issues_found

## Summary

Re-review after gap-closure plan 59-07 fixed the prior BLOCKER (CR-01: detail-page token injection). **The prior CR-01 is verified fixed:** `emitHudTokens()` now runs unconditionally at `app.js:52`, before the `DETAIL_ID !== null` branch at `app.js:55-57`, so both the `/?detail=<id>` boot path and the graph-boot path receive the `:root` token block. The regression test `tests/viz-detail-page-token-injection.test.ts` correctly locks this two ways (source-order assertion + functional stub of `emitHudTokens()` against `css-tokens.js`); its regex `/emitHudTokens\(\)/g` matches only the call site (the import and comments lack parens), so the exactly-once assertion is sound. `css-tokens.js` itself is idempotent (guards on `#hud-tokens` presence) and builds only from the trusted `HUD_CSS_TOKENS` constant — no injection surface.

Data-flow check on the token pipeline (`HUD_CSS_TOKENS` → `emitHudTokens()` → `var(--*)` in styles.css): every `var(--*)` consumed in styles.css resolves to either a `HUD_CSS_TOKENS` entry or the CSS-declared `--index-width` — no unresolved-token gaps. Two defined tokens have no consumer anywhere (IN-02). The detail-window chrome coupling also checks out: the shell's detail window is 360×420 (`apps/tray/src/detail-window.ts:24-25`), so the ≤500px compact media query hides the chip/topics-rail and collapses the rail, and `.detail-page` hides `#rail-recenter` — no dead chrome renders in the shipped detail window.

No security issues found: all user/DB-sourced strings in `reader.js` and `detail-page.js` reach the DOM via `textContent` or escape-then-charset-restricted attribute interpolation (fact/doc id regexes constrain to `[0-9a-f-]`/`[a-z0-9-]`); no secrets, no eval, no dangerous sinks.

Five warnings remain: two frame-loop/hotkey defects in `stats.js` and three async-lifecycle gaps in `reader.js` where the cross-doc supersede guard does not extend to the post-200 helper fetches and error paths.

## Warnings

### WR-01: visibilitychange resume spawns a second (compounding) concurrent frame loop

**File:** `src/viz/modules/stats.js:293-307` (with `scheduleFrame` at 247-257)
**Issue:** When the tab is hidden, `loopRunning = false` is set but the rAF callback already queued by the previous frame's `scheduleFrame()` is *frozen*, not cancelled — browsers suspend, and later deliver, pending `requestAnimationFrame` callbacks. On visibility restore, the handler sets `loopRunning = true` and unconditionally calls `scheduleFrame()`, queuing a new frame chain. The frozen rAF from the old chain then fires, sees `loopRunning === true`, and continues its own chain. Result: two permanent parallel frame loops (one more added per hide/show cycle while at full framerate). Every registered tick runs N× per frame period, `measureFps` sees halved `dt` → measured fps inflated ×N → `autoAdaptQuality` incorrectly restores quality tiers on machines that are actually struggling, and CPU/battery use multiplies — directly against the D-07 "fans quiet all day" contract this module implements.
**Fix:** Invalidate the pending schedule on hide/resume, e.g. a generation counter:
```js
let loopGen = 0;
function scheduleFrame() {
  if (!loopRunning) return;
  const gen = loopGen;
  if (ctx.isIdle() && performance.now() >= animUntil) {
    const delay = Math.max(0, 1000 / IDLE_FPS - (performance.now() - lastFrame));
    setTimeout(() => { if (loopRunning && gen === loopGen) requestAnimationFrame(frame); }, delay);
  } else {
    requestAnimationFrame(now => { if (gen === loopGen) frame(now); });
  }
}
// visibilitychange: hidden → loopRunning = false; loopGen++;
//                   visible → loopRunning = true; loopGen++; lastFrame = performance.now(); scheduleFrame();
```

### WR-02: 'S' stats-overlay hotkey fires while typing in text inputs (⌘K palette, index search)

**File:** `src/viz/modules/stats.js:143-148`
**Issue:** The document-level keydown handler toggles the debug stats overlay on any capital `S` with no modifier, without checking whether the event originated in a text field. Phase 59 introduced `#palette-input` (the ⌘K single search surface) — typing any capital "S" into the palette (or the index sidebar's `.index-search-input`) now toggles a debug overlay mid-search. `palette.js` does not stop propagation of input keystrokes, so the event reaches this handler.
**Fix:**
```js
document.addEventListener('keydown', e => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (e.key === 'S' && !e.ctrlKey && !e.metaKey && !e.altKey) { /* toggle */ }
});
```

### WR-03: reader supersede token guard does not cover fetchStaleness/fetchBacklinks/fetchMeta — cross-doc state bleed, including a wrong-slug rewrite

**File:** `src/viz/modules/reader.js:286-293` (200 branch), `495-516` (fetchMeta), `523-584` (fetchStaleness), `592-629` (fetchBacklinks)
**Issue:** The module's header comment promises "Each loop re-checks its token after every await and bails if superseded," but the guard stops at `body.innerHTML = renderMarkdown(md)`. The three follow-up helpers each `await fetch(...)` and then write **without re-checking `loadToken`**:
- `fetchStaleness` prepends the *old* doc's staleness banner into `body` and clobbers `ctx.staleFactIds` / `ctx.staleFactPrevValues` with the old doc's data (detail.js then shows a wrong prev_value diff for the new doc's atoms).
- `fetchBacklinks` appends the old doc's "Referenced by" section into whatever body the new doc is rendering into.
- `fetchMeta` is the worst case: it rewrites `currentSlug` (and the title, lines 505-508) back to the **old** doc's slug and re-applies graph focus with the old doc's cited ids. Because `docQuery()` reads `currentSlug` at call time, a superseding slug-addressed load that is still polling has its subsequent `/doc` polls redirected to the old doc — the reader silently loads the wrong document.

The race window is real: `openReader` re-targeting (corpus doc click, doc-ref click, backlink click) can land during the three sequential post-200 fetches.
**Fix:** Thread `myToken` into the helpers and bail after every await before any DOM/ctx write:
```js
await fetchStaleness(myToken);  // inside: const data = await res.json(); if (token !== loadToken) return;
await fetchBacklinks(myToken);
await fetchMeta(myToken);
```

### WR-04: regenerate() ignores the POST /doc/generate response — silent no-op on failure

**File:** `src/viz/modules/reader.js:652`
**Issue:** `await fetch('/doc/generate?slug=...', { method: 'POST' })` never checks `res.ok`. If the server rejects the regeneration (5xx, engine busy without queuing), the code proceeds to clear the body and `loadWithPoll()`, which immediately receives a 200 for the *unchanged stale* doc and re-renders it. The user's regenerate click silently did nothing — no error surfaced (the catch block only fires on network-level rejection, not HTTP error status; D-14 forbids exactly this class of silent failure).
**Fix:**
```js
const res = await fetch('/doc/generate?slug=' + encodeURIComponent(currentSlug), { method: 'POST' });
if (!res.ok && res.status !== 202) throw new Error('POST /doc/generate → ' + res.status);
```

### WR-05: `loaded` latches true on a failed load — reopening the reader can never retry

**File:** `src/viz/modules/reader.js:150` (show) and `254-262` (load)
**Issue:** `show()` sets `loaded = true` immediately after kicking off the async `load()`. If `load()` fails (network error, non-200/202 status, poll timeout), the body shows the error text but `loaded` remains `true` — closing and reopening the reader hits `if (!loaded)` and skips the reload, leaving the stale error permanently until an `openReader` re-target to a *different* doc resets state. A transient server hiccup bricks the reader for the current doc.
**Fix:** Reset the flag on failure so reopen retries:
```js
async function load() {
  if (titleEl) titleEl.textContent = currentSlug;
  body.textContent = 'loading…';
  try {
    await loadWithPoll();
  } catch (e) {
    loaded = false; // allow retry on next show()
    body.textContent = 'failed to load doc: ' + String(e);
  }
}
```

## Info

### IN-01: `COMPACT_VIEW` is dead code with a contradictory adjacent comment

**File:** `src/viz/modules/stats.js:35-36` (comment at 49-55)
**Issue:** `const COMPACT_VIEW = Math.min(window.innerWidth, window.innerHeight) <= 500;` is computed and never read. The comment at lines 53-55 still claims "The per-viewport IDLE_TIMEOUT_MS still governs... (compact 1.2s, full 8s)" while `IDLE_TIMEOUT_MS` is unconditionally `1200` for both viewports (per the founder 2026-06-13 decision documented at lines 30-34). The stale comment actively misleads the next reader about runtime behavior.
**Fix:** Delete `COMPACT_VIEW` and correct the line-53 comment to state both viewports use 1.2s.

### IN-02: two HUD_CSS_TOKENS entries have no consumer anywhere in src/viz

**File:** `src/viz/modules/constants.js:689` (`radius-xs`), `src/viz/modules/constants.js:778` (`section-divider-faint`)
**Issue:** A full cross-check of `var(--*)` usage across styles.css and all viz modules finds no consumer for `--radius-xs` or `--section-divider-faint`. Dead entries in the "single authored source" catalog (D-14 claims it is the exhaustive deduped literal set) invite drift — a future edit to them changes nothing, silently.
**Fix:** Remove both entries, or add a source comment naming the intended future consumer if they are deliberate reservations.

### IN-03: test file permanently clobbers `setTimeout` (and other globals) with no teardown

**File:** `tests/viz-idle-drift-camera-flight.test.ts:56-70`
**Issue:** The `vi.hoisted` block replaces `globalThis.setTimeout` with a no-op returning `0` — plus `document`/`window`/`performance` — with no `afterAll` restoration, while the sibling test in this same phase (`viz-detail-page-token-injection.test.ts:27`) explicitly cites the "IN-05 lesson: never permanently clobber a global" and restores its stub. With per-file worker isolation the blast radius is contained, but a no-op `setTimeout` disables vitest's own per-test timeout enforcement inside this file: a future async assertion here would hang the worker silently instead of timing out.
**Fix:** Save the originals in the hoisted block and restore them in `afterAll`, or use `vi.stubGlobal` + `vi.unstubAllGlobals()`.

---

_Reviewed: 2026-07-08T02:51:25Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
