
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
- Configure the repository secret `VSCE_PAT` with a Visual Studio Marketplace token that can manage the publisher.
- Create a GitHub release or run the `Publish` workflow manually.

The workflow uses `vsce publish --packagePath` so the Marketplace receives the same VSIX that the workflow built. Microsoft recommends moving away from long-lived Azure DevOps PATs before their December 1, 2026 retirement; keep this workflow secret short-lived and rotate it until Entra ID publishing is available in your GitHub release setup.
