---
phase: 28-schema-anchored-corpus
plan: "04"
subsystem: viz
tags: [corpus, doc-graph, edge-styling, CORPUS-04]
dependency_graph:
  requires: [28-01]
  provides: [CORPUS-04-endpoint, CORPUS-04-renderer]
  affects: [src/viz/server.ts, src/viz/modules/corpus.js]
tech_stack:
  added: []
  patterns:
    - link-kind-aware force-graph styling (linkColor/linkWidth/linkDirectionalArrowLength/linkLineDash callbacks)
    - both-endpoints-live-doc SQL guard (T-28-DANGLE)
key_files:
  created: []
  modified:
    - src/viz/server.ts
    - src/viz/modules/corpus.js
    - tests/viz-corpus-graph.test.ts
decisions:
  - stmtDocLinks replaced with three-kind IN (...) + both-endpoints-live-doc subquery guard
  - CONTAINMENT_COLOR = stronger muted slate/mauve (rgba(110,90,130,0.70)) — NOT amber (founder-locked palette)
  - linkDirectionalArrowLength(4) for containment, 0 for reference/doc_link — directed spine via D-08
  - linkLineDash([2,2]) for doc_reference (undirected dashed), null for containment/doc_link (solid)
  - onNodeClick/openDocReader unchanged (27-03/27-05 in-place open preserved)
metrics:
  duration: "~12 minutes"
  completed: "2026-06-19"
  tasks_completed: 2
  tasks_total: 3
  files_modified: 3
  test_suite: "49/49 (viz-corpus-graph 25 + viz-server 24)"
---

# Phase 28 Plan 04: Corpus Endpoint + Link-Kind Styling Summary

**One-liner:** Schema-corpus endpoint now returns doc_containment + doc_reference + doc_link edges between live doc nodes only; corpus.js renders containment as a solid directed spine (heavier, arrowed) and reference as faint dashed cross-links — D-08 hierarchy legibility.

## Tasks Completed

| Task | Description | Commit | Files |
|------|-------------|--------|-------|
| 1 | `/graph?type=doc` returns all three doc-edge kinds; tombstoned-endpoint guard | `b20523d` | `src/viz/server.ts`, `tests/viz-corpus-graph.test.ts` |
| 2 | `corpus.js` link-kind-aware styling (containment solid/directed; reference faint/dashed) | `b5f1b5f` | `src/viz/modules/corpus.js` |
| 3 | Hero verify — legible forest on live brain (checkpoint:human-verify) | APPROVED (2026-06-19) | — |

## What Was Built

### Task 1 — `/graph?type=doc` endpoint (server.ts)

Replaced `stmtDocLinks`:

**Before:** `SELECT src,dst,rel,w,kind FROM edge WHERE kind='doc_link'`

**After:**
```sql
SELECT src,dst,rel,w,kind FROM edge
  WHERE kind IN ('doc_link','doc_containment','doc_reference')
    AND src IN (SELECT id FROM node WHERE type='doc' AND tombstoned=0)
    AND dst IN (SELECT id FROM node WHERE type='doc' AND tombstoned=0)
```

The both-endpoints-live-doc subquery guard (T-28-DANGLE) prevents dangling edges from reaching the renderer. The handler's `type==='doc'` branch and the `LinkRecord` map (which already carried `kind`) were left unchanged — the three kinds flow through to the payload automatically.

Unskipped the CORPUS-04 describe block in `viz-corpus-graph.test.ts` (was `describe.skip` with 7 todos); implemented all 7 tests covering:
- doc_containment edges appear in corpus payload
- doc_reference edges appear in corpus payload
- Non-doc edge kinds (cites, relation) never leak through
- Tombstoned-endpoint edges are excluded (T-28-DANGLE)
- Source assertion: stmtDocLinks has all three kind values + tombstoned=0 guard

### Task 2 — corpus.js link-kind styling (corpus.js)

Added `CONTAINMENT_COLOR = 'rgba(110,90,130,0.70)'` — a slightly stronger muted slate/mauve than `LINK_REST` (still NOT amber, not cyan; founder-locked palette rule preserved).

Replaced flat `.linkColor(() => LINK_REST).linkWidth(1)` with kind-aware callbacks:

```js
.linkColor(link => link.kind === 'doc_containment' ? CONTAINMENT_COLOR : LINK_REST)
.linkWidth(link => link.kind === 'doc_containment' ? 2 : 1)
.linkDirectionalArrowLength(link => link.kind === 'doc_containment' ? 4 : 0)
.linkDirectionalArrowRelPos(1)
.linkLineDash(link => link.kind === 'doc_reference' ? [2, 2] : null)
```

Visual semantics (D-08):
- **doc_containment**: solid (no dash) + directed (arrow at child end, `arrowRelPos=1`) + heavier line (width 2) — the parent→child hierarchy spine
- **doc_reference**: faint dashed undirected cross-link (width 1, `[2,2]` dash, no arrow)
- **doc_link**: existing faint mauve solid treatment (width 1, no arrow, no dash) — unchanged

`onNodeClick` → `openDocReader` → `ctx.openReader(slug, { from: 'corpus' })` chain left UNCHANGED (27-03/27-05 in-place open preserved).

## Test Results

```
Test Files  2 passed (2)
      Tests  49 passed (49)    (viz-corpus-graph: 25, viz-server: 24)
```

CORPUS-04 describe block: 7/7 green (was all todos under describe.skip).
Full viz-server regression: 24/24 unchanged (full-brain /graph endpoint unaffected).

Build: `tsc` clean + `npm run build` succeeds (corpus.js copied to dist via copy-viz-assets).

## Acceptance Criteria Verification

| Criterion | Status |
|-----------|--------|
| `grep -c "doc_containment','doc_reference"` ≥1 in server.ts | PASS (1 hit) |
| `stmtDocNodes` unchanged (JOIN node_doc for slug) | PASS — untouched |
| `/graph?type=doc` payload `links` includes all three kinds | PASS — 3 tests confirm |
| Tombstoned-doc endpoint excluded from payload | PASS — test seeds + verifies |
| Full-brain `/graph` unchanged (viz-server tests green) | PASS — 24/24 |
| `grep -c "doc_containment"` ≥2 in corpus.js | PASS (4 hits) |
| `grep -c "linkDirectionalArrowLength\|linkLineDash"` ≥1 each | PASS (1 each) |
| No amber/cyan in rest-state link constants (CONTAINMENT_COLOR, LINK_REST) | PASS |
| onNodeClick → openDocReader chain unchanged | PASS |
| `npm run build` succeeds | PASS |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] READER-04 source test `kind='doc_link'` pattern no longer matched**
- **Found during:** Task 1 test run
- **Issue:** Existing test `source: server.ts has kind=doc_link filter for corpus endpoint` used regex `kind\s*=\s*'doc_link'` which no longer matches after the IN (...) replacement.
- **Fix:** Updated test description and assertion to check that all three kinds appear in server.ts source (the new IN clause contains all three).
- **Files modified:** `tests/viz-corpus-graph.test.ts`
- **Commit:** `b20523d`

**2. [Rule 1 - Bug] CORPUS-04 linkColor test matched `amber` in pre-existing comments**
- **Found during:** Task 2 first test run
- **Issue:** Test assertion `.not.toMatch(/amber|ff8c00|00bfff|cyan/i)` flagged existing comments in corpus.js ("warm amber — ACTIVATION ONLY") that were never link styling.
- **Fix:** Narrowed the assertion to check only the `const CONTAINMENT_COLOR` and `const LINK_REST` definition lines (not comments) for amber/cyan hex codes.
- **Files modified:** `tests/viz-corpus-graph.test.ts`
- **Commit:** `b20523d`

## Threat Surface Scan

No new network endpoints or trust boundaries introduced. The `/graph?type=doc` endpoint remains read-only SELECT; the both-endpoints guard closes T-28-DANGLE. Consistent with T-28-VIZ read-only posture.

## Checkpoint (Task 3 — Human Verify): APPROVED 2026-06-19

Founder verified the corpus on a WAL-safe live-brain copy (`/tmp/corpus28.db`) and approved ("approved feels wayyy better"). Live evidence: `promote-corpus` produced 17 schemas / 7 containment + 2 reference edges with a 4-deep parent→child nest (GSD Phase 4 → Plan phases and tasks → Phase 04 plans → Phase execution completion); all 17 schema docs generated with 0 invented citations (1 doc had 1 dead link); `PRAGMA foreign_key_check` empty.

Two gaps the founder caught during verify were fixed in-session before approval (commits a61d289 / d7e5a45 / 03f899a / de1b8d5): (1) corpus nodes showed schemaId UUIDs → resolved human schema labels; (2) clicking a node showed empty/raw `{"status":"generating"}` → schema-anchored lazy generation wired + `res.ok`-vs-202 bug fixed + a real elapsed/ETA progress bar. Fill-in-place (stable corpus-edge invariant) was proven on live data: a regenerated parent's 4 containment edges did not dangle. Eager offline generation (CORPUS-06) was added so corpus prose generates in the sleep pass rather than on-click.

## Self-Check: PASSED

- `src/viz/server.ts` modified: confirmed (b20523d)
- `src/viz/modules/corpus.js` modified: confirmed (b5f1b5f)
- `tests/viz-corpus-graph.test.ts` modified: confirmed (b20523d)
- Commits exist: b20523d, b5f1b5f — confirmed via git log
- 49/49 tests passing, tsc clean, build succeeds
