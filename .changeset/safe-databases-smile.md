---
"vscode-database-editor": patch
---

Harden SQLite editing against data-loss and wrong-row mutations.

- Enforce foreign-key constraints for editor and Copilot database sessions.
- Reject SQL scripts that leave transactions or savepoints open.
- Preserve exact row identity across pagination, shadowed rowid aliases, composite primary keys, and 64-bit rowids.
- Display generated columns as read-only data and omit them from insert and update statements.
- Confirm destructive actions consistently and retain dialog input when inserts, schema changes, or row mutations fail.
