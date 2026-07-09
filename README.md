# Database Editor for VS Code

A fast, lightweight SQLite database editor built directly into VS Code. Browse tables, edit data, run queries, and manage your database schema — all without leaving the editor.

[![Visual Studio Marketplace](https://img.shields.io/badge/marketplace-NicholasGriffin.vscode--database--editor-blue)](https://marketplace.visualstudio.com/items?itemName=NicholasGriffin.vscode-database-editor)

![SQLite Database Editor VS Code demo](docs/demo.gif)

## Features

- **Open any SQLite file** — Supports `.db`, `.db3`, `.sqlite`, `.sqlite3`, `.sdb`, `.s3db`, and `.gpkg` files
- **Browse database structure** — Tables, views, indexes, triggers, columns, primary and foreign keys in a clean sidebar
- **Copilot integration** — Use Copilot Chat to inspect schema, run queries, and analyze tables with privacy-safe context
- **Paged data grid** — Sort, filter, and paginate through table data with per-column search
- **Inline editing** — Click any cell to edit its value, add new rows, or delete existing ones
- **Image preview** — BLOB columns with PNG/JPEG/GIF/WebP images render as thumbnails inline
- **Pin rows & columns** — Pin important columns to the left and mark rows for easy reference
- **VS Code save integration** — Edits are tracked and saved using the normal `Ctrl+S` / `Cmd+S` flow with undo/redo support
- **Schema management** — Create, rename, and drop tables; add and remove columns
- **SQL workspace** — Run SELECTs, PRAGMAs, and multi-statement SQL scripts with result grids, query history, rollback-safe writes, and normal VS Code save tracking
- **Export** — Export visible rows as CSV, or dump schema and table data as SQL
- **Pure client-side** — Powered by [`sql.js`](https://github.com/sql-js/sql.js) (SQLite compiled to WebAssembly) — no native dependencies

## Usage

1. Open any SQLite database file (`.db`, `.sqlite`, etc.) in VS Code.
2. The custom editor launches automatically — browse tables in the sidebar.
3. Click a table to view its data in the paged grid.
4. Click any cell to edit its value, or use the Actions column to add/delete rows.
5. Press `Ctrl+S` (`Cmd+S` on macOS) or click the Save button to persist changes.

### Schema tools

Use the Schema tab to understand and evolve the database structure without leaving the editor. The default Graph view visualizes tables, views, columns, primary keys, foreign keys, and directed relationships; switch to DDL whenever you want the generated SQLite definition for the selected object.

The schema tools support:

- Relationship graph cards for tables and views, including PK/FK/not-null/type markers on columns.
- Directed foreign-key edges from referencing columns to referenced columns, with isolated tables still shown.
- Graph and DDL views side by side in the same Schema tab, so visual inspection does not replace the textual schema.
- Clicking a graph card to select that table/view and sync the sidebar, DDL, and data grid.
- Table management actions for creating, renaming, and dropping tables, plus adding or removing columns.
- Automatic refresh after schema changes so the graph, sidebar, DDL, and grid stay in sync.

Schema changes run against the editor's in-memory database copy first. Save with the normal VS Code `Ctrl+S` / `Cmd+S` flow when you're ready to persist them.

### SQL workspace

Use the SQL workspace to inspect data, run schema introspection, or apply manual SQLite changes against the editor's in-memory database copy. Successful write scripts mark the custom editor dirty and refresh the sidebar/grid; persist them with the normal VS Code save flow.

The workspace supports:

- Read-only `SELECT`, safe `WITH`, `VALUES`, `EXPLAIN`, and read-only PRAGMA statements.
- Multi-statement scripts, including scripts that end with a result-producing query.
- Mutating SQLite statements such as `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `ALTER`, and `DROP`.
- Automatic transaction wrapping for mutating scripts without explicit transaction control, with rollback if a later statement fails.
- User-managed transactions via `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, and `RELEASE` when you need explicit control.
- Query history for recently executed scripts, available from the SQL workspace toolbar.

If a script with explicit transaction control commits a change before a later statement fails, the workspace still marks the database as possibly changed and refreshes the UI so unsaved changes are not hidden.

### GitHub Copilot integration

When GitHub Copilot Chat is installed, use `@sqlite`, its `/schema`, `/query`, `/explain`, and `/profile` commands, or the “Chat with SQLite Database” editor action. The participant keeps recent conversation turns and receives privacy-safe editor context: the active database, selected table/view, filters, and sort state. Grid row values are never included in that automatic context.

![GitHub Copilot Chat integration demo](docs/copilot-demo.gif)

Copilot tools can:

- List open databases and require an explicit `databaseUri` whenever more than one is open.
- Return a paginated schema summary or focused columns, keys, indexes, triggers, and CREATE SQL for the selected object.
- Run validated `SELECT`/safe `WITH` queries with cancellation, a configurable time budget, and a configurable row cap.
- Run grounded `EXPLAIN QUERY PLAN` analysis and aggregate table profiling without returning sample rows.
- In read/write mode, apply one confirmed modification or an atomic, confirmed multi-statement migration through the editor's dirty/save/undo history.

The integration has two access modes:

- **Read-only (`ro`)** — The default. Copilot can inspect schema and run validated read-only query and analysis tools. It cannot run `INSERT`, `UPDATE`, `DELETE`, DDL, `PRAGMA`, `ATTACH`, `VACUUM`, or scripts.
- **Read/write (`rw`)** — Enables confirmed modification and migration tools. Confirmations identify the target database and preview the SQL. Successful changes refresh the webview, mark the document dirty, and can be saved, undone, or redone normally.

### Copilot privacy and limits

Query rows are processed inside the extension host and sent to the language model only when a query tool is used. Columns matching `databaseEditor.copilot.sensitiveColumnPatterns` are replaced with `[REDACTED]` before tool results are returned. Defaults cover common password, token, secret, API-key, and SSN names. This name-based redaction is a safeguard, not a substitute for reviewing database contents before granting Copilot access.

- `databaseEditor.copilot.enable` hides the participant and tools and also blocks tool invocation at runtime.
- `databaseEditor.copilot.accessMode` controls read-only versus confirmed read/write access.
- `databaseEditor.copilot.maxResultRows` controls the query response cap (default 200, maximum 500).
- `databaseEditor.copilot.queryTimeoutMs` controls the soft query/analysis time budget (default 5000 ms).
- `databaseEditor.copilot.sensitiveColumnPatterns` configures case-insensitive regular expressions used for value redaction.

SQLite runs in-process, so cancellation and timeout checks occur between SQLite result steps; they cannot interrupt a single long native/WASM step. Set `databaseEditor.copilot.accessMode` to `rw` only when you intend to review and confirm database changes.

## Requirements

- VS Code 1.125.0 or later
- No external dependencies — SQLite runs entirely in the webview via WebAssembly

## Known Limitations

- Only SQLite databases are supported (other SQL databases planned for future releases)
- SQL workspace changes run against the editor's in-memory copy until you save the custom editor

## License

Apache 2.0 — see [LICENSE](LICENSE) for details.
