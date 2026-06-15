/**
 * Quick 260607-bc2: env-configurable model provider for the sleep pass.
 *
 * Covers resolveProviderOverlay() — the fail-safe env → config overlay used by
 * sleep-pass-cli's config build. No network, no DB: pure function over an env map.
 *
 * Invariants under test:
 *  - unset RECENSE_MODEL_PROVIDER → DEFAULT_CONFIG.modelProvider (unchanged).
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
    const overlay = resolveProviderOverlay({ RECENSE_MODEL_PROVIDER: 'gpt5-turbo' });
    expect(overlay.modelProvider).toBe(DEFAULT_CONFIG.modelProvider);
  });

  it("empty-string provider value → falls back to DEFAULT_CONFIG provider", () => {
    const overlay = resolveProviderOverlay({ RECENSE_MODEL_PROVIDER: '' });
    expect(overlay.modelProvider).toBe(DEFAULT_CONFIG.modelProvider);
  });

  it("provider='local' → 'local'; no local env → no overrides (DEFAULT_CONFIG kept)", () => {
    const overlay = resolveProviderOverlay({ RECENSE_MODEL_PROVIDER: 'local' });
    expect(overlay.modelProvider).toBe('local');
    expect(overlay.localModel).toBeUndefined();
    expect(overlay.localBaseUrl).toBeUndefined();
  });

  it("provider='local' with local env → applies localModel/localBaseUrl", () => {
    const overlay = resolveProviderOverlay({
      RECENSE_MODEL_PROVIDER: 'local',
      RECENSE_LOCAL_MODEL: 'qwen3:7b',
      RECENSE_LOCAL_BASE_URL: 'http://localhost:1234/v1',
    });
    expect(overlay.modelProvider).toBe('local');
    expect(overlay.localModel).toBe('qwen3:7b');
    expect(overlay.localBaseUrl).toBe('http://localhost:1234/v1');
  });

  it("provider='vertex' → 'vertex'; local env ignored when not local", () => {
    const overlay = resolveProviderOverlay({
      RECENSE_MODEL_PROVIDER: 'vertex',
      RECENSE_LOCAL_MODEL: 'qwen3:7b',
    });
    expect(overlay.modelProvider).toBe('vertex');
    expect(overlay.localModel).toBeUndefined();
  });

  it("provider='deepseek' → 'deepseek'; applies deepseekModel/deepseekBaseUrl", () => {
    const overlay = resolveProviderOverlay({
      RECENSE_MODEL_PROVIDER: 'deepseek',
      RECENSE_DEEPSEEK_MODEL: 'deepseek-v4-pro',
      RECENSE_DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
    });
    expect(overlay.modelProvider).toBe('deepseek');
    expect(overlay.deepseekModel).toBe('deepseek-v4-pro');
    expect(overlay.deepseekBaseUrl).toBe('https://api.deepseek.com');
  });

  it("provider='deepseek' without env vars → no deepseek overrides (DEFAULT_CONFIG kept)", () => {
    const overlay = resolveProviderOverlay({ RECENSE_MODEL_PROVIDER: 'deepseek' });
    expect(overlay.modelProvider).toBe('deepseek');
    expect(overlay.deepseekModel).toBeUndefined();
    expect(overlay.deepseekBaseUrl).toBeUndefined();
  });

  it("provider='anthropic' → deepseek env vars are IGNORED", () => {
    const overlay = resolveProviderOverlay({
      RECENSE_MODEL_PROVIDER: 'anthropic',
      RECENSE_DEEPSEEK_MODEL: 'deepseek-v4-pro',
      RECENSE_DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
    });
    expect(overlay.modelProvider).toBe('anthropic');
    expect(overlay.deepseekModel).toBeUndefined();
    expect(overlay.deepseekBaseUrl).toBeUndefined();
  });
});

describe('resolveProviderOverlay (per-role provider routing)', () => {
  it('role key set → wins over base RECENSE_MODEL_PROVIDER', () => {
    const overlay = resolveProviderOverlay(
      { RECENSE_EXTRACTOR_PROVIDER: 'local', RECENSE_MODEL_PROVIDER: 'vertex' },
      'RECENSE_EXTRACTOR_PROVIDER',
    );
    expect(overlay.modelProvider).toBe('local');
  });

  it('role key unset but base set → uses base', () => {
    const overlay = resolveProviderOverlay(
      { RECENSE_MODEL_PROVIDER: 'vertex' },
      'RECENSE_JUDGE_PROVIDER',
    );
    expect(overlay.modelProvider).toBe('vertex');
  });

  it('neither role nor base set → DEFAULT_CONFIG provider', () => {
    const overlay = resolveProviderOverlay({}, 'RECENSE_JUDGE_PROVIDER');
    expect(overlay.modelProvider).toBe(DEFAULT_CONFIG.modelProvider);
    expect(overlay.modelProvider).toBe('anthropic');
  });

  it('unknown role value → falls back to base', () => {
    const overlay = resolveProviderOverlay(
      { RECENSE_EXTRACTOR_PROVIDER: 'gpt5-turbo', RECENSE_MODEL_PROVIDER: 'vertex' },
      'RECENSE_EXTRACTOR_PROVIDER',
    );
    expect(overlay.modelProvider).toBe('vertex');
  });

  it('unknown role value AND no base → falls back to DEFAULT_CONFIG', () => {
    const overlay = resolveProviderOverlay(
      { RECENSE_JUDGE_PROVIDER: 'gpt5-turbo' },
      'RECENSE_JUDGE_PROVIDER',
    );
    expect(overlay.modelProvider).toBe(DEFAULT_CONFIG.modelProvider);
  });

  it('role resolves to local → local-model overlay applies', () => {
    const overlay = resolveProviderOverlay(
      {
        RECENSE_EXTRACTOR_PROVIDER: 'local',
        RECENSE_LOCAL_MODEL: 'qwen2.5:7b-instruct',
        RECENSE_LOCAL_BASE_URL: 'http://localhost:11434/v1',
      },
      'RECENSE_EXTRACTOR_PROVIDER',
    );
    expect(overlay.modelProvider).toBe('local');
    expect(overlay.localModel).toBe('qwen2.5:7b-instruct');
    expect(overlay.localBaseUrl).toBe('http://localhost:11434/v1');
  });

  it('role resolves to non-local → local-model overlay ignored', () => {
    const overlay = resolveProviderOverlay(
      { RECENSE_JUDGE_PROVIDER: 'anthropic', RECENSE_LOCAL_MODEL: 'qwen2.5:7b-instruct' },
      'RECENSE_JUDGE_PROVIDER',
    );
    expect(overlay.modelProvider).toBe('anthropic');
    expect(overlay.localModel).toBeUndefined();
  });

  it('split routing: extractor=local, judge=anthropic from one env', () => {
    const env = {
      RECENSE_EXTRACTOR_PROVIDER: 'local',
      RECENSE_JUDGE_PROVIDER: 'anthropic',
      RECENSE_LOCAL_MODEL: 'qwen2.5:7b-instruct',
    };
    const extractor = resolveProviderOverlay(env, 'RECENSE_EXTRACTOR_PROVIDER');
    const judge = resolveProviderOverlay(env, 'RECENSE_JUDGE_PROVIDER');
    expect(extractor.modelProvider).toBe('local');
    expect(extractor.localModel).toBe('qwen2.5:7b-instruct');
    expect(judge.modelProvider).toBe('anthropic');
    expect(judge.localModel).toBeUndefined();
  });

  it('per-role local model: role-specific key wins over shared RECENSE_LOCAL_MODEL', () => {
    const env = {
      RECENSE_EXTRACTOR_PROVIDER: 'local',
      RECENSE_JUDGE_PROVIDER: 'local',
      RECENSE_EXTRACTOR_LOCAL_MODEL: 'qwen2.5:7b-instruct',
      RECENSE_JUDGE_LOCAL_MODEL: 'qwen3.6:35b-a3b',
      RECENSE_LOCAL_MODEL: 'shared-fallback',
    };
    const extractor = resolveProviderOverlay(env, 'RECENSE_EXTRACTOR_PROVIDER');
    const judge = resolveProviderOverlay(env, 'RECENSE_JUDGE_PROVIDER');
    expect(extractor.localModel).toBe('qwen2.5:7b-instruct');
    expect(judge.localModel).toBe('qwen3.6:35b-a3b');
  });

  it('per-role local model: absent role key falls back to shared, then config default', () => {
    const shared = resolveProviderOverlay(
      { RECENSE_JUDGE_PROVIDER: 'local', RECENSE_LOCAL_MODEL: 'shared-model' },
      'RECENSE_JUDGE_PROVIDER',
    );
    expect(shared.localModel).toBe('shared-model');

    const none = resolveProviderOverlay(
      { RECENSE_JUDGE_PROVIDER: 'local' },
      'RECENSE_JUDGE_PROVIDER',
    );
    expect(none.localModel).toBeUndefined(); // DEFAULT_CONFIG.localModel kept downstream
  });

  it('per-role local model: no roleEnvKey → shared key only (bc2 backward-compat)', () => {
    const overlay = resolveProviderOverlay({
      RECENSE_MODEL_PROVIDER: 'local',
      RECENSE_JUDGE_LOCAL_MODEL: 'must-not-apply',
      RECENSE_LOCAL_MODEL: 'shared-model',
    });
    expect(overlay.localModel).toBe('shared-model');
  });

  it('role resolves to deepseek → deepseek model overlay applies (per-role key wins)', () => {
    const overlay = resolveProviderOverlay(
      {
        RECENSE_JUDGE_PROVIDER: 'deepseek',
        RECENSE_JUDGE_DEEPSEEK_MODEL: 'deepseek-v4-pro',
        RECENSE_DEEPSEEK_MODEL: 'deepseek-shared',
        RECENSE_DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
      },
      'RECENSE_JUDGE_PROVIDER',
    );
    expect(overlay.modelProvider).toBe('deepseek');
    expect(overlay.deepseekModel).toBe('deepseek-v4-pro'); // per-role key wins
    expect(overlay.deepseekBaseUrl).toBe('https://api.deepseek.com');
  });

  it('role resolves to non-deepseek → deepseek env vars ignored', () => {
    const overlay = resolveProviderOverlay(
      { RECENSE_JUDGE_PROVIDER: 'anthropic', RECENSE_DEEPSEEK_MODEL: 'deepseek-v4-pro' },
      'RECENSE_JUDGE_PROVIDER',
    );
    expect(overlay.modelProvider).toBe('anthropic');
    expect(overlay.deepseekModel).toBeUndefined();
  });
});
