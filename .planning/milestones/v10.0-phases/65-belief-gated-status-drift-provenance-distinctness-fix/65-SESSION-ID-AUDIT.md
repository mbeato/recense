# Session-ID / SessionId Consumer Audit (D-02 Research Gate)

**Purpose:** Discharge the D-02 research gate before any placement code is written. Every
`session_id` / `sessionId` consumer under `src/` is enumerated below with an explicit verdict on
whether per-thread granularity (DRIFT-03) breaks its semantics. This document is the LOCKED
decision Plan 65-07 consumes.

**Live grep reconciliation:** `grep -rn "session_id\|sessionId" src --include="*.ts"` returns 48
hits across 17 files — reconciled against the `<interfaces>` list in the plan and found to match
exactly. No extra files, no missing files.

## 1. Scope statement

Today every Gmail episode carries the literal `session_id = 'ingest:gmail'` (`ingest-cli.ts:188`,
`sessionId: \`ingest:${r.source}\`` where `r.source === 'gmail'` for every Gmail message). Under
the D-02 PRIMARY shape, a Gmail episode would instead carry
`ingest:gmail:<normalized-sender-domain>:<gmail-thread-id>`, so the column's cardinality for
`source='gmail'` goes from exactly 1 (today) to roughly one distinct value per
(sender-domain, thread) pair going forward. Non-gmail sources — `claude-code`, `granola`,
`memory-import`, `project-survey`, `project-doc` — are unaffected in every shape considered here;
their mint sites are untouched by this redesign.

## 2. Per-consumer table

| File | Use of session_id | Semantics assumed | Breaks under per-thread granularity? | Evidence (line refs) |
|---|---|---|---|---|
| `src/adapter/ingest-cli.ts` | mint | Constructs `sessionId: \`ingest:${r.source}\`` inside `appendBatch`'s `db.transaction` loop | no | `:188`. This is the D-02 PRIMARY edit site itself — the mint changes its own output shape; nothing downstream of it inspects the string's content, so widening what it produces is self-consistent by construction. |
| `src/adapter/import-memory-cli.ts` | mint | Constructs `` sessionId: `${IMPORT_SOURCE}:${item.project}` `` | no | `:221`. Non-gmail source (`memory-import`); untouched by the redesign; template-literal construction only, no inspection anywhere downstream. |
| `src/adapter/ingest-project-cli.ts` | mint | Constructs `` sessionId: `project-survey:${scope}:${area}` `` (:349) and `` sessionId: `project-doc:${scope}:${relPath}` `` (:553; doc comment at :501) | no | `:349, :501, :553`. Non-gmail sources (`project-survey`, `project-doc`); untouched by the redesign; construction only. |
| `src/adapter/memory-ops.ts` | mint (MCP `add()` path) + unrelated (MCP `ask()` path) | `:168` declares `sessionId: string` on the `MemoryOps` interface as "one UUID per engine instance" (RESEARCH Session-ID recommendation A3); `:304` mints it via `randomUUID()`; `:398` passes it to `pipeline.recordEvent({ ..., sessionId })` for the `add()` episodic write (origin allowlist-validated, NOT always `'inferred'` — D-05); `:426` passes the SAME per-instance UUID to `responder.respond(bounded, sessionId)` for the `ask()` path, which always appends `origin:'inferred'` episodes (D-43); `:494` exposes `sessionId` on the returned `MemoryOps` object | no | `:168, :304, :398, :420-430, :494`. This is a wholly separate identifier space — one constant UUID per long-lived engine-instance lifetime, not a per-message/per-thread key. The `add()` sub-use technically constructs an `episode.session_id` value (so a non-inferred MCP-added episode COULD later flow into `countDistinctProvenance` if it contradicts a graph node), but it is completely orthogonal to the gmail-thread key: the D-02 redesign only changes what `ingest-cli.ts:188` produces for `source==='gmail'`; it does not touch `memory-ops.ts`'s UUID generation or the `add()`/`ask()` code paths in any way. Zero coupling, zero behavior change under either D-02 shape. |
| `src/adapter/serve-cli.ts` | unrelated | `sessionIdGenerator: undefined` (stateless MCP-over-HTTP transport option, official `@modelcontextprotocol/sdk` config) | no | `:22, :531, :537`. This is the MCP transport's own session-lifecycle concept (`Mcp-Session-Id` HTTP header machinery) — never reads or writes `episode.session_id`. Different library-level concept entirely; the redesign cannot reach it. |
| `src/adapter/stop-cli.ts` | mint | `:78-79` type-guards `input['session_id']` (a string field from the Claude Code hook JSON payload) with `typeof input['session_id'] === 'string' ? input['session_id'] : 'unknown'`, then passes it as `sessionId` to `recordEvent` (:98) | no | `:19, :78-79, :98`. The `===` here compares `typeof(...)` (a type-guard), not the session id's own content — this is construction/fallback-selection, not inspection. Non-gmail source (`claude-code` conversation-capture); untouched by the redesign. |
| `src/adapter/turn-capture-cli.ts` | mint | Same pattern as `stop-cli.ts`: `:67` type-guards `input['session_id']`, falls back to `'unknown'`, passes to `recordEvent` (:85) | no | `:27, :67, :85`. Same type-guard-not-content-inspection reasoning as `stop-cli.ts`. Non-gmail source; untouched. |
| `src/recall/index.ts` | unrelated | `:139` accepts `sessionId: string` as a `recall()` parameter; `:244, :404, :573` write it onto `episodes.append({ origin: 'inferred', ... session_id: sessionId, ... })` in three separate inference branches (typed-frontier, insight-prior, schema-prior neighborhood) | no | `:139, :235-250, :390-410, :560-578`. Every write here is `origin: 'inferred'` — structurally excluded from `countDistinctProvenance` by the D-19 `entry.origin !== 'inferred'` filter, which is enforced upstream at the two `recordContradiction` call sites in `consolidator.ts` (inferred-origin claims never even reach `recordContradiction`). The `sessionId` value itself is caller-supplied (typically the `memory-ops.ts` per-engine UUID or the responder's own session concept), never an ingest-minted gmail key. Different concept: "which conversation asked this" vs "which gmail thread asserted this fact." |
| `src/responder/index.ts` | unrelated | `:144` accepts `sessionId: string` as a `respond()` parameter; `:231` writes it onto `episodes.append({ origin: 'inferred', ... })`; `:241` forwards it to `recall.recall(boundedQuery, sessionId)` | no | `:144, :225-234, :241`. Identical reasoning to `recall/index.ts` — always `origin: 'inferred'`, D-19-excluded, orthogonal identifier space. |
| `src/eval/snapshot.ts` | unrelated | `:45` declares optional `sessionId?: string` on `RecordSnapshotParams`; `:99` writes it into `eval_snapshot.created_session` — a completely different table, not `episode.session_id` | no | `:37-46, :67-72, :85-102`. This writes to the `eval_snapshot` table's `created_session` column, not the episode table at all. No structural relationship to `countDistinctProvenance` or `PendingContradiction`. |
| `src/ingest/pipeline.ts` | passthrough | `RecordEventParams.sessionId` (:31) is passed straight through to `store.append({ session_id: e.sessionId, ... })` (:88) with zero inspection | no | `:26-98`. `recordEvent()` reads `e.sessionId` exactly once and forwards it verbatim — no `.split`, `.startsWith`, comparison, or any other content-dependent branch. Pure carrier regardless of what shape the caller mints. |
| `src/db/episode-store.ts` | passthrough | `AppendEventParams.session_id` (:32) is bound directly into the `stmtInsert` prepared statement (`:118-128`, `@session_id` parameter) and returned unchanged on the resulting `EpisodeRow` (`:210-222`); the dedup-hit branch (`:224-228`) returns the pre-existing row via `(source, external_id)`, never via `session_id` | no | `:24-70, :108-135, :198-228`. Column read/write only; no parsing, no prefix matching, no equality comparison against a literal. The `(source, external_id)` unique index (D-59) is the dedup key — `session_id` plays no role in it. |
| `src/db/schema.ts` | passthrough (DDL) | `episode.session_id TEXT NOT NULL` column declaration | no | `:34`. A plain `TEXT NOT NULL` column with **no index** — confirmed by grep: none of the 18 `CREATE INDEX` statements in this file (`:76, :87, :250, :267, :305, :307, :309, :311, :369, :379, :390, :392, :403, :451, :486, :529, :570, :610, :621, :631`) reference `session`. Higher cardinality under per-thread granularity therefore adds zero index-maintenance cost. |
| `src/lib/types.ts` | passthrough (interface declaration) | `PendingContradiction.session_id: string` (:14-18) and `EpisodeRow.session_id: string` (:106, doc comment :105 "Session identifier for debugging and Phase 3 adapter (D-10)") | no | `:1-30, :95-115`. Pure type declarations — no runtime logic, no comparisons. |
| `src/db/semantic-store.ts` | passthrough | `SemanticStore.recordContradiction(nodeId, entry)` (:439-452) pushes the caller-supplied `PendingContradiction` entry (which carries `session_id`) onto the JSON array and writes it back via `stmtUpdateContradictions`; doc comment at `:435-436` names the field but the method never inspects its content | no | `:17, :56, :420-452`. `pending_contradictions` is documented as "small, ≤N=3 entries before destabilization" (`:17`) but is an unbounded-in-schema JSON `TEXT` array with no application-level cap beyond `contradictionN`-triggered force-destabilization tombstoning the node (see §3(b)). `recordContradiction` itself performs `JSON.parse` → `push` → `JSON.stringify` only; it never reads `entry.session_id`'s content. |
| `src/consolidation/update-decision.ts` | value-semantic | `countDistinctProvenance(entries)` (:90-98): `new Set<string>()`, `if (entry.origin !== 'inferred') sessions.add(entry.session_id)`, returns `sessions.size` | no (this IS the mechanism the redesign targets, and it is designed to change behavior — that is the point of DRIFT-03, not a break) | `:79-98`. The ONLY consumer whose behavior (the *count*) depends on the session_id VALUE's identity/cardinality. Widening cardinality for `source='gmail'` is the intended effect: it makes `distinctCount` reachable above 1 on genuinely independent gmail evidence, which is exactly what DRIFT-03 exists to fix. The function's logic itself (Set membership, D-19 `origin !== 'inferred'` exclusion) is untouched under either D-02 shape. |
| `src/consolidation/consolidator.ts` | passthrough | `episodeSessionId: episode.session_id` read at three `ClaimDecision`-construction sites (`:815, :912, :1001`); written into `PendingContradiction` at the two `recordContradiction` call sites (`session_id: decision.episodeSessionId` — `:1439` inside the primary hold branch `:1427-1517`, `:1590` inside the secondary hold branch `:1582-1624`) | no | `:815, :912, :1001, :1427-1517, :1582-1624`. Every use is a straight field copy (episode row → `ClaimDecision` → `PendingContradiction`); no `.split`, `.startsWith`, `.includes`, or literal-equality check against `session_id`/`episodeSessionId` content anywhere in the file. `countDistinctProvenance(entries)` (the value-semantic consumer) is called at `:1448` and `:1597` on the freshly-read `entries` array — consolidator only forwards to it, never re-implements its logic. |

**Row count check:** 17 rows above, one per file returned by
`grep -rln "session_id\|sessionId" src --include="*.ts"` (17 files). Every "Breaks under
per-thread granularity?" cell is `no` (never blank, never "maybe"). Exactly one row —
`src/consolidation/update-decision.ts` — is classified `value-semantic`.

## 3. Cardinality / cost check

**(a) No index on `episode.session_id`.** `src/db/schema.ts` declares `session_id TEXT NOT NULL`
(`:34`) with no companion `CREATE INDEX`. Grep across all 18 `CREATE INDEX` statements in the file
confirms none reference `session` in any index name or column list
(`idx_episode_unconsolidated`, `idx_node_dirty`, `idx_episode_source_consolidated`,
`idx_episode_cwd`, `idx_consolidation_event_node`, `idx_consolidation_event_episode`,
`idx_episode_origin_ts`, `idx_edge_dst`, `idx_node_temporal_due_at`, `idx_surfaced_event_node_occ`,
`idx_surfaced_event_outcome`, `idx_node_scope_scope`, `idx_node_doc_slug`,
`idx_node_insight_anchor`, `idx_token_usage_ledger_ts`). Higher cardinality on `session_id` for
`source='gmail'` under D-02 PRIMARY therefore adds no index-maintenance cost — there is no index to
maintain.

**(b) `node.pending_contradictions` is an unbounded JSON array with no hard cap.**
`SemanticStore.recordContradiction()` (`semantic-store.ts:439-452`) unconditionally appends every
new entry to the array and writes it back; there is no truncation or eviction of old entries inside
that method. Higher session-key cardinality means the `Set<string>` built by
`countDistinctProvenance` (`update-decision.ts:90-98`) can grow toward a larger distinct count — this
is the INTENDED effect of the redesign, not a cost. In practice the array's size is bounded only by
`contradictionN`-triggered force-destabilization (`consolidator.ts:1452, 1599`), which tombstones the
node once `distinctCount >= this.config.contradictionN` — at that point the old node's
`pending_contradictions` stops accumulating because the node itself is superseded/tombstoned.

## VERDICT

**Shape selected:** PRIMARY (richer sessionId minted at ingest)

**Decision rule applied verbatim (CONTEXT D-02):** select PRIMARY only if ZERO consumers
classified `value-semantic` other than `countDistinctProvenance` AND zero consumers classified
`passthrough` are shown to parse, prefix-match, split, or equality-compare an ingest-minted session
id. Otherwise select FALLBACK. No third shape may be invented.

The table above shows exactly one `value-semantic` row (`src/consolidation/update-decision.ts`,
`countDistinctProvenance`) and zero `passthrough` rows that parse, prefix-match, split, or
equality-compare session-id content — `pipeline.ts`, `episode-store.ts`, `schema.ts`, `types.ts`,
`semantic-store.ts`, and `consolidator.ts` all forward the value as an opaque string. Both decision-rule
conditions are satisfied, so PRIMARY is selected. `src/adapter/memory-ops.ts`'s dual mint/unrelated
use was the one row requiring extra scrutiny (a non-inferred-origin MCP-added episode's session_id
COULD theoretically reach `countDistinctProvenance`), but it draws from a wholly separate identifier
space (a per-engine-instance UUID) untouched by anything `ingest-cli.ts:188` produces, so it does not
count against the decision rule.

Under PRIMARY: the exact edit site is `src/adapter/ingest-cli.ts:188` (the
`` sessionId: `ingest:${r.source}` `` template literal, to become
`` `ingest:gmail:<normalized-sender-domain>:<gmail-thread-id>` `` for `source==='gmail'`, unchanged
for every other source). `src/lib/types.ts`, `src/consolidation/update-decision.ts`, and
`src/db/schema.ts` stay byte-unchanged — `PendingContradiction`, `countDistinctProvenance`, and the
`episode` table DDL require no edits under this shape.

## 5. Named accepted limitations

1. **D-03 forward-only:** existing Gmail episodes keep their historical `ingest:gmail` session id.
   No retroactive migration is performed. Pending contradictions already accumulated under the
   collapsed id count as one bucket forever; the redesign only affects episodes ingested after
   enablement. This is acceptable because the redesign's value is forward-looking (making future
   evidence provenance-distinct), and retroactively rewriting historical `session_id` values on
   already-consolidated episodes would itself be a load-bearing correctness change outside this
   phase's scope (DRIFT-01's "no new data model / no retroactive migration" spirit).

2. **Sender-domain rotation:** an actor controlling three distinct sending domains can still reach
   `contradictionN`-legitimately-shaped independent provenance. This is acceptable because it is the
   same trust bar as controlling three separate Claude Code sessions (already accepted under the
   pre-existing `session_id`-based counting for claude-code episodes), is not made worse by this
   change, and is bounded by the residual gate (Plan 65-02) and by `contradictionNBySource`
   (Plan 65-03).

3. **D-12 cross-run/cross-account interleaving:** out-of-order evidence spanning separate sleep-pass
   runs or separate account backfills is NOT closed by this milestone (the honest-null convention
   per research Pitfall 5's third bullet). This is acceptable because bi-temporal validity columns
   remain a deliberately deferred v9.0 DEFER decision, and closing this gap would require exactly
   the schema change DRIFT-01 rules out; it is documented here as a named, accepted risk rather than
   silently shipped.
