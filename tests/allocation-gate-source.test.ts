/**
 * Per-source AllocationGate tests (D-60/D-62).
 *
 * Invariants verified:
 *  - claude-code source is byte-for-byte identical to the pre-Phase-6 default (zero regression).
 *  - gmail salience = composite × 0.35 (sourced from DEFAULT_SALIENCE_CONFIG.sourceWeights.gmail).
 *  - gmail salience is strictly < 1.0 even on max-pattern content.
 *  - gmail message matching a directive pattern returns hardKeep=false (D-62).
 *  - obsidian user-directive returns hardKeep=true (D-62 — trusted source).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AllocationGate } from '../src/gate/allocation-gate';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';

const testConfig: EngineConfig = { ...DEFAULT_CONFIG, dbPath: ':memory:' };

// Expected weights from DEFAULT_SALIENCE_CONFIG (compile-time constants — test pins these)
const GMAIL_WEIGHT = 0.35;
const OBSIDIAN_WEIGHT = 0.9;

describe('AllocationGate per-source salience (D-60)', () => {
  let gate: AllocationGate;

  beforeEach(() => {
    gate = new AllocationGate(testConfig);
  });

  // ── Zero regression: claude-code path unchanged ───────────────────────────

  it('score(content, role) and score(content, role, "claude-code") produce identical results', () => {
    const cases: Array<[string, 'user' | 'assistant' | 'tool']> = [
      ['hello world', 'user'],
      ['always remember this', 'user'],
      ['actually that is wrong', 'assistant'],
      ['{"result": "ok"}', 'tool'],
    ];
    for (const [content, role] of cases) {
      const defaultResult = gate.score(content, role);
      const explicitResult = gate.score(content, role, 'claude-code');
      expect(explicitResult.salience).toBe(defaultResult.salience);
      expect(explicitResult.hardKeep).toBe(defaultResult.hardKeep);
    }
  });

  // ── Per-source weight correctness ─────────────────────────────────────────

  it('gmail salience ≈ composite × GMAIL_WEIGHT for a plain user message', () => {
    // "hello world" — no patterns, short — gives a clean baseline composite
    const content = 'hello world';
    const role = 'user' as const;
    // claude-code weight is 1.0 → salience IS the composite
    const ccResult = gate.score(content, role, 'claude-code');
    const gmailResult = gate.score(content, role, 'gmail');
    expect(gmailResult.salience).toBeCloseTo(ccResult.salience * GMAIL_WEIGHT, 10);
  });

  it('obsidian salience ≈ composite × OBSIDIAN_WEIGHT for a plain user message', () => {
    const content = 'hello world';
    const role = 'user' as const;
    const ccResult = gate.score(content, role, 'claude-code');
    const obsidianResult = gate.score(content, role, 'obsidian');
    expect(obsidianResult.salience).toBeCloseTo(ccResult.salience * OBSIDIAN_WEIGHT, 10);
  });

  it('gmail salience is strictly < 1.0 even on max-signal content (D-03 honesty cap)', () => {
    // Maximise all signals: long content with both directive + correction patterns
    const maxContent = 'always remember that i prefer this and never do that ' +
                       'and actually that is wrong and incorrect '.repeat(3);
    const maxResult = gate.score(maxContent, 'user', 'gmail');
    expect(maxResult.salience).toBeLessThan(1.0);
    // Confirm the composite itself would be < 1.0 (no artificial pinning)
    const ccResult = gate.score(maxContent, 'user', 'claude-code');
    expect(ccResult.salience).toBeLessThan(1.0);
    // And gmail is strictly below the claude-code value
    expect(maxResult.salience).toBeLessThan(ccResult.salience);
  });

  it('unknown source falls back to claude-code weight (1.0) for back-compat', () => {
    const content = 'hello world';
    const ccResult = gate.score(content, 'user', 'claude-code');
    const unknownResult = gate.score(content, 'user', 'some-future-source');
    expect(unknownResult.salience).toBe(ccResult.salience);
  });

  // ── Hard-keep gating by source (D-62) ────────────────────────────────────

  it('gmail message matching a directive pattern returns hardKeep=false (D-62)', () => {
    // This content matches multiple directive patterns — but gmail is an observed channel
    const directive = 'always remember this preference and never do that';
    const result = gate.score(directive, 'user', 'gmail');
    expect(result.hardKeep).toBe(false);
  });

  it('granola message matching a correction pattern returns hardKeep=false (D-62)', () => {
    const correction = 'actually that is wrong and incorrect';
    const result = gate.score(correction, 'user', 'granola');
    expect(result.hardKeep).toBe(false);
  });

  it('obsidian user-directive returns hardKeep=true (D-62 — trusted source)', () => {
    const directive = 'always remember this preference';
    const result = gate.score(directive, 'user', 'obsidian');
    expect(result.hardKeep).toBe(true);
  });

  it('claude-code user-directive still returns hardKeep=true (zero regression)', () => {
    const directive = 'always remember this preference';
    const result = gate.score(directive, 'user', 'claude-code');
    expect(result.hardKeep).toBe(true);
  });

  it('obsidian assistant-directive returns hardKeep=false (role guard still applies)', () => {
    // Even a trusted source does not hard-keep non-user roles
    const directive = 'always remember this preference';
    const result = gate.score(directive, 'assistant', 'obsidian');
    expect(result.hardKeep).toBe(false);
  });

  it('gmail user-directive still earns non-zero salience (only hardKeep is blocked)', () => {
    const directive = 'always remember this preference';
    const result = gate.score(directive, 'user', 'gmail');
    // salience > 0 — the directive signal still contributes via source-weighted composite
    expect(result.salience).toBeGreaterThan(0);
    expect(result.hardKeep).toBe(false);
  });
});
