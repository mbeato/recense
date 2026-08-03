---
gsd_state_version: 1.0
milestone: v10.0
milestone_name: Action Proposals
status: planning
stopped_at: Phase 67 context gathered
last_updated: "2026-08-03T08:02:36.895Z"
last_activity: 2026-08-03
progress:
  total_phases: 8
  completed_phases: 5
  total_plans: 57
  completed_plans: 57
  percent: 63
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-07-29 — v10.0 Action Proposals opened)

**Core value:** The memory learns and stays correct over time — forms generalizations the user never stated, and updates the right belief in place when a fact changes.

**Current focus:** Phase 69 — retrieval upgrade entity anchored ambient recall

**v9.0 Key research grounding (June-2026 deep-research pass — historical, still load-bearing for RESOLVE/DRIFT reuse):**

- Dense cosine structurally cannot separate contradictions/negations (NevIR near-random; "Semantic Collapse") — the fix is broadening candidate generation, not swapping the embedder
- mem0 and Zep also gate on dense top-k (sharing recense's miss on KU contradictions)
- An off-the-shelf reranker over fused top-k HURT in the research — do NOT add without measuring
- All external magnitudes (+11.2pp recall, judge-fires) are 2026 arXiv preprints / vendor-self-reported — validate on own data before claiming

**v10.0 Key research grounding (2026-07-29 research pass, HIGH confidence — see `.planning/research/{SUMMARY,ARCHITECTURE,PITFALLS}.md`):**

- Net-zero new runtime dependencies holds across all of v10.0 (verified against live source + current external docs)
- Gmail `users.history.list` has no `q` parameter — per-account query scoping is backfill-only; incremental pulls are unfiltered (EMAIL-02, Phase 62)
- Every Gmail episode shares the literal `session_id: 'ingest:gmail'` — `countDistinctProvenance` cannot fire on email-only evidence until the provenance-distinctness key is redesigned (DRIFT-03, Phase 65) — a hard prerequisite for the differentiator, not an optimization
- The milestone's largest new correctness risk is a "D-43-for-proposals" self-confirmation vector on the approve/reject write path (EMIT-05, Phase 66) — this exact defect class has shipped twice before (a pre-launch critical finding, then v9.0's live C-2)
- No competitor publishes a methodology-disclosed accuracy number for email-to-status classification — no external bar to cite (DRIFT-05)

## Current Position

Phase: 69
Plan: Not started
Status: Ready to plan
Last activity: 2026-08-03

## Performance Metrics

**Velocity (historical baseline):**

- Total plans completed: ~191 (v1.0: 42, v2.0: 14, v3.0: 42, v3.1: 8, v4.0: 22, v5.0: 21, v6.0: 16, v7.0: ~26, v8.0: ~24, quick-tasks: ~30)
- Average plan duration: ~20–25 min

**By Milestone:**

| Milestone | Phases | Plans | Shipped |
|-----------|--------|-------|---------|
| v1.0 | 1–8 | 42 | 2026-06-09 |
| v2.0 | 9–10 | 14 | 2026-06-10 |
| v3.0 | 11–17 | 42 | 2026-06-13 |
| v3.1 | 18–19 | 8 | 2026-06-15 |
| v4.0 | 20–23 | 22 | 2026-06-17 |
| v5.0 | 24–28 | 21 | 2026-06-19 |
| v6.0 | 29–34 | 16 | 2026-06-22 |
| v7.0 | 35–39.1 | ~26 | 2026-06-23 |
| v8.0 | 40–45 | 24 | 2026-06-26 |
| v9.0 | 46–61 | 92 | 2026-07-20 |
| v10.0 | 62–68 | TBD | in progress |
| Phase 56 P01 | 20min | 2 tasks | 3 files |
| Phase 56 P03 | 15min | 3 tasks | 3 files |
| Phase 56 P02 | 15min | 2 tasks | 1 files |
| Phase 56 P04 | 20min | 2 tasks | 1 files |
| Phase 62 P16 | 37min | 4 tasks | 9 files |
| Phase 62 P17 | 33min | 2 tasks | 4 files |
| Phase 62 P18 | 21min | 2 tasks | 5 files |
| Phase 62 P19 | 44min | 3 tasks | 2 files |

## Accumulated Context

### v10.0 Phase Map

| Phase | Name | Requirements | Depends on | Parallel? |
|-------|------|--------------|------------|-----------|
| 62 | Multi-Inbox Email Ingest Hardening | EMAIL-01..04 | — | Start here |
| 63 | Offline Intent Classification | CLASSIFY-01..04 | 62 (EMAIL-03 hard prerequisite) | After 62 |
| 64 | Entity Resolution Hardening | RESOLVE-01..03 | 63 | After 63 |
| 65 | Belief-Gated Status Drift + Provenance-Distinctness Fix | DRIFT-01..05 | 63, 64 | After 63, 64 |
| 66 | Domain-Neutral Proposal Emit Seam | EMIT-01..07 | 64, 65 | After 65 |
| 67 | Reference Consumer Adapter | CONSUME-01..03 | 66 | Parallel with 68 |
| 68 | Telegram HITL Belief-Kind Extension | APPROVE-01..04 | 66 | Parallel with 67 |

**Foundation-phase call:** research's `SUMMARY.md` proposed a standalone "Proposal Schema & Sink Foundation" phase (the `action_proposal` table + `ActionProposalSink`) ahead of classification. Folded into Phase 66 instead — it owns no REQ-IDs of its own (its deliverables are exactly EMIT-01/EMIT-02), and neither Phase 63 nor Phase 64 ever touches that table (both only add optional fields to the in-memory `ClaimDecision`), so nothing upstream of Phase 66 is gated on the table shape existing early. See ROADMAP.md's v10.0 Phase Details preamble for the full rationale.

### v10.0 Coverage

30 requirements / 7 phases — 100% coverage:

| Requirement | Phase |
|-------------|-------|
| EMAIL-01 | 62 |
| EMAIL-02 | 62 |
| EMAIL-03 | 62 |
| EMAIL-04 | 62 |
| CLASSIFY-01 | 63 |
| CLASSIFY-02 | 63 |
| CLASSIFY-03 | 63 |
| CLASSIFY-04 | 63 |
| RESOLVE-01 | 64 |
| RESOLVE-02 | 64 |
| RESOLVE-03 | 64 |
| DRIFT-01 | 65 |
| DRIFT-02 | 65 |
| DRIFT-03 | 65 |
| DRIFT-04 | 65 |
| DRIFT-05 | 65 |
| EMIT-01 | 66 |
| EMIT-02 | 66 |
| EMIT-03 | 66 |
| EMIT-04 | 66 |
| EMIT-05 | 66 |
| EMIT-06 | 66 |
| EMIT-07 | 66 |
| CONSUME-01 | 67 |
| CONSUME-02 | 67 |
| CONSUME-03 | 67 |
| APPROVE-01 | 68 |
| APPROVE-02 | 68 |
| APPROVE-03 | 68 |
| APPROVE-04 | 68 |

### Engine Invariants (load-bearing, every phase)

- Sleep pass is the sole graph writer
- Single-tenant; no multi-tenant namespaces
- Graph is source of truth; vector store is derived cache
- Never delete an evidence-backed fact via decay
- Surfacing/inference never strengthens a belief (D-43) — extended in Phase 66 to a "D-43-for-proposals" sentinel covering approve/reject writes
- Online paths (SessionStart inject, retrieval, /v1/surface, /v1/proposals) stay LLM-free
- `source:'hitl'` episodes excluded from consolidation — Phase 63 must inherit this structurally, not re-implement it
- Agents live outside the engine (clients/, not src/) — enforced per-client via its own tsconfig + import-boundary test
- Net-zero new runtime dependencies
- No accuracy regression accepted for a latency/token win

### v9.0 Phase Map

| Phase | Name | Requirements | Depends on | Parallel? |
|-------|------|--------------|------------|-----------|
| 46 | Reconsolidation Candidate Broadening | RECON-01..04 | — | Start here |
| 47 | Hybrid Retrieval Recall | RETR-01..04 | 46 | After 46 |
| 48 | Correctness Hardening | HARD-01..04 | — | Parallel with 46/47 |
| 49 | Scale + Data-Model Spike | SCALE-01..02 | — | Parallel with 46/47/48 |
| 50 | Verification + Regression Gates | GATE-01..03 | 46, 47, 48 | Capstone |

### v9.0 Coverage

13 requirements / 5 phases — 100% coverage:

| Requirement | Phase |
|-------------|-------|
| RECON-01 | 46 |
| RECON-02 | 46 |
| RECON-03 | 46 |
| RECON-04 | 46 |
| RETR-01 | 47 |
| RETR-02 | 47 |
| RETR-03 | 47 |
| RETR-04 | 47 |
| HARD-01 | 48 |
| HARD-02 | 48 |
| HARD-03 | 48 |
| HARD-04 | 48 |
| SCALE-01 | 49 |
| SCALE-02 | 49 |
| GATE-01 | 50 |
| GATE-02 | 50 |
| GATE-03 | 50 |

### Roadmap Evolution

- **Phase 69 added 2026-08-02:** Retrieval Upgrade — Entity-Anchored Ambient Recall. Promoted from `SEED-005`, which was written from a live transcript audit (1,942 real user turns / 302 sessions / 5 projects, `scripts/eval/recall-audit.py`) rather than from intuition. Measured drivers: ambient recall is flat cosine top-5 with no graph hop on the injected path (`retrieveRanked` with `queryText=undefined`); 49% of scoped injected lines are foreign-project and outscore own-project lines (0.541 vs 0.530); proper-noun queries whiff (the "contract with vtx" class was asked twice and whiffed twice with the facts present); the 1-hop edges `buildHonestOneHopTrace` computes are handed to the viz and discarded before injection. Placed AFTER Phase 64 deliberately — 64's SC-1 builds the broadened candidate generator (exact/entity-keyed ∪ BM25 ∪ dense over RECON) that this phase's entity anchoring should reuse rather than duplicate into a second divergent generator. Carries an explicit **D-S1 reversal** (scope becomes a retrieval signal) that must be recorded in the phase CONTEXT. Gated on a 58-prompt memory-shaped eval set from real sessions. (Same SDK `phase.add` 999-sentinel misnumber as 52/54/56/57 — it matched `999.3-MIGRATION.md` in Phase 24's free text; manually corrected to 69 and the misplaced end-of-file entry relocated into the v10.0 phase list.)
- **v10.0 roadmapped 2026-07-29:** 7 phases (62–68), 30 requirements, 100% coverage. Promoted from ROADMAP backlog B-01. Research proposed 8 phases; "Proposal Schema & Sink Foundation" folded into Phase 66 (no REQ-IDs of its own; the table shape isn't load-bearing until Phase 66's own emission/HTTP workstreams need it — see ROADMAP.md rationale). Dependency chain: 62 → 63 (EMAIL-03 hard prereq for CLASSIFY-01) → 64 → 65 → 66 → {67, 68} parallel. Two live-code-verified constraints carried in as phase-level notes: Gmail query-scoping is backfill-only (Phase 62), and the `session_id:'ingest:gmail'` provenance collapse blocks the differentiator until redesigned (Phase 65). EMIT-05's "D-43-for-proposals" sentinel is the milestone's largest correctness risk, closed structurally in Phase 66, not just documented.
- **Phase 57 added 2026-07-02:** viz activity-palette redesign — hue = identity, salience = motion/scale. Founder-requested at the 56-05 checkpoint after the brightness-scaling salience model required founder rescue for the third time (54 replay, 55 hops, 56 spontaneous): dimming saturated hues on the dark additive-blended bg drives every subordinate layer below the perceptual floor. Luminance-equalized pastel/bioluminescent identity palette; SC3 ordering moves to attack/halo/cadence/density constants; one bloom calibration pass; founder checkpoint. Presentation-only. Candidate requirements from 56-REVIEW.md advisories (WR-02 invariant lock, WR-06 trace-fade clobber). (Same SDK `phase.add` 999-sentinel misnumber as 52/54/56; manually corrected to 57.)
- **Phase 56 added 2026-07-01:** Spontaneous 1-hop idle activation — honest "default-mode" brain wandering for `recense viz`. Read-only SSE-only idle emitter fires genuinely-new real semantic (PRED_SET) 1-hop spreads in a distinct color under `kind='spontaneous'` so the brain feels alive with an empty replay buffer, without fabricating edges or writing `activation_trace`. Activity ordering live > replay > spontaneous > twinkle; tray icon does not pulse on it. Deferred-from-54 layer; scoped after the Phase 55 idle-activity founder session (replay cadence tuned 4s→2.5s in the same session). SPONT-01..06 / 4 SCs. (Same SDK `phase.add` 999-sentinel misnumber as 52/54; manually corrected to 56.)
- **Phase 54 added 2026-06-30:** Viz Ambient Liveliness + Replay Traces — presentation-layer follow-up to 53. Three-layer activity hierarchy (live recall amplification > replay echo of recent real `activation_trace` rows during idle gaps > ambient twinkle), keeping the viz server read-only/LLM-free and preserving the Phase 52 honest-traces invariant. Fresh spontaneous retrievals deferred. Approved spec: `docs/superpowers/specs/2026-06-30-viz-ambient-liveliness-replay-traces-design.md`. (Same SDK `phase.add` 999-sentinel misnumber as Phase 52; manually corrected to 54.)
- **Phase 52 added 2026-06-29:** Brain Viz Honest Traces — presentation-layer rework of `recense viz` trace firing (drive recall animation from real scored 1-hop hops, decay-tail glow, bridge ingestion events with per-event color vocabulary, reconsolidation as hero magenta flash). Orthogonal to v9.0 (46–51); no engine/consolidation changes. Approved design spec: `docs/superpowers/specs/2026-06-29-brain-viz-honest-traces-design.md`. (SDK `phase.add` mis-numbered it 999 via sentinel fallback on the decimal/reconstructed roadmap numbering; manually corrected to 52.)
- **v9.0 opened 2026-06-27:** 5 phases (46–50), 17 requirements. Grounded in June-2026 deep-research pass. Phase 43 Eval Regression Gates (GATE-01/02/03) carried from v8.0 deferred into Phase 50. Phase 46 resolves backlog 999.2 (the reconsolidation-judge-fires-zero root cause). Phase 48 closes four ARCH-REVIEW findings (C-2/M-5/M-9/L-2). Phase 49 is spike-first with explicit "defer" as a valid outcome. Dependency shape: 47 depends on 46; 50 depends on 46–48; 48 and 49 are independent and can run in parallel with 46/47.

### v8.0 Carryover Context

- **Suite at v8.0 close:** 2383 passed / 3 skipped; tsc clean. Branch `fix/ci-stale-tests-clean` has the CI-stale-test fix (260626-dvi); confirmed clean.
- **Phase 43 was NOT built** — eval regression gates (GATE-01/02/03) carried forward as Phase 50. Phase 41 PERF-03(b) 3-harness re-run is included in Phase 50's GATE-03 scope.
- **Live-brain numbers (v8.0-final baseline):** LoCoMo J=86.0% (relative-only, lenient judge), R@5/R@10=77.3/82.2%, retrieval p50/p95=45/46ms over ~11.3k nodes, marginal write ~7,118 tok/turn (0% Sonnet escalation). These are the pre-v9.0 baseline for Phase 50 gates.
- **Phase 39.1-05 Task 2** (live hub/subject doc-verification) deferred async from v7.0 — still open.

### Key v9.0 Decisions (to record as made during phases)

- **Phase 55-01 (2026-06-30):** `retrieveRanked` ambient trace enrichment — `AMBIENT_HOP_TOPN=6` kept as a private module-level constant (D-01/D-02, not exported; test guards assert the literal per plan discretion); kind allowlist stays exactly `kind==='relation'` (D-05/D-05a default lean, `links_to`/`extends` included); liveness filter applied before weight-sort/truncate inside a new `buildAmbientTracePayload` helper (D-07, closes the Pitfall 2 displacement bug class); no batching of per-seed edge reads (RESEARCH Flag 3 — naive loop is strictly less work than the existing `retrieveCueless` pattern on the same hot-path budget).

## Deferred Items

Acknowledged and deferred at v9.0 milestone close on 2026-07-20:

| Category | Item | Status |
|----------|------|--------|
| uat_gap | Phase 57 — founder re-observation of corrected CR-01/CR-02 viz behavior (code-verified + regression-tested) | partial |
| uat_gap | Phase 58 — fps overlay number + D-14 visual artifact never captured (founder approved live at both checkpoints) | partial |
| requirement | RETR-03 — fusion ships dark (w*=0 honest null); re-tune when future data supports a positive weight | accepted-null |
| todo | cache-constant judge/extraction prompt prefix via system prompt | pending |
| todo | content-hardening-deferred | pending |
| todo | corpus-brain-3d-transition | pending |
| todo | viz-search-and-hull-quality | pending |
| seed | 003-multi-tenant-namespaces | dormant |
| seed | 004-telegram-responder-as-reference-client | dormant |
| verification | Pre-v9.0 human_needed VERIFICATIONs (28, 34, 39.3, 41, 44) — shipped milestones, carried context | open |
| metadata | 46 historical quick tasks flagged "missing" metadata in audit-open scan (all completed work; bookkeeping noise) | noise |

Carried from v7.0/v8.0 close:

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| Phase 39.1 validation | Plan 39.1-05 Task 2 — live hub/subject doc generation + per-scope verification | Deferred ASYNC post-close (founder decision 2026-06-23). Retroactive checklist in `39.1-05-SUMMARY.md`. | 2026-06-23 |
| Phase 43 eval gates | GATE-01/02/03 — now Phase 50 | Promoted to Phase 50 in v9.0 | 2026-06-26 |
| Phase 41 accuracy recheck | PERF-03(b) 3-harness end-to-end re-run | Included in Phase 50 / GATE-03 | 2026-06-26 |
| Retrieval scaling | Brute-force cosine → sqlite-vec ANN (trigger: measurably hurts at real scale) | Phase 49 will measure crossover | 2026-06-07 |
| Consolidation hardening | Lock-heartbeat for >30-min passes — heartbeatLock() | RESOLVED 2026-07-01 — quick task 260701-mmh wired startLockHeartbeat() into all six lock holders | 2026-06-17 |
| HTTP | True remote VPS + Caddy/TLS exposure (CR-01) | Deferred from Phase 12 | 2026-06-11 |
| HTTP | readBody multibyte UTF-8 chunk-boundary corruption (CR-02) | Deferred from Phase 12 | 2026-06-11 |
| Viz perf | Phase 19 selection-rotation choppiness | Won't-fix — founder decision | 2026-06-14 |

## Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 260802-m2e | Restore backlog lane 998.x → 999.x, fixing the recurring `gsd-sdk phase.add` 999 mis-numbering (5th occurrence: phases 52/54/56/57/69). Root cause was on disk, not in ROADMAP prose: GSD reserves only `999.x` and skips it via `num >= 999`, so two `998.x` dirs mis-named by 40ffcde (v9.0 archival) slipped the guard and made maxPhase=998 → next=999. Pure `git mv`, 6 files, 0 insertions/0 deletions; frontmatter already read 999.3. Verified `phase.add --dry-run` → 70 | 2026-08-02 | 6568059 | [260802-m2e-restore-backlog-lane-999](./quick/260802-m2e-restore-backlog-lane-999/) |
| 260729-s8a | Fix two causes of recense write-lock contention: remember-cli now retries the lock (600s budget) instead of fast-failing in 0.11s, and graph hygiene (VACUUM+dedup, measured 486s) is gated to once per 20h via meta instead of running on every per-turn sleep pass | 2026-07-30 | b817e69, e85c8a1 | [260729-s8a-retry-remember-lock-gate-graph-hygiene](./quick/260729-s8a-retry-remember-lock-gate-graph-hygiene/) |
| 260720-nup | Wire regression gate into CI merge-blocking (gate:ci offline tier + gate job + required-check context) — closes v9.0 audit GATE-01; branch-protection apply pending maintainer | 2026-07-20 | c114b5b, 6812ecd | [260720-nup-wire-regression-gate-into-ci-merge-block](./quick/260720-nup-wire-regression-gate-into-ci-merge-block/) |
| 260714-g0s | Move stats entry point from settings panel to HUD rail histogram button | 2026-07-14 | d49d117, f0c1ec5, d00a5e9 | [260714-g0s-move-stats-entry-point-from-settings-pan](./quick/260714-g0s-move-stats-entry-point-from-settings-pan/) |
| 260701-mmh | Thread startLockHeartbeat() through all six long-pass lock holders (closes 39.1 FIX-STALL-01 residual) | 2026-07-01 | 5167175, 10a6dd0 | [260701-mmh-thread-heartbeatlock-through-consolidato](./quick/260701-mmh-thread-heartbeatlock-through-consolidato/) |
| 260701-vix | .vindex sidecar v2 (per-row embedded_hash) + construction-time freshness diff/delta merge (closes 51-05 staleness follow-up) | 2026-07-01 | e886ade, eb825f7 | [260701-vix-fix-vindex-sidecar-staleness](./quick/260701-vix-fix-vindex-sidecar-staleness/) |
| 260701-brg | remember-bridge reconcile hop stores honest score:null (WR-02; client mid-intensity fallback keeps rendering identical) | 2026-07-01 | 5fe9533 | [260701-brg-remember-bridge-honest-null-score](./quick/260701-brg-remember-bridge-honest-null-score/) |
| 260701-bkp | Bookkeeping: wabt lockfile pin (51-04), stale SCHEMA_VERSION comments, headless-client billing-comment two-layer attribution (45-04 NOTE) | 2026-07-01 | ad56f32 | [260701-bkp-source-bookkeeping-sweep](./quick/260701-bkp-source-bookkeeping-sweep/) |
| 260701-exg | Exhaust-theme gate at both corpus promote seams (closes 39.1 zero-intervention exhaust-gate residual; docs-only, zero new LLM calls) | 2026-07-01 | 03a2083, 369cd50 | [260701-exg-exhaust-theme-gate](./quick/260701-exg-exhaust-theme-gate/) |

## Session Continuity

Last session: 2026-08-03T08:02:36.889Z
Stopped at: Phase 67 context gathered
Next: `/gsd:plan-phase 62` (Multi-Inbox Email Ingest Hardening) — first phase of v10.0, no dependencies.

## Operator Next Steps

- Plan Phase 62 with `/gsd:plan-phase 62` (or run `/gsd:discuss-phase 62` first — CLASSIFY and DRIFT phases carry research flags recommending a design pass before planning, but Phase 62 itself mirrors shipped v4.0 patterns and needs none)
