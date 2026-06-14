/**
 * tests/viz-lod-density.test.ts
 *
 * Phase 19 Item 2: adaptive density in src/viz/modules/lod.js.
 *
 * The overview renders only schema + haze (members hidden until expand/trace),
 * so screen fullness tracks overviewCount = #schema + #haze. lod.js adapts
 * AROUND a calibrated neutral band:
 *   - in-band (DENSITY_FILL_BELOW < overview < DENSITY_THIN_START): pure no-op —
 *     no members revealed, haze opacity scale 1.0 (founder's ~2,700 look intact).
 *   - sparse (overview < DENSITY_FILL_BELOW): reveal real hidden members up to
 *     DENSITY_FILL_TARGET, capped by how many members exist (never fabricates).
 *   - dense (overview > DENSITY_THIN_START): lerp haze opacity scale 1.0 → 0.35.
 *
 * lod.js is a browser ESM with zero imports operating only on ctx, so initLod
 * is exercised directly here — no DOM, no three.js.
 */
import { describe, it, expect } from 'vitest';
// @ts-ignore — browser ESM, no type declarations; exercised directly in node
import { initLod } from '../src/viz/modules/lod.js';
import {
  DENSITY_FILL_BELOW,
  DENSITY_FILL_TARGET,
  DENSITY_THIN_START,
  DENSITY_THIN_FULL,
  HAZE_DENSE_SCALE,
// @ts-ignore — browser ESM, no type declarations
} from '../src/viz/modules/constants.js';

type Node = { id: string; type: string };
type Link = { source: string; target: string; kind: string };

/**
 * Build a ctx for initLod from a spec of schemas (each with a member count) and
 * a count of free-floating haze nodes. Returns the ctx after classification.
 */
function buildCtx(spec: { schemas: number; membersPerSchema: number; haze: number }) {
  const allNodes: Node[] = [];
  const allLinks: Link[] = [];

  for (let s = 0; s < spec.schemas; s++) {
    const sid = `schema-${s}`;
    allNodes.push({ id: sid, type: 'schema' });
    for (let m = 0; m < spec.membersPerSchema; m++) {
      const mid = `member-${s}-${m}`;
      allNodes.push({ id: mid, type: 'fact' });
      allLinks.push({ source: sid, target: mid, kind: 'abstracts' });
    }
  }
  for (let h = 0; h < spec.haze; h++) {
    allNodes.push({ id: `haze-${h}`, type: 'fact' });
  }

  const idMap = new Map(allNodes.map(n => [n.id, n]));
  const ctx: any = { allNodes, allLinks, idMap };
  initLod(ctx);
  return ctx;
}

const overviewOf = (ctx: any) =>
  ctx.allNodes.filter((n: any) => n.__cat === 'schema' || n.__cat === 'haze').length;

describe('lod adaptive density', () => {
  it('is a pure no-op inside the neutral band (founder anchor untouched)', () => {
    // 10 schema + 800 haze = 810 overview → 600 < 810 < 3200
    const ctx = buildCtx({ schemas: 10, membersPerSchema: 5, haze: 800 });
    expect(overviewOf(ctx)).toBeGreaterThan(DENSITY_FILL_BELOW);
    expect(overviewOf(ctx)).toBeLessThan(DENSITY_THIN_START);

    expect(ctx.densityRevealed.size).toBe(0);
    expect(ctx.hazeOpacityScale).toBe(1);

    // a member stays hidden (no expand, no trace, no density reveal)
    const member = ctx.idMap.get('member-0-0');
    expect(ctx.nodeVisible(member)).toBe(false);
  });

  it('sparse: reveals ALL members when they fit under the fill target', () => {
    // 3 schema + 20 haze = 23 overview (< 600); 40 members total → all fit
    const ctx = buildCtx({ schemas: 3, membersPerSchema: 13, haze: 20 }); // 39 members
    expect(overviewOf(ctx)).toBeLessThan(DENSITY_FILL_BELOW);

    const totalMembers = ctx.allNodes.filter((n: any) => n.__cat === 'member').length;
    expect(ctx.densityRevealed.size).toBe(totalMembers);
    expect(ctx.hazeOpacityScale).toBe(1); // dimming is dense-only

    // a revealed member is now visible, and its link to the schema shows
    const member = ctx.idMap.get('member-0-0');
    expect(ctx.nodeVisible(member)).toBe(true);
    const abstractsLink = ctx.allLinks.find((l: any) => l.target === 'member-0-0');
    expect(ctx.linkVis(abstractsLink)).toBe(true);
  });

  it('sparse: caps reveals at the fill target when members are plentiful', () => {
    // 2 schema + 10 haze = 12 overview; 2000 members available → cap to target
    const ctx = buildCtx({ schemas: 2, membersPerSchema: 1000, haze: 10 });
    const overview = overviewOf(ctx);
    expect(overview).toBeLessThan(DENSITY_FILL_BELOW);

    expect(ctx.densityRevealed.size).toBe(DENSITY_FILL_TARGET - overview);
  });

  it('dense: lerps haze opacity scale down, reaching the floor at THIN_FULL', () => {
    // overview = haze only, >= DENSITY_THIN_FULL
    const atFloor = buildCtx({ schemas: 0, membersPerSchema: 0, haze: DENSITY_THIN_FULL });
    expect(overviewOf(atFloor)).toBe(DENSITY_THIN_FULL);
    expect(atFloor.hazeOpacityScale).toBeCloseTo(HAZE_DENSE_SCALE, 5);
    expect(atFloor.densityRevealed.size).toBe(0); // dense never reveals

    // midway between START and FULL → strictly between floor and 1
    const mid = buildCtx({
      schemas: 0,
      membersPerSchema: 0,
      haze: Math.round((DENSITY_THIN_START + DENSITY_THIN_FULL) / 2),
    });
    expect(mid.hazeOpacityScale).toBeGreaterThan(HAZE_DENSE_SCALE);
    expect(mid.hazeOpacityScale).toBeLessThan(1);
  });
});
