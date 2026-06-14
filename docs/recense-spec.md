# Brain-Memory Engine — v1 Architecture Spec

A faithful brain-inspired agent-memory engine. **Customer-zero = the founder's own Claude Code memory**, replacing the flat `MEMORY.md` index. Built solo, dogfood-first; product-shaped interfaces from day one, but the v1 bar is "useful for my own agents," not "scale to thousands."

**Created:** 2026-06-05 · **Status:** Design-of-record (post adversarial review). Built on [`recense-foundation.md`](./recense-foundation.md).
**Provenance:** §1–§3 design + a 6-dimension adversarial review (39 findings, 37 adopted after verification against the foundation). `[REVISED]` / `[CUT]` / `[DEFERRED]` / `[NEW]` tags mark what the review changed.

---

## 0. Locked decisions + one open question

**Locked:** Hybrid graph+vector spine · Learning Levels 1+2 (abstraction + inference), no weight-training in v1 · context window = working memory (not rebuilt) · Level-3 (LoRA) reachable via seams, zero Level-3 code in v1.

**⚠️ OPEN — needs founder ruling (modifies an earlier locked choice):** the update model. You chose **confidence-tiered hybrid** (in-place for low-stakes, tombstone for high-stakes). The review recommends **v1 = tombstone-always**, with confidence-tiered in-place rewrite deferred to v1.1 — because tombstone keeps the history the oscillation-detector needs, it's non-destructive, and in-place is an optimization you can add after watching it run. **This spec is written for tombstone-always-v1; revert to confidence-tiered if you disagree.** Everything else is unaffected by this choice.

---

## 1. Data model

Single store (SQLite-class is sufficient for v1). Four record types.

### Episode (fast / hippocampal store)
| field | purpose |
|---|---|
| `id` | stable id |
| `ts` | timestamp |
| `content` | raw event text (turn, observation) |
| `origin` | `observed` \| `asserted_by_user` \| `inferred` — **immutable, propagating** `[NEW]` |
| `salience` | heuristic score (0–1), set by Allocation Gate — **a tag, not a gate** `[REVISED]` |
| `consolidated` | bool — has the sleep pass processed it |
| `source_inference_id` | nullable — if this episode echoes an injected inference, points to it (so it can't self-confirm) `[NEW]` |

Append-only. **Every event is appended unconditionally** `[REVISED]` (the gate scores, it does not drop). Retention TTL on unconsolidated low-salience episodes `[DEFERRED to v1.1]`.

### Node (slow / semantic graph — entities, facts, schemas)
| field | purpose |
|---|---|
| `id` | stable id `[NEW: required for Level-3 snapshotting]` |
| `type` | `entity` \| `fact` \| `schema` |
| `value` | current value text — **the source of truth at read time** `[REVISED]` |
| `value_hash` | hash of `value`; drives re-embedding `[NEW]` |
| `embedding` | vector of `value` — a **derived cache**, never a second source of truth `[REVISED]` |
| `embedded_hash` | hash the embedding was computed from; `!= value_hash` ⇒ dirty `[NEW]` |
| `origin` | strongest origin among supporting evidence |
| `s` | strength (usage-driven), with `last_access` |
| `c` | confidence (evidence-driven), **bounded/decayed** so it can't saturate `[NEW: faithful-4]` |
| `last_access` | for lazy decay `[REVISED]` |
| `prev_value` + `prev_ts` | one-deep superseded pointer (flip-back detection) `[NEW]` |
| `pending_contradictions` | list of provenance-distinct contradiction ids `[NEW]` |
| `tombstoned` | bool — superseded; deprioritized + decays faster |
| `training_eligible` | derived: `origin ∈ {observed,asserted_by_user} ∧ ¬tombstoned ∧ c ≥ τ` `[NEW: seam-2]` |

### Edge (weighted relations + `abstracts` provenance)
| field | purpose |
|---|---|
| `src`, `dst`, `rel` | typed relation |
| `w` | edge strength + `last_access` (Hebbian + decay, same rules as node `s`) |
| `kind` | `relation` \| `abstracts` (schema→evidence provenance) |

`abstracts` edges are maintained when evidence is tombstoned/evicted — a schema's support set is recomputed so it never dangles `[NEW: coherence-7]`.

### Schema version + record IDs
All `ConsolidationSink` events carry stable record ids + a `schema_version` so a future training snapshot is reproducible `[NEW: seam-1]`.

---

## 2. Components

1. **Episodic Store** — append-only event log. Single writer for episodes (online).
2. **Allocation Gate** `[REVISED]` — a **cheap heuristic** (not an LLM call) that **scores** salience/novelty + applies a **hard-keep allowlist** (imperative self-statements, corrections, "always/never" rules — mirrors CLAUDE.md hard rules). It tags; it never drops. *(efficiency-3, faithful-2, correctness-5)*
3. **Semantic Store** — the graph (source of truth) + **embeddings-on-nodes** (no separate index subsystem `[CUT]`). Exposes **one owned write primitive** `upsert/tombstone(node)` that mutates value + marks `value_hash` dirty atomically; the vector is **never written except as a consequence of a graph write** `[REVISED]`. Candidate retrieval = **brute-force top-k cosine scan** behind a `CandidateRetriever.topk()` seam (swap to ANN only when measured latency hurts). *(scope-1, coherence-1, correctness-4)*
4. **Consolidation Engine** ("sleep" pass, offline/batch, **the only mutator of the graph** `[NEW: single-writer]`) — prioritized (salience-sorted) replay → batched claim extraction → PE-gated update → strength update + lazy-decay materialization → schema induction → end-of-pass: re-embed dirty nodes + eviction sweep over all nodes. Resumable via `last_consolidated_episode_id` checkpoint. *(scope-6, coherence-2, correctness-4/6)*
5. **Retrieval Engine** (online) — cheap, **LLM-free** base path: cosine top-k + graph spreading-activation + rank by `relevance × effective_s × recency`. Distinguishes `unreachable` from `deleted`. **Inference is NOT on this path by default** `[REVISED]`.
6. **Strength/Decay Manager** — Hebbian self-limiting increment `s ← s + η(1−s)`, **lazy multiplicative decay on read** `effective_s = s·exp(−λ·Δt)`, materialized before any mutation. **No synaptic-scaling normalization in v1** `[CUT]`. Sole owner of `s`/`c`/`w` mutations (declared transaction boundary). *(scope-2, coherence-2/3, faithful-7)*
7. **Claude Code Adapter** — SessionStart → inject cheap retrieval result (no generation); turns → Episodic Store (tagging echoed inferences with `source_inference_id`); session-end/scheduled → sleep pass.

---

## 3. Data paths

- **WRITE (online):** event → Allocation Gate scores → **append to Episodic Store unconditionally**. No LLM, no drop. `[REVISED]`
- **CONSOLIDATE (offline sleep, single-writer):** salience-sort unconsolidated episodes → batched claim extraction (one call per episode; skip low-salience) → per claim: nominate candidates (cosine top-k) → **typed-slot compare first; else ONE batched LLM judge** of claim vs all candidates' **graph current values** → three-way update → strength update + decay-materialize → schema induction (cluster on embeddings + support-count) → re-embed dirty nodes (batched) → eviction sweep → advance checkpoint. *(efficiency-1/4/5, faithful-5, correctness-4)*
- **RETRIEVE (online, LLM-free):** cue → cosine top-k + spreading-activation → rank → inject. `unreachable` if no path; never inference here. `[REVISED]`
- **RECALL+INFER (online, explicit, latency-tolerant):** schema-as-prior over a bounded curated neighborhood; **multi-hop LLM composition DEFERRED** `[DEFERRED]`. Inference output is **ephemeral** — tagged `inferred`, **never written back as a fact** in v1. *(scope-4, efficiency-2, correctness-1)*
- **FORGET:** lazy decay lowers **rank**; eviction only when `effective_s` low **AND** `c` low **AND** `tombstoned`. Evidence-backed facts are never decay-evicted. *(correctness-3)*

---

## 4. The update decision (PE-gated, the differentiated core)

For each extracted claim during consolidation:

1. **Nominate candidates** — cosine top-k over node embeddings. *Vectors only narrow the field.*
2. **Classify** claim vs each candidate's **current value read from the graph row** `[REVISED]`:
   - **Typed-slot compare first** (zero inference) where the node has enumerated/typed slots. *(faithful-5)*
   - Else **one batched LLM call** judging the claim against all K candidates → `{confirm, extend, contradict, unrelated}` + magnitude. *(efficiency-1)*
   - Embedding distance may auto-resolve **only** the safe direction: low-similarity → `unrelated`. High-similarity **escalates** to the LLM — never auto-confirm. *(efficiency-7)*
3. **Act:**
   | relation | action |
   |---|---|
   | `confirm` | no-op + strengthen `s`,`c` — **only if claim origin ∈ {observed, asserted_by_user}** (inferred echoes can't confirm) `[NEW]` |
   | `extend` | append new node **+ relation edge** to the candidate (linked) `[REVISED: distinct from unrelated]` |
   | `unrelated` | append new standalone node |
   | `contradict` | compare PE magnitude to a **strength/confidence-scaled threshold**: |
   | &nbsp;&nbsp;· weak vs strong fact | **HOLD** + record a provenance-distinct entry in `pending_contradictions`. When count ≥ **N (≈2–3) distinct** → **force destabilization** (Chen-2020) `[NEW]` |
   | &nbsp;&nbsp;· mid-band | **reconcile → tombstone old + set new current** (v1 default; confidence-tiered in-place is the OPEN question) |
   | &nbsp;&nbsp;· extreme / categorical | append-new trace |
4. **Oscillation guard:** if reconcile would set a value the node held `< K` sessions ago (via `prev_value`), escalate to **append-new** (hold both as genuine ambiguity) instead of flipping again. `[NEW: correctness-2]`

---

## 5. Strength, decay, forgetting

- `s ← s + η(1−s)` on co-activation (self-limiting). Decay is **lazy-on-read**: `effective_s = s·exp(−λ·Δt)`; materialized to the stored value **before** any increment (no double-count). `[REVISED]`
- `c` rises on independent confirmation, falls on contradiction, and is **bounded/decayed** so it cannot saturate and silently disable tombstoning. `[NEW: faithful-4]`
- **No edge-weight normalization in v1.** Plain decay is the mandatory Hebbian brake; normalization is deferred (and was the foundation's own "breaks here" caveat). `[CUT]`
- **Eviction sweep** at end of sleep pass over all nodes (one scalar compare each): evict only `low effective_s ∧ low c ∧ tombstoned`. `[REVISED]`
- **Invariant test:** replay synthetic sparse access over a simulated month; assert **no `origin=observed/asserted` fact ever crosses eviction**. `[NEW: correctness-3]`

---

## 6. Learning layer (Levels 1+2)

- **Abstraction (Level 1, in Consolidation):** cluster instances by **embedding similarity + support-count** (drop the second graph-structural axis) `[REVISED]`; cross support threshold N → emit/strengthen a `schema` node, linked to evidence via `abstracts` edges. One LLM **naming** call per *new* cluster. Schemas strengthen on confirm, tombstone if falsified; `abstracts` edges recomputed when evidence changes. *(scope-5, efficiency-5, coherence-7)*
- **Inference (Level 2, in explicit Recall only):** schema-as-prior over a bounded curated neighborhood. **Multi-hop composition deferred.** Output is **ephemeral, tagged `inferred`, never written back** — so there is no self-confirmation surface in v1. (When persistence is added later, gate it on provenance-DAG-disjoint independent confirmation.) `[REVISED]`

---

## 7. Level-3 seams (interfaces only — zero Level-3 code in v1)

- **`ModelProvider`** split into separable `generate` / `embed` / `judge` so a LoRA on the judge head doesn't force re-embedding the whole store. `[REVISED: seam-4]`
- **`ConsolidationSink`** — generic event stream of schemas, resolved facts, and every confirm/contradict event, each with **stable record id + schema_version** (reproducible training snapshot). `[NEW: seam-1]`
- **`training_eligible`** derived flag on nodes (origin + confidence + not-tombstoned) — the corpus filter. `[NEW: seam-2]`
- **Eval-snapshot** capability: record `query → expected-answer` pairs so a model/LoRA swap can be regression-checked. `[NEW: seam-3]`
- **Provenance + confidence** first-class (already in the data model).

---

## 8. Concurrency & cold-start

- **Single-writer model:** online paths are read-only on the graph and append-only on episodes; **only the offline sleep pass mutates the graph.** This removes the online/offline race by construction (the session-end trigger can't interleave a mutation). `[NEW: correctness-6]`
- **Crash-safety:** the sleep pass is idempotent (value_hash-keyed updates, checkpoint cursor); a killed pass resumes without double-applying strength increments. `[NEW: correctness-4]`
- **Cold-start:** bulk-consolidate existing `MEMORY.md` / `CLAUDE.md` as `origin=asserted_by_user` facts **before** the gate goes live, so novelty has a baseline and inference has substrate. `[NEW: correctness-5]`

---

## 9. v1 cut line

**In v1:** episodic store · tag-don't-drop allocation gate (heuristic + allowlist) · graph + embeddings-on-nodes (no ANN index) · consolidation with batched PE judge (typed-slot-first) · three-way update with **tombstone-default reconcile** + contradiction counter + oscillation guard · lazy decay + eviction predicate · abstraction (schema induction) · **inference = schema-prior, ephemeral** · provenance/origin enforcement · single-writer + cold-start seed · Level-3 seams (interfaces) · invariant test.

**Deferred to v1.1+:** confidence-tiered in-place rewrite (pending the OPEN ruling) · multi-hop LLM composition · ANN index · synaptic-scaling normalization · episodic TTL · inferred-fact write-back (with DAG-disjoint confirmation) · actual Level-3 training.

**Two differentiators preserved:** the allocation gate (what's worth storing, before the write) and PE-gated reconsolidation (the three-way update). Everything else is as simple as the foundation allows.

**The staged upgrade path for every cut/deferred item — with build-triggers and the seam each plugs into — is in [`recense-roadmap.md`](./recense-roadmap.md).** Each upgrade is a layer on a v1 seam, never a rewrite.

---

## 10. Open questions for the founder

1. **§0 update model:** tombstone-always-v1 (this spec) vs your original confidence-tiered hybrid — your ruling.
2. **Stack:** SQLite + a Node/TS engine wrapping your existing Claude Code hooks (closest to `contextscope`), or Python? (Affects the implementation plan, not the design.)
3. **λ, η, N, thresholds:** all calibrated against your real MEMORY.md cadence during build, not guessed up front.
