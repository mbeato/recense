# Recense reference client

A **reference client** wires any agent or messaging channel onto the recense REST
interface by following four steps: receive a message → call `/v1/search` or `/v1/ask`
with a Bearer token → present provenance correctly → fail closed when configuration is
absent or incomplete.

The client is **read-only by design**: it calls only `/v1/search` and `/v1/ask`, never
`/v1/add`. No engine packages are imported — the client is a plain-fetch HTTP caller
with zero native dependencies, making it portable to any environment that can run Node.

The extracted `clients/telegram/` directory is the canonical reference implementation.
Copy its structure; adapt the transport (Telegram, Slack, CLI, webhook) and nothing else.

---

## Hello memory client (on-ramp)

Get an answer from a fresh `recense serve` in under two minutes. The token is printed
once when `recense serve` first starts (TTY mode). For non-TTY (launchd, systemd), read
it from the env file:

```sh
grep '^BRAIN_SERVE_TOKEN=' ~/.config/recense/sleep.env
```

**Health check — no token required:**

```sh
curl -s http://127.0.0.1:7701/health
# {"status":"ok","version":"0.1.0"}
```

**Authenticated ask — replace `<token>` with your BRAIN_SERVE_TOKEN:**

```sh
curl -s -X POST http://127.0.0.1:7701/v1/ask \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"query":"what do I know about my training load"}'
# {"answer":"...","origin":"fact"}
```

**Interactive fetch loop — ~20 lines, no dependencies:**

Save as `hello-memory.mjs` and run with `node hello-memory.mjs`:

```js
#!/usr/bin/env node
// hello-memory.mjs — 2-minute on-ramp
// Set BRAIN_SERVE_URL and BRAIN_SERVE_TOKEN in your shell before running.
import { createInterface } from 'readline';

const { BRAIN_SERVE_URL = 'http://127.0.0.1:7701', BRAIN_SERVE_TOKEN } = process.env;
if (!BRAIN_SERVE_TOKEN) { console.error('BRAIN_SERVE_TOKEN not set'); process.exit(1); }

const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  const res = await fetch(`${BRAIN_SERVE_URL}/v1/ask`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${BRAIN_SERVE_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: line.trim() }),
  });
  if (!res.ok) { console.error('HTTP', res.status); return; }
  const { answer, origin } = await res.json();
  if (!answer || origin === 'none') { console.log('(no answer in memory)'); return; }
  const prefix = origin === 'inferred' ? '(inferred) ' : '';
  console.log(prefix + answer);
});
```

Type a question, press Enter, get an answer. `Ctrl-C` to exit.

---

## Telegram reference client

The `clients/telegram/` directory is a self-contained, engine-free implementation of
the reference client pattern. Its `tsconfig.json` has no `paths` entry into `src/` —
the TypeScript compiler enforces the import boundary at build time.

**Directory layout:**

```
clients/telegram/
  types.ts         — InboundMessage + FetchResult (engine-free local contracts)
  transport.ts     — TelegramTransport seam + DefaultTelegramTransport (global fetch)
  state.ts         — atomic chmod-600 cursor read/write (tmp→rename, null on error)
  config.ts        — loadClientConfig() + ClientConfig (fail-closed, env-sourced)
  memory-client.ts — createMemoryClient(serveUrl, serveToken) → { ask, search }
  index.ts         — fetchMessages + runClientTick + main (poll loop + entry guard)
  tsconfig.json    — compile boundary (no paths into src/)
```

**Environment variables (loaded from a chmod-600 env file):**

| Variable | Required | Default | Description |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | — | Bot API token from @BotFather |
| `BRAIN_SERVE_URL` | no | `http://127.0.0.1:7701` | recense serve base URL |
| `BRAIN_SERVE_TOKEN` | yes | — | Bearer token for recense serve auth |
| `BRAIN_CLIENT_ALLOWLIST` | yes | — | Comma-separated numeric Telegram user IDs |
| `BRAIN_CLIENT_POLL_MS` | no | `2000` (floor: `500`) | Poll interval in ms |
| `BRAIN_CLIENT_STATE_PATH` | no | `~/.config/recense/telegram-client-state.json` | Cursor state file path |

**How it works:**

1. `main()` calls `loadClientConfig()`. If `enabled` is false (see Fail-closed pattern), it
   logs the reason and exits without starting the poll interval.
2. `setInterval` fires `runClientTick(config, transport, memoryClient)` every
   `pollIntervalMs` ms.
3. `runClientTick` checks `tickInFlight` to prevent re-entrant tick overlap, calls
   `fetchMessages` (read-only, no cursor write), applies the D-04 no-loss discipline
   (ask error → return without advancing cursor), and writes the cursor only after
   full success.
4. `fetchMessages` handles cold start by paginating to exhaustion to find the current
   max `update_id`, committing the baseline cursor, and returning empty messages — the
   backlog is never answered.
5. The poll loop never calls `/v1/add`. The client is read-only by construction.

**The transport seam:** `DefaultTelegramTransport` calls the Telegram Bot API via global
`fetch` with `AbortSignal.timeout(10_000)`. Tests inject `MockTelegramTransport` directly
— no Channel class or adapter shim needed.

---

## API contract

All authenticated endpoints require `Authorization: Bearer <BRAIN_SERVE_TOKEN>`. The
health endpoint does not require auth.

### `GET /health`

```
→ 200 { "status": "ok", "version": "0.1.0" }
```

### `POST /v1/ask { query }`

Ask a question; get an LLM-composed answer over stored knowledge.

```json
→ 200 { "answer": "string or null", "origin": "fact | inferred | none" }
```

`origin` values:
- `"fact"` — answered directly from a stored fact
- `"inferred"` — composed via schema-based inference (a generalization, not a literal stored fact)
- `"none"` — honest no-answer: `{ "answer": null, "origin": "none" }`

Error responses:
- `401 Unauthorized` — missing or wrong token
- `503 Service Unavailable` — serve is starting up or the DB is unavailable

### `POST /v1/search { query }`

Semantic search. LLM-free: one embedding call, zero generation calls.

```json
→ 200 {
  "results": [
    {
      "value": "fact text",
      "origin": "asserted_by_user | observed | inferred",
      "score": 0.82,
      "lastUpdatedMs": 1781130884000
    }
  ]
}
```

Provenance in every result is deliberate — a consuming client can weigh an
`asserted_by_user` fact differently from an `inferred` one.

### `/v1/add` — reference clients do not call this

`/v1/add` exists on `recense serve` but the reference client never calls it (D-03). The
client is a read-only consumer. Writes to memory are the engine's job.

---

## Presenting provenance

The "memory that stays correct" differentiator is only visible to users if the client
layer presents it correctly. **Three rules:**

**1. Mark inferred answers visibly.**
When `origin === "inferred"`, the answer was composed via schema-based reasoning, not
recalled from a stored fact. Mark it clearly so the user knows they are reading an
inference, not a record:

```ts
const prefix = origin === 'inferred' ? '(inferred) ' : '';
reply(prefix + answer);
```

The Telegram reference client implements this pattern with an idempotency guard:
`recense serve` already embeds a trailing ` (inferred)` marker in inferred answers, so
the client adds the prefix only when the answer does not already end with the marker —
answers are never double-marked.

**2. Never present `origin: "none"` or `answer: null` as an answer.**
`{ "answer": null, "origin": "none" }` means the memory has no grounded answer. The
correct response is silence or an explicit "I don't have that in memory" — not a
fabricated reply. Presenting a null as an answer would undermine the correctness contract.

```ts
if (!answer || origin === 'none') {
  // stay silent — do not reply with a fabricated answer
  return;
}
```

**3. Surface `lastUpdatedMs` when it matters.**
`/v1/search` results include `lastUpdatedMs` (epoch ms). When showing a retrieved fact
to the user, displaying how recently it was last updated — especially for time-sensitive
information like schedules, config values, or status — makes the "stays correct" signal
visible rather than implicit.

The Telegram client uses `/v1/ask` (single composed answer) and relies on the `origin`
marker. A search-results UI should additionally render the `lastUpdatedMs` per result.

---

## Fail-closed pattern

The reference client is fail-closed at every layer: no configuration accident can
produce a client that answers arbitrary senders.

**Runtime enabled gate (D-10):**

`loadClientConfig()` sets `enabled = false` when any of these conditions hold:
- `TELEGRAM_BOT_TOKEN` is missing or empty
- `BRAIN_SERVE_TOKEN` is missing or empty
- `BRAIN_CLIENT_ALLOWLIST` is empty (parses to zero entries)

`main()` checks `config.enabled` before starting `setInterval`. If false, it logs the
reason and returns — no poll loop is started. **Process-not-running is not the gate.**
The runtime flag is. A running process with `enabled: false` is deliberately idle.

**Empty allowlist answers no one:**

An allowlist of `[]` is not a misconfiguration that allows all senders — it is the
conservative default. The client answers no one until at least one numeric Telegram
user ID is added to `BRAIN_CLIENT_ALLOWLIST`.

**Missing token disables:**

A client started without `BRAIN_SERVE_TOKEN` logs the reason and does not poll.
Without `TELEGRAM_BOT_TOKEN` it cannot fetch updates at all. Both missing-token
conditions are caught by the `enabled` gate before any network call is made.

**Allowlist enforcement per message:**

Even when `enabled: true`, `fetchMessages` checks each inbound sender's numeric ID
against the allowlist set. Unlisted senders are silently ignored — no reply is sent,
so the surface never confirms it exists to an unknown sender.

---

## Deployment

### Client env file (chmod-600, untracked)

Put the client's secrets in a dedicated chmod-600 env file, separate from
`sleep.env`. Never commit it.

```sh
mkdir -p ~/.config/recense
cat > ~/.config/recense/telegram-client.env <<'EOF'
TELEGRAM_BOT_TOKEN=123456:ABC-your-bot-token-here
BRAIN_SERVE_URL=http://127.0.0.1:7701
BRAIN_SERVE_TOKEN=your-64-char-serve-token
BRAIN_CLIENT_ALLOWLIST=123456789
EOF
chmod 600 ~/.config/recense/telegram-client.env
```

**Never log or commit the token.** Read it with grep when you need it:

```sh
grep '^BRAIN_SERVE_TOKEN=' ~/.config/recense/telegram-client.env
```

### launchd KeepAlive plist (macOS)

The setup script `scripts/setup-telegram-client.sh` (added in Phase 13) renders and
installs the launchd plist automatically. Run it once after wiring the env file:

```sh
bash scripts/setup-telegram-client.sh
```

The plist runs the client as a `KeepAlive` job — launchd restarts it automatically
if it exits.

**Client vs serve: node binary note.**
The Telegram client has **no native Node add-ons** (no `better-sqlite3`). Its launchd
wrapper can use `node` from PATH without a pinned binary. This is unlike `recense serve`,
which opens `better-sqlite3` and must use the exact Node binary that compiled the
native module (the `RECENSE_NODE_BIN` pin in `sleep.env`). See
[docs/server-mode.md](docs/server-mode.md) for serve deployment and token rotation.

**Check the client log:**

```sh
tail -f /tmp/recense-telegram-client.log
```

### Token rotation

`BRAIN_SERVE_TOKEN` rotation is documented in `docs/server-mode.md`. After rotating,
update the new token in `telegram-client.env` (chmod-600, not re-committed), then
restart the client job:

```sh
launchctl kickstart -k gui/$(id -u)/com.recense.telegram-client
```
