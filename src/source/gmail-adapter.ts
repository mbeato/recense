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
 *  EMAIL-03: stripHiddenContent is applied to raw.bodyText BEFORE the provenance header
 *        is joined and BEFORE redactSecrets runs (see normalizeGmailMessage). This closes
 *        the raw-HTML-fallback vector in extractBodyText: markup, CSS/attribute-hidden
 *        elements, and invisible Unicode are removed at the ingest boundary so hidden
 *        instructions never reach the sleep-pass classifier's token stream. The
 *        provenance header (From:/Subject:) gets the narrower stripInvisibleCodepoints
 *        (stage 1 only, CR-02, plan 62-11) — not the full pipeline, since headers are not
 *        markup and stages 4-6 would mangle a legitimate `Subject: Re: <urgent> pricing`.
 *        WR-02 (plan 62-15): raw.bodyText is bounded by MAX_STRIP_INPUT_CODE_UNITS before
 *        it reaches stripHiddenContent at all. A sender chooses both the bytes and the
 *        size of raw.bodyText, and 62-VERIFICATION.md measured 126 s of ingest CPU for one
 *        crafted ~512 KB body with no cap in place. Over the cap, no sender-controlled
 *        bytes reach record.content from the body — see MAX_STRIP_INPUT_CODE_UNITS's own
 *        doc comment for the fail-closed reasoning and the measurement that sized it.
 *  D-65: Ingest scope is config.gmail.query (native Gmail search query). Conservative
 *        default in EngineConfig; narrow without code changes.
 *  D-67: cursor:gmail historyId is advanced each pull (speed layer). UNIQUE(source,
 *        external_id) in EpisodicStore is the correctness backstop for any cursor gap.
 *  D-68: OAuth credentials (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN)
 *        are read from process.env ON FIRST fetchMessages CALL — never at construction
 *        (T-05-KEY/T-06-12). Credentials must live in ~/.config/recense/sleep.env
 *        (chmod 600, gitignored). NEVER log the refresh token or client secret.
 *  EMAIL-04: parseEmailDate derives NormalizedRecord.event_ts from the Date: header inside
 *        normalizeGmailMessage. The header is sender-controlled, so the parse doubles as a
 *        security control (see parseEmailDate's JSDoc) — confident-or-null, with a bounded
 *        future-skew clamp (CR-03, closed by plan 62-10) that bounds the "forge a future date
 *        to sort last" ordering attack plan 62-05 exposed: a forged header can never return a
 *        value greater than nowMs, so it buys no ordering advantage over an honest header dated
 *        at the pull instant. It does NOT close the lever entirely — a clamped forged header
 *        still outranks genuine messages dated earlier in the same pull window, bounded by the
 *        pull interval; the real fix (Gmail's server-assigned internalDate) is out of scope
 *        here and flagged for the backlog.
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
import { stripHiddenContent, stripInvisibleCodepoints } from './strip-hidden';

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
    /**
     * Date header value. Parsed by parseEmailDate into NormalizedRecord.event_ts
     * (EMAIL-04); remains deliberately excluded from the provenance string — the
     * D-59 provenance-header shape (From/Subject/Acct) is unchanged.
     */
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
  // Fallback for simple non-multipart messages with body data: this returns the
  // message's sole body part VERBATIM, which for an HTML-only message (no text/plain
  // alternative) is raw HTML, tags and hidden content included. Markup and
  // hidden-content removal is the CALLER's responsibility, via stripHiddenContent
  // inside normalizeGmailMessage (EMAIL-03) — this function does not sanitize.
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
      // EMAIL-02: deliberately query-free — users.history.list accepts no `q` parameter, so
      // per-account query scoping bounds the initial backfill only. This is a locked
      // invariant, not an oversight; see tests/gmail-per-account-query.test.ts.
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

// ---------------------------------------------------------------------------
// parseEmailDate — bounded, attacker-hostile RFC 2822 Date: header parse (EMAIL-04)
// ---------------------------------------------------------------------------

/** Floor for a plausible event time: 1990-01-01T00:00:00Z. Rejects epoch-0/nonsense dates. */
const MIN_PLAUSIBLE_EVENT_MS = 631152000000;

/** Future-skew tolerance: 48 hours. Absorbs real sender clock skew / timezone mistakes. */
const MAX_FUTURE_SKEW_MS = 48 * 60 * 60 * 1000;

/**
 * Parse an RFC 2822 `Date:` header into epoch ms, or null on any failure or implausibility.
 *
 * Pure: no clock read, no I/O. `nowMs` is an explicit parameter so the function stays
 * deterministic and testable — never reads Date.now() internally.
 *
 * Validation order (confident-or-null at every step, D-02 discipline — no heuristic salvage):
 *  1. Empty, whitespace-only, or absent header → null.
 *  2. Date.parse(header) is NaN → null. Date.parse handles RFC 2822 natively; no date library.
 *  3. Result earlier than MIN_PLAUSIBLE_EVENT_MS → null (epoch-0 / nonsense pre-email dates).
 *  4. Result later than nowMs + MAX_FUTURE_SKEW_MS → null. SECURITY-LOAD-BEARING clamp.
 *  5. Otherwise return the parsed value CLAMPED to nowMs (CR-03) — the return is therefore
 *     always `null` or `<= nowMs`, never a value the caller could read as "in the future".
 *
 * Threat reasoning (T-62-23/T-62-24/T-62-25, corrected for CR-03 — `62-REVIEW.md`, closed by
 * plan `62-10`): the Date: header is set by the sender and is therefore attacker-controlled.
 *  (i)   A far-PAST forged date is harmless in plan 62-05's ordering — it sorts the forged
 *        evidence EARLIER, so genuine newer evidence is applied after it and wins (accepted,
 *        T-62-24, unchanged).
 *  (ii)  Beyond MAX_FUTURE_SKEW_MS the header still returns null, and a null event_ts excludes
 *        the episode from chronological reordering altogether, leaving it in its ordinary
 *        salience-priority slot (T-62-23, still true for that branch only).
 *  (iii) INSIDE the window — this is the CR-03 fix — the value is CLAMPED to `nowMs`, so
 *        `parseEmailDate` can never return a value greater than `nowMs`. The maximum ordering
 *        position a forged header can buy is therefore exactly the position the sender could
 *        obtain for free by sending at the pull instant: the forgery confers no capability the
 *        sender did not already have. (Previously this file claimed the lever "cannot be
 *        expressed" inside this window; that was false and is corrected here.)
 *  (iv)  NAMED RESIDUAL (accepted, not closed): within one pull, a clamped forged header still
 *        sorts after genuine messages dated earlier in that same pull window. The advantage is
 *        bounded by the pull interval (`GmailAdapter.pull()` reads `nowMs` once per pull) and is
 *        equivalent to the sender simply sending at the pull instant. Driving it to zero requires
 *        a server-assigned receipt time — Gmail's `internalDate`, which is not sender-controlled
 *        — as the `event_ts` source or the clamp ceiling; that is a change to `RawGmailMessage`
 *        and `RealGmailFetcher.fetchMessages` and is deliberately out of scope here, flagged for
 *        the backlog.
 * The 48-hour tolerance absorbs real-world sender clock skew and timezone-malformed headers
 * without admitting the attack. A null event_ts is always the safe default here, never a
 * guessed one.
 *
 * @param header RFC 2822 Date: header value (may be empty, malformed, or attacker-controlled).
 * @param nowMs  Current time in epoch ms, supplied by the caller (never read internally).
 */
export function parseEmailDate(header: string, nowMs: number): number | null {
  if (!header || !header.trim()) return null;
  const parsed = Date.parse(header);
  if (Number.isNaN(parsed)) return null;
  if (parsed < MIN_PLAUSIBLE_EVENT_MS) return null;
  if (parsed > nowMs + MAX_FUTURE_SKEW_MS) return null;
  // CR-03: a future-dated header inside the skew window is still sender-controlled, so it is
  // clamped to nowMs and can never exceed it — the forgery buys no ordering advantage over an
  // honest header dated at the pull instant.
  return Math.min(parsed, nowMs);
}

// ---------------------------------------------------------------------------
// WR-02 (plan 62-15): input-cap bound on raw.bodyText before stripHiddenContent
// ---------------------------------------------------------------------------

/**
 * Maximum length (in UTF-16 code units, not bytes — String.prototype.length counts code
 * units, and code units are the actual cost driver for every scan inside
 * stripHiddenContent) that raw.bodyText may be before it is handed to stripHiddenContent
 * at all. Above this bound, the body contributes zero sender-controlled bytes to
 * record.content (see STRIP_INPUT_OMITTED_MARKER below) rather than being truncated and
 * stripped. `62-REVIEW.md` and `62-VERIFICATION.md` both name this bound
 * `MAX_STRIP_INPUT_BYTES`; it is named here for what it actually measures instead, so a
 * grep for the review's term still finds this declaration.
 *
 * 1. WHY A CAP EXISTS AT ALL: `62-VERIFICATION.md` measured 126,422 ms (over two minutes)
 *    of ingest CPU for one crafted ~512 KB email body against the pre-62-14 code, and
 *    nothing bounded raw.bodyText before stripHiddenContent — sender-chosen input size was
 *    sender-chosen CPU with no ceiling. `EpisodicStore.capContent`'s 8 KB cap (D-58) runs
 *    DOWNSTREAM of all of that work and bounds none of it.
 *
 * 2. WHY FAIL-CLOSED RATHER THAN TRUNCATE-THEN-STRIP: hiding decisions inside
 *    stripHiddenContent are non-local — a <style> rule anywhere in the document can hide
 *    an element anywhere else in it. Truncating raw.bodyText to this bound and then
 *    stripping the truncated prefix would leave a class-hidden payload in the kept prefix
 *    un-stripped whenever its hiding rule sits past the cut: a content leak of exactly the
 *    kind EMAIL-03 forbids, introduced by a performance guard. So above the bound,
 *    stripHiddenContent is not called on the body at all, and STRIP_INPUT_OMITTED_MARKER
 *    (a fixed ASCII constant, no sender-controlled bytes) stands in for it. Plan 62-15's
 *    SUMMARY records a direct measurement of the rejected truncate-then-strip design
 *    leaking exactly this way, on exactly this shape.
 *
 * 3. WHY THIS VALUE: plan 62-14 measured Shape T (T-62-54 — STYLE_BLOCK_RE's lazy
 *    </style>-tail scan, the one quadratic 62-14 deliberately did not fix) as the
 *    worst-ranked shape in its twelve-shape adversarial set at 512 KB, by nearly two
 *    orders of magnitude over the next-worst shape — and measured it further at 1 MiB
 *    (~435 ms), 2 MiB (~1,751 ms) and 4 MiB (~6,946 ms). Plan 62-15 re-measured Shape T
 *    through the full normalizeGmailMessage path (1 MiB ~439.0 ms, 2 MiB ~1,721.0 ms,
 *    4 MiB ~6,892.5 ms) plus the comment/url-scanner shapes X/X3/Y/Z 62-14 added (all
 *    under 15 ms even at 4 MiB) and confirmed: 1 MiB (1,048,576) is the largest
 *    power-of-two bound under which EVERY measured shape stays under the 1000 ms budget —
 *    2 MiB already puts Shape T at ~1,721 ms. For legitimate-mail context: Gmail itself
 *    clips message display around 102 KB, and EpisodicStore.capContent (D-58) keeps only
 *    8 KB of the resulting episode downstream, so a body over 1 MiB is both vanishingly
 *    rare in genuine mail and already mostly discarded regardless of this bound.
 *
 * 4. WHY A MODULE CONSTANT AND NOT CONFIG: src/lib/config.ts is under the
 *    EMAIL-01/EMAIL-02 zero-diff freeze this phase must not break. Independent of that
 *    freeze, a boundary safety limit that must not be weakened by configuration is the
 *    better shape on its own merits — this is a correctness bound, not a tunable.
 */
const MAX_STRIP_INPUT_CODE_UNITS = 1048576;

/**
 * Fixed ASCII marker substituted for the body when raw.bodyText.length exceeds
 * MAX_STRIP_INPUT_CODE_UNITS. Contains no sender-controlled bytes — asserted verbatim by
 * tests/gmail-hidden-content.test.ts — so the omission itself cannot become a vector.
 */
const STRIP_INPUT_OMITTED_MARKER = '[body omitted: exceeds MAX_STRIP_INPUT_BYTES]';

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
 * @param nowMs     Current time in epoch ms (EMAIL-04) — passed through to parseEmailDate.
 *                  Explicit parameter, never Date.now() inside this function, so the
 *                  normalizer stays pure as its doc block promises.
 */
export function normalizeGmailMessage(
  raw: RawGmailMessage,
  accountId: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _config: Pick<EngineConfig, 'gmail'>,
  nowMs: number
): NormalizedRecord {
  // EMAIL-03/CR-02 (62-REVIEW.md): the BODY gets the full 8-stage stripHiddenContent,
  // before it is joined with the provenance header and BEFORE redactSecrets (ordering is
  // load-bearing, see below). The HEADER gets stage 1 ONLY (stripInvisibleCodepoints):
  // From:/Subject: are 100% sender-controlled (RFC 2047 encoded-words decode to arbitrary
  // UTF-8), and redactSecrets covers secret patterns only, not invisible codepoints — so
  // without this, a Subject/From carrying the Unicode Tags block or zero-width characters
  // reached record.content verbatim (CR-02, closed by plan 62-11). The full pipeline is
  // deliberately NOT applied to headers: stages 4-6 would delete a legitimate
  // `Subject: Re: <urgent> pricing` down to `Re:`, destroying provenance the extractor
  // depends on. accountId still comes from trusted config (T-20-06) and is NOT passed
  // through the primitive.
  // WR-02 (plan 62-15): above MAX_STRIP_INPUT_CODE_UNITS, the stripper is not called on
  // the body at all — the over-cap branch yields STRIP_INPUT_OMITTED_MARKER (fail-closed,
  // see that constant's doc comment). The at-or-below-cap call below keeps its exact call
  // text so the source-order regression lock (tests/gmail-hidden-content.test.ts:117-124)
  // keeps passing unedited.
  const strippedBody =
    raw.bodyText.length <= MAX_STRIP_INPUT_CODE_UNITS
      ? stripHiddenContent(raw.bodyText)
      : STRIP_INPUT_OMITTED_MARKER;
  const strippedFrom = stripInvisibleCodepoints(raw.headers.from);
  const strippedSubject = stripInvisibleCodepoints(raw.headers.subject);

  // D-59/D-09: provenance header with account id so the LLM extractor sees sender + subject + account
  const provenanceHeader = `From: ${strippedFrom} · Re: ${strippedSubject} · Acct: ${accountId}`;
  const combined = `${provenanceHeader}\n${strippedBody}`;

  // D-63: redactSecrets runs over the full combined string (header + stripped body).
  // Strip-before-redact: hidden-markup content is removed outright first, so a secret
  // reachable only inside hidden markup is simply gone, and redaction then operates on
  // final visible text rather than tag soup where a secret could straddle a tag boundary
  // and evade a pattern. The D-63 invariant is unchanged: content on the emitted record
  // is still post-redactSecrets. Sender email in the From: field is PII — redactSecrets
  // explicitly keeps email addresses (D-64).
  //
  // stripHiddenContent is NOT called from src/ingest/pipeline.ts's second redactSecrets
  // pass: that pass is source-agnostic, and markup stripping is not — running it over
  // Obsidian notes or transcript turns would destroy legitimate Markdown/formatting.
  // Stripping is a Gmail-adapter-boundary concern (D-63's adapters-redact-at-their-own-
  // boundary design), enforced at exactly this one call site;
  // tests/gmail-hidden-content.test.ts's source-order assertion keeps it there.
  const content = redactSecrets(combined);

  return {
    content,
    source: 'gmail',
    external_id: raw.id,
    // D-61: HARD-CODED 'observed' — even the founder's own sent mail is observed.
    // NEVER change this to the user-assertion origin tag. External email must earn
    // confidence through consolidation; mis-tagging is the LEARN-03 correctness guard failure mode.
    origin: 'observed',
    // EMAIL-04: source-asserted event time from the Date: header, or null on any
    // absent/malformed/implausible header (confident-or-null — see parseEmailDate).
    event_ts: parseEmailDate(raw.headers.date, nowMs),
    role: 'user',
  };
}

/**
 * Resolve the Gmail search query to use for one account's pull (EMAIL-02).
 *
 * Returns the matching `googleAccounts` entry's `query` when that entry exists
 * and its trimmed value is non-empty; otherwise falls back to `config.gmail.query`.
 * Never throws on an unknown accountId — falls through to the global query.
 *
 * This bounds the account's INITIAL BACKFILL ONLY (see the `googleAccounts` doc
 * comment in src/lib/config.ts): the incremental branch of `fetchMessages`
 * (`gmail.users.history.list`, below) is query-independent by construction —
 * `users.history.list` accepts no `q` parameter — so this resolved query never
 * reaches an already-cursored account's incremental pulls.
 *
 * @param config    Pick of EngineConfig carrying `gmail` + `googleAccounts`.
 * @param accountId Google account id to resolve the query for.
 */
export function resolveAccountQuery(
  config: Pick<EngineConfig, 'gmail' | 'googleAccounts'>,
  accountId: string
): string {
  const account = config.googleAccounts.find(a => a.id === accountId);
  const query = account?.query?.trim();
  return query ? query : config.gmail.query;
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
   * @param config    EngineConfig — reads the per-account Gmail search query (via
   *                  resolveAccountQuery), falling back to config.gmail.query (D-65/EMAIL-02).
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
    // EMAIL-02: per-account query with fallback to the global gmail.query; bounds the
    // INITIAL BACKFILL ONLY — see resolveAccountQuery's doc comment.
    const { messages, newHistoryId } = await this.fetcher.fetchMessages(
      resolveAccountQuery(this.config, this.accountId),
      cursor
    );

    // Normalise: pure synchronous mapping (no await)
    // D-09: pass accountId so the provenance header carries '· Acct: <accountId>'
    // EMAIL-04: Date.now() read once here — the single impure call site (mirrors the
    // Date.now()-default-param pattern already used in calendar-adapter.ts's
    // selectSyncEvents); normalizeGmailMessage itself never reads the clock.
    const nowMs = Date.now();
    const records = messages.map(msg => normalizeGmailMessage(msg, this.accountId, this.config, nowMs));

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
