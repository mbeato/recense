# Milestones

## v7.0 Retrieval & Reasoning Depth (Shipped: 2026-06-23)

**Phases:** 35, 36 (spike), 37, 38, 38.1, 39, 39.1

**Key accomplishments:**

- **Phase 35 — Recency/Strength-Weighted Ranking (RANK-01/02):** LLM-free strength+recency term fused into cue-based RRF ranking as a pool-only, tombstone-excluded third weighted list — shipped DARK (w=0, byte-identical merge; no win claimed, tech-debt).
- **Phase 36 — Typed Predicate Edges SPIKE:** proved typed relations lift multi-hop recall on a scratch DB → GO gate for Phase 37.
- **Phase 37 — Typed Predicate Edges BUILD (TYPED-01/02):** typed edge model + offline typed extraction + typed-path recall. Live precision gate cleared GO — deterministic answer-in-top-3 **83.3% vs 37.5% untyped (+45.8pts)**, payload **3.8 vs 20 nodes (−81% tokens)** on a founder-signed 24-query set. Live coverage tuned 25%→92% (anchor-union + typedAnchorPoolK=20 + gloss rewording).
- **Phase 38 — Stored Reflections / Derived Insights (REFLECT-01/02):** sleep-pass reflects over schema clusters → stores insights as origin=inferred, non-strengthening, confidence-capped. REFLECT-01 verified (D-43-safe, offline); REFLECT-02 ships DARK, win unmeasured (tech-debt).
- **Phase 39 — Reader Wiki-Parity (WIKI-01/02/03):** browsable INDEX + "what links here" backlinks via existing reverse-edge lookup — presentation-layer LLM-Wiki parity, no engine change.
- **Phase 39.1 — Corpus Quality (project-hub + subject docs via zero-intervention exhaust-gate):** new doc taxonomy (project-hub + LLM-named subject docs replacing 1:1 schema-UUID chapters); `promoteSubjects` exhaust-gate wired into the sleep pass with per-pass budget cap; one-time live junk cleanup (22 obsolete chapter docs deleted, fk-clean, snapshot-guarded); ingest of recense + vtx. **Surfaced + fixed a latent bulk-consolidation stall (FIX-STALL-01, `67b3ade`): prefetch-all-before-commit exceeded the 30-min stale-lock window → infinite replay loop; chunked the prefetch to checkpoint progress.**

**Verification:** milestone audit `passed` (`milestones/v7.0-MILESTONE-AUDIT.md`); VERIFICATION.md authored for 36/37/38; 37-VALIDATION green. RANK-02 + REFLECT-02 shipped dark (no win claimed). 2147/2148 tests pass at close.

**Known deferred at close (accepted, non-blocking):**
- **Phase 39.1-05 Task 2** (live hub/subject doc generation + verification) — deferred to async post-close confirmation; the fixed consolidation drain was running in the background at close, to be verified retroactively (checklist in `39.1-05-SUMMARY.md`).
- **43 open artifacts** re-acknowledged from the v6.0 close scan (37 quick-tasks missing metadata, 1 stale `knowledge-base` debug session, 3 intentional todos, 2 dormant seeds) — see STATE.md Deferred Items.
- **Lock-heartbeat for >30-min consolidation passes** — `heartbeatLock()` exists but isn't called by the consolidator; proper fix threads a heartbeat callback through `consolidate()` (worked around at close with an external lock-touch).

---

## v6.0 Project Onboarding (Shipped: 2026-06-22)

**Phases completed:** 6 phases (29–34), 16 plans
**Requirements:** INGEST-01/02/03/04, DOCING-01, REINGEST-01/02, RECALL-01/02, REMEMBER-01/02/03, VIZ-POLISH-01/02/03 — all Complete/Satisfied (15/15)
**Git:** tag `v6.0` (annotated, at close-HEAD — v6.0/v7.0 histories were interleaved on 2026-06-20, so no clean code boundary; tag marks the milestone close)
**Verification:** all 6 phase VERIFICATION.md `passed`; milestone audit `passed` (`v6.0-MILESTONE-AUDIT.md`); cross-phase integration check PASSED (4/4 E2E flows wired, 109 cross-phase integration tests pass, tsc clean)
**Scope note:** Phases 33 (`recense remember`) and 34 (visual polish) were standalone phases folded into v6.0 at close per founder decision 2026-06-22.

**Key accomplishments:**

- **Agentic project onboarding** — `recense ingest-project <dir>`: an agent surveys a fresh repo (README, structure, key modules, conventions, gotchas) with a why-not-what / no-raw-code prompt and emits **summarized semantic knowledge** as episodes through the offline pipeline (origin=`observed`, scope-tagged via `node_scope`), gated by a `genuine|noise` quality judge that excludes raw-code and low-value structural facts. Proven on a real project before build (Phase 29 spike GO → Phase 30).
- **Generalized doc ingest + idempotent re-ingest** — ingestion extended to a project's own documents (README/`docs/*.md`/`CLAUDE.md`); a per-project `gitFingerprint` cursor makes re-ingest incremental and reconsolidation reconciles changed beliefs in place rather than minting duplicates (Phase 31).
- **Scoped project recall + auto-corpus** — `recense recall --scope <slug>` provenance-filters to one project (D-S1-safe: scope never enters ranking), and onboarding auto-promotes/generates the project's schema-anchored corpus landing doc via a crash-safe deferred marker consumed in the sleep pass — a newly-onboarded project is immediately browsable in the Reader (Phase 32, live-verified on `/Users/vtx/usage`: 24KB / 148-citation landing doc).
- **Synchronous curated write (`recense remember`)** — closes the "replaces MEMORY.md" promise on the WRITE side: a verbatim curated single-fact write (origin=`asserted_by_user`, lock-guarded) that runs synchronous in-place reconsolidation (D-04 force-reconcile, else insert); native Claude Code auto-memory retired via a global directive + `autoMemoryEnabled:false` kill-switch + value_hash-verified migration of the 12 `.md` files into the live brain (Phase 33).
- **Cross-surface visual polish** — spacing/alignment consistency and explicit loading/empty/error + hover/focus states across the four live viz surfaces (Reader, Corpus 2D graph, Detail, Brain HUD), CSS-only, with founder-locked guards held: amber reserved for activation/hover, 3D density anchor unchanged, zero runtime-dep change (Phase 34).

**Engine invariants held:** single-tenant; graph is source of truth, vector is derived cache; online paths LLM-free; never strengthen a fact from inferred output (D-43); net-zero new runtime deps; all LLM cost in the offline pass (`recense remember` is the by-design synchronous exception).

**Known deferred items at close:** 43 open artifacts acknowledged & deferred (see STATE.md → Deferred Items) — none scoped to v6.0 phases; 37 are completed quick-tasks lacking status files, 1 stale debug session, 3 intentional future-todos, 2 dormant seeds (SEED-003/004). Plus two carried tech-debt items from the audit: `--scope` case-normalization in the write paths, and a lingering headless-client process handle after `generateDoc`/`generateCorpusDocs`.

---

## v5.0 Foundational Memory Store + Reader Layer (Shipped: 2026-06-19)

**Phases completed:** 5 phases (24–28)
**Requirements:** SCOPE-01..04, DEDUP-01..03, RETR-01/03 (RETR-02 documented dead-end), READER-01..04, CORPUS-01..06 — all Complete/Satisfied
**Git:** tag `v5.0` (annotated `c410eb8`, pushed to `origin`)
**Suite at close:** 1766 passed, 3 skipped · tsc clean
**Verification:** Phase 28 verifier passed; founder-approved hero-verify; code review CR-01/WR-01 fixed, WR-02 rejected with rationale

**Key accomplishments:**

- **SCOPE — Foundational store** — verified the landed `node_scope` provenance + `import-memory` CLI, fixed the FK consolidation crash at root (`67eee74`), re-enabled the hourly agent, and ran the human-gated migration of 199 MEMORY.md facts into the brain under `[scope]` attribution (197 source files archived, reversible) — Phase 24.
- **DEDUP — Entity dedup/prune** — a repeatable, origin-guarded consolidation pass merges near-duplicate entity nodes into canonical nodes (121 clusters / 150 tombstoned live), FK-clean, no recall regression — Phase 25.
- **RETR — Belief-correction / duplicate-fact fix** — RETR-01 diagnosis correctly localized the duplicate-fact symptom to the consolidation judge / PE-routing (NOT the embedder; RETR-02 judge-prompt fix was validation-falsified and reverted — a documented dead-end); RETR-03 shipped `recense dedup-facts` — Phase 26.
- **READER — Reader Layer** — doc-as-node lifecycle-exempt generation with inline `recense://fact/<id>` citations, `/doc` route + Reader/Brain toggle, citation staleness/regen, and a flat 2D Obsidian-style corpus graph — Phase 27.
- **CORPUS — Schema-Anchored Corpus** — the corpus became the abstraction graph rendered as prose: LLM-free mass-gated promotion + centroid-cosine containment/reference ladder, schema-thesis generation, eager OFFLINE generation in the sleep pass (more faithful than lazy-on-click), fill-in-place stub writing for stable corpus edges, and a self-confirmation guard verified RED-under-injection — Phase 28.

**Engine invariants held:** single-tenant; graph is source of truth; online paths LLM-free; never strengthen a fact from inferred output (D-43); net-zero new runtime deps; all LLM cost in the offline pass.

**Known open at close:** live brain corpus generation was in progress at archive; viz-scaling (instanced haze) shipped as a follow-up quick-task to handle the growing node count; v6.0 (Project Onboarding) opened to ingest fresh projects.

---

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
