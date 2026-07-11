---
"vscode-database-editor": patch
---

test: cover v1 data-safety regressions

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
