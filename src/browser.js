// One tab: a web page in an offscreen window, 1920×1080 at 1× (whatever the screen). One tab is the
// program (on air), one the preview (where pages are checked and worked on), and the rest are open
// in the background (graphic.js). A take swaps the preview and the program. This is the page itself: loading, history, scrolling, zoom, the operator's mouse and
// keyboard, and its frames, which go to graphic.js (the program's to the output) and, smaller, as
// JPEGs to the control window's monitors.
//
// A tab in the background keeps running (a scoreboard stays current), drawing a frame a second for
// its card's thumbnail, its video and sound paused till it's brought back.
//
// The pages run in a session of their own ("persist:broadcast", graphic.js: cookies and logins
// kept between starts and shared by both browsers, so a login in the preview is still there once
// it's taken), sandboxed, with no access to the app. Pop-ups open in the same window; alert(),
// confirm() and prompt() are answered without showing anything; a page can't ask "leave this page?".

import { BrowserWindow } from 'electron';
import { localFileProblem } from './favorites.js';
import { HEIGHT, WIDTH } from './ndi.js';

/** A monitor's width in the control window (px). */
const MONITOR_WIDTH = 960;
/**
 * A monitor gets every frame while copying the frame (for the output) and making the monitor's
 * JPEG take no more than this share of a frame's time on the app's main thread; otherwise every
 * 2nd, 3rd or 4th frame, so the output always comes first. The program's share, and the preview's
 * (two monitors share the main thread with the output).
 */
const MONITOR_BUDGET = { program: 0.35, preview: 0.2, tab: 0.05 };
const MONITOR_MAX_EVERY = 4;
/** The preview draws at most this many frames a second (it isn't on air: half the work). */
export const PREVIEW_FPS = 30;
/** A tab in the background: a frame a second, for its thumbnail. */
export const TAB_FPS = 1;

const HIDE_SCROLLBARS = '::-webkit-scrollbar { display: none !important; } html, body { scrollbar-width: none !important; }';

export class Browser {
  /**
   * @param {{ id: string, partition: string,
   *   onPaint: (b: Browser, img: Electron.NativeImage) => void,
   *   onMonitor: (b: Browser, jpeg: Buffer) => void,
   *   onEvent: (b: Browser, kind: 'start' | 'stop' | 'fail' | 'navigated' | 'changed') => void,
   *   onOpen: (b: Browser, url: string) => void,
   *   look: () => { scrollbars: boolean },
   *   onError: (e: string) => void }} o
   */
  constructor(o) {
    this.o = o;
    this.id = o.id;
    /** 'program' or 'preview' (graphic.js sets it). */
    this.role = 'preview';
    this.fps = PREVIEW_FPS;
    /** The zoom this browser's page should be at (a site has one zoom across both browsers: graphic.js). */
    this.zoom = 1;
    this.title = '';
    this.loading = false;
    /** The page's last failure to load (cleared by the next load). */
    this.loadError = null;
    /** The last frame the page painted (a NativeImage). */
    this.lastImage = null;
    this.paintMs = 0;
    this.monitorEvery = 1;
    this.closed = false;
    /** Whether the operator has done anything in its page (clicked, scrolled…): a blank tab that's been touched isn't reused. */
    this.touched = false;
    /**
     * An empty tab, made only to have something there (a new tab, the one that takes a closed
     * preview's place): used for the next page opened, and closed rather than kept when another
     * tab takes its place in the preview. Not a page opened on purpose, even if it's the same black
     * page (the Black favorite is a tab like any other).
     */
    this.placeholder = false;
    /** Where to scroll to once the page has loaded (a closed tab, opened again). */
    this.restoreScroll = null;
    /** Its media was paused when it went to the background (to play again when it comes back). */
    this.paused = false;

    this.win = new BrowserWindow({
      show: false,
      width: WIDTH,
      height: HEIGHT,
      // (Windows are normally kept to the screen's size: 1920×1080 on a smaller display too.)
      enableLargerThanScreen: true,
      webPreferences: {
        partition: o.partition,
        offscreen: { deviceScaleFactor: 1 },
        backgroundThrottling: false,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // (A video page plays without a click.)
        autoplayPolicy: 'no-user-gesture-required',
        spellcheck: false,
      },
    });
    this.win.setContentSize(WIDTH, HEIGHT);
    this.wc = this.win.webContents;
    this.wc.setFrameRate(this.fps);
    this.wc.setAudioMuted(true);
    this.watchFrames();
    this.watchNavigation();
  }

  /** Whether the browser is still there (not closed, or closing, as the app quits). */
  alive() {
    return !this.closed && !this.win.isDestroyed() && !this.wc.isDestroyed();
  }

  /**
   * A handler for one of the page's events, called only while the browser is alive: as the app
   * quits, the page fires events (loading, its title) while it's taken down, after the control
   * window has gone.
   */
  on(event, fn) {
    this.wc.on(event, (...args) => {
      if (this.alive()) fn(...args);
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.statsTimer);
    clearTimeout(this.skippedTimer);
    if (!this.win.isDestroyed()) this.win.destroy();
  }

  /**
   * program (on air: the output's frame rate, and sound unless muted), preview (half the rate,
   * muted) or tab (in the background: a frame a second for its thumbnail, its media paused).
   */
  setRole(role, { fps, muted } = {}) {
    const was = this.role;
    this.role = role;
    this.fps = role === 'program' ? Math.ceil(Number(fps)) : role === 'preview' ? PREVIEW_FPS : TAB_FPS;
    if (!this.alive()) return;
    this.wc.setFrameRate(this.fps);
    this.wc.setAudioMuted(role !== 'program' || !!muted);
    this.monitorEvery = 1;
    if (role === 'tab' && was !== 'tab') this.pauseMedia();
    if (role !== 'tab' && was === 'tab') this.resumeMedia();
  }

  /** The page's frames: to graphic.js (the output), and to the control window's monitor. */
  watchFrames() {
    let spent = 0;
    let n = 0;
    this.statsTimer = setInterval(() => {
      this.paintMs = n ? Math.round((spent / n) * 10) / 10 : 0;
      spent = n = 0;
    }, 1000);
    this.statsTimer.unref?.();
    // (Running averages, ms: what graphic.js does with a frame, and making the monitor's JPEG.)
    let outMs = 0;
    let monitorMs = 0;
    let sinceMonitor = Infinity;
    // (A frame the monitor skipped: shown once the page goes quiet, so the monitor always ends up
    // on the page as it is.)
    let skipped = null;
    let warned = false;
    const monitor = (img) => this.o.onMonitor(this, img.resize({ width: MONITOR_WIDTH, quality: 'good' }).toJPEG(80));
    this.on('paint', (_e, _dirty, image) => {
      const t0 = performance.now();
      let img = image;
      const size = img.getSize();
      // (An empty frame: Chromium sends one now and then, as a tab starts up or before it has a
      // page. Nothing to show, or to send out: the frame before stands.)
      if (img.isEmpty() || !size.width || !size.height) return;
      if (size.width !== WIDTH || size.height !== HEIGHT) {
        // (It shouldn't be; scaling every frame is slow, so say so.)
        if (!warned) this.o.onError(`browser: the page renders at ${size.width}×${size.height}, not ${WIDTH}×${HEIGHT}; scaling every frame (slow)`);
        warned = true;
        img = img.resize({ width: WIDTH, height: HEIGHT });
      }
      this.lastImage = img;
      this.o.onPaint(this, img);
      const t1 = performance.now();
      outMs += (t1 - t0 - outMs) * 0.1;
      // (In the background: no monitor, only the thumbnail graphic.js makes from the frame.)
      if (this.role === 'tab') return;
      clearTimeout(this.skippedTimer);
      const frameMs = 1000 / this.fps;
      if (++sinceMonitor < this.monitorEvery) {
        skipped = img;
        this.skippedTimer = setTimeout(() => {
          if (skipped && this.alive()) monitor(skipped);
          skipped = null;
        }, 2 * frameMs);
      } else {
        skipped = null;
        sinceMonitor = 0;
        monitor(img);
        monitorMs += (performance.now() - t1 - monitorMs) * 0.1;
        const budget = frameMs * MONITOR_BUDGET[this.role];
        this.monitorEvery = outMs + monitorMs <= budget ? 1 : Math.min(MONITOR_MAX_EVERY, Math.ceil(monitorMs / Math.max(0.5, budget - outMs)));
      }
      spent += performance.now() - t0;
      n++;
    });
  }

  watchNavigation() {
    const o = this.o;
    const wc = this.wc;
    const event = (kind) => o.onEvent(this, kind);
    this.on('did-start-navigation', (details, _url, isInPlace, isMainFrame) => {
      // (Electron passes the details as an object, and as arguments too.)
      const main = details?.isMainFrame ?? isMainFrame;
      const inPlace = details?.isSameDocument ?? isInPlace;
      if (!main || inPlace) return;
      this.loadError = null;
      this.loading = true;
      event('start');
    });
    this.on('did-start-loading', () => {
      this.loading = true;
      event('changed');
    });
    this.on('did-stop-loading', () => {
      this.loading = false;
      if (this.restoreScroll !== null && !this.loadError) {
        const y = this.restoreScroll;
        this.restoreScroll = null;
        this.script(`window.scrollTo({ top: ${Number(y)}, behavior: 'instant' }); 0`);
      }
      event('stop');
    });
    this.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      // (-3: aborted, as when another page was asked for before this one had loaded.)
      if (!isMainFrame || code === -3) return;
      this.loadError = { url, code, message: desc };
      event('fail');
    });
    this.on('did-navigate', () => {
      this.title = '';
      this.applyLook();
      event('navigated');
    });
    this.on('did-navigate-in-page', (_e, _url, isMainFrame) => isMainFrame && event('changed'));
    this.on('page-title-updated', (_e, title) => {
      this.title = title;
      event('changed');
    });
    this.on('dom-ready', () => {
      this.applyLook();
      // (A dialog would wait for an answer nobody can give: answered at once instead.)
      wc.executeJavaScript('window.alert = () => {}; window.confirm = () => true; window.prompt = () => null; 0', false).catch(() => {});
    });
    // (A local page's links and frames: only to other web pages on the disk. favorites.js, localFileProblem.)
    this.on('will-frame-navigate', (e) => {
      const problem = localFileProblem(e.url);
      if (!problem) return;
      e.preventDefault();
      o.onError(`${this.role}: ${problem}`);
    });
    // (Pop-ups and new tabs: the same window.)
    wc.setWindowOpenHandler(({ url }) => {
      if (/^(https?|app):/i.test(url)) o.onOpen(this, url);
      return { action: 'deny' };
    });
    // ("Leave this page?": leave.)
    this.on('will-prevent-unload', (e) => e.preventDefault());
    this.on('render-process-gone', (_e, d) => {
      o.onError(`${this.role}: the page stopped (${d.reason}); reloading it`);
      wc.reload();
    });
    this.on('unresponsive', () => o.onError(`${this.role}: the page isn’t responding`));
  }

  /** Scrollbars hidden (unless the look shows them), after each load. Zoom: graphic.js. */
  applyLook() {
    if (!this.alive()) return;
    const wc = this.wc;
    if (this.scrollbarCss) wc.removeInsertedCSS(this.scrollbarCss).catch(() => {});
    this.scrollbarCss = null;
    if (!this.o.look().scrollbars)
      wc.insertCSS(HIDE_SCROLLBARS, { cssOrigin: 'user' })
        .then((key) => (this.scrollbarCss = key))
        .catch(() => {});
  }

  /** The zoom the page is at now (shared with any page from the same site). */
  zoomNow() {
    return this.alive() ? this.wc.getZoomFactor() : this.zoom;
  }

  setZoomNow(z) {
    if (this.alive() && Math.abs(this.wc.getZoomFactor() - z) > 1e-6) this.wc.setZoomFactor(z);
  }

  /** The page's site (host), to tell whether two pages share a zoom. */
  host() {
    try {
      return new URL(this.wc.getURL()).host.toLowerCase();
    } catch {
      return '';
    }
  }

  /** Marks the page as loading straight away (before Chromium says so), so a take right after sees it. */
  starting() {
    this.loading = true;
    this.loadError = null;
  }

  /**
   * A page. Doesn't wait for it to load (a Companion button would wait with it): the status says
   * how it's going (loading, error). scrollY: where to scroll to once it has. placeholder: an empty
   * tab (see above); any other page makes it a tab like any other.
   */
  go(url, { scrollY = null, placeholder = false } = {}) {
    this.starting();
    this.touched = false;
    this.placeholder = placeholder;
    this.restoreScroll = scrollY;
    // (A saved favorite or tab, from before, can name any file: checked here too, as every load is.)
    const problem = localFileProblem(url);
    if (problem) {
      this.o.onError(`${this.role}: ${problem}`);
      url = 'about:blank';
    }
    this.wc.loadURL(url).catch(() => {});
  }

  /** Into the background: the page's video and sound paused (and which were playing remembered). */
  pauseMedia() {
    clearTimeout(this.skippedTimer);
    this.paused = true;
    this.script("window.__bbPlaying = [...document.querySelectorAll('video, audio')].filter((m) => !m.paused); window.__bbPlaying.forEach((m) => m.pause()); 0");
  }

  /** Out of the background: the media that was playing playing again, and the page drawn now (for its monitor). */
  resumeMedia() {
    if (this.paused) this.script('(window.__bbPlaying || []).forEach((m) => m.play().catch(() => {})); window.__bbPlaying = []; 0');
    this.paused = false;
    this.wc.invalidate();
  }

  /** Whether the tab has nothing worth keeping: a placeholder, untouched (opening a page uses it). */
  isBlank() {
    return this.alive() && this.placeholder && !this.touched;
  }

  /** How far down the page is scrolled (px), to load it again there. */
  async scrollY() {
    const y = await this.script('window.scrollY');
    return Number.isFinite(y) ? y : 0;
  }

  back() {
    this.touched = true;
    const h = this.wc.navigationHistory;
    if (!h.canGoBack()) throw new Error(`back: nothing to go back to in the ${this.role}`);
    this.starting();
    h.goBack();
  }

  forward() {
    this.touched = true;
    const h = this.wc.navigationHistory;
    if (!h.canGoForward()) throw new Error(`forward: nothing to go forward to in the ${this.role}`);
    this.starting();
    h.goForward();
  }

  reload(hard) {
    this.starting();
    if (hard) this.wc.reloadIgnoringCache();
    else this.wc.reload();
  }

  stop() {
    this.wc.stop();
  }

  /** Runs a script in the page (scrolling); null if it can't. */
  async script(js) {
    try {
      return await this.wc.executeJavaScript(js, false);
    } catch {
      return null;
    }
  }

  /** Scrolls the page: by px (negative: up), smoothly unless smooth is false. */
  scrollBy(px, smooth = true) {
    this.touched = true;
    return this.script(`window.scrollBy({ top: ${Number(px)}, behavior: '${smooth ? 'smooth' : 'instant'}' }); 0`);
  }

  scrollToTop(smooth = true) {
    this.touched = true;
    return this.script(`window.scrollTo({ top: 0, behavior: '${smooth ? 'smooth' : 'instant'}' }); 0`);
  }

  /**
   * Mouse and keyboard from the control window's monitor, into the page: { type: 'click' | 'move' |
   * 'down' | 'up' | 'wheel' | 'key', x, y (in the page's 1920×1080), button, clickCount, dx, dy, key,
   * text, modifiers }.
   */
  input(e) {
    const wc = this.wc;
    const x = Math.round(Number(e.x) || 0);
    const y = Math.round(Number(e.y) || 0);
    const modifiers = Array.isArray(e.modifiers) ? e.modifiers : [];
    const button = ['left', 'middle', 'right'].includes(e.button) ? e.button : 'left';
    if (e.type !== 'move') this.touched = true;
    const mouse = (type) => wc.sendInputEvent({ type, x, y, button, modifiers, clickCount: Number(e.clickCount) || 1 });
    switch (e.type) {
      case 'move':
        return mouse('mouseMove');
      case 'down':
        wc.focus();
        return mouse('mouseDown');
      case 'up':
        return mouse('mouseUp');
      case 'click':
        wc.focus();
        mouse('mouseDown');
        return mouse('mouseUp');
      case 'wheel':
        // (Electron's wheel deltas go the other way from the DOM's.)
        return wc.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: -Number(e.dx || 0), deltaY: -Number(e.dy || 0), canScroll: true, modifiers });
      case 'key': {
        const keyCode = String(e.key ?? '');
        if (!keyCode) return;
        wc.focus();
        wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
        // (A character typed: its text too.)
        if (e.text) wc.sendInputEvent({ type: 'char', keyCode: String(e.text), modifiers });
        return wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
      }
      default:
        throw new Error(`input: no type "${e.type}"`);
    }
  }

  /** The page as it is now (PNG). */
  async capture() {
    if (!this.alive()) return null;
    const img = await this.wc.capturePage();
    return img.isEmpty() ? null : img.toPNG();
  }

  /** Where the browser is. */
  nav() {
    if (!this.alive()) return null;
    const wc = this.wc;
    const h = wc.navigationHistory;
    return {
      url: wc.getURL(),
      title: this.title || wc.getTitle(),
      loading: this.loading,
      canGoBack: h.canGoBack(),
      canGoForward: h.canGoForward(),
      error: this.loadError,
      zoom: Math.round(this.zoomNow() * 100) / 100,
      id: this.id,
    };
  }
}
