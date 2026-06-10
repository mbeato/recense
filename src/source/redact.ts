/**
 * redactSecrets — pure, deterministic secrets-only redactor (D-63/D-64).
 *
 * Strips high-risk zero-memory-value tokens from episode content before it reaches
 * EpisodicStore.append(). Every adapter calls this at the boundary before constructing
 * a NormalizedRecord — raw sensitive text never touches the episodic log (T-06-05).
 *
 * All regexes are compiled ONCE at module load — never per call
 * (compile-once discipline; mirrors AllocationGate/capContent pattern).
 *
 * Secrets stripped (each replaced with a kind-tagged marker):
 *  Pattern                                              Marker
 *  OpenAI API keys   sk-[A-Za-z0-9]{20,}               [REDACTED:API_KEY]
 *  GitHub tokens     gh[poasr]_[A-Za-z0-9]{20,}        [REDACTED:API_KEY]
 *  AWS access keys   AKIA[0-9A-Z]{16}                  [REDACTED:AWS_KEY]
 *  JWTs              eyJ…….…….……                      [REDACTED:JWT]
 *  Bearer tokens     Bearer <value>                    [REDACTED:BEARER_TOKEN]
 *  Key/secret lits   password=…, secret: …, token=…   [REDACTED:SECRET]
 *  CC-like runs      13–16 consecutive digits           [REDACTED:CC]
 *  SSN-like          NNN-NN-NNNN                       [REDACTED:SSN]
 *
 * Explicitly KEPT (D-64 — PII is the asset, not the threat):
 *  - Email addresses  alice@acme.com
 *  - Phone numbers    +1-415-555-0100
 *  - Personal names   Jane Doe
 *
 * Privacy is enforced by SCOPING what enters (D-65 Gmail query, vault selection),
 * not by blanket PII redaction that would gut the memory's value.
 *
 * Idempotent: redactSecrets(redactSecrets(x)) === redactSecrets(x).
 * No LLM, no network, no randomness (LLM-free online discipline, D-01).
 */

// ---------------------------------------------------------------------------
// Secret pattern registry — compiled once at module load
// ---------------------------------------------------------------------------

/**
 * Each entry: { pattern: compiled global RegExp, marker: replacement string }.
 * Order matters: JWT fires before Bearer so a "Bearer eyJ..." response sees the
 * JWT replaced first, leaving a non-matching Bearer prefix that the Bearer
 * pattern then safely ignores (preventing double-marker on the same token).
 */
const SECRET_PATTERNS: ReadonlyArray<{ pattern: RegExp; marker: string }> = [
  // Anthropic API keys: sk-ant-<type>-<value> — the hyphen-delimited segments break the generic
  // sk-[A-Za-z0-9]{20,} match below. This entry must come FIRST so the full hyphenated key
  // is captured as one marker and the generic sk- pattern does not match a fragment.
  // Idempotency: the marker '[REDACTED:API_KEY]' contains no 'sk-ant-' run so it is safe on replay.
  // (M-12)
  {
    pattern: /sk-ant-[A-Za-z0-9-]{20,}/g,
    marker: '[REDACTED:API_KEY]',
  },
  // OpenAI-style API keys: sk- prefix, ≥ 20 alphanumeric chars
  {
    pattern: /sk-[A-Za-z0-9]{20,}/g,
    marker: '[REDACTED:API_KEY]',
  },
  // GitHub tokens: ghp_ (personal), gho_ (OAuth), gha_ (Actions), ghs_ (server), ghr_ (refresh)
  {
    pattern: /gh[poasr]_[A-Za-z0-9]{20,}/g,
    marker: '[REDACTED:API_KEY]',
  },
  // AWS IAM access key IDs: AKIA prefix, 16 uppercase alphanumeric chars
  {
    pattern: /AKIA[0-9A-Z]{16}/g,
    marker: '[REDACTED:AWS_KEY]',
  },
  // JWTs (three base64url segments starting with eyJ): must fire BEFORE Bearer so that
  // a "Bearer eyJ..." response has the JWT value replaced first, leaving a non-matching
  // "Bearer [REDACTED:JWT]" the Bearer pattern will not re-match.
  {
    pattern: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    marker: '[REDACTED:JWT]',
  },
  // HTTP Bearer tokens (fires after JWT; plain non-JWT bearer values land here)
  {
    pattern: /Bearer\s+[A-Za-z0-9._-]{10,}/gi,
    marker: '[REDACTED:BEARER_TOKEN]',
  },
  // Key/secret/password literals: 'password=foo', 'secret: bar', 'token=xyz', 'api_key=…'
  // Case-insensitive. Stops at whitespace for the value (non-whitespace `\S+`).
  // Negative lookahead (?!\[REDACTED:) prevents re-redacting values that an earlier
  // pattern (e.g. GitHub or JWT) already replaced — keeps idempotency sound and
  // preserves the specific kind-tag over the generic SECRET tag.
  {
    pattern: /(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*(?!\[REDACTED:)\S+/gi,
    marker: '[REDACTED:SECRET]',
  },
  // Credit-card-like 13–16 consecutive digit runs (word-boundary anchored to avoid
  // matching sub-runs inside longer numbers). Phone numbers are safe: they contain
  // dashes/spaces between digit groups and never have 13+ consecutive digits.
  {
    pattern: /\b\d{13,16}\b/g,
    marker: '[REDACTED:CC]',
  },
  // SSN-like: NNN-NN-NNNN (US Social Security Number format)
  {
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    marker: '[REDACTED:SSN]',
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Strip secrets from `text`, replacing each match with a kind-tagged `[REDACTED:*]` marker.
 *
 * Pure function — no side effects, no randomness, no external calls.
 * Idempotent: calling it twice on the same input produces the same output as calling it once.
 *
 * @param text - Raw episode content (email body, transcript turn, vault note text).
 * @returns    Text with secrets replaced by `[REDACTED:<KIND>]` markers.
 *             PII (names, emails, phone numbers) is untouched (D-64).
 */
export function redactSecrets(text: string): string {
  let result = text;
  for (const { pattern, marker } of SECRET_PATTERNS) {
    // Reset lastIndex before each use — global regexes retain lastIndex state
    // across calls; explicit reset ensures deterministic first-match behaviour.
    pattern.lastIndex = 0;
    result = result.replace(pattern, marker);
  }
  return result;
}
