---
phase: 69-retrieval-upgrade-entity-anchored-ambient-recall
verified: 2026-08-03T14:03:39Z
status: gaps_found
score: 4/6 must-haves verified
overrides_applied: 0
gaps:
  - truth: "SC1/RECALL-01 — proper-noun anchoring via LLM-free indexed lookup resolves the 'contract with vtx' class, live"
    status: partial
    reason: "The mechanism (src/retrieval/entity-anchor.ts, wired into engine.ts opts.anchoredIds and ambient-recall.ts) is built, unit-tested (tests/entity-anchor.test.ts F2 regression, orthogonal embedding), and post-review-hardened (WR-01 punctuation stripping, WR-03 skipExactChannel latency fix, WR-02 entity-neighbor filter). But `entityAnchoringEnabled` defaults to `false` in src/lib/config.ts — the 69-06 live-graph gate found it FAILS G2 (mean relevance 0.1009 -> 0.0936, 20/53 rows regressed) and FAILS G5 (latency p95 682ms > 2x baseline 272ms). This is a designed, honest-null outcome of the phase's eval-first gate (D-08/D-09), not a code defect — but as literally written, SC1 does not hold in the live/production system today."
    artifacts:
      - path: "src/lib/config.ts"
        issue: "entityAnchoringEnabled: false (line ~1024) — capability dark, gated off by measured G2/G5 failure"
    missing:
      - "A re-gate run of entityAnchoringEnabled using the WR-01/WR-03 hardening already landed (post-review fix pass), to see whether the punctuation fix and skipExactChannel latency fix change the G2/G5 verdict — or an explicit decision to accept the honest null as the phase's final outcome"
  - truth: "SC2/RECALL-02 (rendering half) — foreign-project doc-type facts re-render as title + recense:// link instead of a truncated 200-char body, live"
    status: partial
    reason: "renderAmbientBlock's docLinks mode (src/adapter/ambient-recall.ts) is built and unit-tested, but `ambientDocLinkRenderEnabled` defaults to `false`. The 69-06 gate cleared it on all 4 hard gates only because 0/58 eval prompts ever surfaced a doc-type candidate to render — a vacuous pass, explicitly logged by the executor as 'not evidence' per the project's no-inflated-metrics discipline, not a verified win."
    artifacts:
      - path: "src/lib/config.ts"
        issue: "ambientDocLinkRenderEnabled: false (line ~1090) — vacuous gate pass, F4 waste (truncated-body doc injections) not yet eliminated live"
    missing:
      - "An eval set (or eval-set addition) that actually exercises a doc-type candidate surfacing in the ambient path, so the gate can produce a real (non-vacuous) verdict before this knob ships on its own merit"
human_verification: []
---

# Phase 69: Retrieval Upgrade — Entity-Anchored Ambient Recall Verification Report

**Phase Goal:** A memory-shaped prompt surfaces the facts that actually answer it — including facts reachable only by name — and the agent can verify what it was given.
**Verified:** 2026-08-03T14:03:39Z
**Status:** gaps_found
**Re-verification:** No — initial verification

## Goal Achievement

**Framing note (read before the table):** This phase was explicitly eval-first (D-08/D-09): every new behavior ships behind a dark knob, and only the 58-prompt live-graph gate — not the code merge — decides whether a knob flips on. Two of five roadmap success criteria did NOT earn a live flip. This is the gate working as designed, not a code defect, and it is documented honestly in `69-06-SUMMARY.md` and `src/lib/config.ts`'s dated gate-annotation comments. It is reported here as `gaps_found` rather than silently passed, per this workflow's explicit instruction not to paper over an honest null — the developer should make the accept/re-gate call explicitly (see the `overrides:` suggestion below), not have it decided implicitly by a verifier marking the phase "passed."

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | SC1/RECALL-01: proper-noun anchoring resolves the "contract with vtx" class, LIVE, LLM-free indexed lookup | ✗ FAILED (honest null) | Module (`src/retrieval/entity-anchor.ts`) built, type-level provider-free, F2 regression test green (`tests/entity-anchor.test.ts`, 13 cases), wired via `engine.ts opts.anchoredIds` and `ambient-recall.ts`. `entityAnchoringEnabled=false` in `DEFAULT_CONFIG` — 69-06 gate: G2 FAILS (0.1009→0.0936 relevance, 20/53 regressed), G5 FAILS (p95 682ms vs 272ms baseline, >2x). Dark by design/measurement, not by omission. |
| 2a | SC2/RECALL-02 (ranking half): foreign-project doc no longer outranks own-project facts | ✓ VERIFIED | `sameProjectRankNudge=0.05`, `foreignDocDemotion=0.10` shipped live in `src/lib/config.ts` (flipped from 0 by 69-06's gate). Ordering-only (never a filter) — `getNodeScopes` D-01 carve-out documented at `src/db/semantic-store.ts`. Gate: G1 4/4 pass, G2 0/53 regressions, mean relevance byte-identical. `tests/ambient-recall.test.ts` covers cross-project preservation. |
| 2b | SC2/RECALL-02 (rendering half): doc nodes render as title + `recense://` link, not truncated body | ✗ FAILED (honest null, vacuous) | `renderAmbientBlock` docLinks mode built and unit-tested (`src/adapter/ambient-recall.ts`, `AMBIENT_BLOCK_CHAR_BUDGET`), but `ambientDocLinkRenderEnabled=false` — 69-06 gate cleared it only because 0/58 eval prompts ever exercised a doc-type row (vacuous pass, explicitly logged as "not evidence" in `69-06-SUMMARY.md`). |
| 3 | SC3/RECALL-03: injected block carries 1-hop relations within the existing token budget | ✓ VERIFIED | `ambientHopInjectionEnabled=true` shipped live (flipped by CR-01 fix, `a688203`). Real exercise: 11 hop lines rendered across the 58-prompt replay. `engine.ts opts.hopCollector` single-pass hand-off (D-06), `honest-trace.ts` carries `rel` additively. WR-04 fix (`ad0e070`) makes the `AMBIENT_BLOCK_CHAR_BUDGET` guarantee exact (scope marker counted inside the per-line cap) — confirmed present in `src/adapter/ambient-recall.ts`. |
| 4 | SC4/RECALL-04: `recense recall` returns cited evidence (node ids + traversed edges), read-only, LLM-free | ✓ VERIFIED | `--evidence` flag in `src/adapter/recall-cli.ts`; `RecallEvidence` type + short-circuit BEFORE `provider.generate` in `src/recall/index.ts`; CR-02 fix (`d209b47`) makes typed-path edge citations real (re-derived from actual out-edges, no fabricated attribution). `tests/recall-evidence.test.ts` locks zero-generate/zero-write/prose-unchanged. |
| 5 | SC5/RECALL-05: every change gated on the 58-prompt eval set, fail-closed, no verbatim prompt leakage | ✓ VERIFIED | `scripts/eval/recall-audit-gate.cjs` (fail-closed on missing set/DB/key), `scripts/eval/69-entity-anchor-latency.cjs`, `eval:recall-gate` npm script. Gate actually run against the live 27,003-node graph; results (G1–G5 per knob) documented with real numbers in `69-06-SUMMARY.md`, not asserted. Output is aggregate-only (sha256-truncated prompt ids), self-check rejects any >200-char or verbatim-input output string. |

**Score:** 4/6 truths verified (5 roadmap SCs, SC2 split into its two explicitly-bundled halves per its own wording)

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `src/retrieval/entity-anchor.ts` | LLM-free indexed prompt-token → entity → facts anchoring | ✓ VERIFIED | 251 lines; exports `extractAnchorTokens`, `collectAnchoredFacts`, `AnchoredFact`, `MAX_ANCHOR_TOKENS`, `MAX_ANCHORED_ENTITIES`, `ANCHOR_LEX_FLOOR`, `ANCHOR_FACTS_PER_ENTITY`, `MAX_ANCHORED_FACTS` — all present. No `ModelProvider` import anywhere (type-level no-provider guarantee, D-03). |
| `tests/entity-anchor.test.ts` | F2 "contract with vtx" regression, orthogonal embedding | ✓ VERIFIED | 270 lines, 13 tests, all passing (verified by direct run). |
| `.planning/REQUIREMENTS.md` | RECALL-01..05 registered with traceability rows | ✓ VERIFIED (registered) / ⚠️ stale status | Section exists with all 5 IDs and SC-cross-refs. Traceability table still reads "Planned" for all five rows and checkboxes remain `[ ]` — not updated post-execution to reflect actual (partial) completion. Documentation drift, not a code gap; noted under Anti-Patterns below. |
| `src/lib/config.ts` | Five dark knobs, defaults reproducing pre-phase behavior | ✓ VERIFIED | All five knobs present with dated gate-annotation comments; final state matches the phase's own documented gate verdict exactly (2 shipped ON + hop injection ON, 2 stayed dark). |
| `src/retrieval/engine.ts` | `opts.anchoredIds` union + `opts.hopCollector` hand-off | ✓ VERIFIED | Both opts present (line ~444-445), gated by `!= null` guards, WR-05-fixed to filter hops to actually-returned rows only. |
| `src/adapter/ambient-recall.ts` | cwd-aware ambientRecall, anchored union, ordering-only nudge, `renderAmbientBlock` | ✓ VERIFIED | `cwd` param threaded (default `''`), `cwdToScope`, `collectAnchoredFacts` gated on `entityAnchoringEnabled`, `renderAmbientBlock` exported with `docLinks` opt and `AMBIENT_BLOCK_CHAR_BUDGET`. |
| `src/adapter/turn-capture-cli.ts` | cwd threaded from hook payload into ambientRecall | ✓ VERIFIED | `ambientRecall(db, promptText, provider, config, realClock, cwd)` call site confirmed at line 118. |
| `src/recall/index.ts` | `RecallEvidence` type + evidence short-circuit | ✓ VERIFIED | Confirmed (required `-a`/binary-safe grep due to a UTF-8 em-dash byte in the file's header comment tripping default `grep`'s binary heuristic — a tooling quirk, not a code issue). `evidence` field, `NULL_EVIDENCE_RESULT`, short-circuit before compose, present as described. |
| `src/adapter/recall-cli.ts` | `--evidence` bare flag | ✓ VERIFIED | `IS_EVIDENCE = process.argv.includes('--evidence')`, evidence-shaped safe-null on every early exit. |
| `scripts/eval/recall-audit-gate.cjs` | Fail-closed G1-G4 replay harness | ✓ VERIFIED | 18,459 bytes, present, `eval:recall-gate` npm script wired. |
| `scripts/eval/69-entity-anchor-latency.cjs` | p50/p95 latency probe | ✓ VERIFIED | Present, measured numbers reported in 69-06-SUMMARY.md, not asserted as a hard gate (probe only). |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `entity-anchor.ts` | `entity-resolution.ts` | `EntityResolver.generateCandidates` (reused, `skipExactChannel` opt added WR-03) | ✓ WIRED | Confirmed both `skipExactChannel: true` call sites in entity-anchor.ts and the corresponding opt in entity-resolution.ts. |
| `engine.ts` | `honest-trace.ts` | `buildAmbientTracePayload` single-pass hop hand-off | ✓ WIRED | `hopCollector` fed from the same pass that feeds the viz sink; WR-05 narrows the payload to `finalResultIds`. |
| `ambient-recall.ts` | `entity-anchor.ts` | `collectAnchoredFacts`, gated on `config.entityAnchoringEnabled` | ✓ WIRED | Confirmed at line 313/316 — gate present, but the gate's own default keeps this dark in production (see gap #1). |
| `ambient-recall.ts` | `engine.ts` | `retrieveRanked opts.anchoredIds` | ✓ WIRED | Confirmed line 337. |
| `turn-capture-cli.ts` | `lib/scope.ts` | `cwd → cwdToScope` inside `ambientRecall` | ✓ WIRED | Confirmed cwd argument threaded end-to-end from the hook call site into `ambientRecall`'s `cwdToScope(cwd)` call. |
| `recall-cli.ts` | `recall/index.ts` | `engine.recall(query, sessionId, scope, { evidence })` | ✓ WIRED | Confirmed line 195. |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Phase-specific test files pass | `npx vitest run tests/entity-anchor.test.ts tests/retrieval-anchor-union.test.ts tests/ambient-recall.test.ts tests/recall-evidence.test.ts tests/honest-trace.test.ts` | 5 files, 75 tests, all passed | ✓ PASS |
| Full suite regression | `npx vitest run` | 241 files passed / 1 skipped (242); 4014 tests passed / 6 expected-fail / 3 skipped (4023) | ✓ PASS — matches the count claimed in `69-REVIEW.md` exactly; no strip-hidden flake observed this run |
| Typecheck | `npx tsc --noEmit -p .` | exit 0, no output | ✓ PASS |
| No debt markers in phase-touched files | `grep -n -E "TBD\|FIXME\|XXX"` across all 12 modified source/script files | no matches | ✓ PASS |

### Probe Execution

Not applicable — this phase's "probe" is the eval gate itself (`scripts/eval/recall-audit-gate.cjs`), which requires the founder's live personal graph (`~/.config/recense/recense.db`) and a real `OPENAI_API_KEY`, and reads a gitignored personal-prompt JSONL (`memory-shaped-evalset.jsonl`) that this verifier is instructed never to read or re-run with. The gate's prior real run is documented with concrete numbers in `69-06-SUMMARY.md` (reproduced in the truths table above) and is treated as evidence, not re-executed here — re-running it would re-touch personal data outside this verifier's read-only/no-personal-data mandate.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|---|---|---|---|---|
| RECALL-01 | 69-01, 69-02, 69-03 | LLM-free indexed entity anchoring resolves "contract with vtx" class | ⚠️ Built, not live | Module + wiring complete and tested; `entityAnchoringEnabled=false` (gate: G2+G5 fail). See gap #1. |
| RECALL-02 | 69-01, 69-03, 69-04 | Cross-project preserved, foreign doc no longer outranks, doc re-rendered as title+link | ⚠️ Partially live | Rank nudge half shipped and gated ON; doc-link rendering half built but dark (vacuous gate pass). See gap #2. |
| RECALL-03 | 69-02, 69-04 | Injected block carries 1-hop relations within budget | ✓ SATISFIED | `ambientHopInjectionEnabled=true` live, real exercise (11 hop lines/58 prompts), budget guarantee hardened (WR-04). |
| RECALL-04 | 69-05 | `recense recall` evidence mode | ✓ SATISFIED | `--evidence` flag live, zero-generate/zero-write tested, CR-02 fabrication fix landed. |
| RECALL-05 | 69-06 | Every change gated on the 58-prompt eval set | ✓ SATISFIED | Fail-closed gate built and run for real against the live graph; results documented with real, non-hardcoded numbers. |

No orphaned requirements — all 5 RECALL IDs declared across plans match the roadmap's phase-69 requirement list exactly.

**Bookkeeping note:** `.planning/REQUIREMENTS.md`'s RECALL section still shows unchecked `[ ]` boxes and "Planned" status for all five IDs in the traceability table, despite 3/5 (RECALL-03/04/05) being fully live and the other 2 having a documented, gate-verified honest-null outcome. This should be reconciled once the gap-01/gap-02 decision below is made (checkbox state should reflect the final, human-accepted outcome — not left at "Planned").

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| `.planning/REQUIREMENTS.md` | 89-93, 155-159 | Traceability rows/checkboxes not updated post-execution | ℹ️ Info | Cosmetic/tracking drift only; does not affect shipped behavior. Reconcile after the override/re-gate decision. |

No debt markers (TBD/FIXME/XXX), no placeholder returns, no hardcoded-empty stubs found in any of the 12 phase-touched source/script files.

### Human Verification Required

None. Both open items (SC1, SC2b) are fully observable in the codebase (config default + documented gate numbers) — no visual, real-time, or external-service behavior needs a human to exercise it to determine status. What DOES need a human decision is a product call, captured below as an override suggestion rather than a "human_needed" test.

### Gaps Summary

Phase 69 shipped 3 of 5 roadmap success criteria live and gate-verified (RECALL-02's ranking half, RECALL-03, RECALL-04, RECALL-05 as the gate mechanism itself), plus a full, tested, review-hardened *capability* for the remaining 2 (RECALL-01 entity anchoring, RECALL-02's doc-link rendering half) that the phase's own eval-first design (D-08/D-09) correctly kept dark because the live-graph gate did not clear them:

- **RECALL-01 (entity anchoring):** measured regression on relevance (G2: 20/53 prompts) and latency (G5: p95 682ms, >2x budget) on the live 58-prompt replay. Post-review hardening (WR-01 punctuation stripping, WR-03 unindexed-scan removal) landed specifically to improve the odds of a future re-gate, but that re-gate has not yet been run.
- **RECALL-02 (doc-link rendering):** the gate's pass was vacuous — 0/58 real prompts ever exercised a doc-type row, so there is no real evidence either way.

Both are honest, well-documented outcomes of a phase explicitly designed to let the gate say no. They are reported as `gaps_found` (not silently passed) because SC1 and half of SC2 do not hold in the live system as literally written in the roadmap. Recommended path: either (a) accept both as the phase's final, intentional outcome via the override block below, updating REQUIREMENTS.md accordingly, or (b) schedule a small follow-up phase/plan to re-run the gate with the WR-01/WR-03 hardening (RECALL-01) and an eval-set addition that exercises a doc row (RECALL-02b).

**Suggested overrides** (if the honest-null outcome is accepted as-is):

```yaml
overrides:
  - must_have: "SC1/RECALL-01 — proper-noun anchoring resolves the contract-with-vtx class, live"
    reason: "Capability built, tested, and review-hardened; kept dark by the phase's own eval-first gate design (D-08/D-09) after a measured G2/G5 failure. Accepted as this phase's honest-null outcome; re-gate deferred to a future phase."
    accepted_by: "<name>"
    accepted_at: "<ISO timestamp>"
  - must_have: "SC2/RECALL-02 (rendering half) — doc nodes render as title + recense:// link, live"
    reason: "Capability built and tested; gate pass was vacuous (0/58 prompts exercised a doc row), so shipping it live would be an unverified change. Accepted as deferred pending an eval-set addition that exercises this path."
    accepted_by: "<name>"
    accepted_at: "<ISO timestamp>"
```

---

_Verified: 2026-08-03T14:03:39Z_
_Verifier: Claude (gsd-verifier)_
