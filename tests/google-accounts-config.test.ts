/**
 * google-accounts-config tests (Phase 62, plan 01 — EMAIL-02).
 *
 * Covers resolveGoogleAccounts(env): env-driven multi-account resolution with
 * an optional per-account Gmail query, mirroring resolveEnabledSources's
 * fail-safe posture (never throw, absent/invalid input falls back to today's
 * single-account default).
 */

import { describe, it, expect } from 'vitest';

import { DEFAULT_CONFIG } from '../src/lib/config';
import { resolveGoogleAccounts } from '../src/adapter/runtime-config';

describe('resolveGoogleAccounts', () => {
  it('absent var returns [{ id: "default" }] and deep-equals DEFAULT_CONFIG.googleAccounts (anti-drift guard)', () => {
    expect(resolveGoogleAccounts({})).toEqual([{ id: 'default' }]);
    expect(resolveGoogleAccounts({})).toEqual(DEFAULT_CONFIG.googleAccounts);
  });

  it('"default,work" returns both ids in order', () => {
    expect(resolveGoogleAccounts({ RECENSE_GOOGLE_ACCOUNTS: 'default,work' })).toEqual([
      { id: 'default' },
      { id: 'work' },
    ]);
  });

  it('RECENSE_GMAIL_QUERY_WORK attaches to work only; default has no query key', () => {
    const result = resolveGoogleAccounts({
      RECENSE_GOOGLE_ACCOUNTS: 'default,work',
      RECENSE_GMAIL_QUERY_WORK: 'label:job-search',
    });
    expect(result).toEqual([{ id: 'default' }, { id: 'work', query: 'label:job-search' }]);
    expect(result[0]).not.toHaveProperty('query');
  });

  it('an empty-string query env var is ignored (no query key)', () => {
    const result = resolveGoogleAccounts({
      RECENSE_GOOGLE_ACCOUNTS: 'work',
      RECENSE_GMAIL_QUERY_WORK: '',
    });
    expect(result).toEqual([{ id: 'work' }]);
    expect(result[0]).not.toHaveProperty('query');
  });

  it('whitespace and empty segments are tolerated', () => {
    expect(resolveGoogleAccounts({ RECENSE_GOOGLE_ACCOUNTS: ' default , , work ' })).toEqual([
      { id: 'default' },
      { id: 'work' },
    ]);
  });

  it('drops an id with an uppercase letter, a space, an =, or a leading digit', () => {
    expect(resolveGoogleAccounts({ RECENSE_GOOGLE_ACCOUNTS: 'Default' })).toEqual([{ id: 'default' }]);
    expect(resolveGoogleAccounts({ RECENSE_GOOGLE_ACCOUNTS: 'has space' })).toEqual([{ id: 'default' }]);
    expect(resolveGoogleAccounts({ RECENSE_GOOGLE_ACCOUNTS: 'a=b' })).toEqual([{ id: 'default' }]);
    expect(resolveGoogleAccounts({ RECENSE_GOOGLE_ACCOUNTS: '1work' })).toEqual([{ id: 'default' }]);
  });

  it('a list of only-invalid ids falls back to [{ id: "default" }]', () => {
    expect(resolveGoogleAccounts({ RECENSE_GOOGLE_ACCOUNTS: 'Bad,1nvalid,has space' })).toEqual([
      { id: 'default' },
    ]);
  });

  it('duplicate ids collapse to one', () => {
    expect(resolveGoogleAccounts({ RECENSE_GOOGLE_ACCOUNTS: 'work,work,default' })).toEqual([
      { id: 'work' },
      { id: 'default' },
    ]);
  });

  it('never throws for any malformed input and never mutates the passed env object', () => {
    const env = { RECENSE_GOOGLE_ACCOUNTS: ',,,=,,,', RECENSE_GMAIL_QUERY_DEFAULT: '  ' };
    const snapshot = { ...env };
    expect(() => resolveGoogleAccounts(env)).not.toThrow();
    expect(resolveGoogleAccounts(env)).toEqual([{ id: 'default' }]);
    expect(env).toEqual(snapshot);
  });
});
