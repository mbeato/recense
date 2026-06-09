/**
 * DEBT-01 guard: assert that the committed DEFAULT_CONFIG telegram block is
 * fail-closed. This test catches any regression that ships `enable: true` or a
 * non-empty allowlist in the committed config (T-09-01).
 *
 * Pitfall 5 note (from 09-RESEARCH.md): we assert the COMPILED DEFAULT_CONFIG
 * value at runtime — this is immune to source-text comments and test fixtures.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../src/lib/config';

describe('DEFAULT_CONFIG telegram — fail-closed guard (DEBT-01 / T-09-01)', () => {
  it('telegram.enable is false in the committed default', () => {
    expect(DEFAULT_CONFIG.telegram.enable).toBe(false);
  });

  it('telegram.allowlist is empty in the committed default', () => {
    expect(DEFAULT_CONFIG.telegram.allowlist).toHaveLength(0);
  });
});
