---
phase: 61-corpus-chrome-index-column-project-browsing
verified: 2026-07-17T10:30:00Z
status: passed
score: 13/13 must-haves verified
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 10/13
  gaps_closed:
    - "GAP-10 (BLOCKER): index column reworked from floating overlay to docked full-height left column outside the graph, with body.index-docked reflow — confirmed via direct source read (styles.css, index.js) and founder live-install sign-off (2026-07-17, approved)."
    - "GAP-7 regression: MAX_ZOOM clamp deferred via setTimeout(..., CORPUS_FOCUS_TRANSITION_MS) in both focusCorpusProject branches, confirmed by direct source read (corpus.js:800-807, 820-827) and a passing locking source-assertion test."
    - "GAP-8 regression: humanTitle()/UUID_RE hoisted to server scope and applied to BOTH /graph?type=doc (server.ts:947) and /index (server.ts:1431) doc-node label derivations, confirmed by direct source read and a passing runtime fixture test (orphan schema-anchored doc)."
  gaps_remaining: []
  regressions: []
gaps: []
human_verification: []
---

# Phase 61: Corpus Chrome — Index Column + Project Browsing Verification Report

**Phase Goal:** The corpus view's chrome catches up to the Phase 59 HUD language and actually works for browsing. (1) Index column: redesign the corpus index/sidebar column so it reads in the same glass/token vocabulary as the Phase 59 chrome. (2) Project browsing: fix the broken project-level browsing flow in the corpus view — navigating from a project to its docs and back should be the primary path (reader opens from corpus doc clicks, not standalone chrome).

**Verified:** 2026-07-17T10:30:00Z
**Status:** passed
**Re-verification:** Yes — round 4 (after 61-17 GAP-7/GAP-8 regression fixes + 61-18 GAP-10 docked-left-panel rework)

## Goal Achievement

### Observable Truths

Re-verification against the round-3 VERIFICATION.md (2026-07-16, score 10/13). All three open items (GAP-10 structural blocker, GAP-7 and GAP-8 round-4 regressions) are independently re-confirmed closed against the current source tree, not just SUMMARY claims.

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Index panel reads as Phase-59 glass/token chrome (D1, half 1) | VERIFIED | `styles.css:1284-1303` `#index-panel` (reworked to docked geometry by 61-18) still carries `background: var(--glass-bg-focused)`, `backdrop-filter: blur(var(--glass-blur-md))` (+ `-webkit-` twin), `box-shadow: var(--glass-specular)`. D-14 invariants suite (`tests/viz-activity-palette-invariants.test.ts`) 45/45 green — confirmed by direct test run, not SUMMARY claim. |
| 2 | Index renders as a collapsible tree, not a wall of text (D1, half 2) | VERIFIED | `index.js` tree-render logic (`renderSections`/`makeProjectRow`/`computeVisible`) untouched by 61-17/61-18 per direct grep of the diff scope; `tests/viz-frontend-static.test.ts` 52/52 green. |
| 3 | Clicking a project (incl. hub-only) focuses it in the graph — project→docs→back is the primary path (D2) | VERIFIED | Unchanged this round (fixed by 61-15/WR-03). Confirmed by direct read: `server.ts:948-960` ships `projectScopes`; `corpus.js` consumes it. `tests/viz-corpus-graph.test.ts` 40/40 green. |
| 4 | Chapter docs render only when their project is focused or expanded — never inverted (D3/D-07) | VERIFIED | Unchanged this round (fixed by 61-15/WR-01). `isProjectRevealed` (`corpus.js:191`) null-guards `scope == null` before the equality check — confirmed by direct read. |
| 5 | Reader round-trip unchanged; focus persists across reader open/close incl. Esc-close (D4) | VERIFIED | `corpus.js:550-558` (`ctx.openReader(slug, {from:'corpus'})`) and `:694-702` (`ctx.returnToCorpus`) unchanged this round — confirmed neither is in 61-17/61-18's `files_modified`, and `refitCorpus` (the only new reflow trigger) is called ONLY from `index.js openSidebar/hidePanel`, never from reader open/close, so this path is architecturally unaffected by the GAP-10 rework. |
| 6 | GAP-1→GAP-9→GAP-10: index column is docked/attached to the main window (not an overlay); graph reflows beside it | **VERIFIED (was FAILED)** | 61-18 confirmed by direct source read: `styles.css:1284-1289` `#index-panel` is `position:fixed; top:0; left:0; bottom:0; width:var(--index-width)` (docked full-height column, NOT the prior `top:56px;left:16px` floating offset); `border-right: 1px solid var(--glass-border-focused)` replaces the rounded-window `border-radius:var(--radius-lg)`; `styles.css:1309` `.index-docked #corpus-graph { left: var(--index-width); }` reinstates the reflow. `index.js:406,413,421,422` toggle `body.classList.add/remove('index-docked')` and call guarded `ctx.refitCorpus()` in both `openSidebar`/`hidePanel`. Drag machinery (`panelPos`, pointer handlers, `.dragging` cursor) fully removed — confirmed zero grep hits. **Founder live-install sign-off approved 2026-07-17** (61-18-SUMMARY.md Task 3) — satisfies the human-verification requirement for this structural, founder-feel-gated truth per the orchestrator's framing. |
| 7 | GAP-2: Project rows look intentionally designed (spacing/alignment/hover) | VERIFIED | Untouched this round; no regression found. |
| 8 | GAP-3: Focused project's row shows a clear active state matching actual graph focus | VERIFIED | Unchanged this round (fixed by 61-15/WR-04). `index.js:62,237-248,451-452` confirms `activeScope` single-writer via `ctx.syncCorpusFocus` — re-confirmed by direct read this round, no regression from the GAP-10 openSidebar/hidePanel rewiring (which touches only display/class-toggle logic, not the click handler). |
| 9 | GAP-4: Schemas nested under their related project in tree + graph | VERIFIED | Untouched this round; `tests/viz-index-route.test.ts` 20/20 green. |
| 10 | GAP-5: No rounded/curved borders on project rows | VERIFIED | Direct grep: `grep -n "border-radius" styles.css` scoped to `.index-row`/`.index-entry` (~1427-1497) still shows zero hits; durable "NEVER DO IT AGAIN" comment (`styles.css:1430-1432`) intact and unmodified by the GAP-10 panel rework. |
| 11 | GAP-6: Corpus view opens with the index rail/panel closed by default | VERIFIED | Direct read: `corpus.js:665-672` `goToCorpus()` still calls only `ctx.showIndexHandle()` (reveals the reopen handle, no auto-open) — unaffected by 61-18's panel-layout rework. |
| 12 | GAP-7: Exiting focus plays the same animation as focusing, in reverse, with no snap or interruption | **VERIFIED (was FAILED)** | Direct source read: `corpus.js:800-807` (null-clear branch) and `:820-827` (focus branch) both wrap the `CorpusGraph.zoom() > MAX_ZOOM` clamp check inside `setTimeout(() => {...}, CORPUS_FOCUS_TRANSITION_MS)`, so the clamp reads the POST-animation zoom instead of the stale pre-animation value. Locking source-assertion test (`tests/viz-corpus-graph.test.ts`, "source: focusCorpusProject defers the MAX_ZOOM clamp...") passes — independently re-run here, green. **Residual edge case (WR-02, non-blocking):** round-4 code review found the deferred timers have no shared handle/cancellation, so re-toggling focus within the 500ms window can still let a stale timer fire mid-new-animation. This is a narrower, rapid-double-toggle-only scenario (not the base focus/unfocus path this truth targets) — tracked as a warning-level follow-on, not a re-open of this truth. |
| 13 | GAP-8: Nested schema rows are legible everywhere — human-readable title, never a raw UUID | **VERIFIED (was FAILED)** | Direct source read: `server.ts:344-350` hoists a single `UUID_RE`/`humanTitle()` above `stmtDocNodes`; `server.ts:947` (`/graph?type=doc` doc-node mapping) now returns `label: humanTitle(n)`; `server.ts:1431` (`/index` handler) references the same hoisted helper (`grep -c "const humanTitle"` = 1, confirmed). New runtime fixture test (orphan schema-anchored doc, no backing schema node, markdown H1 present) asserts `/graph?type=doc` node label is the H1 title, not the UUID — independently re-run here, green (`tests/viz-corpus-graph.test.ts`, 40/40). Live-DB spot-check: the 3 docs previously confirmed leaking (574b6149…, 968b13be…, 82610b58…) no longer match the leak-detection query against the current production DB (their backing schema nodes now carry values, independent of this fix, but the code-level guard is confirmed via the fixture test regardless of current data state). |

**Score:** 13/13 truths verified. All three round-3 open items (GAP-10 structural blocker, GAP-7 and GAP-8 round-4 regressions) are closed and independently re-confirmed against live source, not SUMMARY claims.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/viz/server.ts` | `projectScopes` shipped on `/graph?type=doc`; `humanTitle()`/UUID guard applied consistently across BOTH `/index` and `/graph` label derivations | VERIFIED | Confirmed via direct read: `projectScopes` (line 948-960); shared `humanTitle()` (line 345-350) applied at both `/graph` (line 947) and `/index` (line 1431). `grep -c "const humanTitle"` = 1. |
| `src/viz/modules/corpus.js` | Null-guarded `isProjectRevealed`/label predicate; `projectScopes` consumed from server; single-notify `syncCorpusFocus`; MAX_ZOOM clamp correctly deferred past the animated zoom | VERIFIED | All four confirmed via direct read this round; MAX_ZOOM clamp now inside `setTimeout(..., CORPUS_FOCUS_TRANSITION_MS)` in both branches (lines 800-807, 820-827). |
| `src/viz/modules/index.js` | `activeScope` written only via `ctx.syncCorpusFocus`; docked-panel reflow wiring (`index-docked` class + `refitCorpus`); drag machinery removed | VERIFIED | `activeScope` single-writer confirmed (lines 62, 237-248, 451-452). `index-docked` class toggled in `openSidebar`/`hidePanel` (lines 406, 413, 421, 422) with guarded `ctx.refitCorpus()` calls. `grep -nE "pointer(down\|move\|up\|cancel)\|setPointerCapture\|panelPos\|dragging"` returns zero hits — drag machinery fully removed. |
| `src/viz/css/styles.css` | `#index-panel` reads as a docked left column attached to the main window, `#corpus-graph` reflows beside it (GAP-10) | VERIFIED | `#index-panel` docked geometry (`top:0;left:0;bottom:0`), edge-only `border-right` (no `border-radius`), `.index-docked #corpus-graph { left: var(--index-width); }` reflow rule present (line 1309). |
| `tests/viz-corpus-graph.test.ts` | Source assertions locking the GAP-7 deferred-clamp pattern + GAP-8 `/graph` label runtime assertion | VERIFIED | Both new tests present and independently re-run here: 40/40 green in this file alone; 157/157 across the four phase-relevant test files; 2701/2701 in the full repo suite. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `server.ts /graph?type=doc` node mapping | shared `humanTitle()` guard | `label: humanTitle(n)` | WIRED | Confirmed; identical derivation as `/index`, single shared helper. |
| `corpus.js focusCorpusProject` | MAX_ZOOM clamp | `setTimeout(..., CORPUS_FOCUS_TRANSITION_MS)` | WIRED | Confirmed in both focus and null-clear branches; clamp reads post-animation zoom. |
| `index.js openSidebar/hidePanel` | `#corpus-graph` canvas reflow | `body.classList.add/remove('index-docked')` + guarded `ctx.refitCorpus()` | WIRED | Confirmed; class toggle and refit call present on both open and close paths. |
| `index.js` project-row click | `ctx.focusCorpusProject` | `entry.slug` as scope | WIRED | Confirmed unchanged; no regression from the panel-layout rework. |
| `corpus.js` doc-node click | `ctx.openReader(slug, {from:'corpus'})` | reader in-place open | WIRED | Confirmed; core browsing round-trip (project→docs→reader→back) unaffected by any 61-17/61-18 change — `refitCorpus` is never invoked from this path. |
| `index.js openSidebar/hidePanel` | project focus state (`focusedScope`) | `ctx.refitCorpus()` → `fitAndClamp()` | **PARTIAL (warning, non-blocking)** | `refitCorpus()` (`corpus.js:723-726`) always calls `fitAndClamp()`, which frames ALL visible nodes regardless of `focusedScope` — confirmed by direct read (`fitAndClamp`, lines 579-590, has no focus-awareness). Toggling the docked panel while a project is focused will instantly reframe to the full graph while the dim/active-row state still shows focus. This is a genuine new interaction bug (WR-01, round-4 review) surfaced by GAP-10's re-wiring of a previously-dead hook, but it is NOT on the phase's core "project→docs→back" primary path (reader open/close never calls `refitCorpus`) — tracked as a warning-level follow-on. |

### Requirements Coverage

No requirement IDs are declared for Phase 61 in `.planning/REQUIREMENTS.md` (confirmed via direct grep — no matches for "Phase 61" or "GAP-"). Traceability runs entirely through PLAN frontmatter `requirements:` fields against `61-CONTEXT.md`/`61-UAT.md` D-IDs and GAP-IDs. All ten GAP-IDs (GAP-1 through GAP-10) are claimed across plans 61-05 through 61-18, with GAP-9 explicitly superseded by GAP-10 per the round-3/round-4 verification history. 61-17 closes GAP-7/GAP-8 (regression fixes); 61-18 closes GAP-10. No orphaned requirement IDs found.

### Anti-Patterns Found

| File | Line(s) | Pattern | Severity | Impact |
|------|---------|---------|----------|--------|
| `src/viz/modules/corpus.js` | 723-726 (`ctx.refitCorpus`) | `refitCorpus` ignores `focusedScope`, always reframing to ALL visible nodes (WR-01, round-4) | Warning | Toggling the docked panel while a project is focused instantly resets the camera to the full graph while focus/dim state persists — a state inconsistency, not a break of the primary browsing path (reader open/close never triggers this). |
| `src/viz/modules/corpus.js` | 800-807, 820-827 | GAP-7 deferred clamp `setTimeout`s have no shared handle/cancellation — rapid re-toggle within 500ms can let a stale timer fire mid-new-animation (WR-02, round-4) | Warning | Narrow rapid-double-toggle edge case; the base single focus/unfocus path (this truth's core scope) is fixed and locked by a passing test. |
| `src/viz/modules/corpus.js` | 291-295 (vs `server.ts:1411-1419`) | Client `ownerScope` preference pass applies to all nodes; server's `/index` resolution is tree-root-only (WR-03, carried from round 3, unchanged) | Warning | Theoretical on current data per the round-4 review; not independently re-confirmed live this round (out of 61-17/61-18's touched-file scope). |
| `src/viz/modules/corpus.js` | 711 | Stale comment: "index list docks as a left sidebar OVER this corpus graph" — describes the pre-GAP-10 overlay model, now inaccurate (docks BESIDE) | Info | Documentation drift (round-4 review IN-02); does not affect behavior. |

No debt markers (`TBD`/`FIXME`/`XXX`) or `TODO`/`HACK`/`PLACEHOLDER` strings found in phase-modified files (`src/viz/server.ts`, `src/viz/modules/corpus.js`, `src/viz/modules/index.js`, `src/viz/css/styles.css`, `src/viz/index.html`) — confirmed via direct grep, independently re-run this round.

None of the three warnings (WR-01, WR-02, WR-03) block the phase goal: WR-01 and WR-02 are narrow, secondary interaction edge cases outside the phase's core success criteria (index chrome + project→docs→back browsing); WR-03 is a pre-existing, unconfirmed-live theoretical issue carried since round 3. All three are appropriate follow-on items for a future plan, not gaps in this phase's stated goal.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Phase-scoped test suite (corpus graph, index route, D-14 invariants, frontend static) | `npx vitest run tests/viz-corpus-graph.test.ts tests/viz-index-route.test.ts tests/viz-activity-palette-invariants.test.ts tests/viz-frontend-static.test.ts` | 4 files, 157 tests passed | PASS |
| Full repo test suite (regression check) | `npx vitest run` | 180 files passed / 1 skipped; 2701 tests passed / 3 skipped | PASS |
| TypeScript compiles clean | `npx tsc --noEmit` | exit 0, no output | PASS |
| GAP-5 square-edge rule still holds | `grep -n "border-radius" styles.css` scoped to `.index-row`/`.index-entry` | zero matches | PASS |
| GAP-10 docked reflow rule present | `grep -n "index-docked #corpus-graph" styles.css` | line 1309 present | PASS |
| GAP-10 drag machinery removed | `grep -nE "pointer(down\|move\|up\|cancel)\|setPointerCapture\|panelPos\|dragging" index.js` | zero matches | PASS |
| GAP-7 deferred clamp present | `grep -nE "setTimeout\(" corpus.js` inside `focusCorpusProject` | 2 occurrences, both delayed by `CORPUS_FOCUS_TRANSITION_MS` | PASS |
| GAP-8 shared humanTitle guard | `grep -c "const humanTitle" server.ts` | 1 (single shared definition) | PASS |
| Debt-marker scan | `grep -n -E "TBD\|FIXME\|XXX\|TODO\|HACK\|PLACEHOLDER"` across phase-modified files | no matches | PASS |
| Live-DB UUID-leak re-check (previously confirmed leaking on 3 docs) | `sqlite3 recense.db` re-run of the leak-detection query | 0 rows (backing schema nodes for those 3 docs now carry values, independent of code) | PASS (data-level; code-level guard independently confirmed via fixture test) |

### Probe Execution

No `scripts/*/tests/probe-*.sh` files declared in any 61-*-PLAN.md/SUMMARY.md, and none found under `scripts/`. Step 7c: SKIPPED (no runnable entry points / no declared probes).

### Human Verification Required

None. GAP-10's founder live-install sign-off checkpoint (61-18 Task 3) was presented post-merge on the built app and the founder responded "Approved" (docked left panel outside the graph, graph reflows beside it, no regressions) — recorded verbatim in `61-18-SUMMARY.md` under Task Commits and Next Phase Readiness, dated 2026-07-17. This satisfies the founder-feel/no-regression gate for the structural, twice-rejected layout truth; no further human verification is needed for this re-verification round. The three round-4 review warnings (WR-01, WR-02, WR-03) are code-provable, non-blocking follow-ons requiring engineering time, not human judgment.

### Gaps Summary

No gaps. All 13 observable truths verify against the current codebase, independently confirmed via direct source read, passing tests (phase-scoped 157/157, full-repo 2701/2701), clean `tsc --noEmit`, and the founder's recorded live-install approval for the GAP-10 structural item.

Three warning-level follow-ons remain open (not phase-blocking, recommend a lightweight future plan or explicit deferral):
1. **WR-01** — `ctx.refitCorpus` ignores `focusedScope`; toggling the docked panel while a project is focused snaps the camera to the full graph while dim/active-row state persists. Newly reachable because GAP-10 re-wired a previously-dead hook.
2. **WR-02** — GAP-7's deferred MAX_ZOOM clamp timers have no shared handle/cancellation; rapid focus/unfocus toggling within 500ms can still produce a mid-animation snap.
3. **WR-03** — Client `ownerScope` preference pass is not root-scoped to match the server's `/index` rule; theoretical desync on current data, carried unchanged since round 3.

---

_Verified: 2026-07-17T10:30:00Z_
_Verifier: Claude (gsd-verifier)_
