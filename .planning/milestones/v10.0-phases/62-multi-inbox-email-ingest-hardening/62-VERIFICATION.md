---
phase: 62-multi-inbox-email-ingest-hardening
verified: 2026-08-02T19:27:55Z
status: passed
score: 4/4 must-haves verified
overrides_applied: 0
re_verification:
  pass: 6
  previous_status: gaps_found
  previous_score: 3/4
  history:
    - "Pass 1-2 (2026-07-30): EMAIL-03 failed on CR-01 quoted-`>` bypass and the EMAIL-04 wiring proof; closed by 62-06..62-08."
    - "Pass 3 (2026-07-30): EMAIL-03 failed on BL-01/BL-02/BL-03 (shared ATTRS fragment, default-ignorable set); closed by 62-12."
    - "Pass 4a (2026-07-30): EMAIL-03 failed on VF-01 / NEW-01 / WR-02; chartered to 62-13..62-15."
    - "Pass 4b (2026-07-31): FB-01 and T62-91 closed by 62-16..62-19; EMAIL-03 failed again on newly-found CR-05..CR-11 + WR-10; chartered to 62-20..62-25."
    - "Pass 5 (2026-08-01): CR-05..CR-11 and WR-10 independently re-tested and CLOSED; EMAIL-03 failed again on CR-01/CR-02/CR-03, independently reproduced against the shipped dist/ build at HEAD (4354c81) and end-to-end through normalizeGmailMessage. Named the structural gap (WR-03): the phase's only oracle-driven differential held the HTML wrapper fixed, so no HTML-layer divergence was reachable."
    - "Pass 6 (this report, 2026-08-02): CR-01, CR-02, CR-03 independently re-tested and CLOSED, against a freshly rebuilt dist/ at HEAD (03daef7) with self-constructed payloads, plus end-to-end through normalizeGmailMessage. WR-03's structural gap is CLOSED: tests/html-wrapper-differential.test.ts + tests/support/html-render-oracle.ts is a genuinely independent parse5-based HTML oracle (confirmed never importing htmlparser2 or src/), and its own compile-time exhaustiveness check (HTML_ELEMENT_DISPOSITIONS) was independently proven non-vacuous by constructing and reverting a source edit. All four roadmap SCs now VERIFIED. One non-blocking documentation-drift finding: three MORE stale 'gap closure' doc-block cross-references survive round 7's own claimed full sweep (8df1c4e) — see Anti-Patterns."
  gaps_closed:
    - "CR-01 (self-closing `<style/>` excluded from harvest while stage 4/5 deletes it anyway): CLOSED. All four shapes (`<style/>`, `<style />`, `<STYLE/>`, `<style type=a/>`) independently re-run against dist/ at HEAD return `\"ok\"`, matching the plain-`<style>` control. Root-caused and fixed by `HTML_ELEMENT_DISPOSITIONS` (62-29): a self-closing `<style/>` start tag is now harvested by `scanHtml`'s `onclosetag` exactly like any other `<style>` — stage 2 and stage 4/5 agree by construction, no exclusion left to hold."
    - "CR-02 (stage 6's ANY_TAG_RE sweep quadratic on post-deletion input): CLOSED. Independently re-measured against dist/ at HEAD: element trigger 1.5/0.6/0.4/1.2/2.9/8.8 ms at n=1k/4k/16k/64k/256k/1,048,576 (linear, no 16x-per-4x quadratic signature); comment trigger 0.8/12.1 ms at 64k/1,048,576; a self-constructed multi-block variant (many short well-formed tags followed by the removable construct) also linear. End-to-end through `normalizeGmailMessage`: a 64 KB body-based trigger completes in 2.1 ms (was 4080 ms), and a trigger sized to exactly `MAX_STRIP_INPUT_CODE_UNITS` (1,048,576) completes in 10.3 ms — 97x under the module's own 1000 ms budget, not the ~18-minute extrapolation pass 5 measured. Fixed by re-hoisting the stray-`<` truncation to run immediately before the stage-6 sweep, on the post-deletion string (62-30)."
    - "CR-03 (`<iframe>`/`<noembed>`/`<noframes>` fallback text emitted verbatim): CLOSED. All three independently re-run against dist/ at HEAD return `\"ok\"` for the `<TAG>INJECT</TAG>ok` shape. Fixed by deriving `NON_CONTENT_TAGS` from the single `HTML_ELEMENT_DISPOSITIONS` source (62-29), which now includes all three names alongside the seven the prior hand-maintained list already had."
    - "WR-03 (the phase's only oracle-driven differential held the HTML wrapper fixed, so no HTML-layer divergence was reachable — the coverage shape that let CR-01/CR-02/CR-03 ship green): CLOSED. `tests/html-wrapper-differential.test.ts` (22 shapes x 2 probe kinds x 2 placements = 88 cases) is judged by `tests/support/html-render-oracle.ts`, a parse5-derived oracle independently read (confirmed: imports only `parse5`, never `htmlparser2` or `src/`; every rendering rule carries its own HTML-spec citation, not a copy of production's logic). Non-vacuousness is not merely claimed: the file's own header records it was run against the UNFIXED module at HEAD `0bb2653` and independently rediscovered exactly 18 divergences (8 CR-01, 6 CR-03, 4 WR-01) with nothing spurious — a claim this pass did not re-derive from scratch (would require reverting three plans) but which is falsifiable by construction and consistent with every other independently-confirmed closure in this report."
    - "WR-01 (a stylesheet nested in a never-applied context, e.g. `<iframe>`/`<noscript>`, deleted visible prose outside the container): CLOSED. Independently re-run: `<iframe><style>.legal{display:none}</style></iframe>ok<span class=\"legal\">PAYLOAD</span>` and the equivalent `<svg><iframe>...` nesting both correctly return `\"okPAYLOAD\"` (prose kept, span not spuriously hidden); the `<head><style>...` control still correctly hides (`\"ok\"`), confirming the fix is directional, not a blanket exemption."
    - "WR-09 (`applyRemovalRanges`'s ascending/non-overlapping precondition argued in prose, never checked — violation re-emits deleted text): CLOSED. Read the shipped fix: the function now sorts by `(start asc, end desc)`, skips any range fully consumed by the cursor, and advances the cursor monotonically — the cursor can no longer move backwards. The shipped 500-trial randomized property test (independently read, not re-run stochastically beyond the suite's own execution) asserts no output character falls inside any input range."
    - "WR-10 (a bare `html.indexOf('>', closeEnd)` close-tag scan let sender-controlled in-tag bytes past a quoted `>` survive into `record.content`): CLOSED. Independently re-run against dist/ at HEAD: `<div style=\"display:none\">SECRET</div foo=\"a>b\">tail` now returns `\"tail\"` (was `\"b\\\">tail\"`). Fixed by `findUnquotedGt`, a quote-aware forward scan."
    - "62-26 (parse5 devDependency legitimacy): CLOSED. `parse5@7.3.0` confirmed exact-pinned in `package.json` `devDependencies`, absent from `dependencies`; `package-lock.json` has a locked resolution."
    - "62-27 (CR-11 causal attribution, CI typecheck, REQUIREMENTS.md inversion): CLOSED. `.github/workflows/ci.yml:50` confirmed running `npm run typecheck`, which (per `package.json:37`) covers both `tsconfig.json` and `tests/tsconfig.json`. `.planning/REQUIREMENTS.md` no longer inverts EMAIL-03's status relative to the others (now correctly the only unchecked/'Blocked' row as of the pre-this-pass state it was written against)."
    - "Compile-time exhaustiveness check (`RAWTEXT_DISPOSITIONS_EXHAUSTIVE_CHECK`): CLOSED, independently proven non-vacuous by this pass — adding a ninth name to `RAWTEXT_ELEMENT_NAMES` with no matching `HTML_ELEMENT_DISPOSITIONS` entry was constructed against the live source and produced the exact `TS2741` compile error predicted; the edit was reverted and `git status --porcelain` confirmed clean."
    - "Compile-time `src/` import boundary (WR-10, wave 18): reconfirmed. Constructing `import { tokenize } from 'css-tree'` (bare, not the `/tokenizer` subpath) under `src/` and running `npx tsc --noEmit -p tsconfig.json` reproduces `TS7016`; probe deleted, tree clean."
  gaps_remaining: []
  regressions: []
gaps: []
deferred: []
human_verification: []
---

# Phase 62: Multi-Inbox Email Ingest Hardening — Verification Report (Pass 6)

**Phase Goal:** A user can onboard a second Gmail account through a guided flow and scope each inbox's initial backfill independently, and no hidden/attacker-controlled content from either inbox can reach a future classifier.
**Verified:** 2026-08-02T19:27:55Z (HEAD `03daef7`)
**Status:** passed
**Re-verification:** Yes — sixth pass, after gap-closure round 7 (waves 20-24, plans 62-26..62-31). Prior pass history is preserved in the `re_verification.history` frontmatter block; this file supersedes the 2026-08-01 (pass 5) report in place.

## Summary

Round 7 closes the phase. Every one of the three findings pass 5 filed as blocking EMAIL-03 —
CR-01, CR-02, CR-03 — is independently confirmed CLOSED here, using freshly constructed payloads
run against a freshly rebuilt `dist/` at HEAD, not the SUMMARYs' or the round-7 code review's
claims. The structural gap pass 5 named underneath those three (WR-03 — the phase's only
oracle-driven differential held the HTML wrapper fixed, so an entire layer of production shipped
with no ground truth) is also closed: `tests/html-wrapper-differential.test.ts`, judged by a
parse5-derived oracle that imports neither `htmlparser2` (production's parser) nor `src/`, is a
genuine independent HTML-layer judge, and its compile-time exhaustiveness partner
(`HTML_ELEMENT_DISPOSITIONS`) is non-vacuous by construction — I proved this myself by editing the
live source, watching `tsc` fail with the predicted error, and reverting.

1. **CR-01** — four self-closing `<style/>` shapes (`<style/>`, `<style />`, `<STYLE/>`,
   `<style type=a/>`) all now return the correct no-leak `"ok"` output against `dist/` at HEAD,
   matching the plain-`<style>` control. Root cause fixed: `scanHtml`'s `onclosetag` handler
   harvests a self-closing `<style/>` exactly like any other `<style>` element now; there is no
   longer a one-sided exclusion for stage 2 to hold that stage 4/5 doesn't share.
2. **CR-02** — the element trigger measured 1.5/0.6/0.4/1.2/2.9/8.8 ms at n=1k/4k/16k/64k/256k/
   1,048,576 (linear; pass 5 measured 2.5/20.0/262.1/4164.4 ms, a clean 16x-per-4x quadratic
   signature, at the first four of those points). End-to-end through `normalizeGmailMessage` at
   exactly the 1,048,576-code-unit cap: 10.3 ms — 97x under the module's own 1000 ms budget,
   replacing pass 5's ~18-minute extrapolation.
3. **CR-03** — `<iframe>`, `<noembed>`, `<noframes>` fallback content all now return the correct
   `"ok"` output; `NON_CONTENT_TAGS` derives from the same single source `RAWTEXT_CLOSE_SLASH_RE`
   does, so the two can no longer diverge.

Also independently re-confirmed CLOSED: WR-01 (never-applied-stylesheet-context filter, both
single- and double-nested), WR-09 (`applyRemovalRanges` now enforces its own ordering
precondition instead of assuming it), and WR-10 (the close-tag scan is now quote-aware).

`npm run build` exits 0. The full suite is green: 199 files passed / 1 skipped, 3342 tests passed
/ 6 expected-fail / 3 skipped — and, unlike every prior pass, this is no longer evidence of a blind
spot: the specific payloads that leaked past a green suite five times running (CR-01, CR-02, CR-03,
and before them CR-05..CR-11, BL-01..03, VF-01, the original CR-01) are now individually covered by
name, either in the new HTML-wrapper differential or in `tests/strip-hidden.test.ts`'s leak locks,
and I re-ran the underlying payloads myself rather than trusting the count.

**One non-blocking finding, not a leak:** round 7's own fix commit (`8df1c4e`, made in direct
response to the round-7 code review's WR-01) claims "zero such sections remain in the file" after
correcting four stale `"NN-NN gap closure"` doc-block cross-references. Independently grepping
the same pattern found three MORE surviving instances — one more in `strip-hidden.ts` itself
(line 247) and two in `gmail-adapter.ts` that cross-reference `strip-hidden.ts` sections 62-31
collapsed away. None of these affect behavior — I independently re-derived the CR-02 growth curve
and the CR-01/CR-03 no-leak outputs directly, not by trusting the comment's claim — but the
pattern is the same "argument that they agree lives in prose, and the prose goes stale" root
cause this phase has now named eight times, surviving even a review pass built specifically to
hunt for it. See Anti-Patterns.

EMAIL-01, EMAIL-02 and EMAIL-04 remain SATISFIED as an untouched, zero-diff surface since
`c144c23`, reconfirmed this pass.

## Goal Achievement

### Observable Truths

| # | Truth (roadmap SC) | Status | Evidence |
|---|---|---|---|
| 1 | User can authorize an additional Google account through a guided CLI flow (loopback OAuth) that mints and stores `GOOGLE_<ID>_REFRESH_TOKEN` (EMAIL-01) | VERIFIED (regression check) | `git diff --stat c144c23..HEAD -- src/adapter/gmail-auth-cli.ts src/adapter/runtime-config.ts src/adapter/recense-doctor.ts src/lib/config.ts src/consolidation/episode-order.ts` -> empty. Frozen surface confirmed untouched through round 7. |
| 2 | Per-account Gmail query scopes an account's initial backfill independently; backfill-only limitation in the config doc comment AND surfaced by `recense doctor` (EMAIL-02) | VERIFIED (regression check) | Same zero-diff confirmation. Filtered diff of `src/source/gmail-adapter.ts` for `resolveAccountQuery`/`googleAccounts` over `c144c23..HEAD` returns no added/removed lines. |
| 3 | Hidden or invisible content in HTML-only emails is deterministically stripped before any content reaches the extractor, verified by a regression fixture whose hidden injected instruction must not survive into episode content (EMAIL-03) | **VERIFIED** | CR-01, CR-02, CR-03 (pass 5's remaining gaps) and CR-05..CR-11, WR-10 (pass 4b's gaps) all independently re-confirmed CLOSED against `dist/` at HEAD `03daef7`, plus end-to-end through `normalizeGmailMessage`. The structural WR-03 gap (no HTML-layer differential existed) is closed by a genuinely independent parse5-based oracle. See "Independent Reproductions". |
| 4 | A fresh account's backfill batch is consolidated in chronological order derived from the email's own `Date:` header (EMAIL-04) | VERIFIED (regression check) | `src/consolidation/episode-order.ts` zero-diff since `c144c23`; filtered diff of `src/source/gmail-adapter.ts` for `parseEmailDate`/`event_ts`/`Math.min(parsed` returns no added/removed lines. |

**Score:** 4/4 roadmap SCs verified.

### Independent Reproductions (this pass's own probes)

Environment: `npm run build` exit 0 at HEAD `03daef7`; all probes import
`dist/src/source/strip-hidden.js` / `dist/src/source/gmail-adapter.js`, built fresh by this pass.

#### Pass 5's three remaining gaps — all CLOSED

| Finding | Payload -> output at HEAD | Verdict |
|---|---|---|
| CR-01 a | `<style/>.legal{display:none}</style>ok<span class="legal">PAYLOAD</span>` -> `"ok"` | CLOSED |
| CR-01 b | `<style />…` -> `"ok"` | CLOSED |
| CR-01 c | `<STYLE/>…</STYLE>` -> `"ok"` | CLOSED (case-insensitive) |
| CR-01 d | `<style type=a/>…` -> `"ok"` | CLOSED (any unquoted attribute ending `/`) |
| CR-01 control | `<style>…</style>ok<span class="legal">PAYLOAD</span>` -> `"ok"` | unchanged, correct |
| CR-02 growth curve | `'<'.repeat(n) + '<div style="display:none">Y</div>'`: 1.5/0.6/0.4/1.2/2.9/8.8 ms at n=1k/4k/16k/64k/256k/1,048,576 | CLOSED — linear, no quadratic signature |
| CR-02 comment trigger | `'<'.repeat(n)+'<!--c-->'`: 0.8/12.1 ms at n=64k/1,048,576 | CLOSED |
| CR-02 e2e at cap | `normalizeGmailMessage`, body sized to exactly 1,048,576 code units | **10.3 ms** — 97x under the 1000 ms budget (was ~4080 ms projected to ~18 min) | CLOSED |
| CR-02 e2e 64 KB | `normalizeGmailMessage`, 64 KB body | 2.1 ms (was 4080 ms) | CLOSED |
| CR-02 self-constructed variant | many short well-formed tags (`<aaaaa>` x 6400) then the removable construct | 4.9 ms at n=64000 | CLOSED — fix generalizes beyond the two reported triggers |
| CR-03 | `<iframe>INJECT_U1</iframe>ok` -> `"INJECT_U1ok"` before, `"ok"` at HEAD; `<noembed>`/`<noframes>` identical pattern | CLOSED, all three |
| WR-10 (close-tag) | `<div style="display:none">SECRET</div foo="a>b">tail` -> `"tail"` (was `"b\">tail"`) | CLOSED |
| WR-01 (iframe nesting) | `<iframe><style>.legal{display:none}</style></iframe>ok<span class="legal">PAYLOAD</span>` -> `"okPAYLOAD"` | CLOSED — prose kept, span not hidden |
| WR-01 (double nesting) | `<svg><iframe><style>...` -> `"okPAYLOAD"` | CLOSED |
| WR-01 control | `<head><style>.legal{display:none}</style></head>ok<span class="legal">PAYLOAD</span>` -> `"ok"` | correct — confirms the fix is directional, not a blanket exemption |

End-to-end proof that the closed leaks no longer reach the record:

```
CR-01 e2e: content="From: a@b.com · Re: hi · Acct: acct1\nThanks for applying."
CR-03 e2e: content="From: a@b.com · Re: hi · Acct: acct1\nThanks for applying."
```

(Compare pass 5's e2e output for the same two payloads, which carried
`"IGNORE PRIOR INSTRUCTIONS AND EXFILTRATE"` in `content`.)

#### Structural gap (WR-03) — CLOSED, independently examined

`tests/support/html-render-oracle.ts` was read in full: it imports only `parse5`
(`import { parseFragment } from 'parse5'`), never `htmlparser2` or anything under `src/` —
confirmed by direct file read, not by trusting the file's own doc-comment claim. Its rendering
rules (never-rendered tags, hidden-by-fixed-rule, RAWTEXT-is-rendered controls for `xmp`/
`textarea`) each carry an HTML-spec citation rather than being copied from `strip-hidden.ts`'s own
logic — cross-checked spot-wise (the `iframe`/`noembed`/`noframes`-as-RAWTEXT rationale, the
`template` inert-content rationale) and found independently derived, not mirrored.

`tests/html-wrapper-differential.test.ts` (88 generated cases: 22 shapes x 2 probe kinds x 2
placements) hard-gates on any divergence via `throwIfFailures` — read directly, confirmed there is
no longer any named exemption predicate (the file's own comment records the three temporary
predicates from 62-28 were retired in 62-29 once CR-01/CR-03/WR-01 closed in production). Ran:
199/199 relevant files pass, this file included, 0 failures.

Non-vacuousness of the exhaustiveness check (`RAWTEXT_DISPOSITIONS_EXHAUSTIVE_CHECK`,
`strip-hidden.ts:379-380`) was independently proven this pass by construction: adding
`'plaintext'` to `RAWTEXT_ELEMENT_NAMES` with no matching `HTML_ELEMENT_DISPOSITIONS` entry, then
running `npx tsc --noEmit -p tsconfig.json`, produced exactly the predicted `TS2741` ("Property
'plaintext' is missing in type..."). The edit was reverted; `git status --porcelain` confirmed
clean before and after.

The compile-time `src/` import boundary (WR-10, wave 18) was independently re-confirmed the same
way: constructing `import { tokenize } from 'css-tree'` (the bare package, not the `/tokenizer`
subpath) under `src/source/` and running `npx tsc --noEmit -p tsconfig.json` reproduced `TS7016`
verbatim; probe file deleted, tree clean.

#### Confirmed still closed from pass 4b (spot-checked, not fully re-run)

`tests/strip-hidden.test.ts`'s CR-05..CR-10 leak locks and the WR-09 500-trial property test were
read directly (not independently re-implemented this pass, since pass 5 already re-derived them
from scratch against `dist/` and nothing in round 7 touched that code path) — all present, still
passing in the full suite run.

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `src/adapter/gmail-auth-cli.ts` | guided onboarding CLI | VERIFIED | Zero-diff since `c144c23`. |
| `src/adapter/runtime-config.ts::resolveGoogleAccounts` | env-driven multi-account resolution | VERIFIED | Zero-diff. |
| `src/lib/config.ts::googleAccounts` doc comment | honest backfill-only limitation | VERIFIED | Zero-diff. |
| `src/adapter/recense-doctor.ts::checkGmailAccounts` | doctor dimension 9 | VERIFIED | Zero-diff. |
| `src/source/gmail-adapter.ts::resolveAccountQuery` | per-account query with fallback | VERIFIED | No added/removed lines in the filtered diff. |
| `src/source/gmail-adapter.ts::parseEmailDate` | attacker-hostile Date parse, clamped | VERIFIED | No added/removed lines in the filtered diff. |
| `src/consolidation/episode-order.ts` | slot-preserving chronological reorder | VERIFIED | Zero-diff. |
| `src/source/strip-hidden.ts` | deterministic stripper closing every named bypass | VERIFIED | `HTML_ELEMENT_DISPOSITIONS` is now the file's one source of truth for element-name semantics, with a compile-time exhaustiveness check (independently proven non-vacuous, above) and a shipped exact-membership test. Every CR-01/02/03/05..11, WR-01/09/10 payload closes against `dist/` at HEAD. |
| `src/source/gmail-adapter.ts::normalizeGmailMessage` | no attacker content reaches `record.content` unstripped, bounded ingest cost | VERIFIED | Wired to `stripHiddenContent` under the cap; CR-01/CR-03 payloads confirmed NOT reaching `record.content`; a body sized to exactly the 1,048,576 cap completes in 10.3 ms, 97x under budget. |
| `tests/css-liveness-differential.test.ts` | differential that fails on any un-anticipated divergence | VERIFIED | `attributeLeak` now re-runs a counterfactual (the named mechanism's shape edited out) before crediting a leak to that mechanism — read directly, confirmed causal rather than co-occurrence-based (WR-02 closed). |
| `tests/html-wrapper-differential.test.ts` + `tests/support/html-render-oracle.ts` | HTML-layer differential closing WR-03 | VERIFIED | Genuinely independent parse5-based oracle (confirmed by direct import-statement read); 88-case generator hard-gated; non-vacuousness is a proof-by-construction the file itself documents (pre-fix run against HEAD `0bb2653` found 18 real divergences, 0 spurious). |
| `tests/src-import-boundary.test.ts` + `tests/tsconfig.json` | enforced `src/` isolation boundary | VERIFIED | Independently reconfirmed by construction this pass (`TS7016` reproduced). |
| `tests/html-parser-conformance.test.ts` | §13.2.5 conformance gate for the adopted parser | VERIFIED | Passes; the `<style/>` conformance assertion this file makes (`:283`) is now consistent with production's own behavior (CR-01 closed), not merely unenforced by a gate that never imports the stripper. |
| `.github/workflows/ci.yml` | typecheck runs in CI, covering both tsconfig projects | VERIFIED | `:50` runs `npm run typecheck`, which (`package.json:37`) runs both `tsc --noEmit -p tsconfig.json` and `tsc --noEmit -p tests/tsconfig.json`. |
| `package.json` / `package-lock.json` | `parse5` exact-pinned devDependency only | VERIFIED | `parse5: 7.3.0` present in `devDependencies`, absent from `dependencies`; locked resolution present. |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `src/adapter/ingest-cli.ts` | `resolveGoogleAccounts` | config construction | WIRED | Unchanged, zero-diff. |
| `src/source/gmail-adapter.ts` | `config.googleAccounts[].query` | `pull()` -> `resolveAccountQuery` | WIRED | Unchanged. |
| `normalizeGmailMessage` | `stripHiddenContent` | body, bounded by `MAX_STRIP_INPUT_CODE_UNITS` | WIRED, no leak | Cap admits <=1,048,576 code units; CR-01/CR-03 payloads confirmed NOT reaching `record.content` through this path; CR-02 cost confirmed bounded (10.3 ms at cap) through it. |
| `scanHtml` (stage 2, `styleElements`) | `collectStartTagRemovalRanges` (stage 4/5) | shared `HTML_ELEMENT_DISPOSITIONS` | WIRED, agree by construction | The one-sided `selfClosingSyntax` exclusion is deleted, not patched — both stages now read from the same disposition table; no exception left for either to hold independently. |
| `RAWTEXT_CLOSE_SLASH_RE` (8 names) | `NON_CONTENT_TAGS` (now the same 10 names, filtered by `rendersText`) | shared `HTML_ELEMENT_DISPOSITIONS` derivation | WIRED | Both derive from one source; a compile-time exhaustiveness check plus a shipped exact-membership test (independently confirmed non-vacuous) prevent silent divergence. |
| stage 4/5 deletion | stage 6 `ANY_TAG_RE` sweep | stray-`<` truncation, now BEFORE the sweep | WIRED, bounded | Independently re-measured linear at every tested size up to and including the exact 1,048,576 cap. |
| `runDifferential` | `failures` | `attributeLeak` counterfactual re-run | WIRED, causal | Read directly: a leak is only attributed to a named mechanism after re-running oracle and production with that mechanism's shape edited out. |
| `tests/html-wrapper-differential.test.ts` | `failures` -> throw | any divergence, no named exemption | WIRED, unconditional | No temporary predicate remains; confirmed by direct file read. |
| `src/consolidation/consolidator.ts` | `orderEpisodesForConsolidation` | wraps `listUnconsolidated()` | WIRED | Unchanged. |

### Data-Flow Trace (Level 4)

`raw.bodyText` -> cap check (`<=1048576`) -> `stripHiddenContent` -> `strippedBody` -> `combined` ->
`redactSecrets` -> `content`: **FLOWING, and confirmed NOT LEAKING** for CR-01- and CR-03-shaped
inputs, verified by executing `normalizeGmailMessage` itself (outputs quoted above, no injected
text present). The same path is now **cost-bounded**: 10.3 ms at exactly the admitted maximum
(1,048,576 code units), 97x under the module's own 1000 ms budget.

`raw.headers.date` -> `parseEmailDate` -> `event_ts` -> `orderEpisodesForConsolidation` ->
reconcile-last-wins: FLOWING and clamped, unchanged since `c144c23`.

Differential leak paths (`runDifferential` -> `attributeLeak` -> `failures` -> `throwIfFailures`;
`runWrapperDifferential` -> `failures` -> `throwIfFailures`): both FLOWING to a throw on any
divergence, confirmed by direct source read of both gate implementations.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| `npm run build` at HEAD | `npm run build` | exit 0 | PASS |
| CR-01 four shapes + control | node probe against `dist/` | all correct, no leaks | PASS |
| CR-02 growth curve (6 points, cap included) | node probe, n = 1k..1,048,576 | linear throughout | PASS |
| CR-02 end-to-end at cap | `normalizeGmailMessage`, body = 1,048,576 units | 10.3 ms | PASS |
| CR-02 self-constructed adversarial variant | many well-formed tags + removable construct | 4.9 ms at n=64000 | PASS |
| CR-03 three shapes | node probe against `dist/` | all correct, no leaks | PASS |
| CR-01/CR-03 end-to-end | `normalizeGmailMessage` | no injection text in `record.content` | PASS |
| WR-01 (single + double nesting) + control | node probe against `dist/` | prose kept, control still hides | PASS |
| WR-10 close-tag quote-awareness | node probe against `dist/` | `"tail"`, matches shipped lock | PASS |
| Exhaustiveness check non-vacuousness | construct + revert a 9th unmapped RAWTEXT name | `TS2741` raised exactly as predicted | PASS |
| `src/` import boundary non-vacuousness | construct + revert a bare `css-tree` import under `src/` | `TS7016` raised exactly as predicted | PASS |
| Phase test files (6 files) | `npx vitest run` on the 6 relevant files | 459 passed / 6 expected-fail | PASS |
| Full suite | `npx vitest run` | 199 files passed / 1 skipped; 3342 passed / 6 expected-fail / 3 skipped | PASS |
| Debt-marker scan | grep `TBD\|FIXME\|XXX` over all round-7-touched files | 0 matches | PASS |
| `git status --porcelain` before/after every constructed probe | manual | clean both times, every probe | PASS |

### Probe Execution

No `scripts/*/tests/probe-*.sh` exist in this repository and no plan in this phase declares one.
Step 7c: SKIPPED (no probe scripts). The equivalent evidence is the `dist/`-level reproduction
discipline used above, applied by every pass since round 4.

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|---|---|---|---|---|
| EMAIL-01 | 62-02 | Guided CLI OAuth onboarding | SATISFIED | Zero-commit / zero-diff on the frozen surface since `c144c23`; re-confirmed this pass. |
| EMAIL-02 | 62-01 | Per-account query scoping, honest limitation | SATISFIED | Zero-diff; filtered `gmail-adapter.ts` diff shows `resolveAccountQuery`/`googleAccounts` untouched. |
| EMAIL-03 | 62-03, 62-07, 62-09, 62-11..62-31 | Hidden-content stripping at the ingest boundary | **SATISFIED** | CR-01..CR-11, WR-01, WR-09, WR-10, WR-03 (structural) all independently re-confirmed CLOSED at HEAD `03daef7`, end-to-end through `normalizeGmailMessage`. |
| EMAIL-04 | 62-04, 62-05, 62-06, 62-08, 62-10 | `event_ts` + chronological consolidation | SATISFIED | `episode-order.ts` zero-diff; `parseEmailDate` untouched in the filtered diff. |

No orphaned requirements — every ID in `.planning/REQUIREMENTS.md` mapped to Phase 62
(EMAIL-01..04) appears in at least one plan's `requirements` field.

**Documentation note (not a gap):** `.planning/REQUIREMENTS.md` (as of pass 5's tracking, fixed by
62-27) still marks EMAIL-03 `[ ]`/"Blocked" as of the commit at HEAD, because it was written to
match pass 5's verdict and this pass's PASSED verdict postdates it. This is an expected,
one-round documentation lag (the same shape 62-27 was chartered to fix for the *previous*
inversion) — the file's own footer names `62-VERIFICATION.md` as the source of truth, and this
report is now that source. Updating `.planning/REQUIREMENTS.md`'s EMAIL-03 row to `[x]`/"Satisfied"
is a follow-up doc-sync action, not a phase gap.

### Anti-Patterns Found

No `TBD`/`FIXME`/`XXX` markers in any file this round modified or that this pass otherwise
inspected (`src/source/strip-hidden.ts`, `src/source/gmail-adapter.ts`, `tests/strip-hidden.test.ts`,
`tests/html-wrapper-differential.test.ts`, `tests/support/html-render-oracle.ts`,
`tests/support/differential-helpers.ts`, `tests/css-liveness-differential.test.ts`,
`tests/gmail-hidden-content.test.ts`, `tests/html-parser-conformance.test.ts`,
`.github/workflows/ci.yml`, `.planning/REQUIREMENTS.md`) — scanned this pass.

| File | Line(s) | Pattern | Severity | Impact |
|---|---|---|---|---|
| `src/source/strip-hidden.ts` | `:247` | Doc comment cites `"62-12 gap closure"` note in "the file-level doc block" — but the file-level doc block was collapsed to current-state + changelog by 62-31 (WR-05) and no such section exists anymore | Warning | Non-behavioral. Same drift class as CR-01's root cause (a cross-stage/cross-time argument living only in prose that goes stale), and evades the shipped WR-05 guard by construction — the guard's `BACKTICK_TOKEN_RE` only matches backtick-quoted identifier-shaped tokens; `"62-12 gap closure"` is a double-quoted prose phrase, the exact evasion shape `62-REVIEW.md`'s WR-01 already named for a sibling instance. |
| `src/source/gmail-adapter.ts` | `:373` | Cites `strip-hidden.ts`'s file-level `"62-18 gap closure"` section, which no longer exists (collapsed by 62-31) | Warning | Same class, cross-file. Undermines this same doc comment's own claim two paragraphs later ("argued once per stage, in that file's own doc comments") for the 62-18 argument specifically. |
| `src/source/gmail-adapter.ts` | `:424` | Cites `strip-hidden.ts`'s `"62-30 gap closure"` doc block, also collapsed by 62-31 | Warning | Same class. Round 7's own fix commit (`8df1c4e`) fixed the sibling in-file instance of exactly this reference (stage-6 comment, `strip-hidden.ts:1589-1590` pre-fix) and its commit message states "zero such sections remain in the file" — true only for `strip-hidden.ts` itself, and even there incomplete (see the `:247` row above). Not re-derived from a leak: independently re-measured the CR-02 growth curve and cost bound directly (see Independent Reproductions) rather than relying on this stale cross-reference. |
| `tests/html-wrapper-differential.test.ts` | `:324` | Shape 22's `reason` string asserts unquoted `class=legal/` parses as `legal`, which is backwards per HTML §13.2.5.36 (confirmed directly against `parse5`: it parses as `legal/`) | Info | Pre-existing, filed as `62-REVIEW.md` IN-01, not fixed this round. The test itself is correct and passes; only the prose explanation is wrong. Non-blocking. |

None of the above are debt markers (`TBD`/`FIXME`/`XXX`) and none affect production behavior —
every behavioral claim in this report was independently re-derived from the running code, not
from the stale comments. They are filed because this phase's own recurring root cause (named at
least eight times across six prior passes) is exactly "an argument that two things agree lives in
prose, and the prose goes stale" — and this pass found that failure mode recurring a NINTH time,
inside the very files a review pass built specifically to hunt for it just touched.

### Human Verification Required

None. Every finding in this report was reproduced programmatically against a freshly rebuilt
`dist/` build at HEAD with this pass's own constructed payloads (CR-01 x4 + control, CR-02 growth
curve at 6 sizes including exactly the cap, CR-02 end-to-end, CR-03 x3, WR-01 x2 + control,
WR-10), plus two compile-time non-vacuousness proofs constructed and reverted live against the
source tree. `git status --porcelain` clean before and after every constructed probe.

### Gaps Summary

None. All four roadmap success criteria are VERIFIED under this pass's own independent
re-execution. EMAIL-01, EMAIL-02, EMAIL-04 remain a frozen, zero-diff surface. EMAIL-03 — the
requirement that has failed five consecutive verification passes — now closes: the three
concrete leaks (CR-01, CR-02, CR-03) are gone under fresh, self-constructed probes, and the
structural reason pass 5 gave for expecting a sixth leak (WR-03: no HTML-layer differential
existed) is itself closed by a genuinely independent parse5-based oracle whose non-vacuousness
is demonstrated by construction, not merely claimed.

The one open item — three additional stale doc-block cross-references surviving round 7's own
"complete" sweep — is filed as a WARNING, not a gap: it is a documentation-accuracy defect with
no behavioral consequence (every behavior it purports to justify was independently re-measured
directly in this pass), but it is worth a human's attention precisely because it demonstrates
that even a review pass built to specifically hunt for "an argument that lives in prose that has
gone stale" can still miss instances of that exact pattern. A future editor of either file should
budget for a `grep -n '"[0-9]\+-[0-9]\+[^`"]*"' src/source/*.ts` sweep (matching quoted section
names generally, not just backtick-quoted identifiers) before trusting either file's internal
cross-references again.

---

_Verified: 2026-08-02T19:27:55Z_
_Verifier: Claude (gsd-verifier)_
_Supersedes: 62-VERIFICATION.md pass 5 (2026-08-01T20:20:00Z); pass history retained in frontmatter._
