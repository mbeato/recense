---
phase: 39-reader-wiki-parity-index-and-backlinks
plan: 01
subsystem: viz/reader
tags: [wiki-parity, backlinks, reader, read-only, WIKI-02, WIKI-03]
dependency_graph:
  requires: []
  provides: [GET /doc/backlinks route, fetchBacklinks reader hook, atom cited-by detail panel]
  affects: [src/viz/server.ts, src/viz/modules/reader.js, src/viz/modules/detail.js, src/viz/css/styles.css]
tech_stack:
  added: []
  patterns: [prepared-statement-once, non-fatal-async-fetch, textContent-only-DOM, muted-rose-slate-palette]
key_files:
  created:
    - tests/doc-backlinks.test.ts
  modified:
    - src/viz/server.ts
    - src/viz/modules/reader.js
    - src/viz/modules/detail.js
    - src/viz/css/styles.css
decisions:
  - "stmtDocBacklinks compiled once at server construction — not inside handler (prepared-statement-once pattern)"
  - "stmtCitingDocs (reverse-cites for atom view) compiled once at construction beside stmtDocBacklinks"
  - "fact param validated to hex+dash charset; fact with no citing docs returns citedByDocs:[] (no 404)"
  - "populateDetail stays synchronous; fetchAtomBacklinks is fire-and-forget async (non-fatal, same as fetchStaleness)"
  - "backlinks section appended at body bottom in reader (D-07 — staleness banner stays at top)"
  - "detail panel atom backlinks section appended after connections list"
metrics:
  duration_minutes: 25
  completed_date: "2026-06-21"
  tasks_completed: 2
  tasks_deferred: 1
  files_changed: 5
  commits: 2
---

# Phase 39 Plan 01: Backlinks Route + Reader "Referenced by" Summary

Read-only `GET /doc/backlinks` route (doc and atom view) with muted rose/slate "Referenced by" section in the reader and "Cited by" in the atom detail panel — WIKI-02 presentation parity with zero engine change.

## Tasks

### Task 1: GET /doc/backlinks read-only route (COMPLETE)
**Commit:** `049fdc6`

Added `stmtDocBacklinks` and `stmtCitingDocs` prepared statements compiled once at server construction (beside `stmtDocLinks`, server.ts ~line 237). The `/doc/backlinks` handler:

- **Doc view** (`?slug=`): slug sanitized via `.toLowerCase().replace(/[^a-z0-9-]/g,'').slice(0,64)` → `stmtGetDoc` resolves to doc row → `stmtDocBacklinks.all(docRow.id)` returns incoming edges filtered to `kind IN ('doc_link','doc_reference','doc_containment')` (D-06 — engine kinds excluded) → responds `{backlinks:[{srcId,slug,label,kind}]}`
- **Atom view** (`?fact=`): fact id validated to hex+dash charset → `stmtCitingDocs.all(factId)` returns citing doc nodes via reverse `cites` edges → responds `{citedByDocs:[{srcId,slug,label}]}`
- Empty cases return 200 with empty arrays (no 404 for a valid doc/fact with zero backlinks)
- 404 for unknown slug, 400 for empty/missing slug (when no `fact` param either), 403 for bad Host (inherited loopback guard), 500 on DB error
- GET-only, no new `Database()`, no write-path mutation (WIKI-03/T-39-03)

**Tests:** `tests/doc-backlinks.test.ts` — 13 tests green covering all cases listed above plus D-06 engine-kind exclusion and read-only invariant (exactly 1 `new Database` in server.ts).

### Task 2: Reader "Referenced by" + atom "Cited by" + CSS (COMPLETE)
**Commit:** `323ce28`

**reader.js:**
- `async fetchBacklinks()` added after `fetchStaleness`, modeled exactly on `fetchStaleness` (non-fatal try/catch, early-return on `!res.ok`, early-return when `backlinks.length === 0` — no empty chrome)
- Builds `.backlinks-section > .backlinks-heading + .backlinks-list > li > a.doc-ref` entirely via `createElement`/`textContent` (T-10-12/T-27-08)
- Each `<a>` click calls `ctx.openReader(null, { from: openFrom, docId: bl.srcId })` — reuses existing reader-open path
- Section appended to `body` (not prepended — staleness banner stays at top, D-07)
- Called via `await fetchBacklinks()` between `fetchStaleness` and `fetchMeta` in the render path

**detail.js:**
- `async fetchAtomBacklinks(factId, container)` added — fire-and-forget from `populateDetail` for fact/atom nodes
- Fetches `/doc/backlinks?fact=<id>`, early-returns when empty (no chrome), removes prior `.backlinks-section` on re-selection
- Renders "Cited by" heading with same `.backlinks-*` CSS classes; `ctx.openReader` click handler
- Non-fatal on error (detail panel renders correctly without this enhancement)

**styles.css:**
- `.backlinks-section`: `rgba(139,112,144,0.09)` fill, `rgba(139,112,144,0.4)` border-left, `margin-top:20px`
- `.backlinks-heading`: `#c8bcd0` color, 11px uppercase label
- `.backlinks-list li a`: `#9a8aa4` color, dotted underline; hover `#c8bcd0`
- No amber (`#ffb866`) anywhere in these rules (T-39-04, founder palette lock)

### Task 3: Founder verification checkpoint — DEFERRED
Task 3 (human-verify checkpoint, `gate="blocking"`) was NOT executed. Per orchestrator decision (`workflow.human_verify_mode = end-of-phase`), all human visual verification is batched at end-of-phase. The founder verification steps from the plan (copy live DB, build + start viz, confirm "Referenced by" section, empty-hides-section, atom "cited by", palette check) are deferred to the end-of-phase checkpoint.

## Verification Results

```
npx vitest run tests/doc-backlinks.test.ts   → 13/13 pass
npx vitest run tests/viz-frontend-static.test.ts → 46/46 pass
npx vitest run                               → 2044/2044 pass, 3 skipped
npm run build (tsc)                          → clean (no errors)
grep -v '^[[:space:]]*//' src/viz/server.ts | grep -c "new Database" → 1
```

## Deviations from Plan

None — plan executed exactly as written.

- The TDD RED/GREEN cycle was followed for Task 1 (test written first, confirmed failing, then implementation added to make all 13 pass).
- Task 2 is not marked `tdd="true"` in the plan so no separate RED/GREEN commit cycle required; `viz-frontend-static.test.ts` was used for regression verification.

## Known Stubs

None — no hardcoded empty values or placeholder text in any delivered code path. The empty-backlinks early-return is intentional (must-have truth #2) and is verified by test.

## Threat Flags

No new security-relevant surface beyond what the plan's threat model covers. The `/doc/backlinks` route is strictly read-only, loopback-only, and binds to the same prepared-statement security pattern as the existing `/doc/staleness` route. T-39-01 through T-39-SC mitigations all implemented as planned.

## Self-Check

- [x] `src/viz/server.ts` modified — exists and contains `stmtDocBacklinks` + `/doc/backlinks` handler
- [x] `tests/doc-backlinks.test.ts` created — 13 tests green
- [x] `src/viz/modules/reader.js` modified — contains `fetchBacklinks` and `await fetchBacklinks()`
- [x] `src/viz/modules/detail.js` modified — contains `fetchAtomBacklinks` and `/doc/backlinks?fact=`
- [x] `src/viz/css/styles.css` modified — contains `.backlinks-section`, `.backlinks-heading`, `.backlinks-list`
- [x] Commits `049fdc6` (Task 1) and `323ce28` (Task 2) exist on main
- [x] Full vitest suite: 2044 pass, 0 fail
- [x] `npm run build` clean
- [x] Read-only invariant: exactly 1 `new Database` in server.ts

## Self-Check: PASSED
