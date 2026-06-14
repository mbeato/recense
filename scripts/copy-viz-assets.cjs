#!/usr/bin/env node
/**
 * copy-viz-assets — ship the viz frontend into dist.
 *
 * `tsc` only compiles .ts → .js; it does NOT copy the static frontend (index.html) or the
 * vendored libraries (three.js, 3d-force-graph) into dist. But the compiled server resolves
 * its asset root from __dirname (dist/src/viz/), so without this step `recense viz` serves a
 * 503 "frontend not yet built" and the vendor files 404. Run from postbuild after tsc.
 *
 * Cross-platform (fs.cpSync, Node >=16.7) for the Windows CI matrix.
 */
const { cpSync, existsSync, mkdirSync } = require('fs');
const { join } = require('path');

const root = join(__dirname, '..');
const srcDir = join(root, 'src', 'viz');
const destDir = join(root, 'dist', 'src', 'viz');

mkdirSync(destDir, { recursive: true });

const assets = ['index.html', 'vendor', 'css', 'modules'];
for (const name of assets) {
  const from = join(srcDir, name);
  if (!existsSync(from)) {
    console.error(`copy-viz-assets: missing source asset ${from}`);
    process.exit(1);
  }
  cpSync(from, join(destDir, name), { recursive: true });
}

console.log('copy-viz-assets: copied index.html + vendor + css + modules → dist/src/viz/');
