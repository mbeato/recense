---
phase: 63-offline-intent-classification
reviewed: 2026-08-02T21:18:44Z
depth: standard
files_reviewed: 12
files_reviewed_list:
  - .gitignore
  - scripts/eval/63-intent-prompt-token-delta.cjs
  - scripts/eval/results/63-intent-prompt-token-delta.json
  - src/consolidation/consolidator.ts
  - src/model/claim-extractor.ts
  - src/source/extraction-prompts.ts
  - tests/claim-extractor-intent.test.ts
  - tests/consolidation-intent.test.ts
  - tests/extraction-prompts-intent.test.ts
  - tests/intent-conservation.test.ts
  - tests/no-ats-domain-table.test.ts
  - tests/online-llm-free-sentinel.test.ts
findings:
  critical: 0
  warning: 3
  info: 5
  total: 8
status: issues_found
---

# Phase 63: Code Review Report

**Reviewed:** 2026-08-02T21:18:44Z
**Depth:** standard
**Files Reviewed:** 12
**Status:** issues_found

## Summary

Reviewed the Phase 63 offline intent-classification diff: intent vocabularies/coercers and the all-or-nothing parse gate in `claim-extractor.ts`, the shared `GMAIL_INTENT_CLASSIFICATION_BLOCK` in `extraction-prompts.ts`, intent-field threading through `ClaimDecision`/`PendingJudge` in `consolidator.ts`, the token-delta harness + committed result, the `.gitignore` exception, and six test files.

**Load-bearing invariants — all verified against live source, not comments:**

- **Hard-stop ordering (D-43/C-2):** the inferred/echo/hitl guard at `consolidator.ts:660` `continue`s before extraction and before any of the four intent fill sites (lines 756, 853, 888, 942). Classification inherits the guard by construction. Confirmed correct.
- **Inertness (zero DB writes):** grep of all of `src/` shows `claimIntentStatus`/`claimIntentEntity`/`claimIntentConfidence` are written into `ClaimDecision`/`PendingJudge` and read nowhere — `applyDecision` never touches them, no schema change, no persisted column. Confirmed inert.
- **Field conservation:** all four `ClaimDecision` construction sites (fast-path confirm, auto-unrelated, `pendingJudges.push`, post-verdict fill) thread the three fields; no decision route drops them. Confirmed.
- **No second LLM call:** classification rides the existing extraction prompt; no new `generate` call added. One-call sentinel tests exist and are per-episode (not vacuous).
- **Closed 4-state vocabulary, drop-on-mismatch:** `toIntentStatus`/`toIntentConfidence` return `undefined` on any mismatch (never coerce), and the all-or-nothing gate in `parseClaimsFromArray` clears all three on any partial/invalid set. Schema enum is built from the same `INTENT_STATUSES`/`INTENT_CONFIDENCES` constants. Confirmed.
- **No ATS domain table:** no vendor-domain literal in `src/`; sender domain appears only as prose in the prompt. Guard test is non-vacuous.

No blockers. Three warnings concern (1) the parser/threading path being source-agnostic while the isolation guarantee is prompt-side only, (2) a blind spot in the inertness conservation test's "byte-identical" claim, and (3) the harness clobbering the committed result-of-record on any offline/failed run.

## Warnings

### WR-01: Intent fields are accepted and threaded from ANY source — gmail-only isolation is prompt-side only, and `ClaimDecision` carries no episode source for downstream gating

**File:** `src/model/claim-extractor.ts:376-387`, `src/consolidation/consolidator.ts:771-773, 869-871, 895-897, 958-960`
**Issue:** D-11 isolation is enforced only in the prompt text (non-gmail prompts omit the field names, and `tests/extraction-prompts-intent.test.ts` asserts that). But `parseClaimsFromArray` and the consolidator threading are completely source-agnostic: if a non-gmail extraction response contains `intent_status`/`intent_entity`/`intent_confidence` — via model hallucination, or prompt injection embedded in a conversation/obsidian/web episode's content instructing the extractor to emit them — the parser validates and accepts them, and the consolidator threads them onto the `ClaimDecision` exactly as it would for gmail. `CLAIM_ARRAY_SCHEMA` (shared by all sources' constrained decoding) also now permits the fields for every source. This is harmless *this phase* because the fields are inert, but `ClaimDecision` does not carry `episode.source`, so a Phase 64/65/66 consumer reading `claimIntentStatus` off the decision **cannot** enforce "gmail-derived only" without new plumbing — the source information is already lost at the hop where the intent fields are picked up. That is precisely the field-conservation trap that makes forgetting the gate the path of least resistance later.
**Fix:** Either (a) gate the intent gate on source at the consolidator fill sites now — `claimIntentStatus: episode.source === 'gmail' ? claim.intent_status : undefined` (one predicate, three sites, or hoisted once per episode) — or (b) add `episodeSource` to `ClaimDecision`/`PendingJudge` alongside the intent fields so downstream phases can gate, and record in the Phase 64 plan that the gate MUST be applied at first consumption. Option (a) is smaller and makes the D-11 isolation structural instead of prose-deep.

### WR-02: Inertness conservation test's "byte-identical database" comparison silently skips `consolidation_event.payload` — the most plausible leak channel is outside the compared set

**File:** `tests/intent-conservation.test.ts:231-256, 258-318`
**Issue:** `snapshotDb` compares, per table, `COUNT(*)` plus at most ONE column (`value` if present, else `content`, else nothing). `consolidation_event` has a `value` column, so it is compared on `value` only — its `payload` column (free-form JSON TEXT, `schema.ts:105`) is never inspected. An intent leak that serializes `claimIntentStatus` into the payload of an event row the consolidator already writes would change neither row count nor `value`, so the test titled "produces a byte-identical database" would pass while D-08 inertness is violated. Notably, `tests/consolidation-intent.test.ts`'s header explicitly names "ConsolidationSink payload write on the emit path" as the identified D-08 violation risk — i.e., the known risk channel is exactly the column this test does not cover. Same gap applies to any other multi-TEXT-column table (e.g. `episode` columns other than `content`). The production code is currently clean (verified by grep), but this guard is the thing meant to keep it clean across Phases 64-66.
**Fix:** In `snapshotDb`, for the run-A-vs-run-B comparison, compare ALL columns whose values are deterministic across runs rather than one privileged column — simplest: for each table, select every column except known-nondeterministic ones (`id`, `ts`-like, and embedding blobs), ordered deterministically. At minimum, add `payload` to the compared set for `consolidation_event` and assert the concatenated payloads contain no `"intent"` substring (mirroring the sqlite_master scan at line 391-398).

### WR-03: Any `--offline` or failed harness run overwrites the committed result-of-record JSON with `measured:false`

**File:** `scripts/eval/63-intent-prompt-token-delta.cjs:40, 63-76, 142-166`
**Issue:** `OUT` is the same path for every mode: `scripts/eval/results/63-intent-prompt-token-delta.json`, which is git-tracked (negated in `.gitignore:43` as the "result of record"). The `--offline` mode — documented as "CI-safe" and the first run command in the header — and every `fail()` path (`dist/` missing, wrong provider, sink miscount) all `writeResult()` to that path, replacing the committed `measured:true` evidence with a `measured:false` stub in the working tree. Any subsequent broad `git add`/commit destroys the measured evidence; a CI job running the offline mode dirties the tree on every run. The gitignore comment calls this file a committed result of record, so silent in-place overwrite by non-measuring runs contradicts the file's own D-10 discipline ("dated result files committed manually").
**Fix:** Write offline/failed results to a distinct staged path, e.g. `63-intent-prompt-token-delta-PENDING.json` (already gitignored by the `*PENDING*` rule at `.gitignore:4`), reserving the record path for `measured:true` output — or refuse to overwrite an existing `measured:true` file unless `--force` is passed.

## Info

### IN-01: Comment-stripper in the structural scan can mask a real offender via `//` or `/*` inside a string literal

**File:** `tests/online-llm-free-sentinel.test.ts:300-309`
**Issue:** `stripComments` truncates each line at the first `//` and removes everything between `/*` and `*/` with no string-literal awareness. A future edit like `const u = 'https://x'; await provider.generate(q)` on one line would have the `generate(` call stripped as a "comment," silently defeating the structural half of the guard. The limitation is acknowledged in the docblock and the dynamic half provides partial cover, but the failure mode is a silent pass on exactly the code this sentinel exists to catch.
**Fix:** Only treat `//` as a comment start when not preceded by `:` (cheap URL heuristic), or scan the raw un-stripped text and allowlist the few known comment-only mentions instead.

### IN-02: Harness Arm A is not the true pre-63 baseline — block removal leaves two extra blank lines

**File:** `scripts/eval/63-intent-prompt-token-delta.cjs:102`
**Issue:** `armBPrefix.replace(GMAIL_INTENT_CLASSIFICATION_BLOCK, '')` removes the block but leaves the surrounding `\n\n` + `\n\n` from the template interpolation, so Arm A contains a 4-newline run the real pre-63 prompt never had. Impact is ~0-1 input token — immaterial to the recorded 597-token delta, but the "derived from live source so neither arm can drift" claim is off by whitespace.
**Fix:** `armBPrefix.replace('\n\n' + GMAIL_INTENT_CLASSIFICATION_BLOCK, '')` (and note it in the header comment).

### IN-03: Harness does not pin `RECENSE_ENABLE_EPISODIC_EMAIL`; the result JSON does not record which gmail prompt variant was measured

**File:** `scripts/eval/63-intent-prompt-token-delta.cjs:101`, `scripts/eval/results/63-intent-prompt-token-delta.json`
**Issue:** `promptForSource('gmail')` returns the episodic superset prompt when `RECENSE_ENABLE_EPISODIC_EMAIL=on` is ambient in the shell. A measured run under that env would silently record the larger episodic prompt as "the gmail prompt" and the result JSON gives no way to tell which variant produced `arm_b_prefix_chars: 3822`.
**Fix:** `delete process.env.RECENSE_ENABLE_EPISODIC_EMAIL` at harness start (or record its value in the result object).

### IN-04: `EXTRACTION_MAX_TOKENS` hand-mirrored in the harness instead of imported from dist

**File:** `scripts/eval/63-intent-prompt-token-delta.cjs:45`
**Issue:** The harness already requires four `dist/` modules to stay drift-proof, but hardcodes `8192` with a "kept identical" comment instead of requiring `EXTRACTION_MAX_TOKENS` from `dist/src/model/claim-extractor` (it is exported). If the production constant changes, the harness's "reflects the actual call shape" claim silently drifts — the exact hand-maintained-mirror defect the rest of the file is built to avoid.
**Fix:** `({ EXTRACTION_MAX_TOKENS } = require('../../dist/src/model/claim-extractor'));`

### IN-05: Non-gmail isolation test omits the transcript sources and `claude-code`

**File:** `tests/extraction-prompts-intent.test.ts:70-87`
**Issue:** The D-11 "no non-gmail prompt carries classification field names" test enumerates `gcal, conversation, web, document, code-diff, obsidian, totally-unknown-source-xyz` but skips `granola`/`otter`/`zoom` (the `TRANSCRIPT_EXTRACTION_PROMPT` route) and `claude-code`, and never exercises the `RECENSE_TYPED_EXTRACTION_MODE=merged` route (`MERGED_EXTRACTION_PROMPT`). All are currently clean (verified by reading `extraction-prompts.ts`), but the guard would not catch a future intent-block leak into those prompts.
**Fix:** Add `'granola', 'otter', 'zoom', 'claude-code'` to `nonGmailSources`, and one case with `RECENSE_TYPED_EXTRACTION_MODE=merged` set.

---

_Reviewed: 2026-08-02T21:18:44Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
