import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const publish = await readFile(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');

test('release scripts build and verify one explicit VSIX', () => {
  assert.match(manifest.scripts['test:release'], /vendor:sqljs:check/);
  assert.match(manifest.scripts['test:release'], /test:unit/);
  assert.match(manifest.scripts['test:release'], /test:integration/);
  assert.match(manifest.scripts['test:release'], /test:fixture/);
  assert.match(manifest.scripts['vsce:package'], /--out \.tmp\/release\/vscode-database-editor\.vsix/);
  assert.equal(manifest.scripts['vsce:verify'], 'node scripts/verify-vsix.mjs .tmp/release/vscode-database-editor.vsix');
  assert.match(manifest.devDependencies['@types/node'], /^\^24\./);
});

test('CI verifies generated state and uploads only the inspected artifact', () => {
  assert.match(ci, /vendor:sqljs:check/);
  assert.match(ci, /test:integration/);
  assert.match(ci, /test:fixture/);
  assert.match(ci, /audit:prod/);
  assert.match(ci, /git diff --exit-code/);
  assert.match(ci, /vsce:verify/);
  assert.match(ci, /path: \.tmp\/release\/vscode-database-editor\.vsix/);
  assert.doesNotMatch(ci, /path: ['"]?\*\.vsix/);
});

test('publish is serialised, version-gated, and uses the exact verified artifact', () => {
  assert.match(publish, /concurrency:/);
  assert.match(publish, /environment: visual-studio-marketplace/);
  assert.match(publish, /GITHUB_REF_NAME#v/);
  assert.match(publish, /already published/);
  assert.match(publish, /git diff --exit-code/);
  assert.match(publish, /vsce:verify/);
  assert.match(publish, /--packagePath \.tmp\/release\/vscode-database-editor\.vsix/);
  assert.doesNotMatch(publish, /--packagePath \.\/\*\.vsix/);
});
