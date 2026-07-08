# Database Editor for VS Code

[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/NicholasGriffin.vscode-database-editor?label=Marketplace&color=7aa2f7)](https://marketplace.visualstudio.com/items?itemName=NicholasGriffin.vscode-database-editor)

A fast, lightweight SQLite database editor built directly into VS Code. Browse tables, edit data, run queries, and manage your database schema — all without leaving the editor.

![SQLite Database Editor VS Code demo](docs/demo.gif)

## Features

- **Open any SQLite file** — Supports `.db`, `.db3`, `.sqlite`, `.sqlite3`, `.sdb`, `.s3db`, and `.gpkg` files
- **Browse database structure** — Tables, views, indexes, triggers, columns, primary and foreign keys in a clean sidebar
- **Paged data grid** — Sort, filter, and paginate through table data with per-column search
- **Inline editing** — Click any cell to edit its value, add new rows, or delete existing ones
- **Image preview** — BLOB columns with PNG/JPEG/GIF/WebP images render as thumbnails inline
- **Pin rows & columns** — Pin important columns to the left and mark rows for easy reference
- **VS Code save integration** — Edits are tracked and saved using the normal `Ctrl+S` / `Cmd+S` flow with undo/redo support
- **Schema management** — Create, rename, and drop tables; add and remove columns
- **SQL query tab** — Run read-only SQL queries with a full result grid
- **Export** — Export visible rows as CSV, or dump schema and table data as SQL
- **Pure client-side** — Powered by [`sql.js`](https://github.com/sql-js/sql.js) (SQLite compiled to WebAssembly) — no native dependencies

## Usage

1. Open any SQLite database file (`.db`, `.sqlite`, etc.) in VS Code.
2. The custom editor launches automatically — browse tables in the sidebar.
3. Click a table to view its data in the paged grid.
4. Click any cell to edit its value, or use the Actions column to add/delete rows.
5. Press `Ctrl+S` (`Cmd+S` on macOS) or click the Save button to persist changes.

## Requirements

- VS Code 1.125.0 or later
- No external dependencies — SQLite runs entirely in the webview via WebAssembly

## Known Limitations

- Only SQLite databases are supported (other SQL databases planned for future releases)
- The SQL query tab only allows `SELECT` statements (data editing is done through the grid)

## License

Apache 2.0 — see [LICENSE](LICENSE) for details.
