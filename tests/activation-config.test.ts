import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../src/lib/config';

describe('spread config defaults', () => {
  it('ships the spec §3.1/§4 defaults with the ambient channel on at 2 hops', () => {
    expect(DEFAULT_CONFIG.spreadHops).toBe(2);
    expect(DEFAULT_CONFIG.spreadDamping).toBe(0.6);
    expect(DEFAULT_CONFIG.spreadActivationFloor).toBe(0.005);
    expect(DEFAULT_CONFIG.spreadFrontierCap).toBe(64);
    expect(DEFAULT_CONFIG.spreadFanExponent).toBe(1.0);
    expect(DEFAULT_CONFIG.spreadPathsPerNode).toBe(3);
    expect(DEFAULT_CONFIG.spreadAssocSlotCap).toBe(2);
    expect(DEFAULT_CONFIG.spreadDocSeedWeight).toBe(0.05);
    expect(DEFAULT_CONFIG.spreadRelWeights['relation:*']).toEqual({ fwd: 1.0, rev: 0.8 });
    expect(DEFAULT_CONFIG.spreadRelWeights['doc_containment:*']).toEqual({ fwd: 0, rev: 0 });
  });
});
