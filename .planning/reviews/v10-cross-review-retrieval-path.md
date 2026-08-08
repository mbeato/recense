---
review: v10-cross-phase — ambient retrieval path (end-to-end)
reviewed: 2026-08-07T00:00:00Z
depth: deep
files_reviewed: 18
files_reviewed_list:
  - src/adapter/turn-capture-cli.ts
  - src/adapter/ambient-recall.ts
  - src/adapter/recall-cli.ts
  - src/adapter/session-start-cli.ts
  - src/adapter/memory-ops.ts
  - src/recall/index.ts
  - src/recall/typed-traversal.ts
  - src/retrieval/engine.ts
  - src/retrieval/entity-anchor.ts
  - src/retrieval/honest-trace.ts
  - src/retrieval/topk.ts
  - src/responder/index.ts
  - src/viz/server.ts
  - src/viz/activation-sink.ts
  - src/lib/config.ts
  - src/lib/scope.ts
  - src/db/semantic-store.ts
  - scripts/eval/recall-audit-gate.cjs
findings:
  critical: 1
  warning: 4
  info: 4
  total: 9
status: fixed
fixed_at: 2026-08-07
---

# Cross-Phase Code Review: Ambient Retrieval Path

**Reviewed:** 2026-08-07
**Depth:** deep (cross-file, end-to-end data-flow)
**Files Reviewed:** 18 source files + the 69-06 eval gate + 9 test files (coverage assessment only)
**Status:** issues_found

## Summary

This review treats `turn-capture-cli` cwd → `ambientRecall` → `retrieveRanked` → `renderAmbientBlock`
(plus `recense recall --evidence`) as one surface and looks only for interactions between the
phase-69 changes and pre-existing consumers. Phase 69's own per-phase review (all 2 Critical +
6 Warning fixed on `main`) is treated as settled; nothing already fixed there is re-reported.

Findings are concentrated in one place: **the knobs that ship ON were gated by an eval harness whose
arms do not include the shipped configuration**, and the one shipped-ON rendering path that the gate
cannot observe (a doc-type row rendered with `ambientDocLinkRenderEnabled` dark) produces a malformed
block against real live-graph data. Every claim below was checked against the live graph at
`~/.config/recense/recense.db` (read-only queries) rather than reasoned about abstractly.

**Verified safe (checked hop-by-hop, no finding):**

- **No leak into the SessionStart bulk path.** `session-start-cli` calls `retrieveCueless(cwd)`,
  which reads none of the phase-69 knobs, never touches `node_scope`, and is wired to a
  `NoopActivationTraceSink` (so `traceEnabled === false` and the hop pass never runs). It does not
  import `ambient-recall`. D-97 holds.
- **No leak into the responder or `memory_search`.** `HybridResponder` (`responder/index.ts:194`)
  calls `retrieveRanked` with four args and no `opts`, so `anchoredIds`/`hopCollector`/`vizFloor` are
  all absent: the anchored-union sort is skipped by the `anchoredRows.length > 0` guard, `emitSeeds`
  falls back to `finalResults`, and `seedsForHopPass` is exactly `emitSeeds`. `memory-ops.search`
  does not use `retrieveRanked` at all (it calls `topk` directly).
- **Viz trace payloads are unchanged by live hop injection.** On the ambient path `hits` is
  `topk(vec, AMBIENT_K=5)`, so `vizSeedIds`' `cap = max(k, 6)` never binds and `emitSeeds` is a
  superset of `finalResults`. `seedsForHopPass` therefore equals `emitSeeds` today (anchoring dark),
  and the sink's `src ∈ emitSeeds` filter reproduces the pre-phase hop array in the same order.
  `projectHopsForSink` still strips the additive `rel` key at both engine emit sites and at
  `viz/server.ts:862`. The live `activation_trace` ring confirms the emitted shape is unchanged.
- **`recall --evidence` does not depend on anchoring.** `RecallEngine` shares no code with
  `entity-anchor`; the dark knob is invisible to it. The zero-write/zero-generate locks hold on every
  branch: the typed short-circuit (`recall/index.ts:273`) precedes `provider.generate` at 336, the
  insight branch is disabled by `&& !evidenceMode` (431), the neighborhood short-circuit (651)
  precedes both the trace emit (677) and the compose/append (713/730), and all five null-resolution
  exits return the evidence-shaped safe-null.
- **CR-02's honest-attribution fix is parity-correct.** `typedReach` follows `getOutEdgesWithRel`
  out-edges only (`typed-traversal.ts:68`), and the evidence re-derivation scans the same direction
  with an equivalent filter (`rel === matchedPredicate` implies `PRED_SET.has(rel)`), so the citation
  scan cannot systematically miss edges the traversal used.
- **Reserved-slot selection is self-correcting in the abundant-candidate case.** Pass 3
  (`ambient-recall.ts:411-415`) refills to `AMBIENT_K`, so an anchored fact that also earns a top-k
  rank never costs the block a slot. (The scarce-candidate case does not hold — WR-04.)
- **Hop labels can never be a doc body.** Zero live `kind='relation'` edges point at a `type='doc'`
  node (0 of 18,361), so the doc-body rendering problem in CR-01 reaches the block through fact lines
  only, not hop lines.
- **cwd derivation is consistent across hops.** `turn-capture-cli` threads the same `cwd` string into
  both `recordEvent` and `ambientRecall`, and both the episode→`node_scope` stamp and the ambient
  `currentScope` go through `cwdToScope`, so nested project dirs (`/Users/vtx/VTX/vtx-main-repo` →
  `vtx`) and case differences (`/Users/vtx/VTX` → `vtx`) agree on both sides. Missing/absent `cwd`
  degrades to `''` → `GLOBAL_SCOPE` without throwing.

## Critical Issues

### CR-01: A doc-type (or any multi-line) row shatters the ambient block grammar on the shipped default path, and the eval gate is structurally blind to it

**File:** `src/adapter/ambient-recall.ts:185-193` (render branch), `242-247` (`deriveDocTitle`, unreachable while the knob is dark), `461`; `src/lib/config.ts:1100`; `scripts/eval/recall-audit-gate.cjs:184-227`

**Issue:** With `ambientDocLinkRenderEnabled: false` (the shipped default), the renderer's else-branch
emits the node's raw value:

```ts
const value = row.value.slice(0, valueCap);
factLine = `- ${marker}${value} (${row.origin}, score ${row.score.toFixed(2)}${anchoredSuffix})`;
```

Nothing strips newlines. Doc-node values are full markdown bodies, and on the live graph **159 of the
159 embedded doc nodes contain a newline within the first 200 characters** (plus 17 fact nodes). A
single surfacing doc row therefore renders as six lines, not one:

```
Recalled from recense (ambient):
- [vtx] # Claude Code Variants — Schema Deep-Dive

## Thesis

Claude Code is not a monolithic tool but a surface with meaningful internal variants across runtime mode, configuration state, subscription  (inferred, score 0.51)
```

Docs are genuinely reachable on this path: `topk` scores every row with `embedding IS NOT NULL`
(`topk.ts:339`), and 159/161 live doc nodes carry an embedding — `doc-writer.ts`'s "embedding stays
NULL permanently" comment no longer describes the live graph. The block's own contract ("AMBIENT_K
lines", the `- value (origin, score)` grammar every consumer parses) is broken, and the dangling
`(inferred, score 0.51)` lands on an unrelated body line.

The guard cannot see this. `parseBlock` matches `FACT_RE` (`recall-audit-gate.cjs:184`), whose anchor
requires `^- ` **and** a trailing `(origin, score X.XX)`; a shattered doc row matches on no line at
all, and line 202 says `if (!m) continue; // defensively skip any unparseable line`. So the row
contributes **zero** to `charCount` and **zero** to `parsedRows.length` — G4's budget/line-count check
and G3's foreign-doc check both silently ignore it, and it is indistinguishable from "no doc
surfaced." The fix already exists (`deriveDocTitle` splits on the first non-empty line) but is gated
behind `ambientDocLinkRenderEnabled`, which stays dark precisely because the gate never observed a
doc row.

The test suite pins the broken output as correct: `tests/ambient-recall.test.ts:623-630` ("s. doc row
renders as pre-phase truncated body when docLinks:false") feeds a value containing `\n\n` and asserts
only `toContain('# Deep Dive Title')`, and test `n`'s line-count assertion filters with
`.filter(l => l.startsWith('- '))`, which discards exactly the continuation lines that expose the
defect.

**Fix:** Collapse newlines in every data-driven segment before it enters a line, independent of the
doc-link knob — this is a rendering invariant, not a feature:

```ts
const flatten = (s: string): string => s.replace(/\s*\n+\s*/g, ' ');
// fact branch
const value = flatten(row.value).slice(0, valueCap);
// hop branch (12 live fact nodes have a newline inside the first HOP_LABEL_CHARS)
const label = flatten(hop.label).slice(0, HOP_LABEL_CHARS);
```

`flatten` keeps the byte-identity pins intact (no existing fixture value contains a newline: test `m`,
`f`, and `f2` all use single-line values), and it makes `deriveDocTitle`'s own first-line extraction a
strict refinement rather than the only newline-safe path. Additionally, make the gate fail loudly
instead of skipping: count unparseable non-header lines and treat any non-zero count as a G4
violation, so "the renderer emitted something the grammar does not describe" can never read as a pass.

## Warnings

### WR-01: No gate arm matches the shipped knob configuration — the three ON knobs were gated in an arm that also had the two dark knobs ON

**File:** `scripts/eval/recall-audit-gate.cjs:186-201`; `src/lib/config.ts:1024`, `1054`, `1064`, `1100`, `1110`

**Issue:** The gate has exactly two hard-coded arms:

```js
const DARK_KNOBS = { entityAnchoringEnabled: false, sameProjectRankNudge: 0, foreignDocDemotion: 0,
                     ambientDocLinkRenderEnabled: false, ambientHopInjectionEnabled: false };
const LIT_KNOBS  = { entityAnchoringEnabled: true,  sameProjectRankNudge: NUDGE, foreignDocDemotion: DEMOTE,
                     ambientDocLinkRenderEnabled: true,  ambientHopInjectionEnabled: true };
const knobs = IS_BASELINE ? DARK_KNOBS : LIT_KNOBS;
```

The shipped configuration is a third combination (anchoring OFF, doc-links OFF, nudge 0.05, demote
0.10, hops ON) that neither arm reproduces. Yet `config.ts:1055-1066` and `1111-1115` attribute
per-knob "G1/G2/G3/G4 all pass" verdicts to the run, and `1110`'s annotation is what justified
flipping `ambientHopInjectionEnabled` to `true`. Two of those attributions do not survive the arm
difference:

- G4's budget/line-count evidence for hop injection was collected with `ambientDocLinkRenderEnabled:
  true`, i.e. the one arm where a doc row renders as a single parseable line. It says nothing about
  the shipped arm, which is exactly where CR-01 lives.
- G3's "vacuous — zero foreign docs surfaced" is only establishable in the lit arm (`is_doc` is
  derived from the `(doc, score …)` suffix, which only the doc-link renderer emits). In the shipped
  arm a foreign doc is unobservable rather than absent.

This is the guard-set/ship-set drift class: the guard measures a configuration nobody runs.

**Fix:** Replace the boolean literals with a per-knob override so the shipped set is replayable, and
run the ship-set as its own arm before any future re-gate:

```js
const flag = (k, d) => process.argv.includes(`--${k}`) ? true
  : process.argv.includes(`--no-${k}`) ? false : d;
const knobs = IS_BASELINE ? DARK_KNOBS : {
  entityAnchoringEnabled:      flag('anchor',   true),
  ambientDocLinkRenderEnabled: flag('doclinks', true),
  ambientHopInjectionEnabled:  flag('hops',     true),
  sameProjectRankNudge: NUDGE, foreignDocDemotion: DEMOTE,
};
```

and record in each knob's annotation which arm produced its verdict.

### WR-02: `foreignDocDemotion` fires with an unknown caller scope on ~45% of live turns — a branch the gate never replays

**File:** `src/adapter/ambient-recall.ts:374-386`; `src/lib/scope.ts:43-58`; `scripts/eval/recall-audit-gate.cjs:314`

**Issue:** `isForeignDoc` deliberately ignores whether the caller's own scope is known:

```ts
const scope = scopes.get(id) ?? GLOBAL_SCOPE;
return scope !== currentScope && scope !== GLOBAL_SCOPE;
```

so when `currentScope === GLOBAL_SCOPE` every project-scoped doc is demoted by 0.10 while
`sameProjectRankNudge` is simultaneously disabled by the `currentScope !== GLOBAL_SCOPE` guard one
line below. The code comment justifies this with `"foreign" is well-defined independent of whether
the CALLER's own scope is known` — but "foreign" is a relation *to the caller*, so with an unknown
caller this is a guess, not a definition, and it is the only asymmetric half of a pair that was gated
as a pair.

On the live graph this branch is not an edge case. Of 3,371 `role='user'` episodes in the last 30
days, 1,037 (~31%) have a cwd outside any `/Users/<user>/<project>` root — the single most common cwd
is `/private/var/folders/…/T` (1,036 turns, each its own session id, i.e. short-lived/headless runs)
— and a further 514 are `/Users/vtx/resume`, which `PERSONAL_SLUGS` maps to `global`. That is ~45% of
user turns running with `currentScope === 'global'`.

The gate never exercises it: `recall-audit-gate.cjs:314` synthesizes
`const cwd = '/Users/evaluser/' + String(row.project).toLowerCase()`, which always resolves to a valid
project slug. So the demotion's dominant real-world branch has zero eval coverage, and no test covers
it either (`tests/ambient-recall.test.ts` case k passes `/Users/tester/projA`).

**Fix:** Gate the demotion on a known caller the same way the boost is gated, so an unknown origin is
neutral rather than opinionated:

```ts
const foreignDemotion =
  currentScope !== GLOBAL_SCOPE && isForeignDoc(r.id) ? config.foreignDocDemotion : 0;
```

If the current asymmetry is intended, add a gate row that replays with `cwd = ''` and record the
measured effect, plus a regression test pinning the unknown-cwd behavior explicitly.

### WR-03: Shipped-ON hop injection bypasses every scope and dedup control on the same block

**File:** `src/adapter/ambient-recall.ts:426-437`, `199-215`

**Issue:** The hop pass keeps a hop iff its `src` is a selected row and its neighbour is live:

```ts
if (!selectedIds.has(hop.src)) continue;
...
const neighbour = getCachedNode(hop.node_id);
if (!neighbour || neighbour.tombstoned === 1) continue;
list.push({ rel: hop.rel, label: neighbour.value.slice(0, HOP_LABEL_CHARS) });
```

The neighbour is never checked against `scopes`, never against `AMBIENT_FLOOR`, and never against
`selectedIds`. Three consequences on the shipped path:

1. **Scope bypass.** Content from another project enters the injected block through a hop line even
   though `sameProjectRankNudge`/`foreignDocDemotion` — shipped ON in the same phase to bias the block
   toward the caller's project — only ever reorder the five fact lines. The two mechanisms disagree
   about whether cross-project content should be discouraged.
2. **Duplicate content.** Nothing prevents `hop.node_id` from being another selected row: both are
   top-5 cosine hits for the same query, and 10,706 live `kind='relation'` edges point at fact nodes.
   When that happens the same value is rendered twice (once as a fact line, once as a hop) and pays
   twice against `AMBIENT_BLOCK_CHAR_BUDGET`.
3. **Relevance bypass.** A hop neighbour is injected with no similarity bar at all, in a block whose
   central design argument (`AMBIENT_FLOOR`'s docstring) is "ambient injection is unsolicited, so
   precision beats recall here."

`tests/ambient-recall.test.ts:459-494` covers only the happy path and the tombstoned-neighbour drop;
no test seeds a cross-scope or already-selected neighbour.

**Fix:** Apply the block's existing disciplines to hop neighbours before the slot is consumed, mirroring
the liveness check that is already there:

```ts
if (selectedIds.has(hop.node_id)) continue;                      // never duplicate a fact line
const nScope = scopes.get(hop.node_id) ?? GLOBAL_SCOPE;          // needs hop ids in the batch read
if (currentScope !== GLOBAL_SCOPE && nScope !== GLOBAL_SCOPE && nScope !== currentScope) continue;
```

This requires widening the `store.getNodeScopes(...)` batch at line 351 to include the collected hop
target ids (still one query). Hop lines are enrichment by D-06, so dropping one is always safe.

### WR-04: `ANCHOR_RESERVED_SLOTS` does not cap anchored lines when cosine candidates are scarce

**File:** `src/adapter/ambient-recall.ts:396-415`

**Issue:** The cap's stated contract (line 88-95) is that at most two of `AMBIENT_K` slots may be
occupied by facts forced in purely because they were anchored. The implementation fills the
"non-reserved" slots from `ranked`, which already contains the anchored rows:

```ts
const nonReservedSlots = AMBIENT_K - reserved;
for (const r of ranked) {                       // ← ranked includes anchored rows
  if (selectedIds.size >= nonReservedSlots) break;
  selectedIds.add(r.id);
}
for (const r of ranked) {                       // reserved pass: adds up to AMBIENT_K
  if (selectedIds.size >= AMBIENT_K) break;
  if (!anchoredById.has(r.id) || selectedIds.has(r.id)) continue;
  selectedIds.add(r.id);
}
```

When the prompt yields fewer than `nonReservedSlots` genuine cosine hits the cap silently fails.
Concretely with 2 cosine hits and 6 anchored facts: `anchoredPresentCount = 6` → `reserved = 2` →
`nonReservedSlots = 3`; pass 1 takes 2 cosine rows **plus 1 anchored row**, pass 2 forces 2 more
anchored rows, and the block ships 3 floor-exempt anchored lines. In the degenerate zero-cosine-hit
case all five lines are floor-exempt anchored facts — precisely the "crowd out the whole block with
unsolicited lines" outcome the constant's own docstring says it prevents.

`tests/ambient-recall.test.ts:354-366` (case h) cannot catch this: `seedReservedSlotsGraph` seeds five
cosine hits at cosine 1.0, so pass 1 is always saturated by non-anchored rows.

This is latent today (`entityAnchoringEnabled: false`) but it is load-bearing for the open
entityAnchoring re-gate — a re-gate run would measure a precision guard that is not actually enforced.

**Fix:** Fill the general slots from non-anchored rows only, then let the reserved passes add anchored
rows; pass 3 already backfills any shortfall:

```ts
for (const r of ranked) {
  if (selectedIds.size >= nonReservedSlots) break;
  if (anchoredById.has(r.id) && r.score < AMBIENT_FLOOR) continue; // floor-exempt rows use reserved slots
  selectedIds.add(r.id);
}
```

Add a regression test with fewer cosine hits than `AMBIENT_K - ANCHOR_RESERVED_SLOTS`.

## Info

### IN-01: Anchored rows never light the viz, so the trace under-reports what a turn injected

**File:** `src/retrieval/engine.ts:536-552`, `623-625`

**Issue:** `vizSeedIds` is built exclusively from `hits` (the cosine scan). Anchored rows arrive from
`opts.anchoredIds` and are never added, so with `vizFloor` set — always, on the ambient path
(`ambient-recall.ts:336`) — `emitSeeds` omits every anchored row. When the knob goes live the viz will
light a turn's below-floor cosine seeds while omitting the facts that were actually injected, against
the trace's stated framing ("the brain lights the nodes a turn genuinely retrieved"). Deliberate under
D-09 byte-identity, but worth re-deciding at the re-gate rather than inheriting silently.

**Fix:** At the re-gate, either union anchored ids into `vizSeedIds` (accepting the sink-payload delta
as an intended phase-69 change) or state in the `vizFloor` docstring that the lit set is
cosine-derived only.

### IN-02: Schema-chapter docs carry a UUID `node_scope`, so they are permanently "foreign" and would render a 39-char marker

**File:** `src/lib/scope.ts:87-91`; `src/consolidation/doc-writer.ts:192`; `src/adapter/ambient-recall.ts:177`

**Issue:** `rootScope(slug)` returns the slug unchanged when it has no `':'`, and schema-chapter docs
use a UUID slug — the live graph has ~80 doc nodes whose `node_scope` is a bare UUID. Every such doc
is `scope !== currentScope && scope !== GLOBAL_SCOPE` for every caller, so it takes the full 0.10
demotion permanently, and if one surfaces the renderer emits
`[0bdd1391-8f33-44be-8409-4a64a65df29c] ` as a "project" marker — 39 characters of the 200-char line
budget spent on a UUID.

**Fix:** Stamp schema-chapter docs `GLOBAL_SCOPE` (they belong to no project), or suppress the marker
when the scope does not look like a project slug.

### IN-03: Evidence mode returns `path:'none'` where prose mode would fall through to the neighborhood traversal

**File:** `src/recall/index.ts:297-299`

**Issue:** `if (edges.length === 0) return NULL_EVIDENCE_RESULT;` exits the whole `recall` call. In
prose mode the equivalent dead end (typed compose fails) falls through to the schema-neighborhood
assembly, which is itself a real, citable traversal. So a caller can get `path:'none'` for a query
that prose mode answers, and the safe-null is not distinguishable from "nothing resolved."

**Fix:** Fall through to the neighborhood assembly instead of returning, so evidence mode explores the
same branch order as prose mode:
`if (edges.length === 0) { /* fall through to neighborhood */ } else { ...return typed... }`.

### IN-04: Hop budget check admits a zero-length label at an exactly-full budget

**File:** `src/adapter/ambient-recall.ts:206-208`

**Issue:** `if (runningChars + label.length > AMBIENT_BLOCK_CHAR_BUDGET)` uses a strict `>`, so when
facts have spent the budget exactly and the neighbour's value is empty the hop is appended and renders
as `  ↳ <rel> ` with a trailing space and no content. Two live nodes have an empty value, so the label
is not hypothetical.

**Fix:** Skip empty labels before the budget test: `if (label.length === 0) continue;`.

---

## Fix Log (2026-08-07)

All Critical + Warning findings fixed on `main`; the four Info findings remain OPEN as advisories
(deferred deliberately, not fixed).

- **CR-01** — fixed in `c89e343`. `flatten` helper collapses newline runs to a single space in the
  fact-line raw-value branch and the hop label (rendering invariant, knob-independent);
  `deriveDocTitle` unchanged (already first-line-safe). Tests `s`/`n` tightened to full-line/all-line
  assertions; new regression test `s2` pins a newline-bearing value to exactly one `- ` line.
  `recall-audit-gate.cjs` now counts non-header lines matching neither FACT_RE nor HOP_RE as
  `unparseable_line_count` (per-row + distribution) and treats any nonzero count as a G4 violation.
- **WR-01** — fixed in `2c6c7f7`. Gate gained `--no-doclinks`/`--no-hops` (extending the existing
  `--no-anchor` pattern) so the shipped arm is replayable; header documents that per-knob verdicts
  must name their arm. Ship-arm replay executed against the live DB (see the dated annotation at
  `ambientHopInjectionEnabled` in `src/lib/config.ts`): G1 PASS, G3 PASS, G4 PASS
  (unparseable_line_count 0), G2 53/54 — the single miss is a demonstrated AMBIENT_FLOOR
  boundary/embed-nondeterminism artifact that flips within the dark arm itself, not a knob effect.
- **WR-02** — fixed in `77dd16f`. `foreignDocDemotion` now gated on
  `currentScope !== GLOBAL_SCOPE`, symmetric with the nudge guard; unknown-origin turns are neutral.
  Regression test `k2` pins cwd=`''` → pure cosine order, no demotion.
- **WR-03** — fixed in `26c897f`. Hop neighbours now skip already-selected rows (never a duplicate
  line) and foreign-scope neighbours are dropped for a known-scope caller (neutral for a global
  caller, consistent with WR-02); `getNodeScopes` batch widened to include hop target ids (still one
  query). Two new tests cover cross-scope drop/keep and dedup.
- **WR-04** — fixed in `a5dd60e`. Floor-exempt anchored rows enter selection only through the
  reserved pass, which now counts its own additions (cap = `reserved`); general fill and backfill
  both skip floor-exempt rows, so a scarce-cosine block renders fewer lines rather than more
  unsolicited anchored ones. Regression test `h2` (1 cosine hit + 4 floor-exempt anchored → 3 lines,
  at most 2 anchored); existing case `h` unchanged and green.
- **IN-01..IN-04** — OPEN advisories: viz under-reporting of anchored rows (re-decide at the
  entityAnchoring re-gate), UUID-scoped schema-chapter docs, evidence-mode `path:'none'` early exit,
  zero-length hop label at exact budget.

Verification: full `npx vitest run` (241 files passed, 1 skipped) + `npx tsc --noEmit` clean.
Hard locks re-run explicitly: dark-knob byte-identity (`ambient-recall` f2/s/t), online-llm-free
sentinel, resolution sentinels, pe-machinery-lock, telegram hash-lock, proposal write-isolation.

_Reviewed: 2026-08-07_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep — cross-phase, ambient retrieval path_
_Fixed: 2026-08-07 — CR-01, WR-01..WR-04; Info findings left open_
