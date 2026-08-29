# Bridge-probe eval (graph-aware recall)

Measures associative recall: can retrieval reach a fact that is 2 edges from the query's
seed but shares no words and low cosine with it? Spec: docs/superpowers/specs/2026-08-26-graph-aware-recall-design.md §5.

## One-time setup
1. Snapshot the live DB (never run against it directly):
   `sqlite3 ~/.config/recense/recense.db ".backup scripts/eval/fixtures/bridge-snapshot.db"`
2. Mine probes (gitignored — personal-graph values): `npm run eval:bridge:derive`
3. Review `scripts/eval/cases/bridge-probes.json`, then set `_meta.founder_signoff`.
4. Optional, once: `OPENAI_API_KEY=... node scripts/eval/bridge-harness.cjs --embed-abstention`

## Run
`npm run eval:bridge` → `scripts/eval/results/bridge-<commit>.json` + console table.

Modes: `oracle` (gold seed handed to seed-based arms — propagation quality in isolation),
`e2e` (seeds come from hybrid top-N — the product path). Arms: `cosine`, `hybrid` (graph-off
baseline; every run reports Δ vs it), `typed` (oracle upper bound, null on non-typed paths),
`ppr-exact` (reference / Phase 2 oracle). Phase 2 adds `spread-*` arms in `src/eval/bridge-arms.ts`.

Metrics are retrieval recall only (r@5/10/20, bridge@10, MRR, path-validity when an arm returns
paths, nodes expanded, p50/p95 latency). No LLM, no embedding calls: query vectors are stored seed
embeddings, so the seed is trivially retrievable — the suite measures propagation, not seeding.
Paraphrased-query probes are deferred.

Results files contain node ids and numbers only.
