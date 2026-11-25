// DeckLink output (Blackmagic UltraStudio / DeckLink, through Desktop Video): the native addon in
// ../decklink (built by pnpm install, or pnpm run decklink), and picking the device and mode.

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

/** --decklink-mode: the device's display mode (its four-character code) and the frame rate the app draws at. */
export const DECKLINK_MODES = {
  '1080p59.94': { code: 'Hp59', fps: '59.94' },
  '1080p60': { code: 'Hp60', fps: '60' },
  '1080p50': { code: 'Hp50', fps: '50' },
  // (Interlaced: the app draws a full frame per pair of fields.)
  '1080i59.94': { code: 'Hi59', fps: '29.97' },
  '1080i50': { code: 'Hi50', fps: '25' },
  '1080p29.97': { code: 'Hp29', fps: '29.97' },
  '1080p30': { code: 'Hp30', fps: '30' },
  '1080p25': { code: 'Hp25', fps: '25' },
};

let addon = null;
let loadError = null;
function load() {
  if (addon || loadError) return addon;
  try {
    addon = require(join(here, '../decklink/build/Release/decklink.node'));
  } catch (e) {
    loadError = e.code === 'MODULE_NOT_FOUND' ? "DeckLink support isn't built: run pnpm run decklink (see README.md)" : `couldn't load DeckLink support: ${e.message}`;
  }
  return addon;
}

/**
 * The devices Desktop Video finds, with whether each can output `mode` (and in which pixel
 * format), or { error }. A card with several output ports (a DeckLink Duo 2, Quad 2, 8K Pro…) lists
 * each port as a device of its own: "DeckLink Duo 2 (1)", "(2)"… `busy`: another app (or this one)
 * is playing out of it; `active`: false for a port the card's profile doesn't use (Desktop Video
 * Setup).
 */
export function listDeckLinks(mode = '1080p59.94') {
  const a = load();
  if (!a) return { error: loadError, devices: [] };
  const version = a.apiVersion();
  if (version === null) return { error: "Blackmagic Desktop Video isn't installed (blackmagicdesign.com/support)", devices: [] };
  const code = DECKLINK_MODES[mode]?.code;
  const devices = a.list(code ? [code] : []).map((d) => ({
    number: d.index + 1,
    name: d.name,
    model: d.model,
    output: d.output,
    format: code ? d.modes[code] : null,
    busy: !!d.busy,
    active: d.duplex !== 'inactive',
    duplex: d.duplex ?? null,
    persistentId: d.persistentId ?? null,
  }));
  return { version, devices, error: devices.length ? null : 'no DeckLink devices found: is the device connected (and allowed in System Settings, Privacy & Security)?' };
}

/** Whether a --decklink setting means "the first free one" rather than a particular device. */
export const isAutoDevice = (device) => {
  const want = String(device ?? '').trim();
  return want === '' || /^(on|true|yes|auto|1)$/i.test(want);
};

/** The device a setting names (a number from 1, or part of its name: the whole name first), or undefined. */
export function findDeckLink(devices, device) {
  const want = String(device ?? '').trim();
  if (/^\d+$/.test(want)) return devices.find((d) => d.number === Number(want));
  const w = want.toLowerCase();
  return devices.find((d) => d.name.toLowerCase() === w) ?? devices.find((d) => d.name.toLowerCase().includes(w));
}

/** Why a device can't be used for output now (null: it can). `mine`: the device this app has open. */
export function deckLinkProblem(d, mode, mine = null) {
  if (!d.output) return 'has no video output';
  if (!d.active) return "isn't active in the card's profile (Desktop Video Setup)";
  if (!d.format) return `can't output ${mode}`;
  if (d.busy && d.name !== mine) return 'is in use by another app';
  return null;
}

/**
 * Opens the device for output: `device` is "" / "on" / "1" (the first that's free: not in use by
 * another app, active, able to output the mode), a number (2 = the second device: on a card with
 * several ports, the second port), or its name (or part of it). onTick() is called each time the
 * device has shown a frame. Throws with a message for the operator.
 */
export function openDeckLink({ device, mode, onTick }) {
  const m = DECKLINK_MODES[mode];
  if (!m) throw new Error(`--decklink-mode must be one of ${Object.keys(DECKLINK_MODES).join(', ')} (got ${mode})`);
  const { error, devices, version } = listDeckLinks(mode);
  if (!devices.length) throw new Error(error);
  const names = devices.map((d) => `${d.number}: ${d.name}`).join(', ');
  const open = (pick) => ({ player: new addon.Player(pick.number - 1, m.code, onTick), name: pick.name, number: pick.number, version });
  if (isAutoDevice(device)) {
    // The first free one; one that says it's free but won't start (in use all the same): the next.
    const free = devices.filter((d) => !deckLinkProblem(d, mode));
    let last = null;
    for (const d of free) {
      try {
        return open(d);
      } catch (e) {
        last = e;
      }
    }
    if (last) throw last;
    const why = devices.map((d) => `${d.name} ${deckLinkProblem(d, mode)}`).join('; ');
    throw new Error(`no free DeckLink output: ${why}`);
  }
  const pick = findDeckLink(devices, device);
  if (!pick) throw new Error(`no DeckLink device "${String(device).trim()}" (found ${names})`);
  const problem = deckLinkProblem(pick, mode);
  if (problem) {
    const others = devices.filter((d) => d !== pick && !deckLinkProblem(d, mode)).map((d) => d.name);
    throw new Error(`${pick.name} ${problem}${others.length ? `: pick another port (Output → SDI Port), e.g. ${others[0]}` : ''}`);
  }
  return open(pick);
}
