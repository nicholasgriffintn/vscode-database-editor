---
"vscode-database-editor": patch
---

test: cover v1 data-safety regressions

- Expanded scripts/create-fixture.mjs with release-regression cases for:
  - Foreign-key update cascade, delete cascade, and delete restriction
  - Hidden-rowid alias collisions and declared rowid
  - Rowids above Number.MAX_SAFE_INTEGER
  - Composite-primary-key WITHOUT ROWID pagination
  - Virtual and stored generated columns
  - Duplicate view rows without durable identity
  - Persisted and nested sensitive-column views
  - Trigger-backed audit data
  - Incomplete transaction scenarios
  - Unique/constraint failures
- Extracted host/webview protocol types into src/custom-editor-protocol.ts.
- Added pure revision-aware save-acknowledgement decisions.
- Updated src/extension.ts to use the extracted protocol and message helpers.
- Added test/custom-editor-protocol.test.mjs.
- Recorded the known Phase 1 blockers as 15 executable node:test TODO regressions across the SQLite client, SQL utilities, grid identity, and Copilot view lineage tests.