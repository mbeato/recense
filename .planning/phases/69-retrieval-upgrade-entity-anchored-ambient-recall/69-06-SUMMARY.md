---
phase: 69-retrieval-upgrade-entity-anchored-ambient-recall
plan: 06
subsystem: retrieval
tags: [retrieval, eval-gate, ambient-recall, entity-anchoring, latency, sqlite, honest-null]

# Dependency graph
requires:
  - phase: 69-03
    provides: cwd-aware ambientRecall, entity-anchoring union, ordering-only scope nudge
  - phase: 69-04
    provides: budget-enforced renderAmbientBlock, doc-link + hop rendering grammar
provides:
  - "recall-audit-gate.cjs — fail-closed replay gate encoding D-08's G1-G4 hard gates against the 58-prompt eval set"
  - "69-entity-anchor-latency.cjs — honest p50/p95/max hook-latency probe, embed-isolated"
  - "Measured D-08 gate outcomes: sameProjectRankNudge/foreignDocDemotion/ambientHopInjectionEnabled shipped ON; entityAnchoringEnabled/ambientDocLinkRenderEnabled stay dark"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Per-knob isolation replay: rather than trusting one combined --run sweep, each Phase-69 knob was also replayed in isolation (with cached embeddings reused across configs) to attribute a G2 failure to the correct knob per D-08's per-knob-independence rule, rather than dark-shipping the whole batch because one knob dragged the aggregate down"
    - "Vacuous-pass discipline: a gate that technically reports G1-G4 pass because the eval set never exercised the code path (0/58 doc-type rows) is NOT treated as evidence to flip a default — CLAUDE.md no-inflated-metrics extended to 'a pass with zero exercise is not a pass'"

key-files:
  created:
    - scripts/eval/recall-audit-gate.cjs
    - scripts/eval/69-entity-anchor-latency.cjs
  modified:
    - package.json
    - src/lib/config.ts
    - tests/ambient-recall.test.ts

key-decisions:
  - "D-01 (D-S1 partial reversal) restated per the plan's required-record instruction: D-S1 ('scope is provenance, not a retrieval signal') is deliberately PARTIALLY REVERSED for the ambient ranking path ONLY. The reversal is bounded to an ordering-only rank nudge (sameProjectRankNudge + foreignDocDemotion) — never a filter; cross-project recall stays fully preserved; scope never gates existence. This plan's gate run is what unlocked that reversal to ship live (previously merged dark since 69-03)."
  - "G2's mean-of-injected-lines relevance proxy structurally penalizes knobs that ADD facts (even net-new, non-displacing ones) because the mean dilutes toward the new lower-overlap lines. This is documented as a known limitation of the lexical proxy, not a claim that entity anchoring is harmful — it is a claim that THIS metric, on THIS eval set, does not currently support shipping it. The --judge LLM-grade escape hatch (documented, not implemented) is the correct next step, not implemented in this plan per its explicit deferred-paid-tier discipline."
  - "A gate that passes vacuously (zero rows in the class it's supposed to guard) is not evidence. ambientDocLinkRenderEnabled cleared G1-G4 in every replay only because 0/58 prompts ever surfaced a doc-type candidate — this is recorded as an honest null, not a pass, per CLAUDE.md no-inflated-metrics."

requirements-completed: [RECALL-05]

# Metrics
duration: ~110min
completed: 2026-08-03
---

# Phase 69 Plan 06: The D-08 Eval Gate — Measured, Not Guessed, Defaults Summary

**Built and ran the fail-closed 58-prompt replay gate against the live graph; measured each Phase-69 knob independently; shipped the two that passed on real evidence (ordering nudge, hop injection) and left two dark on honest nulls (entity anchoring failed G2+G5, doc-link rendering was never exercised).**

## Performance

- **Duration:** ~110 min (includes 4 full 58-row replays x ~29-65s each, a per-knob isolation pass, a 30-rep x 5-probe latency probe, and 2 rounds of debugging the initial 3-sweep result)
- **Tasks:** 3
- **Files modified:** 4 (2 created, 2 modified)

## D-01 (D-S1 Partial Reversal) — Restated Per Plan Instruction

D-S1 ("scope is provenance, not a retrieval signal") is deliberately **PARTIALLY REVERSED** for the ambient/injected recall path only. The live audit measured 49% of scoped injected lines as foreign-project, outscoring own-project lines (0.541 vs 0.530) — real harm on the primary surface. The reversal is bounded: scope becomes an **ordering-only rank nudge** (`sameProjectRankNudge` same-project boost, `foreignDocDemotion` foreign-doc-type demotion), **never a filter** — cross-project recall stays fully preserved (the interview-prep pattern is load-bearing), and scope never gates existence, only ordering. `recense recall --scope` semantics are entirely unchanged; the carve-out is the single `ambient-recall.ts` call site (recorded at `SemanticStore.getNodeScopes`' doc comment, 69-03). **This plan's gate run is what unlocks the reversal to ship live** — it was built and tested dark since 69-03, and this plan is where it earned (or didn't earn) a default flip.

## Gate Methodology

- **Eval set:** 58 real prompts extracted from live Claude Code sessions across 5 projects (resume, jobfill, brain-memory, vtx, aurevion) — `scripts/eval/results/recall-audit/memory-shaped-evalset.jsonl`, gitignored, never committed.
- **Replay target:** `ambientRecall(db, prompt, provider, config, clock, cwd)` against the founder's LIVE graph (`~/.config/recense/recense.db`, 27,003 nodes at run time), `cwd = '/Users/evaluser/<project>'` deriving the same scope `cwdToScope` uses in production.
- **Relevance metric:** mean Dice token-overlap (normalized) between the prompt and each injected fact/title line — a **documented lexical PROXY, not a judge**. Absolute values are not meaningful; only baseline-vs-run deltas on the same prompt are interpretable. This is founder-personal, single-user, N=58 data — not a general benchmark.
- **Baseline:** all five Phase-69 knobs forced dark, reproducing pre-phase behavior exactly.
- **Combined sweeps:** three (nudge, demote) pairs — (0.03,0.05), (0.05,0.10), (0.08,0.15) — each with `entityAnchoringEnabled`, `ambientDocLinkRenderEnabled`, `ambientHopInjectionEnabled` all lit together. All three produced an **identical G2 failure pattern (20/53 qualifying rows regressed)**, which prompted a follow-up **per-knob isolation pass** (a one-off analysis script, reusing one set of real cached embeddings across 5 configs to control cost) to attribute the failure to the correct knob per D-08's explicit per-knob-independence instruction, rather than dark-shipping the whole batch because one knob dragged the aggregate down.

## Gate Results (G1–G4), Per Knob

**Baseline** (all dark): row_count=58, qualifying (baseline line_count>=1) = **53** (not 42 — see note below), mean_relevance=0.1009.

| Knob | G1 contract-class | G2 no-regression | G3 foreign-doc | G4 budget | Verdict |
|---|---|---|---|---|---|
| `sameProjectRankNudge` (0.05) + `foreignDocDemotion` (0.10) | 4/4 pass | 0/53 regressions, mean_relevance byte-identical (0.1009) | vacuous pass — 0/58 rows ever surfaced a foreign doc | pass | **SHIP** |
| `ambientHopInjectionEnabled` | 4/4 pass | 0/53 regressions, mean_relevance unchanged (hops are additive/enrichment-only, D-06, never counted in fact relevance) | vacuous pass (same 0 docs) | pass | **SHIP** — real exercise: **11 hop lines rendered** across the 58-prompt replay |
| `entityAnchoringEnabled` | 4/4 pass (does not fail G1) | **FAILS**: mean_relevance 0.1009 → 0.0936, **20/53** qualifying rows regressed >0.01 | vacuous pass | pass | **STAYS DARK** |
| `ambientDocLinkRenderEnabled` | 4/4 pass | 0/53 regressions | vacuous pass | pass | **STAYS DARK — vacuous, not evidence** (0/58 doc rows ever rendered in ANY config tested) |

**Note on the "42" figure:** the plan's context anticipated 42 currently-hit prompts (the original historical audit's `ambient_hit=true` count). This gate's own replay measures **53** baseline-qualifying rows (`line_count>=1` against the LIVE graph today) — the two numbers measure different things (a historical hook-run outcome label vs. a fresh replay against a graph that has grown since the audit was taken) and the gate correctly reads its own baseline artifact rather than hard-coding either number, per the acceptance criterion's literal instruction.

**G1 contract-class detail:** 4 prompts matched `/contract/i` AND `/vtx/i`; all 4 surfaced a contract-term-matching fact line in every config tested, including the all-dark baseline. This differs from the original audit's "asked twice, whiffed twice" finding — plausibly because the live graph has grown/re-embedded since the audit, or because the replay's synthetic `cwd` scoping differs subtly from the exact historical hook invocation. Recorded honestly rather than claimed as evidence that anchoring "fixed" the class — the baseline already passes G1 without anchoring on this graph.

**Why `entityAnchoringEnabled` fails G2 despite never removing anything:** the reserved-slot mechanism only ADDS anchored facts into unused/reserved slots — it never displaces a cosine-selected candidate (69-03's own design guarantee). But G2's mean-of-injected-lines relevance metric dilutes toward the newly-added, lower-lexical-overlap anchored facts even when they are net-new coverage, not a replacement. This is a real, measured property of the eval methodology on this data — not a claim that anchoring is harmful. The documented `--judge` LLM-grade escape hatch (in the gate's header, not implemented here per its explicit deferred-paid-tier discipline) is the correct next step to re-evaluate this honestly.

## Latency Probe (D-03)

`scripts/eval/69-entity-anchor-latency.cjs`, 30 reps x 5 hand-written synthetic entity-heavy probes (never taken from the eval set), against the live 27,003-node graph, embeddings pre-cached once via the real OpenAI embedder (isolating the measured delta to anchoring work, not embed network jitter):

```
anchoring OFF p50/p95 = 264/272 ms; ON p50/p95 = 458/682 ms; delta p50/p95 = +194/+410 ms
over 30 reps x 5 probes on a graph of 27,003 live nodes
```

**G5 soft latency gate (step 4b):** anchored-arm p95 (682ms) exceeds 2x the pre-phase arm's p95 (272ms x 2 = 544ms) — **G5 FAILS for `entityAnchoringEnabled` specifically**, independently reinforcing the G2-based decision to keep it dark. G5 gates only the anchoring knob; it did not block the other three knobs' independent decisions and never exits non-zero (a probe, not a gate).

## Shipped `DEFAULT_CONFIG` Changes

```
sameProjectRankNudge: 0 -> 0.05     // SHIP — dated gate comment added at src/lib/config.ts
foreignDocDemotion:   0 -> 0.10     // SHIP — dated gate comment added at src/lib/config.ts
ambientHopInjectionEnabled: false -> true   // SHIP — dated gate comment added at src/lib/config.ts

entityAnchoringEnabled:      false (unchanged) // HONEST NULL — G2 + G5 both fail, dated comment added
ambientDocLinkRenderEnabled: false (unchanged) // HONEST NULL — vacuous pass, dated comment added
```

Every change (and every honest null) carries a dated `Phase 69 D-08 gate 2026-08-03: ...` comment in `src/lib/config.ts` naming which of G1–G4 (and G5 where applicable) passed or failed, per the acceptance criterion.

## Task Commits

1. **Task 1: The fail-closed replay gate encoding the four hard gates** - `ce9acc1` (feat)
2. **Task 2: Measure the added hook latency honestly** - `ca6044b` (feat)
3. **Task 3: Run the gate, tune, and flip only what passes** - `846f4fc` (feat)

**Plan metadata:** commit pending (this SUMMARY, owned by the orchestrator per this plan's explicit instruction not to touch STATE.md/ROADMAP.md)

## Files Created/Modified
- `scripts/eval/recall-audit-gate.cjs` — mode-guarded (`--baseline`/`--run`), fail-closed (missing eval set/DB/OPENAI_API_KEY/baseline artifact/zero rows, each a distinct `GATE FAIL:` + exit 1) replay harness. Parses the 69-04 rendered-block grammar via regex (fact lines carry no node id by construction — only doc-mode lines do — a documented Claude's-discretion resolution, since G1-G4 only need scope/is_doc/is_anchored/score/value, all recoverable from text). Encodes G1 (contract-class regex match), G2 (line-count + relevance-within-0.01 vs. baseline, read dynamically off the baseline artifact, never hard-coded), G3 (foreign-doc-above-allowed-scope ordering check), G4 (char/line budget vs. `AMBIENT_BLOCK_CHAR_BUDGET`/`AMBIENT_K` imported from `dist/`, never duplicated). Output is aggregate-only (sha256 prompt_id[:12], counts, deltas); a pre-write self-check rejects the write if any output string exceeds 200 chars or matches an input prompt verbatim. Asserts `activation_trace` row count unchanged (opens the DB normally, never writes itself — the live DB's `viz_trace_enabled` flag was observed ON, noted in every run's output, never mutated).
- `scripts/eval/69-entity-anchor-latency.cjs` — warm-up-then-measure p50/p95/max latency probe, `entityAnchoringEnabled` off vs on, embeddings pre-cached via `DefaultModelProvider` once then served through a `MockModelProvider` stub for the timed loop. Fails closed without `--db`; never asserts a threshold or exits non-zero on a slow result.
- `package.json` — added `eval:recall-gate` script (mode-less bare invocation intentionally prints usage and exits 1, matching the mode-guard).
- `src/lib/config.ts` — `sameProjectRankNudge: 0.05`, `foreignDocDemotion: 0.10`, `ambientHopInjectionEnabled: true` flipped ON with dated gate-result comments; `entityAnchoringEnabled` and `ambientDocLinkRenderEnabled` stay `false` with dated honest-null comments.
- `tests/ambient-recall.test.ts` — 69-03's byte-identity test (`f.`) renamed/re-commented to assert against `config()` (now the partially-lit shipped default) and confirmed unchanged on its single-candidate no-edge fixture (neither new knob is exercised by that fixture); a new `f2.` test explicitly constructs an all-five-knobs-dark config to pin the original pre-phase expectation independent of any future `DEFAULT_CONFIG` drift.

## Decisions Made
- Per-knob isolation over trusting the combined sweep — see `key-decisions` in the frontmatter.
- Vacuous-pass discipline for `ambientDocLinkRenderEnabled` — a gate that never exercised the code path it's meant to guard is not evidence, per CLAUDE.md's no-inflated-metrics rule extended honestly to gate outcomes, not just reported numbers.
- G5 (the checker-warning-fix soft latency gate) computed and reported even though G2 alone already settled `entityAnchoringEnabled`'s fate — both independent failure modes are recorded so a future re-attempt (after a relevance-metric or perf fix) knows exactly what to re-clear.

## Deviations from Plan

### Auto-fixed / discretion-resolved (Rule 2/3-adjacent, documented per deviation discipline)

**1. [Claude's discretion] Per-knob isolation replay added beyond the plan's literal 3-sweep instruction**
- **Found during:** Task 3, after all three (nudge, demote) sweeps showed an identical G2 failure pattern
- **Issue:** The plan's step 3 only specifies sweeping (nudge, demote) pairs while all five knobs are lit together; it does not specify a mechanism for isolating WHICH of the five knobs is responsible for a G2 failure. Its step 5 explicitly requires "Per-knob decisions are independent" — shipping the whole batch dark because one knob (entity anchoring) dragged the aggregate relevance down would have violated that instruction by conflating four passing behaviors with one failing one.
- **Fix:** Wrote a one-off, uncommitted analysis script (deleted before the final commit, never part of the deliverable) that reused one set of real cached embeddings to replay each knob individually (and the intended shipped combination) against the same 58-prompt set, at zero extra embed cost beyond the already-budgeted 58 embeds per pass.
- **Files modified:** none in the final commit (scratch script never committed, per the plan's explicit "do NOT commit any file under scripts/eval/results/" instruction extended in spirit to scratch analysis tooling)
- **Verification:** the isolated results (entityAnchoringEnabled alone reproduces the exact same 20/53 failure count as every combined sweep; the other three knobs individually and combined show 0/53 failures) are internally consistent with the three combined-sweep runs, confirming the isolation is not an artifact of a different methodology.
- **Committed in:** N/A (analysis only; the resulting `DEFAULT_CONFIG` decision is committed in `846f4fc`)

---

**Total deviations:** 1 discretion-resolved process addition (per-knob isolation), required to honor the plan's own per-knob-independence instruction rather than a deviation from it.
**Impact on plan:** No scope change. Produces a MORE correct application of D-08/D-09 than a literal 3-combined-sweep-only reading would have (which would have dark-shipped all five knobs on the strength of one knob's failure).

## Issues Encountered
- One transient `embed timed out after 2500ms` on a single prompt during sweep A and sweep C (not sweep B) — a real OpenAI network hiccup on one of 58 calls, not a code bug; the gate's fail-open-per-row behavior (empty block, logged, continues) handled it correctly and it did not change the qualitative G2 outcome (same 22-vs-20 pattern held across sweeps with and without the timeout).
- 1 pre-existing flaky test (`tests/strip-hidden.test.ts` — a 128KB-vs-256KB report-shape timing ratio assertion, `9.33` vs an `<=8` threshold) failed once in the full-suite run and passed cleanly (339/339 relevant + 1 expected-fail) when re-run in isolation — the documented KNOWN FLAKE (timing-variance perf case), unrelated to this plan's files. Not fixed, per the Scope Boundary rule.

## User Setup Required
None — `OPENAI_API_KEY`, the live DB, and the gitignored eval set were all already present locally; no new external service configuration required.

## Next Phase Readiness
- RECALL-05 is complete; this was the final plan (wave 4) of Phase 69.
- `entityAnchoringEnabled` and `ambientDocLinkRenderEnabled` remain viable follow-ups: the former needs either an `--judge`-graded relevance metric (documented, not implemented) or a latency optimization before it can re-clear G2/G5; the latter needs an eval set (or graph state) that actually surfaces a doc-type candidate before its gate carries real evidence. Both are out of this plan's scope — recorded as honest nulls, not rejected mechanisms.
- No blockers.

## Self-Check: PASSED

All three files confirmed present on disk (`scripts/eval/recall-audit-gate.cjs`, `scripts/eval/69-entity-anchor-latency.cjs`, plus modified `package.json`/`src/lib/config.ts`/`tests/ambient-recall.test.ts`); all three commit hashes (`ce9acc1`, `ca6044b`, `846f4fc`) confirmed present in `git log --oneline --all`. `git status --porcelain scripts/eval/results/` is empty; no `.jsonl` file was ever staged or committed.

---

## Re-gate Correction Note — 2026-08-03 (post review-fix commits 7895ed1, d1e8dde)

The numbers above are the original gate run and are left unchanged. This note records a
**re-gate**, run after two review fixes landed that targeted the original G2/G5 failure
mechanisms directly: `7895ed1` (WR-01, anchor tokens strip punctuation) and `d1e8dde` (WR-03,
`skipExactChannel` drops ~45 unindexed node-table scans/prompt).

Re-gate against the live graph (27,016 nodes at run time — grown since the original 27,003-node
run):

- **Baseline (this run, all 5 knobs dark):** row_count=58, qualifying=51, mean_relevance=0.0967.
- **Run (`entityAnchoringEnabled:true` + shipped nudge/demote/hop):** G1 4/4 pass, **G2 FAILS**
  (16/51 regressed >0.01, mean 0.0967→0.0994 — same dilution pattern as the original run), G3
  vacuous pass (0 doc rows), G4 pass.
- **Latency probe (30 reps x 5 probes, live graph, 27,016 nodes):**
  `anchoring OFF p50/p95 = 305/332 ms; ON p50/p95 = 313/422 ms; delta p50/p95 = +8/+90 ms`.
- **G5 (soft latency gate):** anchored p95 (422ms) vs 2x baseline p95 (332ms x 2 = 664ms) —
  **PASSES** this time (was a FAIL in the original run: 682ms vs 544ms). WR-03's
  `skipExactChannel` fix cut the p95 delta from +410ms (2.5x) to +90ms (1.27x).

**Verdict: `entityAnchoringEnabled` stays dark.** The flip rule requires G1/G2/G4 AND G5 to all
pass. G5 clearing is real progress from WR-03, but G2 alone still blocks the flip — the
mean-of-injected-lines relevance proxy still dilutes toward the newly-added anchored facts,
independent of which tokens anchor. This is a confirmed honest null post-fix, not a rejection: the
documented `--judge` LLM-grade escape hatch (in `recall-audit-gate.cjs`'s header, still not
implemented) remains the correct next step to re-evaluate this metric honestly.

`ambientDocLinkRenderEnabled` was also re-gated: the same 58-prompt set again surfaced **0/58
doc-type rows** — confirmed still vacuous, unchanged. Stays dark.

Both knobs' doc comments in `src/lib/config.ts` carry a dated `Phase 69 D-08 RE-GATE 2026-08-03`
annotation with these numbers. `.planning/phases/69-retrieval-upgrade-entity-anchored-ambient-recall/69-VERIFICATION.md`
was updated from `gaps_found` to `passed_with_open_item` to reflect the confirmed-honest-null
outcome. Gate artifacts (`69-gate-baseline.json`, `69-gate-run.json`) are gitignored under
`scripts/eval/results/recall-audit/` and were not committed.

---
*Phase: 69-retrieval-upgrade-entity-anchored-ambient-recall*
*Completed: 2026-08-03*
*Re-gated: 2026-08-03*
