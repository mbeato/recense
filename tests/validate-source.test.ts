/**
 * Unit tests for validateSource (ACT-03 / D-43 audit-provenance allowlist).
 *
 * TDD RED — these tests fail until validateSource is exported from memory-ops.ts.
 *
 * validateSource mirrors validateOrigin's exact-match-or-clamp discipline:
 *   - Returns 'hitl' ONLY when raw === 'hitl' (the sole ACT-03 allowed override).
 *   - Returns fallback for every other value: undefined, 'http', unknown spoofs.
 *   - D-05 contract: validateOrigin's behavior is NOT changed by this addition.
 */
import { describe, it, expect } from 'vitest';
import { validateSource, validateOrigin } from '../src/adapter/memory-ops';

describe('validateSource (ACT-03 allowlist)', () => {
  it("returns 'hitl' when raw === 'hitl'", () => {
    expect(validateSource('hitl', 'http')).toBe('hitl');
  });

  it('returns fallback for undefined (no source field sent)', () => {
    expect(validateSource(undefined, 'http')).toBe('http');
  });

  it('returns fallback for unknown spoof values', () => {
    expect(validateSource('banana', 'http')).toBe('http');
    expect(validateSource('mcp', 'http')).toBe('http');
    expect(validateSource('', 'http')).toBe('http');
  });

  it('uses the fallback argument — respects per-instance default', () => {
    expect(validateSource(undefined, 'mcp')).toBe('mcp');
    expect(validateSource('inferred', 'claude-code')).toBe('claude-code');
  });

  it("'hitl' fallback is also accepted when raw === 'hitl' regardless of fallback value", () => {
    // The only override is 'hitl'; it wins even if the instance default differs.
    expect(validateSource('hitl', 'mcp')).toBe('hitl');
  });
});

describe('validateOrigin (D-05 — unchanged by this addition)', () => {
  it("still clamps unknown values to 'observed'", () => {
    expect(validateOrigin('banana')).toBe('observed');
    expect(validateOrigin(undefined)).toBe('observed');
    expect(validateOrigin('inferred')).toBe('observed');
    expect(validateOrigin('hitl:execute')).toBe('observed');
  });

  it("still returns 'asserted_by_user' only on exact match", () => {
    expect(validateOrigin('asserted_by_user')).toBe('asserted_by_user');
  });
});
