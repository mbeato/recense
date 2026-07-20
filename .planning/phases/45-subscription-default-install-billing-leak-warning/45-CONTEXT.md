# Phase 45: Subscription-Default Install & Billing-Leak Warning - Context

**Gathered:** 2026-06-26
**Status:** Ready for planning
**Source:** PRD Express Path (docs/superpowers/specs/2026-06-26-subscription-default-install-design.md)

<domain>
## Phase Boundary

Make `claude -p` Max-subscription billing the **default** for recense's sleep-pass, simplify
the install flow around that default, and surface the **real** direct-API billing footgun
(`ANTHROPIC_API_KEY` in `~/.claude/settings.json`) as a warn-only safeguard instead of relying
on a false "billing-leak fixed" guarantee.

Four units of work, plus one scientific open item:
1. **Default flip** in `src/lib/config.ts` (`modelProvider: 'anthropic'` → `'claude-headless'`).
2. **`recense init` restructure** (`src/adapter/recense-init.ts`) — provider step, subscription
   default, drop the required Anthropic key on the subscription path, acknowledge-gate on the
   detected settings.json key.
3. **`recense doctor` rework** (`src/adapter/recense-doctor.ts`) — billing-posture dimension,
   `claude` CLI login check, reworked API-key dimension.
4. **Docs** — `README.md` prereqs + footgun line; `docs/evals.md` staleness note.

A **shared settings.json key detector** (one reader) is consumed by both `init` (acknowledge
gate) and `doctor` (standing dimension).

</domain>

<decisions>
## Implementation Decisions

Everything in the PRD is a locked decision.

### Config default
- **D-01** — Flip `DEFAULT_CONFIG.modelProvider` from `'anthropic'` to `'claude-headless'` in
  `src/lib/config.ts`. Per-role headless models already resolve correctly (extract →
  `claude-haiku-4-5`, judge → `claude-sonnet-4-6`); no per-role change needed.
- **D-02** — Update the stale comment in `config.ts` asserting headless is "opt-in via env ONLY,
  default unchanged" so it reflects the new subscription-default reality.
- **D-03** — Find and fix fallout by **grep, not guess**: tests/CI asserting the `'anthropic'`
  default, and any code path that assumed a direct-API default. (The doctor API-key check is
  handled separately under D-11.)

### `recense init` wizard
- **D-04** — Add an explicit billing/provider step with **subscription pre-selected**:
  `Subscription (claude -p)` (default) / `Direct API` / `Local`.
- **D-05** — Subscription path does **not** prompt for or require the Anthropic API key (not
  needed; a stored key is the leak source).
- **D-06** — Subscription path writes `RECENSE_MODEL_PROVIDER=claude-headless` into
  `~/.config/recense/sleep.env` (belt-and-suspenders with the code default; keeps the choice
  auditable in the user's own config).
- **D-07** — Subscription path **acknowledge gate**: if `ANTHROPIC_API_KEY` is present in
  `~/.claude/settings.json`'s `env` block, print the billing warning and require `y` to
  continue. **No file edits.**
- **D-08** — Direct-API path prompts + live-validates the Anthropic key as today (unchanged).
- **D-09** — Local path: existing behavior unchanged.
- **D-10** — OpenAI key prompt + live validation: unchanged, still required (embeddings).

### `recense doctor`
- **D-11** — Rework the API-key dimension: under subscription mode a missing Anthropic key is
  expected → report `✓ subscription mode (Anthropic API key not needed)`. OpenAI remains a hard
  `✗` when missing. Direct-API mode behavior unchanged.
- **D-12** — New standing **billing-posture** dimension: determine active provider, scan
  `~/.claude/settings.json`'s `env` for `ANTHROPIC_API_KEY`. If subscription + key present →
  `✗ ANTHROPIC_API_KEY in ~/.claude/settings.json will bill direct API even on subscription —
  remove it from the env block`. Counts toward the exit-1 failure tally.
- **D-13** — New check: `claude` CLI present + authenticated, via a cheap, non-billed probe.
  Failure → `✗ claude CLI not found / not logged in — run 'claude login'`.

### Shared helper
- **D-14** — A shared settings.json `ANTHROPIC_API_KEY` detector: reads `~/.claude/settings.json`
  `env`, reports whether the key is set. **One reader, two consumers** (init gate + doctor
  dimension). Must handle present / absent / missing-file / malformed-JSON correctly.

### Docs
- **D-15** — README Quickstart prereqs: required = **`claude` CLI logged into a Claude
  subscription** + **OpenAI API key**; Anthropic API key = "optional, only for direct-API mode."
  Add one line naming the `~/.claude/settings.json` `ANTHROPIC_API_KEY` billing footgun.
- **D-16** — `docs/evals.md`: note that the current default stack is headless Haiku/Sonnet so the
  stale `granite4.1:8b + qwen3.6:35b-a3b` references stop reading as current config. **Do not
  rewrite historical baseline numbers.**

### Honesty constraints (load-bearing — apply to all copy and behavior)
- Subscription covers **Anthropic only**. OpenAI key remains required. Install copy says "no
  Anthropic API billing needed," **never** "no keys needed."
- **No inflated safety claims.** Do not describe the env-strip as preventing API billing. The
  warning is the safeguard; the strip is not sufficient on its own.
- recense **does not edit** `~/.claude/settings.json`. Detect and warn only.

### Claude's Discretion
- Exact prompt-library / CLI affordances for the new provider step (reuse whatever `recense-init`
  already uses for choice prompts).
- Internal module placement and signature of the shared settings.json detector, provided it is a
  single reader consumed by both init and doctor.
- Implementation of the "cheap, non-billed probe" for `claude` CLI auth (D-13), provided it does
  not incur subscription/API token cost.
- Test structure/location, consistent with the existing suite.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Design contract
- `docs/superpowers/specs/2026-06-26-subscription-default-install-design.md` — the approved PRD;
  source of truth for every decision above, the honesty constraints, testing matrix, and the
  open item.

### Code to modify
- `src/lib/config.ts` — `DEFAULT_CONFIG.modelProvider` default + stale opt-in comment (config
  block around lines 620-622 per CLAUDE.md).
- `src/adapter/recense-init.ts` — install wizard to restructure (provider step + subscription path).
- `src/adapter/recense-doctor.ts` — doctor dimensions to rework/add.
- `src/model/claude-headless-client.ts` (env-strip at lines 323-326) — **read for the open-item
  reproduction only**; transport hardening is NOT a committed deliverable.

### Docs to update
- `README.md` — Quickstart prerequisites + footgun line.
- `docs/evals.md` — staleness note on the local-stack references.

</canonical_refs>

<specifics>
## Specific Ideas

### Open item — resolve during planning, not committed in the PRD
**D-17** — Empirically confirm whether the billing leak **still fires** with the current
`--setting-sources project` + env-strip in place. This is a **scientific check** (reproduce,
observe the actual billing/auth path), not speculation:
- If it still leaks → the warning is the safeguard; ship the design as written.
- If some transport flag genuinely suppresses settings.json `env` injection → that is a bonus
  real fix, but transport hardening is **not** a committed deliverable. The warn-only path ships
  regardless of the outcome.

### Testing matrix (from PRD §Testing)
- `config.ts`: default provider is `'claude-headless'`.
- settings.json detector: correct true/false for key present / absent / missing-file /
  malformed-JSON.
- `init`: subscription path skips the Anthropic-key prompt and writes
  `RECENSE_MODEL_PROVIDER=claude-headless`; acknowledge gate triggers **only** when the key is
  detected.
- `doctor`: subscription + key present → billing dimension fails (exit 1); subscription + no key →
  passes; missing Anthropic key under subscription is **not** a failure; claude-CLI-missing fails.
- Reconcile any existing tests that assumed the `'anthropic'` default.

</specifics>

<scope_fence>
## Scope Fence — Out of Bounds

Non-goals (explicitly out of scope — do not touch):
- Editing the user's `~/.claude/settings.json` (detect + warn only).
- Replacing the OpenAI embedder or removing the OpenAI key requirement.
- Transport hardening beyond the existing env-strip (see open item D-17).
- Tray-app onboarding changes (no billing surface).
- Reviving the eval-regression-gate (Phase 43) work — explicitly dropped.
- `scripts/setup-dogfood.sh` — already marked legacy, out of scope.

</scope_fence>

<deferred>
## Deferred Ideas

- Transport hardening that would make the env-strip actually win against settings.json
  re-injection — deferred to a possible future phase; only pursued opportunistically if D-17's
  reproduction reveals a genuine suppression flag, and even then not a committed deliverable here.

</deferred>

---

*Phase: 45-subscription-default-install-billing-leak-warning*
*Context gathered: 2026-06-26 via PRD Express Path*
