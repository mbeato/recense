/**
 * gmail-auth-cli tests (Phase 62, plan 02 — EMAIL-01).
 *
 * Covers the pure helper core: account-id validation (byte-identical to plan
 * 62-01's charset), env-key derivation, account-list merge, redirect-URI
 * construction, and OAuth callback parsing (state validation fails closed).
 * Also carries two source assertions locking the scope to gmail.readonly only.
 */

import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

import {
  validateAccountId,
  envTokenKey,
  mergeAccountList,
  buildRedirectUri,
  parseOAuthCallback,
  planEnvUpdate,
} from '../src/adapter/gmail-auth-cli';
import { resolveExistingEnv, writeEnvFile } from '../src/adapter/recense-init';

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

describe('planEnvUpdate', () => {
  it('with an empty map returns exactly the token key + RECENSE_GOOGLE_ACCOUNTS', () => {
    expect(planEnvUpdate(new Map(), 'work', 'TOKEN_SENTINEL')).toEqual({
      GOOGLE_WORK_REFRESH_TOKEN: 'TOKEN_SENTINEL',
      RECENSE_GOOGLE_ACCOUNTS: 'work',
    });
  });

  it('with an existing RECENSE_GOOGLE_ACCOUNTS=default yields default,work', () => {
    const existing = new Map([['RECENSE_GOOGLE_ACCOUNTS', 'default']]);
    expect(planEnvUpdate(existing, 'work', 'TOKEN_SENTINEL')).toEqual({
      GOOGLE_WORK_REFRESH_TOKEN: 'TOKEN_SENTINEL',
      RECENSE_GOOGLE_ACCOUNTS: 'default,work',
    });
  });

  it('re-running for an id already in the list leaves the list unchanged', () => {
    const existing = new Map([['RECENSE_GOOGLE_ACCOUNTS', 'default,work']]);
    expect(planEnvUpdate(existing, 'work', 'TOKEN_SENTINEL').RECENSE_GOOGLE_ACCOUNTS).toBe(
      'default,work',
    );
  });

  it('returns exactly two keys, so unrelated env keys are provably untouched', () => {
    const result = planEnvUpdate(new Map(), 'work', 'TOKEN_SENTINEL');
    expect(Object.keys(result).sort()).toEqual(['GOOGLE_WORK_REFRESH_TOKEN', 'RECENSE_GOOGLE_ACCOUNTS']);
  });

  it('end-to-end env-file write: comment + unrelated key survive, mode is 0o600', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gmail-auth-cli-test-'));
    const tmp = join(dir, 'sleep.env');
    writeFileSync(
      tmp,
      '# a comment\nOPENAI_API_KEY=x\nRECENSE_GOOGLE_ACCOUNTS=default\n',
      { mode: 0o600 },
    );

    writeEnvFile(tmp, planEnvUpdate(resolveExistingEnv(tmp), 'work', 'TOKEN_SENTINEL'));

    const content = readFileSync(tmp, 'utf8');
    expect(content).toContain('# a comment');
    expect(content).toContain('OPENAI_API_KEY=x');
    expect(content).toContain('RECENSE_GOOGLE_ACCOUNTS=default,work');
    expect(content).toContain('GOOGLE_WORK_REFRESH_TOKEN=TOKEN_SENTINEL');
    expect(statSync(tmp).mode & 0o777).toBe(0o600);
  });
});

describe('source assertions — OAuth exchange parameters and secret-safe output', () => {
  it('contains prompt: \'consent\' and access_type: \'offline\'', () => {
    expect(SOURCE).toContain("prompt: 'consent'");
    expect(SOURCE).toContain("access_type: 'offline'");
  });

  it('completion output contains the literal "backfill only" limitation', () => {
    expect(SOURCE).toContain('backfill only');
  });

  it('dispatches writeEnvFile and does not hand-roll its own writeFileSync/chmodSync', () => {
    expect(SOURCE_CODE_ONLY).toContain('writeEnvFile(');
    expect(SOURCE_CODE_ONLY).not.toMatch(/\bwriteFileSync\(/);
    expect(SOURCE_CODE_ONLY).not.toMatch(/\bchmodSync\(/);
  });

  it('no stdout/log call site interpolates refreshToken, code, or clientSecret', () => {
    const secretInterpolation =
      /(console\.log|process\.stdout\.write|process\.stderr\.write|appendFileSync)\([^)]*\$\{\s*(refreshToken|code|clientSecret)\b/;
    expect(SOURCE_CODE_ONLY).not.toMatch(secretInterpolation);
  });
});
