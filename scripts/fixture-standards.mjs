function queryRows(db, sql) {
  const [result] = db.exec(sql);
  if (!result) {
    return [];
  }
  return result.values.map((values) => Object.fromEntries(
    result.columns.map((column, index) => [column, values[index]]),
  ));
}

function scalar(db, sql) {
  const [row] = queryRows(db, sql);
  return row ? Object.values(row)[0] : null;
}

export function getFixtureStandardsReport(db) {
  const peopleForeignKey = queryRows(db, "PRAGMA foreign_key_list('people')")
    .find((foreignKey) => foreignKey.from === 'team_id');
  const projectForeignKey = queryRows(db, "PRAGMA foreign_key_list('team_projects')")
    .find((foreignKey) => foreignKey.from === 'team_id');
  const generatedColumns = queryRows(db, "PRAGMA table_xinfo('people')")
    .filter((column) => Number(column.hidden) === 2 || Number(column.hidden) === 3)
    .map((column) => ({ name: column.name, hidden: Number(column.hidden) }));

  return {
    foreignKeysEnabled: Number(scalar(db, 'PRAGMA foreign_keys')) === 1,
    peopleForeignKey: peopleForeignKey
      ? { onUpdate: peopleForeignKey.on_update, onDelete: peopleForeignKey.on_delete }
      : null,
    projectForeignKey: projectForeignKey
      ? { onUpdate: projectForeignKey.on_update, onDelete: projectForeignKey.on_delete }
      : null,
    generatedColumns,
    generatedValues: queryRows(db, 'SELECT normalized_name, name_length FROM people WHERE id = 1')[0] ?? null,
    internalAliasColumn: Number(scalar(
      db,
      "SELECT COUNT(*) FROM pragma_table_info('imported_records') WHERE name = '__database_editor_identity'",
    )),
    declaredRowidColumn: Number(scalar(
      db,
      "SELECT COUNT(*) FROM pragma_table_info('legacy_records') WHERE name = 'rowid'",
    )),
    largeRowids: queryRows(db, 'SELECT CAST(_rowid_ AS TEXT) AS rowid FROM archive_entries ORDER BY _rowid_')
      .map((row) => String(row.rowid)),
    membershipRows: Number(scalar(db, 'SELECT COUNT(*) FROM memberships')),
    membershipsWithoutRowid: /\bWITHOUT\s+ROWID\b/i.test(String(scalar(
      db,
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'memberships'",
    ))),
    duplicateViewRows: Number(scalar(db, 'SELECT COUNT(*) FROM query_event_categories')),
    nestedSensitiveValue: scalar(db, 'SELECT renamed_value FROM account_export_summary LIMIT 1'),
    auditRows: Number(scalar(db, 'SELECT COUNT(*) FROM people_audit_log')),
    transactionTargetRows: Number(scalar(db, 'SELECT COUNT(*) FROM event_log')),
    teamNameUnique: Number(scalar(
      db,
      "SELECT COUNT(*) FROM pragma_index_list('teams') WHERE [unique] = 1",
    )) > 0,
    releasePrefixedObjects: Number(scalar(
      db,
      "SELECT COUNT(*) FROM sqlite_schema WHERE name LIKE 'release_%'",
    )),
  };
}

export function assertFixtureStandards(db, { requireForeignKeysEnabled = false } = {}) {
  const report = getFixtureStandardsReport(db);
  const failures = [];
  const require = (condition, message) => {
    if (!condition) {
      failures.push(message);
    }
  };

  if (requireForeignKeysEnabled) {
    require(report.foreignKeysEnabled, 'foreign-key enforcement must be enabled while generating the fixture');
  }
  require(
    report.peopleForeignKey?.onUpdate === 'CASCADE' && report.peopleForeignKey?.onDelete === 'RESTRICT',
    'people.team_id must cascade updates and restrict deletes',
  );
  require(report.projectForeignKey?.onDelete === 'CASCADE', 'team_projects.team_id must cascade deletes');
  require(
    JSON.stringify(report.generatedColumns) === JSON.stringify([
      { name: 'normalized_name', hidden: 2 },
      { name: 'name_length', hidden: 3 },
    ]),
    'people must include one virtual and one stored generated column',
  );
  require(
    report.generatedValues?.normalized_name === 'ada lovelace' && report.generatedValues?.name_length === 12,
    'generated people values must be populated deterministically',
  );
  require(report.internalAliasColumn === 1, 'imported_records must exercise an internal identity alias collision');
  require(report.declaredRowidColumn === 1, 'legacy_records must exercise a declared rowid column');
  require(
    JSON.stringify(report.largeRowids) === JSON.stringify(['9007199254740992', '9007199254740993']),
    'archive_entries must preserve adjacent rowids above Number.MAX_SAFE_INTEGER',
  );
  require(report.membershipRows === 1005, 'memberships must cross two 500-row pagination chunks');
  require(report.membershipsWithoutRowid, 'memberships must use a composite primary key WITHOUT ROWID');
  require(report.duplicateViewRows === 2, 'query_event_categories must expose duplicate browse-only rows');
  require(report.nestedSensitiveValue === 'fixture-secret', 'nested account views must preserve sensitive-column lineage');
  require(report.auditRows === 3, 'people inserts must populate trigger-backed audit data');
  require(report.transactionTargetRows === 3000, 'event_log must provide a deterministic transaction target');
  require(report.teamNameUnique, 'teams.name must provide a natural unique-constraint target');
  require(report.releasePrefixedObjects === 0, 'fixture objects must not use release_-specific names');

  if (failures.length > 0) {
    throw new Error(`Fixture standards failed:\n- ${failures.join('\n- ')}`);
  }
  return report;
}
