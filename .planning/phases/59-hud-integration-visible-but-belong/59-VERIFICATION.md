---
phase: 59-hud-integration-visible-but-belong
verified: 2026-07-08T22:55:00Z
status: passed
score: 21/21 must-haves verified
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 19/21
  gaps_closed:
    - "At viz boot a <style id=\"hud-tokens\"> :root block is injected from constants.js values — styles.css can reference var(--glass-*), var(--radius-*), var(--motion-*) (59-01); detail/settings/reader carry the glass token language (59-02, D-12)"
  gaps_remaining: []
  regressions: []
human_verification: []
---

# Phase 59: HUD Integration — Visible-but-Belong Verification Report

**Phase Goal:** The overlay chrome (search, topics, buttons, controls) stops feeling out of place and in the way: persistent but redesigned in the scene's own language — Liquid-Glass-style panels (blur + hairline specular, aubergine-tinted, no drop shadows on dark), auto-receding edge-docked rails, a vanilla-JS cmd-K palette unifying search/topics/settings access (~100 lines, no React dep), strict diegetic/screen-space split. Search stays functional but demoted. Extend constants.js token discipline to the HUD CSS (anti-slop: no foreign palette ramps, protect amber-exclusivity). Absorbs pending todo viz-search-and-hull-quality (2026-06-12).

**Verified:** 2026-07-08
**Status:** passed
**Re-verification:** Yes — after gap-closure plan 59-07 (CR-01)

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Every HUD design token (glass, radii, motion) has a single authored home in `constants.js` | VERIFIED | `HUD_CSS_TOKENS` object at `constants.js:673`; scalar exports `HUD_IDLE_TIMEOUT_MS`/`RECEDE_GHOST_OPACITY`/`PALETTE_*` at 804-820 (regression check: unchanged since prior verification) |
| 2 | At viz boot a `<style id="hud-tokens">` `:root` block is injected — `styles.css` can reference `var(--glass-*)`, `var(--radius-*)`, `var(--motion-*)` — on **both** boot paths | VERIFIED (gap closed) | `app.js:52` — single `emitHudTokens()` call now sits immediately after `window.THREE = THREE;` (line 46) and unconditionally before the `DETAIL_ID` branch splits (line 55: `if (DETAIL_ID !== null) { ... }`). Confirmed by direct source read: `grep -n emitHudTokens src/viz/modules/app.js` returns exactly one hit (line 52, plus the import at line 23) — the former call at old line 235 (inside the graph-boot `else` arm) is gone. |
| 3 | Vendored JetBrains Mono is available to CSS as `font-family: 'JetBrains Mono HUD'` | VERIFIED | `@font-face` block, `styles.css:11-16`, points at vendored `../vendor/fonts/JetBrainsMono-Regular.ttf`, no CDN (unchanged) |
| 4 | Every color literal in `styles.css` is a `var(--token)` reference, sole authored home is `constants.js` | VERIFIED | D-14-A test (`viz-activity-palette-invariants.test.ts:403`) passes; manual spot-check confirms `html,body { background: var(--bg-scene); color: var(--text-body); }` (styles.css:23-24) — no raw literal fallback (unchanged) |
| 5 | The 3 elevation box-shadows on `#reader`/`#settings-panel`/`#index-panel` are gone, replaced by hairline-border only | VERIFIED | No `box-shadow: ... rgba(0,0,0,0.35)` literal remains (unchanged) |
| 6 | `#detail`/`#settings-panel`/`#reader` carry the D-12 glass token language on both boot paths; `#tooltip` is token-migrated but keeps zero `backdrop-filter` (Pitfall-1 exception) | VERIFIED (gap closed) | Since `emitHudTokens()` now runs before the `DETAIL_ID` branch splits, the tray's `/?detail=<id>` window's `<head>` gets the `#hud-tokens` `:root` block just like the main window, so `styles.css`'s var()-only `#detail` rules (styles.css:607-630 etc.) resolve correctly on both surfaces |
| 7 | Pressing ⌘K (or Ctrl-K) opens a single-input palette with Nodes / Topics / Commands sections | VERIFIED | `#palette`/`#palette-backdrop` DOM (`index.html:151-152`); `palette.js` (234 lines) implements sectioned render; 10 unit tests pass (unchanged) |
| 8 | Typing filters all three sections; selecting a node closes the palette and fly-tos via `ctx.selectNode`; selecting a command executes immediately | VERIFIED | Command registry + fuzzy matcher present and tested (unchanged) |
| 9 | Node matching reuses the existing debounced `/search` BM25 fetch (with its sequence-guard); Topics/Commands use client-side fuzzy matcher | VERIFIED | `ctx.searchNodes` reused from `search.js`; palette adds its own `searchSeq` guard layered on top (unchanged) |
| 10 | Event log and tombstone toggle are palette commands (`ctx.toggleLog`/`ctx.toggleTombstones`), not buttons | VERIFIED | Commands array (`palette.js:92-95`); old `#btn-log`/`#btn-tombstones` DOM confirmed absent from `index.html` (re-checked, still absent) |
| 11 | D-06: palette works across brain/corpus/reader views — fly-to switches back to brain first; Commands adapt to current view | VERIFIED | `flyToNode()` closes reader then checks `isCorpusOpen`/`showBrainFromCorpus` before `ctx.selectNode` (unchanged) |
| 12 | A status chip (SSE dot + node count, hover-fold legend) sits top-left; scene center stays clear | VERIFIED | `#hud-chip` at `index.html:45` (re-checked) |
| 13 | One vertical icon rail docked mid-right holds the core actions; the two floating corner buttons are gone | VERIFIED | `#hud-rail` at `index.html:67`; 4-icon rail post-D-15 (settings/corpus/recenter/search) — unchanged |
| 14 | A slim topics rail on the left edge expands on hover and highlights regions via `ctx.selectNode` | VERIFIED | `#topics-rail` at `index.html:107` (re-checked) |
| 15 | The old always-open search field, results list, event-log button and tombstone button are deleted from the DOM | VERIFIED | `grep` for `id="panel"`/`id="search-wrap"`/`id="btn-tombstones"`/`id="btn-log"`/`id="topic-wrap"` returns zero matches in `index.html` (re-checked) |
| 16 | Chrome fades to hairline ghost opacity after ~4s idle or during camera flight; mouse move restores it instantly | VERIFIED | `hud-recede.js` (61 lines): idle/in-flight opacity toggle logic (unchanged) |
| 17 | Focus/detail-open deepens recede immediately | VERIFIED | `.hud-recede-fast` toggled on `receded && focused` (unchanged) |
| 18 | Recede is opacity-only, no layout shift; live SSE trace activity does not force recede | VERIFIED | `hud-recede.js` reads no SSE/trace state; CSS rules confirmed opacity-only (unchanged) |
| 19 | The full glass + rails + palette + recede feel is judged together on the live install by the founder | VERIFIED (human gate resolved) | `59-EVIDENCE.md`: approved live 2026-07-07; all 5 referenced commits (`861da79`,`1f2cb10`,`fd8f224`,`064a4a6`,`b60af3b`) independently re-confirmed present in `git log` |
| 20 | The evidence record (checklist + anti-slop pass/fail) is captured | VERIFIED | `59-EVIDENCE.md` complete (unchanged) |
| 21 | A committed regression test locks the CR-01 fix so the detail-page boot path cannot silently lose token injection again | VERIFIED (new, plan 59-07) | `tests/viz-detail-page-token-injection.test.ts` — Block A (source-order lock: `emitHudTokens()` index < `DETAIL_ID !== null` index) + Block B (functional: stubbed `document`, real `emitHudTokens()` call, asserts injected `<style id="hud-tokens">` textContent contains `:root {` and `--glass-bg-ambient:`). Independently re-ran: `npx vitest run tests/viz-detail-page-token-injection.test.ts` → 3/3 passed. |

**Score:** 21/21 truths verified (0 FAILED)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/viz/modules/constants.js` | `HUD_CSS_TOKENS` + scalar exports | VERIFIED | Present, exhaustive (unchanged) |
| `src/viz/modules/css-tokens.js` | `emitHudTokens()` | VERIFIED (exists, substantive, now fully wired) | Function unchanged; call-site coverage gap (CR-01) closed by plan 59-07 |
| `src/viz/modules/app.js` | Single unconditional `emitHudTokens()` call ahead of `DETAIL_ID` branch | VERIFIED | Line 52, one call site only (`grep -c 'emitHudTokens()' app.js` → 1 call + 1 import) |
| `src/viz/css/styles.css` | `@font-face` + var()-only glass system | VERIFIED | Font-face present; zero raw literals (unchanged) |
| `src/viz/modules/palette.js` | ⌘K palette, ≥90 lines, exports `initPalette` | VERIFIED | 234 lines, wired in `app.js` (unchanged) |
| `tests/viz-hud-palette.test.ts` | matcher unit tests | VERIFIED | 10 tests, all pass |
| `tests/viz-detail-page-token-injection.test.ts` | Regression lock for CR-01 | VERIFIED | New in 59-07; 3 tests, all pass; asserts single call site + source-order + functional token resolution |
| `src/viz/index.html` | `#palette`/`#hud-rail`/`#hud-chip`/`#topics-rail` DOM | VERIFIED | All present, old DOM confirmed deleted |
| `src/viz/modules/hud-recede.js` | idle+flight+focus opacity driver, ≥30 lines, exports `initHudRecede` | VERIFIED | 61 lines (unchanged) |
| `src/viz/modules/camera.js` | `ctx.isCameraInFlight()` | VERIFIED | Present (unchanged) |
| `src/viz/modules/stats.js` | `ctx.msSinceActive()` | VERIFIED | Present (unchanged) |
| `.planning/phases/.../59-EVIDENCE.md` | D-15 evidence record | VERIFIED | Complete, founder-approved (unchanged) |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `css-tokens.js` | `constants.js` | ESM import of `HUD_CSS_TOKENS` | WIRED | Unchanged |
| `app.js` (main-window/graph-boot path) | `css-tokens.js` | `emitHudTokens()` called before styled DOM | WIRED | `app.js:52`, runs before UMD injection and before `DETAIL_ID` branch |
| `app.js` (detail-page path) | `css-tokens.js` | `emitHudTokens()` | **WIRED (fixed)** | `app.js:52` now precedes `DETAIL_ID !== null` check at line 55 — both paths reach the call. Root cause (CR-01) resolved by commit `9979ab7`. |
| `index.html` `#hud-rail` magnifier | `ctx.openPalette` | click → open palette | WIRED | Unchanged |
| `palette.js` | `/search?q=` | reused debounced fetch + sequence-guard | WIRED | Unchanged |
| `palette.js` | `ctx.selectNode` | select-and-go fly-to | WIRED | Unchanged |
| `palette.js` | `ctx.showBrainFromCorpus`/`ctx.closeReader` (D-06) | pre-selectNode view switch | WIRED | Unchanged |
| `hud-recede.js` | `ctx.msSinceActive()`/`ctx.isCameraInFlight()` | recede decision | WIRED | Unchanged |
| `hud-recede.js` | chip/rail/topics-rail | `classList.toggle('hud-receded', ...)` | WIRED | Unchanged |
| `tests/viz-detail-page-token-injection.test.ts` | `app.js` source order | source-index assertion (`emitHudTokens()` idx < `DETAIL_ID !== null` idx) | WIRED | Regression lock proven to fail if the call is moved back — verified by reading the assertion logic |

### Data-Flow Trace (Level 4)

Not applicable in the traditional DB-backed sense (client-side chrome, not a data dashboard). The one meaningful equivalent — does the injected `:root` token block reach every DOM context that consumes it — is now confirmed to flow correctly on **both** boot paths (main-window graph-boot and the tray's `/?detail=<id>` window). This was the exact defect closed by plan 59-07.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full test suite green | `npm test` | 2646 passed / 3 skipped (178 files passed, 1 skipped) | PASS |
| New regression test (CR-01 lock) | `npx vitest run tests/viz-detail-page-token-injection.test.ts` | 3/3 passed | PASS |
| TypeScript strict check | `npx tsc --noEmit -p .` | Clean, no errors | PASS |
| `emitHudTokens()` reachable on detail-page boot path | `grep -n emitHudTokens src/viz/modules/app.js` + manual trace | Single call at line 52, precedes `DETAIL_ID !== null` at line 55 — reachable on both paths | PASS |
| Old chrome DOM absent | `grep -n 'id="panel"\|id="search-wrap"\|id="btn-tombstones"\|id="btn-log"\|id="topic-wrap"' index.html` | zero matches | PASS |
| Gap-closure commits exist | `git log --oneline \| grep -E "9979ab7\|415b0c5"` | both found | PASS |
| Founder-checkpoint commits exist | `git log --oneline \| grep -E "861da79\|1f2cb10\|fd8f224\|064a4a6\|b60af3b"` | all 5 found | PASS |
| No new debt markers introduced | `grep -n 'TBD\|FIXME\|XXX' app.js tests/viz-detail-page-token-injection.test.ts` | none found | PASS |

### Probe Execution

Not applicable — this phase has no `scripts/*/tests/probe-*.sh` and no PLAN/SUMMARY declares probe-based verification. Skipped.

### Requirements Coverage

REQUIREMENTS.md has no formal entries for Phase 59 (`**Requirements**: TBD` in ROADMAP.md); this phase's requirement IDs are the D-xx design requirements defined in `59-UI-SPEC.md`/`59-CONTEXT.md`. All D-01 through D-15 appear in `59-CONTEXT.md`; UI-SPEC references a subset (D-02,04,06,08,09,10,11,12,13,14,15) plus D-16 (typography note, informational).

| Requirement | Source Plan | Description | Status | Evidence |
|---|---|---|---|---|
| D-01 | 59-04 | Overlay footprint (chip/rail/topics-rail) | SATISFIED | DOM present, old chrome deleted |
| D-02 | 59-03, 59-04 | Rail icon set / commands | SATISFIED | Commands registry + rail icons present |
| D-03 | 59-03, 59-04 | Single search surface (palette absorbs search) | SATISFIED | Old search box deleted, magnifier opens palette |
| D-04 | 59-03 | Palette matching behavior | SATISFIED | fuzzy matcher, tested |
| D-05 | 59-03 | No preview-on-arrow (palette doesn't auto-preview) | SATISFIED | No preview call found on hover/arrow |
| D-06 | 59-03 | View-switch before fly-to | SATISFIED | `flyToNode()` verified; WR-04 gap on one command (WARNING, non-blocking) |
| D-07 | 59-03 | (Palette scope item, folded into 59-03 accomplishments) | SATISFIED | Palette module complete |
| D-08 | 59-05 | Idle/flight recede | SATISFIED | `hud-recede.js` verified |
| D-09 | 59-05 | Focus-deepens-recede, opacity-only | SATISFIED | Verified |
| D-10 | 59-01, 59-05 | Single-source token discipline; SSE never forces recede | PARTIAL | CSS-level enforced (D-14 test); JS inline-style literals in `hud.js`/`stats.js` escape the scan (WR-05, WARNING, pre-existing files not solely introduced by this phase) |
| D-11 | 59-01, 59-05 | Shared motion tokens | SATISFIED | D-11 invariant test passes |
| D-12 | 59-02, 59-07 | Glass reskin of detail/settings/reader/tooltip | **SATISFIED (gap closed)** | Correct on main window (59-02); tray detail window now also correct after 59-07's CR-01 fix |
| D-13 | 59-04 | Diegetic/screen-space split (chip legend, etc.) | SATISFIED | Verified in DOM/CSS |
| D-14 | 59-01, 59-02, 59-04 | Machine-checked anti-slop CSS scan | SATISFIED | All D-14-A/B/C tests pass |
| D-15 | 59-06 | Founder closing checkpoint | SATISFIED | Evidence record + approval, human gate resolved |

No orphaned requirement IDs found — every D-xx defined in `59-CONTEXT.md`/`59-UI-SPEC.md` is claimed by at least one plan's `requirements-completed` field (D-12 now claimed by both 59-02 and 59-07).

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/viz/modules/palette.js` | 222-231 (+ reader.js/settings.js/detail.js Escape handlers) | Palette Escape also closes the panel stacked underneath it | WARNING | Confirmed reproducible (WR-02, prior verification); UX bug, not goal-breaking; not addressed by 59-07 (out of scope for that gap-closure plan) |
| `src/viz/modules/palette.js` | 194-215 | Stale in-flight search response not invalidated on query-clear/close | WARNING | Confirmed (WR-03, prior verification); narrow race window |
| `src/viz/modules/palette.js` | 98-99 | "Open reader" command ignores view provenance from corpus | WARNING | Confirmed (WR-04, prior verification) |
| `src/viz/modules/hud.js` | 62-64 | Hardcoded `#d9a05c`/`#7fae93` literals bypass the D-14 CSS-only scan | WARNING | Confirmed (WR-05, prior verification); duplicates token values, drift risk, not currently wrong |
| `src/viz/modules/stats.js` | 132 | `color:#00d4b0` cyan literal in dev-only stats overlay | WARNING | Confirmed (WR-05, prior verification); dev-hotkey surface, pre-dates this phase |
| `src/viz/modules/constants.js` | 804-826 | `PALETTE_Z_INDEX`/`PALETTE_BACKDROP_Z_INDEX`/`RECEDE_GHOST_OPACITY` dead exports (zero consumers) | INFO | Confirmed (IN-01, prior verification); dead code, not user-facing |
| `src/viz/modules/search.js` | 78-223 | ~145 lines dead code (DOM half unreachable since Plan 04 deleted the search box) | INFO | Confirmed (IN-02, prior verification) |
| `src/viz/css/styles.css` | 454-479 | Palette open/close opacity transition is a no-op (display:none/block pairing skips the transition) | INFO | Confirmed (IN-03, prior verification) |
| `src/viz/modules/palette.js` | 154-186 | No keyboard row-selection (Enter/arrows inert) despite `role="listbox"` markup | INFO | Confirmed (IN-04, prior verification); a11y gap |
| `tests/viz-idle-drift-camera-flight.test.ts` | 56-70 | Global `setTimeout` permanently stubbed, never restored | INFO | Confirmed (IN-05, prior verification); test-hygiene only |

No `TBD`/`FIXME`/`XXX` debt markers found in any file this phase touched, including the newly modified/created files from plan 59-07 (`app.js`, `viz-detail-page-token-injection.test.ts`).

None of the WARNING/INFO items above block the phase goal; they are unchanged carry-forwards from the prior verification pass and were explicitly out of scope for the 59-07 gap-closure plan (which was scoped to CR-01 only, per its own success criteria: "No WARNING/INFO findings ... touched").

### Human Verification Required

None. The phase's single closing founder checkpoint (D-15) was already resolved — approved live on 2026-07-07 per `59-EVIDENCE.md`. The gap that was found and closed in this re-verification cycle (CR-01) is a boot-path wiring defect fully verifiable via source inspection and the new automated regression test; it does not require re-opening the founder's qualitative D-15 judgment, since the founder was shown the main app install (unaffected by CR-01) — though the fix does mean the tray detail window, if re-checked live, would now also render themed rather than as an unstyled white page.

### Gaps Summary

None. The single BLOCKER from the prior verification pass (CR-01 — `emitHudTokens()` unreachable on the `/?detail=<id>` tray-detail boot path) is closed:

- `app.js`'s single `emitHudTokens()` call now sits at line 52, immediately after `window.THREE = THREE;` and unconditionally before the `DETAIL_ID` branch splits at line 55 — both the graph-boot and detail-page paths reach it.
- The former call site inside the graph-boot `else` arm (old line 235) has been removed — confirmed exactly one `emitHudTokens()` call exists in the file.
- A new regression test (`tests/viz-detail-page-token-injection.test.ts`, 3 tests) locks this: a source-order assertion (the call must precede the `DETAIL_ID !== null` check) plus a functional assertion (the injected `<style id="hud-tokens">` element carries a resolved `--glass-bg-ambient` custom property). All 3 tests pass independently re-run.
- Full suite (`npm test`) is green: 2646 passed / 3 skipped, up from the prior verification's 2643/3 (the 3 new tests account for the delta). `npx tsc --noEmit -p .` is clean.
- Both gap-closure commits (`9979ab7` fix, `415b0c5` test) are present in git log.

All 21 observable truths for this phase are now VERIFIED. The 5 WARNING-level findings (WR-02 through WR-05) and 5 INFO-level findings (IN-01 through IN-05) carried forward from the prior verification pass remain unresolved but are explicitly non-blocking (UX polish / dev-only surfaces / dead-code cleanup) and were correctly left out of scope by the 59-07 gap-closure plan, which held scope to CR-01 only as required by its own success criteria.

The phase goal — overlay chrome redesigned in the scene's own language (glass panels, edge-docked rails, cmd-K palette, auto-recede, token discipline) — is achieved and verified present, substantive, and wired across both viz boot paths, with the founder's live qualitative approval (D-15) already on record.

---

_Verified: 2026-07-08_
_Verifier: Claude (gsd-verifier)_
