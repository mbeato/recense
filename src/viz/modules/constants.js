/**
 * @module constants
 * brain-memory viz — shared palette, sizing, timing constants and ctx contract.
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
 * @property {Function}  revealTrace             - () → void; reapply visibility
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
 * @property {Function}  markActive              - () → void; reset idle timer
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

/** Spreading-activation BFS depth (max hops outward from seed nodes) */
export const MAX_HOPS = 4;

/** Delay between hop waves (ms) — energy propagates outward at this cadence */
export const HOP_MS = 620;

/** Max edges followed per node per hop (prevents runaway on dense graphs) */
export const TRACE_FANOUT = 5;

/** Total pulse budget per trace (hard cap on GPU draw calls) */
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
