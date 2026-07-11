import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('new database command is contributed and activates the extension', () => {
  const command = manifest.contributes.commands.find((candidate) => candidate.command === 'databaseEditor.newDatabase');
  assert.equal(command.title, 'New SQLite Database');
  assert.ok(manifest.activationEvents.includes('onCommand:databaseEditor.newDatabase'));
});

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

test('editor configuration exposes browsing, editing, persistence, and resource limits', () => {
  const properties = manifest.contributes.configuration.properties;
  const expected = {
    'databaseEditor.maxFileSizeMb': 200,
    'databaseEditor.defaultPageSize': 500,
    'databaseEditor.autoPagination': true,
    'databaseEditor.maxRows': 0,
    'databaseEditor.instantCommit': 'never',
    'databaseEditor.doubleClickBehavior': 'inline',
    'databaseEditor.blobExportMode': 'native',
    'databaseEditor.queryTimeoutMs': 30000,
    'databaseEditor.maxUndoMemoryBytes': 52428800,
  };

  for (const [name, defaultValue] of Object.entries(expected)) {
    assert.equal(properties[name].default, defaultValue, `${name} default`);
    assert.equal(properties[name].scope, 'resource');
  }

  assert.deepEqual(properties['databaseEditor.instantCommit'].enum, ['always', 'never', 'remote-only']);
  assert.deepEqual(properties['databaseEditor.doubleClickBehavior'].enum, ['inline', 'modal']);
  assert.deepEqual(properties['databaseEditor.blobExportMode'].enum, ['native', 'web']);
  assert.match(properties['databaseEditor.maxFileSizeMb'].markdownDescription, /WASM/i);
  assert.match(properties['databaseEditor.maxRows'].markdownDescription, /0 = unlimited/i);
});
