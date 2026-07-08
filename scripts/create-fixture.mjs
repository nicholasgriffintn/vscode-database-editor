import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import initSqlJs from 'sql.js';

function crc32(bytes) {
  let crc = 0xffffffff;
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  for (let i = 0; i < bytes.length; i++) {
    crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeB = Buffer.from(type, 'ascii');
  const crcData = Buffer.concat([typeB, data]);
  const crcVal = crc32(crcData);
  const crcB = Buffer.alloc(4);
  crcB.writeUInt32BE(crcVal);
  return Buffer.concat([len, typeB, data, crcB]);
}

function createPNG(width, height, r, g, b, a = 255) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;  // bit depth
  ihdrData[9] = 6;  // color type RGBA
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace

  // Build raw pixel data: filter byte (0) + RGBA pixels per row
  const rawRows = [];
  const pixel = Buffer.from([r, g, b, a]);
  for (let y = 0; y < height; y++) {
    rawRows.push(0); // filter byte: None
    for (let x = 0; x < width; x++) {
      rawRows.push(...pixel);
    }
  }
  const rawData = Buffer.from(rawRows);
  const compressed = zlib.deflateSync(rawData);

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdrData),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outputDir = path.join(process.cwd(), '.tmp');
const outputPath = path.join(outputDir, 'sample.sqlite');

const SQL = await initSqlJs({
  locateFile: (file) => path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', file),
});
const db = new SQL.Database();

db.run('PRAGMA foreign_keys = ON');
db.run(`
  CREATE TABLE teams (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
  )
`);
db.run(`
  CREATE TABLE people (
    id INTEGER PRIMARY KEY,
    team_id INTEGER REFERENCES teams(id),
    name TEXT NOT NULL,
    score REAL,
    active INTEGER NOT NULL DEFAULT 1,
    notes TEXT
  )
`);
db.run('CREATE INDEX people_name ON people (name)');
db.run(`
  CREATE TRIGGER people_name_required
  BEFORE INSERT ON people
  WHEN NEW.name = ''
  BEGIN
    SELECT RAISE(ABORT, 'name required');
  END
`);
db.run(`
  CREATE VIEW active_people AS
  SELECT people.id, people.name, teams.name AS team
  FROM people
  LEFT JOIN teams ON teams.id = people.team_id
  WHERE people.active = 1
`);
db.run(`
  CREATE TABLE assets (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    payload BLOB NOT NULL
  )
`);
db.run(`
  CREATE TABLE event_log (
    id INTEGER PRIMARY KEY,
    category TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    people_id INTEGER REFERENCES people(id),
    notes TEXT
  )
`);
db.run('CREATE INDEX event_log_people ON event_log (people_id)');

db.run('INSERT INTO teams (name) VALUES (?), (?)', ['Engineering', 'Data']);
db.run(
  'INSERT INTO people (team_id, name, score, active, notes) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)',
  [
    1,
    'Ada Lovelace',
    98.5,
    1,
    'First programmer',
    2,
    'Grace Hopper',
    96.25,
    1,
    'Compiler pioneer',
    null,
    'Katherine Johnson',
    99,
    0,
    'Orbital mechanics',
  ],
);
const assets = [
  { name: 'red-pixel.png', mime_type: 'image/png', payload: createPNG(8, 8, 255, 50, 50) },
  { name: 'green-pixel.png', mime_type: 'image/png', payload: createPNG(8, 8, 50, 200, 80) },
  { name: 'blue-pixel.png', mime_type: 'image/png', payload: createPNG(8, 8, 50, 100, 255) },
  { name: 'yellow-pixel.png', mime_type: 'image/png', payload: createPNG(8, 8, 255, 200, 50) },
  { name: 'purple-pixel.png', mime_type: 'image/png', payload: createPNG(8, 8, 180, 50, 200) },
  { name: 'cyan-pixel.png', mime_type: 'image/png', payload: createPNG(8, 8, 50, 220, 200) },
  { name: 'logo-32x32.png', mime_type: 'image/png', payload: createPNG(32, 32, 30, 120, 210) },
  { name: 'logo-64x64.png', mime_type: 'image/png', payload: createPNG(64, 64, 40, 140, 220) },
];

const assetStmt = db.prepare(
  'INSERT INTO assets (name, mime_type, payload) VALUES (?, ?, ?)'
);
for (const asset of assets) {
  assetStmt.run([asset.name, asset.mime_type, new Uint8Array(asset.payload)]);
}
assetStmt.free();

for (let index = 1; index <= 3000; index += 1) {
  db.run(
    'INSERT INTO event_log (category, occurred_at, duration_ms, people_id, notes) VALUES (?, ?, ?, ?, ?)',
    [
      index % 2 === 0 ? 'sync' : 'query',
      `2026-01-${String((index % 28) + 1).padStart(2, '0')}T12:${String(index % 60).padStart(2, '0')}:00Z`,
      20 + index,
      index % 5 === 0 ? null : (index % 3) + 1,
      index % 5 === 0 ? null : `Fixture event ${index}`,
    ],
  );
}

db.run(`
  CREATE TABLE wide_dashboard (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    owner TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    metric_a REAL DEFAULT 0,
    metric_b REAL DEFAULT 0,
    metric_c REAL DEFAULT 0,
    metric_d REAL DEFAULT 0,
    metric_e REAL DEFAULT 0,
    description TEXT,
    category TEXT DEFAULT 'general',
    priority INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    visibility TEXT DEFAULT 'private',
    team_id INTEGER,
    region TEXT,
    environment TEXT DEFAULT 'production',
    alert_threshold REAL DEFAULT 0.95,
    retention_days INTEGER DEFAULT 90,
    max_entries INTEGER DEFAULT 10000,
    source_url TEXT,
    config_json TEXT,
    tags TEXT,
    notes TEXT
  )
`);

for (let index = 1; index <= 500; index++) {
  db.run(
    `INSERT INTO wide_dashboard (
      name, owner, region, environment, alert_threshold,
      retention_days, max_entries, status, category, description,
      metric_a, metric_b, metric_c, metric_d, metric_e,
      priority, team_id, tags, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `Dashboard ${index}`,
      index % 3 === 0 ? 'alice' : index % 3 === 1 ? 'bob' : 'carol',
      index % 2 === 0 ? 'us-east' : 'eu-west',
      'production',
      0.90 + (index * 0.005),
      30 + (index * 10),
      1000 * (index + 1),
      index % 4 === 0 ? 'archived' : 'active',
      ['analytics', 'monitoring', 'reporting'][index % 3],
      `Sample dashboard #${index} for validation purposes`,
      Math.random() * 100,
      Math.random() * 100,
      Math.random() * 100,
      Math.random() * 100,
      Math.random() * 100,
      index % 3,
      Math.max(1, index % 5),
      index % 2 === 0 ? 'alpha,beta' : 'gamma,delta,epsilon',
      index % 7 === 0 ? null : `Wide row ${index}`,
    ],
  );
}

await mkdir(outputDir, { recursive: true });
await writeFile(outputPath, db.export());
db.close();

console.log(outputPath);
