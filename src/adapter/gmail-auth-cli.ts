#!/usr/bin/env node
/**
 * gmail-auth-cli — recense gmail-auth <account-id> (EMAIL-01, plan 62-02).
 *
 * Guided loopback OAuth onboarding for an additional Google account: mints a
 * Gmail refresh token via a local loopback redirect and stores it (plus the
 * account registration) in ~/.config/recense/sleep.env — no hand-rolled OAuth,
 * no hand-edited files.
 *
 * Spine (see main(), task 2):
 *   1. Parse + validate the account id (before any listener/file access — WR-02)
 *   2. Read the shared OAuth client credentials from sleep.env
 *   3. Short-circuit if the account already has a token, unless --force
 *   4. Start the bounded loopback catcher with a fresh state
 *   5. Print the consent URL (operator opens it manually — no shelled-out browser)
 *   6. Await the callback, validate state, exchange the code
 *   7. writeEnvFile the refresh token + updated RECENSE_GOOGLE_ACCOUNTS
 *   8. Print a completion summary (never a secret)
 *
 * Threat mitigations (T-62-07..T-62-14, see 62-02-PLAN.md threat_model):
 *   T-62-07: loopback listener binds 127.0.0.1 only, ephemeral port.
 *   T-62-08: state is a 32-byte random value, compared with timingSafeEqual
 *            behind a length guard; code is never exchanged on a bad state.
 *   T-62-09: bounded 300s lifetime; close() is idempotent and calls
 *            closeAllConnections() before close() so a keep-alive socket
 *            cannot pin the process; runs in a finally.
 *   T-62-10: token persistence only through the existing writeEnvFile (0o600,
 *            atomic tmp->rename) — no writeFileSync of our own.
 *   T-62-11: stdout/log carry env-var NAMES and reason WORDS only, never a
 *            token, code, or secret value.
 *   T-62-12: GMAIL_OAUTH_SCOPES is frozen to gmail.readonly only.
 *   T-62-13: validateAccountId enforces the same charset as plan 62-01.
 *   T-62-14: an existing token short-circuits without --force.
 */

import { randomBytes, timingSafeEqual } from 'crypto';
import { appendFileSync } from 'fs';
import { createServer, type Server } from 'http';
import { google } from 'googleapis';

import { resolveExistingEnv, writeEnvFile } from './recense-init';
import { sleepEnvPath } from './runtime-config';

const LOG_PATH = '/tmp/recense-gmail-auth.log';

/** Append a timestamped line to the log file (never stdout, never a secret — T-62-11). */
const log = (msg: string): void =>
  appendFileSync(LOG_PATH, `[${new Date().toISOString()}] gmail-auth: ${msg}\n`);

/** Bounded lifetime for the loopback catcher (T-62-09): 300 seconds. */
const CATCHER_TIMEOUT_MS = 300_000;

/**
 * Frozen to exactly the readonly Gmail scope. gmail.modify and the full-mail
 * scope (https://mail.google.com/) are forbidden — v10.0 only reads mail
 * (Pitfall 16.1). A source assertion in tests/gmail-auth-cli.test.ts enforces
 * their absence from this file.
 */
export const GMAIL_OAUTH_SCOPES: readonly string[] = Object.freeze([
  'https://www.googleapis.com/auth/gmail.readonly',
]);

/**
 * Account-id charset, byte-identical to plan 62-01's resolveGoogleAccounts
 * regex (src/adapter/runtime-config.ts) — a divergence would let this CLI
 * mint a token under a key that resolveGoogleAccounts then silently drops.
 */
export function validateAccountId(id: string): boolean {
  return /^[a-z][a-z0-9_]{0,31}$/.test(id);
}

/**
 * Derives the env-var key an account's refresh token is stored under.
 * Must agree with src/source/gmail-adapter.ts:139's tokenEnvKey derivation.
 */
export function envTokenKey(id: string): string {
  return `GOOGLE_${id.toUpperCase()}_REFRESH_TOKEN`;
}

/**
 * Merges `id` into the comma-separated RECENSE_GOOGLE_ACCOUNTS value.
 * Order-preserving, idempotent (merging the same id twice yields the same
 * string), and never drops an existing id the operator put there — even one
 * this CLI would consider invalid. This CLI's job is to add, not to prune
 * someone else's config.
 */
export function mergeAccountList(existing: string | undefined, id: string): string {
  const ids = (existing ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (!ids.includes(id)) ids.push(id);
  return ids.join(',');
}

/**
 * The redirect URI for the loopback OAuth flow. Uses the literal loopback IP,
 * not 'localhost' — Google's loopback rules treat the literal address as the
 * canonical form, and binding/redirecting to a name that could resolve
 * off-host is exactly the mistake this avoids.
 */
export function buildRedirectUri(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export type OAuthCallbackResult =
  | { ok: true; code: string }
  | { ok: false; reason: 'denied' | 'state_missing' | 'state_mismatch' | 'code_missing' };

/**
 * Parses the loopback redirect request URL. Order of checks: an `error`
 * query param (denied) -> missing `state` (state_missing) -> mismatched
 * `state` (state_mismatch) -> missing/empty `code` (code_missing) -> ok.
 *
 * State is compared with crypto.timingSafeEqual behind an equal-length guard
 * (timingSafeEqual throws on length mismatch) — a length difference is itself
 * treated as state_mismatch. Fails closed on every ambiguity: `ok` is never
 * returned when state validation did not pass, even if a `code` is present.
 */
export function parseOAuthCallback(rawUrl: string, expectedState: string): OAuthCallbackResult {
  const url = new URL(rawUrl, 'http://127.0.0.1');
  if (url.searchParams.has('error')) return { ok: false, reason: 'denied' };

  const state = url.searchParams.get('state');
  if (state === null) return { ok: false, reason: 'state_missing' };

  const stateBuf = Buffer.from(state);
  const expectedBuf = Buffer.from(expectedState);
  const statesMatch =
    stateBuf.length === expectedBuf.length && timingSafeEqual(stateBuf, expectedBuf);
  if (!statesMatch) return { ok: false, reason: 'state_mismatch' };

  const code = url.searchParams.get('code');
  if (!code) return { ok: false, reason: 'code_missing' };

  return { ok: true, code };
}

export interface LoopbackCatcher {
  port: number;
  result: Promise<OAuthCallbackResult | { ok: false; reason: 'timeout' }>;
  close: () => void;
}

/**
 * Starts a bounded, state-validating loopback OAuth redirect catcher.
 *
 * Binds 127.0.0.1 only (the host argument is mandatory — binding 0.0.0.0
 * would expose the authorization-code catcher to the local network) on an
 * ephemeral port (listen(0, ...)). Settles `result` exactly once: on the
 * first request received, or on the `timeoutMs` bound, whichever comes
 * first — a second request after settling gets a 400 and is otherwise
 * ignored. `close()` is idempotent and calls closeAllConnections() before
 * close() so a keep-alive browser socket cannot hold the process open.
 */
export function startLoopbackCatcher(
  expectedState: string,
  timeoutMs: number,
): Promise<LoopbackCatcher> {
  return new Promise((resolveStart) => {
    let settled = false;
    let closed = false;
    let resolveResult!: (r: OAuthCallbackResult | { ok: false; reason: 'timeout' }) => void;
    const result = new Promise<OAuthCallbackResult | { ok: false; reason: 'timeout' }>((res) => {
      resolveResult = res;
    });

    const close = (): void => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      server.closeAllConnections();
      server.close();
    };

    const server: Server = createServer((req, res) => {
      if (settled) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('recense gmail-auth: listener already closed.');
        return;
      }
      settled = true;

      const outcome = parseOAuthCallback(req.url ?? '', expectedState);
      const body = outcome.ok
        ? 'recense gmail-auth: authorization received. You may close this tab.'
        : `recense gmail-auth: authorization failed (${outcome.reason}). You may close this tab.`;
      res.writeHead(outcome.ok ? 200 : 400, { 'Content-Type': 'text/plain' });
      res.end(body);

      resolveResult(outcome);
      close();
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolveResult({ ok: false, reason: 'timeout' });
      close();
    }, timeoutMs);

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolveStart({ port, result, close });
    });
  });
}

/**
 * Decides the exact env mutation for onboarding `id` — unit-testable without
 * OAuth. Returns exactly two keys so writeEnvFile leaves every unrelated line
 * (comments, other tokens, API keys) untouched.
 */
export function planEnvUpdate(
  existing: Map<string, string>,
  id: string,
  refreshToken: string,
): Record<string, string> {
  return {
    [envTokenKey(id)]: refreshToken,
    RECENSE_GOOGLE_ACCOUNTS: mergeAccountList(existing.get('RECENSE_GOOGLE_ACCOUNTS'), id),
  };
}

// ── Interactive flow (require.main guard below) ──────────────────────────────

async function main(): Promise<void> {
  // ── Step 1: parse + validate the account id BEFORE any listener/file access (WR-02) ──
  const positionals = process.argv.slice(2).filter((a, idx, arr) => {
    if (a.startsWith('--')) return false; // flag
    const prevArg = arr[idx - 1];
    if (prevArg === '--db') return false; // value for --db
    return true;
  });
  const id = positionals[0];
  const force = process.argv.includes('--force');

  if (!id || !validateAccountId(id)) {
    process.stderr.write(
      'Usage: recense gmail-auth <account-id> [--force]\n' +
        '  <account-id> must match /^[a-z][a-z0-9_]{0,31}$/ (lowercase letters, digits, underscore)\n',
    );
    process.exitCode = 1;
    return;
  }

  // ── Step 2: shared client credentials — same fallbacks as RealGmailFetcher.getClient ──
  const clientId = process.env['GOOGLE_CLIENT_ID'] ?? process.env['GMAIL_CLIENT_ID'];
  const clientSecret = process.env['GOOGLE_CLIENT_SECRET'] ?? process.env['GMAIL_CLIENT_SECRET'];
  if (!clientId || !clientSecret) {
    process.stderr.write(
      'Gmail OAuth client credentials missing — set GOOGLE_CLIENT_ID (or GMAIL_CLIENT_ID) and\n' +
        'GOOGLE_CLIENT_SECRET (or GMAIL_CLIENT_SECRET) in ~/.config/recense/sleep.env\n' +
        '(Google Cloud Console -> APIs & Services -> Credentials -> the Desktop OAuth client)\n',
    );
    process.exitCode = 1;
    return;
  }

  const envPath = sleepEnvPath();
  const existing = resolveExistingEnv(envPath);
  const tokenKey = envTokenKey(id);

  // ── Step 3: an existing token short-circuits without --force (T-62-14) ──
  if (existing.has(tokenKey) && !force) {
    process.stdout.write(
      `Account '${id}' already has a stored token (${tokenKey}).\n` +
        'Re-run with --force to mint a new one (this does not revoke the prior grant).\n',
    );
    return; // exit 0 — re-running must not silently invalidate a working grant
  }

  const state = randomBytes(32).toString('base64url');
  let catcher: LoopbackCatcher | undefined;

  // ── Steps 4-8, wrapped so the catcher is always torn down (T-62-09) ──
  try {
    catcher = await startLoopbackCatcher(state, CATCHER_TIMEOUT_MS);
    log('started');

    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, buildRedirectUri(catcher.port));
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [...GMAIL_OAUTH_SCOPES],
      state,
    });

    process.stdout.write(
      `\nOpen this URL in the browser where the SECOND account (not account 1) is signed in:\n\n` +
        `  ${authUrl}\n\n` +
        'Waiting for the OAuth consent callback (up to 5 minutes)...\n',
    );
    log('awaiting callback');

    const outcome = await catcher.result;
    if (!outcome.ok) {
      log(`callback outcome: ${outcome.reason}`);
      process.stderr.write(`\nAuthorization failed: ${outcome.reason}\n`);
      process.exitCode = 1;
      return;
    }
    log('callback outcome: ok');

    const { tokens } = await oauth2Client.getToken(outcome.code);
    if (!tokens.refresh_token) {
      process.stderr.write(
        '\nNo refresh token returned. Revoke the prior grant for this account at\n' +
          'https://myaccount.google.com/permissions and re-run this command.\n',
      );
      process.exitCode = 1;
      return;
    }

    writeEnvFile(envPath, planEnvUpdate(existing, id, tokens.refresh_token));
    log('env written');

    const queryVar = `RECENSE_GMAIL_QUERY_${id.toUpperCase()}`;
    process.stdout.write(
      `\nAccount '${id}' onboarded.\n` +
        `  Stored: ${tokenKey} (value not shown)\n` +
        `  Added '${id}' to RECENSE_GOOGLE_ACCOUNTS\n` +
        `  Optional: set ${queryVar} to scope this account's initial backfill only\n` +
        `  (Gmail's users.history.list accepts no query, so this bounds initial backfill only —\n` +
        `   incremental pulls are unaffected)\n` +
        `  Ensure 'gmail' appears in RECENSE_ENABLED_SOURCES for the adapter to run.\n` +
        `  Verify with: recense doctor\n`,
    );
  } finally {
    catcher?.close();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] gmail-auth FATAL: ${err}\n`);
    process.exitCode = 1;
  });
}
