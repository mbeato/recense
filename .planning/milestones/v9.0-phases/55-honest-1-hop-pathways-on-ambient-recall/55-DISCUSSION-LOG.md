# Phase 55: Honest 1-hop pathways on ambient recall - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-30
**Phase:** 55-honest-1-hop-pathways-on-ambient-recall
**Areas discussed:** Edge budget, Edge direction, Edge kinds, Seed score, Per-seed density (N)

---

## Edge budget / fanout

| Option | Description | Selected |
|--------|-------------|----------|
| Cap per-seed by weight | All seeds expand; emit each seed's top-N highest-weight real edges. Engine bounds before emit; viz cap stays backstop. | ✓ |
| Cap total edge budget | Global cap on total hops per recall, distributed across seeds. | |
| Expand top seeds only | Only top-K seeds expand; lower seeds light as bare nodes. | |
| Emit all, cap in viz | Engine emits all out-edges; viz TRACE_FANOUT/TRACE_MAX_EDGES trims client-side. | |

**User's choice:** Cap per-seed by weight
**Notes:** Honest subset framing — real edges ranked by real stored weight `w`. Cap lives engine-side, viz caps backstop only.

---

## Edge direction

| Option | Description | Selected |
|--------|-------------|----------|
| Out-edges only | getOutEdges() — matches roadmap wording + measured 40–72/seed. May under-count for src<dst-stored kinds (Phase 18 CR-01 landmine). | ✓ |
| Both directions | getEdgesForNode() — all 1-hop neighbors either direction. More complete, higher volume. | |

**User's choice:** Out-edges only
**Notes:** Chosen knowingly despite the flagged Phase 18 CR-01 landmine (out-edges-only silently missed ~50% of src<dst-stored pairs). Captured as a research flag in CONTEXT — researcher must confirm whether `relation` edges are bidirectional or single-direction; surface at checkpoint if it under-counts, but decision stays out-edges-only unless founder revises.

---

## Edge kinds

| Option | Description | Selected |
|--------|-------------|----------|
| All real edge kinds | Any real out-edge lights regardless of kind. Maximally honest; structural edges may not read as pathways. | |
| Semantic/association only | Exclude structural schema_rel/abstracts; light association + typed-predicate edges. | ✓ |

**User's choice:** Semantic/association only
**Notes:** Resolved to the concrete allowlist `kind === 'relation'` (covers associative + typed-predicate edges, which share kind='relation' with `rel` set). Excludes structural `abstracts`/`schema_rel` and corpus-document kinds `cites`/`doc_*`/`derived_from`.

---

## Seed score

| Option | Description | Selected |
|--------|-------------|----------|
| Emit real seed score | Seeds carry real cosine/RRF magnitude; hops stay score:null. Moves emit from string[] to {node_id,score} objects matching curated row shape. | ✓ |
| Mirror curated (null) | Emit seeds as {node_id, score:null} too. Uniform but discards the real magnitude. | |

**User's choice:** Emit real seed score
**Notes:** Ambient recall has a measured magnitude the curated path lacks — emit it (brightness ∝ real score). Hops remain rank-only null per WR-02.

---

## Per-seed density (N)

| Option | Description | Selected |
|--------|-------------|----------|
| N=6 (balanced) | ~Up to 60 hops across 10 seeds. Readable bundles; tune up if sparse. | ✓ |
| N=8 (denser) | ~Up to 80 hops. Richer spread; relies on viz backstop more. | |
| N=4 (sparser) | ~Up to 40 hops. Cleaner but risks re-introducing the sparse symptom. | |

**User's choice:** N=6 (balanced)
**Notes:** Named tunable constant (Phase 52 D-06 precedent) — adjustable at the founder visual checkpoint. Err denser since the symptom is "pathways rarely show."

---

## Claude's Discretion

- Prepared-statement / batching strategy for per-seed edge reads (keep hot path cheap).
- Deterministic tiebreak ordering for equal-weight edges.
- Whether to include `links_to` / `extends` relation-kind edges (pending researcher signal).
- Idiomatic home for the N constant.

## Deferred Ideas

- Both-direction (in+out) 1-hop pathways — closes the src<dst under-count risk; deferred unless research + checkpoint show it's needed.
- Structural (`abstracts`/`schema_rel`) or doc-graph edges as pathways — a future "show structure in viz" idea, not associative recall.
