# Phase 66: Domain-Neutral Proposal Emit Seam - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-03
**Phase:** 66-Domain-Neutral Proposal Emit Seam
**Areas discussed:** Table shape & migration, Sink seam & emission wiring, Deterministic id, Approve/reject write isolation, Stale/superseded refusal, Routes & auth, Evidence quote

**Mode:** `--auto` — all areas auto-selected; every question resolved to the recommended default without AskUserQuestion.

---

## Table shape & migration

| Option | Description | Selected |
|--------|-------------|----------|
| v17 additive table, surfaced_event conventions, research field set + schema_version + status CHECK | Flat, consumer-free, versioned from day one (Pitfall 11). | ✓ |
| JSON Patch proposed_change | Rejected by REQUIREMENTS preamble — presupposes consumer-schema knowledge. | |
| Defer schema_version ("one consumer so far") | Rejected — dangerous-shortcuts table row; repeats ARCH-REVIEW M-9. | |

## Sink seam & emission wiring

| Option | Description | Selected |
|--------|-------------|----------|
| Mirror ConsolidationSink triad; emit inside applyDecision decisive branches, same transaction, gated on imported isEmissionEligible + intent/resolved fields | Research prescription; extends 65's D-13 sentinel to the real sink. | ✓ |
| Separate post-pass scanner emitting from consolidation_event rows | Rejected — Pitfall 6 class (independent scan loses inherited guards) + breaks same-transaction atomicity. | |

## Deterministic id

| Option | Description | Selected |
|--------|-------------|----------|
| Content-derived hash over (entity_node_id, field, from, to, evidence_episode); PK collapses replays | Pitfall 12: reuse proven idempotency discipline (uq_episode_source_external precedent). | ✓ |
| Random UUID / AUTOINCREMENT | Rejected — replayed emission mints a second id; EMIT-04 fails. | |

## Approve/reject write isolation (D-43-for-proposals)

| Option | Description | Selected |
|--------|-------------|----------|
| Two-layer named sentinel: static grep/import-boundary + runtime node-table byte-identity | Twice-shipped defect class; structural closure demanded by EMIT-05/roadmap. Rejection leaves belief untouched (founder decision locked). | ✓ |
| Documented convention only | Rejected — convention-enforced invariants failed six times in Phase 62 alone. | |

## Stale/superseded refusal

| Option | Description | Selected |
|--------|-------------|----------|
| Approve-time re-check (tombstoned / belief-moved-on / expired) → explicit refusal + terminal status | LLM-free, write-path-only, no background scanning; re-delivery cannot resurrect. | ✓ |
| Background staleness sweeper | Rejected — new moving part, no requirement demands it. | |

## Routes & auth

| Option | Description | Selected |
|--------|-------------|----------|
| Mirror /v1/surface (lock-free GET) + /v1/surface/seen (per-call-lock POST) verbatim incl. T-12-03/T-12-05/D-16; extend 63's D-13 online LLM-free sentinel to /v1/proposals | The extension was promised when the sentinel shipped. | ✓ |
| New auth scheme / separate port | Rejected — EMIT-03 names the existing authenticated surface. | |

## Evidence quote

| Option | Description | Selected |
|--------|-------------|----------|
| Verbatim slice of already-sanitized episode content, stored/served as data, never model-rendered | Pitfall 2 (confused deputy); no new injection/secret surface. | ✓ |
| Model-generated summary alongside | Rejected — the exact vector v4.0 closed for tool calls. | |

---

## Claude's Discretion

- Column names/types, status vocabulary, expiry representation, hash encoding.
- Sink config knob name; store module location; GET filtering minimalism.
- "Belief moved on" comparison detail; quote-slice selection + cap.

## Deferred Ideas

- Reference consumer + contract docs — Phase 67. Telegram belief-kind + batching + rendering rule — Phase 68. Founder's 65-HUMAN-UAT items — untouched. Push delivery — unscoped.

## Todos

Four ≥0.4 matches reviewed, none folded (same keyword-noise set as 63/64/65) — see CONTEXT.md Reviewed Todos.
