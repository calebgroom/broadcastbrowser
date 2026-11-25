#!/bin/sh
# Builds the addon and the stand-in device, then tests the addon against it: BGRA, YUV (a device
# that won't take BGRA), 1080i59.94, a device in use, and a card with several ports. Linux (the
# cloud), not the Mac.
set -e
cd "$(dirname "$0")/.."
test/build-fake.sh >/dev/null
[ -n "$NODEDIR" ] && export npm_config_nodedir="$NODEDIR"
node build.mjs
export LD_LIBRARY_PATH="$PWD/test/build"
LOG=$(mktemp)
echo "== BGRA, 1080p59.94"; FAKE_DECKLINK_LOG=$LOG node test/addon.test.mjs
echo "== YUV only, 1080p59.94"; FAKE_DECKLINK_FORMAT=yuv node test/addon.test.mjs
echo "== 1080i59.94"; MODE=Hi59 FAKE_DECKLINK_LOG=$LOG node test/addon.test.mjs
echo "== in use"; FAKE_DECKLINK_BUSY=1 node -e "
const d = require('./build/Release/decklink.node');
try { new d.Player(0, 'Hp59', () => {}); console.log('FAIL: opened'); process.exit(1); } catch (e) { console.log('ok  ', e.message); }"
rm -f "$LOG"
echo "== a card with 4 ports: 1 in use (and says so), 3 in use (and doesn't), 4 inactive"
FAKE_DECKLINK_PORTS=4 FAKE_DECKLINK_BUSY=1 FAKE_DECKLINK_HIDDEN_BUSY=3 FAKE_DECKLINK_INACTIVE=4 node test/ports.test.mjs
