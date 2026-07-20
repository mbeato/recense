---
phase: 53-brain-layout-at-scale-declutter-deliberate-clustering
plan: 03
status: complete
completed: 2026-06-30
autonomous: false
requirements: [D-09]
---

# 53-03 Summary — Layout guards + founder visual checkpoint (D-09)

## What was built

- **`tests/viz-layout-guards.test.ts`** (commit `b022bc7`, extended in `72cf9d0`/`02a09f9`/`25b03ac`): machine-checkable regression guards for the locked anchors (`BRAIN_SCALE=460`, `revealSettled()` fade+pin body, `nodeRadius` magnitudes), the seed/settle invariants (`setTimeout(revealSettled, SETTLE_BUDGET_MS)`, no `cooldownTicks(12)`, no `Math.random` in the seed path), and — added during the checkpoint loop — the **continuous Halton placement primitive** in both `seedNodePositions/placeInHull` and `buildHazeLayer`.
- **Full viz suite green + dist rebuilt**: 94/94 viz tests pass (Phase 52 honest-traces + Phase 53 layout/determinism/cap/Halton guards). `npm run build` lands the edited modules in `dist/src/viz/modules`, which the packed `recense` binary (`/opt/homebrew/bin/recense` → repo `dist`) serves.
- **Founder visual checkpoint (Task 3): APPROVED** at ~15.4k live nodes. No constant tuning requested — `SETTLE_BUDGET_MS=250` and `OVERVIEW_NODE_CAP=3000` retained at their plan defaults.

## Major deviation — the gridlines were NOT in the planned code path

The plan (53-01/53-PATTERNS) assumed `seedNodePositions` was the sole node-placement path. The founder checkpoint surfaced that the gridlines persisted. Root-cause investigation (systematic-debugging) found two layered defects, fixed as gap commits directly on `main`:

1. **`buildHazeLayer` was never de-latticed** (`72cf9d0`). The bulk haze cloud (most of a 15k brain) is rendered as a separate `InstancedMesh` with its own scatter — still voxel-centre + ±4u jitter. 53-01 only touched the few hundred schema/member force-graph nodes, so the dominant lattice was untouched.
2. **Voxel-grid sampling is the wrong primitive** (`02a09f9`, then `25b03ac`). De-latticing by jittering within voxel cells still inherits the grid's periodicity (H/V gridlines became diagonal). Replaced the position *generator* in both `placeInHull` and `buildHazeLayer` with a **Halton low-discrepancy sequence + `brainOccupied` rejection** — the voxel grid is now used only as the inside/outside test. A first Halton attempt indexed by `(i+1)*48` re-banded (48 = 2⁴·3 collapses the base-2/3 digits — proven numerically: x in 1/16 bins); the final fix walks the sequence with a **contiguous `{v}` counter** (16/16 bins; smooth per-axis histograms on an ellipsoid hull; founder-approved render).

All fixes preserve determinism (D-08, no `Math.random`, counter starts fixed + fixed placement order) and the locked Phase-52 reveal path.

## Key files

- created: `tests/viz-layout-guards.test.ts`
- modified (gap fixes): `src/viz/modules/graph.js` (`halton()`, `sampleInHull()` contiguous-counter sampler; `placeInHull` + `buildHazeLayer` rewired to it)
- constants: `src/viz/modules/constants.js` — untouched at checkpoint (no tuning requested)

## Verification

- `npm test -- tests/viz-layout-guards.test.ts` green; full named viz suite 94/94 green; `npm run build` succeeds.
- Founder visual checkpoint approved at ~15.4k: gridlines gone (SC1), fullness acceptable for exploration (SC2), clustering reads (SC3), reload-stable (D-08), Phase-52 flashes intact.
- Operational note: the viz server (`recense viz --no-open`, :7810) was restarted during the loop after the prior process exited; packed app serves the fixed `dist`.

## Self-Check: PASSED
