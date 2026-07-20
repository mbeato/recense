# Phase 28: Schema-Anchored Corpus — Specification

**Created:** 2026-06-19
**Ambiguity score:** 0.22 (gate: ≤ 0.20 — marginally above; sole residual is the schema→schema *enrichment mechanism*, intentionally deferred to discuss-phase as a HOW)
**Requirements:** 5 locked

## Goal

Pivot the reader corpus from project-scope docs to the **abstraction graph rendered as prose**: docs anchor on **schemas** (the generalization is the thesis) and cite direct facts/entities as evidence, with a selective mass gate deciding which schemas earn a doc and a hierarchical nesting derived from (and enriching) the schema→schema relations.

## Background

Phase 27 shipped the reader layer: `type='doc'` nodes anchored on a **project scope** (one tonos doc exists live, 74 citations), generated via `scope ∪ semantic ∪ entity-hop` gather (`doc-gather.ts`), the judge-tier generator (`doc-generator.ts`), the lifecycle-exempt single-writer `doc-writer.ts`, DB-backed `/doc` + `/doc/meta` + `/doc/staleness` routes, the reader UI with Reader/Brain toggle + staleness + in-place doc-ref open, and a flat 2D `force-graph` corpus (vendored, `corpus.js`) with `doc_link` edges (READER-04).

The corpus today is **flat and scope-only**: `scope = project = one doc`, and `doc_link` edges only form between project docs when the generator happens to name another project. The richer model — docs anchored on the brain's own abstractions — does not exist.

**Live brain reality (canonical DB, scouted 2026-06-19):** 266 `schema` nodes, 4216 facts, 3186 entities. `abstracts` edges = 1487 total, split **schema→entity 985 / schema→fact 422 / schema→schema 83**; `schema_rel` = 12 (schema→schema). Schema incident-edge mass distribution: 24 schemas at ≥12, 26 at 8–11, 80 at 5–7, 114 at 3–4, 22 at 0–2. So: the schema layer is real and populated (viable now), a schema's evidence is mostly **entities + facts** (not other schemas), and the **schema→schema ladder is sparse (~95 edges across 266 schemas)** — deep nesting requires enrichment, not just rendering. Top-mass schemas skew toward dogfooding meta ("Output file paths", "Tool identifiers", "Git commit hashes") — mass ≠ importance.

## Requirements

1. **Schema-anchored doc generation**: A doc can anchor on a schema node, not only a scope.
   - Current: generation anchors only on a project scope; no path to generate a doc for a schema
   - Target: given a schema id, generate a lifecycle-exempt `type='doc'` node whose thesis is the schema's generalization and whose body cites the schema's abstracted evidence (entities/facts via `abstracts`) plus the existing semantic/entity-hop gather re-rooted at the schema; scope-anchored project docs remain unchanged (degenerate anchor)
   - Acceptance: a schema-anchored generate produces a `type='doc'` node whose prose carries ≥1 resolvable `recense://fact|node` ref drawn from the schema's `abstracts` neighborhood; existing scope-anchored generation still passes its Phase-27 tests

2. **Selective mass-gated promotion**: An LLM-free gate decides which schemas earn a doc.
   - Current: nothing decides doc-worthiness; only hand-named project slugs are generated
   - Target: a cheap COUNT/SQL promoter ranks schemas by evidential mass (incident `abstracts`/`cites`/`relation` edges, or supporting fact/entity count) and selects those above a threshold tuned for "selective dozens" (live data: ~24 at mass≥12, ~50 at mass≥8); sub-threshold schemas stay inline
   - Acceptance: against the live brain the promoter returns between ~15 and ~60 schema candidates, runs as a SQL/COUNT query with zero model calls, and is deterministic for a fixed DB snapshot

3. **Schema→schema nesting with ladder enrichment**: The corpus nests schema-docs hierarchically, and the phase enriches the thin schema→schema layer so nesting has substance.
   - Current: schema→schema relations are sparse (~83 `abstracts` + 12 `schema_rel` ≈ 95 across 266 schemas) — too thin for a meaningful hierarchy
   - Target: promoted schema-docs nest parent→child along schema→schema relations; because the live ladder is thin, the phase derives/strengthens schema→schema relations so nesting reaches real depth. (The derivation *mechanism* is a discuss/plan decision; this requirement locks that enrichment + nesting are in scope and must yield real nesting, not that the current ladder is rendered as-is.)
   - Acceptance: after the phase, usable schema→schema relations among promoted schemas materially exceed the ~95 baseline (concrete target set in plan) AND the corpus renders ≥1 parent→child schema-doc nest on the live brain; enrichment never mutates source schemas (see Req 5)

4. **Containment + reference corpus edges, rendered in the flat 2D corpus** (supersedes READER-04): Corpus edges come from structure, not project-name luck.
   - Current: corpus edges are `doc_link` between project docs, formed only when the generator names another project
   - Target: corpus edges = (a) **containment** (parent→child schema-doc) + (b) **reference** (schema-docs sharing facts/entities); the existing flat 2D `force-graph` renderer displays the schema corpus; clicking a node opens that schema-doc in-place (reusing 27-03/27-05). The project-doc `doc_link` corpus is replaced
   - Acceptance: the corpus graph endpoint returns schema-doc nodes + containment+reference edges with no dependency on doc_link-between-projects; the flat 2D corpus renders them; clicking a node opens its doc in-place; a scope/project doc still appears as a (degenerate) node

5. **Read-only projection / self-confirmation guard** (load-bearing): A doc is inferred output and must never strengthen its source.
   - Current: doc nodes are lifecycle-exempt (no embed/decay/FTS/training) and generation does not mutate sources
   - Target: preserve this under schema-anchoring — generating, storing, nesting, or linking a schema-doc must never bump the source schema's s/c, add edge weight back to it, add a fact, or set `training_eligible`; inferred output must not confirm its source
   - Acceptance: snapshot a source schema's `s`, `c`, incident edge weights and supporting nodes; generate its doc + nest + link it; re-snapshot — the source schema and its facts are unchanged; only new `type='doc'` nodes and doc-corpus edges were added

## Boundaries

**In scope:**
- Schema-anchored doc generation (schema = thesis, abstracts-neighborhood entities/facts = evidence)
- Scope-anchored project docs retained as the degenerate case
- Selective, LLM-free mass-gated promotion of doc-worthy schemas
- Schema→schema ladder *enrichment* + hierarchical (parent→child) schema-doc nesting
- Containment + reference corpus edges; rendering the schema corpus in the existing flat 2D `force-graph`; node→doc in-place open
- Preserving the read-only / self-confirmation guard under schema-anchoring
- Decide-cheap / generate-lazy posture (eager candidate + node + parent stub-link; prose generated on first access via existing lazy-gen)

**Out of scope:**
- Entity-anchored docs — deferred (schema + scope anchors only in v1); avoids entity/schema doc-overlap dedupe
- Section-level / partial regen — deferred; whole-doc regen only (inherited from Phase 27)
- Changes to the reader UI, Reader/Brain toggle, staleness, or the 3D brain — inherited as-is from Phase 27
- The generation prompt/model, embedder, and judge selection — unchanged (reuse Phase 27 paths)
- Any new external/npm dependency — reuse the vendored `force-graph`; net-zero deps
- Multi-tenant / cross-account corpus
- Pinning the exact schema→schema *derivation algorithm* — that is a discuss-phase HOW decision; this spec only locks that enrichment must happen and produce real nesting

## Constraints

- **Live data shape:** a schema's evidence is mostly entities (985) + facts (422); the schema→schema ladder is sparse (~95) and must be enriched for nesting. Generation bodies should draw on the entity/fact neighborhood, not assume schema→schema density.
- **Mass ≠ importance:** highest-mass schemas skew to dogfooding meta (Claude-Code session artifacts). The promotion gate may need a coherence/quality factor or a denylist so the corpus isn't dominated by noise — flagged for discuss-phase.
- **Promotion gate is LLM-free** (SQL/COUNT); **generation stays lazy** (cost paid only on first access). Generation remains subscription-billed via the Phase-27 claude-headless judge-tier path — no new model-cost path.
- **Reuse Phase 27**: render (`corpus.js` flat 2D), reader, gather, `doc-writer`, lazy-gen, `/doc*` routes. Net-zero new dependencies.
- **Self-confirmation is load-bearing** (Req 5) — a correctness invariant from the project constraints, not optional.

## Acceptance Criteria

- [ ] A schema-anchored doc can be generated for a given schema id; its prose cites ≥1 resolvable node from the schema's `abstracts` neighborhood; it is a lifecycle-exempt `type='doc'` node
- [ ] The promoter selects ~15–60 schema candidates from the live brain via a deterministic, LLM-free query
- [ ] Usable schema→schema relations among promoted schemas exceed the ~95 baseline after enrichment (target set in plan), and the corpus renders ≥1 parent→child schema-doc nest on the live brain
- [ ] The corpus graph endpoint returns schema-doc nodes + containment+reference edges with no doc_link-between-projects dependency; the flat 2D corpus renders them; clicking a node opens its doc in-place
- [ ] Scope-anchored project docs still generate and appear in the corpus as a degenerate node
- [ ] Generating / nesting / linking a schema-doc leaves the source schema and its facts unchanged (self-confirmation guard); doc nodes remain lifecycle-exempt

## Ambiguity Report

| Dimension          | Score | Min  | Status | Notes                                                                 |
|--------------------|-------|------|--------|-----------------------------------------------------------------------|
| Goal Clarity       | 0.85  | 0.75 | ✓      | Clear: abstraction graph as prose, schema-anchored                    |
| Boundary Clarity   | 0.80  | 0.70 | ✓      | Explicit in/out; entity-anchoring + section-regen deferred            |
| Constraint Clarity | 0.68  | 0.65 | ✓      | Grounded in live data; schema→schema *enrichment mechanism* is a HOW deferred to discuss-phase |
| Acceptance Criteria| 0.74  | 0.70 | ✓      | 6 pass/fail checks tied to live-brain numbers                         |
| **Ambiguity**      | 0.22  | ≤0.20| ⚠      | Marginally above gate; all dimension minimums met. Residual = the schema→schema enrichment HOW (correctly discuss-phase territory) |

Status: ✓ = met minimum, ⚠ = below/at threshold (planner treats as assumption). The #1 discuss-phase question: **how** to derive/enrich schema→schema relations (and how to keep the promotion gate off dogfooding-noise schemas).

## Interview Log

| Round | Perspective     | Question summary                                  | Decision locked                                                             |
|-------|-----------------|---------------------------------------------------|-----------------------------------------------------------------------------|
| 1     | Researcher      | What schema/abstraction substrate exists live?    | 266 schemas, 1487 `abstracts` (mostly schema→entity/fact), schema→schema sparse (~95); viable now |
| 1     | Researcher      | Mass distribution for gate sizing?                | ~24 schemas at mass≥12, ~50 at ≥8 → "selective dozens" achievable           |
| 2     | Boundary/Design | Hierarchy: flat vs containment vs full nesting?   | **Full schema→schema nesting** — phase enriches the sparse ladder           |
| 2     | Boundary/Design | Promotion gate aggressiveness?                    | **Selective evidential mass** — ~dozens of strong docs, not all 266         |
| 2     | Boundary/Design | Anchor types + keep project docs?                 | **Schema + scope** — project docs stay as degenerate anchor                 |
| 3     | Failure Analyst | What would make the corpus wrong?                 | Mass≠importance (dogfooding-noise schemas); self-confirmation feedback — both pinned as constraints/Req 5 |

---

*Phase: 28-schema-anchored-corpus*
*Spec created: 2026-06-19*
*Next step: /gsd:discuss-phase 28 — implementation decisions (how to enrich schema→schema relations, gate against noise, re-anchor the gather, corpus-edge derivation)*
