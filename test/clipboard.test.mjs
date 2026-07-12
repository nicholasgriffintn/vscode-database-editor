import assert from 'node:assert/strict';
import test from 'node:test';

import { createClipboardBridge } from '../media/editor/clipboard.mjs';

test('clipboard bridge correlates host reads and handles timeouts', async () => {
  const messages = [];
  const timers = [];
  const bridge = createClipboardBridge({
    vscode: { postMessage: (message) => messages.push(message) },
    setTimer: (callback) => { timers.push(callback); return timers.length; },
    clearTimer: () => {},
  });

  const read = bridge.readText();
  assert.deepEqual(messages[0], { type: 'clipboardRead', requestId: '1' });
  assert.equal(bridge.handleMessage({ requestId: '1', text: 'copied value' }), true);
  assert.equal(await read, 'copied value');

  const timedOut = bridge.readText();
  timers.at(-1)();
  assert.equal(await timedOut, '');
  assert.equal(bridge.handleMessage({ requestId: 'missing', text: 'ignored' }), false);
});
