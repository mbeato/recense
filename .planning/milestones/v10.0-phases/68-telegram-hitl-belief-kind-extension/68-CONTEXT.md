# Phase 68: Telegram HITL Belief-Kind Extension - Context

**Gathered:** 2026-08-03 (auto mode — decisions are the recommended defaults, grounded in the roadmap's locked success criteria, research SUMMARY Phase 8 + Pitfall 7, and the live clients/telegram scout; audit trail in 68-DISCUSSION-LOG.md)
**Status:** Ready for planning

<domain>
## Phase Boundary

A user approves or rejects a **belief-shaped** proposal from the same Telegram surface already used for tool-call approvals — with the concrete `from → to` transition visible on the decision itself — without rubber-stamping becoming the path of least resistance as multi-inbox volume grows. Belief-kind is a `kind` discriminator on the existing `StoredProposal` union that bypasses the client-side LLM tool-mapping step while reusing the existing expiry and rate-cap machinery, with **zero changes to `proposal-engine.ts` or `proposal-store.ts`** (APPROVE-02, locked verbatim in the roadmap SC). Same-entity same-day proposals batch into one prompt; held updates are never surfaced (APPROVE-03). Raw numeric confidence is never shown and never a programmatic gate — the PE gate is the only gate (APPROVE-04).

All work lives in `clients/telegram/` (+ its tests) — outside the engine, behind the (now-hardened) import-boundary guard. The client consumes only the Phase 66 HTTP contract (`GET /v1/proposals`, `POST /v1/proposals/:id/approve|reject`) the way Phase 67's reference adapter proved.

Out of phase: any engine/serve change (the contract is frozen); the reference adapter (67, done); entity-anchored recall (69); the 65-HUMAN-UAT founder items (still open, untouched).

Hard prerequisite satisfied: Phase 66 complete (verification 5/5) and Phase 67's consumer pattern shipped (incl. refusal semantics: 404/409/503 typed refusals, terminal statuses durable).

</domain>

<decisions>
## Implementation Decisions

### Union extension & zero-fork constraint (APPROVE-02)
- **D-01:** `kind: 'belief'` is added to the `StoredProposal` discriminated union in `clients/telegram/types.ts` (existing members keep their current shape; if the union currently has no `kind` field, the existing member gets its literal kind and belief gets `'belief'` — planner reads the live union first). **`proposal-engine.ts` and `proposal-store.ts` change ZERO lines** — the roadmap SC states this literally; the store already persists opaque `StoredProposal`s and the cap/expiry machinery (`isExpired`, the `cap: {date, count}` doc) is shape-agnostic. If the planner finds this impossible without touching those files, STOP and surface it — do not quietly fork.
- **D-02:** Belief-kind **bypasses the LLM tool-mapping step entirely**: no `validateProposal` call (there is no tool to map — the action is a fixed HTTP approve/reject). The dispatch branch keys on `kind === 'belief'` BEFORE any engine/LLM-adjacent path. The `edit` action **short-circuits explicitly** for belief-kind with a clear "belief proposals can only be approved or rejected" reply (research SUMMARY names this; editing a belief proposal is Phase-66-forbidden consumer-side belief authoring).

### Poll/bridge shape (APPROVE-01)
- **D-03:** A new poll function (own tick + own in-flight guard per the index.ts "never share" rule at :34-44) calls `GET /v1/proposals` over the serve surface (Bearer from env, memory-client.ts factory conventions) and converts pending server proposals into `StoredProposal{kind:'belief'}` rows: local dedup keys on the server's deterministic proposal `id` (a re-listed proposal must not mint a second Telegram prompt), TTL derived from the server record's expiry so the existing expiry machinery does the aging, and entry through the existing ≤3/day rate-cap counter (belief prompts COUNT toward the cap — fatigue is fatigue).
- **D-04:** Approve/reject callbacks POST to `/v1/proposals/:id/approve|reject` and handle every refusal per the Phase 67-documented semantics: 409-class (stale/superseded/expired/not-pending) → update the Telegram message to say the belief moved on / proposal lapsed, mark the local row terminal, never retry. 503 (lock contention) → leave pending, retry next tick. The proposal id is shape-validated (`^[0-9a-f]{64}$`) before path construction (67's WR-04 lesson, same fix).

### Decision-surface rendering (APPROVE-01, APPROVE-04, Pitfall 2/7)
- **D-05:** The decision message renders **structured fields only**: entity descriptor, the concrete `from → to` transition **on the tap targets themselves** (e.g. buttons labeled with the transition, not a bare "Approve" — v4.0 D-09: a fixed generic button becomes a conditioned reflex), and the `evidence_quote` rendered verbatim as clearly-fenced data. **No model prose anywhere on the approval surface** (Pitfall 2 — the confused-deputy class stays closed). `change_from` is a verbatim sentence and `change_to` a status token (the documented asymmetry) — render both as-is; never normalize or paraphrase.
- **D-06:** **No numeric confidence is ever rendered or gated on** (APPROVE-04). The coarse categorical (`high|medium|low`) MAY be shown as plain text at planner discretion, but no threshold logic anywhere in the client keys on confidence — the PE gate upstream is the only gate. A structural test greps the client for confidence-comparison logic (absence proof).

### Batching + hold exclusion (APPROVE-03, Pitfall 7)
- **D-07:** Same-entity same-day pending proposals collapse into **one** Telegram prompt: latest-known transition headlined, all constituent proposals listed with their evidence quotes, one approve/reject decision per constituent (or a compact per-item keyboard — planner discretion), never 4 separate prompts for 4 emails about one application. Batch identity = `entity_descriptor` + local calendar day.
- **D-08:** Held updates are never surfaced — guaranteed twice: upstream (Phase 66: `contradict_hold` is structurally unreachable from emission; the sink never writes a proposal for a hold) and client-side (only server-status-pending proposals are listed/bridged; the client never invents surfacing). A sentinel test asserts the poll path surfaces nothing when the server list is empty — no synthetic/hold-derived prompts exist by construction.
- **D-09:** **Approval-rate self-report** (Pitfall 7's cheapest defense): the client tracks approve/reject/refused counts for belief-kind in its existing state file and periodically appends a one-line self-report to a decision message (e.g. monthly or every Nth decision: "belief proposals this month: 12 approved / 0 rejected"). A ~100% approval rate over a long window is a signal the human stopped reading — the stat makes drift visible. Exact cadence/wording planner discretion; the counter and its surfacing are required.

### Verification approach
- **D-10:** Tests live in `clients/telegram/tests/` (scanned by the hardened import-boundary guard — so stub-server/fixture-only, zero engine imports) plus, if an end-to-end against the real serve surface is wanted, a repo-level test following `tests/proposal-reference-e2e.test.ts`'s harness. Must cover: union round-trip through the UNTOUCHED store (belief proposal persists/expires/caps via existing machinery), tool-mapping bypass (fail-if-called stub on the LLM mapping path), edit short-circuit, refusal handling (409 terminal + message update), batching (3 same-entity same-day → 1 prompt), no-numeric-confidence structural grep, and the zero-diff lock: `git diff --stat` empty for `proposal-engine.ts` and `proposal-store.ts` asserted in the plan's verification.

### Claude's Discretion
- Exact union/kind literal names for existing members; poll cadence constant; batch keyboard layout; self-report cadence/wording; whether coarse confidence text is shown; message formatting details (within D-05's structured-only lock).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements & roadmap
- `.planning/REQUIREMENTS.md` — APPROVE-01..04 (lines 76-79, incl. the arXiv-grounded APPROVE-04 rationale)
- `.planning/ROADMAP.md` — Phase 68 entry (goal + the four locked SCs, incl. the zero-changes-to-engine/store constraint)

### v10.0 research (load-bearing)
- `.planning/research/SUMMARY.md` — "Phase 8: Telegram HITL Belief-Kind Extension" (kind discriminator, new poll fn, one new branch, batching, hold-exclusion, approval-rate self-report, edit short-circuit; "proposal-store.ts and proposal-engine.ts need zero code changes")
- `.planning/research/PITFALLS.md` — **Pitfall 7** (approval fatigue: per-entity-per-day batching + hold-exclusion are FIRST-version scope; FROM→TO tap targets; approval-rate stat; warning signs); Pitfall 2 (structured fields + raw quote, never narrative)

### Upstream phase context
- `.planning/phases/66-domain-neutral-proposal-emit-seam/66-CONTEXT.md` — the frozen contract (D-02/D-02a), refusal semantics (D-10), quote-is-data (D-12)
- `.planning/phases/67-reference-consumer-adapter/67-CONTEXT.md` + `docs/reference-client.md` §Proposal reference client — the documented consumer pattern this client follows (fail-closed rules, refusal table, id shape, needs_reconciliation precedent for resumed applies)

### Code seams (live source is source of truth)
- `clients/telegram/types.ts` — the `StoredProposal` union to extend
- `clients/telegram/proposal-store.ts` — READ-ONLY this phase (cap/expiry machinery to reuse; :4 doc, `isExpired` :115, cap doc)
- `clients/telegram/proposal-engine.ts` — READ-ONLY this phase (`validateProposal` :243 — the step belief-kind bypasses)
- `clients/telegram/index.ts` — tick/in-flight-guard discipline (:34-44 "never share" rule), respond loop, callback_query drain
- `clients/telegram/memory-client.ts` — HTTP client factory conventions (Bearer, timeouts, throw-on-non-2xx)
- `clients/telegram/state.ts` — where the approval-rate counters live
- `src/adapter/serve-cli.ts` (:517-605) — refusal statuses/details the client maps (consume-only)
- `tests/proposal-reference-e2e.test.ts` — repo-level e2e harness precedent
- `clients/telegram/tests/import-boundary.test.ts` — the hardened guard that scans everything this phase adds

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **StoredProposal store + cap/expiry** (proposal-store.ts): shape-agnostic persistence with daily cap and TTL — belief-kind rides it with zero changes.
- **Tick/in-flight-guard pattern** (index.ts:34-44): the documented per-loop guard discipline the new poll copies (never share guards between loops).
- **memory-client.ts**: HTTP factory with Bearer/timeout/error discipline; the proposal bridge mirrors it (67's proposal-client.ts is a second reference).
- **67's refusal-handling + id-validation code**: the exact consumer semantics, already documented in reference-client.md.

### Established Patterns
- Clients never import the engine — hardened guard scans all .ts incl. tests.
- Approval surfaces render structured fields + verbatim quote, never model prose (v4.0 D-09 + Pitfall 2 lineage).
- Fail-closed consumer posture (unknown schema_version → stop; unknown kind → skip; refusal → terminal).
- Convention-enforced invariants fail — zero-diff on engine/store files is asserted in tests, not promised.

### Integration Points
- `clients/telegram/index.ts` — new poll loop + callback branches beside existing surface/tool-proposal flows.
- `clients/telegram/state.ts` — approval-rate counters.
- Consumes `/v1/proposals` surface only; no shared files with any other phase (69 touches retrieval — zero overlap).

</code_context>

<specifics>
## Specific Ideas

- The tap target IS the safety mechanism: "interviewing → rejected" on the button forces a micro-read that a generic "Approve" never does. This is the cheapest honest defense against automation bias and it must survive any layout discretion.
- Warning signs from Pitfall 7 worth encoding as tests where cheap: >5 unbatched prompts/day for one entity would be a batching bug; a `contradict_hold`-derived message existing at all would be an upstream-invariant breach.

</specifics>

<deferred>
## Deferred Ideas

- Typed-confirm for destructive belief flips — rejected by research for this surface (habituated ritual); revisit only on measured incident.
- Edit/counter-proposal flows for belief-kind — deliberately short-circuited; consumer-side belief authoring is out of the milestone's thesis.
- 65-HUMAN-UAT founder items — open, untouched.
- Entity-anchored recall — Phase 69.

### Reviewed Todos (not folded)
Same four keyword-noise matches as 63-67. None folded; all stay pending.

</deferred>

---

*Phase: 68-Telegram HITL Belief-Kind Extension*
*Context gathered: 2026-08-03*
