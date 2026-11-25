// Syphon output (macOS): the output's frames shared with other apps on this Mac (OBS, Resolume,
// QLab, MadMapper, VDMX…) through shared GPU memory, with no network in between: the way to feed an
// app on the same Mac, where NDI would send the picture out and take it straight back in. The
// native part is ../syphon (built by pnpm install, or pnpm run syphon).

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

/** Whether Syphon can be had here at all (it's macOS only). */
export const SYPHON_PLATFORM = process.platform === 'darwin';

let addon = null;
let loadError = null;
function load() {
  if (addon || loadError) return addon;
  if (!SYPHON_PLATFORM) {
    loadError = 'Syphon is macOS only';
    return null;
  }
  try {
    addon = require(join(here, '../syphon/build/Release/syphon.node'));
  } catch (e) {
    loadError = e.code === 'MODULE_NOT_FOUND' ? "Syphon support isn't built: run pnpm run syphon (see README.md)" : `couldn't load Syphon support: ${e.message}`;
  }
  return addon;
}

/** A Syphon server called `name` (clients list it as "<app> – <name>"), or throws why not. */
export function openSyphon(name) {
  const a = load();
  if (!a) throw new Error(loadError);
  return new a.Server(name);
}
