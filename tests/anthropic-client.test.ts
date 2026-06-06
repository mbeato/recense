/**
 * Unit tests for the anthropic-client provider factory.
 *
 * Only resolveModelId is tested here — it is pure (no creds, no network).
 * createAnthropicClient is NOT called; client construction requires credentials.
 */
import { describe, it, expect } from 'vitest';
import { resolveModelId } from '../src/model/anthropic-client';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';

const baseConfig: EngineConfig = {
  ...DEFAULT_CONFIG,
  dbPath: ':memory:',
};

describe('resolveModelId', () => {
  it('returns anthropicModel when modelProvider is anthropic (default)', () => {
    const config: EngineConfig = { ...baseConfig, modelProvider: 'anthropic' };
    expect(resolveModelId(config)).toBe(config.anthropicModel);
  });

  it('returns vertexModel when modelProvider is vertex', () => {
    const config: EngineConfig = { ...baseConfig, modelProvider: 'vertex' };
    expect(resolveModelId(config)).toBe(config.vertexModel);
  });

  it('default config resolves to anthropicModel (zero behavior change)', () => {
    expect(resolveModelId(baseConfig)).toBe(DEFAULT_CONFIG.anthropicModel);
  });
});
