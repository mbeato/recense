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

import { timingSafeEqual } from 'crypto';
import { createServer, type Server } from 'http';

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
