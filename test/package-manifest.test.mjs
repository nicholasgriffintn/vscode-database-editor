import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
const changelog = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const vscodeIgnore = await readFile(new URL('../.vscodeignore', import.meta.url), 'utf8');

test('Marketplace metadata describes the v1 SQLite editor without bypassing Changesets versioning', () => {
  assert.equal(manifest.description, 'Browse, edit, query, import, and export SQLite databases directly in VS Code.');
  assert.equal(manifest.version, '0.0.6');
  assert.match(changelog, /^# vscode-database-editor$/m);
  assert.match(changelog, /^## 0\.0\.6$/m);
});

test('README documents every contributed command and setting', () => {
  for (const command of manifest.contributes.commands) {
    assert.match(readme, new RegExp(escapeRegex(command.title), 'i'), `${command.command} title`);
  }
  for (const setting of Object.keys(manifest.contributes.configuration.properties)) {
    assert.ok(readme.includes(`\`${setting}\``), `${setting} documentation`);
  }
});

test('VSIX ignore patterns contain no duplicates', () => {
  const patterns = vscodeIgnore.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  assert.equal(new Set(patterns).size, patterns.length);
});

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

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
