/**
 * TwoTierJudge tests (EVAL-04 cost-reduction lever).
 *
 * The two-tier judge runs a CHEAP judge (Haiku) first and escalates to the EXPENSIVE
 * judge (Sonnet) ONLY when the cheap verdict is 'contradict'. This is safe by
 * construction: Haiku's known failure mode is OVER-flagging contradictions (false
 * positives, not false negatives — spike 003), so escalating its 'contradict' verdicts
 * lets Sonnet restore precision, while Haiku rarely MISSES a real contradict. The cheap
 * (non-contradict) verdicts are accepted directly, which is where the token savings come
 * from. No network — uses spy Judge instances.
 */
import { describe, it, expect } from 'vitest';
import { TwoTierJudge } from '../src/model/judge';
import type { Judge, JudgeVerdict } from '../src/model/judge';

/** Spy Judge: returns a fixed verdict and counts how many times it was called. */
class SpyJudge implements Judge {
  calls = 0;
  batchCalls = 0;
  constructor(private readonly verdict: JudgeVerdict) {}
  async judge(): Promise<JudgeVerdict> {
    this.calls++;
    return this.verdict;
  }
  async judgeBatch(items: Array<{ claim: string; candidates: Array<{ id: string; value: string }> }>): Promise<JudgeVerdict[]> {
    this.batchCalls++;
    return items.map(() => this.verdict);
  }
}

const verdict = (relation: JudgeVerdict['relation'], id: string | null = null, magnitude = 0): JudgeVerdict =>
  ({ best_candidate_id: id, relation, magnitude, contradicted_ids: relation === 'contradict' && id ? [id] : [] });

const CANDS = [{ id: 'c1', value: 'v1' }];

describe('TwoTierJudge', () => {
  it('accepts a cheap non-contradict verdict WITHOUT calling the expensive judge', async () => {
    const cheap = new SpyJudge(verdict('confirm', 'c1'));
    const expensive = new SpyJudge(verdict('unrelated'));
    const tt = new TwoTierJudge(cheap, expensive);

    const r = await tt.judge('claim', CANDS);

    expect(r.relation).toBe('confirm');
    expect(cheap.calls).toBe(1);
    expect(expensive.calls).toBe(0); // savings: Sonnet never invoked
  });

  it('accepts a cheap "unrelated" verdict without escalating (the dominant, savings-bearing case)', async () => {
    const cheap = new SpyJudge(verdict('unrelated'));
    const expensive = new SpyJudge(verdict('contradict', 'c1', 0.9));
    const tt = new TwoTierJudge(cheap, expensive);

    const r = await tt.judge('claim', CANDS);

    expect(r.relation).toBe('unrelated');
    expect(expensive.calls).toBe(0);
  });

  it('accepts a cheap "extend" verdict without escalating', async () => {
    const cheap = new SpyJudge(verdict('extend', 'c1'));
    const expensive = new SpyJudge(verdict('unrelated'));
    const tt = new TwoTierJudge(cheap, expensive);

    const r = await tt.judge('claim', CANDS);

    expect(r.relation).toBe('extend');
    expect(expensive.calls).toBe(0);
  });

  it('escalates a cheap "contradict" to the expensive judge and returns the EXPENSIVE verdict', async () => {
    // Haiku over-flags contradict; Sonnet downgrades it to unrelated → over-tombstoning prevented.
    const cheap = new SpyJudge(verdict('contradict', 'c1', 0.8));
    const expensive = new SpyJudge(verdict('unrelated'));
    const tt = new TwoTierJudge(cheap, expensive);

    const r = await tt.judge('claim', CANDS);

    expect(cheap.calls).toBe(1);
    expect(expensive.calls).toBe(1);
    expect(r.relation).toBe('unrelated'); // authoritative Sonnet verdict, not Haiku's
  });

  it('escalates contradict and returns Sonnet-confirmed contradict (with Sonnet magnitude/ids)', async () => {
    const cheap = new SpyJudge(verdict('contradict', 'c1', 0.5));
    const expensive = new SpyJudge(verdict('contradict', 'c1', 0.95));
    const tt = new TwoTierJudge(cheap, expensive);

    const r = await tt.judge('claim', CANDS);

    expect(r.relation).toBe('contradict');
    expect(r.magnitude).toBe(0.95); // Sonnet's magnitude is authoritative
    expect(r.contradicted_ids).toEqual(['c1']);
  });

  it('judgeBatch delegates wholesale to the expensive judge (batching is opt-in; stay authoritative)', async () => {
    const cheap = new SpyJudge(verdict('unrelated'));
    const expensive = new SpyJudge(verdict('confirm', 'c1'));
    const tt = new TwoTierJudge(cheap, expensive);

    const rs = await tt.judgeBatch([{ claim: 'a', candidates: CANDS }, { claim: 'b', candidates: CANDS }]);

    expect(rs).toHaveLength(2);
    expect(expensive.batchCalls).toBe(1);
    expect(cheap.batchCalls).toBe(0);
  });
});
