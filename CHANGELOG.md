# vscode-database-editor

## 0.1.0

### Minor Changes

- [`3ef8a43`](https://github.com/nicholasgriffintn/vscode-database-editor/commit/3ef8a439150a79bb00f0f9d6a383a7551b07e52e) Thanks [@nicholasgriffintn](https://github.com/nicholasgriffintn)! - feat: create new SQLite databases from the VS Code Command Palette

- [`b9f4829`](https://github.com/nicholasgriffintn/vscode-database-editor/commit/b9f48294973b63b866df51a417de393ad328d577) Thanks [@nicholasgriffintn](https://github.com/nicholasgriffintn)! - feat: inspect index and trigger DDL and create or drop SQLite indexes

- [`bd81230`](https://github.com/nicholasgriffintn/vscode-database-editor/commit/bd812307ee5c0391cab2734a70a0130c5932d5d8) Thanks [@nicholasgriffintn](https://github.com/nicholasgriffintn)! - feat: import CSV files into existing SQLite tables with preview, mapping, and transactional rollback

- [`c1445ed`](https://github.com/nicholasgriffintn/vscode-database-editor/commit/c1445ed66960c9d393515d602642ee676328648f) Thanks [@nicholasgriffintn](https://github.com/nicholasgriffintn)! - feat: add bounded database health checks and warnings for non-empty SQLite WAL sidecars

- [`5d48c9e`](https://github.com/nicholasgriffintn/vscode-database-editor/commit/5d48c9e7e96aca25c793929705b3d81de25ff379) Thanks [@nicholasgriffintn](https://github.com/nicholasgriffintn)! - fix: complete keyboard navigation, accessible state, read-only cell interaction, focus restoration, and keyboard column resizing

- [`8adb8ca`](https://github.com/nicholasgriffintn/vscode-database-editor/commit/8adb8cae4e0bb2aa9ebecb9da5722d835afc47be) Thanks [@nicholasgriffintn](https://github.com/nicholasgriffintn)! - docs: align Marketplace metadata, configuration documentation, changelog, and packaged-file exclusions for v1

### Patch Changes

- [`d6fd046`](https://github.com/nicholasgriffintn/vscode-database-editor/commit/d6fd0465ad145596accd6be39771d66a681799f0) Thanks [@nicholasgriffintn](https://github.com/nicholasgriffintn)! - refactor: organize shared webview helpers under a consistent media utilities directory

- [`affff8e`](https://github.com/nicholasgriffintn/vscode-database-editor/commit/affff8eedfc46b689dc503009d5fe3c56bd05de7) Thanks [@nicholasgriffintn](https://github.com/nicholasgriffintn)! - test: cover custom editor lifecycle, revision-aware saves, recovery, and disposal in a real Extension Development Host

- [`5aa9174`](https://github.com/nicholasgriffintn/vscode-database-editor/commit/5aa9174aff3f4281134dc788716d375c0f89a360) Thanks [@nicholasgriffintn](https://github.com/nicholasgriffintn)! - perf: render structural schema metadata before lazily counting active table rows

- [`5a6291a`](https://github.com/nicholasgriffintn/vscode-database-editor/commit/5a6291a5463486241767f75c56adda8c99c3041e) Thanks [@nicholasgriffintn](https://github.com/nicholasgriffintn)! - perf: step SQL workspace statements and cap retained preview rows before materialisation

- [`8da12be`](https://github.com/nicholasgriffintn/vscode-database-editor/commit/8da12bec796ef329c8f335e821dcd0e17db12b02) Thanks [@nicholasgriffintn](https://github.com/nicholasgriffintn)! - perf: enforce hard Copilot SQLite timeouts with isolated terminable workers

- [`a86abdc`](https://github.com/nicholasgriffintn/vscode-database-editor/commit/a86abdc5c1cc7f6b881dc35960bb67161d1fcdd6) Thanks [@nicholasgriffintn](https://github.com/nicholasgriffintn)! - perf: bound infinite-scroll DOM rows and BLOB resources with a stable bidirectional grid window

- [`9e7a690`](https://github.com/nicholasgriffintn/vscode-database-editor/commit/9e7a6901b907f838e233b22910a3539fb22ac4d0) Thanks [@nicholasgriffintn](https://github.com/nicholasgriffintn)! - perf: stream cancellable, fidelity-preserving SQL exports from the extension host

- [`9c19127`](https://github.com/nicholasgriffintn/vscode-database-editor/commit/9c191272e3540de58c06a8c27d8ecb519cd9754d) Thanks [@nicholasgriffintn](https://github.com/nicholasgriffintn)! - refactor: centralize webview workflow decisions and move shared SQLite infrastructure out of Copilot-specific modules

- [`0c5e506`](https://github.com/nicholasgriffintn/vscode-database-editor/commit/0c5e5061adef20dc38a449d8c027c341ece99d84) Thanks [@nicholasgriffintn](https://github.com/nicholasgriffintn)! - ci: verify vendor, fixture, tests, dependency audit, metadata, runtime assets, and the exact VSIX archive before publishing

- [`ba533f9`](https://github.com/nicholasgriffintn/vscode-database-editor/commit/ba533f910290ae0f0304fb6702096a7c020956a5) Thanks [@nicholasgriffintn](https://github.com/nicholasgriffintn)! - fix: enforce undo memory budget before snapshot copying in custom document history

- [`ea3a063`](https://github.com/nicholasgriffintn/vscode-database-editor/commit/ea3a0637bf2c7888367e626dadf1068737125b63) Thanks [@nicholasgriffintn](https://github.com/nicholasgriffintn)! - fix: resolve the active database from active panel state

- [`803e025`](https://github.com/nicholasgriffintn/vscode-database-editor/commit/803e025b7262a15bf61262b348d9202def3344f8) Thanks [@nicholasgriffintn](https://github.com/nicholasgriffintn)! - fix: propagate active database context into query redaction and selection metadata

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
