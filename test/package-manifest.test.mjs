import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('Copilot language-model tools are hidden when the integration is disabled', () => {
  const tools = Object.fromEntries(
    manifest.contributes.languageModelTools.map((tool) => [tool.name, tool]),
  );

  assert.equal(
    tools.databaseEditor_list_open_databases.when,
    'config.databaseEditor.copilot.enable',
  );
  assert.equal(
    tools.databaseEditor_db_context.when,
    'config.databaseEditor.copilot.enable',
  );
  assert.equal(
    tools.databaseEditor_query.when,
    'config.databaseEditor.copilot.enable',
  );
  assert.equal(
    tools.databaseEditor_modify.when,
    'config.databaseEditor.copilot.enable && config.databaseEditor.copilot.accessMode == rw',
  );
});
