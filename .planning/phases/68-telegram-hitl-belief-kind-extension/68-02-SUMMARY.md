---
phase: 68-telegram-hitl-belief-kind-extension
plan: 02
subsystem: bot
tags: [telegram, hitl, approval-fatigue, injection-hardening, batching, vitest]

# Dependency graph
requires:
  - phase: 68-01
    provides: StoredBeliefProposal union member, belief-bridge.ts's toStoredBeliefProposal/beliefLocalId/isBeliefProposal, belief-proposal-client.ts's createBeliefProposalClient/isInspectableProposalRecord/PROPOSAL_SCHEMA_VERSION/ProposalHttpError, and the standing zero-diff hash lock on proposal-store.ts/proposal-engine.ts
provides:
  - v3 belief callback codec (encodeBeliefCallbackData/decodeBeliefCallbackData, 36-byte payload, id-shape validated before use)
  - belief-render.ts — asDisplayText sanitizer, renderBeliefDecisionMessage, beliefKeyboard (structured-fields-only decision surface, transition-labeled buttons)
  - belief-bridge.ts's groupBeliefProposals (entity + local-day batch identity) and runBeliefBridgePass (list/gate/dedup/batch/cap/send/rollback)
  - state.ts's belief prompt ledger (readBeliefPromptLedger/writeBeliefPromptLedger) plus the read-modify-write correctness fix to writeStateCursor/readStateCursor
  - config.ts's beliefBridgeEnabled/beliefPollMs (default-OFF gate)
  - index.ts's beliefPollInFlight guard + runBeliefPollTick + the third setInterval in main()
affects: [68-03]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Structured-fields-only rendering with a whitespace-collapse + length-cap sanitizer (asDisplayText) closing structure-spoofing via forged newline-delimited field lines"
    - "Transition-labeled tap targets (from→to on the button itself) as the automation-bias defense, never a bare 'Approve'"
    - "Entity + local-calendar-day batch identity with a small persisted ledger, mirroring proposal-store.ts's CapState naming symmetry"
    - "Store-first-then-send with rollback-on-send-failure (write before send, remove on throw) so a lost message can never become a permanently suppressed proposal"
    - "Three independent setInterval timers (reactive tick / push / belief poll), each with its own never-shared in-flight guard"

key-files:
  created:
    - clients/telegram/belief-render.ts
    - clients/telegram/tests/belief-render.test.ts
    - clients/telegram/tests/belief-poll.test.ts
  modified:
    - clients/telegram/push-codec.ts
    - clients/telegram/belief-bridge.ts
    - clients/telegram/state.ts
    - clients/telegram/config.ts
    - clients/telegram/index.ts

key-decisions:
  - "The plan's own documented byte budget for the v3 callback payload (37 bytes) was an arithmetic error carried from a pre-existing off-by-one in the v2 codec's doc comment — corrected to the actual measured value (36 bytes) in both the code comment and the test assertion (Rule 1 auto-fix: this is a math fact, not a design choice)"
  - "The belief prompt ledger's local-day key is computed once per pass from the pass's own nowMs, not per-row — batch identity is about how many prompts go out today, not when each underlying email arrived"
  - "Cap-slot exhaustion (tryReserveProposalSlot returning false) stops the WHOLE pass, not just the current group, since a reservation failure this early in a sorted-by-urgency loop means later groups would fail identically"
  - "Send failure rolls back only the failed group's rows and continues to the next group, rather than aborting the whole pass — a single group's transient send failure shouldn't block unrelated entities from being prompted"
  - "runBeliefPollTick reuses the SAME proposal store and daily cap as tool proposals (loadActionConfig().proposalStorePath/proposalDailyCap) — belief prompts count toward the existing cap by design (D-03: fatigue is fatigue)"

patterns-established:
  - "asDisplayText(value, maxLen) as the single sanitization point for every free-text field reaching a Telegram message — never write raw record fields into rendered output"
  - "BeliefBridgeDeps as an injectable-everything dependency object (client, transport, chatIds, storePath, statePath, dailyCap, log, nowMs) — mirrors how Phase 67's syncProposals is driven by both unit tests and a repo-level e2e"

requirements-completed: [APPROVE-01, APPROVE-03, APPROVE-04]

# Metrics
duration: ~55min
completed: 2026-08-03
---

# Phase 68 Plan 02: Belief Decision Surface + Poll Summary

**Built the v3 belief callback codec, a structured-fields-only decision-message renderer whose approve buttons carry the concrete from→to transition, and a new poll pass that batches same-entity same-day server proposals into exactly one Telegram prompt per entity per day — behind its own default-OFF timer with its own never-shared in-flight guard.**

## Performance

- **Duration:** ~55 min
- **Tasks:** 2 completed (both TDD: test-first, then implementation)
- **Files modified/created:** 8 (3 created, 5 modified)

## Accomplishments

- `push-codec.ts` gained a v3 belief callback codec (`3|{32-hex localId}|{code}`, 36 bytes, well under Telegram's 64-byte limit) whose decoder validates the id against `^[0-9a-f]{32}$` before ever using it as a store lookup key — callback_data is attacker-influenceable and this is the one check v2's decoder doesn't need
- `belief-render.ts` renders belief decision messages from structured fields only, with the evidence quote fenced and length-capped; a forged newline-plus-field-line inside a quote collapses to a single harmless line via `asDisplayText`, so it can never be mistaken for a real rendered field (T-68-07 closed)
- Every approve button produced by `beliefKeyboard` states the transition it will apply (`✅ applied → interviewing`) — no bare "Approve" exists on a belief message, closing the automation-bias gap named in PITFALLS.md Pitfall 7
- `runBeliefBridgePass` turns pending server proposals into at most one batched prompt per entity per local day: list → wire-shape gate → schema gate → per-record skip-filters (kind/status) → dedup on the derived local id → group by entity+day → drop already-prompted entities → cap-reserve → store-first → send → roll back on failure. Never throws.
- `state.ts`'s `writeStateCursor` had a latent correctness bug (`JSON.stringify({ cursor })` clobbered every sibling key on every write) — fixed to read-modify-write over the whole document, which is what makes the new belief prompt ledger survive the far-more-frequent reactive-tick cursor writes
- The belief poll runs on its own third `setInterval`, its own `beliefPollInFlight` guard (never shared with `tickInFlight`/`pushInFlight`), and its own default-OFF gate (`RECENSE_BELIEF_BRIDGE_ENABLED`) — a new outbound loop on a live client ships dark until deliberately switched on

## Task Commits

Each task was committed atomically:

1. **Task 1: v3 belief callback codec + structured decision surface** - `57bc6de` (feat)
2. **Task 2: belief poll pass — gates, dedup, batching, cap, own timer** - `a83431c` (feat)
3. **Test strengthening (send-failure rollback, every constituent)** - `8f05e8d` (test)

## Files Created/Modified

- `clients/telegram/push-codec.ts` - v3 belief callback codec (`encodeBeliefCallbackData`/`decodeBeliefCallbackData`)
- `clients/telegram/belief-render.ts` - `asDisplayText`, `renderBeliefDecisionMessage`, `beliefKeyboard`
- `clients/telegram/belief-bridge.ts` - `groupBeliefProposals`, `runBeliefBridgePass`, `toLocalDate` helper
- `clients/telegram/state.ts` - read-modify-write fix + `readBeliefPromptLedger`/`writeBeliefPromptLedger`
- `clients/telegram/config.ts` - `beliefBridgeEnabled`/`beliefPollMs` on `ClientConfig` and `loadClientConfig()`
- `clients/telegram/index.ts` - `beliefPollInFlight` guard, `runBeliefPollTick`, third `setInterval` in `main()`
- `clients/telegram/tests/belief-render.test.ts` - 26 tests
- `clients/telegram/tests/belief-poll.test.ts` - 16 tests

## Decisions Made

- Corrected the plan's stated v3 payload byte budget (37) to the actual measured value (36) — a pre-existing arithmetic pattern already present (uncorrected) in the v2 codec's own doc comment; left the v2 comment untouched as out of scope for this plan
- Chose to continue processing remaining groups after a single group's send failure, rather than aborting the whole pass, since the plan's action spec only mandates per-group rollback and doesn't require a full-pass abort on transient network failure
- Cap-slot exhaustion stops the entire pass (matches the plan's explicit "stop bridging for this pass" instruction), distinct from send-failure's per-group continue

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] v3 callback payload byte-budget arithmetic corrected**
- **Found during:** Task 1
- **Issue:** The plan's action text and behavior bullet both stated the v3 payload (`3|{32-hex}|{code}`) is 37 bytes. Direct computation (and a failing test) showed the actual value is 36 bytes — the plan's arithmetic mirrored a pre-existing off-by-one already present in the v2 codec's doc comment (`2 + 36 + 1 + 2 separators = 41` for a format that actually measures 40 bytes).
- **Fix:** Documented and asserted the correct value (36 bytes) in both `push-codec.ts`'s doc comment and the test; left v1/v2 doc comments untouched (out of scope, pre-existing, not part of this plan's files).
- **Files modified:** `clients/telegram/push-codec.ts`, `clients/telegram/tests/belief-render.test.ts`
- **Verification:** `npx vitest run clients/telegram/tests/belief-render.test.ts` passes; both assertions (`<= 64`, exact `36`) are green.
- **Committed in:** `57bc6de` (part of Task 1 commit)

**2. [Rule 1 - Bug] `parse_mode` literal in a doc comment tripped the acceptance-criteria grep**
- **Found during:** Task 1
- **Issue:** `belief-render.ts`'s own doc comment explaining the T-68-07 mitigation used the phrase "sets no parse_mode", which the acceptance criteria's `grep -c "parse_mode"` (required to return 0) would match.
- **Fix:** Reworded the sentence to convey the same fact ("sends plain text with no markup mode set") without using the literal substring.
- **Files modified:** `clients/telegram/belief-render.ts`
- **Verification:** `grep -c "parse_mode" clients/telegram/belief-render.ts clients/telegram/push-codec.ts` returns 0 for both.
- **Committed in:** `57bc6de` (part of Task 1 commit)

## Issues Encountered

None. Worktree base needed correction on start (`git reset --hard` to `46c6d28`) per the worktree branch check protocol — expected per-agent-worktree behavior, not a plan issue.

## User Setup Required

None. The belief poll ships default-OFF; enabling it in production is a future operational step (set `RECENSE_BELIEF_BRIDGE_ENABLED=true`), not required for this plan's completion.

## Next Phase Readiness

- `renderBeliefDecisionMessage`, `beliefKeyboard`, `runBeliefBridgePass`, `groupBeliefProposals`, `runBeliefPollTick`, and the belief prompt ledger are all in place for Plan 03 (callback dispatch: approve/reject/edit-short-circuit handling, approval-rate self-report) to consume
- `proposal-store.ts` and `proposal-engine.ts` remain byte-identical to base commit `561f9c8`, verified by `git diff --stat` — Plan 03 must preserve this invariant
- The v3 callback codec (`decodeBeliefCallbackData`) is ready for Plan 03's `callback_query` dispatch branch (mirroring the existing `1|`/`2|` version-prefix routing in `index.ts`) but is not yet wired into that dispatch loop — that wiring is Plan 03's Task
- No blockers for downstream plans in this phase

---
*Phase: 68-telegram-hitl-belief-kind-extension*
*Completed: 2026-08-03*

## Self-Check: PASSED

All created files verified present on disk (belief-render.ts, tests/belief-render.test.ts,
tests/belief-poll.test.ts, this SUMMARY.md, deferred-items.md).
All 3 commits verified present in git log (57bc6de, a83431c, 8f05e8d).
