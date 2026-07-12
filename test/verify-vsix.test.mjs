import assert from 'node:assert/strict';
import test from 'node:test';

import { validateVsixContents } from '../scripts/verify-vsix.mjs';

const required = [
  'package.json', 'readme.md', 'changelog.md', 'LICENSE.txt', 'dist/extension.js',
  'media/vendor/sqljs/sql-wasm.js', 'media/vendor/sqljs/sql-wasm.wasm', 'media/vendor/sqljs/LICENSE.sql.js',
  'media/webview.mjs', 'media/styles.css',
].map((file) => `extension/${file}`);

test('VSIX validation accepts the exact release assets and metadata', () => {
  assert.deepEqual(validateVsixContents({
    entries: required,
    manifest: { description: 'SQLite editor', version: '1.0.0', main: './dist/extension.js' },
    expectedManifest: { version: '1.0.0', main: './dist/extension.js' },
    expectedMediaPaths: ['media/webview.mjs', 'media/styles.css'],
    sizeBytes: 5 * 1024 * 1024,
  }), []);
});

test('VSIX validation rejects missing assets, mismatched metadata, oversized archives, and source files', () => {
  const failures = validateVsixContents({
    entries: ['extension/package.json', 'extension/src/extension.ts'],
    manifest: { description: '', version: '0.0.1', main: './wrong.js' },
    expectedManifest: { version: '1.0.0', main: './dist/extension.js' },
    expectedMediaPaths: ['media/webview.mjs'],
    sizeBytes: 11 * 1024 * 1024,
  });
  assert.ok(failures.some((failure) => /description/.test(failure)));
  assert.ok(failures.some((failure) => /version/.test(failure)));
  assert.ok(failures.some((failure) => /10 MB/.test(failure)));
  assert.ok(failures.some((failure) => /Development file/.test(failure)));
  assert.ok(failures.some((failure) => /webview\.mjs/.test(failure)));
});
