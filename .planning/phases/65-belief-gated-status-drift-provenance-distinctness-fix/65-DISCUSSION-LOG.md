# Phase 65: Belief-Gated Status Drift + Provenance-Distinctness Fix - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-02
**Phase:** 65-Belief-Gated Status Drift + Provenance-Distinctness Fix
**Areas discussed:** Provenance-key mechanism placement, Thread-lineage & sender capture, Quoted/forwarded stripping seam, Status-node shape + confidence consumption, Out-of-order backfill protection, Hold-produces-nothing gating, DRIFT-05 harness + dry-run gate

**Mode:** `--auto` — all areas auto-selected; every question resolved to the recommended default without AskUserQuestion. Selections logged inline below.

---

## Provenance-key mechanism placement

| Option | Description | Selected |
|--------|-------------|----------|
| Mint richer session_id at gmail ingest | `ingest:gmail:<derived-key>` at ingest-cli.ts:184-191; engine (`countDistinctProvenance`, `PendingContradiction`, `routeContradiction`) stays byte-identical. Research-gated on a session_id consumer blast-radius audit. | ✓ |
| `provenance_key` field on PendingContradiction | Narrow engine change; count `provenance_key ?? session_id`. Locked as the fallback if the audit finds a breaking consumer. | (fallback) |
| Raw message id / external_id as key | Rejected outright — farmable via forwarded/quoted-thread duplication (PITFALLS dangerous-shortcuts table). | |

**Auto-selection rationale:** Extends DRIFT-01's "machinery unmodified" spirit to DRIFT-03; the key is a provenance fact known at ingest. Final call research-gated per the roadmap research flag.

## Thread-lineage & sender capture

| Option | Description | Selected |
|--------|-------------|----------|
| Gmail server-assigned threadId + normalized sender domain | Already in the messages.get response; zero new API calls; not directly sender-controlled. | ✓ |
| References/In-Reply-To header reconstruction | Sender-controlled headers; rejected. | |

## Quoted/forwarded stripping seam

| Option | Description | Selected |
|--------|-------------|----------|
| New LLM-free detector, provenance path only | `>`-quotes, "On … wrote:", forward markers; compile-once discipline mirroring strip-hidden.ts; extractor input and Phase 62 stance untouched; empty-residual messages contribute no independent provenance. | ✓ |
| Extend strip-hidden.ts / strip extractor input too | Would change what the model sees and violate 63's folded coverage boundary. | |

## Status-node shape + confidence consumption

| Option | Description | Selected |
|--------|-------------|----------|
| Ordinary fact node; confidence dampens only; lattice at classifier/drift layer | No new node type; routeContradiction/isOscillation unmodified; out-of-order transitions lower confidence (Pitfall 9 prescription); D-43 lower-only doctrine. | ✓ |
| Lattice/state-machine gating in the engine | Rejected — breaks domain-neutrality (Pitfall 10) and modifies load-bearing routing. | |

## Out-of-order backfill protection

| Option | Description | Selected |
|--------|-------------|----------|
| Backfill sort by event_ts + drift-layer event_ts guard | Pitfall 5's lightweight compromise; cross-run interleaving documented as named accepted risk. | ✓ |
| Bi-temporal validity columns | v9.0 DEFER stands; explicitly out of scope. | |

## Hold-produces-nothing gating

| Option | Description | Selected |
|--------|-------------|----------|
| Decisive-sink-events-only emission seam, established this phase with sentinel test | contradict_hold structurally unreachable from the emission point; Phase 66 extends the test to the real sink. | ✓ |
| Defer entirely to Phase 66 | Rejected — gating semantics are exactly what Phase 66's dependency note says must be validated first. | |

## DRIFT-05 harness + dry-run gate

| Option | Description | Selected |
|--------|-------------|----------|
| Dark-launch key + counters; dry-run on real threads gates enablement; own-harness numbers only | Mirrors RETR-03 honest-null and 64 D-06 observability; no external bar cited (none exists). Optional `contradictionNBySource` dark knob. | ✓ |
| Enable key live immediately | Rejected — roadmap research flag mandates dry-run before live on a load-bearing mechanism. | |

---

## Claude's Discretion

- Exact key composition (domain vs address, accountId inclusion, suffix format/hashing).
- Confidence→damping mechanics within the lower-only lock (research pass designs).
- Module placement/naming for the quote-stripper and drift layer.
- "Near-empty residual" threshold semantics.
- Whether `contradictionNBySource` lands now or is stubbed.

## Deferred Ideas

- Proposal sink/table/routes, deterministic ids, stale-proposal refusal — Phase 66.
- HITL batching + approval-rate stats — Phase 68.
- Bi-temporal columns — deferred (v9.0 DEFER stands).
- B-02 channel-weight ceiling / B-04 hedging-reliability — later backlog, compose with lower-only lock.

## Todos

All four ≥0.4 matches reviewed, none folded (generic-keyword noise; same set Phases 63/64 reviewed) — see CONTEXT.md Reviewed Todos.
