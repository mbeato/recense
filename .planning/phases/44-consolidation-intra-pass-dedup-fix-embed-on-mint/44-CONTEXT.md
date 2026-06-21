# Phase 44 — Context (design decided pre-plan)

Origin: Phase 35 (RANK-02) follow-up investigation, 2026-06-21. The RANK-02 "no win" was traced to a degenerate consolidation graph; root cause confirmed and the fix approach decided with the founder. This doc is the discuss-phase artifact — plan-phase should consume it directly.

## Problem (confirmed, with repro)

During ONE consolidation pass, claims that arrive in that pass cannot dedup or contradict each other:
- `topk` scores only nodes `WHERE embedding IS NOT NULL` (`src/retrieval/topk.ts:107`).
- The mint path `upsertNode` writes `embedding=NULL`; embeddings are written ONLY by `setEmbedding` (T-01-DIRTY), which is called by `reembedDirty`.
- `reembedDirty` runs at pass START (`consolidator.ts:460`) and in Phase C AFTER the per-episode judging loop (`:839`) — never when a node is minted mid-loop.
- So every claim in a single pass sees an empty/blind candidate set for its same-pass siblings → mints `'unrelated'` → zero merges, zero contradictions. Once consolidated, episodes are never re-judged, so the duplicates are permanent.

### Where it bites in production
`consolidate()` processes ALL unconsolidated episodes in one pass (`:469` `listUnconsolidated()` → single loop, no chunking). `ingest-project` (v6.0 onboarding) appends a whole survey then consolidates (deferred sleep pass OR `--consolidate`) — one pass swallows the batch. Bulk ingest into a small/empty graph → permanent duplicate islands. This is a real correctness bug in the shipping onboarding path, and it invalidated the Phase 35 RANK-02 eval (uniform strength → no gradient for strength fusion to rank on).

### Evidence / repro tools (committed in Phase 35)
- `scripts/eval/35-pass-proof.cjs` — DEFINITIVE: same contradiction pair → `contra=0` in one batch, `contra=1` (+ tombstone/reconcile) across two passes.
- `scripts/eval/35-candidate-probe.cjs` — ruled out retrieval (mean top-1 cosine ≈0.62; ~99% clear the 0.3 gate; contradiction pairs co-located).
- `scripts/eval/35-judge-probe.cjs` — ruled out the judge (headless/local/anthropic all return `contradict` correctly, single + batch).

## Decision: Option D — embed-on-mint from the already-computed claim vector

The claim's embedding is ALREADY computed in Phase A: `consolidator.ts:609` `const queryVec = claimVecs[claimIdx]` (claims are batch-embedded up front; that's what `topk` searches with). A minted `'unrelated'` node's value == `claim.value`, so `claimVecs[claimIdx]` is the correct embedding for it.

Fix: at mint time, `setEmbedding(newNodeId, claimVecs[claimIdx])` — thread the precomputed vector to the mint site (decision slot → applyDecision) and set the embedding in the Phase B branch.

Why D (vs. the alternatives considered):
- **Not a gamble** (vs. chunked passes / "Option A"): full intra-pass visibility — episode N+1's `topk` sees episode N's minted node. Chunking left same-batch siblings blind.
- **No new API calls** (vs. "Option B" per-episode embed): the vector is already in hand; it's a sync DB write, valid inside the Phase B transaction (no async-boundary violation, T-02-ASYNC preserved).
- **Surgical** (vs. "Option C" two-phase embed-all-then-judge): no judging-logic change, no loop restructure, no O(N²) reconcile/transitivity complexity in the most load-bearing engine code.

## Load-bearing constraints (must hold)
- `setEmbedding` stays the SINGLE writer of `node.embedding` (T-01-DIRTY) — D calls it at mint with a known vector; it does NOT add a second writer.
- No `await` inside the Phase B `db.transaction` (T-02-ASYNC) — the precomputed vector makes the mint-time embed sync.
- `reembedDirty` still handles value-CHANGED nodes (merge/reconcile where node value ≠ claim value).
- RANK-01 dark default (`rankStrengthWeight: 0`) and the incremental multi-pass path must be unchanged (no regression).

## Task 1 (MANDATORY first task): invariant check
Before implementing, confirm nothing downstream relies on minted nodes being `embedding=NULL` until Phase C. Check: `reembedDirty`'s dirty-selection (`WHERE embedded_hash IS NULL`) and any Phase C / schema-induction / eviction step that assumes freshly-minted nodes are unembedded. If something depends on the dirty flag at mint, surface it before proceeding.

## Verification
- Unit/integration: reproduce `35-pass-proof.cjs`'s scenario as a test — same pair in ONE pass now yields `contra=1` (+ tombstone/reconcile), matching the two-pass result.
- Regression: incremental multi-pass behavior unchanged; existing consolidation tests green; `npm run build` clean.
- Embedding doctrine: `setEmbedding` single-writer + T-02-ASYNC assertions still hold.

## Follow-on (SEPARATE phase, not this one)
Re-run the Phase 35 RANK-02 strength-weight sweep on a now-properly-consolidated graph to fairly test strength fusion (the original "no win" is confounded; see `.planning/phases/35-recency-strength-retrieval-ranking/35-02-SUMMARY.md` post-hoc correction).
