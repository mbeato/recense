---
phase: 62-multi-inbox-email-ingest-hardening
verified: 2026-07-31T18:43:20Z
status: gaps_found
score: 3/4 must-haves verified
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 3/4
  gaps_closed:
    - "FB-01 (BLOCKER — raw-newline-broken CSS string desyncing brace-partitioning): CLOSED. 62-17's token-stream rewrite (harvestFromStylesheet, {}/{} TOKEN-based frame stack) makes rule boundaries structural, not raw-text brace counting, so a BadString/Url/Function token cannot forge or swallow a brace. Independently reproduced CLOSED against dist/: the exact FB-01 payload from the prior verification pass now returns record.content ending exactly \"...Thanks for applying.\" with the injected instruction absent."
    - "T62-91 (WARNING — WR-02 cap's 1000ms bound falsified by an unmeasured STYLE_BLOCK_RE parametrization): CLOSED. 62-18 deletes STYLE_BLOCK_RE outright (the module's last quadratic) in favor of a linear START_TAG_RE + findRawtextCloseBounds walk. Independently re-derived from the shipped doc-comment cost table and cross-checked structurally: the deleted regex, not a re-bounded cap, was T62-91's root cause, and the replacement is O(n) regardless of brace shape."
  gaps_remaining: []
  regressions: []
new_gaps_from_this_verification:
  - "CR-05 (BLOCKER, independently reproduced): the declaration-signature layer (hasHidingSignature) still runs over RAW, untokenized CSS text — a comment or a hex-escaped ident inside a declaration value defeats it. Three independently reproduced shapes: `<style>.legal{display:/*x*/none}</style>` -> leak; `<style>.legal{display:\\6eone}</style>` -> leak; `<div style=\"display:/*x*/none\">` -> leak. The comment-in-declaration sub-shape (`display:/*x*/none` inside a harvested <style> rule) is a REGRESSION from wave 11-14 (baseline 0714166 correctly returns no-leak for this exact input; HEAD leaks) — this corrects 62-REVIEW.md's blanket 'byte-identical, pre-existing' classification for CR-05, which does not hold for this specific sub-shape. The escaped-ident and inline-style-attribute sub-shapes ARE pre-existing (byte-identical against 0714166)."
  - "CR-06 (BLOCKER, independently reproduced, confirmed pre-existing/byte-identical against 0714166): an unterminated final declaration block (`<style>.legal{display:none</style>...`, no closing `}`) is silently dropped from the harvest entirely — a frame is only evaluated on RightCurlyBracket, and EOF abandons the stack without draining it. Three shapes reproduced leaking identically on both HEAD and the pre-wave-11 baseline."
  - "CR-07 (BLOCKER, independently reproduced, confirmed pre-existing/byte-identical against 0714166): HTML character references in class/id/style attribute values are never decoded before comparison (extractAttr returns raw source text). `class=\"leg&#97;l\"`, `id=\"leg&#97;l\"`, `style=\"display&#58;none\"`, `style=\"display&colon;none\"` all reproduced leaking, identically on both HEAD and baseline."
  - "CR-08 (BLOCKER, independently reproduced, confirmed NEW code introduced by 62-17): decodeIdentEscapes consumes only the CR of a CRLF hex-escape separator, leaving a stray LF in the decoded name, so a hex-escaped selector authored with Windows line endings (`.leg\\61\\r\\nl{display:none}`) never matches its class attribute. Confirmed the surrounding escape-decoding FEATURE itself is new to 62-17 (absent from the 0714166 baseline entirely: decodeIdentEscapes does not exist there) by an independent control -- a plain-space-separated escaped selector (`.leg\\61 l`) is correctly closed on HEAD (no leak) and leaks on baseline (no escape decoding at all) -- so CR-08's CRLF-specific defect is a genuine new bug in genuinely new code, not a re-report of a pre-existing gap."
  - "CR-09 (BLOCKER, independently reproduced, confirmed pre-existing/byte-identical against 0714166): MAX_HARVESTED_SELECTORS (200) fails OPEN -- every cap check abandons further harvesting and proceeds to strip with a known-incomplete hidden-set. 250 junk `.fN{display:none}` rules before a real `.legal{display:none}` rule starves the cap and the payload leaks, identically on HEAD and baseline."
  - "CR-10 (BLOCKER, independently reproduced, confirmed pre-existing/byte-identical against 0714166): a `<style>` tag inside an HTML comment (stage 2 runs before comment removal) hijacks the outer walk -- findRawtextCloseBounds pairs the bogus commented-out open tag with the REAL </style>, poisoning the real rule's prelude with intervening HTML tokens, and the real stylesheet is never harvested. Both shapes reproduced leaking identically on HEAD and baseline."
  - "CR-11 (BLOCKER, independently reproduced by re-running the exact shipped Generator-1 exhaustive k=2 cross-product with instrumentation added and reverted cleanly): the 62-19 differential (tests/css-liveness-differential.test.ts) can never fail on a leak from this generator -- runDifferential pushes every genuine leak (classLive && classPresent) into newlyFiled.NFDANGER_leak, which is asserted only via `toBeLessThan(pairCount * 0.05)`, never toEqual([]) or routed through a structural predicate. Independently measured: pairs=1936, cdoTruncation=86, NFDANGER_leak=19 (bound 96.8), NFSAFE_overStrip=49 (bound 387.2) -- exact match to 62-REVIEW.md's reported numbers. This directly contradicts 62-19-SUMMARY.md's own claim ('zero silently absorbed', 'AD-*/NF-* ... never a blanket tolerance for either') and 62-19-PLAN.md's own must-have truth ('Accepted divergences are a declared, named, predicate-checked allowlist -- any divergence outside it fails the suite'): 19 live leaks from a single test run are absorbed by count, not individually gated, and none of them is separately locked as an it.fails reproduction the way NF-01/03/04/05/REG-01 are."
  - "WR-10 (WARNING, independently reproduced by construction): the compile-time guard src/types/css-tree-tokenizer.d.ts documents ('an accidental future import of the bare css-tree package ... fails to compile ... from src/'s perspective') does not exist. A temporary probe file under src/source/ importing both the bare css-tree package (parse/walk/ident) and the test-only oracle (tests/support/css-liveness-oracle) compiled cleanly (npx tsc --noEmit exit 0) because tests/support/css-tree-ambient.d.ts's `declare module 'css-tree'` is a program-global ambient declaration and tsconfig.json's include is [\"src\",\"tests\",\"scripts\"]. Probe created, verified, and deleted; git status confirmed clean after."
deferred: []
human_verification: []
---

# Phase 62: Multi-Inbox Email Ingest Hardening Verification Report

**Phase Goal:** A user can onboard a second Gmail account through a guided flow and scope each inbox's initial backfill independently, and no hidden/attacker-controlled content from either inbox can reach a future classifier.
**Verified:** 2026-07-31T18:43:20Z
**Status:** gaps_found
**Re-verification:** Yes — after gap-closure waves 11-14 (plans 62-16, 62-17, 62-18, 62-19), which replaced the hand-rolled CSS scanner with a `css-tree/tokenizer` token-stream walk, closed the previously-open FB-01 (raw-newline-broken CSS string) and T62-91 (WR-02 cap sizing) blockers, and built an oracle-driven differential.

## Summary

Waves 11-14 genuinely closed what they were chartered against. FB-01 — the fifth independently-shipped mechanism of "a hiding rule's harvest gets desynchronized by adjacent malformed CSS" that this phase's prior four rounds each found a new instance of — is CLOSED: making rule boundaries come from `{`/`}` TOKENS rather than raw-text brace counting is a structural fix, not another patch, and it is independently confirmed against `dist/` with the exact payload the prior verification pass used. T62-91 (the WR-02 cap's cost argument not holding for an unmeasured `STYLE_BLOCK_RE` parametrization) is also CLOSED: `STYLE_BLOCK_RE` — the module's one remaining quadratic — is deleted outright, not re-bounded.

But this pass's own mandated adversarial probing of the layer the review flagged (the CSS **declaration**-signature side, `hasHidingSignature`, and the HTML **attribute** side, `isHiddenStartTag`) found that **the selector layer's migration to token-structural agreement was never matched by the declaration/attribute layers, both of which are still raw-text regex scans, and both are trivially bypassable.** I independently reproduced seven Critical mechanisms (CR-05 through CR-11) and one compile-time-guard Warning (WR-10) from the fresh `62-REVIEW.md` against the shipped `dist/` build, using my own constructed payloads, not the review's prose. All seven Critical reproductions leak a realistic prompt-injection-shaped payload (or, for CR-11, demonstrate that leaks are silently absorbed rather than gated) through `stripHiddenContent`. Five of the seven (CR-06, CR-07, CR-09, CR-10, and two of CR-05's three sub-shapes) are confirmed **pre-existing** — byte-identical against the pre-wave-11 baseline (`0714166`) — meaning they were never closed by any of this phase's fifteen prior waves despite the module's stated "no hidden content reaches record.content" contract. One (CR-08) is confirmed **new code written by 62-17**, with an independent control proving the surrounding escape-decoding feature is itself new and correctly closes a different, related gap. One (CR-05's comment-in-declaration sub-shape specifically) is a genuine **regression** introduced by waves 11-14 — a correction to the fresh review's own "verification notes" section, which classified all of CR-05 as pre-existing/byte-identical; that classification does not hold for this sub-shape.

The differential test suite built specifically to catch exactly this class of defect (`tests/css-liveness-differential.test.ts`, 62-19) does not gate on it: I independently re-ran its exact shipped Generator-1 exhaustive cross-product with instrumentation added and cleanly reverted, and confirmed 19 genuine leaks pass silently under a magnitude bound (`< pairCount * 0.05`), never asserted to zero and never individually locked — directly contradicting 62-19-SUMMARY.md's own "zero silently absorbed" claim and 62-19-PLAN.md's own must-have ("any divergence outside [the allowlist] fails the suite").

**This phase cannot be marked `passed`.** EMAIL-03 remains FAILED — the same roadmap Success Criterion #3 wording this phase has now failed across all five verification rounds, via a newly-identified pair of un-migrated layers (declaration signatures, HTML attribute values) rather than a sixth instance of the selector-harvest bug class the last four rounds chased. EMAIL-01, EMAIL-02, and EMAIL-04 remain solidly verified as an untouched, zero-diff surface.

## Goal Achievement

### Observable Truths

| # | Truth (roadmap SC) | Status | Evidence |
|---|---|---|---|
| 1 | User can authorize an additional Google account through a guided CLI flow (loopback OAuth redirect) that mints and stores `GOOGLE_<ID>_REFRESH_TOKEN` without hand-rolling OAuth or hand-editing env files (EMAIL-01) | VERIFIED (regression check) | `git log --oneline 0ef9b5a6..HEAD -- src/adapter/gmail-auth-cli.ts src/adapter/runtime-config.ts src/adapter/recense-doctor.ts src/lib/config.ts` returns 0 commits (independently re-run this pass). |
| 2 | User can set a per-account Gmail query scoping that account's initial backfill independently; backfill-only limitation stated in the config doc comment AND surfaced by `recense doctor` (EMAIL-02) | VERIFIED (regression check) | Same zero-diff confirmation as above, independently re-run. |
| 3 | Hidden or invisible content in HTML-only emails is deterministically stripped before any content reaches the extractor, verified by a regression fixture with a hidden injected instruction that must not survive into episode content (EMAIL-03) | FAILED | FB-01 and T62-91 (the previously-open blockers) are genuinely CLOSED, independently reproduced against `dist/`. But CR-05, CR-06, CR-07, CR-08, CR-09, CR-10 are all independently reproduced LIVE against `dist/` with realistic injection payloads, and CR-11 independently confirms the differential meant to catch exactly this class silently absorbs 19 genuine leaks per run rather than gating on them. See "Independent Reproductions" below. |
| 4 | A fresh account's initial backfill batch is consolidated in chronological order (derived from the email's own `Date:` header), so an older message in the same backfill cannot silently apply over newer state (EMAIL-04) | VERIFIED | `git log --oneline 46622c2..HEAD -- src/consolidation/episode-order.ts` returns 0 commits. `git diff 46622c2^..HEAD -- src/source/gmail-adapter.ts`: `return Math.min(parsed, nowMs);` (parseEmailDate's clamp) appears only as unchanged context, never as an added/removed line — independently re-confirmed this pass. |

**Score:** 3/4 roadmap SCs verified (EMAIL-01, EMAIL-02, EMAIL-04); EMAIL-03 failed on seven independently-reproduced findings (CR-05 through CR-11), none locked by any shipped test.

### Independent Reproductions (this pass's own probes against `dist/`)

All reproductions below were run against `dist/src/source/strip-hidden.js` after a clean `npm run build` (exit 0). A pre-wave-11 baseline (`0714166`) was built in an isolated `git worktree` and torn down after use; `git status --porcelain` confirmed clean before and after every probe.

| Finding | My repro (payload → output) | Baseline (`0714166`) output | Verdict |
|---|---|---|---|
| CR-05a: comment inside declaration | `<style>.legal{display:/*x*/none}</style>ok<span class="legal">PAYLOAD</span>` → `"okPAYLOAD"` | `"ok"` (no leak) | **LEAK, and a REGRESSION** — differs from baseline; corrects 62-REVIEW.md's "byte-identical, pre-existing" claim for this sub-shape |
| CR-05b: escaped ident in declaration | `display:\6eone` → `"okPAYLOAD"` | `"okPAYLOAD"` (identical) | LEAK, pre-existing |
| CR-05c: inline `style` attribute comment | `<div style="display:/*x*/none">PAYLOAD</div>ok` → `"PAYLOADok"` | `"PAYLOADok"` (identical) | LEAK, pre-existing |
| CR-06: unterminated final declaration block (3 shapes: class, id, prior-rule-then-unterminated) | all three leak on HEAD | all three leak identically on baseline | LEAK, pre-existing |
| CR-07: HTML char refs in class/id/style attrs (4 shapes: `&#97;`, numeric `&#58;`, named `&colon;`) | all four leak on HEAD | all four leak identically on baseline | LEAK, pre-existing |
| CR-08: CRLF hex-escape separator | `.leg\61\r\nl{display:none}` → leaks on HEAD | leaks on baseline too, but for an unrelated reason (no escape decoding exists pre-62-17); **control** (plain-space `.leg\61 l`) closes on HEAD, leaks on baseline — confirms the escape-decoding feature and its CRLF bug are both new to 62-17 | LEAK, new code (62-17) |
| CR-09: 200+ junk hiding rules starve `MAX_HARVESTED_SELECTORS` | 250 `.fN{display:none}` + real `.legal{display:none}` → leaks on HEAD | leaks identically on baseline | LEAK, pre-existing |
| CR-10: `<style>` inside an HTML comment hijacks stage 2 (2 shapes) | both leak on HEAD | both leak identically on baseline | LEAK, pre-existing |
| CR-11: differential absorbs leaks under a magnitude bound | Re-ran shipped Generator-1 exhaustive k=2 cross-product (44×44=1936 pairs) with one instrumentation line added and reverted: `NFDANGER_leak=19` (bound `<96.8`), `NFSAFE_overStrip=49` (bound `<387.2`), `cdoTruncation=86` — exact match to 62-REVIEW.md's reported numbers | N/A (test-suite structure, not a runtime shape) | Confirmed: 19 real leaks pass silently every run, unasserted-to-zero, contradicting 62-19-SUMMARY's "zero silently absorbed" |
| WR-10: compile-time `src/` isolation guard doesn't exist | Probe file `src/source/__verifier_probe_wr10.ts` importing bare `css-tree` + the test-only oracle compiled clean (`npx tsc --noEmit` exit 0); deleted after | N/A (type-system claim) | Confirmed false; guard is documented but not enforced |

Also independently spot-checked three Warnings the review filed (not required for the EMAIL-03 verdict, included for completeness): **WR-11** (`. legal` with a space is now harvested, an over-strip content-loss regression — confirmed: baseline preserves `VISIBLE_D1`, HEAD strips it) and **WR-12** (a commented-out declaration, `/*display:none*/color:red`, still hides its element — confirmed leak-direction-reversed regression: baseline preserves `VISIBLE_K4`, HEAD destroys it; note the fresh review's verification-notes section did not explicitly flag WR-12 as a regression the way it flagged WR-11, but my baseline comparison shows it is one too) and **WR-13** (NBSP-joined class token incorrectly split and matched — confirmed, identical over-strip on both HEAD and baseline, pre-existing, non-critical).

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `src/adapter/runtime-config.ts::resolveGoogleAccounts` | env-driven multi-account resolution | VERIFIED | Zero-diff since baseline, re-confirmed. |
| `src/lib/config.ts::googleAccounts` doc comment | honest backfill-only limitation | VERIFIED | Zero-diff, re-confirmed. |
| `src/source/gmail-adapter.ts::resolveAccountQuery` | per-account query w/ fallback | VERIFIED | Zero-diff, re-confirmed. |
| `src/adapter/recense-doctor.ts::checkGmailAccounts` | dimension 9 | VERIFIED | Zero-diff, re-confirmed. |
| `src/adapter/gmail-auth-cli.ts` | guided onboarding CLI | VERIFIED | Zero-diff, re-confirmed. |
| `src/source/strip-hidden.ts` | deterministic stripper closing every named bypass | STUB (partial) | 1200+ lines; the CSS *selector* layer is now genuinely token-structural (FB-01, CR-04, VF-01, NEW-01 all closed by construction). The *declaration-signature* layer (`hasHidingSignature`, raw-text regex over `css.slice(contentStart, contentEnd)`) and the *HTML attribute* layer (`isHiddenStartTag`/`extractAttr`, raw-text regex, no entity decoding) were never migrated — seven independently-reproduced bypasses (CR-05 through CR-11) live there. |
| `src/source/gmail-adapter.ts::normalizeGmailMessage` | no attacker content reaches `record.content` unstripped, bounded ingest cost | STUB (partial) | The WR-02/T62-91 cost bound is now genuinely closed (STYLE_BLOCK_RE deleted). But content-leak bypasses (CR-05 through CR-10) reach `record.content` through `stripHiddenContent` regardless of the cap — the cap bounds cost, not correctness. |
| `tests/css-liveness-differential.test.ts` | oracle-driven, both-directions differential that fails on any un-anticipated divergence | STUB (partial) | Genuinely closes the three named WR-09 gaps (DECOY_FRAGMENTS boundary construction, documented structural limit, fuzz-test leak assertion). But independently confirmed (CR-11) that its own Generator-1 exhaustive cross-product absorbs live leaks under a magnitude bound rather than gating on them — the "oracle catches unanticipated divergences" contract does not hold for leaks found by that generator itself. |
| `src/source/gmail-adapter.ts::parseEmailDate` | attacker-hostile Date parse, future dates cannot sort last | VERIFIED | Function body confirmed byte-unchanged across waves 9-14. |
| `src/consolidation/episode-order.ts::orderEpisodesForConsolidation` | slot-preserving reorder | VERIFIED | Zero-diff, unaffected by this wave. |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `src/adapter/ingest-cli.ts` | `resolveGoogleAccounts` | config construction | WIRED | Unchanged, zero-diff. |
| `src/source/gmail-adapter.ts` | `config.googleAccounts[].query` | `pull()` → `resolveAccountQuery` | WIRED | Unchanged, zero-diff. |
| `src/source/gmail-adapter.ts` | `stripHiddenContent` | `normalizeGmailMessage` — body, bounded by `MAX_STRIP_INPUT_CODE_UNITS` | WIRED, but leaks via CR-05/06/07/08/09/10 within the cap | The cap and cost bound are correct; the wired function itself has seven live, still-open bypasses independent of the cap. |
| `harvestFromStylesheet` (token-stream) | `hasHidingSignature` (raw-text regex) | rule-body evaluation | PARTIAL — structural agreement on selector boundaries only | The selector side reads from tokens; the declaration side it feeds into (`css.slice(contentStart, contentEnd)`) is raw, untokenized text passed to a regex scanner that never migrated (CR-05, WR-12). |
| `isHiddenStartTag` | `extractAttr` (raw regex, no entity decode) | class/id/style attribute matching | NOT_WIRED to any decoding step | An HTML character reference in an attribute value is compared literally against an undecoded harvested selector name, so the two can never agree (CR-07). |
| `tests/css-liveness-differential.test.ts::runDifferential` | `newlyFiled.NFDANGER_leak` | magnitude-bound assertion, not a predicate gate | WIRED, but non-blocking | Independently confirmed: 19/1936 genuine leaks in one run pass under the bound with no individual lock. |
| `src/consolidation/consolidator.ts` | `orderEpisodesForConsolidation` | wraps `listUnconsolidated()` | WIRED | Unchanged. |
| `orderEpisodesForConsolidation` | reconcile-last-applied-wins | ascending `event_ts` sort, clamped | WIRED, bounded as documented | Unchanged from prior passes. |

### Data-Flow Trace (Level 4)

Traced `raw.bodyText` → cap check → `stripHiddenContent` → `strippedBody` → `combined` → `redactSecrets` → `content`: confirmed FLOWING and correctly bounded (WR-02/T62-91 genuinely closed — cost bound holds structurally now that `STYLE_BLOCK_RE` is deleted). **Confirmed LEAKING for CR-05/CR-06/CR-07/CR-08/CR-09/CR-10-shaped inputs** — each independently reproduced end-to-end through `normalizeGmailMessage`'s underlying `stripHiddenContent`, well under the cap, `redactSecrets` does not catch any of them (it handles secret patterns, not markup/visibility, exactly as documented).

Traced the differential's own leak-detection path (`runDifferential` → `newlyFiled.NFDANGER_leak` → `expect(...).toBeLessThan(...)`): confirmed the path terminates in a magnitude comparison, not a zero-tolerance gate, so genuine leaks discovered by the shipped generator do not fail the suite.

Traced `raw.headers.date` → `parseEmailDate` → `event_ts` → `orderEpisodesForConsolidation` → array position → reconcile-last-wins: confirmed FLOWING and CLAMPED, unchanged from prior passes.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| FB-01 (prior blocker) closure | `node`, `dist/src/source/gmail-adapter.js`/`strip-hidden.js`, exact prior-pass payload | Injected instruction absent, content ends `"...Thanks for applying."` | PASS |
| CR-05a comment-in-declaration | `node`, `dist/src/source/strip-hidden.js` | `"okPAYLOAD"` — PAYLOAD present | **FAIL** |
| CR-05b escaped-ident declaration | same | `"okPAYLOAD"` | **FAIL** |
| CR-05c inline-style comment | same | `"PAYLOADok"` | **FAIL** |
| CR-06 unterminated block (3 shapes) | same | all leak | **FAIL** |
| CR-07 HTML entity in attrs (4 shapes) | same | all leak | **FAIL** |
| CR-08 CRLF hex-escape | same | leaks | **FAIL** |
| CR-09 cap-starve (250 junk rules) | same | leaks | **FAIL** |
| CR-10 comment-hijacks-stage-2 (2 shapes) | same | both leak | **FAIL** |
| CR-11 differential leak-bound | `npx vitest run tests/css-liveness-differential.test.ts -t "full"`, instrumented and reverted | 19/1936 leaks pass under a `<96.8` bound | **FAIL** (structural, not a runtime leak by itself) |
| WR-10 compile-time isolation | `npx tsc --noEmit` with a probe file under `src/source/` importing `css-tree` + the test-only oracle | exit 0, no errors | **FAIL** (documented guard does not exist) |
| Full suite regression | `npx vitest run` | 196 files passed / 1 skipped, 3206 passed / 5 expected-fail / 3 skipped | PASS (confirms all seven Criticals above are uncovered by any shipped test) |
| `npm run build` | — | exit 0 | PASS |
| `npx tsc --noEmit` | — | exit 0 | PASS |

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|---|---|---|---|---|
| EMAIL-01 | 62-02 | Guided CLI OAuth onboarding | SATISFIED | Zero-diff regression re-confirmed. |
| EMAIL-02 | 62-01 | Per-account query scoping, honest limitation | SATISFIED | Zero-diff regression re-confirmed. |
| EMAIL-03 | 62-03, 62-07, 62-09, 62-11, 62-12, 62-13, 62-14, 62-15, 62-16, 62-17, 62-18, 62-19 | Hidden-content stripping | BLOCKED | Selector-layer bugs (FB-01, CR-04, VF-01, NEW-01) closed. CR-05 through CR-11 (declaration-signature and HTML-attribute layers, plus the differential's own leak-absorption) are live, independently reproduced this pass. |
| EMAIL-04 | 62-04, 62-05, 62-06, 62-08, 62-10 | event_ts + chronological consolidation | SATISFIED | `parseEmailDate` and `orderEpisodesForConsolidation` confirmed byte-unchanged across waves 9-14. |

No orphaned requirements. `.planning/REQUIREMENTS.md` line 22 marks EMAIL-03 `[x]` "Complete" and the tracking table (line 113) also shows "Complete" — this is a pre-existing documentation-staleness artifact (noted by every prior verification pass since round 4), not a code defect, but it is now doubly misleading given this pass's findings.

### Anti-Patterns Found

No `TBD`/`FIXME`/`XXX` markers in `src/source/strip-hidden.ts`, `src/source/gmail-adapter.ts`, `src/types/css-tree-tokenizer.d.ts`, or any of the wave 11-14 test files (re-confirmed by grep this pass).

CR-05 through CR-11 and WR-10 are not code-smell anti-patterns — they are functional defects found through adversarial black-box testing of the shipped `dist/` build, independently reproduced by this pass (not merely restated from `62-REVIEW.md`).

| File | Line(s) | Pattern | Severity | Impact |
|---|---|---|---|---|
| `src/source/strip-hidden.ts` | `hasHidingSignature` call site (`:846-847`), the function itself (`:986-1026` region) | Declaration text is sliced raw from source (`css.slice(contentStart, contentEnd)`) and regex-scanned without stripping comments or decoding escapes, unlike the sibling prelude/selector path | Blocker | A comment or hex-escape inside a `display:none` declaration defeats detection; realistic, low-effort attacker technique. |
| `src/source/strip-hidden.ts` | `harvestFromStylesheet`'s `RightCurlyBracket`-only evaluation, no post-tokenize drain | An unterminated final declaration block contributes nothing to the harvest | Blocker | A trivially-crafted unterminated `<style>` block hides a rule from harvest entirely. |
| `src/source/strip-hidden.ts` | `extractAttr` (`:1035-1039`) | Attribute values are never HTML-entity-decoded before comparison | Blocker | An entity-encoded class/id/style value defeats the class/id-hidden and inline-style-hidden checks identically. |
| `src/source/strip-hidden.ts` | `decodeIdentEscapes`'s CRLF branch (`:687-689`) | Consumes only the CR of a CRLF escape terminator | Blocker (new code) | A Windows-line-ending-authored hex-escaped selector desyncs from its class attribute. |
| `src/source/strip-hidden.ts` | `MAX_HARVESTED_SELECTORS` checks (`:843`, `:851`, `:940`) | Cap failure abandons further harvesting rather than failing closed | Blocker | Attacker-controlled junk rules exhaust the cap and starve a real hiding rule out of the harvest. |
| `src/source/strip-hidden.ts` | Stage 2 (`:933-960`) runs before stage 3 comment removal | A `<style>` tag inside an HTML comment is matched by stage 2's `START_TAG_RE` and hijacks the walk | Blocker | The real stylesheet's rules are never harvested; a wide blast radius (the `break`-on-unterminated logic abandons every later `<style>` too). |
| `tests/css-liveness-differential.test.ts` | `runDifferential` (`:295-307`), assertions (`:344-346` etc.) | Leaks are counted, magnitude-bounded, never individually gated | Blocker (of the test's own stated purpose) | The oracle-driven differential built to catch this exact defect class does not fail on a genuine, live leak it detects. |
| `tests/support/css-tree-ambient.d.ts` (`:14`) vs `src/types/css-tree-tokenizer.d.ts` (`:10-16`) | Program-global ambient declaration vs a documented per-directory compile guard | Documented invariant (T-62-17-08) is not enforced | Warning | No `src/` file violates it today, but nothing would catch one that did. |

### Human Verification Required

None. All findings in this report were independently reproduced programmatically against the shipped build (`npm run build`, exit 0; `dist/`), using this pass's own constructed payloads and its own instrumented-and-reverted re-run of the shipped differential generator — not restated from `62-REVIEW.md`'s prose.

### Gaps Summary

Waves 11-14 (plans 62-16, 62-17, 62-18, 62-19) did what their SUMMARYs claim for the layer they touched: the CSS **selector**-harvest layer is now genuinely token-structural, closing FB-01 (the phase's fifth independently-shipped instance of "malformed adjacent CSS desyncs the harvest") and T62-91 (the WR-02 cap's cost argument, by deleting the quadratic outright rather than re-bounding it). Both are independently reproduced CLOSED against `dist/` this pass. EMAIL-01, EMAIL-02, and EMAIL-04 remain solidly verified and untouched (zero-diff).

However, this pass's own mandated adversarial probing of the layer `62-REVIEW.md` flagged as un-migrated — `hasHidingSignature` (declaration text) and `isHiddenStartTag`/`extractAttr` (HTML attribute values), both still raw-text regex scans — found **seven independently-reproducible bypasses of the exact same "no hidden content reaches record.content" contract** (CR-05 through CR-11), all confirmed live against the shipped `dist/` build with realistic, low-effort attacker payloads: a CSS comment or hex-escape inside a declaration value, an unterminated final declaration block, an HTML character reference inside an attribute value, a CRLF-broken hex-escape, a cap-starvation attack, and a `<style>`-inside-a-comment stage-ordering bug. Five of the seven are confirmed pre-existing (byte-identical against the pre-wave-11 baseline `0714166`) — meaning fifteen prior waves across this phase's history never closed them, despite the module's stated total-coverage contract. One (CR-08) is confirmed new code from 62-17 with an independent control isolating exactly which sub-behavior is new versus pre-existing. One (the comment-in-declaration sub-shape of CR-05) is a genuine regression this pass identified that the fresh review's own "byte-identical, pre-existing" classification does not account for.

A separate, structural finding (CR-11) shows the oracle-driven differential built specifically to close WR-09 — "every shipped oracle was drawn from the same enumeration it existed to validate" — reproduces a version of the same root cause inside itself: genuine leaks its own Generator-1 exhaustive cross-product finds are absorbed under a magnitude bound rather than gated to zero, independently re-measured at 19 leaks per run against a bound of 96.8, directly contradicting 62-19-SUMMARY.md's "zero silently absorbed" claim.

**This phase cannot be marked `passed`.** CR-05 through CR-11 are each independently sufficient grounds for `gaps_found`, consistent with this pass's own methodology for FB-01/T62-91 in the prior round. The suggested fix direction from `62-REVIEW.md` — read the declaration block from the token stream already collected (skipping `Comment`, decoding `Ident` escapes) rather than raw text, decode HTML character references in `extractAttr`, drain the frame stack at EOF, fail closed on cap overflow, and compute HTML comment ranges once and share them between stage 2 and stage 3 — targets the same root cause each of the five closed layers (selector harvest, CR-01/BL-01/BL-02/BL-03/VF-01/NEW-01/FB-01) already took: agreement with a conformant CSS/HTML engine must be structural, not the outcome of enumerating repros one at a time. That argument now needs to be extended to the declaration-signature and attribute-value layers specifically, and the differential's leak bucket needs a hard `toEqual([])` or per-mechanism structural predicate rather than a magnitude tolerance.

---

_Verified: 2026-07-31T18:43:20Z_
_Verifier: Claude (gsd-verifier)_
