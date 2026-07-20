# 25-03 SUMMARY — Live dedup run + DEDUP-03 verification

**Plan:** 25-03 (wave 3, autonomous: false — founder-gated live mutation)
**Status:** COMPLETE — DEDUP-03 PASS
**Date:** 2026-06-18

## What was done

Ran the validated `recense dedup-entities` pass against the **live production brain**
(`~/.config/recense/recense.db`) after a founder go-ahead and a machine-reviewed dry-run.

1. **Pre-pass baseline** captured (entity counts, recall sample, FK status) + consistent DB backup
   at `~/.config/recense/recense.db.bak-pre-dedup-260618`.
2. **Dry-run reviewed** — 121 clusters / 150 duplicates, all genuine same-entity (cosine 0.90–1.00,
   the only sub-0.95 ones pure case-variants). No wrong merges; the 150+ file-path/slug entities
   sharing the "brain-memory" substring were correctly left distinct.
3. **Real merge** (`--no-dry-run`, 0.88): 121 clusters merged, 150 nodes tombstoned. Live entities
   3193 → 3043.
4. **Verified** repeatability (2nd run = 0), FK-clean, tombstone-not-delete, 150 `entity_merge`
   provenance events, no recall regression.

## DEDUP-03 result

PASS — exact/case-variant duplicate entities collapsed to single canonicals, FK-clean, repeatable,
recall-stable. Full evidence in `25-03-DEDUP-VERIFICATION.md`.

## Deviation from plan (must read)

The plan's headline metric ("brain-memory 8+ → 1" via `LIKE '%brain-memory%'`) was an **artifact** —
the live LIKE count is 162, dominated by legitimately-distinct file paths and memory-slugs. The
precision-first engine correctly did NOT collapse those. Real outcome = graph-wide exact/case-variant
duplicate collapse (150 dups → 121 canonicals). Verification artifact documents this correction; founder
sign-off line left for explicit confirmation of the reframing.

## Files

- `.planning/phases/25-entity-dedup-prune/25-03-DEDUP-VERIFICATION.md` (the deliverable)
- No source changes (this plan only ran the already-shipped engine/CLI against live data).
- DB backup: `~/.config/recense/recense.db.bak-pre-dedup-260618`
