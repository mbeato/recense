# Phase 40: Competitive Benchmark Baseline - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-22
**Phase:** 40-competitive-benchmark-baseline
**Areas discussed:** Phase identity/sequencing, Cost gate (Max 20x budget), LOCOMO metric, Scoring protocol, Latency/token surface, Cite vs reproduce rivals, LOCOMO slice + frozen config

---

## Phase Identity & Sequencing (pre-discussion clarification)

Session memory framed "phase 40" as Corpus Quality, but live roadmap Phase 40 = Competitive Benchmark Baseline (Corpus Quality is Phase 39.1, 4/5 built). User confirmed they meant the live Phase 40.

User then questioned whether accuracy-affecting technical phases should run *before* the eval. Investigated: todo list empty, no backlog/deferred/future file, no v9 planned. Phases after 40 (41 latency, 42 token, 43 gates) are all accuracy-neutral by design; the accuracy gains already shipped as v7.0 (35–39). Only accuracy-adjacent deferred item (bi-temporal validity) was a deliberate v7.0 no. **Conclusion: sequencing is correct — baseline first, since 41/42 success criteria are defined relative to the Phase 40 baseline.** User: "if nothing comes up then maybe its fine" → nothing came up.

---

## Cost Gate (Claude Max 20x budget)

User asked what % of weekly 20x limit a full run consumes. Established: weekly cap isn't a published token number (estimate only); heavy run is Haiku+Sonnet (subscription general bucket, ~0% Opus), est. ~1–5% of weekly general budget; GPT-4o scorer + embeddings are direct $ independent of reset.

| Option | Description | Selected |
|--------|-------------|----------|
| Build now, run pre-reset | Finish design/build now (cheap); schedule heavy runs pre-reset with a 1-conv probe first | ✓ |
| Pause everything til pre-reset | Do the whole phase in one pre-reset block | |
| Just discuss, decide run later | Lock gray areas, defer run-timing | |

**User's choice:** Build now, run pre-reset — with a 1-conversation cost probe as a hard gate (D-01).
**Notes:** Heavy run is a detached schedulable process; design work shouldn't burn the quota window.

---

## LOCOMO Metric Reported

| Option | Description | Selected |
|--------|-------------|----------|
| Both, QA headline | QA accuracy (LLM-judge) headline + retrieval R@K diagnostic via existing top-k tap | ✓ |
| QA accuracy only | Just end-to-end QA accuracy | |
| Retrieval R@K only | Just retrieval recall@K | |

**User's choice:** Both, QA headline (D-04).

---

## Scoring Protocol

| Option | Description | Selected |
|--------|-------------|----------|
| Match rival protocol | Replicate mem0/Zep LoCoMo LLM-judge protocol + methodology note | ✓ |
| Own GPT-4o scorer | Reuse existing GPT-4o scorer for internal consistency | |
| Both, note the delta | Score with both, report the gap | |

**User's choice:** Match rival protocol (D-05) — research item: pin their exact judge model+prompt.

---

## Latency / Token Surface

| Option | Description | Selected |
|--------|-------------|----------|
| Both: live + repro script | Live 7000-node brain headline latency + committed synthetic-scale reproducibility script; token cost on LoCoMo corpus | ✓ |
| Live brain only | p50/p95 only on the real brain (not reproducible) | |
| LoCoMo corpus only | Everything on the reproducible corpus (understates scale latency) | |

**User's choice:** Both (D-06, D-07).

---

## Cite vs Reproduce Rivals

| Option | Description | Selected |
|--------|-------------|----------|
| Cite + methodology now | Published numbers + one-line methodology notes; reproduction deferred | ✓ |
| Hybrid: reproduce mem0 | Run mem0 head-to-head, cite the rest | |
| Reproduce all feasible | Run mem0 + Zep/Graphiti on identical harness | |

**User's choice:** Cite + methodology now (D-08); reproduction is a deferred stretch.

---

## LOCOMO Slice + Frozen Config

| Option | Description | Selected |
|--------|-------------|----------|
| Full standard LoCoMo-10 | All 10 convs, all categories; comparable to mem0/Zep; scale-gated by probe | ✓ |
| Core memory slices only | single/multi-hop/temporal; skip adversarial+open-domain | |
| Full set + per-category | Full + per-category breakdown | |

**User's choice:** Full standard LoCoMo-10 (D-09); per-category optional.

| Option | Description | Selected |
|--------|-------------|----------|
| Freeze at v7.0 tag | Build harness now; official baseline after 39.1-05 + v7.0 tag; snapshot commit+config | ✓ |
| Baseline current HEAD now | Freeze main today, re-baseline if differs | |
| Freeze at HEAD, re-confirm at tag | Provisional now, official at tag | |

**User's choice:** Freeze at v7.0 tag (D-10).

---

## Claude's Discretion

- R@K ground-truth "hit" definition against LoCoMo answer-evidence labels.
- Synthetic-corpus construction for the reproducible latency curve.
- Token-cost-per-write/per-recall accounting boundaries (reuse existing write-ledger).
- Abstention handling on adversarial/unanswerable LoCoMo questions (per pinned judge protocol).

## Deferred Ideas

- Reproducing rival pipelines head-to-head (later stretch, budget-gated).
- Per-category LoCoMo breakdown as a first-class table.
- Bi-temporal validity (deliberate v7.0 deferral).
