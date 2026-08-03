# Phase 67: Reference Consumer Adapter - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-03
**Phase:** 67-Reference Consumer Adapter
**Areas discussed:** Adapter shape & local-row mapping, Boundary enforcement, E2E proof strategy, Contract documentation scope

**Mode:** `--auto` — all areas auto-selected; recommended defaults chosen without AskUserQuestion. This phase's roadmap success criteria are unusually implementation-specific, so most "decisions" were already locked at roadmap level.

---

## Adapter shape & local-row mapping

| Option | Description | Selected |
|--------|-------------|----------|
| Structural sibling of clients/telegram; pure HTTP consumer; minimal local store keyed on entity_descriptor with own local ids + proposal-id idempotency | Roadmap-locked structure; ARCHITECTURE Q4 consumer-side resolution demoed honestly; includes the EMIT-07 refusal round-trip. | ✓ |
| Import engine store directly for speed | Rejected — falsifies CONSUME-02 and the milestone thesis. | |

## Boundary enforcement

| Option | Description | Selected |
|--------|-------------|----------|
| Own tsconfig (no src/ paths) + sibling copy of the import-boundary test scanning clients/proposal-reference/ incl. its tests | Roadmap-locked; inherits telegram guard's full strictness. | ✓ |
| Extend the telegram test to scan both clients | Rejected — roadmap explicitly requires a sibling copy, not a reuse. | |

## E2E proof strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Repo-level test seeds via engine + serves routes; adapter driven over HTTP only | Keeps the in-dir tests engine-free (the copied guard scans them); proof still end-to-end. | ✓ |
| In-dir e2e importing engine helpers | Rejected — the copied boundary guard would fail on its own test dir. | |

## Contract documentation scope

| Option | Description | Selected |
|--------|-------------|----------|
| Adopter-template section: 16-field record, schema_version gating, replay semantics, auth, refusal semantics, node-id-not-FK caveat (64 D-08), change_from/change_to asymmetry (66-04 carry-forward), fail-closed posture | Both mandatory carry-forwards land here by prior phases' explicit assignment. | ✓ |
| Minimal endpoint listing | Rejected — CONSUME-03 requires third-party buildability. | |

---

## Claude's Discretion

- Local store choice (sqlite vs JSON); adapter file layout; optional demo CLI entry; e2e filename; docs section placement.

## Deferred Ideas

- jobfill live integration (own repo); Phase 68 items; webhooks/push; 65-HUMAN-UAT founder items.

## Todos

Same four keyword-noise matches as 63-66; none folded.
