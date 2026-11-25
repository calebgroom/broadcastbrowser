// Settings, from the command line (pnpm start -- --fps=29.97), the environment
// (BROADCAST_BROWSER_FPS=29.97), or the settings file (settings.json in the app's folder under
// ~/Library/Application Support: the packaged app, started from the Finder, has no command line). The
// first of those that has a setting wins. See README.md, "Settings".

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import { DECKLINK_MODES } from './decklink.js';

/** The control API's port when there's no --port. */
export const DEFAULT_PORT = 8793;
/** Home when there's no --home: the built-in black page (pages/black.html), safe to have on air. */
export const DEFAULT_HOME = 'app://pages/black.html';

/** Output frame rates, as numerator/denominator. */
export const FRAME_RATES = {
  '59.94': [60000, 1001],
  '60': [60, 1],
  '50': [50, 1],
  '29.97': [30000, 1001],
  '30': [30, 1],
  '25': [25, 1],
};

/** The settings file: { "decklink": "1", "output": "both", ... }, the same names as the flags. */
export function settingsPath() {
  return join(app.getPath('userData'), 'settings.json');
}

/** The settings file as a starting point (written when it's first opened from the File menu). */
export const SETTINGS_TEMPLATE = {
  _help: 'Broadcast Browser settings. Restart the app after changing them. Leave a setting out (or empty) for its default. See README.md, "Settings".',
  output: '',
  ndi: '',
  decklink: '',
  'decklink-mode': '',
  syphon: '',
  'syphon-flip': '',
  fps: '',
  name: '',
  port: '',
  'api-host': '',
  home: '',
  hold: '',
  'hold-max': '',
  'tabs-warn': '',
  'auto-update': '',
  insecure: '',
  'user-agent': '',
  'keep-signins': '',
  look: {},
};

/** Writes the template if there's no settings file yet; returns its path. */
export function ensureSettingsFile() {
  const p = settingsPath();
  if (!existsSync(p)) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(SETTINGS_TEMPLATE, null, 2) + '\n');
  }
  return p;
}

/**
 * Saves one setting in the settings file (made from the template if there isn't one), e.g. the SDI
 * port picked in the Output menu, for the next start. The command line and the environment still
 * come first. Returns an error message, or null.
 */
export function saveSetting(name, value) {
  try {
    const p = ensureSettingsFile();
    const now = JSON.parse(readFileSync(p, 'utf8')) ?? {};
    now[name] = value;
    writeFileSync(p, JSON.stringify(now, null, 2) + '\n');
    if (fileSettings) fileSettings[name] = value;
    return null;
  } catch (e) {
    return `couldn't save ${name} in settings.json: ${e.message}`;
  }
}

let fileSettings = null;
let fileError = null;
function fromFile(name) {
  if (!fileSettings) {
    fileSettings = {};
    try {
      const p = settingsPath();
      if (existsSync(p)) fileSettings = JSON.parse(readFileSync(p, 'utf8')) ?? {};
    } catch (e) {
      fileError = `settings.json: ${e.message} (ignored)`;
    }
  }
  const v = fileSettings[name];
  // (Empty: not set, so the default.)
  return v === undefined || v === null || v === '' ? null : String(v);
}

/** A setting from the file as it is there (an object, say): the on-air look. */
export function fileSetting(name) {
  fromFile('');
  return fileSettings?.[name] ?? null;
}

function arg(name, { file = true } = {}) {
  const flag = `--${name}`;
  for (let i = 0; i < process.argv.length; i++) {
    const a = process.argv[i];
    // (A flag on its own, e.g. --decklink: an empty value, not the next flag.)
    if (a === flag) return process.argv[i + 1] === undefined || process.argv[i + 1].startsWith('--') ? '' : process.argv[i + 1];
    if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
  }
  const env = process.env[`BROADCAST_BROWSER_${name.toUpperCase().replace(/-/g, '_')}`];
  return env === undefined ? (file ? fromFile(name) : null) : env;
}

/**
 * The output switch's settings (--output, the window, the Output menu): NDI and SDI. Syphon has a
 * switch of its own (--syphon), left as it is, except by off: everything off.
 */
export const OUTPUT_MODES = {
  both: { ndi: true, sdi: true },
  ndi: { ndi: true, sdi: false },
  sdi: { ndi: false, sdi: true },
  off: { ndi: false, sdi: false, syphon: false },
};

const isOff = (v) => /^(0|off|false|no)$/i.test(String(v).trim());

/**
 * Where the control API listens (README.md, "Control API"), as the setting has it: "localhost"
 * (this Mac only: the default), "all" (every network the Mac is on), or one network, by its
 * interface (en0: it follows the Mac's address on it) or the Mac's address on it (10.0.0.5).
 * Set in the app (File → Control API → Listen On, which keeps it in the settings file), or with
 * --api-host for a start.
 */
export function normalizeApiHost(v) {
  const s = String(v ?? '').trim();
  if (!s || /^(localhost|127\.0\.0\.1|local)$/i.test(s)) return 'localhost';
  if (/^(all|any|\*|0\.0\.0\.0)$/i.test(s)) return 'all';
  return s;
}

/** This Mac's networks now: [{ name: 'en0', address: '10.0.0.5' }] (IPv4, not loopback). */
export function apiNetworks() {
  return Object.entries(networkInterfaces()).flatMap(([name, list]) =>
    (list ?? []).filter((a) => a.family === 'IPv4' && !a.internal).map((a) => ({ name, address: a.address })),
  );
}

/**
 * The address to listen on for a choice (normalizeApiHost's): { address, problem }. A network the
 * Mac isn't on now: this Mac only (127.0.0.1), the safe choice, with the problem to say.
 */
export function resolveApiHost(choice) {
  if (choice === 'localhost') return { address: '127.0.0.1', problem: null };
  if (choice === 'all') return { address: '0.0.0.0', problem: null };
  const nets = apiNetworks();
  const hit = nets.find((n) => n.name === choice) ?? nets.find((n) => n.address === choice);
  if (hit) return { address: hit.address, problem: null };
  const now = nets.map((n) => `${n.name} ${n.address}`).join(', ') || 'none';
  return {
    address: '127.0.0.1',
    problem: /^[\d.]+$/.test(choice) || /^[a-z]+\d*$/i.test(choice)
      ? `${choice} isn't one of this Mac's networks now (${now}), so it listens on this Mac only until it is`
      : `"${choice}" isn't a place to listen (localhost, all, a network interface like en0, or one of this Mac's addresses), so it listens on this Mac only`,
  };
}

/** A new control API token: 32 characters, letters, digits, - and _ (safe in a URL as it is). */
export const newApiToken = () => randomBytes(24).toString('base64url');

/**
 * The control API's token (README.md, "Control API"): --api-token, BROADCAST_BROWSER_API_TOKEN, or
 * the settings file's "api-token", which the app writes the first time it starts (a new, random
 * one). "off": no token, anyone who can reach the port can drive the app. Returns the token, or null for off.
 */
function apiToken(errors) {
  const v = arg('api-token');
  if (v !== null) {
    if (isOff(v)) return null;
    if (v.length < 16) errors.push('--api-token is too short to be safe (16 characters or more): a new one is in the settings file instead');
    else return v;
  }
  const token = newApiToken();
  const err = saveSetting('api-token', token);
  if (err) errors.push(`${err} (the control API's token: a new one each start until it can be saved)`);
  return token;
}

export function readConfig() {
  const errors = [];
  fromFile('');
  if (fileError) errors.push(fileError);
  let fps = arg('fps') ?? '59.94';
  if (!FRAME_RATES[fps]) {
    errors.push(`--fps must be one of ${Object.keys(FRAME_RATES).join(', ')} (got ${fps}); using 59.94`);
    fps = '59.94';
  }
  // DeckLink (SDI/HDMI) output beside NDI: --decklink (the first device), --decklink=2, or
  // --decklink="UltraStudio"; --decklink-mode sets the frame rate for both (without it: the
  // progressive mode at --fps).
  const deckArg = arg('decklink');
  const deckOn = deckArg !== null && !/^(0|off|false|no)$/i.test(deckArg);
  let deckMode = arg('decklink-mode');
  if (deckMode !== null && !DECKLINK_MODES[deckMode]) {
    errors.push(`--decklink-mode must be one of ${Object.keys(DECKLINK_MODES).join(', ')} (got ${deckMode})`);
    deckMode = null;
  }
  if (deckMode && fps !== DECKLINK_MODES[deckMode].fps) {
    if (arg('fps') !== null) errors.push(`--fps=${arg('fps')} doesn't match --decklink-mode=${deckMode}: using ${DECKLINK_MODES[deckMode].fps} (NDI too)`);
    fps = DECKLINK_MODES[deckMode].fps;
  }
  if (!deckMode) deckMode = Object.keys(DECKLINK_MODES).find((m) => m.startsWith('1080p') && DECKLINK_MODES[m].fps === fps);
  // The outputs at start-up (the window switches them as it runs): off, unless a setting says
  // otherwise: --output=both, ndi, sdi or off, and --ndi / --syphon each on or off (--ndi on its own:
  // on). --decklink only picks the device SDI uses (Output → SDI Port saves it there): it doesn't
  // turn SDI on.
  const onOrOff = (name) => {
    const v = arg(name);
    if (v === null) return undefined;
    if (v === '' || /^(1|on|true|yes)$/i.test(v.trim())) return true;
    if (isOff(v)) return false;
    errors.push(`--${name} must be on or off (got ${v})`);
    return undefined;
  };
  let outputs = { ndi: false, sdi: false, syphon: false };
  const outArg = arg('output');
  if (outArg !== null && outArg !== '') {
    if (OUTPUT_MODES[outArg]) outputs = { ...outputs, ...OUTPUT_MODES[outArg] };
    else errors.push(`--output must be both, ndi, sdi or off (got ${outArg})`);
  }
  for (const k of ['ndi', 'syphon']) {
    const on = onOrOff(k);
    if (on !== undefined) outputs[k] = on;
  }
  if (process.platform !== 'darwin') outputs.syphon = false;
  const port = Number(arg('port') ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) errors.push(`--port must be a port number (got ${arg('port')}); using ${DEFAULT_PORT}`);
  const tabsWarn = Number(arg('tabs-warn') ?? 8);
  if (!Number.isInteger(tabsWarn) || tabsWarn < 0) errors.push(`--tabs-warn must be a whole number, 0 or more (got ${arg('tabs-warn')}); using 8`);
  const holdMax = Number(arg('hold-max') ?? 10);
  if (!Number.isFinite(holdMax) || holdMax < 0) errors.push(`--hold-max must be seconds (got ${arg('hold-max')}); using 10`);
  return {
    errors,
    fps,
    /** The DeckLink device and mode, for whenever SDI is on. */
    decklink: { device: deckOn ? deckArg : '', mode: deckMode },
    /** The outputs on at start-up: { ndi, sdi, syphon } (off unless a setting says so). */
    outputs,
    /** Syphon's picture turned upside down (--syphon-flip), for a client that shows it that way. */
    syphonFlip: arg('syphon-flip') !== null && arg('syphon-flip') !== '' && !isOff(arg('syphon-flip')),
    /**
     * The control API's port (Bitfocus Companion): 8793 unless --port says otherwise.
     */
    port: Number.isInteger(port) && port >= 0 && port <= 65535 ? port : DEFAULT_PORT,
    /** Where the control API listens, as chosen (normalizeApiHost): localhost (the default), all, or one network. */
    apiHost: normalizeApiHost(arg('api-host')),
    /** Whether --api-host (or the environment) set it for this start: the settings file's comes next time. */
    apiHostFixed: process.argv.some((a) => a === '--api-host' || a.startsWith('--api-host=')) || process.env.BROADCAST_BROWSER_API_HOST !== undefined,
    /** The control API's token (null: off, no token). */
    apiToken: apiToken(errors),
    /** Whether it's set on the command line or in the environment (so the settings file's, and New API Token's, don't count). */
    apiTokenFixed: process.argv.some((a) => a === '--api-token' || a.startsWith('--api-token=')) || process.env.BROADCAST_BROWSER_API_TOKEN !== undefined,
    /**
     * A page on air at start-up, in a tab of its own beside the tabs open last time (command line or
     * environment only: the settings file keeps the tabs themselves, as "tabs").
     */
    url: arg('url', { file: false }) || null,
    /** Home: the page ⌂ goes to (the settings file's "home", which Set as Home writes). */
    home: arg('home') || DEFAULT_HOME,
    /**
     * Hold the picture on air while a new page loads (and cut to it once it has), so the audience
     * never sees a blank or half-drawn page: on unless --hold=0. hold-max: give up holding after
     * this many seconds and show the page as it is (0: hold until it's loaded, however long).
     */
    // (null: not set, so the window's switch as it was left, on the first time.)
    hold: arg('hold') === null ? null : !isOff(arg('hold')),
    holdMax: Number.isFinite(holdMax) && holdMax >= 0 ? holdMax : 10,
    /**
     * More tabs open than this: the app says so (each holds its memory: a few hundred MB for a heavy
     * site). Tabs are never closed for want of room. 0: never say.
     */
    tabsWarn: Number.isInteger(tabsWarn) && tabsWarn >= 0 ? tabsWarn : 8,
    /** Look for updates by itself (at start-up and every few hours): on unless --auto-update=0. They're only installed when the operator says, or as the app quits. */
    autoUpdate: arg('auto-update') === null || arg('auto-update') === '' || !isOff(arg('auto-update')),
    /** Hosts whose certificate errors are ignored (a graphics server on the LAN with a self-signed one): comma-separated. */
    insecure: String(arg('insecure') ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    /** The user agent pages see (default: Chrome's, without Electron's and the app's names in it). */
    userAgent: arg('user-agent') || null,
    /**
     * Sign-ins (cookies, stored data) kept between starts: on unless --keep-signins=0. Off: the
     * browsing session is in memory only, and what an earlier start kept is wiped.
     */
    keepSignIns: arg('keep-signins') === null || arg('keep-signins') === '' || !isOff(arg('keep-signins')),
    /** The NDI source name (NDI puts the computer's name in front: "MAC-MINI (Broadcast Browser)"), and the Syphon server's. */
    name: arg('name') || 'Broadcast Browser',
  };
}
