// The video output: the graphic's frames, sent out as an NDI source at the output frame rate, and
// out of a DeckLink device (SDI/HDMI) too when there is one (--decklink). With a DeckLink device,
// its clock paces everything: each time it has shown a frame, the next goes to it and to NDI (sent
// unclocked). Without one, NDI paces the sends itself (clockVideo).
//
// Each frame the page draws goes into a short queue and out once, in order: during a play the
// page draws one frame per output frame (it steps the play in whole frames: ?fps=), so every
// position reaches the output, at an even pace, however unevenly the frames arrive. The queue
// waits for two frames before it starts (one frame of slack), or sends a lone frame once no other
// follows it (a single change: an overlay, a step while paused); when it runs dry (nothing moving,
// or the page fell behind), the last frame goes out again, and it waits for two again; when it gets too long (the page draws
// a touch faster than the output rate: 60 against 59.94), the oldest frame is dropped.
//
// Each output can be switched on and off as the app runs (setOutputs: the window's NDI, SDI and
// Syphon switches, the Output menu), between frames: off, it's closed, so it costs nothing. With both
// off (or only Syphon, unwatched), frames aren't taken off the page at all (wantsFrames); the preview carries on.
//
// Syphon (macOS, src/syphon.js) shares the same frames with apps on this Mac. It takes no part in
// the pacing: each frame that goes out goes into its surface too, and only while a client is
// watching (with nobody watching it costs nothing, and the page isn't asked for frames for it).
//
// NDI comes from @stagetimerio/grandiose (an optional dependency: it downloads the NDI SDK and
// compiles when installed). Without it, NDI reports why, and the rest of the app (preview,
// controls, SDI) still works.

import { createRequire } from 'node:module';
import { isAutoDevice, openDeckLink } from './decklink.js';
import { openSyphon, SYPHON_PLATFORM } from './syphon.js';

const require = createRequire(import.meta.url);

export const WIDTH = 1920;
export const HEIGHT = 1080;

/** The queue: frames before it starts sending them, and at most. */
const START_QUEUE = 2;
const MAX_QUEUE = 4;

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
/** A DeckLink device setting, the first-free-one ones ("", on, 1, auto) all alike. */
const deviceKey = (d) => (isAutoDevice(d) ? 'auto' : String(d).trim());

/** Frames kept waiting in the DeckLink addon, ready for the device (beyond its own buffer). */
const DECK_AHEAD = 2;
/** No word from the DeckLink device for this long: the timer takes over pacing (and it's reported). */
const DECK_SILENT_MS = 500;

export class Output {
  /**
   * @param {{ name: string, rate: [number, number], outputs: { ndi: boolean, sdi: boolean, syphon?: boolean }, decklink: { device: string, mode: string }, syphon?: { flip?: boolean }, onWake?: () => void }} o
   * onWake: frames are wanted again without an output being switched (a Syphon client has started watching): draw one.
   */
  constructor({ name, rate, outputs, decklink, syphon = {}, onWake = () => {} }) {
    this.name = name;
    this.rate = rate;
    this.onWake = onWake;
    /** The outputs asked for, and those the loop has set up (it switches them between frames). */
    this.want = { ndi: !!outputs.ndi, sdi: !!outputs.sdi, syphon: SYPHON_PLATFORM && !!outputs.syphon };
    /** The Syphon server, why there's none, whether a client is watching, and the last frame put in it. */
    this.syphon = null;
    this.syphonError = 'off';
    this.syphonFlip = !!syphon.flip;
    this.syphonWatched = false;
    this.syphonLast = null;
    this.applied = null;
    this.applyWaiters = [];
    /** The device and mode SDI uses when it's on. */
    this.deckConfig = decklink;
    /** The DeckLink player (decklink/src/decklink.cc), its device's name, and why there's none. */
    this.deck = null;
    this.deckName = null;
    this.deckNumber = null;
    /** The device setting the open device was opened for (another one picked: it's reopened). */
    this.deckOpenedFor = null;
    this.deckError = 'off';
    this.deckStats = null;
    this.deckPrev = null;
    this.deckRates = { late: 0, dropped: 0, repeats: 0 };
    this.lastTickAt = 0;
    this.tickWaiter = null;
    /** Frames waiting to go out (BGRA, WIDTH × HEIGHT), oldest first, and the last one sent. */
    this.queue = [];
    this.last = null;
    this.priming = true;
    this.running = false;
    this.sender = null;
    /** Whether the NDI sender keeps to its own clock (no DeckLink device to pace it). */
    this.senderClocked = true;
    /** Why there's no NDI (null when there is). */
    this.ndiError = 'off';
    this.sourceName = null;
    // Counts for the last second: frames drawn, frames sent, sends that took longer than two
    // frames, frames sent again for want of a new one while the page was drawing, frames dropped.
    this.counts = { paints: 0, sent: 0, late: 0, repeats: 0, drops: 0 };
    this.stats = { paintsPerS: 0, sentPerS: 0, lateFrames: 0, repeats: 0, drops: 0 };
    this.lastPaintAt = 0;
    this.lastStatsAt = Date.now();
  }

  /** Starts the loop, with the outputs asked for at start-up set up first. */
  async start() {
    this.running = true;
    const ready = new Promise((ok) => this.applyWaiters.push(ok));
    this.loop();
    await ready;
  }

  /**
   * The DeckLink device SDI uses: "" or "auto" (the first free one), a number (from 1: on a card
   * with several ports, the port) or a name. With SDI on, the device in use is closed and the new
   * one opened, between frames. Resolves once the loop has done it.
   */
  setDeckDevice(device) {
    this.deckConfig = { ...this.deckConfig, device: String(device ?? '') };
    if (!this.running) return Promise.resolve();
    return new Promise((ok) => this.applyWaiters.push(ok));
  }

  /**
   * Switches the outputs (each true or false; left out: as it is). Resolves once the loop has
   * done it, with the status of each.
   */
  setOutputs({ ndi, sdi, syphon }) {
    this.want = { ndi: ndi ?? this.want.ndi, sdi: sdi ?? this.want.sdi, syphon: SYPHON_PLATFORM && (syphon ?? this.want.syphon) };
    if (!this.running) return Promise.resolve();
    return new Promise((ok) => this.applyWaiters.push(ok));
  }

  /** Whether any output is on (Syphon: and watched), so the graphic's frames are wanted. */
  wantsFrames() {
    return !!(this.sender || this.deck || this.syphonWatched);
  }

  /**
   * Syphon's picture turned upside down, or not. Syphon doesn't say which way up a picture is: it
   * goes out the OpenGL way (bottom row first), as OBS and most clients expect; flipped, top row
   * first, for a client that shows it upside down. The next frame goes out the new way.
   */
  setSyphonFlip(flip) {
    this.syphonFlip = !!flip;
    this.syphonLast = null;
    this.onWake();
  }

  /** (In the loop.) Whether a Syphon client is watching now; one that's just started gets a frame drawn for it. */
  checkSyphon() {
    let watched = false;
    try {
      watched = !!this.syphon?.hasClients();
    } catch {
      // (Gone: nobody watching.)
    }
    if (watched && !this.syphonWatched) {
      this.syphonLast = null;
      this.syphonWatched = true;
      this.onWake();
    } else this.syphonWatched = watched;
    return watched;
  }

  /** A frame that's going out, into the Syphon surface too (when someone's watching, and it's new). */
  publishSyphon(frame) {
    if (!this.syphon || !this.syphonWatched || frame === this.syphonLast) return;
    try {
      this.syphon.publish(frame, WIDTH, HEIGHT, !this.syphonFlip);
      this.syphonLast = frame;
    } catch (e) {
      this.syphonError = `publishing: ${e.message}`;
    }
  }

  /** (In the loop, between frames.) Opens and closes the outputs to match what's asked for. */
  async applyOutputs() {
    const w = { ...this.want };
    // (Another device picked: close this one first, and open that one below.)
    if (this.deck && deviceKey(this.deckOpenedFor) !== deviceKey(this.deckConfig.device)) {
      this.deck.close();
      this.deck = null;
    }
    if (w.sdi && !this.deck) {
      try {
        this.deckOpenedFor = this.deckConfig.device;
        const { player, name, number } = openDeckLink({
          ...this.deckConfig,
          onTick: () => {
            this.lastTickAt = performance.now();
            const t = this.tickWaiter;
            this.tickWaiter = null;
            t?.();
          },
        });
        this.deck = player;
        this.deckName = name;
        this.deckNumber = number;
        this.deckError = null;
        this.deckPrev = null;
        this.deckStats = null;
        this.lastTickAt = performance.now();
      } catch (e) {
        this.deckError = e.message;
      }
    } else if (!w.sdi) {
      this.deck?.close();
      this.deck = null;
      this.deckError = 'off';
    }
    // (With a DeckLink device, its clock paces the frames and NDI just sends them; without one, NDI
    // keeps to its own clock. Switching SDI with NDI on starts the NDI source again that way.)
    const clocked = !this.deck;
    if (this.sender && (!w.ndi || this.senderClocked !== clocked)) {
      try {
        await this.sender.destroy?.();
      } catch {
        // (Gone anyway.)
      }
      this.sender = null;
    }
    if (w.ndi && !this.sender) {
      try {
        const grandiose = require('@stagetimerio/grandiose');
        this.grandiose = grandiose;
        this.sender = await grandiose.send({ name: this.name, clockVideo: clocked, clockAudio: false });
        this.senderClocked = clocked;
        this.sourceName = this.sender.sourcename();
        this.ndiError = null;
      } catch (e) {
        this.ndiError = e.code === 'MODULE_NOT_FOUND' ? "the NDI library isn't installed (see README.md)" : `couldn't start NDI: ${e.message}`;
        this.sender = null;
      }
    } else if (!w.ndi) this.ndiError = 'off';
    if (w.syphon && !this.syphon) {
      try {
        this.syphon = openSyphon(this.name);
        this.syphonError = null;
        this.syphonLast = null;
      } catch (e) {
        this.syphonError = e.message;
        this.syphon = null;
      }
    } else if (!w.syphon && this.syphon) {
      try {
        this.syphon.stop();
      } catch {
        // (Gone anyway.)
      }
      this.syphon = null;
      this.syphonWatched = false;
      this.syphonError = 'off';
    } else if (!w.syphon) this.syphonError = SYPHON_PLATFORM ? 'off' : 'Syphon is macOS only';
    this.applied = w;
    // (Nothing out: no frames kept. Back on: the next frame drawn goes out first.)
    if (!this.sender && !this.deck && !this.syphon) this.queue = [];
    const waiters = this.applyWaiters;
    this.applyWaiters = [];
    waiters.forEach((ok) => ok());
  }

  /** A new frame from the graphic (BGRA, WIDTH × HEIGHT). */
  frame(bgra) {
    this.queue.push(bgra);
    if (this.queue.length > MAX_QUEUE) {
      this.queue.shift();
      this.counts.drops++;
    }
    this.counts.paints++;
    this.lastPaintAt = performance.now();
  }

  /** The frame to send now. */
  next() {
    // (Two frames waiting: a run of them, under way. Or one, with nothing after it for a frame and
    // a half: a single change, e.g. an overlay turned on or a step while paused; it goes now.)
    const frameMs = (1000 * this.rate[1]) / this.rate[0];
    if (this.priming && (this.queue.length >= START_QUEUE || (this.queue.length && performance.now() - this.lastPaintAt > 1.5 * frameMs))) this.priming = false;
    if (!this.priming && this.queue.length) {
      this.last = this.queue.shift();
      return this.last;
    }
    // (Nothing new: wait for two again. While the page is drawing, that's a frame shown twice.)
    this.priming = true;
    if (this.last && performance.now() - this.lastPaintAt < 100) this.counts.repeats++;
    // (The very first frame: no slack to wait for.)
    if (!this.last && this.queue.length) this.last = this.queue.shift();
    return this.last;
  }

  /** Until the DeckLink device has shown another frame (or `ms` passes). */
  deckTick(ms) {
    return new Promise((ok) => {
      const t = setTimeout(() => {
        this.tickWaiter = null;
        ok();
      }, ms);
      this.tickWaiter = () => {
        clearTimeout(t);
        ok();
      };
    });
  }

  async sendNdi(frame, frameMs) {
    if (!this.sender) return;
    try {
      await this.sender.video({
        xres: WIDTH,
        yres: HEIGHT,
        frameRateN: this.rate[0],
        frameRateD: this.rate[1],
        // (No alpha: the output is full screen.)
        fourCC: this.grandiose.FOURCC_BGRX,
        pictureAspectRatio: 16 / 9,
        frameFormatType: this.grandiose.FORMAT_TYPE_PROGRESSIVE,
        lineStrideBytes: WIDTH * 4,
        data: frame,
      });
    } catch (e) {
      this.ndiError = `sending: ${e.message}`;
      await sleep(frameMs);
    }
  }

  async loop() {
    const frameMs = (1000 * this.rate[1]) / this.rate[0];
    // (Without NDI's or the DeckLink device's clock: a timer that keeps to the frame rate over time, not frame by frame.)
    let due = performance.now();
    while (this.running) {
      if (!this.applied || this.applied.ndi !== this.want.ndi || this.applied.sdi !== this.want.sdi || this.applied.syphon !== this.want.syphon || this.applyWaiters.length) {
        await this.applyOutputs();
        due = performance.now();
      }
      this.checkSyphon();
      if (!this.sender && !this.deck && !this.syphonWatched) {
        // (Every output off, or only Syphon with nobody watching: nothing to do until that changes.)
        this.queue = [];
        await sleep(frameMs);
        this.tickStats();
        continue;
      }
      const deckAlive = this.deck && performance.now() - this.lastTickAt < DECK_SILENT_MS;
      if (deckAlive) {
        // The device has shown a frame: top up what's waiting for it, and send the same to NDI.
        await this.deckTick(3 * frameMs);
        let n = 0;
        while (this.running && this.deck && this.deck.pending() < DECK_AHEAD && n++ < DECK_AHEAD) {
          const frame = this.next();
          if (!frame || !this.deck.push(frame)) break;
          const t0 = performance.now();
          this.publishSyphon(frame);
          await this.sendNdi(frame, frameMs);
          this.counts.sent++;
          if (performance.now() - t0 > 2 * frameMs) this.counts.late++;
        }
        due = performance.now();
        this.tickStats();
        continue;
      }
      const frame = this.next();
      if (!frame) {
        await sleep(10);
        due = performance.now();
        continue;
      }
      const t0 = performance.now();
      this.publishSyphon(frame);
      if (this.sender && !this.deck) await this.sendNdi(frame, frameMs);
      else {
        // (No clock to keep to (only Syphon on), or the DeckLink device has gone quiet: the timer
        // paces it, and the device gets frames as they go.)
        if (this.deck) {
          this.deck.push(frame);
          await this.sendNdi(frame, frameMs);
        }
        due += frameMs;
        const wait = due - performance.now();
        if (wait > 0) await sleep(wait);
        else if (wait < -10 * frameMs) due = performance.now(); // (fell well behind: start over)
      }
      this.counts.sent++;
      if (performance.now() - t0 > 2 * frameMs) this.counts.late++;
      this.tickStats();
    }
  }

  tickStats() {
    const now = Date.now();
    if (now - this.lastStatsAt < 1000) return;
    const s = (now - this.lastStatsAt) / 1000;
    this.stats = { paintsPerS: Math.round(this.counts.paints / s), sentPerS: Math.round((this.counts.sent / s) * 100) / 100, lateFrames: this.counts.late, repeats: this.counts.repeats, drops: this.counts.drops };
    this.counts = { paints: 0, sent: 0, late: 0, repeats: 0, drops: 0 };
    this.lastStatsAt = now;
    if (this.deck) {
      // (The device's counts are totals: per second here, as the rest.)
      const d = this.deck.stats();
      const p = this.deckPrev ?? d;
      this.deckRates = { late: d.late - p.late, dropped: d.dropped - p.dropped, repeats: d.repeats - p.repeats };
      this.deckPrev = d;
      this.deckStats = d;
    }
  }

  status() {
    let connections = 0;
    let tally = { program: false, preview: false };
    if (this.sender) {
      try {
        connections = this.sender.connections();
        const t = this.sender.tally();
        tally = { program: !!t.on_program, preview: !!t.on_preview };
      } catch {
        // (Reported by the send loop.)
      }
    }
    return {
      /** The outputs switched on (each may still have failed to start: see its error). */
      outputs: { ...this.want },
      ndi: !!this.sender,
      error: this.ndiError,
      name: this.sourceName ?? this.name,
      fps: `${(this.rate[0] / this.rate[1]).toFixed(2)}`,
      connections,
      tally,
      ...this.stats,
      decklink: this.deckStatus(),
      syphon: this.syphonStatus(),
    };
  }

  /** The Syphon output, for the status: there to have at all (macOS), on, watched, and why not. */
  syphonStatus() {
    return {
      available: SYPHON_PLATFORM,
      on: !!this.syphon,
      requested: this.want.syphon,
      error: this.syphonError,
      name: this.name,
      watched: this.syphonWatched,
      flip: this.syphonFlip,
    };
  }

  /** The DeckLink output, for the status: on or not (and why), and how it's doing. */
  deckStatus() {
    // (device: the setting, auto for the first free one; name and number: the device in use.)
    const device = isAutoDevice(this.deckConfig.device) ? 'auto' : this.deckConfig.device;
    if (!this.deck) return { on: false, requested: this.want.sdi, error: this.deckError, mode: this.deckConfig.mode, device };
    const d = this.deckStats ?? this.deck.stats();
    const silent = performance.now() - this.lastTickAt > DECK_SILENT_MS;
    return {
      on: true,
      requested: true,
      error: silent ? 'the device has stopped taking frames (unplugged, or in use by another app?)' : null,
      name: this.deckName,
      number: this.deckNumber,
      device,
      mode: this.deckConfig.mode,
      pixelFormat: d.pixelFormat,
      buffered: d.buffered,
      // (Per second: frames the device showed late or dropped, and frames shown again for want of a new one.)
      late: this.deckRates.late,
      dropped: this.deckRates.dropped,
      repeats: this.deckRates.repeats,
      referenceLocked: d.referenceLocked,
    };
  }

  /** The frame last sent (BGRA), for a snapshot. */
  current() {
    return this.last;
  }

  async stop() {
    this.running = false;
    this.deck?.close();
    this.deck = null;
    try {
      this.syphon?.stop();
    } catch {
      // (Gone anyway.)
    }
    this.syphon = null;
    await this.sender?.destroy?.();
    this.sender = null;
  }
}
