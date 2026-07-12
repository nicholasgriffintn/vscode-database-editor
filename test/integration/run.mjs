import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { runTests } from '@vscode/test-electron';
import initSqlJs from 'sql.js';

const integrationDirectory = path.dirname(fileURLToPath(import.meta.url));
const extensionDevelopmentPath = path.resolve(integrationDirectory, '../..');
const extensionTestsPath = path.join(integrationDirectory, 'extension.test.mjs');
const fixturePath = path.join(extensionDevelopmentPath, '.tmp', 'sample.sqlite');

await prepareIntegrationFixtures();

try {
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [fixturePath, '--disable-extensions', '--disable-workspace-trust'],
  });
} catch (error) {
  console.error('VS Code integration tests failed.', error);
  process.exitCode = 1;
}

async function prepareIntegrationFixtures() {
  const require = createRequire(import.meta.url);
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
  const SQL = await initSqlJs({ locateFile: () => wasmPath });
  const source = await readFile(fixturePath);
  const database = new SQL.Database(source);

  for (let revision = 1; revision <= 4; revision += 1) {
    database.run('INSERT INTO teams (name) VALUES (?)', [`Integration team ${revision}`]);
    await writeFile(
      path.join(extensionDevelopmentPath, '.tmp', `sample-edit-${revision}.sqlite`),
      database.export(),
    );
  }
  database.close();

  const indexDatabase = new SQL.Database(await readFile(path.join(extensionDevelopmentPath, '.tmp', 'sample-edit-2.sqlite')));
  indexDatabase.run('CREATE UNIQUE INDEX "teams name lookup" ON teams(name DESC)');
  await writeFile(path.join(extensionDevelopmentPath, '.tmp', 'sample-index.sqlite'), indexDatabase.export());
  indexDatabase.close();

  const csvDatabase = new SQL.Database(await readFile(path.join(extensionDevelopmentPath, '.tmp', 'sample-edit-2.sqlite')));
  csvDatabase.run('BEGIN IMMEDIATE');
  csvDatabase.run('INSERT INTO teams (name) VALUES (?), (?)', ['CSV integration A', 'CSV integration B']);
  csvDatabase.run('COMMIT');
  await writeFile(path.join(extensionDevelopmentPath, '.tmp', 'sample-csv-import.sqlite'), csvDatabase.export());
  csvDatabase.close();
}
