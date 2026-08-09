---
phase: 63-offline-intent-classification
reviewed: 2026-08-02T22:05:00Z
depth: standard
files_reviewed: 6
files_reviewed_list:
  - scripts/eval/63-intent-prompt-token-delta.cjs
  - scripts/eval/results/63-intent-prompt-token-delta.json
  - src/source/extraction-prompts.ts
  - tests/extraction-prompts-intent.test.ts
  - tests/no-ats-domain-table.test.ts
  - tests/online-llm-free-sentinel.test.ts
findings:
  critical: 0
  warning: 6
  info: 6
  total: 12
status: issues_found
---

# Phase 63: Code Review Report

**Reviewed:** 2026-08-02T22:05:00Z
**Depth:** standard
**Files Reviewed:** 6
**Status:** issues_found

## Summary

Reviewed the six phase-63 files in scope: the token-delta eval harness and its results artifact, the gmail intent-classification prompt block in `extraction-prompts.ts`, and the three new test files (prompt routing, ATS-domain guard, online-LLM-free sentinel).

Cross-file verification performed beyond the file list (read-only): the intent fields the new prompt instructs the model to emit (`intent_status`/`intent_entity`/`intent_confidence`) survive parsing — `parseClaimsFromArray` (claim-extractor.ts:376-397) enforces the all-or-nothing triple the prompt promises, and the consolidator threads all three through to the sink (consolidator.ts:771-773, 869-871, 895-897). No field-conservation break. Also verified `MERGED_EXTRACTION_PROMPT` contains no intent field names, so D-11 non-gmail isolation holds even under `RECENSE_TYPED_EXTRACTION_MODE=merged`, and verified `src/adapter/serve-cli.ts` currently contains zero `.generate(`/`.judge(`/`.judgeBatch(` calls (relevant to WR-04).

No critical issues. Six warnings — the highest-value ones are two guard-set gaps (WR-04 structural scan omits the `/v1/surface` handler source; WR-06 ATS guard scans a narrower set than its documented rule), one vacuous test assertion (WR-03), and two environment-sensitivity defects in the eval harness (WR-01, WR-02) that can silently produce a mislabeled or misplaced measurement artifact.

## Warnings

### WR-01: Token-delta harness is silently sensitive to ambient RECENSE_ENABLE_EPISODIC_EMAIL

**File:** `scripts/eval/63-intent-prompt-token-delta.cjs:101`
**Issue:** Arm B is `promptForSource('gmail')`, which returns the episodic-variant prompt when `RECENSE_ENABLE_EPISODIC_EMAIL=on` is set in the shell (extraction-prompts.ts:397). The harness never clears or records this env var. A measured run in a shell where that flag is on would measure the block's delta on top of the *episodic* prompt while labeling arm A "baseline" — a different arm-A token count than production's actual baseline — and the results JSON gives no way to detect which variant was measured. For a harness whose entire design contract is "honest, not estimated" and whose output was founder-approved as the phase's token figure, an unrecorded variant switch is a real integrity gap. (The committed results JSON's `arm_a_prefix_chars: 1120` matches the non-episodic prompt, so the shipped artifact itself was measured correctly.)
**Fix:**
```js
// Pin the variant before building arms, and record it in the result:
delete process.env.RECENSE_ENABLE_EPISODIC_EMAIL;
const armBPrefix = promptForSource('gmail');
// ...and add to crossCheck: episodic_email_variant: false
```

### WR-02: Harness output path is cwd-relative while module requires are script-relative

**File:** `scripts/eval/63-intent-prompt-token-delta.cjs:40`
**Issue:** `OUT = path.join('scripts', 'eval', 'results', ...)` resolves against `process.cwd()`, but the `require('../../dist/...')` calls at lines 91-94 resolve against the script's own directory. Run from any directory other than the repo root, the harness succeeds (requires work, claude calls spend real tokens) and then silently writes the results JSON — via `mkdirSync(..., { recursive: true })` at line 65 — into a spurious `scripts/eval/results/` tree under the wrong cwd, leaving the canonical artifact stale.
**Fix:**
```js
const OUT = path.join(__dirname, 'results', '63-intent-prompt-token-delta.json');
```

### WR-03: Retrieval sentinel's dynamic assertion is vacuous — provider is never wired into the engine

**File:** `tests/online-llm-free-sentinel.test.ts:172-178`
**Issue:** The "retrieval is LLM-free" dynamic test constructs `provider` but never passes it to `RetrievalEngine` or any collaborator (line 169 takes no provider). The assertion `expect(provider.embedCount).toBe(embedCountBefore)` therefore cannot fail under any possible change to `retrieveRanked` — a future `retrieveRanked` that called an LLM through some other channel would still pass. The test's comment admits this ("exists in scope only to prove retrieveRanked never touches it"), but a test that cannot fail proves nothing dynamically; the actual guarantee for retrieval rests entirely on the structural scan (which is what WR-04 weakens). This is a reliability defect in a regression lock whose stated job is keeping the boundary honest "across future phases."
**Fix:** Either drop the provider/assertion from this test (making it purely a "constructs without a provider" compile-level proof, honestly labeled), or make the dynamic half real: assert via the type system/constructor that no `ModelProvider` can reach `RetrievalEngine`, e.g. a test that `RetrievalEngine.length`/constructor signature accepts no provider, plus keep the structural scan as the enforcement.

### WR-04: Structural scan set omits serve-cli.ts, the source of the GET /v1/surface online path

**File:** `tests/online-llm-free-sentinel.test.ts:342-345`
**Issue:** D-13 (quoted in this file's own header, lines 4-5) names three online paths: SessionStart inject, retrieval, and `GET /v1/surface`. The structural scan covers `src/adapter/ambient-recall.ts` + `src/retrieval/*.ts` only — `src/adapter/serve-cli.ts`, which implements the surface route, is not scanned. A future `.generate(` added to serve-cli (e.g., in a new route branch or an error path) would be caught only if the single dynamic request in this file happened to exercise that exact branch; the guard-set is narrower than the ship-set the file claims to lock. Verified: serve-cli.ts contains zero `.generate(`/`.judge(`/`.judgeBatch(` calls today, so adding it to the scan set is free — no false positives.
**Fix:**
```ts
const scanPaths = [
  path.join(process.cwd(), 'src', 'adapter', 'ambient-recall.ts'),
  path.join(process.cwd(), 'src', 'adapter', 'serve-cli.ts'),
  ...collectTsFiles(path.join(process.cwd(), 'src', 'retrieval')),
];
```

### WR-05: Surface-route afterEach masks setup failures and clobbers pre-existing RECENSE_LOCK_PATH

**File:** `tests/online-llm-free-sentinel.test.ts:233-238`
**Issue:** `afterEach` calls `await serverResult.close()` unguarded. If the test fails before `serverResult` is assigned (e.g., `createBrainHttpServer` throws, port bind fails), `afterEach` throws `TypeError: Cannot read properties of undefined`, masking the root-cause failure in the report. The other two describes guard their cleanup with try/catch (lines 100-102); this one doesn't. Secondarily, `delete process.env['RECENSE_LOCK_PATH']` discards any pre-existing value rather than restoring it.
**Fix:**
```ts
afterEach(async () => {
  try { await serverResult?.close(); } catch { /* ignore */ }
  ...
});
```
Save and restore the prior `RECENSE_LOCK_PATH` value instead of unconditionally deleting.

### WR-06: ATS-domain guard scans a narrower set than the rule it claims to enforce

**File:** `tests/no-ats-domain-table.test.ts:26-36, 80-87`
**Issue:** The docstring states the D-03 rule as "never as a lookup table in config or code" and the test title claims "anywhere under src/", but `collectTsFiles` collects only `*.ts` files under `src/`. A fingerprint table in a `.json` data file under `src/` (importable via `resolveJsonModule`), or in `scripts/` (which the token-delta harness demonstrates is live production-adjacent code in this repo), evades the guard entirely while violating the stated rule. Guard-set must match the documented ship-set or the docstring must be narrowed to what is actually enforced.
**Fix:** Extend the walk to `.ts` + `.json` under `src/` (and optionally `scripts/`), or amend the docstring/test title to state the true scope ("all .ts files under src/") so the enforcement claim is honest.

## Info

### IN-01: Harness arm A is not byte-identical to the pre-phase-63 baseline prompt

**File:** `scripts/eval/63-intent-prompt-token-delta.cjs:102`
**Issue:** `armBPrefix.replace(GMAIL_INTENT_CLASSIFICATION_BLOCK, '')` removes the block but leaves the surrounding interpolation newlines (extraction-prompts.ts:88-92), so arm A contains a run of four consecutive newlines where the true pre-63 baseline had two. Token impact is ~0-1 tokens — immaterial to the 597-token delta — but the "baseline" label is approximate, worth a comment.
**Fix:** `armBPrefix.replace('\n' + GMAIL_INTENT_CLASSIFICATION_BLOCK + '\n', '')` or note the approximation in the header comment.

### IN-02: EXTRACTION_MAX_TOKENS duplicated instead of imported from dist

**File:** `scripts/eval/63-intent-prompt-token-delta.cjs:45`
**Issue:** The constant is hand-mirrored (`8192`) with a comment promising it stays identical to `src/model/claim-extractor.ts`, but that module exports `EXTRACTION_MAX_TOKENS` (claim-extractor.ts:259) and the harness already requires sibling dist modules. Drift risk is unnecessary.
**Fix:** `const { EXTRACTION_MAX_TOKENS } = require('../../dist/src/model/claim-extractor');` inside the existing try block.

### IN-03: Dead code — unreachable returns after process.exit, and a pointless branch in judgeBatch stub

**File:** `scripts/eval/63-intent-prompt-token-delta.cjs:98,111,166-167` and `tests/online-llm-free-sentinel.test.ts:69-73`
**Issue:** Every `return` following `fail(...)` and the `return` after `process.exit(0)` are unreachable (`fail` exits). In the sentinel, `judgeBatch`'s `if (items.length === 0)` branch throws the identical error as the fall-through — both branches are the same statement.
**Fix:** Drop the unreachable returns (or have `fail` return never and remove exit from callers); collapse the judgeBatch stub to a single throw (use `void items;` if the param must appear used).

### IN-04: Structural-scan predicate has documented and undocumented evasions

**File:** `tests/online-llm-free-sentinel.test.ts:300-324`
**Issue:** `stripComments` truncates any line at the first `//` including inside string literals — a line like `const u = 'https://x'; await provider.generate(q)` hides a real offender (the comment acknowledges the string-literal blindness, but the scan set is open to future files where this bites). Separately, `OFFENDER_RE` matches only dot-call syntax: `provider['generate'](...)` or `const { generate } = provider; generate(...)` evade undetected, and this limitation is not documented.
**Fix:** Document the aliased/bracket-access evasion alongside the existing string-literal caveat, or tighten the regex to also match `['"]generate['"]\]` and bare `generate(`/`judge(` identifiers within the closed scan set.

### IN-05: collectTsFiles duplicated across test files

**File:** `tests/no-ats-domain-table.test.ts:26-37` and `tests/online-llm-free-sentinel.test.ts:327-338`
**Issue:** Identical recursive `.ts` walker implemented twice in this phase (and the pattern also exists in `tests/src-import-boundary.test.ts` per both files' own comments). Three copies of a filesystem walker is drift-prone — especially given WR-06 shows the walkers' file-extension filter is itself a guard-scope decision.
**Fix:** Extract a shared `tests/helpers/collect-ts-files.ts` and import it from all three guards.

### IN-06: Prompt-routing tests don't pin RECENSE_TYPED_EXTRACTION_MODE and clobber ambient env

**File:** `tests/extraction-prompts-intent.test.ts:23-25, 70-87`
**Issue:** The D-11 isolation test routes `obsidian`/`totally-unknown-source-xyz` through `promptForSource`, whose default branch switches on `RECENSE_TYPED_EXTRACTION_MODE` (extraction-prompts.ts:417). The test passes today under either value (verified: `MERGED_EXTRACTION_PROMPT` carries no intent field names), but the route under test is env-dependent and unpinned — a future intent addition to the merged prompt would be caught only under whichever mode the CI shell happens to have. Also, `afterEach` unconditionally deletes `RECENSE_ENABLE_EPISODIC_EMAIL` rather than restoring a pre-existing value.
**Fix:** Pin `delete process.env['RECENSE_TYPED_EXTRACTION_MODE']` (and optionally run the isolation loop under both modes); save/restore the episodic env var's original value in `beforeEach`/`afterEach`.

---

_Reviewed: 2026-08-02T22:05:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
