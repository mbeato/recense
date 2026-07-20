---
phase: 49-scale-data-model-spike
plan: 02-03
artifact: SPIKE-FINDINGS
requirement: [SCALE-01, SCALE-02]
sut_commit: 0bbbe27
date: 2026-06-28
harness: scripts/eval/49-crossover-spike.cjs
results: scripts/eval/results/49-crossover-spike.json (gitignored, local-only)
---

# Phase 49 Scale + Data-Model Spike — Findings

Two open architecture decisions, measured/analyzed before any adoption. A **defer** outcome on
either is an explicitly valid result — the point was to measure and decide, not to adopt.

- **SCALE-01** — at what node scale does the exact flat-buffer cosine index cross over with an
  approximate HNSW ANN? Decided on real numbers from the live brain.
- **SCALE-02** — should the reconsolidation model add bi-temporal validity intervals and/or
  doubly-linked supersedes chains vs the current tombstone-always model? Written recommendation
  with better-sqlite3 migration cost.

---

## SCALE-01 — Exact flat-buffer cosine vs HNSW crossover

Measured over recense's REAL embedding distribution (live brain = **14,079** embedded nodes at run
time), scaled to 25k and 50k by jitter(σ=0.05)+renormalize of real live vectors (anchored on the
unmodified live set — never random vectors, since HNSW recall is distribution-sensitive). The exact
arm uses production `cosineSimF32` as byte-identical ground truth (asserted, Δ=0). Both ANN
candidates **loaded on this machine** (darwin-arm64) and were measured: `hnswlib-node` 3.0.0
(in-process native HNSW — the apples-to-apples counterpart to the in-process exact scan) and
`vectorlite` 0.2.0 (sqlite loadable-extension HNSW — SCALE-01's named primary, measured as a
secondary data point because its numbers include sqlite-extension overhead).

k=10 · 25 real-distribution queries · 3 repeats · HNSW M=16, ef_construction=200, ef_search=64.

| Nodes | exact p50/p95 | hnswlib-node p50/p95 · r@5 · r@10 · build · mem | vectorlite p50/p95 · r@5 · r@10 · build · mem |
|-------|---------------|------------------------------------------------|----------------------------------------------|
| **14,079 (live)** | 18.3 / **19.5 ms** | 0.97 / **1.01 ms** · 1.000* · 1.000* · 34.5 s · ~89 MB | 0.41 / 0.41 ms · 0.952 · 0.960 · 11.7 s · ~90 MB |
| 25,000 | 32.6 / **33.8 ms** | 1.04 / **1.06 ms** · 1.000* · 1.000* · 65.6 s · ~0 MB† | 0.40 / 0.42 ms · 0.952 · 0.960 · 25.2 s · ~159 MB |
| 50,000 | 66.8 / **67.9 ms** | 1.09 / **1.09 ms** · 1.000* · 1.000* · 141.5 s · ~5 MB† | 0.41 / 0.42 ms · 0.936 · 0.944 · 54.0 s · ~315 MB |

`*` **Recall honesty caveat:** the query set is drawn from real corpus vectors, so the exact nearest
neighbor is itself in the index — hnswlib's recall@10 = 1.000 is **self-match-inflated** and
overstates real-world recall on novel embedded text. Treat vectorlite's ~0.94–0.96 (same query set,
ef_search=64) as the more representative recall signal; real recall on out-of-corpus queries would be
somewhat lower for both and is a known measurement limitation of this harness.

`†` **Memory caveat:** `mem` is an approximate `process.memoryUsage().rss` delta around index build.
Native HNSW memory is off-heap and GC noise produces a ~0/negative delta at two rungs — these numbers
are directional, not precise. The honest read is "tens-to-low-hundreds of MB at 14k–50k," not a
load-bearing figure.

**What the numbers say.** The exact cosine scan is **linear in N** (~1.35 ms per 1k nodes): 19.5 ms
p95 at the real 14k scale, ~33.8 ms at 25k, ~67.9 ms at 50k. Both ANN arms are roughly constant-time
(~1 ms hnswlib, ~0.4 ms vectorlite) but carry an expensive **offline build** (hnswlib 35–142 s;
vectorlite 12–54 s). Important framing: this harness times the **index scan loop only** — it excludes
the embed round-trip, the DB BLOB marshal, and graph traversal — so its exact numbers are NOT directly
comparable to the ~45/46 ms Phase-40/41 *full felt-path* warm baseline. It isolates the index's own
contribution; the full path crosses any given budget later than the scan-only crossover.

### Decision (SCALE-01): **NO-GO / DEFER** (defer is a valid, expected outcome)

Per the D-04 gate, ANN is a "go" **only if** the exact index's p95 measurably exceeds the felt-path
budget (Phase-40/41 ≈ 45/46 ms over ~11.3k nodes) at realistic near-term scale **AND** HNSW holds
recall@10 ≥ 0.95. At the **real current scale (14k), the exact scan-only p95 is 19.5 ms — comfortably
under budget**, so the latency condition is not met. The exact flat-buffer index wins on simplicity,
zero new production dependencies, and byte-exact correctness; ANN's ~1 ms query advantage does not buy
anything the system currently needs, and it adds a native dependency + a 35–142 s offline build +
recall risk.

**Crossover point.** The exact scan-only p95 first breaches the ≈45 ms reference at roughly
**N ≈ 33,000 nodes** (linear interpolation between the 25k/33.8 ms and 50k/67.9 ms rungs), and is
~68 ms at 50k. The recall bar (≥ 0.95) *is* satisfiable at those scales (vectorlite ~0.94–0.96 even
with conservative ef_search; tunable higher), so ANN becomes worth revisiting **only past ~30k nodes
of real felt-path pressure** — which the brain (14k, growing slowly) has not reached. ANN therefore
remains a future-requirement *trigger*, not a current adoption.

**Recommended trigger to re-measure:** when the live brain approaches ~30k embedded nodes, or if the
full felt-path warm p95 (not scan-only) is observed to exceed ~40 ms in production. Re-run
`scripts/eval/49-crossover-spike.cjs`; if exact breaches budget at the live scale with ANN recall@10
≥ 0.95 on a *novel-query* set, flip to GO and adopt (vectorlite is the lower-overhead in-process-ish
option; hnswlib-node the pure in-process option).

Real numbers, live brain, read-only. No writes to `~/.config/recense/recense.db` occurred
(`meta.live_db_mtime_unchanged === true` asserted at end of run; vectorlite tables built on tmpdir
copies and removed).

### SCALE-01 follow-up (held-out novel-query recall + ef_search sweep) — verdict revised

The initial sweep's recall was self-match-inflated (queries ∈ corpus). A follow-up probe
(`scripts/eval/49-recall-tuning-probe.cjs`, results `scripts/eval/results/49-recall-tuning.json`,
gitignored) HOLDS OUT 60 real live vectors from the corpus so the exact top-k are genuine distinct
neighbors, then sweeps `ef_search`:

| N | ef_search | recall@5 | recall@10 | hnswlib p95 | exact p95 (ref) |
|---|-----------|----------|-----------|-------------|-----------------|
| 14k | 64 (default) | 0.993 | 0.987 | 1.0 ms | 19.5 ms |
| 14k | 128 | 1.000 | 0.997 | 2.9 ms | 19.5 ms |
| 14k | **256** | 1.000 | **1.000** | **3.0 ms** | 19.5 ms |
| 14k | 512 | 1.000 | 1.000 | 5.6 ms | 19.5 ms |
| 50k | 64 | 0.990 | 0.983 | 1.1 ms | 67.9 ms |
| 50k | 256 | 1.000 | 0.998 | 3.4 ms | 67.9 ms |
| 50k | **512** | 1.000 | **1.000** | **5.8 ms** | 67.9 ms |

**This revises the verdict.** On genuine novel queries HNSW reaches **recall-exact** (recall@10 = 1.000
at 14k/ef=256 and 50k/ef=512) while remaining **6–12× faster** than the exact scan (3.0 ms vs 19.5 ms
at 14k; 5.8 ms vs 67.9 ms at 50k). The approximation/correctness tax is therefore **tunable to zero**
at a still-large latency win — the recall objection that drove the original DEFER does not survive the
held-out measurement.

**Index-maintenance cost (measured, hnswlib M=16 ef_construction=200).** Because the vector index is a
derived cache built in the OFFLINE sleep pass (never on the online write/hot path), the relevant costs
are: full rebuild 34.3 s @14k / 142.8 s @50k (≈2.4–2.9 ms/node); **incremental `addPoint` per new node
p50 2.7 ms / p95 3.3 ms @14k (3.1/4.3 ms @50k)**; persist `writeIndex` 71 ms → 90 MB file @14k (275 ms
→ 316 MB @50k), load `readIndex` 39 ms @14k / 153 ms @50k. Implications: (a) a `remember` adds **no
synchronous cost** — the marginal price is ~3 ms/node, paid offline in the sleep pass; (b) steady state
is load (39 ms) → addPoint each new node (~3 ms) → persist (71 ms), i.e. sub-second per typical pass;
(c) full rebuild is only an OCCASIONAL compaction op (HNSW delete-churn degrades graph quality over
time) — not per pass; (d) the 90 MB persisted index is the SAME size class as today's exact flat-buffer
sidecar (~87 MB = 14k×1536×4 B), so no storage regression and the online cold path stays "load ~90 MB
in ~40 ms." The only delta vs today: the flat sidecar rebuilds in ~ms, so HNSW requires INCREMENTAL
maintenance + occasional compaction rather than rebuild-every-pass — real sleep-pass engineering, but
entirely off the latency-sensitive path.

**Zero-dep "fast exact" alternatives — tested and rejected (probe `scripts/eval/49-fast-exact-probe.cjs`,
results `scripts/eval/results/49-fast-exact.json`, gitignored).** Before accepting a native dependency,
two pure-JS dependency-free ways to speed up the EXACT scan were measured against float32 ground truth
on held-out novel queries:

| N | float32 (baseline) | int8 quantized | rdim-384 | rdim-512 |
|---|--------------------|----------------|----------|----------|
| 14k | 15.9 ms (exact) | 0.995 r@10 · **15.9 ms (no speedup)** | 0.733 r@10 · 4.2 ms | 0.743 r@10 · 5.7 ms |
| 50k | 55.8 ms (exact) | 0.993 r@10 · **56.1 ms (no speedup)** | 0.733 r@10 · 15.2 ms | 0.740 r@10 · 19.6 ms |

Both fail in opposite ways: **int8 keeps recall (~0.99) but gives ZERO speedup** — in pure JS the scan
is arithmetic-bound, not memory-bound, so a narrower type doesn't help the multiply-accumulate loop;
**dimension reduction is ~4× faster but recall collapses to ~0.73** (random projection 1536→384 drops
~27% of true neighbors — unacceptable for a correctness-first memory). Conclusion: **pure JS gives you
recall OR speed, never both.** There is no zero-dep shortcut at recense's scale — which is exactly the
constraint hnswlib's C++ SIMD buys around, and the reason a hand-rolled pure-JS ANN would underperform.

**The genuine "native without fragility" path is WASM, not pure JS.** A small WASM SIMD dot-product
kernel would make the exact scan ~4× faster while keeping exactness + full recall, AND — unlike a
node-gyp addon — a `.wasm` blob needs no compilation on the user's machine and runs in any Node, so it
preserves the "installs everywhere" property the exact index has today. (A WASM HNSW build would add
the log-N win too.) Decision matrix:

| Path | Query latency | Recall | Installs everywhere | Complexity |
|------|---------------|--------|---------------------|------------|
| Stay exact (today) | 16–68 ms | exact | ✅ zero-dep | none |
| Pure-JS fast-exact | no win / recall loss | — | ✅ | wasted |
| **WASM SIMD dot (fast exact)** | **3.2 ms @14k / 11.5 ms @50k (kernel), 7.9/25.7 ms full** | **exact (r@10=1.000)** | ✅ portable | medium |
| WASM HNSW | ~1–5 ms | exact (tuned) | ✅ portable | high |
| native `hnswlib-node` | ~1–5 ms | exact (tuned) | ⚠️ node-gyp fragility | low |

**WASM SIMD measured (probe `scripts/eval/49-wasm-simd-probe.cjs`, results `49-wasm-simd.json`, gitignored).**
A hand-written WAT `f32x4` dot-product kernel (assembled in-process via the pure-JS `wabt` devDep —
measurement only; production ships a prebuilt ~200-byte `.wasm`) vs the scalar JS exact scan, on
held-out novel queries: **kernel ~4.9× faster at both 14k and 50k (15.6→3.2 ms, 56.0→11.5 ms), with
recall@10 = 1.000 exactly** (it is the same dot product, not an approximation). Full per-query speedup
is ~2.5× (19.0→7.9 ms @14k, 68.6→25.7 ms @50k) because the un-accelerated norm-divide + top-k *sort*
now dominate the tail — both trivially optimizable (fold reciprocal-norm into the kernel; partial-select
top-k). Even un-optimized, exact query at 50k is 25.7 ms (under the ~45 ms budget); the conservative
full-path number carries EXACT retrieval to **~85k nodes** under budget (~190k with the tail optimized).

**Final SCALE-01 recommendation (supersedes the earlier DEFER and the ANN-adopt lean): build a WASM
SIMD exact-scan kernel — do NOT adopt an ANN.** It is the only option that is simultaneously faster
(~5× kernel / ~2.5× full, optimizable further), **exactly correct (recall 1.000 — no approximation
surface)**, portable (a prebuilt `.wasm` needs no compilation, preserving "installs everywhere"), and
simplicity-preserving (keeps the flat brute-force — no graph, no index lifecycle, no tombstone-rebuild,
no compaction). It removes scale pressure to ~85k–190k nodes (brain is at ~14k), so HNSW's sub-linear
advantage is only relevant at a six-figure scale recense may never reach. ANN (native or WASM HNSW)
stays a deferred future-requirement trigger for that regime only.

**Corrected SCALE-01 stance:** adopting an HNSW ANN behind the existing `topk.ts` seam is **VIABLE and
recall-safe today** — it is no longer blocked on correctness. The remaining costs are (a) zero
*user-perceived* latency benefit at the current 14k scale (the win is growth headroom; full felt path
~46 ms → ~30 ms is imperceptible at SessionStart), (b) sleep-pass index-build integration (~35 s
full-rebuild @14k / ~142 s @50k, or incremental `addPoint` for new nodes only) plus wiring the
retrieval engine's tombstone/deleted-node Pass-2 (`engine.ts:526`), and (c) a **native dependency**
(`hnswlib-node` node-gyp addon / `vectorlite` platform binary) entering the production install of a
tool meant to be distributed — versus the current zero-dep, universally-installable exact index. The
go/no-go is thus a product/integration judgment (perf headroom vs native-dep install reliability),
**not** a correctness one. If adopted, `ef_search` should be set to the recall-exact knee (≥256 at
14k, ≥512 at 50k) so retrieval quality is byte-equivalent to the exact index.

---

## SCALE-02 — Reconsolidation data-model recommendation

The current model is **tombstone-always** (v1 decision): a contradicted/updated fact is tombstoned and
a new node written; the prior surface is retained on the node itself via `prev_value` / `prev_ts`, with
`pending_contradictions` (JSON array, ≤3 before destabilization) and `tombstoned` flags
(`src/db/schema.ts:50-53`). The two prior-art alternatives:

- **Zep-style bi-temporal validity intervals** — give each fact an *event-time* validity window and a
  *transaction-time* window (e.g. `valid_from` / `valid_to` / `tx_from` / `tx_to`), so the store can
  answer "what did we believe was true, as-of when" and retire a fact by closing its `valid_to` instead
  of tombstoning. Adds temporal point-in-time query power.
- **DCPM-style doubly-linked supersedes chains** — link each fact to the belief it replaced and the one
  that replaced it (`supersedes_id` / `superseded_by_id` + an index), making correction history a
  traversable chain rather than a flat prev_value snapshot. Adds explicit lineage.

### Migration cost (better-sqlite3 schema delta)

This codebase has two well-established migration cost shapes:

1. **Additive nullable `ALTER TABLE ADD COLUMN` — O(1), metadata-only.** SQLite records a new nullable
   column without rewriting existing rows; no backfill, no data loss (e.g.
   `ALTER TABLE episode ADD COLUMN external_id TEXT`, `schema.ts:232`; guarded by a `PRAGMA table_info`
   existence check, `schema.ts:222-235`). Cost is independent of the ~14k node count.
2. **CHECK-constraint change or constrained/typed reshape — full table recreation.** SQLite cannot
   `ALTER` a CHECK or drop a constraint, so the column set is rebuilt via the `node_v11` pattern
   (`CREATE TABLE node_v11 (...)` → `INSERT INTO node_v11 SELECT * FROM node` → `DROP` → `RENAME`,
   `schema.ts:399-418`), which **rewrites all ~14k node rows AND must re-create every node-referencing
   index plus rebuild the `node_fts` FTS5 virtual table and its triggers**, wrapped in an explicit
   `BEGIN/COMMIT` for crash-atomicity (T-27-01). Cost is O(rows) plus full index/FTS rebuild.

Mapping the options to buckets:

| Option | Schema delta | Cost bucket |
|--------|--------------|-------------|
| Bi-temporal — **nullable** `valid_from`/`valid_to`/`tx_from`/`tx_to` INTEGER columns, no constraints | additive ADD COLUMN ×4 | **Cheap — O(1) metadata-only.** New writes populate intervals; legacy rows stay NULL (open-ended). |
| Bi-temporal — *backfilling* existing `prev_value`/`prev_ts` history INTO intervals, or adding NOT-NULL/CHECK-constrained interval columns | row rewrite + constraint | **Expensive — full `node_v*` recreation** (rewrite ~14k rows + rebuild all indexes + `node_fts`). |
| Supersedes chain — **nullable** `supersedes_id`/`superseded_by_id` TEXT columns + one secondary index | additive ADD COLUMN ×2 + `CREATE INDEX` | **Cheap-additive** for the columns; the index build is O(rows) but one-shot and routine. |
| Supersedes chain — enforcing it as FK/CHECK referential integrity in-schema | constraint change | **Expensive — full recreation** (SQLite can't add the constraint in place). |

Either model is therefore **cheap to introduce going-forward** (nullable additive columns + a
`SCHEMA_VERSION` bump from 14 → 15, idempotent, protected by the existing newer-than-binary downgrade
guard at `schema.ts:608-623`). The expense is only incurred if we *backfill historical correctness
state* into the new shape or *enforce it with constraints* — both of which force the full ~14k-row
`node_v*` recreation + index/FTS rebuild.

### Invariants any new model MUST preserve (CLAUDE.md §Constraints)

- **Decay never deletes an evidence-backed fact** — a validity-interval close or a supersedes link must
  not become a decay-deletion path; retiring ≠ destroying evidence.
- **Graph is source of truth; the vector index is a derived, rebuildable cache** — temporal/lineage
  columns live on the graph `node` table, never authoritative in the vector sidecar.
- **Single-writer, IMMEDIATE-transaction discipline** — node mutation (incl. `setEmbedding`) rides
  inside one writer transaction (`src/db/semantic-store.ts`); any new column write must join that path,
  not open a second writer.
- **Self-confirmation guard** — inferred output must never strengthen a stored fact; supersedes/validity
  edits must be observation/assertion-driven, not inference-driven.

### Recommendation (SCALE-02): **DEFER — keep tombstone-always for now** (defer is a valid outcome)

The tombstone-always model already satisfies the load-bearing correctness requirement (it never
hard-deletes evidence, and prev_value/prev_ts retain the last surface), and the spike found **no current
forcing function** that bi-temporal intervals or supersedes chains would fix: there is no live feature
requesting point-in-time "as-of" queries or multi-hop correction-lineage traversal today. Adopting now
would add data-model surface (and, if done with backfill/constraints, an expensive full-table
recreation) ahead of a concrete need — the kind of speculative complexity the project explicitly avoids.

The cheap-additive path is, however, genuinely cheap and low-risk: **if/when** a feature needs
point-in-time recall or explicit correction lineage, prefer **DCPM-style supersedes chains first**
(nullable `supersedes_id`/`superseded_by_id` + index — strictly additive, directly extends the existing
prev_value lineage, and maps cleanly onto reconsolidation) and add **bi-temporal validity intervals**
only if a true as-of-time query requirement materializes (also addable cheaply as nullable columns).
Either adoption is a **separate future phase**; this spike only measures and recommends. Bump
`SCHEMA_VERSION` 14 → 15 at that time, additively, and keep the four invariants above as gates.

---

*Phase 49 spike — measured/analyzed at `sut_commit: 0bbbe27`. Harness:
`scripts/eval/49-crossover-spike.cjs`. Raw numbers: `scripts/eval/results/49-crossover-spike.json`
(gitignored, local-only). No production mechanism was adopted; both questions resolved to DEFER with
explicit re-trigger conditions.*
