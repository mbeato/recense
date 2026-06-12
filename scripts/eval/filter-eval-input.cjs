#!/usr/bin/env node
/**
 * filter-eval-input.cjs
 *
 * Filter a LongMemEval JSONL file by question_id membership.
 *
 * Usage:
 *   node scripts/eval/filter-eval-input.cjs \
 *     --ids <comma-separated-ids> \
 *     --out  <output-path> \
 *     [--in  <input-path>]   # default: scripts/eval/results/longmemeval-ku-only.jsonl
 *
 * Exits non-zero with a clear message if any requested ID is absent from the source.
 * Validates output line count equals the expected set size.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ---- arg parsing ------------------------------------------------------------

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i !== -1 ? process.argv[i + 1] : d;
};

const IDS_RAW  = arg('--ids',  null);
const OUT_FILE = arg('--out',  null);
const IN_FILE  = arg('--in', path.resolve(__dirname, 'results/longmemeval-ku-only.jsonl'));

if (!IDS_RAW) {
  console.error('Error: --ids <comma-separated-ids> is required');
  process.exit(1);
}
if (!OUT_FILE) {
  console.error('Error: --out <output-path> is required');
  process.exit(1);
}

// Parse ID set (trim whitespace from each token)
const idSet = new Set(IDS_RAW.split(',').map(id => id.trim()).filter(Boolean));
if (idSet.size === 0) {
  console.error('Error: --ids produced an empty set after parsing');
  process.exit(1);
}

// ---- read source ------------------------------------------------------------

if (!fs.existsSync(IN_FILE)) {
  console.error(`Error: source file not found: ${IN_FILE}`);
  process.exit(1);
}

const lines = fs.readFileSync(IN_FILE, 'utf8').split('\n').filter(l => l.trim());

// ---- filter -----------------------------------------------------------------

const kept  = [];
const found = new Set();

for (let i = 0; i < lines.length; i++) {
  let obj;
  try {
    obj = JSON.parse(lines[i]);
  } catch (e) {
    console.warn(`[warn] Skipping malformed JSONL line ${i + 1}: ${String(e.message || e).slice(0, 100)}`);
    continue;
  }
  if (idSet.has(obj.question_id)) {
    kept.push(lines[i]);
    found.add(obj.question_id);
  }
}

// ---- validate completeness --------------------------------------------------

const missing = [...idSet].filter(id => !found.has(id));
if (missing.length > 0) {
  console.error(
    `Error: ${missing.length} requested ID(s) not found in ${IN_FILE}.\n` +
    `Missing: ${missing.join(', ')}\n` +
    `This indicates a stale source file or incorrect ID list.`
  );
  process.exit(1);
}

if (kept.length !== idSet.size) {
  // Sanity: should never happen if the missing check passed, but guard anyway
  console.error(`Error: expected ${idSet.size} output lines but got ${kept.length} (possible duplicate question_ids in source)`);
  process.exit(1);
}

// ---- write output -----------------------------------------------------------

fs.mkdirSync(path.dirname(path.resolve(OUT_FILE)), { recursive: true });
fs.writeFileSync(OUT_FILE, kept.join('\n') + '\n');

console.log(`Wrote ${kept.length} line(s) to ${OUT_FILE}`);
