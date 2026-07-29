# Project Research Summary

**Project:** recense v10.0 "Action Proposals"
**Domain:** Extending a mature (9-milestone, ~2700-test) TypeScript memory engine with email-triggered belief updates and a domain-neutral producer/consumer proposal contract (context-layer-proposes / system-of-record-confirms split)
**Researched:** 2026-07-29
**Confidence:** HIGH overall

## Executive Summary

v10.0 is overwhelmingly a reuse-and-extend milestone. All four research passes converge: net-zero new runtime dependencies, and every one of the seven target features rides an existing seam — the per-episode gmail extraction call, PE-gated three-way reconsolidation, the ConsolidationSink/surfaced_event/v1-surface pattern, and StoredProposal/Telegram HITL machinery. Two of PROJECT.md's open discuss-phase questions are answered decisively: entity identity should be descriptor-based (recense emits its own stable node reference plus a human-readable descriptor; the consumer's adapter owns the match into its own ID space), and the proposal contract should be a flat semantic field/from/to triple in recense's own vocabulary, not JSON Patch.

Two live-code-verified findings reshape what two target features can deliver and must be treated as milestone-shaping constraints. First, Gmail's users.history.list has no `q` parameter, only `labelId` — per-account query scoping only bounds an account's initial backfill; every incremental pull after that fetches all new mail regardless of the configured query. Second, every Gmail episode shares the literal `session_id: 'ingest:gmail'`, so `countDistinctProvenance`/`contradictionN` can never fire on email-only evidence — the milestone's own stated mechanism ("email earns confidence through consolidation volume") is mathematically unreachable as currently wired, and a naive message-id fix opens a forwarded/quoted-thread farming attack.

The single largest new correctness risk is a "D-43-for-proposals" self-confirmation vector: a proposal derives from a belief the sleep pass already wrote before a human sees it; approval must never write back into `node.s`/`node.c` or re-enter as elevated-trust evidence, or the engine reopens — a third time — the exact defect class already caught once pre-launch and once live (v9.0 C-2). No existing test covers this path. Also carried forward: two anti-features to reject (ATS sender-domain fingerprint tables, which Greenhouse's own whitelabeling silently breaks; raw numeric LLM confidence shown to users, which peer-reviewed research shows is undetectably miscalibrated) and the finding that no competitor publishes a methodology-disclosed accuracy number for this feature class — recense has no external bar to cite.

## Key Findings

### Recommended Stack

Net-zero holds — zero new runtime dependencies for all of v10.0, verified against live source and current external docs. `googleapis` (^173.0.0) already provides OAuth2 primitives for account-N onboarding; `better-sqlite3`'s additive-migration pattern (proven twice: `token_usage_ledger`, `surfaced_event`) is the cheap path for a new `action_proposal` table; the `claude -p` headless transport is a generic feature-tag-distinguished seam, so intent classification/entity resolution are new prompts, not new infra; `zod` is already used at an HTTP boundary; `node:http` builtin covers the OAuth loopback catcher.

What to avoid: the `open` npm package (ESM-only, project is CJS), any HTTP framework for the OAuth catcher, a device-code OAuth client type, reusing `node`/`episode` tables with a type tag for proposals (forces a CHECK-constraint table-rebuild and risks polluting embedding/decay/candidate-gen machinery), a file-based JSON proposal store, any new schema-validation library.

### Expected Features

Must have (table stakes, per PROJECT.md's fixed scope): sleep-pass intent classification extending the existing gmail extraction call; internal entity resolution exposed as a stable reference + descriptor; status-vocabulary mapping onto the existing supersedes/PE-gate mechanism; domain-neutral action_proposal table/endpoint (sibling of /v1/surface); in-repo reference consumer adapter; kind:'belief' branch on the existing Telegram HITL flow.

Anti-features to reject: a maintained ATS sender-domain fingerprint ruleset (Greenhouse whitelabeling breaks it); real-time/webhook-triggered classification (contradicts the sleep-pass invariant); a wide status/intent taxonomy beyond the four scoped states; a standalone numeric confidence-threshold slider parallel to PE-gating; showing raw numeric confidence to users (arXiv 2402.07632: undetectable miscalibration, increases inappropriate reliance); auto-approving high-confidence proposals.

Notable absence as a finding itself: no consumer job-tracker or CRM publishes a methodology-disclosed accuracy number for email-to-status classification.

### Architecture Approach

Every architectural question resolves onto an existing seam, verified against live source. Intent classification rides the same `provider.generate()` call gmail episodes already make — three new optional ExtractedClaim fields threaded exactly like TEMP-02's due_at/action_type, zero net-new LLM calls. Belief-gated status lifecycle needs no new data model: an ordinary fact node, existing candidate generation, and the existing `routeContradiction()` PE-gate IS the differentiator, unmodified. The proposal-emit seam is a new `ActionProposalSink` interface (Noop-default, mirrors `ConsolidationSink`) writing to a wholly-additive `action_proposal` table, read/acked over new routes mirroring `/v1/surface` exactly, gated on `claimIntentEntity !== undefined` and firing on confirm/extend/reconcile/force-destabilize — never on `contradict_hold`. The reference adapter lives at `clients/proposal-reference/`, a structural sibling of `clients/telegram/` needing its own import-boundary test copy. Telegram's second proposal kind is a `kind` discriminator on `StoredProposal` — `proposal-store.ts` and `proposal-engine.ts` need zero code changes.

Major components: (1) intent classification (extend extraction), (2) action_proposal table + ActionProposalSink, (3) entity resolution hardening, (4) belief-gated status drift + provenance-distinctness fix, (5) emit seam wiring + HTTP routes, (6) reference adapter, (7) Telegram kind extension.

### Critical Pitfalls

1. HTML-only emails hand raw hidden markup to the classifier — GmailAdapter's fallback returns raw HTML when no text/plain part exists; hidden display:none content is invisible to the human but present in the classifier's token stream. Fix: deterministic HTML/hidden-content stripping at the redactSecrets boundary, applied unconditionally, before classification is enabled.
2. The classifier's own narrative becomes a confused deputy — v4.0's injection hardening is schema-shaped; the belief-shaped payload is free text, so hidden instructions can make the approval message lie without touching any validated field. Fix: proposal must carry the raw quoted evidence verbatim alongside the structured field/from/to, rendered together, never LLM prose alone.
3. session_id 'ingest:gmail' collapses all email provenance into one bucket — countDistinctProvenance can never fire on email-only evidence; the naive fix (message-id as key) opens a forwarded/quoted-thread farming attack. Fix: derive distinctness from sender identity + thread lineage with quoted content stripped first — needs its own deliberate design and test, a hard prerequisite for the differentiator to function as claimed.
4. Entity resolution with no abstain path silently corrupts an external system of record — dense-cosine-only matching cannot separate near-duplicate entity names. Fix: mirror v9.0's RECON broadened candidate generation and enforce a confident-or-null contract (D-02 pattern) — never a best-available guess.
5. Out-of-order backfill evidence can silently revert a newer status — reopens the exact tradeoff v9.0 explicitly deferred (bi-temporal). Lightweight fix: wire the already-read but unused Date: header through as event_ts and sort fresh-account backfill batches chronologically.
6. The self-confirmation guard is a checkpoint, not a schema property (the D-43-for-proposals risk) — if classification is coded as an independent scan rather than a branch inside the existing consolidator loop, it will not automatically inherit the source==='hitl' exclusion. The approve/reject route must write only action_proposal.status, never node.s/node.c, and the reject-path behavior must be a deliberate documented decision. Highest-priority pitfall — this is the exact defect class shipped twice before (a pre-launch critical finding, and v9.0's live finding C-2).
7. Approval fatigue compounds at multi-inbox volume — low-stakes-feeling status proposals are paradoxically more likely to be rubber-stamped. Fix: batch same-entity same-day proposals, never surface contradict_hold as a proposal, show the concrete from-to transition on the tap target.
8. Per-account gmail.query scoping does not filter ongoing incremental pulls — history.list has no q parameter, verified in live code; query narrowing only bounds the initial backfill.

## Implications for Roadmap

### Phase 1: Multi-Inbox Email Ingest Hardening
Rationale: zero dependency on anything else; must land before content from this path reaches an LLM classifier, closing the injection surface the new consumer would otherwise inherit.
Delivers: guided account-N OAuth onboarding CLI (loopback flow, zero new deps); googleAccounts[].query config shape (optional, backward-compatible fallback to global gmail.query); account-aware consolSkipThresholdBySource/sourceWeights keying; deterministic HTML/hidden-content stripping; event_ts wired from the Date: header with chronological sort on fresh-account backfill.
Addresses: "Multi-inbox email ingest completed."
Avoids: Pitfalls 1, 8, 14, 16, and half of 5.
Flag: explicitly decide (discuss-phase) whether per-account query scoping is accepted as backfill-only (zero new code, lean on existing gmail source-weight dampening) or hardened via labelId-based narrowing (extra work, one-time label-resolution call).

### Phase 2: Proposal Schema & Sink Foundation
Rationale: zero dependency on anything else; freezes the table shape both later workstreams need to agree on.
Delivers: additive action_proposal table (v16 migration, no CHECK-enum to extend later); ActionProposalSink interface + Noop default mirroring ConsolidationSink.

### Phase 3: Offline Intent Classification
Rationale: can start alongside Phase 2, needing only the already-proven TEMP-02 extraction-threading pattern; this is where research says the genuinely deep new work concentrates.
Delivers: new optional ExtractedClaim fields (intent_entity, proposed_change, intent_confidence) threaded through ClaimDecision, extending the existing gmail extraction prompt — zero net-new LLM calls. Must be implemented as a branch inside the existing per-episode consolidator loop (after the existing hitl hard-stop), not an independent scan.
Addresses: "Offline intent classification on event episodes."
Avoids: Pitfall 6's guard-inheritance risk (first re-entry point), Pitfall 15 (second-sequential-LLM-call cost regression).

### Phase 4: Entity Resolution Hardening
Rationale: depends on Phase 3's classifier output; near-total reuse of v9.0's candidate generation.
Delivers: broadened candidate generation (exact/BM25/dense union, never dense-only); confident-or-null resolution contract; resolved entity exposed as a stable internal reference plus human-readable descriptor.
Addresses: "Entity resolution against a canonical entity list" — resolves the PROJECT.md open question: recense never mirrors or live-queries the consumer's ID space; it resolves against its own graph and emits a fuzzy descriptor, the consumer's adapter owns the match.
Avoids: Pitfall 4.

### Phase 5: Belief-Gated Status Drift + Provenance-Distinctness Fix
Rationale: depends on Phases 3 and 4; makes the differentiator claim actually true; must include a validation spike against real multi-inbox traffic before Phase 6 wires live consumers.
Delivers: status transitions riding the existing unmodified PE-gated routeContradiction()/supersedes machinery (no new data model, no forced bi-temporal work); redesigned provenance-distinctness key requiring sender-identity + thread-lineage independence with quoted content stripped first; classifier-side lifecycle-lattice awareness (out-of-order/stage-skipping transitions lower confidence rather than requiring new engine gating).
Addresses: "Belief-gated status drift" — the differentiating requirement.
Avoids: Pitfall 3 (flagged in synthesis priorities), Pitfall 5's routing-decision half, Pitfall 9.
This phase cannot ship without the provenance-distinctness fix landing as its own explicit, tested design decision.

### Phase 6: Proposal Emit Seam Wiring
Rationale: depends on Phases 2, 3, 4, 5 (needs validated gating semantics before wiring real emission); forks into two workstreams (emission logic, HTTP surface) that only need to agree on the frozen table shape.
Delivers: ActionProposalSink wired into applyDecision's confirm/extend/reconcile/force-destabilize branches (never contradict_hold), inside the same transaction as the graph write it describes; GET /v1/proposals and POST /v1/proposals/:id/{approve,reject} mirroring /v1/surface; recommended field set {id, kind:'belief', entity:{recense_node_id, descriptor}, proposed_change:{field, from, to}, evidence_episode, confidence, schema_version, createdAt, maxTtlMs}; deterministic idempotent proposal id; stale/superseded-proposal check before an approved proposal applies.
Implements: the domain-neutral proposal emit seam — resolves the PROJECT.md open question on contract shape: a flat semantic triple in recense's own vocabulary, not JSON Patch.
Avoids: Pitfalls 2, 10, 11, 12, 13.
A named "D-43-for-proposals" sentinel test must be added here: CI-grep-verify the approve/reject routes contain zero UPDATE node SET s/SET c statements — this is the single largest new correctness risk in the milestone and this phase must close it structurally, not just document it.

### Phase 7: Reference Consumer Adapter
Rationale: depends on Phase 6 (needs a stable versioned HTTP contract); parallel-safe with Phase 8.
Delivers: clients/proposal-reference/, structurally a sibling of clients/telegram/ with its own tsconfig and its own import-boundary test copy; calls only the proposal routes, never an engine import; a new docs/reference-client.md section.
Addresses: "Reference consumer adapter (in-repo)."

### Phase 8: Telegram HITL Belief-Kind Extension
Rationale: depends on Phase 6; parallel-safe with Phase 7; cheapest phase in the milestone.
Delivers: kind:'belief' addition to StoredProposal's discriminated union; new poll function calling listProposals(); one new branch in handleProposalAction (no validateProposal call needed); per-entity-per-day batching; contradict_hold events never surfaced; approval-rate self-report; explicit short-circuit on "edit" for belief-kind.
Addresses: "Human-in-the-loop approval for belief-shaped proposals."
Avoids: Pitfall 7 (batching/hold-exclusion as first-version scope); closes the second re-entry point of Pitfall 6 (reject-path decision must be made and tested here) and its sharpest form (approval-write isolation on the Telegram side).

### Phase Ordering Rationale

Phases 1 and 2 have zero mutual dependency and start immediately. Phase 3 needs only the proven TEMP-02 pattern, so it starts alongside 1/2. Phase 5's validation spike gates Phase 6 deliberately — cheaper to fix a threshold or the provenance-distinctness key before any consumer depends on the emission stream than after. Phases 7 and 8 are independent consumers of one finished contract (Phase 6) and can run in parallel. The two live-code-verified constraints (Gmail query-scoping is backfill-only; session_id collapse blocks provenance-distinctness) are placed in the phases where they are load-bearing (1 and 5) rather than deferred as footnotes, because both directly gate whether their owning target feature behaves as PROJECT.md currently describes it.

### Research Flags

Needs deeper research/design during planning:
- Phase 3: the classification prompt itself and the domain-mapping of "what job-status evidence maps onto PE magnitude" is where the genuinely deep new work concentrates — budget research-phase time here.
- Phase 5: the provenance-distinctness key redesign is a deliberate change to a load-bearing correctness mechanism — needs its own design decision and dry-run against real multi-email status threads before enabling live.

Standard, directly-reusable patterns (skip research-phase):
- Phase 2 (mirrors ConsolidationSink/surfaced_event verbatim), Phase 4 (mirrors v9.0 RECON + D-02 pattern verbatim), Phase 6's contract/routes (mirrors /v1/surface + T-SEC discipline + existing dedup shape verbatim), Phase 7 (mirrors clients/telegram/'s structural contract verbatim), Phase 8 (proposal-store.ts and proposal-engine.ts need zero code changes).

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Verified against live-read source and current external docs fetched this session, not training-data recall. |
| Features | MEDIUM | HIGH for architecture/contract-shape findings (grounded in specs plus recense's own shipped code); LOW-MEDIUM for consumer-product behavior claims (no published methodology anywhere, explicitly labeled); MEDIUM for confidence-threshold/UX findings (peer-reviewed but general-AI, not domain-specific). |
| Architecture | HIGH | Every recommendation traces to live-read source, including confirming what does NOT need to change. |
| Pitfalls | HIGH | Codebase-specific claims are grep/read-verified; external claims are WebSearch-sourced and explicitly marked MEDIUM or HIGH depending on corroboration. |

Overall confidence: HIGH. The two findings that most change scope (Gmail query-scoping limits, session_id provenance collapse) are both verified directly against live code, not inferred.

### Gaps to Address

- Reject-path behavior is genuinely undecided: does rejecting a belief-shaped proposal correct recense's own graph, do nothing, or write a source:'hitl' audit episode for later manual correction? Must be decided explicitly and tested in Phase 8 planning, not left implicit.
- Query-scoping enforcement depth (backfill-only vs. labelId-hardened) is a real discuss-phase tradeoff, not fully closed by research — the phase plan must pick one explicitly.
- No external accuracy bar exists for this feature class — plan and phase-gate against recense's own honest internal measurement, not a claimed competitive number.
- Confidence-field calibration against real outcomes cannot happen yet — correctly deferred to v10.x, not a v10.0 gap to force-close.

## Sources

### Primary (HIGH confidence)
Live source read directly: src/lib/config.ts, src/source/gmail-adapter.ts, src/adapter/ingest-cli.ts, src/adapter/recense-init.ts, src/db/schema.ts, src/db/surface-store.ts, src/model/claude-headless-client.ts, src/model/claim-extractor.ts, src/source/extraction-prompts.ts, src/model/typed-predicates.ts, src/consolidation/consolidator.ts, src/consolidation/update-decision.ts, src/consolidation/sink.ts, src/adapter/memory-ops.ts, src/adapter/serve-cli.ts, src/source/source-adapter.ts, clients/telegram/proposal-engine.ts, clients/telegram/proposal-store.ts, clients/telegram/types.ts, clients/telegram/index.ts, clients/telegram/tsconfig.json + tests/import-boundary.test.ts, docs/reference-client.md, .planning/ARCH-REVIEW.md, .planning/PROJECT.md.
External: Gmail API users.history.list reference (developers.google.com), Google OAuth native-app guide, CloudEvents spec v1.0.1, JSON Patch vs Merge Patch (Zuplo/erosb), Greenhouse no-reply email support docs, arXiv 2402.07632 (miscalibrated AI confidence).

### Secondary (MEDIUM confidence)
MDM/golden-record sources (Semarchy, D&B, Tilores) grounding descriptor-based entity resolution; n8n HITL docs; 2026 indirect-prompt-injection sources (Unit42, Cloud Security Alliance, Microsoft, Securance/OWASP); HITL automation-bias/approval-fatigue sources (HackerNoon, nhimg.org, Encyclopedia of Agentic Coding Patterns).

### Tertiary (LOW confidence, not adopted as numbers)
Consumer job-tracker feature-description pages (Simplify, JobShinobi, Sorce) — qualitative only; workforceplaybook.ai confidence-threshold guide — cited only to characterize flawed common practice, not adopted.

---
*Research completed: 2026-07-29*
*Ready for roadmap: yes*
