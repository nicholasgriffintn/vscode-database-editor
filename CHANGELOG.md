# vscode-database-editor

## 0.0.6

### Patch Changes

- [`1bac49d`](https://github.com/nicholasgriffintn/vscode-database-editor/commit/1bac49d4afc5821757e8a190c72dd4b9801f6ca4) Thanks [@nicholasgriffintn](https://github.com/nicholasgriffintn)! - feat: creating the first beta release, an extnesion in testing

- [`607a0ea`](https://github.com/nicholasgriffintn/vscode-database-editor/commit/607a0ea222917c41796e88165db2b6c7e3a4747b) Thanks [@nicholasgriffintn](https://github.com/nicholasgriffintn)! - Improve save and document-edit concurrency behavior:

  - make save requests/replies document-targeted and revision-correlated so stale save acknowledgements cannot clear the wrong state
  - preserve pending edits during an in-flight save and automatically retry when the latest edit occurs mid-save
  - serialize overlapping document mutations so incoming database deltas apply in a deterministic order

- [`041e24d`](https://github.com/nicholasgriffintn/vscode-database-editor/commit/041e24d8ad285e50c923e824aacacda1e577b65b) Thanks [@nicholasgriffintn](https://github.com/nicholasgriffintn)! - test: cover v1 data-safety regressions

  - Expanded the generated SQLite fixture with general-purpose people, teams, projects, memberships, account, archive, and import schemas covering:
    - Foreign-key update cascade, delete cascade, and delete restriction
    - Hidden-rowid alias collisions and declared rowid columns
    - Rowids above Number.MAX_SAFE_INTEGER
    - Composite-primary-key WITHOUT ROWID pagination
    - Virtual and stored generated columns
    - Duplicate view rows without durable identity
    - Persisted and nested sensitive-column views
    - Trigger-backed audit data
    - Incomplete transaction scenarios
    - Unique and constraint failures
  - Added reusable fixture standards that validate these invariants whenever the fixture is generated.
  - Extracted host/webview protocol types into src/custom-editor-protocol.ts.
  - Added pure revision-aware save-acknowledgement decisions.
  - Updated src/extension.ts to use the extracted protocol and message helpers.
  - Added regression coverage across the SQLite client, SQL utilities, grid identity, fixture standards, and Copilot view lineage tests.

- [`07d5988`](https://github.com/nicholasgriffintn/vscode-database-editor/commit/07d5988203f27beabe5131fff11e4be2c73884dc) Thanks [@nicholasgriffintn](https://github.com/nicholasgriffintn)! - Harden SQLite editing against data-loss and wrong-row mutations.

  - Enforce foreign-key constraints for editor and Copilot database sessions.
  - Reject SQL scripts that leave transactions or savepoints open.
  - Preserve exact row identity across pagination, shadowed rowid aliases, composite primary keys, and 64-bit rowids.
  - Display generated columns as read-only data and omit them from insert and update statements.
  - Confirm destructive actions consistently and retain dialog input when inserts, schema changes, or row mutations fail.
