# Phase 53: Brain Layout at Scale (declutter + deliberate clustering) - Pattern Map

**Mapped:** 2026-06-30
**Files analyzed:** 3 existing files, 5 modification sites
**Analogs found:** 5 / 5 (all within-file — edits are in-place; best analog is always the surrounding code)

---

## File Classification

| Modification Site | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `graph.js:171-221` `seedNodePositions()` | utility — geometry seeding | transform | `graph.js:316-346` haze deterministic scatter | exact (same voxel→world pipeline, different randomness source) |
| `graph.js:594-614` settle/reveal block | utility — animation timing | event-driven | `graph.js:594-614` itself; `setTimeout(revealSettled,200)` idiom | exact (stop-condition only changes; reveal path unchanged) |
| `graph.js:231-235` `_hashIndex()` | utility — deterministic hash | transform | `graph.js:322-328` haze `_hashIndex` usage | exact (function already exists; usage pattern extends to seeding) |
| `constants.js:194-226` density band | config — named constants | N/A (static) | `constants.js:184-191` `BRAIN_SCALE` / `CONTAIN_STRENGTH` block | role-match (same JSDoc+export const pattern) |
| `lod.js:88-125` overview count / density | service — LOD adaptation | transform | `lod.js:104-117` `DENSITY_FILL` "largest schemas first" block | exact (D-06 cap extends this block directly) |

---

## Pattern Assignments

### `graph.js:171-221` — `seedNodePositions()` (utility, transform)

**Analog:** `graph.js:316-346` — haze deterministic position assignment inside `buildHazeLayer()`

This is the closest analog: same occupied-voxel list, same `applyMatrix4(rotMat).multiplyScalar(BRAIN_SCALE)` transform, same jitter magnitude (±4 units). D-04 rewrites the seeding to use continuous in-hull sampling + cluster centroid bias instead of random voxel pick; D-08 uses `_hashIndex` for determinism. The haze block shows the exact pattern to follow.

**Current code being replaced** (`graph.js:211-221`):
```javascript
  const v = new THREE.Vector3();
  for (const n of allNodes) {
    const [lx, ly, lz] = occupied[(Math.random() * occupied.length) | 0];
    v.set(lx, ly, lz)
     .applyMatrix4(rotMat)
     .multiplyScalar(BRAIN_SCALE);
    // Small jitter so co-located voxels diverge
    n.x = v.x + (Math.random() - 0.5) * 4;
    n.y = v.y + (Math.random() - 0.5) * 4;
    n.z = v.z + (Math.random() - 0.5) * 4;
  }
```

**Analog to copy from** (`graph.js:316-347`) — haze deterministic scatter:
```javascript
    if (occupied && rotMat) {
      // Pick a voxel deterministically by hashing the node index
      const [lx, ly, lz] = occupied[_hashIndex(i, occupied.length)];
      tmpV.set(lx, ly, lz).applyMatrix4(rotMat).multiplyScalar(BRAIN_SCALE);
      // Small deterministic jitter: use hash of (i+voxelIdx) to avoid pile-up
      // at voxel centres. Scale: ±4 units (same as seedNodePositions).
      const jx = ((_hashIndex(i * 3 + 0, 1000) / 1000) - 0.5) * 8;
      const jy = ((_hashIndex(i * 3 + 1, 1000) / 1000) - 0.5) * 8;
      const jz = ((_hashIndex(i * 3 + 2, 1000) / 1000) - 0.5) * 8;
      dummy.position.set(tmpV.x + jx, tmpV.y + jy, tmpV.z + jz);
      node.x = dummy.position.x;
      node.y = dummy.position.y;
      node.z = dummy.position.z;
    }
```

**Hull occupancy test reused** (`graph.js:156-164`) — `brainOccupied()` validates continuous samples land inside hull:
```javascript
function brainOccupied(brainVol, qx, qy, qz) {
  const R = brainVol.res;
  const ix = ((qx + 1) * 0.5 * R) | 0;
  const iy = ((qy + 1) * 0.5 * R) | 0;
  const iz = ((qz + 1) * 0.5 * R) | 0;
  if (ix < 0 || iy < 0 || iz < 0 || ix >= R || iy >= R || iz >= R) return false;
  const i = (iz * R + iy) * R + ix;
  return !!((brainVol.bits[i >> 3] >> (i & 7)) & 1);
}
```

**Cluster centroid data available** — `lod.js` already classifies nodes with `n.__cat`, `n.__schemaId`, `n.__members` and builds `schemaMembers: Map<schemaId, Set<memberId>>`. `seedNodePositions()` receives `allNodes` after `initLod(ctx)` runs, so `n.__cat` and `n.__schemaId` are readable. Schema hub nodes (`n.__cat === 'schema'`) can be used as centroid anchors for their members.

**Occupied voxel list** (`graph.js:193-207`) — already built inside `seedNodePositions`, reuse it directly:
```javascript
  const occupied = [];
  for (let iz = 0; iz < R; iz++) {
    for (let iy = 0; iy < R; iy++) {
      for (let ix = 0; ix < R; ix++) {
        const idx = (iz * R + iy) * R + ix;
        if (!((bits[idx >> 3] >> (idx & 7)) & 1)) continue;
        occupied.push([
          (ix / R) * 2 - 1,
          (iy / R) * 2 - 1,
          (iz / R) * 2 - 1,
        ]);
      }
    }
  }
```

**Signature stays the same** — `seedNodePositions(allNodes, brainVol)` — no API change. The fallback branch (`graph.js:172-183`) for null brainVol stays unchanged.

---

### `graph.js:594-614` — settle/reveal block (utility, event-driven)

**Analog:** The block itself. D-03 changes only the stop condition; everything else is preserved verbatim.

**Current code** (`graph.js:594-614`):
```javascript
  // ── Settle-then-pin reveal ────────────────────────────────────────────
  // The canvas starts hidden (opacity 0). Once the simulation cools (or
  // 200 ms elapses — primary path since onEngineStop is unreliable/slow),
  // pin every node's fx/fy/fz at its settled position then fade in.
  Graph.cooldownTicks(12);
  const graphEl = document.getElementById('graph');
  graphEl.style.opacity = '0'; // hidden — no transition yet

  let _settled = false;
  function revealSettled() {
    if (_settled) return;
    _settled = true;
    for (const n of allNodes) {
      if (n.x != null) { n.fx = n.x; n.fy = n.y; n.fz = n.z; }
    }
    graphEl.style.transition = 'opacity 0.35s ease'; // fade IN only, never out
    graphEl.style.opacity    = '1';
  }

  Graph.onEngineStop(revealSettled);
  setTimeout(revealSettled, 200); // primary path (onEngineStop is unreliable/slow)
```

**What changes (D-03):** Replace `Graph.cooldownTicks(12)` with a wall-clock budget approach. The `revealSettled()` function body (lines 603-611) and the `setTimeout(revealSettled, 200)` idiom (line 614) are preserved intact.

**What the new stop condition looks like (pattern to implement):**
- Remove `Graph.cooldownTicks(12)`.
- Replace with `Graph.cooldownTicks(0)` (run freely) or a high tick ceiling so the sim doesn't self-stop.
- Set `setTimeout(revealSettled, SETTLE_BUDGET_MS)` as the primary stop — when the budget elapses, call `revealSettled()` which pins and fades in.
- `Graph.onEngineStop(revealSettled)` remains as the fallback.
- `SETTLE_BUDGET_MS` is a new named constant in `constants.js` (planner sets initial value, tuned at founder checkpoint).

**Locked:** `revealSettled()` body must not change (D-07). The hidden-then-fade sequence (`opacity 0` → `transition 0.35s ease` → `opacity 1`) is Phase 52 territory and must not regress.

---

### `graph.js:231-235` — `_hashIndex()` deterministic hash (utility, transform)

**This function is NOT modified.** It is reused by the new seeding logic (D-08).

**Function** (`graph.js:231-235`):
```javascript
function _hashIndex(idx, mod) {
  // 32-bit Knuth multiplicative hash; keep low bits for the range
  const h = (Math.imul(idx + 1, 0x9e3779b9) >>> 0);
  return h % mod;
}
```

**Usage pattern from haze layer** (`graph.js:322-328`) — copy this calling convention for node seeding:
```javascript
      const [lx, ly, lz] = occupied[_hashIndex(i, occupied.length)];
      // ...
      const jx = ((_hashIndex(i * 3 + 0, 1000) / 1000) - 0.5) * 8;
      const jy = ((_hashIndex(i * 3 + 1, 1000) / 1000) - 0.5) * 8;
      const jz = ((_hashIndex(i * 3 + 2, 1000) / 1000) - 0.5) * 8;
```

**Key:** Feed `i` as the per-node index (enumerate allNodes with an index counter). For cluster-centroid bias, a stable per-node integer derived from `n.id` (e.g., `n.id.charCodeAt(0)`) can also drive `_hashIndex` — the exact derivation is planner's discretion (D-08 says "hash-based").

---

### `constants.js:194-226` — adaptive-density band (config, static)

**Analog:** `constants.js:184-191` and the existing density-band block itself. New constants follow identical JSDoc + `export const` pattern.

**Existing constants pattern** (`constants.js:184-226`):
```javascript
export const BRAIN_SCALE = 460;                 // LOCKED — never touch

export const CONTAIN_STRENGTH = 0.35;

export const DENSITY_FILL_BELOW = 600;
export const DENSITY_FILL_TARGET = 600;
export const DENSITY_THIN_START  = 3200;
export const DENSITY_THIN_FULL   = 6000;
export const HAZE_DENSE_SCALE    = 0.35;
```

**New constants to add (two groups):**

Group 1 — settle budget (D-03):
```javascript
/** Wall-clock ms the force settle runs before pinning nodes and fading in.
 *  Replaces cooldownTicks(12); bounded regardless of node count. Tune at
 *  founder visual checkpoint. */
export const SETTLE_BUDGET_MS = 200; // initial value; tune at checkpoint
```

Group 2 — overview cap (D-05/D-06):
```javascript
/** Max overview nodes shown (schema + haze) regardless of corpus size.
 *  Holds screen fullness in the founder-calibrated band at 15k+ nodes.
 *  Members and long-tail haze are suppressed beyond this cap (drill-in
 *  or trace still reveals them). Set around the calibrated 2,700–3,200
 *  band; exact value is planner's discretion, tuned at checkpoint. */
export const OVERVIEW_NODE_CAP = 3000; // initial value; tune at checkpoint
```

**Rule:** `BRAIN_SCALE = 460` and `nodeRadius()` stay LOCKED. New constants act only on counts and timing, never on absolute sizing.

---

### `lod.js:88-125` — overview count / density adaptation (service, transform)

**Analog:** `lod.js:104-117` — the existing `DENSITY_FILL` "largest schemas first" block. D-05/D-06 extend this block with an overview cap.

**Current code** (`lod.js:101-126`):
```javascript
  let overviewCount = 0;
  for (const n of allNodes) if (n.__cat === 'schema' || n.__cat === 'haze') overviewCount++;

  const densityRevealed = new Set(); // member ids force-shown to fill a sparse overview
  if (overviewCount < DENSITY_FILL_BELOW) {
    const budget = DENSITY_FILL_TARGET - overviewCount;
    // Largest schemas first → most coherent fill.
    const schemasBySize = [...schemaMembers.entries()]
      .sort((a, b) => b[1].size - a[1].size);
    outer:
    for (const [, members] of schemasBySize) {
      for (const m of members) {
        if (densityRevealed.size >= budget) break outer;
        densityRevealed.add(m);
      }
    }
  }

  // Haze-opacity multiplier: 1.0 in-band and when sparse, lerps to
  // HAZE_DENSE_SCALE between DENSITY_THIN_START and DENSITY_THIN_FULL.
  let hazeOpacityScale = 1;
  if (overviewCount > DENSITY_THIN_START) {
    const t = Math.min(1, (overviewCount - DENSITY_THIN_START) /
                          (DENSITY_THIN_FULL - DENSITY_THIN_START));
    hazeOpacityScale = 1 + t * (HAZE_DENSE_SCALE - 1);
  }
```

**What changes (D-05/D-06):** After computing `overviewCount`, if it exceeds `OVERVIEW_NODE_CAP`, suppress haze nodes beyond the cap. Ranking = schema nodes first (by size, largest first — same as `DENSITY_FILL`'s `schemasBySize`), then haze nodes fill the remainder. The `densityRevealed` set and `hazeOpacityScale` logic remain; the cap is additive.

**Import to add** — `lod.js:33-40` currently imports:
```javascript
import {
  DENSITY_FILL_BELOW,
  DENSITY_FILL_TARGET,
  DENSITY_THIN_START,
  DENSITY_THIN_FULL,
  HAZE_DENSE_SCALE,
  HOT,
} from './constants.js';
```
Add `OVERVIEW_NODE_CAP` to this import list.

**Schema membership data available** — `schemaMembers: Map<schemaId, Set<memberId>>` is already built at `lod.js:58-68` before the density block. Use `schemaMembers` for the ranking signal (`.size` = member count = largest-schema-first, same signal as `DENSITY_FILL`).

---

## Shared Patterns

### Hull-coord to world-space transform
**Source:** `graph.js:186-188` and `graph.js:213-216` / `graph.js:323`
**Apply to:** `seedNodePositions()` rewrite
```javascript
  const euler  = new THREE.Euler(HULL_ROT_X, HULL_ROT_Y, HULL_ROT_Z);
  const rotMat = new THREE.Matrix4().makeRotationFromEuler(euler);
  // ...
  v.set(lx, ly, lz)
   .applyMatrix4(rotMat)
   .multiplyScalar(BRAIN_SCALE);
```
This is the canonical local→world pipeline. `BRAIN_SCALE` is LOCKED at 460 — the `multiplyScalar(BRAIN_SCALE)` call must never use a different scale.

### Deterministic hash for stable reloads
**Source:** `graph.js:231-235` (`_hashIndex`) + usage at `graph.js:322-328`
**Apply to:** `seedNodePositions()` rewrite, wherever `Math.random()` currently picks a voxel or generates jitter
```javascript
function _hashIndex(idx, mod) {
  const h = (Math.imul(idx + 1, 0x9e3779b9) >>> 0);
  return h % mod;
}
// Calling convention:
const voxelIdx = _hashIndex(i, occupied.length);
const jx = ((_hashIndex(i * 3 + 0, 1000) / 1000) - 0.5) * 8;
```

### Hidden-then-fade reveal (LOCKED — must not regress)
**Source:** `graph.js:599-614`
**Apply to:** settle/reveal block (only the stop condition changes)
```javascript
  graphEl.style.opacity = '0';          // hidden before settle
  // ...inside revealSettled():
  graphEl.style.transition = 'opacity 0.35s ease';
  graphEl.style.opacity    = '1';
  // ...
  setTimeout(revealSettled, 200);       // wall-clock primary path
```
The 200 ms `setTimeout` in line 614 is already the primary reveal trigger. D-03 replaces `cooldownTicks(12)` with a new `SETTLE_BUDGET_MS` timeout; the `revealSettled()` body and the `onEngineStop` fallback stay verbatim.

### Containment via `onEngineTick` (NOT d3Force setter)
**Source:** `graph.js:582-592`
**Apply to:** settle phase in general — the containment force keeps settling nodes inside the hull, so cluster-aware seeding reduces how much correction it must do, but the force itself is unchanged
```javascript
  // NEVER add forces via Graph.d3Force() — documented crash (Spike 001 landmine).
  // Use Graph.onEngineTick() instead.
  Graph.onEngineTick(brainContainment);
```

### Named-constant pattern for new tunables
**Source:** `constants.js:184-226`
**Apply to:** `SETTLE_BUDGET_MS`, `OVERVIEW_NODE_CAP`
```javascript
/** JSDoc description explaining what the constant controls and when to tune it. */
export const CONSTANT_NAME = defaultValue;
```
All tunables that will be adjusted at the founder visual checkpoint must be named constants — never magic numbers in logic.

---

## No Analog Found

None. All modification sites are within existing files and their closest analog is the surrounding code. The planner has exact current-code excerpts for every edit target above.

---

## Locked Anchors (must not be touched by any plan action)

| Anchor | Location | Value |
|---|---|---|
| `BRAIN_SCALE` | `constants.js:184` | `460` — locked |
| `nodeRadius()` | `graph.js:67-71` | schema: `3 + sqrt(members)*0.8`; member: `2.5`; haze: `2` — locked |
| `revealSettled()` body | `graph.js:603-611` | pin + fade-in — locked (Phase 52 regression risk) |
| `brainContainment` via `onEngineTick` | `graph.js:582-592` | NOT d3Force setter — documented crash |

---

## Metadata

**Analog search scope:** `src/viz/modules/graph.js`, `src/viz/modules/constants.js`, `src/viz/modules/lod.js`
**Files scanned:** 3
**Pattern extraction date:** 2026-06-30
