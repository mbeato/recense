# D-07 — Native auto-memory kill-switch investigation

**Question:** Can Claude Code's native file-based auto-memory (the `~/.claude/projects/<project>/memory/` + `MEMORY.md` feature) be disabled via `settings.json` or a documented setting/hook?

**Finding: YES — a genuine switch exists, and it was applied.**

Verified against the official Claude Code docs (https://code.claude.com/docs/en/memory, fetched 2026-06-20):

| Mechanism | Effect | Scope |
|-----------|--------|-------|
| `"autoMemoryEnabled": false` in `settings.json` | Disables auto memory entirely | Any settings scope (user / project / local / policy / `--settings`) |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` env var | Disables auto memory entirely | Process env |
| `/memory` in-session toggle | Disables auto memory | Interactive |
| `autoMemoryDirectory` | **Relocates** the memory dir (does NOT disable) | Any scope |

The docs are explicit that CLAUDE.md / auto-memory are **context, not enforced configuration** — "To block an action regardless of what Claude decides, use a PreToolUse hook." So the directive (D-06) shapes behavior; `autoMemoryEnabled: false` is the closest thing to a hard switch short of a deny-hook, and it stops the harness from writing/loading auto-memory at all.

## Applied

- **`autoMemoryEnabled: false`** set in **`~/.claude/settings.json`** (user scope → global, every project) as belt-and-suspenders on top of the D-06 directive. Founder-approved 2026-06-20 (global scope chosen over project-only).
- Settings file re-validated as parseable JSON after the edit; all prior keys (`env`, `model`, `hooks`, plugins, etc.) intact.

## Not done (deliberately)

- **No PreToolUse-deny hook built.** The plan deferred a heavyweight deny-hook unless investigation proved it was the only real mechanism. It is not — `autoMemoryEnabled: false` is a real, documented switch — so no speculative hook was created. (If hard enforcement is ever wanted beyond the switch + directive, a PreToolUse hook on Write/Edit matching the memory dir is the documented escalation, left to a follow-up.)

## Net effect

Native auto-memory is now disabled three ways: the D-06 directive (`~/.claude/CLAUDE.md`), the `autoMemoryEnabled: false` switch, and the retirement (archival) of the existing `MEMORY.md` index via the migration. `recense remember` is the single write path; `recense recall` at SessionStart is the read path.
