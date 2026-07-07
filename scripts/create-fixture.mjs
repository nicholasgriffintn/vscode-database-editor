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

await mkdir(outputDir, { recursive: true });
await writeFile(outputPath, db.export());
db.close();

console.log(outputPath);
