# Database Editor for VS Code

A quick and easy way to view and edit databases directly in VS Code. Currently supports SQLite databases, with more database types planned for the future.

Free and open source forever.

## Features

- Open `.db`, `.db3`, `.sqlite`, and `.sqlite3` files in a custom editor.
- Browse tables, views, row counts, indexes, triggers, columns, primary keys, and foreign keys.
- Sort and filter table data with a fast paged grid.
- Edit cells, insert rows, and delete rows.
- Run read-only SQL queries from the query tab.
- Export visible rows **as** CSV.
- Export schema and table contents as a SQL dump.
- Save edits back to the database file with VS Code's normal save flow.

The editor uses [`sql.js`](https://github.com/sql-js/sql.js) to read and write SQLite databases in the webview without native dependencies.
