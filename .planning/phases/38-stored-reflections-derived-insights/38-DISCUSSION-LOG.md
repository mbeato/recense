# Phase 38: Stored Reflections / Derived Insights - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-21
**Phase:** 38-stored-reflections-derived-insights
**Mode:** `--auto` (no interactive AskUserQuestion; Claude selected the recommended option per area from the codebase map + prior-phase patterns)
**Areas discussed:** Insight node representation, Reflection scope/cadence, Synthesis & self-confirmation, Recall surfacing, Invalidation, Architecture placement

---

## Insight node representation & dependency edges

| Option | Description | Selected |
|--------|-------------|----------|
| New `type='insight'` node + new `derived_from` edge | Distinct recall-artifact node; reuse only doc *lifecycle mechanics* | ✓ |
| Reuse `type='doc'` + `cites` edge | Treat insights as docs; reuse reader/corpus plumbing | |

**Selected:** New `type='insight'` + `derived_from` edge (D-01/D-02).
**Notes:** Docs are reader prose (slug-keyed, rendered in `/doc` + corpus graph); insights are a short recall-time payload. Conflating would pollute reader/corpus surfaces. `derived_from` (insight→{schema, members}) makes both recall discovery and invalidation in-edge walks over existing primitives.

---

## Reflection scope, cadence & selection gate

| Option | Description | Selected |
|--------|-------------|----------|
| Mass gate + noise filter + staleness, generate-when-stale | Reuse Phase 28 gate; act only on stale/new qualifying clusters | ✓ |
| Reflect over all schemas every pass | Simpler, but unbounded LLM cost | |

**Selected:** Mass-gated, noise-filtered, staleness-gated eager generation (D-03).
**Notes:** Bounds the dominant sleep-pass (Haiku) cost. Key contrast vs docs: insight prose is generated **eagerly** offline (recall is LLM-free and can't synthesize at compose-time), but only for stale/new qualifying clusters.

---

## Insight synthesis, confidence ceiling & self-confirmation

| Option | Description | Selected |
|--------|-------------|----------|
| One offline `generate()` per stale cluster, capped confidence, read-only over members | Inferred, `training_eligible=0`, ceiling ~0.6, single-writer transaction | ✓ |
| Multi-call / per-member synthesis | More thorough, higher cost, no clear quality gain | |

**Selected:** Single judge-tier `generate()` per cluster (D-04).
**Notes:** Self-confirmation holds by construction — insights are `origin='inferred'` (D-43 no-ops `strengthen`), and synthesis never strengthens member facts. Confidence ceiling value flagged for founder verification. RED-under-injection sentinel test required (Phase 28 convention).

---

## Recall surfacing

| Option | Description | Selected |
|--------|-------------|----------|
| Augment-with-fallback (insight in place of neighborhood) | Phase 37 D-06 shape; one mode or the other per query; tunable + eval-proven | ✓ |
| Insight + full neighborhood | Re-bloats payload, erases the token win | |
| Full replace (always insight) | Breaks queries with no qualifying insight | |

**Selected:** Augment-with-fallback, LLM-free, tunable, prove-before-activate (D-05).
**Notes:** The compose-token win is the deliverable — measured on the existing KU/LongMemEval replay harness (record payload tokens, not just correctness). Activation default is a founder call after the eval (Phase 35 dark-default posture).

---

## Invalidation when a member is falsified/tombstoned

| Option | Description | Selected |
|--------|-------------|----------|
| Freshness-gate + regen; falsified member flags insight stale, recall stops surfacing | Stale → excluded from recall + queued for regen; tombstone+evict on cluster dissolution | ✓ |
| Hard cascade-tombstone dependent insights immediately | Loses regenerability; over-aggressive | |

**Selected:** Freshness-gate + regen, hysteresis-guarded eviction (D-06).
**Notes:** Satisfies SC3 (falsified fact ⇒ no stale-insight self-confirmation) via the freshness gate; "regenerable/evictable like docs" via regen + the standard AND-gated sweep. Insights decay but are tombstoned explicitly on cluster dissolution, never deleting evidence.

---

## Architecture / placement

| Option | Description | Selected |
|--------|-------------|----------|
| `InsightReflector` deriver in Phase C, after corpus promote, before eviction | Sibling of `SchemaRelationDeriver`; reuses computed centroids/members | ✓ |

**Selected:** Phase-C deriver between `corpusPromoter.promote()` and `runEvictionSweep()` (D-07).
**Notes:** Confirmed by the codebase map; eviction runs last so dissolved-cluster insights are collected same pass.

---

## Claude's Discretion

Routed to research/planner: concrete `reflectConfidenceCeiling` value, mass/hysteresis/threshold knobs against the live brain, synthesis prompt shape, sidecar table choice (`node_doc` reuse vs `node_insight`), exact recall integration point, eval grid.

## Deferred Ideas

- Multi-cluster / cross-schema reasoning chains (v1 = one insight per cluster).
- Rendering insights in the reader/corpus or 3D brain (recall artifact, not reader prose).
- Insight-of-insights (recursive higher-order reflection).
- Reviewed-not-folded todos: `corpus-brain-3d-transition.md`, `content-hardening-deferred.md`, `viz-search-and-hull-quality.md` (keyword-noise viz/content matches, out of scope).
