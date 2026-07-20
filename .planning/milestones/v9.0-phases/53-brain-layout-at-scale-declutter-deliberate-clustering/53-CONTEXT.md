# Phase 53: Brain Layout at Scale (declutter + deliberate clustering) - Context

**Gathered:** 2026-06-30
**Status:** Ready for planning

<domain>
## Phase Boundary

Presentation/layout-layer rework of `recense viz` so the brain reads as a deliberate,
clustered, organic structure at ~15k+ nodes instead of a dense, visibly-gridded, "too full"
cloud. Fixes three coupled symptoms the founder reported at 15k (2026-06-29): visible gridlines,
feels too full, no longer feels clustered/deliberate.

**In scope:**
- Replace voxel-center snapping with continuous in-hull seeding (kills the lattice).
- Cluster-aware seed (by schema membership) + a short, wall-clock-bounded force-settle so related
  nodes group.
- Cap overview node count around the founder's calibrated density band so screen fullness stays in
  band as the corpus grows (decoupled from total corpus size).

**Out of scope (hard):**
- Zero engine / retrieval / scoring / graph-traversal / data-model change. Node positions remain
  decorative (CLAUDE.md: viz is chrome, positions are NOT semantic) — clustering here is for visual
  *deliberateness*, not to encode readable meaning.
- Must NOT regress Phase 52's honest-traces flashes (recall seeds/hops, ingestion bridge,
  reconsolidation hero choreography).
- No persistent position cache / new storage surface (resolved by deterministic seeding instead).
- No new viz capabilities (node search, corpus↔brain fly-through transition) — those are separate phases.

</domain>

<decisions>
## Implementation Decisions

### Clustering mechanism
- **D-01:** **Hybrid — cluster-aware seed + short settle.** Seed connected nodes near each other so
  they START clustered, then run a short force-settle for organic relaxation. Chosen over pure
  force-settle (cost scales badly at 15k; sim already degrades) and seed-only (looks gridded-by-group).
  Since positions aren't semantic, "placed" clusters are honest.
- **D-02:** **Grouping signal = schema membership (primary).** Seed each node near its schema hub using
  the schema→member edges already in the graph payload. Cheapest available signal, maps directly to the
  schema constellation the overview already shows. (Connectivity/community detection and a
  schema-primary+connectivity-fallback were considered and not chosen — revisit only if many nodes lack
  a schema hub.)
- **D-03:** **Settle bounded by a wall-clock budget, then pin.** Settle until a fixed time budget elapses
  (regardless of node count), then pin — mirrors the existing 200ms reveal-timeout idiom at
  `graph.js:614`. At 15k fewer ticks complete but it never hangs; bounded, predictable reveal latency.
  The budget is a named constant; tune the exact value at the founder visual checkpoint (Phase 52 idiom).
  This replaces `Graph.cooldownTicks(12)` (`graph.js:598`).

### Anti-gridline seeding
- **D-04:** **Continuous in-hull sampling, biased toward the cluster centroid.** Sample a continuous
  random point inside the brain hull volume per node (not a discrete voxel center), biased toward the
  node's schema-cluster centroid (D-01/D-02). Fully kills the lattice and is organic + cheap; reuses the
  existing `brainOccupied()` hull test. Replaces the voxel-center pick + ±2u jitter at
  `graph.js:213-220`. Chosen over cell-filling jitter (still faintly voxel-quantized) and blue-noise/
  Poisson (heavy at 15k, and its evenness goal fights the clustering goal).

### "Too full" lever at scale
- **D-05:** **Cap overview node count around the calibrated band.** Hold the overview at a roughly
  constant fullness (top schema super-nodes + capped haze) regardless of total corpus size, so the
  screen stays in the founder's dialed-in band at 15k / 50k / etc. Members/detail still revealed on
  drill-in or trace. Chosen over merely recalibrating `DENSITY_THIN_START/FULL` upward (a moving target
  that re-renders everything) and camera-distance LOD culling (bigger change, zoom-pop risk).
- **D-06:** Exact cap target and survive-ranking are **planner's discretion** — capture intent ("cap
  overview around the existing calibrated ~2,700–3,200 band, drop the long tail"); let research/planner
  pick the target number and ranking signal (schema size vs connectivity vs recency) from what the
  payload cheaply exposes. The "largest schemas first" idiom already in `DENSITY_FILL` (`lod.js`) is the
  starting reference.

### Reveal UX + position stability
- **D-07:** **Hidden until settled, then fade in.** Keep the current settle-then-pin + opacity fade-in
  (`graph.js:600-611`): canvas stays at opacity 0 during the settle budget, then reveals the finished
  clustered layout. No 15k nodes visibly sliding/stuttering. (Visible settling motion was considered and
  rejected as chaotic at scale.)
- **D-08:** **Deterministic seed, re-settle each load — no persistent cache.** Make the cluster-aware
  seed deterministic (hash-based, like the haze layer's `_hashIndex` at `graph.js:231-235`, which already
  exists "so reloads are stable") so the same corpus reproduces the same layout. No persistent position
  store, no cache-invalidation surface; the D-03 wall-clock budget caps re-settle cost each load. Chosen
  over a presentation-layer position cache (adds storage + invalidation) and free re-settle (layout drifts
  every open, undercutting "deliberate, stable structure").

### Verification
- **D-09:** **Perf/budget measurement + founder visual checkpoint** (mirrors Phase 52's
  structural-test-plus-checkpoint). Machine-check the load-cost guard (settle stays within the D-03
  wall-clock budget; frame-rate at ~15k not worse than baseline — success criterion 3). Founder visual
  checkpoint covers gridlines-gone, clustered/deliberate, and not-too-full at ~15k. Exact automatable vs
  felt split is planner's to finalize.

### Claude's Discretion
- Exact wall-clock settle budget value (D-03) — named constant, tuned at founder checkpoint.
- Exact overview cap target + survive-ranking signal (D-06).
- In-hull continuous-sampling implementation (rejection sampling vs jittered-point-then-`brainOccupied`-validate) and the centroid-bias strength (D-04).
- Deterministic hash function / seeding scheme for node positions (D-08).
- The automatable-vs-checkpoint test split (D-09).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Root-cause sites (start here — already traced, do NOT re-investigate)
- `src/viz/modules/graph.js:171-221` — `seedNodePositions()`; voxel-center pick + ±2u jitter
  (`graph.js:213-220`) is the gridline source. D-04 rewrites this for continuous in-hull + cluster-centroid bias.
- `src/viz/modules/graph.js:594-614` — settle-then-pin reveal: `Graph.cooldownTicks(12)` (`:598`),
  `revealSettled()` pin + fade-in (`:603-611`), `setTimeout(revealSettled, 200)` reveal-timeout idiom
  (`:614`). D-03 replaces the tick count with a wall-clock budget; D-07 keeps the hidden-then-fade reveal.
- `src/viz/modules/graph.js:231-235` — `_hashIndex()` deterministic Knuth hash used by the haze layer
  "so reloads are stable" — the idiom D-08 extends to node seeding.
- `src/viz/modules/constants.js:194-226` — adaptive-density band (`DENSITY_FILL_BELOW/TARGET`,
  `DENSITY_THIN_START=3200`, `DENSITY_THIN_FULL=6000`, `HAZE_DENSE_SCALE=0.35`); calibrated at ~2,692
  overview nodes (2026-06-14 install). D-05/D-06 cap around this band. `BRAIN_SCALE=460` and `nodeRadius`
  stay LOCKED ("3,500 is the anchor").
- `src/viz/modules/lod.js:88-125` — `overviewCount` (#schema + #haze) density adaptation; the
  "largest schemas first" reveal idiom (`:105-116`) is the D-06 ranking starting point.

### Phase 52 (shared viz — must not regress)
- `.planning/phases/52-brain-viz-honest-traces/52-CONTEXT.md` — locked viz decisions (palette, trace
  honesty, ingestion bridge, reconsolidation choreography). Phase 53 must not regress these flashes.
- `docs/superpowers/specs/2026-06-29-brain-viz-honest-traces-design.md` — the Phase 52 design contract;
  the closest thing to a viz design spec. Phase 53's design contract = this spec + the layout gap.

### Project guards (load-bearing)
- `CLAUDE.md` (project) — palette lock (amber = activation/hover ONLY); **viz is decorative chrome,
  node positions are NOT semantic** (so connectivity-clustering is aesthetic, not meaning-encoding);
  the old VIZ-06 anatomical-term ban was dropped — brain imagery in the viz is allowed.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `brainOccupied(brainVol, x, y, z)` (`graph.js:155-164`) — the hull occupancy test; D-04 continuous
  in-hull sampling reuses it to validate sampled points land inside the hull.
- `_hashIndex()` (`graph.js:231-235`) — deterministic Knuth hash already used for stable haze seeding;
  extend for D-08 deterministic node seeding.
- The `occupied[]` voxel-center list (`graph.js:194-207`) — already collected; cluster centroids /
  continuous samples can be derived from it without rebuilding the hull volume.
- `DENSITY_FILL` "largest schemas first" reveal logic (`lod.js:105-116`) — D-06 cap ranking analog.
- `revealSettled()` + opacity fade-in (`graph.js:603-611`) — D-07 keeps this reveal path as-is.

### Established Patterns
- Settle-then-pin: sim runs N ticks (or a timeout), then every node's `fx/fy/fz` is pinned at its
  settled position and the canvas fades in. D-03 changes the *stop condition* (wall-clock budget), not
  the pattern.
- Containment force `brainContainment` via `Graph.onEngineTick` (`graph.js:582-592`, `CONTAIN_STRENGTH`
  applied per-tick, NOT via d3Force setter — documented crash). Cluster-aware seeding reduces the
  correction this force must do (nodes start in-hull and grouped).
- Overview fullness tracks `overviewCount = #schema + #haze` (`lod.js:101-102`); `BRAIN_SCALE` and
  `nodeRadius` are locked anchors — adaptation acts on count/haze-opacity, never absolute sizing.

### Integration Points
- `seedNodePositions()` is the single seeding entry point — cluster-aware + continuous in-hull logic
  lands here (needs schema→member adjacency from the graph payload to compute cluster centroids).
- The settle/reveal block (`graph.js:594-614`) is where the wall-clock budget + pin live.
- `lod.js` density adaptation is where the overview cap (D-05/D-06) lands.

</code_context>

<specifics>
## Specific Ideas

- Three founder-reported symptoms (2026-06-29, ~15k nodes) anchor success: (1) visible gridlines,
  (2) too full, (3) no longer clustered/deliberate. Each maps to a decision: D-04 (gridlines),
  D-05/D-06 (too full), D-01/D-02/D-03 (clustering).
- "Deliberate and clustered" is the felt target — clusters should read as intentional grouping, not a
  uniform scatter and not a snapped grid. The hidden-then-fade reveal (D-07) presents the finished
  structure, not the formation.
- Stability matters to the "deliberate structure" feel: the same corpus should look the same on every
  open (D-08 deterministic seed), without paying for a persistent cache.

</specifics>

<deferred>
## Deferred Ideas

- **Spatial arrangement of clusters within the hull** (distinct schema regions vs local cohesion only) —
  surfaced as a possible deeper question; left to planner/founder-checkpoint within D-01's hybrid approach.

### Reviewed Todos (not folded)
- **`corpus-brain-3d-transition.md`** — corpus↔brain 3D camera fly-through transition. Founder-requested
  (Phase 34 checkpoint), explicitly its own future phase; not layout-at-scale work. Deferred.
- **`viz-search-and-hull-quality.md`** — in-app node search + topic-region highlighting + hull view
  quality. Separate future viz phase (search/highlight is a new capability, not layout). Deferred. (Note:
  its "topic regions fall out of schema clustering" observation aligns with D-02's schema grouping —
  worth referencing when that phase is planned.)

</deferred>

---

*Phase: 53-brain-layout-at-scale-declutter-deliberate-clustering*
*Context gathered: 2026-06-30*
