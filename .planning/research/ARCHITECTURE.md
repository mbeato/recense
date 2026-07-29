# Architecture Research

**Domain:** recense v10.0 "Action Proposals" — integrating offline intent classification, entity
resolution, belief-gated status drift, and a domain-neutral proposal-emit seam into a mature
9-milestone TypeScript memory engine (~2700 tests)
**Researched:** 2026-07-29
**Confidence:** HIGH (grounded in live source: `consolidator.ts`, `update-decision.ts`,
`typed-predicates.ts`, `schema.ts`, `memory-ops.ts`, `serve-cli.ts`, `sink.ts`,
`clients/telegram/{proposal-engine,proposal-store,types,index}.ts`, `docs/reference-client.md`)

---

## Existing Architecture (read from source — the invariants new work must respect)

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Online paths — LLM-free, blocks a caller (latency is felt)              │
│                                                                            │
│  SessionStart inject · GET /v1/search · GET /v1/surface · GET /v1/ask*   │
│  (*ask writes one origin='inferred' episode — the sole online write)     │
├──────────────────────────────────────────────────────────────────────────┤
│  Offline sleep pass — Consolidator.consolidate() — SOLE GRAPH WRITER      │
│                                                                            │
│  Phase A (async, no writes): reembedDirty → per-episode loop:            │
│    skip-threshold gate → echo detection → hard-stop (inferred/echo/hitl) │
│    → extractClaimsWithChunking/parseMergedExtraction (ONE generate call  │
│      per eligible episode) → per-claim candidate union (cosine ∪ M1      │
│      entity/link anchors ∪ BM25) → D-17 fast-path OR judge escalation    │
│  Phase B (sync, ONE db.transaction per episode): applyDecision() per     │
│    claim → confirm/extend/unrelated/contradict routing via               │
│    routeContradiction() (PE-gate: hold / reconcile / append-new) →       │
│    ConsolidationSink.emit() (audit) → markConsolidated()                 │
│  Phase C (async, once per pass): reembedDirty → schema induction →       │
│    schema-relation derivation → corpus promotion → doc-graph derive →    │
│    insight reflection → eviction sweep                                  │
├──────────────────────────────────────────────────────────────────────────┤
│  Ingestion — SourceAdapter seam (Gmail, gcal, transcripts, Obsidian)     │
│  writes EPISODES ONLY via IngestionPipeline; never touches the graph     │
├──────────────────────────────────────────────────────────────────────────┤
│  Interfaces — one shared memory-ops.ts core, one engine instance         │
│  stdio MCP (`recense mcp`) · HTTP (`recense serve`: REST + MCP-over-HTTP)│
│  clients/telegram/ — outside the engine, HTTP-only, tsconfig-enforced    │
├──────────────────────────────────────────────────────────────────────────┤
│  Storage — SQLite, WAL. node/edge = graph (source of truth).             │
│  Derived side-tables (each has ONE writer, each is rebuildable/disposable):│
│    activation_trace (viz), consolidation_event (audit/corpus replay),   │
│    node_temporal (surfacing), node_scope (provenance), surfaced_event   │
│    (operational ack log), token_usage_ledger (cost)                     │
└──────────────────────────────────────────────────────────────────────────┘
```

### Load-bearing invariants (verified against source, must not break)

| Invariant | Where enforced today | v10.0 risk |
|---|---|---|
| Sleep pass is sole graph writer | `Consolidator.applyDecision` — only owner of `upsertNode`/`upsertEdge`/`tombstone` | A naive "consumer approves → strengthen the belief" write-back would be a NEW violation (see D-43 discussion below) |
| Online paths LLM-free | `RetrievalEngine`, `memory-ops.search/surface` — zero `provider.generate`/`judge` calls | A per-episode *classifier* call would live offline (fine) but a *second* generate() call is a real **cost regression** the founder explicitly measured against (Phase 42, `consolSkipThreshold`) |
| D-43: inferred/observed-back-output never strengthens a fact | `strength.strengthen()` origin guard; `source:'hitl'` episodes excluded from consolidation (`isEligibleForExtraction`) | A consumer's "approved" ack must not re-enter as elevated-trust evidence — this is a **new instance of the same threat class**, not automatically covered by existing tests |
| Graph is source of truth; vector/side-tables are derived | `activation_trace`, `consolidation_event` are rebuildable, single-writer append logs | A proposal queue must follow the same discipline — never a second copy of belief truth |
| Engine/client boundary | `clients/telegram/tsconfig.json` (no `paths` into `src/`) + `tests/import-boundary.test.ts` (static scan) | A new reference-consumer directory needs its **own** copy of this guard — the existing test only scans `clients/telegram/` |
| Net-zero new runtime deps | `better-sqlite3`, plain `fetch`, official MCP SDK — that's the whole dependency surface | All new work below uses only SQLite + existing HTTP server + existing LLM call sites |
| Single-tenant | `node_scope` is provenance-only, never ranking | Proposal `entity` field must stay a free-text descriptor, never a foreign multi-tenant key |

---

## Q1 — Where does intent classification belong in the sleep-pass pipeline?

**Answer: inside the existing per-episode extraction call, not before it and not after the
PE-gated update.** Concretely, it rides the *same* `provider.generate()` call gmail episodes
already make in `Consolidator.consolidate()` (consolidator.ts:657‑679, extraction prefetch at
323‑399) — **zero net-new LLM calls per episode.**

### Trace through the three candidate sites

**(a) Before extraction (a dedicated classifier call).** Sees only raw episode content — enough
to decide "is this status-relevant" — but is a **second generate() call per gmail episode**. This
is the exact regression the founder measured and built a lever against: Phase 42 found ~7.1k
tok/turn marginal write cost and shipped `consolSkipThresholdBySource` specifically to cut
*extraction* volume. Doubling gmail's per-episode LLM calls for the qualifying subset works
directly against that lever. **Rejected** as the primary mechanism — flag as a fallback-only
pattern if extraction-side classification proves too noisy for a single JSON call.

**(b) Folded into extraction (recommended).** `ExtractedClaim` already carries two *optional*
fields threaded through the exact same call for exactly this reason — `due_at`/`action_type`
(D-03, TEMP-02): "Claims that omit them behave exactly as before — no node_temporal row is
written (backward-compat)." (`src/model/claim-extractor.ts:68-81`). The intent-classification
fields should be added the **same way**:

```ts
// src/model/claim-extractor.ts — ExtractedClaim, additive optional fields
export type ExtractedClaim = {
  type: NodeType;
  value: string;
  links?: string[];
  origin?: Origin;
  due_at?: string;
  action_type?: ActionType;
  // NEW (v10.0), mirrors due_at/action_type's optional-field precedent exactly:
  intent_entity?: string;      // free-text descriptor of the tracked entity, present only
                                // when this claim implies a status change
  proposed_change?: string;    // e.g. "status: interviewing"
  intent_confidence?: number;  // [0,1], model-reported
};
```

`GMAIL_EXTRACTION_PROMPT` (and `GMAIL_EPISODIC_EXTRACTION_PROMPT` when
`RECENSE_ENABLE_EPISODIC_EMAIL=on`) in `src/source/extraction-prompts.ts` gets new instruction
lines asking the model to populate these three fields *only* when the extracted claim implies a
tracked-entity status change; `parseClaimsFromArray` (`src/model/claim-extractor.ts:270`) gets a
few more optional-field reads mirroring its existing `due_at`/`action_type` handling. Note gmail
is explicitly **out of scope** for the Phase-37 "merged extraction" `{facts, triples}` mode today
(`isTypedExtractionSource` returns `false` for `'gmail'`, `extraction-prompts.ts:307-318`) — do
**not** try to route gmail through that machinery; extend gmail's own dedicated prompt + the
shared `parseClaimsFromArray` instead. This is a smaller, more surgical change than it looks.

What it sees: exactly what extraction already sees (the redacted, provenance-headered email
body) — sufficient for "does this imply a change." What it can write: nothing directly — it only
annotates the `ExtractedClaim`, which flows into the *unmodified* candidate-generation →
judge → `routeContradiction` pipeline like any other claim. Does it violate sole-graph-writer?
No — `Consolidator.applyDecision` remains the only write path. Does it add a second LLM call?
**No** — this is the direct answer to the cost question.

**(c) After the PE-gated update (a new Phase C step).** Wrong site for *classification* — Phase C
only sees post-hoc graph state, not raw episode content, so it cannot decide "does this email
imply X" without re-reading episodes out of band. It is, however, exactly the right site for
**proposal emission** (see Q3) — a different responsibility from classification. Keep the two
separate: classification is per-claim (Phase A/B), emission is a decision made *from* the
already-written Phase B outcome.

### The threaded path (mirrors TEMP-02 exactly)

`ExtractedClaim.intent_entity/proposed_change/intent_confidence` → `ClaimDecision` gets three
matching optional fields (`claimIntentEntity`, `claimProposedChange`, `claimIntentConfidence`,
consolidator.ts:150-193, alongside the existing `claimDueAt`/`claimActionType`) → `applyDecision`
calls a new `maybeEmitActionProposal(nodeId, decision, episodeId)` at the same call sites as the
existing `maybeWriteNodeTemporal(nodeId, decision)` (confirm/extend/contradict branches,
consolidator.ts:1075‑1372), gated on `decision.claimIntentEntity !== undefined` — the identical
guard shape TEMP-02 already established for `claimDueAt`.

---

## Q2 — Status lifecycle without a new data model

**Answer: rides existing node + typed-predicate + tombstone machinery unmodified. Does not
force the deferred bi-temporal/supersedes-chain work (v9.0 Phase 49 DEFER).**

The v9.0 decision was explicit: *"Bi-temporal/supersedes DEFER — tombstone-always stands... No
current forcing function; backfill/constraints force full `node_v*` recreation; additive
supersedes-chain columns are the cheap path if ever needed."* Nothing about v10.0 changes that
calculus:

- A status fact ("Acme Corp application status: interviewing") is an ordinary `type='fact'` node.
  A new email reporting a status change is an ordinary claim that candidate-generation surfaces
  against the existing status node (cosine + BM25 lexical union + M1 entity/link anchors,
  Phase 46 RECON-01..04 — unmodified) and the judge verdicts as `contradict`.
- `routeContradiction()` (`src/consolidation/update-decision.ts:45-61`) already implements
  exactly "hold on a weak/ambiguous signal, reconcile on a clear one, append-new on extreme
  divergence" via `peMagnitude / resistance` banding — this **is** the differentiator
  ("one ambiguous email must not flip status"). Zero new gating logic needed.
- `node.prev_value`/`node.prev_ts` (schema v1 columns) already carry the one-deep history
  breadcrumb across a tombstone-and-mint-new reconcile — structurally this already **is** a
  "supersedes" relationship, just not materialized as an edge.
- D-19 provenance-distinct force-destabilization (`countDistinctProvenance`, N independent
  sessions/emails required before a `hold` escalates to a forced flip) is exactly "don't flip
  status on one ambiguous email" made concrete — already built, already tested.
- The `supersedes` predicate is **already in the closed 12-predicate vocabulary**
  (`src/model/typed-predicates.ts:25`, Phase 37 TYPED-01) but is presently only minted between
  two *already-resolved* entity names via the typed-triple path (`resolveEntityByName`). For
  v10.0 it can *optionally* be minted explicitly as an audit/legibility edge (old-status-node →
  new-status-node) inside the same Phase B transaction that reconciles the contradiction, using
  the existing `store.upsertEdge({..., rel: 'supersedes', kind: 'relation'})` call shape already
  used for `'extends'` edges (consolidator.ts:1113‑1119) — additive, optional, **not required**
  for the belief-gating to function, since `prev_value` already carries the same information for
  the D-20 oscillation guard.

**The trade:** no new columns, no new CHECK-constraint table recreation (the pattern every prior
schema change in `schema.ts` v7/v11/v12/v13 had to pay when it needed a new `edge.kind` or
`node.type` enum value — `supersedes` already exists so this cost is avoided entirely). The only
schema cost v10.0 pays is the wholly-new, additive `action_proposal` table (Q3) — no
table-recreation migration needed because it has no CHECK-constraint enum to extend later.

---

## Q3 — The proposal-emit seam

**Answer: a `ActionProposalSink` interface (Noop-default, same DI convention as
`ConsolidationSink`/`ActivationTraceSink`) whose production implementation persists into a new,
additive `action_proposal` SQLite table, read/acked over the existing `recense serve` HTTP
surface. Not a file store, and not a bolt-on post-hoc scan of `consolidation_event`.**

### Why not a file store

`clients/telegram/proposal-store.ts` (JSON file, chmod-600, tmp→rename) is explicitly a
**client-local, ephemeral** approval-state cache — Telegram-only, engine-free by construction
(CLIENT-01). Making it the canonical cross-process queue would (a) put belief-derived state
outside the engine boundary, (b) force every future consumer (jobfill's real integration, a
second Telegram-alternative client) to reimplement or share that file, breaking "recense emits
once, many consumers read," and (c) have no natural single-writer/WAL story. Reject.

### Why not a bare post-hoc `consolidation_event` scan

`SQLiteConsolidationSink` is already live in production (`run-sleep-pass.ts:492`,
`dedup-entities-cli.ts`, `remember-cli.ts`) and does persist every `applyDecision` branch. A
Phase-C step that re-scans it for "this pass's contradict_reconcile rows on a status-shaped
node" is *possible* but reinvents a filter that the classification flag (Q1) already computed
precisely, at the exact moment confidence/magnitude were known — re-deriving "was this a status
claim" from a generic audit row after the fact is strictly worse information than emitting
directly from `applyDecision` where `decision.claimIntentEntity` is already in scope.

### Recommended shape (new file `src/consolidation/action-proposal-sink.ts`, mirrors `sink.ts`)

```ts
export interface ActionProposalInput {
  entity: string;             // fuzzy descriptor — see Q4 (NOT a consumer-owned id)
  proposed_change: string;    // e.g. "status: interviewing"
  evidence_episode: string;   // episode id
  confidence: number;         // decision.claimIntentConfidence / judge magnitude
  node_id: string;            // current/new node id (lineage)
  candidate_id: string | null;// superseded node id, if any
}
export interface ActionProposalSink { emit(p: ActionProposalInput): void; }
export class NoopActionProposalSink implements ActionProposalSink { emit(): void {} }
export class SQLiteActionProposalSink implements ActionProposalSink { /* writes action_proposal */ }
```

Injected into `Consolidator`'s constructor exactly like `corpusPromoter`/`insightReflector`/
`docGraphDeriver` — last positional param, Noop default, zero cost when absent
(consolidator.ts:244‑262 already carries this convention to its seventh optional collaborator;
this is the eighth, consistent with house style).

**Call site:** inside `applyDecision`'s `confirm`/`extend`/`contradict_reconcile`/
`contradict_force_destabilize`/`contradict_oscillation` branches, gated on
`decision.claimIntentEntity !== undefined` — **never** on `contradict_hold` (holding is the
differentiator working correctly: silence during ambiguity is the intended behavior, not a
missed emission). This keeps emission inside the *same* per-episode `db.transaction` as the
graph write it describes, mirroring `ConsolidationSink`'s D-48 atomicity guarantee (event and
graph mutation commit together — a crash mid-pass can never emit a proposal for a write that
didn't happen, or vice versa).

**Schema (new, additive — no CHECK-enum to extend later, no table recreation cost):**

```sql
-- v16 migration
CREATE TABLE IF NOT EXISTS action_proposal (
  id               TEXT    PRIMARY KEY,
  ts               INTEGER NOT NULL,
  entity           TEXT    NOT NULL,
  proposed_change  TEXT    NOT NULL,
  evidence_episode TEXT    NOT NULL,
  confidence       REAL    NOT NULL,
  node_id          TEXT    NOT NULL REFERENCES node(id),
  candidate_id     TEXT,
  status           TEXT    NOT NULL DEFAULT 'pending'
                     CHECK(status IN ('pending','approved','rejected','consumed')),
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_action_proposal_status ON action_proposal(status);
```

Single writer for INSERT: the sleep pass (`SQLiteActionProposalSink`), mirrors CONSOL-03
discipline exactly. The ONLY other writer is a narrow `status` UPDATE from the HTTP approve/reject
route (below) — mirrors how `POST /v1/surface/seen` writes only `surfaced_event.outcome`, never
`node.s`/`node.c` (D-43 precedent for "operational ack ≠ belief write").

### HTTP surface (new routes on `serve-cli.ts`, wired through `memory-ops.ts`)

```
GET  /v1/proposals            — LLM-free, lock-free read (mirrors GET /v1/surface exactly)
POST /v1/proposals/:id/approve — per-call lock, single-row status UPDATE (mirrors /v1/surface/seen)
POST /v1/proposals/:id/reject  — same shape
```

`memory-ops.ts` gets a small `MemoryOps.listProposals()`/`ackProposal()` pair alongside the
existing `surface()`/`surfaceSeen()` (same read-only-handle discipline for the read, same
`acquireLockWithRetry`/`releaseLock` discipline for the write). This is the concrete answer to
"where does the queue physically live": **a new SQLite table, written only by the sink, read and
lock-guard-acked only through the existing HTTP surface** — the Sink is the write-side
abstraction (keeps the mechanism domain-neutral/pluggable and free when disabled); the SQLite
table + HTTP route is *the one and only* production implementation of that abstraction. These
are not competing options — they compose, exactly the way `ConsolidationSink` (interface) +
`consolidation_event` (table) + no HTTP read route (not needed there) already compose today.

### A new invariant to test for (flag for the planner)

The temptation "the consumer approved this, so let's strengthen the node" would be a **new
self-confirmation vector** — the same threat class D-43 already guards against for inferred
output, but on a fresh code path the existing sentinel test doesn't cover. The `approve` HTTP
route must write **only** `action_proposal.status`, never touch `node.s`/`node.c`/`origin`, and
never re-ingest the approval as an elevated-trust episode. Recommend a "D-43-for-proposals"
sentinel test alongside the existing self-confirmation suite.

---

## Q4 — Who owns the canonical entity list?

**Answer: neither (a) nor (b) for v10.0 — recense emits a fuzzy descriptor (option c) and the
consumer resolves it. This is the only option consistent with the locked v10.0 scope edge
("producer + in-repo reference adapter; real jobfill wiring happens in jobfill's repo later")
and the locked "recense has zero knowledge of any consumer's schema" decision.**

| Option | Coupling | Staleness | Where ambiguity lands | Fit with locked decisions |
|---|---|---|---|---|
| (a) recense's own entity graph is canonical | HIGH — consumer must treat recense `node.id` as a stable FK | LOW (single source) | Inside recense — recense would need consumer-schema-aware matching | **Reject.** `node.id`s are not stable across belief-correction (tombstone-and-mint-new on any reconcile, `dedup-entities-cli.ts` merges fragments); using them as a foreign key contradicts tombstone-always. Also directly re-litigates the resolved architecture fork by pulling consumer-schema logic into the engine. |
| (b) consumer's IDs are canonical, mirrored into recense | MEDIUM — needs a mirror channel (episodes via `/v1/add`, or a config file the sleep pass reads) | MEDIUM — mirror can lag a pass cycle | Split — recense gets ground truth to match against (higher resolution precision); consumer still owns identity semantics | Viable, higher-precision *hardening* path, but requires new integration surface (mirror channel) that is explicitly **not** in v10.0's scope ("real jobfill wiring happens in jobfill's repo later"). Good candidate for a v11 SEED if match precision in practice needs it — gate behind a real measured trigger, per the project's existing SEED discipline (ANN/bi-temporal were both deferred exactly this way). |
| (c) recense emits a fuzzy descriptor; consumer resolves | LOW — zero new integration surface beyond the emit contract itself | N/A — nothing to go stale | Entirely in the consumer, where the schema lives | **Recommended for v10.0.** Matches the locked decision verbatim: *"recense emits domain-neutral intents; a consumer-side adapter maps them... recense must not know any consumer's schema."* Zero speculative infra. |

**Concrete emit shape for (c):** `entity` = the canonical `value` string of the recense-internal
node the claim resolved against (e.g. the entity/fact node's own text, not a UUID) — this is
recense's own *internal* entity resolution (unchanged: `resolveEntityByName`, cosine/BM25/anchor
candidate union), which is a different, already-solved problem from the *external* ID-mapping
question this section is about. The "entity resolution against a canonical entity list" language
in the milestone (PROJECT.md) is resolved by recognizing these are two different resolutions:
recense's own graph already acts as its internal canonical list (solved, Phase 46 union
candidate generation); the *external*-facing question — which jobfill row this refers to — is
Option (c)'s domain and is explicitly out of recense's schema knowledge by design.

---

## Q5 — Where the reference consumer adapter lives

**Answer: `clients/proposal-reference/`, a new sibling to `clients/telegram/`, following the
exact structural pattern `docs/reference-client.md` already documents — not a new top-level
`examples/`/`adapters/` directory.**

`docs/reference-client.md` frames the existing Telegram code as *"the canonical reference
implementation. Copy its structure; adapt the transport... and nothing else."* A proposal
consumer isn't a transport swap (Slack vs Telegram) — it consumes a different API surface
(`GET /v1/proposals` + ack, not `/v1/ask`/`/v1/search`) — but the *structural* contract (own
`tsconfig.json` with no `paths` into `src/`, plain-`fetch`, zero engine imports, zero new npm
deps) is identical, so it belongs in the same `clients/` directory, not a new top-level
convention. Naming it `proposal-reference/` rather than `jobfill-reference/` keeps it honest: the
milestone is explicit that "real jobfill wiring happens in jobfill's repo later" — the in-repo
piece is a generic proof of the *contract*, not a jobfill-specific integration.

**What the boundary test needs to keep passing:**

1. `clients/telegram/tests/import-boundary.test.ts` scans **only**
   `resolve(__dirname, '..')` (i.e., `clients/telegram/`) — it does **not** automatically cover a
   new sibling directory. A new copy of the same guard must be added at
   `clients/proposal-reference/tests/import-boundary.test.ts` (same static-scan logic, own
   `CLIENT_DIR`), mirroring the existing per-client-owns-its-guard convention. (A single
   top-level `clients/import-boundary.test.ts` scanning every subdirectory would also work and is
   arguably cleaner now that there are two clients — flag as a planner choice; either satisfies
   the invariant.)
2. `clients/proposal-reference/tsconfig.json` — identical shape to `clients/telegram/tsconfig.json`
   (no `paths`, `include: ["."]`, `exclude: ["tests","dist"]`).
3. The adapter calls **only** `GET /v1/proposals` (poll) and `POST /v1/proposals/:id/ack` (or the
   split approve/reject routes from Q3) against `recense serve` — never `/v1/add`, never any
   engine import. A narrow operational-ack write is already precedented as compatible with
   "read-only by design" — the existing Telegram client calls `POST /v1/surface/seen` (an
   operational ack) despite being "read-only" in the sense that matters (never mints arbitrary
   belief content via `/v1/add`). The same distinction applies here.
4. `docs/reference-client.md` gets a new section (**MODIFIED**, not new file) documenting the
   proposal-poll pattern, mirroring the existing "Telegram reference client" section, keeping the
   "isomorphic to `docs/reference-client.md`" requirement literal.

---

## Q6 — A second proposal KIND in the Telegram client, without forking

**Answer: a `kind` discriminator on `StoredProposal`, a bypass of `proposal-engine.ts` entirely
for the new kind, zero changes to `proposal-store.ts`, and small localized branches in
`index.ts`'s action handler and card-render call site — not a fork.**

### Why `proposal-store.ts` needs zero changes

Reading every exported function (`putProposal`, `getProposal`, `removeProposal`,
`loadExecutable`, `isExpired`, `tryReserveProposalSlot`, `getCapState`) — **none of them inspect
`tool`/`args`/`serverName`.** They operate exclusively on the shared envelope fields (`id`,
`dueAt`, `createdAt`, `maxTtlMs`). The store is already kind-agnostic. Widening the type is
sufficient; no store code moves.

### Why `proposal-engine.ts` needs zero changes

Every export in that file (`buildAllowedToolSpec`, `filterAllowlisted`, `callDeepSeek`,
`buildProposalPrompt`, `validateProposal`, `validateEditedArgs`, `deriveConfirmValue`) exists to
harden the **tool-shaped** path: taking untrusted DeepSeek output and untrusted MCP tool
metadata and turning them into a validated `{tool, args}`. A belief-shaped proposal is produced
**engine-side** with no DeepSeek call and no tool schema — there is nothing for this module to
validate. The answer to "what does bypassing the mapper mean for shared code" is: this file
simply isn't called for `kind:'belief'`. No fork, no dead branches added to it.

### What does change

**`types.ts` (MODIFIED, additive discriminated union):**

```ts
interface StoredProposalBase {
  id: string;
  nodeId: string;
  dueAt: string;
  maxTtlMs: number;
  createdAt: string;
}
interface ToolProposal extends StoredProposalBase {
  kind: 'tool';                       // NEW field; every existing literal gets this added
  serverName: string;
  tool: string;
  args: Record<string, unknown>;
  destructive: boolean;
  expectedConfirmValue: string;
}
interface BeliefProposal extends StoredProposalBase {
  kind: 'belief';                     // NEW kind
  engineProposalId: string;           // action_proposal.id from recense
  entity: string;
  proposedChange: string;
  evidenceEpisode: string;
  confidence: number;
}
export type StoredProposal = ToolProposal | BeliefProposal;
```

**`index.ts` (MODIFIED, additive):**

- A new poll function (mirrors the existing `GET /v1/surface` push-tick pattern,
  `index.ts:1150+`) calling `memoryClient.listProposals()` and mapping each pending row
  directly into a `BeliefProposal` — no LLM call, no `validateProposal` (there's no tool schema
  to validate against; a small type-shape guard on the polled JSON suffices).
- `handleProposalAction` (`index.ts:1036`) gets **one** new branch at the top of the
  `action === 'approve'` handling: `if (proposal.kind === 'belief') { await
  approveBeliefProposal(...); return; }` — before the existing destructive/`executeStoredProposal`
  branches, which stay untouched and tool-kind-only.
- `reject`/`snooze` branches (`index.ts:1047-1073`) are **already generic** — they only touch
  `getProposal`/`removeProposal`/`hitlEpisode`, no tool-specific logic — they work unchanged for
  `kind:'belief'` (optionally also POST a `/v1/proposals/:id/reject` ack, mirrored the same way
  as `approveBeliefProposal`).
- `edit` (`index.ts:1075-1103`) is inherently tool-specific (patches args against an MCP
  `inputSchema`). For `kind:'belief'` there is nothing to edit — a belief's evidence isn't a
  patchable argument set. Add an explicit short-circuit ("editing isn't supported for this
  proposal type") rather than silently misrouting into the tool-only patch logic.
- The approval-card text builder gets one presentation-only `kind` branch (tool card shows
  tool+args; belief card shows entity/proposed-change/confidence) — not a structural fork.

**`memory-client.ts` (MODIFIED, additive):** new thin methods `listProposals()`/
`approveProposal(id)`/`rejectProposal(id)` mirroring the existing `surface()`/`surfaceSeen()`
pair exactly (same HTTP-call shape, same error handling).

### Shared validation/expiry/rate-cap code — what happens to it

- **Expiry** (`isExpired`, `loadExecutable`) — kind-agnostic already (operates on `dueAt`/
  `createdAt`/`maxTtlMs`), applies unchanged to belief proposals.
- **Daily cap** (`tryReserveProposalSlot`) — also kind-agnostic; because both kinds currently
  share one `storePath` → one `ProposalDocument` → one `cap` counter, v10.0 gets a **combined**
  daily cap across tool- and belief-shaped proposals for free. This is the right default for a
  single-user personal tool (notification fatigue is the resource being capped, regardless of
  which kind is generating the notification) — flag as an easy future split (two store paths, or
  `cap: Record<kind, CapState>`) if the founder later wants independent caps per kind.
- **Tool-schema validation** (`validateProposal`/`validateEditedArgs`) — does not apply to
  `kind:'belief'` at all; simply not invoked on that path.

---

## Suggested Build Order

Phases continue from 62 (per `.planning/PROJECT.md`); dependencies are the load-bearing
constraint, not the numbering.

| Step | Work | Depends on | Parallel-safe with |
|---|---|---|---|
| 1 | Multi-inbox email ingest (per-account `gmail.query` scoping) | Nothing — reuses the shipped v4.0 per-account `GmailAdapter` fan-out; pure config wiring | 2 |
| 2 | `action_proposal` table (v16 schema migration, additive, no CHECK-enum) | Nothing | 1, 3 |
| 3 | Intent classification riding gmail extraction (`ExtractedClaim` fields + prompt + `parseClaimsFromArray` + `ClaimDecision` threading) | Nothing structural (mirrors TEMP-02) | 2 |
| 4 | Validate belief-gated status drift against real multi-inbox traffic (spike/eval — is the existing `hold`/`reconcile`/force-destabilize banding tuned right for single-signal emails?) | 1, 3 | — |
| 5 | `ActionProposalSink` + `applyDecision` call sites gated on `claimIntentEntity` | 2, 3, 4 (need validated gating semantics before wiring emission) | 6 (table shape frozen after 2; route work doesn't need 5's logic) |
| 6 | HTTP routes: `GET /v1/proposals`, `POST /v1/proposals/:id/approve\|reject` on `serve-cli.ts` + `memory-ops.ts` | 2 (only needs the table shape) | 5 |
| 7 | Reference consumer adapter `clients/proposal-reference/` (+ import-boundary test, tsconfig, `docs/reference-client.md` section) | 6 (needs a stable HTTP contract) | 8 |
| 8 | Telegram second proposal kind (`types.ts` union, `index.ts` branches, `memory-client.ts` methods) | 6 | 7 |

**Rationale for the split:** steps 1 and 2 have zero mutual dependency and no dependency on
anything else — both can start immediately. Step 3 only needs the extraction-side plumbing
pattern (already proven by TEMP-02), so it can start alongside 2. Step 4 is a validation gate,
not new code — it exists to catch a bad threshold *before* step 5 wires real consumers to the
emission stream (cheap to fix a threshold before anyone depends on its output; expensive after).
Steps 5 and 6 fork from step 2 into two independent workstreams (emission logic vs. the read/ack
HTTP surface) that only need to agree on the table shape, converging at an integration test.
Steps 7 and 8 are two independent *consumers* of the same finished contract (step 6) and can be
built by two people/threads concurrently — this mirrors how `docs/reference-client.md` already
treats "reference client" and future channel clients as parallel, independent implementations of
one stable interface.

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: A dedicated classifier LLM call before extraction

**What people do:** add a cheap "is this status-relevant?" classification call ahead of the
existing extraction call, reasoning that it's small/cheap so it doesn't matter.
**Why it's wrong:** it is a second per-episode LLM call for every gmail episode that clears the
salience gate — directly undoing the cost discipline `consolSkipThreshold` was built to enforce
(Phase 42 measured ~7.1k tok/turn as the baseline to protect). Small-but-nonzero repeated N times
is exactly the class of regression the founder's `docs/evals.md`/token-ledger discipline exists
to catch.
**Do this instead:** fold the classification into the extraction call's own JSON schema
(optional fields, D-03/TEMP-02 pattern) — zero marginal calls.

### Anti-Pattern 2: Making the proposal queue a second belief store

**What people do:** treat `action_proposal` (or a client-side file) as if it were itself a source
of truth about entity status, letting a consumer's "approved" ack flow back into `node.s`/`node.c`
or get re-ingested as a trusted episode.
**Why it's wrong:** this is a new self-confirmation loop — the same threat class D-43 already
exists to prevent for inferred/echoed output, just on a code path the existing sentinel doesn't
cover.
**Do this instead:** the approve/reject HTTP route touches `action_proposal.status` only, exactly
as `surfaceSeen()` touches `surfaced_event.outcome` only, never `node.*`.

### Anti-Pattern 3: Recense-internal node ids as the consumer's foreign key

**What people do:** hand the consumer recense's own `node.id` as the stable identifier for "this
application," since it's right there on the proposal payload.
**Why it's wrong:** `node.id`s are not stable across belief-correction — a reconcile tombstones
the old id and mints a new one (tombstone-always, v9.0 Phase 49). A consumer treating it as a
durable FK will silently orphan rows on the very belief-correction cycles this engine exists to
perform correctly.
**Do this instead:** emit a fuzzy text descriptor (Q4 option c); let the consumer's own schema
own identity.

### Anti-Pattern 4: One shared `import-boundary.test.ts` assumption

**What people do:** add `clients/proposal-reference/` and assume the existing
`clients/telegram/tests/import-boundary.test.ts` already protects it, because "it's under
`clients/`."
**Why it's wrong:** the existing test's `CLIENT_DIR` is hardcoded to `resolve(__dirname, '..')`
— it only scans `clients/telegram/`. A new sibling directory is invisible to it until a matching
guard is added (or the guard is generalized to scan all of `clients/`).
**Do this instead:** add a same-shaped guard scoped to the new directory (or generalize the one
guard to scan every subdirectory of `clients/` — either satisfies the invariant, but doing
neither leaves the boundary unenforced for the new consumer).

---

## Sources

- `/Users/vtx/brain-memory/.planning/PROJECT.md` — v10.0 milestone goal, target features, Key
  Decisions (architecture fork + emit-seam decisions logged 2026-07-29), v9.0 bi-temporal DEFER
  rationale
- `/Users/vtx/brain-memory/src/consolidation/consolidator.ts` — full sleep-pass pipeline,
  extraction prefetch, `ClaimDecision`, `applyDecision`, `maybeWriteNodeTemporal` (TEMP-02
  precedent for threading optional per-claim fields)
- `/Users/vtx/brain-memory/src/consolidation/update-decision.ts` — `routeContradiction`,
  `isOscillation`, `countDistinctProvenance` (the PE-gate/hold mechanism, unmodified for v10.0)
- `/Users/vtx/brain-memory/src/consolidation/sink.ts` — `ConsolidationSink`/
  `NoopConsolidationSink` pattern the new `ActionProposalSink` mirrors
- `/Users/vtx/brain-memory/src/model/claim-extractor.ts` — `ExtractedClaim`, `parseClaimsFromArray`,
  `parseMergedExtraction` (confirms gmail is out of merged-mode scope today)
- `/Users/vtx/brain-memory/src/source/extraction-prompts.ts` — `isTypedExtractionSource`,
  `promptForSource`, `GMAIL_EXTRACTION_PROMPT` routing
- `/Users/vtx/brain-memory/src/model/typed-predicates.ts` — the 12-predicate closed vocabulary,
  `supersedes` already present, `parseTriples`
- `/Users/vtx/brain-memory/src/db/schema.ts` — `SCHEMA_VERSION` history (v1–v15), migration
  cost pattern for CHECK-constraint changes vs. additive new tables
- `/Users/vtx/brain-memory/src/source/source-adapter.ts` — `SourceAdapter`/`NormalizedRecord`
  seam (multi-inbox email ingest reuses this unmodified)
- `/Users/vtx/brain-memory/src/adapter/memory-ops.ts` — shared operation core, `surface()`/
  `surfaceSeen()` as the precedent for the new `listProposals()`/`approveProposal()` pair
- `/Users/vtx/brain-memory/src/adapter/serve-cli.ts` — HTTP route pattern (`GET /v1/surface`,
  `POST /v1/surface/seen`) the new proposal routes mirror
- `/Users/vtx/brain-memory/src/db/surface-store.ts` — `SurfaceItem`/`SurfaceOpts` shape,
  confirms `/v1/surface` is temporal-anchored and structurally distinct from the belief-shaped
  proposal payload (justifying a new read surface rather than reuse)
- `/Users/vtx/brain-memory/docs/reference-client.md` — the adopter-template pattern, "read-only
  by design" framing, the precedent that operational acks (`surfaceSeen`) are compatible with it
- `/Users/vtx/brain-memory/clients/telegram/types.ts` — `StoredProposal`, `AllowlistEntry`,
  `ProposalAction`
- `/Users/vtx/brain-memory/clients/telegram/proposal-engine.ts` — DeepSeek tool-mapping/
  validation machinery (confirmed unused by the belief-shaped path)
- `/Users/vtx/brain-memory/clients/telegram/proposal-store.ts` — confirmed kind-agnostic (no
  `tool`/`args`/`serverName` reads anywhere in the file)
- `/Users/vtx/brain-memory/clients/telegram/index.ts` — `tryGenerateProposal`,
  `handleProposalAction`, `executeStoredProposal`, push-tick wiring
- `/Users/vtx/brain-memory/clients/telegram/tsconfig.json`,
  `/Users/vtx/brain-memory/clients/telegram/tests/import-boundary.test.ts` — the engine/client
  boundary enforcement mechanism a new reference-consumer directory must replicate

---
*Architecture research for: recense v10.0 Action Proposals*
*Researched: 2026-07-29*
