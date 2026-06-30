/**
 * @module constants
 * recense viz — shared palette, sizing, timing constants and ctx contract.
 *
 * Every downstream module (graph/lod/trace/effects/detail/hud/stats/app)
 * imports from here. This file is the source-of-truth for the ctx contract
 * that plans 03–07 implement against — do NOT add runtime behaviour here.
 */

// ============================================================================
// Ctx contract (JSDoc @typedef — Plans 03–07 implement these fields)
// ============================================================================

/**
 * @typedef {Object} Ctx
 * The single shared context object created by app.js and passed to every
 * initX(ctx) call. Fields are populated progressively as each module
 * initialises; only fields explicitly set by that module are safe to read
 * after its init() resolves.
 *
 * --- Bootstrap (set by app.js, Plan 07) -------------------------------------
 * @property {typeof import('three')} THREE     - THREE namespace (from import map)
 * @property {Function}  ForceGraph3D            - UMD bundle, dynamically loaded
 * @property {Object}    Graph                   - ForceGraph3D instance
 * @property {Array}     allNodes                - All nodes from GET /graph
 * @property {Array}     allLinks                - All links from GET /graph
 * @property {Map<string,Object>} idMap          - node.id → node object
 * @property {Map<string,Array>}  adj            - node.id → adjacency list (both dirs)
 * @property {Function}  getVisibleNodes         - () → Node[]; respects tombstone toggle
 * @property {Object|null} brainVol              - Occupancy grid or null when absent
 *
 * --- lod.js (Plan 03) -------------------------------------------------------
 * @property {Function}  nodeVisible             - (node) → boolean; LOD predicate
 * @property {Function}  linkVis                 - (link) → boolean; LOD link predicate
 * @property {Function}  refreshVisibility       - () → void; full visibility re-eval (schema expand/collapse)
 * @property {Function}  revealTrace             - (pathNodes, pathLinks) → void; trace-only delta sync — flips .visible on the bounded pathway object set
 * @property {Set<string>} expanded              - Schema ids currently drilled-in
 * @property {Set<string>} traceNodes            - Node ids revealed by active trace
 * @property {Set<string>} traceLinks            - Link keys revealed by active trace
 * @property {Map<string,string>} memberSchema   - memberId → schemaId
 * @property {Function}  linkKey                 - (link) → string; canonical edge key
 *
 * --- trace.js (Plan 04) -----------------------------------------------------
 * @property {Function}  applyTrace              - (seedIds: string[]) → void; BFS spreading activation
 * @property {Function}  activate                - (node, level: number) → void; boost node glow
 * @property {Function}  spawnPulse              - (from, to) → void; traveling light segment
 * @property {Function}  registerTick            - (fn: (now: number) => void) → void; per-frame cb
 *
 * --- effects.js (Plan 05) ---------------------------------------------------
 * @property {Object}    bloomPass               - UnrealBloomPass (quality-tier control)
 * @property {Object}    hullMat                 - Fresnel ShaderMaterial for idle shimmer
 * @property {Function}  setIdleShimmer          - (on: boolean) → void
 *
 * --- hud.js (Plan 04) -------------------------------------------------------
 * @property {Function}  logEvent                - (cat: string, msg: string) → void
 * @property {Function}  setSSEStatus            - (live: boolean) → void
 *
 * --- stats.js (Plan 03) -----------------------------------------------------
 * @property {Function}  setTier                 - (tier: number) → void; 0=FULL,1=REDUCED,2=MINIMAL
 * @property {Function}  markActive              - () → void; reset idle timer (user interaction only)
 * @property {Function}  markAnimating           - (durationMs: number) → void; hold full framerate without resetting idle timer
 * @property {Function}  isIdle                  - () → boolean
 *
 * --- detail.js (Plan 06) ----------------------------------------------------
 * @property {Function}  selectNode              - (node) → void; open detail panel
 * @property {Function}  closeDetail             - () → void; close detail panel
 *
 * --- constants (this module) ------------------------------------------------
 * @property {typeof import('./constants.js')} constants - this export object
 */

// ============================================================================
// Palette (founder-revised at the 15-08 gate: quiet monochrome + ember accent)
// ============================================================================
// Near-monochrome steel grays with a faint hue cast per semantic type — the
// scene reads as a quiet ghost-brain at ambient glance, types distinguishable
// up close. All values sit far below the bloom threshold; the warm HOT amber
// of a real activation is the only thing that flares and grabs attention.

/**
 * Node colours by semantic type.
 * @type {{entity: number, fact: number, schema: number}}
 */
export const TYPE_COLOR = {
  entity: 0x9c7080,  // dusty rose  — specific entities (the "brain tissue" hue)
  fact:   0x6d7890,  // slate blue  — general semantic facts (cool counterpoint)
  schema: 0x82698c,  // muted mauve — learned abstractions (bridges rose ↔ blue)
};

/**
 * Scene background — set via Graph.scene().background (color-managed path).
 * Deep warm aubergine matching the Recense app-icon field (brand cohesion,
 * 2026-06-12); still dark enough that the amber pulse stays the only signal.
 */
export const BG_COLOR = 0x170f1d;

/** Tombstoned nodes: visually muted and de-emphasised */
export const TOMBSTONE_COLOR = 0x2b2530;

/**
 * Activation glow colour — warm amber.
 * The one warm signal against the cool palette; the brightest thing on screen
 * when a real query fires. Kept as a raw hex so JS can pass it directly to
 * THREE.Color or THREE.MeshBasicMaterial.color.
 */
export const HOT = 0xffb866;

// ============================================================================
// Activation decay envelope (D-06)
// ============================================================================
// Replaces the old flat `node.__act -= dt * 0.6` (~1.6 s linear decay).
// Three named phases: fast attack → hold at peak → exponential fade to floor.
// Values are designer-tunable constants; adjust at the founder visual checkpoint.

/** Fast brightness ramp after a node fires (ms). */
export const DECAY_ATTACK_MS = 140;

/** How long the node stays at peak brightness before fading (ms). */
export const DECAY_HOLD_MS = 600;

/** Exponential fade duration from peak → DECAY_FLOOR (ms). */
export const DECAY_FADE_MS = 2500;

/**
 * Activation floor — the node lingers at this fraction of peak after the
 * fade tail rather than snapping to zero. Low enough to be nearly invisible;
 * high enough to avoid a jarring hard-off at the end of the envelope.
 */
export const DECAY_FLOOR = 0.04;

// ============================================================================
// Per-event kind colour palette (D-07 / D-04)
// ============================================================================
// Single source of truth: every renderer reads KIND_COLOR instead of defining
// its own hex literals.  Keys match the `kind` column in activation_trace
// (plus `recall_seed` / `recall_hop` for the two visual roles in a recall row).
//
// Palette constraints:
//   recall_seed = HOT amber  — the primary retrieval-activation signal
//   recall_hop  = cyan       — subordinate 1-hop associations (thinner / dimmer)
//   neutral     ≠ amber      — D-04 guard: amber is reserved for retrieval/hover
//                              ONLY; neutral MUST use a different hue

/**
 * Per-event kind colours for the activation animation.
 * @type {{recall_seed: number, recall_hop: number, new_node: number, reconsolidation: number, oscillation: number, neutral: number}}
 */
export const KIND_COLOR = {
  /** Retrieval seed — amber (same as HOT; seeds are the primary activation) */
  recall_seed:     0xffb866,
  /** 1-hop association — cyan (subordinate; thinner / dimmer than seeds) */
  recall_hop:      0x66d9ff,
  /** New node encoding — soft sage-green (muted into the tissue palette) */
  new_node:        0x8fbf9e,
  /** Reconsolidation hero — warm rose-mauve (belief-update-in-place; the hero
   *  hue, the warmest/most-saturated of the muted set so it still reads as the
   *  signature event, but no longer hot magenta — sits with entity-rose/schema-mauve) */
  reconsolidation: 0xc481a4,
  /** Oscillation / instability — muted burnt amber (warm + unsettled, distinct
   *  from the brighter recall-seed amber) */
  oscillation:     0xc9824e,
  /** Non-hero cascade events — muted slate (NON-amber per D-04) */
  neutral:         0x8a93a6,
};

// ============================================================================
// Sizing
// ============================================================================

/** Max neighbour connections shown in the detail panel before "+ N more" */
export const MAX_FAN_OUT = 8;

/** 3d-force-graph nodeRelSize multiplier */
export const nodeRelSize = 4;

/** Node mesh scale factor while hovered */
export const HOVER_SCALE = 1.8;

/**
 * World-space radius of the brain graph cloud.
 * Drives both the visible hull scale and the containment volume so they stay
 * perfectly aligned — bigger = roomier node cloud; smaller = denser.
 */
export const BRAIN_SCALE = 460;

/**
 * How hard a node outside the brain occupancy volume is pulled back to center
 * each simulation tick. Higher = crisper brain-shaped edge, more surface
 * clumping. Applied via onEngineTick (NOT d3Force setter — documented crash).
 */
export const CONTAIN_STRENGTH = 0.35;

// ============================================================================
// Adaptive density (Phase 19 Item 2)
// ============================================================================
// The overview renders only schema super-nodes + haze (members hidden until a
// schema is drilled-in or a trace reveals them). So screen fullness tracks
// `overviewCount = #schema + #haze`. Few of those → an empty shell (new user);
// too many → unreadable mush (power user). lod.js adapts AROUND a calibrated
// neutral band so the founder's dialed-in look (~2,700 overview nodes at the
// 2026-06-14 install) is untouched — both regimes are off inside the band.
//
// Two regimes act on DIFFERENT levers, never absolute sizing (BRAIN_SCALE and
// nodeRadius stay locked — "3,500 is the anchor"):
//   sparse → reveal real hidden members to fill (never fabricates nodes; D-04)
//   dense  → dim the haze noise so the schema constellation reads through it
//
// Verified no-op at the live install: 600 < 2692 < 3200 → neither fires.

/** Below this overview count, reveal hidden members to fill the empty shell. */
export const DENSITY_FILL_BELOW = 600;

/** Reveal members (largest schemas first) until overview reaches ~this count.
 *  Capped by how many members actually exist — a genuinely tiny brain stays
 *  small rather than inventing structure. */
export const DENSITY_FILL_TARGET = 600;

/** Above this overview count, begin lerping haze opacity downward. */
export const DENSITY_THIN_START = 3200;

/** Overview count at which haze reaches its minimum opacity scale. */
export const DENSITY_THIN_FULL = 6000;

/** Haze opacity multiplier at full thinning (lerp 1.0 → this between
 *  DENSITY_THIN_START and DENSITY_THIN_FULL). 1.0 = no change. */
export const HAZE_DENSE_SCALE = 0.35;

// ============================================================================
// Hull rotation (radians)
// ============================================================================
// The STL's longest axis is Z (~208 units). -π/2 on X rotates it from
// pointing up to pointing forward so the brain sits upright in the scene.

/** Hull X rotation — -Math.PI/2 to orient the STL's Z-axis forward */
export const HULL_ROT_X = -Math.PI / 2;
export const HULL_ROT_Y = 0;
export const HULL_ROT_Z = 0;

// ============================================================================
// Spreading-activation / trace timing
// ============================================================================
// NOTE (Phase 52): The client-side BFS that used MAX_HOPS / TRACE_FANOUT as
// CONTENT GENERATORS has been deleted.  applyTrace is now driven entirely by
// the server-emitted seeds + hops payload (honest 1-hop neighbours).
// These constants are retained as DEFENSIVE SAFETY CAPS only — in practice
// the honest payload from the engine is already within bounds.

/**
 * DEFENSIVE CAP ONLY — max hop depth accepted from the server payload.
 * (No longer drives a client BFS — the BFS was deleted in Phase 52.)
 */
export const MAX_HOPS = 4;

/** Delay between hop waves (ms) — energy propagates outward at this cadence */
export const HOP_MS = 780;

/**
 * DEFENSIVE CAP ONLY — max edges processed per node from the server payload.
 * (No longer drives a client BFS — the BFS was deleted in Phase 52.)
 */
export const TRACE_FANOUT = 5;

/**
 * DEFENSIVE CAP ONLY — total lit edges per trace (hard cap on GPU draw calls).
 * traceEdgesFromHops clamps to this as a last-resort guard; honest payloads
 * from the engine are already within this limit.
 */
export const TRACE_MAX_EDGES = 80;

/**
 * Traveling pulse duration (ms).
 * The glowing "wire" segment sweeps from source to destination over this time,
 * filling the pathway with light before fading out.
 */
export const PULSE_MS = 1500;

// ============================================================================
// Idle / adaptive-quality fps targets (D-06 / D-07)
// ============================================================================

/** Target fps during ambient idle (all-day display, fan-friendly) */
export const IDLE_FPS = 24;

/** Target fps during active interaction and trace playback */
export const FULL_FPS = 60;

/**
 * fps below which the adaptive quality tier degrades (D-06).
 * stats.js watches the rolling average and calls ctx.setTier() accordingly.
 */
export const DEGRADE_FPS = 45;
