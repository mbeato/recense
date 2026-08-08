---
phase: v10-cross-review-proposal-pipeline
reviewed: 2026-08-07T00:00:00Z
depth: deep
files_reviewed: 28
files_reviewed_list:
  - src/source/gmail-adapter.ts
  - src/source/provenance-key.ts
  - src/model/claim-extractor.ts
  - src/consolidation/consolidator.ts
  - src/consolidation/entity-resolution.ts
  - src/consolidation/status-drift.ts
  - src/consolidation/update-decision.ts
  - src/consolidation/action-proposal-sink.ts
  - src/consolidation/run-sleep-pass.ts
  - src/db/action-proposal-store.ts
  - src/db/schema.ts
  - src/adapter/serve-cli.ts
  - src/adapter/memory-ops.ts
  - src/adapter/lockfile.ts
  - src/strength/decay.ts
  - src/lib/config.ts
  - clients/proposal-reference/proposal-client.ts
  - clients/proposal-reference/local-store.ts
  - clients/proposal-reference/index.ts
  - clients/proposal-reference/config.ts
  - clients/telegram/belief-bridge.ts
  - clients/telegram/belief-proposal-client.ts
  - clients/telegram/belief-render.ts
  - clients/telegram/types.ts
  - clients/telegram/proposal-store.ts
  - clients/telegram/push-codec.ts
  - clients/telegram/state.ts
  - clients/telegram/index.ts
findings:
  critical: 1
  warning: 7
  info: 3
  total: 11
status: fixed
fixed_at: 2026-08-07
---

# Cross-Phase Code Review: Proposal Pipeline (Phases 62–68)

**Reviewed:** 2026-08-07
**Depth:** deep (cross-file, end-to-end field-conservation and predicate-parity trace)
**Files Reviewed:** 28 source files + 11 test files assessed for composed vacuousness
**Status:** issues_found

## Summary

I traced the proposal surface end to end — gmail ingest → classification → entity resolution
→ status-drift gate → `maybeEmitProposal` → `action_proposal` → `/v1/proposals` → both
consumers — looking specifically for the interaction defects a per-phase review cannot see.
The per-hop engineering is genuinely careful; the defects I found are all at seams where two
phases each did their own half correctly and nobody owns the join.

The one Critical finding is a predicate-parity break between the read filter and the
approve-time gate: `ActionProposalStore.listPending` filters expired rows but **not**
tombstoned entity/belief nodes, while `classifyProposalStaleness` refuses all three. Every
proposal whose entity or belief node has been tombstoned by ordinary reconsolidation keeps
being listed, keeps being rendered to a human, keeps burning the Telegram bridge's
one-prompt-per-entity-per-day budget and a daily-cap slot, and is guaranteed to 409 on the
tap — for up to the full 14-day TTL. The `WR-03` comment inside `listPending` argues in
detail why dead rows must be filtered from the read; the identical argument applies verbatim
to tombstoned rows and was not applied.

The remaining Warnings cluster into three families: **list-window starvation** (the 100-row
oldest-first window plus a human-gated consumer that only settles what gets tapped),
**guard-set asymmetry** (the two clients' "same" wire-shape gates are not the same — the
reference adapter's is presence-only and lets it persist a row it will later refuse to read,
permanently bricking itself), and **unlocked "locked" contracts** (the `proposalId` encoding
and the emission-eligibility predicate are both documented as locked but nothing enforces
either).

### Verified safe (suspected mismatches that turned out fine)

I chased these and they hold — recording them so a later reviewer does not re-spend the time:

- **Expiry semantics across the hop.** Server: `expires_at > now` to list, `expires_at <= now`
  to refuse. Telegram: `dueAt = ISO(expires_at)`, `createdAt = ISO(nowMs)`,
  `maxTtlMs = expires_at - nowMs`, so both of `isExpired`'s OR-conditions collapse to
  `now > expires_at`. The two sides agree to within one millisecond of boundary convention.
- **Proposal id shape across the hop.** `proposalId` produces 64 lowercase hex; serve
  re-validates `^[0-9a-f]{64}$` before any store call; both clients re-validate before
  building a path; `beliefLocalId` truncates to exactly 32 hex, which is precisely
  `BELIEF_ID_RE` in `push-codec.ts`. The `3|{id}|{code}` payload round-trips.
- **Writer/settler mutual exclusion.** The scheduler tick (`recense-scheduler.ts:202`) and
  `approveProposal`/`rejectProposal` (`memory-ops.ts:588,655`) take the *same* O_EXCL
  lockfile, so the sleep pass cannot insert while a settle is mid-transition. The CAS
  `AND status = 'pending'` in `transitionFromPending` closes the in-process approve/reject
  race, and `proposal-settle-race.test.ts` genuinely exercises it (the pre-lock reads run
  synchronously before either await, so the interleaving is real, not simulated).
- **Self-confirmation (D-43) via the HITL audit loop.** `hitlEpisode` posts
  `source: 'hitl'`, `validateSource` allowlists only that literal, and the consolidator hard
  stops on `episode.source === 'hitl'` at both `consolidator.ts:113` and `:767`. A belief
  approval cannot feed back into the belief it approves.
- **`dampByConfidence(x, 'low') === 0` routing.** `routeContradiction` divides by
  `Math.max(resistance, EPS)`, so magnitude 0 yields ratio 0, not NaN, and lands in `hold`
  for every resistance. The status-drift header's claim is accurate.
- **`provenance_key` field conservation.** `gmail-adapter.ts:590` → `NormalizedRecord` →
  `ingest-cli.ts:202` (`sessionId: r.provenance_key ?? ...`) → `episode.session_id` →
  `countDistinctProvenance`. No hop drops it.
- **`WR-01` fail-closed staleness.** `getStalenessInputs` returning null classifies as
  `entity_gone`, not `ok`; `proposal-settle-race.test.ts:162` proves it with a real
  FK-off hard delete.

---

## Critical Issues

### CR-01: `listPending` filters expiry but not tombstones — the read filter and the approve gate disagree

**File:** `src/db/action-proposal-store.ts:160-165` (read filter) vs `:108-114` (refusal
classifier), consumed at `src/adapter/memory-ops.ts:570-572` and both clients.

**Issue:** `classifyProposalStaleness` refuses an approve on three grounds, in fixed
precedence: `entity_gone` (entity node tombstoned), `superseded` (belief node tombstoned),
`expired` (past TTL). The list endpoint that feeds every consumer filters exactly one of
those three:

```sql
SELECT * FROM action_proposal
WHERE status = 'pending' AND expires_at > @now
ORDER BY created_at ASC
LIMIT @limit
```

There is no join to `node` and no `tombstoned` predicate, even though the store already
builds exactly that join one statement later for `getStalenessInputs`
(`action-proposal-store.ts:174-182`).

A tombstoned belief is not a rare edge case — it is the *normal* outcome of the very
mechanism that emits proposals. `applyDecision`'s reconcile branch tombstones the candidate
and mints a new node (`consolidator.ts:1573-1581`), and the next contradiction against that
same entity tombstones the node the *previous* proposal named as `belief_node_id`. So the
steady state for any entity receiving repeated status mail is: proposal N is emitted, then
proposal N+1's write tombstones proposal N's belief node, and proposal N stays `pending` and
stays listed.

Downstream consequences, each verified in the consuming code:

1. `runBeliefBridgePass` filters on `r.kind === 'belief' && r.status === 'pending'`
   (`belief-bridge.ts:289`) and nothing else — it has no way to know the belief is gone. It
   stores the row, renders a decision card, and sends it to the human.
2. Delivering that card calls `tryReserveProposalSlot` (`belief-bridge.ts:392`), consuming a
   slot from the daily cap **shared with the tool-proposal path**, and increments the
   entity's ledger (`:396`), which structurally blocks any *other* proposal for that entity
   for the rest of the local day (`:316`).
3. The human taps approve, the POST returns 409, and the row is parked as
   `needs_reconciliation` (`belief-bridge.ts:589-599`) — a state the code itself describes
   as requiring a human to reconcile against the server.
4. The `proposal-reference` adapter marks the row `refused` with reason `conflict`
   (`index.ts:256-264`), a terminal state, and reports it in `SyncReport.refused`.

This is the same failure the `WR-03` comment inside `listPending` was written to prevent —
"without this filter, >= LIMIT accumulated expired rows would permanently hide every newer
proposal from the only list endpoint" — reintroduced through the two refusal reasons that
comment did not cover.

**Fix:** extend the list statement with the same join `getStalenessInputs` already uses, so
the read filter is the exact complement of the refusal classifier. This keeps `listPending`
read-only and lock-free (no lazy UPDATE sweep), preserving the property the WR-03 comment
depends on:

```sql
SELECT p.* FROM action_proposal p
JOIN node e ON e.id = p.entity_node_id
JOIN node b ON b.id = p.belief_node_id
WHERE p.status = 'pending'
  AND p.expires_at > @now
  AND e.tombstoned = 0
  AND b.tombstoned = 0
ORDER BY p.created_at ASC
LIMIT @limit
```

The INNER JOIN also inherits the `WR-01` fail-closed property for free: a proposal orphaned
by a hard-deleted node row drops out of the list rather than being surfaced and then refused.
Add a test asserting `listPending()` excludes a row whose `belief_node_id` is tombstoned and
one whose `entity_node_id` is tombstoned — `proposal-routes.test.ts:302` and `:310` already
build both fixtures for the approve path and can be reused.

---

## Warnings

### WR-01: 100-row oldest-first window plus a human-gated consumer = head-of-line starvation

**File:** `src/db/action-proposal-store.ts:36,160-165,199-203`; consumer at
`clients/telegram/belief-bridge.ts:326-335`.

**Issue:** `PROPOSAL_LIST_LIMIT = 100`, ordering is `created_at ASC`, and nothing ages a
pending row out except its 14-day TTL. Phase 66 chose that shape as a DoS bound when the
only imagined consumer settled everything it listed. Phase 68's consumer does not: it prompts
**one entity per local day** (`belief-bridge.ts:316`), stops the whole pass when the shared
daily cap is reached (`:332-335`), and settles a row only when a human actually taps a button.
Rows nobody taps stay `pending` and stay in the window.

Once 100 unsettled pending rows accumulate, `listPending` returns the same 100 oldest rows on
every poll and **no newer proposal is visible to either consumer at all** until the old ones
age out — 14 days each, and self-sustaining if the arrival rate exceeds the tap rate. The
highest-value transition (an `offer`) is exactly the one most likely to be hidden behind a
backlog of stale `applied` rows.

This is separate from CR-01: it bites even when every referenced node is live. CR-01 makes it
arrive sooner.

**Fix:** the minimum honest change is to stop letting unattended rows hold the window
indefinitely. Either (a) add a lazy expiry transition so a pending row past a *shorter*
attention TTL settles to `expired` rather than lingering, or (b) change the ordering to
surface the newest N alongside the oldest N so a backlog cannot fully mask new arrivals. If
neither is acceptable this milestone, at minimum expose the count of pending rows beyond the
limit in the response so a consumer can detect starvation instead of silently believing it
has seen everything:

```ts
// action-proposal-store.ts
countPending(): number {
  return (this.stmtCountPending.get({ now: this.clock.nowMs() }) as { n: number }).n;
}
// serve-cli.ts GET /v1/proposals
jsonOk(res, { items, total_pending: await ops.countPendingProposals() });
```

### WR-02: reference adapter's wire-shape gate is presence-only, and its write path can poison its own store permanently

**File:** `clients/proposal-reference/index.ts:81-95` vs
`clients/telegram/belief-proposal-client.ts:70-91`; write at
`clients/proposal-reference/index.ts:191-203`; read at
`clients/proposal-reference/local-store.ts:83-124`.

**Issue:** The two clients implement the same declared guard against the same declared trust
boundary, and they are not the same guard. Telegram's checks value *types* on all sixteen
fields, including `PROPOSAL_ID_RE.test(r['id'])`. The reference adapter's checks key
*presence* only:

```ts
function isInspectableRecord(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return REQUIRED_RECORD_KEYS.every(k => k in r);
}
```

So a list response carrying `"id": 12345` or `"entity_descriptor": null` passes. The loop then
builds a `LocalRow` from those values (`index.ts:191-200`) and calls `putLocalRow`, which
validates only the *pre-existing* rows it reads (`local-store.ts:171`) and never the row it
is about to write. The row is persisted.

On the next sync, `readRows` runs `isLocalRow` over that row, `typeof r['proposalId'] === 'string'`
is false, and the store throws `LocalStoreCorruptError` — which `syncProposals` deliberately
re-throws rather than handling (`index.ts:214-219`), aborting every future sync until a human
inspects or restores the file. The adapter writes a row it has permanently guaranteed itself
it cannot read.

The write path's guard set and the read path's guard set must be one source.

**Fix:** validate on the way in, with the same type checks the read path enforces. The
cleanest version reuses the sibling's already-written predicate shape:

```ts
function isInspectableRecord(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r['id'] === 'string' && /^[0-9a-f]{64}$/.test(r['id']) &&
    typeof r['kind'] === 'string' &&
    typeof r['entity_descriptor'] === 'string' &&
    typeof r['change_field'] === 'string' &&
    typeof r['change_to'] === 'string' &&
    (r['confidence'] === 'high' || r['confidence'] === 'medium' || r['confidence'] === 'low') &&
    typeof r['schema_version'] === 'number'
  );
}
```

### WR-03: `applySecondaryContradiction` tombstones beliefs without emitting a proposal

**File:** `src/consolidation/consolidator.ts:1781-1855` (no `maybeEmitProposal` call) vs
`src/consolidation/status-drift.ts:180-188` (the eligibility predicate).

**Issue:** `EMISSION_ELIGIBLE_EVENT_TYPES` is documented as the structural seam Phase 66 must
gate on, and `maybeEmitProposal` correctly imports it rather than re-deriving the set. But
`applySecondaryContradiction` emits three of those three eligible event types —
`contradict_reconcile` (`:1786`), `contradict_append_new` (`:1798`),
`contradict_force_destabilize` (`:1832`) — and never calls `maybeEmitProposal`. Five call
sites funnel through the gate; three emit eligible events around it.

`66-04-PLAN.md:196` records the decision ("secondaries never mint, and D-05 ... gets no gate
call either"), so this is deliberate, not an oversight. But the stated rationale does not
cover what the code actually does: the reconcile branch calls `this.store.tombstone(nodeId)`
(`:1784`) and the force-destabilize branch calls it again (`:1830`). A live belief is retired
with no proposal, no HITL surface, and no consumer notification. "Never mints" and "never
changes a belief" are not the same claim.

**Fix:** either emit for the two tombstoning branches, or make the exclusion explicit and
testable rather than implicit in an absent call. If the intent is genuinely to exclude them,
the honest form is a named predicate the reviewer can see:

```ts
// status-drift.ts — make the scope of the seam explicit
/** Secondary (non-primary) contradiction outcomes are deliberately outside the proposal
 *  seam: they carry no new value, so a proposal could not name a from→to transition. */
export const SECONDARY_EMISSION_EXCLUDED = true;
```

and a test asserting zero `action_proposal` rows for a multi-`contradicted_ids` verdict, so
the decision cannot silently invert later. `action-proposal-emission.test.ts` has the harness
for it but no such case.

### WR-04: `schema_version` is the whole-DB version, so any unrelated schema bump silently disables both consumers

**File:** `src/consolidation/action-proposal-sink.ts:139` (`schema_version: SCHEMA_VERSION`);
gates at `clients/proposal-reference/index.ts:151-159` and
`clients/telegram/belief-bridge.ts:282-286`; constants at
`clients/proposal-reference/proposal-client.ts:34` and
`clients/telegram/belief-proposal-client.ts:30`.

**Issue:** The sink stamps `SCHEMA_VERSION` from `src/db/schema.ts` — the version of the
*entire database schema* (currently 17), bumped for any DDL change anywhere. Both consumers
hard-code `PROPOSAL_SCHEMA_VERSION = 17` and treat any mismatch as a stop-the-whole-pass
condition that applies nothing:

```ts
const badSchema = records.find(r => r.schema_version !== PROPOSAL_SCHEMA_VERSION);
if (badSchema !== undefined) { log(...); return report; }
```

So adding an unrelated table in Phase 70 bumps `SCHEMA_VERSION` to 18, and both consumers stop
processing every proposal — with the `action_proposal` contract itself byte-unchanged. The
version being gated on is not the version of the thing being versioned.

There is a tripwire: `telegram-belief-e2e.test.ts:147` and `proposal-reference-e2e.test.ts:155`
both seed `schema_version: SCHEMA_VERSION` while the clients compare against the literal 17,
so a bump fails those tests. That catches it at build time, which is good — but the fix at
that point is to bump two client literals for a change that did not touch the contract.

**Fix:** version the proposal contract independently of the DB schema.

```ts
// action-proposal-sink.ts
/** The action_proposal WIRE contract version — bumped only when the 16-field record shape
 *  changes, NOT when the DB schema changes for unrelated reasons. */
export const PROPOSAL_CONTRACT_VERSION = 1;
// ...
schema_version: PROPOSAL_CONTRACT_VERSION,
```

and set both clients' constants to that. Keep the three-way field lock in
`action-proposal-contract.test.ts` unchanged — it already guards the shape this version
describes.

### WR-05: the "locked" `proposalId` encoding is not locked by any test

**File:** `src/consolidation/action-proposal-sink.ts:68-92` (claim) vs
`tests/action-proposal-sink.test.ts:71-141` and
`tests/action-proposal-contract.test.ts:96-105` (coverage).

**Issue:** The `proposalId` doc states "The array ordering and the `JSON.stringify`
serialization are locked as part of the contract — Phase 67's reference consumer can
independently reproduce this exact encoding." Neither half is true in the shipped code:

- No consumer reproduces the encoding. Both clients treat the id as an opaque 64-hex token;
  neither imports, mirrors, or re-derives `proposalId`.
- No test asserts the encoding. `action-proposal-sink.test.ts` tests determinism and
  per-field sensitivity, which every hash encoding satisfies. `action-proposal-contract.test.ts`'s
  own `makeRecord` helper (`:97-105`) computes ids with a *different* encoding — an object
  with keys `field`/`from`/`to` — proving the array form is not treated as contract even
  inside the contract test.

The consequence is not cosmetic. `proposalId` is the idempotency key both consumers persist:
`LocalRow.proposalId` in `proposal-reference/local-store.ts:50`, and its 32-char prefix is the
store key in `belief-bridge.ts:95`. Reordering the array or switching to an object would
change every id, orphan every stored local row, and re-prompt every already-decided proposal —
with a fully green suite.

**Fix:** add one golden-vector assertion that fails on any encoding change.

```ts
it('proposalId encoding is byte-locked (golden vector)', () => {
  expect(proposalId({
    entity_node_id: 'e1', change_field: 'status', change_from: null,
    change_to: 'offer', evidence_episode: 'ep1',
  })).toBe(sha256(JSON.stringify(['e1', 'status', null, 'offer', 'ep1'])));
});
```

### WR-06: `toStoredBeliefProposal` throws on a `number` that is not a valid Date, contradicting the pass's "never throws" contract

**File:** `clients/telegram/belief-bridge.ts:127,135` and `:294`; gate at
`clients/telegram/belief-proposal-client.ts:89`.

**Issue:** The wire gate validates `typeof r['expires_at'] === 'number'` — which admits
`Infinity` (JSON `1e999` parses to `Infinity`) and any value outside the ±8.64e15 ms Date
range. `toStoredBeliefProposal` then calls:

```ts
dueAt: new Date(record.expires_at).toISOString(),
```

`new Date(Infinity).toISOString()` throws `RangeError: Invalid time value`. The call sits at
`belief-bridge.ts:294` inside the dedup loop with no surrounding try, and
`runBeliefBridgePass`'s own contract says "Never throws — every error path logs and
returns/continues rather than rejecting, so the caller's setInterval callback is always safe."
That is false for this path.

The blast radius is bounded — `runBeliefPollTick` has a belt-and-suspenders catch
(`clients/telegram/index.ts:1458-1460`), and no rows are written before the throw, so there is
no partial state. But the pass aborts on *every* retry for as long as the offending record is
listed, silently disabling the belief bridge, and the stated invariant is wrong.

**Fix:** tighten the gate rather than the conversion, so the "malformed item stops the pass"
path handles it as designed:

```ts
// belief-proposal-client.ts — isInspectableProposalRecord
const isEpochMs = (v: unknown): boolean =>
  typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 8.64e15;
// ...
isEpochMs(r['created_at']) && isEpochMs(r['updated_at']) && isEpochMs(r['expires_at'])
```

### WR-07: two configured consumers race on one global status, and the reference adapter auto-approves

**File:** `clients/proposal-reference/index.ts:44-46` vs `clients/telegram/belief-bridge.ts`
(whole HITL path); shared state at `src/db/action-proposal-store.ts:189-192`.

**Issue:** `action_proposal.status` is a single global field with no consumer identity. The
first settler wins and the outcome is recorded for everyone. The reference adapter's decision
policy is:

```ts
export function decideOutcome(record: ActionProposalRecord): 'approve' | 'reject' {
  return record.confidence === 'high' ? 'approve' : 'reject';
}
```

— an unconditional auto-approve of every high-confidence proposal, with no human anywhere. If
both consumers are configured against the same serve instance (both read `RECENSE_SERVE_TOKEN`
and both default to `http://127.0.0.1:7701`), the reference adapter's cron sync will approve
proposals out from under the Telegram bridge, and the human's later tap gets a 409 parked as
`needs_reconciliation`. The HITL gate the Telegram bridge exists to provide is silently
bypassed, and the D-09 approval-rate self-report — the mechanism meant to make rubber-stamping
visible — never counts the decision at all (the 409 branch deliberately touches no counter,
`belief-bridge.ts:589-599`).

Nothing in either client, in `serve-cli.ts`, or in config prevents this pairing or warns about
it.

**Fix:** at minimum, document the exclusivity as a hard operational constraint in
`docs/reference-client.md` and make it fail loudly rather than silently. A structural fix is
to require a consumer identity on settle and record it, so a second consumer's decision on an
already-settled proposal is distinguishable from a genuine race:

```ts
// serve-cli.ts — POST /v1/proposals/:id/approve
// require a consumer id header, stored alongside the terminal status
const consumer = req.headers['x-recense-consumer'];
```

If that is out of scope this milestone, the honest minimum is changing `decideOutcome`'s
default to `reject` (or a no-op `defer`) so the demo adapter cannot auto-apply anything a
human was meant to see.

---

## Info

### IN-01: the proposal id is written to the request log despite the adjacent comment forbidding it

**File:** `src/adapter/serve-cli.ts:571-601` and `:60-71`.

**Issue:** The comment at `:573` states "Every `detail` below is a fixed literal — never
interpolate the proposal id, the entity descriptor, a node value, or the evidence quote into a
response body **or a log line** (D-16 / T-12-05)." Every `logRequest` call in that block passes
`url`, which is `/v1/proposals/<64-hex-id>/approve`, and `logRequest` writes it to both stdout
and `/tmp/recense-serve.log`.

The actual risk is low — the id is a non-invertible sha256 and the route is behind the Bearer
gate — but the code and its stated invariant disagree, which is how a real leak gets waved
through later.

**Fix:** either log a redacted path (`/v1/proposals/:id/approve`) on these two routes, or
narrow the comment to say the id is exempt and why.

### IN-02: the `NoopActionProposalSink` test asserts something the sink could not affect either way

**File:** `tests/action-proposal-sink.test.ts:147-155`.

**Issue:** The test creates a DB, calls `sink.emit(...)` on a `NoopActionProposalSink` that
holds no DB reference and no store, then asserts `COUNT(*) === 0`. The assertion passes
identically for a sink that writes to a *different* database, and it would pass if `emit`
were deleted. It proves nothing beyond "the constructor takes no arguments."

**Fix:** the meaningful version of this guarantee is the injection test that already exists at
`action-proposal-emission.test.ts:638` (a real consolidation run with `NoopActionProposalSink`
injected writing zero rows). Either drop this one or point its comment at that test as the
real coverage.

### IN-03: `evidence_quote` is the entire episode, not a quote

**File:** `src/consolidation/consolidator.ts:1351` (`evidence_quote: episodeContent`);
schema at `src/db/schema.ts:245`.

**Issue:** The field is named and documented as a quote, and `belief-render.ts:105` renders it
inside `"..."` delimiters as if it were one. What is actually stored is the full
`episode.content` — up to the 8 KB `capContent` bound — including the
`From: <sender> · Re: <subject> · Acct: <account>` provenance header that `gmail-adapter.ts:538`
prepends. `redactSecrets` deliberately preserves email addresses (D-64), so every
`/v1/proposals` consumer receives the sender's address and subject line for every proposal.

That may be exactly the intent (the approver benefits from provenance), and it is redacted and
hidden-content-stripped. But a consumer reading the field name would reasonably expect a short
extracted span, and the Telegram renderer's 280-char cap is the only thing preventing an 8 KB
email body from being pasted into a chat.

**Fix:** rename to `evidence_content` if a rename is affordable, or document the actual
contents on the schema comment and in `docs/reference-client.md` so a consumer sizing its own
storage or display is not surprised.

---

## Fix Log

Fixed 2026-08-07. All eight non-Info findings addressed; the three Info findings
(IN-01 request-log id, IN-02 vacuous Noop-sink assertion, IN-03 `evidence_quote`
naming) were explicitly out of scope for this pass and remain open.

| Finding | Commit | Outcome |
|---|---|---|
| CR-01 | `2a8a952` | Fixed — `listPending` now INNER JOINs both node rows and filters `tombstoned = 0`, making the read filter the exact complement of `classifyProposalStaleness`. Two route-level regression tests added. |
| CR-01 | `90a2a53` | Follow-up — the reference-adapter e2e refusal round-trip seeded an already-tombstoned belief, which CR-01 removes from the list by design; retargeted at the genuine race (belief moves between list and approve). |
| WR-01 | `9d9c3f9` | Fixed (minimal option only) — added `ActionProposalStore.countPending()` and `total_pending` on `GET /v1/proposals`, counting rows passing the same expiry+tombstone filter. No lazy expiry, no window reorder — those stay founder product decisions. Both clients read only `body.items`, so the new field is backwards-compatible. |
| WR-02 | `440858a` | Fixed — `isInspectableRecord` now type-checks every field the loop consumes (id regex included) instead of testing key presence. Behavior change: a malformed id is now caught at the wire gate, a stop-the-whole-pass condition matching the sibling client; the WR-04 path-traversal test asserts the stricter outcome. |
| WR-02 | `89a86a6` | Follow-up — `docs/reference-client.md` still described the pre-fix presence-only guard. |
| WR-03 | `bbc7b3b` | Fixed as documentation + test; emission behavior deliberately unchanged per 66-04-PLAN.md:196. The doc comment now names the decision and its real rationale (N proposals for one transition = approval fatigue), and a new test locks it: a multi-`contradicted_ids` verdict yields exactly one proposal row while the secondary is genuinely tombstoned via an emission-eligible event type. |
| WR-04 | `2dea13b` | Fixed — `PROPOSAL_CONTRACT_VERSION` introduced in `action-proposal-sink.ts` and stamped in place of `SCHEMA_VERSION`. Starts at **17**, not 1, so already-persisted pending rows and both clients' existing literals stay wire-compatible. DB `SCHEMA_VERSION` untouched and now independent. |
| WR-05 | `3ea09ad` | Fixed — golden-vector byte-lock on `proposalId`, pinning a literal digest (catches a hash change) alongside the spelled-out array form (names the ordering). |
| WR-06 | `40a9e24` | Fixed — `isEpochMs` on `created_at`/`updated_at`/`expires_at` in the Telegram wire gate. New test drives a raw `1e999` body through the stub; verified it fails with the exact `RangeError: Invalid time value` when the gate is reverted. |
| WR-07 | `c4bfc4b` | Fixed as documentation only, per instruction — `decideOutcome` unchanged (nothing in REQUIREMENTS.md CONSUME-01..03 pins it either way). Single-consumer exclusivity is now stated up front in the `docs/reference-client.md` proposal-client section and at the `decideOutcome` site itself. |

**Verification:** full suite `241 files / 4023 tests passed` (6 expected-fail, 4
skipped), `tsc --noEmit` clean across all four tsconfigs (src, tests,
proposal-reference, telegram). Hard locks confirmed untouched by diff:
`src/consolidation/update-decision.ts`, `clients/telegram/proposal-store.ts`,
`clients/telegram/proposal-engine.ts`, and everything under
`scripts/eval/results/`. D-43 sentinels, the emission-hold sentinel, the PE
machinery lock, the import-boundary guards, and the online-LLM-free sentinel all
pass.

---

_Reviewed: 2026-08-07_
_Reviewer: Claude (gsd-code-reviewer), cross-phase deep pass_
_Depth: deep_
_Fixed: 2026-08-07 — Claude (gsd-code-fixer)_
