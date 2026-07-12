const marketplaceUrl = "https://marketplace.visualstudio.com/items?itemName=NicholasGriffin.vscode-database-editor";
const githubUrl = "https://github.com/nicholasgriffintn/vscode-database-editor";
const authorUrl = "https://nicholasgriffin.dev";

const securityHeaders = {
  "Content-Security-Policy": "default-src 'self'; img-src 'self'; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none';",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
};

const pageHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DB Viewer — SQLite Database Editor for VS Code</title>
  <meta name="description" content="A SQLite database editor for VS Code.">
  <link rel="canonical" href="https://dbviewer.app/">
  <link rel="icon" href="/database-editor-icon.png" type="image/png">
  <meta property="og:title" content="DB Viewer — SQLite Database Editor for VS Code">
  <meta property="og:description" content="A SQLite database editor for VS Code.">
  <meta property="og:url" content="https://dbviewer.app/">
  <meta property="og:type" content="website">
  <meta name="theme-color" content="#070a10">
  <style>
    :root {
      color-scheme: dark;
      --bg: #070a10;
      --surface: #0d1118;
      --surface-2: #111721;
      --line: rgba(255, 255, 255, 0.1);
      --text: #f4f7fb;
      --muted: #99a4b4;
      --blue: #54c8f3;
      --blue-dark: #269bd0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
    }

    a { color: inherit; text-decoration: none; }

    .page {
      width: min(1360px, calc(100% - 64px));
      margin: 0 auto;
      padding: 56px 0 34px;
    }

    .hero {
      display: grid;
      grid-template-columns: minmax(460px, 520px) minmax(0, 1fr);
      align-items: center;
      gap: 72px;
      min-height: calc(100vh - 110px);
    }

    .logo {
      display: inline-flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 30px;
      color: #dce8f3;
      font-size: 15px;
      font-weight: 650;
      letter-spacing: -0.02em;
    }

    .logo-mark {
      display: grid;
      width: 36px;
      height: 36px;
      place-items: center;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--surface-2);
    }

    .logo img {
      display: block;
      width: 24px;
      height: 24px;
    }

    h1 {
      max-width: 520px;
      margin: 0;
      font-size: clamp(42px, 4vw, 58px);
      line-height: 1.02;
      letter-spacing: -0.045em;
      font-weight: 720;
    }

    .lead {
      max-width: 520px;
      margin: 22px 0 0;
      color: var(--muted);
      font-size: clamp(17px, 2vw, 19px);
      line-height: 1.62;
      letter-spacing: -0.015em;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 30px;
    }

    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 42px;
      padding: 0 17px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--surface-2);
      color: var(--text);
      font-size: 14px;
      font-weight: 650;
      transition: transform 160ms ease, border-color 160ms ease, background 160ms ease;
    }

    .button:hover {
      transform: translateY(-1px);
      border-color: rgba(84, 200, 243, 0.55);
      background: #14202c;
    }

    .button.primary {
      border-color: rgba(84, 200, 243, 0.62);
      background: linear-gradient(180deg, #6fd7ff, var(--blue-dark));
      color: #03121a;
    }

    .demo {
      justify-self: end;
      width: min(100%, 900px);
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 18px;
      background: var(--surface);
      box-shadow: 0 20px 70px rgba(0, 0, 0, 0.32);
    }

    .demo img {
      display: block;
      width: 100%;
      height: auto;
    }

    .install {
      max-width: 520px;
      margin-top: 32px;
      padding: 22px;
      border: 1px solid var(--line);
      border-radius: 18px;
      background: var(--surface);
    }

    .install h2 {
      margin: 0 0 12px;
      font-size: 18px;
      letter-spacing: -0.02em;
    }

    code {
      display: block;
      overflow-x: auto;
      padding: 13px 14px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #080b11;
      color: #d9e6f2;
      font-family: "SF Mono", Consolas, "Liberation Mono", monospace;
      font-size: 13px;
      white-space: nowrap;
    }

    footer {
      margin-top: 56px;
      color: var(--muted);
      font-size: 13px;
    }

    footer a {
      color: #dbe7f2;
      text-decoration: underline;
      text-decoration-color: rgba(255, 255, 255, 0.28);
      text-underline-offset: 3px;
    }

    @media (max-width: 980px) {
      .page { padding-top: 38px; }
      .hero {
        grid-template-columns: 1fr;
        min-height: auto;
      }

      .demo {
        justify-self: stretch;
        width: 100%;
      }
    }

    @media (max-width: 560px) {
      .page { width: min(100% - 28px, 1360px); }
      .actions { flex-direction: column; }
      .button { width: 100%; }
      .install { padding: 16px; }
    }
  </style>
</head>
<body>
  <main class="page">
    <section class="hero" aria-labelledby="site-title">
      <div>
        <a class="logo" href="/" aria-label="DB Viewer home">
          <span class="logo-mark" aria-hidden="true"><img src="/database-editor-icon.png" alt=""></span>
          <span>DB Viewer</span>
        </a>
        <h1 id="site-title">SQLite Database Editor for VS Code.</h1>
        <p class="lead">Browse, edit, query, and export SQLite databases without leaving VS Code.</p>
        <div class="actions">
          <a class="button primary" href="${marketplaceUrl}">Install from Marketplace</a>
          <a class="button" href="${githubUrl}">GitHub</a>
        </div>
        <section class="install" aria-labelledby="install-title">
          <h2 id="install-title">Install</h2>
          <code>ext install NicholasGriffin.vscode-database-editor</code>
        </section>
      </div>

      <div class="demo">
        <img src="/demo.gif" alt="DB Viewer editing a SQLite database in VS Code" width="900" height="550">
      </div>
    </section>

    <footer>
      Made by <a href="${authorUrl}">Nicholas Griffin</a>
    </footer>
  </main>
</body>
</html>`;

function withHeaders(headers = {}) {
  return {
    ...securityHeaders,
    ...headers,
  };
}

function htmlResponse(body, init = {}) {
  return new Response(body, {
    ...init,
    headers: withHeaders({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      ...init.headers,
    }),
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/demo.gif" || url.pathname === "/copilot-demo.gif" || url.pathname === "/database-editor-icon.png") {
      return env.ASSETS.fetch(request);
    }

    if (url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nAllow: /\nSitemap: https://dbviewer.app/sitemap.xml\n", {
        headers: withHeaders({
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "public, max-age=3600",
        }),
      });
    }

    if (url.pathname === "/sitemap.xml") {
      return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://dbviewer.app/</loc></url>
</urlset>`, {
        headers: withHeaders({
          "Content-Type": "application/xml; charset=utf-8",
          "Cache-Control": "public, max-age=3600",
        }),
      });
    }

    if (url.pathname !== "/") {
      return htmlResponse(pageHtml, { status: 404, headers: { "Cache-Control": "public, max-age=60" } });
    }

    return htmlResponse(pageHtml);
  },
};
