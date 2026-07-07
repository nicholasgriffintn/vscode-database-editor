import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import initSqlJs from 'sql.js';

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
db.run(
  'INSERT INTO assets (name, mime_type, payload) VALUES (?, ?, ?)',
  [
    'single-pixel.png',
    'image/png',
    new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
      0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
      0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
      0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xdd, 0x8d,
      0xb0, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
      0x44, 0xae, 0x42, 0x60, 0x82,
    ]),
  ],
);

for (let index = 1; index <= 350; index += 1) {
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

for (let index = 1; index <= 25; index++) {
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
