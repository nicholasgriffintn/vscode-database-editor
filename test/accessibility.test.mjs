import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('editor shell exposes tabs, labelled panels, live status, and named filters', async () => {
  const source = await readFile(new URL('../media/editor/shell.mjs', import.meta.url), 'utf8');

  assert.match(source, /role: 'tablist'/);
  assert.match(source, /role: 'tab'/);
  assert.match(source, /role: 'tabpanel'/);
  assert.match(source, /'aria-selected'/);
  assert.match(source, /'aria-live': 'polite'/);
  assert.match(source, /'aria-label': 'Filter rows'/);
  assert.match(source, /\['ArrowLeft', 'ArrowRight', 'Home', 'End'\]/);
});

test('grid keeps read-only cells interactive and exposes accessible table and resize controls', async () => {
  const view = await readFile(new URL('../media/grid/view.mjs', import.meta.url), 'utf8');
  const webview = await readFile(new URL('../media/webview.mjs', import.meta.url), 'utf8');

  assert.match(view, /createElement\('caption'/);
  assert.match(view, /role: 'separator'/);
  assert.match(view, /'aria-orientation': 'vertical'/);
  assert.match(view, /`Filter \$\{column\.name\} column`/);
  assert.match(view, /\['ArrowLeft', 'ArrowRight'\]/);
  assert.doesNotMatch(webview, /cellButton\?\.disabled/);
});

test('dialogs have programmatic names and descriptions', async () => {
  const sources = await Promise.all([
    '../media/dialogs/form.mjs',
    '../media/dialogs/workflows.mjs',
    '../media/grid/row-workflows.mjs',
  ].map((path) => readFile(new URL(path, import.meta.url), 'utf8')));

  for (const source of sources) {
    assert.match(source, /aria-labelledby/);
    assert.match(source, /aria-describedby/);
  }
});
