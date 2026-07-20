# Phase 30: Core Ingest Command - Context

**Gathered:** 2026-06-20
**Status:** Ready for planning

<domain>
## Phase Boundary

Ship `recense ingest-project <dir>` — a real CLI command that promotes the Phase-29 throwaway spike (`scripts/spike/survey-feeder.ts`) into production. An agent surveys an unexplored repo across the 5 calibrated areas, emits **summarized why-level observations** as episodes (scope-tagged, `origin=observed`, `source='project-survey'`), and the existing offline episodic→consolidation pipeline mints facts + schemas — enforcing the Phase-29 quality gate.

**In scope:** the `ingest-project` command surface, survey orchestration, the two carried calibration fixes (refusal/tool-failure handling + gotchas prompt tightening), scope tagging, live-brain write + `--dry-run` preview, and dirty-sentinel handoff to the scheduled sleep-pass (with a `--consolidate` inline opt-in).

**Out of scope (other phases — do NOT add here):**
- Direct project-doc ingest (README/docs/CLAUDE.md as episodes) → **Phase 31** (DOCING-01).
- Idempotent re-ingest / in-place belief reconciliation on re-run → **Phase 31** (REINGEST-01).
- Per-project cursor (only changed content re-surveyed) → **Phase 31** (REINGEST-02). `contentExternalId` is used now for episode dedup, but no cursor.
- Scoped project recall tuning + auto-promoted/-generated corpus docs → **Phase 32** (RECALL-01/02).

Requirements delivered: **INGEST-01, INGEST-02, INGEST-04** (INGEST-03 was satisfied by the Phase-29 spike).
</domain>

<decisions>
## Implementation Decisions

### Execution model
- **D-01: Foreground survey, deferred consolidation (default).** The command runs the 5-area survey in the foreground with live per-area progress (minutes), writes one episode per belief-line, marks the DB dirty (existing dirty-sentinel, see `resolveDirtySentinelPath`), and returns. The next scheduled hourly sleep-pass consolidates episodes → facts/schemas. This is the literal reading of SC1 ("ingestion runs offline") + SC2 ("after a sleep pass"). No long write-lock held across consolidation; no collision with the live hourly pass.
- **D-02: `--consolidate` inline opt-in.** A `--consolidate` flag runs the sleep-pass inline under the write lock after the survey (spike-parity path), so facts are recallable on return — for demos/dogfooding and fresh-ingest verification. This is opt-in, NOT the default. Reuses the spike's `runConsolidation` call.
- **D-03: Foreground, not detached.** Reject the background/detached model — keep inline per-area progress feedback; no process-management/logging surface.

### Live-brain safety
- **D-04: Default target = live brain.** The canonical live DB (`~/.config/recense/recense.db`) is the default write target — onboarding a project INTO customer-zero is the whole point. This **inverts** the spike's hard-refuse-live-brain guard (T-29-01); that guard must NOT be carried into the production command.
- **D-05: `--dry-run` preview.** A `--dry-run` flag runs the FULL survey but PRINTS the would-be episodes per area (count + sample lines) WITHOUT writing — sanity-check signal before committing to the live brain. Cheap insurance against polluting the append-only episodic store.
- **D-06: `--db <path>` scratch override.** Accept an explicit `--db` to target a scratch/staging DB (testing, eval). Reject the "survey-to-scratch then explicit --promote" two-step (cross-DB episode-copy machinery + WAL-copy gotcha is out of proportion for Phase 30; re-ingest reconciliation is Phase 31).

### Survey robustness (the two carried Phase-29 fixes)
- **D-07: Detect refusal/tool-failure → retry once → skip.** Pattern-match refusal / apology / tool-access-failure responses BEFORE ingest (e.g. "cannot access", "I'm sorry", "no genuine observations"). On match: retry that one area **once**; if it fails again, **skip** the area (ingest 0 episodes) and report it in the summary. Never ingest the apology text as a "fact." Other areas proceed unaffected. (Fixes the spike's `decisions` area = 0 genuine, a tool flake.)
- **D-08: Per-area prompt override; tighten gotchas.** Give `buildSurveyPrompt` a per-area framing hook: the 4 healthy areas keep the calibrated base prompt **verbatim** (D-08 from 29-CALIBRATION); `gotchas` gets an extra clause steering toward why-level non-obvious traps ("a senior dev's hard-won warnings, NOT a list of what files do"). The quality gate still backstops. (Fixes the spike's gotchas = 13/18 noise — fix is upstream at the prompt, per calibration.)

### Scope tagging
- **D-09: Derive from dir, `--scope` override.** Default scope = `cwdToScope(<dir>)` (basename) — reuse the locked 999.3 D-04 mechanic (episode `cwd=<dir>` → consolidation `resolveNodeScope` stamps `node_scope`). Add an optional `--scope <slug>` flag for repos at non-canonical paths (e.g. a clone at `/tmp/checkout`). **Print the resolved scope before writing** so it's never a surprise.
- **Carry-forward caveat:** schemas do NOT carry a `node_scope` row. Any per-project schema count MUST count `type='schema' AND tombstoned=0` WITHOUT the scope join (29-CALIBRATION Input 4) — else it falsely reports 0 schemas (relevant to SC3 verification).

### Repo description (survey grounding)
- **D-10: Auto-derive from README, `--desc` override.** Seed the prompt's one-line repo description from the first heading/paragraph of the target repo's `README.md`; fall back to the dir name if no README. A `--desc "..."` flag overrides. Keeps the command zero-config for the common case while allowing hand-tuning. (The spike's clean results partly came from grounding the agent with what the project IS — don't drop the description clause.)

### Claude's Discretion (technical — planner/researcher decides)
- **Command vs SourceAdapter shape.** Whether `ingest-project` is a standalone CLI (spike-style, direct `pipeline.recordEvent`) or a `SourceAdapter` plugged into `ingest-cli`'s pull→consolidate flow. The agentic survey is an active producer (unlike passive pull adapters), so the spike's standalone shape is the likely fit — but this is an architecture call for the planner. Either way it routes through `IngestionPipeline.recordEvent` and the existing consolidation.
- **How the survey agent gets filesystem access to `<dir>`.** The spike hardcoded `SURVEY_CWD` and told the agent to Read that path via `claude -p`. For an arbitrary `<dir>`, the agent needs Read/Grep/Glob scoped to it — research the headless client's cwd/working-dir handling (`createClaudeHeadlessClient` / `buildHeadlessArgs`). **Research flag — see Canonical References.**
- **Locked verbatim from spike (do NOT re-derive):** the base survey prompt (D-08 calibration), the 5 areas, `splitObservations` (25/area backstop), the D-07 judge gate prompt, `origin='observed'`, `source='project-survey'`, `externalId=contentExternalId(...)`, net-zero deps, the `claude -p` subscription-billed transport (with `--setting-sources project` to avoid self-ingestion + API-key strip).
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase-29 calibration (the locked inputs — read FIRST)
- `.planning/phases/29-survey-quality-spike/29-CALIBRATION.md` — the 4 calibration inputs carried verbatim into Phase 30: Input 1 (summarization prompt shape D-08), Input 2 (granularity / one-belief-per-line), Input 3 (quality-gate judge prompt D-07), Input 4 (scope-tagging convention D-04 + the schema-has-no-scope-row caveat + operational env gotchas). Also documents the two carried fixes (decisions retry-on-failure, gotchas prompt) and the founder GO sign-off.

### Spike code to promote (the reference implementation)
- `scripts/spike/survey-feeder.ts` — THROWAWAY spike to productionize. Carry: `buildSurveyPrompt`, `SURVEY_AREAS`, `splitObservations` (+ `MAX_OBS_PER_AREA=25`), the per-area feed loop, the `surveyArea` headless call. INVERT: `resolveScratchDbPath`'s hard-refuse-live-brain guard (D-04 here). Note the spike's run-env requirements (OPENAI_API_KEY, pinned node bin, tsx, lock path, provider envs).
- `scripts/spike/genuine-noise-judge.ts` — the judge harness; the gate prompt + lenient verdict parsing referenced by 29-CALIBRATION Input 3.

### Scope provenance infrastructure (already built — 999.3)
- `.planning/phases/999.3-scope-aware-provenance-memory-importer/999.3-CONTEXT.md` — locked scope decisions D-S1..D-S7: `scope` = provenance not tenancy, sidecar `node_scope` table (no `ALTER TABLE node`), derive-from-cwd at consolidation, importer reuses the pipeline. Phase 30 builds directly on this.
- `src/lib/scope.ts` — `cwdToScope` (used for D-09 scope derivation).
- `src/db/schema.ts` — `node_scope` sidecar DDL.
- `src/consolidation/run-sleep-pass.ts` — `runConsolidation` (inline `--consolidate` path) + `resolveNodeScope` (stamps scope from episode cwd).

### CLI + ingestion plumbing (patterns to match)
- `src/adapter/recense.ts` — the command dispatcher; add an `ingest-project` case (lazy-require, `spawnScript` pattern like `ingest`/`import-memory`). Update the usage string.
- `src/adapter/ingest-cli.ts` — closest existing CLI analog (pull→consolidate under one lock; arg-validate-before-acquireLock WR-02; file-only logging; dirty-sentinel).
- `src/adapter/import-memory-cli.ts` — the 999.3 importer; `recordEvent` with `cwd`/`source`/`external_id` for scope-tagged, idempotent ingestion (the D-S4 pattern this phase mirrors).
- `src/source/source-adapter.ts` — `contentExternalId` helper + `NormalizedRecord` contract (if the planner chooses the SourceAdapter shape).
- `src/ingest/pipeline.ts` — `IngestionPipeline` / `AllocationGate` / `recordEvent` (the write path; `cwd` capture).
- `src/model/claude-headless-client.ts` — `createClaudeHeadlessClient` / `buildHeadlessArgs` (subscription billing, `--setting-sources project`, API-key strip; **research the cwd/working-dir handling for arbitrary `<dir>` — Claude's Discretion above**).
- `src/adapter/runtime-config.ts` — `resolveDbPath`, `resolveDirtySentinelPath` (DB target + dirty-sentinel for deferred consolidation).
- `src/adapter/lockfile.ts` — `acquireLock`/`releaseLock` (only needed on the `--consolidate` inline path).

### ROADMAP / requirements
- `.planning/ROADMAP.md` §"Phase 30: Core Ingest Command" — goal + 4 success criteria.
- `.planning/REQUIREMENTS.md` — INGEST-01, INGEST-02, INGEST-04 wording.
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`scripts/spike/survey-feeder.ts`** — the entire survey loop is written and validated; Phase 30 is mostly promoting it from a throwaway script into `src/adapter/ingest-project-cli.ts` (or a SourceAdapter), inverting the live-brain guard and adding flags.
- **999.3 scope infra** — `node_scope` sidecar + `cwdToScope` + `resolveNodeScope` already mint scope-tagged facts from episode cwd. Phase 30 just feeds episodes with the right `cwd`.
- **Dirty-sentinel + scheduled sleep-pass** — the deferred-consolidation path (D-01) is the existing `ingest-cli`/launchd mechanism; mark dirty, let the hourly pass run.
- **`createClaudeHeadlessClient`** — net-zero-deps subscription-billed transport with self-ingestion + API-key guards already in place.

### Established Patterns
- **Lazy-require dispatcher** (`recense.ts` D-87): add the `ingest-project` case with `spawnScript`, no top-level import.
- **Arg-validate-before-acquireLock** (WR-02): only relevant on the `--consolidate` inline path.
- **File-only logging for launchd paths**, but `ingest-project` is operator-invoked interactively → stdout progress is appropriate (unlike the hourly job). Match `recall`/`snapshot` operator-command ergonomics.
- **`contentExternalId(relPath, content)`** dedups byte-identical episodes (INSERT OR IGNORE) — gives free within-run idempotency; full re-ingest reconciliation is Phase 31.

### Integration Points
- `recense.ts` dispatcher (new command + usage string).
- `IngestionPipeline.recordEvent` (episode write).
- Dirty-sentinel → scheduled `runConsolidation` (deferred default) OR inline `runConsolidation` (`--consolidate`).
- `node_scope` via consolidation (scope attribution, recall `[scope]` prefix).
</code_context>

<specifics>
## Specific Ideas

- **"Returns promptly" reconciled:** the founder read SC1's "returns promptly (ingestion runs offline)" as: the SURVEY runs in the foreground (it's the visible work), but CONSOLIDATION is deferred offline to the scheduled pass — so the command doesn't block on the slow fact-minting. `--consolidate` is the escape hatch for immediate facts.
- **Print-before-write ergonomics:** resolved scope (D-09) and `--dry-run` previews (D-05) both surface what WILL happen before touching the live brain — founder caution about polluting customer-zero is the throughline across D-04/D-05/D-09.
- **Verbatim-vs-tuned prompt split (D-08):** keep the 4 calibrated areas byte-identical to 29-CALIBRATION; only `gotchas` deviates. Preserves the measured 82%-genuine result while fixing the one noisy area.
</specifics>

<deferred>
## Deferred Ideas

- **Survey-to-scratch staging DB + explicit `--promote`** — stronger isolation than `--dry-run`, but needs cross-DB episode-copy (WAL-copy gotcha) and overlaps Phase-31 reconciliation. Revisit only if `--dry-run` proves insufficient.
- **Background/detached survey execution** — truly-instant return; deferred in favor of foreground progress (D-03). Reconsider if surveys grow long enough that blocking the terminal is painful.
- **Per-project cursor / incremental re-survey** — explicitly **Phase 31** (REINGEST-02).
- **Direct doc ingest (README/docs/CLAUDE.md as episodes)** — explicitly **Phase 31** (DOCING-01). Phase 30 only READS the README to seed the survey description (D-10), it does not ingest docs as episodes.
- **Soft current-cwd recall boost / per-area recall reporting** — recall-side tuning; 999.3 D-S6 defers the cwd boost; per-area reporting (join node→consolidation_event→episode→session_id) is optional and downstream.

</deferred>

---

*Phase: 30-core-ingest-command*
*Context gathered: 2026-06-20*
