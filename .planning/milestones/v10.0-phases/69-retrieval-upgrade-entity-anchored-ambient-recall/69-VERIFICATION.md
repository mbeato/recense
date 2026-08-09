---
phase: 69-retrieval-upgrade-entity-anchored-ambient-recall
verified: 2026-08-03T14:03:39Z
regated: 2026-08-03T14:12:00Z
status: passed_with_open_item
score: 4/6 must-haves verified; both open items re-gated post-fix and confirmed honest null
overrides_applied: 0
gaps:
  - truth: "SC1/RECALL-01 — proper-noun anchoring via LLM-free indexed lookup resolves the 'contract with vtx' class, live"
    status: confirmed_honest_null_post_fix
    reason: "The mechanism (src/retrieval/entity-anchor.ts, wired into engine.ts opts.anchoredIds and ambient-recall.ts) is built, unit-tested, and post-review-hardened (WR-01 punctuation stripping, WR-03 skipExactChannel latency fix, WR-02 entity-neighbor filter). RE-GATE 2026-08-03 against the live 27,016-node graph (post WR-01/WR-03): G5 (latency soft gate) now PASSES — WR-03's skipExactChannel fix cut the p95 delta from +410ms (2.5x, FAIL) to +90ms (1.27x, PASS: 422ms vs 2x baseline 664ms). G2 (no-regression) still FAILS — 16/51 baseline-qualifying rows regressed relevance >0.01 (mean 0.0967->0.0994), the same mean-of-injected-lines dilution pattern as the original gate; WR-01's punctuation fix changes which tokens anchor but does not change that structural metric penalty. Per the flip rule (G1/G2/G4 AND G5 must all pass), `entityAnchoringEnabled` stays dark. Confirmed honest null post-fix, accepted per D-09 (the gate — not the merge — decides); re-gate follow-up (an LLM-judge relevance grader, D-08's documented `--judge` escape hatch) recorded as the correct next step, not implemented here."
    artifacts:
      - path: "src/lib/config.ts"
        issue: "entityAnchoringEnabled: false (line ~1024) — capability dark; re-gate 2026-08-03 annotation appended at line ~1035 recording G5-now-passes/G2-still-fails"
    missing: []
  - truth: "SC2/RECALL-02 (rendering half) — foreign-project doc-type facts re-render as title + recense:// link instead of a truncated 200-char body, live"
    status: confirmed_honest_null_post_fix
    reason: "renderAmbientBlock's docLinks mode (src/adapter/ambient-recall.ts) is built and unit-tested, but `ambientDocLinkRenderEnabled` defaults to `false`. RE-GATE 2026-08-03 against the same 58-prompt set again surfaced 0/58 doc-type rows — still a vacuous pass, unchanged from the original gate (no code touched in the WR-01/WR-03 fix pass affects doc-candidate surfacing, so this was expected). Confirmed honest null post-fix, accepted per D-09; follow-up is an eval-set addition that exercises a doc-type candidate, not implemented here (out of this re-gate's scope)."
    artifacts:
      - path: "src/lib/config.ts"
        issue: "ambientDocLinkRenderEnabled: false (line ~1090) — vacuous gate pass confirmed on re-gate; re-gate annotation appended at line ~1097"
    missing: []
human_verification: []
---

# Phase 69: Retrieval Upgrade — Entity-Anchored Ambient Recall Verification Report

**Phase Goal:** A memory-shaped prompt surfaces the facts that actually answer it — including facts reachable only by name — and the agent can verify what it was given.
**Verified:** 2026-08-03T14:03:39Z
**Re-gated:** 2026-08-03T14:12:00Z (post fix commits 7895ed1 WR-01, d1e8dde WR-03)
**Status:** passed_with_open_item
**Re-verification:** Yes — original run found 2 gaps (`gaps_found`); this re-gate re-ran the D-08 gate against the post-review-fix code for both dark knobs and confirmed both as honest nulls with updated evidence (see "Re-gate 2026-08-03" section below)

## Goal Achievement

**Framing note (read before the table):** This phase was explicitly eval-first (D-08/D-09): every new behavior ships behind a dark knob, and only the 58-prompt live-graph gate — not the code merge — decides whether a knob flips on. Two of five roadmap success criteria did NOT earn a live flip. This is the gate working as designed, not a code defect, and it is documented honestly in `69-06-SUMMARY.md` and `src/lib/config.ts`'s dated gate-annotation comments. The original run reported this as `gaps_found` rather than silently passed. A re-gate on 2026-08-03 (after the WR-01/WR-03 review fixes that targeted exactly the original failure mechanisms) re-ran the gate for both dark knobs and confirmed both as honest nulls with updated evidence — see "Re-gate 2026-08-03" below. Status is now `passed_with_open_item`: the honest-null outcome is accepted per D-09 (the gate decides), with follow-ups recorded rather than resolved.

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | SC1/RECALL-01: proper-noun anchoring resolves the "contract with vtx" class, LIVE, LLM-free indexed lookup | ✗ FAILED (honest null, re-gated) | Module (`src/retrieval/entity-anchor.ts`) built, type-level provider-free, F2 regression test green (`tests/entity-anchor.test.ts`, 13 cases), wired via `engine.ts opts.anchoredIds` and `ambient-recall.ts`. `entityAnchoringEnabled=false` in `DEFAULT_CONFIG`. Original 69-06 gate: G2 FAILS (0.1009→0.0936, 20/53 regressed), G5 FAILS (p95 682ms vs 272ms baseline, >2x). **Re-gate 2026-08-03 post WR-01/WR-03:** G5 now PASSES (p95 delta +410ms→+90ms, WR-03's skipExactChannel fix), G2 still FAILS (16/51 regressed, mean 0.0967→0.0994). Stays dark — G2 alone blocks the flip rule. |
| 2a | SC2/RECALL-02 (ranking half): foreign-project doc no longer outranks own-project facts | ✓ VERIFIED | `sameProjectRankNudge=0.05`, `foreignDocDemotion=0.10` shipped live in `src/lib/config.ts` (flipped from 0 by 69-06's gate). Ordering-only (never a filter) — `getNodeScopes` D-01 carve-out documented at `src/db/semantic-store.ts`. Gate: G1 4/4 pass, G2 0/53 regressions, mean relevance byte-identical. `tests/ambient-recall.test.ts` covers cross-project preservation. |
| 2b | SC2/RECALL-02 (rendering half): doc nodes render as title + `recense://` link, not truncated body | ✗ FAILED (honest null, vacuous, re-gated) | `renderAmbientBlock` docLinks mode built and unit-tested (`src/adapter/ambient-recall.ts`, `AMBIENT_BLOCK_CHAR_BUDGET`), but `ambientDocLinkRenderEnabled=false` — original 69-06 gate cleared it only because 0/58 eval prompts ever exercised a doc-type row (vacuous pass). **Re-gate 2026-08-03:** still 0/58 doc rows — confirmed vacuous, unchanged (no fix in this pass touches doc-candidate surfacing). |
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

### Re-gate 2026-08-03 (post-fix, this run)

Both dark knobs were re-gated against the live 27,016-node graph after the two review-fix commits
that targeted exactly the original G2/G5 failure mechanisms:
- `7895ed1` WR-01 — anchor tokens strip punctuation (the "vtx?"/"vtx." whiff class)
- `d1e8dde` WR-03 — `skipExactChannel` drops ~45 unindexed node-table scans/prompt (the G5 latency mechanism)

Gate artifacts (gitignored, not committed): `scripts/eval/results/recall-audit/69-gate-baseline.json`,
`69-gate-run.json`.

**Baseline (this run, all 5 knobs dark):** row_count=58, qualifying=51, mean_relevance=0.0967.
**Run (this run, `entityAnchoringEnabled:true` + shipped `sameProjectRankNudge:0.05`/`foreignDocDemotion:0.10`/`ambientHopInjectionEnabled:true`):**

| Gate | Original 69-06 | Re-gate 2026-08-03 |
|---|---|---|
| G1 contract-class | 4/4 pass | 4/4 pass |
| G2 no-regression | FAIL — 20/53 regressed | FAIL — 16/51 regressed (mean 0.0967→0.0994) |
| G3 foreign-doc | vacuous pass | vacuous pass (0 doc rows) |
| G4 budget | pass | pass |
| G5 latency (soft, anchoring-only) | FAIL — p95 458→682ms (+410ms, 2.5x) | **PASS** — p95 305→422ms (+90ms, 1.27x, under 2x/664ms threshold) |

`entityAnchoringEnabled` requires G1/G2/G4 AND G5 to all pass before flipping (per the phase's
flip rule). G5 clearing did not change the outcome because G2 alone still blocks the flip. Stays
dark. `ambientDocLinkRenderEnabled` re-ran against the same 58 prompts and again surfaced 0 doc
rows — confirmed vacuous, unchanged. Both `entityAnchoringEnabled` and `ambientDocLinkRenderEnabled`
doc comments in `src/lib/config.ts` carry a dated re-gate annotation recording these numbers.

### Gaps Summary

Phase 69 shipped 3 of 5 roadmap success criteria live and gate-verified (RECALL-02's ranking half, RECALL-03, RECALL-04, RECALL-05 as the gate mechanism itself), plus a full, tested, review-hardened *capability* for the remaining 2 (RECALL-01 entity anchoring, RECALL-02's doc-link rendering half) that the phase's own eval-first design (D-08/D-09) correctly kept dark because the live-graph gate did not clear them:

- **RECALL-01 (entity anchoring):** original gate measured regression on relevance (G2: 20/53 prompts) and latency (G5: p95 682ms, >2x budget). Post-review hardening (WR-01 punctuation stripping, WR-03 unindexed-scan removal) landed and was re-gated on 2026-08-03: G5 now passes, G2 still fails (16/51 regressed). Confirmed honest null post-fix.
- **RECALL-02 (doc-link rendering):** the gate's pass was vacuous on the original run and remains vacuous on re-gate — 0/58 real prompts ever exercised a doc-type row, so there is still no real evidence either way.

Both are honest, well-documented, and now re-confirmed outcomes of a phase explicitly designed to let the gate say no. Accepted per D-09 (the gate — not the merge — decides) as the phase's current final outcome; re-gate follow-ups are recorded rather than resolved:
- RECALL-01: needs either an LLM-judge relevance grader (`--judge`, documented in `recall-audit-gate.cjs`, not implemented) or a further latency/relevance optimization before it can re-clear G2.
- RECALL-02b: needs an eval-set addition (or graph state) that actually surfaces a doc-type candidate before its gate carries real evidence.

Status updated from `gaps_found` to `passed_with_open_item` — both items are confirmed, evidence-backed honest nulls rather than open questions; no human decision is blocking (D-09 already governs the accept-honest-null-as-final-for-now outcome). Reopen if either follow-up above is picked up in a future phase.

---

_Verified: 2026-08-03T14:03:39Z_
_Verifier: Claude (gsd-verifier)_
