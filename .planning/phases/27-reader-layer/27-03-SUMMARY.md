---
phase: 27-reader-layer
plan: "03"
subsystem: reader-viz
tags: [reader, viz-server, db-backed-doc, lazy-generate, reader-brain-toggle, graph-focus, xss-safe]
dependency_graph:
  requires: [v11-schema, node-doc-sidecar, upsertNodeDoc, generate-doc-cli, READER-01]
  provides: [db-backed-doc-route, doc-meta-endpoint, lazy-generate-spawn, reader-brain-toggle, fact-ref-atom-focus, graph-focus-cited-atoms, READER-02]
  affects:
    - src/viz/server.ts
    - src/viz/modules/reader.js
    - src/viz/css/styles.css
    - tests/viz-doc-route.test.ts
    - tests/reader-render.test.ts
tech_stack:
  added: []
  patterns:
    - db-backed-route-replace-file-read
    - lazy-generate-spawn-detached
    - in-flight-slug-dedup
    - poll-until-doc-ready
    - reader-brain-toggle-altitude
    - graph-focus-cited-client-side
    - selection-preserved-across-toggle
    - xss-escape-textContent-innerHTML-guard
key_files:
  created:
    - tests/viz-doc-route.test.ts
    - tests/reader-render.test.ts
  modified:
    - src/viz/server.ts
    - src/viz/modules/reader.js
    - src/viz/css/styles.css
    - src/viz/index.html
decisions:
  - "spawnGenerateDoc is a closure inside startVizServer — closes over dbPath and inFlightSlugs; no arg-passing needed at call sites"
  - "Graph focus via Graph.nodeColor()/linkColor() callbacks (client-side, no server filter) — cited set is small, already fetched from /doc/meta; lighter than a server nodeIds filter"
  - "Selection is NOT cleared on hide() — ctx.selectNode sets selectedId on ctx; detail.js keeps its panel; the toggle feels like one system at two altitudes"
  - "POLL_MAX=60 at POLL_MS=2000ms = 120s max wait for lazy generation (matches doc-gen 600s timeout; generation is typically faster)"
  - "liftGraphFocus() restores Graph.nodeColor(null).linkColor(null) so brain view returns to normal on hide()"
  - "Reader needs an in-panel close — the open slide-in #reader covers #btn-reader, so the toggle is physically unreachable from inside the reader; added #reader-close × in the header"
  - "Close button styled muted-mauve/slate, NOT amber — amber is activation-only per the founder-locked palette; static chrome never uses it"
  - "#reader scrollbar reuses the .detail-page #detail muted-mauve scrollbar treatment verbatim for visual consistency"
metrics:
  duration: "~60 min (incl. 2 post-verify UX fixes)"
  completed: "2026-06-18"
  tasks_completed: 2
  files_changed: 6
  checkpoint_task: "Task 3 (human-verify hero interaction) — founder verified round-trip works; 2 UX gaps fixed, ready for reload-confirm"
---

# Phase 27 Plan 03: Reader UI Promotion Summary

**One-liner:** DB-backed `/doc?slug=` route with lazy-generate spawn (server stays read-only) + promoted reader.js with Reader/Brain toggle, fact-ref→atom focus, and graph focus on cited atoms.

## What Was Built

### Task 1: DB-backed /doc route + lazy-generate spawn + /doc/meta endpoint

**src/viz/server.ts:**
- Replaced file-backed `/doc?term=` route (reads `scripts/reader-slice/out/<term>.md`) with DB-backed `/doc?slug=` route reading `node WHERE type='doc' AND node_scope.scope=slug AND tombstoned=0`.
- Removed `DOC_ROOT` constant entirely (grep confirms 0 occurrences).
- On miss: spawns `generate-doc-cli.js` as a detached subprocess (T-27-11 — server stays read-only; all writes inside the CLI). Returns 202 `{status:'generating'}` immediately; client polls.
- Added `GET /doc/meta?slug=` returning `{nodeId, generated_at, citedFactIds:[...]}` — drives the graph focus step.
- Added `POST /doc/generate?slug=` for force-regeneration (returns 202 immediately).
- In-flight Set (`inFlightSlugs`) prevents duplicate concurrent spawns for the same slug (T-27-10).
- Slug sanitized to `[a-z0-9-]`, length-capped to 64 chars before DB lookup or spawn.
- All routes inherit the Host-header loopback guard (T-10-09).
- Two new prepared statements compiled once at startup: `stmtGetDoc` (doc node by slug) and `stmtCitedIds` (outgoing `kind='cites'` edges).

**tests/viz-doc-route.test.ts:** 13 tests covering:
- 200 on seeded slug (markdown body returned)
- 202 on missing slug (spawn triggered, verified via mock)
- 400 on empty/missing slug param
- Slug sanitization (path traversal chars stripped → DB miss → 202)
- `/doc/meta` returns nodeId + generated_at + citedFactIds (two facts seeded)
- `/doc/meta` returns 404 for unknown slug
- `POST /doc/generate` returns 202 and triggers spawn
- Host-header 403 on `/doc` and `/doc/meta`
- DOC_ROOT source assertion (0 occurrences confirmed)

All on a temp DB; canonical `~/.config/recense/recense.db` never touched; spawn mocked.

### Task 2: Promote reader.js — DB-backed load, Reader/Brain toggle, fact-ref→atom focus, graph-focus on cited atoms

**src/viz/modules/reader.js:**
- Changed `load()` to fetch `/doc?slug=` (was `/doc?term=`).
- On 202 `{status:'generating'}`: shows `generating doc... (N/60)` progress state; polls every 2s (max 120s) until markdown arrives (D-03 single loading path).
- After render: `body.innerHTML = renderMarkdown(md)` — only innerHTML call in the module (T-10-12/T-27-08).
- Fetches `/doc/meta?slug=` after render to get `citedFactIds`; stores on `ctx.citedFactIds`.
- **Reader/Brain toggle:** `show()` adds `.open` class + sets `btn.textContent = 'Brain'`; `hide()` removes + sets 'Reader'. Graph focus applied on `show()`, lifted on `hide()`.
- **Graph focus on cited atoms:** `applyGraphFocus(ids)` sets `Graph.nodeColor()` callback to dim nodes not in the cited set (non-cited → `rgba(80,60,90,0.18)`); `Graph.linkColor()` dims non-cited links. Client-side per D-CONTEXT — cited set is small (already fetched from /doc/meta), lighter than a server nodeIds filter.
- **Selection preserved across toggle:** `hide()` does NOT clear `ctx.selectedId` or `ctx.selectNode`. The detail panel (detail.js) stays open with the selected atom when the reader closes.
- **wireFactLinks:** on fact-ref click, `hide()` first (closes reader), then `ctx.selectNode(node)` (camera-focus + detail panel). Selection set BEFORE toggle opens brain → atom visible at focus.
- `renderMarkdown`, `escapeHtml`, `renderInline`, `FACT_LINK`, `DOC_LINK` kept verbatim from slice (pure, tested).

**src/viz/css/styles.css:**
- Added `.fact-ref.fact-stale` (orange-underline for changed facts), `.fact-ref.fact-tombstoned` (strikethrough + dim), `.reader-loading` (italic muted text) classes.

**tests/reader-render.test.ts:** 21 tests covering:
- XSS: `<img onerror=...>`, `<script>`, `<b>`, `&`, `"` all escaped
- `recense://fact/<36-char-uuid>` → `<a class="fact-ref" data-fact="...">` (full UUID required)
- `recense://doc/<slug>` → `<a class="doc-ref" data-doc="...">`
- Truncated 8-char id does NOT match FACT_LINK (canonicalized body guarantees full UUIDs)
- Plain markdown links stripped to text (no outbound nav)
- Block-level: h1/h2/h3, hr, ul/li, p
- Inline: `**bold**`, `` `code` ``, inside list items
- Source assertions: `fetch('/doc?slug=')`, `/doc/meta`, `selectNode`, single `innerHTML` assignment

### Task 3: Human-verify hero interaction — VERIFIED (round-trip works) + 2 post-verify UX fixes

The founder exercised the prose→atom→brain→prose round-trip in the browser and confirmed it
works (one system at two altitudes). Two UX gaps were found and fixed before close (commit `5fefcac`):

**UX fix 1 — Reader dismiss button.** The open `#reader` slide-in panel (`transform: translateX(0)`)
physically COVERS `#btn-reader`, so once the reader is open the toggle is unreachable. Added an
explicit in-panel close affordance:
- `#reader-close` × button in `#reader-head` (index.html), wired to the existing `hide()` (which
  already lifts graph focus) in `initReader`. The existing `#btn-reader` toggle still works from
  brain view.
- Also bound `Escape` to `hide()` when the reader is open (guarded — only fires when `.open`).
- Styled muted-mauve (`#8b7090`) at rest, slate (`#c8cfd8`) on hover — NOT amber (amber is
  activation-only per the founder-locked palette; static chrome never uses it). Positioned
  top-right of the header via `position:absolute`; `#reader-head` gets `padding-right:28px` so
  the title never collides with it.

**UX fix 2 — Palette-styled reader scrollbar.** `#reader` has `overflow-y:auto` but no scrollbar
rules → default browser scrollbar. Added the SAME treatment as `.detail-page #detail`: thin, 8px,
transparent track, rounded thumb with `rgba(170,150,180,0.28)` (brighter `0.45` on hover),
`scrollbar-color` for Firefox. Reuses the exact muted-mauve values for visual consistency.

Toggle/focus logic was NOT touched — only the dismiss affordance and scrollbar were added.
Dist rebuilt (`npm run build` → copy-viz-assets). 34 tests green, tsc clean.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test assertion wrong — "onerror" text exists in escaped output**
- **Found during:** Task 2 test run
- **Issue:** The XSS test asserted `not.toContain('onerror')` — but the escaped HTML correctly contains the *literal text* `onerror` (harmless — the browser sees `&lt;img ...onerror=alert(1)&gt;`, a text node). The safety guarantee is `<img ` (raw tag) is absent.
- **Fix:** Changed assertion to `not.toContain('<img ')` (raw tag) + verify `&lt;img` present.
- **Files modified:** `tests/reader-render.test.ts`
- **No commit needed** — caught before committing the test.

**2. [Rule 1 - Bug] Slug sanitization test expected 400 but `<script>` → `script` (valid slug)**
- **Found during:** Task 1 test run (`sanitizes slug` test)
- **Issue:** `%3Cscript%3E` URL-decodes to `<script>`, which the regex `[^a-z0-9-]` strips to `script` — a valid slug. Expected 400, got 202 (correct server behavior: `script` not in DB → generates).
- **Fix:** Changed test to use `../../etc/passwd` → sanitizes to `etcpasswd` → DB miss → 202. Tests path-traversal sanitization works correctly at DB level (no file read, T-27-11).
- **Files modified:** `tests/viz-doc-route.test.ts`
- **No commit needed** — caught before committing the test.

## Known Stubs

The hero interaction (READER-02) is pending human verification (Task 3 checkpoint). The loading state is functional but doc generation only completes if the `generate-doc` CLI can connect to the model provider.

**Graph focus limitation:** `Graph.nodeColor()/linkColor()` callbacks work when the `ctx.Graph` instance is initialized. In a fresh load where graph hasn't rendered yet, `applyGraphFocus` is a no-op (try/catch guards). Focus is re-applied on the next `show()`.

## Threat Flags

None beyond the plan's `<threat_model>`:
- **T-27-08** (XSS): all text runs through `escapeHtml` → `renderMarkdown`; only `innerHTML` is from `renderMarkdown` output (never raw fact values). Verified by test + source assertion (1 innerHTML in module).
- **T-27-09** (ref injection): FACT_LINK/DOC_LINK strict regex (36-char UUID / slug); refs on data-attributes only; never eval'd.
- **T-27-10** (spend/spawn storm): in-flight Set + slug sanitize + Host-header guard.
- **T-27-11** (server read-only): DOC_ROOT removed; spawn-only write path; 0 write SQL in server.ts (verified by grep in test suite).

## Self-Check

- `src/viz/server.ts` — MODIFIED, DOC_ROOT=0 confirmed
- `src/viz/modules/reader.js` — MODIFIED, fetch /doc?slug= + /doc/meta + selectNode confirmed
- `src/viz/css/styles.css` — MODIFIED, .fact-stale + .fact-tombstoned + .reader-loading added
- `tests/viz-doc-route.test.ts` — CREATED, 13 tests pass
- `tests/reader-render.test.ts` — CREATED, 21 tests pass
- `npx tsc --noEmit` — clean
- Commits `61caf40`, `473cb7c` — in git log

## Self-Check: PASSED

- Files created/modified: all found
- Commits verified: `61caf40` (Task 1), `473cb7c` (Task 2)
- Tests: 34/34 pass (13 viz-doc-route + 21 reader-render)
- TypeScript: clean
