import { describe, it, expect } from 'vitest';
import {
  tokenize, lexicalOverlap, isLexicallyDisjoint, dilutionTier, roundRobinSample,
} from '../src/eval/bridge-probes';

describe('tokenize', () => {
  it('lowercases, splits on non-alphanumerics, drops stopwords and short tokens', () => {
    const t = tokenize('The Cloudflare worker runs on the apex domain, and it is fast!');
    expect(t).toEqual(new Set(['cloudflare', 'worker', 'runs', 'apex', 'domain', 'fast']));
  });
});

describe('lexicalOverlap / isLexicallyDisjoint', () => {
  it('counts shared content tokens', () => {
    expect(lexicalOverlap('urby-www runs on Cloudflare', 'Cloudflare Pages hosts the site')).toBe(1);
  });
  it('is disjoint only at zero shared tokens', () => {
    expect(isLexicallyDisjoint('urby-www deploys to Cloudflare', 'the dashboard custom domain is attached')).toBe(true);
    expect(isLexicallyDisjoint('urby-www deploys to Cloudflare', 'Cloudflare dashboard custom domain')).toBe(false);
  });
});

describe('dilutionTier', () => {
  it('maps out-degree to lo/mid/hi by terciles', () => {
    expect(dilutionTier(1, [3, 8])).toBe('lo');
    expect(dilutionTier(3, [3, 8])).toBe('mid');
    expect(dilutionTier(9, [3, 8])).toBe('hi');
  });
});

describe('roundRobinSample', () => {
  it('draws evenly across strata in deterministic key order and never exceeds target', () => {
    const items = [
      { stratum: 'a', id: 'a1' }, { stratum: 'a', id: 'a2' }, { stratum: 'a', id: 'a3' },
      { stratum: 'b', id: 'b1' }, { stratum: 'c', id: 'c1' }, { stratum: 'c', id: 'c2' },
    ];
    const out = roundRobinSample(items, 4, i => i.id);
    expect(out.map(i => i.id)).toEqual(['a1', 'b1', 'c1', 'a2']);
  });
  it('returns everything when target exceeds supply', () => {
    const items = [{ stratum: 'a', id: 'a1' }, { stratum: 'b', id: 'b1' }];
    expect(roundRobinSample(items, 10, i => i.id)).toHaveLength(2);
  });
});
