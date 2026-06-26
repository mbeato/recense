# Subscription-default install + billing-leak warning

**Date:** 2026-06-26
**Status:** Approved (design)
**Scope:** Make `claude -p` Max-subscription billing the default for recense's sleep-pass, simplify the install flow around that, and surface the real direct-API billing footgun instead of a false safety guarantee.

---

## Problem

recense's sleep-pass (extract → Haiku, judge → Sonnet) can run via the headless `claude -p` transport, billed flat against a Claude Max subscription. But two things are out of sync with that intent:

1. **The default is still direct-API.** `src/lib/config.ts` sets `DEFAULT_CONFIG.modelProvider: 'anthropic'`; `claude-headless` (subscription) is opt-in via `RECENSE_MODEL_PROVIDER` only. A fresh install bills the direct Anthropic API by default. Most users would rather tack inference onto an existing Claude subscription than stand up direct-API billing.

2. **The "billing-leak fixed" claim is false in practice.** The transport (`src/model/claude-headless-client.ts:323-326`) deletes `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` from the child env before spawning `claude -p`, and `STATE.md` records the leak as "closed." **Ground-truth billing contradicts this:** the founder is still charged to direct API because `~/.claude/settings.json`'s `env` block re-injects `ANTHROPIC_API_KEY` after the strip, and Claude Code prefers the key over the subscription login. The env-strip cannot win against settings.json re-injection. The real leak source is the key in `~/.claude/settings.json`.

## Goal

A fresh install runs on the subscription by default, with a linear setup that **names** the settings.json billing footgun (warn-only, no silent edits) and keeps direct-API/local as visible levers.

## Honesty constraints (load-bearing)

- **Subscription covers Anthropic only.** Embeddings still call OpenAI directly, so an **OpenAI API key remains required**. Install copy says "no Anthropic API billing needed," never "no keys needed."
- **No inflated safety claims.** Do not describe the env-strip as preventing API billing. The warning is the safeguard; the strip is not sufficient on its own.
- **recense does not edit `~/.claude/settings.json`.** The user owns that file; recense detects and warns only.

---

## Design

### 1. Default flip — `src/lib/config.ts`

- `DEFAULT_CONFIG.modelProvider`: `'anthropic'` → `'claude-headless'`.
- Per-role headless models already resolve correctly: extract → `claude-haiku-4-5`, judge → `claude-sonnet-4-6` (no change needed).
- Update the stale comment asserting headless is "opt-in via env ONLY, default unchanged."
- **Fallout to find and fix during planning (grep, don't guess):** tests/CI asserting the `'anthropic'` default; any code path that assumed a direct-API default. The doctor API-key check is handled in §3.

### 2. `recense init` wizard restructure — `src/adapter/recense-init.ts`

- Add an explicit **billing/provider step** with **subscription pre-selected**:
  - `Subscription (claude -p)` — default
  - `Direct API`
  - `Local`
- **Subscription path:**
  - Do **not** prompt for / require the Anthropic API key (not needed, and a stored key is the leak source). The existing OpenAI-key step still runs (embeddings).
  - Write `RECENSE_MODEL_PROVIDER=claude-headless` into `~/.config/recense/sleep.env` — belt-and-suspenders with the new code default and keeps the choice auditable in the user's own config.
  - **Acknowledge gate:** if `ANTHROPIC_API_KEY` is present in `~/.claude/settings.json`'s `env` block, print the billing warning and require `y` to continue. No file edits.
- **Direct-API path:** prompt + live-validate the Anthropic key as today (unchanged).
- **Local path:** existing behavior.
- OpenAI key prompt + live validation: unchanged, still required.

### 3. `recense doctor` — `src/adapter/recense-doctor.ts`

- **Rework the API-key dimension:** under subscription mode, a missing Anthropic key is expected, not a failure → report `✓ subscription mode (Anthropic API key not needed)`. OpenAI remains a hard `✗` when missing. Direct-API mode behavior unchanged.
- **New standing dimension — billing posture:** determine active provider (subscription vs direct-API) and scan `~/.claude/settings.json`'s `env` for `ANTHROPIC_API_KEY`. If subscription + key present →
  `✗ ANTHROPIC_API_KEY in ~/.claude/settings.json will bill direct API even on subscription — remove it from the env block`
  Counts toward the exit-1 failure tally so it stays loud until resolved.
- **New check — `claude` CLI present + authenticated:** since subscription is the default, verify the `claude` binary exists and is logged in via a cheap, non-billed probe. On failure: `✗ claude CLI not found / not logged in — run 'claude login'`.

### 4. Docs — `README.md`, `docs/evals.md`

- **README Quickstart prerequisites:** required = **`claude` CLI logged into a Claude subscription** + **OpenAI API key**. Anthropic API key → "optional, only for direct-API mode." Add one line naming the `~/.claude/settings.json` `ANTHROPIC_API_KEY` billing footgun.
- **`docs/evals.md`:** the stale `granite4.1:8b + qwen3.6:35b-a3b` local-stack references get a note that the current default stack is headless Haiku/Sonnet. Do not rewrite historical baseline numbers — just stop them reading as current configuration.
- **Out of scope:** `scripts/setup-dogfood.sh` (already marked legacy), the tray app (no billing surface).

---

## Open item — resolve during planning, not committed here

Empirically confirm whether the leak still fires **with the current `--setting-sources project` + env-strip in place**:

- If it still leaks → the warning is the safeguard; ship the design as written.
- If some transport flag genuinely suppresses settings.json `env` injection → that is a bonus real fix, but transport hardening is **not** a committed deliverable of this spec. The warn-only path is the deliverable regardless.

This is a scientific check (reproduce, observe billing/auth path), not speculation.

---

## Components & boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| `config.ts` default | Sets subscription as baseline provider | none |
| `recense-init` billing step | Captures provider choice, writes `sleep.env`, gates on settings.json key | settings.json reader |
| settings.json key detector (shared helper) | Read `~/.claude/settings.json` `env`, report whether `ANTHROPIC_API_KEY` is set | none |
| `recense-doctor` billing dimension | Standing health check for billing posture + claude CLI | settings.json detector |
| docs | Truthful install + prereqs | none |

The settings.json `ANTHROPIC_API_KEY` detector is shared by `init` (acknowledge gate) and `doctor` (standing dimension) — one reader, two consumers.

## Testing

- `config.ts`: default provider is `'claude-headless'`.
- settings.json detector: returns true/false correctly for key present/absent/missing-file/malformed-JSON.
- `init`: subscription path skips the Anthropic-key prompt and writes `RECENSE_MODEL_PROVIDER=claude-headless`; acknowledge gate triggers only when the key is detected.
- `doctor`: subscription + key present → billing dimension fails (exit 1); subscription + no key → passes; missing Anthropic key under subscription is not a failure; claude-CLI-missing fails.
- Reconcile any existing tests that assumed the `'anthropic'` default.

## Non-goals

- Editing the user's `~/.claude/settings.json`.
- Replacing the OpenAI embedder / removing the OpenAI key requirement.
- Transport hardening beyond the existing strip (see Open item).
- Tray-app onboarding changes.
- Reviving the eval-regression-gate (Phase 43) work — explicitly dropped.
