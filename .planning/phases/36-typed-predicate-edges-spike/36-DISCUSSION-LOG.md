# Phase 36: Typed Predicate Edges — Spike - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-20
**Phase:** 36-typed-predicate-edges-spike
**Areas discussed:** Baseline / control arm, Predicate vocabulary, Query set + go-metric, Sample + extraction model

---

## Baseline / control arm

User first asked for a ground-up clarification of what a "typed edge" is (vs the current untyped/anonymous edge and the live schema-neighborhood recall) before answering. Explained against the real `edge` model; user then chose.

| Option | Description | Selected |
|--------|-------------|----------|
| Synthetic untyped A/B | Same extraction → typed graph + label-stripped control; only typing differs; cleanly isolates the variable | ✓ |
| vs current live recall | Compare against live schema-neighborhood recall; conflates two changes (adding relations + typing them) | |
| Both arms | Synthetic A/B as primary signal + live recall as a real-world reference | |

**User's choice:** Synthetic untyped A/B.
**Notes:** Picked after clarification. Rationale: live engine has no populated untyped relation graph today, so the control must be constructed; stripping predicate labels from the same graph isolates typing as the sole variable.

---

## Predicate vocabulary

| Option | Description | Selected |
|--------|-------------|----------|
| Closed founder set | ~8–15 fixed predicates, extractor constrained to them; no synonym noise; cleanest spike signal | ✓ |
| Open / emergent | LLM invents predicate strings, normalize after; realistic but adds synonym-merge confound | |
| Hybrid seed + extend | Closed seed the extractor prefers, may add new on a miss | |

**User's choice:** Closed founder set.
**Notes:** Exact list to be finalized against the real sample so it covers what's present. This closed vocabulary is the calibration note success-criterion 3 requires.

---

## Query set + go-metric

### Query set construction

| Option | Description | Selected |
|--------|-------------|----------|
| Founder hand-authored | ~15–30 multi-hop Qs vs real corpus, founder-verified gold | (initial rec) |
| Auto-generated from graph | Walk the graph to synthesize Qs+answers; circular, weak signal | |
| Sampled from real recall logs | Mine actual queries for multi-hop ones | (user's 1st pick — INFEASIBLE) |

**User's 1st choice:** Sampled from real recall logs — **withdrawn after Claude flagged a blocker**: recall deliberately never logs query text (`recall-cli.ts:11-12`, T-04-03-R), so no query-log data exists. Re-asked.

| Re-ask option | Description | Selected |
|--------|-------------|----------|
| Author from real usage | Hand-author from real customer-zero queries | |
| Instrument + collect first | Add query logging, collect N days, then sample | |
| Reconstruct from episodes | Pull real entities/attributes from sampled episodes, form ≥2-hop Qs, founder-verified gold | ✓ |

**User's choice (re-ask):** Reconstruct from episodes.

### Go-metric

| Option | Description | Selected |
|--------|-------------|----------|
| Answer-reachability % | Per query, gold reachable via correct path? % per arm; deterministic | ✓ |
| recall@k of gold node | Pure retrieval; ignores path/answer assembly | |
| LLM-judged answer quality | Judge scores each arm; adds CLI temp-0 non-determinism | |

**User's choice:** Answer-reachability %.

### Go bar

| Option | Description | Selected |
|--------|-------------|----------|
| Decisive gap | GO if typed ≥70% AND lift ≥+20 pts; NO-GO if lift <+10 pts or typed <50%; gray = founder call | ✓ |
| Strict gap | GO only if lift ≥+30 pts AND typed ≥75% | |
| Any clear positive | GO if lift ≥+10 pts (outside noise) | |

**User's choice:** Decisive gap.
**Notes:** Chosen to survive small-N noise and the no-inflated-metrics hard rule.

---

## Sample + extraction model

### Sample

| Option | Description | Selected |
|--------|-------------|----------|
| Entity-dense slice | Seed on connected entity clusters, ~200–400 co-occurring episodes; guarantees 2-hop chains | ✓ |
| Random N episodes | Uniform 200–500 sample; likely too sparse for chains | |
| Full corpus | All episodes; max coverage but overkill cost for a throwaway spike | |

**User's choice:** Entity-dense slice.

### Extraction model

| Option | Description | Selected |
|--------|-------------|----------|
| Haiku first, escalate | Extract with Haiku (build reality); re-run with Sonnet only on a miss | ✓ |
| Sonnet only | Test the ceiling; may overstate vs Haiku-based build | |
| Both, side by side | Most calibration data; doubles cost/scoring | |

**User's choice:** Haiku first, escalate to Sonnet only on a miss.
**Notes:** Keeps a GO honest (reflects what the build gets); Sonnet escalation separates "typing doesn't help" from "model couldn't extract."

---

## Claude's Discretion

- Recall-traversal sketch (success criterion 3) — left to the spike researcher/planner; build/traversal concern, not a founder decision.
- Scratch-DB construction mechanism — planner's call; must leave the live DB untouched.

## Deferred Ideas

- Promoting typed extraction + typed-path recall into the live engine — Phase 37 (TYPED-01/02), gated on this GO.
- Open/hybrid predicate vocabulary with synonym normalization — deferred to build if closed set proves too narrow.
- LLM-judged answer quality metric — deferred to the Phase 37 build harness.

### Reviewed Todos (not folded)
- `viz-search-and-hull-quality.md` (0.6, generic keyword match) — viz concern, unrelated.
- `content-hardening-deferred.md` (0.4, "phase" match) — unrelated.
