import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const checkMode = process.argv.includes('--check');
const rootDir = process.cwd();
const sourceDir = path.join(rootDir, 'node_modules', 'sql.js');
const targetDir = path.join(rootDir, 'media', 'vendor', 'sqljs');

const assets = [
  {
    source: path.join(sourceDir, 'dist', 'sql-wasm.js'),
    target: path.join(targetDir, 'sql-wasm.js'),
  },
  {
    source: path.join(sourceDir, 'dist', 'sql-wasm.wasm'),
    target: path.join(targetDir, 'sql-wasm.wasm'),
  },
  {
    source: path.join(sourceDir, 'LICENSE'),
    target: path.join(targetDir, 'LICENSE.sql.js'),
  },
];

async function readAsset(assetPath) {
  try {
    return await readFile(assetPath);
  } catch (error) {
    throw new Error(`Unable to read ${path.relative(rootDir, assetPath)}. Run pnpm install first.`, {
      cause: error,
    });
  }
}

async function checkAsset(asset) {
  const [source, target] = await Promise.all([
    readAsset(asset.source),
    readAsset(asset.target),
  ]);

  if (!source.equals(target)) {
    throw new Error(`${path.relative(rootDir, asset.target)} is out of date. Run pnpm run vendor:sqljs.`);
  }
}

async function copyAsset(asset) {
  const source = await readAsset(asset.source);
  await writeFile(asset.target, source);
  console.log(`Copied ${path.relative(rootDir, asset.target)}`);
}

if (!checkMode) {
  await mkdir(targetDir, { recursive: true });
}

for (const asset of assets) {
  if (checkMode) {
    await checkAsset(asset);
  } else {
    await copyAsset(asset);
  }
}

console.log(checkMode ? 'sql.js vendor files are current.' : 'Updated sql.js vendor files.');
