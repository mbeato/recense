---
phase: 39-reader-wiki-parity-index-and-backlinks
plan: 02
subsystem: viz/reader
tags: [wiki-parity, index, reader, read-only, WIKI-01, WIKI-03]
dependency_graph:
  requires:
    - phase: 39-01
      provides: GET /doc/backlinks route, .backlinks-* CSS, stmtDocBacklinks/stmtCitingDocs
  provides: [GET /index read-only route, initIndex module, #btn-index toolbar button, #index-panel container]
  affects: [src/viz/server.ts, src/viz/modules/index.js, src/viz/modules/app.js, src/viz/index.html, src/viz/css/styles.css]
tech_stack:
  added: []
  patterns: [prepared-statement-once, UUID-regex-grouping, textContent-only-DOM, muted-rose-slate-palette, lazy-fetch-panel]
key_files:
  created:
    - tests/viz-index-route.test.ts
    - src/viz/modules/index.js
  modified:
    - src/viz/server.ts
    - src/viz/index.html
    - src/viz/modules/app.js
    - src/viz/css/styles.css
key_decisions:
  - "UUID regex /^[0-9a-f]{8}-...-[0-9a-f]{12}$/i in the /index handler splits schema-anchored (UUID slug) from project-scoped (human slug) docs per D-03"
  - "stmtDocNodes reused (compiled once at server construction) — no new db.prepare inside the /index handler (prepared-statement-once pattern, T-39-07)"
  - "initIndex follows exact corpus.js shape — preparePromise memoizes on success, retries on error, eager setTimeout prepare"
  - "goToBrain() in index.js restores brainEl display without touching corpus.js state — isolation maintained between index and corpus views"
  - "Task 3 (human-verify checkpoint, gate=blocking) deferred to end-of-phase founder verification per orchestrator decision (workflow.human_verify_mode=end-of-phase)"
requirements_completed: [WIKI-01, WIKI-03]
duration: 35
completed: "2026-06-21"
---

# Phase 39 Plan 02: Browsable Index Route + UI Summary

`GET /index` live read-only projection (Projects/Schemas, COALESCE human labels) + `initIndex(ctx)` full-window toggle module + `#btn-index` toolbar button with muted rose/slate CSS — WIKI-01 browsable index over the live doc corpus, zero LLM cost.

## Performance

- **Duration:** ~35 min
- **Started:** 2026-06-21T16:10:00Z
- **Completed:** 2026-06-21T16:20:00Z
- **Tasks:** 2 auto-tasks complete (Task 3 human-verify deferred per orchestrator)
- **Files modified:** 6

## Accomplishments
- `GET /index` server route: reuses `stmtDocNodes`, groups docs by UUID regex, returns `{projects,schemas}` with COALESCE human labels (D-04), sorted by label. GET-only, no new Database, no LLM (WIKI-03/T-39-07).
- 12-test TDD suite (`tests/viz-index-route.test.ts`): coverage for 200 response, content-type, project/schema grouping, UUID label resolution, fallback-to-slug when schema node missing, field shape, Host-header guard, read-only invariant.
- `src/viz/modules/index.js`: `initIndex(ctx)` following corpus.js shape — lazy `buildIndexPanel()`, `preparePromise` memoization, `goToIndex`/`goToBrain` toggle, `ctx.openIndex` hook, eager `setTimeout` prepare.
- `src/viz/index.html`: `#btn-index` button (list SVG, `aria-label="Index"`) + `#index-panel` container added as siblings in the toolbar region.
- `src/viz/modules/app.js`: `import { initIndex }` + `initIndex(ctx)` after `initCorpus(ctx)`.
- `src/viz/css/styles.css`: `#btn-index` fixed button (`top:82px`, below `#btn-corpus`), `.index-active` active state, `#index-panel` full-bleed scrollable host, `.index-section/.index-heading/.index-list/.index-entry` muted rose/slate palette — no amber in any rest-state index chrome.

## Task Commits

Each task was committed atomically:

1. **Task 1 RED: Add failing tests for GET /index** - `1e517c5` (test)
2. **Task 1 GREEN: Add GET /index read-only route** - `efef77b` (feat)
3. **Task 2: Add #btn-index module + button + container + app.js wiring + muted CSS** - `d37f0f8` (feat)

## Files Created/Modified
- `tests/viz-index-route.test.ts` - 12 tests: grouping, label resolution, field shape, Host guard, read-only invariant
- `src/viz/server.ts` - GET /index handler added after /doc/backlinks, before /doc/generate
- `src/viz/modules/index.js` - initIndex(ctx) export: lazy fetch, Projects/Schemas render, toggle, ctx.openIndex
- `src/viz/index.html` - #btn-index button + #index-panel container
- `src/viz/modules/app.js` - import + initIndex(ctx) call
- `src/viz/css/styles.css` - #btn-index, #index-panel, .index-* chrome rules

## Decisions Made
- UUID regex grouping implemented in the route handler (not the DB query) — keeps the SQL clean and the logic at the application layer where it belongs.
- `goToBrain()` in `index.js` only restores `brainEl` display without touching the corpus container — corpus.js retains full ownership of corpus view state. Clean module isolation.
- `preparePromise` retries on error (like corpus.js) — a first open that fails leaves the index openable again without a page reload.

## Deviations from Plan

None — plan executed exactly as written.

- TDD RED/GREEN cycle followed for Task 1 (12 tests written and confirmed failing before implementation).
- Task 2 is not marked `tdd="true"` in the plan; `viz-frontend-static.test.ts` used for regression verification (46/46 pass).
- Task 3 (human-verify checkpoint, `gate="blocking"`) NOT executed. Per orchestrator decision (`workflow.human_verify_mode = end-of-phase`), all human visual verification is batched at end-of-phase. The founder verification steps (copy live DB, build + start viz, confirm Projects/Schemas grouping, click-to-open, brain-untouched toggle, muted palette) are deferred to the end-of-phase checkpoint.

## Verification Results

```
npx vitest run tests/viz-index-route.test.ts      → 12/12 pass
npx vitest run tests/viz-frontend-static.test.ts  → 46/46 pass
npx vitest run                                    → 2056/2056 pass, 3 skipped
npm run build (tsc)                               → clean (no errors)
grep -v '^[[:space:]]*//' src/viz/server.ts | grep -c "new Database" → 1
```

## Known Stubs

None — no hardcoded empty values or placeholder text. The 'Loading index…' status message is live UX copy during async fetch, replaced immediately with content or 'Failed to load index' on error.

## Threat Flags

No new security-relevant surface beyond the plan's threat model. T-39-05 through T-39-SC all implemented:
- `/index` takes no params — no untrusted input to SQL (T-39-05)
- loopback Host-header guard inherited, single-tenant local-only (T-39-06)
- GET-only, no new Database, one SELECT, no LLM/write (T-39-07)
- all DB-sourced strings set via `.textContent`; slug in navigation via `encodeURIComponent` (T-39-08)
- no new npm dependencies (net-zero deps; inline SVG icons) (T-39-SC)

## 39-01 Additive Invariant

39-01's `/doc/backlinks` route and `.backlinks-*` CSS are untouched. All edits to `server.ts` and `styles.css` were strictly additive alongside the 39-01 changes. The `stmtDocBacklinks` and `stmtCitingDocs` prepared statements remain intact.

## Self-Check

- [x] `tests/viz-index-route.test.ts` created — 12 tests green
- [x] `src/viz/server.ts` modified — contains `/index` handler using `stmtDocNodes`
- [x] `src/viz/modules/index.js` created — exports `initIndex`, contains `fetch('/index')`, Projects/Schemas render, doc= navigation
- [x] `src/viz/index.html` modified — contains `btn-index` and `index-panel`
- [x] `src/viz/modules/app.js` modified — contains import and `initIndex(ctx)` call
- [x] `src/viz/css/styles.css` modified — contains `#btn-index`, `#index-panel`, `.index-*` rules; no amber in index rest-state
- [x] Commits `1e517c5` (RED), `efef77b` (GREEN), `d37f0f8` (Task 2) exist on main
- [x] Full vitest suite: 2056 pass, 0 fail
- [x] `npm run build` clean
- [x] Read-only invariant: exactly 1 `new Database` in server.ts

## Self-Check: PASSED
