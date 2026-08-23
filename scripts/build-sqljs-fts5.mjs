import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const supportedSources = new Map([
  ['1.14.1', {
    commit: '8088a6829d929338b861c7179275b1bc222725d9',
    sqliteVersion: '3.49.1',
    sqliteAmalgamation: 'sqlite-amalgamation-3490100',
    sqliteArchiveUrl: 'https://sqlite.org/2025/sqlite-amalgamation-3490100.zip',
    sqliteArchiveSha3: 'e7eb4cfb2d95626e782cfa748f534c74482f2c3c93f13ee828b9187ce05b2da7',
    extensionFunctionsUrl: 'https://www.sqlite.org/contrib/download/extension-functions.c?get=25',
    extensionFunctionsSha256: '991b40fe8b2799edc215f7260b890f14a833512c9d9896aa080891330ffe4052',
  }],
]);
const emscriptenVersion = '5.0.0';
const sourceArgument = process.argv.slice(2).find((argument) => argument !== '--');
const sourceDir = path.resolve(sourceArgument ?? '');
const rootDir = process.cwd();
const targetDir = path.join(rootDir, 'media', 'vendor', 'sqljs');

if (!sourceArgument) {
  throw new Error('Usage: pnpm run build:sqljs -- /path/to/sql.js');
}

const [installedPackage, sourcePackage] = await Promise.all([
  readFile(path.join(rootDir, 'node_modules', 'sql.js', 'package.json'), 'utf8').then(JSON.parse),
  readFile(path.join(sourceDir, 'package.json'), 'utf8').then(JSON.parse),
]);
const sourceDetails = supportedSources.get(installedPackage.version);
if (!sourceDetails) {
  throw new Error(`No pinned sql.js source commit is configured for ${installedPackage.version}.`);
}
if (sourcePackage.version !== installedPackage.version) {
  throw new Error(`Expected sql.js ${installedPackage.version} source, received ${sourcePackage.version}.`);
}

const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceDir, encoding: 'utf8' }).trim();
if (sourceCommit !== sourceDetails.commit) {
  throw new Error(`Expected sql.js source commit ${sourceDetails.commit}, received ${sourceCommit}.`);
}
const compilerOutput = execFileSync('emcc', ['--version'], { encoding: 'utf8' });
const compilerVersion = compilerOutput.match(/^emcc .*\) (\S+)/)?.[1];
if (compilerVersion !== emscriptenVersion) {
  throw new Error(`Build the runtime with Emscripten ${emscriptenVersion}.`);
}

const compilationFlags = [
  '-Oz',
  '-DSQLITE_OMIT_LOAD_EXTENSION',
  '-DSQLITE_DISABLE_LFS',
  '-DSQLITE_ENABLE_FTS3',
  '-DSQLITE_ENABLE_FTS3_PARENTHESIS',
  '-DSQLITE_ENABLE_FTS5',
  '-DSQLITE_THREADSAFE=0',
  '-DSQLITE_ENABLE_NORMALIZE',
].join(' ');

const [sqliteResponse, extensionFunctionsResponse] = await Promise.all([
  fetch(sourceDetails.sqliteArchiveUrl),
  fetch(sourceDetails.extensionFunctionsUrl),
]);
if (!sqliteResponse.ok) {
  throw new Error(`Could not download SQLite amalgamation: HTTP ${sqliteResponse.status}.`);
}
if (!extensionFunctionsResponse.ok) {
  throw new Error(`Could not download sql.js extension functions: HTTP ${extensionFunctionsResponse.status}.`);
}
const sqliteArchive = new Uint8Array(await sqliteResponse.arrayBuffer());
const extensionFunctions = new Uint8Array(await extensionFunctionsResponse.arrayBuffer());
if (createHash('sha3-256').update(sqliteArchive).digest('hex') !== sourceDetails.sqliteArchiveSha3) {
  throw new Error('Downloaded SQLite amalgamation failed its SHA3-256 integrity check.');
}
if (createHash('sha256').update(extensionFunctions).digest('hex') !== sourceDetails.extensionFunctionsSha256) {
  throw new Error('Downloaded sql.js extension functions failed their SHA-256 integrity check.');
}

const sqliteSourceDir = path.join(sourceDir, 'sqlite-src');
const sqliteArchivePath = path.join(sourceDir, 'cache', `${sourceDetails.sqliteAmalgamation}.zip`);
const extensionFunctionsCachePath = path.join(sourceDir, 'cache', 'extension-functions.c');
await Promise.all([
  rm(sqliteSourceDir, { recursive: true, force: true }),
  rm(path.join(sourceDir, 'out'), { recursive: true, force: true }),
  rm(path.join(sourceDir, 'dist', 'sql-wasm.js'), { force: true }),
  rm(path.join(sourceDir, 'dist', 'sql-wasm.wasm'), { force: true }),
  mkdir(path.dirname(sqliteArchivePath), { recursive: true }),
]);
await Promise.all([
  writeFile(sqliteArchivePath, sqliteArchive),
  writeFile(extensionFunctionsCachePath, extensionFunctions),
]);
execFileSync('unzip', ['-q', sqliteArchivePath, '-d', sqliteSourceDir]);
await writeFile(
  path.join(sqliteSourceDir, sourceDetails.sqliteAmalgamation, 'extension-functions.c'),
  extensionFunctions,
);
execFileSync('make', [`SQLITE_COMPILATION_FLAGS=${compilationFlags}`, 'dist/sql-wasm.js'], {
  cwd: sourceDir,
  stdio: 'inherit',
});

await mkdir(targetDir, { recursive: true });
await Promise.all([
  copyFile(path.join(sourceDir, 'dist', 'sql-wasm.js'), path.join(targetDir, 'sql-wasm.js')),
  copyFile(path.join(sourceDir, 'dist', 'sql-wasm.wasm'), path.join(targetDir, 'sql-wasm.wasm')),
  writeFile(path.join(targetDir, 'runtime.json'), `${JSON.stringify({
    sqlJsVersion: installedPackage.version,
    sqlJsCommit: sourceCommit,
    emscriptenVersion,
    sqliteVersion: sourceDetails.sqliteVersion,
    sqliteCompileOptions: ['SQLITE_ENABLE_FTS5'],
  }, null, 2)}\n`),
]);

console.log(`Built sql.js ${installedPackage.version} with FTS5 support.`);
