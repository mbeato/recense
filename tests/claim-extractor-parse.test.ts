/**
 * parseClaims regression coverage — exercises the REAL model-output shapes the
 * mock-based tests never hit. claude-haiku-4-5 wraps its JSON array in ```json
 * fences despite the prompt; the original parser called JSON.parse on the raw
 * fenced text, threw, and silently dropped every claim — breaking cold-start
 * seeding and live consolidation while all mocked tests stayed green.
 *
 * Phase 14 additions:
 *   - Salvage tests: parseClaims must never silently return [] on truncated output
 *   - Chunking test: extractClaimsWithChunking must split oversized content into
 *     multiple generate() calls and concatenate the results
 */
import { describe, it, expect } from 'vitest';
import { parseClaims, extractClaimsWithChunking, EXTRACTION_CHUNK_CHARS } from '../src/model/claim-extractor';
import { MockModelProvider } from '../src/model/provider';

describe('parseClaims: real model output shapes', () => {
  it('parses claims wrapped in ```json fences (the production bug)', () => {
    const fenced =
      '```json\n[\n  {"type":"entity","value":"recense project","links":[]},\n' +
      '  {"type":"fact","value":"Preferred test runner for recense project is vitest","links":["recense project"]}\n]\n```';
    const claims = parseClaims(fenced);
    expect(claims).toHaveLength(2);
    expect(claims[0]).toMatchObject({ type: 'entity', value: 'recense project' });
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

// ---------------------------------------------------------------------------
// Phase 14: salvage on truncated arrays (parseClaims must not silently return [])
// ---------------------------------------------------------------------------

describe('parseClaims: truncated-array salvage (Phase 14)', () => {
  it('salvages complete claims when array is truncated with no closing bracket', () => {
    // Simulate what happens when maxTokens cuts the response mid-array
    const truncated =
      '[{"type":"entity","value":"first claim"},{"type":"fact","value":"second claim"},{"type":"entity","value":"trunca';
    const claims = parseClaims(truncated);
    expect(claims).toHaveLength(2);
    expect(claims[0]).toMatchObject({ type: 'entity', value: 'first claim' });
    expect(claims[1]).toMatchObject({ type: 'fact', value: 'second claim' });
  });

  it('salvages claims when a ] appears inside a value string causing a malformed array span', () => {
    // extractJsonArray finds the ] inside the value "a]b", producing a malformed span;
    // the catch-path salvage finds the last } and closes correctly
    const withInnerBracket =
      '[{"type":"entity","value":"a]b"},{"type":"fact","value":"trunc';
    const claims = parseClaims(withInnerBracket);
    // Should salvage at minimum the entity claim
    expect(claims.length).toBeGreaterThanOrEqual(1);
    expect(claims[0]).toMatchObject({ type: 'entity', value: 'a]b' });
  });

  it('returns [] when no objects are parseable (completely corrupt response)', () => {
    expect(parseClaims('[{"type":"entity","val')).toEqual([]);
    expect(parseClaims('not json at all')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Phase 14: chunked extraction
// ---------------------------------------------------------------------------

describe('extractClaimsWithChunking', () => {
  it('makes a single generate() call for content within the threshold', async () => {
    const content = 'short content';
    const response = JSON.stringify([{ type: 'fact', value: 'single claim' }]);
    const provider = new MockModelProvider({ generateScript: [response] });

    const claims = await extractClaimsWithChunking(provider, 'prefix:\n', content);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ value: 'single claim' });
  });

  it('makes 2+ generate() calls for oversized content and concatenates claims', async () => {
    // Build content slightly over the threshold with a newline at the midpoint
    // so splitIntoChunks will produce exactly 2 chunks
    const pivot = EXTRACTION_CHUNK_CHARS - 2000;
    const content = 'a'.repeat(pivot) + '\n' + 'b'.repeat(3000);
    // content.length = pivot + 1 + 3000 > EXTRACTION_CHUNK_CHARS

    const chunk1Response = JSON.stringify([{ type: 'fact', value: 'claim from chunk one' }]);
    const chunk2Response = JSON.stringify([{ type: 'entity', value: 'claim from chunk two' }]);

    const provider = new MockModelProvider({
      generateScript: [chunk1Response, chunk2Response],
    });

    const claims = await extractClaimsWithChunking(provider, 'prefix:\n', content);

    // Both generate() calls were consumed (proves 2 calls were made)
    expect(claims).toHaveLength(2);
    expect(claims[0]).toMatchObject({ value: 'claim from chunk one' });
    expect(claims[1]).toMatchObject({ value: 'claim from chunk two' });
  });

  it('propagates a generate() error for quarantine semantics (H-2)', async () => {
    const pivot = EXTRACTION_CHUNK_CHARS - 2000;
    const content = 'a'.repeat(pivot) + '\n' + 'b'.repeat(3000);

    const provider = new MockModelProvider({
      generateScript: [JSON.stringify([{ type: 'fact', value: 'ok' }])],
      // Second call will throw (queue exhausted) — simulates API error on chunk 2
    });

    await expect(
      extractClaimsWithChunking(provider, 'prefix:\n', content),
    ).rejects.toThrow();
  });
});
