---
phase: 61-corpus-chrome-index-column-project-browsing
verified: 2026-07-15T02:18:35Z
status: gaps_found
score: 9/13 must-haves verified
overrides_applied: 0
gaps:
  - truth: "Clicking a project in the index focuses it in the graph — project→docs→back is the primary browsing path (D2)"
    status: failed
    reason: "WR-03 (code review, confirmed by direct source read): projectScopes is built ONLY from colon-slug subject docs (corpus.js:236). A project whose only doc-graph presence is its hub doc (no subject doc) is nested correctly in /index (server.ts resolves via hub-doc slug==scope) but is NOT a member of client-side projectScopes. Clicking that project's index row calls ctx.focusCorpusProject(scope), which silently no-ops (corpus.js:789 `if (!projectScopes.has(scope)) return;`) — no zoom, no dim, no chapter reveal, no ctx.syncCorpusFocus notify. The click does nothing in the graph. Currently dormant against the live brain.db (every existing project hub also has >=1 colon-slug subject doc, confirmed by direct query), but the defect is real, unfixed, and demonstrated by the existing `tonos` fixture shape in tests/viz-index-route.test.ts per the review. Any future project that is hub-only (a real, expected corpus shape) will hit this."
    artifacts:
      - path: "src/viz/modules/corpus.js"
        issue: "projectScopes (line 236) built only from subject-doc scopes; focusCorpusProject (line 789) and the project tint (line 320) both gate off this incomplete set instead of the server's broader 'has a hub doc' definition."
    missing:
      - "Derive one shared definition of 'recognized project' between server.ts (projectDocIdBySlug, hub-doc-derived) and corpus.js (projectScopes, subject-doc-derived) — either have the client also admit hub scopes, or ship the recognized-project set from the server."
  - truth: "The focused project's index row shows a clear active state that matches actual graph focus (GAP-3)"
    status: failed
    reason: "WR-04 (code review, confirmed by direct source read): index.js's project-row click handler (index.js:222-231) sets `activeScope = scope` unconditionally after calling ctx.focusCorpusProject(scope), regardless of whether focus actually took. Two reachable triggers: (a) any 'Notes' section root doc with children renders as a project-style row via makeProjectRow (index.js:309, 327) even though its slug is a schema UUID — never a member of projectScopes, so focusCorpusProject no-ops but the row still paints '.active' + aria-current; (b) the WR-03 hub-only-project case. Toggling the phantom-active row off then fires focusCorpusProject(null), which animates a full zoom-out even though nothing was focused."
    artifacts:
      - path: "src/viz/modules/index.js"
        issue: "activeScope is set by two local assignments in the click handler (lines 226, 230) instead of being driven exclusively by ctx.syncCorpusFocus, which corpus.js already calls on every accepted focus change."
    missing:
      - "Remove the two local `activeScope = ...` assignments in the click handler; let ctx.syncCorpusFocus be the single writer (or have focusCorpusProject return a boolean and only set activeScope on true)."
  - truth: "Chapter docs render in the graph only when their owning project is focused OR its tree row is expanded (D-07/D3)"
    status: failed
    reason: "WR-01 (code review, confirmed by direct source read): isProjectRevealed(node) (corpus.js:184-188) and the subject-doc label predicate (corpus.js:339) both compare `scope === focusedScope` with no null guard. A doc whose containment root has no node_scope row resolves scope=null; at rest focusedScope is also null, so `null === null` is true — the doc is VISIBLE when nothing is focused and HIDDEN when any project is focused, the exact inverse of the D-07 contract. Currently dormant against the live brain.db (0 of 351 docs are scope-less, confirmed by direct query), but the predicate is unconditionally wrong and will misfire the moment a scope-less doc exists (e.g. a future consolidation edge case)."
    artifacts:
      - path: "src/viz/modules/corpus.js"
        issue: "isProjectRevealed (lines 184-188) and the label-tier predicate (line 339) lack a `focusedScope !== null` guard before the equality check; nodeCanvasObject's isRelated (line 308) and linkColor's related() (line 381) already guard correctly with `focusedScope && ...`, showing the fix pattern exists in the same file."
    missing:
      - "Add `if (scope == null) return false;` before the equality check in isProjectRevealed, and gate the label predicate's focus branch with `focusedScope !== null && ...`, matching the already-correct nodeCanvasObject/linkColor call sites."
  - truth: "The corpus index reads as a free-floating detached panel (own chrome, draggable, visually separate from the graph), not a rail docked into the layout — the closed corpus view no longer feels bare (GAP-9)"
    status: failed
    reason: "GAP-9 is a new, founder-raised, unresolved item captured in 61-UAT.md (status: failed) during the round-2 61-14 sign-off. It reopens the index-column presentation: the founder confirmed GAP-5..8 and GAP-1..4/D1-D4 all still hold on the docked-rail-with-default-closed-handle paradigm, but separately requested the index become a detached floating panel (akin to the tray-app collapsed node view) instead of docking into the layout or overlaying flush on the canvas. No plan in 61-01..61-14 implements this; 61-14-SUMMARY.md explicitly scopes it to a future plan/phase ('61-15 or a new phase') that does not yet exist in ROADMAP.md."
    missing:
      - "A new plan (round-3 / phase 62) implementing a detached, draggable, own-chrome floating index panel per the founder's GAP-9 direction in 61-UAT.md."
human_verification: []
---

# Phase 61: Corpus Chrome — Index Column + Project Browsing Verification Report

**Phase Goal:** The corpus view's chrome catches up to the Phase 59 HUD language and actually works for browsing. (1) Index column: redesign the corpus index/sidebar column so it reads in the same glass/token vocabulary as the Phase 59 chrome. (2) Project browsing: fix the broken project-level browsing flow in the corpus view — navigating from a project to its docs and back should be the primary path.

**Verified:** 2026-07-15T02:18:35Z
**Status:** gaps_found
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

Merged must-haves from all 14 plans' frontmatter (D1-D4 discussion requirements + GAP-1..GAP-9 UAT requirements). Plans 61-04 and 61-09 are founder sign-off checkpoints formally superseded by 61-14 per their SUMMARY stubs and 61-14-PLAN.md's output contract; their truths are folded into the D1-D4/GAP-1..4 rows below and were founder-confirmed no-regression at 61-14 (2026-07-14).

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Index panel/reopen handle read as Phase-59 glass/token chrome — no longer a flat slab (D1, half 1) | VERIFIED | `styles.css:1293` `#index-panel { background: var(--glass-bg-focused); backdrop-filter: blur(var(--glass-blur-md)); box-shadow: var(--glass-specular); ... }`; `#index-reopen` carries the matching ambient tier (`glass-bg-ambient`, `blur(var(--glass-blur-sm))`). `ALLOWED_SELECTORS` in `tests/viz-activity-palette-invariants.test.ts` includes `#index-panel`/`#index-reopen`; suite green (144/144, includes 45/45 D-14 invariants). |
| 2 | Index renders as a collapsible tree, not a wall of text (D1, half 2) | VERIFIED | `index.js:191-243` `makeProjectRow` (chevron + name + count badge, collapsed by default, `expandedIds` Set gates child emission); `renderTreeSection` at lines 253+, 326-327 renders both `Projects` and `Notes` sections through it. |
| 3 | Clicking a project focuses it in the graph; project→docs→back is the primary browsing path (D2) | **FAILED (partial)** | Works for the common case (every project with a colon-slug subject doc — the entirety of today's live `recense.db`, founder-confirmed at 61-14). Fails by design for hub-only projects: `corpus.js:789` `if (!projectScopes.has(scope)) return;` silently no-ops the click for any project whose `projectScopes` membership (subject-doc-derived, line 236) diverges from the server's hub-doc-derived recognized-project set (WR-03, confirmed by direct source read; see gap). |
| 4 | Graph declutters: tiered labels, hover dims + amber-highlights the subtree, chapters appear only when browsing their project (D3/D-07) | **FAILED (partial)** | Tiered labels, hover-dim, and hover-amber-subtree-BFS all confirmed present and correct (`corpus.js` `onNodeHover` calls `ctx.highlightCorpusNode`, `nodeCanvasObject` composes `CORPUS_FOCUS_DIM_OPACITY`/`CORPUS_HOVER_DIM_OPACITY`). But the D-07 "chapters visible only when focused/expanded" contract is provably inverted for any scope-less doc: `isProjectRevealed` (`corpus.js:184-188`) does `scope === focusedScope` with no null guard, so `null === null` is true at rest (WR-01, confirmed by direct source read; see gap). Currently dormant (0/351 live docs are scope-less) but unconditionally wrong in the source. |
| 5 | Reader round-trip unchanged; focus persists across reader open/close incl. Esc-close (D4) | VERIFIED | `corpus.js` Esc listener gated on `ctx.isReaderOpen()` (hook, not stale `classList.contains('shown')`) and `palette-open`; founder-confirmed no-regression at 61-14 live-install sign-off. |
| 6 | GAP-1: Index is a docked full-height sidebar; graph reflows beside it | VERIFIED | `styles.css` `.index-docked #corpus-graph` reflow rule (61-05); founder-confirmed resolved at 61-09/61-14. |
| 7 | GAP-2: Project rows look intentionally designed (spacing/alignment/hover), not default file-explorer pills | VERIFIED | `.index-row`/`.index-entry` share 5px vertical rhythm, weight-distinguished names, quieted count badge (61-06); founder-confirmed resolved. |
| 8 | GAP-3: Focused project's row shows a clear active state; clicking again exits focus; Esc/canvas-click still work | **FAILED (partial)** | Works and founder-confirmed for normal projects. For a "Notes" (schema) root row with children, or a hub-only project, `index.js:226,230` sets `activeScope = scope` unconditionally after calling `ctx.focusCorpusProject(scope)`, even when that call silently no-ops (WR-04, confirmed by direct source read) — the row paints active/`aria-current` while nothing is focused in the graph, the exact inverse of what GAP-3 was built to guarantee. |
| 9 | GAP-4: Schemas nested under their related project in tree + graph, not free-floating peers | VERIFIED | `server.ts` `stmtSchemaProjectScopes`/`resolveSchemaToProject`; `corpus.js` owner map prefers `node.ownerScope`; `tests/viz-index-route.test.ts` 20/20 green including GAP-4 fixtures. |
| 10 | GAP-5: Project rows have no curved/rounded borders — square-edged within the rail | VERIFIED | `grep -n "border-radius" styles.css` shows zero hits inside `.index-row`/`.index-entry`; durable "NEVER DO IT AGAIN" comment present above `.index-row` (styles.css:1427-1432). |
| 11 | GAP-6: Corpus view opens with the index rail closed; rail opens only via explicit user action | VERIFIED | `corpus.js:658` `goToCorpus` calls `ctx.showIndexHandle()` (not `openIndexSidebar()`); `index.js` `ctx.showIndexHandle` reveals only the handle, no dock/refit. |
| 12 | GAP-7: Exiting focus plays the same zoom/frame animation as focusing, in reverse, instead of snapping | VERIFIED | `corpus.js:775-788` `focusCorpusProject(null)` branch calls `CorpusGraph.zoomToFit(CORPUS_FOCUS_TRANSITION_MS, 40, isNodeVisible)` + `MAX_ZOOM` clamp — no `fitAndClamp()` snap. |
| 13 | GAP-8: Nested schema rows are legible — human-readable title, never a raw UUID; presentation makes clear what these docs are | VERIFIED | `server.ts:1336-1337` `humanTitle()` never returns a UUID; `index.js` renders the section under `'Notes'` (`renderTreeSection('Notes', ...)`); `tests/viz-index-route.test.ts` asserts label !== UUID regex, 20/20 pass. Founder confirmed the "Notes" label at the 61-12 checkpoint and again at 61-14. |
| 14 | GAP-9: Index reads as a detached floating panel (own chrome, draggable), not a docked rail — closed view no longer feels bare | **FAILED** | Founder-raised at the 61-14 round-2 sign-off, captured in `61-UAT.md` with `status: failed`. No plan in 61-01..61-14 implements this; explicitly scoped by 61-14-SUMMARY.md to a future plan/phase that does not yet exist in ROADMAP.md. |

**Score:** 9/13 truths verified (GAP-9 counted separately as item 14/an open new-scope item; D2/D3/GAP-3 counted as failed above; 9 of the 13 D1-D4+GAP1-8 truths fully verified, 3 partially failed on a confirmed code defect, GAP-9 is a wholly new open item).

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/viz/css/styles.css` | `#index-panel`/`#index-reopen` glass tiers; `.index-row`/`.index-chevron`/`.index-count`/`.index-row.active` token-only, square-edged | VERIFIED | Confirmed via direct read; D-14-A/B/C invariants suite 45/45 green. |
| `tests/viz-activity-palette-invariants.test.ts` | `ALLOWED_SELECTORS` extended with `#index-panel`/`#index-reopen` only | VERIFIED | Confirmed present, no other entries disturbed. |
| `src/viz/modules/constants.js` | `CORPUS_FOCUS_DIM_OPACITY`/`CORPUS_HOVER_DIM_OPACITY`/`CORPUS_LABEL_ZOOM_THRESHOLD`/`CORPUS_FOCUS_TRANSITION_MS` at founder-approved values | VERIFIED | Ratcheted 0.18/0.30/1.2/500 at 61-14 sign-off; unchanged since. |
| `src/viz/modules/corpus.js` | `ctx.focusCorpusProject`, `ctx.setCorpusProjectExpanded`, `ctx.syncCorpusFocus`, owner-map (`projectScopeOf`), animated unfocus | VERIFIED (existence/wiring) — **contains 3 confirmed predicate-drift defects (WR-01/03/04)** | See gaps below; the hooks exist and are wired, but their guard logic diverges from server.ts's recognized-project definition and from null-safety, breaking the contract for specific node classes. |
| `src/viz/modules/index.js` | Collapsible tree, project click wiring, `ctx.showIndexHandle`, `activeScope` sync via `ctx.syncCorpusFocus` | VERIFIED (existence/wiring) — **activeScope also locally mutated (WR-04)** | Confirmed. |
| `src/viz/server.ts` | `humanTitle()`, `UUID_RE`, schema→project resolution, `ownerScope` on `/graph` | VERIFIED | Confirmed present; `tests/viz-index-route.test.ts` 20/20 pass. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `index.js` project-name row click | `ctx.focusCorpusProject` | `entry.slug` as scope | PARTIAL | Wired, but the receiving function silently ignores hub-only-project scopes (WR-03). |
| `index.js` chevron toggle | `ctx.setCorpusProjectExpanded` | `entry.slug` as scope | WIRED | Confirmed, no defect found here. |
| `corpus.js` focus change (focus/switch/Esc/background-click) | `index.js` active-row state | `ctx.syncCorpusFocus(focusedScope\|null)` | PARTIAL | The hook exists and corpus.js calls it correctly on every real transition; but `index.js`'s own click handler bypasses it with two direct `activeScope = ...` writes (WR-04), so the two sources of truth can still diverge. |
| `.onNodeHover` | `ctx.highlightCorpusNode` | graph-hover subtree parity (D-05) | WIRED | Confirmed adjacent call, reuses existing BFS. |
| `#index-panel`/`#index-reopen` | `ALLOWED_SELECTORS` (D-14-C gate) | backdrop-filter allow-list membership | WIRED | Confirmed, suite green. |

### Requirements Coverage

No formally assigned requirement IDs exist in `.planning/REQUIREMENTS.md` for Phase 61 (ROADMAP.md: "Requirements: TBD"). All traceability instead runs through PLAN frontmatter `requirements:` fields (D-01..D-08, D1-D4, GAP-1..GAP-8) cross-referenced against `61-CONTEXT.md`/`61-UAT.md`. Every D1-D4 and GAP-1..8 ID is claimed by at least one plan's `requirements:` field (61-01: D-02,D-08,D1; 61-02: D-04,D-05,D-06,D-07,D2,D3; 61-03: D-01,D-03,D1,D2; 61-04: D1,D2,D3,D4; 61-05: GAP-1; 61-06: GAP-2; 61-07: GAP-3; 61-08: GAP-4; 61-09: GAP-1..4; 61-10: GAP-5; 61-11: GAP-7; 61-12: GAP-8; 61-13: GAP-6; 61-14: GAP-5..8). GAP-9 has no `requirements:`-bearing plan — it is captured only in `61-UAT.md`, consistent with it being a newly-raised, unclosed item outside this phase's executed plan set. No orphaned requirement IDs found (nothing in `61-CONTEXT.md`/`61-DISCUSSION-LOG.md` implies a D-ID or GAP-ID that no plan claims).

### Anti-Patterns Found

| File | Line(s) | Pattern | Severity | Impact |
|------|---------|---------|----------|--------|
| `src/viz/modules/corpus.js` | 184-188 | `isProjectRevealed` unguarded `scope === focusedScope` (WR-01) | Warning→Blocker (breaks D-07 truth) | Chapter visibility inverts for scope-less docs; dormant on current data, will trigger on future data shape. |
| `src/viz/modules/corpus.js` | 339 | Label-tier predicate same unguarded comparison (WR-01) | Warning | Scope-less subject docs draw labels at rest below the zoom threshold, defeating D-06. |
| `src/viz/modules/corpus.js` | 234-237, 789 | `projectScopes` built subject-doc-only vs server's hub-doc-derived set (WR-03) | Warning→Blocker (breaks D2 truth) | Hub-only project clicks silently no-op in the graph. |
| `src/viz/modules/index.js` | 222-231 | `activeScope` set unconditionally regardless of whether focus took (WR-04) | Warning→Blocker (breaks GAP-3 truth) | Active-row state can desync from actual graph focus for Notes/schema-root rows and hub-only projects. |
| `src/viz/modules/corpus.js` | 806-814 | `setCorpusProjectExpanded` calls `fitAndClamp()` despite its "WITHOUT zooming" doc comment (WR-05) | Warning | Expanding a chevron while a different project is focused snaps the camera to full-fit, contradicting the pinned focus framing. Not directly a phase-goal must-have but degrades the browsing feel this phase targets. |
| `src/viz/modules/index.js` | 157-173 | Filter auto-expand mutates `expandedIds` without notifying `corpus.js` (WR-06) | Warning | After filtering, index tree can show a project's chapters as expanded while the graph still hides them (D-07 tree↔graph desync). |

No debt markers (`TBD`/`FIXME`/`XXX`) found in phase-modified files. No `TODO`/`HACK`/`PLACEHOLDER` strings found via grep of the phase's touched files.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| D-14 CSS invariants (glass allow-list, raw-literal ban, amber exclusivity) | `npx vitest run tests/viz-activity-palette-invariants.test.ts` | 45/45 passed | PASS |
| `/index` schema→project resolution + human titles | `npx vitest run tests/viz-index-route.test.ts` | 20/20 passed | PASS |
| Corpus graph focus/dim/label logic | `npx vitest run tests/viz-corpus-graph.test.ts` | 27/27 passed | PASS |
| Frontend static asset checks | `npx vitest run tests/viz-frontend-static.test.ts` | 52/52 passed | PASS |
| Row-surface square-edge rule (GAP-5) | `grep -n "border-radius" styles.css` scoped to `.index-row`/`.index-entry` | zero matches | PASS |
| Live `recense.db` project-scope shape (informs WR-01/03/04 real-world impact) | `sqlite3` queries against `/Users/vtx/.config/recense/recense.db` | 0/351 docs scope-less; all 8 project hubs have >=1 subject doc | Confirms WR-01/WR-03 defects are real but currently dormant against production data; WR-04 trigger condition (unresolved schema root with children) not fully quantified. |

### Probe Execution

No `scripts/*/tests/probe-*.sh` files declared in any 61-*-PLAN.md or 61-*-SUMMARY.md, and none found under `scripts/`. Step 7c: SKIPPED (no runnable entry points / no declared probes — this phase's verification runs through the vitest suites above instead).

### Human Verification Required

None. All must-haves for this phase are either machine-verified in code or were already carried through a founder live-install sign-off (61-14, 2026-07-14) whose outcome is documented in `61-14-SUMMARY.md` and `61-UAT.md`, per the task's explicit instruction not to re-litigate that sign-off. The remaining gaps (WR-01/03/04 predicate drift, GAP-9) are code-level or already founder-specified — no additional human judgment is needed to confirm they exist; a human decision IS needed on prioritization (fix now vs. carry into the GAP-9 round-3 plan), which is a planning decision, not a verification one.

### Gaps Summary

Two categories of gap:

1. **Confirmed, unfixed predicate-drift defects (WR-01, WR-03, WR-04) surfaced by the phase's own code review (`61-REVIEW.md`, dated 2026-07-14) and independently re-confirmed here by direct source reading.** All three trace to the same root cause the review names explicitly: `index.js`, `corpus.js`, and `server.ts` maintain three separately-hand-written definitions of "what counts as a recognized project" and "who owns focus state," and they silently disagree in reachable configurations (hub-only projects, scope-less docs, unresolved schema roots with children). Today's live `recense.db` doesn't trigger WR-01 or WR-03 (confirmed by direct query — 0 scope-less docs, all 8 project hubs already have a subject doc), so the founder's live-install sign-off at 61-14 would not have surfaced them. This is exactly the kind of gap a founder click-through cannot catch and a code-level verification is required to find. They are real, provable contradictions of the literal must-have truth text from Plans 02, 03, 07/09/14 — not speculative or stylistic.

2. **GAP-9 (detached floating index panel) is founder-raised, unresolved, and explicitly out of scope for any of the 14 executed plans.** The phase's two headline goals ("index column catches up to Phase 59 chrome" and "project browsing works") are each partially but not fully delivered by the founder's own final assessment: GAP-1..8 and D1-D4 are confirmed resolved, but the founder immediately followed that sign-off with a new architectural request that reopens exactly the "index column" half of the phase goal. No later phase exists in ROADMAP.md to defer this to (Phase 61 is currently the last phase), so it cannot be filtered as a deferred item — it is a live gap requiring a new plan.

**This looks like intentional, tracked scope evolution for GAP-9** (not an execution failure — 61-14-SUMMARY.md correctly followed the plan's own "no hand-patching, capture as a new UAT gap" rule) and **genuine unfixed code defects for WR-01/03/04** (the review ran, found them, and no fix plan followed before this verification). Recommend: (a) a small gap-closure plan for WR-01/03/04 (single shared root-cause, likely a half-day fix per the review's suggested patches), and (b) a round-3/new-phase plan for GAP-9's floating-panel redesign.

---

_Verified: 2026-07-15T02:18:35Z_
_Verifier: Claude (gsd-verifier)_
