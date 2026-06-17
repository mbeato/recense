# Requirements — v4.0 Proactive Memory

**Milestone goal:** Turn recense from a passive recall engine into a memory that *surfaces and acts* on what it learned — proactively pushing salient/due items to Telegram and, on explicit per-action approval, firing any user-configured MCP tool — while the engine stays passive, LLM-free on the hot path, and single-tenant.

**Load-bearing invariants (apply to every requirement):**
- Agents live OUTSIDE the engine; all proactive/agent logic lives in `clients/telegram/`, zero `src/` imports.
- Online/serve paths stay LLM-free; all LLM cost stays in the offline sleep pass (and the client's own offline push loop).
- Surfacing never strengthens a belief (D-43 self-confirmation guard); `surfaced_event` is operational metadata, not a graph write.
- **Nothing fires without explicit human approval.**
- Engine stays single-tenant; net-zero new runtime dependencies.

---

## v4.0 Requirements

### Temporal Ingestion (TEMP)

- [x] **TEMP-01**: A user's Google Calendar is ingested as observed episodes via a `SourceAdapter` — incremental sync (`nextSyncToken` with 410-GONE full-resync recovery), UTC-normalized times, recurring events as a single pattern belief (not N instances), cancellations tombstoned.
- [x] **TEMP-02**: The sleep pass extracts temporal/actionable facts (`due_at` + `action_type`) from email and calendar content into a sparse `node_temporal` table; `ExtractedClaim` carries optional `due_at`/`action_type` backward-compatibly (older models that omit them are unaffected).
- [x] **TEMP-03**: A Gmail episodic-variant extraction prompt captures date-anchored commitments (flights, deadlines, receipts the current prompt discards) behind a default-OFF runtime flag (`RECENSE_ENABLE_EPISODIC_EMAIL`), gated by an offline dry-run A/B against a DB snapshot with explicit pass/fail criteria before any live enable.
- [x] **TEMP-04**: Gmail and Google Calendar ingestion both support **multiple accounts for the single user** — each configured account carries its own OAuth credentials and an independent sync cursor, all feeding the one single-tenant memory. (This is multi-*account*, NOT multi-*tenant*: still one person's memory; SEED-003 namespaces stay out of scope. Extends the existing single-account Gmail adapter from Phase 6.)

### Engine Surfacing API (SURF)

- [x] **SURF-01**: `GET /v1/surface` returns due/actionable, not-yet-surfaced items via an LLM-free composite ranking (deadline-proximity + salience; PE-novelty when available), with a daily cap (P0 deadline-<24h bypass), a past-event guard, and completed/snoozed exclusion.
- [x] **SURF-02**: `POST /v1/surface/seen` idempotently records surfaced/seen/snooze outcomes to a `surfaced_event` operational table (activation_trace precedent); the sleep pass never reads or writes it.
- [x] **SURF-03**: Surfacing and seen-state writes never strengthen a belief (`node.s`/`node.c` unchanged) — proven by a D-43 self-confirmation sentinel test that is a required verification gate before any push client connects.

### Proactive Push (PUSH)

- [ ] **PUSH-01**: The Telegram reference client proactively pushes surfaced items (P0 immediate; P1 daily digest at a configurable hour) over the single `getUpdates` consumer, with a never-empty-digest guard and a quiet-hours window.
- [ ] **PUSH-02**: A user can dismiss or snooze a pushed item via inline buttons, writing state through `POST /v1/surface/seen` so it does not re-notify within the guard window — dedup survives client restarts (DB-backed, not in-memory).
- [ ] **PUSH-03**: Proactive push is behind a default-OFF off-switch (`RECENSE_PROACTIVE_ENABLED`) and runs reliably under launchd (`ThrottleInterval` crash-loop guard).

### Approval-Gated Action (ACT)

- [ ] **ACT-01**: The client proposes an action and the user approves / edits / rejects / snoozes via a Telegram inline keyboard; nothing executes without explicit approval, and the approval message is rendered from the serialized `{tool, args}` payload (never LLM prose).
- [ ] **ACT-02**: On approval the client executes against any user-configured MCP server (stdio or HTTP), discovered via `listTools` and parameterized from memory context (`/v1/search`); servers are gated by a per-server allowlist.
- [ ] **ACT-03**: Action execution is injection-hardened (delimiter-fenced memory data; per-server allowlist as the primary control) and destructive/irreversible tools require a typed secondary confirmation; reversible/irreversible labels + a daily proposal cap guard against approval fatigue; every decision is logged as a `source:'hitl'` episode.

---

## Future Requirements (deferred to v4.x / v5)

- PE-novelty as an explicit surfacing signal (needs `last_pe_magnitude` persisted on `node` rows; ships as the 3rd ranking signal once a baseline exists).
- Schema-activation surfacing trigger ("I noticed a pattern") — reuses SREL-01/02 machinery; needs v4.0 graph data to tune.
- HITL feedback → salience adjustment loop (needs approval/reject volume before it's trustworthy).
- MCP Elicitation mid-execution approval (spec is draft; limited SDK adoption) — revisit v4.1.
- Additional delivery channels (Slack, email digest).
- Per-schema surfacing-frequency learning (requires months of usage data).

## Out of Scope

- **Content-hardening item #1 (transcript per-speaker attribution)** — orthogonal to proactivity; stays parked in `.planning/todos/`.
- **Content-hardening item #2 (Obsidian PDF/binary extraction)** — orthogonal; stays parked.
- **Auto-approve / fire-without-approval** — anti-feature; the approval gate is the load-bearing safety control, never optional.
- **LLM in the surfacing/serve path** — violates LLM-free hot path and degrades the differentiator; scoring is pre-computed offline.
- **iMessage ingestion** — structural self-echo loop, rejected in Phase 7.
- **Multi-tenant namespaces (SEED-003)** — engine stays single-tenant; dormant seed, not scope.

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| TEMP-01 | Phase 20 | Complete |
| TEMP-02 | Phase 20 | Complete |
| TEMP-03 | Phase 20 | Complete |
| TEMP-04 | Phase 20 | Complete |
| SURF-01 | Phase 21 | Complete |
| SURF-02 | Phase 21 | Complete |
| SURF-03 | Phase 21 | Complete |
| PUSH-01 | Phase 22 | Pending |
| PUSH-02 | Phase 22 | Pending |
| PUSH-03 | Phase 22 | Pending |
| ACT-01 | Phase 23 | Pending |
| ACT-02 | Phase 23 | Pending |
| ACT-03 | Phase 23 | Pending |
