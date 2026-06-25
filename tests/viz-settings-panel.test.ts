/**
 * Tests for the in-app settings panel (44-06 Tasks 1 & 2).
 *
 * Coverage:
 *   Task 1 (preset/toggles/save):
 *     - initSettings returns early when #settings-panel is absent
 *     - btn click triggers show() → panel gets 'open' class
 *     - On first open, fetch('/settings') is called
 *     - Rendered header shows the active preset name
 *     - Non-empty overrides flip header to "<Preset> (modified)" (D-11)
 *     - Save click issues POST /settings with {preset, overrides}
 *     - Re-render after save uses the returned effective config
 *     - Escape key closes the open panel
 *
 *   Task 2 (token-usage readout):
 *     - fetch('/usage') is called on open
 *     - 30d headline rendered with token count
 *     - Per-feature breakdown lines rendered (extraction/judging/schema/corpus)
 *     - All-time total rendered
 *     - Zero / null usage renders empty-state message
 *     - Usage values rendered via textContent (no innerHTML for usage data)
 *
 * DOM-shimmed: a minimal FakeEl tree simulates the browser DOM without
 * jsdom or happy-dom (neither is installed in this project).
 *
 * Timing: instead of vi.waitFor polling, uses flush() which awaits several
 * microtask ticks to let the async load/fetch/render chain complete.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Minimal fake DOM ──────────────────────────────────────────────────────────

class FakeEl {
  tagName: string;
  /** Backing field for textContent; use the getter/setter below. */
  _textContent = '';
  className   = '';
  value       = '';
  checked     = false;
  selected    = false;
  type        = '';
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  _children: FakeEl[] = [];
  _listeners: Record<string, Array<(e: any) => void>> = {};
  _classes: Set<string>;
  classList: {
    _s: Set<string>;
    add: (c: string) => void;
    remove: (c: string) => void;
    contains: (c: string) => boolean;
  };

  /**
   * Mirror real DOM: setting textContent removes all child nodes.
   * This ensures bodyEl.textContent = '' correctly clears _children on re-render.
   */
  get textContent() { return this._textContent; }
  set textContent(v: string) {
    this._textContent = v;
    this._children = [];
  }

  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    const s = new Set<string>();
    this._classes = s;
    this.classList = {
      _s: s,
      add: (c: string) => s.add(c),
      remove: (c: string) => s.delete(c),
      contains: (c: string) => s.has(c),
    };
  }

  appendChild(child: FakeEl) {
    this._children.push(child);
    return child;
  }

  insertBefore(child: FakeEl, ref: FakeEl | null) {
    const idx = ref ? this._children.indexOf(ref) : -1;
    if (idx >= 0) this._children.splice(idx, 0, child);
    else this._children.push(child);
    return child;
  }

  addEventListener(ev: string, fn: (e: any) => void) {
    if (!this._listeners[ev]) this._listeners[ev] = [];
    this._listeners[ev].push(fn);
  }

  /** Fire all listeners for an event (test helper). */
  trigger(ev: string, e: any = {}) {
    for (const fn of this._listeners[ev] ?? []) fn(e);
  }

  querySelector(sel: string): FakeEl | null {
    return findFirst(this, sel);
  }

  querySelectorAll(sel: string): FakeEl[] {
    return findAll(this, sel);
  }

  get firstChild(): FakeEl | null { return this._children[0] ?? null; }

  remove() { /* no-op */ }
  after(_sib: any) { /* no-op */ }
}

// ── DOM tree helpers ──────────────────────────────────────────────────────────

/** Find first descendant (not self) matching a simple CSS selector. */
function findFirst(el: FakeEl, sel: string): FakeEl | null {
  for (const child of el._children) {
    if (matchesSel(child, sel)) return child;
    const found = findFirst(child, sel);
    if (found) return found;
  }
  return null;
}

/** Find all descendants (not self) matching a simple CSS selector. */
function findAll(el: FakeEl, sel: string): FakeEl[] {
  const result: FakeEl[] = [];
  for (const child of el._children) {
    if (matchesSel(child, sel)) result.push(child);
    result.push(...findAll(child, sel));
  }
  return result;
}

/** Minimal CSS selector matcher: .className, [attr="val"], compound [a][b]. */
function matchesSel(el: FakeEl, sel: string): boolean {
  if (sel.startsWith('.')) {
    const cls = sel.slice(1);
    return el.className.split(' ').includes(cls) || el._classes.has(cls);
  }
  // Parse attribute conditions e.g. [data-key][type="checkbox"]
  const attrRe = /\[([a-z][a-z0-9-]*)(?:="([^"]*)")?\]/g;
  const conditions: Array<{ attr: string; val: string | undefined }> = [];
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(sel)) !== null) {
    conditions.push({ attr: m[1] ?? '', val: m[2] });
  }
  if (conditions.length === 0) return false;
  for (const { attr, val } of conditions) {
    if (attr === 'type') {
      if (val !== undefined && el.type !== val) return false;
      if (val === undefined && !el.type) return false;
    } else if (attr.startsWith('data-')) {
      const key = attr.slice(5);
      if (val !== undefined && el.dataset?.[key] !== val) return false;
      if (val === undefined && el.dataset?.[key] === undefined) return false;
    } else {
      return false;
    }
  }
  return true;
}

/** Recursively collect all textContent in the tree (space-joined). */
function collectText(el: FakeEl): string {
  const parts: string[] = [el.textContent];
  for (const child of el._children) parts.push(collectText(child));
  return parts.join(' ');
}

// ── Async flush helper ────────────────────────────────────────────────────────

/**
 * Flush 8 rounds of microtasks + 1 macrotask to let the async load() chain
 * (fetch × 2 → json × 2 → Promise.all → render) complete.
 *
 * Replaces vi.waitFor() polling which was unreliable when the render happens
 * across deeply nested promise chains.
 */
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise<void>(r => setTimeout(r, 0));
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeSettingsResponse(overrides: Record<string, unknown> = {}) {
  return {
    preset: 'standard',
    overrides,
    effective: {
      consolSkipThreshold: 0.2,
      consolSkipThresholdAssistant: 0.5,
      corpusSubjectDriftThreshold: 3,
      corpusGen: false,
      corpusGenMax: 25,
      schemaInductionEnabled: true,
    },
  };
}

function makeUsageResponse() {
  return {
    window_days: 30,
    rolling_30d: {
      byFeature: [
        { feature_tag: 'extract',         total_tokens: 12000, total_cost_usd: 0.0036 },
        { feature_tag: 'judge',           total_tokens: 8000,  total_cost_usd: 0.024  },
        { feature_tag: 'schema_abstract', total_tokens: 4000,  total_cost_usd: 0.012  },
        { feature_tag: 'corpus_gen',      total_tokens: 0,     total_cost_usd: 0      },
      ],
      totalTokens: 24000,
      totalCostUsd: 0.0396,
    },
    all_time: {
      byFeature: [],
      totalTokens: 48000,
      totalCostUsd: 0.0792,
    },
  };
}

function makeZeroUsageResponse() {
  return {
    window_days: 30,
    rolling_30d: { byFeature: [], totalTokens: 0, totalCostUsd: 0 },
    all_time:    { byFeature: [], totalTokens: 0, totalCostUsd: 0 },
  };
}

// ── Test setup ────────────────────────────────────────────────────────────────

let fakePanel: FakeEl;
let fakeBody: FakeEl;
let fakeBtn: FakeEl;
let fakeCloseBtn: FakeEl;
let fakeDocListeners: Record<string, Array<(e: any) => void>>;
let fakeDocumentElement: FakeEl;

function buildFakeDom(includePanel = true) {
  fakePanel           = new FakeEl('div');
  fakeBody            = new FakeEl('div');
  fakeBtn             = new FakeEl('button');
  fakeCloseBtn        = new FakeEl('button');
  fakeDocListeners    = {};
  fakeDocumentElement = new FakeEl('html');

  const elements: Record<string, FakeEl | null> = {
    'settings-panel': includePanel ? fakePanel : null,
    'settings-body':  fakeBody,
    'btn-settings':   fakeBtn,
    'settings-close': fakeCloseBtn,
  };

  (globalThis as any).document = {
    documentElement: fakeDocumentElement,
    getElementById:  (id: string) => elements[id] ?? null,
    createElement:   (tag: string) => new FakeEl(tag),
    addEventListener: (ev: string, fn: (e: any) => void) => {
      if (!fakeDocListeners[ev]) fakeDocListeners[ev] = [];
      fakeDocListeners[ev].push(fn);
    },
  };
}

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  buildFakeDom();
  mockFetch = vi.fn();
  (globalThis as any).fetch = mockFetch;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as any).document;
  delete (globalThis as any).fetch;
});

// ── Import settings.js (browser ESM, ts-ignore for type) ─────────────────────
// @ts-ignore — browser ESM module with no type declarations
const { initSettings } = await import('../src/viz/modules/settings.js');

/** Helper: open the panel, await render completion, return the loaded fakeBody. */
async function openAndRender(
  settingsData = makeSettingsResponse(),
  usageData: any = makeZeroUsageResponse(),
): Promise<FakeEl> {
  mockFetch.mockImplementation((url: string) => {
    if (url === '/settings') return Promise.resolve({ ok: true, json: () => Promise.resolve(settingsData) });
    if (url === '/usage')    return Promise.resolve({ ok: true, json: () => Promise.resolve(usageData) });
    return Promise.resolve({ ok: false });
  });
  initSettings({});
  fakeBtn.trigger('click');
  await flush();
  return fakeBody;
}

// ── Task 1 Tests ──────────────────────────────────────────────────────────────

describe('initSettings — panel guard', () => {
  it('returns early when #settings-panel is absent', async () => {
    buildFakeDom(false); // no panel element
    expect(() => initSettings({})).not.toThrow();
    expect(() => fakeBtn.trigger('click')).not.toThrow();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('initSettings — show/hide', () => {
  it('clicking btn-settings adds "open" class to panel', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(makeSettingsResponse()) });
    initSettings({});
    fakeBtn.trigger('click');
    expect(fakePanel.classList.contains('open')).toBe(true);
  });

  it('clicking btn-settings again removes "open" class (toggle)', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(makeSettingsResponse()) });
    initSettings({});
    fakeBtn.trigger('click'); // open
    await flush();
    fakeBtn.trigger('click'); // close
    expect(fakePanel.classList.contains('open')).toBe(false);
  });

  it('close button removes "open" class', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(makeSettingsResponse()) });
    initSettings({});
    fakeBtn.trigger('click');
    await flush();
    fakeCloseBtn.trigger('click');
    expect(fakePanel.classList.contains('open')).toBe(false);
  });

  it('Escape key closes the panel when open', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(makeSettingsResponse()) });
    initSettings({});
    fakeBtn.trigger('click');
    expect(fakePanel.classList.contains('open')).toBe(true);
    // Fire Escape via the document listener
    for (const fn of fakeDocListeners['keydown'] ?? []) fn({ key: 'Escape' });
    expect(fakePanel.classList.contains('open')).toBe(false);
  });
});

describe('initSettings — render from GET /settings', () => {
  it('calls fetch("/settings") on first open', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(makeSettingsResponse()) });
    initSettings({});
    fakeBtn.trigger('click');
    await flush();
    expect(mockFetch.mock.calls.some((args: any[]) => args[0] === '/settings')).toBe(true);
  });

  it('renders active preset name in header (D-11)', async () => {
    const body = await openAndRender();
    const header = findFirst(body, '.settings-section-head');
    expect(header).not.toBeNull();
    expect(header!.textContent).toBe('Standard');
  });

  it('shows "<Preset> (modified)" when overrides are non-empty (D-11)', async () => {
    const body = await openAndRender(makeSettingsResponse({ corpusGen: true }));
    const header = findFirst(body, '.settings-section-head');
    expect(header).not.toBeNull();
    expect(header!.textContent).toBe('Standard (modified)');
  });

  it('renders "Core: extract + reconsolidation — always on" with no toggle (D-12)', async () => {
    const body = await openAndRender();
    const coreRow = findFirst(body, '.settings-core-row');
    expect(coreRow).not.toBeNull();
    // Core row must include the always-on label
    expect(collectText(coreRow!)).toContain('always on');
    // Core row must NOT contain a checkbox
    expect(findAll(coreRow!, '[type="checkbox"]')).toHaveLength(0);
  });

  it('renders schema and corpus toggle rows', async () => {
    const body = await openAndRender();
    const toggleRows = findAll(body, '.settings-toggle-row');
    expect(toggleRows.length).toBeGreaterThanOrEqual(2);
    const allText = collectText(body);
    expect(allText).toContain('schema abstraction');
    expect(allText).toContain('readable corpus docs');
  });

  it('shows error message when /settings returns non-ok', async () => {
    mockFetch.mockResolvedValue({ ok: false });
    initSettings({});
    fakeBtn.trigger('click');
    await flush();
    const err = findFirst(fakeBody, '.settings-error');
    expect(err).not.toBeNull();
  });

  it('does NOT re-fetch on second open (loaded guard)', async () => {
    const body = await openAndRender();
    const callCountAfterFirst = mockFetch.mock.calls.length;

    fakeCloseBtn.trigger('click');
    fakeBtn.trigger('click'); // re-open
    await flush();

    // No additional fetches beyond the initial open
    expect(mockFetch.mock.calls.length).toBe(callCountAfterFirst);
  });
});

describe('initSettings — Save (POST /settings)', () => {
  it('Save click issues a POST /settings with {preset, overrides}', async () => {
    const postResponse = makeSettingsResponse();
    mockFetch.mockImplementation((url: string, opts?: any) => {
      if (url === '/settings' && opts?.method === 'POST') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(postResponse) });
      }
      if (url === '/settings') return Promise.resolve({ ok: true, json: () => Promise.resolve(makeSettingsResponse()) });
      if (url === '/usage')    return Promise.resolve({ ok: true, json: () => Promise.resolve(makeZeroUsageResponse()) });
      return Promise.resolve({ ok: false });
    });

    initSettings({});
    fakeBtn.trigger('click');
    await flush();

    const saveBtn = findFirst(fakeBody, '.settings-save-btn');
    expect(saveBtn).not.toBeNull();

    saveBtn!.trigger('click');
    await flush();

    const postCall = mockFetch.mock.calls.find((args: any[]) =>
      args[0] === '/settings' && args[1]?.method === 'POST'
    );
    expect(postCall).toBeDefined();

    const body = JSON.parse(postCall![1].body);
    expect(body).toHaveProperty('preset');
    expect(body).toHaveProperty('overrides');
  });

  it('POST body has content-type: application/json header', async () => {
    mockFetch.mockImplementation((url: string, opts?: any) => {
      if (url === '/settings' && opts?.method === 'POST') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(makeSettingsResponse()) });
      }
      if (url === '/settings') return Promise.resolve({ ok: true, json: () => Promise.resolve(makeSettingsResponse()) });
      if (url === '/usage')    return Promise.resolve({ ok: true, json: () => Promise.resolve(makeZeroUsageResponse()) });
      return Promise.resolve({ ok: false });
    });

    initSettings({});
    fakeBtn.trigger('click');
    await flush();

    const saveBtn = findFirst(fakeBody, '.settings-save-btn');
    expect(saveBtn).not.toBeNull();

    saveBtn!.trigger('click');
    await flush();

    const postCall = mockFetch.mock.calls.find((args: any[]) =>
      args[0] === '/settings' && args[1]?.method === 'POST'
    );
    expect(postCall).toBeDefined();
    expect(postCall![1].headers?.['content-type']).toBe('application/json');
  });

  it('re-renders from the returned effective config after save', async () => {
    const updatedSettings = {
      preset: 'full',
      overrides: {},
      effective: {
        consolSkipThreshold: 0.2,
        consolSkipThresholdAssistant: 0.5,
        corpusSubjectDriftThreshold: 3,
        corpusGen: true,
        corpusGenMax: 25,
        schemaInductionEnabled: true,
      },
    };

    mockFetch.mockImplementation((url: string, opts?: any) => {
      if (url === '/settings' && opts?.method === 'POST') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(updatedSettings) });
      }
      if (url === '/settings') return Promise.resolve({ ok: true, json: () => Promise.resolve(makeSettingsResponse()) });
      if (url === '/usage')    return Promise.resolve({ ok: true, json: () => Promise.resolve(makeZeroUsageResponse()) });
      return Promise.resolve({ ok: false });
    });

    initSettings({});
    fakeBtn.trigger('click');
    await flush();

    const saveBtn = findFirst(fakeBody, '.settings-save-btn');
    expect(saveBtn).not.toBeNull();

    saveBtn!.trigger('click');
    await flush();

    // After re-render, header should show 'Full' (overrides={} → no "(modified)")
    const header = findFirst(fakeBody, '.settings-section-head');
    expect(header!.textContent).toBe('Full');
  });
});

// ── Task 2 Tests: token-usage readout ─────────────────────────────────────────

describe('initSettings — token-usage readout (Task 2)', () => {
  it('calls fetch("/usage") on open', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(makeSettingsResponse()) });
    // A second call for /usage needs its own response, so use implementation:
    mockFetch.mockImplementation((url: string) => {
      if (url === '/settings') return Promise.resolve({ ok: true, json: () => Promise.resolve(makeSettingsResponse()) });
      if (url === '/usage')    return Promise.resolve({ ok: true, json: () => Promise.resolve(makeUsageResponse()) });
      return Promise.resolve({ ok: false });
    });
    initSettings({});
    fakeBtn.trigger('click');
    await flush();
    expect(mockFetch.mock.calls.some((args: any[]) => args[0] === '/usage')).toBe(true);
  });

  it('renders 30d headline with token count', async () => {
    const body = await openAndRender(makeSettingsResponse(), makeUsageResponse());
    const headline = findFirst(body, '.settings-usage-headline');
    expect(headline).not.toBeNull();
    expect(headline!.textContent).toContain('tokens');
    expect(headline!.textContent).toContain('this period you spent');
  });

  it('renders per-feature lines for extraction, judging, schema, corpus (D-09)', async () => {
    const body = await openAndRender(makeSettingsResponse(), makeUsageResponse());
    const featureLines = findAll(body, '.settings-usage-feature-line');
    expect(featureLines.length).toBeGreaterThanOrEqual(4);

    const allText = featureLines.map(l => l.textContent).join(' ');
    expect(allText).toContain('extraction');
    expect(allText).toContain('judging');
    expect(allText).toContain('schema abstraction');
    expect(allText).toContain('corpus docs');
  });

  it('renders all-time total line (D-10)', async () => {
    const body = await openAndRender(makeSettingsResponse(), makeUsageResponse());
    const allTime = findFirst(body, '.settings-usage-alltime');
    expect(allTime).not.toBeNull();
    expect(allTime!.textContent).toContain('all time');
    expect(allTime!.textContent).toContain('tokens');
  });

  it('renders empty-state message when usage data is zeroed', async () => {
    const body = await openAndRender(makeSettingsResponse(), makeZeroUsageResponse());
    const empty = findFirst(body, '.settings-usage-empty');
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toContain('no usage recorded yet');
  });

  it('renders empty-state message when /usage returns non-ok (null usageData)', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === '/settings') return Promise.resolve({ ok: true, json: () => Promise.resolve(makeSettingsResponse()) });
      if (url === '/usage')    return Promise.resolve({ ok: false });
      return Promise.resolve({ ok: false });
    });
    initSettings({});
    fakeBtn.trigger('click');
    await flush();

    const empty = findFirst(fakeBody, '.settings-usage-empty');
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toContain('no usage recorded yet');
  });

  it('usage values are set via textContent — no innerHTML for dynamic values (T-44-19)', async () => {
    // Track any innerHTML write on elements created by document.createElement.
    const innerHTMLWrites: string[] = [];
    const origCreate = (globalThis as any).document.createElement.bind(
      (globalThis as any).document,
    );
    (globalThis as any).document.createElement = (tag: string) => {
      const el: FakeEl = origCreate(tag);
      Object.defineProperty(el, 'innerHTML', {
        set(v: string) { innerHTMLWrites.push(v); },
        get() { return ''; },
        configurable: true,
      });
      return el;
    };

    mockFetch.mockImplementation((url: string) => {
      if (url === '/settings') return Promise.resolve({ ok: true, json: () => Promise.resolve(makeSettingsResponse()) });
      if (url === '/usage')    return Promise.resolve({ ok: true, json: () => Promise.resolve(makeUsageResponse()) });
      return Promise.resolve({ ok: false });
    });

    initSettings({});
    fakeBtn.trigger('click');
    await flush();

    // Confirm some content rendered (sanity check)
    expect(fakeBody._children.length).toBeGreaterThan(0);
    // No innerHTML writes at all
    expect(innerHTMLWrites).toHaveLength(0);
  });

  it('large token counts use k/M abbreviation for readability', async () => {
    const bigUsage = {
      window_days: 30,
      rolling_30d: {
        byFeature: [
          { feature_tag: 'extract', total_tokens: 1_500_000, total_cost_usd: 0.45 },
        ],
        totalTokens: 1_500_000,
        totalCostUsd: 0.45,
      },
      all_time: {
        byFeature: [],
        totalTokens: 5_200_000,
        totalCostUsd: 1.56,
      },
    };

    const body = await openAndRender(makeSettingsResponse(), bigUsage);
    const headline = findFirst(body, '.settings-usage-headline');
    expect(headline).not.toBeNull();
    // Should use "1.5M" not "1500000"
    expect(headline!.textContent).toContain('1.5M');

    const allTime = findFirst(body, '.settings-usage-alltime');
    expect(allTime).not.toBeNull();
    expect(allTime!.textContent).toContain('5.2M');
  });
});
