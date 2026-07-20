---
phase: 39-reader-wiki-parity-index-and-backlinks
verified: 2026-06-21T18:45:00Z
status: passed
score: 3/3 must-haves verified
overrides_applied: 0
---

# Phase 39: Reader Wiki-Parity — Browsable Index + Surfaced Backlinks Verification Report

**Phase Goal:** Close the two reader-layer ergonomics where recense trails the LLM Wiki pattern — a browsable INDEX (WIKI-01) and surfaced backlinks (WIKI-02) — without touching the engine (WIKI-03). Presentation-layer parity reusing existing doc nodes and reverse-edge lookup.
**Verified:** 2026-06-21T18:45:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| WIKI-01 | A browsable INDEX over live doc nodes is reachable as a navigable entry point, built over existing doc nodes, no new engine state | ✓ VERIFIED | `GET /index` route (server.ts:763-832) reuses compiled `stmtDocNodes` + `stmtDocLinks`, returns `{projects,schemas}` grouped by UUID regex (D-03), human COALESCE labels (D-04), nested-containment `parentId`/`depth`. Frontend `src/viz/modules/index.js` (292 lines) renders a corpus-docked left sidebar (hybrid Projects/Schemas nested tree + search filter), auto-opens with corpus via `corpus.js:381 ctx.openIndexSidebar()`, wired in `app.js:235`. Entries open the reader via `/?doc=<slug>&reader=1` (encodeURIComponent) or `ctx.openReader`. 15 route tests pass. |
| WIKI-02 | Viewing a doc surfaces incoming "referenced by" links; viewing an atom surfaces which docs cite it — read-only, zero online LLM cost | ✓ VERIFIED | `GET /doc/backlinks?slug=` returns incoming `doc_link`/`doc_reference`/`doc_containment` edges (server.ts:688-755, stmtDocBacklinks:245); `?fact=` returns reverse `cites` docs (stmtCitingDocs:260). `reader.js:415 fetchBacklinks()` appends "Referenced by" section (early-returns on empty — no chrome, line 421), each entry clickable via `ctx.openReader`. `detail.js:332 fetchAtomBacklinks()` surfaces atom "Cited by". 14 backlinks tests pass. |
| WIKI-03 | No engine change: no new node/edge types, no write-path mutation; read-only projections, self-confirmation guard untouched | ✓ VERIFIED | `grep -v '//' src/viz/server.ts \| grep -c "new Database"` == **1** (the readonly open at :137). New routes run only SELECT prepared statements compiled once at construction — no INSERT/UPDATE/DELETE/.run/embed/spawn/LLM/fetch in handlers (server.ts:681-832). Edge kinds used (`cites`, `doc_containment`, `doc_link`, `doc_reference`) are all pre-existing. No SQL/schema/migration files touched (`git diff --stat` over all phase commits shows only viz/ + tests + planning). |

**Score:** 3/3 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `src/viz/server.ts` | `GET /index` + `GET /doc/backlinks` read-only routes; stmtDocBacklinks/stmtCitingDocs/reused stmtDocNodes | ✓ VERIFIED | Both routes present + GET-only guarded; statements compiled once at construction; +190 lines |
| `src/viz/modules/index.js` | `initIndex(ctx)` sidebar, lazy `/index` fetch, Projects/Schemas tree | ✓ VERIFIED | Created, 292 lines; `export function initIndex`, `fetch('/index')`, nested tree + filter |
| `src/viz/modules/reader.js` | `fetchBacklinks()` appends "Referenced by", empty-hides | ✓ VERIFIED | reader.js:415; called at :248; early-return on empty at :421 |
| `src/viz/modules/detail.js` | atom "Cited by" via `/doc/backlinks?fact=` | ✓ VERIFIED | fetchAtomBacklinks:332; gate:322; WR-01 unconditional prior-removal :220-223 |
| `src/viz/modules/corpus.js` | sidebar auto-open hooks + containment-subtree highlight | ✓ VERIFIED | openIndexSidebar/closeIndexSidebar/highlightCorpusNode/isCorpusOpen hooks |
| `src/viz/modules/app.js` | `initIndex(ctx)` wired | ✓ VERIFIED | import :34, call :235 |
| `src/viz/css/styles.css` | `.backlinks-*` + `#index-panel`/`.index-*` muted palette, no amber | ✓ VERIFIED | All classes defined; no amber in index/backlinks rest-state chrome |
| `tests/doc-backlinks.test.ts` | route coverage incl. WR-04 dedup regression | ✓ VERIFIED | passes; 14 cases |
| `tests/viz-index-route.test.ts` | grouping/label/read-only coverage | ✓ VERIFIED | passes; 15 cases |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| reader.js | /doc/backlinks | `fetch('/doc/backlinks?' + docQuery())` | ✓ WIRED | reader.js:417, response rendered into `.backlinks-section` |
| /doc/backlinks | edge table | stmtDocBacklinks (doc_link/doc_reference/doc_containment) + stmtCitingDocs (cites) | ✓ WIRED | server.ts:245-269 |
| index.js | /index | `fetch('/index')` in buildIndexPanel | ✓ WIRED | index.js:222 |
| index.js | reader | entry click → `/?doc=` or ctx.openReader | ✓ WIRED | index.js:121 |
| /index | stmtDocNodes | reused compiled statement, grouped by scope | ✓ WIRED | server.ts:772 |
| corpus.js | index.js | goToCorpus → ctx.openIndexSidebar | ✓ WIRED | corpus.js:381 |

### Code-Review Warning Closure (REVIEW.md WR-01..WR-04)

| Warning | Fix | Status | Evidence |
| --- | --- | --- | --- |
| WR-01 stale "Cited by" persists across selections | unconditional prior-section removal before gate | ✓ FIXED | detail.js:220-223 |
| WR-02 routes accept any HTTP method | 405 GET-only guard on both routes | ✓ FIXED | server.ts:690, :765 |
| WR-03 `localeCompare` on null label can 500 /index | null-safe `(label\|\|slug\|\|'')` comparator | ✓ FIXED | server.ts:823 |
| WR-04 duplicate backlink rows per edge kind | `GROUP BY e.src` + MIN(e.kind) + regression test | ✓ FIXED | server.ts:254, :268; new test in doc-backlinks.test.ts |

All four warnings resolved in commit `1324206`; commit verified present on main. IN-04 (`ctx.openIndex` dead export, index.js:289) remains as info-only dead assignment — harmless, not a gap.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| Read-only DB invariant | `grep -v '//' server.ts \| grep -c "new Database"` | 1 | ✓ PASS |
| Route tests | `npx vitest run doc-backlinks + viz-index-route` | 29 passed | ✓ PASS |
| Full suite | `npx vitest run` | 2060 passed, 3 skipped, 0 fail | ✓ PASS |
| TypeScript build | `npx tsc --noEmit` | exit 0, clean | ✓ PASS |
| No new edge/node types | edge-kind grep + schema diff | only pre-existing kinds; no schema files touched | ✓ PASS |
| No write/LLM in new routes | grep INSERT/UPDATE/DELETE/.run/embed/spawn/fetch in 681-832 | none | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| --- | --- | --- | --- | --- |
| WIKI-01 | 39-02 | browsable index over live doc nodes | ✓ SATISFIED | /index route + index.js sidebar |
| WIKI-02 | 39-01 | backlinks / what-links-here surfaced in reader | ✓ SATISFIED | /doc/backlinks route + fetchBacklinks + atom Cited-by |
| WIKI-03 | 39-01, 39-02 | no engine change, read-only | ✓ SATISFIED | 1 new Database, SELECT-only, no new edge/node types |

No orphaned requirements — all three roadmap requirements are claimed by plans and verified.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| — | — | none | — | No TBD/FIXME/XXX debt markers in any phase-modified file. No stubs. Empty-backlinks early-return is intentional (must-have truth #2) and test-covered. |

### Human Verification Required

None outstanding. The phase carried two `checkpoint:human-verify gate="blocking"` tasks (39-01 Task 3, 39-02 Task 3). Per `workflow.human_verify_mode = end-of-phase`, both were batched to the end-of-phase founder checkpoint. The 39-02 SUMMARY Post-Checkpoint Evolution records the founder iteratively reshaped the index (button-position fix → corpus-docked sidebar → auto-open → containment-subtree highlight → nested tree → hybrid Projects/Schemas → search filter) and **approved the live verification on a copy of the live DB**. The deferred human checks are therefore closed, not outstanding.

### Gaps Summary

No gaps. All three roadmap success criteria (WIKI-01, WIKI-02, WIKI-03) are observably achieved in the codebase:

- WIKI-01: a live read-only `/index` projection renders a corpus-docked, auto-opening Projects/Schemas nested-tree sidebar with a search filter; entries open the reader. Evolved well past the original full-window plan per founder direction during the end-of-phase checkpoint, but the goal (browsable index over live doc nodes) is met and remains read-only.
- WIKI-02: incoming "Referenced by" (doc view) and "Cited by" (atom view) render from the read-only `/doc/backlinks` route reusing reverse-edge lookups; empty cases render no chrome; entries are clickable and re-target the reader.
- WIKI-03 (load-bearing invariant): exactly 1 read-only `new Database`, SELECT-only handlers with no LLM/write/embed/spawn, no new node/edge types, no schema/migration changes. Self-confirmation guard untouched.

All four code-review warnings are fixed and verified. tsc clean; full suite 2060/2060 pass; founder live-verification approved.

---

_Verified: 2026-06-21T18:45:00Z_
_Verifier: Claude (gsd-verifier)_
