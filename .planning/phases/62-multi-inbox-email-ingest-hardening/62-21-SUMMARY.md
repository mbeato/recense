---
phase: 62-multi-inbox-email-ingest-hardening
plan: 21
subsystem: infra
tags: [htmlparser2, html-parsing, dependency-evaluation, conformance-gate, email-ingest, EMAIL-03]

# Dependency graph
requires:
  - phase: 62 (plan 16)
    provides: "The css-tree adoption precedent (§4.3 conformance-gate pattern, exact-pin-in-dependencies, blocking-human legitimacy gate) mirrored here for the HTML side"
provides:
  - "htmlparser2@10.0.0 exact-pinned in dependencies, the sole HTML parser candidate surviving evaluation"
  - "HTML Standard §13.2.5 conformance gate (tests/html-parser-conformance.test.ts) locking the parser's tokenizer/RAWTEXT/comment/attribute-decode behavior, including two named, pinned deviations"
  - "The exact API surface (event names, offset properties, inclusivity, and two named gaps) 62-22/62-24 must consume"
affects: [62-22, 62-24]

# Tech tracking
tech-stack:
  added: ["htmlparser2@10.0.0 (production dependency, exact-pinned)"]
  patterns:
    - "Four-criterion falsifiable dependency evaluation (CommonJS reachability from built dist/, source-location fidelity, totality over 20k+ hostile inputs, cost at the 1 MiB bound), mirroring 62-16's css-tree adoption"
    - "Conformance-gate rows split into spec-conformant (Block 1) vs. measured-deviation (named explicitly, not silently passed) when the adopted library itself is not spec-conformant on a sub-case"

key-files:
  created:
    - tests/html-parser-conformance.test.ts
  modified:
    - package.json
    - package-lock.json

key-decisions:
  - "Adopted htmlparser2@10.0.0 over parse5@7.3.0: parse5 is disqualified by C3 (totality) — it throws RangeError: Invalid code point in its tokenizer's surrogate-combining logic on 150/20,000 seeded hostile inputs (reproducible on consecutive lone low surrogates), a real DoS vector on attacker-controlled email HTML. htmlparser2 passes all four criteria (0/20,000 throws, worst measured shape 15.87 ms against the 1000 ms budget)."
  - "D-62-21-01 fired (narrow form): htmlparser2 does not serve <style> element-end offsets with full fidelity for two malformed RAWTEXT close-tag shapes (</style foo>, </style/>) — named as a residual for 62-22 rather than silently proceeding. Content boundaries and all other uses (comment ranges, start-tag name+decoded-attrs+range) are fully served."

requirements-completed: [EMAIL-03]

# Metrics
duration: ~50min (across two sessions: Task 1 checkpoint wait, then Tasks 2-3 resumed)
completed: 2026-08-01
---

# Phase 62 Plan 21: HTML Parser Evaluation, Adoption & Conformance Gate Summary

**Adopted htmlparser2@10.0.0 (exact-pinned) as the production HTML parser for the future strip-hidden.ts integration, after parse5@7.3.0 was measured and disqualified for throwing on malformed Unicode input — with a named, narrow residual for two RAWTEXT close-tag edge cases that 62-22 must handle explicitly rather than trust to the library.**

## Performance

- **Duration:** ~50 min total (Task 1 checkpoint: operator legitimacy review + wait; Tasks 2-3 resumed session: ~40 min of active measurement/implementation)
- **Completed:** 2026-08-01
- **Tasks:** 3 (1 checkpoint, 2 auto)
- **Files modified:** 3 (package.json, package-lock.json, tests/html-parser-conformance.test.ts)

## Accomplishments

- Measured both candidate HTML parsers against four falsifiable criteria (C1 CommonJS reachability from built `dist/`, C2 source-location fidelity for the three uses the future module needs, C3 totality over 20,000 seeded hostile inputs, C4 cost at the 1,048,576-code-unit bound) before adopting either.
- **parse5@7.3.0 disqualified by C3**: throws `RangeError: Invalid code point` in `Tokenizer._emitCodePoint` on 150/20,000 hostile inputs (0.75%), reproducible on inputs containing consecutive lone low surrogates (e.g. two `U+DFFF` in a row). This is a real, attacker-triggerable crash on the production ingest path — email content is untrusted by construction (D-61) and can carry malformed UTF-16.
- **htmlparser2@10.0.0 passes all four**: `require()` works against the built `dist/` artifact (proven, not assumed, per C1's `moduleResolution: "bundler"` caveat); 0/20,000 throws over the same hostile-input seed; worst measured cost-bound shape 15.87 ms (Shape U) against the 1000 ms budget, over 60x headroom; correctly recovers comment ranges, decoded attribute values (including the legacy attribute-specific no-semicolon-before-alnum/`=` character-reference rule, verified in both directions), and start-tag source ranges on the combined fixture.
- Pinned `htmlparser2@10.0.0` exact (no `^`) in `dependencies`; `parse5` fully uninstalled (never landed in `package.json`/`package-lock.json` — it was evaluated as a temporary, unsaved install and removed before any commit).
- Wrote `tests/html-parser-conformance.test.ts`: an HTML Standard §13.2.5 conformance gate with three blocks — spec-transcribed rows (character-reference decoding, comment states including bogus/abrupt-closing/unterminated-to-EOF, RAWTEXT semantics, the CR-10 style-inside-comment row), characterized offset deviations (inclusive `[start,end]` convention, overrun-by-1 on unterminated constructs, implied-end-tag-at-EOF offsets, self-closing-start-tag no-op semantics, and the two named RAWTEXT-close gaps below with literal pinned numbers), and totality (20,000 seeded hostile inputs, LCG, never throws).
- **Found and named a genuine htmlparser2 defect** (not assumed, cross-checked against parse5 which handles both correctly): `</style/>` (a RAWTEXT end tag using self-closing-tag syntax) does not close the `<style>` element at all — the tokenizer's "skip everything until >" fallback swallows the entire remainder of the document, including legitimate trailing content, as RAWTEXT. A milder sibling gap: `</style foo>` (trailing garbage before the close `>`) correctly isolates the element's *content*, but the `closetag`/following-`text` event's own offset metadata is truncated at the first whitespace after the tag name — it does not extend through the real closing `>` — so a consumer relying on that offset directly would under-compute the element's true end boundary by the length of the trailing garbage.

## Task Commits

1. **Task 1: Package legitimacy gate for both candidates (T-62-21-SC)** — checkpoint (see below)
2. **Task 2: Measure both candidates, pick one, pin exact in dependencies** - `e42ec23` (feat)
3. **Task 3: Conformance gate transcribed from the HTML Standard** - `c1fc84e` (test)

_No plan-metadata commit yet — this SUMMARY commit itself is that step._

## Package Legitimacy Audit (Task 1)

Both candidates were `[ASSUMED]` under the fallback policy (no `RESEARCH.md` audit table exists for this gap-closure round). The coordinator relayed an explicit operator decision mid-execution:

> **Operator reply: `approved`.** Both candidates passed the legitimacy check. Authorized to install BOTH `parse5@7.3.0` and `htmlparser2@10.0.0` as temporary devDependencies for the Task 2 measured bake-off, with exactly one promoted to an exact-pinned production `dependencies` entry and the other removed at the end of Task 2. Neither package was rejected.

Verified during Task 1 (before any install): `parse5` — publisher/repo `inikulin/parse5`, weekly downloads in the tens of millions, `7.3.0` exists and is not deprecated. `htmlparser2` — publisher/repo `fb55/htmlparser2`, weekly downloads in the tens of millions, `10.0.0` exists and is not deprecated. No install occurred before the operator's approval was relayed.

## Decision Table (Task 2)

| Criterion | parse5@7.3.0 | htmlparser2@10.0.0 |
|---|---|---|
| **C1 — CJS reachability from built `dist/`** | PASS — `require()` against `dist/src/probe-parse5.js` succeeds (`parse5.parse` with `sourceCodeLocationInfo: true` returns a document tree) | PASS — `require()` against `dist/src/probe-htmlparser2.js` succeeds (`new Parser(handler).write(html); .end()` fires events correctly) |
| **C2 — source-location fidelity, all 3 uses, on the combined fixture** | PASS on the combined fixture: comment slice `<!-- <style>x</style> -->` recovered exactly; `<style>` startTag/content/endTag all recover exact substrings; `class="leg&#97;l"`→`legal`, `style="display&colon;none"`→`display:none` (attribute no-semicolon rule verified both directions, matches spec exactly on all 4 sub-cases tested). **Additional finding**: correctly handles the empty bogus comment `<!>` (htmlparser2 drops it) — but this is moot since parse5 is disqualified below. | PASS on the combined fixture with the same verified offsets and attribute-decode results. **Two narrower gaps found** (named as the D-62-21-01 residual): `</style/>` never closes the element (swallows to EOF); `</style foo>` isolates content correctly but truncates its own reported offset before the real `>`. Empty bogus comment `<!>` is silently dropped entirely (no event of any kind — narrower than parse5's correct handling, but `<!x>` non-empty bogus comments ARE correctly routed through `onprocessinginstruction`). |
| **C3 — totality, 20,000 seeded hostile inputs (LCG)** | **FAIL — 150/20,000 throws** (0.75%). `RangeError: Invalid code point 2162687` in `Tokenizer._emitCodePoint`, reproducible e.g. on `-\tc\udfff\udfff&notit&notit a}<<!<style` (lone-surrogate-adjacent input). **DISQUALIFYING** — C3's requirement is unconditional ("must never throw"). | **PASS — 0/20,000 throws.** Also ~3x faster on the same seed set (25.8 ms vs parse5's 76.3 ms for the full 20,000-input run). |
| **C4 — cost at 1,048,576-code-unit bound, 62-18's 25-shape corpus + 2 new HTML shapes** | Not measured — already disqualified at C3 (mirrors the 62-16 postcss precedent: a candidate disqualified on an earlier criterion is not run through the remaining ones). | **PASS.** Worst shape 15.87 ms (Shape U), over 60x headroom under the 1000 ms budget. Full table below. |

**Winner: htmlparser2@10.0.0.** Pinned exact in `dependencies`; parse5 never landed in a committed file.

### C4 cost table (htmlparser2@10.0.0, all shapes at exactly 1,048,576 code units unless noted)

| Shape | ms |
|---|---|
| Shape A | 8.06 |
| Shape B | 7.65 |
| Shape S | 7.55 |
| Shape T | 2.79 |
| Shape U (worst) | 15.87 |
| Shape V | 1.88 |
| Shape W | 1.84 |
| Shape X | 1.84 |
| Shape X3 | 1.99 |
| Shape Y | 1.79 |
| Shape Z | 1.68 |
| Shape report (a<x) | 5.21 |
| bare `<style>` repeated | 2.36 |
| four attribute pairs | 1.53 |
| unquoted attribute triple | 1.97 |
| `<style ` no-close-until-final-byte | 11.78 |
| well-formed repeated (control) | 9.73 |
| 9 adversarial CSS shapes (wrapped in `<style>`) | 1.41–2.94 |
| **NEW: one unterminated comment to EOF** | 1.92 |
| **NEW: `<style ` repeated, no `>` until final byte** | 9.11 |

Worst measured value across the full set: **15.87 ms**, against the 1000 ms budget — over 60x headroom.

## Exact API Surface for 62-22/62-24

**Import:** `import { Parser } from 'htmlparser2';` — default `decodeEntities: true` (v10's own default; pass explicitly for clarity).

**Events used (low-level `Parser` + handler object, NOT `parseDocument`/domhandler — both were verified to carry the identical offset behavior, so the lower-level API is sufficient and avoids building an unnecessary DOM):**
- `oncomment()` — fires for `<!--...-->` AND `<!-->`/`<!--->` (abrupt-closing forms) AND unterminated-to-EOF. Does NOT fire for bogus comments (`<!x>`) — those route through `onprocessinginstruction(name, data)` instead, with `name`/`data` both equal to the content between `<!` and `>`. The EMPTY bogus comment `<!>` fires NEITHER callback — it is silently dropped with no offset information at all (a genuine gap; rare in practice, name as accepted residual if not otherwise addressed).
- `onopentagname(name)`, `onattribute(name, value)` (value already DECODED), `onopentag(name, attribs)` — `attribs` is a plain object of decoded name→value pairs.
- `onclosetag(name, isImplied)` — `isImplied: true` means synthetic (EOF-implied or otherwise not a real matched close tag).
- `ontext(text)`.
- Offsets: read `parser.startIndex` / `parser.endIndex` **synchronously inside each callback** (they are live Parser-instance properties, not passed as callback args).

**Offset convention — INCLUSIVE `[start, end]`, NOT exclusive `[start, end)` like css-tree/parse5.** To slice: `html.slice(start, end + 1)`. An unterminated construct (comment or RAWTEXT running to EOF) overruns `html.length` by exactly 1. An implied/EOF-synthesized close tag reports `start === end === html.length`.

**Named residual for 62-22 (D-62-21-01, narrow form):** `<style>` element-END computation (as opposed to content-start/end, which is always correct) is unreliable for two RAWTEXT close-tag shapes:
1. `</style/>` — does not close at all. 62-22 must NOT rely on htmlparser2's own close-tag recognition for this shape; either keep a narrow hand-rolled detector for this one pattern, or treat it as an accepted, named residual (input this rare, on an element that's deleted wholesale regardless, is a low-severity gap — but it must be a *named* decision in 62-22, not a silent trust in the library).
2. `</style foo>` / `</style   >` (any whitespace/garbage between the tag name and the final `>`) — content is correctly isolated, but `closetag.end` (and the following `text` event's `start`) are truncated at the first whitespace after the tag name, not the real `>`. 62-22 must forward-scan `html.indexOf('>', closetag.end)` from that truncated offset to recover the true element-end boundary — a cheap, bounded, one-line correction, not a full parser replacement.

Both gaps are pinned with literal numbers in `tests/html-parser-conformance.test.ts`'s Block 2, so a future htmlparser2 upgrade (whether it fixes or further changes either behavior) is caught immediately rather than silently shifting 62-22's deletion ranges.

## Files Created/Modified

- `package.json` / `package-lock.json` — `htmlparser2` added at `10.0.0` (exact) in `dependencies`.
- `tests/html-parser-conformance.test.ts` (386 lines) — HTML Standard §13.2.5 conformance gate: Block 1 (spec-transcribed rows, 2 written as named measured deviations rather than false-passing spec claims), Block 2 (characterized offset deviations, pinned with literal numbers), Block 3 (totality, 20,000 seeded hostile inputs).

## Decisions Made

- **Adopted htmlparser2@10.0.0, not parse5@7.3.0** — a direct, measured reversal of the initial expectation formed while validating C2 (parse5 looked stronger there: it correctly handles the empty bogus comment `<!>` that htmlparser2 drops, and closes `</style/>`/`</style foo>` correctly where htmlparser2 does not). C3's totality failure (150/20,000 throws on malformed Unicode) is an unconditional disqualifier per the plan's own criterion wording and the threat model's T-62-21-03 row — a parser that can be crashed by attacker-controlled input converts a leak into an outage, which is strictly worse than an offset-fidelity gap that has a cheap, bounded workaround.
- **D-62-21-01 fired in narrow form** — rather than silently trusting htmlparser2's close-tag offsets for `<style>` element-end in all cases, the two failing RAWTEXT-close shapes are named explicitly (in this SUMMARY and in the conformance test's own header/Block 2, pinned with literal numbers) as a residual 62-22 must handle with a small forward-scan correction (for `</style foo>`) or an accepted, named gap (for `</style/>`). This is the "narrowest honest fallback" the plan calls for: htmlparser2 fully serves comment-range recovery (use 1) and start-tag name+decoded-attrs+range (use 3); it serves `<style>` content-boundary recovery and the common/EOF-unterminated element-end cases (use 2), with the two malformed-close-tag shapes above as the sole unserved residual.
- **Did not edit `src/source/strip-hidden.ts`** — the plan's own D-62-21-01 text asks for the residual to also be named in that file's doc block, but the coordinator explicitly instructed this plan not to touch that file (62-20, running in parallel, landed a token-stream migration there). The residual is documented here in full instead; 62-22 (which will actually integrate the parser into that file) is the correct place for the in-file doc-block note.
- **Used the low-level `Parser` + handler API, not `parseDocument`/domhandler** — verified both surfaces carry identical offset behavior (including both named gaps), so the lower-level, DOM-free API is sufficient for the module's range-deleting-transformer contract and avoids building an unneeded tree.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Task 3's conformance test had two off-by-one literal offsets from hand computation**
- **Found during:** Task 3 (first `vitest run` of the new conformance test)
- **Issue:** Two hand-derived literal numbers in the "characterized deviations" block (`html.indexOf('>', closetag.end)` expected value, and a redundant `html.length - 1` tautology check) were miscounted by one character each.
- **Fix:** Corrected the literal to the actual measured value (38, not 39); removed the redundant tautological length assertion and replaced it with a direct `trailingText.value` check that tests something meaningful.
- **Files modified:** `tests/html-parser-conformance.test.ts`
- **Verification:** `npx vitest run tests/html-parser-conformance.test.ts` — 25/25 pass.
- **Committed in:** `c1fc84e` (part of Task 3 commit; fixed before commit, not a separate commit)

---

**Total deviations:** 1 auto-fixed (Rule 1, pre-commit test-authoring correction)
**Impact on plan:** No scope creep. The D-62-21-01 residual finding is not a "deviation" in the Rule 1-3 sense — it is exactly the outcome the plan's own decision point anticipates and is documented per the plan's `<output>` spec, not auto-fixed.

## Issues Encountered

None beyond the two measured findings documented above in full (parse5's C3 totality failure; htmlparser2's two RAWTEXT-close-tag gaps) — both are the plan's own point (measure, don't assume) working as intended, not problems requiring resolution beyond documentation.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- `htmlparser2@10.0.0` is exact-pinned in `dependencies`, conformance-gated, and ready for 62-22 to consume.
- 62-22 (and 62-24) must read this SUMMARY's "Exact API Surface" and "Named residual" sections before writing any integration code — the offset convention (inclusive `[start,end]`, not exclusive), the bogus-comment/PI event split, and the two named RAWTEXT-close gaps are load-bearing for correct offset arithmetic.
- Frozen EMAIL-01/02/04 surface: 0 commits touched anything outside `package.json`/`package-lock.json`/`tests/html-parser-conformance.test.ts` — verified via `git status --porcelain` at each task boundary and the final `git log --stat` below.
- `strip-hidden.ts` was deliberately not touched (per coordinator instruction, 62-20 owns concurrent changes there) — the D-62-21-01 residual note that the plan asked to also land in that file's doc block is deferred to 62-22.

---
*Phase: 62-multi-inbox-email-ingest-hardening*
*Completed: 2026-08-01*

## Self-Check: PASSED

- FOUND: `tests/html-parser-conformance.test.ts`
- FOUND: `.planning/phases/62-multi-inbox-email-ingest-hardening/62-21-SUMMARY.md`
- FOUND commit `e42ec23` (Task 2)
- FOUND commit `c1fc84e` (Task 3)
- Verified `git diff --stat` against the pre-plan base touches exactly `package.json`, `package-lock.json`, `tests/html-parser-conformance.test.ts` outside `.planning/` — matches the plan's declared `files_modified`.
