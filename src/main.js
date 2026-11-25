// Broadcast Browser (README.md): a web browser fixed at 1920×1080, out as an NDI source, out of a
// DeckLink device as SDI, and as a Syphon source for apps on this Mac, with a control window to
// drive it and an HTTP control API for Bitfocus Companion (src/http.js). There are two browsers, as
// a vision mixer's preview and program (src/graphic.js): pages are loaded and checked in the
// preview, and Take puts them on air.
//
// The outputs are their own parts: NDI (src/ndi.js, which also drives the others), SDI (src/decklink.js,
// decklink/) and Syphon (src/syphon.js, syphon/).

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, session, shell } from 'electron';
import { Commands } from './commands.js';
import { apiNetworks, ensureSettingsFile, fileSetting, FRAME_RATES, newApiToken, readConfig, resolveApiHost, saveSetting } from './config.js';
import { deckLinkProblem, listDeckLinks } from './decklink.js';
import { Favorites, normalizeUrl } from './favorites.js';
import { BLANK, Graphic, PARTITION } from './graphic.js';
import { startHttp } from './http.js';
import { Output } from './ndi.js';
import { handleScheme, registerScheme } from './site.js';
import { Updater } from './updater.js';

const here = dirname(fileURLToPath(import.meta.url));
/** The project's home: its source, releases and issues. */
const GITHUB = 'https://github.com/calebgroom/broadcastbrowser';
// (The name first: it's the folder the settings file lives in, ~/Library/Application Support/Broadcast Browser.)
app.setName('Broadcast Browser');
const config = readConfig();
registerScheme();
/** The control API's token now (null: none needed). File → Control API → New API Token changes it. */
let apiToken = config.apiToken;
/** An address of the API with its token, for Companion or a browser (the token only ever leaves the app this way, and in the settings file). */
const withToken = (url, path = '/status') => `${url}${path}${apiToken ? `?token=${apiToken}` : ''}`;

/**
 * Where the control API listens: the choice (File → Control API → Listen On, kept in the settings
 * file: localhost, all, or a network: config.js, normalizeApiHost), and the address it comes to now.
 */
let apiChoice = config.apiHost;
let apiAddress = '127.0.0.1';

/** The addresses Companion can reach the control API at, where it listens now. */
function controlUrls(port) {
  if (apiAddress !== '0.0.0.0') return [`http://${apiAddress}:${port}`];
  const out = apiNetworks().map((n) => `http://${n.address}:${port}`);
  return out.length ? out : [`http://127.0.0.1:${port}`];
}

async function main() {
  await app.whenReady();
  // (The packaged app has its icon; running from the project, the Dock would show Electron's.)
  const icon = join(here, '../resources/icon.png');
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(icon);
  // (The About box: NDI's license asks for its trademark line there. Help → Acknowledgements has the rest.)
  handleScheme(session.defaultSession, ['operator', 'pages']);
  // (The control window and the Help windows: nothing to download there, ever.)
  session.defaultSession.on('will-download', (e) => e.preventDefault());

  const operator = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1100,
    minHeight: 640,
    title: 'Broadcast Browser',
    backgroundColor: '#15181d',
    // (No developer tools on the control window, by any route: the app's internals aren't for poking at.
    // The pages have theirs: View → Preview / Program Developer Tools.)
    webPreferences: { preload: join(here, 'preload.cjs'), sandbox: true, contextIsolation: true, devTools: false },
  });
  // (The control window stays the control window: no link takes it anywhere else.)
  operator.webContents.on('will-navigate', (e) => e.preventDefault());
  operator.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const toOperator = (channel, data) => {
    if (!operator.isDestroyed()) operator.webContents.send(channel, data);
  };
  // The control window's messages to the app: taken only from the control window itself (its own
  // page, app://operator/, in its top frame). Web pages run in processes of their own, but one that
  // broke out of its sandbox could otherwise send these too, and drive the app with no API token.
  // (The control API, for Companion and the like, is src/http.js: its own checks, not these.)
  let refusedSaid = false;
  const fromControlWindow = (e) =>
    !operator.isDestroyed() && e.sender === operator.webContents && e.senderFrame != null && e.senderFrame === operator.webContents.mainFrame && e.senderFrame.url.startsWith('app://operator/');
  const handle = (channel, fn) =>
    ipcMain.handle(channel, (e, ...args) => {
      if (fromControlWindow(e)) return fn(e, ...args);
      if (!refusedSaid) {
        refusedSaid = true;
        commands?.error(`refused: a message (${channel}) to the app from somewhere other than the control window (${e.senderFrame?.url?.slice(0, 80) ?? 'unknown'})`);
      }
      throw new Error('not allowed');
    });

  let commands;
  const output = new Output({
    name: config.name,
    rate: FRAME_RATES[config.fps],
    outputs: config.outputs,
    decklink: config.decklink,
    syphon: { flip: config.syphonFlip },
    // (A Syphon client has started watching: a frame for it now, not at the next change.)
    onWake: () => graphic.repaint(),
  });

  // The tabs, for the next start (not too often): the settings file's "tabs": { tabs: [{ url,
  // zoom? }], program, preview }. (Not before they've been opened at start-up.)
  let started = false;
  let savedTabs = '';
  let saveTimer;
  const saveTabs = () => {
    clearTimeout(saveTimer);
    if (!started || !graphic.alive()) return;
    const now = JSON.stringify(graphic.sessionTabs());
    if (now === savedTabs) return;
    savedTabs = now;
    const err = saveSetting('tabs', JSON.parse(now));
    if (err) commands?.error(err);
  };
  const rememberTabs = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveTabs, 1000);
  };

  // (The Tabs menu lists the open tabs: made again when they change, once the menu's there.)
  let refreshTabsMenu = () => {};
  const look = fileSetting('look');
  // (keep-signins off: the pages' session is in memory only, graphic.js; what an earlier start
  // kept on disk is wiped, so nothing of it is left.)
  if (!config.keepSignIns) {
    const kept = session.fromPartition(PARTITION);
    await kept.clearStorageData();
    await kept.clearCache();
    config.errors.push('sign-ins aren’t kept (keep-signins off): this start begins signed out of every site, and nothing is saved for the next');
  }
  const graphic = new Graphic({
    fps: config.fps,
    rate: FRAME_RATES[config.fps],
    look: look && typeof look === 'object' ? look : {},
    hold: config.hold,
    holdMax: config.holdMax,
    tabsWarn: config.tabsWarn,
    insecure: config.insecure,
    userAgent: config.userAgent,
    keepSignIns: config.keepSignIns,
    onFrame: (bgra) => output.frame(bgra),
    // (Every output off: frames aren't taken off the program; the monitors carry on.)
    wantFrames: () => output.wantsFrames(),
    onMonitor: (role, jpeg) => toOperator('monitor', { role, jpeg }),
    onProgram: (p) => toOperator('held', p),
    onThumb: (t) => toOperator('thumb', t),
    onChange: () => {
      rememberTabs();
      refreshTabsMenu();
      const p = graphic?.alive() ? graphic.program.nav() : null;
      if (p && !operator.isDestroyed()) operator.setTitle(`Broadcast Browser — on air: ${p.title || p.url}`);
    },
    onError: (e) => commands?.error(e),
  });

  // Updates (src/updater.js): found and downloaded in the background; installed only when the
  // operator says (Restart to Update), or as the app quits.
  const updater = new Updater({
    auto: config.autoUpdate,
    onChange: () => refreshUpdateMenu(),
    onError: (e) => commands?.error(e),
    onResult: (r) => r.manual && showUpdateResult(r),
  });
  /** Restart to Update: asked first if an output is on (it takes the app off air for a few seconds). */
  const installUpdate = async () => {
    const s = updater.status();
    if (s.state !== 'ready') return;
    const on = Object.entries(output.want).filter(([, v]) => v).map(([k]) => k.toUpperCase());
    if (on.length) {
      const r = await dialog.showMessageBox(operator, {
        type: 'warning',
        message: `Restart to update to ${s.version}?`,
        detail: `${on.join(', ')} ${on.length === 1 ? 'is' : 'are'} on: the app closes, so the outputs stop until it's opened again (a few seconds), and they start off.`,
        buttons: ['Restart and Update', 'Not Now'],
        defaultId: 1,
        cancelId: 1,
      });
      if (r.response !== 0) return;
    }
    updater.install();
  };
  /** How Check for Updates… went. */
  const showUpdateResult = async (r) => {
    if (operator.isDestroyed()) return;
    const current = app.getVersion();
    if (r.state === 'ready') {
      const a = await dialog.showMessageBox(operator, {
        message: `Broadcast Browser ${r.version} is ready to install.`,
        detail: `You have ${current}. It installs when you restart (or the next time you quit).`,
        buttons: ['Restart to Update', 'Later'],
        defaultId: 1,
        cancelId: 1,
      });
      if (a.response === 0) installUpdate();
    } else if (r.state === 'none') dialog.showMessageBox(operator, { message: `Broadcast Browser ${current} is up to date.` });
    else if (r.state === 'dev') dialog.showMessageBox(operator, { message: 'Updates are for the built app.', detail: 'Running from the project (pnpm start), there\u2019s nothing to update: build it with pnpm run dist.' });
    else if (r.state === 'error') dialog.showMessageBox(operator, { type: 'warning', message: 'Couldn\u2019t check for updates.', detail: r.error ?? '' });
  };
  handle('update-install', () => installUpdate());
  handle('update-check', () => updater.check(true));

  let home = config.home;
  const favorites = new Favorites((e) => commands?.error(e));
  commands = new Commands({
    graphic,
    output,
    updater,
    favorites,
    home: () => home,
    setHome: (url) => {
      home = url;
      const err = saveSetting('home', url);
      if (err) commands.error(err);
    },
    onFavorites: () => refreshMenu(output.deckStatus()),
  });
  config.errors.forEach((e) => commands.error(e));

  handle('control', () => controlUrls(config.port));
  // (The header's control address, opened in the default browser: only the API's own addresses.)
  // (With the token: the control window itself never has it.)
  handle('open-control', (_e, url) => {
    if (controlUrls(config.port).includes(url)) return shell.openExternal(withToken(url));
  });
  handle('command', async (_e, name, args) => {
    try {
      return { ok: true, status: await commands.run(name, args) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  await output.start();
  if (config.outputs.ndi && output.ndiError) commands.error(`NDI: ${output.ndiError}`);
  if (config.outputs.sdi && output.deckError) commands.error(`DeckLink: ${output.deckError}`);
  if (config.outputs.syphon && !output.syphon) commands.error(`Syphon: ${output.syphonError}`);
  // (The menu's last DeckLink devices and port: refreshMenu's, below. Here: the control API's
  // timer can come before the menu is first made.)
  let lastDeck = null;
  let lastDl = null;
  // The control API: where it was chosen to listen (this Mac only, unless File → Control API says otherwise).
  const firstPlace = resolveApiHost(apiChoice);
  apiAddress = firstPlace.address;
  if (firstPlace.problem) commands.error(`control API: ${firstPlace.problem}`);
  const http = startHttp(commands, config.port, apiAddress, () => apiToken, (e) => commands.error(e));
  /** Where it listens, in words, for Messages and the menu. */
  const listenWords = () =>
    apiAddress === '127.0.0.1' ? 'this Mac only' : apiAddress === '0.0.0.0' ? 'every network' : `${apiNetworks().find((n) => n.address === apiAddress)?.name ?? 'one network'} only`;
  /** Moves the control API to where the choice comes to now, if that's elsewhere (and says so). */
  const placeApi = async (why = null) => {
    const { address, problem } = resolveApiHost(apiChoice);
    if (address === apiAddress && !why) return;
    let err = await http.listenOn(address);
    apiAddress = err ? '127.0.0.1' : address;
    if (err) err = `${err}; listening on this Mac only` + ((await http.listenOn(apiAddress)) ? ', and that failed too' : '');
    commands.error(`control API: ${err ?? problem ?? `listening on ${listenWords()}: ${controlUrls(config.port).join(', ')}`}`);
    toOperator('control', controlUrls(config.port));
    if (lastDl) refreshMenu(lastDl, lastDeck);
  };
  /** File → Control API → Listen On: a new choice, there at once, and kept for the next start. */
  const chooseApiHost = (choice) => {
    apiChoice = choice;
    const err = saveSetting('api-host', choice);
    if (err) commands.error(`${err} (where the control API listens: only until the app quits)`);
    else if (config.apiHostFixed) commands.error('control API: saved, but this start was given --api-host, which still wins whenever the app is started with it');
    placeApi('chosen');
  };
  // (Networks come and go: a chosen one's address can change, or it can come back. Every few seconds,
  // the API follows its choice there, and the menu lists the networks as they are.)
  setInterval(() => {
    if (apiChoice !== 'localhost' && apiChoice !== 'all') placeApi();
    if (lastDl) refreshMenu(lastDl, lastDeck);
  }, 5000).unref();
  if (!apiToken) commands.error('control API: no token (api-token is off), so anything that can reach this Mac can drive it. See README.md, "Control API"');
  await operator.loadURL('app://operator/index.html');

  // The tabs to start with: those open last time (or, the first time, home on air and a blank
  // preview); --url: a page on air in a tab of its own. (On air stays black until its page has loaded.)
  const last = fileSetting('tabs');
  let tabs = Array.isArray(last?.tabs) && last.tabs.length ? last.tabs.filter((t) => t && typeof t.url === 'string' && t.url) : [];
  let programAt = Number.isInteger(last?.program) ? last.program : 0;
  let previewAt = Number.isInteger(last?.preview) ? last.preview : 1;
  if (!tabs.length) {
    // (From before tabs: the pages last on air and in the preview.)
    const url = fileSetting('url');
    const pv = fileSetting('preview');
    tabs = [{ url: typeof url === 'string' && url ? url : home }, typeof pv === 'string' && pv ? { url: pv } : { url: BLANK, blank: true }];
    programAt = 0;
    previewAt = 1;
  }
  if (config.url)
    try {
      tabs.push({ url: normalizeUrl(config.url) });
      programAt = tabs.length - 1;
      if (previewAt === programAt) previewAt = 0;
    } catch (e) {
      commands.error(`--url: ${e.message}`);
    }
  graphic.start(tabs, programAt, previewAt);
  started = true;

  // The menu bar: the page (its tabs, Cmd+1…9, and its favorites, Cmd+Option+1…9), what's on air, and the outputs (as the
  // header's NDI, SDI and Syphon switches) and the SDI port.
  const outputModes = [
    ['both', 'NDI and SDI'],
    ['ndi', 'NDI Only'],
    ['sdi', 'SDI Only'],
    ['off', 'Off'],
  ];
  let menu = null;
  let menuKey = null;
  // A new token, at once: the old one stops working (Companion's buttons need the new one).
  const replaceApiToken = async () => {
    if (config.apiTokenFixed) return commands.error('the API token is set with --api-token or BROADCAST_BROWSER_API_TOKEN: change it there');
    const { response } = await dialog.showMessageBox(operator, {
      type: 'warning',
      message: 'Make a new API token?',
      detail: 'The current one stops working at once: Companion, and anything else using the control API, needs the new one (File → Control API → Copy Control API Address).',
      buttons: ['New Token', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) return;
    const token = newApiToken();
    const err = saveSetting('api-token', token);
    apiToken = token;
    commands.error(err ? `${err}: the new token works until the app quits` : 'a new API token: File → Control API → Copy Control API Address');
    refreshMenu(output.deckStatus());
  };
  // The license and the acknowledgements, each in a window of its own: from the app's Resources
  // (electron-builder.yml, extraResources), or the project's. (THIRD_PARTY_NOTICES.html: made by
  // scripts/notices.mjs, which pnpm run dist runs; running from the project, pnpm run notices.)
  const docWindows = new Map();
  const openDoc = (name, title) => {
    const open = docWindows.get(name);
    if (open && !open.isDestroyed()) return open.show();
    const file = app.isPackaged ? join(process.resourcesPath, name) : join(here, '..', name);
    if (!existsSync(file)) return commands.error(`${name} is missing${app.isPackaged ? '' : ': pnpm run notices makes it'}`);
    const win = new BrowserWindow({
      width: 820,
      height: 760,
      title,
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, devTools: false },
    });
    docWindows.set(name, win);
    // (Its links go to the Mac's browser; the window itself never leaves the page.)
    const external = (url) => /^https?:/.test(url) && shell.openExternal(url);
    win.webContents.setWindowOpenHandler(({ url }) => (external(url), { action: 'deny' }));
    win.webContents.on('will-navigate', (e, url) => (e.preventDefault(), external(url)));
    win.once('ready-to-show', () => win.show());
    if (name.endsWith('.html')) win.loadFile(file);
    else {
      // (Plain text, LICENSE: as a page, so it wraps and follows dark mode.)
      const esc = readFileSync(file, 'utf8').replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const page = `<!DOCTYPE html><meta charset="utf-8"><title>${title}</title><style>:root{color-scheme:light dark}body{margin:24px 32px}pre{font:12px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap}</style><pre>${esc}</pre>`;
      win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
    }
  };
  // The About window (Broadcast Browser → About Broadcast Browser): the app's own, not the Mac's
  // panel, which takes one block of plain text and no links. Its links open in the Mac's browser,
  // or the License and Acknowledgements windows. (NDI's license asks for its trademark line here.)
  let aboutWindow = null;
  const showAbout = () => {
    if (aboutWindow && !aboutWindow.isDestroyed()) return aboutWindow.show();
    const win = new BrowserWindow({
      // (The size of the page inside: it fits, with no scrolling.)
      width: 440,
      height: 540,
      useContentSize: true,
      title: 'About Broadcast Browser',
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, devTools: false },
    });
    aboutWindow = win;
    win.setMenuBarVisibility(false);
    // (The License and Acknowledgements links: addresses on a domain that can't exist (.invalid), so
    // they're ordinary links to Chromium, and never loaded: every navigation stops here.)
    const LOCAL = 'https://about.broadcastbrowser.invalid/';
    const go = (url) => {
      if (url === `${LOCAL}license`) openDoc('LICENSE', 'License');
      else if (url === `${LOCAL}acknowledgements`) openDoc('THIRD_PARTY_NOTICES.html', 'Acknowledgements');
      else if (/^https?:/.test(url) && !url.startsWith(LOCAL)) shell.openExternal(url);
    };
    win.webContents.setWindowOpenHandler(({ url }) => (go(url), { action: 'deny' }));
    win.webContents.on('will-navigate', (e, url) => (e.preventDefault(), go(url)));
    win.once('ready-to-show', () => win.show());
    const iconFile = join(here, '../resources/icon.png');
    const iconUrl = existsSync(iconFile) ? nativeImage.createFromPath(iconFile).resize({ width: 256, quality: 'best' }).toDataURL() : '';
    const page = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>About Broadcast Browser</title>
<style>
  :root { color-scheme: light dark; --dim: color-mix(in srgb, CanvasText 55%, Canvas); }
  html, body { overflow: hidden; }
  body { margin: 0; padding: 36px 40px 28px; font: 13px/1.5 -apple-system, BlinkMacSystemFont, sans-serif; text-align: center; -webkit-user-select: none; cursor: default; }
  img { width: 112px; height: 112px; }
  h1 { font-size: 22px; font-weight: 600; margin: 14px 0 2px; }
  .version { color: var(--dim); margin: 0; }
  .tagline { margin: 14px 0 0; }
  .github { display: inline-block; margin: 16px 0 0; font-weight: 500; }
  .legal { margin: 22px 0 0; }
  hr { border: 0; border-top: 1px solid color-mix(in srgb, CanvasText 12%, Canvas); margin: 22px 0 16px; }
  .marks { font-size: 11px; line-height: 1.45; color: var(--dim); text-align: left; }
  .marks p { margin: 0 0 8px; }
  a { color: LinkText; text-decoration: none; cursor: pointer; }
  a:hover { text-decoration: underline; }
</style></head><body>
${iconUrl ? `<img src="${iconUrl}" alt="">` : ''}
<h1>Broadcast Browser</h1>
<p class="version">Version ${app.getVersion()} &nbsp;·&nbsp; Electron ${process.versions.electron}</p>
<p class="tagline">Web pages, on air: an NDI®, SDI and Syphon source.</p>
<a class="github" href="${GITHUB}">github.com/calebgroom/broadcastbrowser</a>
<p class="legal">© ${new Date().getFullYear()} Caleb Groom<br><a href="${LOCAL}license">MIT License</a> &nbsp;·&nbsp; <a href="${LOCAL}acknowledgements">Acknowledgements</a></p>
<hr>
<div class="marks">
<p>NDI® is a registered trademark of Vizrt NDI AB (<a href="https://ndi.video/">ndi.video</a>).</p>
<p>Blackmagic Design, DeckLink, UltraStudio and Desktop Video are trademarks of Blackmagic Design Pty. Ltd.</p>
<p>Other names are the trademarks of their owners. Broadcast Browser isn’t affiliated with or endorsed by them.</p>
</div>
</body></html>`;
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
  };
  const run = (name, args) => commands.run(name, args).catch((e) => commands.error(e.message));
  const portItems = (deck, dl) => {
    const auto = !dl.device || dl.device === 'auto';
    const items = [
      { id: 'sdi-port-auto', label: 'First Free Port', type: 'radio', checked: auto, click: () => run('outputs', { device: 'auto' }) },
      { type: 'separator' },
    ];
    if (!deck.devices.length) items.push({ label: deck.error ?? 'No DeckLink devices', enabled: false });
    for (const d of deck.devices) {
      const mine = dl.on ? dl.name : null;
      const problem = deckLinkProblem(d, dl.mode, mine);
      items.push({
        id: `sdi-port-${d.number}`,
        label: `${d.name}${mine === d.name ? ' (in use here)' : !d.active ? ' (inactive in the card’s profile)' : problem ? ` (${problem.replace(/^is |^has /, '').replace(/ \(.*\)$/, '')})` : ''}`,
        type: 'radio',
        checked: !auto && d.name === dl.device,
        enabled: d.output && d.active,
        click: () => run('outputs', { device: d.name }),
      });
    }
    return items;
  };
  const buildMenu = (deck, dl, favs, tabs) => {
    menu = Menu.buildFromTemplate([
      ...(process.platform === 'darwin'
        ? [
            {
              label: app.name,
              submenu: [
                { label: 'About Broadcast Browser', click: () => showAbout() },
                { label: 'Check for Updates…', click: () => updater.check(true) },
                // (Shown once an update is ready: the control window's header says so too.)
                { id: 'update-install', label: 'Restart to Update', visible: updater.status().state === 'ready', click: () => installUpdate() },
                {
                  id: 'update-auto',
                  label: 'Check for Updates Automatically',
                  type: 'checkbox',
                  checked: updater.auto,
                  click: (item) => {
                    updater.setAuto(item.checked);
                    const err = saveSetting('auto-update', item.checked);
                    if (err) commands.error(err);
                  },
                },
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' },
              ],
            },
          ]
        : []),
      {
        label: 'File',
        submenu: [
          { label: 'Open Settings File', click: () => shell.openPath(ensureSettingsFile()).then((e) => e && commands.error(`settings: ${e}`)) },
          { label: 'Show Settings File in Finder', click: () => shell.showItemInFolder(ensureSettingsFile()) },
          { type: 'separator' },
          // The control API, for Companion (README.md, "Control API"): where it listens, its address and token.
          {
            label: 'Control API',
            submenu: [
              { label: `Listening on ${listenWords()}`, enabled: false },
              { label: 'This Mac Only', type: 'radio', checked: apiChoice === 'localhost', click: () => chooseApiHost('localhost') },
              { label: 'All Networks', type: 'radio', checked: apiChoice === 'all', click: () => chooseApiHost('all') },
              ...apiNetworks().map((n) => ({
                label: `${n.name} only (${n.address})`,
                type: 'radio',
                checked: apiChoice === n.name || apiChoice === n.address,
                click: () => chooseApiHost(n.name),
              })),
              // (A network chosen before, not there now: shown, ticked, so it's clear where it would be.)
              ...(apiChoice !== 'localhost' && apiChoice !== 'all' && !apiNetworks().some((n) => n.name === apiChoice || n.address === apiChoice)
                ? [{ label: `${apiChoice} only (not connected: this Mac only till it is)`, type: 'radio', checked: true, enabled: false }]
                : []),
              { type: 'separator' },
              {
                label: 'Copy Control API Address',
                click: () => {
                  clipboard.writeText(withToken(controlUrls(config.port)[0], '/'));
                  commands.error('copied: the control API’s address, with its token. Keep it to yourself: it controls the app');
                },
              },
              {
                label: 'Copy API Token',
                enabled: !!apiToken,
                click: () => {
                  clipboard.writeText(apiToken);
                  commands.error('copied: the control API’s token');
                },
              },
              { label: 'New API Token…', click: () => replaceApiToken() },
            ],
          },
          { type: 'separator' },
          // Sign-ins (README.md, "Sign-ins"): the preview's site's, or every site's (asked first).
          { label: 'Sign Out of the Preview’s Site', click: () => run('signout', {}) },
          {
            label: 'Sign Out of Every Site…',
            click: async () => {
              const { response } = await dialog.showMessageBox(operator, {
                type: 'warning',
                message: 'Sign out of every site?',
                detail:
                  'Every site’s cookies, sign-ins and stored data, and the cache, are removed. Pages already open keep what they show until they’re loaded again: one on air stays on air as it is.',
                buttons: ['Sign Out', 'Cancel'],
                defaultId: 1,
                cancelId: 1,
              });
              if (response === 0) run('signout', { all: 'true' });
            },
          },
          { type: 'separator' },
          // (Cmd+W closes a tab, not this window: closing the window quits the app. Cmd+Q to quit.)
          ...(process.platform === 'darwin' ? [] : [{ role: 'quit' }]),
        ],
      },
      {
        label: 'Tabs',
        submenu: [
          { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => run('tab-new').then(() => toOperator('focus-url')) },
          { label: 'Close the Preview’s Tab', accelerator: 'CmdOrCtrl+W', click: () => run('tab-close') },
          { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: () => run('tab-reopen') },
          { type: 'separator' },
          { label: 'Next Tab into Preview', accelerator: 'CmdOrCtrl+Alt+Right', click: () => run('tab-next', { by: 1 }) },
          { label: 'Previous Tab into Preview', accelerator: 'CmdOrCtrl+Alt+Left', click: () => run('tab-next', { by: -1 }) },
          // The open tabs, with their keys (Cmd+1…9: the nth into the preview; Control+Cmd: on air). The
          // keys themselves are the control window's (operator.js: by the physical number keys,
          // whatever the keyboard's layout); here they're shown, and a click does the same.
          ...(tabs.length ? [{ type: 'separator' }] : []),
          ...tabs.slice(0, 9).map((t, i) => ({
            label: `${(t.title || t.url || 'New tab').slice(0, 60)}${t.state === 'program' ? '  (on air)' : t.state === 'preview' ? '  (in preview)' : ''}`,
            accelerator: `CmdOrCtrl+${i + 1}`,
            registerAccelerator: false,
            // (Never greyed out, the one on air too: a greyed-out item could swallow its key. Pressed, it checks.)
            click: () => {
              const b = graphic.tabs[i];
              if (b && b !== graphic.program) run('tab', { id: b.id });
            },
          })),
        ],
      },
      // (For the control window's text fields: the address bar, a favorite's name. Plain text only,
      // so not the stock Edit menu's Paste and Match Style, or its Speech.)
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'delete' },
          { role: 'selectAll' },
        ],
      },
      {
        // (The preview's page.)
        label: 'Preview',
        submenu: [
          { label: 'Open Location…', accelerator: 'CmdOrCtrl+L', click: () => toOperator('focus-url') },
          { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => run('back') },
          { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => run('forward') },
          { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => run('reload') },
          { label: 'Reload Ignoring Cache', accelerator: 'CmdOrCtrl+Shift+R', click: () => run('reload', { hard: true }) },
          { label: 'Home', accelerator: 'CmdOrCtrl+Shift+H', click: () => run('home') },
          { label: 'Set This Page as Home', click: () => run('set-home') },
          { type: 'separator' },
          { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => run('zoom', { by: 1 }) },
          { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => run('zoom', { by: -1 }) },
          { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => run('zoom', { reset: true }) },
        ],
      },
      {
        // (Cmd+Option+1…9: into the preview (and on air with Auto Take). Control+Option+Cmd+1…9: on air, once loaded.)
        label: 'Favorites',
        submenu: [
          { label: 'Add the Preview’s Page', accelerator: 'CmdOrCtrl+D', click: () => run('favorite-add') },
          // (Cmd+Option+1…9: the nth into the preview; Control+Option+Cmd: on air. The keys are the control
          // window's, as the tabs': shown here.)
          ...(favs.length ? [{ type: 'separator' }] : []),
          ...favs.map((f, i) => ({ label: f.name, accelerator: i < 9 ? `CmdOrCtrl+Alt+${i + 1}` : undefined, registerAccelerator: false, click: () => run('favorite', { id: f.id }) })),
        ],
      },
      {
        label: 'Air',
        submenu: [
          { label: 'Take', accelerator: 'CmdOrCtrl+Return', click: () => run('take') },
          { label: 'Take Now (Don’t Wait for Loading)', accelerator: 'CmdOrCtrl+Shift+Return', click: () => run('take', { now: true }) },
          { label: 'Freeze', accelerator: 'CmdOrCtrl+Shift+F', click: () => run('freeze') },
          { label: 'Black', accelerator: 'CmdOrCtrl+B', click: () => run('black') },
          { label: 'Show Program As Is', click: () => run('live') },
          { type: 'separator' },
          { label: 'Reload the Page on Air', click: () => run('reload', { target: 'program' }) },
          { type: 'separator' },
          { id: 'look-hold', label: 'Hold While Loading', type: 'checkbox', click: () => run('look', { hold: 'toggle' }) },
          { id: 'look-auto', label: 'Auto Take', type: 'checkbox', click: () => run('look', { autoTake: 'toggle' }) },
        ],
      },
      {
        label: 'Output',
        submenu: [
          ...outputModes.map(([mode, label]) => ({ id: `output-${mode}`, label, type: 'radio', click: () => run('outputs', { mode }) })),
          { type: 'separator' },
          { label: 'SDI Port', submenu: portItems(deck, dl) },
          // (Syphon: apps on this Mac. Its own switch: the modes above leave it as it is.)
          ...(process.platform === 'darwin'
            ? [
                { type: 'separator' },
                { id: 'output-syphon', label: 'Syphon (Apps on This Mac)', type: 'checkbox', click: () => run('outputs', { syphon: 'toggle' }) },
                { id: 'output-syphon-flip', label: 'Flip Syphon Picture', type: 'checkbox', click: () => run('outputs', { flip: 'toggle' }) },
              ]
            : []),
          // (NDI's license: a link to ndi.video near where NDI is chosen.)
          { type: 'separator' },
          { label: 'About NDI (ndi.video)', click: () => shell.openExternal('https://ndi.video/') },
        ],
      },
      {
        label: 'View',
        submenu: [
          { label: 'Preview Developer Tools', click: () => graphic.preview.wc.openDevTools({ mode: 'detach' }) },
          { label: 'Program Developer Tools', click: () => graphic.program.wc.openDevTools({ mode: 'detach' }) },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      // (Not the stock Window menu: off the Mac, it has Close, whose Ctrl+W is also Close the Preview's
      // Tab, and closing the control window quits the app. macOS lists the open windows below these.)
      {
        role: 'window',
        submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(process.platform === 'darwin' ? [{ type: 'separator' }, { role: 'front' }] : [])],
      },
      {
        role: 'help',
        submenu: [
          // (In the Mac's browser: the source, the releases, and where to report a problem.)
          { label: 'Broadcast Browser on GitHub', click: () => shell.openExternal(GITHUB) },
          { label: 'Release Notes', click: () => shell.openExternal(`${GITHUB}/releases`) },
          { label: 'Report a Problem…', click: () => shell.openExternal(`${GITHUB}/issues`) },
          { type: 'separator' },
          { label: 'Acknowledgements', click: () => openDoc('THIRD_PARTY_NOTICES.html', 'Acknowledgements') },
          { label: 'License', click: () => openDoc('LICENSE', 'License') },
          // (NDI's link: in the Output menu, by the NDI choices, as its license asks.)
          // (On a Mac it's in the app's menu, as usual.)
          ...(process.platform === 'darwin' ? [] : [{ type: 'separator' }, { label: 'About Broadcast Browser', click: () => showAbout() }]),
        ],
      },
    ]);
    Menu.setApplicationMenu(menu);
  };
  /** The menu made again if what it shows has changed (deck: the DeckLink devices, looked for again unless given). */
  const refreshMenu = (dl, deck = listDeckLinks(dl.mode)) => {
    lastDeck = deck;
    lastDl = dl;
    const favs = favorites.list();
    const tabs = graphic.tabList();
    const key = JSON.stringify([
      deck.error,
      deck.devices.map((d) => [d.name, d.busy, d.active, d.output, !!d.format]),
      dl.device,
      dl.on && dl.name,
      favs.map((f) => [f.id, f.name]),
      tabs.slice(0, 9).map((t) => [t.id, (t.title || t.url).slice(0, 60), t.state]),
      !!apiToken,
      apiChoice,
      apiAddress,
      apiNetworks(),
    ]);
    if (key === menuKey) return;
    menuKey = key;
    buildMenu(deck, dl, favs, tabs);
  };
  refreshMenu(output.deckStatus());
  // (Tabs changed: the menu again, soon, with the DeckLink devices as last looked for.)
  let tabsMenuTimer;
  refreshTabsMenu = () => {
    clearTimeout(tabsMenuTimer);
    tabsMenuTimer = setTimeout(() => lastDl && graphic.alive() && refreshMenu(lastDl, lastDeck), 300);
  };
  const showOutputs = (o, sy) => {
    const mode = o.ndi && o.sdi ? 'both' : o.ndi ? 'ndi' : o.sdi ? 'sdi' : 'off';
    const item = menu.getMenuItemById(`output-${mode}`);
    if (item && !item.checked) item.checked = true;
    const tick = (id, on) => {
      const i = menu.getMenuItemById(id);
      if (i && i.checked !== on) i.checked = on;
    };
    tick('output-syphon', !!o.syphon);
    tick('output-syphon-flip', !!sy?.flip);
    tick('look-hold', !!graphic.look.hold);
    tick('look-auto', !!graphic.look.autoTake);
  };
  let lastPortCheck = 0;
  /** The app menu's Restart to Update, there once an update is ready (and its version said). */
  function refreshUpdateMenu() {
    const item = menu?.getMenuItemById('update-install');
    if (!item) return;
    const s = updater.status();
    item.visible = s.state === 'ready';
    item.label = s.state === 'ready' ? `Restart to Update to ${s.version}` : 'Restart to Update';
    const auto = menu.getMenuItemById('update-auto');
    if (auto && auto.checked !== s.auto) auto.checked = s.auto;
  }

  // The control window's status (and the Output menu's tick): 10 a second.
  const timer = setInterval(() => {
    const s = commands.status();
    if (Date.now() - lastPortCheck > 2000) {
      lastPortCheck = Date.now();
      refreshMenu(s.output.decklink);
    }
    showOutputs(s.output.outputs, s.output.syphon);
    toOperator('status', s);
  }, 100);

  // Quitting (the control window closed, or Cmd+Q): the browser first, so nothing it does as its
  // page is taken down reaches a window that's gone; then the rest. (Once, whichever comes first.)
  let shutDown = false;
  const shutdown = () => {
    if (shutDown) return;
    shutDown = true;
    clearInterval(timer);
    updater.stop();
    saveTabs();
    graphic.close();
    http.close();
    output.stop();
  };
  app.on('window-all-closed', () => app.quit());
  operator.on('close', shutdown);
  operator.on('closed', () => app.quit());
  app.on('before-quit', shutdown);
}

main().catch((e) => {
  console.error(e);
  app.exit(1);
});
