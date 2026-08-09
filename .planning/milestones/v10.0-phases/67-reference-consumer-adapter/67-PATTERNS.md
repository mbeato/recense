# Phase 67: Reference Consumer Adapter - Pattern Map

**Mapped:** 2026-08-03
**Files analyzed:** 8 (new client dir treated as one unit + its tests, docs edit, repo-level e2e, CI wiring)
**Analogs found:** 8 / 8

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `clients/proposal-reference/tsconfig.json` | config | file-I/O (build boundary) | `clients/telegram/tsconfig.json` | exact (copy verbatim, adjust nothing) |
| `clients/proposal-reference/config.ts` | config | request-response (env→struct) | `clients/telegram/config.ts` (`loadClientConfig`, lines 55-87) | exact shape, fewer fields |
| `clients/proposal-reference/memory-client.ts` (or equivalent) | service | request-response (HTTP consumer) | `clients/telegram/memory-client.ts` (whole file, 224 lines) | exact — same factory-fn-returning-object shape, same postJson/GET helper pattern |
| `clients/proposal-reference/store.ts` (local rows) | model / store | CRUD (local persistence) | `clients/telegram/proposal-store.ts` (whole file, 271 lines) | exact — atomic tmp→rename JSON store, deep-copy discipline |
| `clients/proposal-reference/index.ts` (+ optional CLI) | controller / entry | request-response, polling loop | `clients/telegram/index.ts` `fetchMessages`/`runClientTick`/`main` (lines 121-215, 242-496, 1326-1387) — read only the tick-loop + entry-guard shape, ignore Telegram-transport/DeepSeek-proposal internals | role-match (adapter is far simpler — no transport, no LLM) |
| `clients/proposal-reference/tests/import-boundary.test.ts` | test | file scan (boundary guard) | `clients/telegram/tests/import-boundary.test.ts` (whole file, 48 lines) | exact — sibling copy per D-04, only `CLIENT_DIR` resolve target changes |
| `tests/<e2e-name>.test.ts` (repo-level e2e) | test | request-response (HTTP + seed) | `tests/proposal-routes.test.ts` (server-spin harness lines 1-234; refusal-matrix pattern throughout) | exact harness match — `createBrainHttpServer`, `getFreePort`, `ActionProposalStore` seeding |
| `docs/reference-client.md` (modified) | docs | n/a | its own "Telegram reference client" / "API contract" / "Fail-closed pattern" sections (lines 77-260) | exact — mirror existing section structure |

## Pattern Assignments

### `clients/proposal-reference/tsconfig.json` (config)

**Analog:** `clients/telegram/tsconfig.json` (full file, 19 lines) — copy verbatim, no changes needed beyond the fact the directory itself moves. D-01 explicitly requires "same compilerOptions shape; no `paths` into `src/`":

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "types": ["node"],
    "outDir": "dist",
    "rootDir": ".",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["."],
  "exclude": ["tests", "dist"]
}
```

**Caveat for the planner:** D-04 requires the import-boundary test to scan the adapter's `tests/` too, but this `tsconfig.json`'s `exclude: ["tests", "dist"]` matches the telegram precedent exactly (tests are excluded from the *build*, not from the *guard test*'s file scan — the guard test does its own `readdirSync` walk independent of tsconfig). Do not "fix" this apparent tension; it is the telegram file's actual behavior and D-04 wants it copied as-is.

---

### `clients/proposal-reference/config.ts` (config, request-response)

**Analog:** `clients/telegram/config.ts` — use only the `ClientConfig`/`loadClientConfig` half (lines 1-87); skip the MCP/DeepSeek/allowlist-file machinery (lines 89-263), which is Phase-23-specific and out of scope for a pure HTTP consumer.

**Imports pattern** (lines 1-4):
```typescript
import { existsSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { AllowlistEntry, McpServerConfig } from './types';
```
(the new adapter needs only `join`/`homedir` for its local store path — drop the rest)

**Fail-closed config-load pattern** (lines 48-87, condensed template):
```typescript
export interface ClientConfig {
  serveUrl: string;   // RECENSE_SERVE_URL, default http://127.0.0.1:7701
  serveToken: string; // RECENSE_SERVE_TOKEN — Bearer token
  localStorePath: string; // adapter-owned local row store path
  enabled: boolean;   // fail-closed: false when serveToken is missing
}

export function loadClientConfig(): ClientConfig {
  const serveUrl = process.env['RECENSE_SERVE_URL'] ?? 'http://127.0.0.1:7701';
  const serveToken = process.env['RECENSE_SERVE_TOKEN'] ?? '';
  const localStorePath =
    process.env['RECENSE_REFERENCE_STORE_PATH'] ??
    join(homedir(), '.config', 'recense', 'proposal-reference-store.json');
  const enabled = serveToken !== '';
  return { serveUrl, serveToken, localStorePath, enabled };
}
```
Mirror telegram's doc-comment convention: one `/** ENV_VAR — description. Default: X */` line per field (config.ts lines 13-46).

---

### `clients/proposal-reference/memory-client.ts` (service, request-response)

**Analog:** `clients/telegram/memory-client.ts` (whole file, 224 lines) — the single closest structural match in the entire codebase: factory function `createMemoryClient(serveUrl, serveToken)` returning a typed interface of async methods, all HTTP via plain `fetch`, `Authorization: Bearer` header built once, `AbortSignal.timeout(10_000)`, non-2xx throws `serve HTTP {status}`.

**Imports pattern:** none — file has zero imports (lines 1-11 are doc comment only), confirming CLIENT-01 zero-src-import discipline. The new file should likewise import nothing but Node/global `fetch`.

**Auth pattern** (lines 105-122):
```typescript
export function createMemoryClient(serveUrl: string, serveToken: string): MemoryClient {
  const authHeader = `Bearer ${serveToken}`;

  async function postJson(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${serveUrl}${path}`, {
      method: 'POST',
      headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error('serve HTTP ' + String(res.status));
    return res.json();
  }
  ...
```

**GET pattern** (lines 155-168, `surface()`) — the adapter's `GET /v1/proposals` call should follow this shape exactly (separate fetch call, not `postJson`, since GET has no body):
```typescript
async surface(opts?: { limit?: number }): Promise<SurfaceItem[]> {
  const res = await fetch(`${serveUrl}/v1/surface`, {
    method: 'GET',
    headers: { 'Authorization': authHeader },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error('serve HTTP ' + String(res.status));
  const body = await res.json() as { items?: unknown };
  return Array.isArray(body.items) ? body.items as SurfaceItem[] : [];
},
```
For the adapter: `GET /v1/proposals` returns `{ items: ActionProposalRecord[] }` (see route excerpt below) — same `Array.isArray(body.items)` guard.

**POST-action pattern (approve/reject):** mirror `surfaceSeen()` (lines 176-178) — a thin `postJson` wrapper returning `void` (the adapter cares only about success/thrown-error, since the ack body `{status: 'approved'|'rejected'}` is not itself needed once the local row is updated). The adapter's caller must catch the thrown error and branch on HTTP status (see refusal-error mapping below) — `memory-client.ts` itself does NOT catch/interpret status codes; that discipline belongs to the caller (mirrors D-04 "no reply, no cursor advance" pattern in `index.ts`, not in `memory-client.ts`).

**Local type declaration discipline** (lines 22-73): every wire type consumed from serve is **redeclared locally** in the client file, never imported from `src/`:
```typescript
/**
 * A surfaced memory item returned by GET /v1/surface.
 * Declared locally (CLIENT-01: no src/ import) — mirrors src/db/surface-store.ts:SurfaceItem.
 */
export interface SurfaceItem { ... }
```
The adapter must declare its own local `ActionProposalRecord`-shaped interface (16 fields, see below) rather than importing `src/db/action-proposal-store.ts`'s type.

---

### `clients/proposal-reference/store.ts` (model, CRUD — the local-row "system of record")

**Analog:** `clients/telegram/proposal-store.ts` (whole file, 271 lines) — atomic-write JSON document store, the closest existing "local persistence with idempotency" pattern in the repo.

**Atomic write pattern** (lines 87-99):
```typescript
function writeDoc(storePath: string, doc: ProposalDocument): void {
  mkdirSync(dirname(storePath), { recursive: true });
  const tmp = join(dirname(storePath), `.proposal-store-${Date.now()}-${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600 });
  chmodSync(tmp, 0o600); // belt-and-suspenders against umask
  renameSync(tmp, storePath);
}
```

**Never-throw read + idempotent put pattern** (lines 54-85, 128-135):
```typescript
function readDoc(storePath: string): Doc {
  try {
    if (!existsSync(storePath)) return EMPTY;
    const raw = JSON.parse(readFileSync(storePath, 'utf8')) as unknown;
    // ...shape-validate each field defensively, never trust the file...
  } catch { return EMPTY; }
}

export function putRow(row: LocalRow, storePath: string): void {
  const doc = readDoc(storePath);
  doc.rows = doc.rows.filter(r => r.id !== row.id); // idempotent replace-by-id
  doc.rows.push(JSON.parse(JSON.stringify(row)) as LocalRow); // deep-copy before persist
  writeDoc(storePath, doc);
}
```

**Adapter-specific translation (D-02/D-03):** the local row's own id is generated by the adapter (its "own vocabulary"); it must additionally store the **source proposal's `id`** as a foreign key purely for idempotency (EMIT-04's consumer half — "a replayed/re-listed proposal must not create a second local row"). Pattern: `findByProposalId(proposalId)` before insert, mirroring `getProposal`'s find-before-mutate shape (proposal-store.ts lines 146-160) — but keyed on the recense proposal id, not a locally-generated one. Suggested local row shape (planner discretion on exact fields, but this satisfies D-02's "own vocabulary + own local id" requirement):
```typescript
interface LocalRow {
  localId: string;        // this adapter's own id (e.g. randomUUID())
  proposalId: string;     // recense action_proposal.id — the idempotency key (D-02/D-03)
  entityDescriptor: string; // keyed semantically per D-02 (consumer-side resolution demo)
  localStatus: 'pending' | 'applied' | 'refused';
  refusalReason?: string;  // set on a 409-class refusal — terminal, never retried (D-03)
}
```

---

### `clients/proposal-reference/index.ts` (controller/entry, request-response + polling)

**Analog:** `clients/telegram/index.ts` — read ONLY the shape of `main()` (lines 1326-1387) and the entry guard (lines 1379-1387); do NOT copy the Telegram transport, DeepSeek proposal-generation, or typed-confirm machinery (lines 217-1148 are all Telegram/Phase-23-specific and irrelevant to this adapter).

**Entry-guard pattern** (lines 1374-1387) — copy verbatim, this is the exact convention the repo uses to make a client `require()`-able by tests without side effects:
```typescript
if (require.main === module) {
  main().catch(err => {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] proposal-reference FATAL: ${String(err)}\n`);
    process.exit(1);
  });
}
```

**Fail-closed main() skeleton** (mirrors lines 1326-1338, condensed for the adapter's simpler config):
```typescript
export async function main(): Promise<void> {
  const config = loadClientConfig();
  if (!config.enabled) {
    log('client disabled — RECENSE_SERVE_TOKEN missing (fail-closed); idling');
    return;
  }
  const memoryClient = createMemoryClient(config.serveUrl, config.serveToken);
  // list pending → map/apply to local rows → approve/reject → handle refusal (D-03)
}
```

**Full outcome-loop pattern (D-03)** — the adapter's core logic (list → map → approve/reject → refusal handling) has no exact analog in `index.ts` (telegram's approve flow is button-driven, not list-driven), so this is the one piece of genuinely new logic. Structure it as a plain async function (not a `setInterval` tick — D-03 doesn't require polling, just a `list|sync` CLI action per the optional-CLI discretion note), following the try/catch-per-item discipline from `runClientTick`'s respond loop (lines 307-396): never let one item's failure abort the batch.

---

### `clients/proposal-reference/tests/import-boundary.test.ts` (test, boundary guard)

**Analog:** `clients/telegram/tests/import-boundary.test.ts` (whole file, 48 lines) — D-04 explicitly requires a **sibling copy**, not a reuse or parameterization. Copy verbatim; the only line that changes is the resolved directory:

```typescript
const CLIENT_DIR = resolve(__dirname, '..'); // clients/proposal-reference/
```

Everything else — the recursive `.ts` collector (lines 17-29, walks ALL `.ts` including the `tests/` subdir per D-04's "including its own tests/" requirement), the regex guard (lines 39-42), and the `describe`/`it` wrapper (lines 31-48) — is copied unchanged. Only the `describe` title string and the doc-comment header should reference `CONSUME-02` instead of `CLIENT-01`/`D-06` (adjust prose, not logic).

---

### Repo-level e2e test — `tests/<name>.test.ts` (test, request-response, D-05's "proof lives at repo level")

**Analog:** `tests/proposal-routes.test.ts` (383 lines) — this is the harness to crib almost entirely; the e2e drives the SAME server via HTTP and seeds through the SAME `ActionProposalStore`, but additionally invokes the adapter's real entry point (e.g. its `main()`/list-sync function) against that live server instead of raw `http.request` calls.

**Server-spin harness** (lines 63-77, 204-234) — copy verbatim:
```typescript
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number };
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', reject);
  });
}

beforeEach(async () => {
  tmpDbPath = makeTempDbPath('e2e');
  const setupDb = new Database(tmpDbPath);
  initSchema(setupDb);
  setupDb.close();
  port = await getFreePort();
  const provider = makeLlmFreeProvider(); // fail-if-called ModelProvider — proves the route is LLM-free
  serverResult = await createBrainHttpServer({ dbPath: tmpDbPath, token: TEST_TOKEN, provider });
  serverResult.server.listen(port, '127.0.0.1');
  await new Promise<void>((resolve) => {
    if (serverResult.server.listening) { resolve(); return; }
    serverResult.server.once('listening', resolve);
  });
  seedDb = new Database(tmpDbPath);
});
```

**Seed-through-the-engine pattern** (lines 152-195) — the e2e uses this exact `seedProposal()` shape to create a pending `action_proposal` row directly via `ActionProposalStore`/`SemanticStore`, satisfying D-05's "repo-level test MAY use engine modules to seed":
```typescript
const store = new SemanticStore(seedDb, realClock, config(tmpDbPath));
store.upsertNode({ id: entityNodeId, type: 'entity', value: `entity ${n}`, origin: 'observed' });
store.upsertNode({ id: beliefNodeId, type: 'fact', value: `belief ${n}`, origin: 'observed' });
// ... episode insert ...
const proposalStore = new ActionProposalStore(seedDb, realClock);
proposalStore.insert(row); // row: full 16-field ActionProposalRecord, status: 'pending'
```

**Refusal round-trip fixture** — `seedProposal({ beliefTombstoned: true })` (via `SemanticStore.tombstone(beliefNodeId)`, line 166) is exactly the seed the e2e's "409-class refusal" test (the phase's D-03/specifics requirement) should use: seed a proposal whose belief has moved, drive the adapter's approve path over HTTP against the live server, and assert (a) the server returns 409 conflict, (b) the adapter's local row is marked refused/terminal, (c) no retry occurs. Cross-reference the exact refusal→status mapping the adapter must handle, from `serve-cli.ts` (lines 591-598):
```typescript
if (err instanceof ProposalStaleError) {
  const detail = err.reason === 'superseded' ? 'proposal superseded'
    : err.reason === 'entity_gone' ? 'proposal entity retired'
    : 'proposal expired';
  jsonError(res, 409, { error: 'conflict', detail });
}
```

**Fail-if-called ModelProvider** (lines 42-61) — reuse verbatim to prove the adapter's approve/reject calls never trigger LLM generation:
```typescript
function makeLlmFreeProvider(): ModelProvider & { readonly embedCount: number } {
  return {
    async embed(texts) { return texts.map(() => new Float32Array([0, 1, 0])); },
    async generate(): Promise<string> { throw new Error('generate must not be called'); },
    async judge(): Promise<never> { throw new Error('judge must not be called'); },
    async judgeBatch(): Promise<never> { throw new Error('judgeBatch must not be called'); },
  };
}
```

---

### `docs/reference-client.md` (docs, modified)

**Analog:** the file's own existing "Telegram reference client" section (lines 77-125), "API contract" section (lines 128-179), and "Fail-closed pattern" section (lines 226-259) — D-06/D-07 require the new proposal-consumer section to mirror this exact structure: directory-layout table → env-var table → "how it works" numbered flow → contract detail → fail-closed rules.

**Section-header convention to extend** (the file is `##`-delimited top-level sections in reading order; insert the new section after "Telegram reference client" and before "API contract", OR extend "API contract" with the proposal endpoints and add a new "Proposal reference client" section — planner discretion per D-06's note "exact docs section placement... discretion"):

**Directory-layout table pattern** (lines 83-94) to replicate:
```
clients/proposal-reference/
  config.ts        — loadClientConfig() + ClientConfig (fail-closed, env-sourced)
  memory-client.ts — createMemoryClient(serveUrl, serveToken) → { listProposals, approve, reject }
  store.ts         — local row store (own vocabulary, own id, proposalId idempotency key)
  index.ts         — list → map → approve/reject outcome loop + entry guard
  tsconfig.json    — compile boundary (no paths into src/)
```

**API-contract endpoint-doc pattern** (lines 133-179) — same fenced-block-with-arrow convention for each new endpoint:
```
### `GET /v1/proposals`

List pending action proposals (LLM-free, lock-free read).

    → 200 { "items": [ <16-field ActionProposalRecord>, ... ] }

### `POST /v1/proposals/:id/approve` / `POST /v1/proposals/:id/reject`

    → 200 { "status": "approved" | "rejected" }
    → 400 { "error": "bad_request", "detail": "invalid proposal id" }
    → 404 { "error": "not_found", "detail": "proposal does not exist" }
    → 409 { "error": "conflict", "detail": "proposal is not pending" | "proposal superseded" | "proposal entity retired" | "proposal expired" }
    → 503 { "error": "service_unavailable", "detail": "memory busy; retry in a moment" }
```

**MANDATORY content per D-06/D-07 (not modeled by any existing prose — must be authored fresh, but placed using the analog's style):**
1. The full 16-field record, verbatim, from `src/db/action-proposal-store.ts` lines 42-59 (`id, kind, entity_node_id, entity_descriptor, belief_node_id, change_field, change_from, change_to, evidence_episode, evidence_quote, confidence, schema_version, status, created_at, updated_at, expires_at`).
2. `schema_version` gating: "consumers version-gate, never assume" — model this on the Fail-closed section's imperative style (lines 226-260).
3. Deterministic id + replay semantics: `POST .../approve` on an already-terminal proposal is a no-op (409 `conflict`/`proposal is not pending`), not a second application — cite `ProposalNotPendingError` (memory-ops.ts lines 152-157).
4. Auth: identical-401 discipline — reuse the existing "All authenticated endpoints require `Authorization: Bearer <RECENSE_SERVE_TOKEN>`" line (docs line 130) verbatim; the proposal routes land after the same auth gate (serve-cli.ts line 517-518 comment: "Both /v1/proposals routes land after the auth gate above").
5. Two mandatory carry-forwards (exact source quotes to adapt into prose):
   - From `.planning/phases/64-entity-resolution-hardening/64-CONTEXT.md` D-08: "the node id is carried for recense-internal lineage but is NOT a stable foreign key across belief-correction (tombstone-and-mint-new)."
   - From `.planning/phases/66-domain-neutral-proposal-emit-seam/66-04-SUMMARY.md` line 141: "`change_from` is recense's prior belief TEXT (often a full sentence), `change_to` is a token from the closed `IntentStatus` vocabulary. A consumer maps on `change_to`; `change_from` is approver context only" — and explicitly warn against chaining from/to across proposals to reconstruct a timeline.
6. Fail-closed posture (D-07) — model directly on the existing "Fail-closed pattern" section's imperative bullet style (lines 226-260): unknown `schema_version` → stop; unknown `kind` → skip; refusal → terminal, don't retry; never render `evidence_quote`/model prose as the decision surface (quote is data, per 66's D-12).

---

## Shared Patterns

### Zero-src-import discipline (CLIENT-01/CONSUME-02)
**Source:** `clients/telegram/memory-client.ts` (no imports at all) + `clients/telegram/tsconfig.json` (`"include": ["."]`, no `paths`) + `clients/telegram/tests/import-boundary.test.ts` (static file-scan enforcement)
**Apply to:** every file under `clients/proposal-reference/`, including its own `tests/`.
```typescript
// tests/import-boundary.test.ts guard regex — must never match anywhere in the adapter tree:
/from\s+['"][^'"]*\/src\//.test(text) || /require\s*\(\s*['"][^'"]*\/src\//.test(text)
```

### Atomic local-persistence write (0600, tmp→rename)
**Source:** `clients/telegram/proposal-store.ts` lines 87-99 (`writeDoc`)
**Apply to:** `clients/proposal-reference/store.ts` — same tmp-file-in-destination-dir (EXDEV-safe) + chmodSync belt-and-suspenders pattern.

### HTTP client factory shape (Bearer auth, fetch, timeout, non-2xx throw)
**Source:** `clients/telegram/memory-client.ts` lines 105-122 (`createMemoryClient`/`postJson`)
**Apply to:** `clients/proposal-reference/memory-client.ts` — reuse the exact `postJson`/GET pattern, `AbortSignal.timeout(10_000)`, `'serve HTTP ' + status` throw message.

### Typed refusal → HTTP status mapping (must be consumed, not re-derived)
**Source:** `src/adapter/memory-ops.ts` lines 140-170 (`ProposalNotFoundError`, `ProposalNotPendingError`, `ProposalStaleError`) and `src/adapter/serve-cli.ts` lines 568-602 (the route's catch-block mapping to 404/409/503 with fixed literal `detail` strings)
**Apply to:** the adapter's approve/reject caller in `index.ts` — branch on HTTP status code (400/404/409/503), never on the `detail` string's exact text (it's documentation, not a stable API — only the numeric status + `error` enum value are contract).

### Entry-guard for test-safe module loading
**Source:** `clients/telegram/index.ts` lines 1379-1387 (`if (require.main === module)`)
**Apply to:** `clients/proposal-reference/index.ts` — lets the repo-level e2e `require()`/`import` the adapter's functions without triggering a live run.

### Server-spin + engine-seed test harness
**Source:** `tests/proposal-routes.test.ts` lines 63-234 (`getFreePort`, `beforeEach`/`afterEach` server lifecycle, `makeLlmFreeProvider`, `seedProposal`)
**Apply to:** the new repo-level e2e test — reuse verbatim; only the assertions and the "drive it through the adapter's public entry" step are new.

## No Analog Found

None — every file in the phase's scope has a strong (exact or role-match) analog in `clients/telegram/` or `tests/proposal-routes.test.ts`. The one genuinely novel piece of logic is the adapter's list→map→approve/reject outcome loop (D-03), which has no direct precedent (telegram's approval flow is callback-button-driven, not list-driven) — flagged inline above rather than in this table since a partial analog (the try/catch-per-item discipline in `runClientTick`) does apply.

## CI / Build Wiring (must slot into the same rails)

**Root `package.json` scripts** (as of this phase, before any edit):
```json
"typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tests/tsconfig.json",
"test": "vitest run",
"build:client": "tsc -p clients/telegram/tsconfig.json"
```
`tests/tsconfig.json` (`extends: "../tsconfig.json"`, `include: ["../src", ".", "../scripts"]`) does **NOT** include `clients/`. Finding: `clients/telegram/` is currently **not** covered by `npm run typecheck` at all — `build:client` exists as a separate, CI-uninvoked script (grep confirms it is referenced only in `package.json` itself and `scripts/setup-telegram-client.sh`, never in `.github/workflows/ci.yml`). This is an existing gap in the repo, not something this phase is asked to fix — mirror the same posture for `clients/proposal-reference/` (i.e. it is fine, and consistent with precedent, if the new client also lacks a dedicated CI typecheck step; do not invent one unless the planner decides otherwise).

**`vitest.config.ts`** (root) — this IS the wiring that actually matters for CI, since `npm test` runs `vitest run` against this include list:
```typescript
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'clients/telegram/tests/**/*.test.ts'],
    pool: 'forks',
  },
});
```
**Required edit:** add `'clients/proposal-reference/tests/**/*.test.ts'` to the `include` array — this is the exact, minimal, one-line change that makes both the adapter's in-dir tests (import-boundary + any HTTP/fixture-only tests) run under `npm test`/CI. The repo-level e2e test lives under `tests/**/*.test.ts` (already covered) and needs no config change.

**`.github/workflows/ci.yml`** — no changes needed. The `test` job's `npm test` step already picks up the new include-glob once `vitest.config.ts` is updated; the `Build` step (`npm run build`) only builds `src`/`scripts` per root `tsconfig.json` and is unaffected (the client has its own separate `tsc -p .../tsconfig.json`, mirroring telegram's un-wired `build:client`).

## Metadata

**Analog search scope:** `clients/telegram/` (all files + tests/), `src/adapter/serve-cli.ts`, `src/adapter/memory-ops.ts`, `src/db/action-proposal-store.ts`, `tests/proposal-routes.test.ts`, `docs/reference-client.md`, root `package.json`/`vitest.config.ts`/`tsconfig.json`/`tests/tsconfig.json`, `.github/workflows/ci.yml`.
**Files scanned:** 15
**Pattern extraction date:** 2026-08-03
