# Phase 44: Bundled-App Settings & Cost Controls - Context

**Gathered:** 2026-06-24
**Status:** Ready for planning

<domain>
## Phase Boundary

A user-facing **settings surface** (CLI + in-app panel) that lets a bundled-app user
control and see which *token-spending* sleep-pass features run — without re-architecting
the engine. The cost levers already exist as env/config; this phase builds the
**control** (toggle off what you don't value) + **transparency** (see what's spending)
layer over them.

**Scope locked by ROADMAP §"Phase 44":**
1. Presets — **Lite** (extract + reconsolidation), **Standard** (+ schema abstraction), **Full** (+ readable corpus docs).
2. Granular toggles for the cost-bearing levers (`RECENSE_CORPUS_GEN`, `RECENSE_CORPUS_GEN_MAX`, `consolSkipThreshold(/BySource/Assistant)`, `corpusSubjectDriftThreshold`, sleep frequency).
3. Token-usage readout — "this period you spent N tokens, M on readable docs."

**This phase = the FULL phase including tray UI** (user-chosen, not the 1-day CLI MVP).

**Load-bearing guardrail:** the core (extract + prediction-error reconsolidation) is
**non-optional** — toggling it off = not recense. The optional layer is corpus docs,
schema depth, viz, frequency.

**Architecture note (from ROADMAP, confirmed by scout):** the online hook is already
LLM-free — **100% of token cost lives in the offline sleep pass** — so this is a *switch
on the offline pass*, NOT a re-architecture. No `src/adapter/*settings*` exists yet; the
gap is purely a settings surface.

</domain>

<decisions>
## Implementation Decisions

### Scope & UI Layering
- **D-01:** Build the **full phase including tray UI** — presets + granular toggles + token-usage readout + in-app settings panel. (Not the 1-day CLI-only MVP.)
- **D-02:** The tray popover is a **zero-IPC thin shell** that loads the viz frontend at `http://127.0.0.1:7810` with an empty preload (D-102). Therefore the "tray settings UI" is a **settings panel inside the viz frontend** (`src/viz/`), NOT a native Electron settings window. Do **not** add a new Electron preload/IPC surface (would break D-102).
- **D-03:** **One persisted config file = single source of truth**, read/written by **three consumers**: (1) `recense config` CLI, (2) viz-server HTTP GET/POST settings routes, (3) viz frontend settings panel (calls the routes). The viz server already opens the DB and serves the frontend, so it's the natural backend for the panel.

### Settings Persistence
- **D-04:** Persisted config file = **new `~/.config/recense/settings.json`** (under the same `~/.config/recense/` dir as `recense.db` and `sleep.env`). Holds the chosen **preset name** plus an explicit **overrides map**. A small loader merges it over `DEFAULT_CONFIG` — this also **closes the existing gap** where config-object levers (`consolSkipThreshold` et al.) have no disk-override path today (they're only in `DEFAULT_CONFIG` in code).
- **D-05:** **Precedence = explicit env var > settings.json > `DEFAULT_CONFIG`.** This preserves the founder's current env-driven setup with **zero regression** (his `sleep.env`/`RECENSE_CORPUS_GEN` keep working and still win). Bundled users who set no env vars just get settings.json. Mirrors the existing `resolveDbPath` precedence pattern (`--flag > env > default`).
- **D-06:** `run-sleep-pass.ts` (and `ingest-project-cli.ts`) currently read `RECENSE_CORPUS_GEN` / `RECENSE_CORPUS_GEN_MAX` directly via `process.env`. These call sites must be refactored to consult the merged config (env-override-aware) instead of raw `process.env`, so settings.json actually takes effect while env still wins.
- **D-07:** **Sleep frequency** is stored in settings.json too, but it's a **derived artifact**: a `recense config apply` step (or the existing scheduler-reinstall path) **regenerates the launchd plist (macOS) / croner schedule** from the file. The settings UI writes the file then triggers apply. Frequency is the one lever not read at sleep-pass runtime.

### Token-Usage Readout
- **D-08:** Production token ledger = **new table in `recense.db`**. Wire `setHeadlessUsageSink()` into the **real sleep pass** to append one row per LLM call (timestamp, **feature/stage tag**, input/output tokens, est. cost). NOT the EVAL-04 harness (that runs on a throwaway VACUUM-INTO scratch DB and isn't wired to live spend).
- **D-09:** Readout breakdown = **by feature/lever** — extraction (Haiku), judging (Sonnet), corpus docs (Sonnet), schema abstraction. Each line maps to a toggle so the user sees what turning a feature off would save. This requires each ledger row to carry a **feature tag** — `setHeadlessUsageSink` must receive which stage/feature is making the call (the sink currently captures usage but needs feature context plumbed through).
- **D-10:** Readout window = **rolling 30 days (headline) + all-time/since-install total**. Ledger stores per-call timestamps so any window is a cheap query; 30d is the default view.

### Preset ↔ Toggle Semantics
- **D-11:** Model = **preset baseline + explicit overrides**. settings.json stores `{ preset: "standard", overrides: {...} }`. Effective config = preset defaults with overrides applied. Flipping a toggle records an override; UI shows e.g. "Standard (modified)". Reversible — clearing an override snaps back to the preset value.
- **D-12:** **Core guardrail = "not a toggle" AND loader-validated** (belt-and-suspenders). Extract + prediction-error reconsolidation has **no toggle** in UI/CLI (framed as "always on — this is recense"), AND the config loader **hard-rejects/ignores** any settings.json that attempts to disable it, so a hand-edited file can't gut the moat. Even the Lite preset keeps core on. Matches the engine's existing fail-safe-default posture.

### Claude's Discretion
- Exact `recense config` CLI subcommand shape (`get`/`set`/`show`/`apply`/`preset`) — planner/researcher to design, following the existing `recense <verb>` dispatch in `src/adapter/recense.ts`.
- Exact viz-server route paths and settings-panel placement within `src/viz/` — follow existing viz route/module patterns.
- Exact ledger table schema/columns and the retail-$ translation source (token→$ rate) — follow EVAL-04 framing (tokens primary, $ as translation).
- Whether onboarding defaults a bundled user to **Standard** (likely) — confirm during planning.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase spec & framing
- `.planning/ROADMAP.md` §"Phase 44: Bundled-App Settings & Cost Controls" — the authoritative scope, preset definitions, guardrail, and architecture note. The spec for this phase.
- `CLAUDE.md` §Constraints (sleep-pass model stack + subscription-token framing) — cost is measured in **tokens** (subscription-billed, marginal-$ ≈ 0 but token usage real), with retail-$ translation. The `claude -p --output-format json` envelope reports per-call `usage`/`total_cost_usd`.

### Cost levers — config (in-code today, need disk-override)
- `src/lib/config.ts:712` `DEFAULT_CONFIG` — the in-code default object CLIs build from (`{ ...DEFAULT_CONFIG, dbPath }`). No disk override exists today.
- `src/lib/config.ts:254,263,50` — `consolSkipThreshold` (0.2), `consolSkipThresholdAssistant` (0.5), `consolSkipThresholdBySource` levers.
- `src/lib/config.ts:557` — `corpusSubjectDriftThreshold` (3), overridable via `RECENSE_CORPUS_SUBJECT_DRIFT_THRESHOLD`.

### Cost levers — env-var-at-call-site (refactor targets for D-06)
- `src/consolidation/run-sleep-pass.ts:563-629` — reads `RECENSE_CORPUS_GEN` (skip-entirely) and `RECENSE_CORPUS_GEN_MAX` (25) via `process.env`; the corpus-gen step is the highest-cost optional feature (~42s Sonnet/doc).
- `src/adapter/ingest-project-cli.ts:769,795` — second site reading the same two env vars.

### Persistence & runtime-config (precedence pattern + config dir)
- `src/adapter/runtime-config.ts` — `defaultDbPath()`, `sleepEnvPath()`, `loadConfiguredEnv()` (chmod-600 KEY=VALUE `sleep.env` loader), `resolveDbPath()` precedence pattern (`--flag > env > default`) to mirror for settings precedence. settings.json lives in the same `~/.config/recense/` dir.

### Scheduler (frequency apply target — D-07)
- `src/adapter/recense-scheduler.ts` — croner (Linux in-process) / launchd (macOS plist) install path; `recense scheduler install` is what frequency-apply regenerates.

### Token-usage ledger plumbing (D-08/D-09)
- `setHeadlessUsageSink()` (in the headless client — `src/**/claude-headless-client.ts`) — opt-in per-call usage sink already capturing the `claude -p` JSON envelope `usage`; production unchanged when unset. Needs feature-tag context plumbed and a live persistence target.
- `scripts/eval/cost-benefit-harness.cjs` (EVAL-04, `npm run eval:cost-benefit`) — reference for token/cost framing and the WRITE-ledger sink usage. NOT the production readout source (scratch DB).

### Tray / viz frontend (UI panel — D-02/D-03)
- `apps/tray/src/popover.ts` — confirms zero-IPC thin shell over `http://127.0.0.1:7810`, empty preload (D-102). Settings panel is NOT a native window.
- `src/viz/server.ts` — viz HTTP server; add settings GET/POST routes + usage-readout route here.
- `src/viz/modules/` — frontend module pattern (e.g. `reader.js`, `corpus.js`) to mirror for a settings panel.
- `src/adapter/recense.ts:53-139` — CLI subcommand dispatch; add `config` case here.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`runtime-config.ts` precedence + config-dir helpers** — reuse `~/.config/recense/` location, `loadConfiguredEnv` env-merge mental model, and the `resolveDbPath` precedence shape for the settings loader (D-05).
- **`setHeadlessUsageSink()`** — usage-capture seam already production-safe (no-op when unset); just needs feature-tag + a live sink that writes the ledger table (D-08/D-09).
- **viz frontend module pattern** (`src/viz/modules/*.js`) + viz server routes — the settings panel reuses the existing thin-shell-over-:7810 architecture; no new IPC.
- **`recense <verb>` CLI dispatch** (`src/adapter/recense.ts`) — `config` slots in as a new case.
- **EVAL-04 cost-benefit harness** — token↔$ translation logic and feature/stage breakdown framing to mirror in the readout.

### Established Patterns
- **Fail-safe defaults / fail-closed** — adapters default off; the core-guardrail loader-validation (D-12) follows this posture (reject configs that disable the moat).
- **`--flag > env > default` precedence** (resolveDbPath) — directly mirrored by `env > settings.json > DEFAULT_CONFIG` (D-05).
- **`DEFAULT_CONFIG` spread** (`{ ...DEFAULT_CONFIG, dbPath }`) — the merge point where a settings.json loader inserts (D-04).
- **D-102 zero-IPC tray** — hard constraint: no new Electron IPC/preload surface (D-02).

### Integration Points
- **`run-sleep-pass.ts` env reads** → must consult merged config (D-06).
- **`DEFAULT_CONFIG` consumers** (every CLI building config) → must go through the new settings-aware loader so disk overrides take effect.
- **Sleep pass LLM call sites** → tagged usage sink writes ledger rows (D-08).
- **Scheduler install** → frequency-apply regen target (D-07).
- **viz server** → new settings + usage-readout HTTP routes (D-03).

</code_context>

<specifics>
## Specific Ideas

- Token readout phrasing modeled on ROADMAP: "this period you spent N tokens, M on readable docs" — "the contextscope instinct applied inward."
- Each readout line should map 1:1 to a toggle so cost↔control is legible (the explicit point of the phase).
- UI should surface preset divergence explicitly ("Standard (modified)") rather than silently flattening to Custom.

</specifics>

<deferred>
## Deferred Ideas

- **1-day CLI-only MVP** (just `RECENSE_CORPUS_GEN` + sleep frequency + salience threshold via `recense config`) — explicitly NOT chosen; user opted for the full phase. Recorded as the smaller alternative if the full phase needs to be split.
- **Migrate env vars → settings.json and drop env reading** — rejected this phase (breaking change to the founder's launchd/`sleep.env` workflow). Env stays authoritative (D-05). A future unification phase could revisit.
- **PAID longmemeval work-savings arm** in the readout (avoided-re-derivation savings, the bigger half) — out of scope; the readout here is spend-side only. Belongs with EVAL-04's `--with-longmemeval` arm.

[Discussion stayed within phase scope — no new capabilities added.]

</deferred>

---

*Phase: 44-bundled-app-settings-cost-controls*
*Context gathered: 2026-06-24*
