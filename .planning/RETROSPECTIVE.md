# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v1.0 — Core learning loop

**Shipped:** 2026-06-09
**Phases:** 8 | **Plans:** 35 | **Span:** 5 days (2026-06-05 → 2026-06-09), 279 commits

### What Was Built
- Two-store substrate (episodic log + semantic graph + on-node embeddings) on better-sqlite3, single owned write primitive, tag-don't-drop allocation gate, lazy decay + AND-gated eviction.
- Offline consolidation sleep pass as sole graph writer: PE-gated three-way reconsolidation, provenance-distinct contradiction force-destabilization, oscillation guard, resumable checkpoint.
- LLM-free retrieval + Claude Code SessionStart hook (replaces flat MEMORY.md), proven end-to-end on the founder's real brain.db.
- The learning layer: schema induction (abstraction the user never stated), ephemeral schema-prior recall, origin/provenance enforcement closing the self-confirmation loop.
- Level-3 seams (ModelProvider, ConsolidationSink, eval-snapshot); multi-channel ingestion (Gmail/transcript/Obsidian adapters via `brain-ingest`); Telegram query bot; lock-guarded `brain-seed` cold-start CLI + de-hardcoded paths.

### What Worked
- **Customer-zero dogfooding against a real brain.db** caught defects mocks couldn't — the SessionStart loop, sleep pass, and Telegram surface were all live-verified, not just unit-tested.
- **Narrow seams before any heavy machinery** (ModelProvider/SourceAdapter/Channel/Judge) — Phase 7 (Telegram) and Phase 8 (ProviderClaimExtractor) both reused existing seams with near-zero new architecture.
- **Fail-closed config defaults** (`enabledSources=[]`, `telegram.enable=false`, empty allowlists, `''` cold-start paths) kept every new surface safe-by-default for OSS self-host.
- **Worktree-isolated parallel execution** for disjoint plans (Phase 8 wave 1) merged cleanly.

### What Was Inefficient
- **Mock-only test suites hid a production bug** — the Phase 3 judge `parseVerdict` JSON code-fence bug was silently a no-op in prod until caught during live dogfood. Live-path smoke tests were added reactively.
- **A gated live-write fired early** — an hourly launchd job ran compiled sink code and crossed a production-write gate on its own; plan-ordering is not a runtime gate.
- **iMessage Phase 7 was built, then abandoned** for a structural self-echo loop (shared Apple ID) — pivoted to a Telegram bot. The channel-vs-source distinction wasn't settled before building.
- **Non-hermetic tests collide with the live system** — `lockfile.test.ts` uses the production lock path and flakes when the live launchd watcher holds it (surfaced at Phase 8 close).

### Patterns Established
- **CLI + lock discipline** (`recall-cli` skeleton): validate argv → `acquireLock()` BEFORE DB open → release in `finally` on every path. Never `process.exit()` inside a try/finally holding the lock (it skips `finally` and leaks the lock for `LOCK_STALE_MS`). Use `process.exitCode` instead.
- **Fail-safe env overlay** (`resolveProviderOverlay`): env → empty default, unknown values skipped — reused for model provider and cold-start paths.
- **Origin/provenance is load-bearing**: inferred output must never strengthen a fact; every channel/adapter tags origin at the boundary.

### Key Lessons
1. **Dogfke against real data every phase.** Mocks pass while prod silently no-ops; the only reliable signal was running the engine on a live brain.db.
2. **A live, always-on system is part of your test environment.** Tests that touch shared production paths (locks, DBs) will flake against the running watcher/sleep-pass — make them hermetic or expect collisions.
3. **`process.exit()` inside a lock-holding try/finally leaks the lock.** Documented in `sleep-pass-cli`, still re-introduced in `seed-cli` (caught in code review) — bake it into the CLI skeleton, not tribal memory.
4. **Worktree execution starts from committed HEAD, not the working tree.** Uncommitted local edits to a phase-touched file (here: live Telegram test values in `config.ts`) must be parked with a pathspec stash before execution, or the merge-back/commit will clobber or leak them.
5. **Settle channel-vs-source (and identity) before building a surface.** The iMessage→Telegram pivot was a full plan's worth of rework avoidable by resolving the self-echo identity question first.

### Cost Observations
- Model mix: not instrumented this milestone. Default profile ran planner on Opus, executor/verifier/reviewer/researcher on Sonnet; ingestion/judge experimented with local Ollama (Qwen 35b-a3b / qwen2.5:7b) per-role routing.
- Notable: local Qwen 35b-a3b measured to match Haiku on contradiction detection (green-lit split-routing); contradiction magnitude remained poorly calibrated by all models including Haiku.

---

## Milestone: v2.0 — Open-Source Release

**Shipped:** 2026-06-10
**Phases:** 2 | **Plans:** 14 | **Span:** 2 days (2026-06-09 → 2026-06-10), ~70 feat commits

### What Was Built
- OSS install floor: `brain init` guided bootstrap (live key validation, chmod-600 env, absolute node-bin capture), `brain` dispatcher, `brain doctor` 5-dimension health audit, install README + platform matrix.
- Cross-platform scheduler seam: launchd preserved on macOS, croner in-process fallback on Linux, idempotent install/status, macOS-only channels gated cleanly.
- Full v1.0 tech-debt clearance (DEBT-01..06) + hermetic CI matrix green on macOS and Linux (PORT-01/02).
- `brain viz`: read-only 127.0.0.1 3D graph UI with live spreading-activation animation via SSE from a ring-capped `activation_trace` table behind a Noop-default sink seam (zero hot-path cost when off).

### What Worked
- **Seam-mirroring as a design shortcut** — `ActivationTraceSink` copied the `ConsolidationSink` pattern verbatim (interface + SQLite + Noop + Mock); the whole viz data path landed in one plan with no architectural debate.
- **Floor-before-ceiling ordering held** — install/DX shipping before the viz meant the viz demo ran on a clean-install path, catching dispatcher wiring issues early.
- **Spikes before the risky UI phase** — spike 001/002 validated force-graph SSE animation sequencing before Phase 10 committed to it; zero rework in the 5-wave chain.
- **Two-day milestone** — small scope (2 phases) with hard internal ordering executed faster than any v1.0 stretch.

### What Was Inefficient
- **Milestone bookkeeping lagged reality** — v2.0 requirements checkboxes/traceability were never flipped at phase transitions, and the milestone sat unarchived for a day; the v3.0 kickoff had to backfill both before it could start.
- **Summary-extraction quality varies** — several plan SUMMARYs had code-review bullets where the one-liner should be, so automated accomplishment extraction produced junk needing manual curation at close.
- **Post-ship hardening arrived as quick-tasks, not a phase** — the 32-finding ARCH-REVIEW pass (schema v5) landed as quick tasks the day after "complete," suggesting the review belonged inside the milestone gate.

### Patterns Established
- **Sink-seam template** (interface + SQLite + Noop + Mock, Noop default) is now the standard way to add optional observability without hot-path cost.
- **Read-only surfaces open their own DB handle** — never reuse a store object that carries write affordances (viz server precedent).
- **Honesty gates as permanent tests** — shipping-copy constraints encoded as a test (FORBIDDEN_TERMS) rather than a checklist (later relaxed deliberately, 2026-06-10, when the constraint itself was re-scoped to engine mechanisms).

### Key Lessons
1. **Plan-ordering is not a runtime gate** (re-confirmed from v1.0): gates that matter need a default-OFF runtime flag.
2. **Flip requirement/traceability state at phase close, not milestone close** — backfilling at archive time is error-prone and blocks the next milestone.
3. **Run the architecture review before declaring the milestone complete** — 32 findings and a schema bump within 24h of "shipped" means the gate was in the wrong place.

### Cost Observations
- Model mix: not instrumented. Same default profile as v1.0 (planner Opus, execution Sonnet); judge split-routing to local Qwen continued in dogfood.
- Sessions: ~2 days of focused execution + 2 post-ship quick-task sessions.

---

## Milestone: v3.1 — Schema Depth & Brain-Window Polish

**Shipped:** 2026-06-15
**Phases:** 2 (18–19) | **Plans:** 8

### What Was Built
The learning layer learned over its own abstractions: an LLM-free `SchemaRelationDeriver` in the sleep pass derives schema↔schema centroid-cosine edges and an agglomerative super-schema hierarchy (SREL-01/02), and recall gained a single bounded read-only sideways hop through related schemas that stays ephemeral (SREL-03) — all behind the D-37 inferred-origin firewall, sentinel-tested. The Recense brain window became navigable and clean: in-app BM25 node search with fly-to/highlight (VIZ-07), schema topic-region highlighting off engine-served member edges (VIZ-08), and a clean hull from every angle via a Taubin-smoothed D-06 display hull (VIZ-09).

### What Worked
- **Pre-authorized fallback in the plan.** Phase 19's plan named the D-06 display-hull swap as an explicit branch *before* execution. When the `foldSuppress` shader erased the rim, the pivot needed no replan — just take the authorized branch and re-verify. Naming the escape hatch up front paid off.
- **Advisory code review caught real BLOCKERs.** Phase 18's review found two genuine defects (sideways hop scanned only out-edges → ~50% of `schema_rel` pairs missed; non-atomic v7 migration could lose the whole edge graph) and the phase fixed both before close, each with a regression test.
- **Coupled phases sequenced right.** VIZ-08 (topic-region) fell out of Phase 18's schema→member edges exactly as planned; no rework at the seam.

### What Was Inefficient
- **v3.0 was never formally closed.** Phases 11–17 shipped 2026-06-13 but `complete-milestone` was never run, so closing v3.1 swept phases 11–19 into one archive (`v3.1-ROADMAP.md`) and the CLI mis-scoped the milestone as "9 phases / 55 plans." Had to hand-correct the MILESTONES entry and ROADMAP. Re-confirms v2.0's lesson #4.
- **A plan's hardcoded artifact check went stale on the authorized pivot.** Phase 19's Task-1 auto-check asserted `foldSuppress` present in effects.js — but the delivered hull took the D-06 branch, which contains no `foldSuppress`. The verification asserted the *default-path* artifact, not "the hull deliverable, whichever branch shipped." Correct outcome, misleading gate.
- **CLI accomplishment-extraction couldn't parse `**One-liner:**`.** `milestone.complete` emitted ~50 literal "One-liner:" bullets; the MILESTONES entry was rewritten by hand from the summaries.

### Patterns Established
- When a plan authorizes a fallback branch, write the verification to assert the *delivered* artifact, not the default-path one.
- In a gitignored `.planning/` repo, milestone close is doc-only (local archives) plus a git tag on the code state — there is nothing to commit; the tag is the sole durable git artifact.

### Key Lessons
- Close each milestone the day it ships. v3.0's drift made v3.1's archive lumpy and the CLI counts wrong — the exact cost v2.0 already flagged.
- A founder-architected novel mechanism with its 1–2 riskiest decisions explicitly flagged for easy revision (D-01 centroid signal, D-03 super-schema-as-node) keeps the off-distribution call cheap to reverse.

### Cost Observations
- $0 milestone as planned — schema work runs in the local sleep pass, viz is frontend, no paid API runs.
- Model mix: not instrumented; same default profile (planner Opus, execution Sonnet).
- Sessions: ~2 days of focused execution (2026-06-13 → 14) + the 2026-06-15 closeout.

---

## Milestone: v6.0 — Project Onboarding

**Shipped:** 2026-06-22 (executed 2026-06-19 → 06-20; archived 2026-06-22)
**Phases:** 6 (29–34) | **Plans:** 16

### What Was Built
recense can onboard a fresh, unexplored project on demand: `recense ingest-project <dir>` runs an agentic survey that emits *summarized semantic knowledge* (not raw code) through the existing episodic→consolidation pipeline (origin=observed, scope-tagged), gated by a `genuine|noise` quality judge. Generalized doc ingest (README/`docs/*.md`/`CLAUDE.md`) + a per-project `gitFingerprint` cursor make re-ingest incremental and idempotent. `recense recall --scope <slug>` provenance-filters to one project (D-S1-safe), and onboarding auto-promotes/generates the project's schema-anchored corpus landing doc via a crash-safe deferred marker consumed in the sleep pass. Two standalone phases folded in: `recense remember` (synchronous verbatim curated write + in-place reconsolidation + native-memory cutover) and a CSS-only cross-surface visual-polish pass.

### What Worked
- **Spike-gated the off-distribution bet.** Survey-quality (would an agent emit *genuine* facts, not noise?) was the milestone's riskiest, most off-distribution call — Phase 29 ran a throwaway feeder + `genuine|noise` judge on a real project and required a founder GO before any build code. Karpathy spike-first discipline; zero wasted build on an unproven primitive.
- **Onboarding rode existing seams, net-zero deps.** The whole pipeline reused `IngestionPipeline`, `node_scope`, the consolidation path, and the Phase-28 corpus promoter — no new architecture, no new runtime deps. Origin/scope tagging at the boundary meant abstraction + idempotent reconsolidation came for free.
- **Crash-safe deferred side-effect pattern.** Auto-corpus generation used a `pending-corpus-promotion:<scope>` marker written at ingest, consumed *before* `generateCorpusDocs` in the sleep pass, and `deleteMeta`'d only *after* `promoteScope` resolves — so a crash mid-generation retries instead of silently dropping the doc. Clean separation of the online write from the offline LLM cost.

### What Was Inefficient
- **Bookkeeping lag bit a third time — now compounded.** v6.0 sat unclosed while phases 33, 34, and all of v7.0 (35–39) kept landing. Closing it required disambiguating **interleaved v6.0/v7.0 git history** (`feat(35-01)` commits sit *between* `34-03` commits on 2026-06-20) — there is no clean commit boundary, so the v6.0 tag can only mark close-HEAD, not a code boundary. This is exactly v2.0 lesson #2 / v3.1 lesson #4, re-confirmed a third time and now with a concrete cost (lost per-milestone git granularity).
- **Standalone phases had no milestone home.** Phases 33 and 34 were added mid-stream (2026-06-20) without a bucket; 34's VIZ-POLISH reqs landed in v6.0's REQUIREMENTS.md but 33 was an orphan. Bucketing them was a judgment call deferred to close instead of decided at creation.
- **Traceability never flipped at phase close.** RECALL-01/02 stayed `[ ]` Pending in REQUIREMENTS.md despite Phase 32's VERIFICATION marking both SATISFIED; REMEMBER-01/02/03 were never added to the traceability table at all. Both fixed at close — again the lagging step.

### Patterns Established
- **Spike-first for off-distribution primitives** — when the core bet is "will an agent produce useful output," prove quality on a throwaway against real data with a cheap go/no-go before committing build, founder as architect.
- **Crash-safe deferred-marker** (write marker → consume-before-act → delete-after-success) is the standard way to defer an offline side effect (LLM generation) triggered by an online write.

### Key Lessons
1. **Close each milestone the day it ships — third re-confirmation, now load-bearing.** Letting v6.0 and v7.0 both run open produced interleaved history with no recoverable per-milestone tag boundary. The cost is no longer just lumpy archives (v3.0/v3.1) — it's permanent loss of git milestone granularity.
2. **Assign a standalone phase to a milestone bucket when it's created, not at close.** The 33/34 ambiguity was avoidable with a one-line decision at `/gsd:phase --insert` time.

### Cost Observations
- Onboarding LLM cost lives in the offline survey + consolidation (headless `claude -p` on the founder's subscription — flat-billed, real tokens). Visual polish (Phase 34) and the bookkeeping were $0.
- Model mix: not instrumented; survey/extract on headless Haiku, judge on headless Sonnet per the spike-003 stack.

---

## Milestone: v8.0 — Performance, Efficiency & Competitive Parity

**Shipped:** 2026-06-26
**Phases:** 40–45 (Phase 43 deferred — not built) + folded-in 39.2, 39.3 | **Plans:** 24 + 9 folded-in

### What Was Built
LoCoMo competitive baseline (honest, reproducible — J=86.0% relative-only, R@5/R@10 77.3/82.2%, p50/p95 45/46ms) → a zero-dep flat-buffer vector index that killed brute-force cosine at 7000+ nodes (byte-exact top-k, warm ~3.4×) → a token/cost audit that separated marginal write (~7.1k tok/turn) from corpus-gen and applied a per-source `consolSkipThreshold` lever → two productization phases folded in (bundled-app settings + cost controls; subscription-default install with an honest billing-leak footgun) → standalone corpus increments (multi-level doc graph 39.2, honest reader gen-status 39.3).

### What Worked
- **Baseline-before-optimize as a hard gate.** Phase 40 froze the v7.0 SUT and recorded reproducible numbers *first*, so every later "win" (41 latency, 42 token) is measured against a fixed reference rather than a moving target.
- **No-inflated-metrics applied to reading competitors, not just writing our own.** Annotating each competitor headline with what it actually measures (MemPalace 96.6% = raw-embedder mode) kept the targets honest and interview-defensible.
- **Spike-chose the cheap mechanism.** Phase 41's spike picked a zero-dep flat-buffer exact index over sqlite-vec — kept net-zero deps and byte-identical top-k, so latency came free of an accuracy trade.
- **Deferring with discipline.** Both deferrals (Phase 41 PERF-03(b), Phase 43 entirely) were explicit founder decisions with recorded rationale (re-running corroborates an already-proven result at real cost), not silent drops.

### What Was Inefficient
- **Phase 43 never got built**, so v8.0's own stated DoD ("lock the numbers behind regression gates") closes unmet — the headline numbers can silently regress until the gate lands. The bet (productization phases 44/45 were higher-leverage than the gate) is reasonable, but it leaves the milestone's thesis only half-locked.
- **The naive token headline (26,495 tok/turn) overstated marginal write ~3.7×** until Phase 42 separated corpus-gen out — an instrumentation gap that could have misled a cost decision if taken at face value.
- **Bookkeeping lag bit a FOURTH time** — milestone scope grew from the planned 40–43 to 40–45 (+ inserted 39.2/39.3) with no audit run; the close had to reconstruct scope from STATE.md rather than a maintained manifest.

### Patterns Established
- **Productization-track phases interleaved with the perf line.** 44/45 (distribution/onboarding) ran alongside 40–42 (perf/parity) and were folded into the same milestone at close — same pattern as v6.0's 33/34.
- **Derived-cache discipline extended to the vector index** — rebuildable from the graph, end-of-pass build, consolidator stays brute-force; the index is never authoritative.

### Key Lessons
1. A milestone whose thesis is "prove + lock the numbers" is only half-shipped if the lock (CI gate) is deferred — surface that as a known gap loudly, not a footnote. *(v8.0)*
2. Apply the no-inflated-metrics rule to competitor numbers you *cite*, not just numbers you *produce* — a headline is a target only once you understand its configuration. *(v8.0)*
3. Separate marginal cost from batch/optional subsystem cost before quoting a per-turn token figure. *(v8.0)*

### Cost Observations
- All marginal LLM cost stayed in the offline pass on the founder's Max subscription (flat-billed, real tokens). Measured marginal write ~7,118 tok/turn (Haiku extract+judge), 0% Sonnet escalation; corpus-gen is a separate Sonnet-billed backlog subsystem.
- Benchmark runs (LoCoMo scorer via gpt-4o-mini judge) were operator-gated behind a hard cost probe (Phase 40-05 / 42-04 runbook).

---

## Milestone: v9.0 — Memory Quality

**Shipped:** 2026-07-20
**Phases:** 46–61 (5 planned engine phases + 11 appended, mostly viz) | **Plans:** 92

### What Was Built
Engine: reconsolidation candidate broadening (union of entity-graph + BM25 + dense feeding the judge — 368 KU judge-fires vs pre-46 ZERO, belief-correction 84.6% no regression), hybrid BM25+dense fusion on the LLM-free hot path (honest null w*=0, ships dark), correctness hardening (C-2/M-5/M-9/L-2), ANN NO-GO → WASM SIMD f32x4 exact-scan kernel (byte-exact, ~4–5×), and regression gates now merge-blocking in CI (offline `gate:ci` required check; accuracy floors armed; docs/evals.md re-baselined). Viz: a ten-phase overhaul arc (honest traces → layout at 15.4k nodes → ambient liveliness/replay/spontaneous layers → identity palette → node/motion overhaul → HUD → settings/stats → corpus index column), every stage founder-signed-off live.

### What Worked
- **Research-grounded scoping paid off directly.** The June-2026 deep-research finding (dense cosine structurally can't separate contradictions) drove the candidate-broadening bet instead of an embedder swap — and the judge went 0 → 368 fires with all guards intact.
- **Honest-null discipline held under pressure.** Phase 47's held-out sweep found w*=0; the milestone shipped the mechanism dark and recorded the null rather than claiming a recall win.
- **Spike-first kept scale work cheap.** Phase 49 concluded NO-GO (ANN) + DEFER (bi-temporal) — both sanctioned outcomes — and its probe birthed the WASM SIMD kernel that became Phase 51's real win.
- **The milestone audit earned its keep.** `/gsd:audit-milestone` (first run since v6.0) caught the one genuine blocker — GATE-01's requirement text said "blocks merges" while the shipped gate was on-demand — plus that the gate's input fixtures were gitignored and two harnesses still executed live. Closed same-day as quick 260720-nup.
- **Machine-checked visual invariants.** SC3 activity ordering, dim floors, and palette band membership became regression tests — aesthetics got the same lock-in as engine guards.

### What Was Inefficient
- **Milestone scope tripled without bookkeeping.** Planned as 5 engine phases (46–50); shipped as 16 (46–61) via appended viz phases. ROADMAP phase details landed after the Backlog header, the SDK's 999-sentinel misnumbered four inserted phases, REQUIREMENTS.md checkboxes were never flipped at phase close (RECON/GATE rows still `[ ]` at audit time), and `milestone.complete` auto-scraped a junk MILESTONES.md entry across all 37 phase dirs. Bookkeeping lag bit a FIFTH time.
- **Five phases closed without VERIFICATION.md** (46, 49, 50, 52, 55) — all evidence-mitigated, but the audit had to reconstruct verification from summaries.
- **A phase-level scope narrowing silently contradicted milestone requirement text.** Phase 50's D-01 ("on-demand gate, not CI") was founder-approved locally but left GATE-01 unmet as written until the audit surfaced it.
- **The brightness-scaling salience model needed founder rescue three times** (54 replay, 55 hops, 56 spontaneous) before Phase 57 replaced it with the luminance-equalized identity palette — the root cause (dimming saturated hues on a dark additive bg) was structural, not tunable.

### Patterns Established
- **Presentation-track phases interleaved at scale** — 11 of 16 phases were viz/UX, run through the same GSD chain with founder live-install UAT rounds and GAP-x tracking (Phase 61: 10 gaps over 4 rounds to sign-off).
- **Fresh-vs-reused provenance on every recorded metric** — docs/evals.md v9.0-final annotates each number with how it was produced; the no-inflated-metrics rule now covers *re-recording* too.
- **Offline deterministic CI tier for expensive eval suites** — commit the recorded-metric fixtures, gate on them sub-second in CI, keep the paid tier on-demand.

### Key Lessons
1. Requirement text is the contract: a phase-level scope decision that contradicts it must either revise the requirement or close the gap — otherwise the milestone audit (rightly) blocks. *(v9.0)*
2. When a milestone's scope grows past ~2× via inserted phases, run `/gsd:audit-milestone` before close — reconstruction-from-summaries works, but the audit caught the only real blocker here. *(v9.0)*
3. A "CI-safe" gate means: inputs committed, no live harness execution, no keys — verify all three before claiming merge-blocking. *(v9.0)*
4. When a visual model needs founder rescue more than twice, the model is wrong, not the constants — redesign the axis (hue=identity, salience=motion) instead of re-tuning. *(v9.0)*

### Cost Observations
- All LLM cost stayed in the offline sleep pass on the Max subscription; `MAX_THINKING_TOKENS=0` production default held (−66% measured token cut from the thinking-off A/B, accuracy dead-even).
- The CI gate tier costs $0/PR (reads committed JSON); the paid accuracy tier stays key-guarded and on-demand.

---

## Milestone: v10.0 — Action Proposals

**Shipped:** 2026-08-09
**Phases:** 62–69 (7 planned + Phase 69 promoted from SEED-005) | **Plans:** 69 (172 tasks)

### What Was Built
recense now watches multiple Gmail inboxes and turns belief change into human-approved action: guided `gmail-auth` account onboarding + per-account backfill scoping + a 7-round adversarially-verified hidden-content stripping pipeline at the ingest boundary (62); offline intent classification riding the existing extraction call with zero net-new LLM calls (63); confident-or-null three-channel entity resolution (64); belief-gated status drift on the byte-unmodified PE-gate machinery + the provenance-distinctness redesign, knob dark pending founder gate (65); the domain-neutral `ActionProposalSink` + `/v1/proposals` with the D-43-for-proposals sentinel (66); a reference consumer adapter and Telegram belief-kind HITL proving the contract from both sides (67–68); and eval-first entity-anchored ambient recall — 2 knobs live on passed gates, 2 honest nulls (69). One continuous 8-stage E2E test pins the whole chain.

### What Worked
- **Audit-before-close is now the norm — and this time every clearable finding was resolved BEFORE close.** Four quick tasks (260809-1n3/1vg/2fo/2qe) cleared the typecheck blocker, the dist-suite failures, the perf flake, the WR-03 idempotence defect, and the composed-suites-only E2E warning; the audit was re-run and the close proceeded with zero clearable debt. Contrast v9.0 (blocker found at audit, closed same-day) and v8.0 (no audit at all).
- **Bookkeeping lag finally beaten.** REQUIREMENTS.md traceability was reconciled 2026-08-07 *before* the audit; checkboxes matched verifications at close for the first time since the pattern was named in v2.0.
- **Oracle-driven adversarial verification found real defects hand-review missed.** The strip-hidden gap-closure loop (62-13..62-30) built independent conformant oracles (css-tree liveness, parse5 HTML layer) and both-directions differentials — rediscovering chartered findings independently and surfacing genuinely new leak classes (NF-06 compound leak, CSS-escaped selectors) plus quadratic blowups measured down from 126 s to 1.2 ms.
- **Structural inheritance over re-implementation held everywhere.** Classification sits below the existing hitl hard-stop; hold-exclusion flows from one exported eligibility set; the belief-kind rides the frozen proposal store behind a hash-lock test. Zero re-implementations of existing guards.
- **Eval-first knob discipline extended to features.** Phase 69's gates decided what shipped; the LLM-judge re-gate *refuted* the grader-artifact hypothesis rather than rescuing the knob — the null was verified, not just recorded.

### What Was Inefficient
- **Phase 62 consumed 31 of 69 plans.** Planned as "ingest hardening," it became a seven-round adversarial parsing campaign once attacker-controlled HTML met a hand-rolled stripper. The lesson is a budgeting one: parsing hostile input at a trust boundary costs a multiple of any initial estimate.
- **The SDK 999-sentinel misnumber recurred a fifth time (Phase 69)** before quick 260802-m2e found the root cause on disk (two mis-named `998.x` dirs from v9.0 archival) rather than in ROADMAP prose.
- **`milestone.complete` auto-scraped a junk accomplishments list again** (all ~70 plan one-liners dumped into MILESTONES.md; hand-curated at close, same as v9.0).
- **Nyquist validation is enabled in config but produced zero VALIDATION.md files across all 8 phases** — either run it per-phase or disable the flag; the current state is a standing audit warning.

### Patterns Established
- **Independent conformant oracle + both-directions differential** for any surface that parses attacker-controlled input (the test-layer oracle must not share the production parser).
- **Two-layer invariant sentinels** (static grep/import-boundary + runtime byte-identity) for self-confirmation-class risks — D-43-for-proposals is the template.
- **Calibration-relative perf bounds** (elapsed ≤ k × same-process reference) replacing absolute wall-clock assertions that flake under suite load.
- **dist-build gate**: CLI-subprocess tests skip with a message, never fail, on unbuilt trees.
- **Founder gates as designed pre-decision states**: `provenanceDistinctnessEnabled` dark-with-harness-ready is a shippable state, not an oversight.

### Key Lessons
1. Budget adversarial-input hardening as a campaign, not a task — and reach for a conformant parser early; v10.0 consciously spent its first runtime-dep exceptions since v2.0 (`css-tree`, `htmlparser2`, exact-pinned) after hand-rolled scanning lost repeatedly. *(v10.0)*
2. Resolve clearable audit findings before close, not after — the audit-fix-reaudit loop (tech_debt verdict, 6 resolved gaps) produced a clean close with no same-day scramble. *(v10.0)*
3. Root-cause recurring tooling bugs in state on disk, not in prose — five occurrences of the 999-misnumber were "manually corrected" before one look at the phases directory found the actual cause. *(v10.0)*
4. A verified null beats a recorded null: re-gate with a better instrument before accepting failure — and accept it harder if the better instrument agrees. *(v10.0)*

### Cost Observations
- All LLM cost stayed in the offline sleep pass on the Max subscription; `MAX_THINKING_TOKENS=0` held.
- The one measured marginal-cost change: +597 input tokens (+117.52%) per gmail extraction call for intent classification — measured live (two-arm `claude -p` harness), founder-confirmed, zero net-new calls.

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Span | Phases | Key Change |
|-----------|------|--------|------------|
| v1.0 | 5 days | 8 | Established the discuss→plan→execute→verify→review GSD loop with worktree-isolated parallel execution and live-brain.db verification. |
| v2.0 | 2 days | 2 | Spike-before-risky-phase and seam-mirroring compressed delivery; bookkeeping (traceability, archival, arch review) identified as the lagging step. |
| v3.1 | 2 days | 2 | Pre-authorized plan fallbacks (D-06) let a live shader pivot proceed without replan; the bookkeeping lag bit again (v3.0 left unclosed → lumpy combined archive). |
| v6.0 | ~2 days | 6 | Spike-gated the off-distribution survey-quality bet before build; onboarding rode existing seams net-zero deps. Bookkeeping lag bit a THIRD time — interleaved v6.0/v7.0 history left no clean per-milestone tag boundary. |
| v8.0 | ~4 days | 5 (+1 deferred, +2 folded-in) | Baseline-before-optimize enforced as a hard gate; spike chose the zero-dep mechanism; productization phases (44/45) interleaved with the perf line. Bookkeeping lag bit a FOURTH time — scope grew 40–43→40–45 with no audit; Phase 43 (the milestone's own "lock the numbers" thesis) deferred unbuilt. |
| v9.0 | ~23 days | 16 (5 planned + 11 appended) | First audit-before-close since v6.0 — caught the one real blocker (GATE-01 text vs on-demand gate), closed same-day as a quick task. Honest-null discipline (w*=0 ships dark). Bookkeeping lag bit a FIFTH time — scope tripled, checkboxes stale, 5 phases without VERIFICATION.md, SDK 999-misnumber ×4. |
| v10.0 | ~11 days | 8 (7 planned + 1 promoted seed) | Audit → fix → re-audit → close: all clearable findings resolved pre-close via 4 quick tasks. Bookkeeping lag beaten (traceability reconciled before audit). Adversarial gap-closure campaign (7 rounds, Phase 62) became the dominant schedule item; 999-misnumber root-caused on disk after a 5th occurrence. |

### Cumulative Quality

| Milestone | Tests | Notable |
|-----------|-------|---------|
| v1.0 | 522 (521 passing; 1 known environmental flake) | Zero new runtime npm deps for Channel/SourceAdapter surfaces; all seams mock-tested + live-verified. |
| v2.0 | suite green on macOS+Linux CI (lockfile flake fixed via `BRAIN_MEMORY_LOCK_PATH`) | Two new runtime deps total (croner; vendored Three.js assets, no CDN); schema v3→v5 across the milestone + post-ship hardening. |
| v3.1 | full suite green (929+ pass / 2 skip) | Zero new runtime npm deps; schema v6→v7 (atomic migration); `schema_rel` EdgeKind + super-schema nodes flow to the viz payload for free; D-37 firewall sentinel-tested. |
| v6.0 | full suite green; 109 cross-phase integration tests pass, tsc clean (audit) | Zero new runtime npm deps; onboarding reused existing seams (IngestionPipeline/node_scope/consolidation/corpus promoter); 4/4 E2E flows wired; engine invariants held (single-tenant, graph-as-truth, hot path LLM-free, D-43). |
| v8.0 | full suite green (2383 pass / 3 skip), tsc clean | Zero new runtime npm deps (vector index = zero-dep flat-buffer sidecar, NOT sqlite-vec); byte-exact top-k preserved (no accuracy trade for latency); derived-cache discipline extended to the vector index. **No milestone audit run** (closed with Phase 43 as a documented known gap). |
| v9.0 | full suite green (2701 pass / 3 skip), tsc clean | Zero new runtime npm deps (WASM kernel = committed base64 blob, no node-gyp; troika vendored with CDN phone-home patched out); byte-exact retrieval preserved through both the kernel and fusion changes; engine invariants held; regression gate now merge-blocking in CI. Audit `passed` (9/9 integration seams, 3/3 E2E flows). |
| v10.0 | full suite green (4029 pass), tsc clean | TWO new exact-pinned runtime deps (`css-tree@3.2.1`, `htmlparser2@10.0.0`) — the first deliberate net-zero exception since v2.0, spent on conformant parsing of attacker-controlled email; parse5 stayed dev-only as an oracle. D-43 family extended to the approve/reject path (two-layer sentinel); online paths LLM-free incl. `/v1/proposals`; hitl exclusion inherited structurally. Audit `tech_debt`, zero critical blockers (30/30 REQ, 8/8 seams, 8/8 flows, one continuous 8-stage E2E). |

### Top Lessons (Verified Across Milestones)

1. Dogfood against real data — mock-only suites hide production no-ops. *(v1.0)*
2. Lock + `process.exit` discipline belongs in the CLI skeleton, not memory. *(v1.0)*
3. Plan-ordering is not a runtime gate — production-touching code needs a default-OFF flag. *(v1.0, re-confirmed v2.0)*
4. Flip requirements/traceability at phase close; archive the milestone the day it ships. *(v2.0, re-confirmed v3.1, re-confirmed AGAIN v6.0 — leaving v6.0 + v7.0 both open produced interleaved git history with no recoverable per-milestone tag boundary; the cost escalated from lumpy archives to permanent loss of git milestone granularity; re-confirmed a FIFTH time v9.0 — stale checkboxes forced the close to reconstruct requirement status from phase summaries. **First clean hold at v10.0**: traceability reconciled before the audit, clearable findings resolved before the close.)*
5. When a plan authorizes a fallback branch, assert the *delivered* artifact in verification, not the default-path one. *(v3.1 — Phase 19's hardcoded `foldSuppress` check went stale when the hull shipped via the D-06 display-hull branch)*
