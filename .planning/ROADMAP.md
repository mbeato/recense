# Roadmap: brain-memory (recense)

## Milestones

- ✅ **v1.0 Core learning loop** — Phases 1–8 (shipped 2026-06-09) — full detail: [milestones/v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md)
- ✅ **v2.0 Open-Source Release** — Phases 9–10 (shipped 2026-06-10) — full detail: [milestones/v2.0-ROADMAP.md](milestones/v2.0-ROADMAP.md)
- ✅ **v3.0 Interface Layer** — Phases 11–17 (shipped 2026-06-13)
- ✅ **v3.1 Schema Depth & Brain-Window Polish** — Phases 18–19 (shipped 2026-06-15)
- ✅ **v4.0 Proactive Memory** — Phases 20–23 (shipped 2026-06-17) — full detail: [milestones/v4.0-ROADMAP.md](milestones/v4.0-ROADMAP.md)

> RECOVERY NOTE (2026-06-15): `.planning/ROADMAP.md` was accidentally overwritten during Phase 20 planning. Phases 11–19 detail, the Progress table, and the Backlog were recovered from the 2026-06-14 on-disk snapshot (`~/.brain-memory-planning-restore/ROADMAP.md`) and are authoritative. Phase 20 detail is verbatim from the planning context. **Phases 21–23 Goal/Success-Criteria prose is reconstructed from REQUIREMENTS.md + the v4.0 milestone note — sanity-check it against your intent.** Pre-merge artifact kept at `.planning/ROADMAP.reconstructed-v4.md`.

## Phases

<details>
<summary>✅ v1.0 Core learning loop (Phases 1–8) — SHIPPED 2026-06-09</summary>

- [x] Phase 1: Substrate (4/4 plans) — completed 2026-06-05
- [x] Phase 2: Consolidation & Update Core (3/3 plans) — completed 2026-06-05
- [x] Phase 3: Retrieval & Thin Adapter (4/4 plans) — completed 2026-06-06
- [x] Phase 4: Learning Layer (4/4 plans) — completed 2026-06-06
- [x] Phase 5: Level-3 Seams (5/5 plans) — completed 2026-06-08
- [x] Phase 6: Multi-channel Ingestion (7/7 plans) — completed 2026-06-08
- [x] Phase 7: Conversational Access Surface — Telegram (5/5 plans) — completed 2026-06-09
- [x] Phase 8: Self-host Hardening — wire+lock seeder, de-hardcode paths (3/3 plans) — completed 2026-06-09

</details>

<details>
<summary>✅ v2.0 Open-Source Release (Phases 9–10) — SHIPPED 2026-06-10</summary>

- [x] Phase 9: OSS Floor (9/9 plans) — completed 2026-06-09
- [x] Phase 10: Brain-Activation Visualization (5/5 plans) — completed 2026-06-10

Full phase details: [milestones/v2.0-ROADMAP.md](milestones/v2.0-ROADMAP.md)

</details>

<details>
<summary>✅ v3.0 Interface Layer (Phases 11–17) — SHIPPED 2026-06-13</summary>

- [x] **Phase 11: stdio MCP Server** — Local MCP clients reach brain-memory via `brain mcp` with zero deployment (completed 2026-06-10)
- [x] **Phase 12: HTTP Serving Mode** — Remote consumers reach the same engine over HTTP with auth on by default (completed 2026-06-11)
- [x] **Phase 13: Reference Client Extraction** — Telegram responder moves onto the public interface, proving the agent-outside pattern (completed 2026-06-11)
- [x] **Phase 14: Benchmark, Eval & Positioning** — Published numbers + "memory that stays correct" README frame (completed 2026-06-13)
- [x] **Phase 15: Viz UI Modernization** — Fable 5 re-review of the Opus-built viz UI: cleaner, more modern, more optimized (completed 2026-06-12)
- [x] **Phase 16: Brain Viz Tray App** — Always-accessible tray app showing live pathway activation while you work (completed 2026-06-12)
- [x] **Phase 17: LongMemEval Gap Closure** — Retrieval-first attribution + targeted levers recovered 12/18 failures; all 5 criteria pass (completed 2026-06-13)

</details>

<details>
<summary>✅ v3.1 Schema Depth & Brain-Window Polish (Phases 18–19) — SHIPPED 2026-06-15</summary>

- [x] **Phase 18: Schema Relations Engine** — Sleep pass derives schema-schema edges and hierarchical clusters; recall traverses them sideways, all D-37-safe (completed 2026-06-13)
- [x] **Phase 19: Brain Window Polish** — In-app node search + topic-region highlighting + clean hull from all viewing angles ✅ verified 2026-06-14 (UAT 4 pass; selection-perf dropped/won't-fix per founder)

</details>

### ✅ v4.0 Proactive Memory (Phases 20–23) — shipped 2026-06-17 — full detail archived to [milestones/v4.0-ROADMAP.md](milestones/v4.0-ROADMAP.md)

The pivot from a passive recall engine to a memory that **surfaces and acts** on what it learned. Dependency-strict chain (each phase needs the prior): Phase 20 (temporal facts) → Phase 21 (surfacing API) → Phase 22 (notify-only push) → Phase 23 (approval-gated execution).

**Load-bearing invariants (every phase):** agents live OUTSIDE the engine (logic in `clients/telegram/`, zero `src/` imports); online/serve paths stay LLM-free (all LLM cost in the offline sleep pass / client push loop); surfacing never strengthens a belief (D-43 self-confirmation guard); nothing fires without explicit human approval; engine stays single-tenant; net-zero new runtime dependencies.

- [x] **Phase 20: Temporal Ingestion Foundation** — node_temporal schema, Google Calendar SourceAdapter, Gmail episodic-variant (flag-gated + dry-run A/B), multi-account OAuth (completed 2026-06-16)
- [x] **Phase 21: Engine Surfacing API** — LLM-free GET /v1/surface composite ranking, POST /v1/surface/seen, D-43 self-confirmation sentinel (required gate for Phase 22) (completed 2026-06-16)
- [x] **Phase 22: Notify-Only Proactive Push** — Telegram P0/P1 push, restart-surviving dedup, default-OFF off-switch (completed 2026-06-16)
- [x] **Phase 23: Approval-Gated Any-MCP Execution** — propose→approve via Telegram, execute against any user-configured MCP server behind a hard approval gate + injection hardening (completed 2026-06-17)

## Phase Details — v3.0 Interface Layer

### Phase 11: stdio MCP Server

**Goal**: Any local MCP client can reach brain-memory's recall/remember/ask tools through stdio without deployment
**Depends on**: Phase 10
**Requirements**: MCP-01, MCP-02, MCP-03
**Success Criteria** (what must be TRUE):

  1. User runs `brain mcp` and Claude Code or Claude Desktop connects and can call recall, remember, and ask tools against the live brain.db
  2. The tool vocabulary follows a documented mapping to `@modelcontextprotocol/server-memory` naming conventions so existing MCP-memory users recognize it immediately
  3. A `remember` tool call routes through the episodic path only — no direct graph mutations; the sleep pass remains the sole graph writer
  4. The recall path and the retrieval step of ask make zero LLM calls; only the final ask composition step may invoke the configured LLM

**Plans**: 5 plans

- [x] 11-01-PLAN.md — Dependency legitimacy gate + install (@modelcontextprotocol/sdk, zod)
- [x] 11-02-PLAN.md — Server scaffold, routing, memory_search read path, in-process test harness
- [x] 11-03-PLAN.md — Write tools: memory_add (episodic-only, origin clamp) + memory_ask, with lock discipline
- [x] 11-04-PLAN.md — README server-memory mapping table + docs/mcp.md adopter guide
- [x] 11-05-PLAN.md — Founder live-registration acceptance (Claude Code, live brain.db)

### Phase 12: HTTP Serving Mode

**Goal**: brain-memory runs as an always-on HTTP server that remote consumers can reach, with auth on by default
**Depends on**: Phase 11
**Requirements**: SERVE-01, SERVE-02, SERVE-03
**Success Criteria** (what must be TRUE):

  1. A remote caller can invoke recall, remember, and ask over HTTP against a running `brain serve` instance
  2. An unauthenticated HTTP request is rejected (HTTP 401) out of the box; the auth token is generated at init time and never written to a committed file
  3. A self-hoster can follow a documented server-mode guide to deploy on a headless Linux box (engine + `brain serve` + croner scheduler, BYO keys) and reach it from a remote client
  4. The HTTP server opens its own read-only DB handle for read paths — it does not share the write handle the sleep pass holds

**Plans**: 6 plans (4 original + 2 gap-closure)

- [x] 12-01-PLAN.md — shared memory-ops core (extract engine + 3 ops) + mcp-cli refactor
- [x] 12-02-PLAN.md — brain serve HTTP server: REST + stateless MCP-over-HTTP + Bearer auth + hardening + tests
- [x] 12-03-PLAN.md — brain serve CLI dispatch + doctor token dimension + server-mode guide + systemd template
- [x] 12-04-PLAN.md — human-gated live headless-Linux deploy acceptance (D-15)
- [x] 12-05-PLAN.md — gap closure: `brain init` dispatch fix (spawnScript) + non-TTY guard + regression test
- [x] 12-06-PLAN.md — gap closure: systemd template ${VAR}/envsubst alignment + test pin + doctor v2.1 message

### Phase 13: Reference Client Extraction

**Goal**: The Telegram responder consumes memory exclusively through the public interface, proving any agent can sit on top of the engine
**Depends on**: Phase 11
**Requirements**: CLIENT-01, CLIENT-02, CLIENT-03
**Success Criteria** (what must be TRUE):

  1. The Telegram responder recalls and asks through stdio MCP or HTTP only — no direct engine imports remain on the recall/ask path
  2. The fail-closed guards (enable:false default, allowlist enforcement) survive the extraction intact and remain covered by tests
  3. A documented reference-client section shows adopters the template pattern for wiring any agent or channel onto the interface

**Plans**: 7 plans

- [x] 13-01-PLAN.md — Client foundation modules (transport, state, config, isolated tsconfig)
- [x] 13-02-PLAN.md — Client poll loop + HTTP memory client (index.ts over /v1/ask)
- [x] 13-03-PLAN.md — Test suite port + import-boundary guard + build/test wiring
- [x] 13-04-PLAN.md — Reference-client docs (CLIENT-03)
- [x] 13-05-PLAN.md — Engine deletion + config removal + CI guard fix
- [x] 13-06-PLAN.md — Deployment scripts (serve + client launchd, wrappers, setup)
- [x] 13-07-PLAN.md — Live dogfood migration (human-gated checkpoint, D-02)

### Phase 14: Benchmark, Eval & Positioning

**Goal**: brain-memory's correctness claims are backed by published numbers and the README positions it as "memory that stays correct"
**Depends on**: Phase 13
**Requirements**: EVAL-01, EVAL-02, EVAL-03, POS-01
**Success Criteria** (what must be TRUE):

  1. An established long-term-memory benchmark (LongMemEval or LoCoMo) runs against brain-memory and produces a recorded score
  2. A standalone stale-fact/contradiction-update eval demonstrates in-place belief correction — anyone can run it and observe brain-memory correct a stored belief where ADD-only systems produce a duplicate
  3. Benchmark and eval numbers appear in the README with one-command reproduction instructions
  4. The README opens with the "memory that stays correct" frame and surfaces the complaint→mechanism mapping from POSITIONING-GAPS.md

**Plans**: 5 plans

- [x] 14-01-PLAN.md — EVAL-02 correctness suite: fictional case set + end-to-end harness + ADD-only baseline + smoke test
- [x] 14-02-PLAN.md — EVAL-01 LongMemEval-S harness + GPT-4o scorer + probe gate + mini fixture + smoke test
- [x] 14-03-PLAN.md — eval:* npm scripts + CI harness smoke (mocked, zero-API) + scripts/eval/README.md
- [x] 14-04-PLAN.md — POS-01 README positioning-first restructure + docs/evals.md (placeholders)
- [x] 14-05-PLAN.md — published numbers (free path): recorded EVAL-02 84.6% (bedd132) + LongMemEval KU subset 69.2% (conservative pre-gap-closure) into README/docs; recorded JSON committed; full-subset re-run deferred (budget). **Closes v3.0 Interface Layer.**

### Phase 15: Viz UI Modernization

**Goal**: The brain viz UI (Opus-built in Phase 10) is re-reviewed with Fable 5 and ships cleaner, more modern, and more optimized — visual polish and rendering performance, without changing what the viz represents
**Depends on**: Phase 14
**Requirements**: D-01..D-16 (CONTEXT.md decisions serve as the requirement set; ROADMAP req ids were TBD)
**Plans:** 8/8 plans complete

Plans:
**Wave 1**

- [x] 15-01-PLAN.md — Vendor three r171 bloom/shader addons + /modules/ + /css/ server static routes (wave 1)
- [x] 15-02-PLAN.md — Frontend shell: import-map index.html + deep-sea css + constants/ctx contract + static-test rewrite (wave 1)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 15-03-PLAN.md — graph.js (shared-geometry render, containment, reveal) + lod.js (schema clustering) (wave 2)
- [x] 15-04-PLAN.md — trace.js: applyTrace spreading-activation BFS + active-set rAF + pulses (wave 2)
- [x] 15-05-PLAN.md — effects.js: UnrealBloomPass glow + Fresnel rim-lit glass hull + idle shimmer (wave 2)
- [x] 15-06-PLAN.md — detail/hud/stats: XSS-safe detail + receding chrome + master loop, adaptive quality, idle throttle (wave 2)

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 15-07-PLAN.md — app.js orchestrator (load order + wiring) + final static-test rewrite (wave 3)

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 15-08-PLAN.md — Founder acceptance on real hardware: fps numbers, hull, idle, no fake firing (wave 4, human gate)

### Phase 16: Brain Viz Tray App

**Goal**: The brain visualization is one glance away while working — a macOS tray app surfaces the live viz so pathway activations and firing are ambiently visible in near real time, the "second brain on your desk" experience that drives adoption
**Depends on**: Phase 15
**Requirements**: D-01..D-13 (CONTEXT.md decisions serve as the requirement set; ROADMAP req ids were TBD)
**Plans:** 6/6 plans complete

Plans:
**Wave 1**

- [x] 16-01-PLAN.md — Legitimacy gate + apps/tray scaffold + CI typecheck + `brain viz --no-open` flag

**Wave 2** *(blocked on Wave 1)*

- [x] 16-02-PLAN.md — runtime-paths + server-lifecycle (ABI-safe spawn/attach D-07, crash backoff, D-96 SIGTERM)
- [x] 16-03-PLAN.md — tray-icon: undici EventSource verify + SSE real-trace pulse/offline-dim + icon assets (D-05)
- [x] 16-04-PLAN.md — popover: frameless window + positioning + blur-dismiss + pin-to-float + nav guard + empty preload (D-03/D-04/D-102)

**Wave 3** *(blocked on Wave 2)*

- [x] 16-05-PLAN.md — main.ts orchestrator (accessory/login/menu) + electron-builder unsigned build + build-from-source docs (D-06/D-08/D-11/D-12)

**Wave 4** *(blocked on Wave 3, human gate)*

- [x] 16-06-PLAN.md — Founder macOS acceptance: heartbeat, popover/pin, attach, D-96 flag restore (D-13)

### Phase 17: LongMemEval Gap Closure

**Goal**: Attribute the 18 full-context-only LongMemEval KU failures (memory 69.2% vs full-context 79.5%) to a pipeline stage, then apply LLM-free-first levers in attribution order to recover ≥5/18 with zero regressions, keeping the online path LLM-free and total API spend ≤$12
**Depends on**: Phase 16
**Requirements**: ATTR-18, LEVER-1-FTS5, LEVER-2-TEMPORAL, LEVER-3-REWRITE, LEVER-4-BUDGET, LEVER-5-EXTRACT, VERIFY-17 (CONTEXT.md locked decisions serve as the requirement set)
**Plans:** 9/9 plans complete

Plans:
**Wave 1**
- [x] 17-01-PLAN.md — Attribution: instrument harness (4 taps), filtered 18/28 inputs, gated ~$4 API run, label all 18 (gate for levers)

**Wave 2** *(gated on attribution)*
- [x] 17-02-PLAN.md — LEVER 1: FTS5 node_fts v6 migration + sync + hybridTopk/RRF primitive + unit tests ($0, LLM-free)

**Wave 3** *(depends on 17-02)*
- [x] 17-03-PLAN.md — Adopt hybridTopk into retrieveRanked + harness (one-primitive-two-consumers) + LEVER 2 temporal MAX(episode.ts) ranking ($0)

**Wave 4** *(depends on 17-03)*
- [x] 17-04-PLAN.md — LEVER 3 ask-time Q→declarative rewrite (ask path only) + LEVER 4 answer budget + conditional LEVER 5 extraction coverage ($0)

**Wave 5** *(human-gated paid run)*
- [x] 17-05-PLAN.md — Verification: 12/18 recovered (PASS), 1 regression 9ea5eabc (FAIL — BM25), EVAL-02 69.2% < 84.6% floor (FAIL — probable LEVER 5 extraction regression), suite green; operator decision required

**Gap Closure** *(2026-06-13 — closes GAP-01..GAP-05 from 17-VERIFICATION.md; original 17-01..17-05 unchanged)*

_Gap-Closure Wave 1 ($0 fixes, parallel — no file overlap):_
- [x] 17-06-PLAN.md — GAP-01 + WR-02: fix the intransitive temporal comparator (engine.ts + harness, subsequence reorder) + undated-between-dated regression test + UTC parseSessionDate (unblocks trustworthy criterion A)
- [x] 17-07-PLAN.md — GAP-02: revert LEVER 5 extraction extension to V8 + confirm EVAL-02 local ≥84.6% (restores criterion C; $0 local)
- [x] 17-08-PLAN.md — GAP-03 + WR-01 + WR-03: remove BM25/hybrid from the answer path (keep node_fts infra) + reconcile queryText contract + interrogative-gate the rewrite (fixes criterion B regression 9ea5eabc)

_Gap-Closure Wave 2 (human-gated paid run, depends on 17-06/07/08):_
- [x] 17-09-PLAN.md — GAP-04: single budgeted API re-verification — **ALL 5 CRITERIA PASS** (A 12/18, B 0 regressions/9ea5eabc→Paris, C 84.6% local, D 917 suite, E invariants). Cumulative ~$12–12.8 (at/slightly over the $12 soft cap, disclosed).

**Real criterion-C fix (commit bedd132, supersedes the 17-07 hypothesis):** the EVAL-02 regression was the `cea0125` judge-batching refactor, NOT LEVER 5. Per-claim judging is now the engine default; batching opt-in via `BRAIN_MEMORY_ENABLE_JUDGE_BATCH=1`. 17-07's LEVER 5 revert is exonerated/harmless. **Phase 17 complete.**

## Phase Details — v3.1 Schema Depth & Brain-Window Polish

### Phase 18: Schema Relations Engine

**Goal**: The sleep pass derives evidence-grounded relations between schemas and a hierarchy of schema clusters, and recall can traverse schema-to-schema sideways hops — deepening inference without any inferred signal touching the derivation (D-37)
**Depends on**: Phase 17 (builds on validated LEARN-01 schema induction / LEARN-02 schema-prior recall)
**Requirements**: SREL-01, SREL-02, SREL-03
**Success Criteria** (what must be TRUE):
  1. After a sleep pass the graph contains schema-schema relation edges derived from member-centroid similarity and/or member co-activation in recall traces — they are inspectable in the graph payload and deterministically rebuildable without re-running LLM calls
  2. Schemas are organized into a hierarchy of super-schema clusters derived solely from member-content centroids — cluster assignments are rebuildable and a test verifies that zero inferred-episode signal entered the derivation (D-37 guard)
  3. A schema-prior recall query returns enriched candidates via sideways hops through related schemas — the enrichment is logged as an inferred episode and is never written back to the semantic graph (D-43)
  4. A dedicated unit test acts as the D-37 sentinel: the schema-relation and clustering pipelines reject any signal that passed through inferred content, verified by attempting to feed inferred nodes and asserting they are excluded
**Plans**: 4 plans

Plans:
**Wave 1**
- [x] 18-01-PLAN.md — EdgeKind + config placeholders + SchemaRelationDeriver schema_rel edges (D-01) + Phase C wiring (SREL-01)

**Wave 2** *(depends on 18-01)*
- [x] 18-02-PLAN.md — Super-schema hierarchy via agglomerative clustering, materialized as schema nodes + abstracts edges (D-03) (SREL-02)
- [x] 18-03-PLAN.md — Recall single sideways schema_rel hop, read-only, D-43 ephemeral (SREL-03)

**Wave 3** *(depends on 18-01/02/03)*
- [x] 18-04-PLAN.md — Test suite: D-37 sentinel (criterion 4) + idempotency + super-schema exclusion + recall no-write-back (SREL-01/02/03)

### Phase 19: Brain Window Polish

**Goal**: The Recense Brain Window is navigable by content search, highlights whole topic regions by schema membership, and renders a clean hull silhouette from every viewing angle
**Depends on**: Phase 18
**Requirements**: VIZ-07, VIZ-08, VIZ-09
**Success Criteria** (what must be TRUE):
  1. User types a query in the full-size Brain Window and the camera flies to matching nodes with highlights — the popover stays glance-only (no search input there), and no LLM calls are made during the search
  2. User selects a schema in the panel and all member nodes glow as a cohesive brain region — the glow derives from schema-to-member edges in the graph payload served by the engine, not a client-side approximation
  3. The brain hull silhouette is visually clean from front and top viewing angles — no jagged stacked edges — while preserving the existing side-view quality
  4. All three features are triggered only by real user action (D-04-safe) — no background polling, no fake firing on load
**Plans**: 4 plans
**UI hint**: yes

Plans:
**Wave 1** (parallel — zero file overlap)
- [x] 19-01-PLAN.md — VIZ-07 in-app node search: read-only /search?q= BM25 route + search.js module + DOM/CSS/hud wiring
- [x] 19-02-PLAN.md — VIZ-08 schema topic-region highlight in detail.js (engine-served abstracts edges)
- [x] 19-03-PLAN.md — VIZ-09 hull Fresnel fold-suppression shader (foldSuppress uniform)

**Wave 2** (depends on 19-01/02/03)
- [x] 19-04-PLAN.md — Founder macOS acceptance: search/topic/hull live + D-04 no-fake-firing + hull fallback gate ✅ verified 2026-06-14 (UAT 4 pass; selection-perf dropped/won't-fix per founder)

## Phase Details — v4.0 Proactive Memory

### Phase 20: Temporal Ingestion Foundation
**Goal**: Temporal and actionable facts (calendar events, deadline-bearing emails) are ingested into the memory graph in a structured form, making memory-driven triggers possible — without touching the live DB until an offline dry-run gate passes
**Depends on**: Phase 19 (uses existing SourceAdapter seam, Gmail OAuth flow, sleep pass)
**API budget**: ~$0 (dry-run ~$0.20 at DeepSeek V4-Flash; all other work local)
**Requirements**: TEMP-01, TEMP-02, TEMP-03, TEMP-04
**Research flag**: nextSyncToken vs nextPageToken edge cases, 410 GONE full-resync handler — track as verification criteria
**Success Criteria** (what must be TRUE):
  1. Calendar events from a configured Google Calendar account appear as observed episodes with UTC-normalized times after an ingest run; recurring events produce a single pattern belief (not N individual nodes); cancellations tombstone the corresponding node
  2. After the sleep pass runs on calendar or email content with `due_at` claims, `node_temporal` rows exist for those nodes with correct `due_at`/`action_type` values; existing consolidation behavior is unchanged for claims that omit these fields
  3. The Gmail episodic-variant prompt is staged behind `RECENSE_ENABLE_EPISODIC_EMAIL=false` (default) and cannot reach the live DB while the flag is off; an offline dry-run A/B on a DB snapshot produces an explicit pass/fail verdict (claim-count ratio vs baseline within tolerance, no newsletter/promo claims surfacing, EVAL-02 score unchanged) before any live enable is permitted
  4. A second configured Google account (Gmail + Calendar) ingests with its own independent OAuth credentials and sync cursor; both accounts' data coexist in the single-tenant memory under separate origin tags
  5. A simulated 410 GONE response from the Calendar API triggers a full-resync (discards stale cursor, re-ingests all events) without data loss or duplicate nodes
**Plans**: 5 plans
- [x] 20-01-PLAN.md — Temporal schema v8 + ExtractedClaim/ActionType + upsertNodeTemporal (TEMP-02 contract layer)
- [x] 20-02-PLAN.md — Consolidator node_temporal write (CONSOL-03) + episodic/calendar extraction prompts (TEMP-02/TEMP-03)
- [x] 20-03-PLAN.md — Multi-account Gmail + config + CLI wiring + legacy cursor migration (TEMP-04)
- [x] 20-04-PLAN.md — Google Calendar SourceAdapter: recurring→one node, cancellation tombstone, 410-GONE resync (TEMP-01/TEMP-04)
- [x] 20-05-PLAN.md — Episodic-email dry-run A/B gate + default-OFF off-switch proof (TEMP-03, D-07)

---

### Phase 21: Engine Surfacing API
**Goal**: The engine can answer "what should the user see right now?" via an LLM-free composite ranking over due/actionable items, and idempotently record what was surfaced — without ever strengthening a belief
**Depends on**: Phase 20 (needs `node_temporal` rows to rank); produces the surface API that Phase 22 consumes
**API budget**: ~$0 (LLM-free serve path; all work local)
**Requirements**: SURF-01, SURF-02, SURF-03
**Success Criteria** (what must be TRUE):
  1. `GET /v1/surface` returns due/actionable, not-yet-surfaced items via an LLM-free composite ranking (deadline-proximity + salience; PE-novelty when available), with a daily cap (P0 deadline-<24h bypass), a past-event guard, and completed/snoozed exclusion
  2. `POST /v1/surface/seen` idempotently records surfaced/seen/snooze outcomes to a `surfaced_event` operational table (activation_trace precedent); the sleep pass never reads or writes it
  3. Surfacing and seen-state writes never strengthen a belief (`node.s`/`node.c` unchanged) — proven by a D-43 self-confirmation sentinel test that is a required verification gate before any push client connects
**Plans**: 4 plans

Plans:
**Wave 1**
- [x] 21-01-PLAN.md — surfaced_event table v9 (additive migration, D-05 UNIQUE key + D-06 outcome CHECK enum) + schema round-trip test (SURF-02)

**Wave 2** *(depends on 21-01)*
- [x] 21-02-PLAN.md — LLM-free SurfaceStore hybrid ranking (P0 tier + weighted blend + past-event guard + D-07 exclusion + D-09 cap), TDD unit tests (SURF-01)

**Wave 3** *(depends on 21-01, 21-02)*
- [x] 21-03-PLAN.md — memory-ops surface()/surfaceSeen() ops + GET /v1/surface + POST /v1/surface/seen routes (read-only handle / per-call write lock / idempotent upsert) (SURF-01, SURF-02)

**Wave 4** *(gate — depends on 21-01/02/03)*
- [x] 21-04-PLAN.md — D-43 self-confirmation sentinel (blocking gate for Phase 22) + endpoint integration / idempotency / exclusion / D-08 isolation tests (SURF-03)

---

### Phase 22: Notify-Only Proactive Push
**Goal**: The Telegram reference client proactively pushes surfaced items (P0 immediate + P1 daily digest) reliably, with restart-surviving dedup and a real off-switch — notify only, no execution
**Depends on**: Phase 21 (D-43 self-confirmation sentinel must pass before any push client connects — hard gate)
**API budget**: ~$0 (push loop is local; no paid inference)
**Requirements**: PUSH-01, PUSH-02, PUSH-03
**Success Criteria** (what must be TRUE):
  1. The Telegram client proactively pushes surfaced items (P0 immediate; P1 daily digest at a configurable hour) over the single `getUpdates` consumer, with a never-empty-digest guard and a quiet-hours window
  2. A user can dismiss or snooze a pushed item via inline buttons, writing state through `POST /v1/surface/seen` so it does not re-notify within the guard window — dedup survives client restarts (DB-backed, not in-memory)
  3. Proactive push is behind a default-OFF off-switch (`RECENSE_PROACTIVE_ENABLED`) and runs reliably under launchd (`ThrottleInterval` crash-loop guard)
**Plans**: 3 plans (2 waves)

Plans:
**Wave 1** (parallel — zero file overlap)
- [x] 22-01-PLAN.md — D-43 sentinel hard gate + transport answerCallbackQuery/reply_markup/callback_query types + push-codec (64-byte callback_data) (PUSH-01, PUSH-02)
- [x] 22-02-PLAN.md — memory-client surface() GET + surfaceSeen() POST + config default-OFF RECENSE_PROACTIVE_ENABLED/quiet/digest/snooze env (PUSH-01, PUSH-02, PUSH-03)

**Wave 2** (depends on 22-01, 22-02)
- [x] 22-03-PLAN.md — index.ts integration: split push timer (P0-immediate/P1-digest, send-then-mark) + callback_query draining (surfaceSeen + answerCallbackQuery + allowlist) + launchd ThrottleInterval (PUSH-01, PUSH-02, PUSH-03)

---

### Phase 23: Approval-Gated Any-MCP Execution
**Goal**: On explicit per-action approval, the client executes against any user-configured MCP server — injection-hardened, allowlisted, with destructive-action confirmation and a full audit trail. Nothing fires without approval.
**Depends on**: Phase 22 (builds on the push infrastructure, validated in dogfood first)
**API budget**: ~$0.01–$0.05 per proposal (DeepSeek V4-Flash); explicit approval required for runs ≥$3
**Research flag**: Read arxiv 2508.12538 (MCP security / adversarial tool metadata) before writing the Phase 23 plan
**Success Criteria** (what must be TRUE):
  1. The client proposes an action and the user approves / edits / rejects / snoozes via a Telegram inline keyboard; nothing executes without explicit approval, and the approval message is rendered from the serialized `{tool, args}` payload (never LLM prose)
  2. On approval the client executes against any user-configured MCP server (stdio or HTTP), discovered via `listTools` and parameterized from memory context (`/v1/search`); servers are gated by a per-server allowlist
  3. Action execution is injection-hardened (delimiter-fenced memory data; per-server allowlist as the primary control); destructive/irreversible tools require a typed secondary confirmation; reversible/irreversible labels + a daily proposal cap guard against approval fatigue; every decision is logged as a `source:'hitl'` episode
**Plans**: 8 plans (6 waves)

Plans:
**Wave 1** (parallel — zero file overlap)
- [x] 23-01-PLAN.md — Foundation primitives: types (McpServerConfig/AllowlistEntry/StoredProposal) + mcp.json config loader (default-destructive allowlist, ${ENV} secrets, DeepSeek/cap envs) + v2 proposal callback codec
- [x] 23-02-PLAN.md — MCP client wrapper (connect/listTools/callTool/close, `arguments` key, ignore server hints, data-only output T-SEC-02)

**Wave 2** (depends on Wave 1; parallel — zero file overlap)
- [x] 23-03-PLAN.md — Immutable proposal store + expiry (D-07) + restart-surviving daily cap (H-15) + memory-client hitlEpisode() audit writer (H-12)
- [x] 23-04-PLAN.md — Proposal engine: DeepSeek + allowlist filter (D-04) + strip descriptions (T-SEC-01) + delimiter-fence (T-SEC-03) + D-02 confident-or-null + edit re-validation (T-SEC-04) + real-value confirm (D-09)

**Wave 3** (depends on Wave 1+2)
- [x] 23-05-PLAN.md — Push-tick proposal generation (D-01 auto-propose, D-02 plain-notify fallback, D-03 pierce quiet hours, payload-rendered card)

**Wave 4** (depends on 23-05)
- [x] 23-06-PLAN.md — Approve/Reject/Snooze + execute (expiry + allowlist re-check + immutable load) + destructive typed-confirm state machine (D-09)

**Wave 5** (depends on 23-06)
- [x] 23-07-PLAN.md — Edit path (D-06): reply-with-patch → re-validate (T-SEC-04) → fresh proposal + new Approve tap

**Wave 6** (human gate, depends on 23-07)
- [x] 23-08-PLAN.md — Founder acceptance: live DeepSeek model-string smoke + end-to-end propose→approve→execute (destructive confirm, edit re-approval, expiry, D-43 no-belief-write)

---

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Substrate | v1.0 | 4/4 | Complete | 2026-06-05 |
| 2. Consolidation & Update Core | v1.0 | 3/3 | Complete | 2026-06-05 |
| 3. Retrieval & Thin Adapter | v1.0 | 4/4 | Complete | 2026-06-06 |
| 4. Learning Layer | v1.0 | 4/4 | Complete | 2026-06-06 |
| 5. Level-3 Seams | v1.0 | 5/5 | Complete | 2026-06-08 |
| 6. Multi-channel Ingestion | v1.0 | 7/7 | Complete | 2026-06-08 |
| 7. Conversational Access Surface (Telegram) | v1.0 | 5/5 | Complete | 2026-06-09 |
| 8. Self-host Hardening | v1.0 | 3/3 | Complete | 2026-06-09 |
| 9. OSS Floor | v2.0 | 9/9 | Complete | 2026-06-09 |
| 10. Brain-Activation Visualization | v2.0 | 5/5 | Complete | 2026-06-10 |
| 11. stdio MCP Server | v3.0 | 6/6 | Complete | 2026-06-10 |
| 12. HTTP Serving Mode | v3.0 | 6/6 | Complete | 2026-06-11 |
| 13. Reference Client Extraction | v3.0 | 7/7 | Complete | 2026-06-11 |
| 14. Benchmark, Eval & Positioning | v3.0 | 5/5 | Complete | 2026-06-13 |
| 15. Viz UI Modernization | v3.0 | 8/8 | Complete | 2026-06-12 |
| 16. Brain Viz Tray App | v3.0 | 6/6 | Complete | 2026-06-12 |
| 17. LongMemEval Gap Closure | v3.0 | 9/9 | Complete | 2026-06-13 |
| 18. Schema Relations Engine | v3.1 | 4/4 | Complete | 2026-06-13 |
| 19. Brain Window Polish | v3.1 | 4/4 | Complete | 2026-06-14 |
| 20. Temporal Ingestion Foundation | v4.0 | 5/5 | Complete    | 2026-06-16 |
| 21. Engine Surfacing API | v4.0 | 4/4 | Complete    | 2026-06-16 |
| 22. Notify-Only Proactive Push | v4.0 | 3/3 | Complete   | 2026-06-16 |
| 23. Approval-Gated Any-MCP Execution | v4.0 | 10/10 | Complete    | 2026-06-17 |

## Out of Scope (v4.0)

- Auto-approve / fire-without-approval — the approval gate is the load-bearing safety control, never optional
- LLM in the surfacing/serve path — violates the LLM-free hot path
- iMessage ingestion — structural self-echo loop, rejected in Phase 7
- Multi-tenant namespaces (SEED-003) — engine stays single-tenant
- Content-hardening items #1 (transcript per-speaker) and #2 (Obsidian PDF/binary) — orthogonal to proactivity, parked in `.planning/todos/`

## Backlog

### Phase 999.1: Schema-schema relations via derived evidence-grounded links — PROMOTED to Phase 18

This backlog item has been formalized as **Phase 18: Schema Relations Engine** above. The two mechanisms described here (derived overlap/similarity edges + hierarchical induction clustering) map directly to SREL-01 and SREL-02; the sideways traversal maps to SREL-03.

### Phase 999.2: Improve retrieval embeddings so reconsolidation engages on knowledge-update (BACKLOG)

**Goal:** Close the recency-vs-reconsolidation gap surfaced by EVAL-01 (2026-06-16). The KU subset scored 90% (18/20), but instrumented runs showed the consolidation judge fires **zero on-topic contradictions** on KU — correct answers come from extraction + recency-resolution at answer time, NOT prediction-error-gated reconsolidation (the core value prop). Root cause: contradicting count-claims (e.g. "watched 30" vs "watched 50") never cluster as judge candidates because their cosine never clears threshold ("Q-cues never clear 0.7"). Make reconsolidation actually engage on KU so the differentiated mechanism — not recency — produces the answer.

**Investigation (verify against live source — memory hypotheses drift):** live embedder is `text-embedding-3-small` (`src/lib/config.ts:598`); queries embed symmetrically via `src/retrieval/topk.ts` (no instruction-tuned embedder), so the "Qwen3 query-instruction prefix" idea from the `cheap-inference-picks` memory does NOT apply as-is. Candidate fixes to test: (a) upgrade `openaiEmbedModel` → `text-embedding-3-large`; (b) switch to Qwen3-Embedding local **with** a query-side instruction prefix (asymmetric path, bigger change); (c) re-tune cosine thresholds in `src/retrieval/engine.ts` / `topk.ts` (`deletedSimilarityThreshold`, the 0.3 floor).

**Done:** an instrumented KU re-eval shows the judge detects real KU contradictions / sets `tombstoned` or `prev_value` on KU nodes, AND headline accuracy holds ≥90%. NOT a quick task — needs investigation + an embedder/threshold change + a multi-hour granite-extraction re-eval to validate. Memory refs: eval01-gap-extract-coverage, cheap-inference-picks, reconsolidation-underperforms-eval.

**FIRST TASK — build extraction replay so re-evals don't re-extract (~10h → ~1h):** the N=20 extraction output (39,914 claims, all 20 cases) is cached at `~/.recense-eval-cache/eval01-n20-2026-06-16/` (n20-attribution.jsonl + rerun2-attribution.jsonl: claim `value` + `episode_id` per case). Add a harness replay path that ingests pre-extracted claims (skip granite) → re-embed → re-consolidate → retrieve → answer, so retrieval/embedder/threshold variants can be tested back-to-back. Cache is valid ONLY while extractor=granite4.1:8b and `--chunk-turns 2` are unchanged (the retrieval fix touches neither). For an embedder swap specifically, re-embedding the stored node texts is enough — no re-extraction.

**Requirements:** TBD
**Plans:** 0 plans

Plans:
- [ ] TBD (promote with /gsd:review-backlog when ready)

### Phase 999.3: Scope-aware provenance + memory importer (BACKLOG — drafted 2026-06-16, ready to execute on promotion)

**Goal:** Make recense the single foundational memory store: (a) annotate each consolidated fact with the project it came from — single-tenant **provenance**, NOT multi-tenant namespacing (which stays Out of Scope) — and (b) provide a repeatable importer to migrate the per-project `~/.claude/projects/*/memory` markdown facts into recense so the flat MEMORY.md stores can be retired. Retrieval stays global (cross-project recall is wanted for personal facts + learned patterns); scope is for attribution + an optional future cwd-boost.

**Locked design (full detail in `phases/999.3-scope-aware-provenance-memory-importer/999.3-CONTEXT.md`):**
- D-S1 scope = single-tenant provenance; retrieval stays GLOBAL; NOT multi-tenant (respects v4.0 Out-of-Scope "engine stays single-tenant").
- D-S2 sparse sidecar `node_scope` (node_id PK FK→node.id), NOT a column on `node` (faithfulness — `node` stays the pure belief record; `node_temporal` / D-01 precedent).
- D-S3 scope derived during consolidation from contributing episodes' `cwd`; multi-project or personal/unknown → `global`, else project slug.
- D-S4 importer REUSES the ingestion pipeline (`recordEvent`) — episodes with a mapped `cwd`, `source='memory-import'`, idempotent `external_id`; no new ingestion path.
- D-S5 policy bundles excluded (voice_profile, feedback_no_inflated_metrics, outreach_framework, …) — only dated recall-facts migrate; policy stays deterministic config.
- D-S6 recall output surfaces `[scope]`; soft current-cwd relevance boost DEFERRED (not hard filtering).
- D-S7 migration order = consolidate→verify→retire; never delete a source file before its facts are verified retrievable.

**Done:** `node_scope` live at schema v10; consolidation stamps scope from cwd; `recense import-memory` idempotently loads `projects/*/memory` recall-facts (skips policy bundles); recalled facts display scope; a verified migration shows imported facts retrievable with correct scope — after which source files can be retired.

**Depends on:** Phase 23 complete **and** the open consolidation bug (`fk-consolidation-bug-handoff.md`) resolved — this phase modifies the consolidation path and must not stack on an open consol bug.

**Requirements:** SCOPE-01..04 (formalize at promotion)
**Plans:**
- [ ] 999.3-01-PLAN.md — `node_scope` sidecar (schema v10) + cwd→scope helper + store writer + consolidation wiring + recall surfacing + tests
- [ ] 999.3-02-PLAN.md — `recense import-memory` CLI (idempotent, skips policy bundles) + verified migration of `projects/*/memory` (consolidate→verify→retire)
