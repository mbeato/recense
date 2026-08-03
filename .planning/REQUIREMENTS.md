# Requirements — Milestone v10.0 Action Proposals

**Defined:** 2026-07-29
**Core Value:** The memory learns and stays correct over time — it forms generalizations the user never explicitly stated, and when a fact changes it updates the right belief in place rather than surfacing a stale one.

**Goal:** recense ingests real events across both inboxes, decides *what changed* about a tracked entity as a belief, and emits domain-neutral action proposals that a separate system of record confirms — proving the context-layer-proposes / system-of-record-confirms split across a real product boundary.

**Grounding:** Promoted from ROADMAP backlog B-01 (captured 2026-07-29). Scoped after a 4-dimension research pass (`research/SUMMARY.md`, confidence HIGH) whose load-bearing findings were verified against live source, not inferred. Two of those findings contradicted the milestone as originally written and are reflected below (EMAIL-02, DRIFT-03). **Net-zero new runtime dependencies holds across the whole milestone.**

**Reuse posture:** v4.0 already shipped the *tool-shaped* half of this pattern and multi-account Gmail fan-out; v9.0 shipped broadened candidate generation. The genuinely new work is CLASSIFY → RESOLVE → DRIFT → EMIT. Requirements below deliberately name the existing seam each one rides so planning does not re-plan solved problems.

---

## v10.0 Requirements

### EMAIL — Multi-inbox email ingest

> Multi-account Gmail fan-out already ships (v4.0 TEMP-04, D-08/D-09/D-10): one `GmailAdapter` per `config.googleAccounts` entry, per-account `cursor:gmail:<id>`, `GOOGLE_<ID>_REFRESH_TOKEN`, `· Acct:` provenance. What's missing is the onboarding path and per-account scoping — plus two hardening items research found are prerequisites for feeding this content to a classifier.

- [x] **EMAIL-01**: User can authorize an additional Google account through a guided CLI flow that mints and stores `GOOGLE_<ID>_REFRESH_TOKEN` without hand-rolling OAuth. Loopback redirect (`http://127.0.0.1:<random>`), which is the current flow for the Desktop client type recense already uses — the OOB flow is dead. Uses existing `googleapis` OAuth2 primitives, `node:http`, and the existing `writeEnvFile` helper; no new runtime deps.
- [x] **EMAIL-02**: User can set a per-account Gmail query so each inbox scopes independently, **with the documented limitation that scoping applies to an account's initial backfill only** — `users.history.list` accepts no `q` parameter (verified against the live API reference), so incremental pulls are not query-filtered and rely on the existing gmail source-weight (0.35) + skip-threshold (0.4) dampening. The limitation is stated in the config doc comment and surfaced by `recense doctor` — never implied away.
- [x] **EMAIL-03**: HTML-only emails are deterministically stripped of markup and hidden content (`display:none`, zero-width characters, hidden spans) at the ingest boundary before any content reaches the extractor or classifier. Previously `extractBodyText`'s fallback handed raw HTML through, so hidden text invisible to a human was present in the model's token stream.
- [x] **EMAIL-04**: Each email episode carries an `event_ts` derived from the already-read `Date:` header, and fresh-account backfill batches are consolidated in chronological order — so a first-run backfill of a second inbox cannot apply old evidence over newer state.

### CLASSIFY — Offline intent classification

> The sleep pass decides whether an ingested episode implies a status change to a tracked entity. Research established this rides the **existing** per-episode extraction call (the `due_at`/`action_type` TEMP-02 threading pattern), so it costs zero net-new LLM calls — important, because a second per-episode call on the noisiest, highest-volume source would be a real cost regression against the measured ~7.1k tok/turn marginal write.

- [x] **CLASSIFY-01**: The sleep pass classifies whether a gmail episode implies a status change to a tracked entity, as optional fields on the existing extraction call — **no net-new LLM call per episode**.
- [x] **CLASSIFY-02**: Classification runs as a branch inside the existing consolidator per-episode loop, after the existing `source === 'hitl'` hard-stop, so it inherits that guard structurally rather than re-implementing it. A sentinel test proves `hitl` episodes are never classified. (If built as an independent episode scan it would silently *not* inherit the guard that closed D-43 and v9.0's C-2.)
- [x] **CLASSIFY-03**: Online paths (SessionStart inject, retrieval, `/v1/surface`, `/v1/proposals`) stay LLM-free — regression-tested. No classification on any hot path.
- [x] **CLASSIFY-04**: The status vocabulary stays narrow (the four scoped states), and no ATS sender-domain fingerprint table is introduced — sender domain may be a weak prior into the model's read, never a standalone routing table. (Greenhouse's own docs confirm companies whitelabel to their own verified domains, so a fingerprint table degrades silently.)

### RESOLVE — Entity resolution

> "Which tracked application/company/role is this email about." Research answered PROJECT.md's open question on canonical-list ownership: recense resolves against **its own** graph and emits a descriptor; it never mirrors or live-queries a consumer's ID space.

- [x] **RESOLVE-01**: Entity resolution uses broadened candidate generation (exact/entity-keyed + BM25 + dense union — reusing v9.0's RECON machinery), never dense-cosine alone, which structurally cannot separate near-duplicate entity names.
- [x] **RESOLVE-02**: Resolution is **confident-or-null**: when no candidate clears the bar it abstains and no proposal is produced, rather than emitting a best-available guess. A wrong-entity match would silently corrupt an external system of record.
- [x] **RESOLVE-03**: A resolved entity is emitted as recense's own stable node id **plus** a human-readable descriptor. recense never mirrors, imports, or queries the consumer's canonical ID space — the consumer's adapter owns the match into its own IDs.

### DRIFT — Belief-gated status drift

> **The differentiating requirement** — the reason this milestone belongs in recense and not in a script. Status transitions are beliefs, updated through the existing PE gate. Research confirmed this forces **no** new data model: v9.0's bi-temporal DEFER stands.

- [x] **DRIFT-01**: A status lifecycle (applied → interviewing → rejected → offer) is stored as an ordinary fact node and updated through the existing PE-gated `routeContradiction()` / tombstone / `supersedes` machinery — no new data model, no bi-temporal or supersedes-chain columns.
- [x] **DRIFT-02**: A single ambiguous email does not flip a status — the update holds until evidence clears the PE gate, and a held (non-decisive) update produces no proposal.
- [x] **DRIFT-03**: Provenance distinctness is derived from sender identity + thread lineage **with quoted/forwarded content stripped first**, so `countDistinctProvenance` can fire on genuinely independent email evidence *and* a forwarded or quoted thread cannot manufacture false independence. Today every Gmail episode shares the literal `session_id: 'ingest:gmail'`, so the distinct-provenance mechanism can mathematically never fire on email-only evidence — this is a hard prerequisite for DRIFT-02 to work as claimed, not an optimization.
- [x] **DRIFT-04**: Out-of-order evidence (a rejection arriving after an offer) does not silently revert a newer status.
- [x] **DRIFT-05**: Belief-correction accuracy on real multi-inbox traffic is measured honestly against recense's own harness before any consumer is wired live. **No external accuracy bar exists for this feature class** — no competitor publishes a methodology-disclosed number — so nothing is claimed that recense's own measurement does not show.

### EMIT — Domain-neutral proposal seam

> recense emits `{entity, proposed_change, evidence_episode, confidence}` and stops. Research established the shape (flat semantic `{field, from, to}` triple in recense's own vocabulary — **not** JSON Patch, which presupposes consumer-schema knowledge recense is forbidden to have) and the seam pattern (`ActionProposalSink`, Noop default, mirroring `ConsolidationSink` + the `surfaced_event`/`SurfaceStore`/`/v1/surface` precedent).

- [x] **EMIT-01**: Proposals are emitted through an `ActionProposalSink` with a **Noop default**, so an install with no consumer configured pays zero cost.
- [x] **EMIT-02**: A proposal is a flat, domain-neutral record — `{entity: {node_id, descriptor}, proposed_change: {field, from, to}, evidence_episode, confidence}` in recense's own vocabulary — containing **no consumer-specific fields**. recense never writes a consumer's database.
- [x] **EMIT-03**: A consumer can read pending proposals and record an outcome over the existing authenticated `recense serve` surface (`GET /v1/proposals`, `POST /v1/proposals/:id/approve|reject`), mirroring the shipped `/v1/surface` + `/v1/surface/seen` pattern.
- [x] **EMIT-04**: Proposal ids are deterministic, so a replayed, retried, or double-delivered proposal cannot be applied twice by a consumer.
- [x] **EMIT-05**: Approving or rejecting a proposal writes **only** proposal status — never `node.s` or `node.c` — proven by a named "D-43-for-proposals" sentinel test. A rejection marks the proposal rejected and leaves recense's belief untouched, to be corrected by ordinary reconsolidation when better evidence arrives (founder decision 2026-07-29). This is the milestone's largest new correctness risk: the codebase has shipped this exact self-confirmation defect class twice (a pre-launch critical finding, then v9.0's live C-2).
- [x] **EMIT-06**: A proposal carries its **raw quoted evidence verbatim** alongside the structured change, so an approver never decides based on model prose alone. Email content is attacker-controlled and the belief-shaped payload is free text, so hidden instructions could otherwise make an approval message lie without touching any validated field.
- [x] **EMIT-07**: A stale or superseded proposal is detected and refused before it applies.

### CONSUME — Reference consumer adapter

> Scope edge (founder decision 2026-07-29): recense ships the producer seam **plus a thin in-repo reference consumer** proving the contract end-to-end. The live jobfill integration is jobfill's own repo, later.

- [x] **CONSUME-01**: An in-repo reference consumer adapter reads proposals and maps them onto its own local rows, proving the contract works end-to-end without recense knowing its schema.
- [x] **CONSUME-02**: The reference adapter imports **no** engine module — enforced by its own tsconfig boundary and its own import-boundary test (the existing test only scans `clients/telegram/`).
- [x] **CONSUME-03**: The contract is documented well enough that a third-party consumer can be written against it, following the existing `docs/reference-client.md` adopter-template pattern.

### APPROVE — Human-in-the-loop approval

> Extends the shipped v4.0 Telegram machinery to a second proposal *kind*. Research confirmed `proposal-store.ts` needs **zero** code changes and `proposal-engine.ts` is bypassed rather than forked — the intent is engine-produced, so there is nothing for the client-side LLM mapper to do.

- [x] **APPROVE-01**: User can approve or reject a belief-shaped proposal from Telegram, with the concrete `from → to` transition visible on the decision itself.
- [x] **APPROVE-02**: Belief-kind proposals are a `kind` discriminator on the existing `StoredProposal` union: they bypass the client-side LLM mapping step while reusing the existing expiry and rate-cap machinery. No fork of `proposal-engine.ts` / `proposal-store.ts`.
- [x] **APPROVE-03**: Same-entity same-day proposals are batched, and held (non-decisive) updates are never surfaced — bounding approval fatigue, which compounds at multi-inbox volume and makes rubber-stamping the path of least resistance.
- [x] **APPROVE-04**: Raw numeric confidence is **not** shown to the user, and confidence is never the programmatic gate — the PE gate is. (arXiv 2402.07632: miscalibrated model confidence is undetectable by users and increases inappropriate reliance.)

---

## Future Requirements (deferred)

- **Confidence calibration against real outcomes** — the `confidence` field can only be calibrated once approve/reject outcome data exists. Correctly a v10.x follow-up, not a v10.0 gap.
- **labelId-based incremental query enforcement** — `history.list` does accept `labelId`, so per-account scoping *could* be enforced on incremental pulls via per-account Gmail labels. Deferred: costs per-account label setup and a narrower filter vocabulary; revisit if EMAIL-02's backfill-only scoping proves insufficient in practice.
- **Calendar ingest visibility** — `CalendarAdapter` exists and is already multi-account, gated behind `calendar.enabled: false`. Founder decision 2026-07-29: belongs as its own separate thing, the same way jobfill lives separately.
- **Live jobfill integration** — the real consumer adapter against the application tracker, in jobfill's own repo.
- **Additional event sources for proposals** (calendar, transcripts) — the seam is source-agnostic by construction; adding sources is config + prompt work once the contract is proven on email.

## Out of Scope

| Feature | Reason |
|---------|--------|
| recense writing the consumer's database directly | Violates the producer/consumer boundary this milestone exists to prove. recense emits an intent and stops; a consumer-owned adapter maps it. |
| JSON Patch (RFC 6902) as the `proposed_change` shape | Path-addressing presupposes knowledge of the consumer's document structure — exactly the coupling recense is forbidden to have. Flat semantic `{field, from, to}` instead. |
| A message bus / queue broker between producer and consumer | Over-engineering for a personal tool. B-01's own constraint: keep it dead simple. The existing authenticated HTTP surface suffices. |
| Mirroring or live-querying the consumer's canonical entity IDs | Couples recense to a foreign schema and creates a staleness problem. recense resolves against its own graph and emits a descriptor; the consumer owns the match. |
| ATS sender-domain fingerprint table (Greenhouse/Lever/Workday) | Greenhouse's own docs confirm companies whitelabel to their own verified domain, so a maintained fingerprint table degrades silently and is unbounded maintenance. Domain is a weak prior only. |
| Showing raw numeric LLM confidence to the user | arXiv 2402.07632: miscalibration is undetectable by users and increases inappropriate reliance. Confidence stays internal and is never the gate. |
| Auto-approving high-confidence proposals | Removes the human from a loop whose entire purpose is that a wrong belief cannot silently mutate a system of record. Also the only real mitigation for email-borne prompt injection. |
| Real-time / webhook-triggered classification | Contradicts the sleep-pass invariant — all LLM cost lives in the offline pass, online paths stay LLM-free. |
| Bi-temporal validity intervals / supersedes-chain columns | v9.0 measured this as DEFER (tombstone-always stands); research confirmed v10.0 does **not** force it. Backfill would require full table recreation. |
| A second per-episode LLM call for classification | Research showed classification threads onto the existing extraction call. A separate call is a real cost regression on the noisiest, highest-volume source. |
| Multi-tenancy / namespaces | Engine stays single-tenant (reaffirmed 2026-06-10). SEED-003 remains dormant; no trigger has fired. |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| EMAIL-01 | 62 | Satisfied |
| EMAIL-02 | 62 | Satisfied |
| EMAIL-03 | 62 | Satisfied |
| EMAIL-04 | 62 | Satisfied |
| CLASSIFY-01 | 63 | Complete |
| CLASSIFY-02 | 63 | Complete |
| CLASSIFY-03 | 63 | Complete |
| CLASSIFY-04 | 63 | Complete |
| RESOLVE-01 | 64 | Complete |
| RESOLVE-02 | 64 | Complete |
| RESOLVE-03 | 64 | Complete |
| DRIFT-01 | 65 | Complete |
| DRIFT-02 | 65 | Complete |
| DRIFT-03 | 65 | Complete |
| DRIFT-04 | 65 | Complete |
| DRIFT-05 | 65 | Complete |
| EMIT-01 | 66 | Complete |
| EMIT-02 | 66 | Complete |
| EMIT-03 | 66 | Complete |
| EMIT-04 | 66 | Complete |
| EMIT-05 | 66 | Complete |
| EMIT-06 | 66 | Complete |
| EMIT-07 | 66 | Complete |
| CONSUME-01 | 67 | Complete |
| CONSUME-02 | 67 | Complete |
| CONSUME-03 | 67 | Complete |
| APPROVE-01 | 68 | Complete |
| APPROVE-02 | 68 | Complete |
| APPROVE-03 | 68 | Complete |
| APPROVE-04 | 68 | Complete |

_Source of truth for the EMAIL-01..04 rows above: `62-VERIFICATION.md` (pass 6, 2026-08-02,
status `passed`) — future rounds must update the verification report and this table together,
not one without the other._

**Coverage:**
- v10.0 requirements: 30 total
- Mapped to phases: 30 ✓ (100%)
- Unmapped: 0

**Note on phase 66:** research's proposed standalone "Proposal Schema & Sink Foundation" phase (the `action_proposal` table + `ActionProposalSink`) was folded into Phase 66 rather than kept separate — it owns no REQ-IDs of its own (its deliverables are exactly EMIT-01/EMIT-02), and neither Phase 63 (CLASSIFY) nor Phase 64 (RESOLVE) touches that table. See `ROADMAP.md`'s "Phase Details — v10.0 Action Proposals" preamble for the full rationale.

---
*Requirements defined: 2026-07-29*
*Last updated: 2026-07-29 after v10.0 roadmap creation — Traceability populated (7 phases, 62–68), coverage 30/30 (100%).*
