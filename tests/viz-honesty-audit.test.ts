/**
 * VIZ-06 honesty audit — permanent anatomical-term guard for shipped viz copy.
 *
 * Scans src/viz/** (excluding src/viz/vendor/), and src/adapter/brain-viz-cli.ts
 * for forbidden anatomical / brain-region terms. Any match fails CI.
 * Also asserts positive approved framing appears in index.html.
 *
 * The FORBIDDEN_TERMS const is exported as the single source of truth so callers
 * (docs, linters, future audits) can import and extend it without duplication.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Forbidden-term list — single source of truth (VIZ-06 / UI-SPEC)
// ---------------------------------------------------------------------------

/** Anatomical and brain-region terms that must NEVER appear in shipped viz copy. */
export const FORBIDDEN_TERMS: string[] = [
  'hippocampus',
  'cortex',
  'amygdala',
  'cerebellum',
  'striatum',
  'thalamus',
  'prefrontal',
  'temporal lobe',
  'frontal lobe',
  'parietal',
  'neuron',
  'synapse',
  'synaptic',
  'axon',
  'dendrite',
  'cerebral',
  'neural pathway',
];

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Recursively collect all files under `dir`.
 * Excludes src/viz/vendor/ — vendored third-party bundles are not our copy.
 */
function collectVizFiles(dir: string): string[] {
  const vendorDir = path.join(REPO_ROOT, 'src', 'viz', 'vendor');
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (abs === vendorDir) continue; // skip vendored bundles — not our copy
      results.push(...collectVizFiles(abs));
    } else {
      results.push(abs);
    }
  }
  return results;
}

const VIZ_FILES = collectVizFiles(path.join(REPO_ROOT, 'src', 'viz'));
const CLI_FILE = path.join(REPO_ROOT, 'src', 'adapter', 'brain-viz-cli.ts');

/** All viz-surface files to audit: src/viz/** (no vendor) + brain-viz-cli.ts */
const AUDIT_FILES = [...VIZ_FILES, CLI_FILE];

// ---------------------------------------------------------------------------
// Audit tests
// ---------------------------------------------------------------------------

describe('VIZ-06 honesty audit', () => {
  // ── Forbidden-term sweep ──────────────────────────────────────────────────
  describe('forbidden anatomical terms — must be absent from all viz surfaces', () => {
    for (const filePath of AUDIT_FILES) {
      const rel = path.relative(REPO_ROOT, filePath);
      it(`${rel} — zero forbidden terms`, () => {
        const lower = fs.readFileSync(filePath, 'utf8').toLowerCase();
        for (const term of FORBIDDEN_TERMS) {
          const idx = lower.indexOf(term.toLowerCase());
          expect(
            idx,
            `forbidden term "${term}" found in ${rel} at index ${idx}`
          ).toBe(-1);
        }
      });
    }
  });

  // ── Positive-framing assertion ────────────────────────────────────────────
  describe('positive framing — approved copy present in index.html', () => {
    it('index.html contains "memory activations" or "spreading activation"', () => {
      const lower = fs.readFileSync(
        path.join(REPO_ROOT, 'src', 'viz', 'index.html'),
        'utf8'
      ).toLowerCase();
      const hasApproved =
        lower.includes('memory activations') || lower.includes('spreading activation');
      expect(
        hasApproved,
        'index.html must contain "memory activations" or "spreading activation" per VIZ-06 approved framing'
      ).toBe(true);
    });
  });
});
