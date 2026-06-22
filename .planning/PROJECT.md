# brain-memory

## What This Is

A faithful brain-inspired memory engine for AI agents — a two-store (fast episodic + slow semantic graph + vector) system that doesn't just recall facts but *learns*: it abstracts general schemas from experience, reasons over them to handle novel situations, and updates stored beliefs the way the brain does (prediction-error-gated reconsolidation) instead of accumulating stale duplicates. Customer-zero is the founder's own Claude Code memory — it replaces the flat `MEMORY.md` index. Distribution model: **open-source, self-hosted, bring-your-own-keys** (decided 2026-06-08). Direction (2026-06-10): a **pure memory system** any agent or product can consume through pluggable interfaces — Claude Code via hooks today, any local agent via stdio MCP, remote consumers (Tonos, third-party products) via an HTTP serving mode; agents live outside the engine.

## Core Value

The memory **learns and stays correct over time** — it forms generalizations the user never explicitly stated, and when a fact changes it updates the right belief in place rather than surfacing a stale one. If everything else fails, this (abstraction + prediction-error-gated update) must work.

## Current State

**v6.0 Project Onboarding shipped 2026-06-22** (phases 29–34, 16 plans, git tag `v6.0`): recense can now onboard a **fresh, unexplored project** on demand. The primitive is an agentic survey — `recense ingest-project <dir>` reads a repo and emits *summarized semantic knowledge* (not raw code), gated by a `genuine|noise` quality judge, through the existing episodic → consolidation pipeline (origin=`observed`, scope-tagged via `node_scope`); proven on a real project by a go/no-go spike before build (Phase 29 → 30). Generalized doc ingest extends to a project's own README/`docs/*.md`/`CLAUDE.md`, and a per-project `gitFingerprint` cursor makes re-ingest incremental + idempotent (reconsolidation reconciles in place, no duplicates) (Phase 31). `recense recall --scope <slug>` provenance-filters to one project (D-S1-safe: scope never enters ranking), and onboarding auto-promotes/generates the project's schema-anchored corpus landing doc via a crash-safe deferred marker consumed in the sleep pass, so a newly-onboarded project is immediately browsable in the Reader (Phase 32, live-verified on `/Users/vtx/usage`). Two standalone phases were folded in: the synchronous curated write `recense remember` — a verbatim, lock-guarded single-fact write that runs in-place reconsolidation and retires native Claude Code auto-memory (global directive + `autoMemoryEnabled:false` + value_hash-verified migration of the 12 `.md` files) (Phase 33) — and a cross-surface visual-polish pass (Phase 34, CSS-only, founder-locked palette/density guards held). Milestone audit `passed` (15/15 reqs, 4/4 E2E flows wired); engine stayed single-tenant, graph-as-truth, LLM-free on the hot path (`recense remember` the by-design synchronous exception), net-zero new runtime deps.

**v5.0 Foundational Memory Store + Reader Layer shipped 2026-06-19** (phases 24–28): recense became the single source of truth for the founder's knowledge and grew a reader/corpus layer that renders the abstraction graph as prose. Scope-aware fact gather + a human-gated migration of 199 MEMORY.md facts under `[scope]` provenance (Phase 24, FK-consolidation bug root-caused + fixed); repeatable origin-guarded entity dedup (Phase 25) and a `recense dedup-facts` pass (Phase 26 — RETR-01 correctly localized the duplicate-fact symptom to the consolidation judge/PE-routing, *not* the embedder; the RETR-02 judge-prompt fix was validation-falsified and reverted, a documented dead-end); the Reader Layer (Phase 27 — doc-as-node generation with inline `recense://fact/<id>` citations, `/doc` route + Reader/Brain toggle, staleness/regen, flat 2D corpus graph); and the Schema-Anchored Corpus (Phase 28 — LLM-free mass-gated promotion + centroid-cosine containment/reference ladder, schema-thesis generation, eager offline generation in the sleep pass, fill-in-place stub writing for stable corpus edges, self-confirmation guard verified RED-under-injection). Git tag `v5.0`. Engine stayed single-tenant, graph-as-truth, LLM-free on the hot path, net-zero new runtime deps.

**v4.0 Proactive Memory shipped 2026-06-17** (phases 20–23, ~150 commits): recense crossed from passive recall to a memory that *surfaces and acts*. Temporal ingestion (`node_temporal`, Google Calendar adapter, Gmail episodic-variant, multi-account OAuth) → LLM-free `/v1/surface` ranking + D-43 self-confirmation sentinel → notify-only Telegram P0/P1 push (default-OFF, restart-surviving dedup) → approval-gated execution of any user-configured MCP tool (hard approval gate, 4 injection-hardening controls, typed destructive confirm, D-06 edit re-approval, `source:'hitl'` audit excluded from consolidation). Live-validated end-to-end against a real MCP server; one real D-43 audit-provenance bug found by the live gate and fixed; code review clean after CR-01 (prompt-injection fence) fix. All 13 requirements (TEMP/SURF/PUSH/ACT) satisfied. Git tag `v4.0`. The engine stayed passive, LLM-free on the hot path, single-tenant, net-zero new runtime deps.

**v3.1 Schema Depth & Brain-Window Polish shipped 2026-06-15** (phases 18–19, 8 plans): the learning layer now reasons over relations *between* schemas, and the Recense brain window is navigable and visually clean. SREL-01/02/03 + VIZ-07/08/09 all delivered and verified; both phases PASS, Phase 19 founder-accepted live. Git tag `v3.1`.

**v3.1 Phase 19 (Brain Window Polish) complete 2026-06-14**: the full-size Recense brain window gained in-app node search (read-only LLM-free BM25 `/search?q=` route → fly-to/highlight/dim, glance-only popover, D-04-safe; prefix matching fixed live during UAT so `gi` matches `git`), schema topic-region highlighting (selecting a schema lights its whole member region via engine-served `abstracts` edges — an adjacency walk, not a client guess — consuming Phase 18's schema→member payload), and a clean hull silhouette from every angle. The hull shipped via the **D-06 display-hull fallback** — a Taubin-smoothed `brain-model-display.stl` (`scripts/smooth-display-hull.py`) loaded for rendering only while occupancy seeding keeps the detailed mesh — after the `foldSuppress` Fresnel shader erased the rim under additive blending and was reverted. Founder UAT 4/4 live on real macOS hardware (selection-rotation perf, a pre-existing Phase-15 cost, dropped/won't-fix by founder decision). Both phases' VERIFICATION PASS; full suite green.

**v3.1 Phase 18 (Schema Relations Engine) complete 2026-06-13**: the sleep pass now learns over its own abstractions. A new LLM-free `SchemaRelationDeriver` runs in Phase C of `consolidate()` (after `induceSchemas()`, before eviction) and, from observed member-content centroids only, derives (a) `schema_rel` edges between similar schemas (SREL-01, new `EdgeKind`, rebuilt-from-scratch each pass) and (b) a super-schema hierarchy via agglomerative clustering, materialized as `type='schema'` nodes linked by `abstracts` edges (SREL-02) — both flow into the viz `/graph` payload for free. Schema-prior recall takes a single bounded, read-only sideways hop through related schemas to enrich the ephemeral inference, never writing back (SREL-03, D-43 invariant intact). D-37 is enforced at the source query and proved by a centroid-pollution sentinel test. The novel mechanism is founder-architected; the two flagged decisions (D-01 centroid-similarity signal, D-03 super-schema-as-schema-node) were isolated for easy revision. Verifier PASS 4/4; the advisory code review caught + the phase fixed 2 real BLOCKERs before close (CR-01: the sideways hop scanned only out-edges, silently missing ~50% of `schema_rel` pairs given the lexicographic src<dst convention — now scans in-edges too, with a prompt-capturing regression test; CR-02: a non-atomic v7 edge-table migration could lose the entire edge graph on a mid-swap crash — now wrapped in BEGIN/COMMIT) plus WR-01/WR-02. Full suite 929 pass / 2 skip; online paths stay LLM-free. Next: Phase 19 (Brain Window Polish) consumes these schema→member/schema edges for topic-region highlighting (VIZ-08).

**v3.0 Phase 16 (Brain Viz Tray App) complete 2026-06-12**: the viz ships as **Recense** — a macOS menu-bar + desktop Electron app (`apps/tray`, isolated package; engine/CLI keep the brain-memory name). Menu-bar heartbeat pulses amber only on real SSE trace events and dims offline; click = transient popover (compact LOD: 93-schema constellation over 12%-opacity haze mist); window collapse = pinned PiP-style popover (drag strip, X to dismiss); ↗/↙ swap buttons command the main process via sentinel-URL navigation (preload stays empty — zero IPC). Server ownership is attach-or-spawn on 7810 with crash backoff and D-96 flag restore verified on the live DB. Identity shipped during the founder gate: Recense name (collision-vetted), Lucide-derived brain icon with amber core (per-size icns tiers), matching tray glyphs, warmed aubergine in-app palette. Phase 15's DB split-brain open item CLOSED for the app: the tray resolves BRAIN_MEMORY_DB from sleep.env (GUI apps don't inherit shell env). Founder acceptance 9/9 (D-06 evolved: Dock presence only while the window is open); code review 0 critical/4 warnings (WR-01 fixed in-phase); verifier PASS 27/27. Distribution stays build-from-source (D-11); future: `brain app install`, in-app search/topic highlighting, hull front-view quality (captured in todos).

**v3.0 Phase 15 (Viz UI Modernization) complete 2026-06-12**: the viz frontend is rewritten as thin `index.html` + 8 plain ES modules + design-system CSS (old single-file UI replaced), with cinematic bloom on the graph's own composer, a Fresnel rim-lit glass brain hull, and a founder-locked muted rose/slate/mauve palette where warm amber activation is the only attention signal (original D-03 cyan superseded at the 15-08 gate — see auto-memory viz-palette-monochrome-ember). Node interaction is a micro-recall: select fires a shockwave + 1-hop amber ripple + neighborhood focus-dim, the detail panel does relation-grouped hop-by-hop traversal, and orbit/pan stay live while focused. Founder acceptance closed Spike 001's open real-GPU item with numbers: ~120fps interaction / ~22fps idle (D-07 throttle + visibility pause confirmed). Post-gate code review fixed 1 critical (tombstone-filtered nodes vs unfiltered links → d3-force crash) + 6 warnings; 815 tests green; verifier PASS 16/16. Known open item (out of phase scope): DB split-brain — episodes accumulate in `~/.config/brain-memory/brain.db` (0 nodes, 0 consolidation events) while the consolidated graph lives in the repo `brain.db`; `brain viz` defaults to the config path and renders empty without `BRAIN_MEMORY_DB` set.

**v3.0 Phase 13 (Reference Client Extraction) complete 2026-06-11**: the Telegram agent now lives outside the engine as a reference client at `clients/telegram/` — recall goes Telegram → client → HTTP `POST /v1/ask|search` on `brain serve`, never through an engine import (compile-time tsconfig boundary + static import-boundary test, CLIENT-01). Old agent-in-engine code deleted (watcher CLI, all channel modules, `EngineConfig.telegram` — 3,448 lines, D-07/D-08); `docs/reference-client.md` is the adopter template (CLIENT-03). Live dogfood cutover verified end-to-end on the founder's Mac: serve + client launchd agents running, bot answered through serve with provenance marker, old watcher retired same-step (no parallel soak). Two critical review findings fixed in-phase (group-chat privacy guard, client-side idempotent `(inferred)` marking); 736 tests green; CLIENT-01/02/03 validated, verifier PASS 3/3. Deferred warnings: slow getUpdates polls under launchd (undici keep-alive/IPv6 DNS), placeholder secrets pass the enabled gate, `build:client` not in CI, dead `EngineConfig.channel` block.

**v3.0 Phase 12 (HTTP Serving Mode) complete 2026-06-11**: `brain serve` runs REST (`/v1/search|add|ask`) + stateless MCP-over-HTTP (`/mcp`) on one port through the shared memory-ops core — auth on by default (Bearer token born at init, chmod-600, never logged), unauthenticated `GET /health`, read-only DB handle for the search path. Live headless-Linux deploy gate (12-04) passed on a real-systemd stand-in after two guide-verbatim gaps found live were closed same-session (12-05 init dispatch, 12-06 envsubst templates); reboot-survival confirmed. 815 tests green; SERVE-01/02/03 validated. Code review follow-ups deferred: CR-01 template hard-codes `--host 0.0.0.0` (plaintext beside Caddy TLS front), CR-02 readBody multibyte UTF-8 chunk-boundary corruption. True remote VPS + Caddy/TLS exposure remains the open D-15 remainder.

**v3.0 Phase 11 (stdio MCP Server) complete 2026-06-10**: `brain mcp` exposes memory_search / memory_add / memory_ask over stdio via the official MCP SDK — verified end-to-end in the founder's live Claude Code against the real brain.db (D-12 checkpoint passed, off-switch confirmed; one live-found gap, memory_search top-k semantics, closed via 11-06). 774 tests green; MCP-01/02/03 validated. Code review follow-ups deferred: CR-01 " (inferred)" marker leak in memory_ask answers + WR-01 missing 'mcp' sourceWeight.

**v2.0 Open-Source Release shipped 2026-06-10** (phases 9–10): anyone can `brain init` a working install (BYO keys, live-validated, chmod-600 env), audit it with `brain doctor`, schedule the sleep pass cross-platform (launchd/croner), and watch spreading-activation pathways live in the `brain viz` 3D UI. CI matrix green on macOS + Linux. Schema at v5 after the post-ship ARCH-REVIEW hardening pass.

## Last Milestone: v6.0 Project Onboarding — SHIPPED 2026-06-22

> Shipped (phases 29–34, git tag `v6.0`). Phases 33 (`recense remember`) + 34 (visual polish) folded in at close. Full detail: [milestones/v6.0-ROADMAP.md](milestones/v6.0-ROADMAP.md); audit: [v6.0-MILESTONE-AUDIT.md](v6.0-MILESTONE-AUDIT.md). The original goal/target-features below are retained as history. **Active work is v7.0 Retrieval & Reasoning Depth (phases 35–39, build complete) — closing next.**

**Goal:** Let a user onboard a **fresh, unexplored project** into the brain on demand — instead of only learning a project organically (Claude Code conversations) or from docs already in the Obsidian vault. The primitive is an **agentic project survey → episodes**: an agent reads the repo (README, structure, key modules, conventions, gotchas) and writes down *summarized semantic knowledge — not raw code*, which flows through the existing episodic → consolidation pipeline (origin=`observed`, scope-tagged, idempotent by reconsolidation). This makes recense useful for projects the founder hasn't already worked through in Claude Code, and feeds the schema-anchored corpus so a newly-onboarded project is immediately browsable.

**Target capabilities (all 4 confirmed by founder 2026-06-19):**
- **Agentic survey-ingest (core)** — `recense ingest-project <dir>`: an agent explores the repo and emits summarized observations → episodes → facts/schemas via the offline pipeline. Knowledge, not a code index.
- **Generalized doc ingest** — extend document ingestion beyond the single Obsidian vault dir to a project's own docs (README, docs/*.md, CLAUDE.md), origin=`observed`.
- **Idempotent re-ingest** — re-running on a changed project updates beliefs in place (reconsolidation) with a per-project cursor for incremental re-ingest.
- **Project recall surface** — scoped recall of a project's ingested knowledge + auto-generate its schema-anchored corpus doc so onboarding makes it immediately browsable in the reader.

**Key context:** Builds directly on v5.0 (scope provenance `node_scope`, the reader/corpus layer, the offline consolidation cost model) and the existing `SourceAdapter`/episodic seams. **Spike-first** (D): prove the agentic-survey fact/schema quality on one project before committing to the full command design. Constraint: summarized knowledge only — raw code line-by-line is rejected (it mints low-value noise). Engine invariants hold: single-tenant, graph is source of truth, online paths LLM-free, never strengthen a fact from inferred output, net-zero new runtime deps; ingestion LLM cost lives in the offline pass. Pairs with the just-shipped viz-scaling work (instanced haze) so the brain renders at the higher node counts ingestion produces.

## Last Milestone: v5.0 Foundational Memory Store + Reader Layer — SHIPPED 2026-06-19

> Shipped (phases 24–28, git tag `v5.0`). Phase 28 (Schema-Anchored Corpus) was added in-milestone, superseding READER-04. Full detail: [milestones/v5.0-ROADMAP.md](milestones/v5.0-ROADMAP.md). No active milestone — run `/gsd:new-milestone` to open v6.0. The original goal/target-features below are retained as history.

**Goal:** Make recense the single source of truth for the founder's knowledge — retire the flat MEMORY.md / Obsidian-authoring stores into the brain, clean up the entity layer, fix the retrieval-embedding weakness, and surface it all through a generated human-readable reader layer that links prose claims down to atomic facts.

**Target features:**
- **Foundational store (Phase 24, ex-999.3)** — verify the already-landed `node_scope` single-tenant provenance + `import-memory` CLI, confirm a clean FK-free consolidation pass (re-enable the hourly agent), then run the consolidate→verify→retire migration of `~/.claude/projects/*/memory` facts into recense. Retrieval stays GLOBAL; scope is attribution, not multi-tenancy.
- **Entity dedup/prune pass (Phase 25, ex-999.5)** — a scheduled consolidation pass that merges near-duplicate entities (8+ "brain-memory" fragments today) into canonical nodes, origin-guarded, rewiring edges and tombstoning duplicates without losing provenance.
- **Retrieval-embedding fix (Phase 26, ex-999.2)** — fix the sub-0.7 cosine retrieval weakness (query-instruction prefix and/or `text-embedding-3-large`), validated via the cached extraction-replay harness so no re-extraction is needed. ~$3–5 API.
- **Reader layer (Phase 27, ex-999.4)** — productize the validated reader slice: `type='doc'` nodes (lifecycle-exempt, single-writer), a facts→doc generation pass emitting inline `recense://fact/<id>` citations, staleness/regen, a `/doc` route + Reader/Brain toggle, and a doc→doc corpus graph.

**Key context:** Whole cluster traces to the `consolidate-knowledge-into-recense` thread — recense replaces the flat per-project MEMORY.md stores while keeping the long-form human vault deep-dives. Reader slice validated 2026-06-17 (19/19 citations resolve, 0 invented, 100% coverage); its prototype lives uncommitted in `src/viz/modules/reader.js` + `scripts/reader-slice/` (promote, don't rebuild). 999.3 code already landed via parallel work (schema v10) → Phase 24 is verify+migrate, not build. The open FK consolidation crash is root-cause-fixed in code (schema-relations DELETE-side child-wipe + eviction child-wipe) but unverified by a clean pass → that verification is a hard Phase 24 gate. Net-zero new deps; ~$3–5 API (Phase 26 re-eval) against ~$14–15 budget; rest local/$0. Engine invariants hold: single-tenant, graph is source of truth, online paths LLM-free, never strengthen a fact from inferred output. Backlog order: 999.3 → 999.5 → 999.2 → 999.4.

## Last Milestone: v4.0 Proactive Memory — SHIPPED 2026-06-17

**Goal (achieved):** Turn recense from passive recall into a memory that *surfaces and acts* — proactively pushing salient/due items to Telegram and, on explicit per-action approval, firing any user-configured MCP tool — engine staying passive, LLM-free on the hot path, single-tenant.

**Delivered (phases 20–23, git tag `v4.0`):** temporal/actionable ingestion (`node_temporal`, Google Calendar adapter, Gmail episodic-variant, multi-account OAuth) → LLM-free `/v1/surface` ranking + D-43 self-confirmation sentinel → notify-only Telegram P0/P1 push (default-OFF, restart-surviving dedup) → approval-gated execution of any user-configured MCP tool (hard approval gate, 4 injection-hardening controls, typed destructive confirm, `source:'hitl'` audit excluded from consolidation). All 13 requirements (TEMP/SURF/PUSH/ACT) satisfied; live-validated end-to-end against a real MCP server.

**Key context:** Differentiator was *memory deciding what's worth surfacing*, not the trigger/notify/approve plumbing (commodity). Engine constraints held: agents outside the engine, online paths LLM-free, single-tenant, net-zero new runtime deps.

## Requirements

### Validated

Built + verified in **Phase 1: Substrate** (2026-06-05, 91 tests passing, smoke round-trip green) — these hold structurally; final dogfood validation comes once the Phase 3 Claude Code adapter ships.
- [x] Two-store substrate (episodic log + semantic graph + embeddings-on-nodes), single owned write primitive — STORE-01/02/03
- [x] Tag-don't-drop allocation gate + cold-start seed from existing MEMORY.md — INGEST-01/02/03
- [x] Strength + lazy decay + AND-gated eviction (never deletes an evidence-backed fact) — STR-01/02/03

Built + verified in **Phase 2: Consolidation & Update Core** (2026-06-05, 153 tests passing, verifier PASS 8/8, code review 0 blockers) — the engine's core value now runs, pending Phase 3 dogfood:
- [x] Offline consolidation "sleep" pass (single graph writer: salience replay → extract → top-k nominate → classify → confirm/extend/unrelated, re-embed, eviction, resumable checkpoint) — CONSOL-01/02/03
- [x] PE-gated three-way update (HOLD / tombstone-reconcile / append-new by PE magnitude vs effective_s·c), provenance-distinct force-destabilization (D-19) + one-deep oscillation guard (D-20) — UPDATE-01..05
- [x] Origin/provenance enforcement on the contradiction path (closes the self-confirmation loop for counting) — UPDATE-05

Built + verified in **Phase 4: Learning Layer** (2026-06-06, 234 tests passing, verifier PASS 4/4, code review found+fixed 1 critical self-confirmation defect, both dogfood gaps closed and demonstrated live on real brain.db):
- [x] Schema induction in the sleep pass (centroid clustering, once-only LLM naming with refusal-validation, abstracts edges, D-38 joining-origin strengthen) + falsification (support-erosion/contradiction tombstone, no dangling abstracts edges) — LEARN-01
- [x] Ephemeral schema-prior recall (online cue embed D-41, 1-hop neighborhood with member→schema reverse lookup, inference logged as inferred episode D-43, never written back as a fact) — LEARN-02
- [x] Origin/provenance enforcement closes the self-confirmation loop end-to-end across the recall→echo cycle (inferred + echo episodes short-circuited before any strengthen/upsert) — LEARN-03

Built + verified in **Phase 6: Multi-channel ingestion** (2026-06-08, 450 tests passing, verifier PASS 8/8, code review found+fixed 1 critical edit-dedup defect (CR-01), live launchd rewire human-gated and verified on real brain.db) — extends INGEST-01/02/03, CONSOL-01/03, LEARN-03 (no new REQ-IDs; traces D-55..D-69):
- [x] Pluggable `SourceAdapter` seam unified on the episodic path (sleep pass stays sole graph writer); three adapters shipped — Gmail (incremental OAuth, query-scoped), meeting transcripts (watched export folder), Obsidian vault — salience-gated per source, secrets-redacted at the boundary, per-source origin-tagged (vault=asserted_by_user, else observed), content-addressed dedup + cursors, wired into the hourly launchd cycle via a `brain-ingest` CLI with an enabledSources=[] off-switch

- [x] LLM-free online retrieval; abstraction + schema-prior inference (ephemeral) — v1.0 (Phases 3–4)
- [x] Origin/provenance enforcement (closes the self-confirmation loop) — v1.0 (Phase 4)
- [x] Claude Code adapter (SessionStart inject, replaces MEMORY.md) — v1.0 (Phase 3)
- [x] Level-3 seams (ModelProvider, ConsolidationSink, eval-snapshot) — interfaces only — v1.0 (Phase 5)
- [x] Conversational query surface (Telegram bot, read-only) — v1.0 (Phase 7)
- [x] Self-host hardening (lock-guarded `brain-seed` CLI, de-hardcoded paths) — v1.0 (Phase 8)

Built + verified in **Phase 11: stdio MCP Server** (2026-06-10, 774 tests passing, verifier PASS 21/21, live D-12 founder acceptance incl. off-switch; gap 11-06 found live and closed same-day):
- [x] `brain mcp` stdio server: three tools (memory_search top-k LLM-free w/ provenance, memory_add episodic-only deferred-ack, memory_ask {answer, origin}) via official @modelcontextprotocol/sdk, one DB handle per lifetime, per-call write locks — MCP-01
- [x] Tool vocabulary mapped against @modelcontextprotocol/server-memory in README + docs/mcp.md adopter guide — MCP-02
- [x] MCP writes land as episodes only (source='mcp'); semantic graph writes stay exclusive to the sleep pass — MCP-03

- ✓ Low-friction OSS install & DX + cross-platform portability (SEED-001, INSTALL-01..06/SCHED-01..02) — v2.0
- ✓ Brain-activation visualization (SEED-002, VIZ-01..06) — v2.0
- ✓ Tech-debt cleanup — all v1.0 accepted debt cleared (DEBT-01..06) + CI matrix on macOS/Linux (PORT-01..02) — v2.0

Built + verified in **Phase 12: HTTP Serving Mode** (2026-06-11, 815 tests passing, verifier PASS 4/4, live headless-Linux deploy gate passed after same-session gap closure):
- [x] `brain serve` HTTP server: REST `/v1/search|add|ask` + stateless MCP-over-HTTP `/mcp` + unauthenticated `/health`, one port, one engine instance via shared memory-ops core — SERVE-01
- [x] Auth on by default: Bearer token generated at first run, stored chmod-600 in sleep.env, printed once, never logged or committed; unauthenticated → 401 — SERVE-02
- [x] Headless-Linux server-mode guide + systemd unit templates (serve + scheduler), validated verbatim on a real-systemd host incl. reboot-survival — SERVE-03

**v3.0 Interface Layer shipped 2026-06-13** (phases 11–17) — the full interface surface validated:
- [x] stdio MCP server (`brain mcp`) — recall/remember/ask tools for any local MCP client — MCP-01/02/03 (Phase 11)
- [x] HTTP serving mode (`brain serve`) — laptop and always-on-server as equal first-class modes, auth on by default — SERVE-01/02/03 (Phase 12)
- [x] Telegram responder extracted as reference client over the public interface — CLIENT-01/02/03, SEED-004 (Phase 13)
- [x] Benchmark/eval publication — LongMemEval + stale-fact/contradiction-update eval, numbers in README — EVAL-01/02/03 (Phase 14); LongMemEval gap closure (Phase 17)
- [x] Positioning/README refresh — "memory that stays correct" — POS-01 (Phase 14)
- [x] Viz UI modernization + macOS tray app (Recense) — VIZ-01..06 follow-ons (Phases 15–16)

**v3.1 Schema Depth & Brain-Window Polish shipped 2026-06-15** (phases 18–19):
- [x] Schema-schema relation edges + super-schema hierarchy, derived D-37-safe in the sleep pass — SREL-01/02 (Phase 18)
- [x] Bounded read-only sideways schema-hop recall, ephemeral/no-write-back — SREL-03 (Phase 18)
- [x] In-app Brain Window node search, glance-only popover, LLM-free — VIZ-07 (Phase 19)
- [x] Schema topic-region highlighting via engine-served member edges — VIZ-08 (Phase 19)
- [x] Clean brain hull silhouette from front/top/side (D-06 display-hull) — VIZ-09 (Phase 19)

**v4.0 Proactive Memory shipped 2026-06-17** (phases 20–23, git tag `v4.0`):
- [x] Temporal/actionable ingestion — `node_temporal`, Google Calendar `SourceAdapter`, Gmail episodic-variant, multi-account OAuth — TEMP-01/02/03
- [x] LLM-free engine surfacing surface (`/v1/surface` + surfaced/seen state) + D-43 self-confirmation sentinel — SURF-01/02/03
- [x] Notify-only proactive Telegram push (default-OFF, restart-surviving dedup) — PUSH-01/02/03
- [x] Approval-gated execution against any connected MCP tool (hard approval gate, injection hardening, typed destructive confirm, `source:'hitl'` excluded from consolidation) — ACT-01/02/03

**v5.0 Foundational Memory Store + Reader Layer shipped 2026-06-19** (phases 24–28, git tag `v5.0`):
- [x] Foundational store — `node_scope` provenance verify + `import-memory` migration (199 facts) + clean-consolidation FK gate — SCOPE-01/02/03/04 (Phase 24)
- [x] Origin-guarded entity dedup/prune pass — DEDUP-01/02/03 (Phase 25)
- [x] Belief-correction / duplicate-fact fix (judge+PE-routing localized; `recense dedup-facts`) — RETR-01/03 (RETR-02 documented dead-end) (Phase 26)
- [x] Reader layer — doc-as-node generation w/ inline `recense://fact/<id>` citations, `/doc` route + Reader/Brain toggle, staleness/regen — READER-01/02/03 (Phase 27)
- [x] Schema-anchored corpus — abstraction graph rendered as prose, mass-gated promotion, containment/reference ladder, offline gen, self-confirmation guard — CORPUS-01..06 (Phase 28, superseded READER-04)

**v6.0 Project Onboarding shipped 2026-06-22** (phases 29–34, git tag `v6.0`):
- [x] Agentic survey-ingest — `recense ingest-project <dir>` → summarized observations → episodes → consolidation, scope-tagged, offline, quality-gated — INGEST-01/02/03/04 (Phases 29–30)
- [x] Generalized doc ingest (README/`docs/*.md`/`CLAUDE.md`, origin=observed) — DOCING-01 (Phase 31)
- [x] Idempotent + incremental re-ingest (per-project `gitFingerprint` cursor, in-place reconciliation) — REINGEST-01/02 (Phase 31)
- [x] Scoped project recall + auto-corpus landing doc (D-S1-safe scope filter; deferred marker → sleep-pass promote/generate) — RECALL-01/02 (Phase 32)
- [x] Synchronous curated write `recense remember` (verbatim + in-place reconsolidation) + native-memory cutover — REMEMBER-01/02/03 (Phase 33, folded in)
- [x] Cross-surface visual polish (spacing/alignment + states/transitions, CSS-only, guards held) — VIZ-POLISH-01/02/03 (Phase 34, folded in)

### Active (v7.0 Retrieval & Reasoning Depth — build complete, closing; v8.0 next)

v7.0 (phases 35–39) build phases are complete and typed recall is live at 92% coverage — recency/strength-weighted ranking, spike-gated typed predicate edges, stored reflections/derived insights, and reader wiki-parity (index + backlinks). Bi-temporal validity and markdown-export explicitly deferred. v7.0 archival is in progress (this session). Next milestone **v8.0 Performance, Efficiency & Competitive Parity** (phases 40–43, planned): LOCOMO competitive baseline → vector index (kill brute-force cosine at 7000+ nodes) → token/cost audit → eval regression gates. Hard rule: every competitive number reproducible or cited.

### Out of Scope

- **Model weight training / LoRA in v1** — the "learning" lives in the memory substrate, not the model; parametric learning is v3, reachable via seams. Claiming the model itself gets smarter would be undefendable.
- **Scaling to many users / multi-tenancy** — engine stays single-tenant (reaffirmed 2026-06-10); per-user hosting = instance-per-user, which server mode enables with zero schema work. Namespace-based multi-tenancy is a planted seed (SEED-003), not scope.
- **ANN vector index (HNSW/pgvector)** — brute-force cosine scan is exact and sub-ms at this corpus size; deferred until measured latency hurts.
- **Ripple-faithful replay machinery** — catastrophic interference doesn't apply to a symbolic graph; replay is for distillation only.
- **Synaptic-scaling edge normalization** — plain decay already satisfies the mandatory Hebbian brake; it was the foundation's own "where it breaks" caveat.

## Context

- **Design is complete and approved before this project was initialized.** Three design docs are the source of truth, in `docs/`:
  - `brain-memory-foundation.md` — verified neuroscience model (4 adversarial deep-research passes, primary literature) + biological→AI primitive mapping.
  - `brain-memory-spec.md` — v1 architecture-of-record, after a 6-dimension adversarial review (39 findings, 37 adopted).
  - `brain-memory-roadmap.md` — staged evolution v1→v1.1→v1.2→v1.3→v2→v3, each upgrade a layer behind a v1 seam, gated on a real trigger.
- **Founder context:** Purdue CS new grad / startup CTO, deep in the Claude/agentic ecosystem. Adjacent project `contextscope` (`~/usage`, npm `@mbeato/contextscope`, TS/Next.js) audits Claude Code per-turn context and shares tooling/mental-model with this engine. The "compounding knowledge base" thesis (continual learning via curated context, since models can't continually learn) is the product framing — this engine automates that substitute.
- **Two differentiators** (where the novelty budget goes): the allocation gate (deciding what's worth storing, before the write) and PE-gated three-way reconsolidation (the update model). Everything else is as simple as the foundation allows.

## Constraints

- **Tech stack**: TypeScript engine (better-sqlite3, API-based embed/LLM/judge) — the integration surface (Claude Code hooks) is TS, and v1 has no heavy compute. Python training sidecar bolts on at v3 behind the ModelProvider/ConsolidationSink seams. — Keeps the hot integration path in-process; isolates ML to a separable service.
- **Performance**: online paths (SessionStart inject, retrieval) must stay LLM-free and fast; all LLM/embedding cost lives in the offline sleep pass. — The hook blocks the user; latency there is felt every session.
- **Correctness**: never delete an evidence-backed fact via decay; never let inferred output strengthen a fact (self-confirmation); graph is source of truth, vector is a derived cache. — These are the load-bearing guards from the adversarial review.
- **Faithfulness (engine mechanisms only)**: design choices trace to the verified foundation; demoted ideas (myelination→cache) must not creep back as memory mechanisms. Governs the engine, NOT the presentation layer — the `brain viz` anatomical "second brain" rendering is intentional decorative chrome (VIZ-06 anatomical-term ban dropped 2026-06-10 as overkill).

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Hybrid graph+vector spine | Graph gives a clean update target (fixes vector-only mismatch); vectors give fuzzy recall + separation | ✓ Good — carried two milestones; viz made the graph legible |
| Update model = tombstone-always for v1 | Non-destructive, keeps history the oscillation-detector needs; confidence-tiered in-place deferred to v1.1 | ✓ Good — market validated it: mem0 v3 went ADD-only (Apr 2026), vacating in-place correction |
| Learning = Levels 1+2 (abstraction + inference), no weight-training in v1 | Genuinely learns/generalizes without the LoRA rabbit hole; defensible (no inflated "smarter model" claim) | ✓ Good — schema induction remains unmatched in the field (research 2026-06-10) |
| TypeScript, Python v3 sidecar | Integration surface (hooks) is TS, v1 has no heavy compute; ML isolated behind seams | ✓ Good — same codebase now targets laptop + server modes |
| Allocation gate TAGS, never DROPS | Drops would be unrecoverable; more faithful to biology (allocation = priority, not admit/drop) | ✓ Good — no junk-accumulation incidents in dogfood |
| OSS self-host BYO-keys positioning (2026-06-08) | Anyone clones + wires own keys; hosted product would fork the architecture | ✓ Good — v2.0 shipped the install floor on it |
| Pure memory system, agents outside (2026-06-10) | Telegram dogfood showed agent-in-engine doesn't scale to many consumers; layered interface (lib → stdio MCP → HTTP) | ✓ Good — v3.0 shipped all three interfaces (MCP/serve/reference client); Telegram now rides the public HTTP API |
| Engine stays single-tenant (reaffirmed 2026-06-10) | Per-user hosting = instance-per-user; namespace multi-tenancy is SEED-003 behind a real trigger | — Pending |
| viz anatomical brain = intentional chrome; VIZ-06 term-ban dropped (2026-06-10) | Faithfulness governs engine mechanisms, not presentation; the ban was overkill | — Pending |
| recense becomes the single foundational store; retire flat MEMORY.md/Obsidian-authoring (v5.0, 2026-06-17) | Facts-for-retrieval belong in the learning brain, not flat files; scope = single-tenant provenance (NOT multi-tenancy), retrieval stays global; long-form human vault deep-dives stay | — Pending |
| Reader layer = generated docs over the brain with inline fact-refs (v5.0, 2026-06-17) | Keeps a pleasant reading surface while recense is source of truth; id-based citations never stale by construction (only prose drifts); slice validated 19/19 citations, 0 invented | ✓ Good — v5.0 shipped reader + schema-anchored corpus; v6.0 onboarding auto-generates per-project landing docs onto it |
| Onboard fresh projects via agentic survey of *summarized knowledge*, not raw code (v6.0, 2026-06-19) | Raw line-by-line code mints low-value noise facts; the brain stores semantic knowledge. Survey feeds the same episodic→consolidation pipeline (origin=observed, scope-tagged), so abstraction + idempotent reconsolidation come for free | ✓ Good — spike-gated GO before build (Phase 29); live-verified end-to-end on `/Users/vtx/usage` |
| `recense remember` = synchronous verbatim curated write + native-memory cutover (v6.0/Phase 33) | recense owned READ (session-start recall) but deliberate facts still leaked to native `.md` memory; passive turn-capture and batch import were both lossy. A synchronous in-place-reconsolidating write closes the "replaces MEMORY.md" promise on the write side | ✓ Good — global directive + `autoMemoryEnabled:false` + 12-file value_hash-verified migration; customer-zero now writes through the brain |
| Fold standalone phases 33/34 into v6.0 at close (2026-06-22) | Phases 33 (curated write) + 34 (visual polish) were standalone, added 2026-06-20 between the v6.0 and v7.0 themes; 34's VIZ-POLISH reqs were already in v6.0's REQUIREMENTS.md → contiguous v6.0 = 29–34, v7.0 = 35–39 | — Pending (bookkeeping) |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-06-22 — v6.0 Project Onboarding shipped + archived (phases 29–34, git tag `v6.0`; standalone phases 33/34 folded in). Milestone audit passed (15/15 reqs, 4/4 E2E flows). v5.0 requirements moved to Validated (prior drift corrected). Active work is v7.0 Retrieval & Reasoning Depth (phases 35–39, build complete) — closing next in this session; then v8.0 (phases 40–43).*
