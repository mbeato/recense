---
phase: 45-subscription-default-install-billing-leak-warning
plan: 04
status: complete
autonomous: false
---

# 45-04 SUMMARY — Billing-Leak Investigation (D-17)

## Conclusion

**Leak still fires: NO.** Under recense's current `--setting-sources project` transport,
the `~/.claude/settings.json` `env`-block billing leak does **not** fire — the key never
re-injects into `claude -p`, so the call uses the Max subscription, not the direct API.

`--setting-sources project` is the load-bearing safeguard for the settings.json vector
(it excludes user settings entirely). The spawn-env strip (`delete childEnv['ANTHROPIC_API_KEY']`)
defends a *different* vector — a key in the parent process env — and is, on its own,
defeated by settings.json re-injection (proven by the CONTROL run). The two guards are
complementary, not redundant.

## Method (observe-only, zero spend)

Tracer reproduction with an **invalid** API key in a throwaway temp-`HOME` `settings.json`;
an invalid key 401s before any billable call. Two `claude -p --output-format json` runs:
- CONTROL (`--setting-sources user`): tracer key injected → **401 Invalid API key** → leak vector is real and the env-strip alone does not stop it.
- TREATMENT (`--setting-sources project`, recense's real flags): key **not** injected (no 401; fell through to subscription/OAuth login path) → no leak.

Both runs reported `total_cost_usd: 0`. Full detail and the result table are in
`45-04-FINDING.md`.

## Scope / safety

- No production code changed (no `src/` modification).
- The founder's real `~/.claude/settings.json` was never edited — only a throwaway copy under a temp HOME.
- No literal API-key value recorded (key-prefix grep on the finding returns 0).
- Transport hardening remains **deferred** (none needed). The warn-only design
  (init acknowledge-gate, doctor billing dimension) **ships regardless** as defense-in-depth
  against flag/config drift and the parent-env vector.

## Key files

- created: `.planning/phases/45-subscription-default-install-billing-leak-warning/45-04-FINDING.md`

## Self-Check: PASSED
