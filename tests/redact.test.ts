/**
 * redactSecrets unit tests (D-63/D-64).
 *
 * One test per secret class: asserts the secret is replaced with its [REDACTED:*] marker.
 * Explicit KEEP tests: email, phone, name survive verbatim (D-64 — PII is the asset).
 * Idempotency test: redactSecrets(redactSecrets(x)) === redactSecrets(x).
 */
import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../src/source/redact';

describe('redactSecrets — secret class redaction (D-63)', () => {

  // ── Anthropic API key (M-12) ──────────────────────────────────────────────

  it('strips full Anthropic key (sk-ant-api03-… with internal hyphens)', () => {
    const key = 'sk-ant-api03-AbC0123456789defGHIjkl_xyz';
    const input = `my key is ${key} — please keep it safe`;
    const result = redactSecrets(input);
    expect(result).not.toContain('sk-ant-api03');
    expect(result).toContain('[REDACTED:API_KEY]');
    expect(result).toContain('my key is');
    expect(result).toContain('please keep it safe');
  });

  it('Anthropic key redaction is idempotent (second pass leaves only the marker)', () => {
    const key = 'sk-ant-api03-AbC0123456789defGHIjkl_xyz';
    const once = redactSecrets(`key: ${key}`);
    expect(once).not.toContain('sk-ant-api03');
    const twice = redactSecrets(once);
    expect(twice).toBe(once);
  });

  // ── OpenAI API key ────────────────────────────────────────────────────────

  it('strips OpenAI API key (sk- prefix + 20+ chars)', () => {
    const input = 'the key is sk-abcdefghijklmnopqrstuvwxyz and nothing else';
    const result = redactSecrets(input);
    expect(result).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(result).toContain('[REDACTED:API_KEY]');
    expect(result).toContain('the key is');
    expect(result).toContain('and nothing else');
  });

  // ── GitHub token ─────────────────────────────────────────────────────────

  it('strips GitHub personal access token (ghp_ prefix + 20+ chars)', () => {
    const input = 'token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcd';
    const result = redactSecrets(input);
    expect(result).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcd');
    expect(result).toContain('[REDACTED:API_KEY]');
  });

  it('strips GitHub OAuth token (gho_ prefix)', () => {
    const input = 'auth: gho_xyzXYZ12345678901234567890abcdef';
    const result = redactSecrets(input);
    expect(result).not.toContain('gho_xyzXYZ12345678901234567890abcdef');
    expect(result).toContain('[REDACTED:API_KEY]');
  });

  // ── AWS access key ────────────────────────────────────────────────────────

  it('strips AWS IAM access key ID (AKIA prefix + 16 uppercase alphanumeric)', () => {
    const input = 'aws_access_key_id = AKIAIOSFODNN7EXAMPLE';
    const result = redactSecrets(input);
    expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(result).toContain('[REDACTED:AWS_KEY]');
  });

  // ── Bearer token ──────────────────────────────────────────────────────────

  it('strips HTTP Bearer token (non-JWT plain value)', () => {
    const input = 'Authorization: Bearer abc123defghijklmnop';
    const result = redactSecrets(input);
    expect(result).not.toContain('abc123defghijklmnop');
    expect(result).toContain('[REDACTED:BEARER_TOKEN]');
  });

  it('strips Bearer token case-insensitively (BEARER variant)', () => {
    const input = 'authorization: BEARER xyz1234567890abcdef';
    const result = redactSecrets(input);
    expect(result).not.toContain('xyz1234567890abcdef');
    expect(result).toContain('[REDACTED:BEARER_TOKEN]');
  });

  // ── JWT ───────────────────────────────────────────────────────────────────

  it('strips a JWT (three-part eyJ… token)', () => {
    // Standard RS256 JWT shape: header.payload.signature
    const jwt = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9' +
                '.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0' +
                '.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const input = `token: ${jwt}`;
    const result = redactSecrets(input);
    expect(result).not.toContain('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(result).toContain('[REDACTED:JWT]');
  });

  it('strips Bearer JWT (JWT pattern fires first, leaving a non-matching Bearer prefix)', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abc123def456ghi789jkl012';
    const input = `Authorization: Bearer ${jwt}`;
    const result = redactSecrets(input);
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(result).toContain('[REDACTED:JWT]');
    // The "Bearer " prefix remains (JWT value was replaced, Bearer pattern can no longer match)
    // — this is correct; the JWT marker is more informative anyway
  });

  // ── Key/secret/password literals ─────────────────────────────────────────

  it('strips password= literal', () => {
    const input = 'password=hunter2 for the vault';
    const result = redactSecrets(input);
    expect(result).not.toContain('hunter2');
    expect(result).toContain('[REDACTED:SECRET]');
    expect(result).toContain('for the vault');
  });

  it('strips secret: literal (colon+space style)', () => {
    const input = 'secret: mysupersecretvalue123';
    const result = redactSecrets(input);
    expect(result).not.toContain('mysupersecretvalue123');
    expect(result).toContain('[REDACTED:SECRET]');
  });

  it('strips api_key= literal (underscore variant)', () => {
    const input = 'config api_key=abc123secretvalue';
    const result = redactSecrets(input);
    expect(result).not.toContain('abc123secretvalue');
    expect(result).toContain('[REDACTED:SECRET]');
  });

  // ── Credit-card-like runs ─────────────────────────────────────────────────

  it('strips credit-card-like 16-digit run (standard Visa test number)', () => {
    const input = 'paid with card 4111111111111111 today';
    const result = redactSecrets(input);
    expect(result).not.toContain('4111111111111111');
    expect(result).toContain('[REDACTED:CC]');
    expect(result).toContain('paid with card');
    expect(result).toContain('today');
  });

  it('strips credit-card-like 13-digit run (Visa-13 variant)', () => {
    const input = 'card: 4000000000000';
    const result = redactSecrets(input);
    expect(result).not.toContain('4000000000000');
    expect(result).toContain('[REDACTED:CC]');
  });

  // ── SSN-like patterns ─────────────────────────────────────────────────────

  it('strips SSN-like NNN-NN-NNNN pattern', () => {
    const input = 'ssn 123-45-6789 on file';
    const result = redactSecrets(input);
    expect(result).not.toContain('123-45-6789');
    expect(result).toContain('[REDACTED:SSN]');
    expect(result).toContain('ssn');
    expect(result).toContain('on file');
  });

});

describe('redactSecrets — KEEP cases (D-64: PII is the asset)', () => {

  it('keeps email addresses verbatim', () => {
    const input = 'contact alice@acme.com for details';
    expect(redactSecrets(input)).toBe(input);
  });

  it('keeps phone numbers verbatim (E.164 style with country code)', () => {
    const input = 'call +1-415-555-0100 anytime';
    expect(redactSecrets(input)).toBe(input);
  });

  it('keeps US-format phone numbers verbatim', () => {
    const input = 'reach them at 415-555-0100';
    expect(redactSecrets(input)).toBe(input);
  });

  it('keeps personal names verbatim', () => {
    const input = 'Jane Doe founded the company';
    expect(redactSecrets(input)).toBe(input);
  });

  it('keeps a sentence with email + name + phone all untouched', () => {
    const input = 'Jane Doe (max@example.com, +1-415-555-0100) leads the team';
    expect(redactSecrets(input)).toBe(input);
  });

});

describe('redactSecrets — idempotency', () => {

  it('applying redactSecrets twice equals applying it once', () => {
    const text =
      'sk-abcdefghijklmnopqrstuvwxyz and alice@acme.com and ' +
      'password=hunter2 and +1-415-555-0100 and AKIAIOSFODNN7EXAMPLE ' +
      'and Jane Doe (max@example.com) and 4111111111111111 and 123-45-6789';
    const once = redactSecrets(text);
    const twice = redactSecrets(once);
    expect(twice).toBe(once);
  });

  it('plain text with no secrets is unchanged', () => {
    const text = 'the quick brown fox jumps over the lazy dog';
    expect(redactSecrets(text)).toBe(text);
  });

  it('empty string returns empty string', () => {
    expect(redactSecrets('')).toBe('');
  });

});
