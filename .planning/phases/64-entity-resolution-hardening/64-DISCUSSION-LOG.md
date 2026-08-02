# Phase 64: Entity Resolution Hardening - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-02
**Phase:** 64-entity-resolution-hardening
**Mode:** `--auto` (no user interaction; recommended defaults selected, every choice logged)
**Areas discussed:** Resolver placement & reuse seam, Confident-or-null mechanics, Output shape & threading, WR-01 source-gating closure, Candidate pool & read-only contract

---

## Resolver placement & reuse seam

| Option | Description | Selected |
|--------|-------------|----------|
| Standalone module called from the consolidator branch | Reusable union generator + resolver seam; Phase 69 explicitly plans to reuse it | ✓ |
| Inline in the consolidator per-episode loop | Smallest diff, but mints a third inline copy of the union shape and forces Phase 69 into a divergent duplicate | |

**Choice:** Standalone module (recommended default). Roadmap Phase 69 entry: "reusing Phase 64's union generator... rather than duplicate into a second divergent generator."

---

## Confident-or-null mechanics

| Option | Description | Selected |
|--------|-------------|----------|
| Deterministic floor + top-2 margin, LLM-free | Pitfall 4's exact prescription; D-02 validateProposal pattern; zero net-new LLM calls | ✓ |
| Score floor only | Misses the too-close-to-call ambiguity case Pitfall 4 names explicitly | |
| LLM judge disambiguation | Net-new call per classified episode; research says Phase 4 "mirrors RECON + D-02 verbatim, skip research"; deferred until measurement demands it | |

**Choice:** Deterministic floor + margin (recommended default). Thresholds are dark-knob config; conservatism locked (abstain on tie).

---

## Output shape & threading

| Option | Description | Selected |
|--------|-------------|----------|
| Two optional all-or-nothing fields on `ClaimDecision` (node id + descriptor), inert, no DB change | Mirrors TEMP-02/CLASSIFY-02 precedent and the roadmap's "only add optional fields to the in-memory ClaimDecision" | ✓ |
| Persist resolution to a table now | Contradicts the foundation-phase call (schema is Phase 66's first task) | |

**Choice:** In-memory optional fields (recommended default). Descriptor = resolved node's canonical value string per ARCHITECTURE Q4; raw `claimIntentEntity` preserved as input.

---

## WR-01 source-gating closure (63-REVIEW carry-forward)

| Option | Description | Selected |
|--------|-------------|----------|
| Option (a): gate at the consolidator fill sites now | One hoisted predicate, four sites; makes gmail-only isolation structural before first consumption | ✓ |
| Option (b): thread `episodeSource` onto `ClaimDecision`, gate at consumers | More plumbing; gate becomes each consumer's responsibility — the exact field-conservation trap WR-01 names | |
| Defer to Phase 65/66 | Phase 64 IS the first consumption; deferral is the path-of-least-resistance failure WR-01 predicts | |

**Choice:** Option (a) (63-REVIEW's own recommendation). Option (b) additionally permitted at planner discretion; fill-site gate is the mandatory minimum.

---

## Candidate pool & read-only contract

| Option | Description | Selected |
|--------|-------------|----------|
| Live entity-type nodes; resolver strictly read-only, never mints | Unknown company must abstain (Pitfall 4 mode 2); graph IS the canonical list (Q4) | ✓ |
| Include fact nodes in the resolution target set | Resolution targets entities; facts attach in Phase 65 | |
| Mint an entity on miss | Defeats confident-or-null outright | |

**Choice:** Entity-type pool, read-only (recommended default). Generator seam may stay type-agnostic for Phase 69 reuse; filter placement is planner discretion.

---

## Claude's Discretion

- Module name/location; `ClaimDecision` field names; floor/margin defaults + knob names; entity-type filter placement; optional `episodeSource` threading; channel score combination (no off-the-shelf reranker — v9.0 research showed it hurt).

## Deferred Ideas

- Consumer-ID mirror channel (Q4 option (b)) — v11 seed behind a measured trigger.
- LLM disambiguation tier — until DRIFT-05 measurement demands it.
- Per-role granularity under one dedup'd company node — revisit on measured mis-attribution.
- Phase 65 (PE mapping, lattice, provenance), Phase 66 (table/sink/routes), Phase 69 (retrieval reuse + D-S1 reversal record).

## Todo Review

Auto-fold rule (score ≥ 0.4) overridden with justification: all four matches are generic-keyword noise (`system`, `phase`, `status`, `hardening`) — the same matches Phase 63's discussion already reviewed and rejected, and Phase 64 contains no prompt or viz work. None folded; all four recorded as reviewed in CONTEXT.md.
