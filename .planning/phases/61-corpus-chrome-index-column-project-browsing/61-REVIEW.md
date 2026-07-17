---
phase: 61-corpus-chrome-index-column-project-browsing
reviewed: 2026-07-17T00:00:00Z
depth: standard
files_reviewed: 6
files_reviewed_list:
  - src/viz/modules/corpus.js
  - src/viz/server.ts
  - tests/viz-corpus-graph.test.ts
  - src/viz/css/styles.css
  - src/viz/modules/index.js
  - src/viz/index.html
findings:
  critical: 0
  warning: 3
  info: 10
  total: 13
status: issues
---

# Phase 61: Code Review Report (round 4 — supersedes the round-3 report)

**Reviewed:** 2026-07-17
**Depth:** standard
**Files Reviewed:** 6
**Status:** issues

## Summary

Round-4 re-review of the gap-closure diff since `5848d73`: plan 61-17 (GAP-7 deferred MAX_ZOOM clamp; GAP-8 shared `humanTitle` UUID guard) and plan 61-18 (GAP-10 docked-left `#index-panel`, drag machinery removed). This report REPLACES the previous 61-REVIEW.md (round 3+, reviewed 2026-07-16).

**Previously-reported findings verified as resolved:**

- **Round-3 WR-01 (MAX_ZOOM clamp race)** — FIXED. Both branches of `focusCorpusProject` now defer the clamp inside `setTimeout(…, CORPUS_FOCUS_TRANSITION_MS)` (`corpus.js:801-807, 821-827`), matching the suggested fix verbatim. Locked by the new source-assertion test (`viz-corpus-graph.test.ts:346-378`), whose segment logic I traced and confirmed sound (no same-tick clamp can slip past it). A residual stale-timer race remains — see WR-02 below.
- **Round-3 WR-04 (GAP-8 UUID label on `/graph?type=doc`)** — FIXED. `UUID_RE` + `humanTitle()` are hoisted to server scope beside `stmtDocNodes` (`server.ts:344-350`) and applied in BOTH the `/graph?type=doc` node mapping (`server.ts:947`) and the `/index` handler (`server.ts:1431`) — guard-set now equals ship-set for doc labels. I verified `stmtDocNodes` selects `n.value` (`server.ts:327`), so `humanTitle(n)` cannot dereference undefined in the `/graph` mapping. Locked by the new orphan-schema fixture + `/graph` label assertion (`viz-corpus-graph.test.ts:738-748, 779-791`). Both test suites pass (60/60).
- **Round-3 WR-03 (stale dragged position on reopen)** and **IN-09 (drag ergonomics)** — OBSOLETE. The entire drag machinery (`panelPos`, pointer handlers, `.dragging` cursor rules) was removed by the GAP-10 docked-column rework; nothing references `panelPos` anymore.
- **GAP-10 reflow mechanics verified sound:** `#corpus-graph` is `position:fixed; inset:0` with an **opacity-only** transition (`styles.css:1200-1212`), so `.index-docked #corpus-graph { left: var(--index-width) }` (`styles.css:1309`) shrinks it against its `right:0` anchor, and the synchronous `container.clientWidth` read in `sizeCorpusGraph` (`corpus.js:568`) sees the final post-toggle width — no transition race. `openSidebar`/`hidePanel` toggle `body.index-docked` before calling `ctx.refitCorpus` (`index.js:406-413, 421-422`), and the round-3 "stale docked comments" in corpus.js (`sizeCorpusGraph`'s `.index-docked` note, `goToCorpus`'s dock/reflow note, `refitCorpus`'s caller note) are accurate again now that docking is restored.

**Still open / new:** the round-3 `ownerScope` over-application warning was not touched by 61-17/61-18 and is carried (WR-03). Two new warnings target the 61-18/61-17 interactions: `refitCorpus` (newly re-wired by GAP-10) ignores an active project focus, and the GAP-7 deferred clamp timers are never cancelled, so rapid focus toggling reintroduces the mid-animation snap. Info items carry the surviving round-3 nits plus two new GAP-10 observations.

Security posture: no new endpoints; `humanTitle` operates on DB-sourced strings server-side with no request input; `index.js` keeps the `.textContent`-only discipline (innerHTML receives only static SVG constants); the removed drag code eliminates the only inline-style position writer. No Critical findings.

## Warnings

### WR-01: `ctx.refitCorpus` ignores `focusedScope` — docking/undocking the rail while a project is focused snaps the camera to the full graph while the dim state still shows focus

**File:** `src/viz/modules/corpus.js:723-726` (callers: `src/viz/modules/index.js:413, 422`)
**Issue:** GAP-10 re-wired `ctx.refitCorpus` into `openSidebar`/`hidePanel` (it was dead code under the GAP-9 floating paradigm, so this path is newly reachable). `refitCorpus` calls `fitAndClamp()`, which does an **instant** `zoomToFit(0, 40, isNodeVisible)` over ALL visible nodes. Sequence: user opens the rail, clicks a project row → graph animates into the focused cluster with everything else dimmed → user collapses the rail (◀) for more room (or reopens it) → the camera instantly snaps out to the whole graph, while `focusedScope` is still set: the dim overlay, the revealed chapters, and the index's `.active` row all still say "focused on X", but the framing says "everything". This is both a state inconsistency (camera contradicts focus state) and an instant snap of exactly the kind GAP-7 was just fixed to remove.
**Fix:** Make the refit focus-aware:
```js
ctx.refitCorpus = function refitCorpus() {
  sizeCorpusGraph();
  if (focusedScope) {
    try {
      CorpusGraph.zoomToFit(0, 40, (n) => projectScopeOf(n) === focusedScope && isNodeVisible(n));
      if (typeof CorpusGraph.zoom === 'function' && CorpusGraph.zoom() > MAX_ZOOM) CorpusGraph.zoom(MAX_ZOOM, 0);
    } catch (_) { /* ignore */ }
  } else {
    fitAndClamp();
  }
};
```

### WR-02: GAP-7 deferred clamp timers are never cancelled — rapid focus/unfocus within 500 ms fires a stale `zoom(MAX_ZOOM, 0)` mid-animation, reintroducing the snap

**File:** `src/viz/modules/corpus.js:801-807, 821-827`
**Issue:** Each `focusCorpusProject` call schedules an independent anonymous `setTimeout(…, CORPUS_FOCUS_TRANSITION_MS)` with no handle and no cancellation. Sequence: focus a small cluster (whose `zoomToFit` target exceeds `MAX_ZOOM`), then within 500 ms press Esc (or click another project) — the second call starts a NEW 500 ms animated transition, but the FIRST call's timer fires mid-flight, reads the in-transit zoom (still above `MAX_ZOOM` on the way down), and issues an instant `zoom(MAX_ZOOM, 0)` that interrupts the running animation. That is precisely the "instant snap mid-transition" defect the GAP-7 fix exists to eliminate, resurfacing in the rapid-toggle path. The same stale timer also mis-clamps after a `refitCorpus` (rail dock/undock) lands inside the 500 ms window. The new source-assertion test only checks that the clamp is deferred, not that stale deferrals are cancelled.
**Fix:** One shared timer handle, cleared on every entry:
```js
let clampTimer = null;
ctx.focusCorpusProject = function focusCorpusProject(scope) {
  if (!CorpusGraph) return;
  if (clampTimer !== null) { clearTimeout(clampTimer); clampTimer = null; }
  // ... both branches assign: clampTimer = setTimeout(() => { clampTimer = null; ...clamp... }, CORPUS_FOCUS_TRANSITION_MS);
};
```

### WR-03: Client GAP-4 `ownerScope` preference applies to ALL nodes; server's `/index` resolution is tree-ROOT-only — graph reveal/dim grouping can contradict the index tree (carried from round 3, unchanged)

**File:** `src/viz/modules/corpus.js:291-295` (vs `src/viz/server.ts:1411-1419`)
**Issue:** Unchanged by 61-17/61-18. Server-side, GAP-4 nesting in `/index` resolves schema→project **only for containment tree roots** (`if (childToParent.has(row.id)) continue;`, `server.ts:1413`), but corpus.js's preference pass overrides `nodeProjectScope` for **any** node with a recognized `ownerScope` — including chapters that HAVE a containment parent. When a chapter's dominant `abstracts`-member scope differs from the project tree it is containment-nested in, the graph groups it under `ownerScope` while the index tree nests it by containment: expanding/focusing the tree's project neither reveals nor un-dims that chapter, breaking the D-07 tree↔graph parity invariant.
**Fix:** Mirror the server's root-only rule in the client preference pass:
```js
for (const node of (data.nodes || [])) {
  if (childToParentId.has(node.id)) continue; // containment owner wins for non-roots (mirror /index)
  if (node.ownerScope && projectScopes.has(node.ownerScope)) {
    nodeProjectScope.set(node.id, node.ownerScope);
  }
}
```
(Alternatively, have the server attach `ownerScope` only to containment roots — one rule, one place.)

## Info

### IN-01: Corpus Esc listener doesn't exempt the index filter input (carried from round 3)

**File:** `src/viz/modules/corpus.js:847-852`
**Issue:** Pressing Esc while typing in `.index-search-input` (a `type="search"` input, which natively clears on Esc) also clears project focus and fires the animated zoom-out — two unrelated actions on one keypress. The listener exempts the reader and palette but not a focused input. More reachable now that the docked rail and the graph are visible side by side.
**Fix:** Early-return when `ev.target` is an input/textarea: `if (ev.target && /^(INPUT|TEXTAREA)$/.test(ev.target.tagName)) return;`

### IN-02: `ctx.openIndexSidebar` still has zero callers; two "docks over the corpus" comments now contradict the beside-not-over GAP-10 model

**File:** `src/viz/modules/index.js:439`; `src/viz/modules/corpus.js:679, 711`
**Issue:** (a) `ctx.openIndexSidebar` is assigned but never called (grep-verified — the reopen handle calls `openSidebar` directly; corpus.js uses only `showIndexHandle`/`closeIndexSidebar`; the two remaining mentions are comments). Round-3's other dead hook `ctx.openIndex` was removed; this one survived. (b) `corpus.js:679` ("The index sidebar (if open) docks **over** the corpus") and `corpus.js:711` ("docks as a left sidebar **OVER** this corpus graph") still describe the pre-GAP-10 overlay model; the panel now docks BESIDE the graph, which reflows.
**Fix:** Delete the dead hook (or wire it to a palette command); reword both comments to the side-by-side reflow model.

### IN-03: `hidePanel` leaks a `transitionend` listener per call when no transition will fire

**File:** `src/viz/modules/index.js:423-429` (caller: `src/viz/modules/corpus.js:680`)
**Issue:** `goToBrain` calls `closeIndexSidebar` unconditionally on every brain toggle, even when the panel was never opened. In that case `classList.remove('shown')` changes nothing, no `transitionend` ever fires, and the `onEnd` listener stays attached — one accumulates per toggle. Self-limiting (a later real transition flushes them all, each removing itself) and each is tiny, but it's an unbounded-until-flushed listener pile on a hot toggle path.
**Fix:** Guard the whole body: `if (!isSidebarOpen && container.style.display === 'none') return;` at the top of `hidePanel` (or only attach `onEnd` when the panel was actually shown).

### IN-04: Docked panel spans `top: 0` without `-webkit-app-region: no-drag` — header top edge shadowed by the tray shells' 26px drag strip

**File:** `src/viz/css/styles.css:1284-1289` (vs `apps/tray/src/popover.ts:259`, `apps/tray/src/detail-window.ts:44`)
**Issue:** The panel moved from `top: 56px` to `top: 0`. The main exploration window is a framed BrowserWindow (native title bar — unaffected), but the tray popover and detail shells inject a full-width 26 px `-webkit-app-region:drag` strip at `z-index: 60`, above the panel's `z-index: 8`. In those shells the panel header's top ~10 px (title, upper half of the ◀ button hit area) is captured by the drag band instead of the panel. `#index-reopen` explicitly guards against exactly this (`-webkit-app-region: no-drag`, z:70 — `styles.css:1257, 1267`); the panel doesn't.
**Fix:** Add `-webkit-app-region: no-drag;` to `#index-panel` (harmless in the framed window), or pad the header below the 26 px band in shell contexts.

### IN-05: `.index-count` uses a radius token as horizontal padding (carried from round 3)

**File:** `src/viz/css/styles.css:1496`
**Issue:** `padding: 0 var(--radius-xs);` — a border-radius token repurposed as spacing. Works (4px) but couples badge padding to any future radius retune.
**Fix:** Use a literal `4px` (spacing values aren't under the D-14 color-token ban) or introduce a spacing token.

### IN-06: `/index` `depth` field inconsistent after GAP-4 re-parenting (carried from round 3)

**File:** `src/viz/server.ts:1424-1435`
**Issue:** A GAP-4-nested schema root ships `parentId = <project doc id>` but `depth: 0` (depth comes from the pre-resolution `rootAndDepth` walk), and its children's depths are likewise off by one. Harmless today only because index.js ignores the field and recomputes depth during render — dead payload weight that will mislead a future consumer.
**Fix:** Bump depth by 1 for resolved trees or drop `depth` from the payload.

### IN-07: UUID regex duplication only partially resolved by the GAP-8 hoist — `/graph` handler still declares its own copy

**File:** `src/viz/server.ts:344` (hoisted `UUID_RE`), `src/viz/server.ts:940` (`graphSchemaSlugRe`); `src/viz/modules/corpus.js:100`
**Issue:** Round-3 IN-06 asked for one server-side schema-slug regex. The 61-17 hoist gave `/index` and `humanTitle` a shared `UUID_RE`, but the `/graph?type=doc` branch still declares an identical local `graphSchemaSlugRe` three lines above code that could use the hoisted constant — two server copies of a load-bearing predicate (`ownerScope` attachment + `projectScopes` derivation both key off it) remain. The corpus.js client copy is inherent to the boundary.
**Fix:** Delete `graphSchemaSlugRe` and use the hoisted `UUID_RE` in the `/graph` branch.

### IN-08: `/index` payload memoized for the whole session — stale after doc generation; module doc claims lazy fetch (carried from round 3)

**File:** `src/viz/modules/index.js:382-395, 414, 456` (doc comment at `index.js:43`)
**Issue:** `prepareIndex` memoizes `'ready'` permanently — `openSidebar`'s `prepareIndex()` call no-ops after the first success, so docs generated mid-session (reader regenerate, corpus promoter) never appear in the rail until a hard reload. Separately, the header comment still says "Lazy: /index is only fetched on the first open," while line 456 eagerly prefetches 1.2 s after init.
**Fix:** Refetch on `openSidebar` (one cheap read-only request) or invalidate `preparePromise` when a generation completes; fix the comment.

### IN-09: `projectScopes` construction is only an approximate mirror of the `/index` recognized-project rule (carried from round 3)

**File:** `src/viz/server.ts:949-960`
**Issue:** The comment claims the set "mirrors the /index recognized-project rule (a doc is a project when its slug is NOT a UUID)", but the implementation additionally requires `n.scope` non-null and keys by `rootScope(n.scope)` rather than the slug — a scope-less non-UUID doc counts as a project in `/index` but is excluded here; a hub whose slug ≠ its scope-root would render as an index project row that `focusCorpusProject` rejects. Theoretical today (CorpusPromoter appears to always stamp `node_scope`), but the comment overstates the parity in exactly the predicate family where the phase-61 drift bugs lived.
**Fix:** Align the derivation to the slug rule, or amend the comment to state the extra scope-derived conditions.

### IN-10: Round-3 items in files outside this round's scope, re-verified still open

**File:** `tests/viz-index-route.test.ts:471-474`; `tests/viz-activity-palette-invariants.test.ts:452-468`
**Issue:** Grep-verified but not re-reviewed in depth (files not in this round's scope): (a) the "handler reuses stmtDocNodes" test still wraps its only assertion in `if (indexHandlerMatch) { … }` — the block-comment regex does not match the server's `// ──` line-comment style, so the test can pass vacuously (round-3 IN-05); (b) the D-14-C allow-list JSDoc still describes "D-12's exact glass-surface list" without mentioning the `#index-panel`/`#index-reopen` additions (round-3 IN-08).
**Fix:** As previously reported: assert unconditionally / fail when the handler block can't be located; extend the allow-list comment.

---

_Reviewed: 2026-07-17_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
