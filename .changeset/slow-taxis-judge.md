---
vscode-database-editor: patch
---

Fix a grid regression where switching from one deeply-scrolled table to another could render an empty grid due to stale scroll position being reused across table data loads.
