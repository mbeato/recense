# Phase 65: Belief-Gated Status Drift + Provenance-Distinctness Fix - Context

**Gathered:** 2026-08-02 (auto mode — decisions are the recommended defaults, grounded in the v10.0 research pass, live-code scout, and the Phase 63/64 context chain; audit trail in 65-DISCUSSION-LOG.md)
**Status:** Ready for planning

<domain>
## Phase Boundary

A tracked entity's status lifecycle (applied → interviewing → rejected → offer) is stored as an **ordinary fact node** and updated **only** through the existing PE-gated `routeContradiction()` / tombstone / `supersedes` machinery — no new data model, no bi-temporal or supersedes-chain columns (DRIFT-01). A single ambiguous status email holds rather than flipping the belief, and a held (non-decisive) update produces nothing downstream (DRIFT-02). The provenance-distinctness key is **redesigned** so `countDistinctProvenance` becomes reachable on genuinely independent email evidence — derived from sender identity + thread lineage with quoted/forwarded content stripped first — while forwarded/quoted duplication cannot farm false independence (DRIFT-03). Out-of-order evidence during backfill cannot silently revert a newer status (DRIFT-04). Belief-correction accuracy is measured honestly against recense's own harness, and the new key is dry-run against real multi-email status threads, before Phase 66 wires any consumer live (DRIFT-05).

This phase consumes Phase 63's intent fields and Phase 64's resolved-entity fields on the in-memory `ClaimDecision`. It is the first phase in the chain permitted to touch ingest-side provenance (session_id minting / gmail adapter metadata); it still creates **no** `action_proposal` table and no sink (Phase 66's first task per the roadmap foundation-phase call).

Out of phase: `ActionProposalSink` / `action_proposal` table / `/v1/proposals` routes (Phase 66); consumer adapters (Phase 67); Telegram HITL surface, per-entity batching, approval-rate stats (Phase 68); full bi-temporal validity columns (v9.0 DEFER stands); entity-anchored ambient recall (Phase 69).

Hard prerequisites satisfied: Phase 63 complete (verification 4/4) and Phase 64 complete (verification 14/14, 2026-08-02) — classification + resolved entity thread through `ClaimDecision`.

**Research flag honored:** the provenance-distinctness key redesign is a deliberate change to a load-bearing correctness mechanism. The key's *semantics* are locked below; the *mechanism placement* carries a research-gated blast-radius audit (D-02), and enablement is gated on a dry-run against real multi-email status threads (D-14). This is a hard prerequisite for DRIFT-02, not an optimization.

</domain>

<decisions>
## Implementation Decisions

### Provenance-distinctness key — semantics (DRIFT-03, Pitfall 3)
- **D-01:** The distinctness key requires independence on **normalized sender identity + thread lineage** — the Pitfall 3 prescription, e.g. `(normalized-sender-domain, gmail-thread-id)`. **Never** raw message id / `external_id` as the key (PITFALLS "dangerous shortcuts" table: farmable via forwarded/quoted-thread duplication). Exact key composition (domain vs full address; whether accountId participates) is research-pass discretion within these locked components.
- **D-02:** **Mechanism placement — recommended default, research-gated:** mint a richer per-email `sessionId` at gmail ingest (`ingest-cli.ts:184-191`, today the literal `ingest:${r.source}`), e.g. `ingest:gmail:<derived-key>`, so `countDistinctProvenance`, `PendingContradiction` (`types.ts:14`), and `routeContradiction` stay **byte-identical** — the DRIFT-01 "machinery unmodified" spirit extended to DRIFT-03. **Hard gate:** the research pass MUST audit every `session_id` consumer (recall, eval/snapshot, scope attribution, consolidator batching — see grep list in code_context) for semantic breakage under per-thread granularity. If any consumer breaks, **fallback is locked:** add an optional `provenance_key` field to `PendingContradiction` entries (written at record time) and have `countDistinctProvenance` count `provenance_key ?? session_id` — a narrow, tested engine change. One of these two shapes; no third invention.
- **D-03:** Existing gmail episodes keep their historical `session_id` — no retroactive migration. Pending contradictions accumulated under the old collapsed id are acceptable startup state; the key redesign is forward-only. Document this as a named, accepted limitation.

### Thread lineage & sender capture (DRIFT-03)
- **D-04:** Thread lineage comes from Gmail's **server-assigned `threadId`** (already returned by the `messages.get` call the fetcher makes — capture is wiring, zero new API calls): extend `RawGmailMessage` (`gmail-adapter.ts:71`) and the fetcher to carry it. Do NOT reconstruct lineage from sender-controlled `References`/`In-Reply-To` headers.
- **D-05:** Sender identity = normalized domain (or address — research discretion per D-01) parsed from the `From:` header, treated as sender-controlled input: run `stripInvisibleCodepoints` + normalization before keying, mirroring the provenance-header discipline already in `normalizeGmailMessage`.

### Quoted/forwarded stripping for independence (DRIFT-03)
- **D-06:** A new **pure, deterministic, LLM-free** quoted/forwarded-content detector (`>`-quote lines, "On … wrote:" boundaries, forwarded-message markers), compile-once regex discipline mirroring `strip-hidden.ts`. It applies **only on the provenance/distinctness path** — the extractor's input, Phase 62's EMAIL-03 stripping, and the gmail prompt coverage stance (63's folded boundary) are untouched.
- **D-07:** Farming semantics: a message whose post-strip residual is empty/near-empty (pure quotation/forward) contributes **no independent provenance** — this is what stops 3 forwards of one thread from counting as 3 even when senders differ. The locked DRIFT-03 test: 3 genuinely independent status emails → distinct count 3; 3 copies of one forwarded/quoted thread → distinct count 1 (unit test directly on `countDistinctProvenance` inputs, per Pitfall 3's prescription).

### Status node shape + confidence consumption (DRIFT-01, DRIFT-02)
- **D-08:** Status is an **ordinary fact node** minted/updated through the existing claim pipeline — no new node type, no schema change, no bi-temporal columns. All belief movement goes through `routeContradiction()` at its existing call sites; `routeContradiction`, `isOscillation`, and the band thresholds are **not modified**.
- **D-09:** Phase 63's coarse confidence (`high|medium|low`) is consumed as a **dampener only** — it can hold or weaken a status claim's effect, never amplify one (extends the D-43 non-strengthening doctrine; consistent with backlog B-04's lower-only constraint). A `low`-confidence classification must not produce a decisive flip on its own. Exact mapping (e.g. gate-to-hold vs magnitude damping) is the research pass's central design question — flagged in ROADMAP as the phase's deep work alongside the key redesign.
- **D-10:** **Lifecycle-lattice awareness lives at the classifier/drift layer, never in the engine** (Pitfall 9's prescription): out-of-order or stage-skipping transitions (applied → offer with no interview; rejected → interviewing re-engagement) LOWER classification confidence via the existing vocabulary rather than adding new engine gating. The valid-transition lattice lives in the classifier prompt / drift layer, keeping the engine domain-neutral (Pitfall 10 discipline).

### Out-of-order / backfill protection (DRIFT-04, Pitfall 5)
- **D-11:** Two-part mechanism, no bi-temporal schema: (a) during query-backfill, sort the fetched batch by parsed `event_ts` before appending (closes the single-account backlog case — `orderEpisodesForConsolidation` from Phase 62 then keeps within-run order); (b) a **drift-layer `event_ts` guard**: a contradicting status claim whose `event_ts` is older than the current belief's most recent supporting evidence timestamp is dampened/held, not applied — consulted *before* the claim reaches routing, not by modifying `routeContradiction`. Where `event_ts` is null (undated evidence), fall back to current behavior and log it.
- **D-12:** Cross-run/cross-account interleaving beyond (a)+(b) is a **named, accepted, documented risk** this milestone (the honest-null convention per Pitfall 5's third bullet) — do not silently ship the gap, and do not smuggle in bi-temporal columns to close it.

### Held updates produce nothing downstream (DRIFT-02)
- **D-13:** The rule "only decisive outcomes may ever feed an emission point" is established structurally **in this phase**, before the sink exists: whatever seam Phase 66 will hook (the drift layer's output), a `contradict_hold` outcome must be unreachable from it. Sentinel test lands here: an ambiguous single email → hold → zero emission-point invocations; Phase 66 extends the same test to the real sink (PITFALLS Pitfall 7: never emit on `contradict_hold`).

### Measurement + enablement gate (DRIFT-05)
- **D-14:** **Dark-launch discipline:** the new distinctness key ships computing + logging (per-key counters mirroring 64's D-06 observability) behind a config knob defaulting to the old behavior, until a **dry-run against real multi-email status threads** (rejections, recruiter chains, ATS auto-notices from the founder's own inboxes) is reviewed. Enablement is a deliberate, recorded decision — the same caution class as `GMAIL_EXTRACTION_PROMPT` changes.
- **D-15:** Belief-correction accuracy is measured against **recense's own harness** (extend the `scripts/eval/` pattern), recorded honestly in the phase SUMMARY with methodology stated. **No external accuracy bar is cited — none exists for this feature class.** Nothing is claimed the measurement doesn't show. This must complete before Phase 66 wires any consumer live (roadmap gate).
- **D-16:** `contradictionNBySource` — an optional per-source override mirroring the shipped `consolSkipThresholdBySource` pattern (`config.ts:782`) — is adopted as a **dark knob**: default absent/3 (unchanged behavior), available because email's corroboration cadence (days) differs from Claude Code turns (minutes). Pitfall 3's suggestion, at planner discretion whether it lands this phase or is deferred with a stub note.

### Claude's Discretion
- Exact key composition within D-01's locked components (domain vs address, accountId inclusion, hashing/format of the derived session suffix).
- Exact confidence→damping mechanics within D-09's lower-only lock (research pass designs; planner encodes).
- Module placement/naming for the quote-stripper and drift layer; whether the drift logic is a standalone module or a consolidator branch (mirroring 64's D-01 seam reasoning).
- "Near-empty residual" threshold semantics for D-07.
- Whether D-16 lands now or as a stubbed follow-up.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements & roadmap
- `.planning/REQUIREMENTS.md` — DRIFT-01..05 (lines 46-50; DRIFT-03's text is the locked key-semantics statement)
- `.planning/ROADMAP.md` — Phase 65 entry (goal, success criteria, **research flag**: key redesign needs its own design decision + dry-run before live)

### v10.0 research (load-bearing for this phase)
- `.planning/research/PITFALLS.md` — **Pitfall 3** (the phase's defining pitfall: session_id collapse, the farmable-external_id trap, the sender+thread-lineage prescription, `contradictionNBySource`, warning signs/tests); **Pitfall 5** (out-of-order backfill, the lightweight event_ts compromise, the named-risk requirement); **Pitfall 9** (lattice awareness belongs in the classifier, not the engine); Pitfall 7 (never emit on `contradict_hold` — D-13's source); "dangerous shortcuts" table (external_id-as-key row)
- `.planning/research/SUMMARY.md` — "Phase 5: Belief-Gated Status Drift + Provenance-Distinctness Fix" section + Research Flags (Phase 5 bullet); Phase Ordering Rationale (why the validation spike gates Phase 66)

### Upstream phase context (decisions this phase consumes)
- `.planning/phases/63-offline-intent-classification/63-CONTEXT.md` — D-04/D-05/D-06 (4-state enum, all-or-nothing, coarse confidence with PE-mapping deferred **to this phase**), the hold-don't-flip specific, research directives on ambiguity→OMIT
- `.planning/phases/64-entity-resolution-hardening/64-CONTEXT.md` — D-07/D-08 (resolved-entity fields this phase consumes; node id NOT a stable FK), D-06 (observability counters precedent), the per-role granularity known-limit note

### Code seams (live source is source of truth)
- `src/consolidation/update-decision.ts` — `routeContradiction` (:45, NOT to be modified), `isOscillation` (:74), `countDistinctProvenance` (:90 — the mechanism the key feeds; D-19 inferred-exclusion it must preserve)
- `src/consolidation/consolidator.ts` — the four routing/distinct-count call sites (:1350, :1448, :1555, :1597), `ClaimDecision` (:151) with 63/64's intent + resolved-entity fields, the :643 hard-stop discipline
- `src/adapter/ingest-cli.ts` — the `sessionId: \`ingest:${r.source}\`` mint (:184-191) — D-02's primary edit site
- `src/source/gmail-adapter.ts` — `RawGmailMessage` (:71 — threadId capture site), `normalizeGmailMessage` (:490), provenance-header sender-controlled-input discipline (:497-529)
- `src/source/strip-hidden.ts` — compile-once regex discipline + `stripInvisibleCodepoints` export the D-06 stripper mirrors (do NOT extend this file's HTML semantics — quote-stripping is a separate concern)
- `src/source/source-adapter.ts` — `NormalizedRecord` (:84 — where thread/sender metadata must thread through)
- `src/lib/types.ts` — `PendingContradiction` (:14 — D-02 fallback edit site)
- `src/lib/config.ts` — `contradictionN` (:808), `consolSkipThresholdBySource` (:782 — D-16's pattern to mirror)
- `src/consolidation/episode-order.ts` — Phase 62's `event_ts` ordering ("routeContradiction et al. deliberately untouched" comment — the discipline continues)
- `src/db/schema.ts` — episode `event_ts`/`external_id`/`session_id` columns (v16)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`countDistinctProvenance` + `pending_contradictions`** (update-decision.ts:90, schema.ts:56): the shipped mechanism the key feeds — already excludes `origin='inferred'` (D-19); the redesign changes only what populates `session_id` (D-02 default) or adds a counted field (fallback).
- **`event_ts` plumbing** (Phase 62 / EMAIL-04): source-asserted send time already parsed (attacker-skew-bounded, 48h) and stored on episodes; `orderEpisodesForConsolidation` already orders within-run. DRIFT-04 is consumption wiring, not new plumbing.
- **`consolSkipThresholdBySource`** (config.ts:782): the exact per-source-override config shape for D-16.
- **Phase 63/64 test patterns**: counting/fail-if-called provider stubs (this phase is LLM-free beyond the existing extraction call — zero net-new LLM calls), hitl/inferred/echo sentinel inheritance, two-pass persisted-state inertness comparisons, structural never-X tests.
- **64's observability counters** (64 D-06): the shape for D-14's dark-launch key logging.

### Established Patterns
- Sleep pass is the sole graph writer; online paths stay LLM-free; the drift layer runs inside the sleep pass only.
- Convention-enforced invariants fail (six bypasses in Phase 62 alone) — D-07/D-13's guarantees must be structural tests, not prose.
- Dark-knob convention: new behavior ships behind config defaulting to old behavior (D-14, D-16), mirroring `bm25CandidateK` and RETR-03's honest-null.
- Sender-controlled input discipline: everything derived from email headers gets invisible-codepoint stripping + normalization before use (gmail-adapter.ts precedent).

### Integration Points
- `ingest-cli.ts` recordEvent call — where the derived session key (D-02 default) is minted from adapter-provided metadata.
- `GmailAdapter`/`NormalizedRecord` — threadId + sender metadata capture and threading.
- `consolidate()`'s decision path after 63's classification and 64's resolution branches — where the drift layer (confidence damping, lattice check, event_ts guard, emission-point seam) sits; strictly after the :643 hard-stop, inheriting the structural guards.
- `session_id` blast-radius audit surface (D-02 gate): `src/recall/index.ts`, `src/eval/snapshot.ts`, `src/db/episode-store.ts`, `src/adapter/memory-ops.ts`, `src/responder/index.ts`, `src/ingest/pipeline.ts` — every consumer greps to `session_id|sessionId`.
- Downstream (not this phase): Phase 66 hooks the emission point to `ActionProposalSink` and extends the D-13 sentinel to the real sink.

</code_context>

<specifics>
## Specific Ideas

- "Email earns confidence through consolidation volume" is the milestone's stated mechanism — this phase is what makes that sentence true; today `distinctCount` can never exceed 1 on gmail-only evidence (`contradictionN >= 3` mathematically unreachable).
- The inverse failure is as important as the fix: the obvious external_id "fix" turns forwarded threads into a distinctness-farming vector. Both DRIFT-03 test directions (3-independent → 3, 3-forwards → 1) are first-class success criteria, not hardening.
- A hold that lasts forever was the bug; a hold that flips on one ambiguous email would be the opposite bug. The differentiator is the band between them, and DRIFT-05's dry-run on the founder's real inbox threads is what proves the band is placed sensibly.

</specifics>

<deferred>
## Deferred Ideas

- `ActionProposalSink`, `action_proposal` table, `/v1/proposals`, deterministic proposal ids, stale-proposal refusal — Phase 66 (D-13's sentinel extends there).
- Per-entity-per-day batching, approval-rate self-report, hold-exclusion on the Telegram surface — Phase 68.
- Full bi-temporal validity columns — v9.0 DEFER stands; revisit only with a forcing function (STATE.md notes it trending toward table stakes).
- Channel-weight confidence ceiling (backlog B-02) and reliability-from-hedging (B-04) — compose with D-09's lower-only lock later; not this phase.
- Per-role entity granularity under one company node — 64's known limit; revisit on measured mis-attribution via D-15's harness.

### Reviewed Todos (not folded)
All four pending todos matched at score ≥ 0.4 on generic keywords only (`phase`, `status`, `during`, `model`) — the same keyword-noise matches Phases 63 and 64 already reviewed. None folded:
- `2026-06-23-cache-constant-judge-extraction-prompt-prefix-via-system-pro.md` (0.6) — prompt-prefix caching; this phase adds no prompts beyond 63's classification instructions (drift layer is LLM-free). Stays pending.
- `content-hardening-deferred.md` (0.6) — gmail extraction-prompt coverage boundary; no prompt-coverage work here. Stays pending.
- `corpus-brain-3d-transition.md` (0.6) — viz camera transition; unrelated. Stays pending.
- `viz-search-and-hull-quality.md` (0.4) — viz search/hull; unrelated. Stays pending.

</deferred>

---

*Phase: 65-Belief-Gated Status Drift + Provenance-Distinctness Fix*
*Context gathered: 2026-08-02*
