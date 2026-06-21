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
import { parseClaims, extractClaimsWithChunking, EXTRACTION_CHUNK_CHARS, parseMergedExtraction, MERGED_EXTRACTION_PROMPT } from '../src/model/claim-extractor';
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
// Phase 37 D-02: parseMergedExtraction — merged {facts, triples} output
// ---------------------------------------------------------------------------

describe('parseMergedExtraction: merged {facts, triples} response', () => {
  it('parses a well-formed {facts, triples} object and returns correct counts', () => {
    const response = JSON.stringify({
      facts: [
        { type: 'entity', value: 'Max is the founder', links: ['recense'] },
        { type: 'fact', value: 'Never inflate metrics', links: [] },
      ],
      triples: [
        { subject: 'recense', predicate: 'uses', object: 'claude-headless' },
        { subject: 'Max', predicate: 'works_on', object: 'recense' },
      ],
    });
    const { claims, triples } = parseMergedExtraction(response);
    expect(claims).toHaveLength(2);
    expect(claims[0]).toMatchObject({ type: 'entity', value: 'Max is the founder' });
    expect(claims[1]).toMatchObject({ type: 'fact', value: 'Never inflate metrics' });
    expect(triples).toHaveLength(2);
    expect(triples[0]).toMatchObject({ subject: 'recense', predicate: 'uses', object: 'claude-headless' });
    expect(triples[1]).toMatchObject({ subject: 'Max', predicate: 'works_on', object: 'recense' });
  });

  it('parses a {facts, triples} object wrapped in ```json fences (the live Haiku bug)', () => {
    // Haiku reliably wraps its merged output in markdown fences despite the prompt.
    // The original parser bailed on `!trimmed.startsWith('{')` BEFORE locating the
    // object span, silently dropping every fact AND triple — so the live typed
    // extraction minted zero edges (Phase 37 calibration finding, 2026-06-21).
    const inner = JSON.stringify({
      facts: [{ type: 'entity', value: 'recense', links: [] }],
      triples: [{ subject: 'judge', predicate: 'uses', object: 'haiku' }],
    });
    const fenced = '```json\n' + inner + '\n```';
    const { claims, triples } = parseMergedExtraction(fenced);
    expect(claims).toHaveLength(1);
    expect(triples).toHaveLength(1);
    expect(triples[0]).toMatchObject({ subject: 'judge', predicate: 'uses', object: 'haiku' });
  });

  it('parses a {facts, triples} object with a leading prose preamble', () => {
    const inner = JSON.stringify({
      facts: [],
      triples: [{ subject: 'recense', predicate: 'runs_on', object: 'node' }],
    });
    const withPreamble = 'Here is the extraction:\n' + inner;
    const { triples } = parseMergedExtraction(withPreamble);
    expect(triples).toHaveLength(1);
    expect(triples[0]).toMatchObject({ subject: 'recense', predicate: 'runs_on', object: 'node' });
  });

  it('returns {claims:[], triples:[]} on a bare-array input — object shape required (Pitfall 3)', () => {
    // A bare array must NOT be silently misrouted — parseMergedExtraction requires { } shape.
    const bareArray = JSON.stringify([{ type: 'fact', value: 'some claim' }]);
    const result = parseMergedExtraction(bareArray);
    expect(result.claims).toHaveLength(0);
    expect(result.triples).toHaveLength(0);
  });

  it('returns safe fallback on malformed JSON', () => {
    const result = parseMergedExtraction('{ "facts": [bad json');
    expect(result.claims).toHaveLength(0);
    expect(result.triples).toHaveLength(0);
  });

  it('returns safe fallback on empty string', () => {
    const result = parseMergedExtraction('');
    expect(result.claims).toHaveLength(0);
    expect(result.triples).toHaveLength(0);
  });

  it('filters out-of-vocab predicates in the triples bucket (T-37-01)', () => {
    const response = JSON.stringify({
      facts: [{ type: 'fact', value: 'some fact' }],
      triples: [
        { subject: 'recense', predicate: 'invented_by', object: 'Max' }, // out-of-vocab → dropped
        { subject: 'recense', predicate: 'built_by', object: 'Max' },   // valid
      ],
    });
    const { claims, triples } = parseMergedExtraction(response);
    expect(claims).toHaveLength(1);
    expect(triples).toHaveLength(1);
    expect(triples[0]!.predicate).toBe('built_by');
  });

  it('filters self-referential triples (T-37-02)', () => {
    const response = JSON.stringify({
      facts: [],
      triples: [
        { subject: 'recense', predicate: 'uses', object: 'recense' }, // self-loop → dropped
        { subject: 'recense', predicate: 'uses', object: 'sqlite3' }, // valid
      ],
    });
    const { triples } = parseMergedExtraction(response);
    expect(triples).toHaveLength(1);
    expect(triples[0]!.object).toBe('sqlite3');
  });

  it('handles missing triples key gracefully (facts-only response)', () => {
    const response = JSON.stringify({
      facts: [{ type: 'fact', value: 'a fact' }],
    });
    const { claims, triples } = parseMergedExtraction(response);
    expect(claims).toHaveLength(1);
    expect(triples).toHaveLength(0);
  });

  it('handles missing facts key gracefully (triples-only response)', () => {
    const response = JSON.stringify({
      triples: [{ subject: 'A', predicate: 'uses', object: 'B' }],
    });
    const { claims, triples } = parseMergedExtraction(response);
    expect(claims).toHaveLength(0);
    expect(triples).toHaveLength(1);
  });

  it('MERGED_EXTRACTION_PROMPT constant exists (source assertion)', () => {
    expect(typeof MERGED_EXTRACTION_PROMPT).toBe('string');
    expect(MERGED_EXTRACTION_PROMPT.length).toBeGreaterThan(100);
    // Must contain the typed vocabulary
    expect(MERGED_EXTRACTION_PROMPT).toContain('built_by');
    expect(MERGED_EXTRACTION_PROMPT).toContain('configured_with');
    // Must specify a JSON object output contract
    expect(MERGED_EXTRACTION_PROMPT).toContain('"facts"');
    expect(MERGED_EXTRACTION_PROMPT).toContain('"triples"');
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
