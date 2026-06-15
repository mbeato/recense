/**
 * GmailAdapter — incremental Gmail ingestion via the Gmail REST API + OAuth refresh token.
 *
 * Design decisions locked here:
 *  D-58: One episode per message — no adapter-side splitting. The 8KB cap is applied
 *        DOWNSTREAM by EpisodicStore.capContent. The adapter emits one NormalizedRecord
 *        per message and does not truncate.
 *  D-59: external_id = Gmail message-id (the API's immutable `id` field); provenance
 *        header assembled from From + Subject so the LLM extractor sees provenance with
 *        zero additional plumbing.
 *  D-61: origin is HARD-CODED 'observed' — even the founder's own sent mail is observed,
 *        NOT asserted. Third-party email must NEVER use the user-assertion origin tag.
 *        This is a CORRECTNESS GUARD: mis-tagging lets external claims skip consolidation.
 *  D-63: redactSecrets applied over the full content string (header + body) before the
 *        NormalizedRecord is constructed. Raw sensitive text NEVER reaches EpisodicStore.
 *        The provenance header is included in redaction scope so secrets in From/Subject
 *        are stripped too.
 *  D-65: Ingest scope is config.gmail.query (native Gmail search query). Conservative
 *        default in EngineConfig; narrow without code changes.
 *  D-67: cursor:gmail historyId is advanced each pull (speed layer). UNIQUE(source,
 *        external_id) in EpisodicStore is the correctness backstop for any cursor gap.
 *  D-68: OAuth credentials (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN)
 *        are read from process.env ON FIRST fetchMessages CALL — never at construction
 *        (T-05-KEY/T-06-12). Credentials must live in ~/.config/recense/sleep.env
 *        (chmod 600, gitignored). NEVER log the refresh token or client secret.
 *
 * Package legitimacy (T-06-SC): `googleapis` is the official Google-maintained client
 * library (publisher google-wombot / google, github.com/googleapis/google-api-nodejs-client).
 * Human-approved via blocking-human gate before this install (plan 06-04 Task 1, 2026-06-08).
 */
import { google } from 'googleapis';
import type { gmail_v1 } from 'googleapis';
import type { EngineConfig } from '../lib/config';
import type { NormalizedRecord, SourceAdapter } from './source-adapter';
import { redactSecrets } from './redact';

// ---------------------------------------------------------------------------
// Raw message type — the API-agnostic representation used by GmailFetcher
// ---------------------------------------------------------------------------

/**
 * Pre-parsed single Gmail message. The real fetcher decodes headers and body text
 * from the Gmail API response before returning this shape; the pure normalizer
 * operates on this already-decoded form.
 */
export interface RawGmailMessage {
  /** Gmail API message id (immutable, used as external_id — D-59). */
  id: string;
  headers: {
    /** RFC 2822 From: value, e.g. '"Alice Smith" <alice@acme.com>' */
    from: string;
    /** Subject line, e.g. 'Re: pricing discussion' */
    subject: string;
    /** Date header value — carried for completeness; not included in provenance string */
    date: string;
  };
  /** Decoded plain-text body (or empty string when body is unavailable). */
  bodyText: string;
}

// ---------------------------------------------------------------------------
// GmailFetcher seam — injected for testability (no network in unit tests)
// ---------------------------------------------------------------------------

/**
 * Injected seam for Gmail network I/O.
 *
 * The real implementation reads env creds lazily on first call (D-68).
 * Tests inject a hand-written fake that returns scripted messages without credentials.
 *
 * startHistoryId:
 *  null  → query-backfill: fetch all messages matching `query` (initial pull)
 *  string → history-incremental: fetch only messages added since that historyId (D-67)
 */
export interface GmailFetcher {
  fetchMessages(
    query: string,
    startHistoryId: string | null
  ): Promise<{
    messages: RawGmailMessage[];
    /** New historyId to persist as cursor:gmail; null if unavailable. */
    newHistoryId: string | null;
  }>;
}

// ---------------------------------------------------------------------------
// Internal: meta cursor store interface (structural, avoids circular import)
// ---------------------------------------------------------------------------

interface MetaStore {
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}

// ---------------------------------------------------------------------------
// Internal: real fetcher — lazy OAuth client, env creds on first call only
// ---------------------------------------------------------------------------

/** Extracts plain-text body from a Gmail message part (handles multipart/alternative). */
function extractBodyText(part: gmail_v1.Schema$MessagePart | undefined): string {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) {
    return Buffer.from(part.body.data, 'base64url').toString('utf8');
  }
  // Multipart: search child parts depth-first for text/plain
  if (part.parts) {
    for (const child of part.parts) {
      const text = extractBodyText(child);
      if (text) return text;
    }
  }
  // Fallback for simple non-multipart messages with body data
  if (part.body?.data) {
    return Buffer.from(part.body.data, 'base64url').toString('utf8');
  }
  return '';
}

/**
 * Real Gmail fetcher — reads OAuth creds from process.env on first call (D-68/T-06-12).
 * Construction is side-effect-free: no env read, no network, no key held on `this` at new.
 */
class RealGmailFetcher implements GmailFetcher {
  private _gmail: ReturnType<typeof google.gmail> | null = null;

  constructor(private readonly accountId: string) {}

  /** Builds the Gmail client on first call from env. Throws a clear non-secret error if creds missing. */
  private getClient(): ReturnType<typeof google.gmail> {
    if (this._gmail) return this._gmail;

    // D-08/T-06-12: shared OAuth app, per-account refresh token read on first fetchMessages call.
    // GOOGLE_CLIENT_ID/SECRET are shared; fall back to legacy GMAIL_* keys (backward-compat).
    // Per-account token: GOOGLE_<ACCOUNT_ID>_REFRESH_TOKEN; 'default' also falls back to
    // the legacy GMAIL_REFRESH_TOKEN slot.
    // NEVER log clientSecret or refreshToken — not in errors, not in stack traces (D-68).
    const clientId = process.env['GOOGLE_CLIENT_ID'] ?? process.env['GMAIL_CLIENT_ID'];
    const clientSecret = process.env['GOOGLE_CLIENT_SECRET'] ?? process.env['GMAIL_CLIENT_SECRET'];
    const tokenEnvKey = `GOOGLE_${this.accountId.toUpperCase()}_REFRESH_TOKEN`;
    const refreshToken =
      process.env[tokenEnvKey] ??
      (this.accountId === 'default' ? process.env['GMAIL_REFRESH_TOKEN'] : undefined);

    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error(
        `Gmail OAuth credentials missing for account '${this.accountId}' — ` +
        `set GOOGLE_CLIENT_ID (or GMAIL_CLIENT_ID), GOOGLE_CLIENT_SECRET (or GMAIL_CLIENT_SECRET), ` +
        `and ${tokenEnvKey}` +
        (this.accountId === 'default' ? ` (or GMAIL_REFRESH_TOKEN)` : '') +
        ` in ~/.config/recense/sleep.env (D-08/D-68)`
      );
    }

    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    this._gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    return this._gmail;
  }

  async fetchMessages(
    query: string,
    startHistoryId: string | null
  ): Promise<{ messages: RawGmailMessage[]; newHistoryId: string | null }> {
    const gmail = this.getClient();
    const messageIds: string[] = [];
    let newHistoryId: string | null = null;

    if (startHistoryId !== null) {
      // History-incremental: only messages added since the stored historyId (D-67 speed layer)
      let pageToken: string | undefined;
      do {
        const resp = await gmail.users.history.list({
          userId: 'me',
          startHistoryId,
          historyTypes: ['messageAdded'],
          maxResults: 500,
          pageToken,
        });
        const history = resp.data.history ?? [];
        for (const item of history) {
          for (const added of item.messagesAdded ?? []) {
            if (added.message?.id) messageIds.push(added.message.id);
          }
        }
        newHistoryId = resp.data.historyId ?? null;
        pageToken = resp.data.nextPageToken ?? undefined;
      } while (pageToken);
    } else {
      // Query-backfill: full scan matching query (initial pull, D-65)
      let pageToken: string | undefined;
      do {
        const resp = await gmail.users.messages.list({
          userId: 'me',
          q: query,
          maxResults: 500,
          pageToken,
        });
        for (const msg of resp.data.messages ?? []) {
          if (msg.id) messageIds.push(msg.id);
        }
        pageToken = resp.data.nextPageToken ?? undefined;
      } while (pageToken);

      // Capture current historyId for the cursor so subsequent pulls are incremental
      const profile = await gmail.users.getProfile({ userId: 'me' });
      newHistoryId = profile.data.historyId ?? null;
    }

    // T-04-ASYNC: all async fetches complete before any sync normalisation (async-before-sync).
    const messages: RawGmailMessage[] = [];
    for (const id of messageIds) {
      const resp = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
      const payload = resp.data.payload;
      const headers = payload?.headers ?? [];
      const from = headers.find(h => h.name?.toLowerCase() === 'from')?.value ?? '';
      const subject = headers.find(h => h.name?.toLowerCase() === 'subject')?.value ?? '(no subject)';
      const date = headers.find(h => h.name?.toLowerCase() === 'date')?.value ?? '';
      messages.push({ id, headers: { from, subject, date }, bodyText: extractBodyText(payload) });
    }

    return { messages, newHistoryId };
  }
}

// ---------------------------------------------------------------------------
// Pure normalizer — exported for unit testing without credentials
// ---------------------------------------------------------------------------

/**
 * Normalise a single pre-fetched Gmail message into a NormalizedRecord.
 *
 * Pure function — no side effects, no network. Suitable for unit testing with
 * hand-crafted RawGmailMessage fixtures (no env creds needed).
 *
 * Content note (D-58): the 8KB cap is applied DOWNSTREAM by EpisodicStore.capContent;
 * this function does not truncate. One call → one record (one-episode-per-message).
 *
 * Origin is HARD-CODED 'observed' (D-61 — correctness guard; see file-level comment).
 *
 * @param raw       Pre-fetched, decoded Gmail message.
 * @param accountId Google account id (D-09) — embedded in the inline provenance header
 *                  as `· Acct: <accountId>` so the extractor sees it. Comes from trusted
 *                  config.googleAccounts; never sourced from external email content (T-20-06).
 * @param _config   EngineConfig (reserved for future per-source tunables; unused today).
 */
export function normalizeGmailMessage(
  raw: RawGmailMessage,
  accountId: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _config: Pick<EngineConfig, 'gmail'>
): NormalizedRecord {
  // D-59/D-09: provenance header with account id so the LLM extractor sees sender + subject + account
  const provenanceHeader = `From: ${raw.headers.from} · Re: ${raw.headers.subject} · Acct: ${accountId}`;
  const combined = `${provenanceHeader}\n${raw.bodyText}`;

  // D-63: redactSecrets runs over the full combined string (header + body).
  // Sender email in the From: field is PII — redactSecrets explicitly keeps email addresses (D-64).
  const content = redactSecrets(combined);

  return {
    content,
    source: 'gmail',
    external_id: raw.id,
    // D-61: HARD-CODED 'observed' — even the founder's own sent mail is observed.
    // NEVER change this to the user-assertion origin tag. External email must earn
    // confidence through consolidation; mis-tagging is the LEARN-03 correctness guard failure mode.
    origin: 'observed',
    role: 'user',
  };
}

// ---------------------------------------------------------------------------
// GmailAdapter — implements SourceAdapter, pulls incremental observed-origin records
// ---------------------------------------------------------------------------

/**
 * Gmail source adapter — incremental pull via Gmail REST API + OAuth refresh token.
 *
 * Implements SourceAdapter (D-55). Returns one NormalizedRecord per message with:
 *  - origin: 'observed' (HARD-CODED, D-61)
 *  - source: 'gmail'
 *  - external_id: Gmail message id (D-59 dedup key)
 *  - content: redacted provenance-header + body (D-63)
 *
 * Construction is side-effect-free: no env read, no network (T-05-KEY, D-68).
 * OAuth credentials are read lazily by the default real fetcher on first pull() call.
 *
 * The adapter NEVER calls EpisodicStore.append or writes the graph (CONSOL-03).
 * It only returns records and advances cursor:gmail in the meta store.
 */
export class GmailAdapter implements SourceAdapter {
  readonly source = 'gmail';

  private readonly config: EngineConfig;
  private readonly meta: MetaStore;
  private readonly fetcher: GmailFetcher;
  private readonly accountId: string;

  /**
   * @param config    EngineConfig — reads config.gmail.query for the Gmail search scope (D-65).
   * @param meta      Meta cursor store — reads/writes cursor:gmail:<accountId> historyId (D-67/D-10).
   * @param accountId Google account id (D-08). Default 'default' preserves backward-compat:
   *                  reads GOOGLE_DEFAULT_REFRESH_TOKEN with fallback to GMAIL_REFRESH_TOKEN,
   *                  and uses cursor key 'cursor:gmail:default'.
   * @param fetcher   Optional injected GmailFetcher. Defaults to the real lazily-built
   *                  OAuth client that reads env creds on first fetchMessages call (D-68).
   *                  Inject a fake fetcher in unit tests to avoid credentials/network.
   */
  constructor(
    config: EngineConfig,
    meta: MetaStore,
    accountId = 'default',
    fetcher?: GmailFetcher
  ) {
    this.config = config;
    this.meta = meta;
    this.accountId = accountId;
    // Default to real fetcher (lazy, no env read at construction — D-68/T-06-12)
    this.fetcher = fetcher ?? new RealGmailFetcher(accountId);
  }

  /**
   * Pull all new messages since cursor:gmail (or full query-backfill if no cursor).
   *
   * Returns { records, commitCursor } where commitCursor() persists the new historyId.
   * M-6: the cursor write is deferred — the orchestrator calls commitCursor() ONLY after
   * appendBatch succeeds. A crash between fetch and commit means re-fetch on next run
   * (at-least-once delivery; UNIQUE(source,external_id) deduplicated on replay).
   *
   * Throws if OAuth creds are missing (only when using the default real fetcher — D-68).
   * The orchestrator catches per-adapter errors and continues with other adapters (D-66).
   */
  async pull(): Promise<{ records: NormalizedRecord[]; commitCursor: () => void }> {
    // D-10: per-account + per-service cursor key (e.g. 'cursor:gmail:default', 'cursor:gmail:work')
    const cursorKey = `cursor:gmail:${this.accountId}`;
    const cursor = this.meta.getMeta(cursorKey);

    // T-04-ASYNC: all async I/O (network) completes into an array before sync work below
    const { messages, newHistoryId } = await this.fetcher.fetchMessages(
      this.config.gmail.query,
      cursor
    );

    // Normalise: pure synchronous mapping (no await)
    // D-09: pass accountId so the provenance header carries '· Acct: <accountId>'
    const records = messages.map(msg => normalizeGmailMessage(msg, this.accountId, this.config));

    // M-6: capture newHistoryId for the deferred cursor commit (NOT written here).
    // commitCursor is a thunk — called by the orchestrator after appendBatch succeeds.
    const commitCursor = (): void => {
      if (newHistoryId !== null) {
        this.meta.setMeta(cursorKey, newHistoryId);
      }
    };

    return { records, commitCursor };
  }
}
