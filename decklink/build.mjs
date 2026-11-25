// Builds the DeckLink addon (decklink/build/Release/decklink.node) with node-gyp. pnpm install runs
// it (postinstall), and `pnpm run decklink` runs it again. A failed build never fails the install:
// the app runs without DeckLink output and says why. On a Mac it needs Xcode's command-line tools
// (xcode-select --install), as the NDI library does. Desktop Video doesn't have to be installed to
// build it, only to use it.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const verbose = process.argv.includes('--verbose');

function say(line) {
  console.log(`[decklink] ${line}`);
}

if (process.platform !== 'darwin' && process.platform !== 'linux') {
  say(`not built: DeckLink output is for macOS (this is ${process.platform})`);
  process.exit(0);
}

let gyp;
try {
  gyp = require.resolve('node-gyp/bin/node-gyp.js');
} catch {
  say('not built: node-gyp is missing (pnpm install in desktop/ first)');
  process.exit(0);
}

const r = spawnSync(process.execPath, [gyp, 'rebuild', ...(verbose ? ['--verbose'] : [])], { cwd: here, stdio: verbose ? 'inherit' : 'pipe', encoding: 'utf8' });
const built = existsSync(`${here}/build/Release/decklink.node`);
if (r.status === 0 && built) {
  say('built: DeckLink output is available (start with --decklink; see README.md)');
} else {
  say('not built: the app will run without DeckLink output.');
  if (!verbose) {
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split('\n').slice(-15).join('\n');
    if (out) console.log(out);
  }
  if (process.platform === 'darwin') say("If Xcode's command-line tools are missing: xcode-select --install, then pnpm run decklink");
}
process.exit(0);
