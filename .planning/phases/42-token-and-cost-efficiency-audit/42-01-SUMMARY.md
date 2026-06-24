---
phase: 42-token-and-cost-efficiency-audit
plan: "01"
subsystem: eval-harness
tags: [cost-efficiency, lever-sweep, ku-gate, dry-run, build-only]
dependency_graph:
  requires: []
  provides: [42-lever-sweep-harness, ku-config-override-gate]
  affects: [scripts/eval/replay-ku-harness.cjs, scripts/eval/42-lever-sweep-harness.cjs]
tech_stack:
  added: []
  patterns: [greedy-lever-sweep, VACUUM-INTO-scratch, skip-split-LLM-free, KU-dry-run-gate]
key_files:
  created:
    - scripts/eval/42-lever-sweep-harness.cjs
  modified:
    - scripts/eval/replay-ku-harness.cjs
decisions:
  - "KU gate always dispatched with --dry-run this phase per build-only constraint (D-06)"
  - "consolSkipThresholdBySource requires salience deep-merge (nested, not flat top-level key)"
  - "Result files (scripts/eval/results/) are gitignored; only harness source is committed"
  - "write_ledger always measured:false this phase — write-side sleep pass deferred to 42-04"
  - "Best candidate consolSkipThreshold=0.5 ranked by skip-rate delta (+60pp vs baseline 0.2)"
metrics:
  duration: "~7 min"
  completed_date: "2026-06-24"
  tasks_completed: 2
  files_changed: 2
---

# Phase 42 Plan 01: Lever-Sweep Harness + KU Gate Config-Override Summary

One-liner: greedy one-at-a-time lever-sweep harness with LLM-free skip-split ($0 now) + KU accuracy gate built and --dry-run-validated (config_override echo proven, $0), write-side deferred to 42-04.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Lever-sweep harness core (config override + skip-split + write-ledger + result envelope) | 263b0e8 | scripts/eval/42-lever-sweep-harness.cjs (new, 567 lines) |
| 2 | Greedy sweep driver + KU gate dispatch + argmax table + config_override echo | 98b0dfb | scripts/eval/replay-ku-harness.cjs (modified, +41 lines) |

## What Was Built

### scripts/eval/42-lever-sweep-harness.cjs (567 lines, new)

Greedy one-at-a-time lever-sweep harness for COST-01/02:

- **Args**: `--db`, `--out` (default `scripts/eval/results/42-sweep-PENDING.json`), `--lever`, `--values <csv>`, `--sample`, `--dry-run`. No `--out-dir` flag; `OUT_DIR = path.dirname(OUT)`.
- **Config override**: `buildOverrideConfig(leverKey, leverValue, dbPath)` applies `{ ...DEFAULT_CONFIG, dbPath, [leverKey]: leverValue }` for standard numeric levers; deep-merges salience for `consolSkipThresholdBySource`; passes through unchanged for `RECENSE_CORPUS_GEN` (env-var lever, D-02).
- **DB isolation**: Live db opened readonly; `VACUUM INTO` scratch under `os.tmpdir()` (T-42-01 mitigated).
- **Skip-split** ($0, LLM-free): per-candidate skip-rate vs baseline using `effectiveThreshold` mirror from cost-benefit-harness.cjs.
- **Write-ledger**: Always `measured: false` this phase (write-side deferred to 42-04 per D-06 build-now/run-at-reset). `per_model: null`, `subscription_marginal_usd: 0` always present.
- **KU gate dispatch**: `spawnSync(replay-ku-harness.cjs, ['--dry-run', '--config-override-key', LEVER, '--config-override-value', String(v), ...])` per candidate. Always `--dry-run` this phase ($0). Reads back `meta.config_override` to verify propagation.
- **Comparison table**: `lever_value | skip_rate | skip_Δ (pp) | write_tok/turn | ku_score | within_band` (write/KU columns show "deferred" this phase).
- **Argmax**: Best candidate ranked by skip-rate delta (the $0 proxy for write-token savings).
- **Combined-best config**: `{ consolSkipThreshold: 0.5, _note, _phase_40_baseline_commit }` — hand-off to 42-04 for deferred KU accuracy validation.
- **Result files**: Aggregate to `--out`; per-lever to `OUT_DIR/42-sweep-<lever>-<value>.json`; KU-gate dry-run to `OUT_DIR/42-ku-gate-<lever>-<value>.json`.
- **Security** (T-42-02/T-26-03): no ANTHROPIC_API_KEY / OPENAI_API_KEY ever written to results or console. Config.ts never written (T-42-03).

### scripts/eval/replay-ku-harness.cjs (41 lines added)

Added `--config-override-key` / `--config-override-value` flag pair (the ONE source edit this plan makes to that harness):

- Parsed at module level (`CONFIG_OVERRIDE_KEY`, `CONFIG_OVERRIDE_VALUE` — numeric coerced).
- Applied in `makeScratchDb` via `{ ...DEFAULT_CONFIG, dbPath, [CONFIG_OVERRIDE_KEY]: CONFIG_OVERRIDE_VALUE }` (T-42-03: in-memory only). `consolSkipThresholdBySource` deep-merges salience.
- Echoed as `meta.config_override = { key, value }` in **all four result envelopes**: dry-run skeleton, sweep-mode, insight-mode, and legacy single-weight. This proves the lever propagated into the spawned KU process — the gate is NOT a no-op for recall-side levers.

## Sweep Results (consolSkipThreshold, live brain, 25 episodes sampled)

| lever_value | skip_rate | skip_Δ (pp) | write_tok/turn | ku_score | within_band |
|-------------|-----------|-------------|----------------|----------|-------------|
| 0.2 (baseline) | 28.0% | +0 | deferred | deferred | deferred |
| 0.35 | 84.0% | +56 | deferred | deferred | deferred |
| 0.5 | 88.0% | +60 | deferred | deferred | deferred |

**Best candidate (by $0 skip-rate signal): `consolSkipThreshold = 0.5` (+60pp)**

Note: At 0.35 vs 0.5 the skip-rate gain narrows (+56 to +60pp). The real KU accuracy verdict (D-05, ≤1pt noise band) is deferred to 42-04 — a +60pp skip increase is significant enough to risk a regression, so the no-regression gate matters before locking this value.

## Combined-Best Candidate Config (for 42-04 deferred KU validation)

```json
{
  "consolSkipThreshold": 0.5,
  "_note": "Combined-best candidate ranked by $0 skip-rate delta. KU accuracy validation deferred to 42-04.",
  "_phase_40_baseline_commit": "d41d5c8"
}
```

The real within-noise-band accuracy verdict (D-05: ≤1pt / within CI) per candidate is produced by the deferred KU run in 42-04's runbook, not inline this phase.

## Acceptance Criteria Verification

| Criterion | Status |
|-----------|--------|
| `--db /tmp/nonexistent-recense.db` exits 0 with "no data" | PASS |
| Single `--out` flag; `OUT_DIR = path.dirname(OUT)`; no `--out-dir` | PASS (grep -c "out-dir" = 0) |
| Source contains `...DEFAULT_CONFIG`, `[leverKey]`, `VACUUM INTO` | PASS |
| `write_ledger.measured = false` with reason when headless unset | PASS |
| Aggregate JSON has `meta.lever_under_test`, `meta.phase_40_baseline_commit`, `write_ledger.per_model`, `write_ledger.subscription_marginal_usd`, `skip_split` | PASS (all fields verified) |
| No ANTHROPIC_API_KEY / OPENAI_API_KEY in result JSON or code paths | PASS |
| `src/lib/config.ts` unchanged | PASS (`git diff --quiet`) |
| Comparison table printed with deferred KU columns | PASS |
| `replay-ku-harness.cjs` dispatched per candidate (grep ≥ 1) | PASS |
| `--config-override-key/value` passed to KU child (grep ≥ 1) | PASS |
| KU result has `meta.config_override.key === 'candidateK'` (smoke test) | PASS (`ku_override_exit=0`) |
| `RECENSE_CORPUS_GEN` in harness source (grep ≥ 1) | PASS |
| `ku_gate.deferred = true` in aggregate result | PASS |
| No real KU run and no write-side sleep pass executed | PASS (always `--dry-run` for KU; `measured: false` for write) |

## Deviations from Plan

None - plan executed exactly as written.

The one design decision not explicitly in the plan: `consolSkipThresholdBySource` requires a salience deep-merge rather than a flat `[leverKey]` override, because `effectiveThreshold` reads it via `config.salience.consolSkipThresholdBySource`. Handled transparently in `buildOverrideConfig` with no plan-visible deviation.

## Self-Check: PASSED

- `scripts/eval/42-lever-sweep-harness.cjs`: EXISTS (567 lines)
- `scripts/eval/replay-ku-harness.cjs`: MODIFIED (+41 lines, committed 98b0dfb)
- Commits: 263b0e8 (Task 1), 98b0dfb (Task 2) — verified in git log
- `src/lib/config.ts`: UNCHANGED (`git diff --quiet` confirmed)
- No API keys in committed artifacts (scripts/eval/results/ is gitignored)
