#!/usr/bin/env python3
"""
Taubin-smooth a binary STL to reduce high-frequency cortical-fold amplitude
(the source of front/top silhouette stacking — VIZ-09) while preserving the
gross brain shape and side-view character. Dependency-free.

Taubin (lambda/mu) alternates a positive Laplacian step with a slightly larger
negative step, which low-pass-filters the surface WITHOUT the volumetric
shrinkage that plain Laplacian smoothing causes (brain would collapse to a ball).

Usage: smooth_hull.py <in.stl> <out.stl> [iterations] [lambda] [mu]
"""
import sys, struct

def read_stl(path):
    with open(path, 'rb') as f:
        data = f.read()
    n = struct.unpack('<I', data[80:84])[0]
    off = 84
    tris = []
    for _ in range(n):
        # 12 floats (normal + 3 verts) then 2-byte attr = 50 bytes
        vals = struct.unpack('<12f', data[off:off+48])
        v0 = (vals[3], vals[4], vals[5])
        v1 = (vals[6], vals[7], vals[8])
        v2 = (vals[9], vals[10], vals[11])
        tris.append((v0, v1, v2))
        off += 50
    return tris

def weld(tris, q=5):
    index = {}
    verts = []
    faces = []
    for tri in tris:
        idxs = []
        for v in tri:
            key = (round(v[0], q), round(v[1], q), round(v[2], q))
            i = index.get(key)
            if i is None:
                i = len(verts)
                index[key] = i
                verts.append([v[0], v[1], v[2]])
            idxs.append(i)
        faces.append(tuple(idxs))
    return verts, faces

def adjacency(verts, faces):
    nbrs = [set() for _ in verts]
    for a, b, c in faces:
        nbrs[a].add(b); nbrs[a].add(c)
        nbrs[b].add(a); nbrs[b].add(c)
        nbrs[c].add(a); nbrs[c].add(b)
    return [tuple(s) for s in nbrs]

def laplacian_step(pos, nbrs, factor):
    new = [None] * len(pos)
    for i, ns in enumerate(nbrs):
        p = pos[i]
        if not ns:
            new[i] = p
            continue
        sx = sy = sz = 0.0
        for j in ns:
            q = pos[j]; sx += q[0]; sy += q[1]; sz += q[2]
        k = len(ns)
        dx = sx / k - p[0]; dy = sy / k - p[1]; dz = sz / k - p[2]
        new[i] = (p[0] + factor * dx, p[1] + factor * dy, p[2] + factor * dz)
    return new

def bbox(pos):
    xs = [p[0] for p in pos]; ys = [p[1] for p in pos]; zs = [p[2] for p in pos]
    return (max(xs)-min(xs), max(ys)-min(ys), max(zs)-min(zs))

def cross(u, v):
    return (u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0])

def normal(a, b, c):
    u = (b[0]-a[0], b[1]-a[1], b[2]-a[2])
    v = (c[0]-a[0], c[1]-a[1], c[2]-a[2])
    n = cross(u, v)
    m = (n[0]*n[0]+n[1]*n[1]+n[2]*n[2]) ** 0.5
    if m == 0: return (0.0, 0.0, 0.0)
    return (n[0]/m, n[1]/m, n[2]/m)

def write_stl(path, pos, faces):
    out = bytearray()
    out += b'\x00' * 80
    out += struct.pack('<I', len(faces))
    for a, b, c in faces:
        va, vb, vc = pos[a], pos[b], pos[c]
        nx, ny, nz = normal(va, vb, vc)
        out += struct.pack('<12fH', nx, ny, nz,
                           va[0], va[1], va[2],
                           vb[0], vb[1], vb[2],
                           vc[0], vc[1], vc[2], 0)
    with open(path, 'wb') as f:
        f.write(out)

def main():
    inp, outp = sys.argv[1], sys.argv[2]
    iters = int(sys.argv[3]) if len(sys.argv) > 3 else 10
    lam = float(sys.argv[4]) if len(sys.argv) > 4 else 0.5
    mu = float(sys.argv[5]) if len(sys.argv) > 5 else -0.53
    tris = read_stl(inp)
    verts, faces = weld(tris)
    nbrs = adjacency(verts, faces)
    pos = [tuple(v) for v in verts]
    b0 = bbox(pos)
    for _ in range(iters):
        pos = laplacian_step(pos, nbrs, lam)
        pos = laplacian_step(pos, nbrs, mu)
    b1 = bbox(pos)
    write_stl(outp, pos, faces)
    print(f"triangles: {len(tris)} | unique verts: {len(verts)} (welded from {len(tris)*3})")
    print(f"Taubin: iters={iters} lambda={lam} mu={mu}")
    print(f"bbox before: ({b0[0]:.1f}, {b0[1]:.1f}, {b0[2]:.1f})")
    print(f"bbox after:  ({b1[0]:.1f}, {b1[1]:.1f}, {b1[2]:.1f})  (shrink %: "
          f"{100*(1-b1[0]/b0[0]):.1f}, {100*(1-b1[1]/b0[1]):.1f}, {100*(1-b1[2]/b0[2]):.1f})")

if __name__ == '__main__':
    main()
