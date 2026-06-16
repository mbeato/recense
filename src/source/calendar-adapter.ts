/**
 * CalendarAdapter — incremental Google Calendar ingestion via the Calendar REST API + OAuth.
 *
 * Design decisions locked here:
 *  D-04: Recurring events → ONE pattern node per series. The adapter collapses multiple
 *        instances of the same series (grouped by recurringEventId) to ONE NormalizedRecord
 *        carrying the master id, the freshly-computed next-occurrence UTC time, AND the
 *        stored RRULE string. The consolidator (plan 02) writes node_temporal with the
 *        fresh due_at on every re-ingest — so the deadline never goes stale.
 *  D-05: Cancellation is deterministic and LLM-free.
 *        A cancelled MASTER (status='cancelled', no recurringEventId) is NOT emitted;
 *        instead its id is appended to the MetaStore side-channel `calendar:cancelled:<acct>`.
 *        A cancelled INSTANCE (has recurringEventId — EXDATE exception) is silently skipped
 *        and must NOT tombstone the series.
 *        The calendar-tombstone.ts sleep-pass step tombstones nodes whose node_temporal
 *        source_event_id matches a cancelled master id.
 *  D-08: Shared OAuth app (GOOGLE_CLIENT_ID/SECRET), per-account refresh token
 *        (GOOGLE_<ACCOUNT_ID>_REFRESH_TOKEN). 'default' also falls back to GMAIL_REFRESH_TOKEN
 *        (backward-compat). One CalendarAdapter per account; one RealCalendarFetcher per adapter.
 *  D-09: source is HARD-CODED 'gcal' so sourceWeights/enabledSources resolve unchanged.
 *        Account id is inline provenance: `Cal: <summary> · Acct: <accountId>`.
 *  D-10: cursor key is per-account + per-service: `cursor:calendar:<accountId>`.
 *  D-61: origin is HARD-CODED 'observed' — calendar events are observed, never asserted.
 *  D-63: redactSecrets applied at boundary before the NormalizedRecord is constructed.
 *  D-68: OAuth credentials read from process.env ON FIRST fetchEvents CALL — never at
 *        construction (construction is side-effect-free for tests). Credentials must live
 *        in ~/.config/recense/sleep.env (chmod 600, gitignored). NEVER log the token.
 *
 *  410-GONE recovery (D-08/ROADMAP):
 *    When the Google Calendar API returns 410 (stale syncToken), the fetcher sets gone:true.
 *    The adapter then stores '' as the cursor (wipe). On the NEXT pull, the adapter reads ''
 *    from meta and passes it to fetchEvents. The REAL fetcher MUST omit the syncToken param
 *    entirely when it receives an empty-or-null token — the real API rejects syncToken:'' with
 *    HTTP 400. This is enforced by `if (syncToken) params.syncToken = syncToken` (falsy guard).
 *
 *  Net-zero dependency decision (T-20-SC):
 *    The `rrule` npm package is explicitly REJECTED. Next-occurrence computation uses
 *    the Google Calendar API's server-side RRULE expansion (singleEvents:true, timeMin:now)
 *    which is deterministic, LLM-free, and adds zero new runtime dependencies.
 *    The `rrule` package's exclusion is documented and intentional.
 */
import { google } from 'googleapis';
import type { calendar_v3 } from 'googleapis';
import type { EngineConfig } from '../lib/config';
import type { NormalizedRecord, SourceAdapter } from './source-adapter';
import { contentExternalId } from './source-adapter';
import { redactSecrets } from './redact';

// ---------------------------------------------------------------------------
// Raw event type — API-agnostic, used by CalendarFetcher seam
// ---------------------------------------------------------------------------

/**
 * Pre-processed single calendar event. The real fetcher may merge master+instance
 * info (e.g. RRULE from master, start.dateTime from next instance) before returning.
 * The fake fetcher in unit tests provides these fields directly — no network needed.
 */
export interface RawCalendarEvent {
  /** Event id (for one-off/master) or instance id (for expanded recurring instances). */
  id: string;
  /** Event title / display name. */
  summary: string;
  /** Optional plain-text description body. */
  descriptionText?: string;
  /** Start time. dateTime (with tz offset) for timed events; date for all-day. */
  start: {
    dateTime?: string;  // ISO-8601, may carry tz offset (e.g. '2026-07-01T10:00:00-05:00')
    date?: string;      // date-only for all-day events (e.g. '2026-07-01')
    timeZone?: string;
  };
  /** 'confirmed' | 'cancelled' | 'tentative' */
  status: 'confirmed' | 'cancelled' | 'tentative';
  /**
   * Present on recurring instances; value is the master event's id.
   * Absent on one-off events and on master events themselves.
   */
  recurringEventId?: string;
  /**
   * RRULE strings from the master event's recurrence field (e.g. ['RRULE:FREQ=WEEKLY;BYDAY=MO']).
   * Present on recurring masters (or fake test events that pre-populate it).
   * Absent on one-off events and on raw instances from singleEvents=true API calls
   * (real fetcher fetches master separately to populate this field for recurring series).
   */
  recurrence?: string[];
}

// ---------------------------------------------------------------------------
// CalendarFetcher seam — injected for testability (no network in unit tests)
// ---------------------------------------------------------------------------

/**
 * Injected seam for Google Calendar network I/O.
 *
 * The real implementation reads env creds lazily on first call (D-68).
 * Tests inject a FakeCalendarFetcher that returns scripted events without credentials.
 *
 * syncToken:
 *  null or '' → full fetch (omit syncToken entirely — real API rejects syncToken:'')
 *  string     → incremental sync from this token
 *
 * gone: true when the API returned 410 GONE (stale syncToken) — caller must wipe cursor.
 */
export interface CalendarFetcher {
  fetchEvents(
    accountId: string,
    syncToken: string | null
  ): Promise<{
    events: RawCalendarEvent[];
    /** New sync token to persist as cursor:calendar:<acct>; null if unavailable. */
    newSyncToken: string | null;
    /** true when API returned 410 GONE (stale syncToken) — caller wipes cursor. */
    gone: boolean;
  }>;
}

// ---------------------------------------------------------------------------
// Internal MetaStore interface (structural, avoids circular import)
// ---------------------------------------------------------------------------

interface MetaStore {
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}

// ---------------------------------------------------------------------------
// Real fetcher — lazy OAuth client, env creds on first call only (D-68)
// ---------------------------------------------------------------------------

/**
 * Real Google Calendar fetcher — reads OAuth creds from process.env on first call.
 * Construction is side-effect-free: no env read, no network, no key held on `this` at new.
 * One RealCalendarFetcher per CalendarAdapter instance (D-08: one adapter per account).
 */
export class RealCalendarFetcher implements CalendarFetcher {
  private _calendar: ReturnType<typeof google.calendar> | null = null;
  private _cachedAccountId: string | null = null;

  /**
   * Build the Calendar client on first call (D-68 lazy credential read).
   * NEVER log clientSecret or refreshToken — not in errors, not in stack traces.
   */
  private getClient(accountId: string): ReturnType<typeof google.calendar> {
    // Re-use cache when called with the same account (normal single-account pattern)
    if (this._calendar && this._cachedAccountId === accountId) return this._calendar;

    const clientId = process.env['GOOGLE_CLIENT_ID'] ?? process.env['GMAIL_CLIENT_ID'];
    const clientSecret = process.env['GOOGLE_CLIENT_SECRET'] ?? process.env['GMAIL_CLIENT_SECRET'];
    const tokenEnvKey = `GOOGLE_${accountId.toUpperCase()}_REFRESH_TOKEN`;
    const refreshToken =
      process.env[tokenEnvKey] ??
      (accountId === 'default' ? process.env['GMAIL_REFRESH_TOKEN'] : undefined);

    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error(
        `Google Calendar OAuth credentials missing for account '${accountId}' — ` +
        `set GOOGLE_CLIENT_ID (or GMAIL_CLIENT_ID), GOOGLE_CLIENT_SECRET (or GMAIL_CLIENT_SECRET), ` +
        `and ${tokenEnvKey}` +
        (accountId === 'default' ? ` (or GMAIL_REFRESH_TOKEN)` : '') +
        ` in ~/.config/recense/sleep.env (D-08/D-68)`
      );
    }

    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    this._calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    this._cachedAccountId = accountId;
    return this._calendar;
  }

  async fetchEvents(
    accountId: string,
    syncToken: string | null
  ): Promise<{ events: RawCalendarEvent[]; newSyncToken: string | null; gone: boolean }> {
    const calendar = this.getClient(accountId);

    // Build params by sync mode (CR-01). The real Calendar API REJECTS
    // timeMin/timeMax/orderBy/updatedMin/q alongside syncToken (HTTP 400), and rejects
    // syncToken:'' as well. buildCalendarListParams sets server-side timeMin+orderBy ONLY
    // on a full fetch (falsy token → 410 recovery / first sync); incremental cycles carry
    // syncToken alone and apply time-filter+ordering client-side via selectSyncEvents.
    const params: calendar_v3.Params$Resource$Events$List =
      buildCalendarListParams(syncToken);

    const rawEvents: calendar_v3.Schema$Event[] = [];
    let nextPageToken: string | undefined;
    let finalSyncToken: string | null = null;

    try {
      do {
        if (nextPageToken) params.pageToken = nextPageToken;
        const resp = await calendar.events.list(params);
        const data = resp.data;
        rawEvents.push(...(data.items ?? []));
        // nextSyncToken is only available on the FINAL page (no nextPageToken)
        if (!data.nextPageToken) {
          finalSyncToken = data.nextSyncToken ?? null;
        }
        nextPageToken = data.nextPageToken ?? undefined;
      } while (nextPageToken);
    } catch (err: unknown) {
      // 410 GONE: stale syncToken — signal the adapter to wipe the cursor
      const code =
        (err as { code?: number }).code ??
        (err as { response?: { status?: number } }).response?.status;
      if (code === 410) {
        return { events: [], newSyncToken: null, gone: true };
      }
      throw err;
    }

    // CR-01: in incremental mode the API ignored timeMin/orderBy, so replicate them
    // client-side (sort by start asc + drop past confirmed events) before the dedup, which
    // assumes "first instance per series == next occurrence". Full-fetch results pass through.
    const processed = selectSyncEvents(rawEvents, syncToken);

    // Group instances by recurringEventId; keep the first (earliest) instance per series.
    // One-off events (no recurringEventId) are kept as-is.
    const oneOffEvents: calendar_v3.Schema$Event[] = [];
    const seriesFirstInstances = new Map<string, calendar_v3.Schema$Event>();

    for (const ev of processed) {
      if (ev.recurringEventId) {
        // Instance of a recurring series — keep the earliest (first in orderBy startTime list)
        if (!seriesFirstInstances.has(ev.recurringEventId)) {
          seriesFirstInstances.set(ev.recurringEventId, ev);
        }
      } else {
        oneOffEvents.push(ev);
      }
    }

    // For each recurring series, fetch the master to get the RRULE string
    const events: RawCalendarEvent[] = [];

    // One-off events
    for (const ev of oneOffEvents) {
      events.push({
        id: ev.id ?? '',
        summary: ev.summary ?? '',
        descriptionText: ev.description ?? undefined,
        start: {
          dateTime: ev.start?.dateTime ?? undefined,
          date: ev.start?.date ?? undefined,
          timeZone: ev.start?.timeZone ?? undefined,
        },
        status: (ev.status as RawCalendarEvent['status']) ?? 'confirmed',
      });
    }

    // Recurring series: fetch master for RRULE, use first instance's start time
    for (const [masterId, instance] of seriesFirstInstances) {
      let recurrence: string[] | undefined;
      try {
        const masterResp = await calendar.events.get({
          calendarId: 'primary',
          eventId: masterId,
        });
        recurrence = masterResp.data.recurrence ?? undefined;
      } catch {
        // If master fetch fails, proceed without RRULE (graceful degradation)
        recurrence = undefined;
      }

      events.push({
        id: masterId,
        summary: instance.summary ?? '',
        descriptionText: instance.description ?? undefined,
        start: {
          dateTime: instance.start?.dateTime ?? undefined,
          date: instance.start?.date ?? undefined,
          timeZone: instance.start?.timeZone ?? undefined,
        },
        status: (instance.status as RawCalendarEvent['status']) ?? 'confirmed',
        recurringEventId: undefined, // the representative IS the master
        recurrence,
      });
    }

    return { events, newSyncToken: finalSyncToken, gone: false };
  }
}

// ---------------------------------------------------------------------------
// Pure normalizer — exported for unit testing without credentials
// ---------------------------------------------------------------------------

/**
 * Normalize a single pre-fetched/pre-processed calendar event into a NormalizedRecord.
 *
 * Pure function — no side effects, no network. Suitable for unit testing with
 * hand-crafted RawCalendarEvent fixtures (no env creds needed).
 *
 * Content format (D-04/D-09):
 *   `Cal: <summary> · Acct: <acct> · Event: <masterId> · When: <utcISO>` +
 *   optional `· RRULE: <freq-string>` (only for recurring, no RRULE: prefix) +
 *   `\n<descriptionText>`
 *
 * RRULE token: uses the FREQ/... part of the recurrence string, stripping any
 * 'RRULE:' prefix so the consolidator's parseGcalProvenance regex captures just
 * 'FREQ=WEEKLY;BYDAY=MO' (plan 20-02 contract).
 *
 * external_id: content-addressed on masterId + content (D-59). Changing the When
 * token (new occurrence) → new content → new external_id → new episode → consolidator
 * reconciles to the SAME node and upserts node_temporal with fresh due_at (D-04).
 *
 * origin: HARD-CODED 'observed' (D-61 — calendar events are never asserted_by_user).
 *
 * @param raw       Pre-processed calendar event (may have RRULE from master).
 * @param accountId Google account id (from config; never from external content — T-20-06).
 * @param _config   EngineConfig (reserved for future per-source tunables; unused today).
 */
export function normalizeCalendarEvent(
  raw: RawCalendarEvent,
  accountId: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _config: EngineConfig,
): NormalizedRecord {
  // UTC-normalize the start time (D-04: due_at must be UTC ISO-8601)
  const utcISO = toUtcISO(raw.start);

  // D-09: provenance header with master id + UTC time for content-addressing
  // recurringEventId ?? id: for recurring instances, recurringEventId is the master id;
  // for one-off and master events, use their own id.
  const masterId = raw.recurringEventId ?? raw.id;
  let provenanceHeader = `Cal: ${raw.summary} · Acct: ${accountId} · Event: ${masterId} · When: ${utcISO}`;

  // D-04: append RRULE token for recurring events only.
  // Strip the 'RRULE:' prefix from the Google Calendar recurrence field entry so the
  // consolidator's parseGcalProvenance regex captures 'FREQ=WEEKLY;BYDAY=MO' (not 'RRULE:FREQ=...').
  if (raw.recurrence && raw.recurrence.length > 0) {
    const rruleEntry = raw.recurrence.find(r => r.startsWith('RRULE:'));
    if (rruleEntry) {
      const rruleValue = rruleEntry.slice('RRULE:'.length);
      provenanceHeader += ` · RRULE: ${rruleValue}`;
    }
  }

  const combined = `${provenanceHeader}\n${raw.descriptionText ?? ''}`;

  // D-63: redactSecrets over the full combined string (provenance header + body).
  const content = redactSecrets(combined);

  return {
    content,
    source: 'gcal',
    // D-59: content-addressed external_id. masterId is stable; content changes when
    // When changes (new occurrence) → new external_id → new episode → consolidator reconciles.
    external_id: contentExternalId(masterId, content),
    // D-61: HARD-CODED 'observed' — calendar events are observed, never asserted_by_user.
    // External event content must earn confidence through consolidation.
    origin: 'observed',
    role: 'user',
  };
}

// ---------------------------------------------------------------------------
// Sync param + incremental selection helpers (CR-01) — pure, exported for testing
// ---------------------------------------------------------------------------

/**
 * Build the events.list params for a sync cycle (CR-01).
 *
 * The Google Calendar API REJECTS timeMin/timeMax/orderBy/updatedMin/q when syncToken is
 * present (HTTP 400), and rejects syncToken:'' too. So server-side time-filter + ordering
 * are applied ONLY on a full fetch (falsy token → first sync or post-410 recovery);
 * incremental cycles carry syncToken alone and filter/order client-side (selectSyncEvents).
 */
export function buildCalendarListParams(
  syncToken: string | null,
  nowISO: string = new Date().toISOString(),
): calendar_v3.Params$Resource$Events$List {
  const params: calendar_v3.Params$Resource$Events$List = {
    calendarId: 'primary',
    singleEvents: true,
    maxResults: 250,
  };
  if (syncToken) {
    params.syncToken = syncToken;
  } else {
    params.timeMin = nowISO;
    params.orderBy = 'startTime';
  }
  return params;
}

/** Resolve an event's start to epoch ms (dateTime, or all-day date as midnight UTC). */
function eventStartMs(ev: calendar_v3.Schema$Event): number | null {
  const dt = ev.start?.dateTime ?? (ev.start?.date ? `${ev.start.date}T00:00:00Z` : null);
  if (!dt) return null;
  const ms = Date.parse(dt);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Replicate server-side timeMin+orderBy client-side for incremental syncs (CR-01).
 *
 * Full fetch (falsy syncToken): the server already filtered (timeMin=now) and sorted
 * (orderBy=startTime), so return as-is. Incremental (syncToken present): the server ignored
 * those params, so here we:
 *  - drop CONFIRMED events already in the past (D-04: due_at must be >= now);
 *  - KEEP cancellations regardless of date (tombstoning depends on them — D-05);
 *  - KEEP undated events (all-day with no resolvable start);
 *  - sort ascending by start so downstream dedup's "first per series" is the next occurrence.
 */
export function selectSyncEvents(
  rawEvents: calendar_v3.Schema$Event[],
  syncToken: string | null,
  now: number = Date.now(),
): calendar_v3.Schema$Event[] {
  if (!syncToken) return rawEvents;
  return rawEvents
    .filter(ev => {
      if (ev.status === 'cancelled') return true;
      const ms = eventStartMs(ev);
      return ms === null ? true : ms >= now;
    })
    .sort((a, b) => (eventStartMs(a) ?? Infinity) - (eventStartMs(b) ?? Infinity));
}

// ---------------------------------------------------------------------------
// Internal helper — convert start time to UTC ISO-8601
// ---------------------------------------------------------------------------

/**
 * Convert a calendar event's start to a UTC ISO-8601 string.
 *
 * - dateTime with tz offset (e.g. '2026-07-01T10:00:00-05:00') → new Date(...).toISOString()
 *   always returns UTC (e.g. '2026-07-01T15:00:00.000Z')
 * - dateTime already in UTC (ends in 'Z') → new Date(...).toISOString() (idempotent)
 * - date-only (all-day event, e.g. '2026-07-01') → treat as midnight UTC
 * - fallback → current time (should not happen with valid API responses)
 */
function toUtcISO(start: RawCalendarEvent['start']): string {
  if (start.dateTime) {
    return new Date(start.dateTime).toISOString();
  }
  if (start.date) {
    return new Date(`${start.date}T00:00:00Z`).toISOString();
  }
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// CalendarAdapter — implements SourceAdapter, incremental sync with 410-GONE recovery
// ---------------------------------------------------------------------------

/**
 * Google Calendar source adapter — incremental pull via Calendar REST API + OAuth.
 *
 * Implements SourceAdapter (D-55). Returns NormalizedRecord values with:
 *  - origin: 'observed' (HARD-CODED, D-61)
 *  - source: 'gcal'
 *  - external_id: content-addressed (D-59 — changes when next-occurrence changes)
 *  - content: redacted provenance-header + description (D-63)
 *
 * One CalendarAdapter instance per Google account (D-08).
 * Construction is side-effect-free: no env read, no network (D-68/T-05-KEY).
 *
 * Pull() behaviour:
 *  - 410-GONE: wipes cursor to '' and returns empty. On NEXT pull, the empty cursor
 *    triggers a full fetch (syncToken omitted entirely — real API rejects syncToken:'').
 *  - Cancelled MASTER: added to meta side-channel; tombstoning happens in sleep pass.
 *  - Cancelled INSTANCE: silently skipped; does NOT add to the side-channel (D-05).
 *  - Recurring series: collapsed to ONE record per master; RRULE token in content (D-04).
 *
 * The adapter NEVER calls EpisodicStore.append or writes the graph (CONSOL-03).
 * It only returns records and updates cursor:calendar:<accountId> in the meta store.
 */
export class CalendarAdapter implements SourceAdapter {
  readonly source = 'gcal';

  private readonly config: EngineConfig;
  private readonly meta: MetaStore;
  private readonly fetcher: CalendarFetcher;
  private readonly accountId: string;

  /**
   * @param config    EngineConfig — reads calendar sub-config.
   * @param meta      Meta cursor store — reads/writes cursor:calendar:<accountId> (D-10).
   * @param accountId Google account id (D-08). One adapter per account.
   * @param fetcher   Optional injected CalendarFetcher. Defaults to the real lazily-built
   *                  OAuth client that reads env creds on first fetchEvents call (D-68).
   *                  Inject a FakeCalendarFetcher in unit tests to avoid network/credentials.
   */
  constructor(
    config: EngineConfig,
    meta: MetaStore,
    accountId: string,
    fetcher?: CalendarFetcher
  ) {
    this.config = config;
    this.meta = meta;
    this.accountId = accountId;
    // D-68: default real fetcher is side-effect-free at construction (lazy env read)
    this.fetcher = fetcher ?? new RealCalendarFetcher();
  }

  /**
   * Pull new/updated events since cursor:calendar:<accountId>.
   *
   * Returns { records, commitCursor } where commitCursor() persists the new syncToken.
   * M-6: the cursor write is deferred — the orchestrator calls commitCursor() ONLY after
   * appendBatch succeeds (at-least-once delivery on crash).
   *
   * 410-GONE recovery: wipes cursor to '' and returns empty records. On the NEXT pull,
   * the empty cursor triggers a full fetch (falsy syncToken → omit syncToken param).
   */
  async pull(): Promise<{ records: NormalizedRecord[]; commitCursor: () => void }> {
    // D-10: per-account + per-service cursor key
    const cursorKey = `cursor:calendar:${this.accountId}`;
    // getMeta returns null (no cursor) or '' (wiped after GONE) or 'actual-token'
    const syncToken = this.meta.getMeta(cursorKey);

    // T-04-ASYNC: all async I/O completes before any sync work
    const { events, newSyncToken, gone } = await this.fetcher.fetchEvents(
      this.accountId,
      syncToken  // null or '' → falsy → fetcher performs full fetch (omits syncToken param)
    );

    if (gone) {
      // 410-GONE: stale syncToken — wipe cursor and signal re-fetch on next cycle.
      // Store '' (not null) so getMeta returns '' on next pull → still falsy → full fetch.
      this.meta.setMeta(cursorKey, '');
      // commitCursor is a no-op on gone — don't overwrite the wiped cursor.
      return { records: [], commitCursor: () => {} };
    }

    // Group events by masterId (recurringEventId ?? id) for recurring-series collapse (D-04).
    // The fetcher may have already collapsed recurring series (real fetcher does this).
    // This adapter-level collapse handles fakes that return raw instances.
    const byMaster = new Map<string, RawCalendarEvent>();
    const records: NormalizedRecord[] = [];

    for (const event of events) {
      if (event.status === 'cancelled') {
        if (!event.recurringEventId) {
          // Cancelled MASTER → add to side-channel for tombstoning in sleep pass (D-05)
          const metaKey = `calendar:cancelled:${this.accountId}`;
          let existing: string[];
          try {
            existing = JSON.parse(this.meta.getMeta(metaKey) ?? '[]') as string[];
          } catch {
            existing = [];
          }
          if (!existing.includes(event.id)) {
            existing.push(event.id);
          }
          this.meta.setMeta(metaKey, JSON.stringify(existing));
          // Do NOT emit a record for the cancelled master
        }
        // Cancelled INSTANCE (has recurringEventId) → silently skip; do NOT add to set (D-05)
        continue;
      }

      // Collapse recurring instances: keep the first occurrence per master (earliest future)
      // The fetcher orders by startTime, so the first instance per masterId is the next occurrence.
      const masterId = event.recurringEventId ?? event.id;
      if (!byMaster.has(masterId)) {
        byMaster.set(masterId, event);
      }
    }

    // Emit ONE record per master
    for (const event of byMaster.values()) {
      records.push(normalizeCalendarEvent(event, this.accountId, this.config));
    }

    // M-6: deferred cursor commit — called by orchestrator ONLY after appendBatch succeeds
    const commitCursor = (): void => {
      if (newSyncToken !== null) {
        this.meta.setMeta(cursorKey, newSyncToken);
      }
    };

    return { records, commitCursor };
  }
}
