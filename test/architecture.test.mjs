import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

test('top-level modules do not depend on generic implementations inside sqlite-ai', async () => {
  const sourceDirectory = new URL('../src/', import.meta.url);
  const sourceFiles = (await readdir(sourceDirectory)).filter((name) => name.endsWith('.ts'));
  for (const fileName of sourceFiles) {
    const source = await readFile(new URL(fileName, sourceDirectory), 'utf8');
    if (fileName === 'extension.ts') {
      const sqliteAiImports = [...source.matchAll(/from '\.\/sqlite-ai\/([^']+)'/g)].map((match) => match[1]);
      assert.deepEqual(sqliteAiImports.sort(), ['chat-participant', 'tools']);
      continue;
    }
    assert.doesNotMatch(source, /from '\.\/sqlite-ai\//, `${fileName} must import shared modules from src/`);
  }
});

test('SQL export orchestration uses shared SQL, cancellation, schema, sink, and buffer modules', async () => {
  const source = await readFile(new URL('../src/sql-export.ts', import.meta.url), 'utf8');

  assert.match(source, /from '\.\/utilities\/sql'/);
  assert.match(source, /from '\.\/utilities\/cancellation'/);
  assert.match(source, /from '\.\/utilities\/text-chunk-buffer'/);
  assert.match(source, /from '\.\/sqlite-schema'/);
  assert.doesNotMatch(source, /function (?:serializeSqlLiteral|quoteIdentifier|terminateStatement|throwIfCancelled|readSchemaObjects|readShadowTableNames|readInsertableColumns)\(/);
  assert.doesNotMatch(source, /createWriteStream|createBufferedSqlExportSink|createFileSqlExportSink/);
});

test('webview orchestration imports generic error and collection helpers', async () => {
  const source = await readFile(new URL('../media/webview.mjs', import.meta.url), 'utf8');
  const sqlWorkspace = await readFile(new URL('../media/sql/workspace.mjs', import.meta.url), 'utf8');

  assert.match(source, /from '\.\/utilities\/errors\.mjs'/);
  assert.match(sqlWorkspace, /from '\.\.\/utilities\/array\.mjs'/);
  assert.match(source, /from '\.\/utilities\/text-control\.mjs'/);
  assert.doesNotMatch(source, /function (?:getErrorMessage|arraysEqual|isTextControl|replaceTextControlSelection|deleteTextControlSelection|getSelectedTextInControl|createSvgElement)\(/);
});

test('media shared helpers use the utilities directory instead of utils suffixes', async () => {
  const mediaFiles = await readdir(new URL('../media/', import.meta.url), { recursive: true });
  assert.deepEqual(mediaFiles.filter((name) => /-utils\.mjs$/.test(name)), []);
});

test('media root stays an entrypoint instead of becoming a flat feature namespace', async () => {
  const entries = await readdir(new URL('../media/', import.meta.url), { withFileTypes: true });
  assert.deepEqual(entries.filter((entry) => entry.isFile() && entry.name.endsWith('.mjs')).map((entry) => entry.name), ['webview.mjs']);
  for (const directory of ['csv', 'data', 'database', 'dialogs', 'editor', 'grid', 'schema', 'sql', 'utilities']) {
    assert.equal(entries.some((entry) => entry.isDirectory() && entry.name === directory), true, `missing media/${directory}/`);
  }
});

test('webview entrypoint remains orchestration-only', async () => {
  const source = await readFile(new URL('../media/webview.mjs', import.meta.url), 'utf8');
  assert.ok(source.split('\n').length <= 1300, 'webview.mjs must stay below 1,300 lines');
  assert.doesNotMatch(source, /function (?:showRowDetails|showInsertDialog|showCreateIndexDialog|renderSchemaGraph|renderGrid|runSqlWorkspace|createSchemaField|parseCsv|reportError|markChanged|getActiveTable|getEditableTable|getSelectedSchemaObject|toggleRowSelection|selectGridRow|selectGridCell|writeClipboardText|readClipboardText|updatePager|exportVisibleCsv|exportSqlDump|handleSqlExportFinished)\(/);
  assert.doesNotMatch(source, /await (?:deleteRows|updateCell)\(/, 'row mutations must go through createRowWorkflows');
  assert.match(source, /createGridView/);
  assert.match(source, /createGridSelection/);
  assert.match(source, /createDocumentController/);
  assert.match(source, /createSchemaSelection/);
  assert.match(source, /createClipboardBridge/);
  assert.match(source, /createExportWorkflow/);
  assert.match(source, /createRowWorkflows/);
  assert.match(source, /createSchemaView/);
  assert.match(source, /createSqlWorkspace/);
});

test('exported media functions have a single owning module', async () => {
  const mediaRoot = new URL('../media/', import.meta.url);
  const paths = (await readdir(mediaRoot, { recursive: true })).filter((name) => name.endsWith('.mjs') && !name.startsWith('vendor/'));
  const owners = new Map();
  for (const path of paths) {
    const source = await readFile(new URL(path, mediaRoot), 'utf8');
    for (const match of source.matchAll(/export (?:async )?function ([A-Za-z0-9_]+)/g)) {
      const existing = owners.get(match[1]);
      assert.equal(existing, undefined, `${match[1]} is exported by both ${existing} and ${path}`);
      owners.set(match[1], path);
    }
  }
});
