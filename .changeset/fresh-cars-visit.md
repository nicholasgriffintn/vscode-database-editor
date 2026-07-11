---
vscode-database-editor: patch
---

Improve save and document-edit concurrency behavior:
- make save requests/replies document-targeted and revision-correlated so stale save acknowledgements cannot clear the wrong state
- preserve pending edits during an in-flight save and automatically retry when the latest edit occurs mid-save
- serialize overlapping document mutations so incoming database deltas apply in a deterministic order
