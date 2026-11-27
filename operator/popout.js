// A pop-out window (main.js, "Pop-out windows"): a page drawn as big as the window. key, in its
// address: 'preview' or 'program' (whichever page is that feed's: after a take, the preview's window
// shows the new preview), or a tab's id (that tab, wherever it is: in the background, it stays there).
// Interact clicks, scrolls and types into the page itself (interact.js), at the page's own size: zoom
// here is the page's zoom. The status from main.js has this window's page in it: s.page, with where it
// is, s.pageState ('program', 'preview' or 'open') and its place in the tabs, s.pageN.

import { wireInteractOn } from './interact.js';

const api = window.playout;
const $ = (id) => document.getElementById(id);
const key = new URLSearchParams(location.search).get('key') || 'preview';
const NAME = key === 'program' ? 'Program' : key === 'preview' ? 'Preview' : 'Tab';
/** A tab's window (not a feed's): it shows that tab wherever it is. */
const isTab = key !== 'preview' && key !== 'program';

/** What's on air, when it isn't the program's page as it is: a window on it shows the page, not that. */
const AIR_NOTE = {
  frozen: 'Frozen on air: this window shows the page, not the held picture',
  loading: 'Held on air until this page has loaded',
  black: 'Black on air',
};

const pct = (z) => `${Math.round((z ?? 1) * 100)}%`;
const setText = (el, t) => {
  if (el.textContent !== t) el.textContent = t;
};

async function command(name, args = {}) {
  const r = await api.command(name, { target: key, ...args });
  if (!r.ok) showNote(r.error, true);
  return r;
}

let noteTimer = null;
let noteError = false;
/** A line in the bar below: an error, for a few seconds. */
function showNote(text, error = false) {
  const note = $('note');
  clearTimeout(noteTimer);
  noteError = error && !!text;
  note.hidden = !text;
  note.dataset.error = String(noteError);
  setText(note, text ?? '');
  if (noteError)
    noteTimer = setTimeout(() => {
      noteError = false;
      note.hidden = true;
    }, 6000);
}

// ---- The status: this window's page, where it is, and what's on air ----------------------------------

/** The page now: its tab's id (for the address bar), and where it is. */
let page = null;
let state = key === 'program' ? 'program' : key === 'preview' ? 'preview' : 'open';

let first = true;
api.onStatus((s) => {
  const p = s.page;
  if (!p) return;
  page = p;
  // (A tab's window opened on the tab on air: Interact off, until asked for, as in the program's.)
  if (first && isTab && s.pageState === 'program') setInteract(false);
  first = false;
  state = s.pageState ?? state;
  const onAir = state === 'program';
  document.body.className = `${state}${onAir ? ' on-air' : ''}`;
  const title = p.title || p.url || '';
  document.title = `${NAME}${isTab ? ` ${s.pageN}` : ''}${onAir ? ' (on air)' : ''}: ${title}`;
  // (The address: the page's, unless it's being typed in.)
  const url = $('url');
  if (document.activeElement !== url && url.value !== (p.url ?? '')) url.value = p.url ?? '';
  setText($('zoom'), pct(p.zoom));
  setText($('reload'), p.loading ? '✕' : '⟳');
  $('back').disabled = !p.canGoBack;
  $('forward').disabled = !p.canGoForward;
  $('home').disabled = !p.home || p.atHome;
  const air = onAir ? ', on air (held until it has loaded, with Hold While Loading on)' : '';
  $('back').title = `Back (Cmd+[)${air}`;
  $('forward').title = `Forward (Cmd+])${air}`;
  $('home').title = `Home: the page this tab started on${p.home ? ` (${p.home})` : ''} (Cmd+Shift+H)${air}`;
  $('reload').title = p.loading ? 'Stop loading' : `Reload the page (Cmd+R; Shift-click: ignoring the cache)${air}`;
  url.title = onAir
    ? 'The page on air: type an address (or words, to search) and press Return to put it on air, held until it has loaded with Hold While Loading on. Esc: as it was.'
    : 'This page: type an address (or words, to search) and press Return. Esc: as it was.';
  // Loading, and a page that couldn't load.
  $('loadbar').hidden = !p.loading;
  const err = $('error');
  err.hidden = !p.error;
  if (p.error) setText(err, `Couldn't load ${p.error.url}: ${p.error.message}`);
  // Its tag: where the page is.
  const o = s.output?.outputs ?? {};
  const out = !!(o.ndi || o.sdi || o.syphon);
  const tag = $('tag');
  if (onAir) {
    tag.className = `tag program${out ? '' : ' off-air'}`;
    setText(tag, out ? 'ON AIR' : 'NOT ON AIR');
    tag.title = out ? 'This page is on air' : 'This page is the program, but no NDI, SDI or Syphon output of the program is on';
  } else if (state === 'preview') {
    tag.className = 'tag preview';
    setText(tag, 'PREVIEW');
    tag.title = 'This page is in the preview: not on air';
  } else {
    tag.className = 'tag open';
    setText(tag, `TAB ${s.pageN}`);
    tag.title = 'This tab is in the background: not in the preview, and not on air';
  }
  showAir(s, onAir, out);
  // (Find: not on the page on air, whose highlights would go out.)
  if (onAir && !$('find').hidden) closeFind();
});

/** The bar below: what's on air (or, for the page on air, how it's going out), and Take. */
function showAir(s, onAir, out) {
  const air = $('air');
  const pg = s.program;
  const pgTitle = pg?.title || pg?.url || '';
  const airState = s.air?.state ?? 'live';
  if (onAir) {
    const how = AIR_NOTE[airState] ?? (out ? 'On air' : 'The program: nothing of it is going out (no output on)');
    air.replaceChildren(Object.assign(document.createElement('span'), { className: `dot${out ? '' : ' off'}` }), how);
  } else {
    air.replaceChildren(Object.assign(document.createElement('span'), { className: `dot${out ? '' : ' off'}` }), `${out ? 'On air' : 'Program (not going out)'}: ${pgTitle}`);
  }
  air.title = onAir ? '' : `${pgTitle}\n${pg?.url ?? ''}`;
  // Take: the preview's window takes the preview; a tab's, puts that tab on air. To Preview: a tab's.
  const take = $('take');
  take.hidden = onAir;
  take.classList.toggle('waiting', airState === 'loading');
  take.title =
    airState === 'loading'
      ? 'The page taken last is still loading: on air once it has'
      : isTab && state !== 'preview'
        ? 'Put this tab on air (into the preview, then taken), once it has loaded'
        : 'Take: the preview on air, once it has loaded (Cmd+Return)';
  $('to-preview').hidden = !isTab || state !== 'open';
  $('to-preview').title = 'Bring this tab into the preview';
}

$('take').addEventListener('click', () => {
  if (isTab && state !== 'preview') command('tab', { id: key, take: true });
  else command('take');
});
$('to-preview').addEventListener('click', () => command('tab', { id: key }));

// ---- The picture --------------------------------------------------------------------------------------

const canvas = $('canvas');
const ctx = canvas.getContext('2d');
let lastBitmap = null;
/**
 * Where the page goes in the canvas (its pixels): 16:9, as big as fits, centred. The window keeps to
 * 16:9 when dragged, but not in full screen or zoomed by the green button: then black bars either side
 * (or above and below), not a stretched page.
 */
let box = { x: 0, y: 0, w: 1, h: 1 };
function letterbox(w, h) {
  const bw = Math.min(w, (h * 16) / 9);
  const bh = (bw * 9) / 16;
  return { x: Math.round((w - bw) / 2), y: Math.round((h - bh) / 2), w: Math.round(bw), h: Math.round(bh) };
}
/** The page's picture into its box, the bars around it black. */
function draw(bitmap) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, box.x, box.y, box.w, box.h);
}
/** The canvas at the window's size in the screen's pixels, so the picture is sharp. */
function fit() {
  const r = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width * devicePixelRatio));
  const h = Math.max(1, Math.round(r.height * devicePixelRatio));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    box = letterbox(w, h);
    if (lastBitmap) draw(lastBitmap);
  }
}
/** The page's box on screen (CSS px), for the mouse: interact.js. */
function pageArea() {
  const r = canvas.getBoundingClientRect();
  const k = r.width / canvas.width;
  return { left: r.left + box.x * k, top: r.top + box.y * k, width: box.w * k, height: box.h * k };
}
new ResizeObserver(fit).observe(canvas);
fit();

let decoding = false;
let waiting = null;
async function show(jpeg) {
  decoding = true;
  try {
    const bitmap = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
    draw(bitmap);
    lastBitmap?.close();
    lastBitmap = bitmap;
  } catch {}
  decoding = false;
  if (waiting) {
    const next = waiting;
    waiting = null;
    show(next);
  }
}
api.onMonitor((k, jpeg) => {
  if (k !== key) return;
  if (decoding) waiting = jpeg;
  else show(jpeg);
});

// ---- Interact: on from the start, unless the page is on air ------------------------------------------

const screen = $('screen');
let interacting = false;
function setInteract(on) {
  interacting = on;
  $('interact').setAttribute('aria-pressed', String(on));
  screen.classList.toggle('interact', on);
  screen.title = on ? `Click, scroll and type into this page${state === 'program' ? ' (on air)' : ''}. Esc twice (or Interact) to stop.` : 'Interact (in the title row) to click, scroll and type into this page';
  if (on) screen.focus();
}
wireInteractOn({
  screen,
  canvas,
  isOn: () => interacting,
  onStop: () => setInteract(false),
  send: (args) => command('input', args),
  area: pageArea,
});
$('interact').addEventListener('click', () => setInteract(!interacting));
setInteract(key !== 'program');

// ---- The address bar: a page into this window's tab (the one on air: on air) ------------------------

const url = $('url');
url.addEventListener('focus', () => url.select());
url.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    url.blur();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const to = url.value.trim();
    if (!to || !page?.id) return;
    command('go', { url: to, id: page.id });
    url.blur();
    if (interacting) screen.focus();
  }
});
// (Cmd+L: here, with this window in front.)
api.onFocusUrl(() => url.focus());

// ---- Find (Cmd+F): on this page, not on the page on air ---------------------------------------------

const find = $('find');
const findText = $('find-text');
let findTimer = null;
function openFind() {
  if (state === 'program') return showNote('Find isn’t available on the page on air: its highlights would go out with it', true);
  find.hidden = false;
  findText.focus();
  findText.select();
}
function closeFind() {
  if (find.hidden) return;
  find.hidden = true;
  clearTimeout(findTimer);
  setText($('find-count'), '');
  command('find-stop');
  if (interacting) screen.focus();
}
async function runFind(next = false, forward = true) {
  const text = findText.value;
  if (!text) {
    setText($('find-count'), '');
    return command('find-stop');
  }
  const r = await command('find', { text, next, forward });
  if (!r.ok) return;
  const { matches = 0, active = 0 } = r.status ?? {};
  setText($('find-count'), matches ? `${active} of ${matches}` : 'No matches');
}
findText.addEventListener('input', () => {
  clearTimeout(findTimer);
  findTimer = setTimeout(() => runFind(), 150);
});
findText.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeFind();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    runFind(true, !e.shiftKey);
  }
});
find.addEventListener('submit', (e) => e.preventDefault());
$('find-next').addEventListener('click', () => runFind(true, true));
$('find-prev').addEventListener('click', () => runFind(true, false));
$('find-close').addEventListener('click', closeFind);
api.onFind(openFind);

// ---- The tools: the page's, as on a monitor ------------------------------------------------------------

document.querySelector('header').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  e.preventDefault();
  const acts = {
    back: () => command('back'),
    forward: () => command('forward'),
    home: () => command('tab-home'),
    'scroll-up': () => command('scroll', { screens: -1 }),
    'scroll-down': () => command('scroll', { screens: 1 }),
    top: () => command('top'),
    'zoom-out': () => command('zoom', { by: -1 }),
    'zoom-in': () => command('zoom', { by: 1 }),
    'zoom-reset': () => command('zoom', { reset: true }),
    reload: () => ($('reload').textContent === '✕' ? command('stop') : command('reload', { hard: e.shiftKey })),
  };
  acts[b.dataset.act]?.();
  // (Back to the page, for the keyboard.)
  if (interacting) screen.focus();
});
