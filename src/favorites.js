// Favorites: the operator's shortcuts to pages, kept in the settings file ("favorites": [{ id, name,
// url, zoom? }]), in the order the control window lists them (Cmd+Option+1…9 are the first nine). A
// favorite's zoom, if it has one, is put on with it (pages made for a smaller screen, say).

import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fileSetting, saveSetting } from './config.js';

/** The favorites before the operator has any. */
const STARTERS = [
  { name: 'Test Pattern', url: 'app://pages/test.html' },
  { name: 'Black', url: 'app://pages/black.html' },
];

const newId = () => randomBytes(4).toString('hex');

/** A Google search for some words. */
export const searchUrl = (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`;

/**
 * What the operator typed, as an address, or else a Google search for it (as Chrome's address bar
 * decides). An address: a scheme (http, https, file, app, about, data), kept as it is; a path (/…,
 * ~/…): a file; localhost, an IP address or a .local name, or a computer's name with a port or a
 * path after it (graphics-pc:8080, graphics-pc/): http://; a name with a dot and a real-looking
 * ending (example.com, news.google.com/…): https://. Anything else (words, a single word with no dot,
 * anything with a space) is searched for; "?" in front searches for what follows, whatever it is.
 */
/**
 * Why a file:// address can't be shown, or null if it can (and for anything that isn't file://).
 * Only web pages (.html, .htm) from this Mac's disk: never any other file, nor a folder's listing.
 * Otherwise anyone who can reach the control API could open, say, ~/.ssh/id_rsa and read it off
 * /preview.png. (Checked after following symlinks: x.html, linked to another file, is that file.)
 * A page's own images, styles and scripts still load: they're never shown as text.
 */
export function localFileProblem(url) {
  if (!/^file:/i.test(String(url))) return null;
  let path;
  try {
    path = fileURLToPath(String(url));
  } catch {
    return `"${url}" isn't a file on this Mac`;
  }
  // (No control characters, a NUL above all: a name that could end early, before its ".html".)
  if (/[\0-\x1f]/.test(path)) return `"${url}" isn't a file name this Mac uses`;
  try {
    path = realpathSync(path);
  } catch {
    // (Not there: the page's own error says so, if it's a page.)
  }
  return /\.html?$/i.test(path) ? null : `only web pages (.html) can be opened from this Mac's disk, not ${path}`;
}

export function normalizeUrl(input) {
  const s = String(input ?? '').trim();
  if (!s) throw new Error('no address');
  if (s.startsWith('?')) {
    const q = s.slice(1).trim();
    if (!q) throw new Error('nothing to search for');
    return searchUrl(q);
  }
  const file = /^file:/i.test(s) ? s : s.startsWith('/') || s.startsWith('~/') ? pathToFileURL(s.startsWith('~/') ? homedir() + s.slice(1) : s).toString() : null;
  if (file) {
    const problem = localFileProblem(file);
    if (problem) throw new Error(problem);
    return file;
  }
  if (/^(https?|app|about|data):/i.test(s)) return s;
  if (/^[a-z][\w+.-]*:\/\//i.test(s)) throw new Error(`"${s.split(':')[0]}:" addresses can't be shown here (http, https, file or app)`);
  if (/\s/.test(s)) return searchUrl(s);
  const host = s.split(/[/:?#]/)[0].toLowerCase();
  const rest = s.slice(host.length);
  const ip = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  if (host === 'localhost' || ip || host.endsWith('.local')) return `http://${s}`;
  // (A computer on the network, by its name: only with a port or a path, or it's a word to search for.)
  if (/^[a-z0-9-]+$/.test(host) && /^[:/]/.test(rest)) return `http://${s}`;
  // (A domain: labels of letters, digits and hyphens, ending in letters.)
  if (/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(host) && !host.startsWith('-')) return `https://${s}`;
  return searchUrl(s);
}

export class Favorites {
  constructor(onError) {
    this.onError = onError;
    const saved = fileSetting('favorites');
    this.items = Array.isArray(saved)
      ? saved.filter((f) => f && typeof f === 'object' && f.url).map((f) => ({ id: String(f.id ?? newId()), name: String(f.name ?? f.url), url: String(f.url), ...(Number(f.zoom) > 0 ? { zoom: Number(f.zoom) } : {}) }))
      : STARTERS.map((f) => ({ id: newId(), ...f }));
  }

  list() {
    return this.items.map((f, i) => ({ ...f, n: i + 1 }));
  }

  save() {
    const err = saveSetting(
      'favorites',
      this.items.map(({ id, name, url, zoom }) => ({ id, name, url, ...(zoom ? { zoom } : {}) })),
    );
    if (err) this.onError(err);
  }

  /** The favorite a command names: { id }, { n } (from 1), or { name } (the whole name, else part of it). */
  find(a, what = 'favorite') {
    if (a.id !== undefined && a.id !== '') {
      const f = this.items.find((x) => x.id === String(a.id));
      if (!f) throw new Error(`${what}: no favorite ${a.id}`);
      return f;
    }
    if (a.n !== undefined && a.n !== '') {
      const n = Number(a.n);
      const f = Number.isInteger(n) ? this.items[n - 1] : undefined;
      if (!f) throw new Error(`${what}: there are ${this.items.length} favorites (got n=${a.n})`);
      return f;
    }
    if (a.name) {
      const want = String(a.name).toLowerCase();
      const f = this.items.find((x) => x.name.toLowerCase() === want) ?? this.items.find((x) => x.name.toLowerCase().includes(want));
      if (!f) throw new Error(`${what}: no favorite named like "${a.name}"`);
      return f;
    }
    throw new Error(`${what} needs n, name or id`);
  }

  add({ name, url, zoom }) {
    const f = { id: newId(), name: String(name || url).trim() || url, url: normalizeUrl(url) };
    if (Number(zoom) > 0 && Number(zoom) !== 1) f.zoom = Number(zoom);
    this.items.push(f);
    this.save();
    return f;
  }

  update(f, { name, url, zoom }) {
    if (name !== undefined && String(name).trim()) f.name = String(name).trim();
    if (url !== undefined && String(url).trim()) f.url = normalizeUrl(url);
    if (zoom !== undefined && zoom !== '') {
      const z = Number(zoom);
      if (z === 0 || z === 1 || zoom === 'none') delete f.zoom;
      else if (z > 0) f.zoom = z;
      else throw new Error(`favorite: zoom must be a number (got ${zoom})`);
    }
    this.save();
    return f;
  }

  remove(f) {
    this.items = this.items.filter((x) => x !== f);
    this.save();
  }

  /** To place `to` (from 1), or by: up (-1) or down (1). */
  move(f, { to, by }) {
    const from = this.items.indexOf(f);
    let at = to !== undefined && to !== '' ? Number(to) - 1 : from + Number(by || 0);
    if (!Number.isInteger(at)) throw new Error(`favorite-move: to must be a number (got ${to})`);
    at = Math.max(0, Math.min(this.items.length - 1, at));
    this.items.splice(from, 1);
    this.items.splice(at, 0, f);
    this.save();
  }
}
