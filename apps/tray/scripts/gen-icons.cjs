/**
 * gen-icons.cjs — Derive dim (server-offline) tray icon variants from the
 * hand-crafted brand assets, using only Node.js built-ins.
 *
 * Contract:
 *   The four brand PNGs in apps/tray/src/icons/ are hand-crafted canonical
 *   assets that this script READS but NEVER WRITES:
 *     iconTemplate.png        16x16  brain mark, black+alpha (macOS template)
 *     iconTemplate@2x.png     32x32  same mark, @2x
 *     icon-active.png         16x16  amber active mark (non-template)
 *     icon-active@2x.png      32x32  same, @2x
 *
 *   The script's ONLY outputs are the two dim variants, derived by
 *   multiplying the source alpha channel by 0.4 (D-05 server-offline
 *   dim state):
 *     iconDimTemplate.png     16x16  derived from iconTemplate.png
 *     iconDimTemplate@2x.png  32x32  derived from iconTemplate@2x.png
 *
 * Template images: macOS uses the alpha channel to determine the shape and
 * recolors the glyph black/white automatically for light/dark menu bars.
 * Filename MUST end in 'Template' — macOS requires this for the auto-invert
 * behavior. Because the shape comes from alpha, scaling alpha by 0.4
 * produces a faded (dim) rendering of the same brain mark.
 *
 * PNG decoding: requires 8-bit RGBA non-interlaced sources (bit depth 8,
 * colour type 6, compression 0, filter method 0, interlace 0) and fails
 * loudly otherwise — no fallback. All five standard scanline filters
 * (None/Sub/Up/Average/Paeth) are unfiltered.
 *
 * Self-validation: after writing each dim file, reads it back and verifies:
 *   - PNG signature + IHDR dimensions match the decoded source
 *   - max alpha equals Math.round(0.4 * source max alpha)
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
// PNG decoder — strict 8-bit RGBA non-interlaced only (fail loudly otherwise)
// ---------------------------------------------------------------------------

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function decodePNG(buffer, label) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error(`${label}: invalid PNG signature`);
  }

  let width = 0;
  let height = 0;
  const idatParts = [];
  let offset = 8;

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) {
      throw new Error(`${label}: truncated chunk '${type}' at offset ${offset}`);
    }

    if (type === 'IHDR') {
      width  = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      const bitDepth    = buffer[dataStart + 8];
      const colourType  = buffer[dataStart + 9];
      const compression = buffer[dataStart + 10];
      const filterMeth  = buffer[dataStart + 11];
      const interlace   = buffer[dataStart + 12];
      if (bitDepth !== 8)    throw new Error(`${label}: unsupported bit depth ${bitDepth} (expected 8)`);
      if (colourType !== 6)  throw new Error(`${label}: unsupported colour type ${colourType} (expected 6 = RGBA)`);
      if (compression !== 0) throw new Error(`${label}: unsupported compression method ${compression} (expected 0)`);
      if (filterMeth !== 0)  throw new Error(`${label}: unsupported filter method ${filterMeth} (expected 0)`);
      if (interlace !== 0)   throw new Error(`${label}: unsupported interlace method ${interlace} (expected 0 = non-interlaced)`);
    } else if (type === 'IDAT') {
      idatParts.push(buffer.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }

    offset = dataEnd + 4; // skip CRC
  }

  if (width === 0 || height === 0) {
    throw new Error(`${label}: missing or empty IHDR`);
  }
  if (idatParts.length === 0) {
    throw new Error(`${label}: no IDAT chunks found`);
  }

  const raw = zlib.inflateSync(Buffer.concat(idatParts));

  // Unfilter scanlines: each row is 1 filter byte + width*4 RGBA bytes
  const bpp = 4;
  const rowLen = width * bpp;
  const expectedRaw = height * (1 + rowLen);
  if (raw.length !== expectedRaw) {
    throw new Error(`${label}: decompressed size ${raw.length} != expected ${expectedRaw}`);
  }

  const pixels = Buffer.alloc(height * rowLen);

  for (let y = 0; y < height; y++) {
    const filterType = raw[y * (1 + rowLen)];
    const srcRow = y * (1 + rowLen) + 1;
    const dstRow = y * rowLen;

    for (let x = 0; x < rowLen; x++) {
      const rawByte = raw[srcRow + x];
      const left = x >= bpp ? pixels[dstRow + x - bpp] : 0;
      const up   = y > 0 ? pixels[dstRow - rowLen + x] : 0;
      const upLeft = (y > 0 && x >= bpp) ? pixels[dstRow - rowLen + x - bpp] : 0;

      let value;
      switch (filterType) {
        case 0: // None
          value = rawByte;
          break;
        case 1: // Sub
          value = rawByte + left;
          break;
        case 2: // Up
          value = rawByte + up;
          break;
        case 3: // Average
          value = rawByte + Math.floor((left + up) / 2);
          break;
        case 4: { // Paeth
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const pred = (pa <= pb && pa <= pc) ? left : (pb <= pc ? up : upLeft);
          value = rawByte + pred;
          break;
        }
        default:
          throw new Error(`${label}: unknown scanline filter type ${filterType} at row ${y}`);
      }
      pixels[dstRow + x] = value & 0xff;
    }
  }

  return { width, height, pixels };
}

// ---------------------------------------------------------------------------
// Encode raw RGBA pixels back into a PNG (filter byte 0 per row)
// ---------------------------------------------------------------------------

function encodeRGBA(width, height, pixels) {
  const rowLen = width * 4;
  const raw = Buffer.allocUnsafe(height * (1 + rowLen));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + rowLen)] = 0; // filter byte: None
    pixels.copy(raw, y * (1 + rowLen) + 1, y * rowLen, (y + 1) * rowLen);
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    PNG_SIG,
    makeIHDR(width, height),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Dim derivation: copy RGB, scale alpha by DIM_ALPHA_SCALE
// ---------------------------------------------------------------------------

const DIM_ALPHA_SCALE = 0.4;

function maxAlpha(pixels) {
  let max = 0;
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] > max) max = pixels[i];
  }
  return max;
}

function deriveDim(srcPath, outPath, expectedSize) {
  if (!fs.existsSync(srcPath)) {
    throw new Error(`source brand asset missing: ${srcPath} — hand-crafted brand PNGs must exist; this script never creates them`);
  }
  const src = decodePNG(fs.readFileSync(srcPath), path.basename(srcPath));

  if (src.width !== expectedSize || src.height !== expectedSize) {
    throw new Error(`${path.basename(srcPath)}: expected ${expectedSize}x${expectedSize} source, got ${src.width}x${src.height}`);
  }

  const dim = Buffer.from(src.pixels); // copies R/G/B/A; we rescale A below
  for (let i = 3; i < dim.length; i += 4) {
    dim[i] = Math.round(dim[i] * DIM_ALPHA_SCALE);
  }

  fs.writeFileSync(outPath, encodeRGBA(src.width, src.height, dim));
  process.stdout.write(`  WROTE ${path.basename(outPath)} (${src.width}x${src.height}, derived from ${path.basename(srcPath)})\n`);

  return { srcMaxAlpha: maxAlpha(src.pixels), width: src.width, height: src.height };
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

function validateDim(filePath, source) {
  validatePNG(filePath, source.width, source.height);

  const dim = decodePNG(fs.readFileSync(filePath), path.basename(filePath));
  if (dim.width !== source.width || dim.height !== source.height) {
    throw new Error(`${filePath}: decoded dimensions ${dim.width}x${dim.height} != source ${source.width}x${source.height}`);
  }

  const expectedMax = Math.round(DIM_ALPHA_SCALE * source.srcMaxAlpha);
  const actualMax = maxAlpha(dim.pixels);
  if (actualMax !== expectedMax) {
    throw new Error(`${filePath}: max alpha ${actualMax} != expected ${expectedMax} (= round(${DIM_ALPHA_SCALE} * ${source.srcMaxAlpha}))`);
  }

  process.stdout.write(`  PASS ${path.basename(filePath)}: max alpha ${actualMax} = round(${DIM_ALPHA_SCALE} * source max ${source.srcMaxAlpha})\n`);
}

// ---------------------------------------------------------------------------
// Main: derive the two dim variants from the hand-crafted brand templates
// ---------------------------------------------------------------------------

const scriptDir = path.dirname(__filename);
const iconsDir  = path.join(scriptDir, '..', 'src', 'icons');

const derivations = [
  { src: 'iconTemplate.png',    out: 'iconDimTemplate.png',    size: 16 },
  { src: 'iconTemplate@2x.png', out: 'iconDimTemplate@2x.png', size: 32 },
];

process.stdout.write('Deriving dim tray icon variants from brand assets...\n');

try {
  for (const d of derivations) {
    const source = deriveDim(path.join(iconsDir, d.src), path.join(iconsDir, d.out), d.size);
    validateDim(path.join(iconsDir, d.out), source);
  }
} catch (err) {
  process.stderr.write('FAILED: ' + err.message + '\n');
  process.exit(1);
}

process.stdout.write('Done. Both dim icon assets derived and valid.\n');
