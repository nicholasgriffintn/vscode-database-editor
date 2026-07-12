import { readFile, readdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_VSIX_BYTES = 10 * 1024 * 1024;

export function validateVsixContents({ entries, manifest, expectedManifest, expectedMediaPaths, sizeBytes }) {
  const failures = [];
  const files = new Set(entries);
  const requireFile = (relativePath) => {
    if (!files.has(`extension/${relativePath}`)) failures.push(`Missing extension/${relativePath}`);
  };

  if (!manifest.description?.trim()) failures.push('Packaged manifest description is empty');
  if (manifest.version !== expectedManifest.version) failures.push(`Packaged version ${manifest.version} does not match ${expectedManifest.version}`);
  if (manifest.main !== expectedManifest.main) failures.push(`Packaged entrypoint ${manifest.main} does not match ${expectedManifest.main}`);
  if (sizeBytes > MAX_VSIX_BYTES) failures.push(`VSIX is ${(sizeBytes / 1024 / 1024).toFixed(1)} MB; limit is 10 MB`);

  for (const required of [
    'package.json', 'readme.md', 'changelog.md', 'LICENSE.txt', expectedManifest.main.replace(/^\.\//, ''),
    'media/vendor/sqljs/sql-wasm.js', 'media/vendor/sqljs/sql-wasm.wasm', 'media/vendor/sqljs/LICENSE.sql.js',
    'docs/demo.gif', 'docs/copilot-demo.gif', ...expectedMediaPaths,
  ]) requireFile(required);

  for (const entry of entries) {
    if (/^extension\/(?:src|test|scripts|\.changeset|\.hermes)\//.test(entry)) failures.push(`Development file packaged: ${entry}`);
  }
  return failures;
}

export async function verifyVsix(vsixPath) {
  const archive = path.resolve(vsixPath);
  const listing = runUnzip(['-Z1', archive]).trim().split(/\r?\n/).filter(Boolean);
  const manifest = JSON.parse(runUnzip(['-p', archive, 'extension/package.json']));
  const expectedManifest = JSON.parse(await readFile('package.json', 'utf8'));
  const mediaPaths = (await readdir('media', { recursive: true }))
    .filter((entry) => entry.endsWith('.mjs') || entry === 'styles.css')
    .map((entry) => `media/${entry}`);
  const info = await stat(archive);
  const failures = validateVsixContents({
    entries: listing,
    manifest,
    expectedManifest,
    expectedMediaPaths: mediaPaths,
    sizeBytes: info.size,
  });
  if (failures.length > 0) throw new Error(`VSIX verification failed:\n- ${failures.join('\n- ')}`);
  console.log(`Verified ${path.relative(process.cwd(), archive)} (${(info.size / 1024 / 1024).toFixed(1)} MB, ${listing.length} entries)`);
}

function runUnzip(args) {
  const result = spawnSync('unzip', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `unzip exited with ${result.status}`);
  return result.stdout;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const vsixPath = process.argv[2];
  if (!vsixPath) throw new Error('Usage: node scripts/verify-vsix.mjs <path-to-vsix>');
  await verifyVsix(vsixPath);
}
