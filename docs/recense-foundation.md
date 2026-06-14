# Recense Foundation

A faithful, citation-backed model of how the human brain forms, stores, strengthens, retrieves, updates, and forgets memories — assembled as the research foundation for a brain-inspired AI agent-memory engine.

**Created:** 2026-06-05
**Status:** Research foundation (pre-architecture). This document is the substrate the engine design is built on and judged against. It is *not* the architecture spec.
**Method:** Four adversarial deep-research passes (fan-out web search → fetch primary sources → 3-vote adversarial verification → synthesis). ~85 primary/canonical sources fetched; ~95 claims verified across passes.

---

## Confidence legend

Every claim below carries its provenance. Do not treat them as equivalent.

| Mark | Meaning |
|------|---------|
| ✅✅ | **Verified 3-0** this session against primary literature (unanimous adversarial pass) |
| ✅ | **Verified, medium confidence** — real but contested, replication-fragile, or paradigm-bound |
| 📖 | **Canonical literature, NOT session-verified** — textbook-stable, standard citations, stated from established knowledge (applies to the CLS/replay section, which the verifier structurally under-selected three times) |
| 🔶 | **Interpretive AI-mapping** — the founder's translation task, derived from verified biology but not itself an empirical finding |
| ❌ | **Refuted** in verification — do NOT build on these |

---

## The five mechanisms → one architecture

The brain's memory system, faithfully, is **six** mechanisms across **five** areas. Each section states the biology (cited), the closest AI/ML primitive, and **where the metaphor breaks** — the last is the most important part, because that is where naive "brain-inspired" designs fail.

---

### 1. Encoding — how an experience becomes a trace

**Biology**
- **An engram is a sparse population of cells** meeting three operational criteria: activated by the experience, physically/chemically modified by it, and reactivable to drive recall. Optogenetically reactivating fear-tagged cells in a *never-shocked* context drives the conditioned response — proving reactivation is **causally sufficient**, not merely correlated. ✅✅ *(Liu/Ramirez/Tonegawa 2012, Nature 484:381; Josselyn & Tonegawa 2020, Science 367:eaaw4325)*
- **Allocation is competitive and set by intrinsic excitability (CREB), separately from synaptic weights.** More-excitable neurons win recruitment; CREB-deficient neurons are excluded. Ensembles can be bound by excitability **with no new synapses**. So *which units store a memory* is decided by a fast, content-independent bias **before** any weight update. ✅✅ *(Han 2007/09; Yiu 2014; Guskjolen & Cembrowski 2023)*
- **The hippocampus does two opposite computations.** Dentate gyrus performs **pattern separation** (sparse, decorrelated, orthogonalized codes so similar memories don't collide). CA3 performs **pattern completion** — a recurrent autoassociative attractor that rebuilds a whole episode from a partial cue. As few as **two** stimulated neurons can complete a full ensemble. ✅✅ *(Rolls 2013; Santoro 2013; Neunuebel & Knierim 2014; Carrillo-Reid 2019)*
- **CA3 capacity is analytic:** retrievable patterns scale ~linearly with recurrent synapses and ~**1/sparseness** — sparser codes store more. ✅✅ *(Treves & Rolls 1990/91)*

**→ AI/ML primitive** 🔶
- Engram = content-addressable memory item → Hopfield / modern-Hopfield (= attention) attractor states; keyed item embeddings.
- DG pattern separation = sparse, high-dimensional decorrelating projection → LSH, sparse autoencoder, expansion-recoding.
- CA3 pattern completion = associative recall from a fragment → nearest-neighbor / attention retrieval.
- **The non-obvious lesson:** *separate "which slot stores this memory" (a fast salience/routing gate — MoE-style) from "the write itself."* Standard ML conflates them; biology splits allocation (excitability) from consolidation (synaptic).

**Where it breaks**
- Biological engrams are durable physical changes in *specific cells*, not rows in one weight matrix.
- Pattern separation is **inter-regional** — you cannot call a layer a "separator" from its output statistics alone; you must measure input-vs-output similarity. ✅✅
- The 1/sparseness capacity law assumes sparse binary-ish codes; real embeddings are dense and continuous, so it's a design heuristic, not a transferable constant.

---

### 2. Plasticity — the real strengthening rule (your "edges strengthen with use")

**Biology**
- **STDP is the causal form of Hebb:** pre-before-post spiking → potentiation (LTP); post-before-pre → depression (LTD); effect decays ~exponentially over tens of ms. ✅✅ *(Bi & Poo 1998; Markram 1997; Abbott & Nelson 2000)*
- **Naive "fire together wire together" is provably unstable.** It's positive feedback: strong synapses get stronger and drive firing to saturation or zero. **Stability requires homeostatic synaptic scaling** — multiplicative AMPA-receptor adjustment that preserves relative weights while bounding total activity. ✅✅ *(Turrigiano 1998/2008; Abbott & Nelson 2000)*

**→ AI/ML primitive** 🔶
- STDP = causal, asymmetric, eligibility-trace-style association.
- Synaptic scaling = **normalization** (LayerNorm / weight-norm / Oja's rule with its decay term) and continual-learning stability regularizers.
- **The hard lesson for this engine:** *any Hebbian edge-strengthening rule MUST be paired with a decay/normalization term, or it saturates.* This is the single most important constraint on your "strengthen frequently-used graph edges" idea.

**Where it breaks**
- Synaptic scaling is multiplicative and operates on a *slower timescale* than the fast Hebbian change (two-timescale separation); naive global normalization in ML doesn't mirror this.
- ❌ **Do not build on:** "STDP alone solves stability without homeostasis" (refuted 1-2). You need the normalizer.

---

### 3. Myelination — your "myelinate the frequent path" idea (REFRAMED)

This is the mechanism you led with. The research **productively overturns it.**

**Biology**
- Neuronal activity acutely triggers oligodendrocyte-precursor proliferation and new-oligodendrocyte differentiation (4× OPC proliferation within 3h of stimulation; differentiation within 2.5–4h; thicker myelin by ~4 weeks). And it is **causally required** for motor-skill learning — block new oligodendrocytes and the behavioral gain disappears. ✅✅ *(Gibson/Monje 2014, Science 344:1252304; McKenzie 2014, Science 346:318; Fields 2015, NRN)*
- **But "frequently-used paths get faster" is a verified oversimplification.** ✅✅ What's tuned is **spike-time arrival coordination and oscillatory synchrony** — making signals from different paths *arrive together* (isochronicity), via per-pathway myelin geometry (internode length, sheath thickness). **"Faster is not always better."** A 10% conduction-velocity change shifts timing 1–4 ms — enough to flip oscillatory coupling constructive↔destructive. Experience can even *slow* conduction (deprivation cut optic-nerve CV ~22%). ✅✅ *(Pajevic/Basser/Fields 2014; Salami 2003; Etxeberria 2016)*
- **Critically: myelination is a SEPARATE axis from synaptic plasticity.** It changes conduction *latency*, not connection *strength*. ✅✅

**→ AI/ML primitive** 🔶 (medium confidence — interpretive)
- The right analog is **NOT edge-weight strengthening** (that's §2, a different axis). It's **latency/throughput optimization on hot paths** — caching / precompute / JIT a frequently-traversed query path — *without changing connectivity or weights.*

**Where it breaks (and the design consequence)**
- The biological *goal* is cross-path timing **coordination** (arrival synchrony at a join node), not minimizing per-path latency. A non-spiking retrieval-based memory store has **no spike timing to coordinate** — so the deep mechanism doesn't transfer.
- **Design consequence:** myelination is the *least* transferable of the three headline ideas. In a retrieval engine the faithful translation is mundane — *cache/precompute hot query paths.* **Recommendation (decide at architecture time): do NOT make "myelination" a first-class concept in v1.** Fold it into a hot-path cache and spend the novelty budget on consolidation + reconsolidation. Finding this *before* building a "myelination subsystem" that was really just a cache is the entire point of doing the research first.

---

### 4. Consolidation — short → long term, and the two-store spine (CLS)

**Biology (verified)**
- **Systems consolidation physically moves a memory** hippocampus → cortex over ~2 weeks. The cortical (mPFC) engram is *created at training but silent*, and matures only via **offline hippocampal reactivation/replay**. Block the replay during consolidation and the cortical memory never matures. ✅✅ *(Kitamura 2017, Science 356:73; Tonegawa lab 2018, NRN)*

**CLS theory & replay (canonical, not session-verified)** 📖
- **Complementary Learning Systems (CLS)** — *McClelland, McNaughton & O'Reilly 1995, Psychological Review 102:419.* The brain needs **two** learners: a **fast hippocampal** system (sparse, one-shot, pattern-separated) and a **slow neocortical** system (overlapping, generalizing). If the slow system learned each new item immediately, it would suffer **catastrophic interference** — new learning overwrites old. The fix is **interleaved replay**: the fast store replays stored episodes to the slow store, interleaving new with old so the slow store integrates without forgetting.
- **Updated CLS** — *Kumaran, Hassabis & McClelland 2016, Trends Cogn Sci 20:512.* Replay need not be uniform; **prioritized/weighted replay** of surprising or goal-relevant experiences accelerates integration. This paper explicitly bridges to AI agents.
- **Hippocampal replay** — *Wilson & McNaughton 1994, Science 265:676.* During sleep, place-cell ensembles reactivate the same sequences fired during waking experience. Replay is **time-compressed** (~10–20×), occurs in **sharp-wave ripples**, and is **forward and reverse** ordered (reverse replay concentrates at reward).

**→ AI/ML primitive**
- This *is* **experience replay** — *Lin 1992; Mnih et al. 2015 (DQN, Nature 518:529)* — a buffer of past experiences replayed to train a slow function approximator without forgetting. 📖
- **Prioritized experience replay** — *Schaul et al. 2016, ICLR (arXiv:1511.05952)* — replay high-TD-error (surprising) transitions more often. The direct ML analog of salience-weighted ripple replay. 📖
- **Generative replay** — *Shin et al. 2017 (arXiv:1705.08690)* — a generator replays synthetic past samples for continual learning without storing raw data. 📖
- **Your two-store design (fast episodic + slow semantic graph) is the literal neuroscience.** The consolidation "sleep pass" = replaying episodic memories to distill them into the semantic store.

**Where it breaks (the most important caveat for YOUR engine)** 🔶
- **Catastrophic interference is a property of *gradient-trained nets*, not symbolic stores.** If your slow store is a **knowledge graph** (not a neural net), adding a new fact does *not* silently corrupt old facts — so the core problem CLS exists to solve **may not even apply to you.** This means: you likely need replay for *distillation/abstraction* (turning many episodes into a general fact) — **not** to prevent catastrophic forgetting.
- Consequence: you probably do **not** need to faithfully mimic compressed/reverse/ripple-timed replay. **Prioritized replay** (consolidate surprising/important episodes first) is worth keeping; the rest of the ripple machinery is likely solving a problem you don't have. *(This is a design hypothesis to validate, not settled fact.)*

---

### 5. Retrieval, forgetting & updating

**Retrieval & forgetting (verified)**
- **Retrieval is "ecphory": a cue × stored-trace interaction, not a lookup.** A memory can be **available but inaccessible** — present in storage, unreachable by the current cue. ✅✅ *(Frankland/Josselyn/Köhler 2019; Tulving & Thomson 1973)*
- **Most forgetting is retrieval failure, not erasure** — "lost" memories persist as **silent engrams**, recoverable by direct reactivation. Separately, **active forgetting** is a real regulated deletion process (microglial synapse pruning, neurogenesis). ✅✅ *(Ryan 2015; Roy 2017; Wang 2020)*

**→ AI/ML primitive** 🔶
- Retrieval = query-key overlap (RAG / nearest-neighbor / attention).
- **The engine must distinguish "can't reach it" (index/embedding drift — retrieval failure) from "deleted it" (eviction).** Different bugs, different fixes.
- Active forgetting = deliberate eviction/pruning policy (LRU, scheduled deletion, sparsification) — *not* passive decay.

**Updating — RECONSOLIDATION (your staleness fix)**

This is the biological answer to "update a fact when it changes instead of duplicating it." It is **subtler than "overwrite."**

**Biology (verified)**
- **Reconsolidation exists and is in-place:** a consolidated memory, when **reactivated by retrieval**, returns to a transiently **labile, protein-synthesis-dependent** state; new info integrates into the *existing* trace. Retrieval is the trigger; the window is bounded (~<6h in the canonical paradigm — *illustrative, not a universal constant*). ✅✅ *(Nader, Schafe & LeDoux 2000, Nature 406:722)*
- **The update is selective to the reactivated trace** — only the reactivated memory changes, not matched controls. ✅ (medium — human/behavioral replication is fragile) *(Schiller et al. 2010, Nature 463:49)*
- **Prediction error is the gate** — necessary but insufficient. No mismatch → no destabilization → no rewrite. ✅✅ *(Sevenster, Beckers & Kindt 2014, Learn Mem 21:580)*
- **It's an inverted-U → THREE outcomes, not two:** too little PE = **no-op** (leave the memory); right amount = **reconsolidate/rewrite in place**; *too much* PE = **form a NEW trace** (append). A naive monotonic "more conflict → more overwrite" rule misreads the biology. ✅ (medium — integers are paradigm-bound) *(Sevenster 2014)*
- **The PE threshold scales with memory strength:** stronger/more-corroborated memories need larger or repeated contradiction to destabilize. ✅✅ *(Chen et al. 2020, Front Behav Neurosci 14:598924)*

**→ AI/ML primitive** 🔶
- **PE-gated retrieve-modify-rewrite transaction.** On new info: retrieve the relevant stored memory, compute mismatch (prediction error) against the stored value, and branch on the inverted-U:
  - mismatch ≈ 0 → **no-op** (optionally reinforce/strengthen).
  - mismatch moderate → **rewrite in place** (reconcile the node/embedding).
  - mismatch extreme → **append a new memory** (the new info is a different thing, not a correction).
- **Scale the rewrite threshold by the stored fact's strength/confidence:** weakly-held value flips on small contradiction; strongly-corroborated value requires repeated independent contradiction. This is a confidence-weighted write policy.

**Where it breaks (a real architecture fork)**
- The **human/behavioral overwrite effect is replication-fragile** (Schiller/Monfils failed several registered replications); only the **rodent molecular** finding (Nader) is rock-solid. Reconsolidation is also *fear/emotional-conditioning* biology — generalization to arbitrary declarative facts is an analogy, not proven.
- **Design fork:** the fragility argues that **true in-place rewrite may be too destructive.** A safer engineering model is **append-and-supersede (tombstone):** keep the old value, mark it superseded, deprioritize it in retrieval — you get "the current answer is X" without irreversibly destroying history. **This is a decision for the architect (you), flagged explicitly.** Biology weakly favors in-place; software reliability weakly favors tombstoning. The answer may be a hybrid (in-place for low-stakes/high-confidence corrections, tombstone for high-stakes ones).

---

## Master mapping table: biological mechanism → AI/ML primitive

| # | Biological mechanism | Closest AI/ML primitive | Keep in v1? | Where it breaks |
|---|---|---|---|---|
| 1a | Engram (content-addressable trace) | Keyed embedding / Hopfield attractor item | ✅ core | not a row in one weight matrix; distributed |
| 1b | Excitability-based **allocation** (separate from weights) | Salience/routing gate deciding *which slot* writes (MoE-style) | ✅ — the non-obvious win | ML usually conflates allocation with the write |
| 1c | DG **pattern separation** | Sparse decorrelating projection (LSH / sparse AE) | ✅ to reduce collisions | inter-regional metric; not from outputs alone |
| 1d | CA3 **pattern completion** | Associative / attention retrieval from a fragment | ✅ core retrieval | dense embeddings ≠ sparse attractor capacity law |
| 2a | STDP (causal Hebbian) | Asymmetric / eligibility-trace association | ✅ edge weighting | real windows non-exponential, not pairwise |
| 2b | **Homeostatic synaptic scaling** | Normalization / weight decay on the Hebbian rule | ✅ **mandatory** | two-timescale separation not mirrored |
| 3 | Activity-dependent **myelination** | Hot-path **cache / precompute** (latency, not weight) | 🔶 **demote to cache, not a memory concept** | goal is timing *coordination*; no spike-timing in a retrieval store |
| 4a | Systems consolidation (hippo→cortex) | Two-store: fast episodic buffer → slow semantic store | ✅ **the spine** | — |
| 4b | Replay (compressed/reverse/prioritized) | Experience replay; **prioritized** replay (Schaul); generative replay | ✅ prioritized; ⚠️ skip ripple-faithfulness | catastrophic interference may not apply to a *symbolic* store |
| 5a | Ecphory / availability vs accessibility | Query-key retrieval; distinguish "unreachable" vs "deleted" | ✅ | dynamical attractor settling, not deterministic lookup |
| 5b | Active forgetting | Eviction/pruning policy (LRU, scheduled, sparsify) | ✅ | gated by cell-biology with no clean ML counterpart |
| 5c | **Reconsolidation** (PE-gated in-place update) | PE-gated retrieve-modify-rewrite; inverted-U (no-op / rewrite / append); confidence-scaled threshold | ✅ **the staleness fix** | human effect fragile; consider tombstone vs in-place |

---

## Design commitments this research establishes

These are the through-lines the engine should honor (subject to architecture-phase decisions):

1. **Two stores, not three.** Fast episodic + slow semantic. The LLM **context window is working memory** — don't rebuild it. (Consolidation §4 is the spine.)
2. **Separate allocation from writing.** A salience gate decides *what is worth storing and where* before any write. (§1b — the most under-used idea in existing memory systems.)
3. **Every strengthening rule needs a decay/normalization partner.** Non-negotiable, or edge weights saturate. (§2b)
4. **Updating is PE-gated and three-way, not overwrite.** No-op / rewrite-in-place / append-new, thresholded by stored-fact confidence. This is the differentiated core. (§5c)
5. **Demote myelination to a cache.** It's a latency optimization, not a memory mechanism. (§3)
6. **Prioritized replay for distillation, not anti-forgetting.** If the slow store is a graph, catastrophic interference may not apply — replay's job is abstraction, not protection. (§4b)
7. **Distinguish "unreachable" from "deleted."** Two different failure modes with two different fixes. (§5a)

---

## Myths to avoid (verified)

- ❌ "Fire together wire together" *alone* — incomplete; omits homeostatic stability. ✅✅
- ❌ Pattern separation measured from one region's output — it's inter-regional. ✅✅
- ❌ Forgetting = passive decay of a fading trace — it's retrieval failure + active deletion. ✅✅
- ❌ Engram size is invariant to memory strength (refuted 0-3).
- ❌ "Frequently-used paths just get faster" — myelination tunes *timing coordination*, and can slow conduction. ✅✅
- ❌ Reconsolidation overwrite proven durable for a year (refuted 0-3); PE comes specifically from dopaminergic midbrain (refuted 0-3); retrieval-extinction blocks all relapse forms (refuted 1-2). Do not cite these.

---

## Open questions / gaps to close before or during build

1. **In-place rewrite vs. append-and-supersede (tombstone)** — the §5c fork. Architect's call; may be hybrid.
2. **Concrete PE thresholds & the three-way decision rule** — how to compute "mismatch" between new info and a stored memory, and how thresholds scale with confidence. Needs design + empirical tuning on your own Claude Code memory.
3. **Does catastrophic interference apply to a symbolic graph store?** — determines whether replay is for distillation only. Likely yes-distillation, no-protection; validate.
4. **Myelination AI analog** — is there published work on per-edge *latency* tuning for arrival-synchronization (vs weight learning)? None surfaced; low priority given the demote-to-cache recommendation.
5. **CLS section is canon-not-session-verified** 📖 — if a verification stamp is wanted, run a CLS-only pass (note: the verifier structurally under-selects theoretical claims, so scope it to discrete empirical replay findings).

---

## Source ledger

**Verified primary sources (this session, 3-0 unless noted):**
- Liu/Ramirez/Tonegawa 2012, Nature 484:381 — engram sufficiency
- Josselyn & Tonegawa 2020, Science 367:eaaw4325 — engram criteria (review)
- Han 2007/09; Yiu 2014; Guskjolen & Cembrowski 2023 — excitability allocation
- Rolls 2013; Santoro 2013; Treves & Rolls 1990/91; Neunuebel & Knierim 2014; Carrillo-Reid 2019 — DG/CA3, capacity, completion
- Bi & Poo 1998; Markram 1997; Abbott & Nelson 2000 — STDP
- Turrigiano 1998/2008 — synaptic scaling
- Gibson/Monje 2014, Science 344:1252304; McKenzie 2014, Science 346:318; Fields 2015, NRN; Mount & Monje 2017; Pajevic/Basser/Fields 2014; Salami 2003; Etxeberria 2016 — activity-dependent myelination
- Kitamura 2017, Science 356:73 — systems consolidation
- Frankland/Josselyn/Köhler 2019; Tulving & Thomson 1973; Ryan 2015; Roy 2017; Wang 2020 — retrieval & forgetting
- Nader/Schafe/LeDoux 2000, Nature 406:722 — reconsolidation (robust)
- Schiller 2010, Nature 463:49 (medium — fragile); Sevenster/Beckers/Kindt 2014, Learn Mem 21:580; Chen 2020, Front Behav Neurosci 14:598924 — boundary conditions

**Canonical, not session-verified (CLS/replay):** 📖
- McClelland, McNaughton & O'Reilly 1995, Psych Review 102:419
- Kumaran, Hassabis & McClelland 2016, Trends Cogn Sci 20:512
- Wilson & McNaughton 1994, Science 265:676
- Lin 1992; Mnih et al. 2015, Nature 518:529 (DQN); Schaul et al. 2016, arXiv:1511.05952 (PER); Shin et al. 2017, arXiv:1705.08690 (generative replay)
