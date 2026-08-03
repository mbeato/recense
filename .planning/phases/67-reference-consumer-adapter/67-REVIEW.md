---
phase: 67-reference-consumer-adapter
reviewed: 2026-08-03T05:10:00Z
depth: standard
files_reviewed: 10
files_reviewed_list:
  - clients/proposal-reference/tsconfig.json
  - clients/proposal-reference/config.ts
  - clients/proposal-reference/proposal-client.ts
  - clients/proposal-reference/local-store.ts
  - clients/proposal-reference/index.ts
  - clients/proposal-reference/tests/import-boundary.test.ts
  - clients/proposal-reference/tests/local-store.test.ts
  - clients/proposal-reference/tests/sync-loop.test.ts
  - tests/proposal-reference-e2e.test.ts
  - docs/reference-client.md
findings:
  critical: 0
  warning: 6
  info: 6
  total: 12
status: issues_found
---

# Phase 67: Code Review Report

**Reviewed:** 2026-08-03T05:10:00Z
**Depth:** standard
**Files Reviewed:** 10
**Status:** issues_found

## Summary

Reviewed the Phase 67 proposal-reference consumer adapter (config, HTTP client, local row store, outcome loop), its three in-dir tests, the repo-level e2e, and the docs contract section. Verified hardest on the areas the phase context flagged:

- **Token handling: clean.** `authHeader` is built once at factory scope, never interpolated into any log line, error message (`ProposalHttpError` carries only the numeric status), persisted row, or `list` output. Fail-closed gate in `config.ts` verified — empty token means zero network calls.
- **Docs accuracy: verified against live engine.** The 16-field record list matches `src/db/action-proposal-store.ts:42-59` in exact order; closed vocabularies, `schema_version` 17 (`src/db/schema.ts:12`), list bound 100 (`PROPOSAL_LIST_LIMIT`), and every 400/401/404/409/413/503 detail string match `src/adapter/serve-cli.ts:517-605`. Two small docs gaps noted below (IN-02, IN-03).
- **Compile/tests: verified live.** `tsc -p clients/proposal-reference/tsconfig.json` exits 0 under TS 6.0.3 (the `module: commonjs` + `moduleResolution: bundler` combo is accepted in TS6 and mirrors the telegram tsconfig verbatim). All 24 tests across the four test files pass.

What did not survive scrutiny: the crash-resume path can record the *opposite* of the truth in the local system-of-record (WR-01); the import-boundary guard — the phase's headline structural control — has real bypasses including a bare `'../../src'` directory import that resolves to the engine's actual barrel (WR-02); the wire response is cast without validation and a single malformed item crashes the sync instead of stopping it gracefully (WR-03); and the local store's never-throw read path converts a corrupt file into silent total data loss on the next write (WR-05).

## Warnings

### WR-01: Crash-resume replay marks an actually-applied change as `refused`

**File:** `clients/proposal-reference/index.ts:127-137, 151-160`
**Issue:** The loop writes the row `pending` before the POST so a crash mid-flight leaves "a resumable pending row rather than an invisible applied change" (comment at line 127). But trace the resume: if the crash lands *after* the server's 200 and *before* `putLocalRow(applied)`, the next sync finds `existing.localStatus === 'pending'`, re-POSTs, and the server — proposal now terminal — returns 409 `conflict` / `"proposal is not pending"`. `refusalReasonForStatus(409)` maps that to a terminal `refused` row. The local "system of record" now durably records **refused** for a change recense actually **applied** — the exact inversion of the D-03 thesis this adapter exists to demonstrate. The contract makes disambiguation impossible from status + `error` enum alone (all four 409 subtypes share `error: 'conflict'`, and `detail` is explicitly non-contract), so within the frozen v66 surface the adapter cannot know which 409 it got.
**Fix:** The adapter *can* know it is in the ambiguous case: `existing !== undefined` at line 118 means a prior attempt may already have fired. Thread that bit into the catch and record a distinct reason for a 409 on a resumed row, e.g.:
```ts
const resumed = existing !== undefined;
// ... in the 409 branch:
refusalReason: resumed ? 'conflict_after_resume' : refusalReason,
```
so the row is honest about "settled server-side, local outcome unknown" instead of asserting `refused`. At minimum, add this caveat to the **Replay semantics** paragraph in `docs/reference-client.md` (line ~314) — today it tells consumers a redelivered action is "a no-op refusal", without warning that treating it as a terminal *refusal* mislabels the consumer's own successful prior call.

### WR-02: Import-boundary guard is bypassable — the boundary it guards is real

**File:** `clients/proposal-reference/tests/import-boundary.test.ts:40-43`
**Issue:** The scan regex only matches `from '...**/src/**...'` and `require('...**/src/**...')` — a trailing slash after `src` is mandatory and only two import forms are covered. Three bypasses:
1. `import { SemanticStore } from '../../src'` — a bare directory import, no trailing slash, does not match `\/src\//`. This is not theoretical: `src/index.ts` is a real, populated engine barrel (re-exports clock, config, types, hash, stores), so this exact line compiles, resolves, and imports the engine while the guard stays green.
2. Dynamic `await import('../../src/db/schema')` — the regex covers `from` and `require(` but not `import(`.
3. `.mts`/`.cts` files escape `endsWith('.ts')` entirely, so a future file in either extension is never scanned.
Additionally the test has no non-vacuousness floor: if `collectTsFiles` ever returned only a subset (e.g., after a restructure), `expect(violations).toEqual([])` passes on an empty scan.
**Fix:**
```ts
const IMPORT_RE = /(?:from\s+|require\s*\(\s*|import\s*\(\s*)['"][^'"]*\/src(?:\/|['"])/;
// collect .ts, .mts, .cts, .tsx
expect(files.length).toBeGreaterThanOrEqual(5); // guard the guard
```

### WR-03: `body.items` cast without validation — one malformed item crashes the sync instead of stopping it

**File:** `clients/proposal-reference/proposal-client.ts:135-136` (and `clients/proposal-reference/index.ts:82`)
**Issue:** `body.items as ActionProposalRecord[]` is an unchecked cast at the trust boundary. If the server (or anything speaking on its port — the transport is plain HTTP) returns `{ "items": [null] }` or `{ "items": ["x"] }`, the schema gate at `index.ts:82` evaluates `r.schema_version` on a non-object and throws `TypeError`, which is not a `ProposalHttpError`, so it propagates out of `syncProposals` uncaught and `main()` dies with FATAL. The adapter's stated discipline for unexpected shapes is *graceful stop* (the D-07 schema gate) — a null item produces a crash instead. Note the accidental safety that a missing `schema_version` on an *object* item correctly trips the gate (`undefined !== 17`); it is only non-object items that crash.
**Fix:** Filter to objects before returning, so the schema gate sees only things it can inspect:
```ts
return Array.isArray(body.items)
  ? (body.items.filter(i => typeof i === 'object' && i !== null) as ActionProposalRecord[])
  : [];
```
or better, treat any non-object item like an unknown schema_version: stop the sync.

### WR-04: Proposal id interpolated into the POST path unvalidated and unencoded

**File:** `clients/proposal-reference/proposal-client.ts:141, 146`
**Issue:** `'/v1/proposals/' + id + '/approve'` uses the listed record's `id` verbatim. An id containing `/`, `..`, `?`, or `#` steers the request: WHATWG URL normalization in `fetch` collapses dot segments, so `id = "../../v1/add"` yields a POST to `serveUrl + '/v1/add/approve'`-shaped paths — the adapter's authenticated Bearer request lands on a route it never intended to call. The docs themselves state the contract shape ("proposal ids are sha256 hex by construction", `docs/reference-client.md:298-299`) and the server enforces `^[0-9a-f]{64}$` inbound (`serve-cli.ts:555`), but the client trusts list output blindly. The list response is semi-trusted (same server, but plain-HTTP transport and a stated "treat server text as data" posture elsewhere in this phase).
**Fix:**
```ts
if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('malformed proposal id in list response');
```
in `approve`/`reject` (or `encodeURIComponent(id)` as the weaker floor).

### WR-05: Corrupt store file is silently discarded and overwritten — total loss of terminal state, cascading into WR-01

**File:** `clients/proposal-reference/local-store.ts:67-76, 119-123`
**Issue:** `readRows` returns `[]` for unparseable JSON (deliberate never-throw), but `putLocalRow` is built on it: `readRows(...)` → filter → `writeRows`. So the first put after any corruption **rewrites the entire store as a one-row file**, silently destroying every prior row — including terminal `applied` and `refused` markers. The very next sync then re-POSTs previously-applied proposals (findByProposalId finds nothing), the server answers 409, and each one gets recorded `refused` (the WR-01 inversion, now at batch scale). The same silent-drop applies per-row via `raw.filter(isLocalRow)` — a row with one wrong-typed field is dropped and gone on the next write. "Never throws on read" is fine; "never *notices* on write" turns one bad byte into fabricated refusal history in the system of record.
**Fix:** In `putLocalRow` (or `writeRows`), when the store file exists but parses to nothing usable, quarantine instead of overwriting:
```ts
if (existsSync(storePath) && readRows(storePath).length === 0 && statSync(storePath).size > 2) {
  renameSync(storePath, storePath + '.corrupt-' + Date.now());
}
```
and log the quarantine so the operator knows recovery is needed.

### WR-06: No concurrency guard — the D-02 "never a second HTTP call" claim fails under overlapping invocations

**File:** `clients/proposal-reference/local-store.ts:119-123`, `clients/proposal-reference/index.ts:106-129`
**Issue:** The idempotency mechanism is check-then-act over a shared file with no lock: `findByProposalId` (read) … `putLocalRow` (read-modify-write). Two concurrent `sync` invocations (cron overlap, manual run beside a scheduled one) each see no existing row for the same proposalId, each mint a distinct `localId`, each write (last rename wins, potentially losing the other's rows entirely), and each POST — a duplicate HTTP action and duplicate/conflicting local rows. The telegram sibling explicitly guards in-process overlap (`tickInFlight`); this adapter has no overlap protection of any kind, in-process or cross-process, while its docs assert a re-listed proposal "never creates a second local row or a second HTTP call" (`docs/reference-client.md:169-170`).
**Fix:** Take an `O_EXCL` lockfile (e.g., `storePath + '.lock'`, `writeFileSync(lock, pid, { flag: 'wx' })`, unlink in `finally`) around `syncProposals`, exiting cleanly if held — or document the single-instance requirement explicitly in docs/reference-client.md.

## Info

### IN-01: `LocalStatus` value `'skipped'` is dead vocabulary

**File:** `clients/proposal-reference/local-store.ts:27`
**Issue:** No code path ever writes `localStatus: 'skipped'` — the unknown-kind skip (`index.ts:98-101`) and the idempotency skip both `continue` without persisting. The type guard and union carry a state that cannot occur, which misleads a reader auditing the state machine.
**Fix:** Remove `'skipped'` from the union and the guard, or persist skip rows if that was the intent.

### IN-02: Docs env table omits `RECENSE_REFERENCE_LOG_PATH`

**File:** `docs/reference-client.md:152-156` (vs `clients/proposal-reference/index.ts:182`)
**Issue:** The adapter reads `RECENSE_REFERENCE_LOG_PATH`, but the proposal client's environment-variable table documents only `RECENSE_SERVE_URL`, `RECENSE_SERVE_TOKEN`, and `RECENSE_REFERENCE_STORE_PATH`.
**Fix:** Add a row: `RECENSE_REFERENCE_LOG_PATH` — optional, default `<store dir>/proposal-reference.log`.

### IN-03: Retry-policy drift for statuses outside {400, 401, 404, 409, 503} — and docs omit 500

**File:** `clients/proposal-reference/index.ts:139-164`; `docs/reference-client.md:294-322`
**Issue:** Docs state "of every response above, only 503 is retryable" — a set that includes 413 as terminal — and omit 500 `internal_error` entirely, though both proposal routes emit it (`serve-cli.ts:530, 601-603`). The adapter's actual behavior for 413, 500, or any other unmapped status is: fall through to the "unexpected error" log, leave the row `pending`, and re-POST on every future sync — implicit retry-forever, contradicting the documented policy for 413. (Unreachable for 413 today since the client sends `{}`, but the state machine should still be closed.)
**Fix:** Document 500 in the error list; in the adapter, decide explicitly — either extend `refusalReasonForStatus` with a default terminal bucket for 4xx, or document that unmapped statuses are treated as retryable.

### IN-04: Log-line injection via server-supplied text

**File:** `clients/proposal-reference/index.ts:99, 164` (also 85-88)
**Issue:** `record.id`, `record.kind`, and `String(err)` are interpolated raw into the append-only log. Any newline in server-supplied text forges arbitrary log entries (e.g., a fake `sync complete — applied=…` line). Consistent with the phase's own "server text is data" posture, control characters should not pass through.
**Fix:** `const safe = (s: string) => s.replace(/[\r\n]/g, ' ');` around interpolated values in `log()` call sites, or inside `log()` itself.

### IN-05: Trailing slash in `RECENSE_SERVE_URL` silently breaks every route

**File:** `clients/proposal-reference/config.ts:32`; `clients/proposal-reference/proposal-client.ts:107, 129`
**Issue:** `serveUrl + '/v1/proposals'` with `RECENSE_SERVE_URL=http://127.0.0.1:7701/` produces path `//v1/proposals`; the server exact-matches `url === '/v1/proposals'` (`serve-cli.ts:523`), so every sync 404s with no hint at the cause.
**Fix:** `serveUrl.replace(/\/+$/, '')` in `loadAdapterConfig()`.

### IN-06: In-dir test files are typechecked by no tsconfig, and CI never runs `build:proposal-reference`

**File:** `clients/proposal-reference/tsconfig.json:18`; `.github/workflows/ci.yml`; `tests/tsconfig.json`
**Issue:** The adapter tsconfig excludes `tests/`; root tsconfig includes only `src`+`scripts`; `tests/tsconfig.json` includes `../src`, `.`, `../scripts`. So `import-boundary.test.ts`, `local-store.test.ts`, and `sync-loop.test.ts` are in no typechecked program — vitest transpiles via esbuild without checking, so type errors there land on main undetected. CI also never runs `npm run build:proposal-reference` (nor `build:client`), so the "compile boundary enforced at build time" claim is only exercised on manual runs. (Adapter *source* files do get transitively typechecked through `tests/tsconfig.json` via the e2e's imports, so the exposure is the test files plus the tsconfig itself.)
**Fix:** Add `npm run build:proposal-reference` (and `build:client`) to the CI typecheck step, and either include `tests` in the adapter tsconfig for a `--noEmit` check or add a `tests/tsconfig.json`-style config for the clients trees.

---

_Reviewed: 2026-08-03T05:10:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
