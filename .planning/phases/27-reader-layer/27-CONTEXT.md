# Phase 27: Reader Layer - Context

**Gathered:** 2026-06-18
**Status:** Ready for planning

<domain>
## Phase Boundary

Promote the **validated reader slice** (`scripts/reader-slice/` — the Tonos doc, 19/19 citations resolve, 0 invented) into a real product feature. Deliver:
- **READER-01** doc-as-node generation (`type='doc'`, lifecycle-exempt) with inline `recense://fact/<id>` refs that resolve to live nodes;
- **READER-02** a `/doc` route + Reader/Brain toggle (one system, two altitudes);
- **READER-03** citation staleness detection + `prev_value → value` diff + regenerate;
- **READER-04** a navigable doc→doc corpus graph that subsumes the per-project view.

End goal: retire Obsidian as the authoring layer. This phase **promotes** the proven slice — it does not rebuild it. New capabilities (editing, scheduled regen, section-level regen) are out of scope (tracked as v2 / deferred).

</domain>

<decisions>
## Implementation Decisions

### Fact gather (feeds doc generation)
- **D-01:** Gather = `node_scope.scope = '<slug>'` (primary, project-attributed) **∪ Phase-26 semantic gather** (embed the project query + `hybridTopk` for breadth beyond facts that literally name the project). **Drop** the slice's lexical-only `LIKE` gather — the entity-linked hop may still augment, but scope + semantic is the spine. Rationale: completeness is the "retire the vault deep-dive" bet; lexical-only skews to literal name matches.

### Generation lifecycle / trigger (lazy, cache-backed)
- **D-02:** **Lazy generate-on-first-access.** First view of a project with no doc node → auto-generate → cache as the `type='doc'` node. Every later view serves the **cached doc instantly, LLM-free** (no compute on plain re-reads). Stale views serve the cached doc instantly + surface the regenerate affordance (see D-08). Net: model compute happens only on first-gen and explicit regen — never on a normal open. This is the "in-between" model (not pure-manual, not auto-on-scope-change), and it folds the regen path into READER-03 machinery we build anyway.
- **D-03:** **First-view UX = auto-generate with an honest loading/progress bar, single path.** No model-speed-detection branching: a fast env model shows the bar briefly, a slow local model shows it longer. (Chosen over an explicit "Generate" button to keep it feeling alive and avoid a UX lever; revisit only if a slow local model makes the wait intolerable.)

### Generation model & cost
- **D-04:** Doc generation routes through the **existing configured (judge-tier) model provider from env — NO new `docModel`/`genModel` config var.** Rationale (founder): fewer levers for self-hosters; the judge slot is already the strong-tier model in any env. The judge model var is the single source of truth for "the strong model."
- **D-05:** **Prose-quality caveat (for research/planner):** the slice proved *Sonnet* prose specifically. The configured judge model is validated for JSON verdicts, not long-form prose. If the env judge is a local 35b or a `/no_think`-style judge, **spot-check generated prose quality** against the validated Tonos doc before trusting it for the "reads as well as the vault deep-dive" bet. Do not add a var to fix this — surface it as a quality gate.
- **D-06:** Cost posture: doc gen is **offline + low-volume** (lazy → ~one gen per project actually opened, ~6–10 projects, plus occasional regen), so cost is pennies even on a paid judge model. Still honor the budget discipline — quote $ before any batch/bulk regen.

### Reader entry & navigation
- **D-07:** **Brain stays home on open** (the brain viz is a flagship strength — keep it visible). The **doc→doc corpus graph is a secondary view**, reached via an **explicit view-swap button, in the expanded viz ONLY — never in the tray/popover** (glance-only; corpus graph would clutter it — consistent with the existing "rich affordances live in the full Brain Window" rule).
- **D-08:** **Reader opened from BOTH entry points:** (a) click a project entity in the brain → "open doc" → reader (fast path while in the flagship view); (b) swap to the corpus graph → click a doc node → reader (browse-all-docs path). The existing Reader/Brain toggle (slice) then drops between prose and that doc's cited atoms.
- **D-09:** READER-04 "centering on a project" = the corpus graph centered on that project's node, surfacing its docs alongside neighboring projects/entities. This **is** the per-project view (subsumes a dedicated single-project graph).

### Staleness surfacing UX (READER-03)
- **D-10:** **Banner + inline markers.** Top-of-doc banner summarizes and holds the regenerate CTA ("N cited facts changed since this was written — regenerate"). Inline: changed refs get a subtle highlight; tombstoned refs show a "cited fact was removed" marker. Clicking a stale ref opens the `prev_value → value` diff in the existing atom panel (no new panel). Whole-doc regen only (section-level regen = v2 / READER-05).

### Claude's Discretion (route to research/planner — not founder decisions)
- **v11 schema migration:** extend `node.type` CHECK to include `'doc'` and `edge.kind` CHECK to include `'cites'` and `'doc_link'` (current DDL excludes all three — `src/db/schema.ts:41,63`). Required before doc-as-node lands.
- **Doc write path:** route doc writes through the single-writer consolidator (`src/consolidation/consolidator.ts`) or a guarded sibling path that skips lifecycle phases A/C (no recall-embed, eviction, decay, `training_eligible`, claim-extraction). The lifecycle-exemption is mandatory (READER-01); the exact wiring is the planner's call.
- **`generatedAt` storage:** prefer a **dedicated `generated_at` column** over reusing the doc node's `last_access` — the doc node's own `last_access` can advance and would corrupt the `node.last_access > doc.generatedAt` staleness predicate (SPEC §8.3). Planner confirms.
- **Graph focus mechanism (READER-02 toggle):** extend `GET /graph?nodeIds=id1,id2,…` server-side filter vs. client-side filter on the full `/graph` response using the existing `lod.js` visibility-predicate pattern. Pick per implementation cost; the slice used the lighter client-side approach.
- **`doc_link` edge creation:** derived from `recense://doc/<id>` refs the generator emits in prose (SPEC §3). Generator rules govern which docs get linked.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Reader design contract (READ FIRST)
- `.planning/reader-layer-SPEC.md` — the validated-slice design contract. Data model (doc-as-node, `cites`/`doc_link` edges), the three new pieces (generate / render / toggle), update-in-place mechanics, pass/fail criteria, and §8 open decisions (this CONTEXT resolves several of them). **Not a gsd `*-SPEC.md` lock file — but it is the authoritative spec for this phase.**

### The validated slice (promote, don't rebuild)
- `scripts/reader-slice/gather.ts` — slice gather (lexical ∪ entity 1-hop). Product replaces lexical-only with scope + semantic (D-01); entity hop may remain.
- `scripts/reader-slice/generate.ts` — slice generation + citation-verify (inverts the extraction path; `provider.generate`). The generation prompt and the citation-resolution verify loop are the reusable core.
- `scripts/reader-slice/verify-slice.ts` — citation integrity check (every cited id resolves to a live, non-tombstoned fact).
- `scripts/reader-slice/out/tonos.md` — the validated reference doc (19/19 resolve). Use as the prose-quality baseline for D-05's spot-check.
- `src/viz/modules/reader.js` (untracked) — slice reader module: `renderMarkdown` (pure, unit-testable), `FACT_LINK`/`DOC_LINK` interception, fact-ref → atom wiring.
- `src/viz/server.ts` — slice `/doc?term=` route (read-only, traversal-guarded). Product moves doc source from a file to the `type='doc'` node.

### Engine seams (grounded in live source — re-verify, source moves)
- `src/db/schema.ts:41` — `node.type` CHECK (`entity`/`fact`/`schema`; **needs `doc`**); `:63` — `edge.kind` CHECK (`relation`/`abstracts`/`schema_rel`; **needs `cites`/`doc_link`**); `node_scope` table (`:140`).
- `src/lib/types.ts:33` — `NodeRow` (fact schema: `last_access`, `prev_value`/`prev_ts`, `tombstoned`).
- `src/consolidation/consolidator.ts` — single DB writer; doc writes route here.
- `src/db/semantic-store.ts:192` — in-place update / `prev_value`/`prev_ts` mechanics (staleness diff source).
- `src/model/provider.ts:36` — `ModelProvider.generate`; judge-tier model config is the env source for D-04.
- `src/model/claim-extractor.ts:399` — extraction pattern the generator inverts.

### Viz seams
- `src/viz/modules/detail.js:42` — node-detail panel (reuse as the atom panel + `prev_value → value` diff host for D-10).
- `src/viz/modules/lod.js` — client-side visibility-predicate pattern (candidate for the toggle's graph focus).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **Whole slice (`scripts/reader-slice/` + `src/viz/modules/reader.js`):** gather → generate → verify → render → fact-ref-to-atom wiring already work end-to-end. This phase productizes these throwaway pieces, not greenfield.
- **Atom panel (`detail.js` `selectNode`):** reused for fact-ref clicks and the staleness diff (D-10) — no new panel.
- **`node_scope` + semantic retrieval (`hybridTopk`):** already live (Phases 24/26) — the gather spine (D-01) composes existing capabilities.
- **In-place update + `prev_value`/`prev_ts`/`last_access`/`tombstoned`:** the staleness substrate (READER-03 / D-10) already exists on every node; no new tracking needed.

### Established Patterns
- **Single-writer consolidator** is the only legal DB writer — doc writes must route through it (engine invariant).
- **Lifecycle exemption** must be explicit: doc nodes skip recall-embed, eviction, decay, `training_eligible`, and claim-extraction (READER-01).
- **Tray = glance-only; rich affordances = expanded Brain Window** — governs D-07 (corpus graph expanded-only).
- **Viz density anchor (~3,500 nodes) + `lod.js` adaptive density** — do not re-tune absolute node sizes; adapt focus around the anchor.

### Integration Points
- `src/viz/server.ts` `/doc` (slice) → product `/doc` backed by the `type='doc'` node; new model-backed generate/regenerate endpoint (needs env model creds, like the sleep-pass).
- `GET /graph` → optional `?nodeIds=` filter for toggle focus (or client-side).
- Corpus graph = `type='doc'` nodes + `doc_link` edges rendered in the existing viz, behind the expanded-only swap button.

</code_context>

<specifics>
## Specific Ideas

- The hero interaction is non-negotiable: prose → click cited claim → correct atom selected → toggle → brain focused on that doc's atoms → toggle back. Must feel like "one system at two altitudes," not switching apps (SPEC §2).
- "Brain viz is one of the strongest things about this project" (founder) — it stays the home view; the doc layer is the new top altitude, not a replacement.
- Prose bar: a generated doc must read **as well as the hand-written vault deep-dive** (side-by-side against `out/tonos.md`).

</specifics>

<deferred>
## Deferred Ideas

- **Section-level regeneration** (vs whole-doc) — READER-05, v2.
- **Scheduled/auto regen** when a cited fact's `last_access` advances (reverse `cites`-edge dirty-marking) — READER-06, v2. (This phase does staleness *detection* + manual regen only.)
- **Soft current-cwd recall relevance boost** — SCOPE-05, v2.
- **`viz-search-and-hull-quality` todo** (in-app node search + topic-region highlighting) — reviewed, NOT folded. Adjacent to reader navigation but a distinct viz feature; belongs in its own viz phase.
- **`content-hardening-deferred` todo** (transcript speaker attribution, Obsidian PDF extraction) — reviewed, NOT folded. Ingestion/extraction hardening, unrelated to the reader layer.

</deferred>

---

*Phase: 27-reader-layer*
*Context gathered: 2026-06-18*
