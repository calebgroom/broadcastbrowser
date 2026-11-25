// Updates (electron-updater): new versions are published as GitHub releases (electron-builder.yml:
// publish; `pnpm run release`), and the app finds them, downloads them in the background and
// installs them, but never by itself during a show: an update downloaded is installed when the
// operator chooses Restart to Update (asked first if an output is on), or the next time the app
// quits.
//
// It checks a few seconds after start-up and every CHECK_HOURS, unless the auto-update setting is
// off; Check for Updates… (the app menu, or the API's update-check) checks at any time. Only the
// built app updates: running from the project (pnpm start), it says so and does nothing.
//
// The update is checked before it's installed: macOS installs it only if it's signed with the same
// Developer ID as the app running (README.md, "Signing and notarizing").

import { app } from 'electron';
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;

/** How often it checks while the app runs (hours), and how soon after start-up (s). */
const CHECK_HOURS = 4;
const FIRST_CHECK_S = 10;

export class Updater {
  /**
   * @param {{ auto: boolean, onChange: () => void, onError: (e: string) => void, onResult?: (r: { manual: boolean, state: string, version?: string, error?: string }) => void }} o
   * onResult: the end of a check (for Check for Updates…: to say "up to date", or what went wrong).
   */
  constructor(o) {
    this.o = o;
    this.auto = !!o.auto;
    /** idle, checking, downloading, ready, none (up to date), error, or dev (not the built app). */
    this.state = app.isPackaged ? 'idle' : 'dev';
    this.version = null;
    this.percent = 0;
    this.error = null;
    this.checkedAt = null;
    this.manual = false;
    if (!app.isPackaged) return;

    autoUpdater.autoDownload = true;
    // (Downloaded, not yet installed: installed as the app quits.)
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    // (Its log: only problems, into Messages.)
    autoUpdater.logger = { info() {}, debug() {}, warn() {}, error: () => {} };

    const set = (state, extra = {}) => {
      Object.assign(this, { state, ...extra });
      o.onChange();
    };
    const done = (state, extra = {}) => {
      set(state, extra);
      this.checkedAt = new Date().toISOString();
      o.onResult?.({ manual: this.manual, state, version: this.version ?? undefined, error: this.error ?? undefined });
      this.manual = false;
    };
    autoUpdater.on('checking-for-update', () => set('checking', { error: null }));
    autoUpdater.on('update-available', (info) => set('downloading', { version: info.version, percent: 0 }));
    autoUpdater.on('download-progress', (p) => set('downloading', { percent: Math.round(p.percent) }));
    autoUpdater.on('update-not-available', () => done('none', { version: null }));
    autoUpdater.on('update-downloaded', (info) => done('ready', { version: info.version, percent: 100 }));
    autoUpdater.on('error', (e) => {
      const message = String(e?.message ?? e).split('\n')[0];
      // (Already downloaded: an error checking again doesn't undo that.)
      if (this.state === 'ready') return;
      o.onError(`update: ${message}`);
      done('error', { error: message });
    });

    this.firstTimer = setTimeout(() => this.auto && this.check(), FIRST_CHECK_S * 1000);
    this.timer = setInterval(() => this.auto && this.state !== 'ready' && this.check(), CHECK_HOURS * 3600 * 1000);
    this.timer.unref?.();
  }

  /** Looks for an update now (manual: Check for Updates…, which says how it went). */
  check(manual = false) {
    if (this.state === 'dev') {
      if (manual) this.o.onResult?.({ manual, state: 'dev' });
      return;
    }
    if (this.state === 'ready') {
      if (manual) this.o.onResult?.({ manual, state: 'ready', version: this.version });
      return;
    }
    if (this.state === 'checking' || this.state === 'downloading') {
      this.manual ||= manual;
      return;
    }
    this.manual = manual;
    autoUpdater.checkForUpdates().catch(() => {
      // (Reported by the error event.)
    });
  }

  /** The update downloaded, installed now: the app quits, the new version is put in its place and opened. */
  install() {
    if (this.state !== 'ready') throw new Error('no update is ready to install');
    // (Not silently; open it again afterwards.)
    autoUpdater.quitAndInstall(false, true);
  }

  setAuto(on) {
    this.auto = !!on;
    this.o.onChange();
  }

  stop() {
    clearTimeout(this.firstTimer);
    clearInterval(this.timer);
  }

  status() {
    return { state: this.state, current: app.getVersion(), version: this.version, percent: this.percent, error: this.error, auto: this.auto, checkedAt: this.checkedAt };
  }
}
