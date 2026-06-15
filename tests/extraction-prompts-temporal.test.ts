/**
 * Tests for TEMP-03 extraction prompt routing (D-06, plan 20-02).
 *
 * Verifies:
 *   - RECENSE_ENABLE_EPISODIC_EMAIL unset/empty/'false' → promptForSource('gmail') returns
 *     GMAIL_EXTRACTION_PROMPT baseline (default OFF, T-20-02 strict equality)
 *   - RECENSE_ENABLE_EPISODIC_EMAIL='on' → promptForSource('gmail') returns the episodic superset
 *   - promptForSource('gcal') returns GCAL_EXTRACTION_PROMPT regardless of env flag
 *   - GMAIL_EPISODIC_EXTRACTION_PROMPT is a superset (contains 'due_at', 'action_type',
 *     explicit mentions of flights/deadlines/receipts)
 *   - All tests restore process.env after each case (no cross-test leakage)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promptForSource } from '../src/source/extraction-prompts';

// ---------------------------------------------------------------------------
// Env cleanup guard
// ---------------------------------------------------------------------------

const ENV_KEY = 'RECENSE_ENABLE_EPISODIC_EMAIL';

afterEach(() => {
  // Restore env to known-clean state after every test
  delete process.env[ENV_KEY];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('promptForSource — temporal prompt routing (TEMP-03, D-06)', () => {

  // ── Gmail: default OFF ─────────────────────────────────────────────────

  it('gmail: env unset → baseline GMAIL_EXTRACTION_PROMPT (default OFF)', () => {
    delete process.env[ENV_KEY]; // ensure unset
    const prompt = promptForSource('gmail');
    // Baseline must NOT contain due_at (the episodic superset adds it)
    expect(prompt).not.toContain('due_at');
    // Baseline must be the known email-noise guidance prompt
    expect(prompt).toContain('IGNORE email signatures');
  });

  it('gmail: env empty string → baseline GMAIL_EXTRACTION_PROMPT', () => {
    process.env[ENV_KEY] = '';
    const prompt = promptForSource('gmail');
    expect(prompt).not.toContain('due_at');
  });

  it("gmail: env 'false' → baseline GMAIL_EXTRACTION_PROMPT (strict equality guard, T-20-02)", () => {
    process.env[ENV_KEY] = 'false';
    const prompt = promptForSource('gmail');
    expect(prompt).not.toContain('due_at');
  });

  it("gmail: env 'on' → GMAIL_EPISODIC_EXTRACTION_PROMPT (superset)", () => {
    process.env[ENV_KEY] = 'on';
    const prompt = promptForSource('gmail');
    expect(prompt).toContain('due_at');
    expect(prompt).toContain('action_type');
  });

  it("gmail: env 'ON' (wrong case) → baseline, not the episodic superset (strict equality)", () => {
    process.env[ENV_KEY] = 'ON'; // not lowercase 'on' — must NOT activate
    const prompt = promptForSource('gmail');
    expect(prompt).not.toContain('due_at');
  });

  // ── Gmail episodic superset content ────────────────────────────────────

  it("GMAIL_EPISODIC_EXTRACTION_PROMPT contains due_at, action_type, and mentions flights/deadlines/receipts", () => {
    process.env[ENV_KEY] = 'on';
    const prompt = promptForSource('gmail');
    expect(prompt).toContain('due_at');
    expect(prompt).toContain('action_type');
    // Explicit coverage of the three categories the baseline discards (TEMP-03)
    expect(prompt.toLowerCase()).toContain('flight');
    expect(prompt.toLowerCase()).toContain('deadline');
    expect(prompt.toLowerCase()).toContain('receipt');
  });

  // ── gcal: unconditional ─────────────────────────────────────────────────

  it('gcal: returns GCAL_EXTRACTION_PROMPT when env is unset', () => {
    delete process.env[ENV_KEY];
    const prompt = promptForSource('gcal');
    // Calendar prompt must emit due_at (temporal fields are core for gcal — TEMP-01)
    expect(prompt).toContain('due_at');
    expect(prompt).toContain('action_type');
    // Calendar-specific guidance
    expect(prompt.toLowerCase()).toContain('calendar');
  });

  it("gcal: returns GCAL_EXTRACTION_PROMPT even when env is 'on' (separate from email flag)", () => {
    process.env[ENV_KEY] = 'on';
    const promptGcal = promptForSource('gcal');
    const promptGmail = promptForSource('gmail');
    // Both return a prompt that contains due_at
    expect(promptGcal).toContain('due_at');
    expect(promptGmail).toContain('due_at');
    // But they are DIFFERENT prompts (gcal is not the same as the episodic gmail superset)
    expect(promptGcal).not.toBe(promptGmail);
  });

  it('gcal: returns GCAL_EXTRACTION_PROMPT regardless of email flag value', () => {
    const flagValues = [undefined, '', 'false', 'on', 'ON'];
    for (const val of flagValues) {
      if (val === undefined) {
        delete process.env[ENV_KEY];
      } else {
        process.env[ENV_KEY] = val;
      }
      const prompt = promptForSource('gcal');
      expect(prompt).toContain('due_at');
      expect(prompt.toLowerCase()).toContain('calendar');
    }
  });

  // ── Other sources: unchanged ─────────────────────────────────────────────

  it('transcript sources are unaffected by the env flag', () => {
    process.env[ENV_KEY] = 'on';
    const transcriptSources = ['granola', 'otter', 'zoom'];
    for (const src of transcriptSources) {
      const prompt = promptForSource(src);
      // Transcript prompts are unrelated to temporal extraction
      expect(prompt).not.toContain('due_at');
    }
  });

  it('unknown source falls back to EXTRACTION_PROMPT (T-06-09 safe fallback)', () => {
    process.env[ENV_KEY] = 'on';
    const prompt = promptForSource('unknown-source');
    expect(prompt).not.toContain('due_at');
  });
});
