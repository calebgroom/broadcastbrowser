// pnpm run dist: builds Broadcast Browser.app (a .dmg and a .zip in release/) for Apple Silicon, from
// either kind of Mac. See README.md, "Building the app".
//
//   pnpm run dist                     for Apple Silicon (arm64)
//   pnpm run dist -- --arch=x64       for an Intel Mac
//   pnpm run dist -- --arch=universal for either (both in one app: about twice the size)
//   pnpm run dist -- --no-notarize    signed with the Developer ID, but not sent to Apple (quicker: to try a build)
//   pnpm run dist -- --adhoc          signed ad hoc, as before there was a Developer ID
//   pnpm run release                  Apple Silicon and universal, signed, notarized, and uploaded to a
//                                     draft GitHub release, for the apps to update to once it's
//                                     published (README.md, "Updates"): Apple Silicon Macs update to the
//                                     Apple Silicon one, Intel Macs to the universal one
//
// Signing (README.md, "Signing and notarizing"): with a "Developer ID Application" certificate in
// this Mac's Keychain, the app is signed with it (electron-builder finds it) and notarized by Apple,
// using the notarization profile stored in the Keychain by `xcrun notarytool store-credentials`:
// "developer-id", or the one NOTARY_PROFILE names. (Or APPLE_API_KEY…/APPLE_ID…, as electron-builder
// reads them.) No password or key is in the project. Without the certificate: signed ad hoc.
//
// 1. Builds the NDI addon (@stagetimerio/grandiose), the DeckLink addon (decklink/) and the Syphon
//    addon (syphon/) for that kind of Mac: Xcode's tools compile for Apple Silicon on an Intel Mac too. NDI's own library
//    is universal (both kinds) already. For a universal app (or a release), each is built for both
//    and the two joined into one universal file (lipo): the universal app's two halves then have the
//    same addons, which electron-builder's merge keeps as they are.
// 2. Packages the app with electron-builder (electron-builder.yml): signed, and notarized.
// 3. Checks the app's signature (and, notarized, that Gatekeeper accepts it).
// 4. Builds the addons for this Mac again, so `pnpm start` keeps working here.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const require = createRequire(import.meta.url);

const opt = (name) => process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const arch = opt('arch')?.split('=')[1] ?? 'arm64';
// (--linux: only to test the packaging in the cloud, where there's no Mac.)
const platform = opt('linux') ? 'linux' : 'mac';
if (!['arm64', 'x64', 'universal'].includes(arch)) fail(`--arch must be arm64 (Apple Silicon), x64 (Intel) or universal (both), not ${arch}`);

function say(line) {
  console.log(`\n[dist] ${line}`);
}
function fail(line) {
  console.error(`\n[dist] ${line}`);
  process.exit(1);
}
function run(cmd, args, cwd, what, env = process.env) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: false, env });
  if (r.status !== 0) fail(`${what} failed (see above)`);
}

// Signing: the Developer ID certificate in the Keychain, if there is one (and not --adhoc).
const mac = platform === 'mac' && process.platform === 'darwin';
function developerId() {
  const r = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  return r.stdout?.match(/"(Developer ID Application: [^"]+)"/)?.[1] ?? null;
}
const identity = mac && !opt('adhoc') ? developerId() : null;
// (A release: only signed and notarized: macOS won't install an update that isn't signed as the app is.)
const release = !!opt('release');
if (release && (!identity || opt('adhoc') || opt('no-notarize') || platform !== 'mac'))
  fail('a release has to be signed with the Developer ID and notarized (no --adhoc, no --no-notarize): README.md, "Signing and notarizing"');
const builderEnv = { ...process.env };
const builderArgs = [];
// A release: uploaded with a GitHub token from the Keychain (README.md, "Updates"), or GH_TOKEN.
if (release && !builderEnv.GH_TOKEN) {
  const r = spawnSync('security', ['find-generic-password', '-s', 'github-release-token', '-w'], { encoding: 'utf8' });
  const token = r.status === 0 ? r.stdout.trim() : '';
  if (!token) fail('no GitHub token to upload the release with: store one in the Keychain as "github-release-token" (README.md, "Updates")');
  builderEnv.GH_TOKEN = token;
}
let notarize = false;
// (Not notarizing: no Apple credentials reach electron-builder, so it can't try.)
const noCredentials = () => {
  for (const k of ['APPLE_KEYCHAIN_PROFILE', 'APPLE_KEYCHAIN', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD']) delete builderEnv[k];
};
if (!identity) {
  noCredentials();
  // (identity "-": ad hoc. Without it electron-builder would leave the app unsigned, which Apple Silicon won't run.)
  builderArgs.push('-c.mac.identity=-', '-c.mac.notarize=false');
  if (mac)
    say(
      opt('adhoc')
        ? 'signing: ad hoc (--adhoc)'
        : 'signing: ad hoc: no "Developer ID Application" certificate in the Keychain (README.md, "Signing and notarizing"). The first open on another Mac needs Open Anyway.',
    );
} else if (opt('no-notarize')) {
  noCredentials();
  builderArgs.push('-c.mac.notarize=false');
  say(`signing: ${identity}, not notarized (--no-notarize): another Mac will say it can't check it`);
} else {
  // (Notarized with the Keychain profile, unless electron-builder's own variables say otherwise.)
  if (!builderEnv.APPLE_KEYCHAIN_PROFILE && !builderEnv.APPLE_API_KEY && !builderEnv.APPLE_ID) builderEnv.APPLE_KEYCHAIN_PROFILE = builderEnv.NOTARY_PROFILE || 'developer-id';
  notarize = true;
  say(
    `signing: ${identity}; notarizing with ${builderEnv.APPLE_KEYCHAIN_PROFILE ? `the Keychain profile "${builderEnv.APPLE_KEYCHAIN_PROFILE}"` : builderEnv.APPLE_API_KEY ? 'the App Store Connect API key' : 'the Apple ID'} (a few minutes: the app is sent to Apple)`,
  );
}

/** The built app's signature checked, and (notarized) that Gatekeeper accepts it as it would on another Mac. */
/**
 * The fuses electron-builder.yml asks for (electronFuses), as they are in the app's Electron
 * Framework: each slice of it (a universal app has two). Fails if any isn't. (@electron/fuses'
 * own reader looks at the first slice only.)
 */
function checkFuses(appPath) {
  const want = {};
  const block = readFileSync(join(root, 'electron-builder.yml'), 'utf8').match(/^electronFuses:\n((?:[ \t]+\w+: *(?:true|false)\n)+)/m);
  if (!block) return say('fuses: none asked for (electron-builder.yml, electronFuses)');
  for (const [, k, v] of block[1].matchAll(/(\w+): *(true|false)/g)) want[k[0].toUpperCase() + k.slice(1)] = v === 'true';
  const libDir = dirname(require.resolve('app-builder-lib/package.json', { paths: [dirname(require.resolve('electron-builder/package.json'))] }));
  const fuses = createRequire(join(libDir, 'x.js'))('@electron/fuses');
  const { SENTINEL } = createRequire(join(libDir, 'x.js'))('@electron/fuses/dist/constants.js');
  const bin = readFileSync(join(appPath, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework'));
  const bad = [];
  let slices = 0;
  for (let at = bin.indexOf(SENTINEL); at !== -1; at = bin.indexOf(SENTINEL, at + 1)) {
    slices++;
    const wire = at + SENTINEL.length;
    for (const [name, on] of Object.entries(want)) {
      const i = fuses.FuseV1Options[name];
      const state = i === undefined || i >= bin[wire + 1] ? null : bin[wire + 2 + i];
      if (state !== (on ? 49 : 48)) bad.push(`${name} (slice ${slices}): ${state === null ? 'not in this Electron' : String.fromCharCode(state)}, not ${on ? 'on' : 'off'}`);
    }
  }
  if (!slices) fail('fuses: no fuse wire in the Electron Framework');
  if (bad.length) fail(`fuses not as electron-builder.yml asks:\n  ${bad.join('\n  ')}`);
  say(`fuses: as asked, in ${slices === 1 ? 'the app' : `each of its ${slices} slices`} (${Object.entries(want).map(([k, v]) => `${k} ${v ? 'on' : 'off'}`).join(', ')})`);
}

function check(appPath) {
  if (!mac || !existsSync(appPath)) return;
  checkFuses(appPath);
  say('checking the signature');
  const sh = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' });
  const sig = sh('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  console.log((sig.stdout + sig.stderr).trim());
  if (sig.status !== 0) fail('the signature doesn’t check out (see above)');
  if (!identity) return;
  const gk = sh('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath]);
  console.log((gk.stdout + gk.stderr).trim());
  if (notarize) {
    const st = sh('xcrun', ['stapler', 'validate', appPath]);
    console.log((st.stdout + st.stderr).trim());
    if (gk.status !== 0 || st.status !== 0) fail('Gatekeeper doesn’t accept the app, or the notarization isn’t stapled to it (see above)');
    say('Gatekeeper accepts it: notarized, and opens on any Mac without a warning');
  }
}

const gyp = require.resolve('node-gyp/bin/node-gyp.js');
let ndiDir = null;
try {
  ndiDir = dirname(require.resolve('@stagetimerio/grandiose/package.json'));
} catch {
  // (Not installed: the app goes without NDI.)
}

/**
 * One addon (its folder, and the file node-gyp makes there) compiled for `a`: arm64, x64, or
 * universal (compiled for each, and the two joined with lipo into the same file).
 */
function buildAddon(what, dir, file, a) {
  say(`${what} addon for ${a}`);
  const out = join(dir, 'build', 'Release', file);
  if (a !== 'universal') return run(process.execPath, [gyp, 'rebuild', `--arch=${a}`], dir, `building the ${what} addon`);
  // (node-gyp rebuild empties build/: the Apple Silicon one is kept aside while the Intel one's made.)
  const aside = join(mkdtempSync(join(tmpdir(), 'bb-addon-')), file);
  run(process.execPath, [gyp, 'rebuild', '--arch=arm64'], dir, `building the ${what} addon (Apple Silicon)`);
  copyFileSync(out, aside);
  run(process.execPath, [gyp, 'rebuild', '--arch=x64'], dir, `building the ${what} addon (Intel)`);
  run('lipo', ['-create', aside, out, '-output', out], dir, `joining the ${what} addon's two halves`);
  rmSync(dirname(aside), { recursive: true, force: true });
}

/** The NDI, DeckLink and Syphon addons, compiled for `a` (arm64, x64 or universal). */
function buildAddons(a) {
  if (ndiDir && existsSync(join(ndiDir, 'ndi'))) {
    buildAddon('NDI', ndiDir, 'grandiose.node', a);
    run(process.execPath, ['scripts/dist.js'], ndiDir, 'copying the NDI addon');
  } else say('NDI addon: not installed (no NDI SDK in node_modules), so the app goes without NDI. Run pnpm install first.');
  buildAddon('DeckLink', join(root, 'decklink'), 'decklink.node', a);
  if (platform === 'mac') buildAddon('Syphon', join(root, 'syphon'), 'syphon.node', a);
}

// The apps to make: a release, Apple Silicon and universal (one electron-builder run, so its
// latest-mac.yml lists both, and each Mac's updater takes its own); otherwise the one --arch names.
const archs = release ? ['arm64', 'universal'] : [arch];
// (The addons: universal if any app is, so one build of them serves every app made.)
const addonArch = archs.length > 1 || archs[0] === 'universal' ? 'universal' : archs[0];

// 1–4.
buildAddons(addonArch);
// (The third-party notices, from what's installed now: they go inside the app. scripts/notices.mjs.)
run(process.execPath, ['scripts/notices.mjs'], root, 'writing THIRD_PARTY_NOTICES.md');
try {
  say(`packaging for ${platform} ${archs.join(' and ')}`);
  const builder = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
  run(builder, [`--${platform}`, ...archs.map((a) => `--${a}`), '--publish', release ? 'always' : 'never', ...builderArgs], root, 'electron-builder', builderEnv);
  // (electron-builder puts each app in release/mac-arm64, release/mac-universal, or release/mac for Intel.)
  for (const a of archs) check(join(root, 'release', a === 'x64' ? 'mac' : `mac-${a}`, 'Broadcast Browser.app'));
} finally {
  // (Addons this Mac can't run, for pnpm start: made again for it. Universal ones run here as they are.)
  if (addonArch !== process.arch && addonArch !== 'universal') {
    say(`the addons for this computer (${process.arch}) again, for pnpm start`);
    buildAddons(process.arch);
  }
}
const { version } = require(join(root, 'package.json'));
say(`done: ${platform === 'mac' ? archs.map((a) => `release/Broadcast-Browser-${version}-${a}.dmg`).join(', ') + ' (and .zip)' : 'release/'}`);
if (release)
  say(`uploaded to a draft release, v${version}: check it, then Publish release at https://github.com/calebgroom/broadcastbrowser/releases (the apps find it once it's published)`);
