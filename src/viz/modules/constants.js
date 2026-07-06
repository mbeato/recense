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
// Re-homed pixel-equivalent into the Layer 1 (live) motion profile further
// below (Phase 57 D-06/D-08) — names + values UNCHANGED, just grouped there
// as the top profile alongside the other live salient-channel consts.

// ============================================================================
// Per-event kind colour palette (D-07 / D-04, luminance-equalized Phase 57 D-01/02/03/04)
// ============================================================================
// Single source of truth: every renderer reads KIND_COLOR instead of defining
// its own hex literals.  Keys match the `kind` column in activation_trace
// (plus `recall_seed` / `recall_hop` for the two visual roles in a recall row,
// and `replay` for the idle-replay echo layer).
//
// Palette constraints:
//   recall_seed = HOT amber  — the primary retrieval-activation signal
//   recall_hop  = cyan       — subordinate 1-hop associations (thinner / dimmer)
//   neutral     ≠ amber      — D-04 guard: amber is reserved for retrieval/hover
//                              ONLY; neutral MUST use a different hue
//   oscillation ≠ amber      — D-03(b) guard: amber-family (R≈G>B warm-orange)
//                              is exclusively live's; oscillation must be a
//                              genuinely different hue direction
//
// Phase 57 D-02: every entry below computes a Rec.709 relative luminance
// Y = 0.2126R + 0.7152G + 0.0722B inside the LOCKED band [170, 228]
// (tests/viz-activity-palette-invariants.test.ts "D-02 luminance-band
// membership") — the 56-05 lesson (saturated indigo Y≈138 vanished; pastel
// lavender Y≈193 survived) generalized to the whole palette. Subordination
// among activity layers comes from motion/scale/density (D-06, later plans),
// never from a dark hue.
//
// Stage-1 founder checkpoint (57-03, D-16): every hue below was reviewed
// live over the real hull and approved AS-IS (verbal sign-off via the
// execute-phase checkpoint, 2026-07-03) — no per-kind hex changes requested.
// Values below are now LOCKED, not provisional.

/**
 * Per-event kind colours for the activation animation.
 * @type {{recall_seed: number, recall_hop: number, new_node: number, reconsolidation: number, oscillation: number, neutral: number, spontaneous: number, replay: number}}
 */
export const KIND_COLOR = {
  /** Retrieval seed — amber (same as HOT; seeds are the primary activation).
   *  IDENTITY: live-amber. Y≈193. In-band, unchanged (56-05 anchor value). */
  recall_seed:     0xffb866,
  /** 1-hop association — cyan (subordinate; thinner / dimmer than seeds).
   *  IDENTITY: live-cyan. Y≈195. In-band, unchanged. */
  recall_hop:      0x66d9ff,
  /** New node encoding — soft sage-green (muted into the tissue palette).
   *  IDENTITY: sage-green. Y≈178. In-band, unchanged. */
  new_node:        0x8fbf9e,
  /** Reconsolidation hero — rose-mauve (belief-update-in-place; the hero hue,
   *  the warmest/most-saturated of the muted set so it still reads as the
   *  signature event, sitting with entity-rose/schema-mauve).
   *  Phase 57 D-02 retune: 0xc481a4 → 0xd9a0bd — the original was below the
   *  luminance band (Y≈146). Lifted lightness while keeping the rose-mauve
   *  IDENTITY (R>B>G channel ordering unchanged); Y≈174 now in-band.
   *  LOCKED — founder-approved as-is at Stage-1 (57-03, D-09). Subordination
   *  to live comes from motion/scale, not the hue. */
  reconsolidation: 0xd9a0bd,
  /** Oscillation / instability — warm coral-red (unsettled), deliberately
   *  moved OUT of the amber family per D-03(b): amber is reserved for live
   *  retrieval/hover only. Phase 57 D-02 retune: 0xc9824e → 0xe89c9c — the
   *  original was both below the luminance band (Y≈141) AND an amber-family
   *  hue (R≈G>B warm-orange signature). The new hue is a true coral red
   *  (R dominant, G≈B, hue≈0°) — no amber signature — with Y≈172, in-band.
   *  LOCKED — founder-approved as-is at Stage-1 (57-03, D-09). Subordination
   *  to live comes from motion/scale, not the hue. */
  oscillation:     0xe89c9c,
  /** Non-hero cascade events — slate (NON-amber per D-04).
   *  Phase 57 D-02 retune: 0x8a93a6 → 0xaab3c4 — the original was below the
   *  luminance band (Y≈146). Lifted lightness while keeping the cool slate
   *  IDENTITY (B>G>R channel ordering unchanged); Y≈178 now in-band.
   *  LOCKED — founder-approved as-is at Stage-1 (57-03, D-09). Subordination
   *  to live comes from motion/scale, not the hue. */
  neutral:         0xaab3c4,
  /** Spontaneous idle 1-hop wandering (Phase 56) — pastel lavender, the
   *  default-mode-network hue. Distinct from recall amber and replay cyan so
   *  spontaneous activity is never mistaken for a live/replayed query result.
   *  56-05 founder tuning: 0x8a7fff → 0xc9b8ff — saturated indigo is inherently
   *  low-luminance (Y≈138) and vanished on the dark bg once dimmed; desaturating
   *  toward pastel keeps the violet IDENTITY while luminance (Y≈193) carries
   *  visibility. Subordination to live/replay comes from SPONT_DIM + density,
   *  not from a dark hue. */
  spontaneous:     0xc9b8ff,
  /** Replay echo of a recent real recall (Phase 57 D-01) — pale ice-cyan, a
   *  cooler/paler sibling of live recall_hop cyan per the D-04 semantic-hue-
   *  family rule (a replayed hop reading as "a cooler echo of the live hop"
   *  is semantically right). Previously replay had NO identity hue at all —
   *  trace.js dimmed recall_hop by REPLAY_DIM, so replay literally rendered
   *  as a darker copy of live cyan (the bug this phase fixes). Y≈225, in-band.
   *  LOCKED — founder-approved as-is at Stage-1 (57-03, D-09). Subordination
   *  to live comes from motion/scale (REPLAY_DIM survives as the secondary
   *  cue), not the hue. */
  replay:          0xb3ecf5,
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

/** Max total overview nodes (schema + haze) rendered at the overview level,
 *  regardless of corpus size (D-05). Holds screen fullness in the founder-
 *  calibrated ~2,700–3,200 band as the corpus grows to 15k / 50k nodes.
 *
 *  When overviewCount exceeds this cap, the long-tail haze is suppressed
 *  (survive-ranking: schema super-nodes kept first, largest-schema-first
 *  per D-06; haze fills the remaining budget; surplus haze suppressed).
 *  Suppressed nodes are still reachable via drill-in and trace — the cap
 *  is overview-render-only, never a data deletion. A named tunable, NOT a
 *  magic number. Tune at the founder visual checkpoint. */
export const OVERVIEW_NODE_CAP = 3000;

// ============================================================================
// Force-settle timing (Phase 53 D-03)
// ============================================================================
// Replaces Graph.cooldownTicks(12) with a wall-clock budget that bounds the
// settle regardless of node count. The sim runs freely during the budget;
// when the timeout fires, revealSettled() pins every node's fx/fy/fz and
// fades the canvas in. Tune at the founder visual checkpoint.

/** Wall-clock ms the force settle runs before pinning nodes and fading in.
 *  Replaces cooldownTicks(12); bounded regardless of node count (D-03).
 *  Tune at the founder visual checkpoint. */
export const SETTLE_BUDGET_MS = 250;

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

// ============================================================================
// Phase 57 D-06/D-08 — four per-layer motion profiles (SC3 salience ordering)
// ============================================================================
// Salience ordering (live > replay > spontaneous > twinkle) moves OFF
// brightness-of-a-saturated-hue and ONTO motion/scale: each layer below gets a
// named motion-profile block — attack sharpness, halo/scale, pulse thickness,
// cadence, density — forming a designed "character" (live: sharp attack + big
// halo, the event; replay: soft echo; spontaneous: slow calm drift; twinkle:
// micro-breathe). The two salient ordering channels — attack ms (sharper =
// smaller ms) and halo/scale (bigger = more salient) — hold MONOTONICALLY
// across all four layers and are locked by
// tests/viz-activity-palette-invariants.test.ts ("D-06 motion-profile SC3
// ordering"). Cadence and density are free to vary for feel (NOT
// ordering-constrained).
//
// Stage-2 founder checkpoint (57-07, D-16): the founder tuned the full system
// (motion profiles + dim floors + bloom + exposure) live over the real hull
// and approved it AS-IS (verbal sign-off via the execute-phase checkpoint,
// 2026-07-03) — no value changes requested. Every non-live value below is now
// LOCKED, not provisional.

// ----------------------------------------------------------------------------
// Layer 1 — live recall (the event: sharp attack, big halo)
// ----------------------------------------------------------------------------
// Re-homed pixel-equivalent from the original "Activation decay envelope" +
// "Phase 54 ambient liveliness" sections (D-08) — names + values UNCHANGED,
// only grouped here as the top motion profile. Downstream tests
// (viz-ambient-liveliness.test.ts) import these names directly; do not rename.

/** Fast brightness ramp after a node fires (ms) — live's attack-sharpness
 *  channel (D-06 SC3 ordering: the sharpest of the four layers). */
export const DECAY_ATTACK_MS = 80;

/** How long the node stays at peak brightness before fading (ms). */
export const DECAY_HOLD_MS = 600;

/** Exponential fade duration from peak → DECAY_FLOOR (ms). */
export const DECAY_FADE_MS = 2500;

/** Activation floor — the node lingers at this fraction of peak after the
 *  fade tail rather than snapping to zero. Low enough to be nearly invisible;
 *  high enough to avoid a jarring hard-off at the end of the envelope. */
export const DECAY_FLOOR = 0.04;

/** Size-pulse gain multiplier; replaces the inline 0.35 (spec tuning range: 0.8–1.0). */
export const ACT_SCALE_GAIN    = 1.05;

/** Opacity boost gain; replaces the inline 0.4 (spec: raise opacity signal at overview zoom). */
export const ACT_BRIGHTEN_GAIN = 0.95;

/** Haze color-lerp factor; replaces the inline 0.8 (spec: raise for stronger haze color overshoot). */
export const ACT_HAZE_LERP     = 0.95;

/** Live's halo/scale channel (D-06 SC3 ordering: full-extent halo — the
 *  biggest/most-salient of the four layers, "the event"). Expressed as a
 *  multiplier of the node's peak-activation glow radius. LOCKED —
 *  founder-approved as-is at Stage-2 (57-07, D-09). */
export const LIVE_HALO_SCALE = 1.0;

/** Live's pulse-thickness channel (D-06) — traveling-pulse line-width
 *  multiplier for spawnPulse; live's pulses are the thickest of the four
 *  layers. LOCKED — founder-approved as-is at Stage-2 (57-07, D-09). */
export const LIVE_PULSE_THICKNESS = 1.0;

// ----------------------------------------------------------------------------
// Layer 2 — replay echo (soft echo of a recent real recall)
// ----------------------------------------------------------------------------

/** ms of no new rows before idle-replay begins (spec tuning range: 4000–6000). */
export const REPLAY_IDLE_GAP_MS  = 5000;

/** ms between replay broadcasts during idle (raised density at founder checkpoint).
 *  Single authored source (D-10) — server.ts derives this value via source-parse at
 *  startVizServer init rather than re-declaring it. */
export const REPLAY_CADENCE_MS   = 2500;

/** Replay's attack-sharpness channel (D-06 SC3 ordering: softer/slower than
 *  live, sharper than spontaneous). Time-to-peak in ms for the replay echo's
 *  brightness ramp. LOCKED — founder-approved as-is at Stage-2 (57-07, D-09). */
export const REPLAY_ATTACK_MS = 200;

/** Replay's halo/scale channel (D-06 SC3 ordering: smaller than live's
 *  full-extent halo, bigger than spontaneous's). LOCKED — founder-approved
 *  as-is at Stage-2 (57-07, D-09). */
export const REPLAY_HALO_SCALE = 0.75;

/** Replay's pulse-thickness channel (D-06) — thinner than live's, matching
 *  the "soft echo" character. LOCKED — founder-approved as-is at Stage-2
 *  (57-07, D-09). */
export const REPLAY_PULSE_THICKNESS = 0.7;

/** Intensity multiplier vs. live recall — secondary dim cue (D-05), floored
 *  at >= FLOOR_BOUND (0.6; see tests/viz-activity-palette-invariants.test.ts)
 *  now that primary subordination comes from motion/scale (REPLAY_ATTACK_MS /
 *  REPLAY_HALO_SCALE above), not brightness. Phase 57 D-05 retune: 0.4 → 0.7
 *  (the old value sat below the perceptual floor once paired with a
 *  luminance-equalized hue). MUST stay < 1 (SC3 honesty invariant: replay can
 *  never escalate above live). LOCKED — founder-approved as-is at Stage-2
 *  (57-07, D-09). */
export const REPLAY_DIM          = 0.7;

/** Number of recent real rows kept in the server-side replay ring buffer.
 *  Single authored source (D-10) — server.ts derives this value via source-parse at
 *  startVizServer init rather than re-declaring it. */
export const REPLAY_HISTORY_N    = 40;

// ----------------------------------------------------------------------------
// Layer 3 — spontaneous default-mode wandering (slow calm drift)
// ----------------------------------------------------------------------------
// Honest idle-emitted 1-hop spreads (real PRED_SET edges, no fabricated
// content) — rendered strictly subordinate to replay so a genuinely-alive
// brain with an empty replay buffer still reads as alive, without ever
// escalating above the replay layer.

/** Spontaneous's attack-sharpness channel (D-06 SC3 ordering: slower than
 *  replay, sharper/faster than twinkle's micro-breathe). Time-to-peak in ms.
 *  LOCKED — founder-approved as-is at Stage-2 (57-07, D-09). */
export const SPONT_ATTACK_MS = 400;

/** Spontaneous's halo/scale channel (D-06 SC3 ordering: smaller than
 *  replay's, bigger than twinkle's). LOCKED — founder-approved as-is at
 *  Stage-2 (57-07, D-09). */
export const SPONT_HALO_SCALE = 0.55;

/** Spontaneous's pulse-thickness channel (D-06) — thinner than replay's,
 *  matching the "slow calm drift" character. LOCKED — founder-approved as-is
 *  at Stage-2 (57-07, D-09). */
export const SPONT_PULSE_THICKNESS = 0.5;

/** Intensity multiplier vs. live recall — secondary dim cue (D-05), floored
 *  at >= FLOOR_BOUND (0.6) and MUST stay < REPLAY_DIM (spontaneous is the
 *  dimmest activity layer, WR-02). Phase 57 D-05 retune: 0.3 → 0.6 (the old
 *  value sat below the perceptual floor). Primary subordination now comes
 *  from motion/scale (SPONT_ATTACK_MS / SPONT_HALO_SCALE above), not
 *  brightness. LOCKED — founder-approved as-is at Stage-2 (57-07, D-09). */
export const SPONT_DIM          = 0.6;

/** ms between spontaneous emissions during idle (starting direction).
 *  Single authored source (D-10) — server.ts derives this value via source-parse at
 *  startVizServer init rather than re-declaring it. */
export const SPONT_CADENCE_MS   = 2500;

/** Max hop nodes considered per spontaneous emission (founder-tuned at 56-05:
 *  6 → 3 — with 6, a 3-seed tick lit ~21 nodes and read cluttered).
 *  Single authored source (D-10) — server.ts derives this value via source-parse at
 *  startVizServer init rather than re-declaring it. */
export const SPONT_HOP_TOPN     = 3;

/** Distinct live seeds sampled per spontaneous tick (server-only scalar; 56-05 founder
 *  tuning 3 → 2). Single authored source (D-10) — server.ts derives this value via
 *  source-parse at startVizServer init rather than declaring its own literal. */
export const SPONT_SEED_COUNT   = 2;

/** ms between eligible-seed pool rebuilds for the spontaneous emitter (server-only
 *  scalar). Single authored source (D-10) — server.ts derives this value via
 *  source-parse at startVizServer init rather than declaring its own literal. */
export const SPONT_POOL_REFRESH_MS = 60000;

/** Channel scale for spontaneous EDGE pulses only (56-05 founder tuning — at
 *  the pre-Phase-57 SPONT_DIM floor (0.3), the wavefront lines were
 *  near-invisible; thin additive lines need high luminance to register). 0.6 ×
 *  pastel lavender 0xc9b8ff → line luminance ≈ 116: clearly visible, still
 *  well below live-amber full-intensity lines. Replay and spontaneous never
 *  co-render (spontaneous fires only when the replay buffer is empty), so
 *  per-pixel line-vs-line subordination is not load-bearing — the SC3 machine
 *  invariant lives on SPONT_DIM < REPLAY_DIM (node activations), which this
 *  constant does not touch. */
export const SPONT_PULSE_SCALE  = 0.6;

// ----------------------------------------------------------------------------
// Layer 4 — ambient twinkle (micro-breathe, decorative baseline)
// ----------------------------------------------------------------------------

/** Nodes in the rotating twinkle subset (~0.5% of 15k corpus) — twinkle's
 *  density channel (D-06); the only layer where population density is a
 *  meaningful profile channel (live/replay/spontaneous are single-event
 *  pulses, not a population). */
export const TWINKLE_COUNT      = 220;

/** Sine breathe period per twinkle node (ms; spec tuning range: 1500–2500). */
export const TWINKLE_PERIOD_MS  = 2000;

/** Twinkle's attack-sharpness channel (D-06 SC3 ordering: the slowest/least-
 *  sharp of the four layers). Derived as a quarter of TWINKLE_PERIOD_MS — a
 *  sine breathe's natural rise-to-peak. LOCKED — founder-approved as-is at
 *  Stage-2 (57-07, D-09). */
export const TWINKLE_ATTACK_MS = 500;

/** Twinkle's halo/scale channel (D-06 SC3 ordering: the smallest/least-
 *  salient of the four layers — decorative baseline only). LOCKED —
 *  founder-approved as-is at Stage-2 (57-07, D-09). */
export const TWINKLE_HALO_SCALE = 0.3;

/** Twinkle's pulse-thickness channel (D-06) — twinkle has no traveling edge
 *  pulse today (per-node breathe only); this reserves the profile-shape value
 *  for a future twinkle micro-pulse if one is ever added. LOCKED —
 *  founder-approved as-is at Stage-2 (57-07, D-09). */
export const TWINKLE_PULSE_THICKNESS = 0.3;

/** Brightness amplitude of the twinkle breathe — neutral tint lerp (raised from 0.18 at
 *  the founder checkpoint so ambient idle activity reads without the hull as backdrop). */
export const TWINKLE_AMP        = 0.42;

// ============================================================================
// Phase 58 — haze impostor
// ============================================================================

/** Below this fragment alpha, the haze billboard impostor is discarded
 *  (alphaTest-style) rather than blended — keeps correct depth occlusion
 *  between overlapping radial-falloff quads without needing a depth sort. */
export const ALPHA_TEST_THRESHOLD = 0.02;

// ============================================================================
// Phase 58 — schema labels (D-01..D-04, D-15)
// ============================================================================
// Diegetic troika-three-text SDF labels on the top-N highest-member-count
// schema super-nodes (labels.js), depth-tested so opaque node meshes occlude
// them naturally, faded in only on camera approach — the overview
// constellation stays label-free.

/** Number of top schemas (by member count, via ctx.schemaMembers) that get
 *  an in-scene SDF label. A named tunable, not a magic number (D-02 scope). */
export const LABEL_TOP_N = 30;

/** World-space camera-to-node distance below which a label fades in (D-03
 *  appear-on-approach). Provisional — Claude's Discretion, tuned against
 *  detail.js's focus-camera offset (~300 units from a selected node, see
 *  focusCamera()) vs. the overview camera distance (BRAIN_SCALE * 2.2 ≈ 1012
 *  from the origin) — comfortably separates "approaching/focused on a node"
 *  from "overview". Tune at the Stage-1 founder checkpoint (Plan 05). */
export const LABEL_DISTANCE_THRESHOLD = 350;

/** Schema-label slate color (D-03/D-15 locked family) — the same neutral
 *  slate as KIND_COLOR.neutral; in-band luminance (tests/viz-activity-palette-
 *  invariants.test.ts "D-15 label color lock"), never amber. */
export const LABEL_COLOR = 0xaab3c4;

// ============================================================================
// Phase 58 — focus matcap (D-09..D-12, D-15)
// ============================================================================
// Damped fade of the focus-tier matcap mix (detail.js, graph.js's
// mat.userData.matcapMixUniform) toward 0 or 1 via THREE.MathUtils.damp — a
// feel constant (D-15 UNLOCKED), not a correctness lock.

/** Exponential-damp smoothing rate for the matcap mix fade-in/out (D-11). */
export const MATCAP_MIX_LAMBDA = 8;

// ============================================================================
// Phase 58 — camera (D-05..D-08)
// ============================================================================
// One damped, interruptible camera-target system (camera.js) drives every
// camera move — node focus (a single continuous move to the focus pose;
// D-06's staged orbit-then-dolly flight was rejected at the Stage-2
// founder checkpoint's second round as "2 repositions" and removed),
// recenter/home framing, the brain⇄corpus transition (D-08), and search
// fly-to (routes through detail.js's selectNode, so it rides the same
// system for free). Feel constants — UNLOCKED, tuned at the Stage-2
// founder checkpoint (D-15).

/** Exponential-damp smoothing rate for camera POSITION (THREE.MathUtils.damp,
 *  camera.js registerTick). */
export const CAM_POS_LAMBDA = 4;

/** Exponential-damp smoothing rate for camera LOOKAT — deliberately higher
 *  than CAM_POS_LAMBDA so the gaze settles on target before the body catches
 *  up, reproducing the old tween-based accessor's "lookAt tweens at ms/3"
 *  feel (RESEARCH Pitfall 4) with the new continuously-retargetable damp
 *  system. */
export const CAM_LOOKAT_LAMBDA = 8;

// ============================================================================
// Phase 58 — hover damp + focus depth (D-07, area 2 #1)
// ============================================================================
// Frame-rate-independent damped hover (graph.js's onNodeHover), asymmetric by
// design: grow with a slight overshoot (one oscillation), shrink with none.
// Plus the focus-depth deepening (detail.js applyFocusDim/clearFocusDim,
// graph.js's scene fog) — a stronger non-neighbor dim and a tightened fog
// near-plane while a node is focused, both restored on deselect. Feel
// constants — UNLOCKED, tuned at the Stage-2 founder checkpoint (D-15).

/** Exponential-damp smoothing rate for hover scale (THREE.MathUtils.damp,
 *  graph.js registerTick). Same rate drives both the grow and shrink legs —
 *  the asymmetry comes from the overshoot target swap, not a second lambda. */
export const HOVER_LAMBDA = 10;

/** Grow-leg overshoot peak, as a multiplier on HOVER_SCALE (~1.05 = one
 *  subtle oscillation past the resting hover scale before settling back down
 *  to it). Never applied on the shrink leg (hover-leave settles directly to 1). */
export const HOVER_OVERSHOOT = 1.05;

/** Focus-dim opacity for nodes outside the selected neighborhood (D-07 —
 *  moved from detail.js to join the named-constant discipline). Slightly
 *  stronger than the pre-D-07 value so the non-neighbor recede reads more
 *  decisively. Provisional — Claude's Discretion, ratcheted at Stage 2. */
export const FOCUS_DIM_OPACITY = 0.035;

/** Fog near-plane while a node is focused (D-07) — tighter than the resting
 *  BRAIN_SCALE * 1.8, pulling a soft depth cue in toward the focus and
 *  deepening the read alongside the dim. Restored to BRAIN_SCALE * 1.8 on
 *  deselect (detail.js clearFocusDim). Provisional — Claude's Discretion. */
export const FOCUS_FOG_NEAR = BRAIN_SCALE * 1.4;

// ============================================================================
// Phase 59 — HUD design tokens (D-11/D-14 single authored source)
// ============================================================================
// The glass/radius/motion recipe pinned in 59-UI-SPEC.md, exported as a plain
// object so css-tokens.js's emitHudTokens() can build the runtime `:root`
// CSS-custom-property block from it — the JS→CSS consumer of this single
// authored source (mirrors server.ts's parseSchedulerScalars, but via native
// ESM import, no regex). These values are provisional per D-08/D-09,
// ratcheted at the D-15 checkpoint.

/**
 * HUD glass/radius/motion recipe — CSS-var suffix (no leading `--`) to value.
 * @type {Record<string, string>}
 */
export const HUD_CSS_TOKENS = {
  'glass-bg-ambient': 'rgba(26, 18, 32, 0.66)',
  'glass-bg-focused': 'rgba(26, 18, 32, 0.90)',
  'glass-blur-sm': '8px',
  'glass-blur-md': '14px',
  'glass-border': 'rgba(170, 150, 180, 0.12)',
  'glass-border-focused': 'rgba(140, 150, 165, 0.16)',
  'glass-specular': 'inset 0 1px 0 rgba(255, 255, 255, 0.06)',
  'radius-xs': '4px',
  'radius-sm': '7px',
  'radius-md': '11px',
  'radius-lg': '12px',
  'ease-out-soft': 'cubic-bezier(0.22, 1, 0.36, 1)',
  'motion-fast': '120ms',
  'motion-base': '200ms',
  'motion-slow': '220ms',
  'recede-ghost-opacity': '0.12',
};

/** Idle timer before ambient HUD chrome recedes (D-08). Provisional — ratcheted at D-15. */
export const HUD_IDLE_TIMEOUT_MS = 4000;

/** Target opacity for HUD chrome at rest/idle/focus-deepened (D-09). Provisional — ratcheted at D-15.
 *  Kept in sync with HUD_CSS_TOKENS['recede-ghost-opacity'] (same 0.12 literal). */
export const RECEDE_GHOST_OPACITY = 0.12;

/** Palette input debounce (ms) — reuses search.js's existing DEBOUNCE_MS value verbatim. */
export const PALETTE_DEBOUNCE_MS = 200;

/** Palette Nodes-section result cap. */
export const PALETTE_CAP_NODES = 8;

/** Palette Topics-section result cap. */
export const PALETTE_CAP_TOPICS = 6;

/** Palette Commands-section result cap. */
export const PALETTE_CAP_COMMANDS = 8;

/** Palette z-index — above #settings-panel (41), below the tray-injected 70-tier. */
export const PALETTE_Z_INDEX = 50;

/** Palette backdrop z-index — just under the palette itself. */
export const PALETTE_BACKDROP_Z_INDEX = 49;
