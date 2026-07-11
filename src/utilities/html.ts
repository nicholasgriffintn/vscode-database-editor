export function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function buildContentSecurityPolicy({
  cspSource,
  nonce,
}: {
  cspSource: string;
  nonce: string;
}): string {
  return [
    "default-src 'none'",
    `style-src ${cspSource}`,
    `script-src 'nonce-${nonce}' 'wasm-unsafe-eval' ${cspSource}`,
    `img-src ${cspSource} blob:`,
    `connect-src ${cspSource}`,
    `font-src ${cspSource}`,
  ].join('; ');
}
