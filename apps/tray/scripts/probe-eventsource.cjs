/**
 * OQ-2 probe: verify undici EventSource is importable in Electron 42 main process.
 *
 * Usage: npx electron scripts/probe-eventsource.cjs (from apps/tray directory)
 *
 * Exit 0 — undici EventSource available; Task 2 may use `import { EventSource } from 'undici'`
 * Exit 2 — undici unavailable; Task 2 must use the eventsource npm package fallback
 *
 * Construction of EventSource alone proves the class resolves (no server needed).
 */
'use strict';

const { app } = require('electron');

app.whenReady().then(() => {
  try {
    // Attempt the undici import — undici is bundled in Node.js 22+
    const undici = require('undici');
    const EventSourceClass = undici.EventSource;

    if (typeof EventSourceClass !== 'function') {
      throw new Error('undici.EventSource is not a constructor (got: ' + typeof EventSourceClass + ')');
    }

    // Construction proves the class resolves; no server is needed.
    // Use a bogus URL — we do not actually connect.
    const es = new EventSourceClass('http://127.0.0.1:7810/events');
    // Close immediately — we only need to confirm construction succeeded.
    if (typeof es.close === 'function') {
      es.close();
    }

    process.stdout.write('OK: undici EventSource available\n');
    app.exit(0);
  } catch (err) {
    process.stdout.write('FAIL: ' + (err instanceof Error ? err.message : String(err)) + '\n');
    app.exit(2);
  }
}).catch((err) => {
  process.stdout.write('FAIL: app.whenReady rejected: ' + String(err) + '\n');
  app.exit(2);
});
