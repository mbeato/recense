// src/viz/modules/corpus-layout.js
//
// Pure, deterministic 2D force layout for the corpus doc-graph. No DOM, no THREE,
// no Math.random — initial positions are seeded deterministically on a ring by index
// so the same graph always lays out identically (and the layout is unit-testable in
// the node test env). Returns plane coordinates as {x, z} (the y=0 floor plane in 3D).

const DEFAULTS = {
  ticks: 200,
  charge: -30,
  linkDist: 14,
  linkStrength: 0.08,
  center: 0.04,
  collide: 8,
  ringRadius: 20,
};

export function layoutCorpus(nodes, links, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const n = nodes.length;
  const pos = new Map();
  if (n === 0) return pos;
  if (n === 1) { pos.set(nodes[0].id, { x: 0, z: 0 }); return pos; }

  const P = nodes.map((node, i) => {
    const a = (i / n) * Math.PI * 2;
    return { id: node.id, x: Math.cos(a) * o.ringRadius, z: Math.sin(a) * o.ringRadius, vx: 0, vz: 0 };
  });
  const idx = new Map(P.map((p, i) => [p.id, i]));
  const L = links
    .map((l) => [idx.get(typeof l.source === 'object' ? l.source.id : l.source),
                 idx.get(typeof l.target === 'object' ? l.target.id : l.target)])
    .filter(([a, b]) => a != null && b != null);

  for (let t = 0; t < o.ticks; t++) {
    const alpha = 1 - t / o.ticks;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = P[i].x - P[j].x, dz = P[i].z - P[j].z;
        let dist2 = dx * dx + dz * dz || 0.01;
        const f = (o.charge * alpha) / dist2;
        const dist = Math.sqrt(dist2);
        const ux = dx / dist, uz = dz / dist;
        P[i].vx -= ux * f; P[i].vz -= uz * f;
        P[j].vx += ux * f; P[j].vz += uz * f;
        if (dist < o.collide) {
          const push = (o.collide - dist) * 0.5;
          P[i].vx += ux * push; P[i].vz += uz * push;
          P[j].vx -= ux * push; P[j].vz -= uz * push;
        }
      }
    }
    for (const [a, b] of L) {
      let dx = P[b].x - P[a].x, dz = P[b].z - P[a].z;
      const dist = Math.hypot(dx, dz) || 0.01;
      const f = (dist - o.linkDist) * o.linkStrength * alpha;
      const ux = dx / dist, uz = dz / dist;
      P[a].vx += ux * f; P[a].vz += uz * f;
      P[b].vx -= ux * f; P[b].vz -= uz * f;
    }
    for (const p of P) {
      p.vx -= p.x * o.center * alpha; p.vz -= p.z * o.center * alpha;
      p.x += p.vx; p.z += p.vz;
      p.vx *= 0.6; p.vz *= 0.6;
    }
  }

  const cx = P.reduce((s, p) => s + p.x, 0) / n;
  const cz = P.reduce((s, p) => s + p.z, 0) / n;
  for (const p of P) pos.set(p.id, { x: p.x - cx, z: p.z - cz });
  return pos;
}
