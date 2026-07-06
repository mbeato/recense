/**
 * tests/viz-activity-palette-invariants.test.ts
 *
 * Phase 57 Plan 01 — dedicated invariants file (D-12) that owns all Phase-57
 * palette/motion locks. Seeded here with the D-10 shared-source-sync invariant
 * (subsumes the never-written WR-02 lock); later Phase-57 plans extend this file
 * with luminance-band membership, dim floors, and per-channel monotonic SC3
 * ordering checks.
 *
 * Mirrors:
 *   - tests/viz-ambient-liveliness.test.ts — readFileSync/stripComments source-parse
 *     harness (readConstantsJs/readServer + export-const regex convention).
 *   - tests/spontaneous-idle-activation.test.ts — marker-slice static-guard style.
 *
 * D-10 shared source of truth: src/viz/modules/constants.js is the SOLE authored
 * home of every scheduler scalar the viz server needs; src/viz/server.ts derives
 * them via source-parse at startVizServer init (see parseSchedulerScalars()) and
 * never re-declares an independent literal. This test locks that structurally —
 * it fails if a scheduler literal is ever re-added to server.ts, or if a scalar's
 * value in server.ts's parse target ever diverges from constants.js.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseSchedulerScalars } from '../src/viz/server';

const ROOT = path.resolve(__dirname, '..');
const MODULES_ROOT = path.resolve(ROOT, 'src/viz/modules');

function readConstantsJs(): string {
  return fs.readFileSync(path.resolve(ROOT, 'src/viz/modules/constants.js'), 'utf8');
}

function readServer(): string {
  return fs.readFileSync(path.resolve(ROOT, 'src/viz/server.ts'), 'utf8');
}

function readCssTokensJs(): string {
  return fs.readFileSync(path.resolve(ROOT, 'src/viz/modules/css-tokens.js'), 'utf8');
}

function readStylesCss(): string {
  return fs.readFileSync(path.resolve(ROOT, 'src/viz/css/styles.css'), 'utf8');
}

/** Strip JSDoc inner lines and standalone comment lines before token assertions. */
function stripComments(src: string): string {
  return src.split('\n').filter(line => !/^\s*(\*|\/\/)/.test(line)).join('\n');
}

/** The seven scheduler scalars migrated to a single authored home in constants.js (D-10). */
const SCHEDULER_SCALAR_NAMES = [
  'REPLAY_IDLE_GAP_MS',
  'REPLAY_CADENCE_MS',
  'REPLAY_HISTORY_N',
  'SPONT_CADENCE_MS',
  'SPONT_SEED_COUNT',
  'SPONT_HOP_TOPN',
  'SPONT_POOL_REFRESH_MS',
] as const;

describe('D-10 shared source of truth', () => {
  const constantsSrc = readConstantsJs();
  const serverSrc = readServer();
  const serverSrcNoComments = stripComments(serverSrc);

  describe('Test A: WR-01 anti-duplication lock', () => {
    for (const name of SCHEDULER_SCALAR_NAMES) {
      it(`server.ts does not re-declare a literal for ${name}`, () => {
        // A bare `const NAME = <number>` re-declaration is exactly the WR-01 mirror-drift
        // shape being killed — the name may still appear as a destructured/derived binding
        // from parseSchedulerScalars(), which does not match this literal-assignment pattern.
        const literalRedeclaration = new RegExp(`const\\s+${name}\\s*=\\s*[\\d.]+`);
        expect(serverSrcNoComments).not.toMatch(literalRedeclaration);
      });
    }
  });

  describe('Test B: single-source presence', () => {
    for (const name of SCHEDULER_SCALAR_NAMES) {
      it(`constants.js declares ${name} exactly once as an export const`, () => {
        const matches = constantsSrc.match(new RegExp(`export\\s+const\\s+${name}\\s*=`, 'g'));
        expect(matches).not.toBeNull();
        expect(matches).toHaveLength(1);
      });
    }
  });

  describe('Test C: runtime sync (red-if-drift guard)', () => {
    /**
     * Parse a named scalar's numeric value directly out of constants.js's source text,
     * using the same export-const regex convention server.ts's parseSchedulerScalars() uses.
     */
    function parseFromConstantsJs(name: string): number {
      const match = constantsSrc.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*([\\d.]+)`));
      expect(match).not.toBeNull();
      return Number(match![1]);
    }

    // Call the REAL parse mechanism server.ts uses at startVizServer init, against the
    // real constants.js file — proving the two consumption paths (this direct regex check
    // vs. server.ts's own parseSchedulerScalars()) can never silently diverge.
    const parsedByServer = parseSchedulerScalars(MODULES_ROOT);

    it('REPLAY_CADENCE_MS: the value server.ts parses equals constants.js', () => {
      expect(parsedByServer.REPLAY_CADENCE_MS).toBe(parseFromConstantsJs('REPLAY_CADENCE_MS'));
    });

    it('SPONT_HOP_TOPN: the value server.ts parses equals constants.js', () => {
      expect(parsedByServer.SPONT_HOP_TOPN).toBe(parseFromConstantsJs('SPONT_HOP_TOPN'));
    });
  });

  describe('static: server.ts derives scheduler scalars from constants.js', () => {
    it('contains a readFileSync call resolving modules/constants.js', () => {
      expect(serverSrc).toMatch(/readFileSync.*constants\.js/);
    });
  });
});

// =============================================================================
// D-02 luminance-band membership (Phase 57 Plan 02)
// =============================================================================
// The 56-05 lesson generalized: saturated indigo (Y≈138) vanished on the dark bg
// once dimmed; pastel lavender (Y≈193) survived. Every KIND_COLOR identity hue
// must sit inside a machine-tested luminance band so dimming never drives a
// layer below the perceptual floor.

/** Relative luminance, Rec.709 weights, on 0-255 channels (the chosen D-02 metric). */
function relativeLuminance(hex: number): number {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// LOCKED at Stage 1 (57-03, D-09) — the founder reviewed every identity hue
// live over the real hull and approved the palette AS-IS (2026-07-03). Bounds
// are ratcheted to enclose the actual approved-palette luminance range
// (observed min: oscillation Y≈172.16; observed max: replay Y≈224.53) with a
// small documented tolerance (~2-3 Y units) rather than the wider provisional
// anchor. Y_MIN kept at 170 (already ~2 units below the tightest approved hue,
// oscillation); Y_MAX tightened from 235 → 228 (~3 units above the highest
// approved hue, replay).
const Y_MIN = 170;
const Y_MAX = 228;

/** All eight activity identity hues (Phase-57 D-01 scope: the 7 existing
 *  KIND_COLOR entries plus the new `replay` identity hue). */
const IDENTITY_KEYS = [
  'recall_seed',
  'recall_hop',
  'new_node',
  'reconsolidation',
  'oscillation',
  'neutral',
  'spontaneous',
  'replay',
] as const;

describe('D-02 luminance-band membership', () => {
  const constantsSrc = readConstantsJs();

  /** Parse a KIND_COLOR entry's hex literal directly out of constants.js source text. */
  function parseKindColorHex(key: string): number {
    const match = constantsSrc.match(new RegExp(`\\b${key}:\\s*0x([0-9a-fA-F]+)`));
    expect(match, `KIND_COLOR.${key} not found in constants.js`).not.toBeNull();
    return parseInt(match![1]!, 16);
  }

  for (const key of IDENTITY_KEYS) {
    it(`KIND_COLOR.${key} computed luminance falls inside [${Y_MIN}, ${Y_MAX}]`, () => {
      const hex = parseKindColorHex(key);
      const y = relativeLuminance(hex);
      expect(y).toBeGreaterThanOrEqual(Y_MIN);
      expect(y).toBeLessThanOrEqual(Y_MAX);
    });
  }
});

// =============================================================================
// D-06 motion-profile SC3 ordering + D-05 dim floors (Phase 57 Plan 04)
// =============================================================================
// Salience ordering (live > replay > spontaneous > twinkle) now lives on
// motion/scale (D-06), not brightness. This section locks:
//   - monotonic attack-sharpness ordering (smaller ms = sharper = more salient)
//   - monotonic halo/scale ordering (bigger = more salient)
//   - dim-factor floors (REPLAY_DIM / SPONT_DIM must stay >= a perceptual floor)
//   - the WR-02 SPONT_DIM < REPLAY_DIM ordering lock (56-REVIEW.md), migrated in
//     alongside the REPLAY_DIM < 1 lock previously in
//     viz-ambient-liveliness.test.ts:482-489 (Phase 54) — D-12 consolidation.
//
// RATCHETED at Stage-2 (57-07, D-09): the founder tuned the full system live
// over the real hull and approved every motion-profile/floor value AS-IS
// (2026-07-03) — no attack-ms/halo-scale/dim-factor values changed from their
// 57-04-authored state; FLOOR_BOUND below is updated from PROVISIONAL to
// ratcheted/locked (see its own JSDoc for the exact rationale).

/** Perceptual dim-factor floor (D-05) — every subordinate-layer dim factor
 *  must stay >= this fraction of live brightness on the dark bg now that a
 *  luminance-equalized hue sits underneath it. RATCHETED at Stage-2 (57-07,
 *  D-09): the founder approved the full system as-is (2026-07-03) with
 *  REPLAY_DIM=0.7 / SPONT_DIM=0.6 unchanged — 0.6 is already the tightest
 *  possible bound (it equals the approved SPONT_DIM exactly, the dimmest
 *  locked layer), so no numeric change was needed, only this status update
 *  from PROVISIONAL to ratcheted/locked. */
const FLOOR_BOUND = 0.6;

describe('D-06 motion-profile SC3 ordering + D-05 dim floors', () => {
  const constantsSrc = readConstantsJs();

  /** Parse a named export-const numeric value directly out of constants.js source text. */
  function parseConst(name: string): number {
    const match = constantsSrc.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*([\\d.]+)`));
    expect(match, `${name} not found in constants.js`).not.toBeNull();
    return parseFloat(match![1]!);
  }

  describe('monotonic attack-sharpness ordering (smaller ms = sharper)', () => {
    it('LIVE < REPLAY < SPONT < TWINKLE (attack ms)', () => {
      const live = parseConst('DECAY_ATTACK_MS');
      const replay = parseConst('REPLAY_ATTACK_MS');
      const spont = parseConst('SPONT_ATTACK_MS');
      const twinkle = parseConst('TWINKLE_ATTACK_MS');
      expect(live).toBeLessThan(replay);
      expect(replay).toBeLessThan(spont);
      expect(spont).toBeLessThan(twinkle);
    });
  });

  describe('monotonic halo/scale ordering (bigger = more salient)', () => {
    it('LIVE > REPLAY > SPONT > TWINKLE (halo/scale)', () => {
      const live = parseConst('LIVE_HALO_SCALE');
      const replay = parseConst('REPLAY_HALO_SCALE');
      const spont = parseConst('SPONT_HALO_SCALE');
      const twinkle = parseConst('TWINKLE_HALO_SCALE');
      expect(live).toBeGreaterThan(replay);
      expect(replay).toBeGreaterThan(spont);
      expect(spont).toBeGreaterThan(twinkle);
    });
  });

  describe('dim floors (D-05)', () => {
    it('REPLAY_DIM >= FLOOR_BOUND', () => {
      expect(parseConst('REPLAY_DIM')).toBeGreaterThanOrEqual(FLOOR_BOUND);
    });

    it('SPONT_DIM >= FLOOR_BOUND', () => {
      expect(parseConst('SPONT_DIM')).toBeGreaterThanOrEqual(FLOOR_BOUND);
    });
  });

  describe('WR-02 + SC3 dim ordering (migrated from viz-ambient-liveliness.test.ts)', () => {
    it('SPONT_DIM < REPLAY_DIM (56-REVIEW.md WR-02 — spontaneous is the dimmest activity layer)', () => {
      expect(parseConst('SPONT_DIM')).toBeLessThan(parseConst('REPLAY_DIM'));
    });

    it('REPLAY_DIM < 1 (replay can never escalate above live — SC3; migrated from viz-ambient-liveliness.test.ts)', () => {
      expect(parseConst('REPLAY_DIM')).toBeLessThan(1);
    });
  });
});

// =============================================================================
// D-15 label color lock (Phase 58 Plan 03)
// =============================================================================
// labels.js's schema-label SDF text uses LABEL_COLOR — a standalone constant
// (not part of KIND_COLOR), locked here with the same D-02 luminance-band
// harness plus a non-amber-family check (D-03(b) reasoning: amber is a
// warm-orange signature, R≈G>B; the label slate must stay cool, B>G>R).

describe('D-15 label color lock', () => {
  const constantsSrc = readConstantsJs();

  /** Parse LABEL_COLOR's hex literal directly out of constants.js source text. */
  function parseLabelColorHex(): number {
    const match = constantsSrc.match(/export\s+const\s+LABEL_COLOR\s*=\s*0x([0-9a-fA-F]+)/);
    expect(match, 'LABEL_COLOR not found in constants.js').not.toBeNull();
    return parseInt(match![1]!, 16);
  }

  it('LABEL_COLOR computed luminance falls inside [Y_MIN, Y_MAX]', () => {
    const y = relativeLuminance(parseLabelColorHex());
    expect(y).toBeGreaterThanOrEqual(Y_MIN);
    expect(y).toBeLessThanOrEqual(Y_MAX);
  });

  it('LABEL_COLOR is NOT amber-family (cool slate: B > G > R, opposite of amber R≈G>B)', () => {
    const hex = parseLabelColorHex();
    const r = (hex >> 16) & 0xff;
    const g = (hex >> 8) & 0xff;
    const b = hex & 0xff;
    expect(b).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(r);
  });
});

// =============================================================================
// D-11 shared motion tokens + D-10 HUD token single source (Phase 59 Plan 01)
// =============================================================================
// HUD_CSS_TOKENS in constants.js is the single authored home for the glass/
// radius/motion recipe (59-UI-SPEC.md); css-tokens.js's emitHudTokens() is
// the sole JS→CSS consumer, injecting a runtime `:root` block. These locks
// guard the D-11 motion-token values and the D-10 single-source rule: no
// glass/radius/motion/ease token value may ever be re-declared as a hardcoded
// literal in styles.css (--index-width is the one grandfathered exception,
// predating this token system).

/** Extract the HUD_CSS_TOKENS object-literal body out of constants.js source text. */
function extractHudCssTokensBlock(constantsSrc: string): string {
  const match = constantsSrc.match(/export\s+const\s+HUD_CSS_TOKENS\s*=\s*\{([\s\S]*?)\n\};/);
  expect(match, 'HUD_CSS_TOKENS block not found in constants.js').not.toBeNull();
  return match![1]!;
}

/** Parse a single HUD_CSS_TOKENS entry's string value directly out of its source text. */
function parseHudToken(block: string, key: string): string {
  const match = block.match(new RegExp(`'${key}':\\s*'([^']*)'`));
  expect(match, `HUD_CSS_TOKENS['${key}'] not found`).not.toBeNull();
  return match![1]!;
}

describe('D-11 shared motion tokens', () => {
  const constantsSrc = readConstantsJs();
  const block = extractHudCssTokensBlock(constantsSrc);

  it('HUD_CSS_TOKENS declares ease-out-soft, motion-fast, motion-base, motion-slow', () => {
    for (const key of ['ease-out-soft', 'motion-fast', 'motion-base', 'motion-slow']) {
      expect(block).toMatch(new RegExp(`'${key}':`));
    }
  });

  it("ease-out-soft equals 'cubic-bezier(0.22, 1, 0.36, 1)' (no bounce/overshoot)", () => {
    expect(parseHudToken(block, 'ease-out-soft')).toBe('cubic-bezier(0.22, 1, 0.36, 1)');
  });
});

describe('D-10 HUD token single source', () => {
  const cssTokensSrc = readCssTokensJs();
  const stylesSrc = readStylesCss();

  it('css-tokens.js imports HUD_CSS_TOKENS from constants.js (single source)', () => {
    expect(cssTokensSrc).toMatch(/import\s*\{\s*HUD_CSS_TOKENS\s*\}\s*from\s*['"]\.\/constants\.js['"]/);
  });

  it('css-tokens.js emits a :root block and does not re-declare a token value as its own literal', () => {
    expect(cssTokensSrc).toMatch(/:root/);
    expect(cssTokensSrc).not.toMatch(/--glass-bg-ambient:\s*rgba/);
    expect(cssTokensSrc).not.toMatch(/--ease-out-soft:\s*cubic-bezier/);
  });

  it('styles.css does not hardcode a --glass-/--radius-/--motion-/--ease- custom-property declaration (runtime-injected only; --index-width grandfathered)', () => {
    const declarations = stylesSrc.match(/--(?:glass|radius|motion|ease)-[a-z-]*\s*:/g) ?? [];
    expect(declarations).toHaveLength(0);
  });
});
