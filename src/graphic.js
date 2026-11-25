// The switcher: tabs (browser.js), each a page of its own, and two of them on a vision mixer's
// preview and program buses.
//
//   program  on air: every frame it paints goes to the outputs.
//   preview  the tab being checked and worked on (clicked through, scrolled to the right place)
//            while the program stays on air. The address bar goes to its page.
//   the rest open in the background: still running (a scoreboard stays current), drawing a frame
//            a second for their cards' thumbnails, their video paused. Any of them can be brought
//            into the preview (the tab there goes back to the background); a favorite opens a new
//            tab (or brings back one already on that page).
//
// Tabs are only closed by the operator (none is ever closed for want of room: past `tabsWarn` the
// app says so). A closed tab can be opened again (its page loaded again, scrolled to where it was).
//
// Take swaps the preview and the program (A/B, as a switcher's buses): the preview goes on air, and
// what was on air comes back to the preview, ready to go back to. Taking a page that's still loading
// holds the picture that was on air until it has loaded, then cuts to it (hold: on by default), so
// the audience never sees a blank or half-drawn page; so loading a page and taking it straight
// away (auto take, or the API's take=true) is a cut to it once it's ready.
//
// What's on air is the program's page, unless it's held:
//
//   live    every frame the program paints goes out.
//   loading the picture before stays on air while the program loads (after a take, or when the
//           program's own page goes somewhere else: a link, a reload). A page that fails to load
//           stays held (the operator sees why); hold-max gives up waiting on a slow one.
//   frozen  the picture on air when Freeze was pressed stays on air; the program page carries on
//           (its monitor shows it), so it can be clicked or scrolled, then shown again.
//   black   black on air.
//
// Zoom: Chromium keeps one zoom per site, shared by every page from that site in the session, and
// every tab shares the session (so a login in the preview is still there once it's taken). So
// a site in the preview that's also on air can't be zoomed without zooming the air: that's refused
// (zoom it on air, or after the take), and a page loaded into the preview from the site on air
// takes the air's zoom.

import { app, session } from 'electron';
import { AdBlock } from './adblock.js';
import { Browser } from './browser.js';
import { HEIGHT, WIDTH } from './ndi.js';
import { handleScheme } from './site.js';

/** The held picture's thumbnail in the control window (px). */
const PROGRAM_WIDTH = 480;
/** After a page has loaded, wait this long before cutting to it (web fonts, the first layout shifts). */
const SETTLE_MS = 300;
/** The browsers' session: their own cookies, cache and logins, kept between starts. */
export const PARTITION = 'persist:broadcast';
/** The same, kept in memory only (keep-signins off): every start begins signed out of everything. */
export const MEMORY_PARTITION = 'broadcast';
/** A tab card's picture in the control window (px wide: sharp on a Retina screen). How often it's made: the look's `thumbs` (s). */
const THUMB_WIDTH = 360;
/** The choices for how often (s; 0: only when the tab changes place: into or out of the preview or program). */
export const THUMB_EVERY = [1, 2, 5, 10, 30, 0];
/** Closed tabs remembered, to open again. */
const CLOSED_MAX = 20;
/** A tab with nothing in it. */
export const BLANK = 'app://pages/black.html';
/** Zoom: the steps of − and + (as Chrome's). */
const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

/** One black frame (BGRA, opaque). */
let blackFrame = null;
const black = () => (blackFrame ??= Buffer.alloc(WIDTH * HEIGHT * 4, Buffer.from([0, 0, 0, 255])));

/** Chrome's user agent: Electron's, without Electron's and the app's own names in it (some sites turn those away). */
function chromeUserAgent(ua) {
  const names = [app.getName(), app.getName().replace(/\s+/g, ''), process.env.npm_package_name].filter(Boolean);
  let out = ua.replace(/ Electron\/\S+/, '');
  for (const n of names) out = out.replace(new RegExp(` ${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\S+`, 'i'), '');
  return out;
}

const pct = (z) => `${Math.round(z * 100)}%`;
const sameUrl = (a, b) => !!a && !!b && a.replace(/\/$/, '') === b.replace(/\/$/, '');

export class Graphic {
  /**
   * @param {{ fps: string, rate: [number, number], look: object, hold: boolean | null, holdMax: number, tabsWarn: number, insecure: string[], userAgent: string | null,
   *   onFrame: (bgra: Buffer) => void, wantFrames?: () => boolean, onMonitor: (role: 'preview' | 'program', jpeg: Buffer) => void,
   *   onProgram: (p: { kind: string, jpeg?: Buffer } | null) => void, onThumb: (t: { id: string, jpeg: Buffer }) => void,
   *   onChange: () => void, onError: (e: string) => void }} o
   */
  constructor(o) {
    this.o = o;
    /** The look: scrollbars shown, the program's sound, hold while loading, auto take. Kept in the settings file by commands.js. */
    const { zoom: _oldZoom, ...saved } = o.look ?? {};
    this.look = { scrollbars: false, muted: true, hold: true, autoTake: false, thumbs: 5, adblock: false, annoyances: false, ...saved, ...(o.hold === null ? {} : { hold: o.hold }) };
    /** On air: frozen by the operator, held while the program loads (since when), black. */
    this.frozen = false;
    this.loadHold = null;
    this.blackOut = false;
    /** The picture held on air (a NativeImage; null: black). */
    this.heldImage = null;
    this.resend = false;
    this.closed = false;

    /** The browsers' session (keep-signins off: in memory only, config.js). */
    this.partition = o.keepSignIns === false ? MEMORY_PARTITION : PARTITION;
    const ses = session.fromPartition(this.partition);
    this.session = ses;
    handleScheme(ses, ['pages']);
    ses.setUserAgent(o.userAgent ?? chromeUserAgent(ses.getUserAgent()));
    // (Nothing a page asks for that a broadcast doesn't want: no camera, microphone, location,
    // notifications… Full screen is fine: a video's full-screen button fills the 1920×1080.)
    // The same whether a page asks (a request: a prompt, in a browser) or only checks (what
    // navigator.permissions.query and Notification.permission say): without the check handler,
    // every check would say granted. And no USB, serial or HID device, ever.
    const allowed = ['fullscreen', 'clipboard-sanitized-write'];
    ses.setPermissionRequestHandler((_wc, permission, done) => done(allowed.includes(permission)));
    ses.setPermissionCheckHandler((_wc, permission) => allowed.includes(permission));
    ses.setDevicePermissionHandler(() => false);
    // (No downloads: a page that starts one, or a link to a file, is refused, without a Save dialog
    // on the operator's screen. Said in Messages, once in a while: a page could start one after another.)
    let downloadsSaid = 0;
    let downloadsHidden = 0;
    ses.on('will-download', (e, item) => {
      e.preventDefault();
      const now = Date.now();
      if (now - downloadsSaid < 10_000) return void downloadsHidden++;
      const more = downloadsHidden ? ` (and ${downloadsHidden} more)` : '';
      downloadsSaid = now;
      downloadsHidden = 0;
      o.onError(`download refused: ${item.getFilename() || 'a file'} from ${URL.parse(item.getURL())?.host || 'a page'}${more}. Broadcast Browser doesn't download files`);
    });

    /** The tabs, in the operator's order: the program, the preview and the rest. */
    this.tabs = [];
    /** Tabs closed, most recent first: { url, title, zoom, scrollY }, to open again. */
    this.closedTabs = [];
    let made = 0;
    /** A new tab (not yet in the list: the caller puts it there). */
    this.make = () =>
      new Browser({
        id: `t${++made}`,
        partition: this.partition,
        look: () => this.look,
        onPaint: (x, img) => this.paint(x, img),
        onMonitor: (x, jpeg) => (x === this.program || x === this.preview) && o.onMonitor(this.roleOf(x), jpeg),
        onEvent: (x, kind) => this.event(x, kind),
        // (A pop-up: the same tab.)
        onOpen: (x, url) => {
          x.go(url);
          x.touched = true;
        },
        onError: o.onError,
      });
    this.program = this.make();
    this.preview = this.make();
    this.tabs = [this.program, this.preview];
    this.program.setRole('program', { fps: o.fps, muted: this.look.muted });
    this.preview.setRole('preview');

    // Ad blocking (src/adblock.js): off unless the look switches it on; every tab, but allowed sites.
    this.adblock = new AdBlock({
      session: ses,
      look: () => this.look,
      tabOf: (id) => this.tabs.find((b) => b.alive() && b.wc.id === id),
      onError: o.onError,
      onChange: () => o.onChange(),
    });

    app.on('certificate-error', (e, wc, url, error, _cert, done) => {
      const b = this.tabs.find((x) => x.alive() && x.wc === wc);
      if (!b) return;
      const host = (() => {
        try {
          return new URL(url).hostname.toLowerCase();
        } catch {
          return '';
        }
      })();
      if (o.insecure.includes(host)) {
        e.preventDefault();
        done(true);
        return;
      }
      o.onError(`${host}: certificate not trusted (${error}). To show it anyway, add "${host}" to the insecure setting (README.md, "Settings").`);
      done(false);
    });
  }

  roleOf(b) {
    return b === this.program ? 'program' : 'preview';
  }

  /** A browser by role: 'preview' (also the default) or 'program'. */
  target(t) {
    if (t === undefined || t === null || t === '' || t === 'preview') return this.preview;
    if (t === 'program' || t === 'air') return this.program;
    throw new Error(`target must be preview or program (got ${t})`);
  }

  alive() {
    return !this.closed;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.holdTimer);
    clearTimeout(this.settleTimer);
    this.adblock.close();
    this.tabs.forEach((b) => b.close());
  }

  /** A tab's page, for the status, with what ad blocking has done there (and whether its site is allowed). */
  pageOf(b) {
    const n = b.nav();
    if (!n) return n;
    return { ...n, blocked: this.adblock.blockedIn(b.wc.id), adsAllowed: this.adblock.isAllowed(n.url) };
  }

  // ---- Frames ----------------------------------------------------------------------------------

  /** A frame a tab painted: the program's go out (unless the air is held); every tab's card gets a thumbnail now and then. */
  paint(b, img) {
    if (b === this.program && (this.resend || this.air() === 'live')) {
      this.resend = false;
      if (!this.o.wantFrames || this.o.wantFrames()) this.o.onFrame(this.airBitmap(img));
    }
    // (A tab's picture: every `thumbs` seconds; with 0, once after it changes place, and its first.)
    const now = Date.now();
    const every = Number(this.look.thumbs ?? 5);
    if (!b.thumbAt || (every > 0 && now - b.thumbAt >= every * 1000)) this.takeThumb(b, img, now);
    else if (every > 0 || !b.thumbSettled) {
      // Too soon for a new picture: this frame is kept, and becomes the picture once it's time,
      // even if the page never draws again (a page that drew its first frame blank and the rest a
      // moment later would otherwise keep the blank one). With 0, once: a second after its first.
      b.lateThumb = img;
      if (!b.thumbTimer)
        b.thumbTimer = setTimeout(
          () => {
            b.thumbTimer = null;
            const late = b.lateThumb;
            b.lateThumb = null;
            b.thumbSettled = true;
            if (late && b.alive() && this.tabs.includes(b)) this.takeThumb(b, late, Date.now());
          },
          every > 0 ? Math.max(0, b.thumbAt + every * 1000 - now) : 1000,
        );
    }
  }

  /** A tab's picture, from a frame: for its card, and kept for the API's /tab-picture. */
  takeThumb(b, img, now) {
    b.thumbAt = now;
    b.lateThumb = null;
    // (Kept too, for the API's /tab-picture: Companion's tab buttons. Its version, in the tabs'
    // status as picture, says when there's a new one to fetch.)
    const thumb = img.resize({ width: THUMB_WIDTH, quality: 'good' });
    b.thumbImage = thumb;
    b.thumbVersion = (b.thumbVersion ?? 0) + 1;
    this.o.onThumb?.({ id: b.id, jpeg: thumb.toJPEG(70) });
  }

  /** The frame that goes out: the program's, the held one, or black. */
  airBitmap(img) {
    const air = this.air();
    if (air === 'black') return black();
    if (air === 'live') return img.toBitmap();
    // (Held, with nothing held: the app has just started, or it was black. Black rather than a page half drawn.)
    return this.heldImage ? this.heldImage.toBitmap() : black();
  }

  /** Draws the program again (an output just switched on: it gets the picture now, not at the next change). */
  repaint() {
    if (this.closed || !this.program.alive()) return;
    this.resend = true;
    this.program.wc.invalidate();
  }

  get paintMs() {
    return this.program.paintMs;
  }

  // ---- The browsers' events --------------------------------------------------------------------

  event(b, kind) {
    if (this.closed) return;
    // (A tab in the background: its title and address for its card; a page it loaded, its video paused.)
    if (b !== this.program && b !== this.preview) {
      if (kind === 'stop') b.pauseMedia();
      this.o.onChange();
      return;
    }
    const program = b === this.program;
    // (Taken "now": no hold for the load it was taken in the middle of.)
    if (kind === 'start' && program && this.look.hold && this.noHoldFor !== b) this.startLoadHold();
    if (kind === 'stop' && this.noHoldFor === b) this.noHoldFor = null;
    if (kind === 'stop' && program && this.loadHold && !b.loadError) {
      // (Loaded: cut to it once it's settled. Failed: stay held, the operator decides.)
      clearTimeout(this.settleTimer);
      const at = this.loadHold.at;
      this.settleTimer = setTimeout(() => {
        if (!this.closed && this.loadHold?.at === at) this.endLoadHold();
      }, SETTLE_MS);
    }
    if (kind === 'fail') {
      const e = b.loadError;
      this.o.onError(
        program
          ? `on air: couldn't load ${e.url} (${e.message})${this.loadHold ? ': the picture before is still on air (Show As Is to show the failure, or Take to go back)' : ''}`
          : `preview: couldn't load ${e.url} (${e.message})`,
      );
    }
    if (kind === 'navigated') this.applyZoom(b);
    this.o.onChange();
  }

  // ---- Zoom ----------------------------------------------------------------------------------------

  other(b) {
    return b === this.program ? this.preview : this.program;
  }

  /** Whether the two browsers' pages are from the same site, so share a zoom. */
  /**
   * Signs out (commands.js, signout): of one site, `url`'s (its cookies, and its parent domain's,
   * where sign-ins usually are: .example.com for www.example.com; and its subdomains'; and the
   * site's stored data), or with no url, of every site (every cookie and stored datum, the cache,
   * and HTTP logins). Pages already open keep what they show until they're loaded again.
   * Returns { site, cookies } (how many cookies went), or { all: true }.
   */
  async signOut({ url } = {}) {
    const ses = this.session;
    if (!url) {
      await ses.clearStorageData();
      await ses.clearCache();
      await ses.clearAuthCache();
      return { all: true };
    }
    const u = URL.parse(url);
    if (!u || !/^https?:$/.test(u.protocol)) throw new Error(`signout: only a web page's site (http or https), not ${url}`);
    const host = u.hostname;
    const mine = (domain) => {
      const d = domain.replace(/^\./, '');
      return d === host || host.endsWith(`.${d}`) || d.endsWith(`.${host}`);
    };
    const cookies = (await ses.cookies.get({})).filter((c) => c.domain && mine(c.domain));
    for (const c of cookies) await ses.cookies.remove(`http${c.secure ? 's' : ''}://${c.domain.replace(/^\./, '')}${c.path || '/'}`, c.name);
    await ses.clearStorageData({ origin: u.origin, storages: ['localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'filesystem', 'websql'] });
    return { site: host, cookies: cookies.length };
  }

  sameSite() {
    const h = this.program.host();
    return !!h && h === this.preview.host();
  }

  /** A page loaded: its zoom put on, unless it's the preview and the site's on air (it takes the air's). */
  applyZoom(b) {
    const other = this.other(b);
    if (this.sameSite()) {
      if (b === this.preview) {
        const z = other.zoomNow();
        if (b.wantZoom && Math.abs(b.wantZoom - z) > 1e-6)
          this.o.onError(`preview: zoom ${pct(b.wantZoom)} not put on: the page on air is from the same site, and a site has one zoom (it's at ${pct(z)}). Zoom it after the take.`);
        b.zoom = z;
        b.wantZoom = null;
        return;
      }
      other.zoom = b.zoom;
    }
    b.wantZoom = null;
    b.setZoomNow(b.zoom);
  }

  /** A browser's zoom: a factor, or by: a step up or down. */
  setZoom(b, { factor, by }) {
    let z = factor;
    if (by !== undefined) {
      const cur = b.zoomNow();
      z = by > 0 ? (ZOOMS.find((v) => v > cur + 1e-6) ?? ZOOMS.at(-1)) : ([...ZOOMS].reverse().find((v) => v < cur - 1e-6) ?? ZOOMS[0]);
    }
    if (b === this.preview && this.sameSite() && Math.abs(z - b.zoomNow()) > 1e-6)
      throw new Error("zoom: the page on air is from the same site as the preview, and a site has one zoom: zooming the preview would zoom the air. Zoom it on air (target=program), or after the take.");
    b.zoom = z;
    if (this.sameSite()) this.other(b).zoom = z;
    b.setZoomNow(z);
  }

  // ---- Pages and tabs --------------------------------------------------------------------------------

  /**
   * The address bar: a page into the preview's tab (zoom: put on with it; 1 without); newTab: in a
   * new tab instead. take: on air once it's loaded (the look's autoTake without it).
   */
  load(url, { zoom, take, scrollY, newTab = false } = {}) {
    if (newTab) return this.openTab(url, { zoom, take, scrollY });
    const p = this.preview;
    p.zoom = zoom ?? 1;
    p.wantZoom = zoom ?? null;
    p.go(url, { scrollY });
    if (take ?? this.look.autoTake) this.take();
    this.o.onChange();
  }

  /**
   * A page in a new tab, into the preview (the tab there stays open in the background; a
   * placeholder there is used for it). placeholder: the new tab is one (a new, empty tab).
   */
  openTab(url, { zoom, take, scrollY, placeholder = false } = {}) {
    let b = this.preview;
    if (!b.isBlank()) {
      b = this.make();
      this.tabs.push(b);
      this.toPreview(b);
    }
    b.zoom = zoom ?? 1;
    b.wantZoom = zoom ?? null;
    b.go(url, { scrollY, placeholder });
    this.tabsChanged();
    if (take ?? this.look.autoTake) this.take();
    this.o.onChange();
  }

  /** A favorite (or home): the tab already on that page into the preview, if there is one (not the one on air); a new tab otherwise. */
  openFavorite(url, { zoom, take } = {}) {
    // (Not a placeholder showing the same black page: Black opened on purpose is a tab of its own.)
    const open = this.tabs.find((b) => b !== this.program && b.alive() && !b.loadError && !b.isBlank() && sameUrl(b.wc.getURL(), url));
    if (!open) return this.openTab(url, { zoom, take });
    this.toPreview(open);
    if (take ?? this.look.autoTake) this.take();
    this.o.onChange();
  }

  /** A tab into the preview; the tab there goes to the background (or is closed, if it's blank). */
  toPreview(b) {
    if (b === this.preview) return;
    if (b === this.program) throw new Error('that tab is on air: Take swaps it with the preview');
    if (!this.tabs.includes(b)) throw new Error('no such tab');
    const cur = this.preview;
    this.preview = b;
    b.setRole('preview');
    if (cur.isBlank()) this.removeTab(cur, { remember: false });
    else cur.setRole('tab');
    // (Both changed place: new pictures for their cards.)
    b.thumbAt = cur.thumbAt = 0;
    b.thumbSettled = cur.thumbSettled = false;
    this.tabsChanged();
    this.o.onChange();
  }

  /** A tab by { id } or { n } (from 1, in the tabs' order). */
  /**
   * A tab's latest picture (its thumbnail, as on its card), as a PNG that fits in width × height
   * (keeping its shape): for a Companion button. null: none yet.
   */
  tabPicture(b, width, height) {
    const img = b.thumbImage;
    if (!img || img.isEmpty()) return null;
    const { width: w, height: h } = img.getSize();
    const scale = Math.min(width / w, height / h);
    return img.resize({ width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)), quality: 'good' }).toPNG();
  }

  findTab(a, what = 'tab') {
    if (a.id !== undefined && a.id !== '') {
      const b = this.tabs.find((x) => x.id === String(a.id));
      if (!b) throw new Error(`${what}: no tab ${a.id}`);
      return b;
    }
    if (a.n !== undefined && a.n !== '') {
      const b = this.tabs[Number(a.n) - 1];
      if (!b) throw new Error(`${what}: there are ${this.tabs.length} tabs (got n=${a.n})`);
      return b;
    }
    throw new Error(`${what} needs n or id`);
  }

  /** The next (1) or previous (-1) tab into the preview, past the one on air, round the end. */
  stepTab(dir) {
    const others = this.tabs.filter((b) => b !== this.program);
    if (others.length < 2) return;
    const i = others.indexOf(this.preview);
    this.toPreview(others[(i + (dir < 0 ? -1 : 1) + others.length) % others.length]);
  }

  /** A tab closed (not the one on air). The preview's: the tab beside it takes its place, or a blank one. */
  closeTab(b) {
    if (b === this.program) throw new Error("that tab is on air: take another one first");
    if (b === this.preview) {
      const others = this.tabs.filter((x) => x !== this.program && x !== b);
      const i = this.tabs.indexOf(b);
      const next = others.find((x) => this.tabs.indexOf(x) > i) ?? others.at(-1);
      if (next) {
        this.preview = next;
        next.setRole('preview');
      } else {
        const n = this.make();
        this.tabs.splice(i + 1, 0, n);
        this.preview = n;
        n.setRole('preview');
        n.go(BLANK, { placeholder: true });
      }
    }
    this.removeTab(b);
    this.tabsChanged();
    this.o.onChange();
  }

  /** Out of the list and closed; remembered (unless blank) to open again. */
  removeTab(b, { remember = true } = {}) {
    this.tabs = this.tabs.filter((x) => x !== b);
    const n = remember && !b.isBlank() ? b.nav() : null;
    if (n?.url) {
      const entry = { url: n.url, title: n.title, zoom: n.zoom, scrollY: 0 };
      this.closedTabs = [entry, ...this.closedTabs].slice(0, CLOSED_MAX);
      b.scrollY()
        .then((y) => (entry.scrollY = y))
        .finally(() => b.close());
    } else b.close();
  }

  /** The tab closed last, open again (its page loaded again, scrolled to where it was). */
  reopenTab({ take } = {}) {
    const e = this.closedTabs.shift();
    if (!e) throw new Error('no closed tab to open again');
    this.openTab(e.url, { zoom: e.zoom, scrollY: e.scrollY, take });
  }

  /** A tab to place `to` (from 1), or by: left (-1) or right (1). */
  moveTab(b, { to, by }) {
    const from = this.tabs.indexOf(b);
    let at = to !== undefined && to !== '' ? Number(to) - 1 : from + Number(by || 0);
    if (!Number.isInteger(at)) throw new Error(`tab-move: to must be a number (got ${to})`);
    at = Math.max(0, Math.min(this.tabs.length - 1, at));
    this.tabs.splice(from, 1);
    this.tabs.splice(at, 0, b);
    this.o.onChange();
  }

  /** The number of tabs changed: past tabsWarn, say so (once each time it's passed). */
  tabsChanged() {
    const warn = this.o.tabsWarn ?? 8;
    if (warn > 0 && this.tabs.length > warn && !this.warned) {
      this.warned = true;
      this.o.onError(`${this.tabs.length} tabs open: each one holds its memory (a few hundred MB for a heavy site). Close the ones you don't need (×, or Cmd+W for the preview's).`);
    }
    if (this.tabs.length <= warn) this.warned = false;
  }

  /**
   * The first tabs: [{ url, zoom? }] (as sessionTabs gave them, or just one or two), with which is
   * the program and which the preview. The program stays black until its page has loaded.
   */
  start(list, programAt = 0, previewAt = 1) {
    const items = list.filter((t) => t?.url);
    while (items.length < 2) items.push({ url: BLANK, blank: true });
    if (!items[programAt]) programAt = 0;
    if (!items[previewAt] || previewAt === programAt) previewAt = programAt === 0 ? 1 : 0;
    this.tabs = items.map((t, i) => {
      const b = i === programAt ? this.program : i === previewAt ? this.preview : this.make();
      if (b !== this.program && b !== this.preview) b.setRole('tab');
      b.zoom = Number(t.zoom) > 0 ? Number(t.zoom) : 1;
      b.go(t.url, { placeholder: !!t.blank && t.url === BLANK });
      return b;
    });
    this.tabsChanged();
    this.adblock.update();
  }

  /** The tabs, to open again at the next start: [{ url, zoom }], and which are the program and the preview. */
  sessionTabs() {
    return {
      tabs: this.tabs.map((b) => {
        const n = b.nav();
        return { url: n?.url || BLANK, ...(n?.zoom && n.zoom !== 1 ? { zoom: n.zoom } : {}), ...(b.isBlank() ? { blank: true } : {}) };
      }),
      program: this.tabs.indexOf(this.program),
      preview: this.tabs.indexOf(this.preview),
    };
  }

  /** The tabs, for the status (their thumbnails go to the control window on their own). */
  tabList() {
    return this.tabs.map((b, i) => {
      const n = b.nav();
      return {
        n: i + 1,
        id: b.id,
        url: n?.url ?? '',
        title: n?.title ?? '',
        state: b === this.program ? 'program' : b === this.preview ? 'preview' : 'open',
        loading: !!n?.loading,
        error: n?.error?.message ?? null,
        blocked: b.alive() ? this.adblock.blockedIn(b.wc.id) : 0,
        // (Its picture's version: a new number each time there's a new one. 0: none yet.)
        picture: b.thumbVersion ?? 0,
      };
    });
  }

  // ---- On air --------------------------------------------------------------------------------------

  /** What's on air: live, loading (held while the program loads), frozen or black. */
  air() {
    if (this.blackOut) return 'black';
    if (this.frozen) return 'frozen';
    if (this.loadHold) return 'loading';
    return 'live';
  }

  /** The picture on air now, held (and shown small in the control window); null: black. */
  holdPicture(img) {
    this.heldImage = img ?? null;
    this.o.onProgram(img ? { kind: 'held', jpeg: img.resize({ width: PROGRAM_WIDTH, quality: 'good' }).toJPEG(80) } : { kind: 'black' });
  }

  /** The program's own page started going somewhere else: hold what's on air until it's loaded. */
  startLoadHold() {
    if (!this.loadHold) {
      this.loadHold = { at: Date.now() };
      if (!this.frozen && !this.blackOut) this.holdPicture(this.program.lastImage);
      // (The held picture out with the next frame: at start-up, black rather than nothing.)
      this.resend = true;
    } else this.loadHold.at = Date.now();
    this.armHoldMax();
  }

  armHoldMax() {
    clearTimeout(this.holdTimer);
    const max = this.o.holdMax;
    if (max > 0)
      this.holdTimer = setTimeout(() => {
        if (this.closed || !this.loadHold || this.program.loadError) return;
        this.o.onError(`the page on air took more than ${max} s to load: on air as it is`);
        this.endLoadHold();
      }, max * 1000);
  }

  endLoadHold() {
    clearTimeout(this.holdTimer);
    clearTimeout(this.settleTimer);
    if (!this.loadHold) return;
    this.loadHold = null;
    this.airChanged();
  }

  /** On air changed: the output gets the new picture now, and the control window is told. */
  airChanged() {
    if (this.closed) return;
    const air = this.air();
    if (air === 'live') {
      this.heldImage = null;
      this.o.onProgram(null);
    } else if (air === 'black') this.o.onProgram({ kind: 'black' });
    this.repaint();
    this.o.onChange();
  }

  /**
   * Take: the preview on air, and what was on air into the preview. Freeze and black end. A page
   * still loading (or that failed) is held until it's loaded (unless now, or hold is off): what was
   * on air stays on air till then.
   */
  take({ now = false } = {}) {
    const from = this.program;
    const to = this.preview;
    const was = this.air();
    const onAir = was === 'black' ? null : was === 'live' ? from.lastImage : this.heldImage;
    clearTimeout(this.holdTimer);
    clearTimeout(this.settleTimer);
    this.frozen = false;
    this.blackOut = false;
    this.loadHold = null;
    this.noHoldFor = now && to.loading ? to : null;
    this.program = to;
    this.preview = from;
    to.setRole('program', { fps: this.o.fps, muted: this.look.muted });
    from.setRole('preview');
    to.thumbAt = from.thumbAt = 0;
    to.thumbSettled = from.thumbSettled = false;
    // (The new preview's monitor: its picture now, even if the page doesn't change.)
    if (from.alive()) from.wc.invalidate();
    if (!now && this.look.hold && (to.loading || to.loadError)) {
      this.loadHold = { at: Date.now() };
      this.holdPicture(onAir);
      if (!to.loadError) this.armHoldMax();
      else this.o.onError(`took ${to.loadError.url}, which didn't load: the picture before is still on air (Show As Is to show the failure, or Take to go back)`);
    }
    this.airChanged();
  }

  /** The program on air as it is: not frozen, not held, not black. */
  live() {
    clearTimeout(this.holdTimer);
    clearTimeout(this.settleTimer);
    this.frozen = false;
    this.loadHold = null;
    this.blackOut = false;
    this.airChanged();
  }

  /** Freeze the picture on air (true), let it go (false), or the other way (undefined). */
  freeze(on) {
    const next = on === undefined ? !this.frozen : on;
    if (next === this.frozen) return;
    if (next && !this.loadHold && !this.blackOut) this.holdPicture(this.program.lastImage);
    this.frozen = next;
    this.airChanged();
  }

  /** Black on air (true), or not (false), or the other way. */
  black(on) {
    const next = on === undefined ? !this.blackOut : on;
    if (next === this.blackOut) return;
    this.blackOut = next;
    // (Back from black, still held: the held picture is the program as it is now.)
    if (!next && (this.frozen || this.loadHold)) this.holdPicture(this.program.lastImage);
    this.airChanged();
  }

  /** The look changed: scrollbars, muted (the program's sound), hold, autoTake. */
  set(look) {
    this.look = { ...this.look, ...look };
    if (this.program.alive()) this.program.wc.setAudioMuted(!!this.look.muted);
    if (!this.look.hold) this.endLoadHold();
    this.tabs.forEach((b) => b.applyLook());
    // (Ad blocking switched on: its lists loaded, if they aren't.)
    this.adblock.update();
  }

  /** The air, the preview and program, and the tabs. */
  nav() {
    if (this.closed) return null;
    return {
      air: { state: this.air(), frozen: this.frozen, black: this.blackOut, holding: !!this.loadHold, sameSite: this.sameSite() },
      preview: this.pageOf(this.preview),
      program: this.pageOf(this.program),
      tabs: this.tabList(),
      adblock: this.adblock.status(),
      tabsWarn: this.o.tabsWarn ?? 8,
      closedTabs: this.closedTabs.length,
      look: { ...this.look },
    };
  }
}
