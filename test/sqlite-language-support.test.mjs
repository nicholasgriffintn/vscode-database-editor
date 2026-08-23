import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const readJson = async (relativePath) => JSON.parse(await readFile(path.join(root, relativePath), 'utf8'));

test('manifest contributes dedicated SQLite SQL language support without taking over generic .sql files', async () => {
  const manifest = await readJson('package.json');

  assert.ok(manifest.categories.includes('Programming Languages'));

  const language = manifest.contributes.languages.find(({ id }) => id === 'sqlite-sql');
  assert.deepEqual(language.aliases, ['SQLite SQL', 'sqlite-sql']);
  assert.deepEqual(language.extensions, ['.sqlite.sql', '.sqlite3.sql']);
  assert.equal(language.extensions.includes('.sql'), false);
  assert.equal(language.firstLine, '^\\s*--\\s*(?:language\\s*=\\s*)?sqlite\\b');
  assert.equal(language.configuration, './language-support/sqlite-language-configuration.json');

  assert.deepEqual(
    manifest.contributes.grammars.find(({ language: id }) => id === 'sqlite-sql'),
    {
      language: 'sqlite-sql',
      scopeName: 'source.sqlite.sql',
      path: './language-support/sqlite.tmLanguage.json',
    },
  );
  assert.deepEqual(
    manifest.contributes.snippets.find(({ language: id }) => id === 'sqlite-sql'),
    {
      language: 'sqlite-sql',
      path: './language-support/sqlite.code-snippets',
    },
  );
});

test('SQLite SQL language assets provide editing pairs, dialect grammar, and useful snippets', async () => {
  const configuration = await readJson('language-support/sqlite-language-configuration.json');
  const grammar = await readJson('language-support/sqlite.tmLanguage.json');
  const snippets = await readJson('language-support/sqlite.code-snippets');

  assert.equal(configuration.comments.lineComment, '--');
  assert.deepEqual(configuration.comments.blockComment, ['/*', '*/']);
  assert.ok(configuration.surroundingPairs.some(([open, close]) => open === '`' && close === '`'));
  assert.equal(grammar.scopeName, 'source.sqlite.sql');
  assert.ok(grammar.patterns.some((pattern) => pattern.include === '#sqlite-dialect'));
  assert.ok(grammar.patterns.some((pattern) => pattern.include === 'source.sql'));

  const dialectPatterns = grammar.repository['sqlite-dialect'].patterns;
  assert.ok(dialectPatterns.some(({ name, match = '' }) => name === 'keyword.other.pragma.sqlite' && /PRAGMA/i.test(match)));
  assert.ok(dialectPatterns.some(({ name }) => name === 'variable.parameter.sqlite'));
  assert.ok(dialectPatterns.some(({ name }) => name === 'constant.numeric.blob.sqlite'));

  for (const snippetName of ['Create table', 'Insert row', 'Upsert row', 'Common table expression', 'Transaction']) {
    const snippet = snippets[snippetName];
    assert.ok(snippet, `Missing ${snippetName} snippet`);
    assert.equal(snippet.scope, 'sqlite-sql');
    assert.ok(Array.isArray(snippet.body));
  }
});
