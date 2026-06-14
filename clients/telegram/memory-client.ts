/**
 * HTTP memory client for the Telegram reference client.
 *
 * Provides ask() and search() against recense serve over plain-fetch HTTP REST.
 * POST /v1/ask and POST /v1/search with Authorization: Bearer token (D-01).
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

export interface MemoryClient {
  ask(query: string): Promise<AskResult>;
  search(query: string): Promise<unknown[]>;
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
  };
}
