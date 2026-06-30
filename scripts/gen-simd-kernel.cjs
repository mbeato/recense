#!/usr/bin/env node
/**
 * gen-simd-kernel — regenerate the committed WASM SIMD cosine kernel blob.
 *
 * STANDALONE MANUAL DEV COMMAND.  Reads src/retrieval/simd-kernel.wat, assembles
 * it via wabt (devDependency), base64-encodes the bytes, and writes the generated
 * TypeScript module src/retrieval/simd-kernel-wasm.ts.
 *
 * MUST NOT run at install or build time (do NOT add to postinstall, prepare, or
 * postbuild).  wabt is a devDependency only — running it at install time would
 * force end-users to compile wabt on their machine and breaks D-04.
 *
 * Usage:
 *   node scripts/gen-simd-kernel.cjs           — regen the blob (writes file)
 *   node scripts/gen-simd-kernel.cjs --check   — verify committed blob matches WAT
 *                                                  and run cosine self-test (no write)
 */
'use strict';

const { readFileSync, writeFileSync, existsSync } = require('fs');
const { join } = require('path');

const root = join(__dirname, '..');
const watPath = join(root, 'src', 'retrieval', 'simd-kernel.wat');
const blobPath = join(root, 'src', 'retrieval', 'simd-kernel-wasm.ts');

const CHECK_MODE = process.argv.includes('--check');

(async function main() {
  // 1. Verify the WAT source exists
  if (!existsSync(watPath)) {
    console.error('gen-simd-kernel: missing WAT source at', watPath);
    console.error('gen-simd-kernel: run from the project root after creating simd-kernel.wat');
    process.exit(1);
  }

  const wat = readFileSync(watPath, 'utf8');

  // 2. Assemble WAT -> WASM bytes via wabt (devDep)
  let wabtLib;
  try {
    wabtLib = require('wabt');
  } catch {
    console.error('gen-simd-kernel: wabt not found — run `npm install` to restore devDependencies');
    process.exit(1);
  }

  const wabt = await wabtLib();
  const mod = wabt.parseWat('simd-kernel.wat', wat, { simd: true });
  const { buffer: wasmBytes } = mod.toBinary({});
  const freshBase64 = Buffer.from(wasmBytes).toString('base64');

  if (CHECK_MODE) {
    // -- CHECK MODE: reproducibility gate (T-51-01) + cosine self-test --

    // (a) Compare freshly-derived base64 against the committed blob
    if (!existsSync(blobPath)) {
      console.error('gen-simd-kernel --check: committed blob missing at', blobPath);
      console.error('gen-simd-kernel --check: run `node scripts/gen-simd-kernel.cjs` first to generate it');
      process.exit(1);
    }

    const tsContent = readFileSync(blobPath, 'utf8');
    const match = tsContent.match(/const WASM_BASE64 = '([^']+)'/);
    if (!match) {
      console.error('gen-simd-kernel --check: could not extract WASM_BASE64 from', blobPath);
      process.exit(1);
    }
    const committedBase64 = match[1];

    if (freshBase64 !== committedBase64) {
      console.error('gen-simd-kernel --check: FAIL — committed blob does NOT match current WAT source');
      console.error('gen-simd-kernel --check: run `npm run gen:simd-kernel` to regenerate the blob');
      process.exit(1);
    }
    console.log('gen-simd-kernel --check: reproducibility OK (committed blob matches WAT)');

    // (b) Cosine self-test: compile + instantiate, run scan over a tiny fixture,
    //     assert scores match a JS dot/(||q||*||row||) reference within 1e-5.
    //
    //     Fixture: dim=4, count=2
    //       q     = [1, 2, 3, 4]  ||q|| = sqrt(30)
    //       row0  = [1, 2, 3, 4]  ||row0|| = sqrt(30)  expected cosine = 30/30 = 1.0
    //       row1  = [4, 3, 2, 1]  ||row1|| = sqrt(30)  expected cosine = 20/30 ~= 0.6667
    //
    //     Memory layout (dim=4 => dimsBytes=16):
    //       qPtr   = 0             (16 bytes)
    //       mPtr   = 16            (32 bytes: 2 rows * 4 floats * 4 bytes)
    //       rnPtr  = 48            (8 bytes: 2 * f32 reciprocal norms)
    //       outPtr = 56            (8 bytes: 2 * f32 scores)
    //       total  = 64 bytes < 1 WASM page (65536 bytes)

    const wasmModule = await WebAssembly.compile(wasmBytes);
    const memory = new WebAssembly.Memory({ initial: 1 });
    const inst = await WebAssembly.instantiate(wasmModule, { env: { mem: memory } });
    const scan = inst.exports.scan;

    const DIM = 4;
    const COUNT = 2;
    const dimsBytes = DIM * 4;

    const qPtr = 0;
    const mPtr = qPtr + DIM * 4;          // 16
    const rnPtr = mPtr + COUNT * DIM * 4; // 48
    const outPtr = rnPtr + COUNT * 4;     // 56

    const q = [1, 2, 3, 4];
    const rows = [
      [1, 2, 3, 4],
      [4, 3, 2, 1],
    ];

    function l2(v) {
      return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    }

    const qNorm = l2(q);
    const recipQNorm = qNorm === 0 ? 0 : 1 / qNorm;

    const rnVals = rows.map(row => {
      const n = l2(row);
      return n === 0 ? 0 : 1 / n;
    });

    const expected = rows.map((row, ri) => {
      const dot = q.reduce((s, x, j) => s + x * row[j], 0);
      return dot * rnVals[ri] * recipQNorm;
    });

    // Populate WASM memory
    const qView = new Float32Array(memory.buffer, qPtr, DIM);
    const mView = new Float32Array(memory.buffer, mPtr, COUNT * DIM);
    const rnView = new Float32Array(memory.buffer, rnPtr, COUNT);
    const outView = new Float32Array(memory.buffer, outPtr, COUNT);

    qView.set(q);
    for (let i = 0; i < COUNT; i++) {
      mView.set(rows[i], i * DIM);
    }
    rnView.set(rnVals);

    // Call the kernel
    scan(qPtr, mPtr, rnPtr, outPtr, recipQNorm, COUNT, dimsBytes);

    // Assert scores match JS reference within 1e-5
    const TOL = 1e-5;
    let allOk = true;
    for (let i = 0; i < COUNT; i++) {
      const got = outView[i];
      const exp = expected[i];
      const diff = Math.abs(got - exp);
      if (diff > TOL) {
        console.error(
          `gen-simd-kernel --check: FAIL — score[${i}] got ${got} expected ${exp} diff ${diff} > ${TOL}`,
        );
        allOk = false;
      }
    }

    if (!allOk) {
      process.exit(1);
    }

    console.log(
      `gen-simd-kernel --check: cosine self-test OK` +
        ` (score[0]=${outView[0].toFixed(6)} expected=${expected[0].toFixed(6)},` +
        ` score[1]=${outView[1].toFixed(6)} expected=${expected[1].toFixed(6)})`,
    );
    return;
  }

  // -- DEFAULT RUN: write the generated TypeScript blob module --
  const tsContent =
    '// GENERATED by scripts/gen-simd-kernel.cjs from simd-kernel.wat — DO NOT EDIT BY HAND\n' +
    '// Run `npm run gen:simd-kernel` to regenerate after modifying simd-kernel.wat.\n' +
    '\n' +
    "const WASM_BASE64 = '" +
    freshBase64 +
    "';\n" +
    '\n' +
    '/** Return the raw WASM bytes for the fused f32x4 cosine-scan kernel. */\n' +
    'export function wasmBytes(): Uint8Array {\n' +
    "  return Buffer.from(WASM_BASE64, 'base64');\n" +
    '}\n';

  writeFileSync(blobPath, tsContent, 'utf8');
  console.log('gen-simd-kernel: wrote', blobPath);
})().catch(err => {
  console.error('gen-simd-kernel: FAILED:', err);
  process.exit(1);
});
