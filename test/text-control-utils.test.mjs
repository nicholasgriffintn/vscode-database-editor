import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyTextEditingShortcut,
  getSelectedTextInControl,
  isTextControl,
  replaceTextControlSelection,
} from '../media/text-control-utils.mjs';

test('shared text-control helpers preserve selection semantics for cut and paste', async () => {
  const target = createTextControl('hello', 1, 4);
  const writes = [];
  const options = {
    documentRef: { activeElement: null, execCommand: () => false },
    createInputEvent: () => ({ type: 'input' }),
  };

  assert.equal(isTextControl(target), true);
  assert.equal(getSelectedTextInControl(target), 'ell');
  await applyTextEditingShortcut(target, 'cut', {
    ...options,
    writeClipboardText: async (text) => writes.push(text),
    readClipboardText: async () => '',
  });
  assert.deepEqual(writes, ['ell']);
  assert.equal(target.value, 'ho');

  await applyTextEditingShortcut(target, 'paste', {
    ...options,
    writeClipboardText: async () => {},
    readClipboardText: async () => 'i',
  });
  assert.equal(target.value, 'hio');
  assert.equal(target.events.filter((event) => event.type === 'input').length, 2);
});

test('text replacement ignores disabled and read-only controls', () => {
  const target = createTextControl('hello', 0, 5);
  target.readOnly = true;
  replaceTextControlSelection(target, 'changed', {
    documentRef: { activeElement: null, execCommand: () => false },
    createInputEvent: () => ({ type: 'input' }),
  });
  assert.equal(target.value, 'hello');
});

function createTextControl(value, selectionStart, selectionEnd) {
  return {
    tagName: 'INPUT',
    value,
    selectionStart,
    selectionEnd,
    readOnly: false,
    disabled: false,
    events: [],
    dispatchEvent(event) { this.events.push(event); },
    setRangeText(text, start, end) {
      this.value = `${this.value.slice(0, start)}${text}${this.value.slice(end)}`;
      this.selectionStart = start + text.length;
      this.selectionEnd = this.selectionStart;
    },
    select() {
      this.selectionStart = 0;
      this.selectionEnd = this.value.length;
    },
  };
}
