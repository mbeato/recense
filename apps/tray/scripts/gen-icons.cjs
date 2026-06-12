/**
 * gen-icons.cjs — Generate macOS tray icon assets using only Node.js built-ins.
 *
 * Produces four PNGs in apps/tray/src/icons/:
 *   iconTemplate.png       16x16  black+alpha glyph (macOS template: OS recolors via alpha)
 *   iconTemplate@2x.png    32x32  same glyph, @2x
 *   icon-active.png        16x16  amber #F59E0B filled glyph (non-template, pulse frame)
 *   icon-active@2x.png     32x32  same amber glyph, @2x
 *
 * Template images: macOS uses the alpha channel to determine the shape and recolors
 * the glyph black/white automatically for light/dark menu bars. They MUST be
 * black (RGB 0,0,0) + alpha — the color is defined by alpha, not RGB values.
 * Filename MUST end in 'Template' — macOS requires this for the auto-invert behavior.
 *
 * Pulse frames: amber RGB(245,158,11) = #F59E0B, fully opaque. Non-template filename.
 * Palette: amber activation only — no other hue. No synthetic activity.
 *
 * PNG encoding: 8-byte PNG signature + IHDR + IDAT + IEND. Each scanline has a
 * leading filter byte (0 = None). IDAT data is zlib-deflated. CRC32 per chunk.
 *
 * Self-validation: after writing each file, reads back and verifies:
 *   - PNG signature (8 bytes)
 *   - IHDR width and height match the expected dimensions
 * Exits non-zero on any mismatch.
 *
 * Usage: node scripts/gen-icons.cjs  (from apps/tray or repo root)
 */
'use strict';

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// CRC32 (per PNG spec — polynomial 0xEDB88320)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// PNG chunk builder
// ---------------------------------------------------------------------------

function makeChunk(type, data) {
  // type: 4-char ASCII string  data: Buffer
  const typeBytes = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.allocUnsafe(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBytes, data]);
  const crcBuf = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBytes, data, crcBuf]);
}

// ---------------------------------------------------------------------------
// IHDR chunk
// ---------------------------------------------------------------------------

function makeIHDR(width, height) {
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8]  = 8;  // bit depth
  ihdr[9]  = 6;  // colour type: RGBA
  ihdr[10] = 0;  // compression method
  ihdr[11] = 0;  // filter method
  ihdr[12] = 0;  // interlace method
  return makeChunk('IHDR', ihdr);
}

// ---------------------------------------------------------------------------
// Glyph drawing — filled rounded-square/dot shape
//
// Template icons: macOS determines shape from the alpha channel.
// The glyph is a filled rounded square (corner radius = ~20% of size).
// Template channels: R=0, G=0, B=0, alpha = glyph alpha.
// Active channels:  R=245, G=158, B=11 (amber #F59E0B), alpha = glyph alpha.
// ---------------------------------------------------------------------------

function glyphAlpha(x, y, size) {
  // Filled rounded square with a small inset margin.
  // margin: 1px for 16px, 2px for 32px
  const margin = size <= 16 ? 1 : 2;
  const radius = Math.round(size * 0.22);
  const x0 = margin;
  const y0 = margin;
  const x1 = size - 1 - margin;
  const y1 = size - 1 - margin;

  if (x < x0 || x > x1 || y < y0 || y > y1) return 0;

  // Corner rounding: check each corner quadrant
  // Top-left corner
  if (x < x0 + radius && y < y0 + radius) {
    const dx = x0 + radius - x;
    const dy = y0 + radius - y;
    if (dx * dx + dy * dy > radius * radius) return 0;
  }
  // Top-right corner
  if (x > x1 - radius && y < y0 + radius) {
    const dx = x - (x1 - radius);
    const dy = y0 + radius - y;
    if (dx * dx + dy * dy > radius * radius) return 0;
  }
  // Bottom-left corner
  if (x < x0 + radius && y > y1 - radius) {
    const dx = x0 + radius - x;
    const dy = y - (y1 - radius);
    if (dx * dx + dy * dy > radius * radius) return 0;
  }
  // Bottom-right corner
  if (x > x1 - radius && y > y1 - radius) {
    const dx = x - (x1 - radius);
    const dy = y - (y1 - radius);
    if (dx * dx + dy * dy > radius * radius) return 0;
  }

  return 255;
}

// ---------------------------------------------------------------------------
// Build RGBA pixel buffer for a given size and color mode
// ---------------------------------------------------------------------------

function buildRGBA(size, isTemplate) {
  // R, G, B for active (amber) vs template (black)
  const r = isTemplate ? 0 : 245;
  const g = isTemplate ? 0 : 158;
  const b = isTemplate ? 0 : 11;

  // Each scanline: filter byte (0) + width * 4 bytes RGBA
  const scanlineLen = 1 + size * 4;
  const raw = Buffer.allocUnsafe(size * scanlineLen);

  for (let y = 0; y < size; y++) {
    const rowOffset = y * scanlineLen;
    raw[rowOffset] = 0; // filter byte: None
    for (let x = 0; x < size; x++) {
      const alpha = glyphAlpha(x, y, size);
      const pixelOffset = rowOffset + 1 + x * 4;
      raw[pixelOffset]     = r;
      raw[pixelOffset + 1] = g;
      raw[pixelOffset + 2] = b;
      raw[pixelOffset + 3] = alpha;
    }
  }

  return raw;
}

// ---------------------------------------------------------------------------
// Encode full PNG
// ---------------------------------------------------------------------------

function encodePNG(size, isTemplate) {
  const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = makeIHDR(size, size);

  const rawPixels = buildRGBA(size, isTemplate);
  const compressed = zlib.deflateSync(rawPixels, { level: 9 });
  const idat = makeChunk('IDAT', compressed);
  const iend = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([PNG_SIG, ihdr, idat, iend]);
}

// ---------------------------------------------------------------------------
// Self-validation: parse back the PNG we just wrote and check signature + IHDR
// ---------------------------------------------------------------------------

function validatePNG(filePath, expectedWidth, expectedHeight) {
  const data = fs.readFileSync(filePath);

  // Check 8-byte PNG signature: 89 50 4e 47 0d 0a 1a 0a
  const expected = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (data[i] !== expected[i]) {
      throw new Error(`${filePath}: invalid PNG signature at byte ${i} (got ${data[i]}, expected ${expected[i]})`);
    }
  }

  // IHDR starts at byte 8: 4-byte length + 4-byte type + 13-byte data
  // Width is at offset 16 (8 sig + 4 len + 4 type), Height at offset 20
  const width  = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);

  if (width !== expectedWidth) {
    throw new Error(`${filePath}: IHDR width mismatch (got ${width}, expected ${expectedWidth})`);
  }
  if (height !== expectedHeight) {
    throw new Error(`${filePath}: IHDR height mismatch (got ${height}, expected ${expectedHeight})`);
  }

  process.stdout.write(`  PASS ${path.basename(filePath)}: ${width}x${height} valid PNG signature + IHDR\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Resolve output directory relative to this script's location
const scriptDir = path.dirname(__filename);
const iconsDir  = path.join(scriptDir, '..', 'src', 'icons');

fs.mkdirSync(iconsDir, { recursive: true });

const assets = [
  { name: 'iconTemplate.png',    size: 16, isTemplate: true  },
  { name: 'iconTemplate@2x.png', size: 32, isTemplate: true  },
  { name: 'icon-active.png',     size: 16, isTemplate: false },
  { name: 'icon-active@2x.png',  size: 32, isTemplate: false },
];

process.stdout.write('Generating tray icon assets...\n');

let hadError = false;

for (const asset of assets) {
  const outPath = path.join(iconsDir, asset.name);
  try {
    const png = encodePNG(asset.size, asset.isTemplate);
    fs.writeFileSync(outPath, png);
    process.stdout.write(`  WROTE ${asset.name} (${asset.size}x${asset.size})\n`);
  } catch (err) {
    process.stderr.write(`ERROR writing ${asset.name}: ${err}\n`);
    hadError = true;
  }
}

if (hadError) {
  process.exit(1);
}

// Self-validate
process.stdout.write('Validating...\n');

try {
  validatePNG(path.join(iconsDir, 'iconTemplate.png'),    16, 16);
  validatePNG(path.join(iconsDir, 'iconTemplate@2x.png'), 32, 32);
  validatePNG(path.join(iconsDir, 'icon-active.png'),     16, 16);
  validatePNG(path.join(iconsDir, 'icon-active@2x.png'),  32, 32);
} catch (err) {
  process.stderr.write('VALIDATION FAILED: ' + err.message + '\n');
  process.exit(1);
}

process.stdout.write('Done. All four icon assets valid.\n');
