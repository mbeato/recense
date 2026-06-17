---
gsd_state_version: 1.0
milestone: v5.0
milestone_name: Foundational Memory Store + Reader Layer
status: ready
last_updated: "2026-06-17"
last_activity: 2026-06-17
progress:
  total_phases: 4
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-06-17)

**Core value:** The memory learns and stays correct over time — forms generalizations the user never stated, and updates the right belief in place when a fact changes.
**Current focus:** Phase 24 — Foundational Store (verify FK-free consolidation + run MEMORY.md migration)

## Current Position

```
Phase:  24 — Foundational Store   [not started]
Plan:   —
Status: Roadmap defined — ready for /gsd:plan-phase 24

[████████████████████████░░░░░░░░] v1-4.0 shipped · v5.0 phases 24-27 pending
```

Phase 24 gate (SCOPE-01): a clean FK-free manual sleep pass must complete and the hourly agent re-enabled before any other v5.0 phase begins.

## Performance Metrics

**Velocity (historical baseline):**

- Total plans completed: 147 (v1.0: 42, v2.0: 14, v3.0: 42, v3.1: 8, v4.0: 22, quick-tasks: 19)
- Average plan duration: ~20–25 min

**By Milestone:**

| Milestone | Phases | Plans | Shipped |
|-----------|--------|-------|---------|
| v1.0 | 1–8 | 42 | 2026-06-09 |
| v2.0 | 9–10 | 14 | 2026-06-10 |
| v3.0 | 11–17 | 42 | 2026-06-13 |
| v3.1 | 18–19 | 8 | 2026-06-15 |
| v4.0 | 20–23 | 22 | 2026-06-17 |
| v5.0 | 24–27 | TBD | — |

## Accumulated Context

### v5.0 Dependency Chain

**Strict order: 24 → 25 → 26 → 27**

- Phase 24's clean-consolidation gate (SCOPE-01) unblocks all downstream phases — all phases touch the consolidation path; the FK bug must be verified fixed before any new consolidation work lands
- Phase 25 requires `node_scope` live (Phase 24) for scope-aware entity merging
- Phase 26 (extraction replay harness) requires a clean entity graph (Phase 25) for a representative re-eval
- Phase 27 depends on 24 (scope gather), 25 (entity quality), and 26 (semantic breadth); the validated reader slice already works on lexical+entity gather — Phase 27 promotes, it does not rebuild

### Phase 24 — Critical Context

**Already landed on main (999.3 Plans 01 + 02, Tasks 1-2):**
- `node_scope` sidecar (schema v10) + `cwdToScope` / `resolveNodeScope` helpers
- Consolidation stamps scope from contributing episodes' cwd
- `recense import-memory` CLI (idempotent, skips policy bundles, dry-run safe) — 193 facts to import, 7 policy bundles skipped, 12 indexes skipped (verified 2026-06-16)
- Recall output surfaces `[scope]` prefix
- Quick-task 260617-e16 (ab3b6c8): FK-hardened decay eviction (child-wipe for node_scope + node_temporal before DELETE FROM node)

**Remaining work (Task 3 = SCOPE-01 gate + SCOPE-04 migration):**
1. Verify the FK bug is fully fixed: run a manual sleep pass and confirm it completes (no FK error), clears the dirty sentinel
2. Re-enable the hourly launchd sleep-pass agent
3. Run the human-gated `recense import-memory` → `recense sleep-pass` → verify recall → archive sources (per `docs/import-memory.md` runbook D-S7)
4. Write `999.3-MIGRATION.md` with counts + verification samples

**FK bug status:** root-cause was the schema-relations DELETE-side not wiping child rows before node eviction. Two fixes applied: schema-relations FK-02 fix (Phase 23 range) + eviction child-wipe (260617-e16/ab3b6c8). Unverified by a clean pass — that's the SCOPE-01 gate.

**Hourly agent:** currently DISABLED (`launchctl bootout`ed) to prevent crash loops. Must be re-enabled after SCOPE-01 passes.

**Running the sleep pass:**
```
set -a; . ~/.config/recense/sleep.env; set +a
"$RECENSE_NODE_BIN" "$RECENSE_SLEEP_JS"   # logs to /tmp/recense-sleep.log
```

**API cost for migration:** ~$1–2 embedding (DeepSeek is the configured judge; confirm against budget before running).

### Phase 25 — Context

Entity fragmentation observed during reader slice (2026-06-17): 8+ near-duplicate "brain-memory" entity nodes, "tonos" / "Tonos daily eval pipeline" split, max edge degree ~15. The dedup pass must:
- Match by value similarity + embedding cosine above threshold (origin-guarded — never merge facts with conflicting origins if they represent genuinely distinct beliefs)
- Rewire all edges from duplicates → canonical node
- Tombstone duplicates (never delete evidence-backed facts)
- Be repeatable (second run = no-op)

Engine invariants: graph is source of truth; `PRAGMA foreign_key_check` must return empty after the pass.

### Phase 26 — Context

Root cause (from backlog 999.2): contradicting count-claims never cluster as judge candidates because cosine similarity never clears 0.7 with `text-embedding-3-small`. The reconsolidation judge fires zero on-topic contradictions on KU cases, so correct KU answers come from extraction + recency, NOT the differentiating reconsolidation mechanism.

Candidates (verify against live source before building — memory hypotheses drift):
- Upgrade `openaiEmbedModel` → `text-embedding-3-large` (drop-in, asymmetric not needed)
- Query-instruction prefix for an asymmetric embedder (Qwen3-Embedding local, $0 — bigger change)
- Re-tune cosine thresholds in `src/retrieval/engine.ts` / `topk.ts`

The extraction-replay harness path: N=20 extraction output cached at `~/.recense-eval-cache/eval01-n20-2026-06-16/` (39,914 claims). An embedder swap only requires re-embedding stored node texts — no re-extraction. Build the replay path first, then test variants.

API budget: ~$3–5 for the re-eval; ~$14–15 total remaining; explicit approval required for any run ≥$3.

### Phase 27 — Context

Reader slice validated 2026-06-17 (19/19 citations resolve, 0 invented, 100% coverage). Uncommitted prototype lives in:
- `src/viz/modules/reader.js` — doc renderer + ref interception
- `scripts/reader-slice/` — generation pass

Key design decisions (from reader-layer-SPEC.md open decisions, must resolve before building):
1. Doc storage: `type='doc'` node with lifecycle exemptions routed through consolidator (recommended in spec) vs separate store
2. Graph focus: extend `/graph?nodeIds=` vs client-side filter
3. `generatedAt`: dedicated doc field vs reuse doc-node `last_access`
4. Section-level regen is v2 (READER-05 deferred)

The hero interaction is the validation bet: prose ↔ evidence ↔ graph at two altitudes, feeling like one system.

### Budget Constraints

API budget: ~$14–15 remaining (Phase 17 closed at ~$12; Phase 23 used ~$0.05).

- Phase 24: ~$1–2 (embedding cost for migration consolidation; confirm before running)
- Phase 25: ~$0 (local similarity + embedding via existing stack)
- Phase 26: ~$3–5 (extraction-replay re-eval; explicit approval before any paid run)
- Phase 27: ~$0–1 (doc generation per project; LLM cost is per-doc generation, not ongoing)

### Engine Invariants (load-bearing, every phase)

- Single-tenant; no multi-tenant namespaces
- Graph is source of truth; vector store is derived cache
- Never delete an evidence-backed fact via decay
- Surfacing/inference never strengthens a belief (D-43)
- Online paths (SessionStart inject, retrieval, /v1/surface) stay LLM-free
- Agents live outside the engine (clients/, not src/)
- Net-zero new runtime dependencies

### Pending Todos

- SCOPE-01 gate: verify FK-free manual sleep pass before planning any other phase
- Confirm budget before running Phase 24 migration (embedding cost ~$1–2)
- Confirm budget before any Phase 26 paid eval run (≥$3)

### Blockers / Concerns

- **SCOPE-01 gate is a hard prerequisite**: Phase 24 cannot close — and Phase 25 cannot begin — until a clean sleep pass completes and the hourly agent is re-enabled. Do not skip this verification.
- **Phase 27 open decisions**: the four open design decisions from reader-layer-SPEC.md §8 must be resolved at Phase 27 plan time, not deferred into execution.

### Quick Tasks Completed (v5.0 — running log)

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 260617-e16 | FK-harden decay eviction (clean node_scope + node_temporal child rows before DELETE FROM node) + log err.stack at both sleep-pass error sites | 2026-06-17 | ab3b6c8 | [260617-e16](./quick/260617-e16-fk-harden-decay-eviction-child-wipe-slee) |

## Deferred Items

Carried forward from v4.0 close (2026-06-17):

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| Retrieval scaling | Brute-force cosine → sqlite-vec ANN (trigger: ~100k+ nodes; currently ~5k) | Deferred — trigger not met | 2026-06-07 |
| Scheduler | croner daemon reboot-survival on Linux | Deferred to v2.1 | 2026-06-09 |
| seed | SEED-003 multi-tenant namespaces | Dormant — intentional | 2026-06-10 |
| HTTP | True remote VPS + Caddy/TLS exposure (CR-01 template hard-codes --host 0.0.0.0) | Deferred from Phase 12 | 2026-06-11 |
| HTTP | readBody multibyte UTF-8 chunk-boundary corruption (CR-02) | Deferred from Phase 12 | 2026-06-11 |
| Viz perf | Phase 19 selection-rotation choppiness | Won't-fix — founder decision | 2026-06-14 |
| content | content-hardening-deferred.md (transcript per-speaker, Obsidian PDF) | Deferred — orthogonal to v5.0 | 2026-06-15 |
| Lockfile | Lock-heartbeat for long backlog passes (>30min) — LOCK_STALE_MS | Low priority | 2026-06-17 |
| Lockfile | Pathological episode b924fdfd exceeds 10-min local timeout (DeepSeek handles it) | Low priority | 2026-06-17 |

## Session Continuity

Last session: 2026-06-17
Stopped at: v5.0 roadmap defined
Resume file: .planning/ROADMAP.md

## Operator Next Steps

- Run `/gsd:plan-phase 24` to plan Phase 24: Foundational Store
- First task in Phase 24: verify the FK consolidation fix by running a manual sleep pass
