---
phase: 34-visual-polish-pass
reviewed: 2026-06-20T00:00:00Z
depth: standard
files_reviewed: 3
files_reviewed_list:
  - src/viz/css/styles.css
  - src/viz/index.html
  - src/viz/modules/corpus.js
findings:
  critical: 2
  warning: 3
  info: 1
  total: 6
status: issues_found
---

# Phase 34: Code Review Report

**Reviewed:** 2026-06-20
**Depth:** standard
**Files Reviewed:** 3
**Status:** issues_found

## Summary

Reviewed the three phase-34 viz files against `git diff b3c2b9c..HEAD`. The CSS and HTML changes are structurally correct — the `#reader-head` sticky flex refactor, `#btn-corpus` promotion to top-level fixed button, spacing tweaks, and `.corpus-status` overlay are all well-formed. The inline SVG swap introduces no XSS risk (both `ICON_BOOK` and `ICON_BRAIN` are static string literals, not derived from user or network data).

Two blockers in `corpus.js`: the error-state message is silently overwritten by the empty-state branch on every network failure, and the `CorpusGraph = null` guard means a second button click after an empty/failed load appends a second status overlay rather than showing the existing one.

---

## Critical Issues

### CR-01: Network error message overwritten by empty-state branch

**File:** `src/viz/modules/corpus.js:91-114`

**Issue:** When `fetch('/graph?type=doc')` throws (e.g. server unreachable), the `catch` block sets `statusEl.textContent = 'Failed to load corpus'`. Execution then falls through to the empty-state guard at line 111: `(data.nodes || []).length === 0` is trivially true because `data` was never reassigned from its initial `{ nodes: [], links: [] }`. The guard immediately overwrites the error message with `'No docs yet<br><code>recense generate-doc &lt;slug&gt;</code>'` and returns `null`. The user always sees the empty-state hint instead of the fetch failure — masking network errors entirely.

**Fix:** Track whether the fetch failed and skip the empty-state branch:

```js
let fetchFailed = false;
try {
  const res = await fetch('/graph?type=doc');
  if (res.ok) data = await res.json();
  else fetchFailed = true;           // non-2xx: treat as error
} catch (_) {
  fetchFailed = true;
}
if (fetchFailed) {
  statusEl.textContent = 'Failed to load corpus';
  return null;
}
// Empty state check only reached if fetch succeeded.
if ((data.nodes || []).length === 0) {
  statusEl.innerHTML = 'No docs yet<br><code>recense generate-doc &lt;slug&gt;</code>';
  return null;
}
statusEl.remove();
```

---

### CR-02: Repeated clicks after empty/failed load accumulate status overlays

**File:** `src/viz/modules/corpus.js:72-75, 271-275`

**Issue:** `CorpusGraph` is initialized to `null` at line 72 and remains `null` whenever `buildCorpusGraph` returns `null` (the empty-corpus and ForceGraph-unavailable paths). On the next button click, `showCorpus` re-enters the `if (!CorpusGraph)` branch and calls `buildCorpusGraph` again, which appends a fresh `statusEl` div to `#corpus-graph`. After N clicks the container holds N stacked "No docs yet" (or "Failed to load corpus") overlays. The overlays are `pointer-events:none` so users cannot clear them; they persist until the page reloads.

Additionally, in the empty-corpus case `showCorpus` returns before `container.classList.add('open')` runs, so the status message appended to `#corpus-graph` remains invisible (`display:none`) — the user gets no feedback at all on the first click, and stacked invisible divs accumulate on subsequent ones.

**Fix:** Use a sentinel that distinguishes "never tried" from "tried and got null":

```js
const CORPUS_FAILED = Symbol('failed');   // sentinel for "tried, got null"
// ...
let CorpusGraph = null;
let _corpusBuildAttempted = false;

async function showCorpus() {
  if (!_corpusBuildAttempted) {
    _corpusBuildAttempted = true;
    CorpusGraph = await buildCorpusGraph();
  }
  // Whether build succeeded or not, open the container so status text is visible.
  container.classList.add('open');
  if (brainEl) brainEl.style.visibility = 'hidden';
  if (!CorpusGraph) {
    // Update button state so user can toggle back.
    corpusActive = true;
    corpusBtn.setAttribute('aria-label', 'Show brain');
    corpusBtn.setAttribute('title', 'Show brain');
    corpusBtn.innerHTML = ICON_BRAIN;
    corpusBtn.classList.add('corpus-active');
    return;
  }
  // ... rest of showCorpus
}
```

---

## Warnings

### WR-01: Center force captures stale container dimensions at build time

**File:** `src/viz/modules/corpus.js:184-185`

**Issue:** The inline centering force captures `cx` and `cy` from `container.clientWidth` and `container.clientHeight` at the moment `buildCorpusGraph` runs. At that point `#corpus-graph` still has `display:none` (the container is opened after `buildCorpusGraph` returns in `showCorpus`), so `clientWidth` and `clientHeight` are both `0`. The fallback to `window.innerWidth/innerHeight` happens to produce correct values today because the corpus fills the full window, but the center coordinates are captured once and never updated — a later resize changes `container` dimensions but does not re-center the force.

**Fix:** Move the `cx`/`cy` computation inside the force function body so it is evaluated on each tick:

```js
const centerForce = Object.assign(
  function(alpha) {
    const cx = (container.clientWidth || window.innerWidth) / 2;
    const cy = (container.clientHeight || window.innerHeight) / 2;
    const k = 0.05 * alpha;
    for (const n of _cNodes) {
      if (n.fx == null) n.vx = (n.vx || 0) + (cx - n.x) * k;
      if (n.fy == null) n.vy = (n.vy || 0) + (cy - n.y) * k;
    }
  },
  { initialize(nodes) { _cNodes = nodes; } }
);
```

---

### WR-02: `showBrain` restores topic/search display with empty string — wrong in non-window mode

**File:** `src/viz/modules/corpus.js:308-311`

**Issue:** `showBrain` (and the equivalent block in `showCorpus`) hides topic/search panels by setting `style.display = 'none'`, then restores them with `style.display = ''` (empty string). Resetting to `''` defers to the element's CSS-specified display. In `.mode-window` context this works because `.mode-window #topic-wrap { display: block }` wins. However: the corpus toggle is already gated to `.mode-window` only (`#btn-corpus { display:none }` base rule), so in practice the empty-string reset lands in the right context. The defect is latent: if corpus is ever enabled in non-window mode, setting `style.display = ''` on an element whose base CSS is `display:none` will silently keep it hidden with no error. A defensive restore explicitly sets `display = 'block'` or preserves the original value before hiding.

**Fix:** Cache and restore the original display rather than clearing the inline style:

```js
// At showCorpus time:
const topicWrap = document.getElementById('topic-wrap');
const searchWrap = document.getElementById('search-wrap');
const _twDisplay = topicWrap ? topicWrap.style.display : '';
const _swDisplay = searchWrap ? searchWrap.style.display : '';
if (topicWrap) topicWrap.style.display = 'none';
if (searchWrap) searchWrap.style.display = 'none';

// At showBrain time:
if (topicWrap) topicWrap.style.display = _twDisplay;
if (searchWrap) searchWrap.style.display = _swDisplay;
```

---

### WR-03: `#corpus-graph` `display:none` blocks `.corpus-status` visibility on first empty open

**File:** `src/viz/modules/corpus.js:110-115` and `src/viz/css/styles.css:803-805`

**Issue:** When the corpus is empty, `buildCorpusGraph` appends the status element to `#corpus-graph` and returns `null`. `showCorpus` then hits `if (!CorpusGraph) return` at line 275 and exits **before** `container.classList.add('open')` runs. The status element sits inside a `display:none` container — the user sees nothing. The `#corpus-graph` element only becomes visible when `.open` is added. Since the open is never reached, the "No docs yet" message is permanently invisible on the first click. (On a second click, CR-02 applies: another overlay is appended, still to a hidden container.)

**Fix:** In `showCorpus`, open the container and update button state regardless of whether `CorpusGraph` is null (as shown in the CR-02 fix above). The status element is already in the container; making the container visible is the only missing step.

---

## Info

### IN-01: Repeated `getElementById` lookups for topic/search panels across three call sites

**File:** `src/viz/modules/corpus.js:288-291, 308-311, 338-341`

**Issue:** `document.getElementById('topic-wrap')` and `document.getElementById('search-wrap')` are called identically in `showCorpus`, `showBrain`, and `ctx.returnToCorpus`. The DOM won't change between calls; cache at `initCorpus` time alongside the other DOM refs.

**Fix:**

```js
// Add at the top of initCorpus, alongside corpusBtn/container/brainEl:
const topicWrap  = document.getElementById('topic-wrap');
const searchWrap = document.getElementById('search-wrap');
// Then replace all three sets of getElementById calls with the cached refs.
```

---

_Reviewed: 2026-06-20_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
