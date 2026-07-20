---
phase: 41-vector-index-and-hot-path-latency
plan: 03
artifact: PERF-REPORT
requirement: [PERF-02, PERF-03]
sut_commit: 0fec565
baseline_commit: d41d5c8
baseline_tag: v7.0
date: 2026-06-24
db: ~/.config/recense/recense.db (10,192 embedded live nodes), opened read-only
sidecar: ~/.config/recense/recense.db.vindex (63,088,496 bytes, 10,192 vectors)
results:
  - scripts/eval/results/41-topk-equivalence.json (gitignored, local-only)
  - scripts/eval/results/41-latency-after.json (gitignored, local-only)
---

# Phase 41 PERF Report — Vector Index Gates (PERF-02 / PERF-03)

Locks the two hard gates of the phase against the **committed Phase-40 baseline** (commit
`d41d5c8`, tag `v7.0`): PERF-03 (no accuracy regression) and PERF-02 (measurable latency
win). Every number here is a recense self-run against the live brain or against the
committed baseline JSONs — no inflated, cherry-picked, or best-of-N headline (project
CLAUDE.md no-inflated-metrics; D-08).

**Measurement prerequisite satisfied (41-02 flag):** the persisted `<dbPath>.vindex`
sidecar was built BEFORE any cold measurement, exactly as the end-of-sleep-pass hook does
(`buildVectorIndex(db, vectorIndexPath(dbPath))`, run-sleep-pass.ts:680-682) — 10,192
vectors, 63 MB, ~79 ms, written read-only (live DB mtime unchanged). Without this the cold
processes would have hit the brute-force fallback and measured the wrong thing (no win).

---

## PERF-03 — No accuracy regression

### (a) Top-k equivalence — the load-bearing proof (D-10, by construction)

`scripts/eval/41-topk-equivalence.cjs` compares, per query, the **indexed**
`CandidateRetriever.topk` (reading the persisted `.vindex` sidecar) against the
**brute-force** `cosineSimF32` scan (the D-10 reference — the exact same formula the
retriever uses in brute-force mode), over the live brain (10,192 embedded live nodes),
read-only.

| Run | k set | Queries | Checks | Failures | max \|Δscore\| | Verdict |
|-----|-------|---------|--------|----------|----------------|---------|
| mock unit-vector queries (default, deterministic, API-free) | {5, 20} | 20 | 40 | **0** | **0.000e+0** | **equivalent** |
| real `text-embedding-3-small` queries | {5, 20} | 20 | 40 | **0** | **0.000e+0** | **equivalent** |

- **k=5** is the live `candidateK`; **k=20** spans `hybridTopk`'s `preK = k*3` fetch.
- `max |Δscore| = 0` means the indexed cosine scores are **byte-identical** to the
  brute-force scores — not merely set-equivalent. The index is exact (D-01: it computes the
  same `dot / (||q|| · ||row||)` over a contiguous `Float32Array` with precomputed norms),
  so PERF-03 holds **by construction**, independent of any end-to-end eval. The boundary-tie
  allowance the script implements (D-10's "± identical-score float tie reorder") was never
  exercised — there was zero divergence to tolerate.
- This reproduces the spike's 20/20 byte-exact result (41-SPIKE-FINDINGS §3) under the
  **persisted** implementation that 41-02 shipped (not the spike's from-scratch build).

**Verdict: PERF-03(a) PASS** — the indexed retrieval path returns top-k id sets and cosine
scores byte-identical to brute-force. A latency win that changed retrieval results is ruled
out mechanically: the results do not change.

### (b) Three-harness end-to-end accuracy re-run — STATUS: NOT COMPLETED IN-SESSION (honest)

The plan also asks for the three accuracy harnesses (KU replay, LOCOMO, LongMemEval-S) to be
re-run on the indexed path and shown unchanged vs the Phase-40 baselines. **This was not
completed in this execution session, and I am not papering over that.**

What happened, plainly:
- `replay-ku-harness.cjs` was launched twice (full 18-case, then a directional 2-case run),
  both on the subscription-billed `claude-headless` transport (~$0 marginal cash). **Both
  stalled inside the first case's consolidation** — case `6a1eabeb` consolidates **1,968
  cached claims** through Haiku-extract + Sonnet-judge, and ran **> 21 minutes without
  completing a single case** tonight (likely subscription-side throttling; an active
  `claude -p` child confirmed it was working, not hung). The full 18-case run aggregates
  **35,443 claims** — at this rate it is an hours-scale job (Phase-40 noted full
  consolidation runs took ~7.37 hrs). I stopped both runs rather than block the phase for
  hours.
- **LOCOMO** (`locomo-harness.cjs`) and **LongMemEval-S** (`longmemeval-harness.cjs`) carry
  the same consolidation cost plus direct-API-$ exposure; per the plan's $3 paid-API gate
  they were **not run** without that cost being approved.

Why this does NOT undermine PERF-03, and the important caveat:
- **All three harnesses construct `new CandidateRetriever(...)` with NO `indexPath`**
  (replay-ku:259, locomo:160/432, longmemeval:217/710) — i.e. they exercise the
  **brute-force** scan on scratch DBs, **not** the indexed path. So re-running them would
  confirm the 41-02 code changes did not regress the *brute-force fallback*, **not** the
  indexed path. The indexed path's accuracy is the thing under test, and it is proven
  **byte-identical** by PERF-03(a) above — feeding a byte-identical top-k through any harness
  yields a byte-identical score by construction.
- The **KU baseline anchor** for comparison, when these are run, is the committed
  **w=0 (pure cosine) = 77.8%** (14/18) from Phase-35 (`35-VERIFICATION.md`); the LOCOMO
  anchor is `locomo-d41d5c8.json` (headline J = 86.0%, R@5 = 77.3%, R@10 = 82.2%).

**Verdict: PERF-03(b) = DEFERRED to Phase 43 CI gate (founder-approved 2026-06-24).**
Per the plan's own rule, "deferred, approval pending" is not a pass state — so this was
surfaced to the founder as an explicit cost/approval decision. **Decision: defer the
three-harness end-to-end re-run to Phase 43's CI regression gate.** Rationale (agreed by
the executor, the independent gsd-verifier, and the founder): all three harnesses construct
`CandidateRetriever` WITHOUT `indexPath` (`replay-ku:259`, `locomo:160/432`,
`longmemeval:217/710`) — they run the brute-force fallback, not the index — so re-running
them (hours-scale KU consolidation + paid-API spend over the $3 gate) corroborates an
already byte-exact result and buys no new assurance. The mechanical equivalence PERF-03(a)
is complete and is the load-bearing proof; the harness re-run is corroboration only and now
lives as a Phase 43 CI regression sentinel.

---

## PERF-02 — Latency win vs the committed Phase-40 baseline

`scripts/eval/41-latency-after.cjs`, live brain (10,192 embedded live nodes), K=10, 20-query
cue set (the SAME cues the Phase-40 45/46 ms number was measured over), read-only. Each mode
measured 5× (100 samples); ceil-percentile. The harness also re-measures the brute-force
baseline **in the same run** so the delta is same-machine, not just vs the older Phase-40
machine state.

### Warm (in-process `serve`/`mcp` surface)

| Path | p50 | p95 | vs Phase-40 baseline (45/46 ms) |
|------|-----|-----|--------------------------------|
| **indexed** | **13 ms** | **14 ms** | **−32 / −32 ms (~3.4× faster)** |
| brute-force (same run) | 44 ms | 45 ms | reproduces baseline within noise |

### Cold (the FELT SessionStart-inject / recall-cli surface — D-08 HEADLINE)

A fresh `node` process per query opens the live DB read-only and constructs
`CandidateRetriever(db, { indexPath })` exactly as `session-start-cli.ts:128` /
`recall-cli.ts:147` do, then runs one `topk` over the **persisted sidecar** — the real cold
path, reading a pre-built artifact (D-06), not the spike's from-scratch rebuild.

| Path | wall p50 | wall p95 | open+scan (inner) p50 |
|------|----------|----------|------------------------|
| **indexed** | **72 ms** | **77 ms** | **16 ms** |
| brute-force (same run) | 96 ms | 99 ms | 54 ms |
| **cold delta (indexed − brute)** | **−24 ms** | **−22 ms** | **−38 ms inner** |

The inner (open-db + scan) figure isolates the index's contribution: **54 → 16 ms**. The
index skips the ~38 ms row-marshal floor (decoding ~10k embedding BLOBs into per-row
`Float32Array` views) by reading the contiguous pre-built buffer instead — this is exactly
the D-06 cold win that 41-02's persistence was built to deliver, and it is the spike's
prediction confirmed: the spike's *from-scratch* cold was ~20 ms **slower** than brute-force;
the *persisted* cold here is ~24 ms **faster**.

### Run-to-run noise (disclosed — the cold number is the headline, so noise matters)

Four independent runs (mock embed, embed-isolated so jitter does not swamp the delta):

| Run | warm indexed | cold indexed wall | cold brute wall | cold delta p50 |
|-----|--------------|-------------------|-----------------|----------------|
| 1 | 13/14 | 72/77 | 96/99 | −24 |
| 2 | 13/14 | 73/75 | 98/104 | −25 |
| 3 | 13/14 | 73/77 | 95/98 | −22 |
| 4 | 13/13 | 73/78 | 96/113 | −23 |

Indexed warm is rock-stable (13 ms, ±1 ms p95). Indexed cold p50 sits at 72–73 ms (±2–3 ms);
the cold win is **−22 to −25 ms p50, consistently beyond the run-to-run noise band**.

### Real-embed cold disclosure (the felt path including the embed round-trip)

With real `text-embedding-3-small` query embedding (the actual SessionStart-inject felt
path), cold wall-clock is **~361 ms indexed vs ~375 ms baseline** — the OpenAI embed network
round-trip dominates and its variance swamps the index delta at the wall-clock level, exactly
as the spike found (41-SPIKE-FINDINGS §1). The index's contribution is still present in the
embed-isolated inner figure (16 vs 50 ms). The embed-isolated mock-cold numbers above are
therefore reported as the honest **index-contribution** headline; the real-embed cold delta
is **network-confounded and is NOT claimed as the index win.**

**Verdict: PERF-02 PASS (warm decisively; cold meaningfully).** Warm is ~3.4× / −32 ms,
far beyond noise. Cold (embed-isolated, the D-08 felt headline) is −24 ms p50 / −22 ms p95,
stable across four runs and beyond the noise band. Cold wall-clock *including* the embed
round-trip is network-bound and not claimed as an index win — stated plainly, not inflated.

### Soft latency target (set AFTER the numbers, per D-08 — no pre-committed hard SLA)

Now that the numbers are in hand:
- **Warm (serve/mcp):** soft target **≤ 15 ms p95** on the live ~10k-node brain (measured 14
  ms; the brute-force baseline was ~45 ms). This is a comfortable, defensible bar.
- **Cold (SessionStart-inject / recall-cli, embed-isolated open+scan):** soft target
  **≤ 80 ms p95 wall** on the live brain with the sidecar present (measured 77 ms; brute-force
  ~99 ms). The felt wall-clock *with* real embed remains embed-network-bound (~360 ms) and is
  out of scope for an index SLA.
- These are **soft** targets (regression sentinels for Phase 43's CI gate), not hard SLAs —
  consistent with D-08's "set a soft target once the numbers are in, no pre-committed ms SLA."

---

## Honest framing (no inflated metrics — T-41-07)

- Every PERF number above is a recense self-run: latency from `41-latency-after.cjs` against
  the live brain, equivalence from `41-topk-equivalence.cjs`, both compared to the committed
  Phase-40 baseline JSONs / `40-BASELINE.md`. No best-of-N headline; p50 **and** p95 reported;
  run-to-run noise disclosed across four runs.
- The within-noise / confounded results are reported as such: the real-embed cold wall-clock
  is network-bound (NOT an index win), and the warm same-run brute-force (44/45 ms) is shown
  alongside the Phase-40 anchor (45/46 ms) so the delta is honest on both bases.
- The one gate that is **not** a clean pass — PERF-03(b), the three-harness end-to-end
  re-run — is stated explicitly as OPEN and requiring user approval, not quietly marked done.
  The mechanical PERF-03(a) equivalence (byte-exact) is the load-bearing accuracy proof and
  IS complete.
- All measurement was **read-only on the live brain**; only the `.vindex` sidecar was written
  (atomic temp+rename), and the live `recense.db` mtime is unchanged (Jun 23 22:06) before and
  after every run.

## Gate summary

| Gate | Status | Evidence |
|------|--------|----------|
| PERF-03(a) top-k equivalence (D-10) | **PASS** | 40/40 checks, 0 failures, max\|Δscore\|=0 (mock + real embed) |
| PERF-03(b) 3-harness end-to-end no-regression | **DEFERRED to Phase 43 CI (founder-approved 2026-06-24)** | not run in-session (hours-scale consolidation + paid-API; harnesses run brute-force, not the index → corroboration only); KU anchor 77.8% / LOCOMO J 86.0% |
| PERF-02 warm latency | **PASS** | 13/14 ms vs 45/46 ms baseline (~3.4×, −32 ms), stable |
| PERF-02 cold latency (D-08 headline) | **PASS** | 72/77 ms vs 96/99 ms same-run brute (−24/−22 ms), stable over 4 runs |
| Soft target set after the fact (D-08) | **DONE** | warm ≤15 ms p95, cold ≤80 ms p95 wall (embed-isolated) |

---

*Real numbers, live brain, read-only. Sidecar (`<dbPath>.vindex`) was the only write; the
live `recense.db` was opened `readonly:true, fileMustExist:true` throughout and its mtime is
unchanged. SUT = commit `0fec565` (41-02 index built into dist). Baseline = `d41d5c8` / v7.0.*
