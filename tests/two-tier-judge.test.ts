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
import { TwoTierJudge, getTwoTierStats, resetTwoTierStats } from '../src/model/judge';
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

/** Judge that returns per-index verdicts from a list (for mixed-batch tests). */
class ListJudge implements Judge {
  batchCalls = 0;
  lastBatchSize = 0;
  constructor(private readonly verdicts: JudgeVerdict[]) {}
  async judge(): Promise<JudgeVerdict> { return this.verdicts[0]!; }
  async judgeBatch(items: Array<{ claim: string; candidates: Array<{ id: string; value: string }> }>): Promise<JudgeVerdict[]> {
    this.batchCalls++;
    this.lastBatchSize = items.length;
    return items.map((_, i) => this.verdicts[i]!);
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

  // judgeBatch is the REAL production path — the consolidator calls judgeBatch([single]) per
  // claim even in non-batch mode, so the two-tier savings MUST live here, not on judge().
  it('judgeBatch: all-cheap-non-contradict accepts cheaply, expensive NOT called', async () => {
    const cheap = new SpyJudge(verdict('unrelated'));
    const expensive = new SpyJudge(verdict('contradict', 'c1', 0.9));
    const tt = new TwoTierJudge(cheap, expensive);

    const rs = await tt.judgeBatch([{ claim: 'a', candidates: CANDS }, { claim: 'b', candidates: CANDS }]);

    expect(rs.map(r => r.relation)).toEqual(['unrelated', 'unrelated']);
    expect(cheap.batchCalls).toBe(1);
    expect(expensive.batchCalls).toBe(0); // the savings
  });

  it('judgeBatch: escalates ONLY the cheap-contradict items to the expensive judge', async () => {
    const cheap = new ListJudge([verdict('contradict', 'c1', 0.5), verdict('unrelated')]);
    const expensive = new ListJudge([verdict('contradict', 'c1', 0.95)]);
    const tt = new TwoTierJudge(cheap, expensive);

    const rs = await tt.judgeBatch([{ claim: 'a', candidates: CANDS }, { claim: 'b', candidates: CANDS }]);

    expect(rs[0]!.magnitude).toBe(0.95);        // item 0 escalated → Sonnet authoritative
    expect(rs[1]!.relation).toBe('unrelated');  // item 1 cheap-accepted
    expect(expensive.batchCalls).toBe(1);
    expect(expensive.lastBatchSize).toBe(1);    // only the 1 contradict item escalated
  });

  it('judgeBatch increments the engagement counter (cheap_calls per item, escalations per contradict)', async () => {
    resetTwoTierStats();
    const cheap = new ListJudge([verdict('contradict', 'c1', 0.5), verdict('confirm', 'c1')]);
    const expensive = new SpyJudge(verdict('contradict', 'c1', 0.9));
    const tt = new TwoTierJudge(cheap, expensive);

    await tt.judgeBatch([{ claim: 'a', candidates: CANDS }, { claim: 'b', candidates: CANDS }]);

    const s = getTwoTierStats();
    expect(s.cheap_calls).toBe(2);   // both items triaged by Haiku
    expect(s.escalations).toBe(1);   // one contradict escalated to Sonnet
  });
});
