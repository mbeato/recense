# Phase 69: Retrieval Upgrade — Entity-Anchored Ambient Recall - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-03
**Phase:** 69-Retrieval Upgrade — Entity-Anchored Ambient Recall
**Areas discussed:** Requirements derivation, Entity-anchoring mechanism, D-S1 reversal & scope-nudge semantics, 1-hop injection budget, Evidence mode shape, Eval gating protocol

**Mode:** `--auto` — all areas auto-selected. SEED-005 (founder-originated, evidence-grounded in a 1,942-turn live audit) pre-decided most of this; the discussion mostly formalized it.

---

## Requirements derivation

| Option | Description | Selected |
|--------|-------------|----------|
| RECALL-01..05 derived 1:1 from the roadmap's five SCs / seed improvements 1-4 + eval gate; registered in REQUIREMENTS.md by the planner | Roadmap says "derive from SEED-005 during discuss/plan". | ✓ |
| Fold in improvement 5 (temporal) | Rejected — seed marks it a separate larger track; roadmap SCs exclude it. | |

## Entity-anchoring mechanism

| Option | Description | Selected |
|--------|-------------|----------|
| Reuse Phase 64's exported generator seam; LLM-free indexed token→entity lookup; dark knob | The roadmap's stated dependency rationale; hook latency constraint. | ✓ |
| Second recall-specific generator | Rejected — the exact duplication the roadmap warns against. | |
| Re-enable bm25FusionWeight | Rejected — honest null stands; different mechanism entirely. | |

## D-S1 reversal & scope-nudge semantics

| Option | Description | Selected |
|--------|-------------|----------|
| Deliberate PARTIAL reversal: scope becomes a bounded rank nudge on the ambient path, never a filter; recorded verbatim in CONTEXT D-01 | Roadmap explicitly demands the recorded reversal; F1 nuance (cross-project is load-bearing). | ✓ |
| Hard scope filter | Rejected — seed marks it WRONG (interview-prep pattern breaks). | |
| Skip the reversal record | Rejected — roadmap forbids slipping it in as implementation detail. | |

## 1-hop injection budget

| Option | Description | Selected |
|--------|-------------|----------|
| Reuse buildHonestOneHopTrace's already-computed edges; compact per-fact rendering; facts win over hops under budget pressure | Near-zero new I/O; 55-01 no-batching precedent inherited. | ✓ |
| Second edge-read pass for richer hops | Rejected — 55-01 rejected exactly this. | |

## Evidence mode shape

| Option | Description | Selected |
|--------|-------------|----------|
| recense recall evidence output: cited node ids + traversed edges, read-only, prose stays default | Attacks the verifiability gap that makes grep win. | ✓ |
| Replace prose mode | Rejected — prose is the human default; evidence is additive. | |

## Eval gating protocol

| Option | Description | Selected |
|--------|-------------|----------|
| Eval-first, dark knobs until the 58-prompt gate passes; hard gates verbatim from seed; JSONLs never committed | The seed's own "do this BEFORE changing retrieval" requirement. | ✓ |
| Ship live, evaluate after | Rejected — contradicts the seed and every phase-6x precedent. | |

---

## Claude's Discretion

Token heuristics; nudge mechanics/magnitudes; knob and flag names; hop/evidence output formats; generator-reuse refactor placement.

## Deferred Ideas

Temporal/episodic recall (next-milestone candidate); dark-rank-knobs measure-or-delete; bm25FusionWeight re-eval; B-02/B-03/B-04; 65-HUMAN-UAT items.

## Todos

Same four keyword-noise matches as 63-68; none folded.
