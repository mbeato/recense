---
phase: 61-corpus-chrome-index-column-project-browsing
reviewed: 2026-07-16T00:00:00Z
depth: standard
files_reviewed: 9
files_reviewed_list:
  - src/viz/css/styles.css
  - src/viz/index.html
  - src/viz/modules/constants.js
  - src/viz/modules/corpus.js
  - src/viz/modules/index.js
  - src/viz/server.ts
  - tests/viz-activity-palette-invariants.test.ts
  - tests/viz-corpus-graph.test.ts
  - tests/viz-index-route.test.ts
findings:
  critical: 0
  warning: 4
  info: 10
  total: 14
status: issues_found
---

# Phase 61: Code Review Report (round 4)

**Reviewed:** 2026-07-16
**Depth:** standard
**Files Reviewed:** 9
**Status:** issues_found

## Summary

Round-4 review after plan 61-15 (predicate unification: server-shipped `projectScopes`, single-writer `activeScope`) and plan 61-16 (GAP-9 floating draggable `#index-panel`). The floating-panel paradigm itself is NOT flagged (GAP-10 docked-left rework is an acknowledged follow-up).

**Round-3 fixes verified as landed:**

- **WR-01 (null-scope inversion)** — FIXED. `isProjectRevealed` (`corpus.js:189-192`) guards `scope == null` BEFORE the equality check; the label predicate (`corpus.js:353`) gates its focus branch with `focusedScope !== null`. Locked by `viz-corpus-graph.test.ts:821-841` (guard-ordering source assertion).
- **WR-03 (project-scope predicate drift)** — FIXED. Server ships `projectScopes` on `/graph?type=doc` (`server.ts:930-941`); `corpus.js:243-251` consumes it via an `Array.isArray` presence gate (empty-but-present honored), keeping the old subject-doc derivation only as a defensive fallback. Locked by `viz-corpus-graph.test.ts:745-814`, including the hub-only-project case.
- **WR-04 (activeScope desync)** — FIXED. `activeScope` is assigned in exactly two places — its declaration (`index.js:62`) and inside `ctx.syncCorpusFocus` (`index.js:498-501`); the row click handler only reads it, and corpus.js notifies `syncCorpusFocus` only when a focus actually takes or clears. Locked by `viz-corpus-graph.test.ts:856-874`.
- **WR-05 (reveal-time camera snap)** — FIXED. `setCorpusProjectExpanded` (`corpus.js:822-827`) contains no `fitAndClamp` call. Locked by `viz-corpus-graph.test.ts:843-848`.
- **WR-06 (filter auto-expand parity)** — FIXED. `computeVisible` (`index.js:204-233`) notifies `ctx.setCorpusProjectExpanded` for newly-expanded root ancestors; `expandedIds` is only unioned into. Locked by `viz-corpus-graph.test.ts:876-892`.

**Round-3 WR-02 (MAX_ZOOM clamp race) was NOT fixed** and is re-reported below as WR-01. Three new findings target the 61-15/61-16 additions: the client-side GAP-4 `ownerScope` preference over-applies vs the server's root-only rule; the dragged panel position is restored without viewport re-clamping; and the GAP-8 UUID-label scrub covers `/index` but not the `/graph?type=doc` label the corpus canvas actually draws. Eight round-3 Info items remain open and are carried forward.

Security posture re-verified: no new endpoints; `projectScopes`/`ownerScope` are derived server-side from prepared read-only statements with no request input in SQL text; `index.js` keeps the `.textContent`-only discipline (innerHTML receives only static SVG constants); the drag handler touches only inline `left/top` styles. No Critical findings.

## Warnings

### WR-01: MAX_ZOOM clamp races the animated `zoomToFit` in `focusCorpusProject` — ceiling not enforced (round-3 WR-02, still open)

**File:** `src/viz/modules/corpus.js:794-799, 806-814`
**Issue:** `fitAndClamp()` is correct because both the fit and the clamp are instant (0 ms). `focusCorpusProject` copies the same clamp idiom after an **animated** `zoomToFit(CORPUS_FOCUS_TRANSITION_MS, …)`, but `CorpusGraph.zoom()` is read synchronously, returning the **pre-animation** zoom, not the animation target. Consequences: (a) focusing a small cluster (e.g. a 2-doc project) animates the zoom **past MAX_ZOOM** with no clamp ever applied — exactly the blown-up-circles defect MAX_ZOOM exists to prevent; (b) once (a) has happened, the unfocus branch reads the now-over-limit zoom and fires an instant `zoom(MAX_ZOOM, 0)` WHILE the 500 ms zoom-out transition is running, interrupting it — so the GAP-7 "animated zoom-out, not an instant snap" degrades to a snap. Both the focus branch and the `null` branch are affected.
**Fix:** Clamp after the transition completes:
```js
CorpusGraph.zoomToFit(CORPUS_FOCUS_TRANSITION_MS, 40, pred);
setTimeout(() => {
  try {
    if (typeof CorpusGraph.zoom === 'function' && CorpusGraph.zoom() > MAX_ZOOM) {
      CorpusGraph.zoom(MAX_ZOOM, 0);
    }
  } catch (_) { /* ignore */ }
}, CORPUS_FOCUS_TRANSITION_MS);
```
(or compute the target zoom from the cluster bbox and issue a single pre-clamped `zoom()` call instead of `zoomToFit`).

### WR-02: Client GAP-4 `ownerScope` preference applies to ALL nodes; server's `/index` resolution is tree-ROOT-only — graph reveal/dim grouping can contradict the index tree

**File:** `src/viz/modules/corpus.js:286-295` (vs `src/viz/server.ts:1401-1409, 922-929`)
**Issue:** Server-side, GAP-4 nesting in `/index` deliberately resolves schema→project **only for containment tree roots** (`if (childToParent.has(row.id)) continue; // only tree ROOTS resolve this way`, `server.ts:1403`). But the `/graph?type=doc` payload attaches `ownerScope` to **every** UUID-slug node (`server.ts:925-929`), and corpus.js's preference pass overrides `nodeProjectScope` **unconditionally** for any node with a recognized `ownerScope` — including chapters that HAVE a containment parent. When a chapter's dominant `abstracts`-member scope differs from the project tree it is containment-nested in (cross-project schema, or scope drift), the graph groups it under `ownerScope` while the index tree nests it by containment: expanding/focusing the tree's project neither reveals nor un-dims that chapter (`isProjectRevealed` keys off `projectScopeOf`, which now returns the other project), and focusing the *other* project reveals a node sitting visually inside the wrong cluster. This breaks the D-07 tree↔graph parity invariant that WR-06 was just fixed to protect.
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

### WR-03: `openSidebar` restores a stale dragged position without re-clamping — panel can reopen fully off-screen and become unrecoverable

**File:** `src/viz/modules/index.js:453-456` (clamp exists only in `pointermove`, `index.js:112-114`)
**Issue:** The drag handler clamps `left/top` to the viewport at drag time (T-61-16-02), but `panelPos` is applied verbatim in `openSidebar()`. If the window shrinks between the drag and the next open (user resize; the `recense viz` window is freely resizable), `panelPos.left` (legitimately up to old `innerWidth - 40`) can exceed the new viewport entirely — the panel fades in fully off-screen with its drag grip unreachable, and since `panelPos` is the only position source this session, the index is effectively lost until a hard reload. The header comment's "the panel can never be dragged fully off-screen" invariant is enforced only during `pointermove`, not at restore.
**Fix:** Re-clamp with the same formula before applying:
```js
if (panelPos) {
  const w = container.getBoundingClientRect().width || 270;
  const left = Math.max(-(w - 40), Math.min(panelPos.left, window.innerWidth - 40));
  const top = Math.max(0, Math.min(panelPos.top, window.innerHeight - 40));
  container.style.left = left + 'px';
  container.style.top = top + 'px';
}
```

### WR-04: GAP-8 UUID-label scrub covers `/index` only — `/graph?type=doc` still ships the raw UUID as `label`, and the corpus canvas draws it

**File:** `src/viz/server.ts:328` (label COALESCE), `src/viz/modules/corpus.js:357, 363` (draw site); the scrub exists only at `server.ts:1349-1358`
**Issue:** Guard-set ≠ ship-set. The GAP-8 fix (T-61-22: "never leak a UUID as a visible label") added `humanTitle()` (H1-derivation fallback) in the `/index` handler only. The `/graph?type=doc` branch still resolves `label` as `COALESCE(NULLIF(sch.value,''), nd.slug)` — for a schema-anchored doc whose backing schema node is missing or empty-valued, `label` **is the UUID slug**. corpus.js renders `nodeLabels[node.id] = node.label || node.slug || node.id` below the node; chapter docs draw their label on hover (`corpus.js:349-353`), so hovering such a node in the corpus graph displays the raw UUID — the exact leak T-61-22 flagged, on a second surface. `tests/viz-index-route.test.ts:305-315` locks the `/index` surface; nothing locks `/graph`.
**Fix:** Apply the same derivation in the `/graph?type=doc` node mapping (the doc `value` is already selected by `stmtDocNodes`) — e.g. share a `humanTitle(row)` helper: `label: UUID_RE.test(n.label) ? humanTitle(n) : n.label`. Add a `/graph?type=doc` label assertion mirroring the `/index` GAP-8 test.

## Info

### IN-01: Corpus Esc listener doesn't exempt the index filter input (carried from round 3)

**File:** `src/viz/modules/corpus.js:834-839`
**Issue:** Pressing Esc while typing in `.index-search-input` (a `type="search"` input, which natively clears on Esc) also clears project focus and fires the animated zoom-out — two unrelated actions on one keypress. The listener exempts the reader and palette but not a focused input.
**Fix:** Early-return when `ev.target` is an input/textarea: `if (ev.target && /^(INPUT|TEXTAREA)$/.test(ev.target.tagName)) return;`

### IN-02: Dead ctx hooks and stale "docked rail" documentation after GAP-9 (extends round-3 IN-03)

**File:** `src/viz/modules/index.js:485-487`; `src/viz/modules/corpus.js:565-568, 668-671, 710-726`; `src/viz/index.html:153-156`
**Issue:** (a) `ctx.openIndex` and `ctx.openIndexSidebar` still have zero callers (grep-verified; the reopen handle calls `openSidebar` directly, corpus.js uses only `showIndexHandle`/`closeIndexSidebar`). (b) `ctx.refitCorpus` (`corpus.js:723-726`) is now also dead: its only documented caller ("index.js after the sidebar docks/undocks") was removed by the GAP-9 floating rework. (c) Several comments still describe the deleted docking paradigm: `sizeCorpusGraph`'s `.index-docked` left-offset note (`corpus.js:565-568` — that class no longer exists anywhere in CSS), `goToCorpus`'s "then it docks/reflows as built" (`corpus.js:670`), the "docks as a left sidebar OVER this corpus graph" hook header (`corpus.js:711`), and index.html's "left sidebar docked over the corpus graph" host comment. A future reader could reasonably "restore" the docking behavior these comments describe — the exact regression `styles.css:1279-1281` explicitly warns against.
**Fix:** Delete the three dead hooks (or wire `openIndexSidebar` into a palette command if intended); update the stale comments to the floating-panel model.

### IN-03: `.index-count` uses a radius token as horizontal padding (carried from round 3)

**File:** `src/viz/css/styles.css:1497`
**Issue:** `padding: 0 var(--radius-xs);` — a border-radius token repurposed as spacing. Works (4px) but couples badge padding to any future radius retune.
**Fix:** Use a literal `4px` (spacing values aren't under the D-14 color-token ban) or introduce a spacing token.

### IN-04: `/index` `depth` field inconsistent after GAP-4 re-parenting (carried from round 3)

**File:** `src/viz/server.ts:1417-1426`
**Issue:** A GAP-4-nested schema root ships `parentId = <project doc id>` but `depth: 0` (depth comes from the pre-resolution `rootAndDepth` walk), and its children's depths are likewise off by one. Harmless today only because index.js ignores the field and recomputes depth during render — the payload field is dead weight that will mislead a future consumer.
**Fix:** Bump depth by 1 for resolved trees (`depth + (resolvedRootParent.has(root) ? 1 : 0)`) or drop `depth` from the payload.

### IN-05: Vacuous conditional assertion in the `/index` source-assertion test (carried from round 3)

**File:** `tests/viz-index-route.test.ts:463-476`
**Issue:** The "handler reuses stmtDocNodes" test wraps its only meaningful assertion in `if (indexHandlerMatch) { … }`. The regex requires a `/* … */` block comment immediately before `if (url === '/index')`, but the server code uses `// ──` line comments — the match is null and the test passes without asserting anything about the handler body.
**Fix:** Match the real comment style (or slice the source from `url === '/index'` to the next route guard) and assert unconditionally; fail the test when the handler block can't be located.

### IN-06: UUID regex duplicated three times across the boundary (carried from round 3)

**File:** `src/viz/server.ts:924, 1343`; `src/viz/modules/corpus.js:100`
**Issue:** The identical schema-slug UUID regex is declared as `graphSchemaSlugRe` (inside the `/graph` handler), a local `UUID_RE` (inside the `/index` handler), and `UUID_RE` (corpus.js). The "is this slug a schema chapter?" rule is now load-bearing for `projectScopes`, section partitioning, AND chapter hiding — three copies invite drift in exactly the predicate family 61-15 just unified. The two server-side copies at minimum should be one module-level constant.
**Fix:** Hoist a single `const SCHEMA_SLUG_RE` at server module scope and use it in both handlers.

### IN-07: `/index` payload memoized for the whole session — stale after doc generation; module doc claims lazy fetch (carried from round 3)

**File:** `src/viz/modules/index.js:426-439, 503`
**Issue:** `prepareIndex` memoizes `'ready'` permanently — reopening the panel never refetches, so docs generated mid-session (reader regenerate, corpus promoter) never appear until a hard reload. Separately, the doc comment at `index.js:43` still says "Lazy: /index is only fetched on the first open," while line 503 eagerly prefetches 1.2 s after init — doc drift.
**Fix:** Refetch on `openSidebar` (one cheap read-only request), or invalidate `preparePromise` when a generation completes; fix the header comment.

### IN-08: D-14-C allow-list comment no longer matches its contents (carried from round 3)

**File:** `tests/viz-activity-palette-invariants.test.ts:452-468`
**Issue:** The JSDoc describes "D-12's exact glass-surface list," but `ALLOWED_SELECTORS` also contains `#index-panel` and `#index-reopen` (correct for this phase's glass chrome, but undocumented). A future reader auditing D-12 compliance against the comment would flag false violations.
**Fix:** Extend the comment: "…plus the Phase-61 index chrome surfaces (#index-panel, #index-reopen)."

### IN-09: Drag ergonomics — no button filter, no selection suppression, fixed max-height ignores dragged top (new, 61-16)

**File:** `src/viz/modules/index.js:93-105`; `src/viz/css/styles.css:1285-1320`
**Issue:** (a) `pointerdown` doesn't check `ev.button === 0`, so right/middle-button presses initiate a drag. (b) Neither `ev.preventDefault()` nor `user-select: none` on `.index-sidebar-header` — dragging can select the "Index" title text mid-drag. (c) `#index-panel`'s `max-height: calc(100vh - 56px - 16px)` assumes the CSS-default `top: 56px`; once dragged lower, the panel bottom (part of the scrollable list) extends past the viewport bottom.
**Fix:** `if (ev.button !== 0) return;` in pointerdown; add `user-select: none` to the header rule; recompute max-height from the dragged top (`container.style.maxHeight = (window.innerHeight - top - 16) + 'px'`) or accept the clip deliberately with a comment.

### IN-10: `projectScopes` construction is only an approximate mirror of the `/index` recognized-project rule (new, 61-15)

**File:** `src/viz/server.ts:934-941`
**Issue:** The WR-03 comment claims the set "mirrors the /index recognized-project rule (a doc is a project when its slug is NOT a UUID)", but the implementation adds two extra conditions: it requires `n.scope` non-null (a scope-less non-UUID doc counts as a project in `/index` but is excluded here — the LEFT JOIN on `node_scope` makes null scope representable) and it keys by `rootScope(n.scope)` rather than the slug (a hub whose slug ≠ its scope-root would render as an index project row that `focusCorpusProject` rejects). CorpusPromoter appears to always stamp `node_scope`, so this is theoretical today — but the comment overstates the parity, and this predicate family is exactly where the phase-61 drift bugs lived.
**Fix:** Either align the derivation to the slug rule (add the non-UUID slug's root; scope only as fallback) or amend the comment to state the additional scope-derived conditions explicitly.

---

_Reviewed: 2026-07-16_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
