# Phase 44: Bundled-App Settings & Cost Controls - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-24
**Phase:** 44-bundled-app-settings-cost-controls
**Areas discussed:** Phase scope / MVP line, Settings persistence surface, Token-usage readout, Preset↔toggle semantics

---

## Phase scope / MVP line

### Q1 — Scope boundary for this phase

| Option | Description | Selected |
|--------|-------------|----------|
| Full phase, CLI-first | Presets + toggles + readout via `recense config` CLI; tray deferred | |
| CLI MVP only | 3 levers via `recense config`; no presets/readout; ~1 day | |
| Full phase + tray UI | Everything incl. Electron tray popover settings + in-app readout | ✓ |

**User's choice:** Full phase + tray UI.
**Notes:** Largest scope; couples to apps/tray. Scout then revealed the tray is a zero-IPC shell over the viz frontend, reframing "tray UI" as a viz-frontend panel.

### Q2 — UI/source-of-truth layering

| Option | Description | Selected |
|--------|-------------|----------|
| Shared config file, three readers | One on-disk file = SoT; CLI + viz-server routes + viz panel all read/write it; no new IPC (respects D-102) | ✓ |
| CLI-only writes, UI read-only | Panel display-only; all mutation via CLI | |
| Native tray settings window | New Electron window w/ own preload/IPC; breaks D-102 | |

**User's choice:** Shared config file, three readers.
**Notes:** Fits the existing thin-shell architecture; tray popover loads `:7810` with empty preload (D-102).

---

## Settings persistence surface

### Q1 — Persisted config file

| Option | Description | Selected |
|--------|-------------|----------|
| New settings.json | `~/.config/recense/settings.json`; loader merges over DEFAULT_CONFIG | ✓ |
| Extend sleep.env | Flat KEY=VALUE in existing chmod-600 file; mixes secrets+toggles | |
| SQLite settings table | Rows in recense.db; couples config to schema/migrations | |

**User's choice:** New settings.json.
**Notes:** Closes the consolSkipThreshold disk-override gap; one typed file owned by CLI + viz server.

### Q2 — Precedence vs existing env vars

| Option | Description | Selected |
|--------|-------------|----------|
| Env var wins (env > file) | process.env > settings.json > DEFAULT_CONFIG; zero founder regression | ✓ |
| settings.json wins (file > env) | File authoritative; would override founder's exported env | |
| Migrate env → file, drop env | One-time import then stop reading env; breaking change | |

**User's choice:** Env var wins (env > file).
**Notes:** Mirrors resolveDbPath precedence; founder's sleep.env keeps working.

### Q3 — Sleep frequency propagation

| Option | Description | Selected |
|--------|-------------|----------|
| settings.json + apply step | Stored in file; `config apply` regenerates launchd plist / croner | ✓ |
| Defer frequency this phase | Ship rest now; frequency later | |
| Frequency in plist only | UI shows read-only; user runs `scheduler install --every` | |

**User's choice:** settings.json + apply step.
**Notes:** Plist is a derived artifact; frequency is the one lever not read at sleep-pass runtime.

---

## Token-usage readout

### Q1 — Ledger persistence

| Option | Description | Selected |
|--------|-------------|----------|
| New table in recense.db | Sink appends a tagged row per LLM call; queryable, persistent | ✓ |
| Append-only JSONL log | usage.jsonl; decoupled but needs parse/aggregate + rotation | |
| Reuse EVAL-04 harness | Scratch-DB eval; not wired to live spend | |

**User's choice:** New table in recense.db.
**Notes:** viz server already opens the DB; survives across runs.

### Q2 — Breakdown granularity

| Option | Description | Selected |
|--------|-------------|----------|
| By feature/lever | extraction/judge/corpus-docs/schema — each maps to a toggle | ✓ |
| Total only | Single number; not actionable | |
| By model tier | Haiku vs Sonnet; doesn't map to toggles cleanly | |

**User's choice:** By feature/lever.
**Notes:** Requires each ledger row to carry a feature tag (plumb into setHeadlessUsageSink).

### Q3 — Time window

| Option | Description | Selected |
|--------|-------------|----------|
| Rolling 30 days + all-time | 30d headline + since-install total | ✓ |
| Since last reset | User-controlled reset counter | |
| Per sleep-pass + cumulative | Most granular per-run; noisier | |

**User's choice:** Rolling 30 days + all-time.
**Notes:** Per-call timestamps make any window a cheap query.

---

## Preset↔toggle semantics

### Q1 — Preset + individual toggle interaction

| Option | Description | Selected |
|--------|-------------|----------|
| Preset baseline + overrides | Store preset name + explicit overrides map; "Standard (modified)"; reversible | ✓ |
| Toggle drops to Custom | Any edit flattens to Custom; preset forgotten | |
| Presets only, no toggles | Contradicts ROADMAP granular-toggle scope | |

**User's choice:** Preset baseline + overrides.
**Notes:** Keeps preset intent legible and the diff visible.

### Q2 — Core guardrail enforcement

| Option | Description | Selected |
|--------|-------------|----------|
| Not a toggle + validated | No core toggle in UI/CLI AND loader hard-rejects disabling it | ✓ |
| UI-only omission | Just don't render toggle; trust no hand-edits | |
| Toggle with hard warning | Core toggle behind strong confirmation; invites accidental gutting | |

**User's choice:** Not a toggle + validated.
**Notes:** Belt-and-suspenders; even Lite keeps core on. Matches fail-safe-default posture.

---

## Claude's Discretion

- `recense config` subcommand shape (`get`/`set`/`show`/`apply`/`preset`).
- viz-server route paths + settings-panel placement within `src/viz/`.
- Ledger table schema/columns + retail-$ translation rate source.
- Whether onboarding defaults a bundled user to Standard.

## Deferred Ideas

- 1-day CLI-only MVP (not chosen; recorded as the split-down alternative).
- Migrate env → settings.json and drop env reading (rejected — founder-workflow breaking change).
- PAID longmemeval work-savings arm in the readout (out of scope; spend-side only).
