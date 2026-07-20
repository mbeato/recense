# Phase 25: Entity Dedup / Prune - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-18
**Phase:** 25-entity-dedup-prune
**Mode:** `--auto` (no interactive prompts; recommended option auto-selected per area)
**Areas discussed:** Cluster matching, Origin guard, Canonical selection, Edge rewiring, Provenance + packaging/safety

---

## Cluster matching — candidate formation + merge threshold

| Option | Description | Selected |
|--------|-------------|----------|
| Two-stage precision-first (normalized-value blocking → cosine ≥ 0.88 confirm) | Cheap blocking buckets, then conservative cosine well above retrieval's 0.7; deterministic/repeatable | ✓ |
| Pure embedding kNN at retrieval threshold (0.7) | Simpler, single-stage | |
| Exact normalized-value equality only | No embedding step; misses paraphrase fragments | |

**Auto-selected:** Two-stage precision-first. A false merge corrupts the graph, so bias toward not merging.
**Notes:** Deterministic iteration → second run is a no-op (DEDUP-01 repeatability). Threshold 0.88 is a configurable starting point left to planner discretion.

---

## Origin guard

| Option | Description | Selected |
|--------|-------------|----------|
| Block merges across distinct beliefs (origin boundary + active contradiction chains) | Skip non-lexically-identical pairs crossing asserted_by_user vs inferred; never merge mid-reconciliation nodes | ✓ |
| No origin guard (merge purely on similarity) | Simpler, riskier | |

**Auto-selected:** Block merges that would collapse genuinely distinct beliefs.
**Notes:** Entities rarely conflict on origin, but the guard protects the "stays correct" invariant.

---

## Canonical selection

| Option | Description | Selected |
|--------|-------------|----------|
| Highest edge degree → c → earliest last_access → id | Preserve most-referenced identity, keep its id stable | ✓ |
| Highest confidence c only | Ignores connectivity | |
| Oldest node | Ignores connectivity + confidence | |

**Auto-selected:** Degree-first with deterministic tie-breaks. Canonical keeps its own id.
**Notes:** Scope/temporal sidecars: canonical keeps its own, inherits from a duplicate only if missing.

---

## Edge rewiring + PK-collision handling

| Option | Description | Selected |
|--------|-------------|----------|
| Rewire all edges → canonical, merge on (src,dst,rel) collision (max w, latest last_access), drop self-loops, single tx + foreign_key_check assert | FK-safe, mirrors T-FK-01 guard | ✓ |
| Naive UPDATE edge SET src/dst = canonical | Hits PK collisions + can create dangling/self edges | |

**Auto-selected:** Transactional rewire with collision merge + FK assertion.
**Notes:** This is the load-bearing guard — exactly the T-FK-01 failure mode (edge referencing a non-existent node id).

---

## Provenance + pass packaging / safety

| Option | Description | Selected |
|--------|-------------|----------|
| Opt-in manual CLI (`recense dedup-entities`) + `--dry-run` default, tombstone duplicates, `consolidation_event` merge audit, LLM-free | Safe, reversible, ~$0, not auto-wired into hourly pass | ✓ |
| Wire into hourly sleep pass immediately | Convenient but destructive-by-default; violates gated-live-write lesson | |
| Delete duplicates instead of tombstone | Violates never-delete-evidence invariant | |

**Auto-selected:** Manual opt-in CLI with dry-run, tombstone + audit-event provenance.
**Notes:** Mirrors "gated live-write needs a real off-switch." DEDUP-03 verified via brain-memory entity count (8+ → 1) + pre/post sample recall set.

---

## Claude's Discretion

- Exact MERGE cosine value (0.88 start), blocking-key normalization specifics, and whether stage-1 also seeds candidates from embedding nearest-neighbors vs normalized-value buckets only — planner tunes against the live DB holding precision-first fixed.

## Deferred Ideas

- Fact/schema-node deduplication (entities only this phase).
- Auto-wiring dedup into the hourly sleep pass (revisit after manual pass proven safe).
- Reviewed-not-folded todos: `content-hardening-deferred.md` (spurious 0.6 keyword match, off-domain), `viz-search-and-hull-quality.md` (0.2, unrelated viz).
