# Phase 68: Telegram HITL Belief-Kind Extension - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-03
**Phase:** 68-Telegram HITL Belief-Kind Extension
**Areas discussed:** Union extension & zero-fork constraint, Poll/bridge shape, Decision-surface rendering, Refusal handling & edit short-circuit, Batching + hold exclusion, Approval-rate self-report

**Mode:** `--auto` — all areas auto-selected; recommended defaults (heavily pre-locked by roadmap SCs + research SUMMARY Phase 8 + Pitfall 7).

---

## Union extension & zero-fork constraint

| Option | Description | Selected |
|--------|-------------|----------|
| kind discriminator on StoredProposal; ZERO lines changed in proposal-engine.ts/proposal-store.ts; STOP-and-surface if impossible | Roadmap SC verbatim; store/cap/expiry are shape-agnostic. | ✓ |
| Fork a belief-proposal store | Rejected — explicit "no fork" requirement. | |

## Poll/bridge shape

| Option | Description | Selected |
|--------|-------------|----------|
| New poll fn + own in-flight guard; GET /v1/proposals → StoredProposal{kind:'belief'}; dedup by server id; TTL from expiry; counts toward existing cap | index.ts "never share guards" rule; deterministic id makes dedup trivial. | ✓ |
| Push/webhook delivery | Rejected — unscoped this milestone. | |

## Decision-surface rendering

| Option | Description | Selected |
|--------|-------------|----------|
| Structured fields only; from→to ON the tap targets; verbatim fenced quote; no model prose; no numeric confidence ever | v4.0 D-09 + Pitfall 2 + APPROVE-04. | ✓ |
| Natural-language summary message | Rejected — reopens the confused-deputy class. | |

## Refusal handling & edit short-circuit

| Option | Description | Selected |
|--------|-------------|----------|
| 409-class → terminal + message update, never retry; 503 → retry next tick; id shape-validated pre-path; edit → explicit unsupported reply | Phase 67 documented semantics + WR-04 lesson. | ✓ |
| Retry refusals | Rejected — terminals are durable by contract. | |

## Batching + hold exclusion

| Option | Description | Selected |
|--------|-------------|----------|
| Same-entity same-day → ONE prompt (all evidence listed); holds never surfaced (structural upstream + pending-only listing + sentinel) | Pitfall 7 first-version scope, not hardening. | ✓ |
| Per-proposal prompts | Rejected — the fatigue vector the phase exists to bound. | |

## Approval-rate self-report

| Option | Description | Selected |
|--------|-------------|----------|
| Client-side counters + periodic one-line self-report in decision messages | Pitfall 7's cheapest drift defense. | ✓ |
| No stat | Rejected — 100%-approval drift stays invisible. | |

---

## Claude's Discretion

Union literal names; poll cadence; batch keyboard layout; self-report cadence/wording; coarse-confidence text display; message formatting within the structured-only lock.

## Deferred Ideas

Typed-confirm for belief flips (rejected as ritual); belief edit flows; 65-HUMAN-UAT items; Phase 69.

## Todos

Same four keyword-noise matches as 63-67; none folded.
