// Builds the Syphon addon (syphon/build/Release/syphon.node) with node-gyp. pnpm install runs it
// (postinstall), and `pnpm run syphon` runs it again and shows the compiler's output. macOS only. A
// failed build never fails the install: the app runs without Syphon output and says why. It needs
// Xcode's command-line tools (xcode-select --install), as the NDI and DeckLink addons do.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const verbose = process.argv.includes('--verbose');

function say(line) {
  console.log(`[syphon] ${line}`);
}

if (process.platform !== 'darwin') {
  say(`not built: Syphon is macOS only (this is ${process.platform})`);
  process.exit(0);
}

let gyp;
try {
  gyp = require.resolve('node-gyp/bin/node-gyp.js');
} catch {
  say('not built: node-gyp is missing (pnpm install first)');
  process.exit(0);
}

const r = spawnSync(process.execPath, [gyp, 'rebuild', ...(verbose ? ['--verbose'] : [])], { cwd: here, stdio: verbose ? 'inherit' : 'pipe', encoding: 'utf8' });
const built = existsSync(`${here}/build/Release/syphon.node`);
if (r.status === 0 && built) {
  say('built: Syphon output is available');
} else {
  say('not built: the app will run without Syphon output.');
  if (!verbose) {
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split('\n').slice(-15).join('\n');
    if (out) console.log(out);
  }
  say("If Xcode's command-line tools are missing: xcode-select --install, then pnpm run syphon");
}
process.exit(0);
