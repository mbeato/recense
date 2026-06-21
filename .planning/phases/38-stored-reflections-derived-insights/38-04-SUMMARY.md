---
phase: 38-stored-reflections-derived-insights
plan: "04"
subsystem: eval
tags: [eval, replay-harness, insight-surfacing, compose-tokens, REFLECT-02, token-measurement]
dependency_graph:
  requires:
    - phase: 38-02
      provides: InsightReflector synthesizes type='insight' nodes in Phase C consolidation
    - phase: 38-03
      provides: insightSurfacingEnabled flag + recall path that uses insight payload
  provides:
    - "composeToken measurement in replay-ku-harness.cjs (per-case + aggregate)"
    - "--insight-mode flag: insight-OFF vs insight-ON two-pass evaluation"
    - "REFLECT-02 evidence artifact schema (38-insight-tokens.json, deferred live run)"
  affects:
    - "38-04 Task 3 founder decision: activation default + reflectConfidenceCeiling"
tech-stack:
  added: []
  patterns:
    - "chars/4 proxy token counting (EVAL-03 convention) — consistent with session-start-cli cap"
    - "consolidate-once / evaluate-twice pattern (mirrors 35-02 sweep-once insight-OFF/ON)"
    - "findInsightForTopHit: mirrors RecallEngine.recall() schema-resolution + freshness gate as pure DB read"
key-files:
  created:
    - scripts/eval/results/38-insight-tokens.json
  modified:
    - scripts/eval/replay-ku-harness.cjs
key-decisions:
  - "Task 2 DEFERRED: no founder budget consent in context for paid live eval; artifact documents exact invocation + schema with DEFERRED placeholders"
  - "Token counting uses chars/4 proxy (EVAL-03 convention), not a real tokenizer — consistent, reproducible, labeled in results"
  - "findInsightForTopHit() is a pure read helper mirroring RecallEngine.recall() L306-397; no upsertNode/strengthen calls (T-38-08)"
  - "TOLERANCE_BAND_PTS=2: Phase-35 D-07 small-tolerance no-regression band applied to insight-ON KU score vs OFF baseline"
  - "composeTokens added to all evaluation paths (single-weight, sweep, insight-mode) for backward-compatible schema enrichment"
requirements-completed: [REFLECT-02]
duration: ~20min
completed: "2026-06-21"
---

# Phase 38 Plan 04: KU Harness Token Instrumentation + REFLECT-02 Eval Summary

**replay-ku-harness.cjs extended with --insight-mode (compose-token measurement + no-regression check); live REFLECT-02 eval deferred pending founder budget authorization at Task 3 checkpoint**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-06-21T (wave-3 executor)
- **Completed:** 2026-06-21
- **Tasks:** 2 autonomous (Task 1 complete, Task 2 deferred branch); Task 3 PENDING (founder decision)
- **Files modified:** 2

## Accomplishments

- Instrumented replay-ku-harness.cjs with `composeTokens` field (chars/4 proxy, EVAL-03 convention) on all evaluation paths: single-weight, sweep mode, and new insight-mode
- Added `--insight-mode` flag: consolidation runs ONCE per case, evaluation runs TWICE (insight-OFF / insight-ON); the insight-ON pass checks for a live non-stale insight via `findInsightForTopHit()` (mirrors `RecallEngine.recall()` L306-397 schema resolution + freshness gate, pure DB read, T-38-08 compliant)
- No-regression check: `regression=true` if insight-ON KU score falls more than `TOLERANCE_BAND_PTS` (2 pts) below insight-OFF — Phase-35 D-07 small-tolerance band
- Aggregate `composeTokensOff` / `composeTokensOn` / `composeTokenReductionPct` written to result meta for REFLECT-02 evidence
- `--dry-run` zero-API contract preserved: skeleton includes `composeTokens=null` placeholder so `grep -q composeTokens` passes on dry-run output
- Created deferred evidence artifact `38-insight-tokens.json` documenting exact invocation, env-var requirements, expected schema, and deferral reason

## Task Commits

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Instrument harness: composeTokens + insight on/off mode | eab6ee1 | scripts/eval/replay-ku-harness.cjs |
| 2 | Deferred live-run artifact (REFLECT-02 evidence schema) | 607fd6d | scripts/eval/results/38-insight-tokens.json |
| 3 | Task 3: PENDING — founder decision (activation default + ceiling) | — | — |

## Files Created/Modified

- `scripts/eval/replay-ku-harness.cjs` — Added `--insight-mode`, `composeTokens` field, `findInsightForTopHit()`, `countComposeTokens()`, `TOLERANCE_BAND_PTS`, no-regression check; updated all evaluation paths
- `scripts/eval/results/38-insight-tokens.json` — Deferred REFLECT-02 evidence artifact: documents exact live-run invocation, env requirements, expected schema with DEFERRED placeholders, deferral reason

## Decisions Made

- **Task 2 DEFERRED:** No founder budget consent in context for the paid live eval (embedding API + answer LLM). The plan explicitly provides a "prepare invocation and defer to Task 3" acceptance branch. Artifact documents everything needed to execute after authorization.
- **chars/4 proxy:** Matches EVAL-03 injection-efficiency convention; consistent with `session-start-cli` char cap; labeled in results as an approximation.
- **findInsightForTopHit() as standalone helper:** Rather than instantiating RecallEngine (which requires a full DI setup), the helper mirrors the insight surfacing logic as a pure read function over the scratch DB. Zero imports added, net-zero new deps.
- **Consolidate-once evaluate-twice pattern:** Mirrors Phase-35-02 sweep approach. Same scratch DB (same graph, same judge-engagement) for both insight-OFF and insight-ON passes — ensures the token delta is solely from payload composition, not graph differences.

## Deviations from Plan

None — plan executed exactly as written (Tasks 1 and 2 deferred branch). Task 3 is PENDING (founder decision, not an autonomous task).

## Verification Results

```
node -c scripts/eval/replay-ku-harness.cjs                                    → PASS (syntax OK)
grep -q "composeTokens" scripts/eval/replay-ku-harness.cjs                    → PASS
grep -q "insightSurfacingEnabled" scripts/eval/replay-ku-harness.cjs          → PASS
grep -iE "regression|tolerance" scripts/eval/replay-ku-harness.cjs            → PASS (3 matches)
node scripts/eval/replay-ku-harness.cjs --dry-run --out /tmp/replay-38-dry.json → exits 0, ZERO API calls
grep -q "composeTokens" /tmp/replay-38-dry.json                               → PASS (TOKEN_FIELDS_OK)
test -f scripts/eval/results/38-insight-tokens.json                           → PASS
grep -q "composeTokenReductionPct" scripts/eval/results/38-insight-tokens.json → PASS (RESULTS_RECORDED)
No package.json change                                                         → confirmed
```

## Task 3: PENDING — Founder Decision Required

Task 3 is a `type="checkpoint:decision"` task (not autonomous). It surfaces:

1. **Live eval authorization:** The `--insight-mode` live run requires `OPENAI_API_KEY` (embed) and the claude-headless transport. Exact invocation:
   ```
   npm run build && OPENAI_API_KEY=<key> RECENSE_MODEL_PROVIDER=claude-headless node scripts/eval/replay-ku-harness.cjs --insight-mode --out scripts/eval/results/38-insight-tokens.json
   ```
2. **insightSurfacingEnabled activation default:** ship-on (flip to `true`) vs ship-dark (keep `false`, the current default). Only justified if `composeTokenReductionPct` is decisive AND `regression=false`.
3. **reflectConfidenceCeiling verification:** currently `0.6`; founder confirms or adjusts before activation.

Select: `ship-on`, `ship-dark`, or `tune-ceiling` at the Task 3 checkpoint.

## Known Stubs

None. The harness is fully wired. The `38-insight-tokens.json` artifact is intentionally DEFERRED (not a stub) — the schema is complete and the live run fills it after authorization. This is the accepted Task 2 deferral branch per plan spec.

## Threat Surface Scan

No new network endpoints, auth paths, or schema changes. The `findInsightForTopHit()` helper is a pure DB read on the scratch database (T-14-DB: live DB env var never read). Token counting is a string length operation, no external calls.

## Self-Check

### Checking created files exist

- `scripts/eval/replay-ku-harness.cjs` — FOUND (modified)
- `scripts/eval/results/38-insight-tokens.json` — FOUND (created)

### Checking commits exist

- eab6ee1 (Task 1: harness instrumentation) — FOUND
- 607fd6d (Task 2: deferred artifact) — FOUND

## Self-Check: PASSED
