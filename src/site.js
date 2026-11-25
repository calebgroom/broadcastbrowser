// app:// — the app's own pages, served to its windows.
//
//   app://operator/...   operator/ (the control window)
//   app://pages/...      pages/ (pages the browser can show: black.html, the default home, and
//                        test.html, a test pattern for checking the outputs)
//
// The browser's pages are in a session of their own (see graphic.js), so the scheme is handled in
// that session too. A page from the web can link to app://pages/, but not to app://operator/.

import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { net, protocol } from 'electron';

const here = dirname(fileURLToPath(import.meta.url));
const ROOTS = { operator: resolve(here, '../operator'), pages: resolve(here, '../pages') };

/** Before the app is ready. */
export function registerScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);
}

const isFile = (p) => existsSync(p) && statSync(p).isFile();

/** The file for a path under root; null if none. */
function find(root, path) {
  const p = resolve(root, '.' + decodeURIComponent(path));
  if (p !== root && !p.startsWith(root + sep)) return null;
  if (isFile(p)) return p;
  if (isFile(join(p, 'index.html'))) return join(p, 'index.html');
  return null;
}

/** After the app is ready: app:// in a session (`hosts`: which of ROOTS it serves). */
export function handleScheme(ses, hosts = Object.keys(ROOTS)) {
  ses.protocol.handle('app', async (req) => {
    const url = new URL(req.url);
    const root = hosts.includes(url.host) ? ROOTS[url.host] : null;
    const file = root && find(root, url.pathname);
    if (!file) return new Response('not found', { status: 404 });
    const res = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(res.headers);
    headers.set('cache-control', 'no-cache');
    if (file.endsWith('.js')) headers.set('content-type', 'text/javascript; charset=utf-8');
    return new Response(res.body, { status: res.status, headers });
  });
}
