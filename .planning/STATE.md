---
gsd_state_version: 1.0
milestone: v5.0
milestone_name: Foundational Memory Store + Reader Layer
status: planning
last_updated: "2026-06-17T18:24:58.764Z"
last_activity: 2026-06-17
progress:
  total_phases: 0
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-06-15)

**Core value:** The memory learns and stays correct over time — forms generalizations the user never stated, and updates the right belief in place when a fact changes.
**Current focus:** Phase 999.2 — retrieval embeddings reconsolidation engages knowledge updat

## Current Position

Phase: Not started (defining requirements)
Plan: —
Status: Defining requirements
Last activity: 2026-06-17 — Milestone v5.0 started

## Performance Metrics

**Velocity (historical baseline):**

- Total plans completed: 137 (v1.0: 42, v2.0: 14, v3.0: 42, v3.1: 8, quick-tasks: 12)
- Average duration: —

**By Phase:**

| Phase | Plans | Notes |
|-------|-------|-------|
| 01–08 (v1.0) | 42 | shipped 2026-06-09 |
| 09–10 (v2.0) | 14 | shipped 2026-06-10 |
| 11–17 (v3.0) | 42 | shipped 2026-06-13 |
| 18–19 (v3.1) | 8 | shipped 2026-06-15 |
| 20 (v4.0) | TBD | not started |
| 21 (v4.0) | TBD | not started |
| 22 (v4.0) | TBD | not started |
| 23 (v4.0) | TBD | not started |
| Phase 20 P01 | 15m | 3 tasks | 7 files |
| Phase 20-temporal-ingestion-foundation P02 | 20m | 2 tasks | 4 files |
| Phase 20 P03 | 25m | 2 tasks | 6 files |
| Phase 20 P05 | 25m | 2 tasks | 3 files |

## Accumulated Context

### Key v4.0 Ordering Constraints

- **Strict dependency chain**: Phase 20 (temporal facts) → Phase 21 (surfacing API) → Phase 22 (push notify) → Phase 23 (execution)
  - Phase 21 cannot produce useful results without node_temporal rows from Phase 20
  - Phase 22 must not connect until the D-43 sentinel in Phase 21 passes (hard gate)
  - Phase 23 builds on the push infrastructure from Phase 22, validated in dogfood first
- **Live-DB risk isolation**: TEMP-03 Gmail episodic-variant is behind RECENSE_ENABLE_EPISODIC_EMAIL=false (default); an offline dry-run A/B with explicit pass/fail criteria is a required Phase 20 verification criterion before the flag may be enabled; the gated-live-write-needs-real-offswitch lesson applies directly
- **D-43 self-confirmation sentinel** (SURF-03): surfacing must never strengthen node.s / node.c; the sentinel test is a required gate before Phase 22 connects any push client
- **Nothing fires without explicit approval**: ACT-01/02/03 all ship in Phase 23 simultaneously; the approval gate is non-negotiable and cannot be a retrofit
- **Security guards in first version**: injection hardening (delimiter-fenced memory data, serialized payload rendering), per-server allowlist, destructive typed-confirm — all required in Phase 23 v1, not post-ship
- **Agents outside the engine**: all Phase 22/23 agent logic lives in clients/telegram/; zero src/ imports; the engine/client boundary from v3.0 holds without modification
- **Online paths stay LLM-free**: GET /v1/surface and POST /v1/surface/seen are LLM-free; the one async LLM call per proposal in Phase 23 is in the client's offline push loop, not on a blocking hot path

### Budget Constraints

API budget: ~$14–15 remaining (Phase 17 closed at its $12 cap; Phase 17 closed 2026-06-13)

- Phases 20–22: near-$0 (dry-run ~$0.20, everything else local or Telegram)
- Phase 23: ~$0.01–$0.05 per proposal (DeepSeek V4-Flash); requires explicit approval for runs ≥$3

### Research Flags (from SUMMARY.md)

- **Phase 20**: nextSyncToken vs nextPageToken, 410 GONE full-resync handler — track as verification criteria during plan-phase
- **Phase 23**: Read arxiv 2508.12538 (MCP security / adversarial tool metadata) before writing the Phase 23 plan
- **Phases 21 + 22**: standard patterns; no additional research needed before planning

### Net-Zero Dependency Requirement

All v4.0 runtime deps are already installed: googleapis, @modelcontextprotocol/sdk (client mode), zod, better-sqlite3 (existing). No npm install required before any phase begins.

### Roadmap Evolution

- v4.0 Proactive Memory opened 2026-06-15 (4 phases: 20–23)
- Previous milestone v3.1 closed 2026-06-15 (phases 18–19, SREL-01/02/03 + VIZ-07/08/09 all verified)

### Pending Todos

None — starting clean.

### Blockers/Concerns

None active.

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 260614-l8n | Debounced on-write sleep-pass trigger — EpisodicStore.append() touches a dirty-sentinel | 2026-06-14 | 345db4d | [260614-l8n](./quick/260614-l8n-debounced-on-write-sleep-pass-trigger) |
| 260614-n4f | EVAL-03 injection-efficiency eval — 73% context reduction vs flat MEMORY.md | 2026-06-14 | 3df46f3 | [260614-n4f](./quick/260614-n4f-eval03-injection-efficiency) |
| 260614-tp3 | Add --per-turn opt-in flag to longmemeval-harness (EVAL-01 fidelity fix) | 2026-06-14 | 962056e | [260614-tp3](./quick/260614-tp3-add-per-turn-flag-to-longmemeval-harness) |
| 260616-fiv | Add RECENSE_ENABLED_SOURCES env override — fixes the enabledSources no-op so `recense ingest <source>` actually builds adapters | 2026-06-16 | 725f186 | [260616-fiv](./quick/260616-fiv-add-recense-enabled-sources-env-override) |
| 260616-kxe | Retry transient ECONNRESET on the DeepSeek/OpenAI-compat judge path (withRetry + isTransientNetworkError) — undici body-read drops no longer skip episodes | 2026-06-16 | f07e884 | [260616-kxe](./quick/260616-kxe-retry-transient-econnreset-network-error) |
| 260616-nx3 | Raise local-judge SDK timeout to 600s (env-overridable RECENSE_LOCAL_SDK_TIMEOUT_MS) + cap local retries at 1 (worst-case 20min < 30min lock window) — local 35b judge completes instead of silently skipping slow episodes | 2026-06-16 | 5dd3048 | [260616-nx3](./quick/260616-nx3-raise-local-judge-sdk-timeout-recense-lo) |
| 260617-e16 | FK-harden decay eviction (clean node_scope + node_temporal child rows before DELETE FROM node — same pattern as the FK-02 super-schema fix; eviction was silently skipping nodes with those children) + log err.stack at both sleep-pass error sites | 2026-06-17 | ab3b6c8 | [260617-e16](./quick/260617-e16-fk-harden-decay-eviction-child-wipe-slee) |

## Deferred Items

Carried forward from v3.1 close (2026-06-15):

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| Retrieval scaling | Brute-force cosine → sqlite-vec ANN (trigger: ~100k+ nodes; currently ~1.5k = 1–3ms) | Deferred — trigger not met | 2026-06-07 |
| Scheduler | croner daemon reboot-survival on Linux | Deferred to v2.1 | 2026-06-09 |
| seed | SEED-003 multi-tenant namespaces | Dormant — intentional | 2026-06-10 |
| HTTP | True remote VPS + Caddy/TLS exposure (CR-01 template hard-codes --host 0.0.0.0) | Deferred from Phase 12 | 2026-06-11 |
| HTTP | readBody multibyte UTF-8 chunk-boundary corruption (CR-02) | Deferred from Phase 12 | 2026-06-11 |
| Viz perf | Phase 19 selection-rotation choppiness (pre-existing Phase-15 shockwave + ripple + bloom) | Won't-fix — founder decision | 2026-06-14 |
| content | content-hardening-deferred.md (transcript per-speaker, Obsidian PDF) | Deferred — orthogonal to v4.0 | 2026-06-15 |

## Session Continuity

Last session: 2026-06-16T22:33:20.541Z
Stopped at: Phase 23 context gathered
Resume file: .planning/phases/23-approval-gated-any-mcp-execution/23-CONTEXT.md

## Operator Next Steps

- Run `/gsd:plan-phase 20` to plan Phase 20: Temporal Ingestion Foundation
