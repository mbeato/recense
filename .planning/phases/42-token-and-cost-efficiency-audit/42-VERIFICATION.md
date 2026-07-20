---
phase: 42-token-and-cost-efficiency-audit
verified: 2026-06-24T20:00:00Z
status: passed
score: 4/4 must-haves verified
overrides_applied: 0
deferred:
  - truth: "Write-side token cost measured per-episode (Haiku extract + Sonnet judge), broken down by lever (COST-01 write half)"
    addressed_in: "42-DEFERRED-RUN-RUNBOOK.md STEP 3 (reset-window battery)"
    evidence: "42-DEFERRED-RUN-RUNBOOK.md STEP 3 provides exact single-line command: node scripts/eval/42-lever-sweep-harness.cjs --lever consolSkipThreshold --values 0.5 --out ...; confirms write_ledger.measured===true verification; scheduled post-weekly-reset per D-06"
  - truth: "Per-candidate KU accuracy validation at consolSkipThreshold=0.5 within D-05 noise band (COST-02 accuracy half)"
    addressed_in: "42-DEFERRED-RUN-RUNBOOK.md STEP 2 (KU real run) + STEP 4 (LOCOMO/LongMemEval confirm)"
    evidence: "STEP 2 provides real KU command (no --dry-run), D-05 gate rule (ku_correct >= 4), baseline reference 35-sweep-w0.json scores.ku_score=0.222; STEP 4 provides LOCOMO-10 + LongMemEval-S commands with frozen v7.0 baseline (J>=85.0%, R@5>=76.3%, R@10>=81.2%)"
---

# Phase 42: Token / Cost Efficiency Audit Verification Report

**Phase Goal:** Measure recense's token/cost profile end-to-end and tune it; quantify savings vs competitors defensibly; evaluate progressive-disclosure retrieval head-to-head against schema-prior compression and adopt only on a measured token win.
**Verified:** 2026-06-24T20:00:00Z
**Status:** PASSED
**Re-verification:** No — initial verification

**Build-only constraint (D-06, founder 2026-06-24):** The weekly subscription limit was nearly exhausted. Build + dry-run + LLM-free deliverables are verified now. The expensive write-side sleep-pass run and accuracy confirmation battery are deferred to the next weekly reset per the concrete 42-DEFERRED-RUN-RUNBOOK.md. Deferral-with-runbook counts as MET per the phase context.

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|---------|
| 1 | COST-01 recall-side: per-session inject token cost measured LLM-free against flat baseline, broken down by lever | VERIFIED | injection-efficiency-harness.cjs ran against 10,704 live nodes: 496 injected vs 7,048 flat = 93% reduction. Committed source. Result JSON gitignored but locally verified (json_exit=0, flat_missing=false, token_reduction_pct=93). Reported in 42-COST-SAVINGS-REPORT.md §1 with committed source and key-field trace. |
| 2 | COST-01 write-side: write token breakdown (Haiku/Sonnet) per lever deferred with concrete runbook | VERIFIED (deferred) | 42-lever-sweep-harness.cjs (567 lines, parses OK, committed 263b0e8) always sets write_ledger.measured=false with explicit reason. 42-DEFERRED-RUN-RUNBOOK.md STEP 3 provides single-line command, write_ledger.measured===true verification check, and result-field callouts. Runbook is 281 lines, committed d910e9b. |
| 3 | COST-02: lever sweep measured by $0 skip-rate proxy; best candidate identified; accuracy gate deferred with concrete runbook | VERIFIED | Skip-split: consolSkipThreshold=0.5 yields +60pp skip-rate delta (88% vs 28% baseline). Greedy sweep table produced with deferred KU columns marked as such. KU gate always --dry-run this phase; --config-override-key/value flags built into replay-ku-harness.cjs (+41 lines, committed 98b0dfb), echoed in all 4 result envelopes. Deferred accuracy validation documented in STEPS 2+4 of runbook with D-05 noise-band rule. |
| 4 | COST-03: recall-side savings stated with reproducible number; write-side reported separately; competitors cited with methodology notes; no inflation | VERIFIED | 42-COST-SAVINGS-REPORT.md (162 lines, committed 58d92bc). "Recall and write costs are never netted into a single number" stated on line 6 and honored in structure. mem0 93.2% cited from arXiv 2504.19413 Table 2. claude-mem ~10x labeled "NO PRIMARY BENCHMARK / secondary sources only." Every recense figure traces to a committed LLM-free script in §5 reproducibility footer. No rounding-up, no unsourced claims. |
| 5 | COST-04: progressive-disclosure benchmarked LLM-free against schema-prior compression with oracle + fixed-top-K brackets; decision documented with numbers | VERIFIED | 42-progressive-disclosure-harness.cjs (317 lines, parses OK, committed 7ad0f6c + a414d57). Real session-start-cli spawn for incumbent arm. Oracle: -69.96%; fixed-top-5: -52.82%. Verdict: challenger-wins-top-k. Decision: DECLINED pending higher-fidelity follow-on (two named fidelity gaps: selection proxy mismatch + short node sample). D-10 decline path present in harness source (line 18-19, 223-241). Real MCP tool not built per D-09. |

**Score:** 5/5 truths verified (COST-01 split into recall + write-side; 4 requirements, all MET)

---

### Deferred Items

Items not yet executed but addressed in the documented runbook, not penalized per D-06.

| # | Item | Runbook Location | Evidence |
|---|------|-----------------|---------|
| 1 | Write-side token breakdown at consolSkipThreshold=0.5 (COST-01 write half) | 42-DEFERRED-RUN-RUNBOOK.md STEP 3 | Exact command provided; write_ledger.measured===true verification check; headless provider env var requirement documented |
| 2 | Real KU-replay accuracy validation at consolSkipThreshold=0.5 (COST-02 KU gate) | 42-DEFERRED-RUN-RUNBOOK.md STEP 2 | No --dry-run; --config-override-key consolSkipThreshold --config-override-value 0.5; D-05 gate: ku_correct >= 4 (baseline 4/18 = 22.2%) |
| 3 | LOCOMO-10 + LongMemEval-S no-regression confirm (COST-02 final gate) | 42-DEFERRED-RUN-RUNBOOK.md STEP 4 | Frozen v7.0 baseline cited: J>=85.0%, R@5>=76.3%, R@10>=81.2%; D-05 accept/reject stated; run-time caveat (7.37 hrs) documented |

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `scripts/eval/42-lever-sweep-harness.cjs` | Greedy lever-sweep harness with skip-split + KU gate dispatch | VERIFIED | Exists (567 lines); node --check: PASS; VACUUM INTO scratch DB isolation at line 254; DEFAULT_CONFIG spread at line 67; per_model and ku_gate fields present in output envelope; write_ledger.measured=false at lines 340, 527; committed 263b0e8 |
| `scripts/eval/replay-ku-harness.cjs` | +41-line --config-override-key/value addition with meta.config_override echo | VERIFIED | --config-override-key/value parsed at lines 107-111; applied in makeScratchDb at lines 255-261; echoed in all 4 envelopes at lines 700-718, 857-860, 1074, 1201; node --check: PASS; committed 98b0dfb |
| `scripts/eval/42-progressive-disclosure-harness.cjs` | LLM-free A/B harness with oracle + fixed-top-K brackets | VERIFIED | Exists (317 lines); node --check: PASS; real session-start-cli spawn at line 126; oracle policy at line 193-196; fixed-top-K at line 198-204; D-10 decline path at lines 18-19, 223-241; committed 7ad0f6c + a414d57 |
| `.planning/phases/42-token-and-cost-efficiency-audit/42-COST-SAVINGS-REPORT.md` | Competitor-savings report per D-11/D-12, no inflated metrics | VERIFIED | 162 lines; committed 58d92bc; recall-side in §1, write-side in §2, competitors in §3 with methodology notes, progressive-disclosure in §4, reproducibility footer in §5; "never netted" stated line 6; no ANTHROPIC_API_KEY or OPENAI_API_KEY present |
| `.planning/phases/42-token-and-cost-efficiency-audit/42-DEFERRED-RUN-RUNBOOK.md` | Concrete 4-step reset-window runbook with cost-probe hard gate | VERIFIED | 281 lines; committed d910e9b; STEP 1 cost-probe with projection math; STEP 2 KU real run with D-05 gate rule; STEP 3 write-side breakdown; STEP 4 LOCOMO+LongMemEval; all commands single-line (CLAUDE.md hygiene); no --out-dir flag (grep -c = 0); gate decision documented as defer-to-reset |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| 42-lever-sweep-harness.cjs | replay-ku-harness.cjs | spawnSync --config-override-key / --config-override-value | VERIFIED | Lines 370-380 in lever-sweep harness dispatch spawnSync with these flags; replay-ku-harness echoes back meta.config_override which sweep harness reads to verify propagation |
| 42-lever-sweep-harness.cjs | DEFAULT_CONFIG (config.ts) | require('../../dist/src/lib/config') | VERIFIED | Line 67; config.ts not modified (T-42-03 honored; confirmed by summary: git diff --quiet src/lib/config.ts) |
| 42-progressive-disclosure-harness.cjs | session-start-cli | spawnSync (real spawn, not mock) | VERIFIED | Lines 123-136; cliPath resolves to dist/src/adapter/session-start-cli.js; spawnSync result checked for error/status |
| 42-COST-SAVINGS-REPORT.md | injection-efficiency-harness.cjs | §5 reproducibility footer, key field citation | VERIFIED | §5 maps "93% recall-side savings" → scripts/eval/injection-efficiency-harness.cjs → 42-injection-efficiency-PENDING.json → point_estimate.token_reduction_pct |
| 42-DEFERRED-RUN-RUNBOOK.md | 42-lever-sweep-harness.cjs | STEP 3 exact command | VERIFIED | STEP 3 command is: node scripts/eval/42-lever-sweep-harness.cjs --lever consolSkipThreshold --values 0.5 --out ...; no --out-dir flag (harness has none) |

---

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| 42-lever-sweep-harness.cjs parses as valid JS | node --check scripts/eval/42-lever-sweep-harness.cjs | exit 0 | PASS |
| 42-progressive-disclosure-harness.cjs parses as valid JS | node --check scripts/eval/42-progressive-disclosure-harness.cjs | exit 0 | PASS |
| replay-ku-harness.cjs parses as valid JS | node --check scripts/eval/replay-ku-harness.cjs | exit 0 | PASS |
| config-override-key flag present in replay-ku-harness | grep CONFIG_OVERRIDE_KEY scripts/eval/replay-ku-harness.cjs | 6 matches | PASS |
| meta.config_override echo present in all 4 result envelopes | grep config_override replay-ku-harness.cjs | lines 700-718, 857-860, 1074, 1201 | PASS |
| write_ledger.measured always false in lever-sweep harness | grep "measured: false" 42-lever-sweep-harness.cjs | lines 340, 527 | PASS |
| No --out-dir flag in runbook | grep -c out-dir 42-DEFERRED-RUN-RUNBOOK.md | 0 | PASS |
| "never netted" statement in cost-savings report | grep "never netted" 42-COST-SAVINGS-REPORT.md | line 6 | PASS |
| All 6 phase commits exist in git log | git log --oneline 263b0e8 98b0dfb 7ad0f6c a414d57 58d92bc d910e9b | all 6 found | PASS |

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|---------|
| COST-01 | 42-01, 42-04 | Per-write + per-recall token cost measured vs baseline | MET (recall now; write deferred) | Recall: injection-efficiency-harness, 93%. Write: lever-sweep-harness built, measured:false now, STEP 3 of runbook for real run |
| COST-02 | 42-01, 42-04 | Levers tuned for measured net reduction with no accuracy regression | MET ($0 proxy now; KU+LOCOMO deferred) | consolSkipThreshold=0.5 at +60pp skip; KU --dry-run only; STEPS 2+4 of runbook for accuracy gate |
| COST-03 | 42-03 | Savings vs competitors stated defensibly with sources | MET | 42-COST-SAVINGS-REPORT.md 162 lines, committed; no inflated metrics; recall/write separated; competitor citations with methodology notes |
| COST-04 | 42-02 | Progressive disclosure evaluated; adopted only on measured token win | MET | Harness ran LLM-free; challenger-wins-top-k verdict; DECLINED with documented fidelity-gap reasoning; MCP tool not built per D-09 |

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|---------|--------|
| — | — | No TBD/FIXME/XXX markers found in committed harness files or planning documents | — | — |
| — | — | No ANTHROPIC_API_KEY / OPENAI_API_KEY in committed harness source | — | — |
| 42-lever-sweep-harness.cjs | 302, 340, 527 | write_ledger.measured=false with explicit documented reason (build-only constraint per D-06) | INFO | Not a stub — intentional and documented. Build-only scope confirmed by phase context. |

No blockers. No warnings. The `measured:false` entries are intentional phase-constraint markers, not stubs — the reason is in the source and in the summary.

---

### No-Inflated-Metrics Audit (CLAUDE.md Hard Rule)

The following checks were applied to 42-COST-SAVINGS-REPORT.md:

- "93%" recall-side savings: labeled as "vs 34 archived memory facts (7,048 tok flat baseline)" — the denominator is stated and honest. Not rounded up from a smaller number (actual calculation: (7048-496)/7048 = 93.0%).
- "N=3" breakeven: derived inline `ceil(15696 / 6552) = ceil(2.39) = 3` — reproducible from the two cited source JSON files.
- Write-side cost is never added to recall-side savings: explicit statement "Recall and write costs are never netted into a single number" on line 6 of the report.
- mem0 93.2%: cited from arXiv 2504.19413 Table 2 (peer-reviewed) — not paraphrased as "recense matches mem0." One-line methodology note included.
- claude-mem ~10x: cited as "secondary sources only, no primary benchmark" — labeled [ASSUMED]. Recense does not claim to match or beat this figure. The 42-02 numbers (−52.82% on fixed-top-5) are explicitly contrasted: "NOT ~10x."
- Breakeven N=3 is a favorable number vs the old probe's N=20 — the report explains why (larger flat baseline) and is transparent about the derivation. No inflation.

VERDICT: COMPLIANT. Every figure interview-defensible.

---

### Human Verification Required

None. All phase deliverables are committed code, planning documents, or runbooks with deterministic behavior. The deferred battery (runbook execution at next weekly reset) is a scheduled work item with concrete commands, not a verification gap requiring human judgment on the current deliverables.

---

## Gaps Summary

No gaps. All four COST requirements are met at the build-only scope established by D-06 and the 2026-06-24 founder steer. The deferred battery items (write-side token measurement, KU accuracy validation, LOCOMO/LongMemEval confirm) are documented in a concrete 281-line runbook with exact single-line commands, cost-probe gate, and D-05 accept/reject criteria. Deferral-with-concrete-runbook is the intended outcome per D-06, not a gap.

---

_Verified: 2026-06-24T20:00:00Z_
_Verifier: Claude (gsd-verifier)_
