// A card with several output ports (each a device of its own), against the stand-in device:
// src/decklink.js picks the first free one, or the one asked for, and says why one can't be used.
// run-tests.sh runs it with FAKE_DECKLINK_PORTS=4 FAKE_DECKLINK_BUSY=1 FAKE_DECKLINK_HIDDEN_BUSY=3
// FAKE_DECKLINK_INACTIVE=4: port 1 in use by another app, port 3 in use without saying so, port 4
// inactive in the card's profile.
import { listDeckLinks, openDeckLink } from '../../src/decklink.js';

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const mode = '1080p59.94';
const onTick = () => {};
const err = (device) => { try { openDeckLink({ device, mode, onTick }).player.close(); return null; } catch (e) { return e.message; } };

const { devices } = listDeckLinks(mode);
check(devices.length === 4, `4 ports: ${devices.map((d) => d.name).join(', ')}`);
check(devices[0].busy && !devices[1].busy, 'port 1 says it is in use');
check(!devices[3].active && devices[2].active, 'port 4 is inactive');

for (const auto of ['', 'on', '1', 'auto']) {
  const o = openDeckLink({ device: auto, mode, onTick });
  check(o.number === 2, `"${auto}": the first free port, ${o.name}`);
  // (Port 2 in use by this app now: the next free one is 3, which won't start, so none.)
  check(/using it/.test(err(auto) ?? ''), `with port 2 taken: ${err(auto)}`);
  o.player.close();
}
// ("1" is the first free one, as --decklink=1 always was: port 1 by its name.)
check(/in use by another app: pick another port/.test(err('Duo 2 (1)')), `port 1: ${err('Duo 2 (1)')}`);
check(/inactive|isn't active/.test(err('4')), `port 4: ${err('4')}`);
check(err('Fake DeckLink Duo 2 (2)') === null, 'port 2 by its whole name');
check(err('(2)') === null, 'port 2 by part of its name');
check(/no DeckLink device "9"/.test(err('9')), `no port 9: ${err('9')}`);
const a = openDeckLink({ device: '2', mode, onTick });
check(/is in use/.test(err('2')), `port 2 twice: ${err('2')}`);
a.player.close();
check(err('2') === null, 'port 2 again once closed');
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
