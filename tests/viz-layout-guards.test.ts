/**
 * tests/viz-layout-guards.test.ts
 *
 * Phase 53 Plan 03 (D-09): machine-checkable regression guards for the layout,
 * locked-anchor, and Phase-52 honesty invariants.
 *
 * Reads src/viz/modules/graph.js and constants.js as raw source text, strips
 * comment lines, and asserts the locked structural tokens that must not silently
 * regress. Does NOT import the modules at runtime; does NOT modify any src/viz file.
 *
 * Deterministic seeding is already behaviorally tested in tests/viz-seed-determinism.test.ts.
 * This file is structural guard-only (source-text assertions on non-comment lines).
 *
 * Invariants asserted:
 *   1. constants.js: BRAIN_SCALE=460 exported + SETTLE_BUDGET_MS + OVERVIEW_NODE_CAP
 *   2. graph.js settle block: setTimeout(revealSettled, SETTLE_BUDGET_MS) present;
 *      cooldownTicks(12) absent (D-03 / D-09 perf guard)
 *   3. graph.js revealSettled() body: fade sequence + fx/fy/fz pin intact (Phase 52 / D-07)
 *   4. graph.js nodeRadius() definition: schema/member/haze magnitudes intact (locked)
 *   5. graph.js seedNodePositions brainVol branch: no Math.random (D-08 determinism)
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Load source files as text ─────────────────────────────────────────────────
// __dirname is the tests/ directory; root is one level up.
const ROOT = path.resolve(__dirname, '..');
const GRAPH_SRC = fs.readFileSync(
  path.resolve(ROOT, 'src/viz/modules/graph.js'),
  'utf8',
);
const CONST_SRC = fs.readFileSync(
  path.resolve(ROOT, 'src/viz/modules/constants.js'),
  'utf8',
);

// ── Strip comment lines before token assertions ───────────────────────────────
// Strips lines whose first non-whitespace content is `*` (JSDoc inner lines) or
// `//` (standalone line comments). This ensures JSDoc prose cannot satisfy or
// invalidate any assertion gate. Inline comments (e.g. `return 2; // haze`) are
// NOT stripped because the line itself starts with code.
function stripComments(src: string): string {
  return src
    .split('\n')
    .filter(line => !/^\s*(\*|\/\/)/.test(line))
    .join('\n');
}

const GRAPH = stripComments(GRAPH_SRC);
const CONST = stripComments(CONST_SRC);

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Slice from `startMarker` up to (but not including) `endMarker` in `src`.
 * Returns the slice including `startMarker` if found; empty string otherwise.
 */
function sliceBetween(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  if (start < 0) return '';
  const end = src.indexOf(endMarker, start + startMarker.length);
  return end >= 0 ? src.slice(start, end) : src.slice(start);
}

// ─────────────────────────────────────────────────────────────────────────────

describe('viz-layout-guards', () => {

  // ── 1. constants.js exports ───────────────────────────────────────────────
  describe('constants.js exports (locked anchors and tunables)', () => {

    it('exports BRAIN_SCALE = 460 (unchanged locked anchor)', () => {
      // After stripping comments the code line is: export const BRAIN_SCALE = 460;
      expect(CONST).toContain('BRAIN_SCALE = 460');
    });

    it('exports SETTLE_BUDGET_MS (Phase 53 wall-clock settle tunable, D-03)', () => {
      // Value may change at founder checkpoint; guard only that it is exported.
      expect(CONST).toMatch(/export const SETTLE_BUDGET_MS\s*=/);
    });

    it('exports OVERVIEW_NODE_CAP (Phase 53 density cap tunable, D-05)', () => {
      // Value may change at founder checkpoint; guard only that it is exported.
      expect(CONST).toMatch(/export const OVERVIEW_NODE_CAP\s*=/);
    });

  });

  // ── 2. Settle block (D-03 / D-09 perf guard) ─────────────────────────────
  describe('settle block — bounded by wall-clock SETTLE_BUDGET_MS (D-03)', () => {

    it('calls setTimeout(revealSettled, SETTLE_BUDGET_MS) — primary wall-clock path', () => {
      expect(GRAPH).toContain('setTimeout(revealSettled, SETTLE_BUDGET_MS)');
    });

    it('does NOT contain cooldownTicks(12) — fixed-tick stop removed (D-03)', () => {
      // cooldownTicks(12) was the old fixed-tick stop condition; must be gone.
      // cooldownTicks(0) (let sim run freely) is the correct replacement.
      expect(GRAPH).not.toContain('cooldownTicks(12)');
    });

  });

  // ── 3. revealSettled() locked body (Phase 52 / D-07) ─────────────────────
  describe('revealSettled() body — locked fade + pin (Phase 52 regression guard / D-07)', () => {

    // Extract the revealSettled function body.
    // revealSettled() is a nested function indented at 2 spaces; its closing
    // brace is the first '\n  }' (2-space indent) after the function signature.
    const revealStart = GRAPH.indexOf('function revealSettled()');
    const revealClose = GRAPH.indexOf('\n  }', revealStart);
    const revealBody  = revealStart >= 0 && revealClose >= 0
      ? GRAPH.slice(revealStart, revealClose + 4)
      : '';

    it('revealSettled() body is present in graph.js', () => {
      expect(revealStart).toBeGreaterThanOrEqual(0);
      expect(revealBody.length).toBeGreaterThan(0);
    });

    it('pins fx/fy/fz from x/y/z (D-07 no-regress)', () => {
      // The pin must read n.fx = n.x; n.fy = n.y; n.fz = n.z;
      expect(revealBody).toContain('n.fx = n.x');
      expect(revealBody).toContain('n.fy = n.y');
      expect(revealBody).toContain('n.fz = n.z');
    });

    it("sets opacity transition 'opacity 0.35s ease' (Phase 52 locked fade-in)", () => {
      expect(revealBody).toContain("graphEl.style.transition = 'opacity 0.35s ease'");
    });

    it("sets graphEl.style.opacity to '1' after transition (Phase 52 locked fade-in)", () => {
      expect(revealBody).toContain("graphEl.style.opacity    = '1'");
    });

  });

  // ── 4. nodeRadius() locked definition ─────────────────────────────────────
  describe('nodeRadius() definition — schema/member/haze magnitudes locked', () => {

    // Extract the top-level nodeRadius function.
    // It is a top-level function (0-space indent), so closing brace is '\n}'.
    const nodeRadiusStart = GRAPH.indexOf('function nodeRadius(');
    const nodeRadiusClose = GRAPH.indexOf('\n}', nodeRadiusStart);
    const nodeRadiusBody  = nodeRadiusStart >= 0 && nodeRadiusClose >= 0
      ? GRAPH.slice(nodeRadiusStart, nodeRadiusClose + 2)
      : '';

    it('nodeRadius() body is present in graph.js', () => {
      expect(nodeRadiusStart).toBeGreaterThanOrEqual(0);
      expect(nodeRadiusBody.length).toBeGreaterThan(0);
    });

    it("schema branch: formula is '3 + Math.sqrt(node.__members || 0) * 0.8'", () => {
      expect(nodeRadiusBody).toContain("__cat === 'schema'");
      expect(nodeRadiusBody).toContain('3 + Math.sqrt');
      expect(nodeRadiusBody).toContain('* 0.8');
    });

    it("member branch: radius is 2.5", () => {
      expect(nodeRadiusBody).toContain("__cat === 'member'");
      expect(nodeRadiusBody).toContain('2.5');
    });

    it('haze branch: default return is 2 (not 2.5 or any other value)', () => {
      // The haze (default) branch is the bare `return 2;` fallthrough.
      // Use regex to confirm exactly 2 is returned, not 2.5 or 20 etc.
      expect(nodeRadiusBody).toMatch(/return 2[^.0-9]/);
    });

  });

  // ── 5. seedNodePositions brainVol branch — no Math.random (D-08) ─────────
  describe('seedNodePositions brainVol branch — no Math.random (D-08 determinism)', () => {

    // Extract the seedNodePositions function body: from the function signature
    // up to the next top-level function (_hashIndex), which follows immediately
    // after seedNodePositions in graph.js.
    const seedStart    = GRAPH.indexOf('function seedNodePositions');
    const hashIdxStart = GRAPH.indexOf('\nfunction _hashIndex', seedStart);
    const seedBody     = seedStart >= 0 && hashIdxStart >= 0
      ? GRAPH.slice(seedStart, hashIdxStart)
      : (seedStart >= 0 ? GRAPH.slice(seedStart, seedStart + 3000) : '');

    // Strip the null-brainVol fallback branch. The fallback is the early-return
    // block `if (!brainVol) { ... return; }`. Its closing sentinel is:
    //   "    return;\n  }" (4-space return + newline + 2-space if-block close)
    // Everything after that sentinel is the brainVol branch.
    const NULL_FALLBACK_SENTINEL = '    return;\n  }';
    const nullEndIdx = seedBody.indexOf(NULL_FALLBACK_SENTINEL);
    const brainVolBranch = nullEndIdx >= 0
      ? seedBody.slice(nullEndIdx + NULL_FALLBACK_SENTINEL.length)
      : seedBody;

    it('seedNodePositions brainVol branch is found in graph.js', () => {
      expect(seedStart).toBeGreaterThanOrEqual(0);
      expect(brainVolBranch.length).toBeGreaterThan(0);
    });

    it('brainVol branch contains NO Math.random (all randomness via _hashIndex, D-08)', () => {
      // The null-fallback branch may retain Math.random (excluded above).
      // The brainVol path must be fully deterministic for stable reloads (D-08).
      // Behavioral determinism is proven in tests/viz-seed-determinism.test.ts;
      // this guard catches accidental reintroduction of Math.random in the code.
      expect(brainVolBranch).not.toContain('Math.random');
    });

  });

  // ── 6. buildHazeLayer scatter — full-cell de-lattice (D-04, gap fix) ──────
  // The haze InstancedMesh renders the BULK of a large brain. Its scatter must
  // span the full inter-voxel cell (±cellHalf) like seedNodePositions/placeInHull,
  // NOT the old ±4-world-unit jitter that left a visible lattice. This guard
  // exists because 53-01 de-latticed seedNodePositions but missed this second
  // placement path — the actual source of the gridlines the founder reported.
  describe('buildHazeLayer scatter — full-cell continuous de-lattice (D-04)', () => {

    const hazeStart = GRAPH.indexOf('function buildHazeLayer(');
    const hazeClose = GRAPH.indexOf('\n}', hazeStart);
    const hazeBody  = hazeStart >= 0 && hazeClose >= 0
      ? GRAPH.slice(hazeStart, hazeClose + 2)
      : '';

    it('buildHazeLayer() body is present in graph.js', () => {
      expect(hazeStart).toBeGreaterThanOrEqual(0);
      expect(hazeBody.length).toBeGreaterThan(0);
    });

    it('uses cellHalf full-cell jitter (continuous, spans the inter-voxel cell)', () => {
      expect(hazeBody).toContain('cellHalf');
    });

    it('validates haze points in-hull via brainOccupied (no out-of-hull bleed)', () => {
      expect(hazeBody).toContain('brainOccupied(brainVol');
    });

    it('does NOT use the old ±4-unit ") * 8" lattice jitter (regression guard)', () => {
      // The old snap-to-voxel jitter was `(... - 0.5) * 8` (±4 world units),
      // far smaller than the voxel spacing → visible lattice. Must be gone.
      expect(hazeBody).not.toMatch(/-\s*0\.5\)\s*\*\s*8/);
    });

    it('contains no Math.random in the brainVol scatter (D-08 determinism)', () => {
      // The null-brainVol fallback (no occupied/rotMat) may retain trig scatter,
      // but the brainVol path must be deterministic. Slice to the else-fallback.
      const elseIdx = hazeBody.indexOf('} else {');
      const brainVolHaze = elseIdx >= 0 ? hazeBody.slice(0, elseIdx) : hazeBody;
      expect(brainVolHaze).not.toContain('Math.random');
    });

  });

});
