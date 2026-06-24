# Phase 42: Token / Cost Efficiency Audit - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-24
**Phase:** 42-token-and-cost-efficiency-audit
**Areas discussed:** Lever scope & sweep method, No-regression guardrail, Progressive-disclosure design, Competitor-savings framing

---

## Lever scope & sweep method

### Q1 — Sweep method
| Option | Description | Selected |
|--------|-------------|----------|
| One-at-a-time + greedy lock | Sweep each lever in isolation, lock best, move on. Clean per-lever attribution; misses interactions. | |
| Full grid / joint sweep | Cartesian over all combos; captures interactions but run count explodes vs the cost gate. | |
| One-at-a-time, then confirm best combo | Greedy per-lever sweep + one confirmation run at combined best to catch interaction regressions. | ✓ |

### Q2 — Feature drop in-bounds?
| Option | Description | Selected |
|--------|-------------|----------|
| Thresholds only; features stay on | Tune thresholds within current feature set; corpus-gen/reflections stay on. | |
| Feature-drop on the table | Allow defaulting a feature OFF (e.g. RECENSE_CORPUS_GEN=0) if dominant cost + low value. | |
| You decide per-lever | Measure each lever's token delta first, decide tune-only vs droppable from the data. | ✓ |

**User's choice:** Greedy one-at-a-time + combined-best confirm; feature-drop decided per-lever from measured delta.
**Notes:** Interactions treated as second-order; the per-lever delta drives the tune-vs-drop call at plan time.

---

## No-regression guardrail

### Q1 — Which harness gates the sweep
| Option | Description | Selected |
|--------|-------------|----------|
| KU replay inner-loop + LOCOMO confirm | Cheap cached KU as per-candidate gate, full LOCOMO/LongMemEval as final proof. | ✓ (structure) |
| Full 3-harness on every candidate | Most rigorous; run count × token cost collides with budget gate. | |
| LOCOMO only | Narrower accuracy signal than KU/LongMemEval coverage. | |

### Q2 — Tolerance
| Option | Description | Selected |
|--------|-------------|----------|
| Within-noise band | Accept if accuracy within run-to-run noise (≤~1pt / CI). | ✓ |
| Strict: no drop at all | Accept only if ≥ baseline; may reject real wins lost to noise. | |
| You decide once noise known | Measure baseline variance, set band from it. | |

**User's choice:** KU inner-loop + LOCOMO/LongMemEval confirm (cheaper structure, still a real gate); tolerance = within-noise band. **Full eval run deferred to a weekly-reset window.**
**Notes:** Free-text steer — "id rather avoid or defer doing an eval run until a weekly reset" and "we can do the inner loop gate for the sweep im just opting for the cheaper option right now but that doesnt mean we shouldnt test it just not a full eval run again must defer." → build-now / run-at-reset split (D-06): harness + cheap KU validation now; full LOCOMO/LongMemEval confirm + write-side sleep-pass run deferred, cost-probe gated.

---

## Progressive-disclosure design

### Q1 — Disclosure unit (resolved via thinking-partner exchange, not the original tool call)
| Option | Description | Selected |
|--------|-------------|----------|
| A. Fact-index → fact detail | Thin hits (id+gloss) → expand to value+provenance+neighborhood. Literal claude-mem mechanism; cleanest A/B. | ✓ |
| B. Schema-index → member expand | Schema titles → members. Conflates challenger/incumbent (schemas ARE recense's compression). | deferred |
| C. Corpus-doc → doc body | Reader doc titles → body. Coarse granularity, wrong for QA harnesses. | deferred |

**User's choice:** Option A.
**Notes:** User asked "im not really sure what the index is or should be how do we weigh our options." Reasoned it out: progressive disclosure's token win requires an agent-in-the-loop that expands only what it needs, so it fits the **MCP pull surface**, not the one-shot SessionStart inject. A is the clean competitor-vs-recense contrast; B conflates the arms; C is the wrong granularity. User confirmed "yes A sounds good." Prototype depth resolved to harness-only A/B first (oracle + fixed-top-K bracketing), real MCP tool only on a win; decline-with-numbers is a valid outcome.

---

## Competitor-savings framing

### Q1 — recense's self-baseline
| Option | Description | Selected |
|--------|-------------|----------|
| Flat full-context dump | Bounded recall vs injecting everything. Matches mem0/claude-mem framing; reuses injection-efficiency scaling curve. | ✓ |
| Naive RAG (top-k raw chunks) | Isolates schema-compression value but no competitor publishes against it. | |
| recense-without-the-lever | Internal marginal delta, not a competitor-style claim. | |

### Q2 — Headline axis
| Option | Description | Selected |
|--------|-------------|----------|
| Recall-side headline + write-side separate | Lead recall-side (competitor-comparable), report write-side cost + breakeven separately. | ✓ |
| Combined net number | Single end-to-end figure; mixes a paid cost with a saved cost, hard to defend. | |
| Recall-side only | Comparable but hides the pay-at-sleep half of the bet. | |

**User's choice:** Self-baseline = flat full-context dump; recall-side headline + write-side/breakeven stated separately.
**Notes:** No-inflated-metrics — never net write and recall into one flattering number.

---

## Claude's Discretion
- Exact tunable lever set + sweep ranges — from the frozen v7.0 config snapshot.
- Exact noise-band threshold — measure baseline variance if cheap, else ≤1pt/CI heuristic.
- Token-accounting boundaries — reuse existing write-ledger / `usage.per_model` shapes.
- Progressive-disclosure A/B simulation fidelity (oracle + fixed-top-K, gloss-token sizing).
- KU-replay validation timing relative to the deferred reset-window run.

## Deferred Ideas
- Schema-as-index hybrid (progressive disclosure over recense's schema layer) — follow-on if Option A wins.
- Corpus-doc → doc-body progressive disclosure (MemPalace L0→L3 over the Reader corpus) — browse-surface, wrong granularity for QA.
- Building the real MCP two-step tool — only on a measured A/B win.
- User-facing cost-control settings surface — Phase 999.1 backlog.
- Reproducing rival pipelines head-to-head on the token axis — Phase-40 deferred stretch.
