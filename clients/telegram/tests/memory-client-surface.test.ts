/**
 * clients/telegram/tests/memory-client-surface.test.ts  (RED stub)
 *
 * Stub tests for the not-yet-implemented surface() and surfaceSeen() methods.
 * These fail until memory-client.ts exposes the two methods (Task 1 GREEN).
 * Replaced by the comprehensive mock-server suite in Task 3.
 *
 * No imports from ../../src/ — CLIENT-01.
 */
import { describe, it, expect } from 'vitest';
import { createMemoryClient } from '../memory-client';

describe('MemoryClient — surface() and surfaceSeen() interface (RED stub)', () => {
  it('surface() is a function on the returned client', () => {
    const client = createMemoryClient('http://127.0.0.1:9999', 'test-token');
    // Fails until surface() is added to MemoryClient
    expect(typeof (client as unknown as Record<string, unknown>)['surface']).toBe('function');
  });

  it('surfaceSeen() is a function on the returned client', () => {
    const client = createMemoryClient('http://127.0.0.1:9999', 'test-token');
    // Fails until surfaceSeen() is added to MemoryClient
    expect(typeof (client as unknown as Record<string, unknown>)['surfaceSeen']).toBe('function');
  });
});
