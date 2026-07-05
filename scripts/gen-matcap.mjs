#!/usr/bin/env node
/**
 * gen-matcap — regenerate the committed focus-tier matcap texture.
 *
 * STANDALONE MANUAL DEV COMMAND.  Renders an analytic studio-lit sphere (three
 * Blinn-Phong lights, no external asset/CDN) to a single grayscale scalar per
 * pixel and encodes it as a PNG using only Node's built-in `zlib` — no
 * canvas/three.js/pngjs dependency, net-zero new deps (mirrors the
 * gen-simd-kernel.cjs convention of a regenerable-derived-asset script).
 *
 * MUST NOT run at install or build time (do NOT add to postinstall, prepare,
 * or postbuild) — this is a one-time asset-generation step, not a build step.
 *
 * D-15 matcap-grayscale lock: the render is grayscale BY CONSTRUCTION (a
 * single scalar brightness replicated to R=G=B per pixel), and is asserted
 * grayscale before writing. `--check` re-decodes the committed PNG and
 * re-asserts grayscale + byte-identity against a fresh render, so a hue can
 * never silently creep into this asset (the node shader multiplies this
 * texture by the node's own LOCKED-palette color — T-58-04).
 *
 * Usage:
 *   node scripts/gen-matcap.mjs           — regen the asset (writes file)
 *   node scripts/gen-matcap.mjs --check   — verify the committed PNG is
 *                                             grayscale + matches the
 *                                             generator output (no write)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outPath = join(root, 'src', 'viz', 'vendor', 'matcaps', 'focus-matcap.png');

const CHECK_MODE = process.argv.includes('--check');

// Square texture — plenty of resolution for a smooth radial gradient sampled
// by a per-fragment view-space normal; small enough to keep the committed
// asset tiny.
const SIZE = 256;

// Max per-pixel |R-G|/|G-B|/|R-B| — 0 in practice (R=G=B always assigned from
// the same scalar), kept as an explicit tolerance so the assertion documents
// intent rather than relying on exact-equality alone.
const GRAY_TOLERANCE = 2;

// ─── Analytic studio-lit grayscale sphere (D-09, D-15) ───────────────────────
// Standard matcap authoring technique: light a unit sphere viewed head-on
// (view direction fixed at +Z) with a small rig (key + fill + specular) and
// bake the result to a square texture, later sampled by
// `vViewNormal.xy * 0.5 + 0.5` in the node shader. Every term here collapses
// to ONE scalar per pixel — there is no per-channel branching, so the output
// is grayscale by construction, not by post-hoc filtering.
const AMBIENT      = 0.14;
const KEY_WEIGHT    = 0.55;
const FILL_WEIGHT   = 0.22;
const SPEC_WEIGHT   = 0.32;
const SPEC_POWER    = 20;

function normalize3([x, y, z]) {
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}
function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function add3(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

const VIEW_DIR = [0, 0, 1];
const KEY_DIR  = normalize3([0.45, 0.6, 0.66]);
const FILL_DIR = normalize3([-0.5, -0.25, 0.6]);
const HALF_DIR = normalize3(add3(KEY_DIR, VIEW_DIR)); // Blinn-Phong half-vector, key light

/** Brightness in [0,1] for a unit sphere normal (nx,ny,nz), nz>=0 (front-facing). */
function computeBrightness(nx, ny, nz) {
  const n = [nx, ny, nz];
  const diffKey  = Math.max(0, dot3(n, KEY_DIR));
  const diffFill = Math.max(0, dot3(n, FILL_DIR));
  const spec     = Math.pow(Math.max(0, dot3(n, HALF_DIR)), SPEC_POWER);
  const brightness = AMBIENT + diffKey * KEY_WEIGHT + diffFill * FILL_WEIGHT + spec * SPEC_WEIGHT;
  return Math.min(1, brightness);
}

/** Renders the full SIZE x SIZE RGB (R=G=B) pixel buffer. Pure/deterministic (D-08-style). */
function renderPixels() {
  const pixels = new Uint8Array(SIZE * SIZE * 3);
  const center = (SIZE - 1) / 2;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const nx = (x - center) / center;
      const ny = -(y - center) / center; // image y-down -> sphere y-up
      const r2 = nx * nx + ny * ny;
      const idx = (y * SIZE + x) * 3;
      let byte;
      if (r2 > 1) {
        byte = 0; // outside the sphere disc — never actually sampled by a real normal
      } else {
        const nz = Math.sqrt(Math.max(0, 1 - r2));
        byte = Math.round(computeBrightness(nx, ny, nz) * 255);
      }
      pixels[idx] = pixels[idx + 1] = pixels[idx + 2] = byte;
    }
  }
  return pixels;
}

// ─── Minimal PNG encode/decode (color type 2 = truecolor RGB, 8-bit, no
// interlace, filter type 0/None per scanline) — built on Node's builtin zlib
// only, no pngjs/canvas dependency. We control both encoder and decoder, so
// the decoder only needs to understand the shape this encoder produces
// (Sub/Up/Average/Paeth are still implemented for spec-correctness, but this
// encoder always emits None). ─────────────────────────────────────────────────

function crc32Table() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
}
const CRC_TABLE = crc32Table();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function encodePNG(pixels, size) {
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0); // width
  ihdrData.writeUInt32BE(size, 4); // height
  ihdrData[8]  = 8; // bit depth
  ihdrData[9]  = 2; // color type: truecolor RGB
  ihdrData[10] = 0; // compression method
  ihdrData[11] = 0; // filter method
  ihdrData[12] = 0; // interlace method: none

  const rowBytes = size * 3;
  const raw = Buffer.alloc(size * (1 + rowBytes));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + rowBytes);
    raw[rowStart] = 0; // filter type: None
    for (let x = 0; x < rowBytes; x++) {
      raw[rowStart + 1 + x] = pixels[y * rowBytes + x];
    }
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdrData),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Un-filter PNG scanlines (all 5 filter types) for an 8-bit, N-bytes-per-pixel image. */
function unfilterScanlines(raw, width, height, bpp) {
  const rowBytes = width * bpp;
  const out = Buffer.alloc(height * rowBytes);
  let prevRow = Buffer.alloc(rowBytes);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filterType = raw[pos]; pos += 1;
    const rowData = raw.subarray(pos, pos + rowBytes); pos += rowBytes;
    const outRow = Buffer.alloc(rowBytes);
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= bpp ? outRow[i - bpp] : 0;
      const b = prevRow[i];
      const c = i >= bpp ? prevRow[i - bpp] : 0;
      let val = rowData[i];
      switch (filterType) {
        case 0: break;
        case 1: val = (val + a) & 0xFF; break;
        case 2: val = (val + b) & 0xFF; break;
        case 3: val = (val + Math.floor((a + b) / 2)) & 0xFF; break;
        case 4: val = (val + paeth(a, b, c)) & 0xFF; break;
        default: throw new Error(`gen-matcap: unsupported PNG filter type ${filterType}`);
      }
      outRow[i] = val;
    }
    outRow.copy(out, y * rowBytes);
    prevRow = outRow;
  }
  return out;
}

function decodePNG(buf) {
  let offset = 8; // skip signature
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idatChunks = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 8 + length + 4; // length + type + data + crc
  }
  if (bitDepth !== 8 || colorType !== 2) {
    throw new Error(`gen-matcap: unexpected PNG format (bitDepth=${bitDepth}, colorType=${colorType}) — expected 8-bit truecolor RGB`);
  }
  const raw = inflateSync(Buffer.concat(idatChunks));
  const pixels = unfilterScanlines(raw, width, height, 3);
  return { width, height, pixels };
}

/** Throws if any pixel's R/G/B channels diverge beyond `tolerance` (D-15 grayscale lock). */
function assertGrayscale(pixels, size, tolerance) {
  for (let i = 0; i < size * size; i++) {
    const r = pixels[i * 3], g = pixels[i * 3 + 1], b = pixels[i * 3 + 2];
    if (Math.abs(r - g) > tolerance || Math.abs(g - b) > tolerance || Math.abs(r - b) > tolerance) {
      throw new Error(`gen-matcap: non-grayscale pixel at index ${i} (r=${r} g=${g} b=${b}) — D-15 lock violated`);
    }
  }
}

// ─── Entrypoint ───────────────────────────────────────────────────────────────

function main() {
  if (CHECK_MODE) {
    if (!existsSync(outPath)) {
      console.error('gen-matcap --check: missing committed asset at', outPath);
      process.exit(1);
    }
    const buf = readFileSync(outPath);
    let width, height, pixels;
    try {
      ({ width, height, pixels } = decodePNG(buf));
    } catch (err) {
      console.error('gen-matcap --check:', err.message);
      process.exit(1);
    }
    if (width !== SIZE || height !== SIZE) {
      console.error(`gen-matcap --check: size mismatch (committed ${width}x${height}, expected ${SIZE}x${SIZE})`);
      process.exit(1);
    }
    try {
      assertGrayscale(pixels, SIZE, GRAY_TOLERANCE);
    } catch (err) {
      console.error('gen-matcap --check:', err.message);
      process.exit(1);
    }
    const fresh = renderPixels();
    if (Buffer.compare(Buffer.from(pixels), Buffer.from(fresh)) !== 0) {
      console.error('gen-matcap --check: committed PNG has drifted from the generator output — run `node scripts/gen-matcap.mjs` to regenerate');
      process.exit(1);
    }
    console.log('gen-matcap --check: OK — grayscale, byte-identical to the generator');
    process.exit(0);
  }

  const pixels = renderPixels();
  assertGrayscale(pixels, SIZE, GRAY_TOLERANCE); // fail loudly BEFORE writing (D-15)
  const png = encodePNG(pixels, SIZE);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, png);
  console.log('gen-matcap: wrote', outPath, `(${png.length} bytes)`);
}

main();
