---
phase: 60
slug: settings-stats-depth
status: verified
threats_open: 0
asvs_level: 1
created: 2026-07-13
---

# Phase 60 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| browser → viz server | HTTP query params + Host header cross here (untrusted) |
| server → SQLite | read-only handle; aggregate queries only |
| constants.js source → server | COST_EVENTS marker list parsed from disk text at startup (trusted, own-repo source) |
| /stats/usage, /stats/brain-health JSON → DOM/SVG | server numbers/dates/labels become chart geometry + text |
| CSS surface additions → D-14 invariant | new #stats-view selectors must not extend the backdrop-filter glass allow-list |
| settings link / palette command → ctx | pure client navigation, no server input crosses here |
| DOM ↔ server data (GAP-1/GAP-2 client redesign) | summary/lever_deltas values are server-sourced; must render textContent-only |

---

## Threat Register

| Threat ID | Category | Component | Disposition | Mitigation | Status |
|-----------|----------|-----------|-------------|------------|--------|
| T-60-01 (60-01) | Tampering (SQLi) | `window` query param → SQL | mitigate | Validated against literal `ALLOWED_WINDOWS` set `{7d,30d,90d,all}`, falls back to `30d` on anything else; cutoff always bound via `?` — verified server.ts:1526-1535, no raw param concatenated into SQL | closed |
| T-60-02 (60-01) | Information Disclosure | `/stats/usage`/`/stats/brain-health` error path | mitigate | `catch { res.writeHead(500); res.end('internal error') }` — no SQL/stack in body (T-44-17) — verified server.ts:1675-1678, 1746-1749 | closed |
| T-60-03 (60-01) | Spoofing | Host header on new routes | mitigate | Single DNS-rebinding 403 guard at the top of `http.createServer`, before all route dispatch (server.ts:854-862) — covers `/stats/usage` (1517) and `/stats/brain-health` (1685) with zero per-route duplication; tests assert 403 (viz-stats-routes.test.ts) | closed |
| T-60-04 (60-01) | Repudiation/Integrity | metrics honesty | mitigate | `last_sleep_pass.status` is the literal `'unknown'`/`'none'`, never fabricated; `node_growth.approximate:true` — verified server.ts:1723-1734, 1738; test asserts no `'ok'`/`'success'` literal (viz-stats-routes.test.ts:509) | closed |
| T-60-09 (60-01) | Integrity (mirror-drift) | COST_EVENTS marker list | mitigate | `parseCostEvents()` source-parses `constants.js` at startup (mirrors `parseSchedulerScalars`), fail-fast if absent; no re-declared server literal — verified server.ts:114-134; `grep -nE "COST_EVENTS\s*=\s*\["` in server.ts returns no match | closed |
| T-60-05 (60-01) | Denial of Service | unbounded aggregate | accept | Read-only handle, all new statements compiled once at startup (server.ts:461-634, before `http.createServer` at 851), window-bounded; single-tenant loopback-only surface (Host guard + 127.0.0.1 bind) | closed |
| T-60-SC (60-01) | Tampering | package installs | accept | No install task; verified no new runtime dependency added by Phase 60 (package.json diff on this branch is an unrelated Phase-51 wabt version pin) | closed |
| T-60-04 (60-02) | Tampering (XSS) | chart `<text>` / tooltip labels | mitigate | All label text set via `.textContent` (charts.js:244,255,283,342); SVG nodes via `createElementNS`+`setAttribute`; `grep -n innerHTML src/viz/modules/charts.js` returns no match | closed |
| T-60-06 (60-02) | Integrity (palette) | series color selection | mitigate | Colors sourced only from `KIND_COLOR`/`TYPE_COLOR`/`NEUTRAL_SERIES_RAMP`; `grep -niE "ffb866" src/viz/modules/charts.js` returns no match | closed |
| T-60-SC (60-02) | Tampering | package installs | accept | Hand-rolled SVG, zero new dependency — confirmed no new deps | closed |
| T-60-04 (60-03) | Tampering (XSS) | chart labels, retail-$, timestamps | mitigate | All server-sourced values via `.textContent`; SVG via charts.js `createElementNS`; `grep -vE '^\s*(//|\*)' stats-dashboard.js \| grep innerHTML` returns no match | closed |
| T-60-07 (60-03) | Integrity (design lock) | `#stats-view` CSS | mitigate | No `backdrop-filter` on `#stats-view` or its chart-card sub-rules (styles.css:1479-1730 inspected, all `backdrop-filter` hits in the file are pre-existing panels before line 1479); D-14-C allow-list test (`tests/viz-activity-palette-invariants.test.ts`) parses actual CSS blocks by selector and passes live (59/59) with `#stats-view` absent from `ALLOWED_SELECTORS` | closed |
| T-60-08 (60-03) | Availability | fetch failure / empty DB | mitigate | Non-fatal fetch → `'could not load usage stats'`; zeroed data → `'no usage recorded yet'` — verified stats-dashboard.js:266,276 | closed |
| T-60-SC (60-03) | Tampering | package installs | accept | Zero new deps confirmed | closed |
| T-60-04 (60-04) | Tampering (XSS) | metric labels, status tile, tooltips | mitigate | All server-sourced values via `.textContent`; no innerHTML in Brain-Health render path | closed |
| T-60-04b (60-04) | Integrity (honesty) | last-sleep-pass status | mitigate | Server `'unknown'`/`'none'` rendered as-is; no client fabricated success; D-13 approximation caption present — verified stats-dashboard.js render path + server.ts:1733 | closed |
| T-60-06 (60-04) | Integrity (palette) | Brain-Health series colors | mitigate | Identity hues from `KIND_COLOR`/`TYPE_COLOR` only; `grep -niE "ffb866\|amber" stats-dashboard.js` returns no match | closed |
| T-60-08 (60-04) | Availability | empty brain / fetch fail | mitigate | `'No brain activity yet'` / `'could not load brain-health stats'` verified stats-dashboard.js:1028,1037 | closed |
| T-60-SC (60-04) | Tampering | package installs | accept | Zero new deps confirmed | closed |
| T-60-04 (60-05) | Tampering (XSS) | link/command labels | mitigate | `.settings-usage-link` text set via `.textContent = 'View usage stats →'` (settings.js:262); palette `'Open stats'` is a static label — no server data rendered on these two entry points | closed |
| T-60-09 (60-05) | Integrity | single source of truth | mitigate | `appendFullUsageReadout` deleted from settings.js — `grep -n appendFullUsageReadout src/viz/modules/settings.js` returns no match; duplicate 30d/all-time readout can no longer drift from the dashboard | closed |
| T-60-SC (60-05) | Tampering | package installs | accept | Zero new deps confirmed | closed |
| T-60-10 (60-06) | Integrity | pre-checkpoint build state | mitigate | Full viz test suite + `tsc --noEmit` independently re-run during this audit: 149+ viz tests green, tsc clean — build is green at time of audit | closed |
| T-60-SC (60-06) | Tampering | package installs | accept | Verification-only plan, no installs | closed |
| T-60-07-01 (60-07) | Tampering | SVG `<text>` / tooltip content (responsive-render refactor) | mitigate | Width-threading refactor introduced no innerHTML — `grep -vE '^\s*(//\|\*)' stats-dashboard.js \| grep -c innerHTML` == 0; charts.js untouched by this plan | closed |
| T-60-07-02 (60-07) | Denial of Service | resize handler | accept | Single debounced (200ms) `window.addEventListener('resize', ...)` listener (stats-dashboard.js:252-255) that re-renders only cached data — verified `handleResize()` body (stats-dashboard.js:241-250) calls no fetch and no `stampAsOf()` | closed |
| T-60-08-01 (60-08) | Tampering (SQLi) | new prepared statements (`stmtTokensSince`, `stmtTokensBetween`, `stmtHeaviestDaySince`, `stmtUsageDailyBucketsAll`) | mitigate | All cutoffs are server-computed `Date.now()`/`Date.UTC()`-derived numbers bound via `?` (server.ts:531-566); no request value concatenated into SQL text | closed |
| T-60-08-02 (60-08) | Information Disclosure | summary framing numbers | accept | Only aggregate token/cost baselines already exposed by the existing route; no PII/per-record leakage; `grep -niE "quota_remaining\|quota remaining\|remaining_tokens"` across server.ts and stats-dashboard.js returns no match — no fabricated quota figure | closed |
| T-60-08-03 (60-08) | Spoofing/DNS-rebinding | `/stats/usage` (extended) | mitigate | Unchanged — inherits the same top-of-`createServer` Host-header 403 guard verified under T-60-03; existing test still asserts 403 | closed |
| T-60-09-01 (60-09) | Tampering (XSS) | stat tiles / framing / levers / breakdown text | mitigate | Every server-sourced value via `.textContent`; `renderStatTileRow`/`renderFraming`/`renderLeversCard`/`renderUsageBreakdown` all textContent-only, no innerHTML | closed |
| T-60-09-02 (60-09) | Elevation (design-invariant bypass) | new styles.css selectors (`.stats-tile-row`, `.stats-framing`, `.stats-levers-*`, `.stats-breakdown-*`) | mitigate | No `backdrop-filter` on any of the new selectors (styles.css:1644-1730 inspected); D-14 allow-list test (`viz-activity-palette-invariants.test.ts`) re-run live and green (59/59) | closed |
| T-60-09-03 (60-09) | Information Disclosure | framing copy | accept | Baseline-relative "vs your typical" only; no fabricated quota; no new data beyond the already-exposed `summary` object (covered under T-60-08-02's verification) | closed |

*Status: open · closed*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

Note: several Threat IDs recur across sibling/gap-closure plans within Phase 60 (e.g. `T-60-04`, `T-60-06`, `T-60-08`, `T-60-09`, `T-60-SC`) because each plan's own `<threat_model>` block re-declares the same STRIDE category against that plan's specific component/files. Each occurrence above is verified independently against its own component, disambiguated by `(plan-id)`.

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-60-01 | T-60-05 (60-01) | Both `/stats/*` routes are read-only, window-bounded, use prepared statements compiled once at startup, and are only reachable on a loopback-bound, Host-guarded, single-tenant server — no unauthenticated remote caller can trigger unbounded work | plan 60-01 | 2026-07-11 |
| AR-60-02 | T-60-SC (all plans) | Phase 60 (plans 01-09) introduced zero new runtime dependencies — hand-rolled SVG chart primitives, first-party server routes, and client-side rendering only; verified against package.json/package-lock.json diff on this branch (only unrelated change: a Phase-51 `wabt` version pin, not a Phase-60 commit) | plans 60-01..09 | 2026-07-13 |
| AR-60-03 | T-60-07-02 | Resize re-render is a pure client-side re-layout (debounced 200ms, single listener, cached-data-only, no network call) — negligible cost on a local single-tenant surface, and cannot be triggered remotely | plan 60-07 | 2026-07-13 |
| AR-60-04 | T-60-08-02, T-60-09-03 | `summary`/framing fields are aggregate token/cost baselines already exposed by the pre-existing `/usage`/`/stats/usage` routes; framing is explicitly "vs your typical" (ledger-derived), never a fabricated provider-quota number (grep-verified absent); no PII or per-record data added | plans 60-08, 60-09 | 2026-07-13 |

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-07-13 | 32 | 32 | 0 | gsd-security-auditor (live grep verification against implemented code + independent re-run of viz-stats-routes, viz-charts-geometry, viz-frontend-static, viz-activity-palette-invariants, viz-settings-panel, viz-hud-palette test suites + `tsc --noEmit`) |

---

## Unregistered Attack Surface

None found. All new routes (`/stats/usage`, `/stats/brain-health`), new response fields (`summary`, `lever_deltas`), new client entry points (settings link, palette command), new CSS surfaces (`#stats-view` and sub-cards), and the GAP-1/GAP-2 gap-closure changes (responsive chart width, resize handler, redesigned Usage tab) map to an existing threat in the register above. No `## Threat Flags` section was present in any of the nine 60-0N-SUMMARY.md files (confirmed via `grep -rn "Threat Flags"` across the phase's summaries — no matches), so no executor-flagged new attack surface required reconciliation.

The Phase 60 code-review pass (`60-REVIEW.md`) found and fixed 11 Critical/Warning defects (CR-01..04, WR-01..07); none were security defects — the review's own summary states "the security invariants hold" and all findings were metric-correctness or chart-interaction bugs. Two review fixes are load-bearing for the honesty posture this audit relies on and were independently re-verified here: CR-03 (`judge_activity.escalation_rate` reports `null` rather than a structurally-fabricated 1.0 — server.ts:1710-1713) and WR-07 (`POST /settings` replace semantics — server.ts:1440, pre-existing endpoint, outside the Phase-60 threat register but confirmed not to weaken T-44-15's key-whitelist guard).

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-07-13
