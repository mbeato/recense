---
phase: 27-reader-layer
plan: "04"
subsystem: reader-viz-staleness
tags: [staleness, reader, viz-server, xss-safe, atom-panel-diff, regenerate]
dependency_graph:
  requires: [v11-schema, node-doc-sidecar, generate-doc-cli, db-backed-doc-route, fact-ref-atom-focus, READER-02]
  provides: [staleness-endpoint, staleness-banner, inline-stale-markers, atom-panel-diff, regenerate-cta, READER-03]
  affects:
    - src/viz/server.ts
    - src/viz/modules/reader.js
    - src/viz/modules/detail.js
    - src/viz/css/styles.css
    - tests/doc-staleness.test.ts
tech_stack:
  added: []
  patterns:
    - compile-once-stmt-staleness
    - read-only-staleness-endpoint
    - textContent-only-staleness-banner
    - ctx-staleFactIds-detail-handoff
    - regenerate-spawn-via-post-doc-generate
key_files:
  created:
    - tests/doc-staleness.test.ts
  modified:
    - src/viz/server.ts
    - src/viz/modules/reader.js
    - src/viz/modules/detail.js
    - src/viz/css/styles.css
decisions:
  - "staleness endpoint classifies tombstoned facts separately from stale (last_access > generated_at) so the banner can report 'N changed, M removed' accurately"
  - "tombstoned cited refs are made pointer-events:none at mark time (not CSS alone) for reliable non-clickability across browsers"
  - "staleness banner uses muted rose/slate palette (NOT amber) — amber is founder-locked to activation only; static warning chrome uses the muted slate/mauve tones"
  - "btn-regen is styled muted slate, same palette logic — regenerate is a user action, not an activation event"
  - "ctx.staleFactIds and ctx.staleFactPrevValues stored on ctx after fetchStaleness so detail.js can access them synchronously when populateDetail fires"
  - "fetchStaleness called BEFORE fetchMeta so stale markers are on the DOM before graph focus is applied (order matters for visual consistency)"
  - "regenerate clears staleFactIds/staleFactPrevValues + ctx before reloading so a fresh load does not inherit the old stale state"
  - "stmtCitedFacts compiled once at startup (compile-once pattern) alongside stmtCitedIds — reads n.tombstoned to classify removed refs without a second query"
metrics:
  duration: "~40 min (incl. founder palette re-tone)"
  completed: "2026-06-18"
  tasks_completed: 3
  files_changed: 5
  checkpoint_task: "Task 3 (human-verify staleness detection + diff + regenerate) — APPROVED by founder; one palette fix applied (.fact-stale orange→rose)"
---

# Phase 27 Plan 04: Citation Staleness Summary

**One-liner:** `/doc/staleness` endpoint + staleness banner with regenerate CTA + inline stale/tombstoned markers + prev_value→value diff in the atom panel (READER-03, D-10).

## What Was Built

### Task 1: GET /doc/staleness endpoint (cites reverse-lookup, last_access vs generated_at)

**src/viz/server.ts:**
- Added `stmtCitedFacts` prepared statement compiled once at startup: `SELECT ce.dst AS factId, n.value, n.prev_value, n.prev_ts, n.last_access, n.tombstoned FROM edge ce JOIN node n ON n.id = ce.dst WHERE ce.src = ? AND ce.kind = 'cites'`. Joins cites-edge reverse lookup to the cited fact rows.
- `GET /doc/staleness?slug=` route: looks up doc node via existing `stmtGetDoc` (reuses the 27-03 stmt), then runs `stmtCitedFacts` and classifies each cited fact as `tombstoned` (tombstoned=1) or `stale` (last_access > generated_at). Unchanged facts excluded.
- Returns `{generated_at, stale:[{factId, prev_value, value}], tombstoned:[factId,...]}`.
- Read-only SELECT only (T-27-13) — staleness detection never advances `last_access` of the cited facts it inspects. Inherits Host-header loopback guard (T-10-09).

**tests/doc-staleness.test.ts:** 10 tests covering:
- `generated_at` from `node_doc` row returned correctly
- Changed fact (last_access > T0, prev_value set) appears in `stale` with prev_value + current value
- Tombstoned cited fact appears in `tombstoned`
- Unchanged fact (last_access < T0) excluded from both lists
- 404 for unknown slug
- 400 for empty slug, 400 for missing slug param
- 403 for mismatched Host header (loopback guard)
- Source assertions: `/doc/staleness` in server.ts; `kind='cites'` reverse lookup present

All on a TEMP throwaway DB (`/tmp/staleness-test-*.db`); canonical `~/.config/recense/recense.db` never touched; spawn mocked.

### Task 2: Staleness banner + inline markers + atom-panel diff + regenerate

**src/viz/modules/reader.js:**
- `fetchStaleness()` async function called after `wireFactLinks()` (before `fetchMeta`): fetches `/doc/staleness?slug=`, classifies cited refs, updates stale state, marks inline refs, prepends banner.
- Inline ref marking: `.fact-stale` added for stale refs + `a.dataset.prevValue` set; `.fact-tombstoned` added for tombstoned refs + `pointer-events:none` + `aria-label='cited fact was removed'` + `title='cited fact was removed'`.
- Staleness banner: `div.staleness-banner` prepended to `reader-body` (via `insertBefore`). Count text built with `textContent` only (T-27-12): e.g. "2 cited facts changed, 1 removed since this was written". Contains a `.btn-regen` button wired to `regenerate()`.
- `ctx.staleFactIds` (Set) and `ctx.staleFactPrevValues` (Map id→prev_value) stored so `detail.js` can access them synchronously in `populateDetail`.
- `regenerate()`: removes banner, shows loading indicator, POSTs to `/doc/generate?slug=` (force), clears stale state on ctx, then reloads via `loadWithPoll()` — reuses the existing poll loop.

**src/viz/modules/detail.js:**
- `populateDetail`: after the existing fields loop, appends a `.meta-row.meta-diff` row when `node.prev_value && ctx.staleFactIds && ctx.staleFactIds.has(node.id)`. Row built with `createElement` + `textContent` only for the `prev_value` (hard invariant T-27-12 / T-10-12, line 184).
- Shows "was: `<prev_value>`" — one-deep history matching the SPEC §3 `prev_value/prev_ts` semantics.

**src/viz/css/styles.css:**
- `.staleness-banner`: muted rose/slate palette (`rgba(139,112,144,0.09)` background, `rgba(139,112,144,0.4)` left border) — NOT amber (amber is activation-only per founder-locked palette).
- `.btn-regen`: muted slate at rest, slightly brighter on hover.
- `.meta-diff`, `.meta-diff .meta-key`, `.meta-diff .meta-val`: italic muted-mauve value text for the diff row.
- `.fact-stale` and `.fact-tombstoned` rules already existed from 27-03; no duplication.

### Task 3: Human-verify — APPROVED (with one palette fix)

Demo DB prepared at `/tmp/staleness-demo.db`:
- Copied `~/.config/recense/recense.db` + WAL + SHM files.
- Fact `05ea9c70-...` (changed): `last_access` advanced past `generated_at`; `prev_value` = prior text of "The web chat interface is a message drafting workspace...".
- Fact `06e46335-...` (tombstoned): `tombstoned=1` set.
- All other cited facts remain unchanged.

Founder verified the banner, tombstone marker, atom-panel diff, and detection — all good. ONE
palette fix requested before close: the `.fact-stale` marker used orange/amber
(`rgba(217,130,60,...)` ≈ `#d9823c`), which is the activation color — a violation of the
founder-locked rule (amber/orange is ACTIVATION-ONLY; static markers use muted rose/slate/mauve).

**Re-tone applied (commit `fcaa1e9`):** `.fact-stale` now uses the established `.doc-ref` rose
family (`rgba(156,112,128,...)`) — `border-bottom-color: rgba(156,112,128,0.85)` + a faint
`rgba(156,112,128,0.08)` background tint. Same visual structure (stronger bottom-border + faint
tint so the ref still reads as marked), just muted rose instead of orange. `.fact-tombstoned`
(muted red, fine for "removed") and `.staleness-banner` (already palette-compliant mauve) were
NOT touched. Dist rebuilt (`npm run build` → copy-viz-assets landed the updated styles.css).
Tests green; tsc clean. Review server still on port 7818 against the re-seeded demo DB — founder
to hard-reload `http://127.0.0.1:7818/?doc=tonos&reader=1` to confirm the rose tone.

## Deviations from Plan

**1. [Founder palette fix] Re-toned `.fact-stale` from orange to muted rose**
- **Found during:** Task 3 human-verify
- **Issue:** The `.fact-stale` inline marker (carried over from 27-03) used orange/amber `rgba(217,130,60,...)` — the founder-locked activation color. Static markers must use muted rose/slate/mauve.
- **Fix:** Re-toned to the `.doc-ref` rose family `rgba(156,112,128,...)` (border 0.85 + 0.08 bg tint). `.fact-tombstoned` and `.staleness-banner` untouched.
- **Files modified:** `src/viz/css/styles.css`
- **Commit:** `fcaa1e9`

## Known Stubs

None. Task 3 approved by founder; the only requested change (palette re-tone) is applied.

## Threat Flags

None beyond the plan's `<threat_model>`:
- **T-27-12** (XSS): staleness banner count text set via `textContent`; `prev_value` diff row set via `textContent` (never `innerHTML` with node values). Verified by source grep.
- **T-27-13** (D-43 self-confirmation): `/doc/staleness` is a read-only SELECT; `stmtCitedFacts` never touches `last_access` of cited facts. Detecting staleness does not strengthen the facts it inspects.
- **T-27-14** (DoS/spend): `regenerate()` reuses the 27-03 in-flight-slug guard via `POST /doc/generate`; user-initiated; loopback-only.

## Self-Check

- `src/viz/server.ts` — MODIFIED: `/doc/staleness` route present, `stmtCitedFacts` compiled once
- `src/viz/modules/reader.js` — MODIFIED: `fetchStaleness`, `regenerate`, `staleness-banner`, `fact-stale`, `/doc/generate` all present
- `src/viz/modules/detail.js` — MODIFIED: `prev_value` diff row, `meta-diff` class, textContent-only
- `src/viz/css/styles.css` — MODIFIED: `.staleness-banner`, `.btn-regen`, `.meta-diff` rules added; `.fact-stale` re-toned to muted rose
- `tests/doc-staleness.test.ts` — CREATED: 10 tests, temp DB, spawn mocked
- `npx vitest run tests/doc-staleness.test.ts tests/reader-render.test.ts` — 31/31 pass
- `npx tsc --noEmit` — clean
- Commits: `63dbe0f` (Task 1), `f38a9ec` (Task 2), `fcaa1e9` (palette re-tone)

## Self-Check: PASSED

- Files created/modified: all found (verified on disk)
- Commits verified: `63dbe0f`, `f38a9ec`, `fcaa1e9` all in git log
- Tests: 31/31 pass
- TypeScript: clean
- Dist: rebuilt with rose tone (`rgba(156,112,128,0.85)` confirmed in dist/src/viz/css/styles.css)
