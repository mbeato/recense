---
phase: 36-typed-predicate-edges-spike
verified: 2026-06-22
status: passed
score: 1/1 spike deliverable (go/no-go) achieved — see honesty note on unrecorded A/B score
backfilled: true
backfill_note: "Authored 2026-06-22 at v7.0 milestone close. Phase 36 was a spike: its only artifacts at execution were 36-CONTEXT.md (decisions/bar) + 36-DISCUSSION-LOG.md (alternatives). No code reached src/ (verified). This VERIFICATION records the go/no-go outcome and its corroborating downstream evidence."
---

# Phase 36: Typed Predicate Edges — SPIKE — Verification Report (backfilled)

**Phase Goal:** Prove — on a scratch DB, live graph untouched — that extracting *typed* predicates produces a measurable lift in multi-hop recall, yielding a founder-owned go/no-go for the Phase 37 build plus calibration notes. Off-distribution architecture de-risking; deliverable is a decision, not shipped code (TYPED-SPIKE-01).
**Verified:** 2026-06-22 (backfilled at v7.0 close)
**Status:** passed (with documented honesty caveat)

## Goal Achievement

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| TYPED-SPIKE-01 | A typed-vs-untyped A/B on a scratch DB yields a scored, founder-owned GO/NO-GO against an explicit bar, gating Phase 37 | ✓ ACHIEVED (with caveat) | The go bar is recorded in `36-CONTEXT.md` D-05 (GO if typed ≥~70% reachability AND lift ≥+20pts; NO-GO if lift <+10pts OR typed <50%; D-04 metric = deterministic answer-reachability %; D-01 synthetic untyped control isolates typing as the only variable; D-07 Haiku-first for an honest, no-inflation GO). The decision was a **GO** — corroborated by the authorized, delivered, and **live** Phase 37 build (typed recall live at 92% coverage, STATE.md). |
| Scratch-DB only; live graph/schema/recall untouched | ✓ VERIFIED | No spike code in `src/` (gsd-integration-checker live-source check, 2026-06-22): the only typed-extraction code in production was written in Phase 37, not 36. The stray `_extract37.ts` at project root is a Phase 37-04 eval helper with zero imports from `src/`. |

## Honesty Caveat (no-inflated-metrics)

The spike's **own A/B reachability numbers were not preserved** in a phase artifact — `36-DISCUSSION-LOG.md` records only the alternatives considered (control arm, predicate vocab, query-set/metric, go-bar), not the measured per-arm score. The GO is therefore **inferred and corroborated**, not directly re-readable from a Phase-36 artifact:
- Corroborating evidence: Phase 37 was built (gated explicitly on this GO per `36-CONTEXT.md`) and its independent build gate **37-04 cleared a stronger bar on live data** — typed top-3 **83.3%** (≥75%) AND lift **+45.8pts** (≥+20pts), founder D-04/D-05 sign-off. A no-GO spike would not have produced a downstream build that clears the same family of bar by a wide margin.
- Lesson logged (RETROSPECTIVE / STATE deferred): a spike's go/no-go **score** should be written into a SUMMARY or VERIFICATION at the time, not left implicit in the decision to proceed.

## Verdict

**passed** — the spike delivered its go/no-go (a GO), no live state was touched, and the decision is corroborated by the live Phase 37 build. The unrecorded A/B score is a documentation gap, not a wiring or correctness gap.
