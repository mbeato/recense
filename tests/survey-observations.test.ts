/**
 * Unit tests for src/adapter/survey-observations.ts
 *
 * Tests the pure helper functions carried from scripts/spike/survey-feeder.ts
 * into a real importable module. No DB, no I/O, no claude calls.
 *
 * Phase 30 Plan 01 — TDD RED: these tests must FAIL before the module is created,
 * then PASS after.
 */
import { describe, it, expect } from 'vitest';
import {
  SURVEY_AREAS,
  MAX_OBS_PER_AREA,
  splitObservations,
  isRefusalOrToolFailure,
  buildSurveyPrompt,
} from '../src/adapter/survey-observations';

// ── SURVEY_AREAS ─────────────────────────────────────────────────────────────

describe('SURVEY_AREAS', () => {
  it('exports the five calibrated areas in order', () => {
    expect(SURVEY_AREAS).toEqual([
      'architecture',
      'conventions',
      'decisions',
      'current-state',
      'gotchas',
    ]);
  });

  it('MAX_OBS_PER_AREA is 25', () => {
    expect(MAX_OBS_PER_AREA).toBe(25);
  });
});

// ── splitObservations ─────────────────────────────────────────────────────────

describe('splitObservations', () => {
  it('strips bullet/number markers and returns long-enough belief lines', () => {
    const input = [
      '- one belief here that is long enough to pass the filter',
      '* another belief line that has sufficient length to qualify',
      'short',               // < 20 chars — dropped
      'foo();',              // ends in ; — dropped
      'x',                  // too short — dropped
    ].join('\n');
    const result = splitObservations(input);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('one belief here that is long enough to pass the filter');
    expect(result[1]).toBe('another belief line that has sufficient length to qualify');
  });

  it('drops lines ending in ; (code-like)', () => {
    const result = splitObservations('const x = require("foo");');
    expect(result).toHaveLength(0);
  });

  it('drops lines ending in { (code-like)', () => {
    const result = splitObservations('function doSomething() {');
    expect(result).toHaveLength(0);
  });

  it('drops lines ending in } (code-like)', () => {
    const result = splitObservations('  const obj = { key: "value" }');
    // ends in } — dropped
    expect(result).toHaveLength(0);
  });

  it('drops lines containing => (arrow function)', () => {
    const result = splitObservations('const fn = (x) => x + 1;');
    expect(result).toHaveLength(0);
  });

  it('drops lines containing require( (require call)', () => {
    const result = splitObservations('const path = require("path");');
    expect(result).toHaveLength(0);
  });

  it('drops single-token lines (no space)', () => {
    const result = splitObservations('superlongwordsingletoken');
    expect(result).toHaveLength(0);
  });

  it('drops lines shorter than 20 chars', () => {
    const result = splitObservations('too short here');  // 14 chars — dropped
    expect(result).toHaveLength(0);
  });

  it('caps output at MAX_OBS_PER_AREA (25) regardless of input length', () => {
    // 40 compliant lines (each ≥20 chars, has space, no code patterns)
    const lines = Array.from({ length: 40 }, (_, i) =>
      `This is a valid belief observation line number ${i} with sufficient length`,
    );
    const result = splitObservations(lines.join('\n'));
    expect(result).toHaveLength(25);
  });

  it('handles empty string returning empty array', () => {
    expect(splitObservations('')).toEqual([]);
  });

  it('strips numbered list markers', () => {
    const result = splitObservations('1. The system uses a thin API route layer for performance reasons and maintainability');
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('The system uses a thin API route layer for performance reasons and maintainability');
  });

  it('strips numbered list markers with parens', () => {
    const result = splitObservations('2) The architecture separates concerns into distinct layers for testability');
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('The architecture separates concerns into distinct layers for testability');
  });
});

// ── isRefusalOrToolFailure ────────────────────────────────────────────────────

describe('isRefusalOrToolFailure', () => {
  it('detects tool access failure phrase', () => {
    expect(isRefusalOrToolFailure('Read, Grep, and Glob tools cannot access /x')).toBe(true);
  });

  it("detects I'm sorry", () => {
    expect(isRefusalOrToolFailure("I'm sorry, I cannot access that directory")).toBe(true);
  });

  it('detects no genuine observations', () => {
    expect(isRefusalOrToolFailure('No genuine observations available')).toBe(true);
  });

  it('does NOT flag a genuine observation', () => {
    expect(
      isRefusalOrToolFailure('The architecture uses a thin API route layer because ...')
    ).toBe(false);
  });

  it('treats empty string as failure (never ingest)', () => {
    expect(isRefusalOrToolFailure('')).toBe(true);
  });

  it('treats whitespace-only string as failure', () => {
    expect(isRefusalOrToolFailure('   \n  ')).toBe(true);
  });

  it('detects "I am sorry" variant', () => {
    expect(isRefusalOrToolFailure('I am sorry, I cannot help with that request')).toBe(true);
  });

  it('is case-insensitive for refusal detection', () => {
    expect(isRefusalOrToolFailure('CANNOT ACCESS the directory')).toBe(true);
  });

  it('detects "unable to access" phrasings', () => {
    expect(isRefusalOrToolFailure('I was unable to access the requested path')).toBe(true);
  });

  it('detects "permission denied" phrasings', () => {
    expect(isRefusalOrToolFailure('permission denied for the specified directory')).toBe(true);
  });
});

// ── buildSurveyPrompt ─────────────────────────────────────────────────────────

describe('buildSurveyPrompt', () => {
  const params = {
    repoDir: '/Users/vtx/usage',
    repoDesc: 'the @mbeato/contextscope package — a CLI + local Next.js dashboard that audits per-turn Claude Code token context',
  };

  it('contains the load-bearing "Write WHY, NOT WHAT" framing line', () => {
    for (const area of SURVEY_AREAS) {
      const prompt = buildSurveyPrompt(area as any, params);
      expect(prompt).toContain('Write WHY, NOT WHAT');
    }
  });

  it('contains all MUST NOT contain items from the quality gate', () => {
    for (const area of SURVEY_AREAS) {
      const prompt = buildSurveyPrompt(area as any, params);
      expect(prompt).toContain('your output MUST NOT contain');
      expect(prompt).toContain('any raw code lines or code snippets');
      expect(prompt).toContain('import/dependency graphs or dependency lists');
      expect(prompt).toContain('structural trivia');
      expect(prompt).toContain('config dumps or boilerplate');
    }
  });

  it('interpolates repoDir into the prompt', () => {
    const prompt = buildSurveyPrompt('architecture', params);
    expect(prompt).toContain('/Users/vtx/usage');
  });

  it('interpolates repoDesc into the prompt', () => {
    const prompt = buildSurveyPrompt('architecture', params);
    expect(prompt).toContain('@mbeato/contextscope');
  });

  it('interpolates area into the prompt', () => {
    const prompt = buildSurveyPrompt('conventions', params);
    expect(prompt).toContain('"conventions"');
  });

  it('uses different area tokens for each area', () => {
    const archPrompt = buildSurveyPrompt('architecture', params);
    const convPrompt = buildSurveyPrompt('conventions', params);
    // Both contain their own area token
    expect(archPrompt).toContain('"architecture"');
    expect(convPrompt).toContain('"conventions"');
  });

  it('healthy areas (non-gotchas) are byte-identical aside from area token', () => {
    // The 4 healthy areas should have the same base structure
    const archPrompt = buildSurveyPrompt('architecture', params);
    const convPrompt = buildSurveyPrompt('conventions', params);
    // Both should have the same base quality gate text
    const archWithoutArea = archPrompt.replace('"architecture"', '"AREA"');
    const convWithoutArea = convPrompt.replace('"conventions"', '"AREA"');
    expect(archWithoutArea).toBe(convWithoutArea);
  });

  it('gotchas area gets the extra why-level steering clause', () => {
    const gotchasPrompt = buildSurveyPrompt('gotchas', params);
    // The gotchas area gets an extra clause per D-08
    expect(gotchasPrompt).toContain("senior dev's hard-won warnings");
    expect(gotchasPrompt).toContain('NOT a list of what files do');
  });

  it('gotchas area still contains the base prompt content', () => {
    const gotchasPrompt = buildSurveyPrompt('gotchas', params);
    // Must keep the rest of the base prompt
    expect(gotchasPrompt).toContain('Write WHY, NOT WHAT');
    expect(gotchasPrompt).toContain('your output MUST NOT contain');
  });

  it('non-gotchas areas do NOT contain the gotchas extra clause', () => {
    for (const area of ['architecture', 'conventions', 'decisions', 'current-state'] as const) {
      const prompt = buildSurveyPrompt(area, params);
      expect(prompt).not.toContain("senior dev's hard-won warnings");
    }
  });

  it('works with a different repoDir (parameterized, not hardcoded)', () => {
    const prompt = buildSurveyPrompt('architecture', {
      repoDir: '/home/user/my-project',
      repoDesc: 'a custom project description',
    });
    expect(prompt).toContain('/home/user/my-project');
    expect(prompt).toContain('a custom project description');
    expect(prompt).not.toContain('/Users/vtx/usage');
  });

  it('contains the ~15 / hard-ceiling-20 curation cap instruction', () => {
    const prompt = buildSurveyPrompt('architecture', params);
    expect(prompt).toContain('~15 most important');
    expect(prompt).toContain('hard ceiling: 20');
  });

  it('contains the "one belief per line" format instruction', () => {
    const prompt = buildSurveyPrompt('architecture', params);
    expect(prompt).toContain('ONE belief per line');
    expect(prompt).toContain('complete');
    expect(prompt).toContain('standalone sentence');
  });

  it('contains the Read/Grep/Glob tool instruction', () => {
    const prompt = buildSurveyPrompt('architecture', params);
    expect(prompt).toContain('Read, Grep, and Glob tools');
  });
});
