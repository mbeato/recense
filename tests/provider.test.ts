/**
 * ModelProvider seam tests (Phase 5, SEAM-01, D-46).
 * All tests use MockModelProvider — no network calls.
 *
 * Covers:
 *  1. Separate-heads: generate/embed/judge are independent entry points.
 *  2. Swap-embed-independence (SEAM-01 SC1): swapping embedFn leaves
 *     generate() and judge() outputs byte-identical.
 */
import { describe, it, expect, vi } from 'vitest';
import { MockModelProvider, DefaultModelProvider } from '../src/model/provider';
import type { ModelProvider } from '../src/model/provider';
import type { JudgeVerdict } from '../src/model/judge';
import { DEFAULT_CONFIG } from '../src/lib/config';

// ── L-12: spy on createAnthropicClient to verify generate() caches the client ──
// vi.hoisted so the spy reference is available inside vi.mock's factory.
const { createClientSpy } = vi.hoisted(() => ({
  createClientSpy: vi.fn(() => ({
    client: {
      messages: {
        create: vi.fn(async () => ({
          content: [{ type: 'text', text: 'cached-response' }],
        })),
      },
    },
    model: 'test-model',
  })),
}));

vi.mock('../src/model/anthropic-client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/model/anthropic-client')>();
  return { ...original, createAnthropicClient: createClientSpy };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Deterministic unit vector for test embedding. */
function makeVecFn(seed: number): (t: string) => Float32Array {
  return (_t: string) => {
    const v = new Float32Array(4);
    v[0] = Math.sin(seed);
    v[1] = Math.cos(seed);
    v[2] = Math.sin(seed * 2);
    v[3] = Math.cos(seed * 2);
    return v;
  };
}

const VERDICT_CONFIRM: JudgeVerdict = {
  best_candidate_id: 'c1',
  relation: 'confirm',
  magnitude: 0.0,
};
const VERDICT_CONTRADICT: JudgeVerdict = {
  best_candidate_id: 'c2',
  relation: 'contradict',
  magnitude: 0.8,
};

// ── MockModelProvider — separate heads ───────────────────────────────────────

describe('MockModelProvider — separate heads', () => {
  it('generate() returns scripted strings in queue order', async () => {
    const mp = new MockModelProvider({
      generateScript: ['hello', 'world'],
      embedFn: makeVecFn(1),
      judgeScript: [VERDICT_CONFIRM],
    });
    expect(await mp.generate('prompt1')).toBe('hello');
    expect(await mp.generate('prompt2')).toBe('world');
  });

  it('embed() maps texts via embedFn — order and count preserved', async () => {
    const fn = makeVecFn(7);
    const mp = new MockModelProvider({ embedFn: fn });
    const results = await mp.embed(['a', 'b', 'c']);
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r).toBeInstanceOf(Float32Array);
      expect(r.length).toBe(4);
    }
  });

  it('judge() returns scripted verdicts in queue order', async () => {
    const mp = new MockModelProvider({
      judgeScript: [VERDICT_CONFIRM, VERDICT_CONTRADICT],
    });
    const v1 = await mp.judge('claim A', [{ id: 'c1', value: 'v1' }]);
    const v2 = await mp.judge('claim B', [{ id: 'c2', value: 'v2' }]);
    expect(v1).toEqual(VERDICT_CONFIRM);
    expect(v2).toEqual(VERDICT_CONTRADICT);
  });

  it('generate() throws on queue exhaustion', async () => {
    const mp = new MockModelProvider({ generateScript: ['only-one'] });
    await mp.generate('p1');
    await expect(mp.generate('p2')).rejects.toThrow(/exhausted/i);
  });

  it('judge() throws on queue exhaustion', async () => {
    const mp = new MockModelProvider({ judgeScript: [VERDICT_CONFIRM] });
    await mp.judge('claim', []);
    await expect(mp.judge('claim2', [])).rejects.toThrow(/exhausted/i);
  });

  it('three heads are independent — all return their own scripted value', async () => {
    const mp = new MockModelProvider({
      generateScript: ['gen-result'],
      embedFn: makeVecFn(3),
      judgeScript: [VERDICT_CONTRADICT],
    });
    const gen = await mp.generate('p');
    const emb = await mp.embed(['x']);
    const jdg = await mp.judge('claim', [{ id: 'c2', value: 'v' }]);
    expect(gen).toBe('gen-result');
    expect(emb).toHaveLength(1);
    expect(emb[0]).toBeInstanceOf(Float32Array);
    expect(jdg).toEqual(VERDICT_CONTRADICT);
  });

  it('satisfies the ModelProvider interface (type-level check via assignment)', () => {
    const mp: ModelProvider = new MockModelProvider({ generateScript: [], judgeScript: [] });
    expect(typeof mp.generate).toBe('function');
    expect(typeof mp.embed).toBe('function');
    expect(typeof mp.judge).toBe('function');
  });
});

// ── SEAM-01 success criterion 1: swap-embed-independence ─────────────────────

describe('SEAM-01: swap-embed-independence', () => {
  it('swapping embedFn leaves generate() output byte-identical', async () => {
    const sharedGen = ['gen-output'];
    const sharedJudge = [VERDICT_CONFIRM];

    const providerA = new MockModelProvider({
      generateScript: [...sharedGen],
      embedFn: makeVecFn(1),
      judgeScript: [...sharedJudge],
    });
    const providerB = new MockModelProvider({
      generateScript: [...sharedGen],
      embedFn: makeVecFn(99), // DIFFERENT embed function
      judgeScript: [...sharedJudge],
    });

    const genA = await providerA.generate('same prompt');
    const genB = await providerB.generate('same prompt');
    expect(genA).toBe(genB);
  });

  it('swapping embedFn leaves judge() output identical', async () => {
    const sharedGen = ['gen-output'];
    const sharedJudge = [VERDICT_CONTRADICT];

    const providerA = new MockModelProvider({
      generateScript: [...sharedGen],
      embedFn: makeVecFn(2),
      judgeScript: [...sharedJudge],
    });
    const providerB = new MockModelProvider({
      generateScript: [...sharedGen],
      embedFn: makeVecFn(50), // DIFFERENT embed function
      judgeScript: [...sharedJudge],
    });

    const jA = await providerA.judge('claim', [{ id: 'c2', value: 'v' }]);
    const jB = await providerB.judge('claim', [{ id: 'c2', value: 'v' }]);
    expect(jA).toEqual(jB);
  });

  it('the differing embedFn produces distinct embed() outputs across the two providers', async () => {
    const providerA = new MockModelProvider({ embedFn: makeVecFn(1) });
    const providerB = new MockModelProvider({ embedFn: makeVecFn(99) });

    const embA = await providerA.embed(['text']);
    const embB = await providerB.embed(['text']);

    // Vectors should differ — makeVecFn(1) ≠ makeVecFn(99)
    let allSame = true;
    for (let i = 0; i < embA[0]!.length; i++) {
      if (Math.abs(embA[0]![i]! - embB[0]![i]!) > 1e-6) {
        allSame = false;
        break;
      }
    }
    expect(allSame).toBe(false);
  });
});

// ── DefaultModelProvider (export / class shape — no network) ─────────────────

describe('DefaultModelProvider (export verification)', () => {
  it('is exported as a constructor function', () => {
    // T-05-KEY: only verifying export exists — no actual instantiation
    // (would require ANTHROPIC_API_KEY / OPENAI_API_KEY in environment)
    expect(typeof DefaultModelProvider).toBe('function');
  });
});

// ── L-12: generate() caches the SDK client across calls ─────────────────────

describe('DefaultModelProvider — generate() client cache (L-12)', () => {
  it('createAnthropicClient is called once even when generate() is called twice', async () => {
    createClientSpy.mockClear();

    const config = { ...DEFAULT_CONFIG, dbPath: ':memory:' };
    const provider = new DefaultModelProvider({
      generateConfig: config,
      judgeConfig: config,
      embedConfig: config,
    });

    // First generate call — should build the client
    await provider.generate('first prompt');
    // Second generate call — must reuse the cached client
    await provider.generate('second prompt');

    expect(createClientSpy).toHaveBeenCalledTimes(1);
  });
});
