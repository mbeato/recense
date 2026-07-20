# Phase 30: Core Ingest Command - Research

**Researched:** 2026-06-20
**Domain:** CLI command promotion + headless-agent filesystem tool access (code-local)
**Confidence:** HIGH (every claim traced to live source + a live `claude -p` probe)

## Summary

Phase 30 is a narrow promotion of `scripts/spike/survey-feeder.ts` into a real `recense ingest-project <dir>` command. Almost everything is locked in CONTEXT.md (D-01→D-10). Research focused on the five unresolved seams. The single load-bearing finding overturns an assumption in both the spike header and the CONTEXT: **the committed `buildHeadlessArgs` passes `--tools none`, which I verified disables ALL tools (a live `claude -p` probe returns `NO_TOOLS`). The survey agent in the spike could not have read `/Users/vtx/usage` through the committed transport.** Yet the Phase-29 calibration log shows the agent DID read the real repo (real 90s glob/read turns, a per-area "tool-access flake" on `decisions`). The only reconciliation is that the spike's measured run did NOT use the committed code path verbatim, or used a manually-different invocation. **The planner must treat headless tool-access as genuinely NEW work, not a carry-forward.**

I verified the exact working flag set against the live `claude` binary. The minimal, correct mechanism for arbitrary-dir read access is: spawn with `cwd: <dir>` **and** pass `--tools Read Grep Glob --add-dir <dir> --permission-mode bypassPermissions`. This must be a NEW, opt-in code path in the headless client (a second arg-builder / options param) — the existing judge/extractor path MUST keep `--tools none` + `cwd: os.tmpdir()` unchanged.

The other four seams are low-risk: recordEvent contract is confirmed (the spike already uses it correctly), the dirty-sentinel "mark dirty and return" path is FREE (EpisodicStore.append touches the sentinel automatically when `config.dirtySentinelPath` is set), and most spike run-env landmines (lock path, node-bin, tsx) disappear when the command is dispatched through `recense.ts spawnScript` with hydrated env.

**Primary recommendation:** Add a NEW opt-in survey mode to the headless client (`createClaudeHeadlessSurveyClient` or an options arg to `createClaudeHeadlessClient`) that enables Read/Grep/Glob scoped to `<dir>` via `cwd:<dir>` + `--add-dir <dir>` + `--permission-mode bypassPermissions`, while preserving `--setting-sources project` and the API-key strip. Promote the spike as a standalone `src/adapter/ingest-project-cli.ts` (mirroring import-memory-cli), inverting the live-brain guard.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| `ingest-project <dir>` command surface, flag parsing | Adapter (CLI) | — | Operator-invoked; mirrors import-memory-cli, lives in `src/adapter/` (agents live OUTSIDE engine per CLAUDE.md) |
| Survey-agent filesystem access (Read/Grep/Glob over `<dir>`) | Model transport (`claude-headless-client`) | — | The cwd/tool-access scope is a property of the `claude -p` spawn; the engine never reads `<dir>` itself |
| Episode write (one per belief-line, scope-tagged) | Engine (`IngestionPipeline.recordEvent`) | DB (`EpisodicStore.append`) | Existing pipeline; CLI only supplies fields |
| Scope attribution `[scope]` | Engine (consolidation `resolveNodeScope`) | — | Derived from episode `cwd` at consolidation — no CLI work beyond setting `cwd` correctly |
| Deferred consolidation handoff (default, D-01) | DB (sentinel touch) → launchd | — | `append()` touches the sentinel; the scheduled pass picks it up. CLI does nothing extra |
| Inline consolidation (`--consolidate`, D-02) | Engine (`runConsolidation`) under lock | Adapter (lock acquire) | Spike-parity path; reuse verbatim |

---

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| INGEST-01 | `recense ingest-project <dir>` surveys repo, emits summarized observations as episodes through existing pipeline | Survey loop carried from spike; **NEW** headless tool-access mechanism (PRIMARY seam) makes the agent actually read `<dir>`; `recordEvent` write path confirmed |
| INGEST-02 | Ingested knowledge scope-tagged (node_scope) so recall/corpus attribute under `[scope]` | `cwd=<dir>` on each `recordEvent` → consolidation `resolveNodeScope(cwdToScope(cwd))` stamps `node_scope` (`src/lib/scope.ts`, verified in spike: `/Users/vtx/usage` → `usage`) |
| INGEST-04 | Runs through OFFLINE episodic→consolidation path (origin=observed); never blocks online; yields facts+schemas | `origin:'observed'`; default path = append (sentinel touch) + return, consolidation deferred to scheduled pass; `--consolidate` inline opt-in via `runConsolidation` |

---

## [PRIMARY] Seam 1: Headless cwd / arbitrary-dir tool access

### The mechanism in the committed client (verified, live source)

`src/model/claude-headless-client.ts`:
- **`buildHeadlessArgs` (line 105–116)** hardcodes `--tools none` plus `--setting-sources project`, `--strict-mcp-config`, `--exclude-dynamic-system-prompt-sections`. No `cwd`, no `--add-dir`, no `--permission-mode`.
- **spawn options (line 153–159)** hardcode `cwd: os.tmpdir()`.
- The model is selected per-call; the working dir and tool set are NOT parameterizable.

### Live verification (load-bearing — I probed the real `claude` binary)

| Probe | Flags | Result |
|-------|-------|--------|
| Committed args | `--tools none --add-dir /Users/vtx/usage` + ask to list files | `result: "NO_TOOLS"` — `--tools none` disables tools even with `--add-dir` `[VERIFIED: claude -p probe]` |
| Working set | `--tools Read Grep Glob --add-dir <dir> --permission-mode bypassPermissions` | Real glob results, 4 turns, `permission_denials: []` `[VERIFIED]` |
| `--add-dir` without bypass | `--tools Read Grep Glob --add-dir <dir>` (default permission mode) | Real reads succeeded, no denials — `--add-dir` grants read access to read-only tools without bypass `[VERIFIED]` |
| cwd-based, no `--add-dir` | spawn `cwd:<dir>` + `--tools Read Grep Glob --permission-mode bypassPermissions` | Real reads of cwd succeeded `[VERIFIED]` |

`claude --help` confirms: `--tools` "Use `""` to disable all tools, `default` to use all tools"; `--add-dir <directories...>` "Additional directories to allow tool access to"; `--permission-mode` choices include `bypassPermissions`, `default`, `acceptEdits`, `auto`. `[VERIFIED: claude --help]`

### THE CONTRADICTION the planner must know about

The spike (`survey-feeder.ts`) imports `createClaudeHeadlessClient` verbatim (line 53, 133) — i.e. the committed `--tools none` / tmpdir path. With that path, the agent gets `NO_TOOLS` and **cannot** read `/Users/vtx/usage`. But `29-CALIBRATION.md` and `/tmp/recense-survey-spike.log` show genuine reads happened: architecture took ~98s, returned 45 genuine repo-specific facts; the `decisions` area was a documented "tool-access flake" (16s, returned an apology "Read, Grep, and Glob tools cannot access /Users/vtx/usage"). That apology message is itself proof the agent HAD tools wired (it tried and one call flaked) — inconsistent with a flat `--tools none`.

**Reconciliation (state as open question, do not guess the cause):** the measured Phase-29 results came from a run that did NOT use the committed `buildHeadlessArgs` (e.g. a local uncommitted edit during the spike, or a different binary/config). The committed code as it stands today CANNOT reproduce those results. `[VERIFIED: code + probe disagree with calibration log]`

→ **Planner implication:** the headless tool-access change is genuinely new work and is on the critical path for INGEST-01 / SC2. Do NOT plan it as "carry the spike's transport verbatim." Phase 30 should re-validate ≥5 genuine facts/area on the REAL committed-transport path (the calibration's 82% number was measured on an unverified path).

### Exact change required

Add an **opt-in survey path** to the headless client — do NOT mutate the existing judge/extractor path. Two viable shapes:

1. **New options param on `createClaudeHeadlessClient(config, opts?)`** where `opts = { surveyDir?: string }`. When `surveyDir` is set: build args via a survey variant and set spawn `cwd: surveyDir`.
2. **New factory `createClaudeHeadlessSurveyClient(config, surveyDir)`** that reuses the spawn body but with survey args + `cwd: surveyDir`. (Cleaner separation; the survey is the only tool-using caller.)

Survey arg set (replace only the tool/dir/permission flags; keep the rest):
```
'-p', '--output-format', 'json',
'--model', model,
'--system-prompt', <survey system prompt — NOT the JSON-only NEUTRAL_SYSTEM>,
'--setting-sources', 'project',          // KEEP — self-ingestion-hook guard (load-bearing)
'--strict-mcp-config',                    // KEEP
'--exclude-dynamic-system-prompt-sections',
'--tools', 'Read', 'Grep', 'Glob',        // CHANGED from 'none' — read-only, no Bash/Write/Edit
'--add-dir', surveyDir,                    // NEW — scope tool access to <dir>
'--permission-mode', 'bypassPermissions', // NEW — non-interactive; no stdin to approve prompts
```
Spawn: `cwd: surveyDir` (NEW for this path) instead of `os.tmpdir()`. Keep the **API-key strip** (`delete childEnv['ANTHROPIC_API_KEY']` / `ANTHROPIC_AUTH_TOKEN`) verbatim — it is independent of cwd/tools and still bills the subscription. `[VERIFIED: claude-headless-client.ts:145-148]`

**Guards that must be preserved (verified load-bearing):**
- `--setting-sources project` — drops the global `UserPromptSubmit` turn-capture hook so the survey's own `claude -p` calls are NOT re-ingested (self-ingestion loop). This is GLOBAL/cwd-independent, so running with `cwd:<dir>` does NOT reintroduce the loop. `[VERIFIED: claude-headless-client.ts:91-99]`
- API-key strip — keeps billing on the Max subscription. `[VERIFIED: lines 14-16, 145-148]`

**Caveats for the planner:**
- The survey path needs a **non-empty system prompt** that permits tool use — `NEUTRAL_SYSTEM` ("no tool use") would suppress tools. Either pass a survey-specific system prompt or pass `--tools default`-style and rely on the user prompt. Recommend an explicit survey system prompt.
- The survey path needs the **multi-turn `result`** (4 turns observed), not a single message. The existing `messageContentToText`/`parseVerdict` shape returns `.result` which already aggregates the final answer — confirmed the probe's `.result` carried the synthesized observations. `[VERIFIED: probe]`
- Running with `cwd:<dir>` means the agent sees the TARGET repo's `CLAUDE.md`/hooks IF `--setting-sources` allowed them — but it's pinned to `project` and the target repo's project settings would load. For brain-memory's own repo this could re-trigger its Stop-hook; for arbitrary external repos it loads their project settings. **Open question for planner:** is loading the target repo's project settings desirable (it gives the agent the repo's own CLAUDE.md context — arguably good for survey grounding) or a risk (a malicious repo's hooks)? Safest: keep `--setting-sources project` but document that the target repo's project hooks will load; if that's unacceptable, use `cwd: os.tmpdir()` + `--add-dir <dir>` instead (probe Test B confirms `--add-dir` alone grants read access without cwd). **`--add-dir` + tmpdir cwd is the more defensive choice** and avoids loading the target's hooks entirely.

→ **Recommendation:** use `cwd: os.tmpdir()` (neutral, no target-repo hooks) + `--add-dir <dir>` + `--tools Read Grep Glob` + `--permission-mode bypassPermissions`. Test B proved this reads the dir successfully with zero denials and preserves the existing tmpdir isolation property. This is strictly safer than cwd:<dir> and still satisfies arbitrary-dir access.

---

## Seam 2: Spike-promotion shape — standalone CLI vs SourceAdapter

**Recommendation: standalone `src/adapter/ingest-project-cli.ts`, mirroring `import-memory-cli.ts`.** HIGH confidence.

Evidence:
- **The survey agent is an ACTIVE producer**, not a pull adapter. `SourceAdapter.pull()` returns `{ records, commitCursor }` and is built from config-listed `enabledSources` with per-account cursors (`ingest-cli.ts:99-200`). None of that fits a one-shot operator-invoked agentic survey of an arbitrary dir — there is no cursor (deferred to Phase 31 REINGEST-02), no `enabledSources` entry, no per-account loop.
- **`import-memory-cli.ts` is the exact precedent** the CONTEXT names (D-S4 pattern): operator-invoked, builds its own `IngestionPipeline`, calls `recordEvent` directly with `source`/`cwd`/`externalId`, `--dry-run` prints a plan and writes nothing, arg-validate-before-acquireLock, `require.main === module` guard so it's dispatched via `recense.ts spawnScript`. The spike is already written in this exact shape.
- The SourceAdapter route would force the survey into `ingest-cli`'s pull→consolidate-under-one-lock flow, which holds the write lock across consolidation — the OPPOSITE of D-01's "no long write-lock across consolidation."

Either shape routes through `IngestionPipeline.recordEvent` and existing consolidation (CONTEXT requirement met either way), but standalone is the lower-friction, precedent-backed fit.

**Dispatcher wiring** (`recense.ts`): add `case 'ingest-project': spawnScript('ingest-project-cli.js', process.argv.slice(3)); break;` (the `slice(3)` form, NOT `rest`, so `<dir>` positional + flags pass through — see the H-1 note at lines 79-83). Add `ingest-project` to the usage string at line 122. `[VERIFIED: recense.ts:85-91, 122]`

---

## Seam 3: recordEvent contract for scope-tagged survey episodes

The spike already uses the correct shape (`survey-feeder.ts:261-269`); confirmed against `RecordEventParams` (`pipeline.ts:27-50`) and `EpisodicStore.append` (`episode-store.ts:191-230`):

```ts
pipeline.recordEvent({
  content,                                       // one belief-line
  role: 'user',
  origin: 'observed',                            // D-04: NEVER asserted_by_user / inferred
  sessionId: `project-survey:${scope}:${area}`,  // per-area session id (enables per-area mapping)
  source: 'project-survey',                      // locked source tag
  externalId: contentExternalId(`${scope}/${area}`, content), // relPath#sha256[:16]
  cwd: '<dir>',                                  // LOAD-BEARING: drives node_scope at consolidation
});
```

**Gotchas confirmed:**
- **`cwd` → scope flow:** consolidation runs `resolveNodeScope(cwdToScope(cwd))` and writes the `node_scope` sidecar (`src/lib/scope.ts`). `cwdToScope` only trusts paths directly under `/Users|/home/<user>/` (`HOME_PROJECT_RE`); anything else → `'global'`. So a clone at `/tmp/checkout` would scope to `global` — **this is exactly why D-09's `--scope <slug>` override exists.** The CLI must let `--scope` substitute the scope, but note: scope is derived at CONSOLIDATION from episode `cwd`, not stored on the episode as a scope column. To honor `--scope`, the cleanest path is to set `cwd` to a synthetic home-rooted path OR (cleaner) thread an explicit scope. **Open question for planner:** `--scope` cannot simply override `cwdToScope` post-hoc because scope is computed downstream from `cwd`. Options: (a) set `cwd` to `/Users/<user>/<scope>` synthetic, (b) add a scope-override seam to consolidation. Inspect `resolveNodeScope`'s call site before committing — this is the one place D-09 is more than a flag.
- **`origin: 'observed'`** — NOT `'inferred'`. `append()` skips the dirty-sentinel touch for `inferred` episodes (`episode-store.ts:224`); `observed` correctly touches it. Also satisfies "never let inferred output strengthen a fact" (CLAUDE.md).
- **`contentExternalId(relPath, content)`** = `` `${relPath}#${sha256(content).slice(0,16)}` `` (`source-adapter.ts:57-59`). Gives byte-identical within-run dedup via the `(source, external_id)` INSERT-OR-IGNORE backstop (`episode-store.ts:217`). Full re-ingest reconciliation is Phase 31.
- **session_id per area** enables the optional per-area reporting join (node→consolidation_event→episode→session_id), deferred per CONTEXT.

---

## Seam 4: Deferred-consolidation handoff (D-01) + inline `--consolidate` (D-02)

**Default path (D-01) "mark dirty and return" is essentially FREE.** Confirmed: `EpisodicStore.append()` calls `touchDirtySentinel()` on every real new insert when `config.dirtySentinelPath` is set (`episode-store.ts:221-226`). The sentinel write is the launchd `WatchPaths` trigger; the next scheduled pass consolidates. The CLI's ONLY responsibility is to build config with `dirtySentinelPath: resolveDirtySentinelPath()` — exactly as `ingest-cli.ts:249` does. No explicit "mark dirty" call, no lock held. `[VERIFIED: episode-store.ts:155-181, 221-226; runtime-config.ts:106-108]`

- `resolveDirtySentinelPath()` returns `RECENSE_DIRTY_SENTINEL` from env or `''` (disabled). The dispatcher's `hydrateRuntimeEnv()` populates it from `sleep.env`, so a dispatched `recense ingest-project` inherits it automatically. `[VERIFIED: runtime-config.ts:32, 106-108; recense.ts:32]`
- **WR-02:** validate `<dir>` exists + DB path + (if `--consolidate`) before `acquireLock`. The default path needs NO lock at all (just appends).

**Inline path (D-02 `--consolidate`):** reuse the spike's pattern verbatim (`survey-feeder.ts:229-282`):
1. validate args (WR-02), then `acquireLock()` (fast-fails, no queue — `lockfile.ts`),
2. survey + feed episodes,
3. `await runConsolidation(db, dbPath, process.env, log)` under the held lock,
4. `db.close()` then `releaseLock()` in `finally` (close-first ordering, `ingest-cli.ts:289-294`).

Provider overlay for headless consolidation: `resolveProviderOverlay(process.env, 'RECENSE_JUDGE_PROVIDER')` (`run-sleep-pass.ts:192`), applied as in `survey-feeder.ts:244`. Note the global write lock is ONE lock for all write ops — the `--consolidate` run will collide with a live hourly pass and fast-fail; default deferred path avoids this entirely. `[VERIFIED: MEMORY recense-global-write-lock + lockfile.ts]`

---

## Seam 5: Run-env landmines — which survive promotion, which are spike artifacts

The spike header lists five run-env requirements. Classifying each for the dispatched command (`recense ingest-project` → `recense.ts spawnScript` runs the compiled `.js` under `process.execPath`, after `pinNodeRuntime` + `hydrateRuntimeEnv`):

| Spike requirement | Status when dispatched | Reason |
|-------------------|------------------------|--------|
| `RECENSE_NODE_BIN` / pinned node (ABI) | **DISAPPEARS** | `recense.ts:26` calls `pinNodeRuntime` which re-execs under the correct node before any better-sqlite3 load. The dispatcher already solves the ABI gotcha for all subcommands. `[VERIFIED: recense.ts:21-26]` |
| `tsx` (ts-node alternative) | **DISAPPEARS** | The spike runs `.ts` via tsx; the command runs the COMPILED `.js` via `spawnScript`. No tsx. `[VERIFIED: recense.ts:43-48]` |
| `RECENSE_LOCK_PATH=/tmp/...` | **DISAPPEARS as a requirement** | Spike needed it to avoid the live brain's lock while running against scratch. The default (D-01) path holds NO lock. `--consolidate` uses the real live lock intentionally (it IS writing the live brain). The scratch-isolation lock-path was a spike-only concern. |
| `RECENSE_EXTRACTOR_PROVIDER` / `RECENSE_JUDGE_PROVIDER` = claude-headless | **REMAINS (env-config), inherited** | Consolidation provider is read from env via `resolveProviderOverlay`. The live `sleep.env` already sets these for the production stack; `hydrateRuntimeEnv` inherits them. Only matters on the `--consolidate` path; the deferred path's consolidation runs under the scheduled job which already has them. **The survey AGENT itself** uses `createClaudeHeadlessClient` directly (judge-tier config), so it always uses headless regardless. `[VERIFIED: survey-feeder.ts:133, 244]` |
| `OPENAI_API_KEY` (embedder) | **REMAINS — real requirement, only on consolidation paths** | Consolidation embeds via OpenAI; absent → every episode "skipped" + false "complete" (a documented masked failure). The deferred path does NOT consolidate, so the default command does NOT need it. The `--consolidate` path DOES. The dispatched command inherits it from `sleep.env` via `hydrateRuntimeEnv`. **Recommendation:** keep the spike's pre-flight `OPENAI_API_KEY` check, but gate it on `--consolidate` only (the default path doesn't embed). `[VERIFIED: survey-feeder.ts:222-225; MEMORY recense-manual-run-env-masked-failures]` |
| `RECENSE_CLAUDE_HEADLESS_TIMEOUT_MS` | **REMAINS — set in code** | Survey calls take ~90-100s/area (real tool use); the 120s default is tight. Spike raises it to 600s if unset (`survey-feeder.ts:235-237`). Carry this — survey is slower than a judge call. `[VERIFIED: survey-feeder.ts:234-237]` |

**Net:** the command must (1) carry the headless timeout bump, (2) check `OPENAI_API_KEY` only when `--consolidate` is passed. The ABI/tsx/lock-path landmines vanish through the dispatcher. Do NOT over-document the vanished ones in the command.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Filesystem tool access for the agent | A custom file-reader fed into the prompt | `claude -p --tools Read Grep Glob --add-dir <dir>` | The agent decides what to read; net-zero deps; proven in probe |
| `claude -p` argv | Manual argv construction in the CLI | The headless client's arg-builder (extended for survey) | The self-ingestion + billing guards are load-bearing and easy to drop |
| Dirty-sentinel "mark dirty" | A manual `writeFileSync(sentinel)` | `EpisodicStore.append`'s automatic `touchDirtySentinel` (set `config.dirtySentinelPath`) | Already correct, swallows errors, skips inferred |
| Scope tagging | Re-deriving slug in the CLI | Set `cwd` on `recordEvent`; consolidation derives via `resolveNodeScope` | Single source of truth (999.3) |
| Episode dedup | A custom seen-set | `contentExternalId` + `(source, external_id)` INSERT-OR-IGNORE | Free idempotency |

---

## Common Pitfalls

### Pitfall 1: Carrying `--tools none` into the survey path
**What goes wrong:** the agent returns `NO_TOOLS` / hallucinated observations with no real repo grounding.
**How to avoid:** the survey path MUST use `--tools Read Grep Glob --add-dir <dir>`; verified via live probe.
**Warning sign:** survey area returns in <20s (no real tool turns) or facts are generic/not repo-specific.

### Pitfall 2: Trusting the Phase-29 82%-genuine number for the committed path
**What goes wrong:** the calibration was measured on a path that the committed transport cannot reproduce (it has `--tools none`). Planning verification against 82% as a regression baseline is unsound.
**How to avoid:** re-measure ≥5 genuine/area on the REAL committed survey transport in Phase 30 (SC2 verification).

### Pitfall 3: `--scope` treated as a trivial flag
**What goes wrong:** scope is derived downstream from `cwd` at consolidation; setting a `--scope` flag without threading it to `resolveNodeScope` (or synthesizing `cwd`) silently does nothing for non-home-rooted dirs (e.g. `/tmp/checkout` → `global`).
**How to avoid:** inspect the `resolveNodeScope` call site; either synthesize a home-rooted `cwd` or add a scope-override seam. See Seam 3 open question.

### Pitfall 4: Inheriting the target repo's project hooks via `cwd:<dir>`
**What goes wrong:** spawning with `cwd:<dir>` + `--setting-sources project` loads the TARGET repo's project hooks/CLAUDE.md — for brain-memory's own repo this could re-trigger its Stop-hook.
**How to avoid:** prefer `cwd: os.tmpdir()` + `--add-dir <dir>` (probe Test B confirms read access works) — keeps the neutral-cwd isolation and loads no target hooks.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `claude` binary (print mode) | Survey agent transport | ✓ | responds to `claude -p` (probed live) | — (net-zero deps; the whole transport) |
| `--add-dir`, `--tools`, `--permission-mode` flags | Arbitrary-dir tool access | ✓ | present in installed `claude` (verified `--help`) | — |
| OpenAI embedder (`OPENAI_API_KEY`) | `--consolidate` path only | ✓ (in sleep.env) | — | Deferred path doesn't embed; default command works without it |
| better-sqlite3 native ABI | Episode write | ✓ | dispatcher pins node via `pinNodeRuntime` | — |

**Missing dependencies with no fallback:** none for the default path. The `--consolidate` path requires `OPENAI_API_KEY` (inherited from sleep.env).

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Spike header claims the agent reads via `claude -p` with the committed transport | Committed transport has `--tools none` → no reads; survey needs a NEW tool-enabled path | This research (2026-06-20) | Tool-access is new critical-path work, not a carry-forward |
| Survey grounded by hardcoded `SURVEY_CWD` | `<dir>` param + `--add-dir <dir>` / `cwd` | Phase 30 | Works for any operator-supplied dir |

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The Phase-29 82%-genuine results came from a non-committed code path (local edit / different invocation), since the committed `--tools none` returns NO_TOOLS | PRIMARY | If the committed path somehow DID read (it cannot per probe), the new transport work would be redundant — but the probe is definitive, so risk is low |
| A2 | `--add-dir <dir>` + neutral tmpdir cwd is preferable to `cwd:<dir>` for isolation | PRIMARY / Pitfall 4 | If a survey needs the target repo's CLAUDE.md as grounding, tmpdir-cwd loses it; mitigated by D-10 README-derived description already grounding the agent |

---

## Open Questions

1. **Why did the spike's measured run get real tool access despite the committed `--tools none`?**
   - Known: committed args disable tools (probe); calibration log shows real reads.
   - Unclear: the exact invocation that produced the 82% result.
   - Recommendation: don't depend on the spike's numbers; re-validate SC2 on the committed Phase-30 path.

2. **How does `--scope <slug>` (D-09) thread to `resolveNodeScope` for non-home-rooted dirs?**
   - Known: scope is derived from `cwd` at consolidation, not stored on the episode.
   - Recommendation: planner inspects `resolveNodeScope`'s call site; choose synthetic-cwd vs a scope-override seam. This is the only D-09 element that is more than a flag-parse.

3. **`--setting-sources project` with `cwd:<dir>` vs `cwd:tmpdir` + `--add-dir` — which isolation posture?**
   - Recommendation: tmpdir + `--add-dir` (Test B verified) for maximum isolation; document the choice.

---

## Sources

### Primary (HIGH confidence)
- `src/model/claude-headless-client.ts` — `buildHeadlessArgs` (`--tools none`, line 105-116), spawn `cwd: os.tmpdir()` (line 153-159), API-key strip (145-148), `--setting-sources project` rationale (91-99)
- Live `claude -p` probes (2026-06-20) — `--tools none` → `NO_TOOLS`; `--tools Read Grep Glob --add-dir <dir>` → real reads, 0 denials
- `claude --help` — `--add-dir`, `--tools` (`""`=disable, `default`=all), `--permission-mode` choices
- `scripts/spike/survey-feeder.ts` — survey loop, `recordEvent` shape, run-env header
- `src/ingest/pipeline.ts` (RecordEventParams 27-50), `src/db/episode-store.ts` (append + sentinel touch 155-230)
- `src/lib/scope.ts` (`cwdToScope`, `resolveNodeScope`), `src/source/source-adapter.ts` (`contentExternalId` 57-59)
- `src/adapter/recense.ts` (dispatch pattern 43-48, 85-91, 122), `src/adapter/import-memory-cli.ts` (the precedent), `src/adapter/ingest-cli.ts` (consolidate-under-lock, dirtySentinel config 249)
- `src/adapter/runtime-config.ts` (`resolveDirtySentinelPath` 106-108, `hydrateRuntimeEnv` 140-149)
- `29-CALIBRATION.md`, `/tmp/recense-survey-spike.log` — per-area genuine counts, the `decisions` tool-flake evidence

### Secondary (MEDIUM confidence)
- MEMORY index: recense-global-write-lock, recense-manual-run-env-masked-failures, recense-db-path-canonical

## Metadata

**Confidence breakdown:**
- Headless tool-access mechanism: HIGH — verified by live `claude -p` probe (4 configurations tested)
- Spike-promotion shape: HIGH — import-memory-cli is a direct, named precedent
- recordEvent / scope / sentinel: HIGH — read live source end to end
- `--scope` downstream threading: MEDIUM — flagged as an open question (didn't read the resolveNodeScope call site fully)
- Run-env classification: HIGH — traced through the dispatcher

**Research date:** 2026-06-20
**Valid until:** 2026-07-04 (stable code-local; the `claude` CLI flag surface is the only fast-moving input)

## RESEARCH COMPLETE
