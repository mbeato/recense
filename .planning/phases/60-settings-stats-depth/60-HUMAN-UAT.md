---
status: partial
phase: 60-settings-stats-depth
source: [60-VERIFICATION.md]
started: 2026-07-11T21:40:00Z
updated: 2026-07-11T21:40:00Z
---

## Current Test

[awaiting human testing]

## Tests

### 1. Open via settings link
expected: Open settings, click `View usage stats →` — the brain is replaced full-window by the stats surface on the Usage tab. (A fresh `recense viz` serves at http://127.0.0.1:7810; relaunch if not running.)
result: [pending]

### 2. Usage tab content
expected: Burn chart is the focal anchor; cost-event dashed markers appear at the known dates (2026-07-03 thinking-off, Phase-42 skip-threshold) and hovering one shows a before/after avg-burn delta; per-feature and per-model splits render; retail-$ headline reads `API-retail equivalent (subscription-billed: $0 marginal)`.
result: [pending]

### 3. Range pills and refresh
expected: 7d/30d/90d/all-time pills rescope the charts; all-time shows weekly buckets with parseable dates; clicking refresh updates the `as of {HH:MM:SS}` stamp.
result: [pending]

### 4. Brain Health tab
expected: All six metric groups render in identity hues (reconsolidation magenta, tombstone coral, judge cyan, node-growth sage); node-growth approximation caption present; judge activity shows fires only (escalation honestly unavailable); last-sleep-pass tile shows an honest status, never a fabricated success.
result: [pending]

### 5. Design-language conformance
expected: No amber anywhere on either tab; surface is flat (not glass); charts read as Phase-59-native.
result: [pending]

### 6. Close behavior
expected: Escape / × closes back to the brain; if the corpus view was open before, its HUD chrome is not clobbered.
result: [pending]

### 7. Palette entry
expected: ⌘K → `Open stats` opens the takeover; the command hides while the dashboard is already open.
result: [pending]

### 8. Compact/tray LOD
expected: Nothing from the stats surface leaks into the compact/tray popover LOD.
result: [pending]

## Summary

total: 8
passed: 0
issues: 0
pending: 8
skipped: 0
blocked: 0

## Gaps
