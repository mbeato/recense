# Milestones

## v4.0 Proactive Memory (Shipped: 2026-06-17)

**Phases completed:** 4 phases (20–23), ~39 feat commits
**Requirements:** TEMP-01/02/03, SURF-01/02/03, PUSH-01/02/03, ACT-01/02/03 — all Complete (13/13)
**Git range:** `b605f13` (schema v8 `node_temporal`) → `b6173b7` (milestone archive) · git tag `v4.0`
**Suite at close:** 1490 passed, 3 skipped
**Verification:** Phases 20–23 all ✓ passed; live-validated end-to-end against a real MCP server

**Key accomplishments:**

- **TEMP — Temporal/actionable ingestion** — schema-v8 `node_temporal` sidecar (`due_at` index), a Google Calendar `SourceAdapter`, a Gmail episodic-variant capture (flights/deadlines/receipts the prompt formerly discarded), and multi-account OAuth — the prerequisite that makes memory-driven triggers possible (Phase 20).
- **SURF — LLM-free engine surfacing surface** — `GET /v1/surface` ranks "salient / due / not-yet-surfaced" items with surfaced/seen state so nothing re-notifies; the notification-fatigue filter rides on existing salience + PE-gating + schemas. Guarded by the D-43 self-confirmation sentinel: surfacing never strengthens `node.s`/`node.c` (Phase 21).
- **PUSH — Proactive Telegram push** — extends the Phase-13 reference client from pull to push: P0/P1 alerts/reminders, default-OFF, restart-surviving dedup, LLM-free path (Phase 22).
- **ACT — Approval-gated agentic execution** — the client proposes an action, the user approves via Telegram inline button (HITL), and it executes through *any* connected MCP tool. Hard approval gate (nothing fires without explicit approval), 4 injection-hardening controls, per-server allowlist, typed destructive-confirm, D-06 edit re-approval, and `source:'hitl'` audit excluded from consolidation (Phase 23).

**Engine invariants held:** agents live outside the engine (all Phase 22/23 logic in `clients/telegram/`, zero `src/` imports), online paths stayed LLM-free, single-tenant, net-zero new runtime deps. One real D-43 audit-provenance bug found by the live gate and fixed; code review clean after the CR-01 prompt-injection-fence fix.

**Known open at close:** the `consolidate-knowledge-into-recense` backlog (999.2/999.3/999.5/999.4) promoted into v5.0; an open FK consolidation crash root-cause-fixed in code, pending clean-pass verification (v5.0 Phase 24 gate).

---

## v3.1 Schema Depth & Brain-Window Polish (Shipped: 2026-06-15)

**Phases completed:** 2 phases (18–19), 8 plans, 8 tasks
**Requirements:** SREL-01/02/03, VIZ-07/08/09 — all Complete
**Git range:** `ad1b6cd` (SREL-01 RED) → `cda7dd3` (viz depth fog) · 26 files, +2,335/−61 · 2026-06-13 → 2026-06-14
**Verification:** Phase 18 ✓ passed · Phase 19 ✓ passed (+ founder UAT complete)

**Key accomplishments:**

- **SREL-01** — The sleep pass derives `schema_rel` edges between schemas from member-centroid cosine, as a wipe-and-rebuild derived cache behind the D-37 inferred-origin firewall (zero inferred signal touches derivation).
- **SREL-02** — Average-linkage agglomerative clustering over schema centroids materializes super-schema nodes linked via `abstracts` edges — deterministic, rebuildable, zero-LLM, D-37-safe.
- **SREL-03** — Recall gains a single bounded read-only sideways hop (top-N `schema_rel` neighbors folded in) that enriches ephemeral inference and is never written back (D-43 no-write-back preserved, sentinel-tested).
- **VIZ-07** — In-app node search in the full-size Brain Window: read-only BM25 `/search?q=` route + fly-to/highlight/dim, glance-only popover, LLM-free, user-initiated (D-04). Prefix matching fixed during UAT (`gi` → `git`).
- **VIZ-08** — Selecting a schema lights its whole member region via engine-served `abstracts` edges (adjacency walk, not a client-side guess); closing restores opacities.
- **VIZ-09** — Clean brain hull silhouette from front/top/side: shipped via the D-06 Taubin-smoothed display-hull STL (the `foldSuppress` shader erased the rim and was reverted), founder-accepted live.

_Note: v3.0 Interface Layer (phases 11–17, shipped 2026-06-13) was never formally closed via `complete-milestone`, so its phase details were swept into `milestones/v3.1-ROADMAP.md` when this milestone archived. The accomplishments above are scoped to v3.1 (phases 18–19) only; phases 11–17 are recorded in the archive ROADMAP under "Phase Details — v3.0 Interface Layer."_

---

## v2.0 Open-Source Release (Shipped: 2026-06-10)

**Phases completed:** 2 phases, 14 plans, 18 tasks
**Timeline:** 2 days (2026-06-09 → 2026-06-10), ~70 feat commits

**Key accomplishments:**

- **One-command OSS install** — `brain init` guided bootstrap (DB path, BYO-key collection with live validation, chmod-600 env file, absolute node-binary capture against ABI crashes), `brain` dispatcher with lazy-require hooks, install README + supported-platform matrix (Phase 9).
- **`brain doctor` health audit** — human-readable pass/fail across five dimensions: DB reachability/schema version, live API-key check, scheduler registration, hooks wiring, node-ABI match; non-zero exit on any failure (Phase 9).
- **Cross-platform scheduler seam** — macOS launchd preserved, croner@10 in-process fallback on Linux, idempotent `brain scheduler install/status`, macOS-only channels (iMessage/Telegram watcher) exit cleanly on other platforms (Phase 9).
- **Security + tech-debt baseline for the OSS tag** — Telegram config fail-closed with empty allowlist guard (DEBT-01), hermetic lockfile tests via `BRAIN_MEMORY_LOCK_PATH` (DEBT-02), WAL `db.close()` in CLIs (DEBT-03), snapshot-threshold calibration (DEBT-04), Nyquist VALIDATION backfill (DEBT-05), cross-project retrieval scoping via schema-v3 cwd column (DEBT-06), CI matrix green on macOS + Linux (PORT-01/02) (Phase 9).
- **Brain-activation visualization** — `brain viz` opens a 127.0.0.1-only read-only 3D graph UI (vendored Three.js/3d-force-graph, no CDN): nodes colored by type and sized by strength, spreading-activation pathways animated live per query via SSE from a ring-capped `activation_trace` table behind a Noop-default `ActivationTraceSink` seam — zero hot-path cost when off (Phase 10).
- **Honesty gate held** — permanent copy audit (no anatomical-region claims; "memory activations" framing) plus human sign-off of the live viz on real hardware (Phase 10).

**Known deferred items at close:** 17 acknowledged (see STATE.md → Deferred Items). 4 substantive — Phase 09 HUMAN-UAT 3 pending scenarios, Phase 10 UAT 1 pending scenario, Phase 09 VERIFICATION human_needed; the rest are completed quick-tasks lacking summary files and two intentionally dormant seeds (SEED-003/004, planted for v3+).

---

## v1.0 Core learning loop (Shipped: 2026-06-09)

**Phases completed:** 8 phases, 35 plans, 38 tasks
**Suite at close:** 522 tests (521 passing; 1 known environmental flake — `lockfile.test.ts` shares the production lock path with the live launchd watcher)

**Key accomplishments:**

- **Two-store substrate with a single owned write primitive** — episodic log + semantic graph + on-node embeddings in SQLite (better-sqlite3); tag-don't-drop allocation gate, lazy multiplicative decay, AND-gated eviction that never deletes an evidence-backed fact (Phase 1).
- **Offline consolidation sleep pass as the sole graph writer** — salience replay → extract → top-k nominate → classify, with PE-gated three-way reconsolidation (HOLD / tombstone-reconcile / append-new), provenance-distinct contradiction force-destabilization, one-deep oscillation guard, and a resumable checkpoint (Phase 2).
- **LLM-free retrieval + live Claude Code dogfood** — cue-less strength-ranked retrieval with 1-hop spreading activation and honest `deleted`/`unreachable` classification, wired into a SessionStart hook that replaces the flat MEMORY.md index; full store→consolidate→retrieve→inject loop proven end-to-end on the founder's real brain.db (Phase 3).
- **The learning layer (the differentiator)** — schema induction abstracts generalizations the user never stated; ephemeral schema-prior recall reasons over them without writing inferences back; origin/provenance enforcement closes the self-confirmation loop so inferred output can never strengthen a fact (Phase 4).
- **Product-shaped seams + multi-channel ingestion** — three Level-3 interface seams (ModelProvider, ConsolidationSink, eval-snapshot) for later LoRA without engine changes (Phase 5); a pluggable `SourceAdapter` seam with Gmail / meeting-transcript / Obsidian adapters, salience-gated and secrets-redacted, wired into the hourly launchd cycle via `brain-ingest` (Phase 6).
- **Conversational surface + self-host hardening** — a Telegram query bot (facts-first + schema-prior fallback, `(inferred)` marker, fail-closed allowlist, read-only on the graph) (Phase 7); and a lock-guarded `brain-seed` cold-start CLI plus full de-hardcoding of owner-specific paths, making the engine cleanly self-hostable BYO-keys (Phase 8).

**Known deferred items at close:** 12 acknowledged (see STATE.md → Deferred Items). All benign — completed quick-tasks lacking summary files, two ideation seeds, and one passed UAT. Accepted tech-debt from the v1.0 audit (Phase-3 cross-project bleed, `snapshotMatchThreshold` calibration, WAL `db.close()` in launchd CLIs, Nyquist VALIDATION backfill) is tracked, non-blocking, and documented in `milestones/v1.0-MILESTONE-AUDIT.md`.

---
