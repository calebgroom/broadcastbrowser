// Ad blocking (optional, off by default): two switches, each a filter engine from Ghostery's ad
// blocker (@ghostery/adblocker-electron), built from the lists uBlock Origin uses.
//
//   adblock      ads and trackers (EasyList, EasyPrivacy, uBlock Origin's filters): their requests
//                cancelled, and what's left of them on the page (empty boxes, "Advertisement")
//                hidden.
//   annoyances   cookie banners and other pop-ups (EasyList Cookie, uBlock Origin's annoyances).
//
// Both apply to every tab (they share one session, browser.js), except on the sites in the allow
// list (a site that won't work with an ad blocker: its pages are left alone). A switch, or a site
// allowed, takes effect as pages load: what's already on a page (on air above all) isn't changed
// under it, but its next requests are.
//
// The engines are kept in the app's folder (adblock/*.bin), so they're ready at once at the next
// start, even with no network; once a day they're made again from the lists, in the background. The
// first time (or with the cache gone and no network) there's nothing to block with: Messages says
// so, and it tries again every 10 minutes.
//
// Each tab counts what's been blocked since its page last loaded (requests cancelled or
// redirected), for its monitor and its card.
//
// The library's own enableBlockingInSession takes the session's request hooks for itself, with one
// engine and no exceptions; these hooks do the same work for both engines, the allow list and the
// counts. Its in-page helper (a preload, sandboxed: it only uses Electron's messaging) asks for each
// frame's hiding rules; the answer comes from here.

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { app, ipcMain, net } from 'electron';
import { ElectronBlocker, adsAndTrackingLists, fromElectronDetails, fullLists } from '@ghostery/adblocker-electron';
import { fileSetting, saveSetting } from './config.js';

const require = createRequire(import.meta.url);
/** The library's in-page helper (resolved from the library itself: pnpm keeps it beside it, not here). */
const PRELOAD = createRequire(require.resolve('@ghostery/adblocker-electron')).resolve('@ghostery/adblocker-electron-preload');

/** The two engines: their lists, and what they're called in messages. */
const KINDS = {
  ads: { look: 'adblock', lists: adsAndTrackingLists, what: 'ads and trackers' },
  annoyances: { look: 'annoyances', lists: fullLists.filter((u) => !adsAndTrackingLists.includes(u)), what: 'cookie banners and pop-ups' },
};
/** Made again from the lists when older than this (h); tried again after a failure (min). */
const REFRESH_HOURS = 24;
const RETRY_MINUTES = 10;

/** A page's site, for the allow list: its host, without www. */
export function siteOf(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return '';
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

export class AdBlock {
  /**
   * @param {{ session: Electron.Session, look: () => { adblock?: boolean, annoyances?: boolean }, tabOf: (webContentsId: number) => { wc: Electron.WebContents } | undefined,
   *   onError: (e: string) => void, onChange: () => void, dir?: string }} o
   */
  constructor(o) {
    this.o = o;
    this.dir = o.dir ?? join(app.getPath('userData'), 'adblock');
    /** The engines (null: not loaded), loading, when they were made, and why not (if not). */
    this.engines = { ads: null, annoyances: null };
    this.loading = { ads: false, annoyances: false };
    this.madeAt = { ads: null, annoyances: null };
    this.errors = { ads: null, annoyances: null };
    this.retry = {};
    /** Sites whose pages aren't blocked (the settings file's "adblock-allow"). */
    const saved = fileSetting('adblock-allow');
    this.allowed = new Set(Array.isArray(saved) ? saved.map((s) => siteOf(`https://${String(s).replace(/^https?:\/\//, '')}`)).filter(Boolean) : []);
    /** What's been blocked in each tab since its page loaded, by its webContents id. */
    this.counts = new Map();

    const ses = o.session;
    ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (d, done) => this.beforeRequest(d, done));
    ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (d, done) => this.headersReceived(d, done));
    ses.registerPreloadScript({ type: 'frame', filePath: PRELOAD });
    ipcMain.handle('@ghostery/adblocker/inject-cosmetic-filters', (e, url, msg) => this.cosmetics(e, url, msg));
    ipcMain.handle('@ghostery/adblocker/is-mutation-observer-enabled', () => true);
    this.refreshTimer = setInterval(() => this.update({ refresh: true }), 3600 * 1000);
    this.refreshTimer.unref?.();
  }

  close() {
    clearInterval(this.refreshTimer);
    Object.values(this.retry).forEach(clearTimeout);
  }

  // ---- The engines ----------------------------------------------------------------------------------

  /** The switches changed (or it's start-up): the engines switched on loaded, if they aren't. refresh: and made again if they're old. */
  update({ refresh = false } = {}) {
    const look = this.o.look();
    for (const [kind, k] of Object.entries(KINDS)) {
      if (!look[k.look]) continue;
      if (!this.engines[kind]) this.load(kind);
      else if (refresh && Date.now() - (this.madeAt[kind] ?? 0) > REFRESH_HOURS * 3600 * 1000) this.make(kind);
    }
  }

  /** An engine: from the cache at once (if there is one), then made again from the lists if it's old or missing. */
  async load(kind) {
    if (this.loading[kind]) return;
    this.loading[kind] = true;
    this.o.onChange();
    const file = join(this.dir, `${kind}.bin`);
    try {
      const [buf, info] = await Promise.all([readFile(file), stat(file)]);
      this.engines[kind] = ElectronBlocker.deserialize(new Uint8Array(buf));
      this.madeAt[kind] = info.mtimeMs;
    } catch {
      // (None yet, or from another version of the library: made from the lists.)
    }
    this.loading[kind] = false;
    this.o.onChange();
    if (!this.engines[kind] || Date.now() - this.madeAt[kind] > REFRESH_HOURS * 3600 * 1000) await this.make(kind);
  }

  /** An engine made from its lists (fetched now), kept in the cache, and put in use. */
  async make(kind) {
    if (this.making?.[kind]) return;
    this.making = { ...this.making, [kind]: true };
    clearTimeout(this.retry[kind]);
    const k = KINDS[kind];
    if (!this.engines[kind]) {
      this.loading[kind] = true;
      this.o.onChange();
    }
    try {
      const engine = await ElectronBlocker.fromLists((url) => net.fetch(url), k.lists, { loadNetworkFilters: true, loadCosmeticFilters: true });
      this.engines[kind] = engine;
      this.madeAt[kind] = Date.now();
      this.errors[kind] = null;
      await mkdir(this.dir, { recursive: true });
      await writeFile(join(this.dir, `${kind}.bin`), engine.serialize());
    } catch (e) {
      const message = String(e?.message ?? e).split('\n')[0];
      // (With an engine from the cache, it carries on with that: only without one is it worth saying.)
      if (!this.engines[kind]) {
        this.errors[kind] = message;
        this.o.onError(`ad blocking: couldn't get the lists for ${k.what} (${message}): not blocking them until it can (trying again every ${RETRY_MINUTES} minutes)`);
      }
      this.retry[kind] = setTimeout(() => this.o.look()[k.look] && this.make(kind), RETRY_MINUTES * 60 * 1000);
    } finally {
      this.making[kind] = false;
      this.loading[kind] = false;
      this.o.onChange();
    }
  }

  /** The engines switched on and ready. */
  active() {
    const look = this.o.look();
    return Object.entries(KINDS)
      .filter(([kind, k]) => look[k.look] && this.engines[kind])
      .map(([kind]) => this.engines[kind]);
  }

  /** For tests: an engine put in use as it is. */
  setEngine(kind, engine) {
    this.engines[kind] = engine;
    this.madeAt[kind] = Date.now();
  }

  // ---- The allow list --------------------------------------------------------------------------------

  /** Whether a page's site is allowed (its host, or a domain it's under, in the list). */
  isAllowed(url) {
    const site = siteOf(url);
    if (!site) return false;
    for (const a of this.allowed) if (site === a || site.endsWith(`.${a}`)) return true;
    return false;
  }

  /** A site allowed (true), blocked again (false), or the other way. Kept in the settings file. */
  setAllowed(url, on) {
    // (An address with a scheme as it is; a bare name, weather.example, as a web site.)
    const s = String(url ?? '').trim();
    const site = /^[a-z][\w+.-]*:\/\//i.test(s) || /^(about|data|blob|javascript):/i.test(s) ? siteOf(s) : siteOf(`https://${s}`);
    if (!site) throw new Error(`adblock-allow: "${url}" isn't a web site`);
    // (Blocked again: also any entry it's under, so it really is blocked.)
    const covering = [...this.allowed].filter((a) => site === a || site.endsWith(`.${a}`));
    const next = on === undefined ? !covering.length : on;
    if (next) this.allowed.add(site);
    else covering.forEach((a) => this.allowed.delete(a));
    const err = saveSetting('adblock-allow', [...this.allowed].sort());
    if (err) this.o.onError(err);
    this.o.onChange();
    return { site, allowed: next };
  }

  /** Whether a request's tab is on an allowed site (or blocking is off for it). */
  allowedFor(webContentsId) {
    const tab = webContentsId ? this.o.tabOf(webContentsId) : undefined;
    return !!tab && this.isAllowed(tab.wc.getURL());
  }

  // ---- The session's hooks ---------------------------------------------------------------------------

  count(webContentsId) {
    if (webContentsId) this.counts.set(webContentsId, (this.counts.get(webContentsId) ?? 0) + 1);
  }

  /** What's been blocked in a tab since its page loaded. */
  blockedIn(webContentsId) {
    return this.counts.get(webContentsId) ?? 0;
  }

  /** A request: cancelled (or redirected to a harmless stand-in) if an engine says so. */
  beforeRequest(d, done) {
    // (A page loading: its count starts again. Pages themselves are never blocked.)
    if (d.resourceType === 'mainFrame') {
      if (d.webContentsId) this.counts.set(d.webContentsId, 0);
      return done({});
    }
    const engines = this.active();
    if (!engines.length || this.allowedFor(d.webContentsId)) return done({});
    let request;
    try {
      request = fromElectronDetails(d);
      if (request.type === 'other') request.guessTypeOfRequest();
    } catch {
      return done({});
    }
    for (const engine of engines) {
      const { redirect, match } = engine.match(request);
      if (redirect) {
        this.count(d.webContentsId);
        return done({ redirectURL: redirect.dataUrl });
      }
      if (match) {
        this.count(d.webContentsId);
        return done({ cancel: true });
      }
    }
    done({});
  }

  /** A page's (or frame's) headers: the engines' content-security rules added (a few filters block that way). */
  headersReceived(d, done) {
    if (d.resourceType !== 'mainFrame' && d.resourceType !== 'subFrame') return done({});
    const engines = this.active();
    // (The page loading isn't its tab's page yet: the allow list goes by the page's own address.)
    if (!engines.length || this.isAllowed(d.resourceType === 'mainFrame' ? d.url : this.o.tabOf(d.webContentsId)?.wc.getURL() ?? '')) return done({});
    const directives = [];
    try {
      const request = fromElectronDetails(d);
      for (const engine of engines) {
        const csp = engine.getCSPDirectives(request);
        if (csp) directives.push(...csp.split(';').map((s) => s.trim()).filter(Boolean));
      }
    } catch {
      return done({});
    }
    if (!directives.length) return done({});
    const headers = { ...(d.responseHeaders ?? {}) };
    for (const name of Object.keys(headers))
      if (name.toLowerCase() === 'content-security-policy') {
        directives.push(...headers[name]);
        delete headers[name];
      }
    done({ responseHeaders: { ...headers, 'content-security-policy': [directives.join(';')] } });
  }

  /** A frame asking (through the library's helper) for its hiding rules: each engine's put in. */
  async cosmetics(event, url, msg) {
    // (Only for the tabs' pages: no other window asks for, or gets, the filters' styles and scripts.)
    if (!this.o.tabOf(event.sender.id)) return;
    const engines = this.active();
    if (!engines.length) return;
    // (The tab's page decides: a frame in an allowed page is left alone too.)
    if (this.isAllowed(event.sender.getURL()) || this.isAllowed(url)) return;
    for (const engine of engines) await engine.onInjectCosmeticFilters(event, url, msg);
  }

  /** For the status. */
  status() {
    const look = this.o.look();
    const part = (kind) => ({
      on: !!look[KINDS[kind].look],
      ready: !!this.engines[kind],
      loading: this.loading[kind],
      madeAt: this.madeAt[kind] ? new Date(this.madeAt[kind]).toISOString() : null,
      error: this.errors[kind],
    });
    return { ads: part('ads'), annoyances: part('annoyances'), allowed: [...this.allowed].sort() };
  }
}

/** (For tests and the README: the lists each switch uses.) */
export const LISTS = Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, v.lists]));
