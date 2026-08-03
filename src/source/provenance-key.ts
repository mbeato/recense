/**
 * provenance-key.ts — the DRIFT-03 provenance-distinctness key derivation (Phase 65, Plan 65-04).
 *
 * Pure, two-import module: `(From: header, Gmail thread id, body text)` -> a session-id-shaped
 * string that decides whether `countDistinctProvenance` (src/consolidation/update-decision.ts)
 * can ever fire on Gmail-only evidence. This is the single function research Pitfall 3 names as
 * both the fix (today's collapsed session_id makes distinctCount mathematically stuck at 1 on
 * Gmail-only evidence) and the new farming surface (the obvious "use the raw message id" fix
 * turns three forwards of one thread into three false corroborations). Both directions are
 * first-class success criteria, proven at value level by the D-07 locked test pair in
 * tests/provenance-key.test.ts.
 *
 * Composed key: `ingest:gmail:<normalized-sender-domain>:<gmail-thread-id>`.
 *
 * Discretionary choices (CONTEXT.md D-01 names all four as planner discretion — stated here,
 * not just in the plan, so a future reader does not have to re-derive them):
 *  - **Domain, not full address.** A single mailbox can mint unlimited local parts
 *    (`a+1@`, `a+2@`), so keying on the address would let one sender manufacture N independent
 *    provenances. Keying on the domain reduces that to controlling N domains — the same bar as
 *    controlling N Claude Code sessions. Honest cost, stated plainly: two different humans at
 *    the same company corroborating the same status count as ONE provenance. This is the
 *    deliberate conservative direction — under-count, never over-count.
 *  - **accountId excluded.** The same thread landing in two of the founder's own inboxes is one
 *    piece of evidence, not two. Including accountId would double-count a CC.
 *  - **Plaintext, not hashed.** The sender domain already appears verbatim inside
 *    `episode.content`'s provenance header (`From: ... · Re: ... · Acct: ...`,
 *    gmail-adapter.ts:521), so writing it into `session_id` discloses nothing new, and a
 *    readable key is what makes Plan 65-10's dry-run reviewable by a human. The `[a-z0-9.-]`
 *    domain charset plus the `[A-Za-z0-9_-]` thread-id charset is what makes `:` a safe
 *    separator without escaping.
 *  - **`ingest:gmail` prefix preserved.** The composed key extends the existing literal
 *    (`ingest-cli.ts`'s `` `ingest:${r.source}` ``) rather than replacing it, so an operator
 *    eyeballing `session_id` values still sees the source, and the collapsed fallback is a
 *    strict prefix of every composed key.
 *
 * Fail-closed invariant (stated once, load-bearing everywhere below): every unparseable or
 * non-independent path returns the SAME shared `COLLAPSED_GMAIL_PROVENANCE_KEY`, never a
 * per-message unique value. An unparseable message under-counts provenance (the belief holds
 * longer) — the safe direction. Any per-message fallback (e.g. appending a counter or the raw
 * message id) would restore exactly the farmable behavior the "dangerous shortcuts" table bans.
 *
 * No vendor domain knowledge of any kind — no allowlist, no denylist, no ATS/job-board special
 * case, no "known recruiter domain" table. `tests/no-ats-domain-table.test.ts` walks all of
 * `src/` and fails the build if one appears; the underlying reason (CLASSIFY-04 D-03: employers
 * whitelabel ATS mail onto their own verified domains, so a fingerprint table degrades silently
 * while looking correct in review) applies here identically — sender domain is used only for
 * generic normalization, never matched against a table.
 *
 * Contract: pure (no clock, no I/O, no randomness), total (never throws), deterministic (same
 * input -> same output, always).
 *
 * Implementation note on `normalizeSenderDomain`'s reject list: the plan's own action text lists
 * "contains no '.'" as a reject condition, but the plan's own behavior spec requires
 * `normalizeSenderDomain('Weird <a@b>, Second <c@d.com>')` to return `'b'` (no dot) rather than
 * `null` — the two are directly inconsistent. This implementation follows the explicit
 * input/output example (the literal locked test), so a missing dot alone is NOT a reject
 * condition; every other reject condition the plan lists (length, charset, leading/trailing
 * '.'/'-' , consecutive dots) is enforced as written and is independently sufficient to reject
 * every adversarial case the plan names.
 */
import { stripInvisibleCodepoints } from './strip-hidden';
import { stripQuotedForwarded, isNearEmptyResidual } from './strip-quoted';

/**
 * The pre-Phase-65 collapsed session id (`ingest-cli.ts`'s literal for `source === 'gmail'`)
 * and the shared fail-closed fallback for every unparseable/non-independent path below.
 */
export const COLLAPSED_GMAIL_PROVENANCE_KEY = 'ingest:gmail';

/** Domain segment charset, enforced AFTER lowercasing and trailing-dot removal. */
const DOMAIN_CHARSET_RE = /^[a-z0-9.-]+$/;

/**
 * Gmail thread ids are lowercase hex today, but the safe charset is deliberately wider
 * (URL-safe: letters, digits, underscore, hyphen) rather than hex-only — do not hard-code hex.
 * `:` is excluded because it is the key separator.
 */
const THREAD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** DNS name length bound (RFC 1035) — reject rather than truncate above this. */
const MAX_DOMAIN_LENGTH = 253;

/**
 * Extract the content of the first `<...>` pair in `s`, or `null` if there is none.
 */
function extractFirstAngleBracketAddress(s: string): string | null {
  const start = s.indexOf('<');
  if (start === -1) return null;
  const end = s.indexOf('>', start + 1);
  if (end === -1) return null;
  return s.slice(start + 1, end);
}

/**
 * Normalize a `From:` header value to a lowercase, validated domain, or `null` if no usable
 * domain can be extracted.
 *
 * Order of operations is load-bearing: invisible-codepoint stripping runs FIRST, exactly
 * mirroring `gmail-adapter.ts:517`'s `strippedFrom` ordering, because `From:` is 100%
 * sender-controlled and RFC 2047 encoded-words decode to arbitrary UTF-8 — a zero-width payload
 * could otherwise fragment the parse and mint an attacker-chosen number of distinct "domains"
 * from one real sender.
 *
 * Reject, never truncate or sanitize, on every failure path: a silently repaired domain would
 * be a distinct key an attacker chose, which is exactly the farming surface this module exists
 * to close.
 */
export function normalizeSenderDomain(fromHeader: string): string | null {
  // Step 1: strip invisible codepoints FIRST, before any pattern match (mirrors
  // gmail-adapter.ts:517's strippedFrom ordering) — From: is sender-controlled input.
  const stripped = stripInvisibleCodepoints(fromHeader);

  // Step 2: extract the first email address — the content of the first `<...>` pair if present,
  // else the whole trimmed string. A multi-address From: is malformed but must not throw; the
  // FIRST address wins.
  const bracketAddress = extractFirstAngleBracketAddress(stripped);
  const addressCandidate = bracketAddress !== null ? bracketAddress : stripped.trim();

  // Take everything after the LAST '@' in that address (a quoted local part may legitimately
  // contain its own '@').
  const atIndex = addressCandidate.lastIndexOf('@');
  if (atIndex === -1) return null;
  let domain = addressCandidate.slice(atIndex + 1);

  // Step 3: lowercase, trim, strip one trailing '.' (FQDN form).
  domain = domain.toLowerCase().trim();
  if (domain.endsWith('.')) domain = domain.slice(0, -1);

  // Step 4: reject (never repair) on every unusable shape.
  if (domain.length === 0) return null;
  if (domain.length > MAX_DOMAIN_LENGTH) return null;
  if (!DOMAIN_CHARSET_RE.test(domain)) return null;
  if (domain.startsWith('.') || domain.startsWith('-')) return null;
  if (domain.endsWith('.') || domain.endsWith('-')) return null;
  if (domain.includes('..')) return null;

  return domain;
}

/**
 * Derive the DRIFT-03 provenance-distinctness key for a single Gmail message.
 *
 * Order matters and is deliberate:
 *  1. Residual gate (D-07) FIRST — a pure forward/quote contributes no independent provenance
 *     regardless of who forwarded it or which thread it landed in. Running this before sender
 *     and thread are even consulted is why three forwards of one thread collapse to one key
 *     even when the three forwarding senders differ.
 *  2. Sender-domain normalization.
 *  3. Thread-id charset validation.
 *
 * Every failure path returns the SHARED `COLLAPSED_GMAIL_PROVENANCE_KEY`, never a per-message
 * unique value (the fail-closed direction: under-count, never farm).
 */
export function deriveGmailProvenanceKey(input: {
  fromHeader: string;
  threadId: string;
  bodyText: string;
  minResidualChars: number;
}): string {
  const residual = stripQuotedForwarded(input.bodyText);
  if (isNearEmptyResidual(residual, input.minResidualChars)) {
    return COLLAPSED_GMAIL_PROVENANCE_KEY;
  }

  const domain = normalizeSenderDomain(input.fromHeader);
  if (domain === null) {
    return COLLAPSED_GMAIL_PROVENANCE_KEY;
  }

  if (!THREAD_ID_RE.test(input.threadId)) {
    return COLLAPSED_GMAIL_PROVENANCE_KEY;
  }

  return `${COLLAPSED_GMAIL_PROVENANCE_KEY}:${domain}:${input.threadId}`;
}
