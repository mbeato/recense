# 45-04 FINDING — D-17 Billing-Leak Empirical Reproduction

**Date:** 2026-06-26
**Type:** Observe-only scientific reproduction (no production code changed)
**Question (D-17):** Does the direct-API billing leak STILL FIRE when `ANTHROPIC_API_KEY`
is set in `~/.claude/settings.json`'s `env` block, given the current
`--setting-sources project` + spawn-env `delete ANTHROPIC_API_KEY` safeguards in
`src/model/claude-headless-client.ts`?

**Answer: NO — the leak does NOT fire under recense's current transport.**
`--setting-sources project` is the load-bearing safeguard that prevents the
`~/.claude/settings.json` `env` block from re-injecting the key into `claude -p`.

---

## Reproduction method

Zero-cost tracer design: an **invalid** tracer API key is placed in a **throwaway**
`settings.json` under a temp `HOME`. An invalid key fails authentication (HTTP 401)
*before* any billable call, so the reproduction cannot incur API spend, and it never
touches the founder's real `~/.claude/settings.json` (scope fence T-45-05) and never
records a real key value (T-45-01 — a grep for the Anthropic key prefix on this file
returns 0).

Setup (probe script: `scratchpad/d17-probe.sh`):
- `HOME=$TMPHOME` with `$TMPHOME/.claude/settings.json` = `{ "env": { "ANTHROPIC_API_KEY": "<invalid tracer>" } }`
- run from a neutral temp cwd (no project `.claude`), mirroring recense's `os.tmpdir()` cwd
- spawn env has `ANTHROPIC_API_KEY` + `ANTHROPIC_AUTH_TOKEN` stripped via `env -u …`
  (mirrors `delete childEnv['ANTHROPIC_API_KEY']` at claude-headless-client.ts:224/325)
- `claude -p 'Reply with exactly: ok' --output-format json --model claude-haiku-4-5 --strict-mcp-config`
- observable signal: the `--output-format json` envelope's `api_error_status`,
  `result`, and `total_cost_usd` (CLAUDE.md: the per-call billing signal)

Two conditions were run — a sensitivity CONTROL and the TREATMENT that matches recense's
actual flags.

## Observations

| Condition | `--setting-sources` | spawn-env key | `api_error_status` | `result` | `total_cost_usd` |
|-----------|---------------------|---------------|--------------------|----------|------------------|
| CONTROL (sensitivity) | `user` | stripped | **401** | `Invalid API key · Fix external API key` | 0 |
| TREATMENT (recense actual) | `project` | stripped | `null` | `Not logged in · Please run /login` | 0 |

**CONTROL** — With user settings loaded, the tracer key in `settings.json`'s `env` block
**was injected and used**: `claude -p` attempted API-key auth and returned a 401 for the
invalid key. This proves (a) the tracer is detectable, and (b) the spawn-env strip ALONE
does **not** stop the settings.json vector — Claude Code re-injects the key from
`settings.json` *after* the strip, and that re-injected key overrides the subscription login.

**TREATMENT** — With `--setting-sources project` (recense's real config), the key was
**never injected**: there is no 401 / no "Invalid API key" path. Instead `claude -p` fell
through to the subscription/OAuth login path and reported "Not logged in" only because the
throwaway temp `HOME` has no stored login. In the founder's real environment (logged-in
subscription), this same path resolves to a subscription call (`total_cost_usd: 0`). The
key point is the **absence of the 401 / api-key path**: `--setting-sources project`
excluded the user `settings.json` `env` block, so the key did not re-inject.

## Interpretation — two distinct injection vectors

The two safeguards defend **different** vectors; they are not redundant:

1. **Parent-process-env vector** — `ANTHROPIC_API_KEY` exported in the shell/process that
   spawns recense. Defended by the spawn-env strip (`delete childEnv['ANTHROPIC_API_KEY']`).
2. **settings.json `env`-block vector** — the 2026-06-17 incident shape. Claude Code
   re-injects this itself when user settings load, *past* the spawn-env strip (CONTROL
   proves this). Defended by **`--setting-sources project`**, which excludes user settings
   entirely (TREATMENT proves this).

So the load-bearing guard against the `settings.json` footgun is `--setting-sources project`,
**not** the env-strip. The doc comment at `claude-headless-client.ts:11-16` attributes the
settings.json protection to the env-strip ("The spawn env DELETES ANTHROPIC_API_KEY … so
`claude -p` falls back to the … login"); that is incomplete for the settings.json vector —
the strip is defeated by re-injection, and `--setting-sources project` is what actually
suppresses it. (Comment-accuracy is a NOTE, not fixed here — observe-only scope.)

## Decision

- **D-17 is answered empirically:** under the current `--setting-sources project` transport,
  the settings.json billing leak does **not** fire — the key never re-injects.
- This is the "genuine suppression flag" branch the plan anticipated. Per scope, it is a
  NOTE only: **no transport hardening is committed here** (none is needed — the existing
  flag already suppresses), and it remains a deferred idea.
- **The warn-only design (init acknowledge-gate D-07/D-10, doctor billing dimension D-12)
  ships regardless of this outcome.** It is still warranted as defense-in-depth: it protects
  against (a) config/flag drift that could drop `--setting-sources project`, (b) the
  parent-process-env vector, and (c) any future code path that does not route through this
  transport. Naming the footgun (warn-only, recense never edits the file) remains correct.

## Scope-fence compliance

- No production source under `src/` was modified by this plan.
- The real `~/.claude/settings.json` was never edited — only a throwaway copy under a temp HOME.
- No literal API-key value is recorded in this finding (a grep for the Anthropic key
  prefix returns 0).
