// The control window, as a vision mixer's: two monitors, the preview and the program (on air).
//
//  - Pages load into the preview: the address bar (Cmd+L), ◀ ▶ ⟳ ⌂, and the favorites (left: click,
//    or Cmd+Option+1…9). Check it there, click through it with Interact, scroll it to the right place.
//  - TAKE (Cmd+Return) puts the preview on air, and what was on air into the preview. A page still
//    loading goes on air once it has (the picture before stays on air till then).
//  - Shift-click a favorite (Control+Option+Cmd+1…9), or Shift+Enter in the address bar: straight to air,
//    once it's loaded. Auto take: every page does that.
//  - Open Tabs (under the monitors): every page open, each a tab of its own, with a picture of it
//    (every couple of seconds). Click one: into the preview, just as it was (the tab there goes back
//    to the background). Shift-click: on air. ×: close (Cmd+W: the preview's; Cmd+Shift+T: open the
//    last closed again). A favorite opens a new tab, or the tab already on it.
//  - The program's monitor shows its page; while what's on air isn't that page (frozen, held while
//    it loads, black), what's on air is shown small in its corner.
//
// The app holds everything; this window sends commands (window.playout, src/preload.cjs) and shows
// the status that comes back.

const $ = (id) => document.getElementById(id);
import { wireInteractOn } from './interact.js';

const api = window.playout;

let status = null;

async function command(name, args) {
  const r = await api.command(name, args);
  if (!r.ok) addLocalError(r.error);
  else if (r.status && r.status.air) showStatus(r.status);
  return r;
}

// ---- Messages ------------------------------------------------------------------------------------

const localErrors = [];
function addLocalError(message) {
  localErrors.push({ at: new Date().toISOString(), message });
  if (localErrors.length > 20) localErrors.shift();
  renderErrors();
}

let shownErrors = '';
let shownLast = null;
function renderErrors() {
  const list = [...(status?.errors ?? []), ...localErrors].sort((a, b) => a.at.localeCompare(b.at)).slice(-20);
  const key = JSON.stringify(list);
  if (key === shownErrors) return;
  // (A new message: the list opens by itself.)
  const last = list.at(-1)?.at ?? null;
  const grew = last !== null && last !== shownLast;
  shownErrors = key;
  shownLast = last;
  $('error-count').textContent = list.length ? `(${list.length})` : '';
  $('errors').replaceChildren(
    ...list.reverse().map((e) => {
      const li = document.createElement('li');
      li.textContent = `${e.at.slice(11, 19)}  ${e.message}`;
      return li;
    }),
  );
  if (grew) $('errors-box').open = true;
}

// ---- The outputs ------------------------------------------------------------------------------------

const RATES = [
  ['sentPerS', 'sent/s', 5],
  ['paintsPerS', 'drawn/s', 3],
  ['paintMs', 'ms/frame', 4],
];
const rateSlots = {};
function showRates(out) {
  const box = $('rates');
  if (!box.childElementCount)
    for (const [key, label, width] of RATES) {
      const span = document.createElement('span');
      const b = document.createElement('b');
      b.style.display = 'inline-block';
      b.style.minWidth = `${width}ch`;
      b.style.textAlign = 'right';
      span.append(b, ` ${label}  `);
      box.append(span);
      rateSlots[key] = { b };
    }
  for (const [key] of RATES) {
    const v = out[key] ?? 0;
    const text = key === 'paintMs' ? v.toFixed(1) : String(v);
    if (rateSlots[key].b.textContent !== text) rateSlots[key].b.textContent = text;
  }
}

/**
 * A feed's outputs (out: the status's output, the program's, or previewOutput), on its monitor's
 * switches (pre: pg or pv). Short labels there; all the detail on hover.
 */
function showOutputs(out, pre, feed) {
  if (!out) return;
  const o = out.outputs;
  const Feed = feed === 'program' ? 'Program' : 'Preview';
  const pill = (el, on, state, text, title) => {
    el.className = `pill switch small ${on ? state : 'idle'}`;
    el.setAttribute('aria-pressed', String(on));
    const t = el.querySelector('.text');
    if (t.textContent !== text) t.textContent = text;
    el.title = `${title}\nClick to turn it ${on ? 'off' : 'on'} (also the Output menu).`;
  };
  const rx = (n) => `${n} ${n === 1 ? 'receiver' : 'receivers'}`;
  pill(
    $(`${pre}-ndi`),
    o.ndi,
    !out.ndi ? 'off' : out.tally.program ? 'program' : out.tally.preview ? 'preview' : 'ok',
    !o.ndi || !out.ndi ? 'NDI' : `NDI · ${out.connections}`,
    !o.ndi
      ? `${Feed} feed, NDI: off. Its source: "${out.name}".`
      : out.ndi
        ? `${Feed} feed, NDI: ${out.name}, ${rx(out.connections)}${out.tally.program ? ', on a switcher’s program' : out.tally.preview ? ', on a switcher’s preview' : ''}.`
        : `${Feed} feed, NDI: not working: ${out.error}`,
  );
  const dl = out.decklink;
  const trouble = !dl.on || !!dl.error || dl.late > 0 || dl.dropped > 0;
  // (The port: as it's open, or as it's set: a number, a device's name (its port in brackets), or the first free one.)
  const set = !dl.device || dl.device === 'auto' ? '' : (/\((\d+)\)\s*$/.exec(dl.device)?.[1] ?? dl.device);
  const port = dl.on && dl.number ? String(dl.number) : set;
  pill(
    $(`${pre}-sdi`),
    o.sdi,
    trouble ? 'off' : 'ok',
    `SDI${port ? ` · ${port}` : ''}`,
    (!o.sdi
      ? `${Feed} feed, SDI (DeckLink): off. It'll use ${dl.mode ?? 'the mode at this frame rate'}.`
      : !dl.on
        ? `${Feed} feed, SDI (DeckLink): not working: ${dl.error}`
        : `${Feed} feed, SDI (DeckLink): ${dl.name}, ${dl.mode}${dl.error ? ` · ${dl.error}` : ''} · ${dl.buffered} buffered · per second: ${dl.late} late, ${dl.dropped} dropped, ${dl.repeats} repeated`) +
      `\nPort: ${!dl.device || dl.device === 'auto' ? 'the first free one' : dl.device} (Output → ${Feed} → SDI Port).`,
  );
  // (Syphon: macOS only, so no switch elsewhere.)
  const sy = out.syphon;
  $(`${pre}-syphon`).hidden = !sy?.available;
  if (sy?.available)
    pill(
      $(`${pre}-syphon`),
      o.syphon,
      !sy.on ? 'off' : 'ok',
      'Syphon',
      (!o.syphon
        ? `${Feed} feed, Syphon (apps on this Mac: OBS, Resolume, QLab…): off. Its server: "${sy.name}".`
        : !sy.on
          ? `${Feed} feed, Syphon: not working: ${sy.error}`
          : `${Feed} feed, Syphon: "${sy.name}". ${sy.watched ? 'An app is watching it.' : 'No app is watching it (it costs nothing until one does).'}${sy.flip ? ' Flipped.' : ''}`) +
        `\nUpside down in an app? Output → Flip Syphon Picture.`,
    );
}

/**
 * No output on, of either feed: the header says so (in place of the rates, which count nothing
 * then). Until an output has ever been on (the first start), the program's switches are outlined too.
 */
function showNoOutputs(s) {
  const any = [s.output?.outputs, s.previewOutput?.outputs].some((o) => o && (o.ndi || o.sdi || o.syphon));
  $('no-outputs').hidden = any;
  $('rates').hidden = !any;
  $('pg-ndi').parentElement.classList.toggle('guide', !any && !s.outputsSeen);
}

// ---- The two pages and what's on air --------------------------------------------------------------

const AIR = {
  live: ['ON AIR', 'The program page is on air.'],
  frozen: ['FROZEN', 'The picture on air is held (bottom right); the program page carries on here. Freeze again, or Take, to end it.'],
  loading: ['HOLDING · LOADING', 'The picture before stays on air (bottom right) until this page has loaded. Show as is: show it now.'],
  black: ['BLACK', 'Black on air. Black again, or Take, to end it.'],
};

const sameUrl = (a, b) => !!a && !!b && a.replace(/\/$/, '') === b.replace(/\/$/, '');
const pct = (z) => `${Math.round((z ?? 1) * 100)}%`;
const setText = (el, text) => {
  if (el.textContent !== text) el.textContent = text;
};

/** One monitor's title, loading bar, error and zoom. */
function showMonitor(prefix, p, role) {
  if (!p) return;
  setText($(`${prefix}-title`), p.title || p.url);
  $(`${prefix}-title`).title = p.url;
  $(`${prefix}-load`).hidden = !p.loading;
  const err = $(`${prefix}-error`);
  err.hidden = !p.error;
  if (p.error) setText(err, `Couldn't load ${p.error.url}: ${p.error.message}`);
  setText(document.querySelector(`.monitor[data-role="${role}"] .zoom`), pct(p.zoom));
  // (Ad blocking: what it's blocked on this page, and its site allowed or not.)
  const ab = status?.adblock;
  const on = !!(ab && (ab.ads.on || ab.annoyances.on));
  const web = /^https?:/i.test(p.url ?? '');
  const count = $(`${prefix}-blocked`);
  count.hidden = !on || !web;
  setText(count, p.adsAllowed ? 'ads allowed here' : `${p.blocked ?? 0} blocked`);
  count.title = p.adsAllowed ? 'This site is in the allow list: nothing is blocked on it.' : 'Ads and trackers blocked on this page since it loaded.';
  const btn = document.querySelector(`.monitor[data-role="${role}"] .ads-site`);
  btn.hidden = !on || !web;
  btn.classList.toggle('allowed', !!p.adsAllowed);
  setText(btn, p.adsAllowed ? 'Block ads here' : 'Allow ads here');
  btn.title = p.adsAllowed
    ? 'This site is allowed (nothing blocked on it). Click to block on it again, from its next page load.'
    : "Stop blocking on this site (for a site that won't work with an ad blocker), from its next page load. Kept for next time.";
}

function showPages(s) {
  const pv = s.preview;
  const pg = s.program;
  if (pv) {
    if (document.activeElement !== $('url') && $('url').value !== pv.url) $('url').value = pv.url;
    $('back').disabled = !pv.canGoBack;
    $('forward').disabled = !pv.canGoForward;
    setText($('reload'), pv.loading ? '✕' : '⟳');
    $('reload').title = pv.loading ? 'Stop loading' : 'Reload (Cmd+R; Shift-click: ignoring the cache)';
  }
  showMonitor('pv', pv, 'preview');
  showMonitor('pg', pg, 'program');
  // (A monitor's pop-out button, lit while its window is open.)
  const popped = new Set(s.popouts ?? []);
  for (const r of ['preview', 'program']) document.querySelector(`.monitor[data-role="${r}"] .popout`)?.setAttribute('aria-pressed', String(popped.has(r)));
  // (A tab's card: its ⧉ lit while its own pop-out window is open.)
  for (const b of $('tabs').querySelectorAll('.card .pop')) b.setAttribute('aria-pressed', String(popped.has(b.closest('.card').dataset.id)));
  const air = s.air.state;
  const [label, title] = AIR[air] ?? AIR.live;
  const tag = $('air-tag');
  // (On air only with an output of the program's on: otherwise the program goes nowhere, and the tag says so.)
  const o = s.output?.outputs ?? {};
  const out = !!(o.ndi || o.sdi || o.syphon);
  tag.className = `tag air ${air}${out ? '' : ' off-air'}`;
  setText(tag, out ? label : air === 'live' ? 'NOT ON AIR' : `${label} · NOT ON AIR`);
  tag.title = out
    ? title
    : `Nothing of the program is going out: no NDI, SDI or Syphon output of the program is on. Turn one on with the switches at the right of this title, or in the Output menu.\n\n${title}`;
  $('pg-screen').classList.toggle('held-air', air !== 'live');
  // (Take: amber while the page taken is still loading.)
  $('take').classList.toggle('waiting', air === 'loading');
  $('live').hidden = air !== 'loading';
  $('freeze').setAttribute('aria-pressed', String(s.air.frozen));
  $('black').setAttribute('aria-pressed', String(s.air.black));
  const l = s.look;
  for (const k of ['hold', 'autoTake', 'scrollbars', 'muted', 'adblock', 'annoyances']) $(k).setAttribute('aria-pressed', String(!!l[k]));
  // (Ad blocking: its lists loading, or not to be had.)
  const ab = s.adblock;
  if (ab) {
    const state = (part, label) => (part.on && part.loading ? `${label} (loading…)` : part.on && !part.ready && part.error ? `${label} (no lists)` : label);
    setText($('adblock'), state(ab.ads, 'Block ads'));
    setText($('annoyances'), state(ab.annoyances, 'Hide cookie banners'));
  }
  setText($('muted'), l.muted ? 'Muted' : 'Sound on');
  if ($('home-url').textContent !== s.home) {
    $('home-url').textContent = s.home;
    $('home-url').title = s.home;
  }
}

/** An update: its download's progress, then a button to restart and install it. */
function showUpdate(u) {
  const el = $('update');
  const show = u && (u.state === 'downloading' || u.state === 'ready');
  el.hidden = !show;
  if (!show) return;
  const ready = u.state === 'ready';
  el.classList.toggle('ready', ready);
  setText(el, ready ? `Update ${u.version} ready · Restart to Update` : `Downloading update ${u.version ?? ''} · ${u.percent ?? 0}%`);
  el.title = ready
    ? `Broadcast Browser ${u.version} is downloaded (you have ${u.current}). Click to restart into it (asked first if an output is on). Or it installs the next time you quit.`
    : `Broadcast Browser ${u.version} is downloading in the background. Nothing changes until you restart.`;
}

function showStatus(s) {
  if (!s || !s.air) return;
  status = s;
  showUpdate(s.update);
  showOutputs(s.output, 'pg', 'program');
  showOutputs(s.previewOutput, 'pv', 'preview');
  showRates(s.output);
  showNoOutputs(s);
  showPages(s);
  showFavorites(s.favorites, s.preview?.url, s.program?.url);
  showTabs(s.tabs, s.tabsWarn, s.closedTabs);
  renderErrors();
}

// ---- Open tabs -----------------------------------------------------------------------------------

/**
 * The tabs' pictures, by tab id: a canvas each, kept from one drawing of the list to the next, so a
 * picture is never cleared and loaded again. A new picture (every few seconds: the Pictures choice)
 * is decoded first, off to the side, then faded in over the one before.
 */
const pictures = new Map();
const FADE_MS = 250;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

function picture(id) {
  let p = pictures.get(id);
  if (!p) {
    const canvas = document.createElement('canvas');
    canvas.width = 360;
    canvas.height = 203;
    p = { canvas, ctx: canvas.getContext('2d'), shown: null, from: null, raf: 0 };
    pictures.set(id, p);
  }
  return p;
}

/** A tab's new picture (decoded): faded in over the one it has. */
function showPicture(id, bitmap) {
  const p = picture(id);
  const { canvas, ctx } = p;
  // (One still fading in: it's the picture now; the one it was fading from goes.)
  cancelAnimationFrame(p.raf);
  p.from?.close();
  p.from = p.shown;
  p.shown = bitmap;
  const draw = (img, alpha) => {
    ctx.globalAlpha = alpha;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  };
  if (!p.from || reduceMotion.matches || document.hidden) {
    draw(bitmap, 1);
    p.from?.close();
    p.from = null;
    return;
  }
  const t0 = performance.now();
  const step = (t) => {
    const a = Math.min(1, (t - t0) / FADE_MS);
    draw(p.from, 1);
    draw(bitmap, a);
    if (a < 1) p.raf = requestAnimationFrame(step);
    else {
      ctx.globalAlpha = 1;
      p.from.close();
      p.from = null;
    }
  };
  p.raf = requestAnimationFrame(step);
}

/** Tabs closed: their pictures let go. */
function dropPictures(open) {
  for (const [id, p] of pictures)
    if (!open.has(id)) {
      cancelAnimationFrame(p.raf);
      p.shown?.close();
      p.from?.close();
      pictures.delete(id);
    }
}
let tabsKey = '';
const TAB_STATE = {
  program: ['● ON AIR', 'On air now. Take another tab to change it.'],
  preview: ['▸ IN PREVIEW', 'In the preview now: TAKE to put it on air.'],
  open: ['', 'Click: into the preview. Shift-click: on air.'],
};

function showTabs(list = [], warnAt = 0, closed = 0) {
  $('tab-reopen').disabled = !closed;
  const every = String(status?.look?.thumbs ?? 5);
  if (document.activeElement !== $('thumbs') && $('thumbs').value !== every) $('thumbs').value = every;
  const over = warnAt > 0 && list.length > warnAt;
  setText($('tab-count'), `${list.length} open${over ? ` · more than ${warnAt}: close some` : ''}`);
  $('tab-count').classList.toggle('over', over);
  $('tab-count').title = 'Each open tab holds its memory (a few hundred MB for a heavy site). Tabs are never closed for you.';
  // (A card's blocked count changes often: just its text, not the list drawn again.)
  for (const t of list) {
    if (t.error || TAB_STATE[t.state]?.[0]) continue;
    const st = $('tabs').querySelector(`.card[data-id="${CSS.escape(t.id)}"] .state`);
    if (st) setText(st, t.blocked ? `${t.blocked} blocked` : '');
  }
  const key = JSON.stringify(list.map((t) => [t.id, t.n, t.url, t.title, t.state, t.loading, t.error]));
  if (key === tabsKey) return;
  tabsKey = key;
  dropPictures(new Set(list.map((t) => t.id)));
  $('tabs').replaceChildren(
    ...list.map((t) => {
      const li = document.createElement('li');
      li.className = `card ${t.state}${t.error ? ' error' : ''}`;
      li.dataset.id = t.id;
      li.tabIndex = t.state === 'program' ? -1 : 0;
      li.draggable = true;
      const [label, title] = TAB_STATE[t.state] ?? TAB_STATE.open;
      li.title = `${t.title || t.url}\n${t.url}\n${title}${t.n <= 9 && t.state !== 'program' ? `\n⌘${t.n}: into the preview. ⌃⌘${t.n}: on air.` : ''}`;
      const th = document.createElement('span');
      th.className = 'thumb';
      // (Its picture's canvas, moved here from the card drawn before: nothing cleared.)
      th.append(picture(t.id).canvas);
      if (t.loading) th.append(Object.assign(document.createElement('span'), { className: 'spinner' }));
      // (Its shortcut: ⌘1…9, by its place.)
      if (t.n <= 9) th.append(Object.assign(document.createElement('kbd'), { className: 'num', textContent: `⌘${t.n}` }));
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = t.title || t.url || 'New tab';
      const u = document.createElement('span');
      u.className = 'url';
      u.textContent = t.url.replace(/^https?:\/\//, '');
      const st = document.createElement('span');
      st.className = 'state';
      st.textContent = t.error ? `couldn't load: ${t.error}` : label || (t.blocked ? `${t.blocked} blocked` : '');
      const x = document.createElement('button');
      x.className = 'close';
      x.dataset.act = 'close';
      x.textContent = '×';
      x.title = t.state === 'preview' ? 'Close this tab (Cmd+W)' : 'Close this tab';
      const pop = document.createElement('button');
      pop.className = 'pop';
      pop.dataset.act = 'popout';
      pop.textContent = '⧉';
      pop.title = 'Pop out this tab: its page in a window of its own, wherever the tab is (in the background, it stays there)';
      pop.setAttribute('aria-pressed', String((status?.popouts ?? []).includes(t.id)));
      li.append(th, name, u, st, pop, x);
      return li;
    }),
  );
}

function wireTabs() {
  const list = $('tabs');
  const tabOf = (e) => e.target.closest('.card');
  list.addEventListener('click', (e) => {
    const card = tabOf(e);
    if (!card) return;
    e.preventDefault();
    if (e.target.closest('[data-act="close"]')) return command('tab-close', { id: card.dataset.id });
    if (e.target.closest('[data-act="popout"]')) return api.popout(card.dataset.id);
    if (card.classList.contains('program')) return;
    command('tab', { id: card.dataset.id, ...(e.shiftKey ? { take: true } : {}) });
  });
  list.addEventListener('keydown', (e) => {
    const card = tabOf(e);
    if (!card || card.classList.contains('program')) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      command('tab', { id: card.dataset.id, ...(e.shiftKey ? { take: true } : {}) });
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      command('tab-close', { id: card.dataset.id });
    }
  });
  // (Drag to reorder.)
  let dragId = null;
  const clearMarks = () => list.querySelectorAll('.drop-before, .drop-after, .dragging').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'dragging'));
  list.addEventListener('dragstart', (e) => {
    const card = tabOf(e);
    if (!card) return;
    dragId = card.dataset.id;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
  });
  list.addEventListener('dragover', (e) => {
    const card = tabOf(e);
    if (!dragId || !card) return;
    e.preventDefault();
    const r = card.getBoundingClientRect();
    const after = e.clientX > r.left + r.width / 2;
    list.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
    card.classList.add(after ? 'drop-after' : 'drop-before');
  });
  list.addEventListener('drop', (e) => {
    const card = tabOf(e);
    e.preventDefault();
    if (!dragId || !card || !status) {
      dragId = null;
      return clearMarks();
    }
    const tabs = status.tabs;
    const from = tabs.findIndex((t) => t.id === dragId);
    let to = tabs.findIndex((t) => t.id === card.dataset.id);
    if (card.classList.contains('drop-after')) to++;
    if (from < to) to--;
    clearMarks();
    if (from !== -1 && from !== to) command('tab-move', { id: dragId, to: to + 1 });
    dragId = null;
  });
  list.addEventListener('dragend', () => {
    dragId = null;
    clearMarks();
  });
  onClick($('tab-new'), async () => {
    await command('tab-new');
    $('url').focus();
  });
  onClick($('tab-reopen'), () => command('tab-reopen'));
  // (A tab's picture: decoded, then faded in on its card. Closed tabs' pictures go when the list next changes.)
  api.onThumb(async ({ id, jpeg }) => {
    let bitmap;
    try {
      bitmap = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
    } catch {
      return;
    }
    showPicture(id, bitmap);
  });
  $('thumbs').addEventListener('change', () => command('look', { thumbs: $('thumbs').value }));
}

// ---- Favorites ---------------------------------------------------------------------------------------

let favKey = '';
function showFavorites(favs, previewUrl, programUrl) {
  const key = JSON.stringify([favs, previewUrl, programUrl]);
  if (key === favKey) return;
  favKey = key;
  showFavoritesMini(favs, previewUrl, programUrl);
  const list = $('favs');
  if (!favs.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = "No favorites yet: load a page into the preview and press ＋ Preview's page (Cmd+D).";
    list.replaceChildren(li);
    return;
  }
  list.replaceChildren(
    ...favs.map((f) => {
      const li = document.createElement('li');
      li.className = `fav${sameUrl(f.url, programUrl) ? ' on-air' : ''}${sameUrl(f.url, previewUrl) ? ' in-preview' : ''}`;
      li.dataset.id = f.id;
      li.draggable = true;
      const go = document.createElement('button');
      go.className = 'go';
      go.dataset.act = 'go';
      go.title = `${f.url}${f.zoom ? ` (zoom ${pct(f.zoom)})` : ''}\nClick: into the preview${f.n <= 9 ? ` (⌥⌘${f.n})` : ''}. Shift-click: on air once loaded${f.n <= 9 ? ` (⌃⌥⌘${f.n})` : ''}.\nDrag to reorder.`;
      const kbd = document.createElement('kbd');
      kbd.textContent = f.n <= 9 ? String(f.n) : '';
      kbd.title = f.n <= 9 ? `⌥⌘${f.n}` : '';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = f.name;
      const u = document.createElement('span');
      u.className = 'url';
      u.textContent = f.url.replace(/^https?:\/\//, '') + (f.zoom ? ` · ${pct(f.zoom)}` : '');
      go.append(kbd, name, u);
      const tools = document.createElement('span');
      tools.className = 'tools';
      const edit = document.createElement('button');
      edit.dataset.act = 'edit';
      edit.textContent = '✎';
      edit.title = 'Change or delete';
      tools.append(edit);
      li.append(go, tools);
      return li;
    }),
  );
}

/** The favorite being changed (null: a new one). */
let editing = null;
function openForm(f) {
  editing = f ?? null;
  const page = status?.preview;
  $('fav-name').value = f?.name ?? page?.title ?? '';
  $('fav-url').value = f?.url ?? page?.url ?? '';
  // (A new one: the zoom the preview is at now, if it isn't 100%.)
  const zoom = f ? f.zoom : page?.zoom !== 1 ? page?.zoom : null;
  $('fav-zoom').value = zoom ? String(Math.round(zoom * 100)) : '';
  $('fav-delete').hidden = !f;
  $('fav-form').hidden = false;
  $('fav-name').focus();
  $('fav-name').select();
}
function closeForm() {
  editing = null;
  $('fav-form').hidden = true;
}

async function saveForm() {
  const name = $('fav-name').value.trim();
  const url = $('fav-url').value.trim();
  const zoomText = $('fav-zoom').value.trim();
  const zoom = zoomText ? Number(zoomText) / 100 : editing ? 'none' : 1;
  if (!url) return addLocalError('a favorite needs an address');
  const r = editing ? await command('favorite-update', { id: editing.id, name, url, zoom }) : await command('favorite-add', { name, url, zoom });
  if (r.ok) closeForm();
}

function wireFavorites() {
  const list = $('favs');
  list.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    const li = e.target.closest('.fav');
    if (!b || !li) return;
    const f = status?.favorites.find((x) => x.id === li.dataset.id);
    if (!f) return;
    if (b.dataset.act === 'edit') openForm(f);
    // (Shift: on air once loaded. Otherwise into the preview, or on air with Auto take.)
    else command('favorite', { id: f.id, ...(e.shiftKey ? { take: true } : {}) });
  });
  // (Drag to reorder.)
  let dragId = null;
  const clearMarks = () => list.querySelectorAll('.drop-before, .drop-after, .dragging').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'dragging'));
  list.addEventListener('dragstart', (e) => {
    const li = e.target.closest('.fav');
    if (!li) return;
    dragId = li.dataset.id;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
  });
  list.addEventListener('dragover', (e) => {
    const li = e.target.closest('.fav');
    if (!dragId || !li) return;
    e.preventDefault();
    const r = li.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    list.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
    li.classList.add(after ? 'drop-after' : 'drop-before');
  });
  list.addEventListener('drop', (e) => {
    const li = e.target.closest('.fav');
    e.preventDefault();
    if (!dragId || !li || !status) {
      dragId = null;
      return clearMarks();
    }
    const favs = status.favorites;
    const from = favs.findIndex((f) => f.id === dragId);
    let to = favs.findIndex((f) => f.id === li.dataset.id);
    if (li.classList.contains('drop-after')) to++;
    if (from < to) to--;
    clearMarks();
    if (from !== -1 && from !== to) command('favorite-move', { id: dragId, to: to + 1 });
    dragId = null;
  });
  list.addEventListener('dragend', () => {
    dragId = null;
    clearMarks();
  });
  onClick($('fav-add'), () => openForm(null));
  $('fav-form').addEventListener('submit', (e) => {
    e.preventDefault();
    saveForm();
  });
  onClick($('fav-cancel'), closeForm);
  onClick($('fav-delete'), async () => {
    if (!editing) return;
    const r = await command('favorite-remove', { id: editing.id });
    if (r.ok) closeForm();
  });
  $('fav-form').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeForm();
    }
  });
}

// ---- The monitors' pictures, and the picture on air when it isn't the program's page ----------------

function startMonitors() {
  const canvases = { preview: $('pv-canvas'), program: $('pg-canvas') };
  for (const [role, canvas] of Object.entries(canvases)) {
    const ctx = canvas.getContext('2d');
    let decoding = false;
    let waiting = null;
    const show = async (jpeg) => {
      decoding = true;
      try {
        const bitmap = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
      } catch {}
      decoding = false;
      if (waiting) {
        const next = waiting;
        waiting = null;
        show(next);
      }
    };
    canvases[role].show = (jpeg) => {
      if (decoding) waiting = jpeg;
      else show(jpeg);
    };
  }
  api.onMonitor((role, jpeg) => canvases[role]?.show(jpeg));
  let heldUrl = null;
  api.onHeld((p) => {
    const fig = $('held');
    if (heldUrl) URL.revokeObjectURL(heldUrl);
    heldUrl = null;
    fig.hidden = !p;
    if (!p) return;
    fig.classList.toggle('black', p.kind === 'black' || !p.jpeg);
    if (p.jpeg) {
      heldUrl = URL.createObjectURL(new Blob([p.jpeg], { type: 'image/jpeg' }));
      $('held-img').src = heldUrl;
    } else $('held-img').removeAttribute('src');
  });
}

// ---- Interact: a monitor is its page -------------------------------------------------------------

let interacting = false;
function setInteract(on) {
  interacting = on;
  $('interact').setAttribute('aria-pressed', String(on));
  for (const id of ['pv-screen', 'pg-screen']) {
    $(id).classList.toggle('interact', on);
    $(id).title = on ? `Interact: click, scroll and type into this page${id === 'pg-screen' ? ' (on air)' : ''}. Esc twice (or Interact) to stop.` : '';
  }
  if (on) $('pv-screen').focus();
}

/** A monitor's picture, clicked, scrolled and typed into while Interact is on: operator/interact.js. */
function wireInteract(screenId, canvasId, target) {
  wireInteractOn({
    screen: $(screenId),
    canvas: $(canvasId),
    isOn: () => interacting,
    onStop: () => setInteract(false),
    send: (args) => api.command('input', { target, ...args }).then((r) => !r.ok && addLocalError(r.error)),
  });
}

// ---- Wiring ------------------------------------------------------------------------------------------

function onClick(el, fn) {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    fn(e);
  });
}

/** The address bar: into the preview (Shift: on air once loaded). */
function goToUrl(toAir) {
  const url = $('url').value.trim();
  if (!url) return;
  command('go', { url, ...(toAir ? { take: true } : {}) });
  $('url').blur();
}

/**
 * Outside the address bar and the form, and not interacting: Page Up / Down and ↑ ↓ (Shift:
 * further) scroll the page on air; with Alt, the preview's.
 */
function handleKeydown(e) {
  // The number keys (by the physical key, whatever the keyboard's layout, and wherever the focus):
  // Cmd+1…9 the nth tab into the preview, Cmd+Option+1…9 the nth favorite; with Control, on air.
  // (Not Shift: Cmd+Shift+3, 4 and 5 are macOS's screenshots, which the app never sees.)
  const digit = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
  if (digit && e.metaKey) {
    e.preventDefault();
    const n = Number(digit[1]);
    if (e.shiftKey) {
      addLocalError(`⇧⌘${n} does nothing: on air is ⌃⌘${n} (Control, not Shift)`);
      return;
    }
    const take = e.ctrlKey ? { take: true } : {};
    if (e.altKey) command('favorite', { n, ...take });
    else {
      // (The tab on air's own number, or no tab there: nothing to do, and Messages says so.)
      const t = status?.tabs?.[n - 1];
      if (!t) addLocalError(`⌘${n}: there are ${status?.tabs?.length ?? 0} tabs open`);
      else if (t.state === 'program') addLocalError(`⌘${n}: “${t.title || t.url}” is the tab on air`);
      else command('tab', { id: t.id, ...take });
    }
    return;
  }
  const el = document.activeElement;
  const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
  if (typing || interacting || e.metaKey || e.ctrlKey) return;
  const target = e.altKey ? 'preview' : 'program';
  const keys = {
    PageUp: () => command('scroll', { target, screens: -1 }),
    PageDown: () => command('scroll', { target, screens: 1 }),
    ArrowUp: () => command('scroll', { target, by: e.shiftKey ? -500 : -100 }),
    ArrowDown: () => command('scroll', { target, by: e.shiftKey ? 500 : 100 }),
  };
  if (keys[e.key]) {
    e.preventDefault();
    keys[e.key]();
  }
}

/** Each monitor's tools act on its own page. */
function wireMonitorTools() {
  for (const mon of document.querySelectorAll('.monitor')) {
    const target = mon.dataset.role;
    mon.querySelector('.mon-tools').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      e.preventDefault();
      const acts = {
        'scroll-up': () => command('scroll', { target, screens: -1 }),
        'scroll-down': () => command('scroll', { target, screens: 1 }),
        top: () => command('top', { target }),
        'zoom-out': () => command('zoom', { target, by: -1 }),
        'zoom-in': () => command('zoom', { target, by: 1 }),
        'zoom-reset': () => command('zoom', { target, reset: true }),
        reload: () => command('reload', { target, hard: e.shiftKey }),
        ads: () => command('adblock-allow', { target }),
        popout: () => api.popout(target),
      };
      acts[b.dataset.act]?.();
    });
  }
}

// ---- The splitter: the tabs' height (the monitors take the rest) -----------------------------------

/**
 * the tabs' height (px), between two limits: no more than leaves the monitors' pictures MONITOR_MIN
 * high, and no less than leaves the monitors all the height they can use (they're as wide as they
 * can be: more height would only be a gap). What the operator chose is kept (for next time too),
 * and put back as far as the limits allow when the window or the favorites column changes.
 */
const RECENT_MIN = 30;
const RECENT_DEFAULT = 250;
/** The smallest the monitors' pictures get (px high) however large the tabs are. */
const MONITOR_MIN = 200;
function wireSplitter() {
  const box = $('recent-box');
  const bar = $('splitter');
  const air = document.querySelector('.air');
  const monitors = document.querySelector('.monitors');
  const stored = (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  };
  const store = (k, v) => {
    try {
      localStorage.setItem(k, String(v));
    } catch {}
  };
  // (The height the monitors and the tabs share: the column less everything else in it.)
  const shared = () => {
    const css = getComputedStyle(air);
    const kids = [...air.children].filter((el) => getComputedStyle(el).display !== 'none');
    const gaps = parseFloat(css.rowGap || '0') * (kids.length - 1);
    const pad = parseFloat(css.paddingTop) + parseFloat(css.paddingBottom);
    const others = kids.filter((el) => el !== box && el !== monitors).reduce((h, el) => h + el.getBoundingClientRect().height, 0);
    return air.clientHeight - pad - gaps - others;
  };
  const chrome = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mon-chrome')) || 76;
  const limits = () => {
    const room = shared();
    // (The monitors' pictures at their widest: half the width each, at 16:9.)
    const gap = parseFloat(getComputedStyle(monitors).columnGap || '14');
    const widest = ((monitors.clientWidth - gap) / 2) * (9 / 16);
    const max = Math.max(RECENT_MIN, room - chrome() - MONITOR_MIN);
    const min = Math.min(max, Math.max(RECENT_MIN, Math.floor(room - chrome() - widest)));
    return { min, max };
  };
  // (What the operator chose; what's shown is that, within the limits.)
  let want = Number(stored('recentHeight')) || RECENT_DEFAULT;
  let open = want > RECENT_MIN + 4 ? want : RECENT_DEFAULT;
  const show = (h) => {
    const { min, max } = limits();
    const v = Math.round(Math.max(min, Math.min(max, h)));
    box.style.height = `${v}px`;
    box.classList.toggle('folded', v <= RECENT_MIN + 4);
    bar.setAttribute('aria-valuenow', String(v));
    return v;
  };
  const choose = (h) => {
    want = show(h);
    // (Its size to come back to on a double-click: not the smallest it goes.)
    if (want > limits().min + 4) open = want;
    store('recentHeight', want);
  };
  show(want);
  let drag = null;
  bar.addEventListener('pointerdown', (e) => {
    drag = { y: e.clientY, h: box.getBoundingClientRect().height };
    bar.setPointerCapture(e.pointerId);
    bar.classList.add('dragging');
    e.preventDefault();
  });
  bar.addEventListener('pointermove', (e) => {
    // (Up: the tabs larger.)
    if (drag) show(drag.h + (drag.y - e.clientY));
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    bar.classList.remove('dragging');
    choose(box.getBoundingClientRect().height);
  };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
  // (Double-click: as small as it goes, or back to its size.)
  bar.addEventListener('dblclick', () => choose(box.getBoundingClientRect().height <= limits().min + 4 ? open : RECENT_MIN));
  // (From the keyboard: ↑ ↓ when the bar has focus.)
  bar.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    e.stopPropagation();
    choose(box.getBoundingClientRect().height + (e.key === 'ArrowUp' ? 40 : -40));
  });
  // (The window resized, or the favorites folded: what was chosen, within the new limits.)
  new ResizeObserver(() => show(want)).observe(air);
}

// ---- The favorites column: folded to a slim strip, for wider monitors ---------------------------------

function wireSide() {
  const side = $('side');
  const fold = (on, save = true) => {
    side.classList.toggle('folded', on);
    if (save)
      try {
        localStorage.setItem('sideFolded', on ? '1' : '0');
      } catch {}
  };
  let folded = false;
  try {
    folded = localStorage.getItem('sideFolded') === '1';
  } catch {}
  fold(folded, false);
  onClick($('side-close'), () => fold(true));
  onClick($('side-open'), () => fold(false));
  // (The strip's numbers: as the favorites. Shift-click: on air.)
  $('favs-mini').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    e.preventDefault();
    command('favorite', { id: b.dataset.id, ...(e.shiftKey ? { take: true } : {}) });
  });
}

function showFavoritesMini(favs, previewUrl, programUrl) {
  $('favs-mini').replaceChildren(
    ...favs.map((f) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.dataset.id = f.id;
      b.className = `${sameUrl(f.url, programUrl) ? 'on-air' : ''} ${sameUrl(f.url, previewUrl) ? 'in-preview' : ''}`.trim();
      b.textContent = String(f.n);
      b.title = `${f.name}\n${f.url}\nClick: into the preview${f.n <= 9 ? ` (⌥⌘${f.n})` : ''}. Shift-click: on air${f.n <= 9 ? ` (⌃⌥⌘${f.n})` : ''}.`;
      li.append(b);
      return li;
    }),
  );
}

async function init() {
  wireSide();
  wireSplitter();
  startMonitors();
  wireFavorites();
  wireTabs();
  wireInteract('pv-screen', 'pv-canvas', 'preview');
  wireInteract('pg-screen', 'pg-canvas', 'program');
  wireMonitorTools();
  api.onStatus(showStatus);
  api.onFocusUrl(() => {
    $('url').focus();
    $('url').select();
  });
  document.addEventListener('keydown', handleKeydown);

  // (Shift+Enter, or Shift-click Go: on air once loaded.)
  let shiftSubmit = false;
  $('nav').querySelector('button[type="submit"]').addEventListener('mousedown', (e) => (shiftSubmit = e.shiftKey));
  $('url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') shiftSubmit = e.shiftKey;
    if (e.key === 'Escape') {
      $('url').value = status?.preview?.url ?? '';
      $('url').blur();
    }
  });
  $('nav').addEventListener('submit', (e) => {
    e.preventDefault();
    goToUrl(shiftSubmit);
    shiftSubmit = false;
  });
  $('url').addEventListener('focus', () => $('url').select());
  onClick($('back'), () => command('back'));
  onClick($('forward'), () => command('forward'));
  onClick($('reload'), (e) => (status?.preview?.loading ? command('stop') : command('reload', { hard: e.shiftKey })));
  onClick($('home'), (e) => command('home', e.shiftKey ? { take: true } : {}));
  onClick($('home-go'), (e) => command('home', e.shiftKey ? { take: true } : {}));
  onClick($('home-set'), () => command('set-home'));

  onClick($('take'), () => command('take'));
  onClick($('live'), () => command('live'));
  onClick($('freeze'), () => command('freeze'));
  onClick($('black'), () => command('black'));
  onClick($('hold'), () => command('look', { hold: 'toggle' }));
  onClick($('autoTake'), () => command('look', { autoTake: 'toggle' }));
  onClick($('interact'), () => setInteract(!interacting));
  onClick($('scrollbars'), () => command('look', { scrollbars: 'toggle' }));
  onClick($('muted'), () => command('look', { muted: 'toggle' }));
  onClick($('adblock'), () => command('look', { adblock: 'toggle' }));
  onClick($('annoyances'), () => command('look', { annoyances: 'toggle' }));

  // (The header's No outputs on: the program's switches, shown for a moment.)
  onClick($('no-outputs'), () => {
    const outs = $('pg-ndi').parentElement;
    outs.classList.remove('flash');
    void outs.offsetWidth;
    outs.classList.add('flash');
    setTimeout(() => outs.classList.remove('flash'), 2400);
  });
  // (Each monitor's output switches: its feed's.)
  for (const [pre, feed] of [
    ['pg', 'program'],
    ['pv', 'preview'],
  ])
    for (const k of ['ndi', 'sdi', 'syphon']) onClick($(`${pre}-${k}`), () => command('outputs', { feed, [k]: 'toggle' }));

  // The control API's address (where it listens: File → Control API → Listen On, which can move it).
  let urls = [];
  const showControl = (now) => {
    urls = now;
    const local = urls.length === 1 && urls[0].startsWith('http://127.0.0.1:');
    $('control').textContent = `Control: ${urls[0]}${local ? ' (this Mac only)' : ''}`;
    $('control').title =
      `Control API, for Bitfocus Companion:\n${urls.join('\n')}\n\n` +
      (local ? 'Only apps on this Mac can reach it. For Companion on another computer: File → Control API → Listen On.\n\n' : '') +
      'Click to open it in your browser (the status, as JSON).\nCompanion needs its token: File → Control API → Copy API Token.';
  };
  showControl(await api.control());
  api.onControl(showControl);
  onClick($('control'), () => api.openControl(urls[0]));
  onClick($('update'), () => status?.update?.state === 'ready' && api.updateInstall());
}

init();
