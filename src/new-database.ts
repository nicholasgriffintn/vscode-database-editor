import type { SqlJsStatic } from './sqljs-host';

export const NEW_DATABASE_SAVE_OPTIONS = {
  title: 'Create SQLite Database',
  saveLabel: 'Create Database',
  filters: {
    'SQLite databases': ['sqlite', 'sqlite3', 'db', 'db3', 'sdb', 's3db', 'gpkg'],
    'All files': ['*'],
  },
};

export function createEmptySqliteBytes(SQL: SqlJsStatic): Uint8Array {
  const database = new SQL.Database();
  try {
    // sql.js exports a zero-length buffer until SQLite allocates its first page.
    database.run('CREATE TABLE "__database_editor_init" ("value" INTEGER)');
    database.run('DROP TABLE "__database_editor_init"');
    return database.export();
  } finally {
    database.close();
  }
}

export async function createNewDatabase<TUri>({
  showSaveDialog,
  createDatabaseBytes,
  writeFile,
  openDatabase,
}: {
  showSaveDialog: (options: typeof NEW_DATABASE_SAVE_OPTIONS) => Promise<TUri | undefined>;
  createDatabaseBytes: () => Promise<Uint8Array>;
  writeFile: (destination: TUri, bytes: Uint8Array) => Promise<void>;
  openDatabase: (destination: TUri) => Promise<void>;
}): Promise<TUri | undefined> {
  // A returned destination means the native save dialog has completed its overwrite confirmation.
  const destination = await showSaveDialog(NEW_DATABASE_SAVE_OPTIONS);
  if (!destination) {
    return undefined;
  }

  const bytes = await createDatabaseBytes();
  await writeFile(destination, bytes);
  await openDatabase(destination);
  return destination;
}
