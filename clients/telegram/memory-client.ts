/**
 * HTTP memory client for the Telegram reference client.
 *
 * Provides ask(), search(), surface(), and surfaceSeen() against recense serve
 * over plain-fetch HTTP REST with Authorization: Bearer token (D-01).
 *
 * Performs NO retry and NO logging — the caller (index.ts) owns the never-throw /
 * no-cursor-advance discipline so the failure mode stays in one place (D-04).
 *
 * Zero src/ imports — CLIENT-01 enforced at build time by clients/telegram/tsconfig.json.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AskResult {
  answer: string | null;
  origin: string;
}

/**
 * A surfaced memory item returned by GET /v1/surface.
 * Declared locally (CLIENT-01: no src/ import) — mirrors src/db/surface-store.ts:SurfaceItem.
 */
export interface SurfaceItem {
  node_id: string;
  value: string;
  /** ISO-8601 UTC — used as occurrence_due_at when posting to /v1/surface/seen */
  due_at: string;
  action_type: string;
  /** 0 = P0 (<24h deadline, bypasses quiet hours); 1 = lower priority (digest-only) */
  tier: 0 | 1;
  score: number;
}

/**
 * Body for POST /v1/surface/seen.
 * Declared locally (CLIENT-01: no src/ import) — mirrors the serve-cli endpoint contract.
 */
export interface SurfaceSeenParams {
  node_id: string;
  /** ISO-8601 string matching the SurfaceItem.due_at used as the idempotency key */
  occurrence_due_at: string;
  outcome?: 'surfaced' | 'seen' | 'snoozed' | 'completed' | 'dismissed';
  /** ISO-8601; required when outcome='snoozed' — server returns 400 otherwise (WR-01) */
  snooze_until?: string;
}

export interface MemoryClient {
  ask(query: string): Promise<AskResult>;
  search(query: string): Promise<unknown[]>;
  /** GET /v1/surface — returns due/salient items not yet marked seen. Uses GET, not POST. */
  surface(opts?: { limit?: number }): Promise<SurfaceItem[]>;
  /** POST /v1/surface/seen — records an outcome for a surfaced item. */
  surfaceSeen(params: SurfaceSeenParams): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an HTTP memory client bound to a specific recense serve instance.
 *
 * @param serveUrl   Base URL of recense serve (e.g. 'http://127.0.0.1:7701')
 * @param serveToken Bearer token for the serve's auth endpoint; sent as-is even
 *                   when empty (serve will return 401, caller handles the error).
 */
export function createMemoryClient(serveUrl: string, serveToken: string): MemoryClient {
  // Construct the header value once — never logged (T-13-05)
  const authHeader = `Bearer ${serveToken}`;

  async function postJson(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${serveUrl}${path}`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    // Non-2xx → throw; caller (index.ts) treats as unreachable (D-04: no reply, no cursor advance)
    if (!res.ok) throw new Error('serve HTTP ' + String(res.status));
    return res.json();
  }

  return {
    /**
     * Ask memory a question. Returns { answer, origin }.
     *
     * answer === null or origin === 'none' means no grounded answer is available (safe-null).
     * Throws on network error or non-2xx status — caller must NOT advance cursor on throw.
     */
    async ask(query: string): Promise<AskResult> {
      const body = await postJson('/v1/ask', { query }) as { answer?: unknown; origin?: unknown };
      const answer = typeof body.answer === 'string' ? body.answer : null;
      const origin = typeof body.origin === 'string' ? body.origin : 'unknown';
      return { answer, origin };
    },

    /**
     * Search memory for relevant results. Returns the results array.
     *
     * Throws on network error or non-2xx status.
     */
    async search(query: string): Promise<unknown[]> {
      const body = await postJson('/v1/search', { query }) as { results?: unknown };
      return Array.isArray(body.results) ? body.results : [];
    },

    /**
     * Fetch surfaced items from GET /v1/surface.
     *
     * IMPORTANT: uses a separate fetch with method:'GET' — postJson is POST-only (Landmine 3).
     * Returns the items array on success; returns [] when the response has no items field.
     * Throws 'serve HTTP {status}' on non-2xx (caller catches per-item — C-1).
     */
    async surface(opts?: { limit?: number }): Promise<SurfaceItem[]> {
      const params = new URLSearchParams();
      if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
      const qs = params.toString();
      const url = `${serveUrl}/v1/surface${qs ? '?' + qs : ''}`;
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'Authorization': authHeader },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error('serve HTTP ' + String(res.status));
      const body = await res.json() as { items?: unknown };
      return Array.isArray(body.items) ? body.items as SurfaceItem[] : [];
    },

    /**
     * Record an outcome for a surfaced item via POST /v1/surface/seen.
     *
     * When outcome='snoozed', snooze_until must be present (WR-01).
     * Throws 'serve HTTP {status}' on non-2xx — caller handles 400/404/503 per-item.
     */
    async surfaceSeen(params: SurfaceSeenParams): Promise<void> {
      await postJson('/v1/surface/seen', params);
    },
  };
}
