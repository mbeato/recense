/**
 * Tests for per-source extraction prompt selection (D-62 / T-06-09).
 *
 * Covers five routing cases:
 *   1. gmail     → email-noise guidance + JSON-array output contract
 *   2. granola   → speaker-attribution guidance
 *   3. obsidian  → EXTRACTION_PROMPT verbatim (curated-markdown extractor)
 *   4. claude-code → EXTRACTION_PROMPT verbatim (existing conversation extractor)
 *   5. unknown   → EXTRACTION_PROMPT fallback (T-06-09 safe fallback)
 *
 * Each non-default prompt must carry the JSON-array output contract so parseClaims
 * can process every source's response without modification (D-59/D-62).
 */
import { describe, it, expect } from 'vitest';
import { promptForSource } from '../src/source/extraction-prompts';
import { EXTRACTION_PROMPT } from '../src/model/claim-extractor';

describe('promptForSource', () => {
  // ── 1. gmail ──────────────────────────────────────────────────────────────

  it('gmail prompt contains email-noise guidance', () => {
    const prompt = promptForSource('gmail');
    expect(prompt).toContain(
      'IGNORE email signatures, pleasantries, and scheduling logistics',
    );
  });

  it('gmail prompt contains the JSON-array output contract', () => {
    const prompt = promptForSource('gmail');
    expect(prompt).toContain('Return ONLY a valid JSON array');
  });

  // ── 2. transcript sources (granola / otter / zoom) ───────────────────────

  it('granola prompt contains speaker-attribution guidance', () => {
    const prompt = promptForSource('granola');
    expect(prompt).toContain('attribute each claim to the named speaker');
  });

  it('granola prompt contains the JSON-array output contract', () => {
    const prompt = promptForSource('granola');
    expect(prompt).toContain('Return ONLY a valid JSON array');
  });

  it('otter prompt contains speaker-attribution guidance (same as granola)', () => {
    expect(promptForSource('otter')).toBe(promptForSource('granola'));
  });

  it('zoom prompt contains speaker-attribution guidance (same as granola)', () => {
    expect(promptForSource('zoom')).toBe(promptForSource('granola'));
  });

  // ── 3. obsidian ──────────────────────────────────────────────────────────

  it('obsidian prompt equals EXTRACTION_PROMPT verbatim', () => {
    expect(promptForSource('obsidian')).toBe(EXTRACTION_PROMPT);
  });

  // ── 4. claude-code ───────────────────────────────────────────────────────

  it('claude-code prompt equals EXTRACTION_PROMPT verbatim', () => {
    expect(promptForSource('claude-code')).toBe(EXTRACTION_PROMPT);
  });

  // ── 5. unknown source falls back to EXTRACTION_PROMPT (T-06-09) ──────────

  it('unknown source falls back to EXTRACTION_PROMPT (T-06-09 safe fallback)', () => {
    expect(promptForSource('unknown-source-xyz')).toBe(EXTRACTION_PROMPT);
    expect(promptForSource('')).toBe(EXTRACTION_PROMPT);
  });
});
