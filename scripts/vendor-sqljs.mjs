import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const checkMode = process.argv.includes('--check');
const rootDir = process.cwd();
const sourceDir = path.join(rootDir, 'node_modules', 'sql.js');
const targetDir = path.join(rootDir, 'media', 'vendor', 'sqljs');
const runtimeMetadataPath = path.join(targetDir, 'runtime.json');

const assets = [
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

async function checkRuntime() {
  const [packageJson, runtimeMetadata] = await Promise.all([
    readFile(path.join(sourceDir, 'package.json'), 'utf8').then(JSON.parse),
    readFile(runtimeMetadataPath, 'utf8').then(JSON.parse),
  ]);
  if (runtimeMetadata.sqlJsVersion !== packageJson.version) {
    throw new Error(
      `The FTS5 runtime was built from sql.js ${runtimeMetadata.sqlJsVersion}, but ${packageJson.version} is installed. `
      + 'Run pnpm run build:sqljs -- /path/to/sql.js.',
    );
  }

  const runtimePath = path.join(targetDir, 'sql-wasm.js');
  const require = createRequire(import.meta.url);
  delete require.cache[require.resolve(runtimePath)];
  const initSqlJs = require(runtimePath);
  const SQL = await initSqlJs({ locateFile: (file) => path.join(targetDir, file) });
  const db = new SQL.Database();
  try {
    db.run('CREATE VIRTUAL TABLE runtime_fts5_check USING fts5(body)');
    db.run("INSERT INTO runtime_fts5_check VALUES ('searchable text')");
    const result = db.exec("SELECT body FROM runtime_fts5_check WHERE runtime_fts5_check MATCH 'searchable'");
    if (result[0]?.values?.[0]?.[0] !== 'searchable text') {
      throw new Error('The vendored SQLite runtime failed its FTS5 search check.');
    }
  } finally {
    db.close();
  }
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

await checkRuntime();

console.log(checkMode ? 'sql.js FTS5 vendor files are current.' : 'Updated sql.js licence and verified the FTS5 runtime.');
