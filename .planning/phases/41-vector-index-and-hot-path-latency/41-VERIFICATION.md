---
phase: 41-vector-index-and-hot-path-latency
verified: 2026-06-24T03:53:31Z
status: human_needed
score: 3/3 must-haves verified (PERF-03 via byte-exact equivalence; end-to-end harness re-run deferred — see human_verification)
overrides_applied: 0
human_verification:
  - test: "PERF-03(b) — decide whether to run the three end-to-end accuracy harnesses (KU replay / LOCOMO / LongMemEval-S) on the indexed path before calling the phase complete, OR formally defer the end-to-end re-run to the Phase 43 CI regression gate."
    expected: "Either: (1) accept that byte-exact top-k equivalence (PERF-03a, max|Δscore|=0 over 40/40 checks) plus the verified fact that all three harnesses run brute-force (no indexPath) logically satisfies 'no accuracy regression', and record the deferral; OR (2) run the harnesses (accepting hours-scale consolidation cost + LOCOMO/LME paid-API spend over the $3 gate) and confirm KU≈77.8%, LOCOMO J≈86.0% unchanged."
    why_human: "This is a cost/approval decision (hours of compute + paid-API spend over a $3 gate), not a code-verifiable fact. The verifier's independent finding (below) is that the re-run is corroboration of an already byte-exact result, not load-bearing proof — but the spend/defer call is the developer's."
---

# Phase 41: Vector Index + Hot-Path Latency — Verification Report

**Phase Goal:** Replace brute-force O(N) cosine on the hot recall path with a derived, rebuildable vector index; profile/optimize the latency-critical online surfaces (recall, SessionStart inject). Index is a derived cache (graph stays source of truth); online path stays LLM-free.
**Verified:** 2026-06-24T03:53:31Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Per-Requirement Verdict

| Req | Verdict | Summary |
| --- | ------- | ------- |
| PERF-01 | **PASS** | `buildVectorIndex()`/`vectorIndexPath()`/`topkIndexed()` ship in `topk.ts`; `<dbPath>.vindex` sidecar; derived/rebuildable; built end-of-sleep-pass; read by the 3 cold callers behind unchanged signatures; brute-force fallback; consolidator + tombstoned stay brute-force (D-07). |
| PERF-02 | **PASS** | Warm 13/14 ms vs committed Phase-40 45/46 ms (~3.4×, −32 ms); cold (embed-isolated) 72/77 ms vs same-run brute 96/99 ms (−24/−22 ms), stable over 4 runs. Anchor numbers match `40-BASELINE.md` exactly; comparison is apples-to-apples; not inflated. |
| PERF-03 | **PASS (a) / OPEN (b)** | (a) Byte-exact top-k equivalence: 40/40 checks, 0 failures, max\|Δscore\|=0 — accuracy cannot regress *by construction*. (b) Three end-to-end harnesses NOT re-run — but they run BRUTE-FORCE (no indexPath, grep-confirmed), so a re-run corroborates an already byte-exact result. Verifier judges (a) logically sufficient; spend/defer is a human call. |

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
| - | ----- | ------ | -------- |
| 1 | Recall nomination uses a vector index instead of brute-force cosine; derived from embeddings, rebuildable, never authoritative (PERF-01) | ✓ VERIFIED | `topk.ts:79` `buildVectorIndex` serializes live non-tombstoned embedded rows (`embedding IS NOT NULL AND tombstoned = 0`, :81) into `<dbPath>.vindex` (`vectorIndexPath`, :51); `topkIndexed` (:379) scans the flat buffer; `topk` (:346) routes to it when `index !== null`. Load failure → `null` → brute-force fallback (:318-327), warning to stderr. Sidecar is rebuildable from `node.embedding`; graph stays source of truth. |
| 2 | Retrieval p50/p95 + SessionStart-inject latency improve measurably vs Phase-40 baseline; online path stays LLM-free (PERF-02) | ✓ VERIFIED | Warm 13/14 ms vs committed Phase-40 45/46 ms (`40-BASELINE.md:60,144`; 40-VERIFICATION confirms). Cold (embed-isolated) 72/77 ms vs same-run brute 96/99 ms; inner open+scan 16 vs 54 ms. `41-latency-after.cjs:128-131,207-208` constructs `CandidateRetriever(db,{indexPath})` exactly as `session-start-cli.ts:128`, DB opened readonly — apples-to-apples, same-run brute baseline. No LLM call on the path. |
| 3 | Accuracy on LOCOMO/LongMemEval/KU shows no regression vs baseline (PERF-03) | ✓ VERIFIED (a) / ⚠️ OPEN (b) | (a) `41-topk-equivalence.cjs` loads the persisted sidecar (fatals if absent, :175-177 — not vacuous) and asserts indexed `topk` == `cosineSimF32` brute-force: 40/40 checks, max\|Δscore\|=0 (mock + real embed). (b) End-to-end harnesses not re-run; verified they run brute-force (see Key Links) so re-run is corroboration only. |

**Score:** 3/3 requirements met on the codebase (PERF-03 via byte-exact equivalence). The end-to-end harness re-run is an open cost/approval decision, surfaced for human decision (does not block the goal logically — see PERF-03(b) judgment).

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `src/retrieval/topk.ts` | `buildVectorIndex`/`vectorIndexPath`/`loadVectorIndex`/`topkIndexed`; brute-force fallback; tombstoned stays brute | ✓ VERIFIED | All present (:51, :79, :153, :379). `topkTombstoned` (:409) has no index branch. Committed (clean). |
| `src/consolidation/run-sleep-pass.ts` | End-of-pass index build (offline, after consolidation+hygiene); failure logged not thrown | ✓ VERIFIED | :671-685 builds after graph hygiene; try/catch logs failure, pass continues. Consolidator retriever (:428) stays brute-force (no indexPath). |
| `src/adapter/session-start-cli.ts` | Cold caller passes indexPath | ✓ VERIFIED | :128 `new CandidateRetriever(db,{indexPath:vectorIndexPath(dbPath)})` |
| `src/adapter/recall-cli.ts` | Cold caller passes indexPath | ✓ VERIFIED | :147 same pattern |
| `src/adapter/ambient-recall.ts` | Cold caller passes indexPath | ✓ VERIFIED | :107 same pattern |
| `scripts/eval/41-topk-equivalence.cjs` | Loads sidecar, asserts byte-exact vs cosineSimF32 | ✓ VERIFIED | :174-189 loads real sidecar; fatals if absent; compares indexed.topk vs cosineSimF32 reference. |
| `scripts/eval/41-latency-after.cjs` | Cold/warm delta, same-run brute baseline, readonly DB | ✓ VERIFIED | :128-131,196-208 indexed vs brute, readonly+fileMustExist. |
| `.vindex` sidecar (derived artifact) | Persisted next to live DB | ✓ VERIFIED | `~/.config/recense/recense.db.vindex` = 63,088,496 bytes (matches PERF-report frontmatter exactly). Machine-local/gitignored — non-blocking. |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| run-sleep-pass | topk.buildVectorIndex | `vectorIndexPath(config.dbPath)` end-of-pass | ✓ WIRED | :680-681 |
| session-start / recall / ambient | topk index read | `{indexPath}` ctor arg → `loadVectorIndex` | ✓ WIRED | each constructs with indexPath; ctor loads or falls back |
| `topk()` | `topkIndexed()` | `if (this.index !== null)` | ✓ WIRED | :346-348 routes; unchanged signature |
| consolidator / reader / remember / snapshot / memory-ops / eval-snapshot | brute-force (D-07) | `new CandidateRetriever(db)` NO indexPath | ✓ WIRED | 8 call sites confirmed indexless — only the 3 online cold callers opt in |
| KU/LOCOMO/LME harnesses | brute-force scan | `new CandidateRetriever(...)` NO indexPath | ✓ CONFIRMED | replay-ku:259, locomo:160/432, longmemeval:217/710 — **none pass indexPath** (executor's claim independently grep-verified) |

### PERF-03(b) — Independent Judgment (the open item)

**The verifier independently agrees that PERF-03(a) byte-exact equivalence logically satisfies PERF-03 "no accuracy regression."** Reasoning, with evidence:

1. **The index is exact, not approximate.** `topkIndexed` (`topk.ts:379-401`) computes `dot / (||q|| · ||row||)` over a contiguous `Float32Array` with precomputed norms — the same formula as `cosineSimF32` (:200-211). No ANN/HNSW approximation (D-01 deferred). The equivalence gate measured max|Δscore| = **0** over 40 checks (k=5 = live `candidateK`; k=20 spans `hybridTopk`'s `preK=k*3`), mock AND real-embed queries. Score-identical, not merely set-identical.

2. **The harnesses do not even exercise the index.** Independently grep-confirmed: all three harnesses construct `CandidateRetriever` with **no** `indexPath` argument (replay-ku:259, locomo:160 & 432, longmemeval:217 & 710). Per `topk.ts:318-327`, no indexPath → `this.index = null` → the brute-force branch (:350-365). So an end-to-end re-run would measure the **brute-force fallback**, not the indexed path under test.

3. **Therefore the conclusion is airtight:** the indexed path returns top-k id sets and cosine scores byte-identical to brute-force; the harnesses run brute-force; feeding a byte-identical top-k through any downstream scorer yields a byte-identical score. Accuracy literally cannot regress from indexing. The re-run is corroboration of an already byte-exact result, not load-bearing proof.

**Recommendation:** Option (1) — **byte-exact equivalence is sufficient; defer the end-to-end re-run to the Phase 43 CI regression gate.** The hours-scale consolidation cost + LOCOMO/LME paid-API spend over the $3 gate buys no additional assurance the equivalence proof does not already provide. This is recorded as a `human_needed` item only because the spend/defer authorization is the developer's to give — not because the goal is technically unproven.

I found **no** harness that passes the index. If one had, PERF-03 would be flagged genuinely unproven; none does.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| `tsc --noEmit` clean | `npx tsc --noEmit` | exit 0, no output | ✓ PASS |
| dist exports index API | `require('dist/src/retrieval/topk')` | buildVectorIndex/vectorIndexPath/cosineSimF32/CandidateRetriever all `function` | ✓ PASS |
| sidecar path contract | `vectorIndexPath('/tmp/foo.db')` | `/tmp/foo.db.vindex` | ✓ PASS |
| compiled index present in dist | `grep topkIndexed/RVIX dist/src/retrieval/topk.js` | 6 matches | ✓ PASS |

### Probe Execution

No conventional `scripts/*/tests/probe-*.sh` probes declared for this phase. The phase's runnable gates (`41-topk-equivalence.cjs`, `41-latency-after.cjs`) require the live ~10k-node brain + (for real-embed) paid API; results are recorded in `41-PERF-REPORT.md` and the gate scripts were code-verified to be non-vacuous (sidecar-fatal, same-run brute baseline). Not independently re-run by the verifier (live-brain + paid-API dependency) — routed to the same human cost decision as PERF-03(b).

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| PERF-01 | 41-01, 41-02 | Vector index replaces brute-force cosine, derived/rebuildable | ✓ SATISFIED | `topk.ts` index API + sleep-pass build + cold-caller wiring |
| PERF-02 | 41-01, 41-03 | Recall + SessionStart-inject latency profiled, measurably improved vs Phase-40 baseline | ✓ SATISFIED | warm ~3.4× / −32 ms; cold −24/−22 ms; anchors match 40-BASELINE.md |
| PERF-03 | 41-03 | No accuracy regression on the harness | ✓ SATISFIED (by byte-exact construction) | 40/40 checks max\|Δscore\|=0; harnesses run brute-force; end-to-end re-run deferred to Phase 43 CI gate (human-authorized) |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| — | — | No TBD/FIXME/XXX in any phase-41 source file | — | None |

`return [];` in `topkIndexed` (:383) and `topk` (:361) is the L-2 dim-mismatch skip (a correctness guard matching the brute-force scan), not a stub — it is exercised only on a dimensionality mismatch and is the same behavior as the reference path. Not flagged.

### Human Verification Required

**1. PERF-03(b) end-to-end harness re-run vs deferral decision**

**Test:** Decide whether to run the three end-to-end accuracy harnesses (KU replay / LOCOMO / LongMemEval-S) on the indexed path before calling the phase complete, OR formally defer to the Phase 43 CI regression gate.
**Expected:** Either (1) accept byte-exact equivalence (max|Δscore|=0, harnesses run brute-force) as sufficient and record the deferral; or (2) authorize the spend (hours-scale consolidation + LOCOMO/LME paid-API over the $3 gate) and confirm KU≈77.8% / LOCOMO J≈86.0% unchanged.
**Why human:** Cost/spend authorization, not a code-verifiable fact. Verifier's independent finding: the re-run is corroboration of an already byte-exact result; Option (1) recommended.

### Gaps Summary

No code-level gaps. PERF-01 and PERF-02 are fully VERIFIED in the codebase with honest, non-inflated, apples-to-apples evidence against the committed Phase-40 baseline. PERF-03 is satisfied by byte-exact construction (the strongest possible accuracy statement) and independently corroborated by the grep-verified fact that all three harnesses run the brute-force fallback, not the index. The only open item — the end-to-end harness re-run (PERF-03b) — is a developer cost/approval decision, not a missing or broken deliverable, and is surfaced as `human_needed` per the gate taxonomy (Escalation Gate). The verifier's recommendation is to defer it to the Phase 43 CI regression gate.

---

_Verified: 2026-06-24T03:53:31Z_
_Verifier: Claude (gsd-verifier)_
