# Milestones

## v9.0 Memory Quality (Shipped: 2026-07-20)

**Phases completed:** 16 phases (46–61), 92 plans
**Timeline:** 2026-06-27 → 2026-07-20 (23 days) · 592 commits · 336 files changed (+77,566 / −1,294) vs v8.0
**Audit:** passed (.planning/milestones/v9.0-MILESTONE-AUDIT.md) — 17/18 requirements + 1 accepted honest-null; integration 9/9 seams; E2E flows 3/3

**Delivered:** Belief-correction and retrieval now work on messy real-world data — the reconsolidation judge actually fires on real contradictions instead of zero — and the gains are locked behind a merge-blocking regression gate; plus a ten-phase viz overhaul (52–61) that made the 3D brain honest, legible at 15k+ nodes, and alive.

**Key accomplishments:**

1. **Reconsolidation candidate broadening (46):** contradiction candidates are now the union of entity-keyed graph lookup + BM25 lexical (node_fts) + dense top-k — the judge fires 368 contradicts on LongMemEval-KU vs a pre-46 baseline of ZERO (the backlog-999.2 root cause), with belief-correction at 84.6% and no clean-case regression (fresh EVAL-02, discharged in 50-03). All load-bearing guards (tombstone, provenance, no-self-confirmation) intact.
2. **Hybrid BM25+dense retrieval (47):** RRF fusion live on the LLM-free hot path behind a single tunable weight; held-out selection honestly found w*=0 (no positive weight beat pure cosine without per-category regression) — mechanism ships dark, ready for future data.
3. **Correctness hardening (48):** closed the C-2 self-confirmation loop, immediate-mode write transactions (no more SQLITE_BUSY_SNAPSHOT pass-aborts), SCHEMA_VERSION forward guard, embedding model/dims stamped + asserted (fails closed on mismatch).
4. **Scale spike → WASM SIMD kernel (49, 51):** measured ANN NO-GO (exact scan p95 19.5ms @14k, crossover ~33k nodes) and bi-temporal DEFER (tombstone-always stands); shipped a portable WASM SIMD f32x4 exact-scan kernel instead — byte-exact (recall@10=1.000, max|Δscore|=1.8e-7 at dim=1536), ~4–5× faster, zero native deps.
5. **Regression gates, merge-blocking (50 + quick 260720-nup):** offline deterministic `gate:ci` tier (reads committed recorded-metric fixtures, sub-second, no API/DB) wired as a required CI status check on main; accuracy floors armed (`gate:accuracy`, key-guarded); docs/evals.md re-baselined to v9.0-final with honest fresh-vs-reused provenance per metric.
6. **Viz overhaul arc (52–61):** honest traces from real scored hops, deliberate clustering legible at 15.4k live nodes, three-layer ambient liveliness (live > replay > spontaneous > twinkle) with genuinely-real 1-hop spreads, luminance-equalized identity palette, node presentation/motion overhaul, HUD integration, settings + stats depth, and corpus index-column project browsing — every stage founder-signed-off live.

**Known deferred items at close:** 11 acknowledged (see STATE.md Deferred Items) — notably Phase 57/58 human-verification residuals, RETR-03 honest null, and 4 pending todos.

## v8.0 Performance, Efficiency & Competitive Parity (Shipped: 2026-06-26)

**Phases:** 40, 41, 42, 44, 45 (Phase 43 deferred — not built) + folded-in standalone corpus increments 39.2, 39.3
**Plans:** 24 (40:5, 41:3, 42:4, 44:6, 45:6) + 9 folded-in (39.2:5, 39.3:4)
**Git:** tag `v8.0` (annotated, on `main` after merging `fix/ci-stale-tests-clean` — 184 commits / 51 feat-commits over the v7.0→close window; net code 15,076+ / 15,299− across 180 files, ~31k LOC TS in `src/`)
**Timeline:** 2026-06-22 → 2026-06-26 (~4 days)
**Suite at close:** 2383 passed / 3 skipped · tsc clean
**Verification:** Phase 40 VERIFICATION passed (BENCH-01/02/03 PASS); 39.2 VERIFICATION passed; 41 gates PASS (PERF-02/03(a)); 44/45 plans complete with Phase-45 code review CR-01/CR-02/WR-01-03 closed (`c539e12`). No milestone audit was run (founder elected to close with Phase 43 documented as a known gap rather than gate on `/gsd:audit-milestone`).

**Key accomplishments:**

- **Phase 40 — Competitive Benchmark Baseline (BENCH-01/02/03):** stood up a reproducible LoCoMo harness alongside LongMemEval + KU replay and recorded honest baselines on the frozen v7.0 SUT (`d41d5c8`) — LoCoMo-10 **J=86.0%** (lenient mem0 Appendix-A judge, cited relative-only — explicitly NOT a clean mem0 win), retrieval **R@5/R@10 = 77.3/82.2%**, live-brain retrieval **p50/p95 = 45/46 ms** over ~11.3k nodes, synthetic curve 1k–20k. Competitor targets pinned with sources AND a methodology note on what each number actually measures (no-inflated-metrics rule applied to *reading* competitors too — e.g. MemPalace's 96.6% = raw-embedder mode, Zep 84% DO-NOT-CITE). Write-ups: `40-BASELINE.md`, `40-COMPETITOR-TARGETS.md`.
- **Phase 41 — Vector Index + Hot-Path Latency (PERF-01/02/03):** replaced brute-force O(N) cosine on the hot recall path with a **zero-dep flat-buffer vector sidecar** (chosen on a spike that beat sqlite-vec; net-zero deps), derived/rebuildable (graph stays source of truth; consolidator stays brute-force). Top-k equivalence **byte-exact 40/40** (PERF-03(a)); latency **warm 13/14 ms (~3.4×), cold 72/77 ms (−24 ms)** vs the Phase 40 baseline (PERF-02). PERF-03(b) 3-harness end-to-end re-run deferred to the Phase 43 CI gate (founder 2026-06-24: harnesses don't use the index → re-running corroborates an already-proven result at hours-scale + paid-API cost for no new assurance).
- **Phase 42 — Token / Cost Efficiency Audit (COST-01..04):** measured the marginal write path at **~7,118 tok/turn, 0% Sonnet escalation** (the naive 26,495 tok/turn headline overstates marginal write ~3.7× because corpus-gen is a separate backlog subsystem); clean breakeven ~6.2 sessions. Applied per-source **`consolSkipThreshold: { 'claude-code': 0.5 }`** (global 0.5 rejected as UNSAFE — drops project-survey/project-doc knowledge) capturing ~87% of the token win with near-zero loss, validated by $0 live-brain inspection (the synthetic harnesses force salience=1.0 → lever no-op). Progressive-disclosure A/B run LLM-free; competitor savings stated with reproduced + cited numbers.
- **Phase 44 — Bundled-App Settings & Cost Controls (D-01..D-12, productization track):** a settings *surface* over the already-existing env/config levers — merge loader (env>file>preset>DEFAULT), presets **Lite/Standard/Full**, a token-usage ledger with feature-tagged sink, `recense config` CLI + launchd frequency regen, and viz-server settings/usage routes + in-app panel. Load-bearing guardrail: extract + prediction-error reconsolidation is **non-optional** (toggling it off = not recense); only corpus docs / schema depth / viz / frequency are optional. Since 100% of token cost lives in the offline pass, this is a switch on that pass, not a re-architecture.
- **Phase 45 — Subscription-Default Install & Billing-Leak Warning (D-01..D-17, productization track):** flipped `DEFAULT_CONFIG.modelProvider` → `claude-headless` so Max-subscription billing is the install default; restructured `recense init` (provider step, drop the required Anthropic key on the subscription path, acknowledge-gate when a `~/.claude/settings.json` key is detected); added a `recense doctor` billing-posture dimension + `claude` CLI login probe. **Corrected the false "billing-leak fixed" claim** to an honest named footgun — the env-strip does NOT prevent API billing because `ANTHROPIC_API_KEY` in settings.json re-injects into `claude -p`; recense never edits that file (detect + warn only). Design/PRD: `docs/superpowers/specs/2026-06-26-subscription-default-install-design.md`.
- **Folded-in corpus increments (standalone, inserted post-v7.0):** **39.2 Multi-Level Corpus Graph** — LLM-free projection of `doc_reference` (IDF shared-members + schema_rel adjacency) + multi-level `doc_containment` from the abstraction ladder, turning the shallow hub→subject star into a real doc→doc graph (~$0, no re-ingest); **39.3 Reader Generation Phase-Status** — real per-phase progress UI + a genuine lock-aware wait-queue with an honest `failed` end-state, replacing the `generated_at` silent-no-op hack, via a per-slug status file across the detached-child→read-only-server boundary.

**Engine invariants held:** single-tenant; graph is source of truth, **vector index is a derived rebuildable cache** (never authoritative); online paths LLM-free; never strengthen a fact from inferred output (D-43); net-zero new runtime deps (flat-buffer sidecar, no sqlite-vec); all marginal LLM cost in the offline sleep pass; no accuracy regression accepted for a latency/token win.

### Known Gaps (founder elected to close with these open)

- **Phase 43 Eval Regression Gates — NOT BUILT** (empty dir, only `.gitkeep`). The v8.0-final accuracy/latency/token numbers are recorded but **not yet locked behind a CI/pre-merge gate**, so they can silently regress until the gate lands. Requirements **GATE-01 (automated gate), GATE-02 (thresholds on all three axes), GATE-03 (baseline = v8.0-final, intentional re-baseline)** carried forward to the next milestone as its opener. Deferred behind Phase 42's reset-window eval (roadmap 2026-06-24); both executor and verifier recommended deferral.
- **Phase 41 PERF-03(b)** — the 3-harness end-to-end no-regression re-run was explicitly routed into the deferred Phase 43 gate; carried forward with it.

**Known deferred (carried from v7.0, non-blocking):**

- **Phase 39.1-05 Task 2** (live hub/subject doc generation + verification) — async post-close confirmation against the `39.1-05-SUMMARY.md` checklist.

---

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
