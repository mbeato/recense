/**
 * Settings panel (Phase 44-06) — in-app cost-controls surface inside the viz frontend.
 *
 * Mirrors reader.js structure exactly:
 *   - initSettings(ctx) export with panel guard
 *   - show()/hide() toggling panel.classList 'open' + documentElement class
 *   - fetch GET /settings on first open (non-fatal try/catch, mirrors fetchMeta)
 *   - POST /settings on save (re-render from returned effective config)
 *   - fetch GET /usage on open (non-fatal try/catch)
 *   - SECURITY: textContent-only for ALL server/user-sourced values (T-44-19,
 *     mirror reader.js 452-463 — zero innerHTML for dynamic values)
 *
 * Implements: D-02 (no IPC), D-03 (frontend settings.json consumer),
 *             D-09 (feature line maps 1:1 to its toggle), D-10 (30d + all-time readout),
 *             D-11 (preset + overrides + divergence label), D-12 (core always-on, no toggle)
 */

// Preset defaults mirrored from PRESET_CONFIGS (src/lib/config.ts) — used
// to detect override divergence from the selected preset baseline (D-11).
const PRESET_DEFAULTS = {
  lite:     { corpusGen: false, schemaInductionEnabled: false },
  standard: { corpusGen: false, schemaInductionEnabled: true },
  full:     { corpusGen: true, corpusGenMax: 25, schemaInductionEnabled: true },
};

// Display fallbacks for tuning inputs when effective config is absent.
const DEFAULT_THRESHOLDS = {
  consolSkipThreshold:          0.2,
  consolSkipThresholdAssistant: 0.5,
  corpusSubjectDriftThreshold:  3,
  sleepFrequencyHours:          1,
};

export function initSettings(_ctx) {
  const panel = document.getElementById('settings-panel');
  if (!panel) return;

  const btn     = document.getElementById('btn-settings');
  const closeBtn = document.getElementById('settings-close');
  const bodyEl  = document.getElementById('settings-body');

  let loaded = false;

  // ── Show / hide ─────────────────────────────────────────────────────────────

  function show() {
    panel.classList.add('open');
    document.documentElement.classList.add('settings-panel-open');
    if (!loaded) { load(); loaded = true; }
  }

  function hide() {
    panel.classList.remove('open');
    document.documentElement.classList.remove('settings-panel-open');
  }

  if (btn) btn.addEventListener('click', () =>
    panel.classList.contains('open') ? hide() : show()
  );
  if (closeBtn) closeBtn.addEventListener('click', () => hide());

  // Escape closes the panel when open (mirrors reader.js)
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && panel.classList.contains('open')) hide();
  });

  // ── Load on first open ───────────────────────────────────────────────────────

  async function load() {
    if (!bodyEl) return;
    bodyEl.textContent = 'loading…';
    const [settingsData, usageData] = await Promise.all([
      fetchSettings(),
      fetchUsage(),
    ]);
    render(settingsData, usageData);
  }

  // ── Fetch /settings (non-fatal, mirrors fetchMeta in reader.js) ─────────────

  async function fetchSettings() {
    try {
      const res = await fetch('/settings');
      if (!res.ok) return null;
      return await res.json();
    } catch (_) {
      return null;
    }
  }

  // ── Fetch /usage (non-fatal) ─────────────────────────────────────────────────

  async function fetchUsage() {
    try {
      const res = await fetch('/usage');
      if (!res.ok) return null;
      return await res.json();
    } catch (_) {
      return null;
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  // formFields accumulates all toggle/number inputs per render pass so save()
  // can collect values without any querySelectorAll traversal.

  function render(settingsData, usageData) {
    if (!bodyEl) return;
    bodyEl.textContent = '';

    if (!settingsData) {
      const err = document.createElement('div');
      err.className = 'settings-error';
      err.textContent = 'could not load settings'; // textContent only — T-44-19
      bodyEl.appendChild(err);
      return;
    }

    const { preset, overrides, effective } = settingsData;
    const hasOverrides = Object.keys(overrides || {}).length > 0;
    const presetLabel = preset
      ? preset.charAt(0).toUpperCase() + preset.slice(1)
      : 'Standard';

    // Track form fields in this render pass for save() to collect (avoids querySelectorAll).
    const formFields = [];

    // ── Header (D-11 divergence label) ────────────────────────────────────────
    const headerEl = document.createElement('div');
    headerEl.className = 'settings-section-head';
    // textContent only — T-44-19 (preset name comes from server but is one of three enum strings)
    headerEl.textContent = hasOverrides ? presetLabel + ' (modified)' : presetLabel;
    bodyEl.appendChild(headerEl);

    // ── Preset selector ───────────────────────────────────────────────────────
    const presetWrap = document.createElement('div');
    presetWrap.className = 'settings-row';
    const presetLbl = document.createElement('span');
    presetLbl.className = 'settings-label';
    presetLbl.textContent = 'preset'; // static label — textContent is fine
    presetWrap.appendChild(presetLbl);

    const presetSel = document.createElement('select');
    presetSel.className = 'settings-select';
    for (const p of ['lite', 'standard', 'full']) {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = p.charAt(0).toUpperCase() + p.slice(1); // static text
      if (p === preset) opt.selected = true;
      presetSel.appendChild(opt);
    }
    // Explicit value assignment so fake-DOM and real DOM both work correctly.
    presetSel.value = preset || 'standard';
    presetWrap.appendChild(presetSel);
    bodyEl.appendChild(presetWrap);

    appendDivider(bodyEl);

    // ── Core: extract + reconsolidation — always on, no toggle (D-12) ─────────
    const coreRow = document.createElement('div');
    coreRow.className = 'settings-row settings-core-row';
    const coreLbl = document.createElement('span');
    coreLbl.className = 'settings-label';
    // Static string — textContent is fine (not server-sourced data)
    coreLbl.textContent = 'core: extract + reconsolidation — always on (this is recense)';
    coreRow.appendChild(coreLbl);
    bodyEl.appendChild(coreRow);
    // Usage tied to the core row (extraction + judging) — placed adjacent (D-09)
    appendUsageLines(bodyEl, usageData, ['extract', 'judge']);

    appendDivider(bodyEl);

    // ── Optional features ─────────────────────────────────────────────────────
    const optHead = document.createElement('div');
    optHead.className = 'settings-section-subhead';
    optHead.textContent = 'optional features';
    bodyEl.appendChild(optHead);

    // Schema abstraction toggle (Standard+)
    const schemaRow = makeToggleRow(
      'schema abstraction',
      'schemaInductionEnabled',
      effective && effective.schemaInductionEnabled !== undefined
        ? effective.schemaInductionEnabled
        : true,
      formFields,
    );
    bodyEl.appendChild(schemaRow);
    // Usage adjacent to the schema toggle (D-09)
    appendUsageLines(bodyEl, usageData, ['schema_abstract']);

    // Readable corpus docs toggle (Full)
    const corpusRow = makeToggleRow(
      'readable corpus docs',
      'corpusGen',
      effective && effective.corpusGen !== undefined ? effective.corpusGen : false,
      formFields,
    );
    bodyEl.appendChild(corpusRow);

    // Corpus docs per pass (number input, adjacent to corpus toggle — D-09)
    const corpusMaxRow = makeNumberRow(
      'corpus docs per pass',
      'corpusGenMax',
      effective && effective.corpusGenMax !== undefined ? effective.corpusGenMax : 25,
      formFields,
    );
    bodyEl.appendChild(corpusMaxRow);
    // Usage adjacent to corpus toggle (D-09)
    appendUsageLines(bodyEl, usageData, ['corpus_gen']);

    appendDivider(bodyEl);

    // ── Tuning inputs ─────────────────────────────────────────────────────────
    const tuningHead = document.createElement('div');
    tuningHead.className = 'settings-section-subhead';
    tuningHead.textContent = 'tuning';
    bodyEl.appendChild(tuningHead);

    bodyEl.appendChild(makeNumberRow(
      'salience skip threshold',
      'consolSkipThreshold',
      effective && effective.consolSkipThreshold !== undefined
        ? effective.consolSkipThreshold
        : DEFAULT_THRESHOLDS.consolSkipThreshold,
      formFields,
    ));
    bodyEl.appendChild(makeNumberRow(
      'assistant salience threshold',
      'consolSkipThresholdAssistant',
      effective && effective.consolSkipThresholdAssistant !== undefined
        ? effective.consolSkipThresholdAssistant
        : DEFAULT_THRESHOLDS.consolSkipThresholdAssistant,
      formFields,
    ));
    bodyEl.appendChild(makeNumberRow(
      'subject-doc drift threshold',
      'corpusSubjectDriftThreshold',
      effective && effective.corpusSubjectDriftThreshold !== undefined
        ? effective.corpusSubjectDriftThreshold
        : DEFAULT_THRESHOLDS.corpusSubjectDriftThreshold,
      formFields,
    ));
    bodyEl.appendChild(makeNumberRow(
      'sleep frequency (hours)',
      'sleepFrequencyHours',
      overrides && overrides.sleepFrequencyHours !== undefined
        ? overrides.sleepFrequencyHours
        : DEFAULT_THRESHOLDS.sleepFrequencyHours,
      formFields,
    ));

    appendDivider(bodyEl);

    // ── Token usage readout (D-09 / D-10) ─────────────────────────────────────
    appendFullUsageReadout(bodyEl, usageData);

    // ── Save button ───────────────────────────────────────────────────────────
    const saveBtn = document.createElement('button');
    saveBtn.className = 'settings-save-btn';
    saveBtn.textContent = 'save';
    saveBtn.addEventListener('click', () =>
      save(presetSel, formFields)
    );
    bodyEl.appendChild(saveBtn);
  }

  // ── Save ────────────────────────────────────────────────────────────────────

  async function save(presetSel, formFields) {
    const newPreset = presetSel.value;
    const presetDefaults = PRESET_DEFAULTS[newPreset] || {};
    const newOverrides = {};

    // Collect non-default values from form fields as overrides (D-11).
    for (const field of formFields) {
      if (field.type === 'boolean') {
        const val = field.el.checked;
        if (presetDefaults[field.key] === undefined || presetDefaults[field.key] !== val) {
          newOverrides[field.key] = val;
        }
      } else if (field.type === 'number') {
        const val = parseFloat(field.el.value);
        if (!isNaN(val)) {
          if (presetDefaults[field.key] === undefined || presetDefaults[field.key] !== val) {
            newOverrides[field.key] = val;
          }
        }
      }
    }

    try {
      const res = await fetch('/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ preset: newPreset, overrides: newOverrides }),
      });
      if (!res.ok) return;
      const updated = await res.json();
      // Re-render from the server's returned effective config (reflects D-12 backstop).
      const newUsage = await fetchUsage();
      loaded = false; // allow re-open to re-fetch
      render(updated, newUsage);
    } catch (_) {
      // save failure is non-fatal (mirrors reader.js non-fatal fetch posture)
    }
  }

  // ── DOM helpers ───────────────────────────────────────────────────────────────

  function appendDivider(parent) {
    const hr = document.createElement('hr');
    hr.className = 'settings-divider';
    parent.appendChild(hr);
  }

  /** Creates a boolean toggle row and registers it in formFields. */
  function makeToggleRow(label, key, checked, formFields) {
    const row = document.createElement('div');
    row.className = 'settings-row settings-toggle-row';

    const lbl = document.createElement('span');
    lbl.className = 'settings-label';
    lbl.textContent = label; // static UI label — textContent is fine
    row.appendChild(lbl);

    const inp = document.createElement('input');
    inp.type = 'checkbox';
    inp.className = 'settings-toggle';
    inp.checked = !!checked;
    row.appendChild(inp);

    formFields.push({ key, type: 'boolean', el: inp });
    return row;
  }

  /** Creates a number input row and registers it in formFields. */
  function makeNumberRow(label, key, value, formFields) {
    const row = document.createElement('div');
    row.className = 'settings-row settings-number-row';

    const lbl = document.createElement('span');
    lbl.className = 'settings-label';
    lbl.textContent = label; // static UI label — textContent is fine
    row.appendChild(lbl);

    const inp = document.createElement('input');
    inp.type = 'number';
    inp.className = 'settings-number-input';
    inp.value = String(value); // number → string; textContent not applicable to input.value
    row.appendChild(inp);

    formFields.push({ key, type: 'number', el: inp });
    return row;
  }

  // ── Usage lines adjacent to toggles (D-09) ───────────────────────────────────

  /**
   * Appends a compact per-feature usage line adjacent to its controlling toggle.
   * Each feature tag listed maps 1:1 to a toggle row (D-09).
   * SECURITY: all numbers rendered via textContent (T-44-19).
   */
  function appendUsageLines(parent, usageData, featureTags) {
    const rows30d = (usageData && usageData.rolling_30d && usageData.rolling_30d.byFeature) || [];
    let totalTokens = 0;
    let totalCost = 0;
    for (const row of rows30d) {
      if (featureTags.indexOf(row.feature_tag) !== -1) {
        // /usage rows carry input_tokens + output_tokens (no combined field) —
        // sum them the same way the route computes the headline totalTokens.
        totalTokens += (row.input_tokens || 0) + (row.output_tokens || 0);
        totalCost   += row.total_cost_usd || 0;
      }
    }

    const lineEl = document.createElement('div');
    lineEl.className = 'settings-usage-line';
    // textContent only — T-44-19 (totalTokens/totalCost are numbers from server)
    lineEl.textContent = totalTokens > 0
      ? fmtTokens(totalTokens) + ' tokens this month (~$' + totalCost.toFixed(4) + ')'
      : '0 tokens this month';
    parent.appendChild(lineEl);
  }

  // ── Full usage readout (D-09 / D-10) ─────────────────────────────────────────

  /**
   * Appends the complete token-usage section: 30d headline, per-feature breakdown
   * (each line maps to its toggle — D-09), and all-time total (D-10).
   * SECURITY: all values rendered via textContent (T-44-19).
   */
  function appendFullUsageReadout(parent, usageData) {
    const section = document.createElement('div');
    section.className = 'settings-usage-section';

    const usageHead = document.createElement('div');
    usageHead.className = 'settings-section-subhead';
    usageHead.textContent = 'token usage';
    section.appendChild(usageHead);

    // Empty / null guard
    if (!usageData) {
      const na = document.createElement('div');
      na.className = 'settings-usage-empty';
      na.textContent = 'no usage recorded yet'; // static string — textContent is fine
      section.appendChild(na);
      parent.appendChild(section);
      return;
    }

    const { rolling_30d, all_time } = usageData;
    const total30d   = (rolling_30d && rolling_30d.totalTokens)  || 0;
    const totalAllTime = (all_time && all_time.totalTokens) || 0;

    if (total30d === 0 && totalAllTime === 0) {
      const na = document.createElement('div');
      na.className = 'settings-usage-empty';
      na.textContent = 'no usage recorded yet';
      section.appendChild(na);
      parent.appendChild(section);
      return;
    }

    // 30d headline (D-10) — textContent only for all values — T-44-19
    const headline = document.createElement('div');
    headline.className = 'settings-usage-headline';
    const costStr = (rolling_30d && rolling_30d.totalCostUsd)
      ? ' (~$' + rolling_30d.totalCostUsd.toFixed(4) + ')'
      : '';
    headline.textContent =
      'this period you spent ' + fmtTokens(total30d) + ' tokens' + costStr;
    section.appendChild(headline);

    // Per-feature breakdown (D-09) — each line maps to its toggle
    // Feature order matches the toggle order: core (extract+judge), schema, corpus
    const FEATURE_LABELS = [
      { tag: 'extract',        label: 'extraction' },
      { tag: 'judge',          label: 'judging' },
      { tag: 'schema_abstract', label: 'schema abstraction' },
      { tag: 'corpus_gen',     label: 'corpus docs' },
    ];
    const byFeature = (rolling_30d && rolling_30d.byFeature) || [];

    for (const { tag, label } of FEATURE_LABELS) {
      const row = byFeature.find(r => r.feature_tag === tag);
      // /usage rows carry input_tokens + output_tokens (no combined field) — sum
      // them like the route's headline totalTokens so per-feature lines aren't 0.
      const tokens = row ? (row.input_tokens || 0) + (row.output_tokens || 0) : 0;
      const cost   = (row && row.total_cost_usd) || 0;

      const lineEl = document.createElement('div');
      lineEl.className = 'settings-usage-feature-line';
      // textContent only — T-44-19 (label is static; tokens/cost are numbers)
      lineEl.textContent = label + ': '
        + (tokens > 0
          ? fmtTokens(tokens) + ' tokens (~$' + cost.toFixed(4) + ')'
          : '0 tokens');
      section.appendChild(lineEl);
    }

    // All-time total (D-10) — textContent only — T-44-19
    const allTimeEl = document.createElement('div');
    allTimeEl.className = 'settings-usage-alltime';
    const allTimeCost = (all_time && all_time.totalCostUsd)
      ? ' (~$' + all_time.totalCostUsd.toFixed(4) + ')'
      : '';
    allTimeEl.textContent =
      'all time: ' + fmtTokens(totalAllTime) + ' tokens' + allTimeCost;
    section.appendChild(allTimeEl);

    parent.appendChild(section);
  }

  // ── Format helpers ─────────────────────────────────────────────────────────

  /** Human-readable token count: 1.2M, 34.5k, or plain number. */
  function fmtTokens(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'k';
    return String(n);
  }
}
