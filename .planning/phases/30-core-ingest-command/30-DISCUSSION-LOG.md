# Phase 30: Core Ingest Command - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-20
**Phase:** 30-core-ingest-command
**Areas discussed:** Execution model, Live-brain safety, Survey robustness, Scope tagging, Repo description

---

## Execution model

| Option | Description | Selected |
|--------|-------------|----------|
| Foreground survey, defer consolidation | Survey runs foreground w/ progress, writes episodes, marks dirty, returns; scheduled sleep-pass consolidates. Matches SC1/SC2 literally. | ✓ |
| Inline survey + consolidate (spike parity) | Survey + runConsolidation in one process under one held lock; facts ready on return; holds global lock ~minutes, can collide with hourly pass | |
| Detach to background, return instantly | Spawn detached survey; truly prompt but adds process-mgmt surface + no inline feedback | |

**User's choice:** Foreground survey, defer consolidation.

### Follow-up — inline opt-in

| Option | Description | Selected |
|--------|-------------|----------|
| Add `--consolidate` opt-in flag | Default defers; `--consolidate` runs sleep-pass inline for immediate facts (demos/dogfood/verify) | ✓ |
| Strictly defer, no inline option | Episodes-only always; one code path; must wait for scheduled pass to see facts | |

**User's choice:** Add `--consolidate` opt-in flag.

---

## Live-brain safety

| Option | Description | Selected |
|--------|-------------|----------|
| `--dry-run` preview, default write-to-live | Default = live brain; `--dry-run` runs full survey, prints would-be episodes, no write; `--db` scratch override | ✓ |
| Survey-to-scratch, then explicit promote | Staging DB first; separate `--promote` copies into live; strongest isolation but two-step + cross-DB copy machinery | |
| Direct write, no preview | Straight to live brain; simplest; relies fully on the gate; bad run pollutes append-only episodic store | |

**User's choice:** `--dry-run` preview, default write-to-live.
**Notes:** Founder caution about polluting customer-zero is the throughline — print-before-write across dry-run + resolved-scope.

---

## Survey robustness

### Refusal / tool-failure handling

| Option | Description | Selected |
|--------|-------------|----------|
| Detect, retry once, then skip the area | Pattern-match refusal/apology/tool-failure before ingest; retry once; else skip + report; never ingest apology text | ✓ |
| Detect and skip immediately (no retry) | Same detection, no retry; cheaper but a transient flake loses the area | |
| Detect and hard-fail the whole run | Any bad area aborts the run; safest vs partial data but wasteful | |

**User's choice:** Detect, retry once, then skip the area.

### Gotchas noise fix

| Option | Description | Selected |
|--------|-------------|----------|
| Per-area prompt overrides; tighten gotchas | Base prompt verbatim for 4 healthy areas; gotchas gets an extra why-level clause; gate still backstops | ✓ |
| Keep one shared prompt, lean on the gate | No special-casing; trust the gate to reject noise; simpler but wasted survey/judge tokens | |

**User's choice:** Per-area prompt overrides; tighten gotchas.

---

## Scope tagging

| Option | Description | Selected |
|--------|-------------|----------|
| Derive from dir, `--scope` override | scope = cwdToScope(<dir>); `--scope` flag for non-canonical paths; print resolved scope before writing | ✓ |
| Derive from dir only, no override | Always basename; simplest; mis-tags repos at non-canonical paths with no recourse | |

**User's choice:** Derive from dir, `--scope` override.

---

## Repo description

| Option | Description | Selected |
|--------|-------------|----------|
| Auto-derive from README, `--desc` override | Seed description from README first heading/para; fall back to dir name; `--desc` overrides | ✓ |
| Require `--desc` flag | Most accurate but friction every run; breaks 'point at unexplored repo' ergonomics | |
| Omit the description entirely | Agent infers everything; simplest but risks vaguer surveys (spike's clean results partly came from grounding) | |
| Done — ready for context | Leave to research/planner | |

**User's choice:** Auto-derive from README, `--desc` override.

---

## Claude's Discretion

- **Command vs SourceAdapter architecture** — standalone CLI (spike-style) vs SourceAdapter plugged into ingest-cli. Planner's call; spike's standalone shape is the likely fit given the agentic active-producer nature.
- **Survey agent filesystem access for arbitrary `<dir>`** — how `createClaudeHeadlessClient` sets the agent's working dir / Read-Grep-Glob scope. Flagged for research.
- Everything locked verbatim from the spike + 29-CALIBRATION (base prompt, 5 areas, splitObservations, judge gate, record contract, transport).

## Deferred Ideas

- Survey-to-scratch staging + explicit `--promote` (stronger isolation; revisit if `--dry-run` insufficient).
- Background/detached execution (reconsider if surveys grow long).
- Per-project cursor / incremental re-survey → Phase 31 (REINGEST-02).
- Direct doc ingest as episodes → Phase 31 (DOCING-01).
- Soft cwd recall boost / per-area recall reporting → downstream (999.3 D-S6 defers).
