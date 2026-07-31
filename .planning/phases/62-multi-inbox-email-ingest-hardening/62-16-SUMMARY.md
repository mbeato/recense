---
phase: 62-multi-inbox-email-ingest-hardening
plan: 16
subsystem: testing
tags: [css-tree, css-syntax-level-3, tokenizer, css-parser, security-oracle, email-ingest, prompt-injection]

# Dependency graph
requires:
  - phase: 62-multi-inbox-email-ingest-hardening (waves 9-15)
    provides: strip-hidden.ts's hand-rolled CSS scanner, the FB-01/CR-04 open findings, and the
      three planning-time escaped-selector candidates this plan re-derives
provides:
  - css-tree@3.2.1 pinned as a production dependency, gated against CSS Syntax Level 3 §4.3 by a
    shipped conformance test written from the spec, not from this phase's repro history
  - a test-only liveness oracle (css-tree's own parser) that answers, independently of any recense
    code, which bare .class/#id selectors a conformant CSS engine treats as live
  - a shipped adjudication table converting every open finding (FB-01, CR-04, three
    planning-candidate escaped selectors) into assertions, with the operator-confirmed disposition
    reclassify applied
affects: [62-17, 62-18, 62-19]

# Tech tracking
tech-stack:
  added: ["css-tree@3.2.1 (production dep, tokenizer subpath only from src/)"]
  patterns:
    - "Test-only oracle pattern: a second, independent implementation (css-tree's parser) used
      only in tests/ to judge production code, never imported from src/, enforced by an ambient
      .d.ts that declares only the narrow tokenizer surface for src/"
    - "Documented expected-failure rows (vitest it.fails) to keep a suite green while pinning a
      known defect as a shipped, named assertion instead of prose"

key-files:
  created:
    - src/types/css-tree-tokenizer.d.ts
    - tests/css-tokenizer-conformance.test.ts
    - tests/support/css-liveness-oracle.ts
    - tests/support/css-tree-ambient.d.ts
    - tests/css-liveness-adjudication.test.ts
  modified:
    - package.json
    - package-lock.json
    - .planning/phases/62-multi-inbox-email-ingest-hardening/62-17-PLAN.md

key-decisions:
  - "css-tree@3.2.1 adopted as the only conformant, independently-maintained CSS tokenizer/parser
    available; postcss is disqualified (wrong on both FB-01 and CR-04's own input shapes)"
  - "Task 4 disposition: reclassify — FB-01 and CR-04 are non-defects on their reported inputs;
    scope of 62-17 corrected from three escaped-selector leaks to the two 62-16 actually confirmed"
  - "CR-04's underlying mechanism (matchesUrlOpen lacks a token-boundary check) stays open and
    unfixed — the reclassification closes only the two reported input shapes, not the mechanism"
  - "Own re-derivation overturned planning's own adjudication table on one row: .leg\\al decodes to
    U+000A + l (the CSS content:\"\\A\" newline idiom), never the letter a, so it cannot match
    class=\"legal\" in any real browser — a correct non-leak, not a third genuine leak"

patterns-established:
  - "A disagreeing measurement wins over a planning-time table, and the disagreement is recorded
    explicitly (in the shipped test and in this SUMMARY), never silently reconciled"

requirements-completed: [EMAIL-03]

# Metrics
duration: 37min
completed: 2026-07-31
---

# Phase 62 Plan 16: css-tree Adoption + Liveness Oracle + Adjudication Summary

**Pinned css-tree@3.2.1's tokenizer against CSS Syntax §4.3, built a css-tree-parser-based liveness oracle independent of recense's own code, and used it to show both chartered blockers (FB-01, CR-04) are non-defects on their reported inputs while two previously-unfiled CSS-escaped-selector leaks are real — disposition `reclassify` confirmed by the operator.**

## Performance

- **Duration:** 37 min
- **Started:** 2026-07-31T15:47:44Z
- **Completed:** 2026-07-31T16:24:25Z
- **Tasks:** 4 (1 human-verify gate, 2 auto/tdd, 1 decision checkpoint)
- **Files modified:** 9 (5 created, 3 modified in `src/`/`package.json`/`package-lock.json`, 1 plan-doc correction)

## Accomplishments

- `css-tree@3.2.1` pinned with `--save-exact`, typed by a local ambient declaration exposing only
  `tokenize`/`tokenTypes` to `src/`; verified via `require.cache` that the tokenizer entry point
  loads exactly 8 files from exactly one package (zero transitive packages reachable)
- A shipped §4.3 conformance gate (`tests/css-tokenizer-conformance.test.ts`) asserting css-tree's
  agreement with the spec on every production behind the six historical bypasses, plus two
  characterized-deviation locks (BOM skip, ≤1 offset overrun) and a 20,000-input totality fuzz
- A test-only liveness oracle (`tests/support/css-liveness-oracle.ts`) built on css-tree's real
  parser — decodes CSS escapes via css-tree's own `ident.decode`, never imported from `src/`
- A shipped, per-finding adjudication table (`tests/css-liveness-adjudication.test.ts`, 55 assertions)
  re-deriving every open finding independently, overturning one row of planning's own table
- Operator-confirmed Task 4 disposition (`reclassify`) applied: FB-01/CR-04 reclassifications
  pinned as shipped assertions (not prose); the CR-04 mechanism finding explicitly kept open and
  visibly tracked; 62-17's stated scope corrected from three escaped-selector leaks to two

## Task Commits

1. **Task 1: Package legitimacy gate — css-tree@3.2.1** — satisfied by explicit human approval
   recorded by the orchestrator before this agent started (no code commit; gate only)
2. **Task 2: Install css-tree (pinned), declare tokenizer subpath, ship §4.3 conformance gate** -
   `8f9617b` (feat)
3. **Task 3: Build the liveness oracle and adjudicate every open finding** - `fa17235` (test)
4. **Task 4: Adjudication review — apply operator-confirmed `reclassify` disposition** - `5027d27`
   (docs)

**Plan metadata:** (this commit) `docs(62-16): complete css-tree adoption + liveness oracle plan`

## Files Created/Modified

- `src/types/css-tree-tokenizer.d.ts` - narrow ambient declaration (`tokenize`, `tokenTypes` only)
  constraining `src/` to the tokenizer subpath
- `tests/css-tokenizer-conformance.test.ts` - §4.3 conformance gate + two characterized-deviation
  locks + 20k-input totality fuzz, all seeded LCG
- `tests/support/css-liveness-oracle.ts` - test-only `liveHidingSelectors()`, css-tree parser +
  `ident.decode`, never reachable from `src/`
- `tests/support/css-tree-ambient.d.ts` - untyped ambient declaration for the full `css-tree`
  package, scoped to `tests/` only (needed so `tsc --noEmit` passes on the oracle's parser import)
- `tests/css-liveness-adjudication.test.ts` - 55 assertions pairing oracle verdict with shipped
  behavior for every open finding, corpus row, and the CR-04 mechanism tracking block
- `package.json`, `package-lock.json` - `css-tree: 3.2.1` (exact pin), 2 new packages
  (`mdn-data`, `source-map-js` transitive but unreachable from the tokenizer entry point)
- `.planning/phases/62-multi-inbox-email-ingest-hardening/62-17-PLAN.md` - scope corrected from
  three to two confirmed escaped-selector leaks; fixed an incorrect `.leg\al` test expectation the
  plan had drafted

## Decisions Made

- **css-tree@3.2.1, not a hand-rolled §4.3 transcription.** postcss is disqualified (measured wrong
  on both FB-01's and CR-04's own input shapes); a seventh hand-rolled scanner has no independent
  oracle better than the sixth had. Production surface limited to `tokenize`/`tokenTypes` from the
  `/tokenizer` subpath; the parser is test-only.
- **Task 4 disposition: `reclassify`** (operator-selected after seeing the full table below). FB-01
  and CR-04 stay reclassified as measured non-defects on their reported inputs. CR-04's mechanism
  defect (`matchesUrlOpen` has no token-boundary check) is explicitly NOT closed by this — it
  remains open until 62-17's token-walk rewrite retires the hand-rolled scanner entirely.
- **62-17's scope corrected from three to two confirmed-live escaped-selector leaks.** Only
  `.leg\61 l` and `#leg\61 l` are real; `.leg\al` is a correctly-adjudicated non-leak (see below).

## Full Measured Verdict Table

Every row below is my own independent re-derivation using css-tree's actual parser AST and
`ident.decode`, cross-checked against production `stripHiddenContent` directly (not planning's
throwaway scratch oracle). Rows are shipped as assertions in `tests/css-liveness-adjudication.test.ts`.

| Row | Oracle verdict | Shipped `stripHiddenContent` | Classification |
|---|---|---|---|
| **FB-01** (verifier's exact input) | **NOT LIVE** — `.legal` never becomes its own rule; the bad-string keeps tokenizing inside `.a`'s still-open block | payload present | **AGREEMENT — not a leak** |
| FB-01 rebalancing control (extra `}`) | LIVE | stripped | correct |
| **CR-04 shape 1** (unterminated false url-span) | **NOT LIVE** — whole stylesheet is one top-level `Raw` node, no `Rule` at all | payload present | **AGREEMENT — not a leak** |
| **CR-04 shape 2** (terminated false url-span glued to selector) | **NOT LIVE** — `Rule` exists but `prelude` is `Raw` (invalid selector) | payload present | **AGREEMENT — not a leak** |
| CR-04 declaration-position control | LIVE | stripped | correct (bug can't reach a selector from declaration position) |
| VF-01, all 3 shapes | LIVE | stripped | correct |
| NEW-01 both-directions twin | LIVE | stripped, trailing prose kept | correct |
| 9 string/url/escape controls (`strip-hidden.ts:407-501`) | LIVE (all 9) | stripped (all 9) | correct |
| `@media screen` / `@media print` | LIVE (oracle doesn't evaluate media conditions — shares production's blind spot) | stripped | **accepted over-strip**, pinned explicitly |
| BL-01, BL-02 (×2) | LIVE | stripped | correct |
| **`.leg\61 l` vs `class="legal"`** | **LIVE** (decodes to `legal`) | **payload present** | **GENUINE LEAK, never filed** |
| **`#leg\61 l` vs `id="legal"`** | **LIVE** | **payload present** | **GENUINE LEAK, never filed** |
| **`.leg\al` vs `class="legal"`** | **NOT LIVE** — decodes to `"leg\nl"` (one hex digit `a` = U+000A, the CSS `content:"\A"` newline idiom), NOT the letter `a` | payload present | **AGREEMENT — not a leak** (planning's table was wrong here) |
| CR-01 (inline `style="display:none"`) | N/A — no selector, inline styles apply unconditionally | stripped | correct, trivially live |
| CR-02, BL-03 (Subject-header codepoint payloads) | N/A — no CSS at all | stripped (different stage: `stripInvisibleCodepoints`) | correct |
| WR-02 cap (byte-size sentinel) | N/A — no CSS | N/A | out of this plan's scope (cap enforced upstream, in `normalizeGmailMessage`) |

## Disagreement With `62-16-PLAN.md`'s Own Planning-Time Table

`<adjudication_from_planning>` listed `.leg\al{display:none}` vs `class="legal"` as a third genuine
leak (LIVE). Independent re-derivation overturns this — confirmed by css-tree's own `ident.decode`
function, not just hand analysis:

```
$ node -e "console.log(require('css-tree').ident.decode('leg\\al'))"
leg
l          <- literal newline (U+000A) between "leg" and "l"
```

Per CSS Syntax Level 3 §4.3.7 ("consume an escaped code point"): `\a` is a **one-digit** hex escape
— the character immediately after the digit `a` is `l`, which is not itself a hex digit, so the hex
run terminates after one digit. `parseInt('a', 16) === 10 === 0x0A` (LINE FEED), not the letter `a`
(`0x61`). This is the well-known CSS `content:"\A"` newline idiom, not an obscure edge case. The
decoded selector name is `"leg\nl"`, never `"legal"`. A literal newline can never appear inside a
single HTML class token (`class` attribute values are split on ASCII whitespace, which includes
LF), so `.leg\al{display:none}` can **never** match `class="legal"` in any real browser. This row is
a correctly-adjudicated non-leak, not a third genuine leak. Only **two** of planning's three
escaped-selector candidates are real. `62-17-PLAN.md` has been corrected to reflect this (scope
floor: two leaks, not three; the incorrect test-expectation parenthetical for `\al` removed).

## Task 4 Disposition (operator-confirmed: `reclassify`)

Presented to the operator: the full table above, with rows contradicting the filed reports (FB-01,
both CR-04 shapes) and rows that are new (the two genuine escaped-selector leaks) called out
explicitly, plus the `.leg\al` planning-table correction and all three oracle residuals below. The
operator selected **`reclassify`**:

- FB-01 and CR-04 are reclassified as measured non-defects **on their reported inputs**. This is
  shipped as code (assertions in `tests/css-liveness-adjudication.test.ts`), not left as prose.
- **CR-04's mechanism finding stays open and unfixed.** `matchesUrlOpen`
  (`src/source/strip-hidden.ts:463-472`) still has no token-boundary check. Both of 62-16's reported
  repros happen to produce an invalid resulting selector (so a browser drops the rule too on those
  two specific inputs) — that is a property of those two inputs, not a proof the mechanism cannot
  produce a genuine leak on some other input. A dedicated tracking block in
  `tests/css-liveness-adjudication.test.ts` names this explicitly so it cannot be read as silently
  closed. 62-17's token-walk rewrite is what actually retires the mechanism, by deleting
  `matchesUrlOpen` entirely.
- **62-17's scope is corrected to the two confirmed-live escaped-selector leaks** (`.leg\61 l`,
  `#leg\61 l`), not the three planning's throwaway table guessed at. `62-17-PLAN.md` was edited
  accordingly: its `must_haves.truths`, objective, scope-floor paragraph, Task 1's confirmed-leak
  bullet list (the incorrect `.leg\al` test expectation removed and replaced with the correct
  over-strip guardrail expectation), the file-level doc-block update instruction, and Task 2's
  BYPASS_CORPUS row-count acceptance criteria were all updated. `62-19-PLAN.md` was checked and
  needed no changes — its "three" references are all about the unrelated WR-09 gap count or Task-1
  generator count, not escaped-selector leak count.

## Newly-Filed Leaks (never filed by any prior wave)

- **`.leg\61 l{display:none}` vs `class="legal"`** — genuine live leak. `BARE_CLASS_SELECTOR_RE`
  (`/^\.[A-Za-z0-9_-]+$/`) categorically rejects any selector text containing a backslash, so this
  rule is never in the harvest candidate set at all, regardless of what it decodes to.
- **`#leg\61 l{display:none}` vs `id="legal"`** — same root cause, id form.

Both reproduced against `stripHiddenContent` directly (not `dist/`, since Task 3's charter is
measurement-only, no production changes): payload leaks in both cases.

## Oracle Limitations / Blind Spots (verbatim, not softened)

1. **`unresolved` bucket** — verified to fire correctly on escapes encoding U+0000 or a UTF-16
   surrogate (dedicated tests in `tests/css-liveness-adjudication.test.ts` pass:
   `decode('leg\0zz')` and `decode('leg\d800zz')` both land in `unresolved`, never silently
   compared). None of the actual finding/corpus rows adjudicated in this plan hit this bucket.
2. **The oracle's `hasHidingSignature` re-description is deliberately as crude as production's
   own** (unanchored substring regex against a rule's raw block text, not a semantic per-declaration
   check) — this is Task 3's explicit instruction ("reuse the shipped `hasHidingSignature` semantics
   by describing them"), not an oversight. Observed directly: in the FB-01 shape, `.a`'s own block
   registers a false-positive "hiding signature" because the text `display:none` merely *appears*
   inside its malformed `content` string value (a real browser would treat that whole declaration as
   invalid and apply no hiding to `.a` at all). Harmless for every row actually adjudicated here (no
   payload used `class="a"`), but a real precision limit of the oracle, not a correctness bug in the
   conclusions above.
3. **T-62-16-02 (threat register): the oracle's §5.4 parse/selector-validity layer is NOT
   cross-checked against a second independent CSS implementation.** postcss is disqualified per
   this plan's own `<decision_record>` item 2 (wrong on both FB-01's and CR-04's own input shapes).
   Only the tokenizer half is independently gated, by `tests/css-tokenizer-conformance.test.ts`
   against §4.3. This residual is not resolved by this plan and is not scoped to any later wave in
   this phase's roadmap beyond the general awareness it should be weighed alongside the adjudication
   conclusions above.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added a test-scoped ambient declaration for the full `css-tree` package**
- **Found during:** Task 3 (building the liveness oracle)
- **Issue:** The plan's `<interfaces>` specified `import { parse, walk, generate } from 'css-tree'`
  for the test-only oracle, but with `@types/css-tree` deliberately not installed (Task 2's own
  instruction) and `src/types/css-tree-tokenizer.d.ts` covering only the `/tokenizer` subpath,
  `tsc --noEmit` failed TS7016 on any import of the bare `css-tree` package from `tests/`.
- **Fix:** Added `tests/support/css-tree-ambient.d.ts` — a one-line `declare module 'css-tree';`
  scoped to `tests/`, granting the full package an implicit `any` shape there (acceptable since the
  oracle's own tests are what catch a misuse of the API, not the type checker), while `src/` still
  has no declaration for the bare package at all.
- **Files modified:** `tests/support/css-tree-ambient.d.ts` (new)
- **Verification:** `npx tsc --noEmit` exits 0; the `src/`-reachability grep gate still passes.
- **Committed in:** `fa17235` (Task 3 commit)

**2. [Rule 1 - Bug] Used css-tree's own `ident.decode` instead of a hand-rolled §4.3.7 decoder**
- **Found during:** Task 3 (building the liveness oracle)
- **Issue:** The plan's `<interfaces>` implied hand-decoding selector-name escapes. A hand-rolled
  decoder risks subtly drifting from the library's own tokenizer/escape semantics — exactly the
  class of bug this whole plan exists to eliminate (a second, independently-buggy implementation).
- **Fix:** Verified `css-tree` exports `ident.decode`/`ident.encode` (and `string.decode`/`encode`)
  at the top level; used `ident.decode` directly, which returns U+FFFD for zero/surrogate/
  out-of-range escapes without throwing on any tested edge case (trailing backslash, short hex runs,
  non-hex escapes). This is what surfaced the `.leg\al` planning-table disagreement with authority —
  the library itself, not my own arithmetic.
- **Files modified:** `tests/support/css-liveness-oracle.ts`
- **Verification:** Cross-checked against hand-derived §4.3.7 arithmetic for every row in the
  adjudication table; all matched.
- **Committed in:** `fa17235` (Task 3 commit)

**3. [Rule 1 - Bug] Reworded two doc-comment lines in `src/types/css-tree-tokenizer.d.ts`**
- **Found during:** Task 3 verification (the `src/`-reachability grep gate)
- **Issue:** The plan's own Task 3 `<verify>` gate greps `src/` for the literal strings
  `css-liveness-oracle` and `from 'css-tree'`. My own doc-comment prose in
  `src/types/css-tree-tokenizer.d.ts` (explaining why the ambient declaration is narrow) happened
  to contain both literal substrings, tripping the gate's false-positive.
- **Fix:** Reworded two comment lines to convey the same meaning without the exact matched
  substrings ("the bare `css-tree` package" instead of quoting `from 'css-tree'`; "a test-only
  liveness oracle under `tests/support/`" instead of naming the file directly).
- **Files modified:** `src/types/css-tree-tokenizer.d.ts`
- **Verification:** `grep -rn "css-liveness-oracle\|from 'css-tree'" src/` returns empty.
- **Committed in:** `fa17235` (Task 3 commit)

---

**Total deviations:** 3 auto-fixed (1 blocking, 1 bug/robustness improvement, 1 bug/gate compliance)
**Impact on plan:** All three were necessary for the plan's own acceptance criteria to pass or for
implementation robustness; none changed the plan's scope or conclusions. No scope creep.

## Issues Encountered

None beyond the deviations above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- 62-17 (token-stream rewrite of `strip-hidden.ts`'s CSS layer) is ready to execute: its scope
  floor is now correctly stated as the two confirmed-live escaped-selector leaks, its Task 1
  behavior spec no longer contains an incorrect test expectation for `.leg\al`, and it already
  anticipated the `reclassify` disposition (FB-01/CR-04 stay as agreement rows, not "fixed").
- The CR-04 mechanism finding (`matchesUrlOpen` lacks a token-boundary check) is explicitly still
  open; 62-17's full token-walk rewrite (which deletes `matchesUrlOpen` entirely) is what closes it,
  not this plan's reclassification.
- 62-19 (WR-09 closure + divergence triage) needs no scope changes from this plan; its "three"
  references are unrelated to escaped-selector leak count.
- No blockers.

---
*Phase: 62-multi-inbox-email-ingest-hardening*
*Completed: 2026-07-31*
