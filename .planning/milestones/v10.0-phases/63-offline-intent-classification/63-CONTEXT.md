# Phase 63: Offline Intent Classification - Context

**Gathered:** 2026-08-02 (auto mode — decisions are the recommended defaults, grounded in the v10.0 research pass and live-code scout; audit trail in 63-DISCUSSION-LOG.md)
**Status:** Ready for planning

<domain>
## Phase Boundary

The sleep pass decides, from gmail episodes only, whether an email implies a status change to a tracked entity — as optional fields on the SAME extraction call gmail episodes already make (zero net-new LLM calls), threaded through the in-memory `ClaimDecision` exactly like TEMP-02's `due_at`/`action_type`. Classification runs as a branch inside the existing per-episode consolidator loop AFTER the `source === 'hitl'` hard-stop, so the guard is inherited by construction. Online paths (SessionStart inject, retrieval, `/v1/surface`) stay LLM-free. Vocabulary is exactly the four scoped states (applied/interviewing/rejected/offer); no sender-domain fingerprint table anywhere.

Out of phase: entity resolution (Phase 64), PE-gated status drift + provenance distinctness (Phase 65), the `action_proposal` table / `ActionProposalSink` / `/v1/proposals` routes (Phase 66 — the foundation-phase call folded the schema there; Phase 63 touches NO database schema), HITL surface (Phase 68).

Hard prerequisite satisfied: Phase 62 complete — EMAIL-03 hidden-content stripping verified (verification pass 6, 2026-08-02) before classification is enabled on gmail content.

</domain>

<decisions>
## Implementation Decisions

### Prompt integration (CLASSIFY-01)
- **D-01:** Extend the EXISTING gmail temporal-superset extraction prompt (the D-06 "one prompt, one LLM call, no second pass" precedent in `src/source/extraction-prompts.ts`) with classification instructions. No second variant, no conditional prompt selection, no second call.
- **D-02:** Keep prompt ordering cache-friendly: the enlarged constant prefix stays FIRST, variable episode content stays LAST. Do not implement the prompt-prefix caching itself (that is the deferred 2026-06-23 todo) — just don't break its future applicability.
- **D-03:** Sender domain may be referenced in the prompt as a weak prior the model reads ("ATS mail often comes from whitelabeled domains — do not trust domain alone"), but NO domain→verdict mapping table exists in config or code (CLASSIFY-04; Greenhouse whitelabeling silently breaks fingerprint tables).

### Field shape (CLASSIFY-01, CLASSIFY-04)
- **D-04:** Three new optional fields on `ExtractedClaim`, mirroring the `due_at`/`action_type` optional-annotation pattern: a **closed 4-state status enum** (`applied | interviewing | rejected | offer`), a **free-text entity descriptor** (company/role as the email states it — resolution to a graph node is Phase 64's job, NOT this phase's), and a **coarse categorical confidence** (`high | medium | low`). Exact field names at planner discretion (research suggested `intent_entity` / `intent_confidence`); semantics above are locked.
- **D-05:** All-or-nothing presence: the three fields appear together or not at all. Absence = "not status-relevant" (the overwhelmingly common case). Out-of-enum status from the model → drop the entire classification (absence over guess — stricter than `toActionType`'s coerce-to-'other', because a wrong status is worse than none).
- **D-06:** No raw numeric confidence anywhere in the schema or output (research anti-feature: arXiv 2402.07632 — undetectably miscalibrated; calibration against real outcomes is explicitly deferred to v10.x). Coarse categorical only; how it maps onto PE magnitude is Phase 65's consumption decision.

### Attachment level & persistence (CLASSIFY-02)
- **D-07:** Classification attaches **per-claim** and threads through the in-memory `ClaimDecision` (new optional fields beside `claimDueAt`/`claimActionType` at `src/consolidation/consolidator.ts:151`). If the model tags multiple claims in one episode, all thread through — dedup/consumption is Phase 64/65's concern.
- **D-08:** **No DB schema change in Phase 63.** Fields live on the in-memory `ClaimDecision` only and are inert (nothing consumes them yet). The `action_proposal` table is Phase 66's first task per the roadmap foundation-phase call.
- **D-09:** The classification branch sits INSIDE `consolidate()`'s per-episode loop, strictly AFTER the existing `origin === 'inferred' || echoSourceId !== null || source === 'hitl'` hard-stop (`consolidator.ts:643`) — never as an independent episode scan (PITFALLS.md Pitfall 6: an independent scan silently loses the guard that closed D-43 and v9.0's C-2). Sentinel test proves hitl episodes are never classified.

### Enablement
- **D-10:** Always-on for gmail-source episodes; **no new config flag**. The fields are inert in this phase, so there is no user-visible behavior change to gate; a flag would be speculative surface. The existing `consolSkipThreshold` salience gate already bounds which gmail episodes reach extraction at all.
- **D-11:** Classification instructions go only into the gmail prompt path — other sources' prompts are untouched (CLASSIFY-01 scopes to gmail episodes).

### Verification approach (CLASSIFY-01/02/03)
- **D-12:** Token-cost check = (a) a call-count sentinel test asserting exactly ONE `provider.generate` call per gmail episode through the consolidator (counting stub), plus (b) an honest measured input-token delta for the enlarged prompt prefix (from the `claude -p` usage envelope on a sample), recorded in the phase SUMMARY. No rounded/inflated claims.
- **D-13:** LLM-free online regression (CLASSIFY-03) = a fail-if-called `ModelProvider` stub exercised through the online entrypoints (SessionStart inject / retrieval path, `/v1/surface`) asserting zero provider calls. `/v1/proposals` does not exist yet — Phase 66 extends this test when it lands. A structural/static variant (import-boundary-style) is at planner discretion if it fits an existing pattern.

### Claude's Discretion
- Exact field names on `ExtractedClaim`/`ClaimDecision` (semantics locked in D-04/D-05).
- Whether the CLASSIFY-03 test is dynamic-stub only or also static/structural.
- Classification prompt wording — flagged for the research pass (see below).

### Research directives (roadmap research flag)
The genuinely deep new work is the classification prompt itself: how to instruct reliable 4-state discrimination on real ATS/recruiting mail, when to emit `high|medium|low`, ambiguity → OMIT (a single ambiguous email must classify as nothing, feeding Phase 65's hold-don't-flip), and sender-domain-as-weak-prior phrasing. The "job-status evidence → PE magnitude" mapping should be DESIGNED (documented) here only insofar as it constrains the confidence vocabulary; its consumption is Phase 65.

### Folded Todos
- **Cache-constant judge/extraction prompt prefix via --system-prompt** (`.planning/todos/pending/2026-06-23-cache-constant-judge-extraction-prompt-prefix-via-system-pro.md`) — Phase 63 grows the constant gmail prompt prefix, making this deferred optimization slightly more valuable. Folded as a CONSTRAINT only (D-02: preserve prefix-first ordering); implementing the caching remains out of scope.
- **Content-hardening item 3: gmail episodic-variant prompt product decision** (`.planning/todos/pending/content-hardening-deferred.md` §3) — folded as a boundary: Phase 63 modifies the gmail prompt to ADD classification fields but must NOT broaden extraction coverage (the "IGNORE signatures/pleasantries/logistics" stance stays); the episodic-variant product decision remains explicitly deferred and must not be smuggled in.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements & roadmap
- `.planning/REQUIREMENTS.md` — CLASSIFY-01..04 (the phase's four requirements, with rationale)
- `.planning/ROADMAP.md` — Phase 63 entry (goal, success criteria, research flag) + the v10.0 preamble "Foundation-phase call" (why NO `action_proposal` table exists in this phase)

### v10.0 research (load-bearing for this phase)
- `.planning/research/SUMMARY.md` — "Phase 3: Offline Intent Classification" section + Critical Pitfalls 1/2/6/15
- `.planning/research/PITFALLS.md` — Pitfall 6 (self-confirmation reopens at the classification boundary; branch-inside-loop is the structural fix) — the single most load-bearing design constraint of this phase
- `.planning/research/ARCHITECTURE.md` — seam-by-seam reuse map (TEMP-02 threading pattern verified against live source)

### Code seams (live source is source of truth)
- `src/source/extraction-prompts.ts` — gmail temporal-superset prompt (D-06 one-prompt precedent), `promptForSource()` selection seam
- `src/model/claim-extractor.ts` — `ExtractedClaim` optional-field pattern (`due_at`/`action_type` at :78-80, parse/coercion at :290-298, JSON schema at :213)
- `src/consolidation/consolidator.ts` — hitl hard-stops (:106, :643), `ClaimDecision` interface (:151), the per-episode loop the branch lives in

### Folded todos
- `.planning/todos/pending/2026-06-23-cache-constant-judge-extraction-prompt-prefix-via-system-pro.md` — cache-ordering constraint (D-02)
- `.planning/todos/pending/content-hardening-deferred.md` §3 — gmail prompt coverage boundary

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **TEMP-02 optional-field threading** (`claim-extractor.ts` → `ClaimDecision` → consumers): the exact pattern to mirror — optional fields, backward-compat by absence, coercion guards on model output.
- **Gmail temporal-superset prompt** (`extraction-prompts.ts:62+`): the D-06 precedent for extending one prompt instead of adding a call.
- **Counting/fail-if-called provider stubs**: the test suite already stubs `ModelProvider` extensively (2883 tests); reuse for D-12/D-13 sentinels.

### Established Patterns
- Sleep pass is sole graph writer; all LLM cost offline; `consolSkipThreshold` gates low-salience turns out of extraction (bounds classification volume for free).
- Convention-enforced invariants have failed six times before (ARCH-REVIEW M-8 class) — hence D-09's branch-inside-loop requirement is structural, not stylistic.
- Model stack: extract → headless Haiku, judge → headless Sonnet via `claude -p` (config.ts:620-622); classification rides the Haiku extraction call.

### Integration Points
- `consolidate()` per-episode loop after the :643 hard-stop — the ONLY place the classification branch may live.
- `ClaimDecision` (consolidator.ts:151) — where the new optional fields sit, beside `claimDueAt`/`claimActionType`.
- Downstream (not this phase): Phase 64 reads the flagged decisions for resolution; Phase 65 maps confidence onto PE magnitude; Phase 66 persists proposals.

</code_context>

<specifics>
## Specific Ideas

- A single ambiguous email must yield NO classification (omit), not a low-confidence guess — this is what lets Phase 65's hold-don't-flip differentiator work.
- The classifier reads content that Phase 62 already stripped (EMAIL-03); do not add a second stripping layer here, and do not weaken the extractor's noise stance.

</specifics>

<deferred>
## Deferred Ideas

- Entity resolution / graph-node matching — Phase 64.
- Confidence → PE-magnitude consumption + lifecycle-lattice awareness (out-of-order transitions) — Phase 65.
- `action_proposal` table, `ActionProposalSink`, `/v1/proposals` (+ extending the D-13 regression test to it) — Phase 66.
- Prompt-prefix caching via `--system-prompt` — deferred todo, constraint-only here.
- Gmail episodic-variant extraction prompt (broader coverage of receipts/flights) — explicit product decision, stays deferred.

### Reviewed Todos (not folded)
- `corpus-brain-3d-transition.md` (score 0.6) — viz camera transition; keyword-noise match, unrelated to classification. Stays pending for a future viz phase.
- `viz-search-and-hull-quality.md` (score 0.4) — viz search/hull; keyword-noise match, largely resolved by Phase 19 already. Stays pending.

</deferred>

---

*Phase: 63-Offline Intent Classification*
*Context gathered: 2026-08-02*
