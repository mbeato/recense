---
phase: 68-telegram-hitl-belief-kind-extension
reviewed: 2026-08-03T14:15:00Z
depth: standard
files_reviewed: 13
files_reviewed_list:
  - clients/telegram/types.ts
  - clients/telegram/index.ts
  - clients/telegram/belief-proposal-client.ts
  - clients/telegram/belief-bridge.ts
  - clients/telegram/belief-render.ts
  - clients/telegram/push-codec.ts
  - clients/telegram/state.ts
  - clients/telegram/config.ts
  - clients/telegram/tests/belief-render.test.ts
  - clients/telegram/tests/belief-poll.test.ts
  - clients/telegram/tests/belief-callback.test.ts
  - clients/telegram/tests/no-numeric-confidence.test.ts
  - tests/telegram-belief-e2e.test.ts
findings:
  critical: 1
  warning: 6
  info: 7
  total: 14
status: issues_found
---

# Phase 68: Code Review Report

**Reviewed:** 2026-08-03T14:15:00Z
**Depth:** standard
**Files Reviewed:** 13
**Status:** issues_found

## Summary

Reviewed the Phase 68 Telegram HITL belief-kind extension: the `StoredProposal` discriminated union, the belief bridge poll pass, the v3 callback codec, the decision handler with refusal mapping, the render surface, and the state/ledger machinery. All 57 phase tests pass (verified by running them, including the repo-level e2e against a real `createBrainHttpServer`).

The security-critical surfaces requested in the phase context hold up well:

- **Evidence-quote injection**: `DefaultTelegramTransport.sendMessage` sets no `parse_mode` (transport.ts:113-124), so markdown/HTML in an attacker-influenced quote cannot execute. Structure spoofing (forged field lines) is closed by `asDisplayText`'s whitespace collapse + caps, and is directly tested (belief-render.test.ts:176-198).
- **Callback forgery / cross-kind confusion**: v1/v2/v3 codecs are mutually exclusive by version prefix and part count; v3 validates the id against `^[0-9a-f]{32}$` before it becomes a store key; both cross-kind guards exist and are tested (T-68-01 in `executeStoredProposal`/`handleEditPatch`/`handleProposalAction`; T-68-13 in `handleBeliefProposalAction`). Allowlist is checked before any decoder runs.
- **64-hex id gate**: enforced client-side before path interpolation (belief-proposal-client.ts:95, 184, 195) and server-side (serve-cli.ts:555). Refusal mapping (503 retryable / 400,404,409 terminal / 401 + others neutral) matches the server's real emitted statuses (serve-cli.ts:576-601), verified by cross-reading.
- **Dark knob**: `beliefBridgeEnabled` gates both `main()`'s timer creation and `runBeliefPollTick`'s first line; `loadActionConfig()` is not called before the gate; tested (belief-poll.test.ts W2).
- **No numeric confidence**: structural scan is non-vacuous (MIN_SCANNED_FILES floor) with planted offenders.

However, the batching/render pipeline has one provable blocker (message-length overflow → permanent retry loop that drains the shared daily cap) and several correctness defects in the ledger, ordering, and failure paths detailed below.

## Critical Issues

### CR-01: Rendered group message can exceed Telegram's 4096-char limit → permanent send-fail/rollback/retry loop that drains the shared daily cap

**File:** `clients/telegram/belief-render.ts:83-111` (no total-length bound), `clients/telegram/belief-bridge.ts:310-343` (retry + cap-slot burn)
**Issue:** `renderBeliefDecisionMessage` bounds each *field* (ENTITY_CAP=80, TRANSITION_CAP=60, QUOTE_CAP=280) but never bounds the *total* message. At the module's own caps, a 10-constituent group renders **5,473 characters** (empirically verified) — 1,377 over Telegram's hard 4,096-char `sendMessage` limit. Telegram returns 400; `DefaultTelegramTransport.sendMessage` throws; the bridge's catch rolls back all rows and `continue`s. The next pass (every 5 min) re-bridges the identical group, reserves **another** cap slot (`tryReserveProposalSlot` at line 311, never released on rollback), and fails identically. Consequences: (1) the group is never surfaced to the human for its entire lifetime — the HITL decision is silently lost and the proposals expire server-side; (2) each failed attempt permanently consumes one slot of the daily cap that is *shared with tool proposals* (BeliefPollTestHooks doc, index.ts:1403), so within `dailyCap` passes (~50 min at defaults) the entire proposal pipeline is capped out for the day, every day, until the oversized group expires. This is reachable with realistic data: 10 same-entity emails in a day (the exact scenario batching exists for) with evidence quotes hitting the 280 cap and long descriptors. MockTelegramTransport does not model the length limit, so no test catches it.
**Fix:** Bound the total. Either cap the rendered message (truncate constituents until `text.length <= 4096`, moving the remainder into the existing overflow line), or lower `MAX_GROUP_CONSTITUENTS`/`QUOTE_CAP` so the worst case fits (e.g., 6 constituents at current caps ≈ 3,300 chars). Belt-and-suspenders in the bridge:
```typescript
// belief-bridge.ts, before sendMessage
const TELEGRAM_MAX_TEXT = 4096;
let capped = [...group.rows].sort(byDueAt).slice(0, MAX_GROUP_CONSTITUENTS);
let text = renderBeliefDecisionMessage(capped);
while (text.length > TELEGRAM_MAX_TEXT && capped.length > 1) {
  capped = capped.slice(0, capped.length - 1);
  text = renderBeliefDecisionMessage([...capped, ...overflowMarkerRows]);
}
```
Additionally, distinguish a non-retryable send failure (HTTP 400) from a transient one so a poison group cannot burn a cap slot per pass forever.

## Warnings

### WR-01: Ledger uses a plain object as a map — entities named after `Object.prototype` keys are silently suppressed forever

**File:** `clients/telegram/belief-bridge.ts:297-300, 341`; `clients/telegram/state.ts:14, 78`
**Issue:** `ledgerCounts` is a plain-object spread (`{ ...ledger.counts }`), and eligibility is `(ledgerCounts[g.entityDescriptor] ?? 0) === 0`. For an `entityDescriptor` equal to any inherited property name — `'constructor'`, `'toString'`, `'valueOf'`, `'hasOwnProperty'`, `'__proto__'`, etc. — the lookup returns the inherited function/object (not `undefined`), `?? 0` never fires, the value `!== 0`, and the group is dropped as "already prompted." Because the inherited property exists on every fresh pass, proposals for such an entity are **never surfaced, on any day** — a silent, permanent HITL bypass. `entityDescriptor` is derived from external email content upstream, so this is attacker-influenceable in principle, and it is a plain correctness bug regardless.
**Fix:** Use own-property semantics:
```typescript
const count = Object.hasOwn(ledgerCounts, g.entityDescriptor) ? ledgerCounts[g.entityDescriptor] : 0;
```
or store counts in a `Map`/`Object.create(null)` internally (serializing to entries on write).

### WR-02: Message numbering and keyboard row order can diverge — numbered block N may not correspond to keyboard row N

**File:** `clients/telegram/belief-bridge.ts:319-321` vs `clients/telegram/belief-render.ts:84-88, 128`
**Issue:** The bridge sorts constituents by **earliest `dueAt`** before capping, and `beliefKeyboard` preserves that order (plain `slice`). But `renderBeliefDecisionMessage` re-sorts the same array by **`serverCreatedAtMs` ascending** before numbering the blocks. Whenever created-order ≠ expiry-order (server TTLs are uniform today, so the orders coincide by accident — but nothing enforces that), the message's "1./2./3." blocks no longer line up with keyboard rows 1/2/3. The transition-on-button mitigation (D-05) weakens here: button labels are truncated to 24 chars per side, so two same-entity constituents with the same from→to (different underlying beliefs) render *identical* button labels, making the tap ambiguous exactly when order correspondence matters.
**Fix:** Use one ordering for both. Either have the bridge pass the render-order (sort by `serverCreatedAtMs` in the bridge and let render/keyboard both preserve input order), or have `beliefKeyboard` apply the same `serverCreatedAtMs` sort as the renderer:
```typescript
const constituents = [...group].sort((a, b) => a.serverCreatedAtMs - b.serverCreatedAtMs).slice(0, MAX_CONSTITUENTS);
```

### WR-03: Crash window between successful POST and local terminal write produces a false "nothing was applied" reply and a skewed `refused` counter

**File:** `clients/telegram/belief-bridge.ts:484-534` (and the false claim in the docstring at 420-424)
**Issue:** On approve, the order is: `client.approve()` (network) → `putProposal({...row, localStatus:'terminal'})`. If the process dies after the POST commits server-side but before the local write, the row is still `pending` on restart. The user's next tap re-POSTs, the server returns a genuine 409 (`transitionFromPending` CAS), and the handler maps it terminally with the reply **"that belief moved on — nothing was applied"** — false: the user's own earlier approve *did* apply — and increments `refused`, permanently skewing the approval-rate self-report (D-09's whole point is that these counters be honest). The function's docstring explicitly claims "there is no crash-resumed pending row whose earlier POST might already have succeeded" — that claim is exactly wrong for this window. The e2e test (telegram-belief-e2e.test.ts:239-264) constructs this precise state (terminal→pending reset) and asserts the misleading message as correct behavior.
**Fix:** Soften the 409 reply to be truthful in both cases (e.g., "that proposal was already settled server-side — no new change was applied") and either count 409 separately from genuine refusals or exclude 409-on-approve-of-own-row from `refused`. Correct the docstring.

### WR-04: Partial multi-chat send failure rolls back rows that a delivered message already references, then re-prompts

**File:** `clients/telegram/belief-bridge.ts:329-339`
**Issue:** The per-group send loop iterates all `chatIds` inside a single try. If `sendMessage` succeeds for chat A and throws for chat B, the catch removes **all** rows for the group. Chat A now holds a live keyboard whose buttons reference deleted rows — violating the store-first invariant this very function documents ("no button can ever reference a missing row"); taps yield "that proposal is no longer available." The next pass re-bridges (dedup finds nothing) and sends chat A a duplicate prompt. With one allowlisted chat (the current deployment) this is unreachable, but the code explicitly supports multiple chats.
**Fix:** Track per-chat delivery and only roll back when **zero** chats received the message; or send to all chats collecting failures and treat any success as delivered (rely on the ledger for dedup):
```typescript
let delivered = 0;
for (const chatId of chatIds) {
  try { await transport.sendMessage(chatId, text, keyboard); delivered++; }
  catch (err) { log('belief bridge: send failed for chat: ' + String(err)); }
}
if (delivered === 0) { for (const row of capped) removeProposal(row.id, storePath); continue; }
```

### WR-05: Wire-shape gate checks key presence only; the type validation the client contract delegates to the caller is never performed

**File:** `clients/telegram/belief-proposal-client.ts:80-84`; `clients/telegram/belief-bridge.ts:269-291, 324-326`
**Issue:** `isInspectableProposalRecord` documents "Does NOT validate value types — that is the caller's job once the shape gate passes," but `runBeliefBridgePass` (the caller) never validates value types either. A record with a non-string `id` throws in `beliefLocalId` (`.slice` on a number); worse, a non-string `entity_descriptor` survives `toStoredBeliefProposal` and `putProposal`, then throws inside `renderBeliefDecisionMessage` → `asDisplayText` (`value.replace` on a number) — **after** the rows are persisted. The throw escapes `runBeliefBridgePass` (violating its own "never throws" contract; only `runBeliefPollTick`'s belt-and-suspenders catch saves the timer — direct callers like the e2e harness are unprotected), the rows are never rolled back, and on every subsequent pass the dedup check silently drops the proposal: never prompted, never cleaned until expiry. The server is a trusted peer, but the module's entire fail-closed gate design (steps 2-3 stop-the-pass) exists precisely because the wire is not assumed well-formed.
**Fix:** Extend the gate to value types for the fields the bridge actually consumes (strings: `id` matching `^[0-9a-f]{64}$`, `entity_descriptor`, `change_field`, `change_to`, `evidence_quote`; `change_from` string|null; numbers: `created_at`, `expires_at`, `schema_version`; enums: `kind`, `status`, `confidence`) — either in `isInspectableProposalRecord` or as a bridge-side `isUsableRecord` filter applied at step 2.

### WR-06: A cap slot is consumed per failed send attempt and never released — a Telegram outage drains the shared daily cap with zero prompts delivered

**File:** `clients/telegram/belief-bridge.ts:311-338`
**Issue:** `tryReserveProposalSlot` is called before the send; on send failure the rows are rolled back and the ledger left untouched (correct), but the cap increment is permanent. Each 5-minute retry pass burns another slot for the same group. During a sustained Telegram/network outage the shared daily cap (default 10) exhausts within ~50 minutes, halting the rest of the belief pass (`return` on false) **and** starving the tool-proposal path that shares the same counter — all with zero prompts actually reaching the human. For tool proposals, counting *generated* proposals is deliberate (H-15 fatigue DoS — an LLM call happened); for belief prompts, the doc says "one slot per PROMPT, since fatigue is measured in prompts," yet a failed send consumes a slot without a prompt and without any LLM cost to account for. This is the same mechanism CR-01 rides; it deserves its own fix because it triggers on any transient outage, not just oversized messages.
**Fix:** Reserve the slot only after a successful send (there is no DeepSeek-call-cost rationale on this path), or add a `releaseProposalSlot`-equivalent decrement on the rollback path. If the frozen store forbids a release API, move the reservation after `sendMessage` succeeds — the fatigue invariant (prompts/day) is measured at delivery on this path.

## Info

### IN-01: Dead exported type `ProposalStatus` in types.ts

**File:** `clients/telegram/types.ts:152`
**Issue:** `ProposalStatus` is exported here and also (independently) in belief-proposal-client.ts:23. The types.ts copy is imported by nothing in the client (verified by grep); `StoredBeliefProposal.localStatus` uses an inline `'pending' | 'terminal'` union instead.
**Fix:** Remove the types.ts declaration or reference it from `StoredBeliefProposal`'s doc; two hand-copies of the same vocabulary in one directory invite drift.

### IN-02: `ActionProposalRecord` hand-duplicated inside the client directory

**File:** `clients/telegram/belief-bridge.ts:58-75`
**Issue:** belief-bridge.ts declares and exports its own 16-field `ActionProposalRecord` while simultaneously importing the identical type from belief-proposal-client.ts (as `ClientActionProposalRecord`, line 22). CONSUME-02/CLIENT-01 forbid importing from `src/`, not from a sibling client module — the second copy is pure intra-directory duplication that TS only keeps aligned structurally. `toStoredBeliefProposal` takes the local copy but is called with the client copy; a drift would surface as a confusing structural-typing error, not a clear one.
**Fix:** Delete the local declaration and re-export the client's type (`export type { ActionProposalRecord } from './belief-proposal-client';`) so tests keep their import path.

### IN-03: `beliefBridgeEnabled=false` gates only the poll timer — the '3|' decision handler stays live

**File:** `clients/telegram/index.ts:446-464`
**Issue:** With the knob off, no prompts are ever bridged (verified: `runBeliefPollTick` returns before `loadActionConfig`/`listProposals`), so in a clean deployment the '3|' branch only ever no-ops (`loadExecutable` → missing → "no longer available", no HTTP). But rows bridged while the knob was ON remain actionable after it is turned OFF — taps still POST approve/reject to the server. Likely intended (finish in-flight decisions), but it is an undocumented asymmetry in the "nothing runs when disabled" story.
**Fix:** Add one sentence to the v3-branch comment stating that previously-bridged rows remain decidable after the knob is disabled, or gate the branch on `config.beliefBridgeEnabled` if strict-dark is the intent.

### IN-04: `asDisplayText` can split a surrogate pair at the truncation boundary

**File:** `clients/telegram/belief-render.ts:60`
**Issue:** `collapsed.slice(0, maxLen - 1)` is a UTF-16 code-unit slice; a cap landing mid-astral-character (emoji in an evidence quote) yields a lone surrogate, which `JSON.stringify` escapes as an unpaired `\udXXX` — Telegram may reject the payload or render a replacement char.
**Fix:** `[...collapsed].slice(0, maxLen - 1).join('')` or trim a trailing lone high surrogate before appending the ellipsis.

### IN-05: Timezone-dependent assertions in belief-poll.test.ts

**File:** `clients/telegram/tests/belief-poll.test.ts:269, 286-287`
**Issue:** `nowMs = Date.parse('2026-08-03T12:00:00.000Z')` is asserted to produce local-day `'2026-08-03'` via `toLocalDate` (local timezone). On machines at UTC+12:30 or later (e.g., Pacific/Auckland DST edge, Kiritimati) the local day is 2026-08-04 and the test fails. Flaky-under-environment pattern.
**Fix:** Compute the expected string with the same local conversion the code uses (`toLocalDate(new Date(day1))`-equivalent inline) instead of a hardcoded literal, or pin an instant that is the same calendar day in every UTC offset (there is none for ±14h — so compute, don't hardcode).

### IN-06: Forged v2 snooze on a belief row lacks the T-68-01 guard (audit-noise only)

**File:** `clients/telegram/index.ts:1141-1146`
**Issue:** `handleProposalAction`'s snooze branch writes `hitlEpisode({decision:'snooze'})` without loading the row, so a forged `2|{beliefLocalId}|s` callback records a tool-flow snooze audit against a belief row. No state change, no execution — the approve/reject/edit branches are all guarded — but the audit trail can carry a mislabeled decision for a belief proposal.
**Fix:** Optionally load + kind-check before auditing in the snooze branch for audit-trail hygiene.

### IN-07: A permanently malformed `serverProposalId` is indistinguishable from "memory busy"

**File:** `clients/telegram/belief-bridge.ts:540-544`; `clients/telegram/belief-proposal-client.ts:184-186`
**Issue:** If a stored row's `serverProposalId` fails the 64-hex gate (corrupted store, or WR-05's missing type validation letting a bad id through), `client.approve` throws a plain `Error`, which the handler maps to the neutral retryable branch ("could not record that decision — try again in a moment"). The user can tap forever; the row never resolves until expiry. Fail-closed direction, but a permanent-failure row masquerades as a transient one.
**Fix:** Pre-validate `row.serverProposalId` against `^[0-9a-f]{64}$` in the handler and map a mismatch to the terminal refusal path.

---

_Reviewed: 2026-08-03T14:15:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
