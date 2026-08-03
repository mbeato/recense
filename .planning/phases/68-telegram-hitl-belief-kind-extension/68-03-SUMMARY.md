---
phase: 68-telegram-hitl-belief-kind-extension
plan: 03
subsystem: bot
tags: [telegram, hitl, http-client, refusal-mapping, approval-fatigue, vitest]

# Dependency graph
requires:
  - phase: 68-01
    provides: StoredBeliefProposal union member, isBeliefProposal/toStoredBeliefProposal/beliefLocalId, createBeliefProposalClient/ProposalHttpError, the standing zero-diff hash lock on proposal-store.ts/proposal-engine.ts
  - phase: 68-02
    provides: v3 belief callback codec (encodeBeliefCallbackData/decodeBeliefCallbackData), belief-render.ts (asDisplayText/renderBeliefDecisionMessage/beliefKeyboard), runBeliefBridgePass, the belief prompt ledger, config.ts's beliefBridgeEnabled/beliefPollMs gate
provides:
  - handleBeliefProposalAction — the belief decision handler with full refusal mapping (clients/telegram/belief-bridge.ts)
  - The '3|' callback dispatch branch in index.ts's callback drain, wired before '2|', with a lazy belief-client getter and ApprovalTestHooks.beliefClient/statePath
  - readBeliefStats/writeBeliefStats approval-rate counters (clients/telegram/state.ts)
  - no-numeric-confidence.test.ts — structural absence proof for APPROVE-04
  - tests/telegram-belief-e2e.test.ts — repo-level proof against a real serve, including the genuine second-POST 409 round-trip
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Status-only refusal mapping (never parse/echo the serve `detail` string) mirroring clients/proposal-reference/index.ts's decision policy, adapted for a foreground human-tap POST that needs no `needs_reconciliation` third state"
    - "Approval-rate self-report appended to the decision reply itself on every Nth terminal decision, rather than a separate message"
    - "Local module-scoped log68() append-only file logger, duplicated from index.ts's own log() rather than injected, so handleBeliefProposalAction's signature stays parameters-only (no config, no log) for direct test/e2e drive-ability"

key-files:
  created:
    - clients/telegram/tests/belief-callback.test.ts
    - clients/telegram/tests/belief-refusal.test.ts
    - clients/telegram/tests/no-numeric-confidence.test.ts
    - tests/telegram-belief-e2e.test.ts
  modified:
    - clients/telegram/belief-bridge.ts
    - clients/telegram/index.ts
    - clients/telegram/state.ts
    - clients/telegram/tests/approval-handler.test.ts
    - clients/telegram/tests/callback-query.test.ts
    - clients/telegram/tests/edit-path.test.ts
    - clients/telegram/tests/proposal-push.test.ts
    - clients/telegram/tests/proposal-store.test.ts
    - clients/telegram/tests/push-timer.test.ts
    - clients/telegram/tests/telegram-client.test.ts
    - clients/telegram/tests/transport-extension.test.ts
    - clients/telegram/tests/typed-confirm.test.ts

key-decisions:
  - "T-68-13 (the mirror of Plan 01's T-68-01 tool-path guard) is asserted immediately after loadExecutable and before the already-terminal check, so a forged '3|{id}|a' naming a TOOL row is refused before any belief-only field is read"
  - "The refusal catch never writes a hitl audit episode for 503/401/unmapped errors (non-terminal, nothing decided yet) but does write a 'belief-refused' episode for 400/404/409 (terminal) — matching T-68-15's 'every terminal decision writes an audit episode' requirement"
  - "The approval-rate self-report is appended as a second paragraph to the SAME reply (confirmation or refusal text) rather than a separate sendMessage call, so it always rides the one message the decision already sends"
  - "Doc comments in belief-bridge.ts intentionally avoid the literal function names validateProposal/callDeepSeek/buildProposalPrompt/callServerTool (referring to them by module instead) — the acceptance-criteria grep for those exact strings would otherwise flag its own documentation, mirroring Plan 02's parse_mode lesson"

patterns-established:
  - "getToolProposal()-style thin cast wrapper in test files that only ever handle one member of the StoredProposal union, kept local to the test file rather than exported, so the frozen proposal-store.ts return type (the union) never needs a production-code cast"

requirements-completed: [APPROVE-01, APPROVE-02, APPROVE-04]

# Metrics
duration: ~25min
completed: 2026-08-03
---

# Phase 68 Plan 03: Belief Decision Dispatch + Refusal Mapping + Verification Sweep Summary

**Wired the '3|' belief callback into the dispatch loop, built the full approve/reject/refusal-status handler with a persisted approval-rate self-report, structurally proved confidence is never a numeric gate, and closed the loop with a repo-level e2e that decodes a real button's callback_data and drives a genuine second-POST 409 through the frozen `/v1/proposals` contract.**

## Performance

- **Duration:** ~25 min
- **Tasks:** 3 completed (Tasks 1–2 TDD: test → feat; Task 3 test-only, no tdd flag)
- **Files modified/created:** 16 (4 created, 12 modified)

## Accomplishments

- `handleBeliefProposalAction` in `belief-bridge.ts` decides missing/expired/tool-kind-forged (T-68-13)/already-terminal (T-68-17) rows before any HTTP call, short-circuits edit/snooze with a fixed reply and a `belief-edit-refused` audit episode, and never imports or calls anything from the LLM tool-mapping module or the MCP execution module — proven by a fail-if-called stub recording zero invocations and a source grep returning nothing
- The full refusal-status mapping (Task 2): 503 leaves the row pending and retryable with no counter change; 400/404/409 write the row terminal, increment `refused`, write a `belief-refused` audit episode, and are never retried; 401 and any other status/network error leave the row pending with a neutral reply that never mentions tokens, "Bearer", or the serve `detail` string (T-68-16)
- `readBeliefStats`/`writeBeliefStats` persist approve/reject/refused counters (same read-modify-write document discipline as the cursor and belief prompt ledger); every 10th terminal decision appends a self-report line to that decision's own reply (D-09/Pitfall 7)
- The `3|` version prefix is dispatched in `index.ts`'s callback drain BEFORE `2|`, decoding with `decodeBeliefCallbackData`, calling `handleBeliefProposalAction` inside a try/catch, and answering the callback unconditionally on every outcome (Pitfall 1) — `ApprovalTestHooks` gained an injectable `beliefClient`/`statePath` and a lazy belief-client getter mirroring the existing approval-config getters
- `no-numeric-confidence.test.ts` scans all of `clients/telegram/` for three numeric-confidence shapes (comparison, coercion, `confidence:` numeric-literal assignment) with a 30-file non-vacuousness floor, planted-offender proofs (built by string concatenation), and a lawful-string proof that categorical usage is never flagged
- `tests/telegram-belief-e2e.test.ts` drives a real `createBrainHttpServer` + seeded `ActionProposalStore`: `runBeliefBridgePass` sends exactly one transition-labeled prompt, the button's real `callback_data` is decoded and fed to `handleBeliefProposalAction`, the server-side status becomes `approved` and the local row is terminal; resetting the local row to pending and tapping again produces a genuine server-side 409 that the client maps to a terminal refusal with no state inversion (server status stays `approved`)

## Task Commits

Each task was committed atomically (Tasks 1 and 2 used TDD — test commit then feat commit):

1. **Task 1: The '3|' dispatch branch and the belief decision handler** — `67e822b` (test, RED) → `be3d114` (feat, GREEN)
2. **Task 2: Refusal mapping and the approval-rate self-report** — `1521fc2` (test, RED) → `b0dec57` (feat, GREEN)
3. **Task 3: Numeric-confidence absence scan, repo-level e2e, verification sweep** — `27c87c1` (test)

## Files Created/Modified

- `clients/telegram/belief-bridge.ts` — `handleBeliefProposalAction`, `renderTransitionConfirmation`, `maybeAppendSelfReport`, local `log68()`
- `clients/telegram/index.ts` — `3|` dispatch branch (before `2|`), `getBeliefClient`/`getBeliefStatePath` lazy getters, `ApprovalTestHooks.beliefClient`/`statePath`
- `clients/telegram/state.ts` — `readBeliefStats`/`writeBeliefStats`, `BeliefStats` type
- `clients/telegram/tests/belief-callback.test.ts` — 9 tests (dispatch, guards, bypass proof, double-tap idempotency)
- `clients/telegram/tests/belief-refusal.test.ts` — 12 tests (one per refusal class, counter behaviors, self-report cadence, no-leak proof)
- `clients/telegram/tests/no-numeric-confidence.test.ts` — 5 tests (main scan + 3 planted-offender blocks + 1 lawful-strings block)
- `tests/telegram-belief-e2e.test.ts` — 1 test covering the full happy path + genuine 409 round-trip
- `clients/telegram/tests/{approval-handler,callback-query,edit-path,proposal-push,proposal-store,push-timer,telegram-client,typed-confirm,transport-extension}.test.ts` — pre-existing type-error fixes surfaced by this task's mandatory strict typecheck (see Deviations)

## Decisions Made

- Placed the T-68-13 tool-kind guard immediately after the missing/expired load check and before the already-terminal check, so a forged callback naming a tool row is rejected on the earliest possible branch
- The refusal catch writes a `belief-refused` audit episode only for the terminal classes (400/404/409); 503/401/unmapped write no episode since nothing was decided yet — this satisfies T-68-15's "every terminal decision is auditable" without auditing non-decisions
- Kept `handleBeliefProposalAction`'s signature exactly as specified in the plan (transport, memoryClient, client, storePath, statePath, chatId, decoded, nowMs — no config, no injected log) by duplicating a small local `log68()` file-append helper rather than adding a log parameter or importing index.ts's private `log()`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Doc comments literally named the four forbidden functions, tripping the acceptance-criteria grep**
- **Found during:** Task 1
- **Issue:** `belief-bridge.ts`'s own doc comments explained the bypass property by naming `validateProposal`, `callDeepSeek`, `buildProposalPrompt`, and `callServerTool` literally — the acceptance criterion `grep -n "validateProposal\|callDeepSeek\|buildProposalPrompt\|callServerTool" clients/telegram/belief-bridge.ts` (required to return nothing) matched its own documentation. Same pitfall class as Plan 02's `parse_mode` doc-comment lesson.
- **Fix:** Reworded to refer to "the LLM tool-mapping module (proposal-engine.ts)" and "the MCP execution module (mcp-client.ts)" without using the literal function names.
- **Files modified:** `clients/telegram/belief-bridge.ts`
- **Verification:** `grep -n "validateProposal\|callDeepSeek\|buildProposalPrompt\|callServerTool" clients/telegram/belief-bridge.ts` returns nothing; full test file passes.
- **Committed in:** `be3d114` (part of Task 1 GREEN commit)

**2. [Rule 3 - Blocking] `npx tsc` 6.0.3 errors (TS5112) when files are passed on the command line alongside a present tsconfig.json**
- **Found during:** Task 3's mandatory ad-hoc strict typecheck of `clients/telegram/*.ts clients/telegram/tests/*.ts`
- **Issue:** The exact command specified in the plan's `<verify>` block (and the harness's checker-W1-fix instruction) fails with `error TS5112: tsconfig.json is present but will not be loaded if files are specified on commandline` before ever reaching type analysis — this is TypeScript 6.x's own new guard, unrelated to any repo code.
- **Fix:** Added `--ignoreConfig` to the ad-hoc command (which already passes every needed compiler option explicitly, so no tsconfig behavior is lost). Ran the corrected command; it surfaced the genuine pre-existing errors below.
- **Files modified:** None (invocation-only)
- **Verification:** `npx tsc --noEmit --ignoreConfig --strict --esModuleInterop --skipLibCheck --noUncheckedIndexedAccess --target ES2022 --module commonjs --moduleResolution bundler --types node clients/telegram/*.ts clients/telegram/tests/*.ts` exits 0.

**3. [Rule 3 - Blocking] Seven test files' `ClientConfig` literals predate Plan 02's `beliefBridgeEnabled`/`beliefPollMs` fields**
- **Found during:** Task 3's ad-hoc strict typecheck (this is the first time `tests/` has ever been typechecked against `clients/telegram/tsconfig.json`'s own strict compiler options — `tsconfig.json`'s `exclude: ["tests","dist"]` normally keeps them out of `npm run build:client`)
- **Issue:** `approval-handler.test.ts`, `callback-query.test.ts`, `edit-path.test.ts`, `proposal-push.test.ts`, `push-timer.test.ts`, `telegram-client.test.ts`, `typed-confirm.test.ts` build `ClientConfig` object literals missing the two fields Plan 02 added, failing `TS2739`/`TS2322`.
- **Fix:** Added `beliefBridgeEnabled: false, beliefPollMs: 300_000,` to each literal (or, for `push-timer.test.ts`'s options-driven builder, to its return object; for `proposal-push.test.ts`'s `Partial<ClientConfig>`-override builder, before the `...overrides` spread, mirroring `belief-poll.test.ts`'s existing pattern).
- **Files modified:** the seven files listed above
- **Verification:** ad-hoc tsc scan exits 0; `npx vitest run clients/telegram/tests` — 366 passing, no regressions.

**4. [Rule 1 - Bug] `proposal-push.test.ts` / `proposal-store.test.ts` read tool-only fields off the `StoredProposal` union without narrowing**
- **Found during:** same ad-hoc typecheck
- **Issue:** Plan 01 turned `StoredProposal` into `StoredToolProposal | StoredBeliefProposal`. `getProposal()`/`loadExecutable()` now return the union, so `.tool`/`.args`/`.serverName`/`.destructive`/`.expectedConfirmValue` access in these two tool-only test files no longer typechecks (`TS2339`).
- **Fix:** `proposal-push.test.ts` — cast the one `getProposal(...)` result to `StoredToolProposal` at its single call site (with a comment explaining this file only ever handles tool-kind proposals). `proposal-store.test.ts` — added a local `getToolProposal()` cast-wrapper used at every tool-field access site, plus one inline cast in the `loadExecutable` test.
- **Files modified:** `clients/telegram/tests/proposal-push.test.ts`, `clients/telegram/tests/proposal-store.test.ts`
- **Verification:** ad-hoc tsc scan exits 0; both files' own test suites still pass unchanged.

**5. [Rule 1 - Bug] `edit-path.test.ts` had a dead always-true ternary (`getProposal ? ... : null`)**
- **Found during:** same ad-hoc typecheck (`TS2774: This condition will always return true since this function is always defined`)
- **Issue:** A vestigial block computed `newProposal` via `getProposal ? (...) : null` (a function reference is always truthy) where the truthy branch always returned `null` anyway — the resulting variable was never read afterward.
- **Fix:** Deleted the dead block; verified `getProposal` and `StoredProposal` are still used elsewhere in the file (they are).
- **Files modified:** `clients/telegram/tests/edit-path.test.ts`
- **Verification:** ad-hoc tsc scan exits 0; file's own suite still passes.

**6. [Rule 1 - Bug] `transport-extension.test.ts` had seven stale `@ts-expect-error` directives**
- **Found during:** same ad-hoc typecheck (`TS2578: Unused '@ts-expect-error' directive`)
- **Issue:** These markers dated to Phase 22's TDD RED phase, guarding `answeredCallbacks`/`answerCallbackQuery` before either existed on `MockTelegramTransport`. Both have been implemented for many phases; the directives now flag as unused rather than suppressing a real error.
- **Fix:** Removed all seven directives; added one comment explaining why.
- **Files modified:** `clients/telegram/tests/transport-extension.test.ts`
- **Verification:** ad-hoc tsc scan exits 0; file's own suite still passes.

## Issues Encountered

None beyond the pre-existing test-file type errors documented above as deviations. Worktree base needed correction on start (`git reset --hard` to `b1250a7`) per the worktree branch check protocol — expected per-agent-worktree behavior, not a plan issue.

## Phase Verification Sweep (Task 3, recorded per plan instruction)

- `npx vitest run` — full suite green: **238 test files passed | 1 skipped; 3942 tests passed | 6 expected fail | 4 skipped** (after `npm run build` regenerated `dist/` — several repo-root harness tests spawn compiled artifacts and are environment-dependent on a built tree, not a regression; see the worktree note)
- `npx tsc --noEmit -p tsconfig.json` — exits 0
- `npx tsc --noEmit -p tests/tsconfig.json` — exits 0
- `npm run build:client` — exits 0
- `npx tsc --noEmit --ignoreConfig --strict --esModuleInterop --skipLibCheck --noUncheckedIndexedAccess --target ES2022 --module commonjs --moduleResolution bundler --types node clients/telegram/*.ts clients/telegram/tests/*.ts` — exits 0 (see Deviation #2 for the `--ignoreConfig` addition)
- `git diff --stat 561f9c8 -- clients/telegram/proposal-store.ts clients/telegram/proposal-engine.ts` — empty (APPROVE-02 zero-diff holds)
- `git diff --stat 561f9c8 -- package.json package-lock.json` — empty (net-zero runtime deps holds)
- `npx vitest run clients/telegram/tests/import-boundary.test.ts` — 3/3 passing, CLIENT-01 holds over every file this phase added

## User Setup Required

None. The belief poll/bridge remains behind its Plan 02 default-OFF gate (`RECENSE_BELIEF_BRIDGE_ENABLED`); enabling it in production is a future operational step, not required for this plan's completion.

## Next Phase Readiness

- All four APPROVE-01..04 requirements are structurally satisfied: APPROVE-01 (apply through the frozen contract with a transition-naming reply), APPROVE-02 (zero-diff on the two frozen files, verified twice), APPROVE-04 (categorical-only confidence, structurally proven absent as a gate)
- Phase 68 (Telegram HITL Belief-Kind Extension) is complete across all three plans — no blockers for the orchestrator's phase-close step
- `proposal-store.ts` and `proposal-engine.ts` remain byte-identical to base commit `561f9c8`

---
*Phase: 68-telegram-hitl-belief-kind-extension*
*Completed: 2026-08-03*

## Self-Check: PASSED

All created files verified present on disk (belief-bridge.ts, index.ts, state.ts,
tests/belief-callback.test.ts, tests/belief-refusal.test.ts,
tests/no-numeric-confidence.test.ts, tests/telegram-belief-e2e.test.ts, this
SUMMARY.md). All 5 task commits verified present in git log (67e822b, be3d114,
1521fc2, b0dec57, 27c87c1).
