---
phase: 40-competitive-benchmark-baseline
plan: 04
subsystem: eval
tags: [benchmark, latency-curve, competitor-targets, bench-02, bench-03, wave-3]
dependency_graph:
  requires:
    - scripts/eval/locomo-harness.cjs (40-02)
    - scripts/eval/fixtures/locomo-mini.json (40-01)
  provides:
    - scripts/eval/latency-curve.cjs
    - scripts/eval/fixtures/locomo-node-pool.json
    - .planning/phases/40-competitive-benchmark-baseline/40-COMPETITOR-TARGETS.md
    - tests/locomo-latency-curve.test.ts
  affects:
    - scripts/eval/results/latency-curve-N.json (output from full run)
tech_stack:
  added: []
  patterns:
    - Retrieval-only timing: Date.now() wraps only CandidateRetriever.topk() (Pitfall 4)
    - Scratch DB at controlled N: SemanticStore.upsertNode + setEmbedding with random unit vectors
    - Pool cycling: pool[i % pool.length] for N > pool.length
    - percentile(sortedArr, p): ceil-based index (Math.ceil(p/100*len)-1)
    - --quick / --mock-embed: zero-API CI mode (zero-vector queries, no OPENAI_API_KEY needed)
key_files:
  created:
    - scripts/eval/latency-curve.cjs
    - scripts/eval/fixtures/locomo-node-pool.json
    - .planning/phases/40-competitive-benchmark-baseline/40-COMPETITOR-TARGETS.md
    - tests/locomo-latency-curve.test.ts
  modified: []
decisions:
  - "Node pool drawn from locomo-mini.json turn texts + supplemental LoCoMo-derived fact fragments (64 values); locomo10.json absent so plan fallback path used"
  - "Random unit vectors used for node embeddings in scratch DB — cosine scores not meaningful; only scan cost (O(N) × dims) matters for the curve"
  - "Zero-vector queries in --mock-embed/--quick mode — no OPENAI_API_KEY needed; full run embeds real queries via OpenAIEmbedder"
  - "COMPETITOR-TARGETS.md hard-flags Zep 84% as DO NOT CITE; mem0 66.88% named primary comparator; noise floor (6.4% corrupted key + ~63% judge acceptance) documented"
  - "locomo-node-pool.json committed to worktree (node pool is public CC BY-NC content, not private brain data)"
metrics:
  duration: "~25 minutes"
  completed: "2026-06-23"
  tasks_completed: 3
  tasks_total: 3
  files_created: 4
  files_modified: 0
requirements: [BENCH-02, BENCH-03]
---

# Phase 40 Plan 04: Latency Curve (D-06b) + Competitor Targets (BENCH-03)

Latency-vs-N curve for retrieval-only p50/p95 using a public LoCoMo-derived node pool (D-06b, BENCH-02), plus the sourced+methodology-noted competitor target table that bakes in the no-inflated-metrics rule (BENCH-03).

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Export public LoCoMo node pool | `2dbbe49` | `scripts/eval/fixtures/locomo-node-pool.json` |
| 2 | latency-curve.cjs — retrieval-only p50/p95 across N | `2dbbe49` | `scripts/eval/latency-curve.cjs` |
| 3 | Competitor-targets methodology note + smoke test | `a6947ba` | `40-COMPETITOR-TARGETS.md`, `tests/locomo-latency-curve.test.ts` |

Note: Tasks 1 and 2 were committed together (the node pool is a direct dependency of the latency-curve script; both were ready simultaneously).

## Key Implementation Details

### Node Pool (Task 1)

Plan preferred approach: export node values from a completed locomo harness scratch DB via `SELECT value FROM node WHERE tombstoned=0 AND embedding IS NOT NULL`. Since `locomo10.json` is not present in the worktree (gitignored, not yet acquired), the plan's documented fallback was used: extract node-shaped value strings from `locomo-mini.json` turn texts and QA answers, supplemented with representative LoCoMo-derived fact fragments that match the length/shape distribution of real consolidation output.

- 64 unique string values (> 50 minimum)
- All public LoCoMo CC BY-NC content (conv-26, Caroline/Melanie conversation from locomo-mini.json)
- No private brain data

### latency-curve.cjs (Task 2)

```
for each N in N_LIST:
  makeScratchDb()                          ← fresh tmpdir DB per N (T-14-DB)
  SemanticStore.upsertNode × N             ← pool values cycled, index-suffixed for uniqueness
  SemanticStore.setEmbedding × N           ← random unit vectors (scan cost, not cosine quality)
  CandidateRetriever(scratch.db)
  for each queryVec in queryVectors:
    t0 = Date.now()
    retriever.topk(qVec, K)                ← retrieval-ONLY timing (Pitfall 4)
    ms = Date.now() - t0
  sort(latencies); percentile(50); percentile(95)
  push {n_nodes, p50_ms, p95_ms, samples}

write {meta, curve} → OUT
```

Key: `percentile(sortedArr, p)` uses `Math.ceil(p/100*len)-1` index per PATTERNS §443-446.

Quick/CI mode: `--quick` implies `--mock-embed` (zero-vector queries, no OPENAI_API_KEY).

### Competitor Targets (Task 3, BENCH-03)

`40-COMPETITOR-TARGETS.md` documents:
- **Primary comparator**: mem0 66.88% ± 0.15 (gpt-4o-mini judge, peer-reviewed, 10-run avg)
- **DO NOT CITE**: Zep ~84% LoCoMo (denominator inflation bug, ~25 pt overstating); corrected: ~58.44% ± 0.20
- **MemPalace 96.6%**: raw ChromaDB embedder (all-MiniLM-L6-v2), NOT the palace architecture
- **Noise floor**: 6.4% corrupted answer key + ~62.81% judge acceptance of intentionally wrong but on-topic answers → differences < 5-7 pts are uninterpretable noise
- **Comparison-config mismatches**: recense latency = retrieval-only; mem0 "91% lower" = full answer-gen pipeline; recense tokens = per-write+per-recall; mem0 "90% fewer" = context-tokens-per-query

Smoke test in `tests/locomo-latency-curve.test.ts`: spawnSync `--quick`, asserts exit 0 + `curve[0].p50_ms` + `curve[0].p95_ms` numeric keys.

## Test Results

```
Test Files  1 passed (1)
     Tests  1 passed (1)
```

latency-curve --quick: N=200, 2 queries, mock-embed → p50=1ms p95=2ms samples=2 (exit 0).

## Artifact Sizes

| Artifact | Lines | Min Required |
|----------|-------|-------------|
| scripts/eval/latency-curve.cjs | 327 | 120 |
| scripts/eval/fixtures/locomo-node-pool.json | 65 | ≥50 values |
| 40-COMPETITOR-TARGETS.md | ~200 | contains DO NOT CITE, 66.88, 58.44, embedder |
| tests/locomo-latency-curve.test.ts | ~90 | — |

## Deviations from Plan

### Node Pool Generation Path (Rule 3 — Fallback)

- **Found during:** Task 1
- **Issue:** `locomo10.json` is gitignored and not present in the worktree (it must be acquired separately from github.com/snap-research/locomo). The plan's preferred approach (export from a completed scratch DB via SELECT) requires running the locomo harness first with `--keep-dbs`, which is a paid operation.
- **Fix:** Used the plan's explicitly documented fallback: extracted node-shaped value strings from `locomo-mini.json` turn texts and QA answers, supplemented with representative LoCoMo fact-shaped strings. The pool only needs a realistic length/shape distribution for the latency curve.
- **Impact:** None — the pool contains 64 public LoCoMo-derived strings (> 50 minimum), no private content, and the latency curve uses random unit vectors for embeddings anyway (measuring scan cost, not retrieval quality).
- **Files modified:** `scripts/eval/fixtures/locomo-node-pool.json`

## Known Stubs

None — all deliverables are complete for their defined scope. The full latency-curve run (real N values 1K–20K with real OpenAI embeddings) requires `OPENAI_API_KEY` and is gated by omitting `--mock-embed`. Plan 40-05 owns the official full run.

## Threat Flags

None — all T-40-09/10/SC mitigations implemented:
- T-40-09 (private data leak): node pool contains only public CC BY-NC LoCoMo text from locomo-mini.json
- T-40-10 (inflated metrics): DO NOT CITE flag on Zep 84%, mem0 66.88% as primary comparator, noise floor documented
- T-40-SC (package install): no new packages

## Self-Check: PASSED

- [x] `scripts/eval/latency-curve.cjs` exists (327 lines, > 120 min)
- [x] `scripts/eval/fixtures/locomo-node-pool.json` exists (64 values, all strings, > 50 min)
- [x] `node scripts/eval/latency-curve.cjs --quick` exits 0, emits p50/p95 curve
- [x] `40-COMPETITOR-TARGETS.md` contains DO NOT CITE, 66.88, 58.44, and embedder caveat
- [x] `npx vitest run tests/locomo-latency-curve.test.ts` → 1 passed
- [x] Commits verified: `2dbbe49` (pool + latency-curve), `a6947ba` (competitor targets + smoke test)
