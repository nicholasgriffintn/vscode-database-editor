import { quoteIdentifier } from './sql.mjs';

export function parseCsv(source) {
  const text = String(source ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  const lineNumbers = [];
  let row = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
        if (character === '\n') line += 1;
      }
      continue;
    }
    if (character === '"' && field === '') quoted = true;
    else if (character === ',') { row.push(field); field = ''; }
    else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field); rows.push(row); lineNumbers.push(rowLine);
      row = []; field = ''; line += 1; rowLine = line;
    } else field += character;
  }
  if (quoted) throw new Error(`CSV line ${rowLine} has an unterminated quoted field.`);
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); lineNumbers.push(rowLine); }
  return { rows, lineNumbers };
}

export function convertCsvValue(value, column, { convertTypes = false, nullText } = {}) {
  if (nullText !== undefined && value === nullText) return null;
  if (!convertTypes || value === '') return value;
  const type = String(column?.type ?? '').toUpperCase();
  if (/INT/.test(type)) {
    if (!/^[+-]?\d+$/.test(value)) throw new Error(`Expected INTEGER for ${column.name ?? 'column'}.`);
    const integer = Number(value);
    if (!Number.isSafeInteger(integer)) throw new Error(`INTEGER for ${column.name ?? 'column'} is outside the safe range.`);
    return integer;
  }
  if (/(REAL|FLOA|DOUB|NUMERIC|DECIMAL)/.test(type)) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`Expected numeric value for ${column.name ?? 'column'}.`);
    return number;
  }
  return value;
}

export function importCsvRows(db, {
  tableName, columns, mapping, rows, lineNumbers = [], convertTypes = false, nullText, isCancelled = () => false,
}) {
  if (!mapping?.length) throw new Error('Map at least one CSV column to a table column.');
  const columnByName = new Map(columns.map((column) => [column.name, column]));
  const targets = mapping.map(({ tableColumn }) => {
    const column = columnByName.get(tableColumn);
    if (!column) throw new Error(`Unknown table column: ${tableColumn}`);
    if (column.canInsert === false || column.generated || column.hidden) throw new Error(`Column cannot be imported: ${tableColumn}`);
    return column;
  });
  if (new Set(targets.map((column) => column.name)).size !== targets.length) throw new Error('Each table column can only be mapped once.');
  const sql = `INSERT INTO ${quoteIdentifier(tableName)} (${targets.map((column) => quoteIdentifier(column.name)).join(', ')}) VALUES (${targets.map(() => '?').join(', ')})`;
  db.run('BEGIN IMMEDIATE');
  const statement = db.prepare(sql);
  try {
    for (let index = 0; index < rows.length; index += 1) {
      if (isCancelled()) throw new Error('CSV import cancelled.');
      try {
        statement.run(mapping.map(({ csvIndex }, mappingIndex) => convertCsvValue(rows[index][csvIndex] ?? '', targets[mappingIndex], { convertTypes, nullText })));
      } catch (error) {
        throw new Error(`CSV line ${lineNumbers[index] ?? index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    db.run('COMMIT');
    return { inserted: rows.length };
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  } finally {
    statement.free();
  }
}
