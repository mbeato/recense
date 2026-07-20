# Phase 28: Schema-Anchored Corpus - Context

**Gathered:** 2026-06-19
**Status:** Ready for planning

<domain>
## Phase Boundary

Pivot the reader corpus from project-scope docs to the **abstraction graph rendered as prose**: a `type='doc'` node can anchor on a **schema** (its generalization is the thesis) and cite the schema's abstracted facts/entities as evidence. An LLM-free mass gate selects doc-worthy schemas; a newly *enriched* schema→schema ladder drives hierarchical (parent→child) nesting; corpus edges become containment + reference over the abstraction graph, rendered in the existing flat 2D `force-graph`. Scope/project docs remain as the degenerate anchor. The Phase-27 reader, render, gather, `doc-writer`, lazy-gen, and `/doc*` routes are reused, not rebuilt.

</domain>

<spec_lock>
## Requirements (locked via SPEC.md)

**5 requirements are locked.** See `28-SPEC.md` for full requirements, boundaries, and acceptance criteria.

Downstream agents MUST read `28-SPEC.md` before planning or implementing. Requirements are not duplicated here.

**In scope (from SPEC.md):**
- Schema-anchored doc generation (schema = thesis, abstracts-neighborhood entities/facts = evidence)
- Scope-anchored project docs retained as the degenerate case
- Selective, LLM-free mass-gated promotion of doc-worthy schemas
- Schema→schema ladder *enrichment* + hierarchical (parent→child) schema-doc nesting
- Containment + reference corpus edges; rendering the schema corpus in the existing flat 2D `force-graph`; node→doc in-place open
- Preserving the read-only / self-confirmation guard under schema-anchoring
- Decide-cheap / generate-lazy posture (eager candidate + node + parent stub-link; prose generated on first access via existing lazy-gen)

**Out of scope (from SPEC.md):**
- Entity-anchored docs (deferred — schema + scope anchors only in v1)
- Section-level / partial regen (whole-doc regen only, inherited from Phase 27)
- Changes to the reader UI, Reader/Brain toggle, staleness, or the 3D brain (inherited as-is)
- The generation prompt/model, embedder, and judge selection (reuse Phase 27 paths)
- Any new external/npm dependency (reuse vendored `force-graph`; net-zero deps)
- Multi-tenant / cross-account corpus
- Pinning the exact schema→schema *derivation algorithm* — resolved by this CONTEXT (see D-01..D-04)

</spec_lock>

<decisions>
## Implementation Decisions

### Schema→schema ladder enrichment (Req 3)

> **⚠ REVISED 2026-06-19 after research (founder-directed).** The original D-01/D-02 — shared-evidence CONTAINMENT — was **falsified by the live brain**: every fact/entity belongs to exactly one schema (`schema-induction.ts:304` `alreadyInSchema` guard), so evidence sets are **strict disjoint partitions** and `|A.ev ∩ B.ev| = 0` for ALL schema pairs (confirmed by SQL on a WAL-safe canonical copy — see `28-RESEARCH.md` §D-01/D-02 and Pitfall 1). Shared-evidence containment yields **zero edges** and cannot be the spine. Per the founder decision (and CONTEXT's own Deferred-Ideas fallback), the **centroid-cosine signal is promoted from demoted-tie-breaker to the PRIMARY spine**. D-01 and D-02 below are superseded by D-01R/D-02R. D-03 (edges on doc nodes only), D-05 (hysteresis), D-06 (mass), D-07 (noise filter), D-08, D-09 are UNCHANGED.

- **D-01R (supersedes D-01): Primary enrichment signal = centroid-cosine similarity between schema member-centroids; direction from evidence mass.** Use the per-schema **member centroid** the `SchemaRelationDeriver` already computes (SREL-01, `schema-relations.ts:280–310`). Two schemas are *related* when their centroid cosine exceeds a reference threshold; the ladder is **enriched** by lowering/expanding the existing cosine derivation (live DB has only ~12 `schema_rel` at the current high threshold) so usable relations among promoted schemas **materially exceed the ~95 baseline** (Req-3 acceptance — planner sets the concrete target + threshold against the live brain). Cosine is **symmetric**, so parent/child **direction comes from evidence MASS** (D-06): of two cosine-connected schemas, the larger-mass (broader-evidence) schema is the parent. LLM-free, deterministic for a fixed snapshot.
  - *Rationale:* centroid-cosine is the verified SREL-01 mechanism (faithful); it is the only signal that can be *enriched* (containment is structurally 0). Mass supplies the directionality cosine lacks. Reuses centroids already computed in Phase C — no new embed calls.

- **D-02R (supersedes D-02): One pass derives BOTH corpus edge types from the cosine+mass signal.** For each promoted-schema pair above the cosine reference threshold:
  - **CONTAINMENT** (directed parent→child) when the pair is cosine-connected AND masses differ — parent = larger mass. Keep only the child's **single strongest parent** (highest-cosine qualifying parent) → a clean forest (legible nesting in the flat 2D graph). Guarantees the Req-3/D-08 "≥1 parent→child nest".
  - **REFERENCE** (undirected) for cosine-connected pairs not selected as a containment parent/child link (and for ties / equal-mass pairs). Also fold in the existing SREL-02 super-schema sibling pairs + remaining `schema_rel` pairs among promoted schemas as reference edges.
  - Apply a **min-evidence floor** (e.g. ≥4 members, D-06 mass) so tiny schemas aren't spuriously nested.
  - Thresholds (reference cosine, containment cosine, mass-gap minimum, floor) are starting points — planner sets concrete values and **validates against the live brain** that (a) usable relations among promoted schemas materially exceed ~95 and (b) the result is a legible forest, NOT a hairball (eyeball the first render; tighten the cosine threshold if over-connected).

- **D-03: Materialize derived relations ON THE DOC NODES ONLY (parent-doc → child-doc).** Derivation reads schema evidence **read-only**; the new containment + reference edges are written between the eager schema-DOC nodes, never incident to a source schema. This makes the Req-5 self-confirmation guard hold **by construction** — no snapshot-proof gymnastics, source schemas gain 0 edges and no s/c change. Each doc is 1:1 with its schema, so "schema→schema relations exceed the ~95 baseline" is satisfied via the doc-projected relations. Edges are a wipe-and-rebuildable derived cache (like the existing `schema_rel`).

- **D-04: Run as ONE idempotent function, packaged as a CLI command AND wired into the sleep pass for automatic refresh.** Sibling of the existing `recense generate-doc`. One transaction: mass gate → containment/reference derivation → eager doc-node stubs (via the lifecycle-exempt `doc-writer`) → wipe+rebuild doc-corpus edges. Prose stays **lazy** (generated on first open). The CLI entry comes free for manual/test runs; the **sleep-pass Phase C caller is the chosen production mode** (auto-refresh as the brain grows). Runs next to the existing `SchemaRelationDeriver`, which already computes the schema centroids/members the gather will reuse.

- **D-05: Hysteresis band prevents doc-node thrash.** Promote at `mass ≥ high` (e.g. 12), demote (tombstone the doc) only when `mass < low floor` (e.g. 8). A schema flickering in the 8–12 band keeps its doc node once earned. Two constants in the same SQL gate; deterministic; kills pass-to-pass flapping under the auto-refresh of D-04.

### Promotion gate metric + noise filter (Req 2)

- **D-06: mass = distinct evidence-member count.** `mass(schema) = COUNT(DISTINCT dst) FROM edge WHERE src=schema.id AND kind='abstracts' AND dst is a live fact|entity`. This is the **same evidence set** the containment derivation (D-01/D-02) builds, so the gate and the ladder share one computation. Deterministic, LLM-free, matches the SPEC's mass distribution (~24 at ≥12, ~50 at ≥8).

- **D-07: Dogfooding-noise filtered by a member-SHAPE token penalty (NOT scope-diversity).** Down-rank/exclude a schema when a high fraction of its abstracted members are **non-prose tokens** — regex on hex hashes (`^[0-9a-f]{7,}$`), file paths, bare identifiers, URLs, timestamps — and/or its induced label matches meta keywords (`path|identifier|hash|id|timestamp|url`). Targets the named offenders ("Output file paths", "Tool identifiers", "Git commit hashes") directly, with no per-schema hand-list, and runs in the same SQL/JS pass.
  - *Explicitly rejected:* **scope-diversity weighting** — the meta-noise schemas are *ubiquitous* across projects (every repo has commit hashes), so a "spans many scopes = important" signal would *boost* the noise, not suppress it. The discriminating property is that members are tokens, not that they're scope-bound.
  - *Bonus:* a token-dominated schema also generates poor prose, so this protects quality as well as relevance.
  - *Caveat for planner:* the regex set is heuristic and brittle to novel noise shapes — expect to tune patterns; eyeball the gate output on the live brain before trusting it.

### Corpus rendering (Req 4)

- **D-08: Distinct edge styling; scope-doc woven in via reference edges.** Containment edges drawn **solid/directed** (the hierarchy spine that makes nesting legible); reference edges drawn **faint/dashed/undirected**. A project/scope doc joins the graph through reference edges wherever its evidence overlaps schema-docs — it is **not** an orphaned island. Reuses `corpus.js` link-styling. Sub-threshold schemas stay **inline** (no node), per SPEC — the corpus shows only promoted schema-docs + the degenerate scope docs. Clicking any node opens that doc in-place (reuse 27-03/27-05).

### Gather re-anchoring (Req 1)

- **D-09: Evidence-set spine + centroid-seeded semantic breadth + re-rooted entity-hop.** Re-rooting `doc-gather.ts` from a scope-slug to a schema:
  - **Spine** = the schema's abstracts-evidence (its facts + entities directly) — replaces the `node_scope.scope=slug` source.
  - **Semantic breadth** = `hybridTopk` seeded by the schema's **member CENTROID** (the real semantic center of its evidence, already computable à la `SchemaRelationDeriver`) — NOT the schema's induced label. Labels are often short/fallback (`super:a + b + c`) → weak query vector; the centroid is faithful and needs no extra embed call.
  - **Entity-hop** re-rooted at the schema's own abstracted entities → 1-hop fact neighbors (replaces entity-name `LIKE slug`).
  - Faithful framing: schema = thesis, its abstracts-evidence = body, centroid = breadth.
  - Scope-anchored gather stays unchanged (degenerate path).

### Claude's Discretion (route to research/planner)

- Concrete threshold values (REVISED for the D-01R/D-02R cosine spine): **reference cosine threshold** + **containment cosine threshold** (the enrichment knob — lower than the current `schema_rel` threshold to exceed the ~95 baseline), **mass-gap minimum** for a containment parent/child split, min-evidence floor (~4 members), hysteresis high/low (research-grounded `HIGH=10 / LOW=7`), token-fraction cutoff (`NOISE_CAP=0.5`, research-validated). Set against the live brain so usable relations exceed ~95, the corpus is a legible forest (not a hairball), and the gate returns ~15–60 candidates (research: 17 clean at mass≥10).
- New edge `kind`s for doc-corpus edges (containment vs reference) — DDL/CHECK extension, mirroring how Phase 27 added `cites`/`doc_link`. Whether to reuse/retire `doc_link` (Req 4 supersedes the project-doc `doc_link` corpus).
- Corpus graph endpoint shape (extend `/graph?type=doc` to emit schema-doc nodes + containment+reference edges, drop the doc_link-between-projects dependency).
- CLI command name for D-04 (e.g. `recense promote-corpus`).
- The generation prompt adaptation for a schema thesis (reuse the Phase-27 judge-tier `doc-generator.ts`; prompt may need a "thesis = this generalization" framing) — spot-check prose quality per Phase-27 D-05.
- Sleep-pass wiring point in Phase C (relative to `SchemaRelationDeriver`).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase contract (READ FIRST)
- `.planning/phases/28-schema-anchored-corpus/28-SPEC.md` — locked requirements, boundaries, acceptance criteria, live-brain data shape (266 schemas, 1487 `abstracts`, schema→schema sparse ~95). **MUST read before planning.**
- `.planning/phases/27-reader-layer/27-CONTEXT.md` — the Phase-27 reader decisions (D-01..D-10) that this phase inherits and extends; reader/render/gather/doc-writer/lazy-gen contracts.
- `.planning/reader-layer-SPEC.md` — the validated-slice design contract referenced by Phase 27 (data model for doc-as-node, `cites`/`doc_link` edges, generate/render/toggle).

### The enrichment substrate (Req 3 — re-tune/extend, do not rebuild)
- `src/consolidation/schema-relations.ts` — `SchemaRelationDeriver` (Phase 18 SREL-01/02): centroid computation from abstracts-members, `schema_rel` derivation, agglomerative super-schema clustering. The centroid logic (D-09) and the offline derived-cache pattern (D-04) reuse this. Runs in sleep-pass Phase C.
- `src/consolidation/schema-induction.ts` — how schemas + `abstracts` edges are induced (the evidence sets D-01/D-06 count over).

### The reader/corpus substrate (reuse, re-anchor)
- `src/reader/doc-gather.ts` — current scope ∪ semantic ∪ entity-hop gather; D-09 re-roots its three sources from slug to schema. Note `gatherSiblingDocs` (READER-04 doc_link source) is superseded by D-03's containment/reference derivation.
- `src/reader/doc-generator.ts` — judge-tier generator + citation-verify; reused unchanged except a schema-thesis prompt framing (Claude's discretion).
- `src/consolidation/doc-writer.ts` — lifecycle-exempt single-writer for `type='doc'` nodes; D-04's eager doc-node stubs route here.
- `src/viz/modules/corpus.js` (vendored flat 2D `force-graph`) — renders the corpus; D-08 styling lives here.

### Engine seams (re-verify; source may have moved)
- `src/db/schema.ts` — `node.type` / `edge.kind` CHECK constraints (Phase 27 added `doc`/`cites`/`doc_link`; new doc-corpus edge kinds per D-03 land here).
- `src/viz/server.ts` — `/doc*` + `/graph?type=doc` corpus endpoints; D-08/Req-4 endpoint change.
- Sleep-pass Phase C (consolidation entry that runs `SchemaRelationDeriver`) — D-04 wiring point.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`SchemaRelationDeriver` (`schema-relations.ts`)** — already computes per-schema centroids from abstracts-members and runs as an idempotent wipe-and-rebuild derived cache in sleep-pass Phase C. D-04's pass is a structural sibling; D-09's centroid seed reuses the same centroid math.
- **`doc-gather.ts` / `doc-generator.ts` / `doc-writer.ts`** — the full Phase-27 gather→generate→write→lazy-gen path; this phase re-anchors the gather (D-09) and adds an eager promotion+stub pass (D-04), reusing the rest verbatim.
- **`abstracts` edges (985 schema→entity + 422 schema→fact, live)** — the evidence sets that D-01/D-02/D-06 count and intersect. No new tracking needed.
- **`corpus.js` flat 2D `force-graph`** — the renderer; D-08 is link-styling + scope-doc integration, not a new view.

### Established Patterns
- **Single-writer + lifecycle exemption** — doc nodes route through `doc-writer`, skipping embed/decay/FTS/`training_eligible`/claim-extraction. D-04's eager stubs honor this.
- **Derived caches are wipe-and-rebuildable, LLM-free, zero-inferred-signal** (SREL-01/D-37 pattern) — D-01..D-04 follow it: read-only over evidence, atomic transaction, deterministic for a fixed snapshot.
- **Self-confirmation guard is load-bearing** — D-03 satisfies it structurally by keeping all new edges on doc nodes, never on source schemas.
- **Viz density anchor + `lod.js`** — do not re-tune absolute node sizes; the corpus is a separate flat graph anyway.

### Integration Points
- Sleep-pass Phase C → add D-04's promote+derive+stub+wire pass after `SchemaRelationDeriver`.
- `GET /graph?type=doc` → emit schema-doc nodes + containment+reference edges; drop the doc_link-between-projects dependency (Req 4 supersedes READER-04).
- `doc-gather.ts` → add a schema-anchored entry alongside the scope-anchored one.

</code_context>

<specifics>
## Specific Ideas

- The corpus must read as a **legible hierarchy** on the flagship viz — containment as a solid directed spine, reference as faint cross-links (D-08). The parent→child nest is the point; it shouldn't look like an undifferentiated hairball.
- "Mass ≠ importance" is the live failure mode: the highest-mass schemas are Claude-Code dogfooding artifacts. The first corpus render must NOT be dominated by "Output file paths" / "Git commit hashes" — D-07 is there to earn a good first impression.
- Faithfulness framing the generator should carry: **schema = the generalization (thesis), its abstracted facts/entities = the evidence (body)** — the abstraction graph literally rendered as prose.

</specifics>

<deferred>
## Deferred Ideas

- **Entity-anchored docs** — out of scope per SPEC (schema + scope anchors only in v1); avoids entity/schema doc-overlap dedupe. Future phase.
- **Section-level / partial regen** — inherited deferral from Phase 27 (READER-05); whole-doc regen only.
- **Centroid-cosine as a real secondary signal** — D-01 demotes it to at most a tie-breaker; a future pass could blend cosine + containment if containment-only under-shoots depth.
- **LLM-derived ladder** — rejected for v1 (keeps enrichment cheap/LLM-free); revisit only if structural containment can't reach meaningful depth.

None of the above were scope creep — all are SPEC-deferred or natural future extensions.

</deferred>

---

*Phase: 28-schema-anchored-corpus*
*Context gathered: 2026-06-19*
