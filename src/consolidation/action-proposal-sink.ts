/**
 * ActionProposalSink — EMIT-01 producer seam (D-04/D-06/D-07).
 *
 * `emit()` is called synchronously inside the same per-episode `db.transaction` that already
 * commits the graph write it describes (D-06) — a crash between the belief write and the
 * proposal write must not be possible, mirroring `ConsolidationSink`'s T-05-SINK-TX guarantee.
 * `SQLiteActionProposalSink` mints the record's minted-not-caller-supplied fields and delegates
 * the actual INSERT to `ActionProposalStore.insert` (shipped by Phase 66-01), whose `INSERT OR
 * IGNORE` on the content-hash PK is EMIT-04's entire replay-collapse mechanism.
 *
 * Implementations:
 *   SQLiteActionProposalSink — production: writes one `action_proposal` row per decisive change
 *   NoopActionProposalSink   — default; no writes, no external state (EMIT-01's "zero cost")
 *   MockActionProposalSink   — test helper: captures inputs to a public array
 *
 * Threat mitigations (see 66-02-PLAN.md `<threat_model>`):
 *   T-66-06: `evidence_quote` is passed through as an opaque string — no formatter, no
 *            summariser, no `ModelProvider` of any kind on this path.
 *   T-66-04: `proposalId` is a content hash over exactly five keyed fields with a locked
 *            `JSON.stringify` array encoding; timestamps and the randomly-minted
 *            `belief_node_id` are excluded.
 *   T-66-12: `actionProposalSinkEnabled` defaults `false` AND the Consolidator constructor
 *            default is `NoopActionProposalSink` — two independent barriers.
 */
import { SCHEMA_VERSION } from '../db/schema';
import { sha256 } from '../lib/hash';
import type { Clock } from '../lib/clock';
import type { IntentConfidence } from '../model/claim-extractor';
import type { ActionProposalStore, ActionProposalRecord } from '../db/action-proposal-store';
import { PROPOSAL_TTL_MS } from '../db/action-proposal-store';

// ---------------------------------------------------------------------------
// BELIEF_CHANGE_FIELD_STATUS
// ---------------------------------------------------------------------------

/**
 * The attribute name recense uses for a status-lifecycle belief change.
 *
 * Not a Pitfall-10 consumer-schema leak: `change_field` is a free TEXT column with no CHECK
 * constraint (D-03 — a CHECK'd enum here would encode consumer vocabulary into recense's own
 * seam). This constant is recense's own vocabulary word for "the attribute that changed," not
 * jobfill's. A second consumer in an unrelated domain would carry a different `change_field`
 * string through this exact seam, unchanged.
 */
export const BELIEF_CHANGE_FIELD_STATUS = 'status';

// ---------------------------------------------------------------------------
// ActionProposalInput — caller-supplied half (id/schema_version/status/timestamps minted)
// ---------------------------------------------------------------------------

export interface ActionProposalInput {
  kind: 'belief';
  entity_node_id: string;
  entity_descriptor: string;
  belief_node_id: string;
  change_field: string;
  change_from: string | null;
  change_to: string;
  evidence_episode: string;
  evidence_quote: string;
  confidence: IntentConfidence;
}

// ---------------------------------------------------------------------------
// proposalId — the deterministic content-hash id (D-07, EMIT-04)
// ---------------------------------------------------------------------------

/**
 * Deterministic id over the identity of the change: `(entity_node_id, change_field, change_from,
 * change_to, evidence_episode)`. The array ordering and the `JSON.stringify` serialization are
 * locked as part of the contract — Phase 67's reference consumer can independently reproduce
 * this exact encoding, and JSON is what makes `null` distinguishable from `''` for `change_from`.
 *
 * Two fields are deliberately excluded, and that exclusion is itself part of the contract:
 *   - timestamps: a replayed sleep pass must produce the SAME id, not a fresh one every retry.
 *   - `belief_node_id`: `applyDecision` mints this with a random UUID — including it would
 *     make every replay of the same change mint a fresh row, silently falsifying EMIT-04.
 */
export function proposalId(
  input: Pick<
    ActionProposalInput,
    'entity_node_id' | 'change_field' | 'change_from' | 'change_to' | 'evidence_episode'
  >
): string {
  return sha256(JSON.stringify([
    input.entity_node_id,
    input.change_field,
    input.change_from,
    input.change_to,
    input.evidence_episode,
  ]));
}

// ---------------------------------------------------------------------------
// ActionProposalSink interface
// ---------------------------------------------------------------------------

/**
 * Narrow seam called synchronously inside per-episode db.transaction (D-06).
 * No async, no promises — better-sqlite3 is synchronous; a suspended step between the
 * graph mutation and its emit would break the atomicity guarantee.
 */
export interface ActionProposalSink {
  emit(proposal: ActionProposalInput): void;
}

// ---------------------------------------------------------------------------
// SQLiteActionProposalSink — production implementation
// ---------------------------------------------------------------------------

export class SQLiteActionProposalSink implements ActionProposalSink {
  private readonly store: ActionProposalStore;
  private readonly clock: Clock;

  constructor(store: ActionProposalStore, clock: Clock) {
    this.store = store;
    this.clock = clock;
  }

  /**
   * Mint id=proposalId(proposal), schema_version=SCHEMA_VERSION, status='pending',
   * created_at=updated_at=clock.nowMs(), expires_at=created_at+PROPOSAL_TTL_MS, then delegate
   * to ActionProposalStore.insert. Synchronous — safe inside an existing db.transaction (D-06).
   */
  emit(proposal: ActionProposalInput): void {
    const now = this.clock.nowMs();
    const record: ActionProposalRecord = {
      id: proposalId(proposal),
      kind: proposal.kind,
      entity_node_id: proposal.entity_node_id,
      entity_descriptor: proposal.entity_descriptor,
      belief_node_id: proposal.belief_node_id,
      change_field: proposal.change_field,
      change_from: proposal.change_from,
      change_to: proposal.change_to,
      evidence_episode: proposal.evidence_episode,
      evidence_quote: proposal.evidence_quote,
      confidence: proposal.confidence,
      schema_version: SCHEMA_VERSION,
      status: 'pending',
      created_at: now,
      updated_at: now,
      expires_at: now + PROPOSAL_TTL_MS,
    };
    this.store.insert(record);
  }
}

// ---------------------------------------------------------------------------
// NoopActionProposalSink — default (no writes, no external state)
// ---------------------------------------------------------------------------

export class NoopActionProposalSink implements ActionProposalSink {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  emit(_proposal: ActionProposalInput): void {
    // Intentional no-op — used as the default when no sink is injected.
  }
}

// ---------------------------------------------------------------------------
// MockActionProposalSink — test helper
// ---------------------------------------------------------------------------

export class MockActionProposalSink implements ActionProposalSink {
  /** All emitted proposals in emission order. */
  readonly proposals: ActionProposalInput[] = [];

  emit(proposal: ActionProposalInput): void {
    this.proposals.push(proposal);
  }

  /** Reset captured proposals (useful across test cases). */
  reset(): void {
    this.proposals.length = 0;
  }
}
