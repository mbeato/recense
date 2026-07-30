---
phase: 62-multi-inbox-email-ingest-hardening
reviewed: 2026-07-30T15:20:00Z
depth: standard
files_reviewed: 7
files_reviewed_list:
  - src/source/strip-hidden.ts
  - src/source/gmail-adapter.ts
  - tests/strip-hidden.test.ts
  - tests/gmail-event-ts.test.ts
  - tests/gmail-future-date-ordering.test.ts
  - tests/gmail-hidden-content.test.ts
  - tests/fixtures/gmail-hidden-injection.html
findings:
  critical: 3
  warning: 8
  info: 4
  total: 15
status: issues_found
---

# Phase 62: Code Review Report (gap-closure wave — plans 62-09 / 62-10 / 62-11)

**Reviewed:** 2026-07-30T15:20:00Z
**Depth:** standard (with executed adversarial probes)
**Files Reviewed:** 7
**Status:** issues_found

> Scope note: this review covers only the `0ef9b5a6..HEAD` gap-closure diff. The prior
> full-surface review of this phase is preserved at `62-REVIEW-wave5.md`.

## Summary

Three fixes were submitted. One holds cleanly, two do not.

- **CR-03 (62-10, the `Math.min(parsed, nowMs)` clamp) holds.** I could not defeat it. The clamp is correct; the corrected JSDoc is now accurate (the prior "cannot be expressed" wording was indeed an overclaim); the `id` tie-break the tests lean on is a `crypto.randomUUID()` minted by `EpisodicStore` (`src/lib/hash.ts:17`), genuinely not sender-controlled; and `event_ts` is the only sender-influenced input reaching `orderEpisodesForConsolidation`. The named residual is characterized correctly and its bound is right. One design gap remains (WR-07: `Date.now()` bypasses the project's `Clock` seam).
- **CR-01 (62-09, quote-aware `STYLE_BLOCK_RE`) does not hold, and it introduced a regression.** The new unquoted class `[^'"<>]` excludes `<`. HTML's attribute-value-unquoted state treats `<` as an ordinary value character, so `<style x=a<b>` is a valid `<style>` start tag in every conforming parser — and the **pre-fix** `[^>]*` regex harvested it correctly while the **post-fix** regex does not (BL-01, verified by running both regexes side by side). Separately the closing literal `<\/style\s*>` was never widened and still misses `</style foo>` and `</style/>`, both of which close the element per spec and both of which `ANY_TAG_TOKEN_RE` (stage 4) *does* accept — the exact cross-stage disagreement (T-62-43) the new doc comment claims to prevent (BL-02). Both leak class-hidden injection payloads into `record.content`. The automated "bug-class guard" 62-09 added catches neither, and structurally cannot (WR-06).
- **CR-02 (62-11, `stripInvisibleCodepoints`) is a correct extraction of an incomplete guard.** The extraction is behavior-preserving and has no `lastIndex` hazard — `String.prototype.replace` with a `/g` regex resets `lastIndex` per `@@replace`, and `matchAll` clones rather than mutates, so the two call sites cannot interfere. But the codepoint set is a hand-maintained literal that omits several published invisible-payload carriers, including the Variation Selectors Supplement `U+E0100–U+E01EF` (the 2025 arbitrary-byte smuggling carrier, immediately adjacent to the Tags block that *is* covered) and `U+200E`/`U+200F`, which sit one codepoint past the end of the covered `U+200B–U+200D` range (BL-03, verified end-to-end through `normalizeGmailMessage`).

Test quality is mixed. The CR-03 tests are the strongest work in the wave — each would fail on revert, and the file explicitly reasons about which assertions are locks and which are controls. The CR-02 tests discriminate correctly at the `record.content` level. But the "stage-1 extraction is behavior-preserving" block is 22-of-26 tautological (WR-04), the codepoint coverage table asserts the implementation against itself (WR-05), and the ReDoS bound is measured only at 64 KB while the input is uncapped and Gmail bodies reach megabytes (WR-02, measured).

All 161 tests across the four files pass. That is not evidence of correctness here: every finding below is reachable through code paths the suite does not exercise.

## Narrative Findings (AI reviewer)

### Critical Issues

#### CR-01 (BL-01): `STYLE_BLOCK_RE`'s new `[^'"<>]` class regressed a `<style>` shape the pre-fix regex handled — harvest bypassed, raw CSS leaked

**File:** `src/source/strip-hidden.ts:216`
**Severity:** BLOCKER

**Issue:** 62-09 changed the unquoted-attribute class from `[^>]` to `[^'"<>]`, excluding `<`. Per HTML Standard §13.2.5.36 (attribute value, unquoted state), `U+003C` is a parse error but is *appended to the attribute value* — the tag continues to the next unquoted `>`. So `<style x=a<b>` is a `<style>` start tag with `x="a<b"` in every conforming parser, and what follows is CSS.

Verified by running both regex literals against the same input:

```
"<style x=a<b>.legal{display:none}</style>ok"
  old  /<style\b[^>]*>.../                       -> harvested [".legal{display:none}"]
  new  /<style\b(?:"[^"]*"|'[^']*'|[^'"<>])*>.../ -> harvested []
```

End-to-end through `stripHiddenContent`:

```
in : '<style x=a<b>.legal{display:none}</style>ok<span class="legal">PAYLOAD_A</span>'
out: '.legal{display:none}okPAYLOAD_A'
```

Two failures in one. (1) `PAYLOAD_A` — text a human cannot see in a mail client — reaches `record.content` and the classifier's token stream, which is precisely the EchoLeak-class defect CR-01 was filed for. (2) Stage 4 also fails to recognize the `<style>` element (`START_TAG_RE` excludes `<` identically), so the raw stylesheet text leaks into output as prose.

This is a **net regression of this wave**: the shipped, previously-reviewed build handled this input; the fix does not.

The doc comment at `:211-214` justifies excluding `<` as keeping stage 2 in agreement with stage 4. They do agree — they agree on *failing*, and the shared failure is the leak. Agreement on a wrong boundary is not the invariant worth preserving.

Same root cause, over-removal direction: `<div x=a<b style="display:none">PAYLOAD</div>Visible.` returns `''` — `Visible.` is destroyed by the stage-6 stray-`<` truncation. Documented residual (c) covers *unbalanced quotes* only; an unquoted `<` in an attribute is a second, undocumented trigger of the same truncation.

**Fix:** Make the tag-scanning literals tolerate an unquoted `<` inside the attribute region, matching the HTML tokenizer, so stages 2 and 4 agree on the *correct* boundary rather than on a shared miss. Build all four from one shared fragment so they cannot drift again:

```ts
// Shared unquoted-attribute fragment — single source of truth for all four tag-scanning
// literals. `<` is legal inside an unquoted attribute value (HTML §13.2.5.36); only an
// unquoted `>` terminates a tag.
const ATTRS = `(?:"[^"]*"|'[^']*'|[^'">])*`;

const START_TAG_RE = new RegExp(`<([a-zA-Z][a-zA-Z0-9]*)\\b(${ATTRS})>`, 'g');
const ANY_TAG_TOKEN_RE = new RegExp(`<(\\/?)([a-zA-Z][a-zA-Z0-9]*)\\b${ATTRS}>`, 'g');
const STYLE_BLOCK_RE = new RegExp(`<style\\b${ATTRS}>([\\s\\S]*?)<\\/style\\b[^>]*>`, 'gi');
const ANY_TAG_RE = new RegExp(`<${ATTRS}>`, 'g');
```

Add the regression case to `tests/strip-hidden.test.ts` and to the CR-01 block in `tests/gmail-hidden-content.test.ts`:

```ts
it('CR-01: an unquoted < inside a <style> attribute still yields the hiding rule to the harvest', () => {
  const out = stripHiddenContent('<style x=a<b>.legal{display:none}</style>ok<span class="legal">P</span>');
  expect(out).not.toContain('P');
  expect(out).not.toContain('display:none');
  expect(out).toContain('ok');
});
```

The shared-fragment construction also resolves WR-06: a fifth regex written against `ATTRS` cannot reintroduce the bug class, which a string-matching source guard can never guarantee.

---

#### CR-02 (BL-02): `</style foo>` and `</style/>` close the element per spec but not per `STYLE_BLOCK_RE` — harvest bypassed while stage 4 removes the block

**File:** `src/source/strip-hidden.ts:216` (the `<\/style\s*>` tail) vs. `src/source/strip-hidden.ts:125` (`ANY_TAG_TOKEN_RE`)
**Severity:** BLOCKER

**Issue:** The closing literal is `<\/style\s*>`, accepting only `</style>` and `</style   >`. The HTML tokenizer's RAWTEXT-end-tag-name state accepts more: on whitespace it transitions to *before attribute name* (`</style foo>` closes the element), and on `/` it transitions to *self-closing start tag* (`</style/>` closes the element, self-closing flag ignored). Stage 4's `ANY_TAG_TOKEN_RE` accepts both of those forms as a `style` close tag.

So on these inputs stage 2 harvests nothing while stage 4 deletes the `<style>` element — the exact "stage 2 disagrees with stage 4 about where this element ends" failure the new doc comment at `:211-214` claims to be guarding against. The evidence that the span is hidden is destroyed; the span's text survives.

Verified:

```
in : '<style>.legal{display:none}</style foo>ok<span class="legal">PAYLOAD_B</span>'
out: 'okPAYLOAD_B'

in : '<style>.legal{display:none}</style/>ok<span class="legal">PAYLOAD_B2</span>'
out: 'okPAYLOAD_B2'
```

(`</style\n>` and `</STYLE>` are handled correctly — `\s*` and the `i` flag cover them. The gap is specifically attributes and the self-closing slash.)

This predates 62-09, but it is a live bypass of exactly the harvest 62-09 was chartered to repair, it is in the shape family the review brief names (`</style` variants), and 62-09 rewrote this literal's line without widening the tail.

**Fix:** Widen the close-tag tail to what a `style` end tag can legally contain, consistent with `ANY_TAG_TOKEN_RE`:

```ts
const STYLE_BLOCK_RE = /<style\b(?:"[^"]*"|'[^']*'|[^'">])*>([\s\S]*?)<\/style\b[^>]*>/gi;
```

Test:

```ts
it.each([
  ['</style foo>', '<style>.legal{display:none}</style foo>ok<span class="legal">P</span>'],
  ['</style/>',    '<style>.legal{display:none}</style/>ok<span class="legal">P</span>'],
])('harvests through a %s end tag', (_label, input) => {
  const out = stripHiddenContent(input);
  expect(out).not.toContain('P');
  expect(out).toContain('ok');
});
```

---

#### CR-03 (BL-03): `INVISIBLE_CODEPOINTS_RE` is a hand-maintained literal that omits several published invisible-payload carriers — CR-02's header guard is incomplete for its own named threat class

**File:** `src/source/strip-hidden.ts:102-103` (consumed at `:432` and `:451`; header call sites `src/source/gmail-adapter.ts:363-364`)
**Severity:** BLOCKER

**Issue:** The regex covers `U+200B–U+200D, U+2060, U+FEFF, U+00AD, U+180E, U+2061–U+2064, U+E0000–U+E007F`. The following carriers were verified to pass straight through both `stripInvisibleCodepoints` and `stripHiddenContent`, and confirmed present in `record.content` via `normalizeGmailMessage`:

| Carrier | Codepoints | Why it matters |
|---|---|---|
| Variation Selectors Supplement | `U+E0100–U+E01EF` | The 2025 arbitrary-byte smuggling technique. Immediately adjacent to the Tags block that IS covered — same attack, offset by `0x80`. |
| Variation Selectors | `U+FE00–U+FE0F` | Same technique, BMP half. |
| Bidi embedding / override / isolate | `U+202A–U+202E`, `U+2066–U+2069` | Trojan-Source-class visual reordering. |
| LRM / RLM / ALM | `U+200E`, `U+200F`, `U+061C` | Zero-width invisible marks. `U+200E` is *one codepoint past* the end of the covered `U+200B–U+200D` range — this reads as an off-by-one in the range, not a decision. |
| Combining grapheme joiner, deprecated format chars | `U+034F`, `U+206A–U+206F` | Invisible `Cf`/`Mn`. |
| Hangul fillers | `U+115F`, `U+1160`, `U+3164`, `U+FFA0` | Render as blank; the classic "invisible character" trick. |
| Line / paragraph separator | `U+2028`, `U+2029` | Structure forgery in a header field, adjacent to the accepted WR-01 newline case. |

Observed output for a `Subject:` carrying six `U+E0100`-series selectors, and for a bidi-override subject:

```
"From: a@b.c · Re: Your application<U+E0100..U+E0105> · Acct: default\nbody"
"From: a@b.c · Re: Invoice <RLO>txt.exe<PDF> attached · Acct: default\nbody"
```

The file-level doc block names "the 'hidden Unicode instruction injection' carrier named in 2026 indirect-prompt-injection research" as the thing this stage exists to stop. A guard against that class expressed as an enumerated literal will drift — this wave's own history (CR-01 surviving in the fourth of four regexes for a full extra plan) is the argument.

**Fix:** Derive the set from Unicode properties rather than maintaining a list, plus the non-`Cf` extras:

```ts
/**
 * Invisible / non-rendering codepoints. Derived from Unicode properties rather than an
 * enumerated list so a new carrier codepoint cannot silently drift outside the guard:
 *  \p{Cf} — all format controls: zero-width chars, BOM, soft hyphen, U+180E, invisible
 *           math operators, LRM/RLM/ALM, bidi embed/override/isolate, U+206A-206F, and
 *           the whole Unicode Tags block U+E0000-E007F.
 *  \p{Variation_Selector} — U+FE00-FE0F and U+E0100-E01EF (Mn, not Cf): the 2025
 *           arbitrary-byte smuggling carrier, adjacent to the Tags block.
 *  Explicit extras: U+034F CGJ, U+2028/U+2029 separators, Hangul fillers.
 * NOTE: \p{Cf} does NOT include U+0000-U+001F, so \n and \t are preserved (stage 8 owns
 * whitespace) and the accepted WR-01 newline disposition is unchanged by this widening.
 */
const INVISIBLE_CODEPOINTS_RE =
  /[\p{Cf}\p{Variation_Selector}\u034F\u2028\u2029\u115F\u1160\u3164\uFFA0]/gu;
```

Then replace the enumerated coverage table at `tests/strip-hidden.test.ts:503-515` with a table sourced from the *threat class* rather than from the implementation, and re-check the three round-trip assertions at `tests/gmail-hidden-content.test.ts:133/156/170`, which currently hardcode the same ranges as the implementation (see WR-05).

---

### Warnings

#### WR-01: Stage 2 harvests `display:none` rules from inside HTML comments, deleting genuinely visible prose

**File:** `src/source/strip-hidden.ts:455` (stage 2) vs. `:458` (stage 3)
**Severity:** WARNING

**Issue:** The harvest runs before comment removal, so a hiding rule inside an HTML comment is applied globally. Outlook conditional comments wrapping a `<style>` block are ubiquitous in real marketing/ATS mail — precisely the corpus this module was written for. Measured:

```
in : '<!--[if mso]><style>.promo{display:none}</style><![endif]-->Hello <span class="promo">VISIBLE PROMO TEXT</span> bye'
out: 'Hello bye'
```

`VISIBLE PROMO TEXT` is visible in every non-Outlook client and is silently destroyed. This is the false-positive direction that residual (a) explicitly refuses to accept elsewhere ("would drop legitimate dark-mode-styled prose, trading an injection risk for a classification-accuracy regression") — applied inconsistently here.

**Fix:** Run comment removal before the harvest (swap stages 2 and 3 in `stripHiddenContent`, harvesting from the comment-stripped string). Re-verify idempotence over `IDEMPOTENCE_FIXTURES` afterwards, and add the MSO-conditional case as a KEEP test.

#### WR-02: The stage-2 quadratic is unbounded because nothing caps body size before `stripHiddenContent` — 1 MB measured at 2.8 s

**File:** `src/source/gmail-adapter.ts:362`; bound tested only at 64 KB in `tests/strip-hidden.test.ts:406-457`
**Severity:** WARNING

**Issue:** T-62-54 is accepted as pre-existing O(n²), but its *reachability* was never characterized and the mitigation is absent. `extractBodyText` (`src/source/gmail-adapter.ts:123-144`) returns the decoded body verbatim with no length limit, and `EpisodicStore.capContent` (`src/db/episode-store.ts:70`) runs *downstream* of stripping, so it bounds none of this work. Gmail bodies are attacker-sized. Measured on this machine over the suite's own Shape T:

```
 64 KB ->    13 ms
128 KB ->    45 ms
256 KB ->   180 ms
512 KB ->   708 ms
  1 MB ->  2845 ms
```

Clean quadratic. Extrapolating: ~45 s at 4 MB, tens of minutes at Gmail's practical ceiling — a single crafted message stalls the whole sleep pass, which is a per-message availability failure, not a throughput nit. The suite's `< 500 ms` assertions at 64 KB read as a safety bound but only bound the smallest point on the curve.

The alternation itself is fine, and I want to state that positively: `"[^"]*"`, `'[^']*'` and `[^'"<>]` are disjoint on their first character, so there is no ambiguity for the engine to backtrack through — 62-09's ReDoS reasoning is sound. The cost is entirely the failing forward scan repeated per start position, and the missing piece is an input cap.

**Fix:** Cap the input at the stripper's boundary — the cap already exists conceptually downstream, just apply it before the quadratic work:

```ts
/** Hard cap on pre-strip body size. Bounds the stage-2 O(n²) scan (T-62-54) on an
 *  attacker-sized body; downstream capContent trims to maxContentBytes anyway, so
 *  anything past this ceiling could never have reached the episode. */
const MAX_STRIP_INPUT_BYTES = 256 * 1024;
const strippedBody = stripHiddenContent(raw.bodyText.slice(0, MAX_STRIP_INPUT_BYTES));
```

and extend the growth-ratio test to 256 KB → 512 KB so the curve is measured where it actually hurts.

#### WR-03: `<style/>` — stage 2 treats it as a block and harvests, stage 4 treats it as self-closing and leaves the CSS as prose

**File:** `src/source/strip-hidden.ts:216` vs. `:181` (`SELF_CLOSING_SUFFIX_RE`)
**Severity:** WARNING

**Issue:** HTML does not honor self-closing syntax on non-foreign elements, so `<style/>` *opens* a style element in a browser and everything up to `</style>` is invisible CSS. Here:

```
in : '<style/>.legal{display:none}</style>ok<span class="legal">PAYLOAD_I</span>'
out: '.legal{display:none}ok'
```

The harvest succeeds (good — the payload is removed) but the stylesheet text is emitted as prose into the classifier's token stream. Same cross-stage disagreement class as BL-02, opposite direction.

**Fix:** Treat RAWTEXT elements as never self-closing in `collectRemovalRanges`:

```ts
const RAWTEXT_ELEMENTS = new Set(['script', 'style', 'title', 'textarea']);
const selfClosing =
  !RAWTEXT_ELEMENTS.has(tagName) &&
  (SELF_CLOSING_SUFFIX_RE.test(match[0]) || VOID_ELEMENTS.has(tagName));
```

#### WR-04: 22 of 26 cases in the "stage-1 extraction is behavior-preserving" block are tautologies

**File:** `tests/strip-hidden.test.ts:539-553`
**Severity:** WARNING

**Issue:** The block asserts `stripHiddenContent(s) === stripHiddenContent(stripInvisibleCodepoints(s))` over `[...IDEMPOTENCE_FIXTURES, ...INVISIBLE_UNICODE_INPUTS]`. Counted programmatically: **22 of the 26 inputs contain no invisible codepoint at all**, so for those `stripInvisibleCodepoints(s) === s` and the assertion reduces literally to `f(s) === f(s)` — unfailable by construction. Only 4 cases carry signal, and 2 of those are the same string listed twice (`IDEMPOTENCE_FIXTURES[3]` and `INVISIBLE_UNICODE_INPUTS[0]`).

Worse, the block's stated claim — "Proves the outline transformation … changed nothing observable" — is not what it tests. It compares the function against *itself*; there is no pre-refactor reference, so it cannot detect any change to stages 2-8. It would pass unchanged if stage 5's hiding registry were gutted.

Given this phase already shipped one vacuously-passing test that forced plan 62-06 into existence, this is the same failure mode recurring inside the plan that was meant to be careful about it. (The comment claiming the fixtures are shared "by reference, not a hand-copied subset" is true and beside the point — sharing the array does not make the cases discriminating.)

**Fix:** Either drop the block and rely on the recorded full-suite counts as the SUMMARY already does, or make it discriminating and guard against fixture drift:

```ts
const discriminating = allInputs.filter(s => stripInvisibleCodepoints(s) !== s);
it('the behavior-preservation fixtures actually exercise stage 1', () => {
  expect(discriminating.length).toBeGreaterThanOrEqual(6);
});
it.each(discriminating)('...', (s) => { /* existing assertion */ });
```

#### WR-05: The invisible-codepoint coverage table asserts the implementation against itself

**File:** `tests/strip-hidden.test.ts:503-515`; same pattern at `tests/gmail-hidden-content.test.ts:133, 156, 170`
**Severity:** WARNING

**Issue:** The `it.each` table enumerates exactly the eight codepoint classes present in `INVISIBLE_CODEPOINTS_RE`, and its title claims "every codepoint class in INVISIBLE_CODEPOINTS_RE is covered". That is true and provides no information: it can only confirm that the regex contains what the regex contains. It says nothing about the property that matters — whether the guard covers the threat class — which is why BL-03 shipped. The three assertions in `gmail-hidden-content.test.ts` repeat the implementation's ranges verbatim as the assertion pattern, so they will keep passing for any carrier the implementation misses.

**Fix:** Source the table from the threat class, not the implementation (see BL-03). At minimum, retitle these as *implementation-mirror* tests so a future reader does not mistake them for coverage evidence.

#### WR-06: The CR-01 "bug-class guard" does not guard the bug class

**File:** `tests/strip-hidden.test.ts:459-485`
**Severity:** WARNING

**Issue:** The guard's stated purpose is "so a fifth regex added later — with the same bug — fails the suite instead of shipping a third instance of the bug class." It is two `not.toContain` string checks against `'[^>]*'` and `'[^<>]*'`. Every one of the following is the same bug and passes the guard: `[^>]+`, `[^>]{0,200}`, `[^ >]*`, `[^\s>]*`, `[^\n>]*`, or any regex built via `new RegExp(...)` from a template. It also, by construction, could not have caught BL-01 or BL-02 — both surviving bypasses live in a regex that *does* carry the quote-aware prefix.

The second assertion (`count >= 4`) is a lower bound on a count that cannot decrease unless a regex is deleted, so it does not detect one regex being reverted while another is added.

Minor secondary issue: the comment-stripping filter only drops lines whose *trimmed start* is `//`, `/*`, or `*`, so a trailing `// … [^>]* …` comment on a code line would trip the guard as a false positive.

**Fix:** Replace the string guard with the structural fix in BL-01 — a single shared `ATTRS` fragment that all four literals are built from. A shared constant is a guarantee; a grep is a hope. If a guard test is still wanted, assert positively against the regex objects:

```ts
for (const [name, re] of Object.entries(TAG_SCANNING_REGEXES)) {
  expect(re.source, `${name} must use the shared quote-aware attribute fragment`).toContain(ATTRS);
}
```

#### WR-07: `GmailAdapter.pull()` reads `Date.now()` directly, bypassing the project's `Clock` seam — the clamp is untestable end-to-end and one test depends on wall-clock

**File:** `src/source/gmail-adapter.ts:506`; consequence at `tests/gmail-event-ts.test.ts:193-212`
**Severity:** WARNING

**Issue:** The codebase has a `Clock` abstraction with a `FakeClock` — `tests/gmail-event-ts.test.ts:22,188` imports and uses it for `SemanticStore` in the very same file. `GmailAdapter` does not accept one, so the only `nowMs` that ever reaches the CR-03 clamp in production is real wall-clock, and no test can drive `pull()` through the clamp.

The visible consequence: the end-to-end test at `:193` asserts `newer.event_ts === Date.parse('Tue, 9 Jun 2026 10:00:00 +0000')`, which holds only because the machine clock is past that instant. Run the suite on a machine whose clock is before 2026-06-09T10:00Z and it fails, because the clamp would return `Date.now()`. The file's own comment at `:42-46` shows the authors already noticed the clamp interacting with fixture dates and hand-corrected the *unit* fixtures; the end-to-end path was left on the real clock.

**Fix:** Inject the existing `Clock`, matching the pattern used elsewhere in the codebase:

```ts
constructor(config: EngineConfig, meta: MetaStore, accountId = 'default',
            fetcher?: GmailFetcher, private readonly clock: Clock = new SystemClock()) { … }
// in pull():
const nowMs = this.clock.now();
```

then drive the end-to-end test with `new FakeClock(NOW)` so it is deterministic and can actually exercise the clamp through `pull()`.

#### WR-08: The recorded WR-01 fix shape (strip newlines from headers) will not close the same-line separator forgery

**File:** `src/source/gmail-adapter.ts:367`
**Severity:** WARNING

**Issue:** This is not a restatement of the accepted WR-01 (a raw `\n` forging a second provenance *line*) — it is a distinct variant the named fix shape does not reach. The provenance header uses ` · ` as an in-line field separator and neither `From` nor `Subject` is stripped of it:

```
From: attacker@evil.com · Re: benign · Acct: work-trusted · Acct: default
```

No newline is involved, so a newline-stripping fix leaves this intact. The extractor sees two `Acct:` claims on one line with the attacker's chosen value first. Since 62-11's premise is that the provenance header is a sender-controlled surface needing a guard, the guard should cover the delimiter, not only the line break.

**Fix:** When the WR-01 fix lands, neutralize the whole delimiter set in one pass and test both variants together:

```ts
/** Neutralizes every provenance-header delimiter, not just newlines: a sender-controlled
 *  From:/Subject: must not be able to forge an additional field on the line OR a new line. */
const PROVENANCE_DELIMITERS_RE = /[\r\n\u2028\u2029\u00B7]/g;
const safeField = (s: string) =>
  stripInvisibleCodepoints(s).replace(PROVENANCE_DELIMITERS_RE, ' ');
```

---

### Info

#### IN-01: `MAX_HARVESTED_SELECTORS` comment overstates what the cap does

**File:** `src/source/strip-hidden.ts:222-223`
**Issue:** "Cap on harvested selectors so a pathological stylesheet cannot cause quadratic work." The cap bounds the size of the returned sets; the quadratic work (WR-02) is in `STYLE_BLOCK_RE`'s tail scan and is entirely unaffected by it. A reader trusting this comment would conclude the DoS surface is already mitigated.
**Fix:** Reword to "Cap on the harvested selector set size, bounding stage-5 predicate cost. Does NOT bound the stage-2 scan — see T-62-54."

#### IN-02: The `lastIndex` regression lock cannot fail

**File:** `tests/strip-hidden.test.ts:579-599`
**Issue:** `INVISIBLE_CODEPOINTS_RE` is only ever driven through `String.prototype.replace`, whose `@@replace` algorithm sets `lastIndex = 0` before matching for global regexes. The property is guaranteed by the language spec, so the test is unfailable as written. It retains value as a canary if someone later switches to a manual `.exec()` loop — that framing should be explicit so it isn't mistaken for evidence of a real hazard having existed.
**Fix:** Retitle to reflect what it locks, or assert `INVISIBLE_CODEPOINTS_RE.lastIndex === 0` after a call, which is the actual observable.

#### IN-03: Wall-clock threshold assertions in the ReDoS tests are CI-flaky

**File:** `tests/strip-hidden.test.ts:378, 386, 431, 439`
**Issue:** `expect(elapsed).toBeLessThan(500)` on a shared or loaded runner is a flake source; a GC pause or noisy neighbor fails the build for a non-defect. The growth-ratio tests (`t64 / max(t32,1) <= 8`) are the better instrument and are already present.
**Fix:** Keep the ratio tests as the assertion of record; raise the absolute thresholds to a generous ceiling (e.g. 5 s, which still catches a hang) or drop them.

#### IN-04: `parseEmailDate` returns `NaN` rather than `null` when `nowMs` is `NaN`

**File:** `src/source/gmail-adapter.ts:317-321`
**Issue:** With `nowMs = NaN` both comparisons are `false` and `Math.min(parsed, NaN)` returns `NaN`, so the declared `number | null` contract yields a number that is not a time. No production caller can produce this today (`Date.now()`), so this is flagged only because the JSDoc promises "confident-or-null at every step" and the code does not. Fixing it is optional under the project's no-handling-for-impossible-cases rule; correcting the doc would do equally well.
**Fix:** Either `if (!Number.isFinite(nowMs)) return null;` at the top, or soften the JSDoc claim.

---

_Reviewed: 2026-07-30T15:20:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
