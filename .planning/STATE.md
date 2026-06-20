---
gsd_state_version: 1.0
milestone: v6.0
milestone_name: Project Onboarding
status: executing
stopped_at: Phase 30 context gathered
last_updated: "2026-06-20T14:21:09.632Z"
progress:
  total_phases: 4
  completed_phases: 1
  total_plans: 6
  completed_plans: 5
  percent: 25
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-06-17)

**Core value:** The memory learns and stays correct over time — forms generalizations the user never stated, and updates the right belief in place when a fact changes.
**Current focus:** Phase 30 — core-ingest-command

## Current Position

```
Milestone: v6.0 Project Onboarding — ROADMAP READY
Phase: 30 (core-ingest-command) — EXECUTING
Plan: 3 of 3
Status: Ready to execute

[████████████████████████████████████████░░░░░░░] v1-v5.0 SHIPPED · v6.0 Phase 29: 2/3 plans done · Plan 03 paused at go/no-go checkpoint
```

**v6.0 phases:**

- Phase 29: Survey Quality Spike (INGEST-03) — go/no-go for the build
- Phase 30: Core Ingest Command (INGEST-01/02/04) — depends on 29
- Phase 31: Doc Ingest + Idempotent Re-ingest (DOCING-01, REINGEST-01/02) — depends on 30
- Phase 32: Project Recall + Auto-Corpus (RECALL-01/02) — depends on 30+31

**v6.0 Project Onboarding — opened 2026-06-19.** Goal: onboard a fresh/unexplored project into the brain via an agentic survey (summarized knowledge, not raw code) → episodes → consolidation; generalized doc ingest; idempotent re-ingest; scoped project recall + auto-corpus. Scope confirmed by founder (all 4 capabilities). Research skipped (designed from first principles + known ingestion seams). Phase numbering continues from 28 → 29+. Earlier v5.0 phase dirs (24-28) retained in `.planning/phases/` (no collision; archived detail in `milestones/v5.0-ROADMAP.md`).

**Phase 27 Plan 05 (corpus graph — COMPLETE) — 2026-06-18:**

- **Task 1 (`971c69b`):** `generateDoc` returns `linkedDocRefs` from `recense://doc/<id>` refs in prose; `writeDoc` creates `kind='doc_link'` edges for live target doc nodes only (in-set guard, T-27-15, FK-safe). 9 tests green.
- **Task 2 (`738aa66`):** `GET /graph?type=doc` returns live doc nodes (with slug via node_doc JOIN) + doc_link edges; `/graph` unchanged. Data layer founder-verified correct — stays.
- **Task 2b (founder-directed redesign — `f5a46e0` vendor + `11e4ba3` rendering):** the corpus view is now a SEPARATE flat 2D Obsidian-style graph (vendored `force-graph@1.43.5`, 2D canvas, no THREE dep, net-zero npm deps) on its own `#corpus-graph` container — NOT a 3D-brain data-swap. `corpus.js` owns `#btn-corpus`; lazy-inits the 2D instance on first open; full-window toggle hides `#graph` + shows `#corpus-graph` (brain untouched, no density regression); muted rose/slate/mauve at rest, amber hover-only; D-08 doc-node click → `/?doc=slug&reader=1`. Removed the 3D-swap code from reader.js. 14 corpus tests green; tsc clean; dist rebuilt.
- **Task 3:** No new checkpoint opened (per direction). Viz server on **7819** against `/tmp/corpus-verify.db` (tonos + vtx + doc_link) — founder reload-confirms the flat graph there.

**Phase 27 Plan 04 (staleness — COMPLETE, founder-approved) — 2026-06-18:**

- **Task 1 (`63dbe0f`):** `GET /doc/staleness?slug=` in `server.ts`. `stmtCitedFacts` stmt compiled once: joins cites-edge reverse lookup to cited fact rows (tombstoned + last_access + prev_value). Returns `{generated_at, stale:[{factId,prev_value,value}], tombstoned:[id,...]}`. Read-only (T-27-13). 10 tests green.
- **Task 2 (`f38a9ec`):** `fetchStaleness()` in `reader.js` — after wireFactLinks, fetches staleness, marks `.fact-stale` (+ data-prevValue) and `.fact-tombstoned` (pointer-events:none + aria-label) inline refs, prepends `.staleness-banner` with textContent count + `.btn-regen`. Stores `ctx.staleFactIds` + `ctx.staleFactPrevValues`. `regenerate()` POSTs to `/doc/generate` + reloads via loadWithPoll. `detail.js` populateDetail: `.meta-row.meta-diff` row shows "was: `<prev_value>`" via textContent (T-27-12). CSS: `.staleness-banner`, `.btn-regen`, `.meta-diff` rules in muted slate/mauve (not amber). 31/31 tests green. tsc clean.
- **Task 3 (checkpoint): APPROVED.** Founder verified banner + tombstone marker + atom-panel diff + detection — all good. ONE palette fix requested + applied (`fcaa1e9`): `.fact-stale` re-toned from orange/amber `rgba(217,130,60,...)` (the activation color — founder-locked violation) to the muted `.doc-ref` rose family `rgba(156,112,128,...)`. `.fact-tombstoned` (muted red) + `.staleness-banner` (mauve) untouched. Dist rebuilt; 31/31 tests + tsc clean. Demo at `/tmp/staleness-demo.db` (re-seeded), viz server on port 7818 — founder to hard-reload http://127.0.0.1:7818/?doc=tonos&reader=1 to confirm the rose tone.

**Phase 27 Plan 03 (reader UI — Tasks 1+2 done, Task 3 awaiting human-verify) — 2026-06-18:**

- **Task 1:** DB-backed `/doc?slug=` route in `server.ts` (replaced file-backed `/doc?term=`). On miss: spawns `generate-doc-cli` detached subprocess (server stays read-only, T-27-11); returns 202 `{status:'generating'}`. `/doc/meta?slug=` returns `{nodeId, generated_at, citedFactIds:[...]}`. `POST /doc/generate?slug=` for force-regen. In-flight Set deduplicates concurrent spawns (T-27-10). 13 tests green.
- **Task 2:** Promoted `reader.js` to DB-backed load (polls on 202), Reader/Brain toggle (btn text flips, class .open), graph focus on cited atoms via `Graph.nodeColor()/linkColor()` callbacks (client-side — cited set small), fact-ref click → `hide()` + `ctx.selectNode(node)` with selection preserved across toggle (READER-02). XSS-safe: single `innerHTML` from `renderMarkdown` output. 21 tests green.
- **Task 3 (checkpoint): VERIFIED.** Founder exercised the prose→atom→brain→prose round-trip and confirmed it works (one system at two altitudes). Found 2 UX gaps, both fixed (commit `5fefcac`): (1) added `#reader-close` × button in the header — the open slide-in `#reader` covers `#btn-reader` so the toggle was unreachable from inside; wired to existing `hide()` + Escape; muted-mauve/slate styling (NOT amber); (2) palette-styled `#reader` scrollbar reusing the `.detail-page #detail` muted-mauve treatment. Toggle/focus logic untouched. Dist rebuilt. Ready for founder to reload `http://127.0.0.1:7818/?doc=tonos&reader=1` and confirm.

**Phase 27 Plan 02 (doc-generation core) — COMPLETE 2026-06-18:**

- `gatherFacts` (scope ∪ semantic ∪ entity-hop, D-01), `generateDoc` (judge-tier cited markdown + citation-verify, D-04), `writeDoc` (lifecycle-exempt type='doc' node — no embed/decay/FTS/training — single IMMEDIATE transaction), `recense generate-doc <slug>` CLI (lock-guarded, idempotent, --force).
- **D-05 prose quality: PASS** (env judge model produces well-structured specific deep-dive ≥ Tonos baseline).
- **Live bug 1 found+fixed (`6960a5c`):** the `claude-headless` judge emitted 8-char id PREFIXES (`recense://fact/e751c852`), not full UUIDs → strict `{36}` regex dropped all 71 citations (0 cites edges). Fix: accept 8+-char prefixes, resolve via unique-prefix match (ambiguous→invented), CANONICALIZE prose to full UUIDs so node.value/cites/reader-regex agree.
- **Live bug 2 found+fixed (`809a0f7`):** `--force` re-run produced an EMPTY doc — NOT model non-determinism but a SWALLOWED TIMEOUT. The shared headless client (`DEFAULT_TIMEOUT_MS=120s`) returns empty content on timeout (its sleep-pass fail-safe); doc-gen's ~4000-token gen took ~122s → SIGKILL → empty string persisted as a silent 0-citation doc. Three scoped fixes (shared client UNCHANGED): (1) CLI raises doc-gen headless timeout to 600s (env-overridable); (2) generateDoc THROWS on empty output (never persists an empty doc); (3) writeDoc tombstones any prior live doc for the slug → one-live-doc-per-slug (--force supersedes, not appends). **27 tests green, tsc clean.**
- **Pending (non-blocking, needs USER auth):** (a) stray-doc cleanup — two test-artifact tonos doc nodes (`218260d4` len 8900, `97dc7e6a` len 0, both 0 cites) need an FK-consistent delete; (b) live `generate-doc tonos --force` re-verify (expect citationCount ~30–71, matching cites edges, one live doc). The auto-mode classifier blocked BOTH as coordinator-authorized live/paid mutations (coordinator consent ≠ user consent). Both confirm unit-tested fixes; do not block closure.
- **Carry into 27-03:** reader.js `recense://fact/<id>` interception MUST use the `{36}` full-UUID regex (the canonicalized doc body guarantees full UUIDs now).

Phase 24 status (verified 2026-06-18):

- **SCOPE-01** ✅ — FK root cause FIXED + live-verified (commit `67eee74`, debug `resolved/fk-consolidation-residual.md`); prior child-wipe (ab3b6c8) was only containment. Backlog plateau (~143) was a 2nd bug — salience-skip without `markConsolidated` — fixed `5326550`. Consolidation drains fully, clean passes, `foreign_key_check` empty. NOTE: the old "dirty sentinel clears" sub-criterion is UNMEETABLE — the sentinel is a permanent launchd TRIGGER, not clearable state; real signal = backlog≈0 + clean pass.
- **SCOPE-02** ✅ — `[scope]` recall verified live (read-only harness): `[vtx]`/`[tonos]`/`[putyouon]` render; global/unscoped render no marker (D-S6). (Plan's "[global] renders" criterion was wrong — global = blank.)
- **SCOPE-03** ✅ — `import-memory --dry-run` gate: 199 import / 7 policy skipped / 12 index skipped / 0 leaks (`24-02-DRYRUN-EVIDENCE.md`).
- **SCOPE-04** ✅ DONE — real import (idempotent, +6 new → 199/199 memory-import consolidated, 0 source files touched, clean FK pass) + verified retrievable with correct `[scope]` across tonos/vtx/putyouon/global. Report: `999.3-MIGRATION.md`. Cost: cents (judge on CC subscription; ~14 episodes embedded via OpenAI). **RETIREMENT EXECUTED 2026-06-18** (quick-260617-w0u): MOVED (never deleted) **197** fact files → `~/.claude/projects-memory-archive-2026-06-18/` mirroring source layout (reversible); KEPT 12 MEMORY.md indexes + 7 policy bundles + **2 live trackers** (`interview_readiness_tracker`, `leetcode_practice_tracker` — skills read/write them every session, so excluded from the 199→197 move). Nav-layer verified safe first: only readers of moved files are the kept policy bundles + the 12 indexes (whose `[file.md]` links now dangle — cosmetic; recense recall supersedes them). DB untouched by the move; 199/199 still consolidated + scoped. Minor follow-up: the 2 trackers were imported as stale fact-snapshots — tombstone + add to importer skip-set (non-blocking).

SECURITY: `OPENAI_API_KEY` was exposed in a session transcript 2026-06-18 (printed by a grep) → ROTATE it (revoke at platform.openai.com, update `~/.config/recense/sleep.env`; ~9 `.bak-*` copies hold the old key — dead once revoked).

Next: decide retirement (run move OR formally defer + close Phase 24), then Phase 25 (Entity Dedup — node_scope live + FK fix already satisfy its only hard prereqs).

## Performance Metrics

**Velocity (historical baseline):**

- Total plans completed: 155 (v1.0: 42, v2.0: 14, v3.0: 42, v3.1: 8, v4.0: 22, quick-tasks: 19)
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

## Accumulated Context

### Roadmap Evolution

- Phase 28 added (2026-06-19): **Schema-Anchored Corpus** — pivots the reader corpus from project-scope docs to the abstraction graph rendered as prose (docs anchor on schemas/entities, cite direct facts; mass-gated promotion; hierarchy mirrors the `abstracts` ladder; decide-cheap/generate-lazy; read-only projection). **Supersedes Phase 27 READER-04** (doc_link-between-projects); inherits the reader UI + flat 2D renderer + lazy-gen + /doc routes + gather + doc-writer. Origin: design discussion during Phase 27 27-05 verification (see memory [[corpus-from-schemas-design]]).

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

Last session: 2026-06-20T14:21:09.625Z
Stopped at: Phase 30 context gathered
Resume file: None

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

- **Task 3 hero-verify:** Start `recense viz` on a copy of the live DB (`cp ~/.config/recense/recense.db /tmp/review.db && recense viz --db /tmp/review.db`), open `http://127.0.0.1:7810/?doc=tonos&reader=1`. The reader will show a loading state while `generate-doc tonos` runs in the background (or immediately serve a cached doc if one exists). Exercise: click a fact-ref → atom selected → toggle to Brain → brain focused on cited atoms → toggle back → selection intact. Type "approved" or describe the gap.
- **(User-authorized, non-blocking) Clean up + re-verify tonos doc:** Two stray test-artifact tonos doc nodes in live DB (`218260d4` len 8900, `97dc7e6a` len 0, both 0 cites) need FK-consistent delete. Then `recense generate-doc tonos --force --db ~/.config/recense/recense.db` (600s timeout, subscription billing).
- **Next after Task 3 approval: Plan 27-04** (doc corpus view, staleness diff, regen button).
