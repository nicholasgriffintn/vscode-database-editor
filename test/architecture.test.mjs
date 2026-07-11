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

  assert.match(source, /from '\.\/utilities\/errors\.mjs'/);
  assert.match(source, /from '\.\/utilities\/array\.mjs'/);
  assert.match(source, /from '\.\/utilities\/text-control\.mjs'/);
  assert.doesNotMatch(source, /function (?:getErrorMessage|arraysEqual|isTextControl|replaceTextControlSelection|deleteTextControlSelection|getSelectedTextInControl|createSvgElement)\(/);
});

test('media shared helpers use the utilities directory instead of utils suffixes', async () => {
  const mediaFiles = await readdir(new URL('../media/', import.meta.url));
  assert.deepEqual(mediaFiles.filter((name) => /-utils\.mjs$/.test(name)), []);
});
