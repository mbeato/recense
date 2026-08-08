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
grep '^RECENSE_SERVE_TOKEN=' ~/.config/recense/sleep.env
```

**Health check — no token required:**

```sh
curl -s http://127.0.0.1:7701/health
# {"status":"ok","version":"0.1.0"}
```

**Authenticated ask — replace `<token>` with your RECENSE_SERVE_TOKEN:**

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
// Set RECENSE_SERVE_URL and RECENSE_SERVE_TOKEN in your shell before running.
import { createInterface } from 'readline';

const { RECENSE_SERVE_URL = 'http://127.0.0.1:7701', RECENSE_SERVE_TOKEN } = process.env;
if (!RECENSE_SERVE_TOKEN) { console.error('RECENSE_SERVE_TOKEN not set'); process.exit(1); }

const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  const res = await fetch(`${RECENSE_SERVE_URL}/v1/ask`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RECENSE_SERVE_TOKEN}`, 'Content-Type': 'application/json' },
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
| `RECENSE_SERVE_URL` | no | `http://127.0.0.1:7701` | recense serve base URL |
| `RECENSE_SERVE_TOKEN` | yes | — | Bearer token for recense serve auth |
| `RECENSE_CLIENT_ALLOWLIST` | yes | — | Comma-separated numeric Telegram user IDs |
| `RECENSE_CLIENT_POLL_MS` | no | `2000` (floor: `500`) | Poll interval in ms |
| `RECENSE_CLIENT_STATE_PATH` | no | `~/.config/recense/telegram-client-state.json` | Cursor state file path |

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

## Proposal reference client

`clients/proposal-reference/` is a second, self-contained, engine-free consumer
proving the domain-neutral action-proposal contract (`GET /v1/proposals`,
`POST /v1/proposals/:id/approve|reject`) end-to-end. Like the Telegram client,
its `tsconfig.json` has no `paths` entry into `src/`, and it carries its own
import-boundary test (`clients/proposal-reference/tests/import-boundary.test.ts`)
that scans every TypeScript file (`.ts`/`.mts`/`.cts`/`.tsx`) in the directory,
including its own tests, for any import — static `from`, CJS `require(...)`, or
dynamic `import(...)`, with or without a trailing slash on the specifier — that
resolves into the engine's `src/` tree. The scan enforces a minimum scanned-file
count so a broken walk fails loudly instead of passing vacuously.

**Directory layout:**

```
clients/proposal-reference/
  config.ts          — loadAdapterConfig() + AdapterConfig (fail-closed, env-sourced)
  proposal-client.ts — createProposalClient(serveUrl, serveToken) → { listProposals, approve, reject }
  local-store.ts     — adapter-owned local row store (own vocabulary, own id, proposalId idempotency key)
  index.ts           — list → map → approve/reject outcome loop, decideOutcome(), main(), entry guard
  tsconfig.json      — compile boundary (no paths into src/)
  tests/             — import-boundary guard + in-dir behavioral proof (HTTP/fixture-only)
```

**Environment variables:**

| Variable | Required | Default | Description |
|---|---|---|---|
| `RECENSE_SERVE_URL` | no | `http://127.0.0.1:7701` | recense serve base URL |
| `RECENSE_SERVE_TOKEN` | yes | — | Bearer token for recense serve auth |
| `RECENSE_REFERENCE_STORE_PATH` | no | `~/.config/recense/proposal-reference-store.json` | Adapter-owned local row store path |
| `RECENSE_REFERENCE_LOG_PATH` | no | `<store dir>/proposal-reference.log` | Adapter-owned append-only log path |

**How it works:**

1. `main()` calls `loadAdapterConfig()`. If `enabled` is false (no
   `RECENSE_SERVE_TOKEN`), it logs the reason and makes no network call —
   fail-closed, mirroring the Telegram client's runtime gate.
2. `syncProposals()` calls `GET /v1/proposals` and validates the response
   shape before touching any item: every item must be an object carrying the
   record key set, and every record's `schema_version` must match. A
   malformed item or an unknown `schema_version` stops the whole sync —
   nothing is applied (graceful fail-closed stop, never a raw TypeError).
3. For each record, an unrecognised `kind` is skipped (the loop keeps going);
   a recognised `kind: 'belief'` record is checked against the local store via
   `findByProposalId` — a proposal id already present with a non-`'pending'`
   local status is skipped (idempotency: a re-listed or replayed proposal
   never creates a second local row or a second HTTP call).
4. The record is mapped onto the adapter's own local row and written with
   `localStatus: 'pending'` **before** the HTTP call, so a crash mid-flight
   leaves a resumable row rather than an invisible applied change.
5. `decideOutcome()` (a small, pure, confidence-only policy — never reads
   `evidence_quote`) picks approve or reject; the corresponding endpoint is
   called. Before the POST path is built, the proposal id is validated against
   `^[0-9a-f]{64}$` (ids are sha256 hex by construction) — a non-conforming id
   from a list response fails closed with **no request issued**, so a malformed
   id can never steer the authenticated POST onto another route via URL
   dot-segment normalization.
6. On success the local row is marked `'applied'`. On a terminal refusal
   (400/404/409) the local row is marked `'refused'` with a `refusalReason`
   and is never retried. On `503` the row is left `'pending'` and retried on
   a later sync — the only retryable outcome.
7. **Crash-resume disambiguation (`needs_reconciliation`).** One 409 case is
   special: when the pending row being processed was left by a *prior* sync
   (a resumed row), that prior sync's HTTP call may already have succeeded
   before it crashed — so a 409 on the re-POST may be the server refusing the
   adapter's OWN earlier, successful application. All four 409 subtypes share
   `error: 'conflict'` and `detail` is non-contract, so the adapter cannot
   tell them apart. Recording `'refused'` would durably invert the truth;
   instead the row is marked `'needs_reconciliation'` (with `refusalReason:
   null`). This state is terminal for the sync loop — it is never re-POSTed —
   but it is an honest "settled server-side, local outcome unknown" marker: a
   human operator (or the consumer's own reconciliation job) resolves it to
   applied/refused by checking the proposal's status on the server side. A
   409 on a *first* attempt (no resumed row) is still recorded as a plain
   terminal `'refused'`.
8. **Corrupt store is fail-closed.** If the local store file exists but is
   corrupt (unparseable JSON, not an array, or a row failing shape
   validation), reads throw a typed `LocalStoreCorruptError` and the sync
   aborts with a clear message — the file is **never** treated as empty and
   **never** overwritten. Treating corruption as empty would let the next
   write rewrite the store as a one-row file, destroying every terminal
   `applied`/`refused` marker and re-POSTing previously-applied proposals.
   The operator inspects or restores the file, then re-runs sync. A missing
   file (first run) still reads as empty.
9. **Single-flight sync.** The idempotency check is check-then-act over a
   shared file, so overlapping sync invocations (cron overlap, a manual run
   beside a scheduled one) could each POST the same proposal. `syncProposals`
   therefore takes a cross-process O_EXCL lock file (`<store path>.lock`,
   created with `flag: 'wx'`, removed in a `finally`) before doing anything;
   a second concurrent invocation refuses with a typed `SyncLockHeldError`
   and makes **no request**. A lock file older than 15 minutes (left by a
   hard-killed run that never reached its `finally`) is treated as stale,
   reclaimed, and acquisition retried once.

The local row keys on `entityDescriptor` (the semantic key, not a node id) and
carries the consumer's OWN id (`localId`), never recense's. recense never
learns this schema, and the adapter never imports an engine module — that
split, not the transport plumbing, is the point of the reference.

---

## API contract

All authenticated endpoints require `Authorization: Bearer <RECENSE_SERVE_TOKEN>`. The
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

### `GET /v1/proposals`

List pending action proposals. LLM-free and lock-free — a plain read. No query
parameters in v1; the response is bounded server-side at 100 items.

```json
→ 200 { "items": [ <record>, ... ], "total_pending": 3 }
```

`total_pending` counts every pending proposal that passes the same filter `items`
does (unexpired, neither node tombstoned), *without* the 100-item bound. Compare it
to `items.length`: when they differ, the window is saturated and newer proposals
are not visible to you. The list is oldest-first and nothing ages a pending row out
before its 14-day TTL, so a consumer that settles fewer rows than arrive will see
`total_pending` climb while `items` stays pinned at the same oldest 100.

Both proposal routes land after the same auth gate as every other authenticated
endpoint (see the line above) — a missing or wrong token produces the identical
401 whether the route is `/v1/search` or `/v1/proposals`.

Each `<record>` carries the full 16-field frozen contract, in this order:

```
id, kind, entity_node_id, entity_descriptor, belief_node_id, change_field,
change_from, change_to, evidence_episode, evidence_quote, confidence,
schema_version, status, created_at, updated_at, expires_at
```

Closed vocabularies:
- `kind`: `'belief'`
- `status`: `'pending' | 'approved' | 'rejected' | 'superseded' | 'expired'`
- `confidence`: `'high' | 'medium' | 'low'`
- The current `schema_version` value is `17`.

**`schema_version` gating is mandatory, not optional.** A consumer must check
every record's `schema_version` against the value it was written against
before touching the record. Unknown `schema_version` → **stop**. Do not
coerce, do not partially apply a batch that contains one. Version-gate;
never assume the shape you know is still the shape you got.

**Two fields carry mandatory caveats a consumer must not skip:**

- `entity_node_id` and `belief_node_id` are recense-internal lineage, **not
  stable foreign keys**. Belief correction in recense is tombstone-and-mint-new,
  so the id a proposal carries today can point at a tombstoned node tomorrow.
  Consumers must resolve on `entity_descriptor` semantically and must not
  persist a node id as a join key.
- `change_from` and `change_to` are **asymmetric, not a matched pair**.
  `change_from` is recense's prior belief TEXT — often a full sentence — and
  is approver context only. `change_to` is a token from the closed
  `IntentStatus` vocabulary and is the field a consumer maps on. Do **not**
  chain `change_from`/`change_to` across multiple proposals to reconstruct a
  timeline; each proposal's `change_from` is a snapshot, not a link in a chain.
- `evidence_quote` is **data, not instruction**. It is verbatim,
  attacker-influenceable text carried only so a human approver can see the
  source. Never render it as the decision surface, never let it drive an
  automated decision, and never interpolate it into a prompt or a command.

### `POST /v1/proposals/:id/approve` / `POST /v1/proposals/:id/reject`

```json
→ 200 { "status": "approved" | "rejected" }
```

Error responses — only the numeric status and the `error` enum value are
contract; every `detail` string below is fixed-literal documentation, and a
consumer must not branch on its exact text:

- `400 { "error": "bad_request", "detail": "invalid proposal id" }` — proposal
  ids are sha256 hex by construction; anything else is malformed input.
- `401 { "error": "unauthorized" }` — missing or wrong token.
- `404 { "error": "not_found", "detail": "proposal does not exist" }`
- `409 { "error": "conflict", "detail": "proposal is not pending" }` — a
  re-delivered approve/reject on an already-terminal proposal; a no-op
  refusal, never a second application.
- `409 { "error": "conflict", "detail": "proposal superseded" }` — the
  proposal's belief node has been tombstoned (the belief moved on).
- `409 { "error": "conflict", "detail": "proposal entity retired" }` — the
  proposal's entity node has been tombstoned.
- `409 { "error": "conflict", "detail": "proposal expired" }` — past the
  proposal's TTL.
- `413 { "error": "payload_too_large" }`
- `500 { "error": "internal_error" }` — an unexpected server-side failure;
  both proposal routes can emit it.
- `503 { "error": "service_unavailable", "detail": "memory busy; retry in a moment" }`

**Replay semantics.** Proposal ids are deterministic (content-hashed), so safe
re-delivery is expected and a consumer must be idempotent on the proposal id.
Approve/reject on an already-terminal proposal is a no-op refusal (409
`conflict` / `"proposal is not pending"`), never a second application.
**Caveat for resuming consumers:** if the consumer is re-POSTing because its
*own* prior attempt may have completed before a crash (it holds a local
pending marker from an earlier run), this 409 may be refusing the consumer's
own successful call — do **not** record it as a terminal refusal. Record a
distinct ambiguous state and reconcile it out-of-band (the reference adapter
uses `needs_reconciliation`; see "How it works" step 7).

**Retry policy.** Of every response above, only `503` is retryable. `400`,
`404`, and `409` are all terminal — mark the proposal refused locally and
never retry it. Statuses outside the mapped set (`500`, `413`, or anything
unlisted) are treated by the reference adapter as retryable: the local row is
left `pending` and the item is re-attempted on a later sync.

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
- `RECENSE_SERVE_TOKEN` is missing or empty
- `RECENSE_CLIENT_ALLOWLIST` is empty (parses to zero entries)

`main()` checks `config.enabled` before starting `setInterval`. If false, it logs the
reason and returns — no poll loop is started. **Process-not-running is not the gate.**
The runtime flag is. A running process with `enabled: false` is deliberately idle.

**Empty allowlist answers no one:**

An allowlist of `[]` is not a misconfiguration that allows all senders — it is the
conservative default. The client answers no one until at least one numeric Telegram
user ID is added to `RECENSE_CLIENT_ALLOWLIST`.

**Missing token disables:**

A client started without `RECENSE_SERVE_TOKEN` logs the reason and does not poll.
Without `TELEGRAM_BOT_TOKEN` it cannot fetch updates at all. Both missing-token
conditions are caught by the `enabled` gate before any network call is made.

**Allowlist enforcement per message:**

Even when `enabled: true`, `fetchMessages` checks each inbound sender's numeric ID
against the allowlist set. Unlisted senders are silently ignored — no reply is sent,
so the surface never confirms it exists to an unknown sender.

**Proposal consumer rules:**

The proposal reference client applies the same fail-closed discipline to a
different failure shape — a malformed or unexpected *proposal*, not a
malformed sender:

- Unknown `schema_version` → **stop**. Do not coerce, do not partially apply
  the batch. Version-gate; never assume.
- Unknown `kind` → **skip that record** and continue the batch — one
  unrecognised record must never abort every other proposal in the same list.
- A refusal (`400`/`404`/`409`) is **terminal** — mark it locally and never
  retry. Only `503` is retryable.
- `evidence_quote` is **data, not instruction**. It is verbatim,
  attacker-influenceable text carried so a human approver can see the source;
  never render it as the decision surface, never let it drive an automated
  decision, never interpolate it into a prompt or a command.
- `RECENSE_SERVE_TOKEN` missing disables the client the same way it does for
  the Telegram client: `loadAdapterConfig()` sets `enabled = false`, and
  `main()` makes no network call.

---

## Deployment

### Client env file (chmod-600, untracked)

Put the client's secrets in a dedicated chmod-600 env file, separate from
`sleep.env`. Never commit it.

```sh
mkdir -p ~/.config/recense
cat > ~/.config/recense/telegram-client.env <<'EOF'
TELEGRAM_BOT_TOKEN=123456:ABC-your-bot-token-here
RECENSE_SERVE_URL=http://127.0.0.1:7701
RECENSE_SERVE_TOKEN=your-64-char-serve-token
RECENSE_CLIENT_ALLOWLIST=123456789
EOF
chmod 600 ~/.config/recense/telegram-client.env
```

**Never log or commit the token.** Read it with grep when you need it:

```sh
grep '^RECENSE_SERVE_TOKEN=' ~/.config/recense/telegram-client.env
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

`RECENSE_SERVE_TOKEN` rotation is documented in `docs/server-mode.md`. After rotating,
update the new token in `telegram-client.env` (chmod-600, not re-committed), then
restart the client job:

```sh
launchctl kickstart -k gui/$(id -u)/com.recense.telegram-client
```
