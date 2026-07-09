import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('Copilot language-model tools are hidden when the integration is disabled', () => {
  const tools = Object.fromEntries(
    manifest.contributes.languageModelTools.map((tool) => [tool.name, tool]),
  );

  for (const name of [
    'databaseEditor_list_open_databases',
    'databaseEditor_db_context',
    'databaseEditor_query',
    'databaseEditor_explain',
    'databaseEditor_profile',
  ]) {
    assert.equal(tools[name].when, 'config.databaseEditor.copilot.enable');
  }

  for (const name of ['databaseEditor_modify', 'databaseEditor_migrate']) {
    assert.equal(
      tools[name].when,
      'config.databaseEditor.copilot.enable && config.databaseEditor.copilot.accessMode == rw',
    );
  }
});

test('schema context tool manifest exposes pagination inputs', () => {
  const tool = manifest.contributes.languageModelTools.find((candidate) => candidate.name === 'databaseEditor_db_context');
  const properties = tool.inputSchema.properties;

  assert.equal(properties.offset.type, 'number');
  assert.match(properties.offset.description, /nextOffset|page/i);
  assert.equal(properties.limit.type, 'number');
  assert.match(properties.limit.description, /objects|page/i);
});
