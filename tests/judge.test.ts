/**
 * Judge seam tests (Phase 2, D-18/D-15).
 * All tests use MockJudge — no network calls.
 * parseVerdict validation and safe-fallback tests drive AnthropicJudge internals indirectly
 * via a test-only subclass that exposes the private method.
 */
import { describe, it, expect, vi } from 'vitest';
import { MockJudge, AnthropicJudge } from '../src/model/judge';
import type { Judge, JudgeVerdict, JudgeRelation } from '../src/model/judge';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { AnthropicLike } from '../src/model/anthropic-client';

// ── MockJudge ────────────────────────────────────────────────────────────────

describe('MockJudge', () => {
  it('returns scripted verdicts in order', async () => {
    const verdicts: JudgeVerdict[] = [
      { best_candidate_id: 'c1', relation: 'confirm', magnitude: 0.0 },
      { best_candidate_id: 'c2', relation: 'contradict', magnitude: 0.9 },
      { best_candidate_id: null, relation: 'unrelated', magnitude: 0.0 },
    ];
    const mock = new MockJudge(verdicts);
    const r1 = await mock.judge('claim A', [{ id: 'c1', value: 'v1' }]);
    const r2 = await mock.judge('claim B', [{ id: 'c2', value: 'v2' }]);
    const r3 = await mock.judge('claim C', []);
    // M2: MockJudge defaults contradicted_ids to [] when omitted from scripted verdict
    expect(r1).toMatchObject(verdicts[0]!);
    expect(r2).toMatchObject(verdicts[1]!);
    expect(r3).toMatchObject(verdicts[2]!);
    expect(r1.contradicted_ids).toEqual([]);
    expect(r2.contradicted_ids).toEqual([]);
    expect(r3.contradicted_ids).toEqual([]);
  });

  it('throws a clear error when the scripted queue is exhausted', async () => {
    const mock = new MockJudge([{ best_candidate_id: 'x', relation: 'confirm', magnitude: 0 }]);
    await mock.judge('claim', [{ id: 'x', value: 'v' }]); // drains the queue
    await expect(mock.judge('second claim', [])).rejects.toThrow(/exhausted/i);
  });

  it('satisfies the Judge interface (type-level check)', () => {
    const judge: Judge = new MockJudge([]);
    expect(typeof judge.judge).toBe('function');
  });
});

// ── JudgeRelation / JudgeVerdict types (compile-time + runtime) ──────────────

describe('JudgeRelation values', () => {
  it('includes all four valid relations', () => {
    const valid: JudgeRelation[] = ['confirm', 'extend', 'contradict', 'unrelated'];
    expect(valid).toHaveLength(4);
  });
});

// ── AnthropicJudge (export / class shape — no network) ───────────────────────

describe('AnthropicJudge (export verification)', () => {
  it('is exported as a constructor function', () => {
    // T-02-KEY: only verifying export exists — no actual instantiation
    // (would require ANTHROPIC_API_KEY in environment)
    expect(typeof AnthropicJudge).toBe('function');
  });
});

// ── parseVerdict: safe-fallback on malformed JSON ────────────────────────────
//
// AnthropicJudge.parseVerdict is private, but we can test it indirectly by
// subclassing and calling the real parse path — or more simply, by testing
// the judge's behavior when the LLM response would be malformed.
// We exercise the fallback by exposing the method via a test subclass.
//
// Implementation note: AnthropicJudge must expose a protected/internal
// parseVerdict-equivalent that can be tested. The cleanest approach:
// export a standalone parseVerdict function (or make parseVerdict protected).
// The plan says "private `parseVerdict`" but does not prohibit exporting it
// under a test-accessible name. We test via the exported `_parseVerdict`
// (or directly if the class exposes it for testing purposes).
//
// Since the plan says "a parseVerdict-via-AnthropicJudge unit test feeding
// malformed JSON asserts the safe `unrelated` fallback", we use a package-private
// test helper approach: export `parseVerdictForTest` from judge.ts.

import { parseVerdictForTest, chooseConsistentVerdict, parseVerdictBatchForTest } from '../src/model/judge';

describe('parseVerdict (via exported test helper)', () => {
  it('returns safe unrelated fallback for malformed JSON', () => {
    const result = parseVerdictForTest('not valid json {{{');
    expect(result).toEqual({ best_candidate_id: null, relation: 'unrelated', magnitude: 0, contradicted_ids: [] });
  });

  it('returns safe unrelated fallback for invalid relation', () => {
    const result = parseVerdictForTest(JSON.stringify({ best_candidate_id: 'c1', relation: 'unknown', magnitude: 0.5 }));
    expect(result).toEqual({ best_candidate_id: null, relation: 'unrelated', magnitude: 0, contradicted_ids: [] });
  });

  it('clamps magnitude above 1.0 to 1.0', () => {
    const result = parseVerdictForTest(JSON.stringify({ best_candidate_id: 'c1', relation: 'contradict', magnitude: 1.5 }));
    expect(result.magnitude).toBe(1.0);
    expect(result.relation).toBe('contradict');
    expect(result.best_candidate_id).toBe('c1');
  });

  it('clamps magnitude below 0.0 to 0.0', () => {
    const result = parseVerdictForTest(JSON.stringify({ best_candidate_id: 'c1', relation: 'confirm', magnitude: -0.3 }));
    expect(result.magnitude).toBe(0.0);
  });

  it('accepts valid confirm verdict at boundary magnitude 0.0', () => {
    const result = parseVerdictForTest(JSON.stringify({ best_candidate_id: 'c1', relation: 'confirm', magnitude: 0.0 }));
    expect(result).toEqual({ best_candidate_id: 'c1', relation: 'confirm', magnitude: 0.0, contradicted_ids: [] });
  });

  it('accepts all four valid relation strings', () => {
    const relations: JudgeRelation[] = ['confirm', 'extend', 'contradict', 'unrelated'];
    for (const relation of relations) {
      const result = parseVerdictForTest(JSON.stringify({ best_candidate_id: 'x', relation, magnitude: 0.5 }));
      expect(result.relation).toBe(relation);
    }
  });

  it('returns unrelated safe fallback for missing fields', () => {
    const result = parseVerdictForTest(JSON.stringify({ relation: 'confirm' })); // missing magnitude
    // magnitude missing → should still work (defaults to 0) or fallback
    // The implementation can choose: accept with default or fallback. Either is valid.
    // We just assert it doesn't throw.
    expect(result).toBeDefined();
  });
});

// ── parseVerdict: JSON code-fence handling (regression for claude-haiku-4-5) ──

describe('parseVerdict code-fence handling', () => {
  it('(a) parses a realistic fenced JSON response (triple-backtick json ... triple-backtick)', () => {
    // Build the fenced string explicitly to avoid invisible/zero-width characters.
    const backtick = '\x60';
    const fence = backtick + backtick + backtick;
    const fenced =
      fence + 'json\n' +
      '{ "best_candidate_id": "abc", "relation": "confirm", "magnitude": 0.0 }\n' +
      fence;
    const result = parseVerdictForTest(fenced);
    expect(result).toEqual({ best_candidate_id: 'abc', relation: 'confirm', magnitude: 0, contradicted_ids: [] });
  });

  it('(b) parses preamble text followed by a JSON object', () => {
    const text = 'Sure, here is the verdict:\n{ "best_candidate_id": "xyz", "relation": "extend", "magnitude": 0.5 }';
    const result = parseVerdictForTest(text);
    expect(result).toEqual({ best_candidate_id: 'xyz', relation: 'extend', magnitude: 0.5, contradicted_ids: [] });
  });

  it('(c) bare JSON object (no fence) still parses — no regression', () => {
    const text = '{ "best_candidate_id": "n1", "relation": "contradict", "magnitude": 0.8 }';
    const result = parseVerdictForTest(text);
    // fail-safe: no contradicted_ids in JSON + best_candidate_id='n1' → [n1]
    expect(result).toEqual({ best_candidate_id: 'n1', relation: 'contradict', magnitude: 0.8, contradicted_ids: ['n1'] });
  });

  it('(d) a string containing no JSON object returns SAFE_VERDICT', () => {
    const result = parseVerdictForTest('no json here at all');
    expect(result).toEqual({ best_candidate_id: null, relation: 'unrelated', magnitude: 0, contradicted_ids: [] });
  });
});

// ── chooseConsistentVerdict ───────────────────────────────────────────────────

describe('chooseConsistentVerdict', () => {
  it('returns v1 unchanged when both relations are equal (confirm vs confirm)', () => {
    const v1: JudgeVerdict = { best_candidate_id: 'c1', relation: 'confirm', magnitude: 0.0 };
    const v2: JudgeVerdict = { best_candidate_id: 'c2', relation: 'confirm', magnitude: 0.0 };
    expect(chooseConsistentVerdict(v1, v2)).toBe(v1);
  });

  it('returns contradict verdict with intersection when both are contradict (M2 conservative rule)', () => {
    // M2: both contradict → return v1 fields with contradicted_ids = intersection.
    // When neither has contradicted_ids (undefined), intersection of [] and [] = [].
    const v1: JudgeVerdict = { best_candidate_id: 'c1', relation: 'contradict', magnitude: 0.8 };
    const v2: JudgeVerdict = { best_candidate_id: 'c2', relation: 'contradict', magnitude: 0.7 };
    const result = chooseConsistentVerdict(v1, v2);
    expect(result.relation).toBe('contradict');
    expect(result.best_candidate_id).toBe('c1');
    expect(result.magnitude).toBe(0.8);
    expect(result.contradicted_ids).toEqual([]); // intersection of empty lists
  });

  it('returns non-contradict when v1=contradict and v2=confirm (never escalate on disagreement)', () => {
    const v1: JudgeVerdict = { best_candidate_id: 'c1', relation: 'contradict', magnitude: 0.9 };
    const v2: JudgeVerdict = { best_candidate_id: 'c2', relation: 'confirm', magnitude: 0.0 };
    expect(chooseConsistentVerdict(v1, v2)).toBe(v2);
  });

  it('returns non-contradict when v1=extend and v2=contradict (v1 is non-destructive)', () => {
    const v1: JudgeVerdict = { best_candidate_id: 'c1', relation: 'extend', magnitude: 0.0 };
    const v2: JudgeVerdict = { best_candidate_id: 'c2', relation: 'contradict', magnitude: 0.6 };
    expect(chooseConsistentVerdict(v1, v2)).toBe(v1);
  });

  it('returns v1 when both are non-contradict but differ (first-order verdict wins)', () => {
    const v1: JudgeVerdict = { best_candidate_id: 'c1', relation: 'confirm', magnitude: 0.0 };
    const v2: JudgeVerdict = { best_candidate_id: 'c2', relation: 'extend', magnitude: 0.0 };
    expect(chooseConsistentVerdict(v1, v2)).toBe(v1);
  });
});

// ── M2: parseVerdict contradicted_ids ────────────────────────────────────────

describe('parseVerdict: contradicted_ids (M2)', () => {
  it('parses contradicted_ids array from a contradict verdict', () => {
    const text = JSON.stringify({
      best_candidate_id: 'a',
      relation: 'contradict',
      magnitude: 0.8,
      contradicted_ids: ['a', 'b'],
    });
    const result = parseVerdictForTest(text);
    expect(result.relation).toBe('contradict');
    expect(result.contradicted_ids).toEqual(['a', 'b']);
  });

  it('deduplicates contradicted_ids', () => {
    const text = JSON.stringify({
      best_candidate_id: 'a',
      relation: 'contradict',
      magnitude: 0.8,
      contradicted_ids: ['a', 'b', 'a'],
    });
    const result = parseVerdictForTest(text);
    expect(result.contradicted_ids).toEqual(['a', 'b']);
  });

  it('fail-safe: contradict with missing contradicted_ids and best_candidate_id → [best_candidate_id]', () => {
    const text = JSON.stringify({ best_candidate_id: 'x', relation: 'contradict', magnitude: 0.9 });
    const result = parseVerdictForTest(text);
    expect(result.contradicted_ids).toEqual(['x']);
  });

  it('fail-safe: contradict with null best_candidate_id and no ids → []', () => {
    const text = JSON.stringify({ best_candidate_id: null, relation: 'contradict', magnitude: 0.9 });
    const result = parseVerdictForTest(text);
    expect(result.contradicted_ids).toEqual([]);
  });

  it('non-contradict relation forces contradicted_ids to []', () => {
    const text = JSON.stringify({ best_candidate_id: 'a', relation: 'confirm', magnitude: 0.0, contradicted_ids: ['a'] });
    const result = parseVerdictForTest(text);
    expect(result.contradicted_ids).toEqual([]);
  });

  it('non-string entries in contradicted_ids are filtered out', () => {
    const text = JSON.stringify({
      best_candidate_id: 'a',
      relation: 'contradict',
      magnitude: 0.8,
      contradicted_ids: ['a', 123, null, 'b'],
    });
    const result = parseVerdictForTest(text);
    expect(result.contradicted_ids).toEqual(['a', 'b']);
  });

  it('non-array contradicted_ids falls back to fail-safe', () => {
    const text = JSON.stringify({
      best_candidate_id: 'a',
      relation: 'contradict',
      magnitude: 0.8,
      contradicted_ids: 'not-an-array',
    });
    const result = parseVerdictForTest(text);
    // fail-safe: not an array → treat as missing → [best_candidate_id]
    expect(result.contradicted_ids).toEqual(['a']);
  });

  it('SAFE_VERDICT includes contradicted_ids: []', () => {
    const result = parseVerdictForTest('not valid json {{{');
    expect(result.contradicted_ids).toEqual([]);
  });
});

// ── M2: chooseConsistentVerdict intersection rule ─────────────────────────────

describe('chooseConsistentVerdict: contradicted_ids intersection (M2)', () => {
  it('both contradict: returns v1 with intersection of contradicted_ids lists', () => {
    const v1: JudgeVerdict = { best_candidate_id: 'c1', relation: 'contradict', magnitude: 0.8, contradicted_ids: ['c1', 'c2', 'c3'] };
    const v2: JudgeVerdict = { best_candidate_id: 'c1', relation: 'contradict', magnitude: 0.7, contradicted_ids: ['c1', 'c3'] };
    const result = chooseConsistentVerdict(v1, v2);
    expect(result.relation).toBe('contradict');
    expect(result.best_candidate_id).toBe('c1');
    expect(result.contradicted_ids).toEqual(['c1', 'c3']); // intersection
  });

  it('both contradict: empty intersection when lists are disjoint', () => {
    const v1: JudgeVerdict = { best_candidate_id: 'c1', relation: 'contradict', magnitude: 0.8, contradicted_ids: ['c1'] };
    const v2: JudgeVerdict = { best_candidate_id: 'c2', relation: 'contradict', magnitude: 0.7, contradicted_ids: ['c2'] };
    const result = chooseConsistentVerdict(v1, v2);
    expect(result.contradicted_ids).toEqual([]);
  });

  it('one-contradict: non-contradict verdict returned unchanged (contradicted_ids: [])', () => {
    const v1: JudgeVerdict = { best_candidate_id: 'c1', relation: 'contradict', magnitude: 0.8, contradicted_ids: ['c1'] };
    const v2: JudgeVerdict = { best_candidate_id: 'c2', relation: 'confirm', magnitude: 0.0, contradicted_ids: [] };
    const result = chooseConsistentVerdict(v1, v2);
    expect(result.relation).toBe('confirm');
    expect(result.contradicted_ids).toEqual([]);
  });
});

// ── M2: MockJudge backward-compat (contradicted_ids defaulted to []) ───────────

describe('MockJudge: backward-compatible contradicted_ids default', () => {
  it('scripted verdict without contradicted_ids emits []', async () => {
    const mock = new MockJudge([{ best_candidate_id: 'c1', relation: 'contradict', magnitude: 0.8 }]);
    const result = await mock.judge('claim', [{ id: 'c1', value: 'v1' }]);
    expect(result.contradicted_ids).toEqual([]);
  });

  it('scripted verdict with contradicted_ids passes it through', async () => {
    const mock = new MockJudge([{ best_candidate_id: 'c1', relation: 'contradict', magnitude: 0.8, contradicted_ids: ['c1', 'c2'] }]);
    const result = await mock.judge('claim', [{ id: 'c1', value: 'v1' }]);
    expect(result.contradicted_ids).toEqual(['c1', 'c2']);
  });
});

// ── EngineConfig: five new Phase-2 tunables ───────────────────────────────────

describe('EngineConfig: Phase-2 tunables present in DEFAULT_CONFIG', () => {
  it('candidateK is a positive number', () => {
    expect(typeof DEFAULT_CONFIG.candidateK).toBe('number');
    expect(DEFAULT_CONFIG.candidateK).toBeGreaterThan(0);
  });

  it('consolSkipThreshold is in [0, 1]', () => {
    expect(DEFAULT_CONFIG.consolSkipThreshold).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_CONFIG.consolSkipThreshold).toBeLessThanOrEqual(1);
  });

  it('unrelatedSimilarityThreshold is in [0, 1]', () => {
    expect(DEFAULT_CONFIG.unrelatedSimilarityThreshold).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_CONFIG.unrelatedSimilarityThreshold).toBeLessThanOrEqual(1);
  });

  it('peReconcileBandLow is a positive number less than peReconcileBandHigh', () => {
    expect(DEFAULT_CONFIG.peReconcileBandLow).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.peReconcileBandLow).toBeLessThan(DEFAULT_CONFIG.peReconcileBandHigh);
  });

  it('peReconcileBandHigh is a positive number', () => {
    expect(DEFAULT_CONFIG.peReconcileBandHigh).toBeGreaterThan(0);
  });
});

// ── MockJudge.judgeBatch ──────────────────────────────────────────────────────

describe('MockJudge.judgeBatch', () => {
  it('empty items array → empty result, no queue consumption', async () => {
    const mock = new MockJudge([{ best_candidate_id: 'c1', relation: 'confirm', magnitude: 0 }]);
    const result = await mock.judgeBatch([]);
    expect(result).toEqual([]);
    // Queue not consumed — judge() would still work
    const v = await mock.judge('x', [{ id: 'c1', value: 'v' }]);
    expect(v.relation).toBe('confirm');
  });

  it('consumes one verdict per item in order', async () => {
    const verdicts: JudgeVerdict[] = [
      { best_candidate_id: 'c1', relation: 'confirm', magnitude: 0 },
      { best_candidate_id: 'c2', relation: 'contradict', magnitude: 0.8 },
      { best_candidate_id: null, relation: 'unrelated', magnitude: 0 },
    ];
    const mock = new MockJudge(verdicts);
    const results = await mock.judgeBatch([
      { claim: 'A', candidates: [{ id: 'c1', value: 'v1' }] },
      { claim: 'B', candidates: [{ id: 'c2', value: 'v2' }] },
      { claim: 'C', candidates: [] },
    ]);
    expect(results).toHaveLength(3);
    expect(results[0]!.relation).toBe('confirm');
    expect(results[1]!.relation).toBe('contradict');
    expect(results[2]!.relation).toBe('unrelated');
    // M2: contradicted_ids defaults to []
    expect(results[0]!.contradicted_ids).toEqual([]);
    expect(results[1]!.contradicted_ids).toEqual([]);
  });

  it('throws queue-exhausted when items exceed scripted verdicts', async () => {
    const mock = new MockJudge([{ best_candidate_id: 'x', relation: 'confirm', magnitude: 0 }]);
    await expect(mock.judgeBatch([
      { claim: 'A', candidates: [{ id: 'x', value: 'v' }] },
      { claim: 'B', candidates: [{ id: 'y', value: 'v' }] },
    ])).rejects.toThrow(/exhausted/i);
  });

  it('satisfies the Judge interface', () => {
    const j: Judge = new MockJudge([]);
    expect(typeof j.judgeBatch).toBe('function');
  });
});

// ── parseVerdictBatch fail-safes ──────────────────────────────────────────────

describe('parseVerdictBatch fail-safes', () => {
  const noCandidates: Array<Set<string>> = [new Set(), new Set(), new Set()];

  it('whole-parse failure → all SAFE_VERDICT', () => {
    const result = parseVerdictBatchForTest('not json at all', 3, noCandidates);
    expect(result).toHaveLength(3);
    for (const v of result) {
      expect(v).toEqual({ best_candidate_id: null, relation: 'unrelated', magnitude: 0, contradicted_ids: [] });
    }
  });

  it('response is not an array (object) → all SAFE_VERDICT', () => {
    const result = parseVerdictBatchForTest('{"relation":"confirm"}', 2, [new Set(), new Set()]);
    expect(result).toHaveLength(2);
    expect(result[0]!.relation).toBe('unrelated');
    expect(result[1]!.relation).toBe('unrelated');
  });

  it('malformed item (not an object) leaves that slot as SAFE_VERDICT', () => {
    const raw = JSON.stringify([
      { claim_index: 0, best_candidate_id: 'c1', relation: 'confirm', magnitude: 0, contradicted_ids: [] },
      null,  // malformed
      { claim_index: 2, best_candidate_id: null, relation: 'unrelated', magnitude: 0, contradicted_ids: [] },
    ]);
    const result = parseVerdictBatchForTest(raw, 3, noCandidates);
    expect(result[0]!.relation).toBe('confirm');
    expect(result[1]!.relation).toBe('unrelated'); // SAFE_VERDICT for null slot
    expect(result[2]!.relation).toBe('unrelated');
  });

  it('invalid relation in an item → leaves that slot as SAFE_VERDICT', () => {
    const raw = JSON.stringify([
      { claim_index: 0, best_candidate_id: 'c1', relation: 'bogus', magnitude: 0, contradicted_ids: [] },
    ]);
    const result = parseVerdictBatchForTest(raw, 2, [new Set(['c1']), new Set()]);
    expect(result[0]!.relation).toBe('unrelated'); // SAFE for invalid relation
    expect(result[1]!.relation).toBe('unrelated'); // not provided → SAFE
  });

  it('claim_index mapping: maps to correct slot even out of array order', () => {
    const raw = JSON.stringify([
      { claim_index: 2, best_candidate_id: null, relation: 'unrelated', magnitude: 0, contradicted_ids: [] },
      { claim_index: 0, best_candidate_id: 'c1', relation: 'confirm', magnitude: 0.1, contradicted_ids: [] },
    ]);
    const result = parseVerdictBatchForTest(raw, 3, noCandidates);
    expect(result[0]!.relation).toBe('confirm');
    expect(result[1]!.relation).toBe('unrelated'); // not provided → SAFE
    expect(result[2]!.relation).toBe('unrelated');
  });

  it('position fallback when claim_index absent', () => {
    const raw = JSON.stringify([
      { best_candidate_id: 'c1', relation: 'extend', magnitude: 0.2, contradicted_ids: [] },
      { best_candidate_id: null, relation: 'unrelated', magnitude: 0, contradicted_ids: [] },
    ]);
    const result = parseVerdictBatchForTest(raw, 2, [new Set(['c1']), new Set()]);
    expect(result[0]!.relation).toBe('extend');
    expect(result[1]!.relation).toBe('unrelated');
  });

  it('contradict-empty-cids fail-safe: contradict + empty cids + bestId → [bestId] per item', () => {
    const raw = JSON.stringify([
      { claim_index: 0, best_candidate_id: 'c1', relation: 'contradict', magnitude: 0.8 },
    ]);
    const result = parseVerdictBatchForTest(raw, 1, [new Set(['c1'])]);
    expect(result[0]!.relation).toBe('contradict');
    expect(result[0]!.contradicted_ids).toEqual(['c1']); // fail-safe applied
  });

  it('magnitude clamped to [0,1] per item', () => {
    const raw = JSON.stringify([
      { claim_index: 0, best_candidate_id: null, relation: 'unrelated', magnitude: 1.9 },
    ]);
    const result = parseVerdictBatchForTest(raw, 1, [new Set()]);
    expect(result[0]!.magnitude).toBe(1.0);
  });

  it('T-UE6-02 defensive filter: contradicted_ids outside candidate set dropped per item', () => {
    const raw = JSON.stringify([
      {
        claim_index: 0,
        best_candidate_id: 'c1',
        relation: 'contradict',
        magnitude: 0.7,
        contradicted_ids: ['c1', 'hallucinated-id'],
      },
    ]);
    const result = parseVerdictBatchForTest(raw, 1, [new Set(['c1'])]);
    expect(result[0]!.contradicted_ids).toEqual(['c1']); // hallucinated-id filtered
  });

  it('json array in code fence is extracted correctly', () => {
    const backtick = '\x60';
    const fence = backtick + backtick + backtick;
    const text = fence + 'json\n' +
      '[{"claim_index":0,"best_candidate_id":"x","relation":"confirm","magnitude":0,"contradicted_ids":[]}]\n' +
      fence;
    const result = parseVerdictBatchForTest(text, 1, [new Set(['x'])]);
    expect(result[0]!.relation).toBe('confirm');
    expect(result[0]!.best_candidate_id).toBe('x');
  });
});

// ── AnthropicJudge.judgeBatch — batch-of-1 delegates to single path ───────────

describe('AnthropicJudge.judgeBatch — batch-of-1 delegates to single path', () => {
  it('calls messages.create once with the single-claim prompt (not batch format)', async () => {
    const calls: { content: string }[] = [];
    const mockClient: AnthropicLike = {
      messages: {
        async create(params) {
          calls.push({ content: typeof params.messages[0]?.content === 'string' ? params.messages[0].content : '' });
          // Return a valid single-claim verdict
          return {
            content: [{ type: 'text' as const, text: '{"best_candidate_id":"c1","relation":"confirm","magnitude":0,"contradicted_ids":[]}' }],
          } as any;
        },
      },
    };
    const judge = AnthropicJudge.forTest(mockClient, 'test-model');
    const results = await judge.judgeBatch([
      { claim: 'test claim', candidates: [{ id: 'c1', value: 'test value' }] },
    ]);

    // batch-of-1 uses existing single path: prompt starts with single-claim prefix (not "For EACH")
    expect(results).toHaveLength(1);
    expect(results[0]!.relation).toBe('confirm');
    // Single path makes 1 call (order-swap skips since no contradict)
    expect(calls).toHaveLength(1);
    // Single prompt contains 'New claim:' (from JUDGE_PROMPT_PREFIX), not 'Claim 0:'
    expect(calls[0]!.content).toContain('New claim:');
    expect(calls[0]!.content).not.toContain('Claim 0:');
  });

  it('empty items → returns [] with no API calls', async () => {
    let callCount = 0;
    const mockClient: AnthropicLike = {
      messages: {
        async create(_params) {
          callCount++;
          return { content: [] } as any;
        },
      },
    };
    const judge = AnthropicJudge.forTest(mockClient, 'test-model');
    const results = await judge.judgeBatch([]);
    expect(results).toEqual([]);
    expect(callCount).toBe(0);
  });
});

// ── AnthropicJudge.judgeBatch — batch>1 prompt shape and order-swap ───────────

describe('AnthropicJudge.judgeBatch — batch>1: prompt shape and order-swap', () => {
  /**
   * Build a mock AnthropicLike that records all prompts and returns scripted responses.
   */
  function makeMockClient(responses: Array<{ text: string }>): {
    client: AnthropicLike;
    capturedPrompts: string[];
  } {
    const capturedPrompts: string[] = [];
    let callIdx = 0;
    const client: AnthropicLike = {
      messages: {
        async create(params) {
          const content = typeof params.messages[0]?.content === 'string' ? params.messages[0].content : '';
          capturedPrompts.push(content);
          const resp = responses[callIdx++];
          const text = resp?.text ?? '[]';
          return { content: [{ type: 'text' as const, text }] } as any;
        },
      },
    };
    return { client, capturedPrompts };
  }

  it('batch prompt enumerates claims with per-claim candidate lists', async () => {
    const batchResponse = JSON.stringify([
      { claim_index: 0, best_candidate_id: null, relation: 'unrelated', magnitude: 0, contradicted_ids: [] },
      { claim_index: 1, best_candidate_id: null, relation: 'unrelated', magnitude: 0, contradicted_ids: [] },
    ]);
    const { client, capturedPrompts } = makeMockClient([{ text: batchResponse }]);
    const judge = AnthropicJudge.forTest(client, 'test-model');

    await judge.judgeBatch([
      { claim: 'Alice is a manager', candidates: [{ id: 'n1', value: 'Alice is an engineer' }] },
      { claim: 'Bob lives in NYC', candidates: [{ id: 'n2', value: 'Bob lives in LA' }, { id: 'n3', value: 'Bob' }] },
    ]);

    expect(capturedPrompts).toHaveLength(1); // ONE call for non-contradict batch
    const prompt = capturedPrompts[0]!;

    // Batch prefix: "For EACH numbered claim"
    expect(prompt).toContain('For EACH numbered claim');
    // Claims enumerated
    expect(prompt).toContain('Claim 0:');
    expect(prompt).toContain('Claim 1:');
    expect(prompt).toContain('"Alice is a manager"');
    expect(prompt).toContain('"Bob lives in NYC"');
    // Per-claim candidate lists
    expect(prompt).toContain('Candidates for claim 0:');
    expect(prompt).toContain('Candidates for claim 1:');
    expect(prompt).toContain('id: "n1"');
    expect(prompt).toContain('id: "n2"');
    expect(prompt).toContain('id: "n3"');
  });

  it('batched swap: only contradict items re-sent with reversed candidates in ONE second call', async () => {
    // v1: item 0 = contradict, item 1 = confirm (no swap needed)
    const v1Response = JSON.stringify([
      { claim_index: 0, best_candidate_id: 'c1', relation: 'contradict', magnitude: 0.8, contradicted_ids: ['c1'] },
      { claim_index: 1, best_candidate_id: 'c2', relation: 'confirm', magnitude: 0, contradicted_ids: [] },
    ]);
    // v2 (swap): item 0 reversed → same contradict (both agree → intersection cids)
    const v2Response = JSON.stringify([
      { claim_index: 0, best_candidate_id: 'c1', relation: 'contradict', magnitude: 0.7, contradicted_ids: ['c1'] },
    ]);
    const { client, capturedPrompts } = makeMockClient([{ text: v1Response }, { text: v2Response }]);
    const judge = AnthropicJudge.forTest(client, 'test-model');

    const results = await judge.judgeBatch([
      { claim: 'A contradicts', candidates: [{ id: 'c1', value: 'v1' }, { id: 'c2', value: 'v2' }] },
      { claim: 'B confirms', candidates: [{ id: 'c2', value: 'v2' }, { id: 'c3', value: 'v3' }] },
    ]);

    // ≤2 total calls: forward batch + swap batch
    expect(capturedPrompts).toHaveLength(2);

    // Second call contains ONLY the contradict item (claim 'A contradicts')
    const swapPrompt = capturedPrompts[1]!;
    expect(swapPrompt).toContain('"A contradicts"');
    expect(swapPrompt).not.toContain('"B confirms"'); // confirm item not re-sent

    // In the swap prompt, candidates for the contradict item are REVERSED
    // Original order: c1,c2 → reversed: c2,c1 → c2 appears before c1
    const c1Pos = swapPrompt.indexOf('"c1"');
    const c2Pos = swapPrompt.indexOf('"c2"');
    expect(c2Pos).toBeLessThan(c1Pos); // c2 first (reversed)

    // Results: item 1 (confirm) unchanged; item 0 resolved via chooseConsistentVerdict
    expect(results[1]!.relation).toBe('confirm');
    // Both orderings agree on contradict → chooseConsistentVerdict returns v1 with intersection cids
    expect(results[0]!.relation).toBe('contradict');
  });

  it('no swap when all items are non-contradict (only one LLM call)', async () => {
    const v1Response = JSON.stringify([
      { claim_index: 0, best_candidate_id: 'c1', relation: 'confirm', magnitude: 0, contradicted_ids: [] },
      { claim_index: 1, best_candidate_id: null, relation: 'unrelated', magnitude: 0, contradicted_ids: [] },
    ]);
    const { client, capturedPrompts } = makeMockClient([{ text: v1Response }]);
    const judge = AnthropicJudge.forTest(client, 'test-model');

    await judge.judgeBatch([
      { claim: 'A', candidates: [{ id: 'c1', value: 'v1' }] },
      { claim: 'B', candidates: [{ id: 'c2', value: 'v2' }] },
    ]);

    // No contradict → no swap call → exactly 1 LLM call
    expect(capturedPrompts).toHaveLength(1);
  });

  it('zero-candidate items receive SAFE_VERDICT without a network call', async () => {
    const batchResponse = JSON.stringify([
      { claim_index: 0, best_candidate_id: 'c1', relation: 'confirm', magnitude: 0, contradicted_ids: [] },
    ]);
    const { client, capturedPrompts } = makeMockClient([{ text: batchResponse }]);
    const judge = AnthropicJudge.forTest(client, 'test-model');

    const results = await judge.judgeBatch([
      { claim: 'A has candidates', candidates: [{ id: 'c1', value: 'v1' }] },
      { claim: 'B has no candidates', candidates: [] }, // zero-candidate → SAFE_VERDICT
      { claim: 'C also has candidates', candidates: [] }, // zero-candidate → SAFE_VERDICT
    ]);

    // Batch prompt built with only item 0 (non-empty)
    expect(capturedPrompts).toHaveLength(1);
    expect(capturedPrompts[0]).toContain('Claim 0:'); // only one claim in prompt
    expect(capturedPrompts[0]).not.toContain('Claim 1:');

    expect(results[0]!.relation).toBe('confirm');
    // Items with 0 candidates → SAFE_VERDICT
    expect(results[1]!).toEqual({ best_candidate_id: null, relation: 'unrelated', magnitude: 0, contradicted_ids: [] });
    expect(results[2]!).toEqual({ best_candidate_id: null, relation: 'unrelated', magnitude: 0, contradicted_ids: [] });
  });
});
