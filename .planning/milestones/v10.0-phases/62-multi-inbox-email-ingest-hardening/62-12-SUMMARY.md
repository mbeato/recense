---
phase: 62-multi-inbox-email-ingest-hardening
plan: 12
subsystem: email-ingest-security
tags: [security, regex, style-tag, unicode, bl-01, bl-02, bl-03, gap-closure, redos, regression]

requires:
  - phase: 62-09
    provides: STYLE_BLOCK_RE-quote-aware (the narrowing this plan reverses), CR-01-bug-class-guard (the source guard this plan updates)
  - phase: 62-11
    provides: stripInvisibleCodepoints extraction (CR-02), the primitive whose codepoint set this plan widens
provides:
  - Single shared ATTRS fragment behind all four tag-scanning literals (START_TAG_RE, ANY_TAG_TOKEN_RE, STYLE_BLOCK_RE, ANY_TAG_RE), permitting an unquoted `<` per HTML §13.2.5.36
  - INVISIBLE_CODEPOINTS_RE derived from \p{Default_Ignorable_Code_Point} + U+2028/U+2029 (139 -> 4176 codepoints, zero narrowing)
  - Measured-RED reproductions + a regression-of-the-regression lock for BL-01
  - Re-measured cost bound (5 shapes, including new Shape U) with raised absolute ceilings
affects: [63-offline-intent-classification]

tech-stack:
  added: []
  patterns: [measured-red-before-green, shared-regex-fragment-source-of-truth, unicode-property-derived-codepoint-set, structural-over-textual-guard]

key-files:
  created: []
  modified:
    - src/source/strip-hidden.ts
    - tests/strip-hidden.test.ts
    - tests/gmail-hidden-content.test.ts

key-decisions:
  - "Reversed 62-09's decision to exclude < from the unquoted-attribute class in STYLE_BLOCK_RE (and by the same reasoning START_TAG_RE/ANY_TAG_TOKEN_RE): HTML §13.2.5.36 makes an unquoted < a parse error that is appended to the attribute value, not a tag terminator. 62-09 excluded < to keep stage 2 in agreement with stage 4 -- they agreed on FAILING (the BL-01 leak). All four literals now share one ATTRS fragment so agreement is structural, not coincidental."
  - "Rejected the code reviewer's <\\/style\\b[^>]* close tail: reintroduces the exact substring the 62-09 source guard bans and gives the close tag a different boundary rule from ANY_TAG_TOKEN_RE (the T-62-43 cross-stage disagreement this file exists to prevent). Used <\\/style\\b${ATTRS}> instead."
  - "Rejected the code reviewer's /[\\p{Cf}\\p{Variation_Selector}...]/gu invisible-codepoint set: measured to NARROW current coverage by 31 codepoints (U+E0000, U+E0002-U+E001F, the unassigned Tags-block remainder). Used \\p{Default_Ignorable_Code_Point} instead -- zero narrowing, 139 -> 4176 codepoints covered."
  - "62-07's grep -c 'new RegExp' == 0 acceptance criterion is superseded by the invariant it was a proxy for (compiled once at module load, never per call). Four new RegExp(...) constructions are evaluated exactly once at module load and satisfy that invariant literally."
  - "62-09's source guard is updated, not removed: first assertion (no bare [^>]*/[^<>]* class) kept unchanged; second assertion (count-based lower bound) replaced with single-source-of-truth counts (alternation exactly once, ATTRS interpolated on exactly 4 lines, new RegExp( on exactly 4 const-prefixed lines)."
  - "Accepted two behavior changes on legitimate (non-attacker) mail: bidi embedding/override/isolate controls and LRM/RLM/ALM are now stripped from RTL subjects/bodies (Trojan-Source defense; letters are never touched); U+FE0F VARIATION SELECTOR-16 is now stripped, so an explicit-presentation-selector emoji loses its selector -- same class as the existing ZWJ stripping."
  - "Absolute wall-clock ceilings raised 500ms -> 5000ms across all adversarial cost-bound tests (IN-03, 62-REVIEW.md): growth-ratio assertions remain the ReDoS instrument of record and are unchanged; a threshold with ~1.6x headroom (or none) on the author's machine is a CI-flake source, not a security control."

requirements-completed: [EMAIL-03]

duration: 25min
completed: 2026-07-30
---

# Phase 62 Plan 12: Close BL-01/BL-02/BL-03 (gap-closure wave C) Summary

**One shared `ATTRS` regex fragment now backs all four HTML tag-scanning literals in `strip-hidden.ts` (closing a same-wave regression and a spec-conformance gap), and `INVISIBLE_CODEPOINTS_RE` is now derived from the `Default_Ignorable_Code_Point` Unicode property instead of a 139-codepoint hand-maintained enumeration (4176 codepoints covered, zero narrowing).**

## Performance

- **Duration:** ~25 min
- **Tasks:** 3
- **Files modified:** 3 (`src/source/strip-hidden.ts`, `tests/strip-hidden.test.ts`, `tests/gmail-hidden-content.test.ts`)

## Accomplishments

- Closed BL-01 (a same-wave regression 62-09 introduced): `<style x=a<b>...` now yields its hiding rule to the stage-2 harvest instead of leaking the class-hidden payload and the raw stylesheet, and no longer destroys following visible prose.
- Closed BL-02: `</style foo>` and `</style/>` now end the `<style>` block for stage 2 exactly as they already did for stage 4 — stage 4 can no longer delete the evidence that a span is hidden while stage 2 harvests nothing.
- Closed BL-03: every carrier in the review's threat-class table (Variation Selectors Supplement, Variation Selectors, bidi embed/override/isolate, LRM/RLM/ALM, CGJ, deprecated format chars, Hangul fillers, line/paragraph separators) is now removed from `record.content`, with zero narrowing of what was already stripped.
- Added a regression-of-the-regression lock so a future "hardening" cannot narrow an attribute class or the codepoint set and silently break a working case the way 62-09 did.
- Re-measured (not asserted) the cost consequence of the widening across five shapes, added the shape it specifically worsens, and raised the CI-flaky absolute wall-clock gates while keeping the growth-ratio ReDoS instrument unchanged.

## Task Commits

1. **Task 1: Encode all three blockers as failing tests (measured RED)** - `16fdfb5` (test)
2. **Task 2: One shared attribute fragment + a property-derived codepoint set (GREEN)** - `a75bde0` (fix)
3. **Task 3: Re-measure the cost bound after the shared-fragment change and flag the out-of-scope findings** - `84936c7` (test)

**Plan metadata:** (this commit, pending)

## Task 1 — Measured RED evidence

Ran `npx vitest run tests/strip-hidden.test.ts tests/gmail-hidden-content.test.ts` against the unfixed source (Task 2 not yet applied). Verify command exited **non-zero**: `Test Files 2 failed (2)`, `Tests 31 failed | 157 passed (188)`.

**Every failing test name, verbatim:**

`tests/strip-hidden.test.ts`:
- `stripHiddenContent — unquoted < inside a tag attribute region (BL-01 regression of the 62-09 fix) > yields the hiding rule to the harvest and the raw CSS does not leak as prose`
- `... > over-removal direction: does not destroy visible prose that follows the same shape`
- `... > 62-09 regression lock: an unquoted < in a <style> attribute was handled by the PRE-62-09 [^>]* regex and must never stop being handled again`
- `stripHiddenContent — spec-legal <style> end tags (BL-02) > harvests through a </style foo> end tag`
- `... > harvests through a </style/> end tag`
- `stripInvisibleCodepoints — carriers sourced from the BL-03 threat class, not from the implementation > removes <label>` x20 (all 20 threat-class carrier rows)

`tests/gmail-hidden-content.test.ts`:
- `EMAIL-03 62-12 gap closure — BL-01/BL-02/BL-03 at the record.content level > BL-01: an unquoted < inside a <style> attribute does not leak the class-hidden payload or the raw CSS`
- `... > BL-02: a </style foo> end tag does not leak the class-hidden payload`
- `... > BL-02: a </style/> end tag does not leak the class-hidden payload`
- `... > BL-03: a Variation Selectors Supplement payload in Subject does not survive into record.content`
- `... > BL-03: a bidi-override payload in Subject does not survive into record.content`
- `... > decision #2 control (controls removed): the bidi override/pop-directional-formatting controls around the same RTL subject are stripped`

**Verbatim leaked output** (the two rows the plan's acceptance criteria specify):

```
input:  <style x=a<b>.legal{display:none}</style>ok<span class="legal">PAYLOAD_A</span>
output: .legal{display:none}okPAYLOAD_A   (matches the plan's predicted shipped output exactly)

input:  <div x=a<b style="display:none">PAYLOAD</div>Visible.
output: '' (empty string — Visible. destroyed, matching the plan's predicted over-removal)

input:  <style>.legal{display:none}</style foo>ok<span class="legal">PAYLOAD_B</span>
output: okPAYLOAD_B

input:  <style>.legal{display:none}</style/>ok<span class="legal">PAYLOAD_B2</span>
output: okPAYLOAD_B2
```

BL-03 threat-class carriers (escaped, not pasted): every row of `stripInvisibleCodepoints('a' + cp + 'b')` for `cp` in `\u{E0100}`, `\u{E01EF}`, `\u{FE00}`, `\u{FE0F}`, `\u{202A}`, `\u{202E}`, `\u{2066}`, `\u{2069}`, `\u{200E}`, `\u{200F}`, `\u{061C}`, `\u{034F}`, `\u{206A}`, `\u{206F}`, `\u{115F}`, `\u{1160}`, `\u{3164}`, `\u{FFA0}`, `\u{2028}`, `\u{2029}` returned `'a' + cp + 'b'` unchanged (the carrier survived) instead of `'ab'`.

At the `record.content` level: the `U+E0100`-series Subject case left the selectors in place verbatim (`"From: a@b.c · Re: Your application" + U+E0100 + U+E0101 + U+E0102 + " · Acct: default\n..."`); the bidi-override Subject case left the RLO control (escaped as \u202E) and the PDF control (escaped as \u202C) in place around `txt.exe`.

**Controls that PASSED in this RED state (required, and verified genuinely control-shaped):**
- `decision #2 control (letters survive)` — the Arabic letters and `txt.exe` all reached `record.content` even with BL-03 unfixed.
- The pre-existing `<urgent>`/`pricing & terms`/`alice@acme.com` no-mangling control (`tests/gmail-hidden-content.test.ts`).
- `SECRET6` (unquoted `>` genuinely closes the tag) and `VISIBLE6` (no-over-correction) controls.
- Both unbalanced-quote residual-(c) locks (`<div title="unclosed>Visible after....` -> `''`; `<div title="unclosed>mid" class="c">Visible after.` -> `Visible after.`).

`git diff --exit-code src/` was `0` throughout Task 1 — no production edit.

## Task 2 — GREEN: the five final regex declarations

```ts
const INVISIBLE_CODEPOINTS_RE = /[\p{Default_Ignorable_Code_Point}\u2028\u2029]/gu;

const ATTRS = `(?:"[^"]*"|'[^']*'|[^'">])*`;

const START_TAG_RE = new RegExp(`<([a-zA-Z][a-zA-Z0-9]*)\\b(${ATTRS})>`, 'g');
const ANY_TAG_TOKEN_RE = new RegExp(`<(\\/?)([a-zA-Z][a-zA-Z0-9]*)\\b${ATTRS}>`, 'g');
const STYLE_BLOCK_RE = new RegExp(`<style\\b${ATTRS}>([\\s\\S]*?)<\\/style\\b${ATTRS}>`, 'gi');
const ANY_TAG_RE = new RegExp(`<${ATTRS}>`, 'g');
```

**Why 62-09's `<`-exclusion was reversed:** 62-09 narrowed the unquoted-attribute class from `[^>]` to `[^'"<>]` specifically to keep stage 2 (`STYLE_BLOCK_RE`) in agreement with stage 4 (`START_TAG_RE`/`ANY_TAG_TOKEN_RE`) about where a `<style>` open tag ends. Per HTML §13.2.5.36, an unquoted `<` is a parse error but is *appended to the attribute value* — it does not terminate the tag. So the narrowing made all three stages agree, but they agreed on **failing**: `<style x=a<b>...` stopped matching, the class-hidden payload and the raw stylesheet both reached `record.content`. This plan restores `<` to the unquoted-attribute class (matching `ANY_TAG_RE`'s pre-existing, already-shipped form) and makes all four literals share one `ATTRS` fragment, so future agreement is structural rather than four literals coincidentally carrying the same character class.

**Two reviewer proposals rejected, with the measured reason for each:**

1. **Close-tag tail `<\/style\b[^>]*>`** (the code reviewer's proposed fix for BL-02) was rejected in favor of `<\/style\b${ATTRS}>`. Measured reason: `[^>]*` reintroduces the exact substring the 62-09 source guard bans (`not.toContain('[^>]*')`), which would force either a self-inflicted red suite or a weakened guard — and it gives the close tag a *different* boundary rule from `ANY_TAG_TOKEN_RE`, exactly the T-62-43 cross-stage disagreement this file exists to prevent. `${ATTRS}` accepts every form `ANY_TAG_TOKEN_RE` accepts (`</style foo>`, `</style/>`, `</style   >`, `</style>`, `</STYLE>`) with a boundary rule that is structurally guaranteed to match.

2. **`/[\p{Cf}\p{Variation_Selector}\u034F\u2028\u2029\u115F\u1160\u3164\uFFA0]/gu`** (the code reviewer's proposed `INVISIBLE_CODEPOINTS_RE`) was rejected in favor of `/[\p{Default_Ignorable_Code_Point}\u2028\u2029]/gu`. Measured reason (full Unicode-space enumeration during planning, re-verified by this executor by reading the planning evidence table): `\p{Cf}` **narrows** current coverage by 31 codepoints — `U+E0000` and `U+E0002-U+E001F`, the unassigned part of the Tags block the shipped literal already covers and `\p{Cf}` does not — which would have regressed part of the very carrier BL-03 is about. `\p{Default_Ignorable_Code_Point}` misses zero currently-covered codepoints, covers every BL-03 row except `U+2028`/`U+2029` (added explicitly since they are not `Default_Ignorable`), and additionally reaches the unassigned plane-14 remainder neither the shipped literal nor `\p{Cf}` reaches. Coverage: 139 -> 4176 codepoints, zero narrowing anywhere. `\p{Cf}` would also have stripped the Arabic/Syriac prepended concatenation marks (`U+0600-U+0605`, `U+06DD`, `U+070F`, `U+08E2`, `U+110BD`, `U+110CD`) — legitimate formatting characters `Default_Ignorable_Code_Point` correctly excludes.

**Fate of the 62-09 source guard** (`tests/strip-hidden.test.ts`, retitled `strip-hidden.ts — residual source-text checks for the CR-01/BL-01/BL-02 bug class (62-12 decision #1)`): the first assertion (`not.toContain('[^>]*')` / `not.toContain('[^<>]*')`) is kept **unchanged** — it passes only because the reviewer's `[^>]*` close tail was rejected. The second assertion is **replaced** with single-source-of-truth counts: the alternation appears exactly 1 time in the comment-stripped source (inside `ATTRS` itself); `${ATTRS}` is interpolated on exactly 4 lines; `new RegExp(` appears on exactly 4 lines, every one beginning with `const `. The describe block's own comment now states WR-06's finding explicitly: a string-matching source guard can never guarantee the bug class does not recur (`[^>]+`, `[^ >]*`, `[^\s>]*` etc. would all pass a substring check); the guarantee is now structural (a fifth literal built from `ATTRS` cannot carry a divergent boundary), and this residual grep detects the specific regression shapes this file has actually shipped — a canary, not a proof.

**Supersession of 62-07's `new RegExp` criterion:** 62-07's acceptance criterion `grep -c "new RegExp" == 0` is explicitly superseded, stated in the file's own doc block. That criterion was a proxy for the real invariant — "compiled once at module load, never per call" — not the invariant itself. Four module-scope `new RegExp(...)` constructions are evaluated exactly once at module load and satisfy that invariant literally; the thing the invariant actually forbids (constructing a regex per matched tag name inside `findMatchingCloseEnd`) remains forbidden and remains absent.

**RTL/bidi and `U+FE0F` behavior changes, recorded as accepted decisions** (in the module's own doc block and in `tests/gmail-hidden-content.test.ts`'s decision #2 control pair): bidi embedding/override/isolate controls and LRM/RLM/ALM are now stripped from legitimate right-to-left subjects/bodies — this module produces text for an LLM extractor, not for display, and Trojan-Source-class visual reordering is exactly the threat this stage exists to stop; only invisible controls are touched, letters are never touched (the property matches no ASCII codepoint and no Arabic/Hebrew letter codepoint — verified by the decision-#2 letters-survive control, which passes both in the RED state and after the fix). `U+FE0F` VARIATION SELECTOR-16 is also now stripped, so an emoji written with an explicit presentation selector loses it — the same class of accepted loss as the existing ZWJ stripping (shipped since 62-03).

Verification: `npx vitest run tests/strip-hidden.test.ts tests/gmail-hidden-content.test.ts tests/gmail-adapter.test.ts tests/gmail-adapter-multiaccount.test.ts` -> **217/217 passed**. `git diff -U0 src/source/strip-hidden.ts` confirmed by direct inspection to be confined to the five regex declarations and their adjacent/file-level doc comments; `harvestHidingSelectors`, `collectRemovalRanges`, `findMatchingCloseEnd`, `isHiddenStartTag`, `hasHidingSignature`, `normalizeWhitespace`, `stripInvisibleCodepoints`, and `stripHiddenContent` bodies are byte-identical (only their surrounding doc comments changed in two cases). `npx tsc --noEmit` exits 0. `git diff --exit-code src/source/gmail-adapter.ts src/db/schema.ts src/consolidation/ src/adapter/ src/lib/config.ts` exits 0.

## Task 3 — Re-measured cost bound (not asserted)

Measured on this machine, through the full `stripHiddenContent` pipeline, before (commit `16fdfb5`, unfixed) vs. after (commit `a75bde0`, fixed) Task 2's change:

| shape | 32 KB before | 32 KB after | 64 KB before | 64 KB after | ratio before | ratio after |
|---|---|---|---|---|---|---|
| A `<div a="yyy…` | 20.6 ms | 60.5 ms | 76.9 ms | 240.5 ms | 3.73x | 3.97x |
| B `<div a"b'c…` | 12.8 ms | 37.1 ms | 48.5 ms | 152.0 ms | 3.79x | 4.10x |
| S `<style a="yyy…` | 18.5 ms | 80.7 ms | 75.6 ms | 306.8 ms | 4.08x | 3.80x |
| T complete `<style …>` open tags | 3.4 ms | 3.7 ms | 12.4 ms | 11.6 ms | 3.61x | 3.09x |
| **U `<div a=b ` (new)** | 125.8 ms | 366.5 ms | 492.5 ms | 1450.4 ms | 3.91x | 3.96x |

**Complexity class is unchanged**: every shape stays within ~3.1x-4.1x per doubling both before and after — polynomial (quadratic), not catastrophic, in both states. The three `ATTRS` alternatives (`"[^"]*"`, `'[^']*'`, `[^'">]`) remain disjoint on their first character, so there is no ambiguity for the regex engine to backtrack through even on Shape U, the shape this change specifically worsens.

**Constant factor rose roughly 3x at 64 KB** for shapes A (3.13x), B (3.13x), S (4.06x), and U (2.94x). Shape T (the genuinely quadratic `</style>`-tail scan, unrelated to the attribute-scanning fragment) is essentially unaffected (0.94x — within measurement noise). This is the direct, expected consequence of permitting `<` in the unquoted-attribute class: under the old `[^'"<>]` class every failing forward scan from a `<` terminated at the next `<`; under the new `[^'">]` class (`ATTRS`) it now runs to end of string, since `<` no longer stops the scan.

**Shape U added** to the first adversarial describe block: unit `'<div a=b '` repeated to size, no quotes, no `>`, no `</style>` anywhere. Asserted no-throw and `t64 / max(t32, 1) <= 8` (measured 3.96x, well within bound).

**Absolute wall-clock ceilings raised 500ms -> 5000ms** across all five adversarial `toBeLessThan` assertions (`grep -c 'toBeLessThan(500)'` -> 0, `grep -c 'toBeLessThan(5000)'` -> 5). Reasoning recorded in the test file: growth-ratio assertions (`grep -c 'toBeLessThanOrEqual(8)'` -> 3) remain the ReDoS instrument of record and are **unchanged**; the absolute ceiling's only job is to catch a genuine hang, which 5s still does well within the existing 20s block timeouts (both adversarial describe blocks); a threshold with ~1.6x headroom or none at all on the author's machine (Shape S measured 306.8ms against the old 500ms; Shape U measured 1450.4ms) is a CI-flake source per IN-03 (62-REVIEW.md), not a security control.

### Out-of-scope findings — named, NOT fixed

- **WR-02 (uncapped input before stripping) — this wave makes it ~3x worse.** Fix shape (verbatim, per plan): a `MAX_STRIP_INPUT_BYTES = 256 * 1024` cap applied to `raw.bodyText` at `src/source/gmail-adapter.ts:362`, before `stripHiddenContent`, since `EpisodicStore.capContent` runs downstream and bounds none of this quadratic work. Not fixed here because `gmail-adapter.ts` is explicitly out of this plan's `files_modified`, and the operator scoped wave C to the three blockers. Should be the next thing picked up given the ~3x cost rise this plan introduces.
- **WR-01** (stage 2 harvests hiding rules from inside HTML comments, destroying visible Outlook `<!--[if mso]>` prose; fix shape: swap stages 2 and 3, re-verify idempotence) — named, not fixed.
- **WR-03** (`<style/>` self-closing disagreement — stage 2 harvests, stage 4 treats it as self-closing and emits the CSS as prose; fix shape: treat RAWTEXT elements as never self-closing in `collectRemovalRanges`) — named, not fixed. Task 1 confirmed this exact case is byte-identical before and after this plan.
- **WR-04** (tautological behavior-preservation test cases), **WR-05** (implementation-mirror codepoint table asserts the implementation against itself — the pre-existing table at `tests/strip-hidden.test.ts:503-515`-equivalent location was deliberately left in place; this plan's Task 1 added a threat-class-sourced table alongside it rather than rewriting it), **WR-07** (`GmailAdapter.pull()` bypasses the `Clock` seam), **WR-08** (provenance-header `·` delimiter forgery not closed by the newline-only WR-01 fix shape) — all named, not fixed.
- **IN-01** (`MAX_HARVESTED_SELECTORS` comment overstates what the cap does), **IN-02** (`lastIndex` regression lock cannot fail by construction), **IN-04** (`parseEmailDate` returns `NaN` instead of `null` when `nowMs` is `NaN`) — all named, not fixed.
- **T-62-54** (pre-existing `</style>`-tail O(n²), the genuinely quadratic Shape T scan) and 62-11's `\n`-in-`Subject:` provenance-line forgery — both still on the backlog, still deliberately unfixed.

## Files Created/Modified

- `src/source/strip-hidden.ts` — one shared `ATTRS` fragment behind all four tag-scanning literals; `INVISIBLE_CODEPOINTS_RE` derived from `\p{Default_Ignorable_Code_Point}`; doc-block rationale for all three 62-12 decisions.
- `tests/strip-hidden.test.ts` — BL-01/BL-02 unit reproductions + 62-09 regression-of-the-regression lock; threat-class-sourced BL-03 table; retitled/updated source guard; Shape U + raised ceilings in the adversarial cost-bound blocks.
- `tests/gmail-hidden-content.test.ts` — episode-content-level assertions for all three blockers, including the decision #2 RTL letters-survive / controls-removed control pair.

## Decisions Made

See `key-decisions` in frontmatter — all six are the plan's own named decisions, each verified (not merely asserted) during this execution: two rejected reviewer proposals with the measured reason recorded, the fate of the 62-09 source guard, the 62-07 `new RegExp` supersession, and the two accepted RTL/`U+FE0F` behavior changes.

## Deviations from Plan

None — plan executed exactly as written. One process note: two earlier attempts to write literal `\uXXXX` escape sequences via the Edit/Write tools were silently corrupted into actual Unicode glyphs (a JSON-transport artifact of single-backslash `\u` sequences being decoded before reaching the file). Caught immediately by inspecting the written bytes, and corrected using Python scripts with double-escaped backslashes for every remaining regex-bearing edit in this plan. No test assertion or production regex shipped with a corrupted escape — this is a documented executor-tooling caveat, not a deviation from the plan's content.

## Verification

- `npx tsc --noEmit` -> exit 0 (checked after every task)
- Task 1: `npx vitest run tests/strip-hidden.test.ts tests/gmail-hidden-content.test.ts` -> exit 1, **31 failed | 157 passed (188)**, `git diff --exit-code src/` -> 0
- Task 2: `npx vitest run tests/strip-hidden.test.ts tests/gmail-hidden-content.test.ts tests/gmail-adapter.test.ts tests/gmail-adapter-multiaccount.test.ts` -> exit 0, **217/217 passed**
- Task 3: `npx vitest run tests/strip-hidden.test.ts` -> exit 0, **166/166 passed**
- `grep -c "^import\|require(" src/source/strip-hidden.ts` -> 0 (zero-import preserved)
- `grep -c 'new RegExp(' src/source/strip-hidden.ts` -> 4, all 4 lines begin with `const `
- `grep -c '\${ATTRS}' src/source/strip-hidden.ts` -> 4 (line-count, not occurrence-count — `grep -c` counts matching lines; `STYLE_BLOCK_RE`'s single declaration line contains 2 occurrences and still counts as 1 line)
- `grep -c 'toBeLessThan(500)' tests/strip-hidden.test.ts` -> 0; `grep -c 'toBeLessThan(5000)'` -> 5
- `grep -c 'toBeLessThanOrEqual(8)' tests/strip-hidden.test.ts` -> 3
- **Full suite** (`npm run build` then `npx vitest run`): **pre-plan baseline 2956 passed / 3 skipped / 0 failed / 194 files** (stated in plan) -> **post-plan measured 3017 passed / 4 skipped / 0 failed / 194 files**. Net +61 passed, reconciling exactly: 31 (Task 1's direct BL-01/02/03 + regression-lock assertions) + 8 (4 new `IDEMPOTENCE_FIXTURES` entries, used in both the idempotence describe block and the stage-1 behavior-preservation block) + 20 (`INVISIBLE_UNICODE_INPUTS` gained the 20 BL-03 carrier inputs, used once in the behavior-preservation block) + 2 (Shape U no-throw + growth-ratio) = 61. The skipped count rose by 1 (3 -> 4); this matches the same class of environment-conditional skip 62-09's own SUMMARY documented in a fresh worktree (a real-DB-guarded test unrelated to this plan's files) and is not attributable to any change in this plan.
- `git diff --exit-code src/source/gmail-adapter.ts src/db/schema.ts src/consolidation/ src/adapter/ src/lib/config.ts` -> 0

## Threat Flags

None — no new network endpoints, auth paths, file-access patterns, or trust-boundary schema changes were introduced. All changes are within the existing `stripHiddenContent`/`stripInvisibleCodepoints` boundary control named in the plan's own threat model.

## Next Phase Readiness

- All three Critical findings against roadmap Success Criterion #3 (EMAIL-03) are closed and verified at both the unit and `record.content` level.
- WR-02 (uncapped input) is the clear next pickup: this plan's own measurement shows it now costs ~3x more CPU per crafted body than before this wave.
- Phase 63 (Offline Intent Classification) depends on EMAIL-03 as a hard prerequisite (per STATE.md's v10.0 phase map) — that dependency is now satisfied.

## Self-Check

- FOUND: src/source/strip-hidden.ts
- FOUND: tests/strip-hidden.test.ts
- FOUND: tests/gmail-hidden-content.test.ts
- FOUND: .planning/phases/62-multi-inbox-email-ingest-hardening/62-12-SUMMARY.md
- FOUND commit 16fdfb5 (Task 1, RED)
- FOUND commit a75bde0 (Task 2, GREEN)
- FOUND commit 84936c7 (Task 3, cost re-measurement)

## Self-Check: PASSED

---
*Phase: 62-multi-inbox-email-ingest-hardening*
*Completed: 2026-07-30*
