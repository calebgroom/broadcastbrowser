// What the control window and the HTTP API (Bitfocus Companion) can do. Every command answers with
// the status after it. Arguments can be numbers and booleans, or the same as text (from a URL).
//
// Pages are tabs (graphic.js): one is the program (on air), one the preview (being worked on), the
// rest open in the background. Take swaps the preview and the program. Commands that act on a page
// act on the preview's unless target=program.
//
// Pages (take=true: on air once loaded; the look's autoTake without it)
//   go        { url, take?, zoom?, newTab? }   the preview's tab to a page (the address bar):
//                                       https://…, example.com, 10.0.0.5:8080, /path/file.html;
//                                       newTab: in a new tab instead
//   home      { take? }                 home, in a new tab (or the tab already on it)
//   favorite  { n } | { name } | { id }, take?   a favorite (n from 1; name: whole, else part), in a
//                                       new tab, or the tab already on it (not the one on air)
//
// Tabs (n from 1, in the tabs' order, or id)
//   tabs                                the list: [{ n, id, url, title, state, loading, error }];
//                                       state: program, preview or open
//   tab       { n } | { id }, take?     a tab into the preview (the one there goes to the background)
//   tab-next  { by? }                   the next (1) or previous (-1) tab into the preview
//   tab-new   { url?, take? }           a new tab into the preview (blank without url)
//   tab-close { n } | { id }            close a tab (not the one on air)
//   tab-reopen  { take? }               the tab closed last, open again (where it was scrolled to)
//   tab-move  { n|id, to? | by? }       to a place (from 1), or left (-1) / right (1)
//
// A page (target: preview, the default, or program)
//   back, forward     { target? }       through the page's history
//   reload    { target?, hard? }        the page again (hard: not from the cache). On air: held till it's loaded
//   stop      { target? }               stop loading
//   scroll    { target?, by? | screens?, smooth? }   px or screens (negative: up)
//   top       { target?, smooth? }      to the top of the page
//   zoom      { target?, factor? | by? | reset? }   a factor (1.5 or 150), a step up or down, or 100%
//   input     { target?, type, x, y, … }   mouse and keyboard (the control window's monitors: browser.js)
//
// On air
//   take      { now? }                  the preview on air, the program into the preview. A page still
//                                       loading is cut to once it has (now: at once)
//   live                                the program on air as it is: not frozen, held or black
//   freeze    { on? }                   hold the picture on air (the program page carries on)
//   black     { on? }                   black on air
//   outputs   { mode } | { ndi?, sdi?, syphon? } | { device } | { flip }   the video outputs: mode
//                                       both, ndi, sdi or off; each on, off or toggle; device: the
//                                       SDI port; flip: Syphon's picture upside down
//
// Settings
//   look      { scrollbars?, muted?, hold?, autoTake?, adblock?, annoyances? }   each true, false or
//                                       toggle; kept for next time (adblock: ads and trackers blocked;
//                                       annoyances: cookie banners and pop-ups hidden)
//             { thumbs }                how often the tabs' pictures are new (s): 1, 2, 5, 10, 30, or 0 (off)
//   adblock-allow  { target? | url?, on? }   ad blocking off on the page's site (the preview's,
//                                       the program's, or that address's), or on again (on: false),
//                                       or the other way; kept for next time
//   set-home  { url? | target? }        home: this address, or the preview's page (the program's: target=program)
//
// Updates
//   update-check                        look for a new version now (it downloads in the background;
//                                       it's installed from the control window, or as the app quits)
//
// Favorites
//   favorites                           the list: [{ n, id, name, url, zoom? }]
//   favorite-add     { name?, url?, zoom?, target? }   a new one (the preview's page, without url)
//   favorite-update  { n|name|id, name?/newName?, url?, zoom? }
//   favorite-remove  { n|name|id }
//   favorite-move    { n|name|id, to? | by? }   to a place (from 1), or up (-1) / down (1)

import { nativeImage } from 'electron';
import { OUTPUT_MODES, saveSetting } from './config.js';
import { findDeckLink, listDeckLinks } from './decklink.js';
import { normalizeUrl } from './favorites.js';
import { BLANK, THUMB_EVERY } from './graphic.js';
import { HEIGHT, WIDTH } from './ndi.js';

const number = (v, what) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
  if (!Number.isFinite(n)) throw new Error(`${what} must be a number (got ${v})`);
  return n;
};

/** true, false, or undefined for "the other way" (left out or toggle). */
function onOff(v, what) {
  if (v === undefined || v === null || v === '' || v === 'toggle') return undefined;
  if ([true, 'true', '1', 'on', 'yes', 1].includes(v)) return true;
  if ([false, 'false', '0', 'off', 'no', 0].includes(v)) return false;
  throw new Error(`${what} must be true, false or toggle (got ${v})`);
}

/** A zoom: 1.5 or 150 (both 150%), 0.25 to 5. */
function zoomFactor(v, what) {
  let f = number(v, what);
  if (f > 10) f /= 100;
  if (f < 0.25 || f > 5) throw new Error(`${what} must be 0.25 to 5, or 25 to 500 (got ${v})`);
  return f;
}

/** Commands that answer with what they found, not the status. */
export const LISTS = ['favorites', 'tabs'];

export class Commands {
  /**
   * @param {{ graphic: import('./graphic.js').Graphic, output: import('./ndi.js').Output, favorites: import('./favorites.js').Favorites,
   *   home: () => string, setHome: (url: string) => void, onFavorites: () => void }} o
   */
  constructor({ graphic, output, updater, favorites, home, setHome, onFavorites }) {
    this.graphic = graphic;
    this.output = output;
    this.updater = updater;
    this.favorites = favorites;
    this.home = home;
    this.setHome = setHome;
    this.onFavorites = onFavorites;
    this.errors = [];
  }

  error(e) {
    this.errors = [...this.errors.slice(-19), { at: new Date().toISOString(), message: e }];
  }

  /** The SDI port: auto (the first free one), a number from 1, or a device's name. */
  async setDeckDevice(device) {
    let setting = String(device ?? '').trim();
    // (Here 1 is the first port, not "on" as --decklink=1 is.)
    if (/^(auto|)$/i.test(setting)) setting = 'auto';
    else {
      const { devices, error } = listDeckLinks(this.output.deckConfig.mode);
      const d = findDeckLink(devices, setting);
      if (!d) throw new Error(`outputs: no DeckLink device "${setting}" (${devices.length ? `found ${devices.map((x) => `${x.number}: ${x.name}`).join(', ')}` : error})`);
      // (By name: the numbers can change when devices come and go.)
      setting = d.name;
    }
    await this.output.setDeckDevice(setting);
    const err = saveSetting('decklink', setting);
    if (err) this.error(err);
    if (this.output.want.sdi && this.output.deckError) this.error(`DeckLink: ${this.output.deckError}`);
    this.graphic.repaint();
  }

  async setOutputs(a) {
    const only = (...keys) => keys.every((k) => a[k] === undefined);
    if (a.device !== undefined) {
      await this.setDeckDevice(a.device);
      if (only('mode', 'ndi', 'sdi', 'syphon', 'flip')) return this.status();
    }
    if (a.flip !== undefined) {
      const on = onOff(a.flip, 'outputs: flip');
      const flip = on === undefined ? !this.output.syphonFlip : on;
      this.output.setSyphonFlip(flip);
      const err = saveSetting('syphon-flip', flip);
      if (err) this.error(err);
      if (only('mode', 'ndi', 'sdi', 'syphon')) return this.status();
    }
    const now = this.output.want;
    let want;
    if (a.mode !== undefined) {
      const mode = OUTPUT_MODES[String(a.mode)];
      if (!mode) throw new Error(`outputs: mode must be both, ndi, sdi or off (got ${a.mode})`);
      want = { ...now, ...mode };
    } else {
      const pick = (v, cur, what) => onOff(v, `outputs: ${what}`) ?? (v === 'toggle' ? !cur : cur);
      want = { ndi: pick(a.ndi, now.ndi, 'ndi'), sdi: pick(a.sdi, now.sdi, 'sdi'), syphon: pick(a.syphon, now.syphon, 'syphon') };
    }
    const was = { ...now };
    await this.output.setOutputs(want);
    // (One that failed to start: say why.)
    if (want.ndi && !was.ndi && this.output.ndiError) this.error(`NDI: ${this.output.ndiError}`);
    if (want.sdi && !was.sdi && this.output.deckError) this.error(`DeckLink: ${this.output.deckError}`);
    if (want.syphon && !was.syphon && !this.output.syphon) this.error(`Syphon: ${this.output.syphonError}`);
    // (Back on: the picture now, not at the next change.)
    this.graphic.repaint();
    return this.status();
  }

  /** The frame on the output now, as a PNG (null before the first one). */
  snapshot() {
    const f = this.output.current();
    return f ? nativeImage.createFromBitmap(f, { width: WIDTH, height: HEIGHT }).toPNG() : null;
  }

  status() {
    return {
      ...this.graphic.nav(),
      home: this.home(),
      favorites: this.favorites.list(),
      output: { ...this.output.status(), paintMs: this.graphic.paintMs },
      update: this.updater?.status() ?? null,
      errors: this.errors,
    };
  }

  /** The look, changed and kept in the settings file for next time. */
  look(next) {
    this.graphic.set(next);
    const err = saveSetting('look', this.graphic.look);
    if (err) this.error(err);
  }

  /**
   * A tab's picture for the API's /tab-picture (n or id; width and height, in pixels, 8 to 640:
   * 72 × 40 if left out): a PNG, or null if it has none yet. Throws for no such tab.
   */
  tabPicture(a = {}) {
    const size = (v, def, what) => {
      if (v === undefined || v === '') return def;
      const n = Math.round(number(v, `tab-picture: ${what}`));
      if (n < 8 || n > 640) throw new Error(`tab-picture: ${what} must be 8 to 640 pixels (got ${v})`);
      return n;
    };
    const b = this.graphic.findTab(a, 'tab-picture');
    return this.graphic.tabPicture(b, size(a.width, 72, 'width'), size(a.height, 40, 'height'));
  }

  /** Runs one command; throws an Error with a message for the operator on bad input. */
  async run(name, a = {}) {
    const g = this.graphic;
    const fav = this.favorites;
    const take = () => onOff(a.take, `${name}: take`);
    const page = () => g.target(a.target);
    const smooth = () => onOff(a.smooth, `${name}: smooth`) !== false;
    const favoritesChanged = () => {
      this.onFavorites();
      return this.status();
    };
    switch (name) {
      case 'outputs':
        return this.setOutputs(a);
      case 'go':
        g.load(normalizeUrl(a.url), {
          take: take(),
          zoom: a.zoom !== undefined && a.zoom !== '' ? zoomFactor(a.zoom, 'go: zoom') : undefined,
          newTab: onOff(a.newTab ?? a.newtab ?? a['new-tab'], 'go: newTab') === true,
        });
        break;
      case 'home':
        g.openFavorite(this.home(), { take: take() });
        break;
      case 'favorite': {
        const f = fav.find(a);
        g.openFavorite(f.url, { take: take(), zoom: f.zoom });
        break;
      }
      case 'update-check':
        this.updater?.check();
        break;
      case 'tabs':
        return { tabs: g.tabList() };
      case 'tab': {
        const b = g.findTab(a);
        const t = take() ?? false;
        // (The tab on air, to air: nothing to do.)
        if (!(t && b === g.program)) g.toPreview(b);
        if (t && b !== g.program) g.take();
        break;
      }
      case 'tab-next':
        g.stepTab(a.by !== undefined && a.by !== '' ? number(a.by, 'tab-next: by') : 1);
        break;
      case 'tab-new':
        g.openTab(a.url ? normalizeUrl(a.url) : BLANK, { take: a.url ? take() : false, placeholder: !a.url });
        break;
      case 'tab-close':
        g.closeTab(a.n === undefined && a.id === undefined ? g.preview : g.findTab(a, 'tab-close'));
        break;
      case 'tab-reopen':
        g.reopenTab({ take: take() });
        break;
      case 'tab-move':
        g.moveTab(g.findTab(a, 'tab-move'), a);
        break;
      case 'back':
        page().back();
        break;
      case 'forward':
        page().forward();
        break;
      case 'reload':
        page().reload(onOff(a.hard, 'reload: hard') === true);
        break;
      case 'stop':
        page().stop();
        break;
      case 'scroll': {
        const b = page();
        if (a.screens !== undefined && a.screens !== '') await b.scrollBy(number(a.screens, 'scroll: screens') * (HEIGHT - 120), smooth());
        else await b.scrollBy(number(a.by ?? 200, 'scroll: by'), smooth());
        break;
      }
      case 'top':
        await page().scrollToTop(smooth());
        break;
      case 'zoom': {
        const b = page();
        if (a.reset !== undefined && onOff(a.reset, 'zoom: reset') !== false) g.setZoom(b, { factor: 1 });
        else if (a.by !== undefined && a.by !== '') g.setZoom(b, { by: Math.sign(number(a.by, 'zoom: by')) });
        else if (a.factor !== undefined && a.factor !== '') g.setZoom(b, { factor: zoomFactor(a.factor, 'zoom: factor') });
        else throw new Error('zoom needs factor, by or reset');
        break;
      }
      case 'input':
        page().input(a);
        return null;
      case 'take':
        g.take({ now: onOff(a.now, 'take: now') === true });
        break;
      case 'live':
        g.live();
        break;
      case 'freeze':
        g.freeze(onOff(a.on, 'freeze: on'));
        break;
      case 'black':
        g.black(onOff(a.on, 'black: on'));
        break;
      case 'look': {
        const next = {};
        const was = { adblock: g.look.adblock, annoyances: g.look.annoyances };
        for (const k of ['scrollbars', 'muted', 'hold', 'autoTake', 'adblock', 'annoyances']) {
          // (autotake, auto-take or autoTake.)
          const v = a[k] ?? (k === 'autoTake' ? (a.autotake ?? a['auto-take']) : undefined);
          if (v === undefined) continue;
          const on = onOff(v, `look: ${k}`);
          next[k] = on === undefined ? !g.look[k] : on;
        }
        if (a.thumbs !== undefined && a.thumbs !== '') {
          const v = /^off$/i.test(String(a.thumbs)) ? 0 : number(a.thumbs, 'look: thumbs');
          if (!THUMB_EVERY.includes(v)) throw new Error(`look: thumbs must be ${THUMB_EVERY.join(', ')} seconds (0: off) (got ${a.thumbs})`);
          next.thumbs = v;
        }
        this.look(next);
        // (Blocking switched on or off: it applies to pages as they load. Said once, in Messages.)
        if (g.look.adblock !== was.adblock || g.look.annoyances !== was.annoyances)
          this.error(`ad blocking: ${g.look.adblock ? 'ads and trackers blocked' : 'ads not blocked'}, ${g.look.annoyances ? 'cookie banners hidden' : 'cookie banners not hidden'}. It applies to pages as they load: ⟳ the preview to apply it there.`);
        break;
      }
      case 'adblock-allow': {
        const url = a.url ? normalizeUrl(a.url) : page().nav()?.url;
        if (!url) throw new Error('adblock-allow: no page');
        const r = g.adblock.setAllowed(url, onOff(a.on, 'adblock-allow: on'));
        this.error(`ad blocking: ${r.site} ${r.allowed ? 'allowed (not blocked)' : 'blocked again'}, from its next page load`);
        break;
      }
      case 'signout': {
        // Every site (all=true), or one: the preview's (target=program: the page on air's), or url's.
        if (onOff(a.all, 'signout: all') === true) {
          await g.signOut();
          this.error('signed out of every site: every cookie, sign-in and stored datum, and the cache, gone. Pages already open keep what they show until they’re loaded again (⟳)');
          break;
        }
        const url = a.url ? normalizeUrl(a.url) : page().nav()?.url;
        if (!url) throw new Error('signout: no page');
        const r = await g.signOut({ url });
        this.error(`signed out of ${r.site}: ${r.cookies} ${r.cookies === 1 ? 'cookie' : 'cookies'} and its stored data gone. A page already open keeps what it shows until it’s loaded again (⟳)`);
        break;
      }
      case 'set-home': {
        const url = a.url ? normalizeUrl(a.url) : page().nav()?.url;
        if (!url) throw new Error('set-home: no page shown');
        this.setHome(url);
        break;
      }
      case 'favorites':
        return { favorites: fav.list() };
      case 'favorite-add': {
        const b = page();
        const p = b.nav();
        const url = a.url || p?.url;
        if (!url) throw new Error('favorite-add: no page shown, and no url');
        fav.add({ name: a.name || (a.url ? '' : p?.title) || url, url, zoom: a.zoom ?? (a.url ? undefined : b.zoomNow()) });
        return favoritesChanged();
      }
      case 'favorite-update':
        fav.update(fav.find(a, 'favorite-update'), { name: a.newName ?? (a.id || a.n ? a.name : undefined), url: a.url, zoom: a.zoom });
        return favoritesChanged();
      case 'favorite-remove':
        fav.remove(fav.find(a, 'favorite-remove'));
        return favoritesChanged();
      case 'favorite-move':
        fav.move(fav.find(a, 'favorite-move'), a);
        return favoritesChanged();
      default:
        throw new Error(`no command "${name}"`);
    }
    return this.status();
  }
}
