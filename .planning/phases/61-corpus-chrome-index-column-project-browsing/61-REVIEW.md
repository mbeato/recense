---
phase: 61-corpus-chrome-index-column-project-browsing
reviewed: 2026-07-14T00:00:00Z
depth: standard
files_reviewed: 8
files_reviewed_list:
  - src/viz/css/styles.css
  - src/viz/index.html
  - src/viz/modules/constants.js
  - src/viz/modules/corpus.js
  - src/viz/modules/index.js
  - src/viz/server.ts
  - tests/viz-activity-palette-invariants.test.ts
  - tests/viz-index-route.test.ts
findings:
  critical: 0
  warning: 6
  info: 8
  total: 14
status: issues_found
---

# Phase 61: Code Review Report

**Reviewed:** 2026-07-14
**Depth:** standard
**Files Reviewed:** 8
**Status:** issues_found

## Summary

Reviewed the phase-61 corpus chrome work: the docked/default-closed index rail (`index.js`, `styles.css`, `index.html`), project focus/unfocus + chapter reveal in the 2D corpus (`corpus.js`, `constants.js` CORPUS_* tunables), the server-side `/index` human-title + GAP-4 schema→project resolution (`server.ts`), and the two test files.

**Project invariants verified as PASSING:**
- Founder hard rule (GAP-5): `.index-row` / `.index-entry` carry **no border-radius** — hover/active backgrounds are square-edged. Confirmed in `styles.css:1434-1461`.
- Read-only server: `/index` and the GAP-4 resolution reuse prepared statements on the single readonly handle; no LLM on any online path; the `new Database` count lock (T-39-07) still passes.
- Token discipline: every `var(--…)` used in `styles.css` resolves to a `HUD_CSS_TOKENS` entry (mechanically cross-checked); `--index-width` is the grandfathered exception; no raw color literals reintroduced.
- XSS posture: all DB-sourced strings in `index.js` go through `.textContent`; `innerHTML` only receives static SVG constants; `/index` labels are UUID-scrubbed via `humanTitle` (GAP-8).

The main defect cluster is **cross-module state/predicate drift** between `index.js`, `corpus.js`, and `server.ts`: the three components disagree about what counts as a "project scope" and about who owns focus/expanded state, producing silent no-ops and UI desync in reachable configurations. No security or data-loss issues found.

## Warnings

### WR-01: `null === null` scope comparison inverts chapter visibility and label tiering for scope-less docs

**File:** `src/viz/modules/corpus.js:184-190, 334-339`
**Issue:** `projectScopeOf(node)` returns `null` for a doc whose containment root has no `node_scope` row (`stmtDocNodes` LEFT JOINs `node_scope`, so `scope` is `null`; `rootScope(null)` → `null`, and `nodeProjectScope.set(id, null)` stores it, so the `owner !== undefined` check returns the stored `null`). Two predicates compare that against `focusedScope`, which is **also `null` at rest**:
- `isProjectRevealed`: `scope === focusedScope` → `null === null` → `true`. A UUID-slug chapter doc with a null-resolved owner is therefore **visible whenever nothing is focused** and **hidden whenever any project is focused** — the exact inverse of the D-07 "chapters hidden by default, revealed on focus" contract.
- Label predicate (line 339): `projectScopeOf(node) === focusedScope` → scope-less subject docs draw labels at rest even below `CORPUS_LABEL_ZOOM_THRESHOLD`, defeating D-06 tiered labels.

Note `nodeCanvasObject`'s `isRelated` (line 308) and `linkColor`'s `related()` (line 381) correctly guard with `focusedScope && …` — these two call sites are the inconsistent ones.
**Fix:**
```js
function isProjectRevealed(node) {
  const scope = projectScopeOf(node);
  if (scope == null) return false;
  return (focusedScope !== null && scope === focusedScope) || expandedScopes.has(scope);
}
// label predicate:
: (globalScale >= CORPUS_LABEL_ZOOM_THRESHOLD || isHover ||
   (focusedScope !== null && projectScopeOf(node) === focusedScope));
```

### WR-02: MAX_ZOOM clamp races the animated `zoomToFit` in `focusCorpusProject` — ceiling not enforced

**File:** `src/viz/modules/corpus.js:781-785, 793-800`
**Issue:** `fitAndClamp()` is correct because both the fit and the clamp are instant (0 ms). `focusCorpusProject` copies the same clamp idiom after an **animated** `zoomToFit(CORPUS_FOCUS_TRANSITION_MS, …)`, but `CorpusGraph.zoom()` is read synchronously — it returns the **pre-animation** zoom, not the animation target. Consequences: (a) focusing a small cluster (e.g. a 2-doc project) lets the animated fit land **above MAX_ZOOM** with no clamp ever applied; (b) in the rare case the current zoom already exceeds MAX_ZOOM, `zoom(MAX_ZOOM, 0)` fires an instant zoom that fights the in-flight 500 ms animation. Same pattern in both the `null` (unfocus) branch and the focus branch.
**Fix:** Apply the clamp after the transition completes, e.g.:
```js
CorpusGraph.zoomToFit(CORPUS_FOCUS_TRANSITION_MS, 40, pred);
setTimeout(() => {
  if (typeof CorpusGraph.zoom === 'function' && CorpusGraph.zoom() > MAX_ZOOM) {
    CorpusGraph.zoom(MAX_ZOOM, 0);
  }
}, CORPUS_FOCUS_TRANSITION_MS);
```
(or compute the fit zoom yourself and pass a pre-clamped `zoom()` call instead of `zoomToFit`).

### WR-03: Predicate parity — client "project scope" gate (subject-doc-derived) disagrees with server GAP-4 resolution (hub-doc-derived)

**File:** `src/viz/modules/corpus.js:234-237, 277-281, 789` vs `src/viz/server.ts:1378-1392`
**Issue:** The server nests a schema tree under a project when a **hub doc with slug == scope exists** (`projectDocIdBySlug` keys every non-UUID slug). The client builds `projectScopes` **only from subject docs** (`slug` contains `':'`, line 236), then uses it to gate three things: the GAP-4 `ownerScope` preference pass (line 278), the project tint (line 320), and `focusCorpusProject`'s validity check (line 789). For a project with a hub doc but **no colon-slug subject docs** — exactly the shape of the `tonos` fixture in `viz-index-route.test.ts` — the `/index` tree nests schema docs under the project, but in the graph: `ownerScope` is discarded, the project gets no tint, and clicking the project row in the index **silently no-ops** (`!projectScopes.has(scope)` → return, no zoom, no dim, no chapter reveal). Per-side each predicate is documented and unit-tested; the cross-side contract is broken. This is the classic guard-set ≠ ship-set drift: two hand-maintained definitions of "recognized project."
**Fix:** Derive one definition. Simplest: have the client also admit hub scopes — `if (node.slug && !slug.includes(':') && !UUID_RE.test(node.slug) && node.scope) projectScopes.add(rootScope(node.scope))` alongside the subject-doc rule — or ship the recognized-project set from the server (it already computes `projectDocIdBySlug`) so both sides consume one source.

### WR-04: `index.js` sets `activeScope` unconditionally — active-row state desyncs from actual corpus focus

**File:** `src/viz/modules/index.js:219-232`
**Issue:** The project-row click handler calls `ctx.focusCorpusProject(scope)` and then sets `activeScope = scope` regardless of whether the focus actually took. `focusCorpusProject` deliberately ignores unrecognized scopes (`corpus.js:789`, no `syncCorpusFocus` notify) and no-ops entirely when `CorpusGraph` is null (build error / empty corpus). Reachable triggers: (a) any **Notes-section root with children** renders as a project row via `makeProjectRow`, and its `entry.slug` is a schema **UUID** — never in `projectScopes`; (b) hub-only projects per WR-03. Result: the row paints the active mauve bar + `aria-current` while nothing is focused in the graph — the GAP-3 "active row always matches graph focus state" contract is violated in the exact direction it was built to prevent. Toggling the phantom-active row off then fires `focusCorpusProject(null)`, which animates a full zoom-out even though no focus existed.
**Fix:** Make `ctx.syncCorpusFocus` the single writer of `activeScope`: remove the two local `activeScope = …` assignments in the click handler (corpus.js already calls `syncCorpusFocus` on every accepted focus change and on clear), or have `focusCorpusProject` return a boolean and only set `activeScope` on `true`.

### WR-05: `setCorpusProjectExpanded` calls `fitAndClamp()` — contradicts its own "WITHOUT zooming" contract and destroys focus framing

**File:** `src/viz/modules/corpus.js:806-814`
**Issue:** The hook's doc comment states "reveal/hide a project's chapter docs WITHOUT zooming or dimming," but the implementation ends with `fitAndClamp()`, an **instant 0 ms re-frame of the whole visible set**. Two concrete misbehaviors: (a) while project A is focused (zoomed to A's cluster, others dimmed), expanding project B's chevron in the index snaps the camera out to the full-graph fit while `focusedScope` is still A — dim state and framing now contradict each other; (b) on a name-click of a collapsed project, `setProjectExpanded` runs first (instant full-fit snap) followed by `focusCorpusProject`'s 500 ms animated zoom-in — a visible jolt-then-fly.
**Fix:** Drop `fitAndClamp()` from `setCorpusProjectExpanded` (reveal is a paint-time visibility change on a pinned layout; no re-frame needed), or at minimum skip it while `focusedScope !== null`:
```js
ctx.setCorpusProjectExpanded = function (scope, expanded) {
  if (!CorpusGraph) return;
  if (expanded) expandedScopes.add(scope); else expandedScopes.delete(scope);
  reassertPaint();
  // no fitAndClamp — reveal must not move the camera (D-07 contract)
};
```

### WR-06: Filter auto-expand mutates `expandedIds` without notifying corpus — index tree and graph reveal state diverge

**File:** `src/viz/modules/index.js:157-173`
**Issue:** `computeVisible` force-adds every match ancestor to `expandedIds` (intentional, per its comment), but never calls `ctx.setCorpusProjectExpanded(root.slug, true)` — unlike the chevron path (`setProjectExpanded`, line 181), which keeps `corpus.js`'s `expandedScopes` in sync. After filtering (and after clearing the filter, since the expansion deliberately persists), the index renders a project's chapter rows as expanded while the corresponding chapter **nodes remain hidden in the graph** (`expandedScopes` never gained the scope). Hovering those rows then highlights invisible nodes — nothing happens on canvas. The D-07 "tree row expanded → chapters visible" invariant is broken for every filter-driven expansion.
**Fix:** When `computeVisible` newly adds a root to `expandedIds`, route it through the same notifier: collect newly-expanded root entries and call `ctx.setCorpusProjectExpanded(entry.slug, true)` for each (roots only — non-root ancestors don't gate corpus reveal).

## Info

### IN-01: Corpus Esc listener doesn't exempt the index filter input

**File:** `src/viz/modules/corpus.js:821-826`
**Issue:** Pressing Esc while typing in `.index-search-input` (a `type="search"` input, which natively clears on Esc) also clears project focus and fires the animated zoom-out — two unrelated actions on one keypress.
**Fix:** Early-return when `ev.target` is an input/textarea: `if (ev.target && /^(INPUT|TEXTAREA)$/.test(ev.target.tagName)) return;`

### IN-02: `.index-count` uses a radius token as horizontal padding

**File:** `src/viz/css/styles.css:1496`
**Issue:** `padding: 0 var(--radius-xs);` — semantically a border-radius token repurposed as spacing. Works (4px) but couples badge padding to any future radius retune.
**Fix:** Use a literal `4px` (spacing values aren't under the D-14 color-token ban) or introduce a spacing token.

### IN-03: Dead ctx hooks — `ctx.openIndex` and `ctx.openIndexSidebar` have no consumers

**File:** `src/viz/modules/index.js:427-429`
**Issue:** Grep across `src/viz/modules/` finds no caller of either hook (the reopen handle calls `openSidebar` directly; corpus.js uses only `showIndexHandle`/`closeIndexSidebar`). The module header still claims index.js "open[s] the corpus when the sidebar opens from the brain view" — `openSidebar` never calls `ctx.openCorpus`, so if either dead hook is ever wired up from brain view, it would dock `.index-docked` over the 3D brain. Remove or document.
**Fix:** Delete `ctx.openIndex`; keep `ctx.openIndexSidebar` only if a consumer is planned, and guard it with `if (typeof ctx.isCorpusOpen === 'function' && !ctx.isCorpusOpen()) ctx.openCorpus?.();`

### IN-04: `/index` `depth` field inconsistent after GAP-4 re-parenting

**File:** `src/viz/server.ts:1397-1409`
**Issue:** A GAP-4-nested schema root ships `parentId = <project doc id>` but `depth: 0` (depth comes from the pre-resolution `rootAndDepth` walk), and its children's depths are likewise off by one. Harmless today only because `index.js` ignores the field and recomputes depth during render — the payload field is dead weight that will mislead a future consumer.
**Fix:** Either bump depth by 1 for resolved trees (`depth + (resolvedRootParent.has(root) ? 1 : 0)`) or drop `depth` from the payload.

### IN-05: Vacuous conditional assertion in the `/index` source-assertion test

**File:** `tests/viz-index-route.test.ts:463-476`
**Issue:** The "handler reuses stmtDocNodes" test wraps its only meaningful assertion in `if (indexHandlerMatch) { … }`. The regex requires a `/* … */` block comment immediately before `if (url === '/index')`, but the actual server code uses `// ──` line comments — the match is null and the test passes without asserting anything about the handler body.
**Fix:** Match the real comment style (or just slice the source from `url === '/index'` to the next route guard) and assert unconditionally; fail the test when the handler block can't be located.

### IN-06: UUID regex duplicated three times across the boundary

**File:** `src/viz/server.ts:921, 1326`; `src/viz/modules/corpus.js:100`
**Issue:** The identical schema-slug UUID regex is declared as `graphSchemaSlugRe` (inside the `/graph` handler), `UUID_RE` (inside the `/index` handler), and `UUID_RE` (corpus.js). The two server copies at least should be one module-level constant; drift here would silently split the "is schema doc" classification between `/graph` ownerScope and `/index` partitioning.
**Fix:** Hoist a single `const SCHEMA_SLUG_RE` at server module scope and use it in both handlers.

### IN-07: `/index` payload memoized for the whole session — stale after doc generation; module doc claims lazy fetch

**File:** `src/viz/modules/index.js:363-377, 445`
**Issue:** `prepareIndex` memoizes `'ready'` permanently — reopening the rail never refetches, so docs generated mid-session (reader regenerate, corpus promoter) never appear until hard reload. Separately, the module header says "Lazy: /index is only fetched on the first open," but line 445 eagerly prefetches 1.2 s after init — doc drift.
**Fix:** Refetch on `openSidebar` when the cached payload is older than some threshold (or always — it's one cheap read-only request), and fix the header comment.

### IN-08: D-14-C allow-list comment no longer matches its contents

**File:** `tests/viz-activity-palette-invariants.test.ts:453-468`
**Issue:** The comment describes "D-12's exact glass-surface list," but the set now also contains `#index-panel` and `#index-reopen` (correct for this phase's glass rail, but undocumented). A future reader auditing D-12 compliance against the comment would flag false violations.
**Fix:** Extend the comment: "…plus the Phase-61 index rail surfaces (#index-panel, #index-reopen), sanctioned at the 61-05/61-11 checkpoints."

---

_Reviewed: 2026-07-14_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
