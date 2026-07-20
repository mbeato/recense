---
phase: 34-visual-polish-pass
plan: "02"
subsystem: viz
tags: [css, html, js, polish, corpus, force-graph, state-coverage]
requires: [34-01]
provides: [corpus-topic-hide-show, corpus-icon-button, corpus-force-tuning, corpus-state-coverage]
affects: [src/viz/modules/corpus.js, src/viz/css/styles.css, src/viz/index.html]
tech_stack:
  added: []
  patterns: [mode-state-visibility-toggle, icon-only-fixed-button, d3force-internal-tuning, inline-status-overlay]
key_files:
  created: []
  modified:
    - src/viz/modules/corpus.js
    - src/viz/css/styles.css
    - src/viz/index.html
decisions:
  - "returnToCorpus also hides topics/search to prevent them reappearing when reader closes back to corpus"
  - "#btn-corpus placed immediately before #btn-recenter in HTML for DOM order clarity (sibling, not nested)"
  - ".mode-window #btn-recenter top changed from 46px to 82px (10+30+6+30+6) to accommodate corpus button"
  - "statusEl created before fetch so loading text shows even on near-instant cached responses"
  - "Empty-state catch: statusEl.textContent set in catch even if error path exits early (statusEl stays visible)"
  - "corpus-active in returnToCorpus uses same aria-label='Show brain' path as showCorpus (consistent state)"
metrics:
  duration: "~5 min"
  completed: "2026-06-21"
  tasks_completed: 3
  files_changed: 3
---

# Phase 34 Plan 02: Visual Polish Pass — Corpus Surface Summary

Corpus-surface polish: topics/search hidden in corpus mode, book-icon fixed button replacing text toggle, d3-force layout tuned for a contained cluster, and full loading/empty/error state coverage in muted mauve/slate palette.

## Tasks Completed

| # | Name | Commit | Files |
|---|------|--------|-------|
| 1 | B3 — hide topics/search in corpus view | 4d3b038 | src/viz/modules/corpus.js |
| 2 | C1 — corpus icon button in fixed cluster | 96f0eba | src/viz/index.html, src/viz/css/styles.css, src/viz/modules/corpus.js |
| 3 | C2 force tuning + corpus state coverage | ee68e9f | src/viz/modules/corpus.js, src/viz/css/styles.css |

## What Was Built

**Task 1 (B3):** In `showCorpus()`, after `container.classList.add('open')`, both `#topic-wrap` and `#search-wrap` are set to `display: none`. In `showBrain()`, after `container.classList.remove('open')`, both are restored to `display: ''`. In `ctx.returnToCorpus`, both are also set to `none` — ensures topics stay hidden when the reader closes back to corpus view. `#panel` (node count + SSE status) left visible in all states.

**Task 2 (C1):** `#btn-corpus` removed from `.actions-row` in `index.html` and placed as a top-level sibling of `#btn-recenter`, carrying the inline book SVG (`viewBox="0 0 24 24"`, two `<path>` elements), `aria-label="Corpus graph"`, `title="Corpus"`, no `class="btn-sm"`. CSS `#btn-corpus` block replaced: `display: none` by default; `.mode-window #btn-corpus` is `position: fixed; top: 46px; right: 12px; width: 30px; height: 30px` with muted palette and `transition: opacity 0.15s ease`; `.mode-window #btn-corpus.corpus-active` uses muted rose border `rgba(156, 112, 128, 0.55)` (not amber). `.mode-window #btn-recenter` updated to `top: 82px` (10+30+6+30+6). All three `corpusBtn.textContent` assignments removed from `corpus.js`; state conveyed via `setAttribute('aria-label', …)` / `setAttribute('title', …)` in `showCorpus`, `showBrain`, and `returnToCorpus`.

**Task 3 (C2 + state coverage):** d3-force tuning added after `G` is assigned — `G.d3Force('charge').strength(-80)` and `G.d3Force('link').distance(50)`, both guarded in `try/catch`, no new imports. `buildCorpusGraph()` now creates a `.corpus-status` div before the fetch (`Loading corpus…`), sets `Failed to load corpus` in the catch, renders the empty-state (`No docs yet` + `<code>recense generate-doc &lt;slug&gt;</code>`) and `return null` when `data.nodes.length === 0`, and calls `statusEl.remove()` before first graph paint when data is present. CSS appends `.corpus-status` (`color: #6b5f73; font-style: italic`) and `.corpus-status code` (`color: #8b7090; font-style: normal`) — muted mauve/slate, no amber.

## Deviations from Plan

None — plan executed exactly as written.

## Threat Flags

None — pure client-side DOM toggling, CSS, static HTML relocation, and force-param tuning. The `/graph?type=doc` fetch is unchanged; empty/error copy is static literals (no interpolation of fetched data into innerHTML). Net-zero deps confirmed.

## Known Stubs

None.

## Self-Check: PASSED

- `src/viz/modules/corpus.js` exists; `getElementById('topic-wrap')` appears 3×; `statusEl.textContent = 'Loading corpus…'`, `Failed to load corpus`, `No docs yet`, `charge.strength(-80)`, `link.distance(50)` all present; zero `corpusBtn.textContent` assignments.
- `src/viz/index.html` contains `aria-label="Corpus graph"` on `#btn-corpus`; `#btn-corpus` is not inside `.actions-row`; no `class="btn-sm"` on it.
- `src/viz/css/styles.css` contains `top: 46px` on `.mode-window #btn-corpus`, `border: 1px solid rgba(156, 112, 128, 0.55)` on corpus-active rule, `top: 82px` on `.mode-window #btn-recenter`, `.corpus-status {` with `color: #6b5f73`.
- Amber guard: no `#d9a05c` or `rgba(217, 160, 92` on corpus-status or btn-corpus rest rules.
- Commits 4d3b038, 96f0eba, ee68e9f all present on main.
