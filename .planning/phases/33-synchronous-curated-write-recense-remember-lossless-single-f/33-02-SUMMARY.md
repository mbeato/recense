---
phase: 33-synchronous-curated-write-recense-remember-lossless-single-f
plan: 02
subsystem: infra
tags: [migration, claude-code, settings, native-memory, cutover]

# Dependency graph
requires:
  - phase: 33-01
    provides: "recense remember verbatim curated write path (the only write used by the migration)"
provides:
  - "D-06 global directive in ~/.claude/CLAUDE.md routing all deliberate memory to recense remember"
  - "D-07 native-memory kill-switch applied globally (autoMemoryEnabled:false)"
  - "REMEMBER-03 cutover: 14 native .md memory files migrated verbatim into the live brain and archived"
affects: [customer-zero memory; all future sessions write deliberate facts via recense remember]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "founder-gated live-state migration (autonomous:false) — read-only investigation + scripted per-file write→verify→archive behind an explicit approval gate"
    - "deterministic value_hash live-node-exists verify gate (non-cosine) before any irreversible archive"

key-files:
  created:
    - .planning/phases/33-.../33-SETTINGS-FINDING.md (D-07 investigation result)
    - .planning/phases/33-.../33-MIGRATION.md (per-file write→verify→archive evidence)
    - ~/.claude/projects/-Users-vtx-brain-memory/memory/.migrated/ (14 archived originals)
  modified:
    - ~/.claude/CLAUDE.md (additive D-06 directive section)
    - ~/.claude/settings.json (autoMemoryEnabled:false)
    - src/adapter/remember-cli.ts (-- end-of-options fix, committed 8902ddf)
    - tests/remember-cli.test.ts (dash-fact regression tests)

key-decisions:
  - "D-07: a GENUINE kill-switch exists — autoMemoryEnabled:false in settings.json (any scope), equivalently CLAUDE_CODE_DISABLE_AUTO_MEMORY=1. Verified against official docs (code.claude.com/docs/en/memory). Applied at user scope (global) per founder approval; no speculative deny-hook built."
  - "Founder approved (2026-06-20): apply directive + run full 14-file live migration; global kill-switch scope."
  - "MEMORY.md flat index is retired (D-09) — it was inserted+verified then naturally superseded in place when the last granular file's reconcile judged the index as a contradicting neighbor; content preserved in the 13 granular nodes + archive."

patterns-established:
  - "Live-state cutover runs inline (not in a worktree subagent): worktree isolation is useless when mutations target ~/.claude and the live DB, and the blocking-human gate needs the founder directly"
  - "Migration verify gate is value_hash live-node-exists, never recense recall (cosine-gated, unreliable as a delete gate)"

requirements-completed: [REMEMBER-03]

# Metrics
duration: 35min
completed: 2026-06-20
---

# Phase 33-02: Native-memory cutover Summary

**Claude Code's native auto-memory is retired for customer-zero: a global directive + a verified `autoMemoryEnabled:false` switch route all deliberate memory to `recense remember`, and the 14 existing `.md` memory files were migrated verbatim into the live brain (value_hash-verified) and archived.**

## Performance

- **Duration:** ~35 min (incl. one engine bug fix + 3 resumable migration passes)
- **Tasks:** 3/3 (Task 2 was the founder approval gate — approved)
- **Files migrated:** 14 (13 notes + MEMORY.md)

## Accomplishments

- **Task 1 — directive + kill-switch investigation (D-06/D-07):**
  - Appended an additive "## Memory — use recense, not native .md memory" section to `~/.claude/CLAUDE.md` (all prior sections intact). Routes deliberate memory to `recense remember`, forbids native `.md` memory, notes recall fires at SessionStart.
  - D-07 finding (verified vs official docs): `autoMemoryEnabled:false` is a real settings.json switch (equivalently `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`). Applied globally in `~/.claude/settings.json` (JSON re-validated). Recorded in `33-SETTINGS-FINDING.md`. No deny-hook built (not needed).
- **Task 2 — founder gate:** presented the directive text, the kill-switch finding, and the migration plan (14 files, scope `brain-memory`, live DB, write→verify→archive). Founder approved "apply all" + global kill-switch.
- **Task 3 — one-time migration:** each file fed verbatim through `recense remember --scope brain-memory --db ~/.config/recense/recense.db`, deterministically verified by `value_hash` live-node-exists, then moved to `.migrated/`. Result: 14/14 migrated & archived, 0 remaining in root, 0 hard-deletes. 10 unrelated-insert, 3 contradict-reconcile-in-place, 1 (MEMORY.md) insert-then-superseded-in-place. Full per-file evidence in `33-MIGRATION.md`.

## Deviations / fixes

- **Engine bug found & fixed (committed `8902ddf`):** `remember-cli`'s arg parser dropped any fact starting with `-` (markdown frontmatter `---`, list items) as a flag → the first frontmatter-led file silently failed to store. Added `--` end-of-options handling + 3 regression tests; migration switched to `recense remember … -- "<content>"`. Backward compatible. Full suite green (1914 passed).
- **Migration-script false-positive:** lock-held detection initially matched the literal text "lock held" echoed from a fact's *content* (the `recense-global-write-lock` note). Scoped detection to stderr; the node had actually stored fine and archived on the next pass.
- **MEMORY.md supersession:** not a failure — the flat index is the artifact D-09 retires; it was verified-live at archive time and later reconsolidated in place. Granular content lives in the 13 notes + the archive.
- **Execution mode:** ran inline (not a worktree subagent) because all mutations target `~/.claude` + the live DB (worktree isolation buys nothing) and the blocking-human gate needs the founder directly.

## Verification

- `~/.claude/CLAUDE.md` contains the `recense remember` directive; prior headings (Hard rules, Git, Terminal output, Voice Profile) all intact.
- `~/.claude/settings.json` valid JSON with `autoMemoryEnabled:false`; hooks/model/plugins intact.
- `33-SETTINGS-FINDING.md` and `33-MIGRATION.md` written with the D-07 result and per-file evidence.
- 0 `.md` files remain in the memory dir root; 14 archived in `.migrated/`; 0 hard-deletes.
- Every migrated file's content is a value_hash-matched node in the live DB at archive time (MEMORY.md subsequently superseded — documented).
