/**
 * gmail-auth-cli tests (Phase 62, plan 02 — EMAIL-01).
 *
 * Covers the pure helper core: account-id validation (byte-identical to plan
 * 62-01's charset), env-key derivation, account-list merge, redirect-URI
 * construction, and OAuth callback parsing (state validation fails closed).
 * Also carries two source assertions locking the scope to gmail.readonly only.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

import {
  validateAccountId,
  envTokenKey,
  mergeAccountList,
  buildRedirectUri,
  parseOAuthCallback,
} from '../src/adapter/gmail-auth-cli';

const SOURCE_PATH = join(__dirname, '../src/adapter/gmail-auth-cli.ts');
const SOURCE = readFileSync(SOURCE_PATH, 'utf8');
// Comment lines may legitimately explain a threat mitigation by naming the
// forbidden string (e.g. "gmail.modify is forbidden") — the plan's own
// verification greps only non-comment lines (`grep -v '^\s*[*/#]'`).
const SOURCE_CODE_ONLY = SOURCE.split('\n')
  .filter((line) => !/^\s*(\*|\/\/|\/\*|#)/.test(line))
  .join('\n');

describe('validateAccountId', () => {
  it('accepts valid ids', () => {
    expect(validateAccountId('default')).toBe(true);
    expect(validateAccountId('work')).toBe(true);
    expect(validateAccountId('a')).toBe(true);
    expect(validateAccountId('w_2')).toBe(true);
  });

  it('rejects invalid ids', () => {
    expect(validateAccountId('')).toBe(false);
    expect(validateAccountId('Work')).toBe(false);
    expect(validateAccountId('1work')).toBe(false);
    expect(validateAccountId('wo rk')).toBe(false);
    expect(validateAccountId('w,x')).toBe(false);
    expect(validateAccountId('w=x')).toBe(false);
    expect(validateAccountId('w-x')).toBe(false);
    expect(validateAccountId('a'.repeat(33))).toBe(false);
    expect(validateAccountId('w\nx')).toBe(false);
  });
});

describe('envTokenKey', () => {
  it('derives GOOGLE_<ID>_REFRESH_TOKEN', () => {
    expect(envTokenKey('work')).toBe('GOOGLE_WORK_REFRESH_TOKEN');
  });
});

describe('mergeAccountList', () => {
  it('adds to an undefined list', () => {
    expect(mergeAccountList(undefined, 'work')).toBe('work');
  });

  it('appends to an existing list', () => {
    expect(mergeAccountList('default', 'work')).toBe('default,work');
  });

  it('is idempotent — merging an already-present id leaves the list unchanged', () => {
    expect(mergeAccountList('default,work', 'work')).toBe('default,work');
  });

  it('trims whitespace and drops empty segments', () => {
    expect(mergeAccountList(' default , work ', 'x')).toBe('default,work,x');
  });
});

describe('buildRedirectUri', () => {
  it('returns the literal loopback address with the given port', () => {
    expect(buildRedirectUri(53682)).toBe('http://127.0.0.1:53682');
  });
});

describe('parseOAuthCallback', () => {
  const STATE = 'S';

  it('returns ok with the code when state matches', () => {
    expect(parseOAuthCallback('/?code=abc&state=S', STATE)).toEqual({ ok: true, code: 'abc' });
  });

  it('returns state_mismatch for a wrong state', () => {
    expect(parseOAuthCallback('/?code=abc&state=WRONG', STATE)).toEqual({
      ok: false,
      reason: 'state_mismatch',
    });
  });

  it('returns state_mismatch for a state of different length', () => {
    expect(parseOAuthCallback('/?code=abc&state=SS', STATE)).toEqual({
      ok: false,
      reason: 'state_mismatch',
    });
  });

  it('returns state_missing when the param is absent', () => {
    expect(parseOAuthCallback('/?code=abc', STATE)).toEqual({
      ok: false,
      reason: 'state_missing',
    });
  });

  it('returns denied for an error param, even with a correct state', () => {
    expect(parseOAuthCallback('/?error=access_denied&state=S', STATE)).toEqual({
      ok: false,
      reason: 'denied',
    });
  });

  it('returns code_missing when code is absent', () => {
    expect(parseOAuthCallback('/?state=S', STATE)).toEqual({
      ok: false,
      reason: 'code_missing',
    });
  });

  it('never returns ok when state is wrong even if a code is present', () => {
    const result = parseOAuthCallback('/?code=abc&state=WRONG', STATE);
    expect(result.ok).toBe(false);
  });
});

describe('source assertions — scope lockdown', () => {
  it('contains the readonly Gmail scope', () => {
    expect(SOURCE).toContain('auth/gmail.readonly');
  });

  it('contains neither the modify scope nor the full-mail scope in code (comments may explain the prohibition)', () => {
    expect(SOURCE_CODE_ONLY).not.toContain('gmail.modify');
    expect(SOURCE_CODE_ONLY).not.toContain('https://mail.google.com/');
  });
});
