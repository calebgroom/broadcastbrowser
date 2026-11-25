// The addon against the stand-in device (fake.cc): node decklink/test/addon.test.mjs
// (run by run-tests.sh, which builds both and sets LD_LIBRARY_PATH).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const d = require('../build/Release/decklink.node');
const log = process.env.FAKE_DECKLINK_LOG;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const W = 1920, H = 1080;
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

console.log('version', d.apiVersion());
console.log('list', JSON.stringify(d.list(['Hp59', 'Hi59', 'Hp29'])));

const mode = process.env.MODE ?? 'Hp59';
let n = 0;
const frames = [];
for (let i = 0; i < 6; i++) frames.push(Buffer.alloc(W * H * 4));
let p;
const push = () => {
  while (p.pending() < 2) {
    const b = frames[n % frames.length];
    b.writeUInt32LE(++n, 0);
    p.push(b);
  }
};
let ticks = 0;
p = new d.Player(0, mode, () => { ticks++; push(); });
push();
await sleep(2000);
const s1 = p.stats();
console.log('after 2 s', JSON.stringify(s1));
// A stall: the app's main thread busy for 150 ms (9 frames at 59.94).
const t0 = Date.now(); while (Date.now() - t0 < 150) {}
await sleep(1000);
const s2 = p.stats();
console.log('after the stall', JSON.stringify(s2));
p.close();
check(s1.frameRate > 29 , `frame rate ${s1.frameRate}`);
check(Math.abs(ticks - (3 + 0.15) * s1.frameRate) < 0.1 * s1.frameRate * 3, `ticks ${ticks} in ~3.15 s`);
check(s1.late === 0 && s1.dropped === 0, 'no late or dropped frames before the stall');
check(s1.repeats <= 3, `repeats before the stall: ${s1.repeats}`);
check(s2.catchUps >= 0, `catch-ups after the stall: ${s2.catchUps}`);
if (log && s1.pixelFormat === 'bgra') {
  const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' '));
  // (Pushed frames are numbered from 1; the preroll is black.)
  const shown = lines.filter((l) => l[2] === 'ok').map((l) => Number(l[1])).filter((v) => v < 1e6);
  let back = 0, same = 0;
  for (let i = 1; i < shown.length; i++) { if (shown[i] < shown[i - 1]) back++; if (shown[i] === shown[i - 1]) same++; }
  console.log(`shown ${shown.length}, repeated ${same}, out of order ${back}, empty slots ${lines.filter((l) => l[2] === 'empty').length}, first ${shown.slice(0, 8).join(',')}`);
  check(back === 0, 'frames shown in order');
  const before = lines.filter((l) => Number(l[0]) < 110);
  check(before.every((l) => l[2] === 'ok'), 'every slot filled before the stall');
}
// Reopen after close, and the errors.
const again = new d.Player(0, mode, () => {});
again.close();
check(true, 'reopened and closed');
try { new d.Player(3, mode, () => {}); check(false, 'no device 4'); } catch (e) { check(/no DeckLink device 4/.test(e.message), `error: ${e.message}`); }
try { new d.Player(0, 'Hp24', () => {}); check(false, 'unsupported mode'); } catch (e) { check(/can't output/.test(e.message), `error: ${e.message}`); }
try { p.push(Buffer.alloc(10)); check(true, 'push after close is ignored'); } catch (e) { check(false, `push after close: ${e.message}`); }
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
