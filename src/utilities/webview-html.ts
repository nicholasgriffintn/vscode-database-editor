import * as vscode from 'vscode';

import { buildContentSecurityPolicy, escapeHtmlAttribute } from './html';
import { createNonce } from './nonce';

export function createEditorWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): string {
  const nonce = createNonce();
  const resourceVersion = Date.now().toString(36);
  const extensionUriValue = extensionUri.toString();
  const sqlJsUri = webview.asWebviewUri(vscode.Uri.joinPath(
    extensionUri,
    'media',
    'vendor',
    'sqljs',
    'sql-wasm.js',
  ));
  const wasmUri = webview.asWebviewUri(vscode.Uri.joinPath(
    extensionUri,
    'media',
    'vendor',
    'sqljs',
    'sql-wasm.wasm',
  ));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'webview.mjs'))
    .with({ query: `v=${resourceVersion}` });
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'styles.css'))
    .with({ query: `v=${resourceVersion}` });
  const contentSecurityPolicy = buildContentSecurityPolicy({
    cspSource: webview.cspSource,
    nonce,
  });

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link nonce="${nonce}" rel="stylesheet" href="${styleUri}">
  <title>SQLite Database Editor</title>
</head>
<body>
  <div id="app" data-wasm-uri="${wasmUri}" data-extension-uri="${escapeHtmlAttribute(extensionUriValue)}" data-resource-version="${resourceVersion}"></div>
  <script nonce="${nonce}" src="${sqlJsUri}"></script>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
}
