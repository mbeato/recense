---
phase: 34
slug: visual-polish-pass
status: draft
shadcn_initialized: false
preset: none
created: 2026-06-20
---

# Phase 34 — UI Design Contract: Visual Polish Pass

> Polish pass over the four live viz surfaces (Reader, Corpus 2D graph, Detail panel/page,
> Brain HUD/controls). Two axes only: **spacing/alignment consistency** and **states &
> transitions** (loading/empty/error, hover/focus, smooth transitions). This is a CSS +
> state-handling diff — no structural/composition redesign.
>
> All items traced to 34-ROUGH-EDGES.md (founder-pointed inventory). B1 is already
> resolved (`ae812c5`). Remaining: B2, B3, C1, C2, R1.

---

## Design System

| Property | Value |
|----------|-------|
| Tool | none — hand-crafted CSS (no shadcn, no Tailwind) |
| Preset | not applicable |
| Component library | none |
| Icon library | Inline SVG only — no external dep (net-zero rule) |
| Font (UI chrome) | `system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif` |
| Font (data/code) | `ui-monospace, SFMono-Regular, Menlo, monospace` |

Source: `src/viz/css/styles.css` (single stylesheet; no build step on the frontend).

**Primary visual anchor:** the 3D brain viz canvas (`#graph`) — the full-bleed focal
point of the primary screen. It is unchanged by this pass (density anchor founder-locked);
all chrome polished here recedes around it.

---

## Spacing Scale

### Part 1 — Canonical scale (multiples of 4 ONLY)

These are the ONLY tokens the executor may use for any **new** spacing declaration
introduced during this pass. Every value is a multiple of 4.

| Token | Value | Usage |
|-------|-------|-------|
| xs | 4px | Small inline padding, min border-radius |
| base | 8px | Meta grid gap, input inner padding, divider-adjacent margin |
| md | 12px | Panel horizontal padding (`#panel`), button horizontal padding, section breathing room |
| lg | 16px | Detail panel horizontal padding, major section pad, topic-section separation (B2) |
| xl | 24px | Reader section margins |
| 2xl | 40px | Reader bottom padding (`#reader` padding-bottom) |

### Part 2 — Pre-existing exceptions (accepted — do NOT replicate for new declarations)

These are off-canonical values already baked into the live CSS. They are accepted as-is to
keep this a polish (not a re-architecture) pass. The executor must **preserve** them where
they exist but must **NOT** use them for any new spacing it writes.

| Value | Where it lives | Justification | Guard |
|-------|----------------|---------------|-------|
| **2px** (micro) | Border widths + scrollbar thumb border (`.staleness-banner` left border, `.detail-page #detail::-webkit-scrollbar-thumb` border, etc.) | Hairline borders read correctly only at sub-4px; a 4px border would visibly thicken the chrome | Do NOT introduce 2px as a margin/padding/gap on any NEW declaration — borders only |
| **6px** (sm — the "tight gap" token) | Pervasive flex-row gap: `.status-row`, `.actions-row`, `#panel .actions-row`, `.row` gaps; list-row inner gaps; `.conn-link` left margin; `#reader-head` bottom margin (R1) | The entire HUD's compact rhythm is built on this 6px gap; replacing it with 8px would loosen and reflow every control row — a structural change, out of scope | Do NOT replicate 6px for NEW spacing — new gaps use `base` (8px); existing 6px gaps stay untouched |
| **`22px 26px 40px`** | `#reader` padding (R1 relocates the 22px top into the sticky head) | Reader prose column dimensions tuned for reading measure, not token-derived | Preserve the 26px horizontal / 40px bottom; only the top value relocates per R1 |
| **`5px 9px`** | `#tooltip` padding | Compact floating overlay sized tight to its text | Preserve as-is; do not normalize |

### Normalizations applied this pass (off-canonical → canonical)

- `.divider { margin: 10px 0; }` → `12px 0` (snap to `md` token)
- `#detail-title { margin: 8px 0 6px; }` → `8px 0 8px` (snap 6px bottom → `base` token)

---

## Typography

### Canonical scale (4 sizes, 2 active weights)

| Role | Size | Weight | Line Height |
|------|------|--------|-------------|
| Body | 13px | 400 | 1.5 |
| Label / meta | 11px | 400 | 1.4 |
| Node title / Reader h2 | 15px | 500 | 1.3 |
| Reader h1 | 19px | 700 — UA heading default, do NOT set explicitly | 1.2 |

> The two **active** weights the executor may set are 400 and 500. Reader h1's 700 is the browser's UA default for `<h1>` — it is inherited, not declared. Do not add an explicit `font-weight: 700` rule.

### Pre-existing carve-outs — executor must preserve, NOT introduce or remove

These three sizes exist in the live CSS for specific surfaces and are intentional. They
are NOT part of the canonical scale above (the canonical scale has 4 entries, not 7); the
executor must leave them exactly as-is and must not add new type at these sizes.

- **13.5px @ 1.62** — Reader body prose (`#reader-body`): wider measure for sustained reading. Unchanged.
- **12px monospace** — Stats / data values (`.stat`, `.meta-val`, `.data-value`): mono data feel. Unchanged.
- **10px uppercase, 0.08em tracking** — Kicker / topic-header / tag labels (`#reader-kicker`, `#topic-header`, `.tip-tag`, `.conn-rel`): demoted micro-labels. Unchanged.

---

## Color

| Role | Value | Usage |
|------|-------|-------|
| Dominant (60%) | `#170f1d` | Full-bleed background, canvas backing |
| Secondary (30%) | `rgba(26, 18, 32, 0.66–0.93)` | Panel backgrounds (`#panel`, `#detail`, `#reader`), tooltip backing |
| Accent (10%) | `#d9a05c` / `rgba(217, 160, 92, …)` | See reserved list below |
| Destructive | `rgba(220, 60, 60, …)` / `#f08080` | `.toast`, `.error-badge` — error surfacing only |

**Accent `#d9a05c` is reserved for:**

- Button `:hover` border tint
- `#search-input` `:focus` border
- `.result-row` / `.topic-row` `:hover` border
- Corpus graph node `:hover` fill (`HOVER_NODE` in `corpus.js`)
- `.fact-ref` underline and `:hover` background tint
- `.conn-link` `:hover` color
- SSE dot/label when disconnected (amber = pending/reconnecting signal)
- `#reader-title` text (the currently-viewed doc name — treated as active/opened state)
- Brain node activation glow (Three.js material — not CSS)

**NOT amber at any rest or non-activation state (founder-locked guard):**

- Buttons at rest: `rgba(170,150,180,0.07)` background + `rgba(170,150,180,0.18)` border
- `#reader-close` at rest: `#8b7090` (muted mauve); hover: `#c8cfd8` (slate) — never amber
- `#btn-corpus` active: rose border `rgba(156,112,128,0.55)` — muted rose, not amber
- Loading, empty, error states: muted mauve/slate palette only
- Topic chips, search results, corpus status labels: muted slate `#a99db3` / `#6b5f73`

**Node type palette (rest):**

| Node type | Color | Hex |
|-----------|-------|-----|
| Entity | Dusty rose | `#9c7080` |
| Fact | Slate | `#6d7890` |
| Schema | Muted mauve | `#82698c` |
| Corpus doc node | Dusty rose (matches entity) | `#9c7080` |

---

## Copywriting Contract

| Element | Copy |
|---------|------|
| Corpus loading state | `Loading corpus…` |
| Corpus empty state heading | `No docs yet` |
| Corpus empty state body | `run recense generate-doc <slug>` (monospace `<code>` inline) |
| Corpus error (fetch fails) | `Failed to load corpus` (via existing `.toast`) |
| Reader loading (lazy doc gen) | `Generating…` + progress bar — existing `.doc-progress-label` (no change) |
| Reader error | existing `.toast` pattern (no change) |
| Detail empty connections | `none` via `.conn-empty` — EXISTING, no change |
| HUD error | existing `.toast` pattern (no change) |

Copy register: lowercase, terse, no punctuation — consistent with existing HUD/panel copy (`connecting…`, `live`, `no topics yet`).

No destructive actions in Phase 34 (B1 resolved; no delete/regen confirmation flows added).

---

## Registry Safety

| Registry | Blocks Used | Safety Gate |
|----------|-------------|-------------|
| shadcn official | none | not applicable |
| Third-party | none | not applicable |

No registry. Net-zero runtime dependency rule holds. All icon glyphs are inline SVG.

---

## Polish Contract

Concrete prescriptions per rough-edge item. The executor implements these exactly; no
discretion on scope. Changes are CSS-only unless noted.

---

### R1 — Sticky Reader Close Button

**Surface:** Reader overlay (`#reader`, `#reader-head`, `#reader-close`)
**Rough-edge axis:** States & transitions (close button scrolls out of reach)
**File:** `src/viz/css/styles.css`

**Current:** `#reader-head` is in normal flow inside `#reader` (which is `position: fixed;
overflow-y: auto`). The close `×` scrolls away on long docs.

**Prescribed CSS change:**

1. Remove `padding-top: 22px` from `#reader` (move it into the head):

```css
#reader {
  padding: 0 26px 40px; /* was: 22px 26px 40px */
}
```

2. Make `#reader-head` sticky with a solid background so scrolling content doesn't
   bleed through:

```css
#reader-head {
  position: sticky;
  top: 0;
  z-index: 1;
  background: rgba(20, 14, 26, 0.97);
  /* Bleed to reader edges to cover full-width scrolling content */
  margin-left: -26px;
  margin-right: -26px;
  padding-left: 26px;
  padding-right: 28px;       /* preserve clearance for the absolute-positioned × */
  /* Carry the original reader top padding + bottom breathing room */
  padding-top: 20px;
  padding-bottom: 12px;
  margin-bottom: 6px;        /* sm "tight gap" exception — preexisting rhythm */
}
```

`#reader-close` styling is unchanged: muted mauve at rest (`#8b7090`), slate on hover
(`#c8cfd8`), no amber. The original `padding-right: 28px` (close-button clearance) is
folded into the rule above.

---

### B2 — HUD Declutter in Expanded Mode

**Surface:** Brain HUD controls (`#panel`, `.actions-row`, `#search-wrap`, `#topic-wrap`)
**Rough-edge axis:** Spacing / alignment (too many controls crowding the graph)
**Files:** `src/viz/index.html`, `src/viz/css/styles.css`

**Current:** `.actions-row` has 5 buttons (tombstones, reader, corpus, log, test-trace).
The corpus button moves out in C1, leaving 4. Log and test-trace are debug tools that
crowd the panel in the main window.

**Prescribed changes:**

**index.html:** Remove `<button id="btn-test-trace">` entirely (the HTML comment already
labels it "Temporary: manual trace trigger for design verification" — it is no longer
needed post-Phase 19).

**styles.css:** Hide `#btn-log` in expanded (`.mode-window`) mode — it remains visible
in tray/popover mode where browser devtools are absent:

```css
.mode-window #btn-log { display: none; }
```

**styles.css:** Add breathing room between the search and topics sections (`lg` token):

```css
#topic-wrap {
  margin-top: 16px;  /* was 12px — lg token */
  border-top: 1px solid rgba(140, 150, 165, 0.08);
  padding-top: 12px; /* md token */
}
```

Result in `.mode-window` actions row: `[Show tombstones] [Reader]` — two focused
controls, no debug noise.

---

### B3 — Topics Hidden in Corpus View

**Surface:** Brain HUD topics (`#topic-wrap`, `#search-wrap`)
**Rough-edge axis:** States & transitions (mode-state visibility)
**File:** `src/viz/modules/corpus.js`

**Current:** `#topic-wrap` and `#search-wrap` stay visible when the corpus view is open.

**Prescribed JS changes in `corpus.js`:**

In `showCorpus()`, after `container.classList.add('open')`:

```js
const topicWrap = document.getElementById('topic-wrap');
const searchWrap = document.getElementById('search-wrap');
if (topicWrap) topicWrap.style.display = 'none';
if (searchWrap) searchWrap.style.display = 'none';
```

In `showBrain()`, after `container.classList.remove('open')`:

```js
const topicWrap = document.getElementById('topic-wrap');
const searchWrap = document.getElementById('search-wrap');
if (topicWrap) topicWrap.style.display = '';
if (searchWrap) searchWrap.style.display = '';
```

Also in `ctx.returnToCorpus` (the corpus-under-reader return path) — apply the same
hide so topics stay hidden when the reader closes back to corpus:

```js
if (topicWrap) topicWrap.style.display = 'none';
if (searchWrap) searchWrap.style.display = 'none';
```

`#panel` and its node count / SSE status remain visible in corpus view (they don't
crowd the 2D canvas and provide useful context).

---

### C1 — Corpus Icon Button in Fixed Button Cluster

**Surface:** Corpus toggle button (`#btn-corpus`)
**Rough-edge axis:** Spacing / alignment (button placement + icon)
**Files:** `src/viz/index.html`, `src/viz/css/styles.css`, `src/viz/modules/corpus.js`

**Current:** `#btn-corpus` is a text button (`Corpus` / `Brain`) inside
`#panel > .actions-row`. Only visible in `.mode-window` via CSS gate.

**Target:** Book-icon fixed button between the collapse button (top: 10px) and the
recenter button (currently top: 46px) in the `.mode-window` cluster.

**index.html change:** Move `#btn-corpus` out of `.actions-row` to a top-level sibling
of `#btn-recenter`. Replace its text content with an inline book SVG:

```html
<button id="btn-corpus" type="button" aria-label="Corpus graph" title="Corpus">
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
  </svg>
</button>
```

**styles.css:** Replace the existing `#btn-corpus` / `.mode-window #btn-corpus` /
`#btn-corpus.corpus-active` rules with:

```css
/* Corpus toggle — icon-only fixed button, matches recenter cluster */
#btn-corpus {
  display: none; /* hidden in popover/tray */
}
.mode-window #btn-corpus {
  position: fixed;
  top: 46px;    /* below collapse: 10px top + 30px height + 6px gap */
  right: 12px;
  width: 30px;
  height: 30px;
  padding: 0;
  margin: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 70;
  border-radius: 7px;
  background: rgba(26, 18, 32, 0.7);
  border: none;
  color: #d9cbc0;
  opacity: 0.65;
  cursor: pointer;
  -webkit-app-region: no-drag;
  transition: opacity 0.15s ease;
}
.mode-window #btn-corpus:hover { opacity: 1; }

/* Active: corpus is shown — muted rose border (NOT amber) */
.mode-window #btn-corpus.corpus-active {
  opacity: 1;
  color: #c8bcd0;
  border: 1px solid rgba(156, 112, 128, 0.55);
}

/* Push recenter down to accommodate the corpus button */
.mode-window #btn-recenter {
  top: 82px; /* 10 + 30 + 6 (corpus) + 30 + 6 = 82px */
}
```

**corpus.js:** The button no longer has text content — remove the
`corpusBtn.textContent = 'Brain'` / `'Corpus'` assignments. Convey state via
`aria-label` + `title` updates and the `.corpus-active` class (already implemented):

In `showCorpus()`: `corpusBtn.setAttribute('aria-label', 'Show brain'); corpusBtn.setAttribute('title', 'Show brain');`

In `showBrain()`: `corpusBtn.setAttribute('aria-label', 'Corpus graph'); corpusBtn.setAttribute('title', 'Corpus');`

`.corpus-active` class add/remove stays as-is.

---

### C2 — Corpus Force Layout: Contained Graph, Not Sparse Scatter

**Surface:** Corpus 2D graph (`corpus.js`)
**Rough-edge axis:** Spacing / alignment (visual framing of the node layout)
**File:** `src/viz/modules/corpus.js`
**Research finding:** Default `d3.forceManyBody` strength is `-30` — weak repulsion.
With small/medium doc corpora and sparse edges, nodes disperse to the canvas edges.
Strengthening the charge and shortening link distance pulls the graph into a legible
cluster. `fitAndClamp()` + `onEngineStop` already handles zoom framing — keep as-is.

**Prescribed JS changes in `buildCorpusGraph()`, after the `ForceGraph()` chain:**

```js
// Tune force params for compact corpus framing (net-zero deps — tuning internal
// d3-force references held by the force-graph instance, no import needed).
try {
  const charge = G.d3Force('charge');
  if (charge && typeof charge.strength === 'function') charge.strength(-80);
  const link = G.d3Force('link');
  if (link && typeof link.distance === 'function') link.distance(50);
} catch (_) { /* non-fatal if force-graph doesn't expose d3Force */ }
```

`MAX_ZOOM = 2.5` unchanged. `fitAndClamp()` on `onEngineStop` unchanged. If tuning
alone doesn't frame a very sparse graph (1–3 nodes), the 350ms fallback `fitAndClamp()`
call in `showCorpus()` is already the safety net — do not add additional timers.

---

### Corpus State Coverage (VIZ-POLISH-02 gap — no ROUGH-EDGES item)

**Surface:** Corpus 2D graph (`corpus.js`, `css/styles.css`)
**Axis:** States & transitions
**Gap:** No UI feedback during `buildCorpusGraph()` fetch + init; no empty state when
`data.nodes.length === 0`; fetch errors are silently swallowed.

**Prescribed CSS addition (`styles.css`):**

```css
/* Corpus status overlay (loading / empty / error) */
.corpus-status {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  text-align: center;
  pointer-events: none;
  color: #6b5f73;
  font-size: 13px;
  font-style: italic;
  line-height: 1.8;
}
.corpus-status code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: #8b7090;
  font-style: normal;
}
```

(`#corpus-graph` is `position: fixed; inset: 0` — this establishes the containing block
for `position: absolute` children. No `position: relative` needed.)

**Prescribed JS addition in `buildCorpusGraph()`:**

Before the `fetch`:

```js
// Loading indicator — shown immediately while fetch + graph init runs
const statusEl = document.createElement('div');
statusEl.className = 'corpus-status';
statusEl.textContent = 'Loading corpus…';
container.appendChild(statusEl);
```

After `if (res.ok) data = await res.json();` and the `catch` block, inside the `catch`:

```js
} catch (_) {
  if (statusEl) statusEl.textContent = 'Failed to load corpus';
}
```

After the `nodeSlugs` / `nodeLabels` loop, add:

```js
if ((data.nodes || []).length === 0) {
  // Empty state copy
  statusEl.innerHTML =
    'No docs yet<br><code>recense generate-doc &lt;slug&gt;</code>';
  return null; // bail — no graph to build; statusEl stays as the empty state
}
// Data present: remove loading overlay before first graph paint
statusEl.remove();
```

Palette: `#6b5f73` and `#8b7090` are muted mauve/slate — no amber.

---

### Detail Panel — Spacing Normalization (audit finding)

**Surface:** Detail panel / page (`#detail`, `.divider`, `#detail-title`)
**Axis:** Spacing / alignment
**File:** `src/viz/css/styles.css`

Audit finding (no founder-flagged rough edge — this is the UI-phase audit of the
"no item yet" surface):
- `.divider { margin: 10px 0; }` is off the canonical scale (nearest tokens: 8px base or 12px md)
- `#detail-title { margin: 8px 0 6px; }` has a 6px bottom margin (nearest token: 8px base)

Both are ≤2px adjustments — no visual regression risk.

**Prescribed CSS change:**

```css
.divider        { margin: 12px 0; }        /* was 10px — normalized to md token */
#detail-title   { margin: 8px 0 8px; }     /* was 8px 0 6px — normalize 6px→8px base */
```

---

## Transition Specifications

All transitions must match the existing system. No new durations or easings introduced.

| Interaction | Duration | Easing | Target |
|-------------|----------|--------|--------|
| Panel slide-in | 220ms | `cubic-bezier(0.22, 1, 0.36, 1)` | `#detail`, `#reader` (existing) |
| Button hover | 150ms | `ease` | `button`, `#btn-recenter`, `#btn-corpus` |
| Result / topic row hover | 120ms | `ease` | `.result-row`, `.topic-row` |
| Opacity reveal | 200ms | `ease` | `#panel` hover, `#btn-recenter` hover |
| Toast | 200ms | `ease` | `.toast` opacity |
| Reader slide | 220ms | `ease` | `#reader.open` transform |
| Corpus status overlay | none (instant) | — | `.corpus-status` (sync with data fetch) |
| `#btn-corpus` hover opacity | 150ms | `ease` | same as `#btn-recenter` |

---

## Checker Sign-Off

- [ ] Dimension 1 Copywriting: PASS
- [ ] Dimension 2 Visuals: PASS
- [ ] Dimension 3 Color: PASS
- [ ] Dimension 4 Typography: PASS
- [ ] Dimension 5 Spacing: PASS
- [ ] Dimension 6 Registry Safety: PASS

**Approval:** pending
