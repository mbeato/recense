---
phase: 61-corpus-chrome-index-column-project-browsing
plan: 12
subsystem: viz-corpus-index
tags: [gap-closure, GAP-8, index-sidebar, legibility]
requires:
  - "61-08: GAP-4 schema nesting under projects in /index (resolvedRootParent)"
provides:
  - "/index labels are always human-readable — humanTitle() guarantees a UUID slug never leaks (H1 title or 'Untitled note' fallback)"
  - "Nested-schema section renders under the founder-confirmed label 'Notes'"
affects:
  - "61-14: founder verification checkpoint sees legible schema rows (no descriptor line requested — nothing deferred)"
tech-stack:
  added: []
  patterns:
    - "Server-side title derivation as pure string work over already-selected columns (no new SQL/DB/dep)"
key-files:
  created: []
  modified:
    - src/viz/server.ts
    - tests/viz-index-route.test.ts
    - src/viz/modules/index.js
decisions:
  - "GAP-8 section label = 'Notes' — founder CONFIRMED the shipped default at the Task 3 checkpoint (alternatives concept-notes/one-off-docs/documents declined)"
  - "No one-line descriptor under the heading — founder declined; nothing deferred to 61-14 on this front"
  - "Title derivation order: non-UUID row.label → doc first markdown H1 → 'Untitled note' (never a UUID, never empty)"
metrics:
  duration: "~10 min (plus checkpoint wait)"
  completed: "2026-07-14"
---

# Phase 61 Plan 12: GAP-8 Schema Legibility (Human Titles + Notes Label) Summary

/index now derives human-readable titles server-side (UUID slugs replaced by the doc's H1, never leaked) and the nested-schema section renders under the founder-confirmed "Notes" label.

## What Was Built

**Task 1 — humanTitle() in /index (server.ts):** The `/index` handler's Entry labels previously came straight from the `COALESCE(NULLIF(sch.value,''), nd.slug)` column — when a schema-anchored doc's backing schema node had no value, the label fell back to `nd.slug`, which for those docs IS the schema UUID (T-61-22 information disclosure). A pure helper `humanTitle(row)` now guarantees a never-UUID label:

1. Non-empty, non-UUID `row.label` → returned unchanged (project labels and named schemas unaffected).
2. Else the doc body's first markdown H1 (`/^\s*#\s+(.+?)\s*$/m`) — e.g. `# Orphan Schema Doc` → `Orphan Schema Doc`.
3. Else the human generic `'Untitled note'`.

Applied to both the projects and schemas partitions at Entry construction. No new SQL statement, no new `Database`, no new dependency — `row.value` was already selected by `stmtDocNodes`. The `byLabel` sort is unchanged and now orders by the always-non-empty human title.

**Task 2 — "Notes" section label (index.js):** The schema-section display heading changed from the literal `'Schemas'` to `'Notes'` in `renderTreeSection('Notes', lastData.schemas || [], vS)`. Only the display string changed — the payload/data key stays `schemas`, `vS`/`anyS` untouched. Module doc comment updated to describe the section as "schema-anchored one-off docs (each derived from an induced concept), nested under their related project when resolvable (GAP-4/GAP-8)". No CSS change (61-14 owns styles.css).

**Task 3 — founder decision (checkpoint):** Founder CONFIRMED the shipped default label **"Notes"** and DECLINED the optional one-line descriptor under the heading. No code change resulted; nothing deferred to 61-14 from this checkpoint.

## Test Changes

- `tests/viz-index-route.test.ts`: the missing-schema-node case renamed to "derives a human-readable title (doc H1) when the backing schema node is missing — never leaks a UUID"; asserts `label === 'Orphan Schema Doc'` and that the label does NOT match the UUID regex. The named-schema positive case (`SCHEMA_LABEL_1`) is unchanged and still green. Header + fixture comments updated to the new contract.

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run tests/viz-index-route.test.ts` — 20/20 passed.
- `npx vitest run tests/viz-frontend-static.test.ts` — 52/52 passed.
- Source assertions: `humanTitle` present in server.ts; `renderTreeSection('Notes'` present and `renderTreeSection('Schemas'` absent in index.js.
- Behavioral verification (schema rows read as legible one-off docs at a glance) deferred to the 61-14 founder checkpoint per plan.

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

None — no new security-relevant surface. T-61-22 (UUID label leak) and T-61-23 (title-derivation tampering) mitigated as registered: never-UUID label guaranteed by humanTitle + regression test; derivation is pure read-only string work on already-selected columns.

## Commits

- `dc2b36e` feat(61-12): derive human-readable /index titles so a UUID never leaks as a label
- `e137b2b` feat(61-12): default the nested-schema section label to Notes (GAP-8)

## Self-Check: PASSED

All modified files exist on disk; commits dc2b36e and e137b2b verified in git log; working tree clean.
