# Phase 53: Brain Layout at Scale (declutter + deliberate clustering) - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-30
**Phase:** 53-brain-layout-at-scale-declutter-deliberate-clustering
**Areas discussed:** Clustering + settle cost, Anti-gridline seeding, 'Too full' lever at 15k, Reveal UX + position stability

---

## Clustering + settle cost

### How should related nodes end up clustered at 15k?

| Option | Description | Selected |
|--------|-------------|----------|
| Hybrid: cluster-aware seed + short settle | Seed connected nodes near each other, then short force-settle for organic relaxation. Cheap, scales to 15k. | ✓ |
| Pure force-settle (more ticks) | Raise cooldownTicks a lot; most organic but cost scales badly at 15k. | |
| Cluster-aware seed only (no extra settle) | Place groups at seed, keep 12-tick freeze; cheapest but looks gridded-by-group. | |

**User's choice:** Hybrid: cluster-aware seed + short settle

### What grouping signal should drive the cluster-aware seed placement?

| Option | Description | Selected |
|--------|-------------|----------|
| Schema membership (primary) | Seed each node near its schema hub via schema→member edges already in payload. | ✓ |
| Graph connectivity / community | Lightweight community detection over edges; more compute, may not match schema story. | |
| Schema primary + connectivity fallback | Schema where it exists, connectivity for orphans; most complete, more code. | |

**User's choice:** Schema membership (primary)

### How should the settle be bounded so it stays within the perf budget at 15k?

| Option | Description | Selected |
|--------|-------------|----------|
| Wall-clock budget, then pin | Settle until a fixed time budget elapses then pin; bounded reveal latency, never hangs. Mirrors the 200ms reveal-timeout idiom. | ✓ |
| Fixed tick count (tuned) | Raise cooldownTicks to a tuned constant; per-tick cost grows with node count. | |
| Tune at founder checkpoint | Make the bound a named constant, defer the value to the visual checkpoint. | |

**User's choice:** Wall-clock budget, then pin
**Notes:** Value left as a named constant, tuned at the founder visual checkpoint (Phase 52 idiom).

---

## Anti-gridline seeding

### How should node positions fill space instead of snapping to voxel centers?

| Option | Description | Selected |
|--------|-------------|----------|
| Continuous in-hull sampling | Sample a continuous random point inside the hull per node, biased toward cluster centroid. Kills lattice, organic, cheap; reuses brainOccupied(). | ✓ |
| Cell-filling jitter | Voxel-center seed + ±half-voxel jitter; smallest change, still faintly voxel-quantized. | |
| Blue-noise / Poisson-disk | Even minimum-distance point set; heaviest at 15k and fights the clustering goal. | |

**User's choice:** Continuous in-hull sampling

---

## 'Too full' lever at 15k

### What should be the primary lever to keep the overview readable as the corpus grows past ~6k?

| Option | Description | Selected |
|--------|-------------|----------|
| Cap overview node count | Hold overview at a roughly constant target (top schemas + capped haze) regardless of corpus size; detail revealed on drill/trace. | ✓ |
| Recalibrate the existing band upward | Push DENSITY_THIN_START/FULL up; smallest change but a moving target, still renders everything. | |
| Camera-distance LOD culling | Fullness tied to camera distance; more general, bigger change, zoom-pop risk. | |

**User's choice:** Cap overview node count

### What target and ranking should the overview cap use?

| Option | Description | Selected |
|--------|-------------|----------|
| Founder band, largest schemas first | Target ~2,700–3,200 band, most-populated/connected schemas first, drop the tail. | |
| Founder band, but tune ranking at checkpoint | Lock the target, defer the survive-ranking to the visual checkpoint. | |
| Let Claude / planner decide | Capture "cap around the calibrated band"; planner picks number + ranking from the payload. | ✓ |

**User's choice:** Let Claude / planner decide

---

## Reveal UX + position stability

### Should the settle be visible, or hidden until pre-settled?

| Option | Description | Selected |
|--------|-------------|----------|
| Hidden until settled, then fade in | Keep current settle-then-pin + fade-in; reveals finished layout, no janky 15k motion. | ✓ |
| Visible settling motion | Fade in early, watch clusters form; more alive but chaotic/stuttery at 15k. | |

**User's choice:** Hidden until settled, then fade in

### How should layout stability across viz loads be handled at 15k?

| Option | Description | Selected |
|--------|-------------|----------|
| Deterministic seed, re-settle each load | Hash-based deterministic seed (like haze _hashIndex); same corpus → same layout, no cache, budget caps cost. | ✓ |
| Cache settled positions | Persist final positions in a presentation-layer store; fastest reload but needs invalidation + storage. | |
| Re-settle freely (no stability guarantee) | Random seed + bounded settle; layout drifts every open, undercuts "deliberate structure". | |

**User's choice:** Deterministic seed, re-settle each load

---

## Verification (cross-cutting)

### How should Phase 53 be verified?

| Option | Description | Selected |
|--------|-------------|----------|
| Perf measurement + founder visual checkpoint | Machine-check load-cost/frame-rate guard + founder checkpoint for gridlines/clustered/not-too-full. Mirrors Phase 52. | ✓ |
| Founder visual checkpoint only | Eyeball at 15k; no objective guard for the no-regression criterion. | |
| Let planner decide the test split | Capture both criteria; planner works out automatable vs checkpoint. | |

**User's choice:** Perf measurement + founder visual checkpoint

---

## Claude's Discretion

- Exact wall-clock settle budget value (tuned at founder checkpoint).
- Exact overview cap target + survive-ranking signal.
- In-hull continuous-sampling implementation and centroid-bias strength.
- Deterministic hash function / seeding scheme.
- Automatable-vs-checkpoint test split.

## Deferred Ideas

- Spatial arrangement of clusters within the hull (distinct regions vs local cohesion) — within D-01's hybrid, left to planner/checkpoint.
- `corpus-brain-3d-transition.md` (reviewed todo) — corpus↔brain fly-through; separate future phase.
- `viz-search-and-hull-quality.md` (reviewed todo) — node search + topic-region highlight; separate future viz phase.
