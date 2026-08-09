---
phase: 65-belief-gated-status-drift-provenance-distinctness-fix
plan: 10
subsystem: testing
tags: [eval-harness, provenance-key, status-drift, gmail, honest-measurement]

# Dependency graph
requires:
  - phase: 65-04
    provides: "deriveGmailProvenanceKey / normalizeSenderDomain / COLLAPSED_GMAIL_PROVENANCE_KEY (src/source/provenance-key.ts)"
  - phase: 65-02
    provides: "stripQuotedForwarded / isNearEmptyResidual (src/source/strip-quoted.ts)"
  - phase: 65-08
    provides: "Wired status-drift layer (routeContradiction gated by StatusDrift.evaluate), four DRIFT-65 observability counters, per-source contradictionNBySource"
provides:
  - "scripts/eval/drift-05-dry-run.cjs — DRIFT-05 harness reporting provenance-key distinctness (residual-threshold sweep + fallback-reason breakdown) and belief-correction accuracy against a labeled case set, with an embedded honest methodology block"
  - "scripts/eval/cases/drift-05-cases.json — 14 labeled synthetic status-thread cases, all seven scenario types, pinned to the real derivation by tests/drift-05-harness-smoke.test.ts"
  - "npm run eval:drift05 / eval:drift05:dry"
  - "tests/drift-05-harness-smoke.test.ts — zero-network schema + dry-path smoke suite"
affects: ["66 (Domain-Neutral Proposal Emit Seam) — gated on the Task 3 ENABLE/HOLD decision this plan sets up but does not itself make"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Resistance-targeted magnitude scripting: dry-mode section 2 queries the scratch DB's live candidate node (s, c, last_access) and computes effectiveStrength() live, then derives a judge magnitude that lands the ratio deterministically in the desired routeContradiction band (hold vs reconcile) regardless of what the confirm-path's starting s/c happen to be — avoids hardcoding fragile magnitude constants against an engine-internal confidence default."
    - "One message = one consolidate() pass, not batched — sidesteps predicting cross-episode extraction-prefetch order within a single pass and makes the out-of-order cases a direct, isolated test of the D-11(b) cross-pass event_ts guard specifically (the D-11(a) within-pass sort is covered elsewhere, not duplicated here)."
    - "Observed outcome classified from the LAST consolidation_event row tied to any of a case's gmail episodes, using status-drift.ts's own shipped isEmissionEligible predicate rather than re-deriving a second classification rule (mirrors D-13's stated intent that Phase 66 must reuse this predicate, not reinvent it)."

key-files:
  created:
    - scripts/eval/drift-05-dry-run.cjs
    - scripts/eval/cases/drift-05-cases.json
    - tests/drift-05-harness-smoke.test.ts
  modified:
    - package.json

key-decisions:
  - "Case schema: the plan's action text names seven per-case fields but its own acceptance criteria requires eight. Resolved by adding an eighth `requirement` field (a structured DRIFT-0X tag distinct from the free-text `rationale`), documented in the harness header per the provenance-key.ts precedent for resolving a stated plan inconsistency in-place rather than guessing silently."
  - "Dry-mode section 2 uses Consolidator + a scripted MockModelProvider (one pass per message), NOT runConsolidation — matches the plan's explicit instruction to follow the tests/eval-harness-smoke.test.ts Consolidator-for-CI / runConsolidation-for-real-runs split. Real-mode section 2 uses runConsolidation() per pass against the real DefaultModelProvider stack."
  - "Harness's own episode-minting code always sets session_id to the REAL derived provenance key, independent of the shipped provenanceDistinctnessEnabled config flag (which stays false throughout, read only for the methodology block). This measures the redesigned derivation's effect on belief-correction without ever flipping the shipped knob — that flip is Task 3's human decision alone."

requirements-completed: [DRIFT-05]

# Metrics
duration: ~55min
completed: 2026-08-03
---

# Phase 65 Plan 10: DRIFT-05 Honest Measurement Harness Summary

**A convention-following `.cjs` harness (`npm run eval:drift05[:dry]`) reports provenance-key distinctness with a residual-threshold sweep and fallback-reason breakdown, plus belief-correction accuracy against a 14-case labeled synthetic set spanning all seven required scenarios — zero network in dry mode, an embedded methodology block citing no external accuracy bar, and the `provenanceDistinctnessEnabled` enablement decision deliberately left to the still-open Task 3 human checkpoint.**

## Performance

- **Duration:** ~55 min (Tasks 1-2; Task 3 is an open checkpoint, not counted)
- **Tasks:** 2 of 3 completed (Task 3 is a blocking human checkpoint — see below)
- **Files modified:** 4 (3 created, 1 modified)

## Accomplishments

- **`scripts/eval/drift-05-dry-run.cjs`** (609 lines) follows `correctness-harness.cjs`'s conventions verbatim (`'use strict'`, the same `arg` helper, `--dry-run`/`--cases`/`--out` flags, compiled-`dist/` requires, fresh scratch DB per case under `os.tmpdir()`, non-dry API-key guard) and adds the two Phase-65-specific flags (`--inbox <path>`, `--sweep-residual <a,b,c>`).
- **Section 1 (provenance-key distinctness)** is fully real and LLM-free in every mode: for the supplied message set (synthetic case set, or a real `--inbox` JSONL export when supplied) it reports total messages, the collapsed baseline (always 1), the derived scheme's distinct count, the fallback count with a `no-domain`/`no-thread-id`/`near-empty-residual` reason breakdown, the residual-length distribution (min/p25/median/p75/max non-whitespace chars post-`stripQuotedForwarded`), and a distinct-key count for each of the three default `--sweep-residual` values (10, 20, 30).
- **Section 2 (belief-correction accuracy)** runs every one of the 14 cases through the real engine. In `--dry-run` mode it uses `Consolidator` + a scripted `MockModelProvider` (tagged `provider:'mock'` in the output, per T-65-10-MOCKNUM) with a resistance-targeted magnitude scheme that queries the scratch DB's live candidate node and computes `effectiveStrength()` directly so the routing band (hold vs reconcile) is hit deterministically regardless of confirm-path internals. In a real (non-dry) run it uses `runConsolidation()` — the real `DefaultModelProvider` stack — per pass, which is the honest measurement Task 3's checkpoint is designed to review.
- **Section 3 (methodology)** is embedded in the output JSON itself: what was measured, case count, whether real inbox data was included, all six Phase 65 config values used verbatim (`contradictionNBySource`, `provenanceDistinctnessEnabled`, `provenanceMinResidualChars`, `statusDriftEnabled`, `statusDriftConfidenceDamping`, `statusDriftEventTsGuard`), explicit coverage gaps, and the literal required sentence: *"no external accuracy bar exists for this feature class."*
- **The harness never enables `provenanceDistinctnessEnabled`** — `grep -c "provenanceDistinctnessEnabled = true\|provenanceDistinctnessEnabled: true" scripts/eval/drift-05-dry-run.cjs` returns `0`. Session ids for the synthetic episodes it mints are set directly to the real derived key (bypassing `GmailAdapter`, mirroring how `correctness-harness.cjs` bypasses the extraction pipeline's normal record path), so the redesigned derivation's effect is measured without ever flipping the shipped knob.
- **`scripts/eval/cases/drift-05-cases.json`** (14 cases) covers all seven required scenarios at least twice each: `hold-single-ambiguous`, `release-three-independent`, `forward-farm`, `quote-farm`, `out-of-order`, `chronological-control`, `undated`. Every `from` address uses a `.test`/`.example` domain (T-65-10-PII). Every case's `expected_distinct_provenance` is asserted, live, against the real `deriveGmailProvenanceKey`.
- **`tests/drift-05-harness-smoke.test.ts`** (9 tests, all green) validates the case schema, the synthetic-domain guard, the case-file-vs-derivation consistency (imports `deriveGmailProvenanceKey` from `src/`, not `dist/`), the `spawnSync --dry-run` invocation with API keys deleted from the child env, and the missing-`--cases`-file non-zero-exit path.

## Task Commits

1. **Task 1: Build the DRIFT-05 harness and its labeled case set** — `e304a31` (feat)
2. **Task 2: Zero-network smoke test for the case schema and the dry-run path** — `b914ae9` (test)
3. **Task 3: Review the dry-run against real inbox threads and record the enablement decision** — NOT STARTED (blocking human checkpoint; see below)

**Plan metadata:** this commit (docs: complete plan) — pending, written after this SUMMARY per the `#2070` ordering requirement.

## Files Created/Modified

- `scripts/eval/drift-05-dry-run.cjs` — the harness (Task 1).
- `scripts/eval/cases/drift-05-cases.json` — 14 labeled synthetic cases (Task 1).
- `package.json` — `eval:drift05` / `eval:drift05:dry` scripts added, no dependency change (Task 1).
- `tests/drift-05-harness-smoke.test.ts` — zero-network smoke suite (Task 2).

## Decisions Made

- Case schema's eighth field resolution (`requirement`) — see `key-decisions` above.
- Dry-mode Consolidator+MockModelProvider vs real-mode runConsolidation() split — see `key-decisions` above.
- Session-id-set-directly-to-derived-key regardless of the config flag — see `key-decisions` above.
- Observed-outcome classification uses the shipped `isEmissionEligible` predicate from `status-drift.ts` (last `consolidation_event` row for the case's gmail episodes) rather than inventing a parallel rule, matching D-13's stated intent that downstream consumers reuse this predicate.

## Measured Results (dry-run, synthetic case set, zero network)

Run: `npm run build && npm run eval:drift05:dry` — exit 0, `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` unset.

**Section 1 — Provenance-key distinctness (30 messages, synthetic case set):**

| Metric | Value |
|---|---|
| Total messages | 30 |
| Distinct keys (collapsed, today) | 1 |
| Distinct keys (derived) | 15 |
| Fallback count | 12 |
| Fallback reasons | `near-empty-residual: 12`, `no-domain: 0`, `no-thread-id: 0` |
| Residual length (non-whitespace, min/p25/median/p75/max) | 0 / 0 / 107 / 114 / 132 |
| Sweep (threshold -> distinct) | `10: 15`, `20: 15`, `30: 15` |

All 12 fallbacks trace to the forward-farm and quote-farm cases' deliberately near-empty residuals (3 messages x 4 cases = 12) — confirming the D-07 farming guard fires on every farmed message regardless of the sweep threshold (identical distinct count across 10/20/30 for this case set, since the farmed bodies are either fully forwarded or fully quoted with zero residual either way).

**Section 2 — Belief-correction accuracy (14/14 cases, `provider: 'mock'`):**

| Scenario | Correct | Expected outcome |
|---|---|---|
| hold-single-ambiguous | 2/2 | hold |
| release-three-independent | 2/2 | corrected |
| forward-farm | 2/2 | hold |
| quote-farm | 2/2 | hold |
| out-of-order | 2/2 | corrected |
| chronological-control | 2/2 | corrected |
| undated | 2/2 (1 corrected, 1 hold) | mixed |

Aggregate: 14/14 (100%), `provider: 'mock'`. Drift counters (summed across all 30 message-passes): `evaluations=30, damped=21, staleDropped=2, eventTsUnknown=26`. Resolve counters: `attempts=30, hits=0, abstains=30` (expected — the scratch DBs never contain a pre-existing entity node to resolve against).

**This 100% figure is a plumbing proof, not a real accuracy measurement** (per T-65-10-MOCKNUM, explicitly tagged `provider:'mock'` in the output and restated in the methodology block) — every case's classification and judge magnitude were scripted by this harness to hit the labeled outcome deterministically via the resistance-targeting scheme, not produced by a real classifier reading the message bodies. The `eventTsUnknown=26` figure is expected and not a bug: every case's `initial_status_fact` is seeded via an undated `conversation`-sourced episode, so the FIRST gmail message in every case (and every subsequent message in cases where prior messages only produced non-supporting `contradict_hold` events) finds no dated supporting evidence yet — see the harness's inline Gotchas comment and the `dampByConfidence`/`SUPPORTING_EVENT_TYPES` source for why this is the documented, honest behavior rather than a defect.

**The REAL number** — from a real run against real inbox data, driven by the actual `DefaultModelProvider` classifier and judge — does not yet exist. That is exactly what Task 3's checkpoint asks the founder to produce and review.

## Task 2 Mutation Check (required by acceptance criteria)

Temporarily set case `release-1`'s `expected_distinct_provenance` from `3` to `999`, re-ran `npx vitest run tests/drift-05-harness-smoke.test.ts -t "expected_distinct_provenance matches"`: the consistency test **FAILED** as expected (`AssertionError: case release-1: expected_distinct_provenance=999 but the real derivation produced 3 distinct key(s)`). Reverted via direct file restore; confirmed `git diff --stat scripts/eval/cases/drift-05-cases.json` empty (byte-identical to the Task 1 commit); re-ran the full suite — green, 9/9.

## Deviations from Plan

None (Rules 1-3) — plan executed as written. The eighth-field schema resolution and the dry/real Section 2 split are both explicitly Claude's-discretion items the plan calls out (see `key-decisions`), not deviations from a locked spec.

## Issues Encountered

None — the harness ran correctly on first `npm run build && node scripts/eval/drift-05-dry-run.cjs --dry-run`, with all counter math (drift/resolve totals) independently hand-verified against the shipped consolidator logic before this SUMMARY was written (see `## Measured Results` above).

## Known Stubs

None — no UI surfaces, no hardcoded empty/placeholder values.

## Threat Flags

None new. All threat-model dispositions from the plan's `<threat_model>` section are mitigated as designed:
- T-65-10-PII: synthetic-only committed case file, `.test`/`.example` domains asserted by the smoke test; `--inbox` path is operator-supplied and never committed.
- T-65-10-MOCKNUM: dry-mode Section 2 tagged `provider:'mock'`; smoke test's header states a green run is not evidence of measurement.
- T-65-10-OVERCLAIM: methodology embedded in the output JSON itself, asserted by the smoke test to contain the no-external-bar sentence and all six config values.
- T-65-10-SILENT: the knob-enable grep returns 0; Task 3 remains an unresolved blocking checkpoint (`autonomous: false`), not auto-approved.
- T-65-10-DRIFTCASE: smoke test recomputes every case's `expected_distinct_provenance` from the real derivation; mutation check performed and confirmed biting (above).
- T-65-10-KEYLEAK: API-key presence guard mirrors `correctness-harness.cjs`; dry-path smoke-tested with both keys explicitly deleted from the child env.
- T-65-SC: zero package installs; `package.json` gained two scripts, no dependency change (`git diff --stat package.json` — 2 insertions, 0 deletions).

## User Setup Required

**Yes — Task 3 is a blocking human checkpoint, not yet started.** See "CHECKPOINT REACHED" in the executor's return for the founder-facing instructions: export a real multi-email status-thread sample as JSONL (kept outside the repo), run `npm run eval:drift05 -- --inbox <path> --out scripts/eval/results/drift-05-<date>.json`, review the printed sections against the four questions in the plan's `how-to-verify`, and state `ENABLE` (optionally with revised knob values) or `HOLD` (naming the blocking observation) — that decision, verbatim, must land in a revision of this SUMMARY before the plan can be considered complete.

## Next Phase Readiness

- **Phase 66 (Domain-Neutral Proposal Emit Seam) is gated on Task 3's decision**, per the research SUMMARY's Phase Ordering Rationale (this plan is a hard prerequisite, not a nice-to-have) — do not begin Phase 66 planning/execution until this plan's Task 3 checkpoint resolves.
- The harness, case set, and smoke test are fully built, committed, and green — the founder's only remaining action is the real-inbox review and the `ENABLE`/`HOLD` decision itself. No further engineering work blocks Task 3.
- If `ENABLE`: the ONLY source diff should be knob values in `src/lib/config.ts`, with `tests/runtime-config.test.ts` updated in the SAME commit so the stock-default assertions match. If `HOLD`: no source changes at all; name the specific blocking observation in a SUMMARY revision.

---
*Phase: 65-belief-gated-status-drift-provenance-distinctness-fix*
*Completed: 2026-08-03 (Tasks 1-2 only — Task 3 checkpoint open)*

## Self-Check: PASSED

- FOUND: scripts/eval/drift-05-dry-run.cjs
- FOUND: scripts/eval/cases/drift-05-cases.json
- FOUND: tests/drift-05-harness-smoke.test.ts
- FOUND commit e304a31 (feat(65-10): DRIFT-05 harness and labeled case set)
- FOUND commit b914ae9 (test(65-10): zero-network smoke test for the DRIFT-05 case schema and dry-run path)
