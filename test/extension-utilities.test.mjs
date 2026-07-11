import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { toArrayBuffer } from '../dist/utilities/binary.js';
import { createCopilotConfigurationReaders } from '../dist/utilities/copilot-configuration.js';
import { getErrorMessage } from '../dist/utilities/errors.js';
import { buildContentSecurityPolicy, escapeHtmlAttribute } from '../dist/utilities/html.js';
import { escapeMarkdown, formatSqlCodeBlock } from '../dist/utilities/markdown.js';
import { createNonce } from '../dist/utilities/nonce.js';
import { basename, basenameFromUri, dirname } from '../dist/utilities/path.js';
import { sqlLiteral } from '../dist/utilities/sql.js';

test('binary conversion returns an independent exact ArrayBuffer', () => {
  const source = new Uint8Array([1, 2, 3]);
  const result = toArrayBuffer(source);
  source[0] = 9;

  assert.ok(result instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(result)], [1, 2, 3]);
});

test('HTML utilities escape attributes and build the strict webview CSP', () => {
  assert.equal(
    escapeHtmlAttribute('a&"<b>'),
    'a&amp;&quot;&lt;b&gt;',
  );
  assert.equal(
    buildContentSecurityPolicy({ cspSource: 'vscode-webview://fixture', nonce: 'abc123' }),
    "default-src 'none'; style-src vscode-webview://fixture; script-src 'nonce-abc123' 'wasm-unsafe-eval' vscode-webview://fixture; img-src vscode-webview://fixture blob:; connect-src vscode-webview://fixture; font-src vscode-webview://fixture",
  );
});

test('nonce generation is injectable, fixed-length, and uses the allowed alphabet', () => {
  const values = [0, 0.5, 0.999];
  let index = 0;
  const nonce = createNonce(6, () => values[index++ % values.length]);

  assert.equal(nonce.length, 6);
  assert.match(nonce, /^[A-Za-z0-9]+$/);
  assert.equal(nonce, 'Af9Af9');
});

test('shared path utilities handle filesystem paths and encoded URIs', () => {
  assert.equal(dirname('/'), '/');
  assert.equal(dirname('/database.sqlite'), '/');
  assert.equal(dirname('/fixtures/sample.sqlite'), '/fixtures');
  assert.equal(basename('/fixtures/sample.sqlite'), 'sample.sqlite');
  assert.equal(basename('sample.sqlite'), 'sample.sqlite');
  assert.equal(basenameFromUri('file:///fixtures/sample%20database.sqlite'), 'sample database.sqlite');
  assert.equal(basenameFromUri('untitled:sample%20database.sqlite'), 'untitled:sample%20database.sqlite');
  assert.equal(basenameFromUri('custom:folder%2Fsample.sqlite'), 'custom:folder%2Fsample.sqlite');
});

test('shared formatting and error utilities preserve SQL and escape display text', () => {
  assert.equal(getErrorMessage(new Error('failure')), 'failure');
  assert.equal(getErrorMessage('failure'), 'failure');
  assert.equal(sqlLiteral("Ada's"), "'Ada''s'");
  assert.equal(escapeMarkdown('a*b_[c]'), 'a\\*b\\_\\[c\\]');
  assert.equal(formatSqlCodeBlock(' SELECT 1; '), '```sql\nSELECT 1;\n```');
  assert.equal(formatSqlCodeBlock('SELECT `value`;'), '```sql\nSELECT `value`;\n```');
});

test('Copilot configuration readers preserve defaults, copies, and live configured values', () => {
  const configuredValues = new Map();
  const readers = createCopilotConfigurationReaders({
    getConfiguration(section) {
      assert.equal(section, 'databaseEditor.copilot');
      return {
        get(key, defaultValue) {
          return configuredValues.has(key) ? configuredValues.get(key) : defaultValue;
        },
      };
    },
  });

  assert.equal(readers.getCopilotEnabled(), true);
  assert.equal(readers.getAccessMode(), 'ro');
  const defaultOptions = readers.getQueryOptions();
  assert.deepEqual(defaultOptions, {
    maxResultRows: 200,
    timeoutMs: 5_000,
    sensitiveColumnPatterns: ['password', 'passwd', 'token', 'secret', 'api[_-]?key', 'ssn'],
  });
  defaultOptions.sensitiveColumnPatterns.push('mutated');
  assert.doesNotMatch(readers.getQueryOptions().sensitiveColumnPatterns.join(','), /mutated/);

  configuredValues.set('enable', false);
  configuredValues.set('accessMode', 'rw');
  configuredValues.set('maxResultRows', 25);
  configuredValues.set('queryTimeoutMs', 750);
  configuredValues.set('sensitiveColumnPatterns', ['credential']);

  assert.equal(readers.getCopilotEnabled(), false);
  assert.equal(readers.getAccessMode(), 'rw');
  assert.deepEqual(readers.getQueryOptions(), {
    maxResultRows: 25,
    timeoutMs: 750,
    sensitiveColumnPatterns: ['credential'],
  });
});

test('consumers import shared utilities instead of defining duplicate helpers inline', async () => {
  const [extension, tools, registry, protocol, chatParticipant] = await Promise.all([
    readFile(new URL('../src/extension.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/sqlite-ai/tools.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/sqlite-ai/sqlite-document-registry.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/custom-editor-protocol.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/sqlite-ai/chat-participant.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(extension, /from '\.\/utilities\/binary'/);
  assert.match(extension, /from '\.\/utilities\/copilot-configuration'/);
  assert.match(extension, /from '\.\/utilities\/path'/);
  assert.match(extension, /from '\.\/utilities\/webview-html'/);
  assert.doesNotMatch(extension, /function (?:getNonce|escapeAttribute|toArrayBuffer|dirname)\(/);
  assert.doesNotMatch(tools, /function (?:basename|getErrorMessage|escapeMarkdown|formatSqlCodeBlock|sqlLiteral)\(/);
  assert.doesNotMatch(registry, /function basename\(/);
  assert.doesNotMatch(protocol, /error instanceof Error \? error\.message : String\(error\)/);
  assert.doesNotMatch(chatParticipant, /error instanceof Error \? error\.message : String\(error\)/);
});
