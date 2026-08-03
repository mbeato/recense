# Phase 66: Domain-Neutral Proposal Emit Seam - Context

**Gathered:** 2026-08-03 (auto mode — decisions are the recommended defaults, grounded in the v10.0 research pass, live-code scout, and the 63/64/65 context chain; audit trail in 66-DISCUSSION-LOG.md)
**Status:** Ready for planning

<domain>
## Phase Boundary

recense emits a flat, domain-neutral action proposal — `{entity, proposed_change, evidence_episode, confidence}` in recense's own vocabulary — **and stops**. This phase ships the whole producer seam: a new `ActionProposalSink` with a **Noop default** (an install with no consumer configured pays zero cost — EMIT-01), the **additive** `action_proposal` table (the roadmap foundation-phase call: this phase owns the table; nothing upstream touched it), and consumer-facing routes on the existing authenticated `recense serve` surface (`GET /v1/proposals`, `POST /v1/proposals/:id/approve|reject`) mirroring the shipped `/v1/surface` + `/v1/surface/seen` pattern (EMIT-03). Proposal ids are deterministic so replay/double-delivery cannot apply twice (EMIT-04). Approve/reject writes **only** proposal status — never `node.s`/`node.c` — proven by the named "D-43-for-proposals" sentinel, the milestone's largest correctness risk, closed structurally (EMIT-05). Every proposal carries its raw quoted evidence verbatim (EMIT-06). A stale or superseded proposal is detected and refused before approval applies it (EMIT-07).

Emission fires only on decisive consolidation outcomes: Phase 65 exported `EMISSION_ELIGIBLE_EVENT_TYPES`/`isEmissionEligible` (`src/consolidation/status-drift.ts:180-188`) precisely so this phase gates its sink on it instead of re-deriving the rule — `contradict_hold` is structurally unreachable (65's D-13 sentinel extends to the real sink here).

Out of phase: the in-repo reference consumer adapter + contract docs (Phase 67, CONSUME-01..03); Telegram HITL belief-kind extension, per-entity-per-day batching, approval-rate stats (Phase 68); any consumer-schema knowledge anywhere (forbidden by EMIT-02); flipping `provenanceDistinctnessEnabled` (still the founder's open D-14 gate in 65-HUMAN-UAT.md — this phase neither needs it nor touches it).

Hard prerequisites satisfied: Phase 64 (resolved entity fields) and Phase 65 (validated gating semantics; re-verification 5/5 `human_needed` — the three open UAT items all gate the dark distinctness knob, not this seam) complete.

</domain>

<decisions>
## Implementation Decisions

### Table shape & migration (EMIT-01, EMIT-02, Pitfall 11)
- **D-01:** One **additive** `action_proposal` table, schema **v17** migration following the shipped conventions exactly (DDL + `IF NOT EXISTS` + guarded ALTER pattern; `surfaced_event`'s v9 migration at `schema.ts:383-385` is the model). No changes to any existing table.
- **D-02:** Record shape is the research-recommended set, flat and consumer-free: deterministic `id` (TEXT PK), `kind` (`'belief'` — a discriminator so Phase 68 can extend the union), `entity_node_id` + `entity_descriptor` (recense's node id + canonical value string per 64's D-08 — the docs caveat that node id is NOT a stable FK across belief-correction belongs to Phase 67's contract docs), `proposed_change` as the flat semantic triple `field`/`from`/`to` (**never JSON Patch** — presupposes consumer-schema knowledge recense is forbidden to have), `evidence_episode` (episode id), `evidence_quote` (verbatim — D-12), `confidence` (the coarse categorical vocabulary from 63's D-06; no raw numerics), `schema_version` (Pitfall 11 — costs nothing now, repeats ARCH-REVIEW M-9 if skipped), `status` with a CHECK constraint (`pending|approved|rejected|superseded|expired` — exact vocabulary planner discretion, mirroring `surfaced_event.outcome`'s CHECK style), `created_at`/`updated_at` epoch ms, and an expiry field (`expires_at` or `max_ttl_ms` — planner discretion; Pitfall 13's staleness backstop).
- **D-03:** No consumer-specific fields, ever — a structural test greps the DDL + emitted payload type for the absence of consumer vocabulary is prose-brittle; instead lock EMIT-02 by asserting the emitted record type exactly equals the documented contract fields (exhaustive key check in a test).

### Sink seam & emission wiring (EMIT-01, Pitfalls 6/7)
- **D-04:** `ActionProposalSink` interface + `NoopActionProposalSink` default + `SQLiteActionProposalSink`, mirroring `ConsolidationSink`/`NoopConsolidationSink`/`SQLiteConsolidationSink` (`src/consolidation/sink.ts:91-133`) verbatim — same constructor/injection style into `Consolidator`. Noop is the default everywhere; the SQLite sink is wired only when explicitly configured (config knob naming per the dark-knob convention).
- **D-05:** Emission fires **inside `applyDecision`'s decisive branches only** (the existing `this.sink.emit` sites at consolidator.ts:1290/1322/1343/1367/1468/1497 are the map), gated on (a) `isEmissionEligible(eventType)` — imported from status-drift.ts, NOT re-derived — and (b) the decision actually carrying the intent + resolved-entity fields (63/64's all-or-nothing pairs). A `contradict_hold` or a decision without a resolved entity emits nothing. 65's D-13 sentinel test (`tests/emission-hold-sentinel.test.ts`) is **extended to the real sink** in this phase, as that plan promised.
- **D-06:** The proposal INSERT happens **in the same transaction as the graph write it describes** (research SUMMARY Phase 6 prescription) — a crash between belief-write and proposal-write must not produce a proposal describing a belief change that didn't land, or vice versa.

### Deterministic id (EMIT-04, Pitfall 12)
- **D-07:** Proposal id is a **content-derived hash** over the identity of the change — at minimum `(entity_node_id, proposed_change.field, proposed_change.from, proposed_change.to, evidence_episode)` — not a random UUID, not AUTOINCREMENT. Replay/retry/double-delivery collapses via the TEXT PK (INSERT OR IGNORE semantics; the `uq_episode_source_external` dedup backstop at `schema.ts:246-253` is the shipped precedent for exactly this discipline). Exact hash function/encoding planner discretion; determinism and the keyed fields are locked.

### Approve/reject write isolation — "D-43-for-proposals" (EMIT-05)
- **D-08:** Approve/reject handlers write **only** `action_proposal.status` (+ `updated_at`). Never `node.s`, never `node.c`, never any `node`/`edge` table write. A **rejection leaves the belief untouched** — ordinary reconsolidation corrects it when better evidence arrives (founder decision 2026-07-29, locked in EMIT-05's text).
- **D-09:** The sentinel is **named "D-43-for-proposals"** and is two-layered, both structural: (a) a CI-grep/static test asserting the proposal store + route handlers contain zero `UPDATE node`/`SET s`/`SET c` statements and that the proposal-store module imports no semantic-store write API (the import-boundary test style); (b) a runtime whole-DB sentinel: approve one proposal, reject another → `node` table byte-identical before/after (the 63/64 snapshot-comparison pattern, payload-aware per 63's WR-02 lesson). This defect class shipped twice before (pre-launch critical + v9.0's live C-2) — prose is not acceptable closure.

### Stale/superseded refusal (EMIT-07, Pitfall 13)
- **D-10:** Detection happens **at approve time on the write path** — no background scanner, no LLM. Before an approval is recorded, re-check the originating belief: (a) entity node tombstoned → refuse; (b) the node's current value for the proposed field no longer matches what the proposal presupposed (the belief has since moved — comparison semantics planner/research discretion, but it must catch "belief moved past the proposal") → refuse and mark `superseded`; (c) proposal past its expiry → refuse and mark `expired`. Refusal is an explicit, distinct response (409-class), never a silent success; the proposal's terminal status is recorded so re-delivery cannot resurrect it.

### Routes & auth (EMIT-03)
- **D-11:** `GET /v1/proposals` (pending list, lock-free read — the `/v1/surface` D-95 discipline at serve-cli.ts:401) and `POST /v1/proposals/:id/approve|reject` (per-call lock — the `/v1/surface/seen` T-12-02 discipline at :433) live in `serve-cli.ts` beside their models. All existing serve invariants inherit: Bearer auth fires before any body parse with identical 401s (T-12-03), token only in chmod-600 sleep.env (T-12-05), never log bodies/values/token (D-16), `/health` stays the only unauthenticated path. 63's D-13 LLM-free online regression (fail-if-called `ModelProvider` through online entrypoints) is **extended to `/v1/proposals`** in this phase — that extension was explicitly promised when the test shipped.

### Evidence quote (EMIT-06, Pitfall 2)
- **D-12:** `evidence_quote` is a **verbatim slice of the already-stored episode content** (post strip-hidden, post redactSecrets — no new secret-leak or injection surface is introduced; the pipeline already sanitized it). It is stored and served as **data**: no model ever summarizes, rewrites, or renders it into prose on any path this phase owns (the confused-deputy class v4.0 closed for tool calls — Pitfall 2). Size is bounded (episode content is already 8KB-capped; an additional quote cap is planner discretion). The approver-side rendering rule ("show FROM→TO + raw quote, never narrative") is Phase 68's to enforce; this phase's job is that the data is there and verbatim.

### Claude's Discretion
- Exact column names/types, status vocabulary, expiry representation (D-02), and hash function/encoding (D-07) — semantics locked.
- Config knob name for enabling the SQLite sink (dark-knob convention locked).
- Whether `GET /v1/proposals` supports status filtering/pagination params in v1 (keep minimal; mirror /v1/surface's simplicity).
- Where the proposal store module lives (`src/db/proposal-store.ts` suggested, mirroring `surface-store.ts`) and the exact "belief moved on" comparison in D-10.
- Quote-slice selection (whole episode content vs relevant span) and any additional cap (D-12).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements & roadmap
- `.planning/REQUIREMENTS.md` — EMIT-01..07 (lines 52-62, including the section preamble locking the flat-triple/not-JSON-Patch shape and the seam pattern) 
- `.planning/ROADMAP.md` — Phase 66 entry (goal, success criteria) + the v10.0 preamble foundation-phase call (this phase owns the `action_proposal` table + sink foundation)

### v10.0 research (load-bearing for this phase)
- `.planning/research/SUMMARY.md` — "Phase 6: Proposal Emit Seam Wiring" section (recommended field set, same-transaction prescription, never-contradict_hold, the named D-43-for-proposals CI-grep sentinel; note: routes/contract marked "skip research-phase — mirrors /v1/surface + T-SEC discipline verbatim")
- `.planning/research/PITFALLS.md` — Pitfall 2 (confused-deputy: structured fields + raw quote, never narrative — EMIT-06's source); Pitfall 10 (contract over-engineering / jobfill-schema leakage — the domain-neutral claim IS the milestone); Pitfall 11 (schema_version now, not later); Pitfall 12 (idempotency/replay — reuse proven discipline, no third bespoke mechanism); Pitfall 13 (stale proposals); Pitfall 7 (never emit on contradict_hold)

### Upstream phase context (decisions this phase consumes)
- `.planning/phases/65-belief-gated-status-drift-provenance-distinctness-fix/65-CONTEXT.md` — D-13 (decisive-only emission seam established there; sentinel extends here)
- `.planning/phases/65-belief-gated-status-drift-provenance-distinctness-fix/65-HUMAN-UAT.md` — the three open founder items; none block this phase, and this phase must not flip the distinctness knob
- `.planning/phases/64-entity-resolution-hardening/64-CONTEXT.md` — D-07/D-08 (resolved-entity pair this phase carries into the proposal; node-id-not-a-stable-FK caveat goes in Phase 67's docs)
- `.planning/phases/63-offline-intent-classification/63-CONTEXT.md` — D-06 (coarse confidence vocabulary, no raw numerics), D-13 (the online LLM-free regression this phase extends to /v1/proposals)

### Code seams (live source is source of truth)
- `src/consolidation/sink.ts` — `ConsolidationSink` interface (:91), `SQLiteConsolidationSink` (:99), `NoopConsolidationSink` (:130-133) — the exact seam pattern to mirror
- `src/consolidation/status-drift.ts` — `EMISSION_ELIGIBLE_EVENT_TYPES` (:180), `isEmissionEligible` (:186) — import, never re-derive
- `src/consolidation/consolidator.ts` — `applyDecision` (:1276) and its `sink.emit` sites (:1290, :1322, :1343, :1367, :1468, :1497); the intent/resolved-entity fields on `ClaimDecision`
- `src/db/schema.ts` — `SCHEMA_VERSION = 16` (:12 — this phase bumps to 17), `surfaced_event` DDL + CHECK style (:202-212), v9 migration comment pattern (:383-385), `uq_episode_source_external` dedup precedent (:246-253)
- `src/db/surface-store.ts` — the store-module shape `proposal-store.ts` mirrors
- `src/adapter/serve-cli.ts` — `GET /v1/surface` lock-free read (:401), `POST /v1/surface/seen` per-call lock (:433-505), auth invariants (T-12-03 :16, T-12-05 :18, D-16 :44-53)
- `tests/emission-hold-sentinel.test.ts` — 65's D-13 sentinel this phase extends to the real sink

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`ConsolidationSink` triad** (sink.ts): interface + Noop default + SQLite impl with constructor injection into `Consolidator` — the seam is a copy-adapt, not an invention.
- **`EMISSION_ELIGIBLE_EVENT_TYPES`** (status-drift.ts:180): Phase 65 exported this set specifically so this phase gates on it — `contradict_hold` exclusion comes for free and is already sentinel-tested.
- **`surfaced_event` + `SurfaceStore` + `/v1/surface`(+`/seen`)**: table conventions (CHECK'd status vocabulary, UNIQUE dedup, epoch-ms timestamps), store module shape, and route/lock/auth discipline — all three layers have a shipped model.
- **`uq_episode_source_external`** (schema.ts:246): the INSERT-dedup-by-natural-key precedent for D-07's deterministic id.
- **Phase 63/64/65 test patterns**: fail-if-called provider stubs (online LLM-free), whole-DB snapshot comparisons (payload-aware), planted-offender structural scans, mutation-check discipline.

### Established Patterns
- Sleep pass is the sole graph writer; proposal writes are operational-table writes (like `surfaced_event`), never node/edge writes.
- Online paths (serve routes) stay LLM-free — extended test coverage to /v1/proposals is mandatory, not optional.
- Convention-enforced invariants fail (twice-shipped self-confirmation class) — D-09's two-layer sentinel is structural.
- Additive-only migrations with guarded ALTERs; SCHEMA_VERSION bump; corpus consumers version-gate on it.
- Net-zero new runtime dependencies (hash via node:crypto).

### Integration Points
- `Consolidator` constructor — second sink injection beside `ConsolidationSink` (or a composed emitter; planner discretion on wiring shape, Noop-default locked).
- `applyDecision` decisive branches — the ONLY emission call sites.
- `serve-cli.ts` request router — two new authenticated routes beside /v1/surface.
- `recense-doctor`/init surface — if the sink gains a config knob, doctor should know it exists (planner discretion, minimal).
- Downstream (not this phase): Phase 67 consumes the HTTP contract and writes `docs/reference-client.md` §; Phase 68 adds `kind:'belief'` handling to the Telegram client and enforces the approval-rendering rule.

</code_context>

<specifics>
## Specific Ideas

- The domain-neutral claim IS the differentiator this milestone exists to prove (Pitfall 10): if `proposed_change` ever grows a jobfill-shaped field, the milestone's thesis is falsified. When in doubt, leave it out of the contract.
- "recense never writes a consumer's database" has a mirror: a consumer never writes recense's beliefs. EMIT-05's sentinel is the mirror's lock, and it must be named "D-43-for-proposals" verbatim so the lineage to D-43 and v9.0's C-2 stays greppable.
- A held update produced no proposal in Phase 65 by construction; this phase must keep that true under the real sink — the sentinel extension is the proof, not the intention.

</specifics>

<deferred>
## Deferred Ideas

- Reference consumer adapter (`clients/proposal-reference/`), import-boundary test copy, `docs/reference-client.md` contract section — Phase 67 (CONSUME-01..03).
- Telegram `kind:'belief'` extension, per-entity-per-day batching, hold-exclusion on the approval surface, approval-rate self-report, FROM→TO tap-target rendering rule — Phase 68 (APPROVE-01..04).
- `provenanceDistinctnessEnabled` ENABLE/HOLD + WR-01/WR-03 resolutions — open founder items in 65-HUMAN-UAT.md; untouched by this phase.
- Proposal push/notification delivery (beyond pull-based GET) — no requirement this milestone.

### Reviewed Todos (not folded)
All four pending todos matched at score ≥ 0.4 on generic keywords only (`model`, `neutral`, `phase`, `status`) — the same keyword-noise set Phases 63/64/65 reviewed. None folded:
- `2026-06-23-cache-constant-judge-extraction-prompt-prefix-via-system-pro.md` (0.6) — prompt caching; this phase adds no prompts (seam is LLM-free). Stays pending.
- `corpus-brain-3d-transition.md` (0.6) — viz; unrelated. Stays pending.
- `content-hardening-deferred.md` (0.4) — gmail prompt coverage; unrelated. Stays pending.
- `viz-search-and-hull-quality.md` (0.4) — viz; unrelated. Stays pending.

</deferred>

---

*Phase: 66-Domain-Neutral Proposal Emit Seam*
*Context gathered: 2026-08-03*
