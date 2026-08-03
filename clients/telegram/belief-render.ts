/**
 * clients/telegram/belief-render.ts
 *
 * Decision-surface renderer for belief-shaped proposals (Phase 68 — APPROVE-01/04).
 *
 * Renders structured fields only — never model prose (research PITFALLS.md Pitfall 2:
 * "the classifier's narrative becomes the confused deputy for status-shaped
 * proposals"). Every character in the rendered message is either a fixed literal
 * owned by this module or a field copied through asDisplayText; nothing here is
 * interpolated from an LLM.
 *
 * Every approve tap target carries the concrete from→to transition on the button
 * label itself (D-05) rather than a bare "Approve" — a fixed generic label becomes
 * a conditioned reflex (v4.0 D-09 lineage), and the transition on the tap target is
 * the cheapest honest defense against rubber-stamping automation bias
 * (PITFALLS.md Pitfall 7).
 *
 * Zero src/ imports — only ./types, ./push-codec, and ./transport (types), all
 * local to clients/telegram/ (CLIENT-01 / import-boundary guard).
 */

import type { StoredBeliefProposal } from './types';
import { encodeBeliefCallbackData } from './push-codec';
import type { InlineKeyboardMarkup } from './transport';

/**
 * Max constituents rendered per group, both in the message body and the keyboard.
 * A group larger than this (should not happen once the bridge's own per-group cap
 * is applied — see belief-bridge.ts) is truncated defensively here too, with the
 * remainder named in a plain-text overflow line.
 */
const MAX_CONSTITUENTS = 10;

/** Field caps (characters) — bound how much of the message a single field can consume. */
const ENTITY_CAP = 80;
const TRANSITION_CAP = 60;
const QUOTE_CAP = 280;
const BUTTON_SIDE_CAP = 24;

/**
 * Collapse all whitespace (newlines, carriage returns, tabs, runs of spaces) in
 * `value` to a single space, trim, and truncate to `maxLen` characters, appending
 * a single ellipsis character when truncation occurs.
 *
 * Threat closed (T-68-07): transport.sendMessage sends plain text with no markup
 * mode set, so Telegram cannot execute markup from a rendered field — the residual
 * risk is STRUCTURE
 * spoofing, where attacker-controlled free text (e.g. an email-derived evidence
 * quote) contains a newline followed by text shaped like one of this renderer's
 * own field lines (e.g. a forged "2. status: rejected → ghosted" line). Collapsing
 * whitespace removes the newline that would let a forged line be mistaken for a
 * real one; the fixed field order and the length cap bound the rest.
 *
 * Display-layer only: the stored StoredBeliefProposal fields stay verbatim (D-05)
 * — nothing here is written back to the store. This is purely what the human sees.
 */
export function asDisplayText(value: string, maxLen: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLen) return collapsed;
  return collapsed.slice(0, Math.max(0, maxLen - 1)) + '…';
}

/**
 * Render a batched group of belief proposals (same entityDescriptor + local day,
 * D-07) as a single plain-text decision message.
 *
 * Structure, fixed order:
 *   1. `[Belief update] {entityDescriptor}` header line (cap 80).
 *   2. A headline line for the LATEST constituent (highest serverCreatedAtMs):
 *      `{changeField}: {from} → {to}` (each side cap 60; changeFrom === null
 *      renders as the fixed literal `(unset)`).
 *   3. One numbered block per constituent (earliest-first): the same field/transition
 *      line, then the evidence quote on its own line inside `"..."` delimiters
 *      (cap 280), then the row's expiry (`dueAt`).
 *   4. If the full group (`totalCount` when given, else `group.length`) exceeds the
 *      constituents actually rendered, a trailing overflow line naming the
 *      remaining count. `totalCount` lets a caller that pre-capped `group` for
 *      Telegram's message-length limit (CR-01 — see belief-bridge.ts) keep the
 *      overflow line honest about constituents it carried out of this message.
 *
 * The coarse categorical confidence MAY appear as plain text next to a constituent
 * (D-06) — the literal word "confidence" is never written, so no numeric-confidence
 * pattern can ever match this output; a raw numeric confidence is never rendered,
 * ever.
 */
export function renderBeliefDecisionMessage(group: StoredBeliefProposal[], totalCount?: number): string {
  const ordered = [...group].sort((a, b) => a.serverCreatedAtMs - b.serverCreatedAtMs);
  const first = ordered[0];
  if (first === undefined) return '[Belief update]';

  const constituents = ordered.slice(0, MAX_CONSTITUENTS);
  const latest = ordered.reduce((max, c) => (c.serverCreatedAtMs > max.serverCreatedAtMs ? c : max), first);

  const lines: string[] = [];
  lines.push(`[Belief update] ${asDisplayText(first.entityDescriptor, ENTITY_CAP)}`);

  const latestFrom = latest.changeFrom === null ? '(unset)' : asDisplayText(latest.changeFrom, TRANSITION_CAP);
  const latestTo = asDisplayText(latest.changeTo, TRANSITION_CAP);
  lines.push(`${asDisplayText(latest.changeField, TRANSITION_CAP)}: ${latestFrom} → ${latestTo}`);

  constituents.forEach((c, i) => {
    const from = c.changeFrom === null ? '(unset)' : asDisplayText(c.changeFrom, TRANSITION_CAP);
    const to = asDisplayText(c.changeTo, TRANSITION_CAP);
    lines.push(`${String(i + 1)}. ${asDisplayText(c.changeField, TRANSITION_CAP)}: ${from} → ${to} (${c.confidence})`);
    lines.push(`   "${asDisplayText(c.evidenceQuote, QUOTE_CAP)}"`);
    lines.push(`   Expires: ${c.dueAt}`);
  });

  const total = totalCount ?? ordered.length;
  const hidden = total - constituents.length;
  if (hidden > 0) {
    lines.push(`... and ${String(hidden)} more not shown`);
  }

  return lines.join('\n');
}

/**
 * Build the belief decision keyboard: one row per constituent (max MAX_CONSTITUENTS
 * rows, matching renderBeliefDecisionMessage's overflow rule), each row two buttons.
 *
 * D-05 rationale: the approve button's label carries the transition itself (a check
 * mark, the from side, '→', the to side) rather than a bare "Approve" — a fixed
 * generic label becomes a conditioned reflex (v4.0 D-09 lineage) and the transition
 * on the tap target is the cheapest honest defense against rubber-stamping that
 * survives any future layout change (PITFALLS.md Pitfall 7).
 *
 * Every callback_data payload is produced by encodeBeliefCallbackData against the
 * constituent's LOCAL store id (never the server's 64-hex id — see push-codec.ts's
 * v3 byte-budget note).
 */
export function beliefKeyboard(group: StoredBeliefProposal[]): InlineKeyboardMarkup {
  const constituents = group.slice(0, MAX_CONSTITUENTS);

  const rows = constituents.map(c => {
    const from = c.changeFrom === null ? '(unset)' : asDisplayText(c.changeFrom, BUTTON_SIDE_CAP);
    const to = asDisplayText(c.changeTo, BUTTON_SIDE_CAP);
    return [
      {
        text: `✅ ${from} → ${to}`,
        callback_data: encodeBeliefCallbackData(c.id, 'a'),
      },
      {
        text: `❌ ${to}`,
        callback_data: encodeBeliefCallbackData(c.id, 'r'),
      },
    ];
  });

  return { inline_keyboard: rows };
}
