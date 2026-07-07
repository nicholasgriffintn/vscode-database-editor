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

## GitHub workflows

- `.github/workflows/ci.yml` runs on pushes to `main` and pull requests. It installs with pnpm, runs tests, builds a VSIX, and uploads the VSIX as a workflow artifact.
- `.github/workflows/publish.yml` runs on published GitHub releases or manual dispatch. It tests, builds a VSIX, and publishes that exact package to the Visual Studio Marketplace.

## Publishing

Before publishing:

- Replace the placeholder `publisher` value in `package.json` with your Marketplace publisher ID.
- Create an Azure service principal or user-assigned managed identity with a GitHub federated credential for this repository.
- Add that identity to the Visual Studio Marketplace publisher with the Contributor role.
- Configure repository secrets for `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and `AZURE_SUBSCRIPTION_ID`.
- Create a GitHub release or run the `Publish` workflow manually.

The workflow uses GitHub OIDC through `azure/login` and publishes with `vsce publish --azure-credential --packagePath`, so the Marketplace receives the same VSIX that CI built without storing a long-lived Azure DevOps PAT.
