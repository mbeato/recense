---
phase: 62-multi-inbox-email-ingest-hardening
plan: 19
subsystem: testing
tags: [css-tree, css-syntax-level-3, tokenizer, security-oracle, differential-testing, email-ingest, prompt-injection, wr-09]

# Dependency graph
requires:
  - phase: 62-multi-inbox-email-ingest-hardening (plans 16-18)
    provides: "css-tree@3.2.1 tokenizer + test-only liveness oracle (62-16), the token-stream
      CSS harvest replacing the hand-rolled scanner (62-17), and the linear <style>-boundary
      walk eliminating the module's last quadratic (62-18)"
provides:
  - "An oracle-driven, both-directions differential (tests/css-liveness-differential.test.ts)
    with exhaustive token-boundary adjacency at k=2 (44x44 cross product) and >=25,000
    seeded/structured inputs, judged against a conformant CSS engine independent of
    recense's own code -- the missing ingredient WR-09 named"
  - "The three WR-09 test-design gaps closed in the shipped oracles: DECOY_FRAGMENTS can now
    construct a non-boundary url( adjacency (gap 1); the differential's structural limit is
    documented (gap 2); the deterministic fuzz test asserts hidden-content leakage, not just
    totality (gap 3)"
  - "Five previously-undiscovered defects (NF-01 through NF-05, REG-01) found live by these
    oracles, each locked as a named, dedicated it.fails minimal reproduction -- none fixed in
    this wave (test-only scope)"
  - "A complete divergence disposition table against the pre-wave-12 baseline (06fdebd): 12
    distinct classes, 11 IMPROVEMENT, 1 REGRESSION (safe-direction only, never a leak), zero
    silently absorbed"
  - "The phase's residual register: every open limitation named with its current status"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Accepted-divergence allowlist (AD-*) vs newly-filed-defect buckets (NF-*): both are
      named, predicate-checked, magnitude-bounded counters, but AD-* means 'both sides
      already agree, counted for coverage' while NF-* means 'a confirmed open defect,
      counted so a magnitude change fails loudly, separately locked by its own it.fails
      reproduction' -- never a blanket tolerance for either."
    - "Delimiter-bounded payload markers (PL[name]/PLID[name]) in generated-corpus
      differentials, closing a self-inflicted false-positive class where one probe name is a
      literal prefix of another (e.g. 'legal' vs 'legalid')."

key-files:
  created:
    - tests/css-liveness-differential.test.ts
  modified:
    - tests/strip-hidden.test.ts

key-decisions:
  - "Newly-discovered defects (NF-01..05, REG-01) are documented and locked as it.fails
    reproductions, NOT fixed in this plan -- files_modified scopes 62-19 to tests only, and
    every one of them requires touching src/source/strip-hidden.ts's harvest logic, which is
    a separate, dedicated gap-closure decision, not a same-wave patch."
  - "The fuzz test's WR-09 gap-3 leak check excludes inputs whose garbage embeds a literal
    <style>/<script>/</style>/</script> fragment (an orthogonal, already-tested HTML
    raw-text-boundary property) and unmatched-CDO inputs (the already-locked NF-01
    mechanism), so the check stays focused on CSS-token-level adjacency -- the property
    gap 3 is actually about -- rather than reproducing HTML-tag-matching noise at ~95% of
    the corpus."
  - "REG-01 is dispositioned REGRESSION, not ACCEPTED WIDENING, per the plan's own strict
    rubric (it disagrees with the oracle where baseline agreed) even though its direction is
    always safe (over-strip, never a leak) -- the plan explicitly forbids inventing a fourth,
    softer bucket for a divergence that doesn't cleanly fit ACCEPTED WIDENING's definition."

patterns-established:
  - "A scratch differential harness against a real historical baseline (git worktree, not a
    manual reconstruction) is the right tool for 'did the blast radius match what was
    claimed,' complementing (not replacing) an oracle-driven differential, which answers
    'is any of this actually correct.'"

requirements-completed: [EMAIL-03]

# Metrics
duration: 44min
completed: 2026-07-31
---

# Phase 62 Plan 19: WR-09 Closure — Oracle-Driven Differential + Divergence Triage Summary

**Built the oracle-driven, both-directions CSS liveness differential WR-09 required (exhaustive k=2 token-boundary adjacency plus 25,000+ seeded/structured inputs against a conformant CSS engine), closed the three test-design gaps in the existing shipped oracles, and ran a full divergence triage against the pre-wave-12 baseline — finding five new defects (all safe-direction, all locked, none fixed this wave) and confirming the tokenizer swap's blast radius is exactly what waves 16-18 claimed, plus one previously unclaimed regression.**

## Performance

- **Duration:** 44 min
- **Started:** 2026-07-31T17:24:00Z (approx.)
- **Completed:** 2026-07-31T18:08:00Z (approx.)
- **Tasks:** 3 (all auto)
- **Files modified:** 2 (1 created, 1 modified)

## Accomplishments

- `tests/css-liveness-differential.test.ts` — a 500+ line oracle-driven differential with
  three generators: an exhaustive 44x44 token-boundary-adjacency cross product (k=2, no
  sampling), >=20,000 seeded k=3..6 inputs, and >=5,000 structured whole-rule stylesheets —
  all judged in both directions against `liveHidingSelectors` (62-16), not against a second
  copy of recense's own code. `TOKEN_ALPHABET` is derived from `css-tree/tokenizer`'s own
  type list (25 of 26 named types reachable; EOF is structurally unreachable via the
  callback API) and asserted so by a coverage test, not just claimed in prose.
- Found and locked **five previously-undiscovered defects** — see the dedicated section
  below. This is the payoff WR-09's closure was chartered to produce: a tokenizer swap that
  didn't also fix the oracle would ship bypass number seven; the fixed oracle found four new
  ones on its own and a fifth via the baseline triage.
- All three WR-09 test-design gaps closed in the existing shipped oracles (not the
  differential, which is new code): `DECOY_FRAGMENTS` extended with four fragments placing
  `url(` after a non-boundary context (each cross-checked against `liveHidingSelectors`
  before being added); the differential's structural limit documented in the fuzz-test
  block; the fuzz test now asserts hidden-content leakage via a fourth named failure list.
- A complete divergence disposition table against baseline commit `06fdebd` (pre-wave-12):
  ~9,000-input shared corpus, 257 total divergent outputs collapsing to 12 distinct classes,
  11 confirmed IMPROVEMENT (matches the oracle where baseline didn't) and 1 REGRESSION
  (safe-direction only, never a leak — locked, not fixed).
- Full suite green at close: 3206 passed / 5 expected-fail / 3 skipped (up from the
  3202/3/3-skip baseline this plan started from); `tsc --noEmit` clean; `npm run build`
  succeeds; frozen surface unchanged (0 commits over the five frozen paths since `0ef9b5a6`);
  every historical repro re-reproduced against the built `dist/`.

## Task Commits

1. **Task 1: Oracle-driven both-directions differential with exhaustive token-boundary
   adjacency** — `d71aa0a` (test)
2. **Task 2: Close the three WR-09 gaps in the existing shipped oracles** — `9e03ffb` (test)
3. **Task 3: Divergence triage — enumerate and disposition every behavior change since the
   pre-wave-12 baseline** — `b3570d3` (test)

**Plan metadata:** (this commit) `docs(62-19): complete WR-09 closure + divergence triage plan`

## Files Created/Modified

- `tests/css-liveness-differential.test.ts` (new) — the oracle-driven differential:
  `TOKEN_ALPHABET` (44 entries, coverage-tested against `css-tree/tokenizer`'s type list),
  the accepted-divergence allowlist (`AD01`-`AD04`), the newly-filed-defect counters
  (`NF01_cdoTruncation`, `NFDANGER_leak`, `NFSAFE_overStrip`), three generators, and a
  dedicated "newly discovered defects" describe block with four `it.fails` locked repros
  (NF-01, NF-03, NF-04, NF-05).
- `tests/strip-hidden.test.ts` — `DECOY_FRAGMENTS` extended (WR-09 gap 1, 4 new fragments +
  audit comment); the fuzz-test block's doc comment records the differential's structural
  limit (WR-09 gap 2); the fuzz test itself extended with a fourth `leakFailures` list plus
  style/script-fragment and unmatched-CDO exclusion counters (WR-09 gap 3); a new
  "62-19 Task 3 divergence triage" describe block locking REG-01 as an `it.fails` minimal
  repro.

## Decisions Made

- **Newly-filed defects are documented and locked, not fixed, in this plan.** Every one of
  NF-01..05 and REG-01 requires a change to `src/source/strip-hidden.ts`'s CSS harvest
  logic — outside this plan's `files_modified` (tests only) and, for at least NF-01/REG-01,
  requiring careful design to avoid reopening the exact FB-01/CR-04 tradeoff 62-17 made
  deliberately. Each is named, reproducible, and reported here for a follow-up plan to pick
  up — the same pattern 62-16 used for the two escaped-selector leaks it found (closed one
  wave later by 62-17), not a new departure.
- **The fuzz test's leak check excludes style/script-fragment-containing inputs and
  unmatched-CDO inputs**, both counted and magnitude-bounded rather than silently dropped.
  Without this, ~95% of the 2000-iteration corpus routed through an already-known,
  already-locked mechanism (NF-01, or the orthogonal HTML-raw-text-boundary property already
  covered by BL-01/BL-02/NEW-01 and Task 1's own generators), muddying the CSS-adjacency
  signal gap 3 actually targets.
- **REG-01 is dispositioned REGRESSION, not ACCEPTED WIDENING**, per the plan's own rubric,
  even though it is always safe-direction (over-strip, never a leak). ACCEPTED WIDENING
  requires "does not contradict the oracle"; REG-01 does contradict it (oracle says NOT
  live, current strips anyway) on an input baseline agreed with the oracle on. The plan
  explicitly forbids inventing a softer fourth bucket for this shape of finding.
- **Delimiter-bounded probe markers** (`PL[name]`/`PLID[name]`, not `PL_${name}`) in the
  differential — found and fixed a self-inflicted false-positive class mid-execution where
  `PL_legal` is a literal substring of `PL_legalid`, producing thousands of phantom
  "divergences" that were purely a test-harness bug, not production defects. Documented
  in-line as a residual risk anyone extending this pattern must watch for.

## Newly Discovered Defects (found live by this plan's own oracles, not fixed here)

Per this plan's own explicit instruction ("do NOT widen the allowlist to make the suite
green... mark the case as a documented expected-failure naming the finding, and report it —
the whole purpose of this plan is to find exactly that"), every defect below is locked as an
`it.fails` reproduction in the shipped test suite, not silently absorbed.

| ID | Mechanism | Direction | Severity | Minimal repro | Locked in |
|----|-----------|-----------|----------|----------------|-----------|
| NF-01 | An unmatched CDO (`<!--` with no later `-->` anywhere in the document) inside a `<style>` block trips stage 3's unterminated-HTML-comment fail-safe, which truncates the ENTIRE rest of the document — including the real `</style>` tag and every visible sentence after it — because stage 3 does not respect the RAWTEXT boundary of a `<style>`/`<script>`/etc. element. | Availability (total content loss) | **High** — a single stray, spec-legal CDO token (the historic "SGML comment hack") can silently delete an entire message's visible prose, not just the CSS. | `<style><!--.legal{display:none}</style>VISIBLE_SENTENCE<span class="legal">PAYLOAD</span>` → `out === ""` | `tests/css-liveness-differential.test.ts` |
| NF-03 | A comma-separated selector list is rejected all-or-nothing (`preludeToBareSelectors` returns `null` for the WHOLE prelude if ANY comma-separated group fails the bare-selector shape check) rather than per-selector, the way a real browser evaluates each entry in the list independently. | Under-strip (leak) | **Medium** — lets a bare hiding selector hide behind any non-bare sibling in the same comma list, e.g. `a, .legal { display:none }`. | `<style>a,.legal{display:none}</style>VISIBLE_SENTENCE<span class="legal">PAYLOAD</span>` → `PAYLOAD` leaks | `tests/css-liveness-differential.test.ts` |
| NF-04 | A blockless at-rule (`@media;`, terminated by `;` with no `{`) misattributes the NEXT rule's `{`/`}` block as its own (bogus) block, because `startsWithAtKeyword` only looks at whether the pending prelude starts with an `AtKeyword` at the next `{`, never accounting for an intervening `;` that should have already closed the at-rule. | Under-strip (leak) | **Medium** — the real, independent rule after the `;` is silently dropped from the harvest. | `<style>@media;.legal{display:none}</style>VISIBLE_SENTENCE<span class="legal">PAYLOAD</span>` → `PAYLOAD` leaks | `tests/css-liveness-differential.test.ts` |
| NF-05 | CDO/CDC tokens are not treated as ignorable at the stylesheet top level (CSS Syntax Level 3 §5.4.1: "If the top-level flag is set, do nothing"); `harvestFromStylesheet` pushes a lone `-->` into the pending prelude like any other token, poisoning the shape match for the rule that follows. | Under-strip (leak) | **Medium** — a stray `-->` (matched or unmatched) before a hiding rule causes that rule to be silently dropped. | `<style>-->.legal{display:none}</style>VISIBLE_SENTENCE<span class="legal">PAYLOAD</span>` → `PAYLOAD` leaks | `tests/css-liveness-differential.test.ts` |
| REG-01 | An unclosed `Function`/`Url` token (no matching `)` anywhere in the stylesheet) followed by one intermediate, fully-matched `{}`-pair "resets" `harvestFromStylesheet`'s frame-stack walk to depth 0 after that pair closes, so a REAL rule appearing after it is treated as a fresh top-level rule — even though a conformant parser still considers everything from the unclosed paren to EOF swallowed inside that one unterminated function call's argument list (CSS Syntax §5.4.9). | Over-strip (safe) | **Low** — never a leak; the predictable flip side of 62-17's deliberate choice not to track paren/function nesting (the fix for FB-01/CR-04). | `<style>f(#a{color:red}.legal{display:none}</style>ok<span class="legal">PAYLOAD</span>` → `PAYLOAD` stripped when the oracle says it shouldn't be | `tests/strip-hidden.test.ts` |

NF-01/NF-03/NF-04/NF-05 were found by Task 1's generators (magnitude across all three
generators combined: NF-01 fired on 2,414 of ~27,000 generated documents; the leak-direction
mechanisms NF-03/04/05 combined fired 423 times; all bounded, none silenced — see
`tests/css-liveness-differential.test.ts`'s own `NewlyFiledCounters` magnitude assertions).
REG-01 was found by Task 3's baseline differential and additionally exercised (0 occurrences,
by design — the fuzz test's alphabet doesn't construct an unclosed-Function-plus-intermediate-
brace-pair shape) by the fuzz test's own corpus.

## Divergence Disposition Table (Task 3, baseline `06fdebd` vs current)

Scratch differential (not shipped): loaded the baseline module from a `git worktree` checkout
of `06fdebd` alongside the current module, ran both over a ~9,000-input shared corpus
(`IDEMPOTENCE_FIXTURES`, `BYPASS_CORPUS` bodyText literals, 2,000 ground-truth-generator
inputs, 2,000 fuzz-test inputs, Task 1's Generator 1 in full plus 3,000 of Generator 2, and
the 25 62-18 cost shapes truncated to 4,096 bytes for speed, not timing). 257 divergent
outputs collapsed to **12 distinct classes** by output-pair signature.

| Class | Minimal reproducing input | Baseline output | Current output | Oracle verdict | Disposition |
|-------|---------------------------|------------------|-----------------|-----------------|--------------|
| 1-2 | `<style>.leg\61 l{display:none}</style>ok<span class="legal">PAYLOAD_ESC1</span>` (and the `#leg\61 l`/id-form twin) | `PAYLOAD_ESC1` present (leak) | `PAYLOAD_ESC1` absent | `classes` has `legal` (live) | **IMPROVEMENT** — the two 62-17-closed escaped-selector leaks, independently reconfirmed |
| 3-4 | Same two shapes, via `BYPASS_CORPUS` bodyText literals | leak present | leak absent | live | **IMPROVEMENT** (duplicate confirmation via the shipped corpus) |
| 5 | Ground-truth-generator input containing `xurl(a).gd13{color:cyan}` adjacent to the planted `.legal{display:none}` rule | `PAYLOAD_GEN` present (leak) | `PAYLOAD_GEN` absent | live | **IMPROVEMENT** — the WR-09-gap-1 `xurl(` decoy fragment reproduces a real baseline defect the new tokenizer closes |
| 6 | `/*c*/{.legal{display:none}` | strips `legal` (over-strip) | keeps `legal` present | NOT live (`classes=[]`) | **IMPROVEMENT** — current agrees with the oracle; baseline over-stripped |
| 7-11 | Five `Generator 2`-found shapes combining `#h`/`#legalid`/junk tokens before `.legal{...}` in various orders | baseline disagrees with the oracle on at least one probe in each (mix of over- and under-strip relative to the oracle) | current matches the oracle exactly on all probes in every one of these five | varies per input (see `tests/css-liveness-differential.test.ts`'s own generator for the exact verdicts) | **IMPROVEMENT** (all five) — current's token-shape harvest agrees with a conformant parser strictly more often than baseline's regex-based harvest |
| 12 | `xurl(.,1pxxurl(#legalid{display:none}/*c*/.legal{display:none}` (minimal: `f(#a{color:red}.legal{display:none}`) | keeps `legal` present (matches oracle: NOT live) | strips `legal` (disagrees with oracle) | NOT live (`classes=[]`) | **REGRESSION** — this is REG-01, above. Safe-direction only, never a leak; locked, not fixed this wave. |

**Zero rows dispositioned REGRESSION-but-accepted-anyway** — REG-01 is reported honestly per
the plan's own rubric, not softened into ACCEPTED WIDENING. Zero rows fit none of the three
buckets (every divergence found traces to one of the twelve classes above).

## Residual Register (every open limitation, current status)

| Limitation | Status |
|---|---|
| (a) White-text-on-white-background hiding | Open, out of scope (deliberate — a color-only heuristic would regress legitimate dark-mode prose) |
| (b) Hiding via an externally-linked stylesheet | Open, out of scope (deliberate — recense never fetches remote resources) |
| (c) Unbalanced quotes inside a tag causing the stage-6 fail-safe to over-truncate | Open, accepted (narrowed by 62-12; only unbalanced-quote trigger remains) |
| (d) `@media`/`@supports` conditions not evaluated (harvests unconditionally) | Open, accepted, unchanged by this plan — confirmed via `AD-01` coverage: every `@media`-containing input in this plan's generators produced agreement between the oracle and production, not a new divergence |
| (e) Unrestricted-hash (`#1abc`-shaped) ids harvested regardless of CSS `id`-vs-`unrestricted` distinction | Open, accepted, unchanged — confirmed via `AD-02` coverage in this plan's Generator 3: the oracle's own parser ALSO treats `#<unrestricted-hash>` as a valid `IdSelector`, so this is agreement, not a divergence at all (matches 62-17's own finding that this residual predates the tokenizer swap) |
| NF-01 (unmatched CDO → total content loss) | **Open, newly found this plan, not fixed** — see table above |
| NF-03 (comma-list all-or-nothing rejection) | **Open, newly found this plan, not fixed** — see table above |
| NF-04 (blockless at-rule misattribution) | **Open, newly found this plan, not fixed** — see table above |
| NF-05 (CDO/CDC not ignored at stylesheet top level) | **Open, newly found this plan, not fixed** — see table above |
| REG-01 (unclosed Function/Url + intermediate brace pair over-strip) | **Open, newly found this plan, not fixed** — see table above |
| WR-01 (MSO conditional comments) | Still open and out of scope, as before this plan. Measured, not assumed: none of `IDEMPOTENCE_FIXTURES`, `BYPASS_CORPUS`, or this plan's three generators construct an MSO-conditional-comment shape (`<!--[if mso]>`), so the tokenizer swap's effect on WR-01 specifically was not exercised by this plan's corpus either way — recorded as "not measured by this plan," not "confirmed unchanged." No work scoped toward it. |
| WR-08 (` · ` provenance-delimiter forgery) | Deferred to Phase 65 DRIFT-03, unchanged by this plan |
| T-62-54/T62-91 (STYLE_BLOCK_RE quadratic) | Closed by 62-18 (verified again in this plan's Task 3 corpus: no timing regression measured at the small sizes used, consistent with 62-18's own claim) |
| WR-03 (`<style/>` self-closing cross-stage disagreement) | Still open, untouched by this plan, as scoped by 62-18 |
| The liveness oracle's own blind spots (T-62-16-02, T-62-19-01) | Unresolved: the oracle's PARSE and selector-validity layers are not cross-checked against a second independent CSS implementation (postcss disqualified, 62-16); the oracle SHARES the tokenizer with production, so a tokenizer defect would be invisible to every test in this plan by construction — mitigated only by `tests/css-tokenizer-conformance.test.ts`'s independent §4.3 gate, not eliminated |
| This plan's own NF-danger/NF-safe bucketing (see `css-liveness-differential.test.ts`'s own header doc comment) | A sampling-based, not exhaustive-structural, classification — a sample from every bucket in every generator was manually traced and confirmed to match one of the four named NF mechanisms with zero unexplained outliers, but a hypothetical sixth mechanism could in principle hide inside a bounded bucket's count without tripping the magnitude assertion. Named explicitly rather than silently assumed complete. |

## What The New Oracle Still Cannot Detect (plain statement, per this plan's own output requirement)

The differential CAN detect a divergence between recense's harvest and a conformant CSS
engine's verdict on any input its three generators can construct — and DID, five times,
none of which any prior wave's case-driven oracle had a chance of finding, because none of
NF-01/03/04/05/REG-01 involve a `url(`/comment/escape shape at all. It CANNOT detect a
defect the judge SHARES with production: both ultimately read the same `css-tree/tokenizer`
token stream, and the oracle's parse/selector-validity layer is independently gated against
§4.3 (the tokenizer half) but not cross-checked against a second independent CSS
implementation (the parser half) — postcss was disqualified during 62-16 planning as wrong
on its own terms. This is not a hedge added after the fact: it is the same residual 62-16
named for its own oracle, inherited here because this differential is built on the same
`liveHidingSelectors` function.

**If the oracle had found nothing outside the allowlist, that would have been weak evidence,
not strong** — the previous three waves (62-13's differential, 62-14's fuzz test, the
ground-truth generator itself) each ran large corpora and found nothing wrong for reasons
that were structural (drawn from the same case enumeration they validated), not
reassuring. This plan's oracle is different in kind, not just in scale, and it found five
real things. That is the intended reading of this result: the fix worked, and it is
reporting real, if mostly safe-direction, residual defects rather than a clean bill of
health that would have been suspicious given the history.

## Issues Encountered

- **A self-inflicted false-positive class in the differential's own probe-marker scheme**
  (found and fixed during Task 1, before the first real run): using `PL_${name}`/
  `PLID_${name}` as payload markers made `PL_legal` a literal substring of `PL_legalid`,
  producing thousands of phantom "divergences" purely from string-matching, not from
  production behavior. Fixed by switching to delimiter-bounded markers (`PL[name]`/
  `PLID[name]`) before any real triage was done against the noisy signal.
- **The WR-09 gap-3 fuzz-test extension initially flagged ~2,000/2,000 iterations as
  "leaking"** when directly reusing the existing chaotic HTML-tag-fragment alphabet with a
  naive "wrap `s` + a fixed rule in one clean `<style>` block" ground-truth model. Root-caused
  to two separate effects (NF-01's already-known CDO mechanism, plus embedded literal
  `</style` fragments in `s` legitimately and correctly ending the wrapper's OWN `<style>`
  element per HTML raw-text rules, making the naive ground-truth model simply wrong for those
  inputs). Resolved by excluding style/script-fragment-containing and unmatched-CDO inputs
  from the check (counted, magnitude-bounded), which is what let the ONE genuine remaining
  divergence (an over-strip-direction case, subsequently relaxed out of the failure condition
  since over-strip is the module's own documented safe direction) surface cleanly.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- **v10.0 Phase 63 (Offline Intent Classification) is unblocked by this plan** — EMAIL-03's
  hard-prerequisite status for Phase 63 is satisfied; this plan closes out the last WR-09
  test-design gap in Phase 62's own charter.
- **Five open findings (NF-01, NF-03, NF-04, NF-05, REG-01) are ready-to-pick-up gap-closure
  candidates** for whoever schedules the next CSS-layer touch on `strip-hidden.ts`. NF-01
  (total content loss from a stray CDO) is the highest-severity of the five and the most
  likely candidate for prioritization if a dedicated gap-closure plan is scheduled — it is an
  availability defect reachable by ordinary (if unusual) legal CSS syntax, not an exotic
  adversarial construction.
- **62-REVIEW.md's WR-09 finding is now closed.** The operator's standing instruction
  ("a tokenizer swap that does not also fix the oracle will ship bypass number seven") is
  satisfied: the fixed oracle found real defects on its first real run, closing the loop this
  phase's own review opened.
- No blockers for Phase 63.

## Self-Check: PASSED

Verified via `git log --oneline -4`: all 3 task commits (`d71aa0a`, `9e03ffb`, `b3570d3`) plus
this metadata commit (once created) present. Verified via file reads:
`tests/css-liveness-differential.test.ts` exists and contains all three generators, the
`NewlyFiledCounters`/`AllowlistCounters` types, and the four `it.fails` NF-* locks.
`tests/strip-hidden.test.ts` contains the four new `DECOY_FRAGMENTS` entries, the extended
fuzz test with `leakFailures`, and the REG-01 `it.fails` lock. Full suite: 3206 passed / 5
expected-fail / 3 skipped; `npx tsc --noEmit` clean; `npm run build` succeeds; dist-reachability
and frozen-surface checks both pass (0 commits over the five frozen paths since `0ef9b5a6`).
Scratch worktree and all `tests/_scratch-*.test.ts` files removed — not committed, confirmed
via `git status --short` showing a clean tree apart from this SUMMARY and STATE.md updates.

---
*Phase: 62-multi-inbox-email-ingest-hardening*
*Completed: 2026-07-31*
