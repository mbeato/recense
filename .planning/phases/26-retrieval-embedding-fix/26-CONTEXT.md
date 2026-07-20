# Phase 26: Belief-Correction / Duplicate-Fact Fix - Context

**Gathered:** 2026-06-18 (RE-SCOPED after diagnosis — supersedes the original embedder-swap context)
**Status:** Ready for planning
**Mode:** re-scoped by orchestrator from 3 read-only diagnoses + founder approval

<domain>
## Phase Boundary

Fix the **duplicate-fact / belief-correction-incomplete symptom**: contradicting and
restated claims mint a SECOND node instead of reconciling with the existing belief (→ dupes
accumulate, tombstones stay near zero). Diagnosis (RETR-01, DONE) localized the bug to the
**consolidation judge verdict + PE-resistance contradiction routing** — it is NOT
embedder-bound and NOT cosine-threshold-bound.

**In scope:** a (cost-gated) judge-replay to split the failure (judge-misclassify vs
PE-routing-escape); the fix in the identified path (`consolidator.ts` judge handling and/or
PE routing constants in `config.ts:269-293`); validation on the reused extraction-replay
harness; a fact-level dedup/reconciliation pass for residual real duplicate fact nodes.

**Out of scope (falsified / deferred):** the embedder swap to `text-embedding-3-large`, the
full re-embed, and the ~$3–5 paid replay (premise falsified — see diagnoses); changing the
0.7 `deletedSimilarityThreshold` or `unrelatedSimilarityThreshold` (cosine retune buys ~0);
cleaning up the ~747 `claude-headless` self-ingestion polluted episodes (separate known TODO,
but the dedup pass must EXCLUDE pollution from its "real duplicate" set).

</domain>

<decisions>
## Implementation Decisions

Derived from the three diagnoses (`26-DIAGNOSIS-V{1,2,3}.md`) and founder-approved re-scope.

### Root cause is settled — fix the judge/PE path, not retrieval (→ RETR-01 DONE)
- **D-01:** The reconsolidation cue is the raw extracted `claim.value` → `topk(candidateK=5)`
  (`consolidator.ts:485-515`); the mint-dup-vs-reach-judge gate is `unrelatedSimilarityThreshold`
  0.3 (`consolidator.ts:583-586`). 152 near-dup minted pairs ALL cleared 0.3 (top-30 mean
  cos 0.81). The bug is post-retrieval: judge verdict and/or PE routing. Do not pursue the
  embedder swap or a cosine retune.

### Isolate before fixing (→ RETR-02)
- **D-02:** First run a **judge-replay** over the ~30 surfaced near-duplicate claim/candidate
  pairs: run the live judge, read verdicts, and split the failure into (a) judge misclassifies
  a same-belief restatement (returns `unrelated`/`extend` instead of `confirm`/`contradict`)
  vs (b) judge returns `contradict` but PE routing (`routeContradiction`, `peReconcileBand*`,
  `peAppendNewMinResistance`) escapes to `append-new`/`hold`. The fix targets whichever path(s)
  the replay implicates — do not fix blind.
- **D-03:** The judge-replay uses LLM-judge calls — **cost-gated**: default to the free local
  judge stack; if using a headless/API judge, quote cost + get approval first, and run under
  `--setting-sources project` to avoid the self-ingestion hook loop ([[claude-headless-self-ingestion-loop]]).

### Validate on the reused harness (→ RETR-02)
- **D-04:** Build/reuse the extraction-replay KU harness (`scripts/eval/replay-ku-harness.cjs`
  — the old 26-02 plan specced it but it was never executed, so it must be built). It is
  embedder-agnostic and survives the re-scope as the validation tool. Acceptance: EVAL-02
  belief-correction does NOT regress below **84.6%**, AND duplicate-minting on the surfaced
  failure set is measurably reduced (the real signal — fewer dups, more reconciliations).

### Residual cleanup (→ RETR-03)
- **D-05:** A **fact-level** dedup/reconciliation pass (Phase 25 entity-dedup engine analog,
  fact nodes this time) collapses residual real duplicate fact nodes: tombstone (never delete)
  the losers, rewire edges, preserve provenance, FK-clean, repeatable. **Exclude known
  self-ingestion pollution** from the "real duplicate" set (do not let `SUBCHECK_OK` / "Task …
  exit code 0" artifacts inflate the count). Reuse Phase 25's `EntityDedup` machinery where it
  generalizes.

### Engine invariants (load-bearing, unchanged)
- **D-06:** Graph is source of truth, vector is derived cache; never delete an evidence-backed
  fact (tombstone only); never let inferred output strengthen a fact. The fix must not weaken
  these.

### Claude's Discretion
- Exact judge-replay harness shape; whether the fix is a judge-prompt change, a PE-routing
  constant retune, or both (driven by D-02's result); how much of Phase 25's `EntityDedup`
  generalizes to fact nodes vs needs a fact-specific variant.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Diagnoses (the research for this phase — read first)
- `.planning/phases/26-retrieval-embedding-fix/26-DIAGNOSIS-V3.md` — the decisive one: real
  consolidation flow grounded in code, band distributions, why it's judge/PE not threshold.
- `26-DIAGNOSIS-V2.md` (rules out embedder), `26-DIAGNOSIS-V1.md` (the invalid-pairs lesson).
- `scripts/eval/diagnose-claim-path-v3.cjs` (+ v1/v2) — the read-only probes; reuse their
  DB-open / NN-scan / embedder patterns.

### The code being fixed
- `src/consolidation/consolidator.ts` §485-622 (claim embed → topk → cosine gate → judge),
  §854-873 (mint new node), §896-902 (`routeContradiction` / PE resistance).
- `src/lib/config.ts` §257-293 — `unrelatedSimilarityThreshold` (0.3, the real gate),
  `peReconcileBandLow/High`, `peAppendNewMinResistance`, and the documented failure-class
  comment ("every contradiction produces a duplicate, belief-correction never completes").
- `src/model/judge.ts` — the judge prompt / verdict schema (confirm/extend/unrelated/contradict).
- `src/retrieval/topk.ts` §97-99 — candidate scan (tombstoned=0).

### Validation + dedup reuse
- `scripts/eval/replay-ku-harness.cjs` — to build (was specced in the now-superseded
  26-02-PLAN.superseded.md; that file documents the intended harness shape).
- `src/consolidation/` EntityDedup engine from Phase 25 (clustering, FK-safe edge rewire,
  tombstone, provenance) — generalize to fact nodes for RETR-03.
- Memory: [[cosine-weakness-threshold-not-embedder]], [[judge-must-be-empirically-validated]],
  [[reconsolidation-underperforms-eval]], [[recense-headless-judge-spike-and-billing]],
  [[claude-headless-self-ingestion-loop]], [[recense-db-path-canonical]].

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- Phase 25 `EntityDedup` engine (clustering + FK-safe rewire + tombstone + provenance) → the
  RETR-03 fact-dedup analog.
- The v1/v2/v3 diagnosis scripts (live-DB read-only open, NN cosine scan reusing stored
  vectors, OpenAIEmbedder usage) → the judge-replay harness can reuse these patterns.
- The judge provider seam (local 35b / DeepSeek / headless) already exists — the judge-replay
  picks a validated judge.

### Established Patterns
- Consolidation is single-writer offline; the cosine gate at `unrelatedSimilarityThreshold`
  is the candidate admission, the judge is the verdict, PE-resistance is the routing.
- Tombstone (not delete) + `prev_value` carry is the universal supersede idiom.

### Integration Points
- The fix lands in the offline consolidation/sleep-pass path, not the online recall path.
- Validation runs through the replay harness, not the live engine, until proven.

</code_context>

<specifics>
## Specific Ideas

- The 152 near-dup count is INFLATED by `claude-headless` self-ingestion artifacts and this
  session's own ingested diagnosis text — the true residual-dup count is lower. Filter before
  acting on RETR-03.
- Concrete RETR-02 signal: on the surfaced failure set, same-belief restatements should move
  from "two nodes" to "one node + tombstoned prior," and EVAL-02 must hold ≥84.6%.

</specifics>

<deferred>
## Deferred Ideas

- Embedder swap to `text-embedding-3-large` / re-embed / paid replay — falsified premise,
  retired (old 26-03/26-04 plans `.superseded`).
- Cosine-threshold retuning — buys ~0, not pursued.
- Cleaning up the ~747 `claude-headless` self-ingestion polluted episodes — separate known
  TODO; this phase only excludes them from the dedup set.

</deferred>

---

*Phase: 26-retrieval-embedding-fix (re-scoped to belief-correction / duplicate-fact fix)*
*Context re-scoped: 2026-06-18*
