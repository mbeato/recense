---
phase: 50-verification-regression-gates
reviewed: 2026-06-30T00:00:00Z
depth: standard
files_reviewed: 2
files_reviewed_list:
  - scripts/eval/gate-runner.cjs
  - scripts/eval/gate-accuracy-runner.cjs
findings:
  critical: 1
  warning: 5
  info: 5
  total: 11
status: issues_found
---

# Phase 50: Code Review Report

**Reviewed:** 2026-06-30
**Depth:** standard
**Files Reviewed:** 2
**Status:** issues_found

## Summary

Two regression-gate runners were reviewed against the Phase 50 fail-closed contract and the
project's "never let a missing harness output be treated as a pass" / no-inflated-metrics rules.

**The cheap gate's core fail-closed path is solid.** `gate-runner.cjs --run` cannot exit 0 on a
missing/corrupt baseline, a missing result JSON, or a missing/null expected key — `readJsonSafe`
and `requireKey` both `process.exit(1)` on every absence path, the baseline is validated before any
harness runs, and the floor/ceiling comparator directions and inclusive boundaries are correct
(floor fails on `actual < bound`, ceiling on `actual > bound`, equality passes). The `--contradicts`
binary `>0` assertion and the accuracy-runner's hard key-guard also behave as specified. Good work
on the absence-path contract.

The defects cluster around two themes the contract did **not** cover: (1) `--update-baseline`
destroys state it didn't author, and (2) several *present-but-degenerate* inputs (missing individual
thresholds, missing whole baseline on the accuracy tier, non-numeric scores) silently fall through to
a green verdict instead of failing closed. The single most serious is CR-01: the documented
`npm run gate:baseline` command silently wipes the armed accuracy-tier floors, reverting the paid
gate to all-SKIP/PASS — a data-loss → fail-open chain on the most load-bearing axis (belief
correction, the project's stated core value).

## Critical Issues

### CR-01: `--update-baseline` wipes the armed accuracy-tier floors → paid gate silently reverts to all-SKIP/PASS

**File:** `scripts/eval/gate-runner.cjs:221-254`
**Issue:**
`--update-baseline` builds a fresh `newBaseline` object whose `thresholds` block contains only the
five cheap-axis keys (`locomo_r5_floor`, `locomo_r10_floor`, `lat_p95_ceiling_ms`,
`injected_tokens_ceiling`, `contradicts_floor`) and then **overwrites the entire baseline file**
(`fs.writeFileSync(BASELINE_PATH, JSON.stringify(newBaseline, ...))`, line 254). The accuracy-tier
floors that Plan 50-03 armed — `eval02_floor` (0.796), `locomo_j_floor` (0.8104), `ku_floor` (0.339)
— and the entire `meta.accuracy_floor_provenance` block are **not carried over** and are therefore
destroyed on every re-baseline.

This is reachable through the documented, intended command: `package.json` wires
`"gate:baseline": "... gate-runner.cjs --run --update-baseline --locomo ..."`. After a founder runs
`npm run gate:baseline` and commits the result, `gate-accuracy-runner.cjs` reads the baseline,
finds none of `eval02_floor` / `locomo_j_floor` / `ku_floor` present, and prints
`SKIP: ... (no baseline floor)` for all three axes — then exits 0 with `GATE PASS (accuracy tier)`
(see `gate-accuracy-runner.cjs:191`, `235`, `271`). The most expensive and most important gate
(belief-correction — the stated core value in CLAUDE.md) is silently disarmed and reports green.

This violates both the no-inflated-metrics rule (a PASS that enforced nothing) and the fail-closed
mandate, and it is silent data loss in a committed artifact.

**Fix:** Merge new thresholds onto the existing baseline rather than replacing the file. Read the
prior baseline first and preserve unmanaged keys and provenance:
```javascript
// before writing, load the prior baseline so accuracy floors + provenance survive
let prior = {};
try { prior = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')); } catch {}
const newBaseline = {
  meta: {
    ...(prior.meta || {}),            // preserve accuracy_floor_provenance
    eval: 'gate-baseline', version: 'v9.0-final', date: new Date().toISOString(),
    commit, engine_version: engineVersion, recorded_from: { /* ... */ },
  },
  scores: { /* ... measured cheap-axis scores ... */ },
  thresholds: {
    ...(prior.thresholds || {}),      // preserve eval02_floor / locomo_j_floor / ku_floor
    locomo_r5_floor: /* ... */, locomo_r10_floor: /* ... */,
    lat_p95_ceiling_ms: /* ... */, injected_tokens_ceiling: /* ... */, contradicts_floor: 1,
  },
};
```
Alternatively, if dropping accuracy floors on re-baseline is intended, that must be made explicit
(loud warning + a separate `gate:accuracy:baseline` re-arm path) rather than silent.

## Warnings

### WR-01: Accuracy runner fails OPEN on a missing/unparseable baseline (PASS with zero enforcement)

**File:** `scripts/eval/gate-accuracy-runner.cjs:66-77`, `294-305`
**Issue:**
`readBaseline()` returns `{ thresholds: {} }` when the baseline file is missing or unparseable
(lines 68-69, 74-75). Every axis then takes the `!('..._floor' in thresholds)` branch, prints a
`SKIP` notice, and pushes nothing to `failures[]`. The final verdict (lines 294-305) sees an empty
`failures[]` and prints `GATE PASS (accuracy tier)` with `process.exit(0)`. So a missing baseline
runs the full paid suite, enforces nothing, and reports green. This directly contradicts the sibling
contract: `gate-runner.cjs:262` fails **closed** (`process.exit(1)`) on a missing baseline. The two
runners disagree on the most basic fail-closed case, and the accuracy tier is the one where a false
green is most costly. Note the threat model intends SKIP ≠ FAIL per-axis, but a *wholly absent
baseline* producing an overall PASS is the fail-open case T-50-04 was meant to prevent.
**Fix:** Treat a missing/unparseable baseline as a hard error for `--run` (the paid tier should never
run unguarded): `console.error('GATE FAIL: baseline missing/unparseable — cannot enforce accuracy floors'); process.exit(1);`. Keep per-axis SKIP only for the case where the baseline exists but an individual floor is intentionally absent.

### WR-02: Missing individual threshold silently disables that axis and can still GATE PASS

**File:** `scripts/eval/gate-runner.cjs:278-293`
**Issue:**
Each comparator is gated by `if (t.<key> != null && ...)`. If a single threshold key is absent from
the baseline (corruption, hand-edit, or the CR-01 wipe), that axis is skipped entirely with no
notice and no failure — the gate can print `GATE PASS` while silently enforcing nothing on that axis.
Unlike the accuracy runner, there isn't even a SKIP log line, so the regression hole is invisible.
This is a tampering/inflation vector (T-50-02): deleting one floor disables detection on that axis.
**Fix:** After validating the `thresholds` block exists, assert the expected cheap-axis keys are all
present and fail closed if any is missing:
```javascript
for (const k of ['locomo_r5_floor','locomo_r10_floor','lat_p95_ceiling_ms','injected_tokens_ceiling']) {
  if (t[k] == null) { console.error(`GATE FAIL: baseline missing threshold '${k}'`); process.exit(1); }
}
```

### WR-03: Present-but-non-numeric score evades the comparator → fail-open on type-corrupt input

**File:** `scripts/eval/gate-runner.cjs:82-97`, `278-300`
**Issue:**
`requireKey` only guards against missing keys and `null`/`undefined` (lines 86, 92). A present score
that is a non-numeric string or object (e.g. a result JSON with `"r5": "n/a"`) passes `requireKey`,
then `"n/a" < 0.7527` evaluates to `false` (NaN comparison), so no failure is recorded and the gate
can `GATE PASS` on corrupt data. The docstring claims `requireKey` "ensures fail-closed behavior on
missing expected keys," but type-corruption slips through and is exactly the kind of degenerate
harness output the fail-closed contract is meant to catch.
**Fix:** Add a numeric guard in `requireKey` (or a dedicated `requireNumber`) for the score axes:
```javascript
if (typeof cur !== 'number' || Number.isNaN(cur)) {
  console.error(`GATE FAIL: non-numeric value at '${keyPath}' in ${label} (${filepath})`);
  process.exit(1);
}
```

### WR-04: "GATE PASS (accuracy tier)" does not distinguish enforced-pass from all/partial-SKIP

**File:** `scripts/eval/gate-accuracy-runner.cjs:291-305`
**Issue:**
The final verdict only checks `failures.length`. A run where one, two, or all three axes were SKIPPED
(no floor present) prints the identical flat `GATE PASS (accuracy tier)` as a run where all three were
actually compared and passed. A human or downstream consumer reading the last line cannot tell
"accuracy verified" from "accuracy never checked." Combined with CR-01/WR-01 this is how a disarmed
gate looks green.
**Fix:** Track skips and reflect them in the verdict:
```javascript
const skipped = ['eval02_floor','locomo_j_floor','ku_floor'].filter(k => !(k in thresholds));
if (failures.length === 0 && skipped.length > 0) {
  console.warn(`GATE PASS (accuracy tier) — but ${skipped.length} axis/axes were NOT enforced (no floor): ${skipped.join(', ')}`);
}
```

### WR-05: Key-guard requires ANTHROPIC_API_KEY, which the documented `claude -p` subscription transport does not use

**File:** `scripts/eval/gate-accuracy-runner.cjs:136-150`
**Issue:**
The hard key-guard demands `ANTHROPIC_API_KEY` for `--run`. Per CLAUDE.md the sleep-pass stack runs
Haiku/Sonnet via the headless `claude -p` subscription transport — explicitly "NOT direct API." On
the founder's primary machine that env var is typically unset, so this guard will block the intended,
correctly-configured paid run; conversely, a set `ANTHROPIC_API_KEY` does not actually prove the
`claude -p` transport is authenticated. The guard's signal does not match the real auth mechanism it
is supposed to protect. It fails closed (safe direction), but it gates on the wrong thing and will
produce confusing false refusals.
**Fix:** Gate on what the run actually consumes: keep `OPENAI_API_KEY` as required (real billed
gpt-4o-mini + embeddings), and replace the `ANTHROPIC_API_KEY` check with a probe of the actual
transport (e.g. `which claude` / a `claude -p` reachability check), or document clearly that a value
must be exported even when subscription-billed.

## Info

### IN-01: Floor epsilon mismatch — code uses −0.02 while the convention of record is −0.05

**File:** `scripts/eval/gate-runner.cjs:244-247`
**Issue:**
`--update-baseline` computes cheap floors at `recorded − 0.02` (lines 244-245), but 50-03-SUMMARY and
the established pattern state "floor = recorded value − 0.05 epsilon, applied uniformly to cheap and
accuracy axes." The committed baseline cheap floors are indeed −0.02 while accuracy floors are −0.05,
so the "uniformly" claim is already false, and a re-baseline would re-emit the −0.02 cheap floors.
Tighter floors are more sensitive (not inflation), but the code and the documented convention
disagree.
**Fix:** Pick one epsilon and make code + docs agree; if cheap vs accuracy intentionally differ,
state that explicitly in the pattern note.

### IN-02: `lat_p50_ms` is collected and recorded but never gated on the `--run` path

**File:** `scripts/eval/gate-runner.cjs:152-171`, `238`, `286-289`
**Issue:**
`runLatencyAxis` reads and the baseline records `lat_p50_ms`, but only `lat_p95_ceiling_ms` is
compared. The phase framing says "latency p50/p95"; p50 is informational-only on the gate path. Not a
bug, but worth documenting so the asymmetry isn't mistaken for an omission.
**Fix:** Either add a p50 ceiling or add a comment that p50 is recorded for provenance only.

### IN-03: Temp dir leaks if a sub-harness fails to spawn

**File:** `scripts/eval/gate-accuracy-runner.cjs:80-91`, `168`, `289`
**Issue:**
`runHarness` throws on `result.error` (spawn failure). That throw is uncaught and propagates past the
`fs.rmSync(OUT_DIR, ...)` cleanup at line 289, leaving a `gate-accuracy-<pid>` directory in
`os.tmpdir()`. Minor housekeeping leak, not a correctness issue.
**Fix:** Wrap the orchestration in `try { ... } finally { fs.rmSync(OUT_DIR, { recursive: true, force: true }); }`.

### IN-04: `--probe` prints static hardcoded estimates instead of running a representative case

**File:** `scripts/eval/gate-accuracy-runner.cjs:94-132`
**Issue:**
Plan 50-02 specified the probe "run/estimate ONE representative case, report cost + case count." The
implementation prints fixed token ranges (e.g. "~50k–100k") with no live measurement. This is safer
(zero spend on probe) and the numbers are labeled "estimated," but they can silently drift from
reality as harnesses change, which is adjacent to the no-inflated-metrics concern.
**Fix:** Either run one representative case for a live estimate as planned, or add a comment that the
envelope is a static, manually-maintained estimate with a last-verified date.

### IN-05: `--run` + `--update-baseline` together never executes the comparison

**File:** `scripts/eval/gate-runner.cjs:210-257`
**Issue:**
`npm run gate:baseline` passes `--run --update-baseline`, but the `IS_UPDATE_BASELINE` block runs
first and `process.exit(0)` at line 256, so the `--run` comparator at lines 259-308 never executes.
Re-baselining therefore records and exits 0 without comparing — which is the intended behavior, but
the redundant `--run` flag in the script is misleading and invites the assumption that gate:baseline
also gates.
**Fix:** Drop `--run` from the `gate:baseline` script, or have `--update-baseline` ignore/reject a
co-passed `--run` with a one-line note.

---

_Reviewed: 2026-06-30_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
