---
gsd_state_version: 1.0
milestone: v8.0
milestone_name: Performance, Efficiency & Competitive Parity
status: completed
stopped_at: Phase 44 context gathered
last_updated: "2026-06-25T03:00:46.827Z"
last_activity: 2026-06-25 -- Phase 44 marked complete
progress:
  total_phases: 23
  completed_phases: 18
  total_plans: 75
  completed_plans: 69
  percent: 78
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-06-17)

**Core value:** The memory learns and stays correct over time — forms generalizations the user never stated, and updates the right belief in place when a fact changes.
**Current focus:** Phase 44 — bundled-app-settings-cost-controls

**Phase 37 go-live — remaining levers (not blocking; coverage tuning DONE):**

- 2/24 queries still below the gloss threshold (genuinely ambiguous phrasing) — gloss-quality, NOT fragmentation.
- Phase 25 entity dedup was done 2026-06-18 (opt-in CLI). It is NOT the lever for the Max fragmentation — "Max"/"Max (design lead)" are distinct surface forms in different normalizeValue buckets, so the same-value dedup never compares them; the anchor-union (typedAnchorPoolK=20) handles that fragmentation at recall (why coverage hit 92%). Catching semantic variants needs a NEW cross-value matcher (false-merge risk: "OpenAI" vs "OpenAI API key") — deliberately NOT built.
- **Phase 25 NOW NIGHTLY (commit `a483864`, flag `RECENSE_SLEEP_DEDUP=1` ENABLED in sleep.env 2026-06-21):** the existing precision-first same-value entity+fact dedup runs at the end of each sleep pass, preceded by a consistent VACUUM INTO snapshot (`~/.config/recense/snapshots/`, keep last 5) — the rollback point given the no-DB-backup SPOF; if the snapshot fails, dedup is skipped. E2E-verified on a live copy: snapshot valid, 26 entity + 9 fact clusters merged, FK clean, idempotent. Cross-value semantic merge deliberately excluded.
- **OPENAI_API_KEY ROTATED 2026-06-21** by founder (sleep.env updated) — sleep-pass node embeds + gloss self-heal now functional. (Old key was exposed in transcript twice; now dead.)
- Gloss tuning was measured on the template-derived query set (somewhat optimistic); the rewording is principled (mirror question form) and false-positive-free, but real-world phrasing may vary.

**MILESTONE STATUS (2026-06-23):** **v6.0 + v7.0 BOTH SHIPPED, tagged, and pushed to origin.** v6.0 (phases 29–34) → tag `v6.0` (`236fcd9`). **v7.0 (phases 35–39.1) CLOSED** → tag `v7.0` (`d41d5c8`), archived at `milestones/v7.0-ROADMAP.md` + `v7.0-MILESTONE-AUDIT.md`, MILESTONES.md entry written (hand-cleaned). Both tags pushed to `github.com:mbeato/recense.git`. RANK-02 + REFLECT-02 shipped DARK, no win claimed (tech-debt). **Phase 39.1 landed**: Plans 01–04 complete (new doc taxonomy + exhaust-gate + live junk cleanup of 22 obsolete chapter docs) + Plan 05 Task 1 (ingest recense + vtx). A latent bulk-consolidation stall was found+fixed during 39.1-05 (FIX-STALL-01, `67b3ade`). **Phase 39.1-05 Task 2 (live hub/subject doc-verification) DEFERRED ASYNC post-close** — the fixed consolidation drain is running (~307-episode backlog, ~hours); verify per-scope doc inventory retroactively against the `39.1-05-SUMMARY.md` checklist.

## Current Position

Milestone: v8.0 Performance, Efficiency & Competitive Parity (Phases 40–43)
Phase: 44 — COMPLETE
Plan: 1 of 6
Status: Phase 44 complete
Decision (founder, 2026-06-24): PERF-03(b) the 3-harness end-to-end re-run is DEFERRED to the Phase 43 CI regression gate. Rationale: the harnesses don't use the index, so re-running them (hours-scale KU consolidation + paid-API spend over the $3 gate) corroborates an already-proven result and buys no new assurance. Both executor and verifier recommended deferral.
Last activity: 2026-06-25 -- Phase 44 marked complete
Note: phase dirs preserved (no clear); 39.1-05 doc-verification still deferred async. Live recense.db opened read-only throughout; only the .vindex sidecar was written.

## Performance Metrics

**Velocity (historical baseline):**

- Total plans completed: 161 (v1.0: 42, v2.0: 14, v3.0: 42, v3.1: 8, v4.0: 22, quick-tasks: 19)
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
| Phase 28-schema-anchored-corpus P01 | 12 | 2 tasks | 9 files |
| Phase 28-schema-anchored-corpus P02 | 2026-06-19 | 4 commits (2 RED + 2 GREEN) | 4 files |
| Phase 30 P01 | 65 | 2 tasks | 4 files |
| Phase 34 P02 | 5 | 3 tasks | 3 files |
| Phase 39.1 P01 | 5 | 3 tasks | 4 files |
| Phase 42-token-and-cost-efficiency-audit P03 | 10 | 2 tasks | 1 files |
| Phase 42 P04 | 5 | 2 tasks | 1 files |

## Accumulated Context

### Roadmap Evolution

- Milestone **v7.0 Retrieval & Reasoning Depth** added (2026-06-20): Phases 35–38. Origin: founder gap-analysis vs LLM-Wiki / PARA / Quarto / mem0 / Letta / Zep-Graphiti — recense is *ahead* on the core learning mechanism (PE-gated reconsolidation, schema abstraction, self-confirmation guards) but behind on two edges: retrieval *ranking* (semantic-only, ignores strength/recency) and reasoning *depth* (untyped edges, recall-time-only inference). Unifying bet = recense's own "pay at sleep, save at recall" principle; all three build phases serve token-efficiency AND use-quality. **Bi-temporal validity (Zep/Graphiti) evaluated and explicitly deferred** — adds storage+complexity for a "what did I believe in March" question customer-zero rarely asks; revisit only on a concrete belief-history need.
  - Phase 35 — **Recency/Strength-Weighted Ranking** (RANK-01/02): fuse `effective_s`+`last_access` into recall ranking (today computed but used only for eviction); LLM-free, eval-backed on the KU/LongMemEval harness. Near-pure win, goes first. Standalone.
  - Phase 36 — **Typed Predicate Edges SPIKE** (TYPED-SPIKE-01): prove typed relations (`works_at`/`prefers`/…) lift multi-hop recall on a scratch DB before committing engine change. Spike-first per Phase-29 discipline; off-distribution architecture — founder stays the architect. Standalone.
  - Phase 37 — **Typed Predicate Edges BUILD** (TYPED-01/02): **gated on Phase 36 go/no-go** — does not start on a no-go. Typed edge model + offline typed extraction + typed-path recall (precise path vs neighborhood dump).
  - Phase 38 — **Stored Reflections / Derived Insights** (REFLECT-01/02): sleep-pass reflects over schema clusters → stores insights as `origin=inferred`, non-strengthening, confidence-capped; recall returns a precomputed insight instead of re-synthesizing N facts at compose-time. Makes "reasons over schemas" a durable mechanism. Sequenced last. Founder-directed 2026-06-20 (scope: "ranking now, spike then build the rest"; new milestone).
- Milestone **v8.0 Performance, Efficiency & Competitive Parity** added (2026-06-20): Phases 40–43, **starts after v7.0** (system under test must be final, not a moving target). Founder goal: "lock down performance and efficiency, hammer evals, be at or above competitor memory systems." Frame: competitors (mem0, Zep/Graphiti, Letta) publish on **three axes — accuracy, latency, token/cost** — and founder wants all three. **Load-bearing hard-rule: no inflated metrics** — every competitive claim must be a benchmark recense ran itself or a published competitor number cited with source; baseline-before-optimize mandatory. Grounded headline lever: recall still does **brute-force O(N) cosine** (`src/retrieval/topk.ts`) and the live brain is already **7000+ nodes** (past the ~5K comfort), with the `sqlite-vec`/HNSW seam **unbuilt** → biggest latency win. Scope: FULL (founder-chosen) — includes building the vector index, not just tuning knobs.
  - Phase 40 — **Competitive Benchmark Baseline** (BENCH-01/02/03): add LOCOMO alongside LongMemEval + KU harness; record honest accuracy/latency(p50,p95)/token baselines; cite competitor targets with sources. **Gates 41–43.**
  - Phase 41 — **Vector Index + Hot-Path Latency** (PERF-01/02/03): build sqlite-vec/HNSW (derived/rebuildable cache, graph stays source of truth), kill brute-force cosine, profile recall + SessionStart inject; no accuracy regression. Independent of 42.
  - Phase 42 — **Token/Cost Efficiency Audit** (COST-01/02/03): measure write (Haiku/Sonnet) + recall token cost, tune consolSkipThreshold/inject budget, verify v7.0 ranking+reflection token savings paid off; defensible vs-competitor claim. Independent of 41. **Deferred-run battery executed 2026-06-25** (2nd Max plan cleared the reset constraint): COST-01 closed (marginal write ~7,118 tok/turn, 0% Sonnet escalation; naive 26,495 overstates ~3.7× via corpus-gen contamination); COST-02 closed by $0 live-brain inspection (KU/LoCoMo/LongMemEval all lever-blind, salience=1.0) → **per-source `consolSkipThreshold: {'claude-code':0.5}` applied** (global 0.5 rejected: drops project-survey/project-doc knowledge); STEP 4 SKIPPED (lever-blind + expensive); four runbook errors found + annotated. (quick 260625-nkt)
  - Phase 43 — **Eval Regression Gates** (GATE-01/02/03): turn harness into a CI/pre-merge gate with thresholds on all three axes; freezes v8.0-final numbers. Comes last. Founder-directed 2026-06-20 (placement: new milestone after v7.0; ambition: full incl. vector index).
- **Competitor audit (2026-06-20, source-verified): claude-mem + MemPalace.** claude-mem (83k★, Apache-2.0, the direct CC-memory incumbent) = capture-and-compress, **append-only with exact-hash dedup, NO belief correction / NO decay / NO schema graph**; matches recense on hooks+inject+hybrid-retrieval+provenance+scoping. MemPalace (56k★, MIT, viral but contested) = verbatim ChromaDB + SQLite KG (triples w/ temporal-validity windows); spatial "palace" is a **metadata-computed veneer, not a real graph**; **README "contradiction detection" is NOT in the code** (per independent teardown + arXiv critique); benchmark 96.6% LongMemEval R@5 is "raw mode" = measures the embedder, not the architecture. **Net: recense's moat (PE-gated reconsolidation + schema abstraction) confirmed — both competitors punt on exactly that.** Three roadmap-relevant findings: (1) **progressive-disclosure retrieval** (compact index → fetch detail on demand) is a concrete token technique BOTH use and recense likely lacks → Phase 42 input / pending founder decision; (2) competitor benchmark numbers are gameable → folded into Phase 40 BENCH-03 (understand-methodology, not just cite) + concrete targets added to ROADMAP Phase 40; (3) **temporal validity** kept deferred but now documented as a deliberate *competitive-positioning* stance (recense reconsolidation > MemPalace validity-windows for stale-info correctness), not an oversight.
  - Phase 39 — **Reader Wiki-Parity: Index + Backlinks** (WIKI-01/02/03): added 2026-06-20 after a feature-by-feature LLM-Wiki audit vs the `research-wiki` standard. Verdict: recense meets-or-beats the LLM Wiki on every *mechanism* (autonomous maintenance, dedup-to-canonical, PE-gated update-don't-rewrite, enforced citations, auto-staleness, self-confirmation immunity, forgetting) — behind only on two reader ergonomics: a browsable INDEX and surfaced backlinks ("what links here"). Both reuse data that already exists (doc nodes; `idx_edge_dst`/`getInEdges` reverse lookup) → presentation-layer parity, no engine change. **Markdown export deferred** (recall+reader replace grep; queryable-DB-vs-portable-files is a deliberate divergence). Engine-internal data for both already present; gap was purely UI. Independent of 35–38. Founder-directed 2026-06-20.
- Phase 34 added (2026-06-20): **Visual Polish Pass** — cross-surface UI cleanup of the four live viz surfaces (Reader, Corpus 2D graph, Detail panel/page, Brain HUD/controls) along two axes only: spacing/alignment consistency + states & transitions (loading/empty/error, hover/focus, smooth transitions). Polish only — no structural/composition change, no redesign. Founder-locked guards: palette (amber=activation/hover only, ref 27-04 violation), 3D density anchor (no regress), net-zero deps. Standalone (all surfaces exist + live). UI hint: yes — route through `/gsd-ui-phase 34` at plan time. Founder-directed 2026-06-20.
- Phase 33 added (2026-06-20): **Synchronous Curated Write (`recense remember`)** — closes the customer-zero "replaces MEMORY.md" promise on the WRITE side. recense owns read (recall at session-start) but deliberate facts still leak to native Claude Code `.md` memory because the only write paths are passive-lossy (turn-capture→sleep-pass) or batch-lossy (import-memory). Adds a synchronous, verbatim, curated single-fact write that runs in-place reconsolidation (reuses update-decision/sink/judge), plus a CLAUDE.md cutover directive and a one-time lossless migration of the 12 existing `.md` files through the new command. Standalone — depends only on the live consolidation machinery, NOT the v6.0 onboarding phases. Founder-directed 2026-06-20; design forks resolved (reconsolidate-on-write + migrate-via-remember). See memory [[graphify-is-codebase-tool-not-memory-rival]] context thread.
- Phase 28 added (2026-06-19): **Schema-Anchored Corpus** — pivots the reader corpus from project-scope docs to the abstraction graph rendered as prose (docs anchor on schemas/entities, cite direct facts; mass-gated promotion; hierarchy mirrors the `abstracts` ladder; decide-cheap/generate-lazy; read-only projection). **Supersedes Phase 27 READER-04** (doc_link-between-projects); inherits the reader UI + flat 2D renderer + lazy-gen + /doc routes + gather + doc-writer. Origin: design discussion during Phase 27 27-05 verification (see memory [[corpus-from-schemas-design]]).
- Phase 39.1 inserted after Phase 39: Corpus Quality — project-hub + subject docs via LLM exhaust-gate, retroactive junk cleanup, recense+vtx ingestion (design in recense, scope brain-memory) (URGENT)
- Phase 39.2 inserted after Phase 39.1: Multi-Level Corpus Graph from Schema Projection — project the doc->doc graph (doc_reference subject<->subject + cross-project, multi-level containment) down from the existing schema/fact graph; LLM-free, no re-ingest. Origin: 39.1-05 verify found doc_reference near-empty (star topology). Structure-only; corpus-content fix (exhaust-judge, hollow subjects, schema-chapter regen) deferred.

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

**Plans (planned 2026-06-17, canonical names):** `24-01` SCOPE-01/02 gate · `24-02` SCOPE-03 dry-run gate · `24-03` SCOPE-04 human-gated migration (`autonomous: false`).
NOTE: plans were initially written as `24.1/.2/.3` (dot form) which broke wave/dependency resolution (all collapsed to wave 1 → would have run the paid migration in parallel with the gate). Renamed to `24-0N` hyphen form so `depends_on` resolves the strict chain 24-01 → 24-02 → 24-03.

**FK bug status — RESOLVED + verified 2026-06-17 (commit `67eee74`):**

- The prior "fix" (schema-relations FK-02 + eviction child-wipe ab3b6c8) was only **containment** — per-episode isolation quarantined the failing episode and let the pass continue, but episode `49e769b8-368d-41f3-95b4-f8cf2f8eb661` still threw `FOREIGN KEY constraint failed` and was **dropped every pass** (silent data loss).
- Real root cause (debug `resolved/fk-consolidation-residual.md`): in `consolidator.ts`, the judge's `best_candidate_id` was used directly as `edge.src` in the `extend` branch WITHOUT filtering against `candidateIdSet` (unlike `contradicted_ids`, which already was). A non-deterministic headless judge returning an out-of-set / hallucinated id → `edge.src` references a non-existent node → FK violation.
- Fix: null-coerce `best_candidate_id` against `candidateIdSet` (out-of-set → standalone no-edge path). Regression test `T-FK-01` added; build clean; vitest green.
- Live verification: episode `49e769b8` now `consolidated=1`; no FK error; `PRAGMA foreign_key_check` empty.

**Consolidation stack (transitioned in a separate session, 2026-06-17):** `RECENSE_EXTRACTOR_PROVIDER=claude-headless` + `RECENSE_JUDGE_PROVIDER=claude-headless` (sleep.env) — headless `claude -p` on the **CC subscription**, replacing the local/deepseek stack. Billing-leak closed: no `ANTHROPIC_API_KEY` in `~/.claude/settings.json`; commit `7c4b117` isolates headless from global hooks (`--setting-sources project`). The headless judge's non-determinism is exactly what surfaced the FK bug above — the T-FK-01 fix hardens against it.

**Hourly agent (`com.recense.sleep-pass`):** RE-ENABLED and stable (no crash loop post-fix). The backlog had PLATEAUED at ~143–154 (270 → 238 → 143 → then stuck) — this was a BUG, not throughput: the salience-skip path in `consolidator.ts` did `continue` without `markConsolidated`, so 142 sub-threshold episodes were re-scanned and re-skipped every pass forever (LLM-free gate → stuck across all 3 model stacks). Fixed in quick-260617-ulp (`5326550`): mark-and-skip via a shared `markSkipped` helper. Verified on a live-DB copy: backlog 144 → 2 (the 2 are at/above-threshold needing a working model), no graph effects from skips, fk_check clean. The next live pass (dist rebuilt) marks the ~142 → backlog falls to the at/above set → sentinel clears.

**SCOPE-01 backlog: DRAINED TO 0 — done 2026-06-18T02:16Z** via a manual pass on the new dist (145 → 0, "Sleep pass complete", fk_check clean, no graph effects from the salience-skips). SCOPE-01 consolidation gate is functionally met: backlog=0 + clean pass.

CORRECTION (load-bearing): the gate's old "dirty sentinel clears" sub-criterion is UNMEETABLE — **nothing in the codebase removes the sentinel** (confirmed via grep, src + scripts). It is a TRIGGER signal: `EpisodicStore.append()` bumps its mtime so launchd WatchPaths fires; launchd triggers on modification, not existence. So the file persists permanently regardless of backlog. The real success signal is **backlog=0 + a clean launchd-triggered cycle** (a no-op "Sleep pass complete" in `/tmp/recense-sleep.log`), NOT a sentinel that disappears. Backlog=0 is momentary — active claude-code sessions + ongoing migration ingest will re-touch the sentinel and re-grow it; the agent now drains it fully each pass instead of plateauing. Remaining for SCOPE-01: run the SCOPE-02 `[scope]` recall check (24-01 Task 2). Then 24-02 → 24-03 unblock.

**Running a manual sleep pass (if forcing the drain):**

```
set -a; . ~/.config/recense/sleep.env; set +a
"$RECENSE_NODE_BIN" "$RECENSE_SLEEP_JS"   # logs to /tmp/recense-sleep.log
```

**API cost for 24-03 migration:** ~$1–2 (confirm against budget before the real run, D-13). Judge is now headless Sonnet on the subscription, not API — embedding remains the cost driver.

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
| 260617-qat | Gated headless `claude -p` transport (spike 003) behind the AnthropicLike seam — extract→Haiku/judge→Sonnet on Max, env-strip billing safeguard, default provider unchanged. Tasks 1–3 shipped; Task 4 (live sleep.env activation) founder-gated. | 2026-06-17 | 1a58624 | [260617-qat](./quick/260617-qat-integrate-spike-validated-headless-claud) |
| 260617-ulp | Fix salience-skip consolidation leak — the salience-skip `continue` in consolidator.ts never called markConsolidated, so 142 sub-threshold episodes were re-scanned every pass forever (sentinel never cleared, blocked SCOPE-01). Mark-and-skip via shared `markSkipped` helper (routes both skip sites). Verified on a live-DB copy: backlog 144→2, no graph effects, fk_check clean. | 2026-06-18 | 5326550 | [260617-ulp](./quick/260617-ulp-fix-salience-skip-consolidation-leak-mar) |
| 260617-w0u | Phase 24 SCOPE-04 source retirement (24-03 T4, founder-gated) — nav-layer safety verified, then MOVED 197 migrated fact files → `~/.claude/projects-memory-archive-2026-06-18/` (reversible). Kept 12 indexes + 7 policy bundles + 2 live trackers (excluded from 199→197 after finding skills read/write them). DB untouched; 199/199 still consolidated+scoped. Closes Phase 24. No git commit (move is under ~/.claude; .planning gitignored). | 2026-06-18 | — | [260617-w0u](./quick/260617-w0u-phase-24-scope-04-source-retirement) |
| 260619-mbr | Viz scaling (post-v5.0) — brain-viz lagged with ingestion; measured the cause = 6,119 unabstracted "haze" fact/entity nodes rendered as individual transparent meshes in the overview. Render them as ONE InstancedMesh (shared geo + Fresnel material + per-instance color, volume-scattered, pickable via instanceId) + exclude haze from the d3 force sim. Overview ~6,400 meshes → ~270 + 1 instanced cloud; look preserved (founder-locked density anchor untouched). Founder-approved ("feels way better"). Scales toward the v6.0 ingestion milestone. | 2026-06-19 | e5e551e | [260619-mbr](./quick/260619-mbr-viz-haze-instancing) |
| 260619-mbr | Viz haze instancing — replace ~6,119 per-mesh transparent haze spheres with one THREE.InstancedMesh (T1: exclude haze from ForceGraph3D sim; T2: deterministic in-volume scatter + Fresnel material; T3: instanceId raycasting hover/click/trace). Draw calls: ~6,400 → ~270 + 1 instanced. T4 awaiting founder visual verification at http://localhost:7811. | 2026-06-19 | 1e56b1c, 98a641b, e5e551e (T1–T3) | [260619-mbr](./quick/260619-mbr-viz-haze-instancing) |
| 260620-sf9 | Raise sleep-pass headless timeout to 600s — the scheduled sleep pass ran headless `claude -p` at the 120s default, too short for Phase 32-02 landing docs (100+ citations, ~256s) → SIGKILL → empty → not persisted, silently dropping large docs on 32-03's deferred path. Mirror the 600s guard already in generate-doc/generate-corpus/ingest-project CLIs. Found during Phase 32 live verification; A/B-confirmed (usage doc: empty@120s vs 24KB/148-cite@600s). 22/22 sleep-pass tests pass. | 2026-06-21 | 7588c7e | [260620-sf9](./quick/260620-sf9-sleep-pass-headless-timeout) |
| 260625-nkt | Apply per-source `consolSkipThreshold: {'claude-code':0.5}` (config.ts) + record Phase 42-04 deferred-eval findings. Deferred-run battery executed 2026-06-25 (2nd Max plan cleared reset): COST-01 closed (marginal write ~7,118 tok/turn, 0% Sonnet escalation; naive 26,495 overstates ~3.7× via corpus-gen contamination → breakeven ~6.2 vs 22.9 sessions); COST-02 closed by $0 live-brain inspection (synthetic benches lever-blind, salience=1.0) → global 0.5 rejected (drops project-survey/project-doc knowledge), per-source claude-code:0.5 is the safe ~87% win. STEP 4 (LoCoMo/LongMemEval) skipped (lever-blind). Four runbook errors found + annotated. Build clean. | 2026-06-25 | e82afcb (config), (docs below) | [260625-nkt](./quick/260625-nkt-apply-per-source-consolskipthreshold-cla) |

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
| Viz / index | Semantic-clustering CATEGORIES for the index Schemas tree — k-means (fixed k) + LLM cluster labels from c-TF-IDF candidates (via headless `claude -p`), recompute on doc-count bands not continuously. Deep-research verdict (Phase 39): at ~22 docs search+hierarchy beats clustering (unstable — no defensible min_cluster_size at 20–100, HDBSCAN over-fragments, re-cluster churn); graph-community detection over the sparse schema_rel/doc_link hairball refuted. | Deferred — trigger not met (~100+ docs) | 2026-06-21 |
| Corpus / Phase 32 | Run `promoteScope('tonos')` (+ other project scopes) so project landing docs gain chapter-doc children — the hybrid index already renders project→chapter nesting; tonos is currently a standalone Phase-27 generate-doc with no children. | Deferred to Phase 32 (Project Recall + Auto-Corpus) | 2026-06-21 |
| Corpus freshness | Refresh/grow the doc corpus — it's been a while since docs were added and some schemas/projects lack docs. Run `ingest-project` on unexplored projects + corpus promotion / doc-generation passes. Also feeds the ~100-doc trigger for index categories above. | Backlog — operational | 2026-06-21 |

### Acknowledged & deferred at v7.0 milestone close (2026-06-23)

| Category | Item | Status |
|----------|------|--------|
| Phase 39.1 validation | Plan 39.1-05 Task 2 — live hub/subject doc generation + per-scope verification | Deferred ASYNC post-close (founder decision). Code + units done; the FIX-STALL-01 consolidation drain was running at close. Retroactive checklist in `39.1-05-SUMMARY.md`. |
| Consolidation hardening | Lock-heartbeat for >30-min passes — call `heartbeatLock()` (exists in lockfile.ts:237) from the consolidator via a `consolidate()` callback (keeps src/consolidation free of adapter imports). FIX-STALL-01 stopped the infinite loop; this prevents the >30-min single-pass stale-lock collision. | Deferred — known follow-up (also pre-listed 2026-06-17) |
| Phase 39.1 corpus polish | Auto-extracted v7.0 MILESTONES accomplishments were garbled by SUMMARY parsing → rewritten by hand at close. PROJECT.md full evolution review + RETROSPECTIVE.md v7.0 section not done at close. | Retroactive — founder OK'd updating docs post-close |
| Open artifacts | Same 43 from v6.0 scan re-surfaced (none scoped to v7.0 phases) | Re-acknowledged — see v6.0 block below |

### Acknowledged & deferred at v6.0 milestone close (2026-06-22)

43 open artifacts surfaced by the pre-close audit-open scan were acknowledged and deferred (none scoped to v6.0 phases 29–34):

| Category | Item | Status |
|----------|------|--------|
| quick_tasks | 37 completed quick-tasks lacking a status/summary file (dates 260606→260620, v1.0–v6.0 era) | Acknowledged — completed work, missing metadata only |
| debug | `knowledge-base` debug session [status unknown] | Acknowledged — stale/ambient, not v6.0 |
| todos | content-hardening-deferred · corpus-brain-3d-transition · viz-search-and-hull-quality | Acknowledged — intentional future deferrals |
| seeds | SEED-003 (multi-tenant namespaces) · SEED-004 (Telegram reference client) | Dormant by design |
| tech-debt (audit) | `--scope` not lowercase-normalized in ingest-project-cli / remember-cli (recall-cli lowercases) — mixed-case write/recall mismatch | Deferred — convention-only edge case |
| tech-debt (audit) | headless-client process lingers at 0% CPU after generateDoc / generateCorpusDocs (DB writes land correctly) | Deferred — pre-existing operational note |

## Session Continuity

Last session: 2026-06-24T22:25:08.713Z
Stopped at: Phase 44 context gathered
Resume file: .planning/phases/44-bundled-app-settings-cost-controls/44-CONTEXT.md

## Key Decisions (Phase 28)

- **gatherFactsForSchema tags spine facts 'scope'** — identical tag to the scope-gather so downstream via-handling, citation verify, and corpus tests need no change (Plan 28-02)
- **null centroid = hard skip of semantic pass, no embed call** — D-09 design: the centroid is pre-computed by the caller (promoter/CLI), never computed inside gatherFactsForSchema; null centroid degrades gracefully to spine + entity-hop (Plan 28-02)
- **verifyCitations() factored as unexported internal helper in doc-generator.ts** — FACT_REF regex defined exactly once, shared by scope (generateDoc) and schema (generateDocForSchema) paths; prevents duplication drift (Plan 28-02)
- **generateDocForSchema uses gatherSiblingDocs(db, schemaId)** — the schemaId is passed as the "current slug" so the schema's own doc is excluded from the sibling list; consistent with scope path (Plan 28-02)
- **buildSchemaDocPrompt frames schemaLabel as THESIS** — "This deep-dive's thesis is a generalization that the memory engine abstracted from experience: '<schemaLabel>'"; same HARD RULES + RELATED DOCS block as buildDocPrompt (Plan 28-02)

## Key Decisions (Phase 27)

- **linkedDocRefs returned by generateDoc includes ALL doc refs from prose** — writeDoc is responsible for the in-set guard (tombstoned/non-existent skipped); generator stays read-only and composable
- **/graph?type=doc JOINs node_doc to expose slug field** — enables D-08 doc-node click → reader open without a new server endpoint; slug in corpus node records (Plan 27-05)
- **Corpus view = SEPARATE flat 2D Obsidian graph, NOT a 3D-brain data-swap** (founder-directed, Plan 27-05) — vendored `force-graph@1.43.5` (2D canvas, no THREE dep, net-zero npm deps); `corpus.js` owns a separate `ForceGraph()` instance on `#corpus-graph`; full-window hide/show toggle leaves the 3D brain untouched (no rebuild, no density regression). Supersedes the earlier 3D-data-swap (738aa66 reverted-in-spirit; the data layer stays)
- **force-graph vendored as a file** — same posture as the existing `3d-force-graph.min.js` (same author Vasco Asturiano); keeps net-zero npm deps; exposes `window.ForceGraph` (Plan 27-05)
- **openDocReader() (corpus.js) navigates via window.location** — resolves slug from the corpus node data; navigates `/?doc=<slug>&reader=1` (D-08, Plan 27-05)
- **Corpus button expanded-only CSS gate** — mirrors search/topic-wrap pattern: `#btn-corpus { display:none }` / `.mode-window #btn-corpus { display:inline-flex }` (D-07, Plan 27-05)
- **generated_at is write-once at the SQL layer** (ON CONFLICT omits generated_at from the DO UPDATE SET clause) — staleness predicate cannot be corrupted by doc re-render without regen
- **Table recreation migration guard** checks live DDL from sqlite_master before running — idempotent and no data loss on re-run
- **node_doc sidecar** (not a new column on node) — mirrors node_scope/node_temporal pattern for faithfulness
- **CandidateRetriever created from db inside gatherFacts** (optional injection for tests) — simpler caller API vs. requiring all callers to inject a retriever
- **generateDoc is read-only** (no DB writes) — CLI composes generateDoc+writeDoc, preserving testability without real DB
- **FTS suppression via DELETE after upsertNode** in same IMMEDIATE transaction — prevents markdown body polluting BM25 keyword search
- **Judge-tier config as generate head** (D-04): DefaultModelProvider({ generateConfig: judgeConfig, ... }) — no new docModel/genModel var
- **Doc-gen headless timeout = 600s** (env-overridable, scoped to the CLI): doc-gen's ~4000-token gen crosses the shared client's 120s default → swallowed-timeout empty doc. Shared client's empty-on-failure fail-safe left UNCHANGED (sleep pass depends on it)
- **generateDoc fails loud on empty output** — never persists a silent empty doc (the swallowed-timeout backstop)
- **One live doc per slug** — writeDoc tombstones the prior live doc for the slug in-transaction so --force supersedes, not appends
- **spawnGenerateDoc as inner closure in startVizServer** — closes over dbPath and inFlightSlugs; no arg-passing overhead; detached subprocess with unref() (fire-and-forget)
- **Graph focus via Graph.nodeColor()/linkColor() callbacks** — client-side, cited set is small (from /doc/meta), no server nodeIds filter needed; liftGraphFocus() restores null callbacks on hide()
- **Selection NOT cleared on toggle** — `hide()` does NOT clear ctx.selectedId or selectNode; detail panel stays open; the brain→reader toggle feels like one system at two altitudes (READER-02)

## Operator Next Steps

- Start the next milestone with /gsd-new-milestone
