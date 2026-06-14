# Recense Engine — Evolution Roadmap

How the engine grows from the simplest working v1 to the full sophisticated system, **one layer at a time, each gated on the previous working + a concrete signal**. Companion to [`recense-spec.md`](./recense-spec.md).

**Created:** 2026-06-05

## Guiding principle

Every upgrade is a **layer on a stable interface defined in v1**, never a rewrite. v1 deliberately ships the seams the later stages plug into (`CandidateRetriever.topk`, the split `ModelProvider`, `ConsolidationSink`, the update-decision branch points, provenance/origin, `training_eligible`). So "cut from v1" never means "redesign later" — it means "swap the implementation behind a seam that already exists." That is what makes the cuts safe.

**Trigger discipline:** do not build a stage because it's next on the list. Build it when its trigger fires — a real signal from running the prior stage. If a trigger never fires (e.g. the graph never gets big enough to need an ANN index), that stage never gets built, and that's a win.

---

## Stage v1 — Core loop (the simplest thing that genuinely learns)

**Ships:** episodic store · tag-don't-drop allocation gate (heuristic + hard-keep allowlist) · graph + embeddings-on-nodes (brute-force cosine scan) · consolidation with batched PE judge (typed-slot-first) · three-way update with **tombstone-default reconcile** + provenance-distinct contradiction counter + oscillation guard · lazy decay + AND-gated eviction · abstraction (schema induction) · inference = schema-prior, ephemeral · origin/provenance enforcement · single-writer + cold-start seed from MEMORY.md · Level-3 seams (interfaces only) · the eviction invariant test.

**Success criteria (the gate to even think about v1.1):**
1. It replaces `MEMORY.md` for your own Claude Code — facts get stored, recalled, and *corrected* without manual editing.
2. A changed fact updates correctly (tombstone+supersede), and a stale fact stops surfacing.
3. It forms at least one real schema you never explicitly stated ("learns").
4. `contextscope` confirms it isn't bloating per-turn context vs the old flat index.
5. The eviction invariant test passes — no true fact silently deleted.

---

## Stage v1.1 — Update sophistication
**Add:** confidence-tiered **in-place rewrite** (the deferred half of the update model) — low-stakes/high-confidence corrections overwrite instead of tombstoning. Plus episodic-log **TTL/retention**.
**Why deferred:** in-place is destructive and the human-overwrite evidence is fragile; tombstone-always is the safe default that also feeds the oscillation detector.
**Trigger:** you've run tombstone-always for a few weeks and have data on *which* corrections are demonstrably safe to overwrite; and/or tombstone history growth is real enough to want pruning.
**Plugs into:** the `contradict → mid-band` branch point (already exists) + the existing tombstone primitive. No structural change.

## Stage v1.2 — Retrieval depth
**Add:** multi-hop LLM composition for novel cues (the full Level-2 inference).
**Why deferred:** heaviest inference path, and mostly *unreachable* until the graph is dense — early on there are no multi-hop paths to compose.
**Trigger:** the graph is dense enough that multi-hop paths actually exist and resolve, AND you have explicit recall queries where latency is acceptable (never on SessionStart).
**Plugs into:** the RECALL+INFER path (already scoped) + bounded-neighborhood curation (already specified). Keep it off the hot path.

## Stage v1.3 — Scale plumbing
**Add:** swap brute-force cosine scan → ANN index (HNSW/pgvector). Optionally synaptic-scaling normalization.
**Why deferred:** pure ceremony at hundreds of nodes; normalization was the foundation's own "where it breaks" caveat.
**Trigger:** *measured* retrieval latency actually hurts (node count into tens of thousands) — for the index; *observed* hub-edge dominance degrading retrieval — for normalization (may never fire).
**Plugs into:** `CandidateRetriever.topk()` seam (drop-in, zero logic change) + the Strength/Decay Manager.

## Stage v2 — Inferred knowledge persistence (deeper generalization)
**Add:** let high-value inferences *become* facts when independently confirmed — provenance-DAG-disjoint confirmation, the safe version of write-back.
**Why deferred:** the self-confirmation loop is the engine's most dangerous failure; v1 keeps inference ephemeral precisely to avoid it.
**Trigger:** the inference path is trusted in practice, and the provenance machinery (origin enum + support paths) has proven correct over real usage.
**Plugs into:** origin/provenance (already first-class) + a new `derived` node type recomputed-on-read.

## Stage v3 — Level 3: parametric learning
**Add:** distill consolidated memory into a LoRA adapter / fine-tune so the *base model's weights* change — true skill acquisition, the most literal "learning like a human."
**Why deferred:** heavy separate track (training infra, GPU serving, brittle, expensive); and it must not be entered without a regression harness.
**Trigger:** you have a stable corpus, the **eval-snapshot harness (seam-3) is proven** (so you can catch a fine-tune making things worse), and serving infra is in place (Baseten+Truss from the tooling research is the path of least resistance).
**Plugs into:** `ConsolidationSink` (the training-event stream) + `training_eligible` flag + the split `ModelProvider` (swap in the adapted model) + eval-snapshot. **All four seams already shipped in v1** — this is the payoff of building them early.

---

## One-glance dependency view

```
v1 core loop ──► v1.1 in-place updates ──► (update model complete)
     │
     ├──► v1.2 multi-hop inference ──► v2 inferred-fact persistence ──► (learning deepens)
     │
     ├──► v1.3 ANN index / normalization ──► (scale, if ever needed)
     │
     └──► [seams: Sink + training_eligible + ModelProvider + eval-snapshot] ──► v3 LoRA/fine-tune
```

Nothing downstream requires re-architecting anything upstream. Each arrow is a layer, gated on a real signal, behind a seam v1 already exposes.
