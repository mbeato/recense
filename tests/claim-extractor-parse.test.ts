/**
 * parseClaims regression coverage — exercises the REAL model-output shapes the
 * mock-based tests never hit. claude-haiku-4-5 wraps its JSON array in ```json
 * fences despite the prompt; the original parser called JSON.parse on the raw
 * fenced text, threw, and silently dropped every claim — breaking cold-start
 * seeding and live consolidation while all mocked tests stayed green.
 */
import { describe, it, expect } from 'vitest';
import { parseClaims } from '../src/model/claim-extractor';

describe('parseClaims: real model output shapes', () => {
  it('parses claims wrapped in ```json fences (the production bug)', () => {
    const fenced =
      '```json\n[\n  {"type":"entity","value":"brain-memory project","links":[]},\n' +
      '  {"type":"fact","value":"Preferred test runner for brain-memory project is vitest","links":["brain-memory project"]}\n]\n```';
    const claims = parseClaims(fenced);
    expect(claims).toHaveLength(2);
    expect(claims[0]).toMatchObject({ type: 'entity', value: 'brain-memory project' });
    expect(claims[1]).toMatchObject({ type: 'fact' });
  });

  it('parses claims with leading prose preamble', () => {
    const noisy =
      'Here is the extracted knowledge:\n[{"type":"fact","value":"prefers tabs over spaces"}]';
    const claims = parseClaims(noisy);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ type: 'fact', value: 'prefers tabs over spaces' });
  });

  it('parses a bare JSON array (no fences)', () => {
    const claims = parseClaims('[{"type":"entity","value":"Max"}]');
    expect(claims).toEqual([{ type: 'entity', value: 'Max', links: undefined }]);
  });

  it('returns [] for an empty array', () => {
    expect(parseClaims('```json\n[]\n```')).toEqual([]);
  });

  it('returns [] when no array span is present', () => {
    expect(parseClaims('I could not find any structured knowledge.')).toEqual([]);
  });

  it('drops malformed items but keeps valid ones', () => {
    const mixed =
      '```json\n[{"type":"fact","value":"good"},{"type":"bogus","value":"x"},{"type":"entity","value":""}]\n```';
    const claims = parseClaims(mixed);
    expect(claims).toEqual([{ type: 'fact', value: 'good', links: undefined }]);
  });
});
