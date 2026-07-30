/**
 * recense-doctor checkGmailAccounts tests (Phase 62, plan 01 — EMAIL-02, T-62-04).
 *
 * Mirrors the temp-env-file pattern used by checkServeToken tests in
 * tests/recense-doctor.test.ts. Never points at the real ~/.config/recense/sleep.env.
 */

import { describe, it, expect } from 'vitest';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { checkGmailAccounts } from '../src/adapter/recense-doctor';

const makeTempEnvPath = (suffix: string) =>
  join(tmpdir(), `brain-doctor-gmail-accounts-${process.pid}-${Date.now()}-${suffix}.env`);

function writeEnv(path: string, lines: string[]): void {
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
}

describe('checkGmailAccounts', () => {
  it('gmail absent from enabled sources returns ok=true with the not-enabled detail', () => {
    const envPath = makeTempEnvPath('not-enabled');
    writeEnv(envPath, ['RECENSE_ENABLED_SOURCES=obsidian']);

    const result = checkGmailAccounts(envPath);

    expect(result.ok).toBe(true);
    expect(result.detail).toContain('gmail ingest not enabled');
    expect(result.detail).toContain('backfill only');

    unlinkSync(envPath);
  });

  it('gmail enabled, default account, client id/secret + GMAIL_REFRESH_TOKEN present returns ok=true', () => {
    const envPath = makeTempEnvPath('default-ok');
    writeEnv(envPath, [
      'RECENSE_ENABLED_SOURCES=gmail',
      'GOOGLE_CLIENT_ID=client-id',
      'GOOGLE_CLIENT_SECRET=client-secret',
      'GMAIL_REFRESH_TOKEN=SENTINEL_TOKEN_VALUE_DO_NOT_PRINT',
    ]);

    const result = checkGmailAccounts(envPath);

    expect(result.ok).toBe(true);
    expect(result.detail).toContain('default: token present');
    expect(result.detail).toContain('backfill only');

    unlinkSync(envPath);
  });

  it('gmail enabled, default+work, GOOGLE_WORK_REFRESH_TOKEN missing returns ok=false naming work', () => {
    const envPath = makeTempEnvPath('work-missing');
    writeEnv(envPath, [
      'RECENSE_ENABLED_SOURCES=gmail',
      'RECENSE_GOOGLE_ACCOUNTS=default,work',
      'GOOGLE_CLIENT_ID=client-id',
      'GOOGLE_CLIENT_SECRET=client-secret',
      'GMAIL_REFRESH_TOKEN=SENTINEL_TOKEN_VALUE_DO_NOT_PRINT',
    ]);

    const result = checkGmailAccounts(envPath);

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('work: token MISSING');
    expect(result.detail).toContain('backfill only');

    unlinkSync(envPath);
  });

  it('a present token value never appears anywhere in result.detail', () => {
    const envPath = makeTempEnvPath('token-secrecy');
    const SENTINEL = 'SENTINEL_TOKEN_VALUE_DO_NOT_PRINT';
    writeEnv(envPath, [
      'RECENSE_ENABLED_SOURCES=gmail',
      'GOOGLE_CLIENT_ID=client-id',
      'GOOGLE_CLIENT_SECRET=client-secret',
      `GMAIL_REFRESH_TOKEN=${SENTINEL}`,
    ]);

    const result = checkGmailAccounts(envPath);

    expect(result.detail).not.toContain(SENTINEL);

    unlinkSync(envPath);
  });

  it('a per-account query value never appears anywhere in result.detail', () => {
    const envPath = makeTempEnvPath('query-secrecy');
    const SENTINEL_QUERY = 'label:job-search-sentinel-query-value';
    writeEnv(envPath, [
      'RECENSE_ENABLED_SOURCES=gmail',
      'RECENSE_GOOGLE_ACCOUNTS=work',
      `RECENSE_GMAIL_QUERY_WORK=${SENTINEL_QUERY}`,
      'GOOGLE_CLIENT_ID=client-id',
      'GOOGLE_CLIENT_SECRET=client-secret',
      'GOOGLE_WORK_REFRESH_TOKEN=some-token',
    ]);

    const result = checkGmailAccounts(envPath);

    expect(result.detail).not.toContain(SENTINEL_QUERY);
    expect(result.detail).toContain('query: per-account');

    unlinkSync(envPath);
  });

  it('the detail contains "backfill only" on both the ok=true and ok=false paths', () => {
    const okPath = makeTempEnvPath('bfo-ok');
    writeEnv(okPath, [
      'RECENSE_ENABLED_SOURCES=gmail',
      'GOOGLE_CLIENT_ID=client-id',
      'GOOGLE_CLIENT_SECRET=client-secret',
      'GMAIL_REFRESH_TOKEN=some-token',
    ]);
    const okResult = checkGmailAccounts(okPath);
    expect(okResult.ok).toBe(true);
    expect(okResult.detail).toContain('backfill only');
    unlinkSync(okPath);

    const failPath = makeTempEnvPath('bfo-fail');
    writeEnv(failPath, ['RECENSE_ENABLED_SOURCES=gmail']);
    const failResult = checkGmailAccounts(failPath);
    expect(failResult.ok).toBe(false);
    expect(failResult.detail).toContain('backfill only');
    unlinkSync(failPath);
  });

  it('a missing env file does not throw', () => {
    expect(() => checkGmailAccounts('/tmp/brain-doctor-gmail-accounts-nonexistent-99999.env')).not.toThrow();
    const result = checkGmailAccounts('/tmp/brain-doctor-gmail-accounts-nonexistent-99999.env');
    // No env file → RECENSE_ENABLED_SOURCES resolves to [] → gmail not enabled → pass.
    expect(result.ok).toBe(true);
  });
});
