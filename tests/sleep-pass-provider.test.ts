/**
 * Quick 260607-bc2: env-configurable model provider for the sleep pass.
 *
 * Covers resolveProviderOverlay() — the fail-safe env → config overlay used by
 * sleep-pass-cli's config build. No network, no DB: pure function over an env map.
 *
 * Invariants under test:
 *  - unset BRAIN_MEMORY_MODEL_PROVIDER → DEFAULT_CONFIG.modelProvider (unchanged).
 *  - unknown value → falls back to DEFAULT_CONFIG.modelProvider (fail safe).
 *  - explicit valid value ('local'/'vertex') → that provider.
 *  - localModel/localBaseUrl applied ONLY when provider resolves to 'local'.
 */
import { describe, it, expect } from 'vitest';
import { resolveProviderOverlay } from '../src/adapter/sleep-pass-cli';
import { DEFAULT_CONFIG } from '../src/lib/config';

describe('resolveProviderOverlay (sleep-pass provider resolution)', () => {
  it('unset env → DEFAULT_CONFIG provider, no local overrides', () => {
    const overlay = resolveProviderOverlay({});
    expect(overlay.modelProvider).toBe(DEFAULT_CONFIG.modelProvider);
    expect(overlay.modelProvider).toBe('anthropic');
    expect(overlay.localModel).toBeUndefined();
    expect(overlay.localBaseUrl).toBeUndefined();
  });

  it('unknown provider value → falls back to DEFAULT_CONFIG provider (fail safe)', () => {
    const overlay = resolveProviderOverlay({ BRAIN_MEMORY_MODEL_PROVIDER: 'gpt5-turbo' });
    expect(overlay.modelProvider).toBe(DEFAULT_CONFIG.modelProvider);
  });

  it("empty-string provider value → falls back to DEFAULT_CONFIG provider", () => {
    const overlay = resolveProviderOverlay({ BRAIN_MEMORY_MODEL_PROVIDER: '' });
    expect(overlay.modelProvider).toBe(DEFAULT_CONFIG.modelProvider);
  });

  it("provider='local' → 'local'; no local env → no overrides (DEFAULT_CONFIG kept)", () => {
    const overlay = resolveProviderOverlay({ BRAIN_MEMORY_MODEL_PROVIDER: 'local' });
    expect(overlay.modelProvider).toBe('local');
    expect(overlay.localModel).toBeUndefined();
    expect(overlay.localBaseUrl).toBeUndefined();
  });

  it("provider='local' with local env → applies localModel/localBaseUrl", () => {
    const overlay = resolveProviderOverlay({
      BRAIN_MEMORY_MODEL_PROVIDER: 'local',
      BRAIN_MEMORY_LOCAL_MODEL: 'qwen3:7b',
      BRAIN_MEMORY_LOCAL_BASE_URL: 'http://localhost:1234/v1',
    });
    expect(overlay.modelProvider).toBe('local');
    expect(overlay.localModel).toBe('qwen3:7b');
    expect(overlay.localBaseUrl).toBe('http://localhost:1234/v1');
  });

  it("provider='vertex' → 'vertex'; local env ignored when not local", () => {
    const overlay = resolveProviderOverlay({
      BRAIN_MEMORY_MODEL_PROVIDER: 'vertex',
      BRAIN_MEMORY_LOCAL_MODEL: 'qwen3:7b',
    });
    expect(overlay.modelProvider).toBe('vertex');
    expect(overlay.localModel).toBeUndefined();
  });
});
