# Stack Research

**Domain:** recense v10.0 "Action Proposals" — additions to a mature TypeScript engine (~2700 tests, 9 shipped milestones)
**Researched:** 2026-07-29
**Confidence:** HIGH across all four questions — every claim below is backed by either the live shipped source (read directly) or current external docs (fetched/searched this session, not recalled from training data)

## Headline Answer

**Net-zero holds. Zero new runtime dependencies are needed for v10.0.** Every one of the four capabilities is either (a) pure config/prompt/schema work on seams that already exist and already do this exact kind of job, or (b) a small additive SQLite table following a pattern (`surfaced_event`) the codebase has already shipped twice. The only genuinely new *code* is: a config-shape change, one new CLI command (OAuth loopback helper), a handful of new prompts/feature-tags on the existing headless transport, and one new table + two new HTTP routes. No new package, no new native dependency, no new build tooling.

The one real technical finding worth flagging to the roadmapper: **Gmail's `history.list` API has no `q` (search-query) parameter** — only `labelId`. This means per-account query scoping, as currently architected, is fully enforced only on the *initial backfill*; every *incremental* pull after that fetches all new mail (any label) regardless of the account's configured query string. This is a real constraint on Question 1, not a hypothetical — see below.

---

## Recommended Stack (deltas only — nothing new)

### Core Technologies (unchanged)

| Technology | Version (confirmed live) | Purpose | Why nothing changes |
|------------|---------|---------|-----------------|
| `googleapis` | `^173.0.0` (verified current on npm, last published ~2 months ago) | Gmail/Calendar REST client, OAuth2 client | Already the dependency for Q1 and Q2 both. `google.auth.OAuth2` (used today in `gmail-adapter.ts`) already exposes `.generateAuthUrl()` and `.getToken(code)` — the two calls Q2's onboarding flow needs. No new package. |
| `better-sqlite3` | `^12.10.0` | Proposal storage (Q4) | The versioned-migration DDL pattern (`CREATE TABLE IF NOT EXISTS` + `SCHEMA_VERSION` bump) already handles additive tables cheaply — proven twice (`token_usage_ledger` v14, `surfaced_event`). |
| `claude -p` headless transport (`src/model/claude-headless-client.ts`) | n/a (subscription CLI, not an npm dep) | Intent classification + entity resolution (Q3) | Transport is prompt-agnostic — it's a generic `AnthropicLike` seam distinguished only by a `feature_tag` string (`'extract'`, `'judge'`, `'corpus_gen'`, `'schema_abstract'`, ...). Adding `'intent_classify'` / `'entity_resolve'` tags is the entire integration surface. |
| `zod` | `^3.25.76` | Validating the new proposal-emit JSON shape at the HTTP boundary | Already a dependency (used today in `src/adapter/memory-ops.ts` for request-body validation). Reuse for `{entity, proposed_change, evidence_episode, confidence}` request/response validation on the new routes — no new schema-validation library needed. |
| `node:http` (builtin) | n/a | Loopback-redirect OAuth catcher (Q2) | Already the pattern for `recense serve` and the viz server. Spinning up a one-shot local listener on an OS-assigned port to catch the OAuth redirect is ~30 lines with the builtin module — no `express`/`koa`/`http-server` needed. |

### Supporting Libraries — none required

No new supporting library is needed for any of the four questions. Every capability maps onto an existing, already-installed dependency or Node builtin.

---

## Question 1 — Per-account Gmail query scoping

### Config-shape migration (cleanest option)

Add an **optional** `query` field to each `googleAccounts` entry, and keep `EngineConfig.gmail.query` as the fallback default:

```typescript
// src/lib/config.ts
googleAccounts: Array<{ id: string; query?: string }>;
```

Why this shape and not others:
- **Fully backward-compatible.** `DEFAULT_CONFIG.googleAccounts = [{ id: 'default' }]` compiles and behaves identically with no code change — `query` is optional, so existing single-account installs (and every existing test fixture) are untouched.
- **`gmail.query` keeps a real job** instead of becoming dead config: it's the fallback for any account that doesn't set its own `query`, which matches how `sourceWeights`/`consolSkipThresholdBySource` in the same file already do "global default + per-key override" (see `SalienceConfig`).
- **No CHECK-constraint or table-rebuild cost** — this is a pure TypeScript interface change plus a resolution helper, not a schema migration; `googleAccounts` isn't even persisted in SQLite, it's process config read from `sleep.env`/config file at startup.
- **Rejected alternative — a separate `gmailAccountQueries: Record<string,string>` map keyed by account id.** Technically works but duplicates the account identity (id already lives in `googleAccounts`) and risks the two collections drifting (an id present in one map but not the other). Co-locating `query` on the account object it belongs to removes that whole failure class.

Integration point: `GmailAdapter.pull()` (`src/source/gmail-adapter.ts:339`) currently reads `this.config.gmail.query` directly. The resolved per-account query (`account.query ?? config.gmail.query`) needs to reach the adapter — either resolve it in `buildAdapters` (`src/adapter/ingest-cli.ts:113`) and pass it into the constructor, or pass the whole `account` object instead of the bare `accountId` string and let the adapter resolve internally. Either is a small, mechanical change; no new dependency either way.

### googleapis-specific concern — verified, and it's real

Confirmed against the current Gmail API reference (`developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list`, fetched this session):

**`users.history.list` accepts `startHistoryId`, `historyTypes`, `labelId`, `maxResults`, `pageToken` — there is no `q` parameter.** Full Gmail search-query syntax (`-category:promotions`, `newer_than:90d`, etc.) is only supported by `users.messages.list`, which the adapter uses solely for the *initial backfill* (`startHistoryId === null` branch in `gmail-adapter.ts`).

This means, as the code is written today (and will remain unless changed): **the configured `query` only filters the first pull.** Every subsequent incremental pull via `history.list` returns *all* newly-added messages regardless of query — the existing in-code comment ("historyId cursor is query-independent") is the softer, cursor-focused framing of this same underlying API limitation; the sharper framing is that **query enforcement itself is backfill-only**, not just cursor-reset behavior.

For per-account scoping specifically, this matters more than it did for the single global query: a "work" account with a narrow query (say, `label:jobfill`) and a "personal" account with a broad one will both, after their first backfill, ingest *all* new mail via `history.list` — the per-account narrowing silently stops being enforced past day one.

Two honest mitigation paths (no new dependency either way — flag for roadmap/plan, not a stack change):
1. **Accept it, document it, lean on existing downstream gating.** `gmail` already carries the lowest `sourceWeights` multiplier (0.35) and a raised `consolSkipThresholdBySource` (0.4) — the noise from unfiltered incremental mail is already dampened before it reaches the judge. This is the zero-new-code option and is consistent with how the codebase already treats Gmail as the noisiest channel.
2. **If precise per-account narrowing is a hard requirement**, restrict *account-level* queries to Gmail-label syntax only (e.g. `label:jobfill-work`) and pass the matching `labelId` into `history.list` (`labelId` **is** supported there) — this requires one extra one-time `users.labels.list` call to resolve a label *name* to its *id*, still via the already-installed `googleapis` client. This is real code (a label-resolution helper + a query-syntax constraint), not a new dependency, but it is more work than option 1 and constrains what a "query" is allowed to look like per account.

Recommend surfacing this to the roadmapper as a discuss-phase decision, not a stack blocker — no library changes hands either way.

---

## Question 2 — OAuth onboarding for account N

### Current status of installed/desktop OAuth flows (verified this session)

- **OOB (`urn:ietf:wg:oauth:2.0:oob`) is fully dead**, not just discouraged: Google blocked it for new usage in Feb 2022 and removed it entirely for all client types by ~Oct 2022 / Jan 2023. As of today it is non-functional — confirmed via Google's own OOB Migration Guide and multiple corroborating sources.
- **Loopback IP redirect (`http://127.0.0.1:PORT` or `http://localhost:PORT`) is the current, Google-recommended replacement for "Desktop app" OAuth clients** (confirmed via `developers.google.com/identity/protocols/oauth2/native-app`, fetched this session). Critically: **the exact port does not need to be pre-registered** — Google's own guidance is to "start an HTTP listener on a random available port" and use that port in the redirect URI at runtime. Only the *host* (`127.0.0.1`/`localhost`/`::1`) is validated, not the specific port.
- **Device flow (TV/limited-input) is a different OAuth *client type*** in Google Cloud Console — recense's existing shared `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` is registered as a **Desktop app** client. Switching to device flow would mean provisioning a second, differently-typed OAuth client and running two onboarding code paths for no benefit — loopback redirect is strictly the better fit given what already exists.

### Minimal, zero-dependency onboarding flow

Everything needed is already installed:

1. **Generate the auth URL** — `new google.auth.OAuth2(clientId, clientSecret, redirectUri)` then `.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: [...] })`. Same `google.auth.OAuth2` class already imported in `gmail-adapter.ts:154` — just needs a `redirectUri` argument, which the shipped code doesn't currently pass (it doesn't need one for the refresh-token-only flow it already has).
2. **Catch the redirect** — a one-shot `node:http` server (`http.createServer(...)`, `.listen(0, '127.0.0.1')` to get an OS-assigned port, read the actual port off `server.address()`, build the redirect URI, then close the server the moment the callback with `?code=...` arrives). Same builtin module already used by `recense serve` and the viz server; no framework.
3. **Print the URL** (or optionally shell out via `child_process.exec` + platform-detected `open`/`xdg-open`/`start`, the same zero-dep pattern the v2.0 stack research already established for browser-opening and explicitly chose over the ESM-only `open` npm package).
4. **Exchange the code** — `oauth2Client.getToken(code)` → `{ tokens: { refresh_token, ... } }`. Same class, same method family already in use.
5. **Persist the token** — call the **already-exported** `writeEnvFile(envPath, vars, removeKeys)` helper (`src/adapter/recense-init.ts:115`): atomic tmp-file-in-destination-dir → `chmod 600` → `rename`, preserves unrelated existing keys, updates known keys in place. This is the exact same helper `recense init` already uses to write `sleep.env`. Call it with `{ [\`GOOGLE_${accountId.toUpperCase()}_REFRESH_TOKEN\`]: refreshToken }` — **zero new file-I/O code**, reuse verbatim.

Net new code for Q2: one new CLI subcommand (`recense auth-google <accountId>` or similar) wiring together four things that already exist (`google.auth.OAuth2`, `node:http`, `child_process.exec`-open, `writeEnvFile`). No new dependency at any step.

---

## Question 3 — Offline intent classification + entity resolution

**Confirmed: nothing new needed at the transport/infra level. This is purely prompt + schema work on an existing seam.**

`src/model/claude-headless-client.ts` is architected as a generic prompt-in/text-out transport behind the `AnthropicLike` interface, already carrying four distinct feature purposes (`extract`, `judge`, `corpus_gen`, `schema_abstract`) distinguished only by an ambient `setHeadlessFeature(tag)` string used for cost-ledger attribution (`token_usage_ledger`, feature-tagged rows). Adding intent classification and entity resolution means:

- New prompt templates (à la the existing extractor/judge prompts) — no new file/module category, same pattern as `src/model/claim-extractor.ts`.
- New `feature_tag` values (e.g. `'intent_classify'`, `'entity_resolve'`) for cost-ledger visibility — a one-line addition to `deriveFeatureTag()`'s conventions, or explicit `setHeadlessFeature()` calls bracketing the new sleep-pass phase, exactly like `corpus_gen`/`schema_abstract` are bracketed today.
- Response parsing — `zod` (already a dependency) or the same manual JSON-parse-with-fallback style already used for `parseVerdict`/`parseClaims` (both fail safe to `[]`/`'unrelated'` on parse failure — the same fail-safe posture should extend to intent/entity output: an unparseable classification should fail to "no proposal" rather than throw, exactly like judge failures fail to "unrelated" today).
- Runs where the judge already runs — inside the existing sleep pass, under the existing `db.transaction` / single-graph-writer discipline (`run-sleep-pass.ts`), so it inherits the online-path-stays-LLM-free invariant automatically: nothing here touches `/v1/search`, `/v1/surface`, or any hook.

**Entity resolution against a "canonical entity list"** specifically: the existing `node` table (`type='entity'`, already the graph's live entity set) is the obvious first candidate for "what entities exist" — no new storage is implied by resolution *matching against the graph recense already has*. Whether the canonical list needs to be an *external* whitelist (e.g., jobfill's own company/role list) is a data-ownership question explicitly flagged as open for discuss-phase in `PROJECT.md`, not a stack question — no library choice is gated on it either way (a graph query and a flat external list are both zero-new-dependency reads).

---

## Question 4 — Action-proposal contract storage/emit

### Evaluated: reuse `node`/`episode` with a type tag — NOT recommended

- **`node`** has a `CHECK(type IN ('entity','fact','schema','doc','insight'))` constraint. SQLite can't `ALTER` a `CHECK` constraint in place — every prior widening of this exact constraint (v11, v13 in `schema.ts`) required the full "create `node_v11`, copy rows, drop, rename" table-rebuild migration. That's real migration cost for a "no new storage" option that turns out not to be free.
- Worse than the migration cost: `node` is the belief graph and **source of truth** feeding embeddings, decay, eviction, and — critically — the v9.0 union candidate generation (entity-keyed + BM25 `node_fts` + dense top-k) that feeds the reconsolidation judge. A transient, externally-consumed, eventually-deleted "proposal" row sitting in the same table risks getting embedded, decayed, evicted, or picked up as a contradiction candidate by machinery that was built and tuned assuming every `node` row is a belief. This is exactly the shape of self-confirmation/pollution bug class this codebase has spent multiple phases (D-43, C-2 in v9.0 HARD-01..04) closing. Reusing `node` reopens that class for no benefit.
- **`episode`** is the write-*ahead* log consumed *by* consolidation (`idx_episode_unconsolidated`, `consolidated` flag). Proposals are consolidation *output*, not input — writing them there risks the sleep pass trying to re-consolidate its own output, or corrupting `consolidated`-flag semantics that downstream code already depends on.

**Verdict: reuse is a false economy here — it looks free but costs a table-rebuild migration and a new correctness-invariant surface. Not recommended.**

### Evaluated: new SQLite table — recommended, and it's the cheap option

The codebase has an exact precedent to copy: **`surfaced_event`** (Phase 21, `schema.ts`) — an append-only, single-writer table with an `outcome` lifecycle (`CHECK(outcome IN ('surfaced','seen','snoozed','completed','dismissed'))`), an idempotency key (`UNIQUE(node_id, occurrence_due_at)`), and a dedicated `SurfaceStore` class doing LLM-free reads — exposed today via `GET /v1/surface` + `POST /v1/surface/seen` on `recense serve` (`src/adapter/serve-cli.ts:401-507`).

A `proposal` table modeled the same way — `id`, `entity_node_id`, `proposed_change`, `evidence_episode_id`, `confidence`, `status` (`CHECK(status IN ('pending','approved','rejected','expired'))`), `created_at`, `resolved_at` — costs, in schema-migration terms:
- **A wholly new table via `CREATE TABLE IF NOT EXISTS`** — the same additive pattern as `token_usage_ledger` (v14) and `surfaced_event` itself. No `ALTER TABLE`, no data rewrite, no table-rebuild dance.
- **One `SCHEMA_VERSION` bump** (currently 15 → 16) — a single-line change plus the guarded upgrade-stamp logic that's already generic (`schema.ts:626-642`).
- **Two new HTTP routes** on the existing `recense serve` surface (`GET /v1/proposals`, `POST /v1/proposals/:id/{approve,reject}` or similar) — following the exact `/v1/surface` + `/v1/surface/seen` shape, reusing the shared memory-ops core and the existing per-call-lock discipline (`T-12-02`) already used by every write route.

This is the *cheapest* of the realistic options, not just the cleanest: it's strictly additive DDL (zero rewrite cost) versus the `node`/`episode` reuse option's forced table-rebuild.

### Evaluated: file-based store (mirroring the Telegram client's JSON store) — not recommended for the engine side

`clients/telegram/proposal-store.ts` is a genuinely good pattern (atomic tmp→rename, `chmod 600`, deep-copy-on-read/write, expiry-on-read cleanup) — but it's the right pattern for a *different* problem: transient, client-local approval state for one specific consumer that talks to the engine only over HTTP/MCP (`CLIENT-01`'s compile-time import boundary). Copying that pattern to the *engine's* proposal-emit seam would mean:

- A second persistence mechanism alongside SQLite, needing its own atomicity/locking story, when SQLite (WAL mode, already the engine's single-writer discipline via `acquireLock`) already solves exactly this for free.
- A consumer contract of "read this JSON file path" instead of "call this HTTP endpoint" — which breaks the stated shape of the milestone (`docs/reference-client.md`-isomorphic adapter, proven over the public HTTP surface, mirroring how the Telegram client itself only ever talks to `recense serve`). A file store would either require the reference adapter to reach into engine-internal filesystem state (violating the same client/engine boundary the codebase enforced by moving Telegram *out* of the engine in Phase 13), or `serve.ts` would need a second, unversioned, non-DB read path bolted on next to its DB-backed routes — architecturally messier than one small additive table.

**Verdict: new SQLite table, read over the existing `recense serve` HTTP surface. This is also the "closest to zero new work" answer relative to the alternatives, once the `node`/`episode`-reuse trap is ruled out.**

---

## What NOT to Add

| Avoid | Why | Use Instead |
|-------|-----|--------------|
| `open` (npm) or any browser-launcher package | ESM-only; project compiles to CJS (established in v2.0 stack research and still true) | `child_process.exec` + platform detection (`darwin`/`linux`/`win32`), already the established pattern |
| `express`/`fastify`/any HTTP framework for the OAuth loopback catcher | A one-shot single-route listener doesn't need a framework | `node:http` builtin, ~30 lines, matches `recense serve`/viz-server precedent |
| A device-code OAuth client registration | Requires a second, differently-typed OAuth client in Google Cloud Console for no benefit over loopback redirect, which the existing Desktop-type client already supports | Loopback redirect flow on the existing shared OAuth client |
| Reusing `node`/`episode` tables with a type tag for proposals | `node`'s `CHECK(type IN (...))` requires a full table-rebuild migration (as v11/v13 needed) to widen, AND risks proposal rows polluting embedding/decay/candidate-generation machinery tuned for belief rows only | A new, small, additive `proposal` table modeled on `surfaced_event` |
| A file-based JSON store for the engine-side proposal queue (copying `clients/telegram/proposal-store.ts`) | Duplicates SQLite's already-solved atomicity/locking for no benefit, and creates a second non-HTTP consumer contract that fights the milestone's stated "reference adapter over the public HTTP surface" shape | A new SQLite table exposed via `recense serve` HTTP routes |
| Any new LLM/embedding client library for intent classification or entity resolution | The existing headless `claude -p` transport (`AnthropicLike` seam) already handles arbitrary prompt/schema work; it's purpose-agnostic by design | New prompts + new `feature_tag` values on `claude-headless-client.ts` |
| A new schema-validation library (`ajv`, `joi`, etc.) for the proposal contract | `zod` is already a dependency, already used at an HTTP boundary in this codebase (`memory-ops.ts`) | `zod` |
| Changing `enabledSources`/adapter architecture for multi-account query scoping | The per-account fan-out, cursors, and provenance headers are already shipped (TEMP-04) and working; only the query field needs to move from global to per-account-with-fallback | Extend `googleAccounts` entries with an optional `query` field |

---

## Version Compatibility

| Package | Version (verified) | Notes |
|---------|---------------------|-------|
| `googleapis` | `^173.0.0` | Confirmed current on npm (last published ~2 months before this research date). Bundles `google-auth-library`'s `OAuth2Client` (`google.auth.OAuth2`), which already exposes everything Q2 needs — no separate `google-auth-library` install required. |
| Gmail API | `v1` (`gmail_v1` types already imported in `gmail-adapter.ts`) | `users.history.list` reference confirmed current at `developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list` — no `q` param, `labelId` param present. |
| Google OAuth (installed/desktop) | n/a (protocol, not a package version) | OOB flow non-functional since ~2022/2023; loopback IP redirect is the current recommended flow for Desktop app OAuth clients per `developers.google.com/identity/protocols/oauth2/native-app`, fetched this session. No pre-registration of the exact loopback port required. |
| `better-sqlite3` | `^12.10.0` | `SCHEMA_VERSION` currently 15; a Q4 proposal table would bump to 16 via the existing additive-migration convention — no version conflict. |
| `zod` | `^3.25.76` | Already installed; sufficient for validating the new proposal JSON contract, no upgrade needed. |

---

## Sources

- [Gmail API — Method: users.history.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list) — verified `labelId`/`historyTypes`/no-`q` params, fetched this session
- [Google — OAuth 2.0 for Mobile & Desktop Apps (native-app)](https://developers.google.com/identity/protocols/oauth2/native-app) — verified loopback redirect is current recommendation, random port not pre-registered, fetched this session
- [Google — Out-Of-Band (OOB) flow Migration Guide](https://developers.google.com/identity/protocols/oauth2/resources/oob-migration) — verified OOB deprecation timeline
- [npm — googleapis](https://www.npmjs.com/package/googleapis) — verified current version `173.0.0`
- Live source read directly (not recalled): `src/lib/config.ts`, `src/source/gmail-adapter.ts`, `src/adapter/ingest-cli.ts`, `src/adapter/recense-init.ts` (`writeEnvFile`), `src/db/schema.ts` (SCHEMA_VERSION, `surfaced_event`, `node`/`episode` CHECK constraints, v11/v13 rebuild precedent), `src/db/surface-store.ts`, `src/adapter/serve-cli.ts` (`/v1/surface` routes), `src/model/claude-headless-client.ts`, `clients/telegram/proposal-store.ts`, `package.json`
- `.planning/research/v2.0-STACK.md` — prior stack research, confirms the `open`-npm-is-ESM-only / CJS-project constraint still governs browser-launch choices

---
*Stack research for: recense v10.0 Action Proposals.*
*Researched: 2026-07-29.*
