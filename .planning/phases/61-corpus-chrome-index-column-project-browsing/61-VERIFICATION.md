---
phase: 61-corpus-chrome-index-column-project-browsing
verified: 2026-07-16T10:20:00Z
status: gaps_found
score: 10/13 must-haves verified
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 9/13
  gaps_closed:
    - "D2 / GAP-3: clicking a project (incl. hub-only projects) focuses it in the graph — WR-03 fixed by 61-15 (server-shipped projectScopes, client Array.isArray-gated consumption)"
    - "D3/D-07: chapter docs no longer show at rest for scope-less docs — WR-01 fixed by 61-15 (isProjectRevealed + label predicate null-guarded before equality check)"
    - "GAP-3: index active row never phantom-paints — WR-04 fixed by 61-15 (activeScope is now written in exactly two places: declaration + ctx.syncCorpusFocus; click handler's two local writes removed)"
  gaps_remaining:
    - "GAP-9 → GAP-10: index-column layout paradigm still unresolved. 61-16 built the GAP-9 floating/draggable panel, but the founder's live-install sign-off (Task 3, 2026-07-16) rejected the floating-over-canvas result itself and asked for a docked left panel outside the graph, attached to the main window, with the graph reflowing beside it. GAP-9 is marked superseded in 61-UAT.md; GAP-10 is open with no executing plan yet."
  regressions:
    - "GAP-7 (previously VERIFIED): round-4 code review (61-REVIEW.md WR-01, re-reported from round-3 WR-02, still unfixed) found focusCorpusProject reads CorpusGraph.zoom() synchronously right after issuing an animated zoomToFit(), so the MAX_ZOOM clamp check runs against the PRE-animation zoom, not the animation's target. Confirmed by direct source read (corpus.js:794-799, 806-814): no setTimeout/await between the zoomToFit() call and the zoom()-read clamp check. For a small project cluster the animated zoom can overshoot MAX_ZOOM with the clamp never firing, and — per the review — the stale clamp read can also fire an instant zoom(MAX_ZOOM,0) WHILE the 500ms zoom-out transition is running, interrupting it (degrading GAP-7's 'animated, not a snap' guarantee). This was not caught by the previous verification round because it requires reading the synchronous-vs-animated zoom() timing, not just presence of a zoomToFit() call."
    - "GAP-8 (previously VERIFIED): round-4 code review (61-REVIEW.md WR-04) found the GAP-8 UUID-scrub (humanTitle()) was applied only to the /index handler (server.ts:1349-1358), not to the /graph?type=doc handler that the corpus canvas actually reads labels from (server.ts:328, COALESCE(NULLIF(sch.value,''), nd.slug)). Confirmed live-firing against production data: direct sqlite3 query against /Users/vtx/.config/recense/recense.db found 3 schema-anchored docs (574b6149-59cd-4144-9b4e-0a558eb494c7, 968b13be-3eba-4396-9334-13cc04fd2ac9, 82610b58-28ff-46c2-853c-ebd6b081ffcb) whose backing schema node has an empty/null value — their /graph?type=doc label IS the raw UUID slug, which corpus.js draws on node hover (corpus.js:349-363). This is the exact UUID leak GAP-8 was built to eliminate, on a second, unguarded surface. Not a diff-caused regression from 61-15/61-16 — it is a pre-existing defect the round-2/round-3 verification passes did not check (they verified /index only) and this round's deeper review surfaced."
gaps:
  - truth: "The corpus index is a docked left panel/column that lives outside the graph canvas, attached to the main app window (side-by-side), with the graph reflowing beside it — GAP-10"
    status: failed
    reason: "Founder explicitly rejected the current state at a live-install sign-off (61-16 Task 3, 2026-07-16): 'index on top of graph is still out of place needs to be outside the window as a left panel but still attached to the main window.' Confirmed in source: styles.css:1284 #index-panel is position:fixed (floating overlay), styles.css:1200 #corpus-graph is position:fixed;inset:0 (full canvas, never reflows), and the code comment at styles.css:1278-1281 explicitly states 'opening/closing/dragging the panel never reflows #corpus-graph... restoring the old index-docked canvas-offset reflow rule — it was deliberately removed.' This is the literal opposite of what GAP-10 demands. No plan in 61-01..61-16 implements a docked-left-panel-with-reflow layout; 61-UAT.md and 61-16-SUMMARY.md both explicitly scope this to an unexecuted round-4 follow-up plan."
    artifacts:
      - path: "src/viz/css/styles.css"
        issue: "#index-panel (line ~1284) is a floating position:fixed overlay with offset/rounded-border/max-height chrome; no docked-column layout exists. #corpus-graph (line ~1200) is fixed/inset:0 with no reflow rule tied to panel open state."
      - path: "src/viz/modules/index.js"
        issue: "openSidebar()/hidePanel() (lines ~446-470) apply/remove only opacity + a dragged left/top position; no canvas reflow trigger (ctx.refitCorpus was removed in 61-16 and is now dead per 61-REVIEW.md IN-02)."
    missing:
      - "A round-4 plan reworking #index-panel from the floating-window paradigm into a docked left column outside the graph viewport, attached to the main app window, with a reinstated #corpus-graph reflow rule (side-by-side layout, not an overlay)."
  - truth: "Exiting project focus plays the same zoom/frame animation as focusing, in reverse, with no snap or interruption (GAP-7)"
    status: failed
    reason: "Confirmed by direct source read: focusCorpusProject (corpus.js:789-814) calls CorpusGraph.zoomToFit(CORPUS_FOCUS_TRANSITION_MS, 40, pred) then immediately (same synchronous tick, no setTimeout/await) reads CorpusGraph.zoom() to decide whether to clamp to MAX_ZOOM. zoom() returns the PRE-animation value, not the animation's eventual target, so the clamp check is evaluated against the wrong number. For small project clusters this can let the animated zoom overshoot MAX_ZOOM unclamped, and per 61-REVIEW.md WR-01 the same stale read can also fire an instant zoom(MAX_ZOOM,0) mid-transition, interrupting the 500ms zoom-out and reintroducing the snap GAP-7 was built to eliminate. This is a re-report of round-3's WR-02, confirmed still unfixed in the current source."
    artifacts:
      - path: "src/viz/modules/corpus.js"
        issue: "Lines 794-799 (focus branch) and 806-814 (null/unfocus branch) both read CorpusGraph.zoom() synchronously immediately after calling zoomToFit(), instead of after the transition completes."
    missing:
      - "Defer the MAX_ZOOM clamp check until after CORPUS_FOCUS_TRANSITION_MS has elapsed (setTimeout), or compute a pre-clamped target zoom from the cluster bbox and issue a single zoom() call instead of zoomToFit()."
  - truth: "Nested schema rows are legible everywhere in the UI — a human-readable title, never a raw UUID (GAP-8)"
    status: failed
    reason: "Confirmed live-firing against production data. The GAP-8 humanTitle() UUID scrub (server.ts:1349-1358) is applied only inside the /index handler. The /graph?type=doc handler's stmtDocNodes query (server.ts:320-328) resolves label via COALESCE(NULLIF(sch.value,''), nd.slug) with no UUID guard. Direct sqlite3 query against the live recense.db found 3 schema-anchored docs whose backing schema node has an empty value, so their /graph label IS the raw UUID slug. corpus.js draws this label on node hover (corpus.js:356-363: `nodeLabels[node.id] || nodeSlugs[node.id] || node.id`), so hovering one of these 3 nodes in the corpus graph shows a raw UUID today, on the live install."
    artifacts:
      - path: "src/viz/server.ts"
        issue: "stmtDocNodes (line 320-328, used by /graph?type=doc) computes label via a raw COALESCE with no humanTitle()-style UUID guard; the guard exists only in the separate /index handler (line ~1349)."
    missing:
      - "Apply the same UUID-guard derivation (or a shared humanTitle() helper) to the /graph?type=doc node-label mapping so both surfaces agree; add a /graph label test mirroring the existing /index GAP-8 assertion."
human_verification: []
---

# Phase 61: Corpus Chrome — Index Column + Project Browsing Verification Report

**Phase Goal:** The corpus view's chrome catches up to the Phase 59 HUD language and actually works for browsing. (1) Index column: redesign the corpus index/sidebar column so it reads in the same glass/token vocabulary as the Phase 59 chrome. (2) Project browsing: fix the broken project-level browsing flow in the corpus view — navigating from a project to its docs and back should be the primary path.

**Verified:** 2026-07-16T10:20:00Z
**Status:** gaps_found
**Re-verification:** Yes — round 3 (after 61-15 predicate-unification + 61-16 GAP-9 floating panel)

## Goal Achievement

### Observable Truths

Re-verification against the previous VERIFICATION.md (2026-07-15, score 9/13). Per the round-3 context, GAP-9 is superseded by GAP-10 (founder rejected the floating-over-canvas result at the 61-16 Task 3 live-install sign-off) — GAP-10 cannot be verified away and is carried as an open, founder-rejected structural gap.

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Index panel/reopen handle read as Phase-59 glass/token chrome (D1, half 1) | VERIFIED | `styles.css:1284` `#index-panel` still carries `--glass-bg-focused`/`backdrop-filter: blur(var(--glass-blur-md))`/`box-shadow: var(--glass-specular)` (reused from the `#detail` recipe per 61-16). D-14 invariants suite (`tests/viz-activity-palette-invariants.test.ts`) 45/45 green, `#index-panel`/`#index-reopen` still in `ALLOWED_SELECTORS`. |
| 2 | Index renders as a collapsible tree, not a wall of text (D1, half 2) | VERIFIED | `index.js` `makeProjectRow`/`renderTreeSection` unchanged by 61-15/61-16 except the click-handler write removed (WR-04 fix); tree structure and chevron/count-badge presentation intact. |
| 3 | Clicking a project focuses it in the graph — project→docs→back is the primary path (D2) | VERIFIED (was FAILED) | WR-03 fix confirmed by direct source read: `server.ts:913-956` computes and ships `projectScopes: string[]` on `/graph?type=doc`; `corpus.js:243-251` consumes it via `Array.isArray(data.projectScopes)` gate (falls back to old subject-doc derivation only when absent). A hub-only project (hub doc, no colon-slug subject doc) is now a `projectScopes` member, so its index-row click reaches `focusCorpusProject` instead of silently no-opping. `tests/viz-corpus-graph.test.ts` 38/38 green including the hub-only-project case. |
| 4 | Chapter docs render only when their project is focused or expanded — never inverted (D3/D-07) | VERIFIED (was FAILED) | WR-01 fix confirmed by direct source read: `corpus.js:188-192` `isProjectRevealed` now returns `false` immediately when `scope == null`, BEFORE the equality check, so a scope-less doc can no longer match `null === focusedScope` at rest. The label-tier predicate (`corpus.js:353`) got the matching `focusedScope !== null &&` gate. |
| 5 | Reader round-trip unchanged; focus persists across reader open/close incl. Esc-close (D4) | VERIFIED | No touched code this round; `viz-corpus-graph.test.ts` full suite green, no regression reported or found. |
| 6 | GAP-1→GAP-9→GAP-10: index column is docked/attached to the main window (not an overlay); graph reflows beside it | **FAILED** | Reversed twice since round 1: GAP-1 (docked rail + reflow, round 1) → GAP-9 (founder asked to un-dock into a floating panel, round 2) → 61-16 built the floating panel (no reflow) → founder rejected that at the round-3 sign-off, asking for a *different* dock (left panel outside canvas, graph reflows beside it) = GAP-10, open. Current code has neither: `#index-panel` is `position: fixed` overlay chrome, `#corpus-graph` is `position: fixed; inset: 0` with the reflow rule explicitly removed (`styles.css:1278-1281` comment). |
| 7 | GAP-2: Project rows look intentionally designed (spacing/alignment/hover) | VERIFIED | Untouched this round; no regression found. |
| 8 | GAP-3: Focused project's row shows a clear active state matching actual graph focus | VERIFIED (was FAILED) | WR-04 fix confirmed by direct source read: `index.js:62,281-286,499` — `activeScope` is written in exactly two places (`let activeScope = null` declaration; `activeScope = scope \|\| null` inside `ctx.syncCorpusFocus`, line 499). The click handler's two local `activeScope = ...` writes were removed; it only reads `activeScope === scope` for the toggle check now. A click on a non-focusable row (unrecognized scope) leaves `activeScope` untouched because `focusCorpusProject` returns before calling `syncCorpusFocus`. |
| 9 | GAP-4: Schemas nested under their related project in tree + graph | VERIFIED | Untouched this round; `tests/viz-index-route.test.ts` 20/20 green, no regression. |
| 10 | GAP-5: No rounded/curved borders on project rows | VERIFIED | Untouched this round; `grep -n "border-radius" styles.css` still shows zero hits inside `.index-row`/`.index-entry`; durable "NEVER DO IT AGAIN" comment intact. |
| 11 | GAP-6: Corpus view opens with the index rail/panel closed by default | VERIFIED | Untouched this round; `corpus.js` `goToCorpus` still calls `ctx.showIndexHandle()` (reveals only the reopen handle), no auto-open. |
| 12 | GAP-7: Exiting focus plays the same animation as focusing, in reverse, with no snap or interruption | **FAILED** (regression from prior round's VERIFIED) | Round-4 code review (61-REVIEW.md WR-01, a still-unfixed re-report of round-3 WR-02) confirmed by direct source read: `corpus.js:794-799` and `806-814` both read `CorpusGraph.zoom()` synchronously right after calling the animated `zoomToFit()`, so the MAX_ZOOM clamp check runs against the pre-animation zoom, not the transition's target — the clamp can fail to fire for small clusters, or fire mid-transition and interrupt it, degrading the animated unfocus back to a snap in the affected cases. Base animation direction (`zoomToFit` on both focus and null-clear) is correctly wired; the defect is the un-deferred clamp read. |
| 13 | GAP-8: Nested schema rows are legible everywhere — human-readable title, never a raw UUID | **FAILED** (regression from prior round's VERIFIED) | Round-4 code review (61-REVIEW.md WR-04) confirmed by direct source read AND a live-database query: the GAP-8 `humanTitle()` UUID scrub exists only in the `/index` handler (`server.ts:~1349-1358`); the `/graph?type=doc` handler's `stmtDocNodes` (`server.ts:320-328`) has no such guard — `COALESCE(NULLIF(sch.value,''), nd.slug)` ships the raw UUID slug as `label` whenever the backing schema node's value is empty. `sqlite3` query against the live `/Users/vtx/.config/recense/recense.db` found exactly 3 such schema-anchored docs today; hovering any of those 3 nodes in the corpus canvas (`corpus.js:349-363`) displays the raw UUID, live, right now. |

**Score:** 10/13 truths verified (3 predicate-drift truths closed by 61-15: D2, D3/D-07, GAP-3; 1 structural truth open — GAP-10, superseding GAP-9; 2 previously-verified truths (GAP-7, GAP-8) downgraded to FAILED by round-4 code review findings confirmed via direct source + live-DB evidence).

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/viz/server.ts` | `projectScopes` shipped on `/graph?type=doc`; `humanTitle()`/UUID guard applied consistently across BOTH `/index` and `/graph` label derivations | PARTIAL | `projectScopes` present and correct (line 913-956). UUID guard exists only for `/index` (line ~1349); `/graph?type=doc`'s `stmtDocNodes` label (line 320-328) is unguarded — confirmed leaking on 3 live docs (WR-04). |
| `src/viz/modules/corpus.js` | Null-guarded `isProjectRevealed`/label predicate; `projectScopes` consumed from server; single-notify `syncCorpusFocus`; MAX_ZOOM clamp correctly ordered relative to animated zoom | PARTIAL | Null guards, server-set consumption, and single-notify all VERIFIED via direct read. MAX_ZOOM clamp ordering NOT fixed — clamp read is synchronous/pre-animation (WR-01, confirmed). |
| `src/viz/modules/index.js` | `activeScope` written only via `ctx.syncCorpusFocus`; panel drag position clamped on restore | PARTIAL | `activeScope` single-writer VERIFIED. Panel-position re-clamp on `openSidebar()` NOT implemented (`openSidebar()` line ~446-451 applies `panelPos.left/top` verbatim, no viewport re-check) — a warning-level defect (61-REVIEW.md WR-03), secondary to GAP-10 since this whole panel-positioning surface is slated for GAP-10 rework. |
| `src/viz/css/styles.css` | `#index-panel` reads as a docked left column attached to the main window, `#corpus-graph` reflows beside it (GAP-10) | **MISSING** | `#index-panel` is `position: fixed` floating overlay chrome (61-16 build); no docked-column layout exists; `#corpus-graph` reflow rule was deliberately removed and not reinstated. |
| `tests/viz-corpus-graph.test.ts` | Source assertions locking WR-01/03/04 guard patterns | VERIFIED | 38/38 green, includes the guard-ordering and single-writer assertions cited in 61-REVIEW.md. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `server.ts /graph?type=doc` | `corpus.js projectScopes` | `data.projectScopes` (Array.isArray gate) | WIRED | Confirmed; hub-only project now recognized. |
| `index.js` project-row click | `ctx.focusCorpusProject` | `entry.slug` as scope | WIRED | Confirmed; no longer silently rejects hub-only scopes. |
| `corpus.js` focus change | `index.js activeScope` | `ctx.syncCorpusFocus(scope\|null)` | WIRED (single-writer) | Confirmed; the two local writes in the click handler were removed — `syncCorpusFocus` is now the only assignment path besides declaration. |
| `index.js openSidebar()` | `#index-panel` position | `panelPos.left/top` applied verbatim | PARTIAL | Wired, but not re-clamped against the current viewport at restore time (WR-03, round-4 review) — a resize-then-reopen edge case, secondary to the larger GAP-10 layout rework. |
| `server.ts /graph?type=doc` label | `corpus.js` hover-drawn label | `COALESCE(NULLIF(sch.value,''), nd.slug)` (no UUID guard) | **NOT WIRED to a human title** | Confirmed leaking raw UUID for 3 live docs — see GAP-8 gap above. |
| `index.js openSidebar/hidePanel` | `#corpus-graph` canvas width | (removed in 61-16; GAP-10 wants it reinstated) | **NOT WIRED** | Confirmed absent; no reflow trigger exists in either direction. |

### Requirements Coverage

No requirement IDs are declared for Phase 61 in `.planning/REQUIREMENTS.md` or `ROADMAP.md` (`**Requirements**: TBD`, confirmed via `gsd-sdk query roadmap.get-phase 61`, `success_criteria: []`). Traceability runs entirely through PLAN frontmatter `requirements:` fields against `61-CONTEXT.md`/`61-UAT.md` D-IDs and GAP-IDs, consistent with the prior verification round. 61-15's frontmatter claims WR-01/WR-03/WR-04 (plus WR-05/WR-06 as bonus fixes); 61-16's claims GAP-9. Both are accounted for above. No orphaned requirement IDs found — nothing in `61-CONTEXT.md`/`61-DISCUSSION-LOG.md`/`61-UAT.md` implies a D-ID, GAP-ID, or WR-ID that no plan or this verification round addresses.

### Anti-Patterns Found

| File | Line(s) | Pattern | Severity | Impact |
|------|---------|---------|----------|--------|
| `src/viz/modules/corpus.js` | 794-799, 806-814 | MAX_ZOOM clamp reads `CorpusGraph.zoom()` synchronously right after an animated `zoomToFit()` — reads pre-animation zoom, not the transition target (WR-01, round-4) | Warning→Blocker (breaks GAP-7 truth in affected cases) | Small-project focus can animate past MAX_ZOOM unclamped; clamp can also interrupt the 500ms unfocus transition mid-flight. |
| `src/viz/server.ts` | 320-328 (vs 1349-1358) | `/graph?type=doc` label derivation has no UUID guard; `/index` handler's `humanTitle()` guard is not shared/reused (WR-04, round-4) | Warning→Blocker (breaks GAP-8 truth, confirmed live on 3 docs) | Hovering an affected node in the corpus canvas shows a raw UUID today. |
| `src/viz/modules/corpus.js` | 286-295 | Client `ownerScope` preference pass applies to ALL nodes; server's `/index` schema→project resolution is tree-root-only (WR-02, round-4, not independently confirmed against live data this round due to time budget — carried from 61-REVIEW.md) | Warning | Can desync tree/graph grouping for a containment-nested chapter whose dominant `abstracts`-scope differs from its containment project — theoretical on current data per the review, not confirmed live-firing here. |
| `src/viz/modules/index.js` | 446-451 (clamp only in `pointermove`, 100-114) | `openSidebar()` restores `panelPos` without re-clamping to the current viewport (WR-03, round-4) | Warning | Panel can reopen off-screen after a window shrink between drag and reopen; secondary to GAP-10 since this whole positioning surface is slated for rework. |
| `src/viz/modules/index.js` | 485-487 (per 61-REVIEW.md IN-02) | Dead `ctx.openIndex`/`ctx.openIndexSidebar` hooks; dead `ctx.refitCorpus`; stale "docks/reflows" comments describing a removed paradigm | Info | Documentation drift; a future reader could mistakenly "restore" removed docking behavior based on stale comments. |

No debt markers (`TBD`/`FIXME`/`XXX`) found in phase-modified files (`src/viz/server.ts`, `src/viz/modules/corpus.js`, `src/viz/modules/index.js`, `src/viz/css/styles.css`) — confirmed via direct grep. No `TODO`/`HACK`/`PLACEHOLDER` strings found.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full project test suite (corpus graph, index route, D-14 invariants) | `npx vitest run tests/viz-corpus-graph.test.ts tests/viz-index-route.test.ts tests/viz-activity-palette-invariants.test.ts` | 3 files, 103 tests passed | PASS |
| Full repo test suite (regression check) | `npx vitest run` | 180 files passed / 1 skipped; 2699 tests passed / 3 skipped | PASS (matches the round-3 context's claimed "180 files / 2699 tests") |
| GAP-5 square-edge rule still holds | `grep -n "border-radius" styles.css` scoped to `.index-row`/`.index-entry` | zero matches | PASS |
| WR-04 (round-4) UUID-leak live check | `sqlite3 recense.db` join of `stmtDocNodes`-equivalent query for schema docs with empty backing schema value | 3 rows returned (574b6149…, 968b13be…, 82610b58…) | FAIL (confirms the gap is live, not dormant) |
| Debt-marker scan | `grep -n -E "TBD\|FIXME\|XXX\|TODO\|HACK\|PLACEHOLDER"` across phase-modified files | no matches | PASS |

### Probe Execution

No `scripts/*/tests/probe-*.sh` files declared in any 61-*-PLAN.md/SUMMARY.md, and none found under `scripts/`. Step 7c: SKIPPED (no runnable entry points / no declared probes).

### Human Verification Required

None. GAP-10 is already a founder-delivered verdict (documented verbatim in `61-UAT.md`, 2026-07-16 live-install sign-off) — it does not need re-litigating by a human; it needs a round-4 closure plan. GAP-7 and GAP-8's round-4 regressions are code-provable defects (confirmed here via direct source read and, for GAP-8, a live database query) — no human judgment is needed to confirm they exist, only engineering time to fix them.

### Gaps Summary

Three real, confirmed gaps block full phase sign-off:

1. **GAP-10 (BLOCKER, structural, founder-rejected)** — the index-column half of the phase goal ("redesign the corpus index/sidebar column so it reads in the same glass/token vocabulary as the Phase 59 chrome") is visually correct (glass tokens, D-14 invariants pass) but the layout paradigm itself has been rejected by the founder for the second time this phase (GAP-1's docked rail → GAP-9's un-docked floating panel → GAP-10's demand for a *different* dock: a left panel outside the graph viewport, attached to the main window, with the graph reflowing beside it). This is a fully open item with zero executing plan. It alone is sufficient to keep this phase at `gaps_found` — it cannot be verified away because it is a direct, dated, verbatim founder rejection recorded in `61-UAT.md`, not a code-level inference.

2. **GAP-7 and GAP-8 regressions, surfaced by round-4 code review and independently re-confirmed here.** Both were VERIFIED in the prior verification round (2026-07-15) but a deeper pass (61-REVIEW.md, dated 2026-07-16) found each has an unguarded second code path: GAP-7's animated-unfocus guarantee is undermined by a synchronous-read MAX_ZOOM clamp race; GAP-8's UUID-never-leaks guarantee holds on `/index` but not on `/graph?type=doc`, and the latter is confirmed leaking today against 3 real documents in the live corpus. Neither is a diff caused by 61-15/61-16 — both are pre-existing gaps in coverage that a more thorough review pass caught this round. They should be closed in the same round-4 gap-closure plan that addresses GAP-10, since all three touch the same `corpus.js`/`server.ts`/`index.js` surface area.

3. **Genuine, confirmed wins this round**: the three predicate-drift defects from the previous verification round (WR-01/WR-03/WR-04 — D2 hub-only-project click, D3/D-07 scope-less-doc visibility inversion, GAP-3 phantom-active-row) are all fixed, confirmed via direct source read against the actual current code (not just SUMMARY claims), and locked by new source-assertion tests in `tests/viz-corpus-graph.test.ts` (38/38 green). The full 180-file/2699-test suite is green.

Recommend: a single round-4 gap-closure plan covering (a) GAP-10's docked-left-panel-with-reflow rework (the larger, structural item — the plan should treat 61-16's floating-panel CSS/JS as the substrate to rework, per 61-16-SUMMARY.md's own next-steps note), and while that surface is open, (b) the GAP-7 MAX_ZOOM clamp-timing fix and (c) the GAP-8 `/graph` label-guard fix, since both are small, well-scoped patches on the same files GAP-10 will already be touching.

---

_Verified: 2026-07-16T10:20:00Z_
_Verifier: Claude (gsd-verifier)_
