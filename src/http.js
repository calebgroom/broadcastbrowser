// The control API, for Bitfocus Companion or anything else on the network:
//
//   GET  /status              what's on air, the preview and program, the tabs, the favorites, the outputs, recent errors
//   GET  /frame.png           the frame on the output now (1920×1080)
//   GET  /preview.png         the preview's page as it is now (1920×1080)
//   GET  /tab-picture?n=3&width=72&height=40   a tab's latest picture (its card's), a PNG that fits
//   GET or POST /<command>?<args>   a command (commands.js), e.g.
//                             /go?url=example.com   /go?url=…&take=true   /favorite?n=2
//                             /take   /freeze   /black   /live   /favorites
//                             /tabs   /tab?n=2   /tab?n=2&take=true   /tab-new?url=…   /tab-close?n=3
//                             /scroll?screens=1&target=program   /zoom?by=1   /reload?target=program
//
// Arguments come from the query string or a JSON body. Answers are JSON: { ok: true, status } or
// { ok: false, error } (status 400).
//
// Every request needs the API token (config.js, apiToken; README.md, "Control API"), one of these
// ways; without it, 401 (unless api-token is off):
//
//   - signed (the Companion module): the token never crosses the network. Three headers:
//       X-BB-Time       the time, in milliseconds since 1970 (within a minute of this Mac's)
//       X-BB-Nonce      a one-off value, 16 to 64 letters, digits, - or _ (never the same twice)
//       X-BB-Signature  hex HMAC-SHA256, keyed with the token, of these lines, joined with \n:
//                         BB1, the method (GET), the path and query as sent (/go?url=x),
//                         X-BB-Time, X-BB-Nonce, and the body's SHA-256 in hex (of nothing, for none)
//     A request seen once isn't taken again (its nonce), nor one more than a minute off (its time),
//     so one overheard can't be sent again. Every 401 has this Mac's time in X-BB-Time, so a client
//     whose clock is off can allow for it and try again.
//   - the token itself: Authorization: Bearer <token>, or ?token=<token> (for anything else: curl,
//     HTTPie, Companion's own HTTP actions). Anyone who can watch the network's traffic can see it.
//
// And no CORS: a web page, in any browser, can't read the answers. Without these, any site visited
// on a computer that can reach this one could drive the app, and read the pages it has open (signed
// in) off /preview.png.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { LISTS } from './commands.js';

/** How far a signed request's time may be from this Mac's, either way. */
const SIGNED_WINDOW_MS = 60_000;
const MAX_BODY = 100_000;

const json = (res, code, body, headers = {}) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body, null, 2) + '\n');
};

const sha256 = (data) => createHash('sha256').update(data).digest();
// (Compared in constant time, as their hashes: the same length whatever was sent.)
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && timingSafeEqual(sha256(a), sha256(b));

/** The token the request carries itself: the Authorization header's (Bearer), or the query string's. */
function sentToken(req, url) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '');
  return m ? m[1] : url.searchParams.get('token');
}

/** What a signed request signs (see the top). The Companion module makes the same (its src/api.js). */
export function signedText(method, path, time, nonce, body) {
  return ['BB1', method.toUpperCase(), path, String(time), nonce, sha256(body ?? '').toString('hex')].join('\n');
}

/** The body, as it came (a Buffer): null if it's too big or the request broke off. */
function readBody(req) {
  return new Promise((ok) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        ok(null);
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', () => ok(null));
    req.on('close', () => ok(null));
  });
}

/**
 * @param {import('./commands.js').Commands} commands
 * @param {string} host the address to listen on (config.js, resolveApiHost: 127.0.0.1, 0.0.0.0 for
 *   every network, or one of the Mac's). server.listenOn(host) moves it there while it runs.
 * @param {() => string | null} token the API token now (it can be changed while the app runs: the menu's New API Token); null: none needed
 */
export function startHttp(commands, port, host, token, onError) {
  // The nonces of the signed requests taken lately, and when each can be forgotten (once its time is
  // out of the window, the time alone refuses it).
  const nonces = new Map();
  const forget = setInterval(() => {
    const now = Date.now();
    for (const [n, until] of nonces) if (until < now) nonces.delete(n);
  }, 10_000);
  forget.unref();

  /** Why this request isn't allowed (an error message), or null if it is. */
  const refuse = (req, url, raw) => {
    const t = token();
    if (!t) return null;
    const h = req.headers;
    if (h['x-bb-signature'] !== undefined) {
      const time = Number(h['x-bb-time']);
      const nonce = String(h['x-bb-nonce'] ?? '');
      if (!Number.isFinite(time)) return 'signed request: X-BB-Time missing';
      if (!/^[\w-]{16,64}$/.test(nonce)) return 'signed request: X-BB-Nonce must be 16 to 64 letters, digits, - or _';
      if (Math.abs(Date.now() - time) > SIGNED_WINDOW_MS) return `signed request: its time is more than ${SIGNED_WINDOW_MS / 1000} s from this Mac's (see X-BB-Time)`;
      const want = createHmac('sha256', t).update(signedText(req.method, req.url ?? '/', h['x-bb-time'], nonce, raw)).digest('hex');
      if (!same(String(h['x-bb-signature']).toLowerCase(), want)) return 'signed request: the signature doesn’t match (the wrong token?)';
      if (nonces.has(nonce)) return 'signed request: already taken once (its nonce)';
      if (nonces.size > 50_000) return 'signed request: too many at once';
      nonces.set(nonce, Date.now() + 2 * SIGNED_WINDOW_MS + 1000);
      return null;
    }
    if (same(sentToken(req, url), t)) return null;
    return 'this needs the API token: Authorization: Bearer <token>, or ?token=<token> (in the app: File → Control API → Copy Control API Address)';
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const name = url.pathname.replace(/^\/+|\/+$/g, '');
    if (req.method !== 'GET' && req.method !== 'POST') return json(res, 405, { ok: false, error: 'GET or POST' }, { allow: 'GET, POST' });
    // (The body first: a signed request signs it too.)
    const raw = req.method === 'POST' ? await readBody(req) : Buffer.alloc(0);
    if (raw === null) return json(res, 413, { ok: false, error: `the body is too big (${MAX_BODY} bytes at most)` });
    const why = refuse(req, url, raw);
    if (why) return json(res, 401, { ok: false, error: why }, { 'www-authenticate': 'Bearer realm="Broadcast Browser"', 'x-bb-time': String(Date.now()) });
    url.searchParams.delete('token');
    try {
      if (name === '' || name === 'status') return json(res, 200, { ok: true, status: commands.status() });
      if (name === 'frame.png') {
        // (The frame on the output now, at full size: to check the picture before NDI.)
        // (No output running: the page as it is now, straight from the offscreen window.)
        const png = commands.snapshot() ?? (await commands.graphic.program.capture());
        if (!png) return json(res, 404, { ok: false, error: 'no frame yet' });
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
        return res.end(png);
      }
      if (name === 'preview.png') {
        const png = await commands.graphic.preview.capture();
        if (!png) return json(res, 404, { ok: false, error: 'no preview yet' });
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
        return res.end(png);
      }
      if (name === 'tab-picture') {
        const png = commands.tabPicture(Object.fromEntries(url.searchParams));
        if (!png) return json(res, 404, { ok: false, error: 'no picture of that tab yet' });
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
        return res.end(png);
      }
      let body = {};
      const text = raw.toString('utf8');
      if (text.trim()) {
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { ok: false, error: 'the body must be a JSON object' });
      const { token: _t, ...fromBody } = body;
      const args = { ...Object.fromEntries(url.searchParams), ...fromBody };
      const out = await commands.run(name, args);
      // (favorites and tabs answer with what they found, the others with the status.)
      json(res, 200, LISTS.includes(name) ? { ok: true, ...out } : { ok: true, status: out });
    } catch (e) {
      json(res, 400, { ok: false, error: e.message });
    }
  });
  const problem = (e) => `control API: ${e.code === 'EADDRINUSE' ? `port ${port} is in use (another copy running? --port=...)` : e.code === 'EADDRNOTAVAIL' ? `${e.address ?? 'that address'} isn't this Mac's now` : e.message}`;
  /**
   * Listens on host (moving from where it was: open connections are closed, so a client asks again
   * at the new address). Resolves with null once it is, or the problem (and it listens nowhere).
   */
  server.listenOn = (to) =>
    new Promise((resolve) => {
      const go = () => {
        const failed = (e) => resolve(problem(e));
        server.once('error', failed);
        server.listen(port, to, () => {
          server.off('error', failed);
          resolve(null);
        });
      };
      if (!server.listening) return go();
      server.close(go);
      server.closeAllConnections();
    });
  server.listenOn(host).then((p) => p && onError(p));
  return server;
}
