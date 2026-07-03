# Phase 57: viz activity-palette redesign - Pattern Map

**Mapped:** 2026-07-02
**Files analyzed:** 7 (5 modified, 2 new)
**Analogs found:** 6 / 7 (1 partial — new shared-constants module has no direct codebase precedent, mechanism is Claude's Discretion per D-10)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|-----------------|---------------|
| `src/viz/modules/constants.js` (modify) | config | transform | itself (existing layer-constants blocks, lines 329-398) | exact — extend existing pattern in place |
| `src/viz/modules/trace.js` (modify) | component/renderer | event-driven | itself (existing KIND_COLORS build + fade-timeout blocks) | exact — extend existing pattern in place |
| `src/viz/server.ts` (modify) | route/service | streaming (SSE) | itself (existing mirrored-constant + `setInterval` scheduler blocks) | exact — extend existing pattern in place |
| `src/viz/modules/effects.js` (modify, D-13 calibration) | component | transform (render config) | itself (`initEffects`, UnrealBloomPass block) | exact — this IS the Phase-15 bloom composer file |
| **NEW** shared constants module (TS-server ↔ ESM-client boundary, D-10) | config | transform | `src/viz/modules/constants.js` (client-side single-source pattern) + `src/viz/server.ts` (TS import style) — no direct cross-boundary-module precedent exists | partial — mechanism is new territory, see "No Analog Found" |
| `tests/viz-ambient-liveliness.test.ts` (modify — migrate `REPLAY_DIM < 1` lock) | test | transform (source-parse assertions) | itself | exact |
| **NEW** dedicated invariants test file (D-12) | test | transform (source-parse + behavioral assertions) | `tests/viz-ambient-liveliness.test.ts` (source-parse harness) + `tests/spontaneous-idle-activation.test.ts` (guard/lock style) | exact — both are strong, complementary analogs |

## Pattern Assignments

### `src/viz/modules/constants.js` (config, transform) — MODIFY

**Analog:** itself — the file already contains 4 generations of layer-constants blocks that are the direct template for the new per-layer motion-profile blocks (D-06).

**Existing block header/comment convention** (lines 327-334, repeats at 371-376):
```javascript
// ============================================================================
// Phase 54 — ambient liveliness (tuned at founder visual checkpoint)
// ============================================================================
// Three-layer activity hierarchy: live recall (brightest) > replay echo (dimmer,
// real-but-past) > twinkle (faintest, decorative baseline). All values are spec
// midpoints; founder dials them at the Plan 05 visual checkpoint. REPLAY_DIM < 1
// is a hard invariant (replay can never escalate above live — SC3).
```
Each layer gets a `// Layer N — <name>` sub-header followed by named, individually-JSDoc'd `export const` values (never object literals) — e.g.:
```javascript
// Layer 2 — replay echo
/** ms of no new rows before idle-replay begins (spec tuning range: 4000–6000). */
export const REPLAY_IDLE_GAP_MS  = 5000;

/** ms between replay broadcasts during idle (raised density at founder checkpoint; keep in sync
 *  with server.ts REPLAY_CADENCE_MS — the server-side scheduler is the authoritative copy). */
export const REPLAY_CADENCE_MS   = 2500;

/** Intensity multiplier vs. live recall — MUST be < 1 (honesty invariant SC3; spec: 0.4–0.6). */
export const REPLAY_DIM          = 0.4;
```
The `SPONT_PULSE_SCALE` comment (lines 390-398) is the template for documenting a NEW tunable's rationale/tuning history inline — carry this style into every new motion-profile constant (attack ms, halo scale, pulse thickness, cadence, density per layer).

**KIND_COLOR map to redesign** (lines 148-173): flat `{key: hex}` object, each entry with an inline `/** ... */` comment explaining WHY that hue was chosen. The 56-05 pastel-lavender rationale comment (lines 164-172) is the explicit template CONTEXT.md calls out for every new/changed hue — keep hue identity, document the luminance concern, name what carries subordination instead of the hue itself.

**Migration note:** D-08 says live's founder-tuned constants (`ACT_SCALE_GAIN`, `ACT_BRIGHTEN_GAIN`, `ACT_HAZE_LERP`, decay envelope at lines 108-129, 337-343) migrate INTO the new profile structure pixel-equivalent — this is a restructuring of existing exports, not new values.

---

### `src/viz/modules/trace.js` (component/renderer, event-driven) — MODIFY

**Analog:** itself — `KIND_COLORS` consumption block and the three fade-timeout branches are the direct sites to change.

**KIND_COLORS pre-build + pre-dimmed replay color construction** (lines 236-275):
```javascript
// Per-kind colour objects (pre-built at init; zero allocation cost per-frame)
const KIND_COLORS = {
  new_node:        new THREE.Color(KIND_COLOR.new_node),
  reconsolidation: new THREE.Color(KIND_COLOR.reconsolidation),
  oscillation:     new THREE.Color(KIND_COLOR.oscillation),
  neutral:         new THREE.Color(KIND_COLOR.neutral),
  recall_seed:     new THREE.Color(KIND_COLOR.recall_seed),
  recall_hop:      new THREE.Color(KIND_COLOR.recall_hop),
  spontaneous:     new THREE.Color(KIND_COLOR.spontaneous),
};

// Pre-dimmed cyan for replay-echo edge pulses — spawnPulse has no intensity knob, so a
// darker colour keeps replay pulses strictly dimmer than live (SC3), matching the
// REPLAY_DIM node-activation factor. Scale each channel by REPLAY_DIM and rebuild the hex
// (avoids THREE.Color.multiplyScalar so it also works under the minimal test colour stub).
const _rh = KIND_COLOR.recall_hop;
const REPLAY_HOP_COLOR = new THREE.Color(
  (Math.round(((_rh >> 16) & 0xff) * REPLAY_DIM) << 16) |
  (Math.round(((_rh >> 8) & 0xff) * REPLAY_DIM) << 8) |
  Math.round((_rh & 0xff) * REPLAY_DIM),
);
```
Once replay gets its OWN identity hue (D-01), this `REPLAY_HOP_COLOR` bit-shift-dim-from-recall_hop construction goes away — replay reads `KIND_COLOR.replay` (or equivalent new key) directly the same way `SPONT_HOP_COLOR` (lines 264-275) reads `KIND_COLOR.spontaneous` directly, scaled only by its own pulse-scale constant. The `SPONT_HOP_COLOR` construction is therefore the forward-looking template for the new replay-hop color (both are "identity hue × own pulse-scale constant", not "borrowed hue × dim factor").

**WR-06 — three fade-timeout global clears to fix (D-11):**

Branch 1, replay (lines 692-697):
```javascript
const fadeMs = DECAY_ATTACK_MS + DECAY_HOLD_MS + 500;
setTimeout(() => {
  ctx.traceNodes.clear();
  ctx.traceLinks.clear();
  if (ctx.revealTrace) ctx.revealTrace(pathNodes, []);
}, fadeMs);
```
Branch 2, spontaneous (lines 766-771) — identical shape. Branch 3, live recall (lines 865-870) — identical shape. All three currently call `.clear()` on the whole `ctx.traceNodes` / `ctx.traceLinks` Sets, which wipes IDs added by a concurrent, still-in-flight trace of a different kind (the WR-06 bug). The fix sketch in `56-REVIEW.md` (own-trace-scoped `addedIds` deletion) replaces each `.clear()` with deleting only the ids this specific `applyTrace` call added — each of the three branches already builds a local `pathNodes` array right before the `setTimeout`, so the ids to scope-delete are directly available (`pathNodes.map(n => n.id)` for nodes; link ids would need the equivalent local set if any link keys are added elsewhere in that branch).

---

### `src/viz/server.ts` (route/service, streaming) — MODIFY

**Analog:** itself — the mirrored-constant comment block and the three-scheduler (`setInterval`) pattern are what the new shared module (D-10) replaces / feeds.

**Current mirror-drift pattern to eliminate** (lines 65-77):
```typescript
// Phase 54 replay constants — mirrored from src/viz/modules/constants.js (browser-ESM;
// not imported here to avoid a cross-boundary build dependency). Keep in sync with constants.js.
const REPLAY_IDLE_GAP_MS = 5000;  // ms of silence before idle-replay activates (spec: 4000–6000)
const REPLAY_CADENCE_MS  = 2500;  // ms between replay broadcasts (denser idle life — founder checkpoint)
const REPLAY_HISTORY_N   = 40;    // max recent real rows in the server-side replay ring (deeper for variety)

// Phase 56 spontaneous-emitter constants — server-authoritative, mirroring the REPLAY_*
// precedent above. Keep in sync with constants.js.
const SPONT_CADENCE_MS       = 2500;
const SPONT_SEED_COUNT       = 2;
const SPONT_HOP_TOPN         = 3;
const SPONT_POOL_REFRESH_MS  = 60000;
```
This is literally WR-01: hand-copied `const` declarations with a comment promising to "keep in sync" — no compiler/test enforcement. D-10 requires this become a real `import` from the one shared module instead of a hand-mirror.

**Existing TS import convention on this file** (lines 38-56) — the style the new shared-module import should match:
```typescript
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as child_process from 'node:child_process';
import Database from 'better-sqlite3';
import { ftsQueryFromText } from '../retrieval/topk';
import {
  defaultSettingsPath,
  loadMergedConfig,
  loadSettingsFile,
  writeSettingsFile,
} from '../adapter/settings-loader';
import type { PresetName, SettingsFile } from '../lib/config';
import { PRED_SET } from '../model/typed-predicates';
import { buildHonestOneHopTrace, type HonestTraceReader } from '../retrieval/honest-trace';
```
All existing server-side imports are plain relative TS module imports (no `.js` extension, `moduleResolution: "bundler"`, compiles to CommonJS per `tsconfig.json`). No existing TS file in the repo imports anything from `src/viz/modules/*.js` — this cross-boundary import is new territory (see "No Analog Found").

**Scheduler pattern the new constants feed** (lines 492-510, 555-573) — three near-identical `setInterval(..., <CADENCE>)` blocks (replay, spontaneous) each gated on `lastLiveRow` / `replayBuffer` state and `.unref()`'d. Whatever shape the new shared constants take, they plug into these `setInterval(fn, XXX_CADENCE_MS)` call sites unchanged — no scheduler restructuring implied by D-10.

---

### `src/viz/modules/effects.js` (component, transform) — MODIFY (D-13 bloom/tone-mapping calibration)

**This IS the Phase-15 bloom composer + renderer setup** referenced in CONTEXT.md's "Code to change" list — located precisely at `initEffects(ctx)`, lines 131-151.

**UnrealBloomPass composer setup** (lines 140-148):
```javascript
const composer = Graph.postProcessingComposer();
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.7,   // strength  — restrained glow; ambient scene stays dark
  0.4,   // radius    — tight bloom halo around activated nodes
  0.75,  // threshold — darkened base palette sits well below; only HOT activation flares
);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());  // tone-mapping + sRGB; MUST be last (A1 / r171)
```
D-13's calibration surface is exactly these three `UnrealBloomPass` constructor args (strength/radius/threshold) plus whatever renderer exposure/tone-mapping property lives on the `OutputPass` / underlying `THREE.WebGLRenderer` (not shown in this file — check `graph.js` where the renderer/composer is originally constructed if an explicit `renderer.toneMappingExposure` setter is needed; `effects.js` only appends passes to `Graph.postProcessingComposer()`, it does not construct the renderer itself).

**Constraint comment already in file** (D-14 alignment, lines 131-136):
```javascript
// Uses Graph.postProcessingComposer() — do NOT construct a second EffectComposer
// (Pitfall 2 / T-15-DBLCOMP). The composer already contains a RenderPass added by
// 3d-force-graph. We append:
//   [RenderPass (auto)] → [UnrealBloomPass] → [OutputPass] (last = sRGB)
```
This existing guard is already load-bearing for D-14 (global bloom only, no second composer / no per-layer selective bloom) — no new code needed to satisfy D-14, just don't violate this existing invariant.

`ctx.bloomPass` is also read by `src/viz/modules/stats.js` (lines 78, 167) for adaptive-quality degrade/resize — any renamed/restructured bloom params must keep `ctx.bloomPass` as a live `UnrealBloomPass` reference since stats.js depends on it.

---

### NEW: shared constants module (TS-server ↔ ESM-client boundary) (config, transform)

**No direct precedent exists in the codebase** — no TS file currently imports from `src/viz/modules/*.js`, and no `.js` client module currently gets compiled/re-exported for TS consumption. This is genuinely new territory; D-10 explicitly leaves the mechanism to the planner's discretion.

**Two closest partial analogs to combine:**
1. `src/viz/modules/constants.js` — the "one file, many named `export const`s with JSDoc" shape that all client consumers (`trace.js`, `lod.js`, `hud.js`) already import via plain ESM `import { X } from './constants.js'` with no build step (confirmed: `src/viz/index.html` loads `./modules/app.js` as `<script type="module">`, and `scripts/copy-viz-assets.cjs` copies `modules/` into `dist/src/viz/modules/` byte-for-byte with no compilation).
2. `src/viz/server.ts` — TS file, `module: "commonjs"` per `tsconfig.json`, compiled via `tsc` into `dist/`; imports other TS sources via plain relative `import` (no CJS/ESM interop currently exercised for `.js` client modules).

**Mechanism constraint (verified via `tsconfig.json` + `scripts/copy-viz-assets.cjs`):** the client modules directory is copied to `dist/` **as-is, uncompiled** — so whatever the shared module becomes, its client-consumable form must be plain browser-loadable ESM (the same shape as today's `constants.js`), while its server-consumable form must be importable by a `tsc`-compiled CommonJS build. A `.ts` file alone will NOT satisfy the client side (tsc emits CommonJS `require`/`exports`, which the browser's raw `<script type="module">` import map cannot resolve without a bundler, and none exists in this project). Concretely this means the planner's chosen mechanism is likely one of: (a) a plain `.js` ESM file that server.ts loads via dynamic `import()` (async, since `commonjs` output can't statically `require()` an ESM module), (b) a JSON file both sides parse, or (c) a small always-copied-uncompiled `.mjs`/`.cjs` pair — but this decision is explicitly Claude's Discretion (D-10) and belongs in the plan, not this pattern map.

---

### `tests/viz-ambient-liveliness.test.ts` (test, transform) — MODIFY (migrate `REPLAY_DIM < 1` lock)

**Analog:** itself.

**Source-text-read helpers to reuse** (lines 105-122):
```typescript
const ROOT = path.resolve(__dirname, '..');

function readTraceJs(): string {
  return fs.readFileSync(path.resolve(ROOT, 'src/viz/modules/trace.js'), 'utf8');
}

function readConstantsJs(): string {
  return fs.readFileSync(path.resolve(ROOT, 'src/viz/modules/constants.js'), 'utf8');
}

function readServer(): string {
  return fs.readFileSync(path.resolve(ROOT, 'src/viz/server.ts'), 'utf8');
}

/** Strip JSDoc inner lines and standalone comment lines before token assertions. */
function stripComments(src: string): string {
  return src.split('\n').filter(line => !/^\s*(\*|\/\/)/.test(line)).join('\n');
}
```

**The exact lock being migrated** (lines 482-489):
```typescript
it('SC3: REPLAY_DIM numeric value parses to < 1 (replay can never escalate above live)', () => {
  // Extract the assigned value and confirm it is strictly less than 1.
  // REPLAY_DIM >= 1 would let a replay echo exceed live brightness — a hard SC3 violation.
  const match = src.match(/export\s+const\s+REPLAY_DIM\s*=\s*([\d.]+)/);
  expect(match).not.toBeNull();
  const value = parseFloat(match![1]!);
  expect(value).toBeLessThan(1);
});
```
Per D-12, this test (and any other scattered layer-constant lock in this file) migrates into the new dedicated invariants file as its underlying constant migrates into the new per-layer profile structure — leave a comment here noting the lock moved, or delete it outright once the new file supersedes it (planner's call; D-10's shared module may make regex source-parsing partially obsolete in favor of direct imports + runtime assertions, per the code_context note in CONTEXT.md).

---

### NEW: dedicated invariants test file (D-12) (test, transform)

**Analogs (two, complementary):**
1. `tests/viz-ambient-liveliness.test.ts` — source-parse regex-on-file-text harness (`readConstantsJs`/`readTraceJs`/`readServer` + `stripComments` + regex `match`/`toContain` assertions). Use this shape for: luminance-band membership per palette entry, dim-floor values, per-channel monotonic SC3 ordering across profile blocks — anything checkable by parsing exported constant values out of source text (or, if D-10's shared module allows real imports, by importing the values directly and asserting on them numerically — strictly better than regex, worth strongly preferring if the shared-module mechanism permits it).
2. `tests/spontaneous-idle-activation.test.ts` — deterministic-fixture + real-import-and-call guard style (imports `pickSpontaneousSeeds` directly from `../src/viz/server`, not by regex) plus a **secondary** static source-text guard (lines 181-200) that slices a named block by start/end marker strings and asserts on its content:
```typescript
it('static: the spontaneous emitter region in server.ts opens no new Database() and writes no activation_trace row', () => {
  const src = readServer();
  const startMarker = 'eligible-seed pool for the spontaneous idle emitter';
  const endMarker = 'spontaneousInterval.unref();';
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = stripComments(src.slice(start, end + endMarker.length));
  expect(block).not.toContain('new Database(');
  ...
});
```
This marker-slice-then-assert pattern is the template for the shared-source-sync check (D-10 / D-12's "shared-source sync" invariant) if the shared module ends up being verified by cross-referencing server.ts and constants.js text rather than by import identity.

**Recommended file location/name (not prescriptive — planner's call):** `tests/viz-activity-palette-invariants.test.ts`, sibling to `viz-ambient-liveliness.test.ts` and `spontaneous-idle-activation.test.ts`, following the existing `tests/viz-*` and `tests/*-idle-activation.test.ts` naming convention already in the directory.

**Header-comment convention to match** (from `viz-ambient-liveliness.test.ts` lines 1-12):
```typescript
/**
 * tests/viz-ambient-liveliness.test.ts
 *
 * TDD tests for Phase 54 Plan 02 — three-layer ambient liveliness in trace.js:
 *   Layer 1 (Task 1): live recall amplification (...)
 *   ...
 *
 * RED/GREEN commits are per-task per the TDD execution flow.
 * Source-text guard pattern mirrors viz-layout-guards.test.ts (Phase 53).
 * Behavioral pattern mirrors viz-haze-activation.test.ts (Phase 52).
 */
```
Every prior viz test file in this codebase declares which earlier test file it mirrors — continue that chain explicitly in the new file's header (mirrors `viz-ambient-liveliness.test.ts` + `spontaneous-idle-activation.test.ts`).

**THREE mock, if behavioral (not just source-parse) tests are needed** (`viz-ambient-liveliness.test.ts` lines 14-90): a hand-rolled `vi.mock('three', ...)` stub covering `Color`/`Vector3`/`Quaternion`/`CylinderGeometry`/`SphereGeometry`/`ShaderMaterial`/`MeshBasicMaterial`/`Mesh`/`AdditiveBlending`, plus `globalThis.performance`/`document`/`window` stubs set BEFORE the module import (required because `initTrace` calls `document.getElementById` at module-init time). Reuse this exact mock if the new invariants file needs to exercise `initTrace`/`activate` behaviorally (e.g. to assert monotonic ordering by actually running the envelope), rather than parsing source text.

---

## Shared Patterns

### Named-tunable + inline rationale comment (constants.js convention)
**Source:** `src/viz/modules/constants.js` (every export in the file, especially lines 386-398 `SPONT_HOP_TOPN`/`SPONT_PULSE_SCALE`)
**Apply to:** every new constant this phase introduces (palette hues, dim floors, per-layer motion-profile values).
```javascript
/** Max hop nodes considered per spontaneous emission (founder-tuned at 56-05:
 *  6 → 3 — with 6, a 3-seed tick lit ~21 nodes and read cluttered). */
export const SPONT_HOP_TOPN     = 3;
```
Never a bare magic number — always a named `export const` with a JSDoc comment stating the tuning history/rationale, matching the D-09 ratchet workflow (provisional value now, founder-approved value + tolerance at checkpoint, comment updated to record the "why").

### Client/server constant mirror comment (the anti-pattern D-10 kills)
**Source:** `src/viz/server.ts` lines 65-77
**Apply to:** nowhere new — this is the pattern being eliminated, not propagated. Flag any new server.ts constant that duplicates a constants.js value as a D-10 violation.

### Source-parse regex test harness
**Source:** `tests/viz-ambient-liveliness.test.ts` lines 104-122
**Apply to:** the new dedicated invariants test file, and any remaining/migrated locks in `viz-ambient-liveliness.test.ts`.
```typescript
function readConstantsJs(): string {
  return fs.readFileSync(path.resolve(ROOT, 'src/viz/modules/constants.js'), 'utf8');
}
function stripComments(src: string): string {
  return src.split('\n').filter(line => !/^\s*(\*|\/\/)/.test(line)).join('\n');
}
```

### Own-trace-scoped cleanup vs. global clear (WR-06 fix shape)
**Source:** `56-REVIEW.md` fix sketch (referenced in CONTEXT.md, not re-derived here) + the three existing `setTimeout` blocks in `trace.js` (lines 692-697, 766-771, 865-870), each already computing a local `pathNodes` array right before the timeout fires.
**Apply to:** all three `trace.js` branches (live, replay, spontaneous) per D-11.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| NEW shared constants module (D-10 cross-boundary mechanism) | config | transform | No TS file in the repo imports from `src/viz/modules/*.js`, and no client `.js` module is currently compiled/re-exported for TS use. `tsconfig.json` (`module: "commonjs"`) + `scripts/copy-viz-assets.cjs` (copies `modules/` uncompiled) jointly constrain the mechanism but no working example exists to copy from — planner must design this fresh (explicitly Claude's Discretion per D-10). |
| Luminance-band computation helper (D-02: relative Y or OKLCH L) | utility | transform | Grepped `luminance`/`OKLCH`/`0.2126` across `src/` and `tests/` — no hits outside vendored Three.js shader files (`LuminosityHighPassShader.js`, a bloom internal, not a reusable app-level utility). This is genuinely new code; pick the metric per Claude's Discretion and document it inline, following the named-tunable comment convention above. |

## Metadata

**Analog search scope:** `src/viz/modules/`, `src/viz/server.ts`, `src/viz/index.html`, `tests/viz-*.test.ts`, `tests/spontaneous-idle-activation.test.ts`, `tsconfig.json`, `scripts/copy-viz-assets.cjs`, `package.json`
**Files scanned:** ~15 (targeted reads + grep sweeps; no full-repo scan needed — phase scope is entirely inside `src/viz/` + `tests/viz-*`)
**Pattern extraction date:** 2026-07-02
