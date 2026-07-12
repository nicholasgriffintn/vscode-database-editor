# Contributing

## Development

```sh
pnpm install
pnpm run compile
pnpm test
```

Run the full validation workflow locally:

```sh
pnpm run validate:local
```

This checks the vendored SQLite runtime, unit and Extension Development Host integration suites, generated fixture standards, production dependency audit, explicit VSIX build, and archive contents. The verified artifact is always `.tmp/release/vscode-database-editor.vsix`.

## Vendored runtime files

The SQLite runtime used by the webview lives in `media/vendor/sqljs`. These files are copied from the installed `sql.js` package:

- `sql-wasm.js`
- `sql-wasm.wasm`
- `LICENSE.sql.js`

They are built upstream by `sql.js`, which compiles SQLite to WebAssembly with Emscripten. This repository does not build SQLite or the WASM file directly.

Refresh the vendored files after changing the `sql.js` dependency:

```sh
pnpm run vendor:sqljs
```

Check the committed files match the installed package:

```sh
pnpm run vendor:sqljs:check
```

Test the extension in VS Code using the built-in Extension Development Host:

- Open this folder in VS Code.
- Open Run and Debug.
- Select `Launch Extension`.
- Press F5.

The launch config compiles the extension, creates `.tmp/sample.sqlite`, and opens an Extension Development Host with the sample database. The custom SQLite editor should show tables, views, indexes, triggers, editable table rows, CSV export, and SQL dump export.

## Architecture

- `src/extension.ts` owns activation, the custom editor provider, and the typed extension-host/webview message boundary.
- `src/sqlite-document.ts` and `src/sqlite-document-state.ts` own custom-document bytes, saved baselines, backup restoration, and dirty-state comparisons.
- `src/editor-settings.ts` reads extension-host settings. Defaults must remain aligned with `media/editor-settings.mjs` and `package.json`; `test/editor-settings.test.mjs` enforces the host/webview defaults.
- `src/sqlite-ai/` contains the Copilot participant, document registry, SQL safety checks, SQL.js host, and tools. Automatic editor context must never include row values or raw filter values.
- `media/webview.mjs` coordinates the editor UI and delegates feature behaviour to modules grouped under `media/database`, `media/editor`, `media/grid`, `media/schema`, `media/sql`, and the other domain directories.
- `test/*.test.mjs` exercises both browser-side ES modules and the compiled extension-host modules in `dist/`.

When changing the host/webview protocol, update both message handlers and add regression coverage for any state transition that can affect saving, undo/redo, backups, or privacy. When adding a command or setting, update `package.json`, README documentation, and relevant manifest tests together.

## GitHub workflows

- `.github/workflows/ci.yml` runs on pushes to `main` and pull requests. It verifies vendor and fixture consistency, runs unit/integration/audit gates, rejects generated differences, builds one explicit VSIX, inspects it, and uploads that exact file.
- `.github/workflows/publish.yml` runs on published GitHub releases or manual dispatch. It serialises Marketplace releases through the protected `visual-studio-marketplace` environment, rejects tag/version mismatches and already-published versions, and publishes the inspected VSIX by exact filename.

## Publishing

Before publishing:

- Replace the `publisher` value in `package.json` with your Marketplace publisher ID if you are not me.
- Create an Azure service principal or user-assigned managed identity with a GitHub federated credential for this repository.
- Add that identity to the Visual Studio Marketplace publisher with the Contributor role.
- Configure repository secrets for `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and `AZURE_SUBSCRIPTION_ID`.
- Create a GitHub release or run the `Publish` workflow manually.

The workflow uses GitHub OIDC through `azure/login` and publishes with `vsce publish --azure-credential --packagePath`, so the Marketplace receives the same VSIX that CI built without storing a long-lived Azure DevOps PAT.

If a bad release reaches the Marketplace, stop the publish workflow, fix the issue on `main`, and publish a new patch version. For a release that must no longer be offered, use the Marketplace publisher portal to deprecate or unpublish that exact version; do not overwrite an existing version or reuse its tag. Record the reason and replacement version in the GitHub release and generated Changesets changelog.
