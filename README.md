# Broadcast Browser

A Mac app (Electron) that shows web pages as a **1920×1080 NDI® source**, out of a **Blackmagic UltraStudio or DeckLink** device as SDI (or HDMI) if you want, and as a **Syphon** source for apps on the same Mac. The browser is fixed at 1920×1080 at 1×, whatever the screen, so a page lays out exactly as it will on air. It works like a vision mixer: pages are loaded into a **preview**, checked there, and **taken** to **program** (on air). It's driven from a control window (an address bar, favorites, the two monitors) and an HTTP API, for Bitfocus Companion and Stream Deck.

```
 go / favorite ──▶ preview browser ──┐ take (swap)
                                     ▼
                  program browser (1920×1080) ──frames──┬─▶ NDI ──▶ vMix / ATEM / TriCaster
                      ▲                                 ├─▶ UltraStudio ──SDI──▶ switcher
                      │                                 └─▶ Syphon ──▶ OBS, Resolume… on this Mac
   control window ────┤
   Companion (HTTP :8793) ┘
```

The video outputs are their own parts, apart from the browser: NDI through the NDI SDK (`src/ndi.js`), SDI through Blackmagic's DeckLink SDK (`src/decklink.js` and the native addon in `decklink/`), and Syphon (`src/syphon.js`, `syphon/`). Any page the browser shows goes out the same way.

## Setup (once)

You need Node.js 22.12 or later, pnpm, and Xcode's command-line tools (`xcode-select --install`), which compile the NDI, DeckLink and Syphon addons. For SDI output you also need Blackmagic **Desktop Video** (14.4 or later); on Apple Silicon, allow its system extension when macOS asks, and restart.

```sh
git clone https://github.com/calebgroom/broadcastbrowser.git
cd broadcastbrowser
pnpm install
```

`pnpm install` downloads the NDI SDK and compiles the NDI addon (optional: without it the app runs and says why), and compiles the DeckLink addon (`[decklink] built`; `pnpm run decklink` builds it again and shows why not) and the Syphon addon (`[syphon] built`; `pnpm run syphon` likewise). The first `pnpm start` downloads Electron itself.

## Running

```sh
pnpm start                                           # every output off until you turn it on
pnpm start -- --output=ndi                           # NDI on from the start
pnpm start -- --output=both --decklink=2 --decklink-mode=1080p60   # NDI and SDI: the second device, 1080p60
pnpm start -- --url=https://example.com              # that page on air, in a tab beside the ones open last time
```

It opens the last page shown; the first time, home (black, until you set one).

### Outputs

There are two feeds, each with its own NDI, SDI and Syphon outputs:

- **Program**: what's on air, with hold while loading, freeze and black.
- **Preview**: the page in the preview, as it is (none of those: they're the program's). For a producer to watch what's coming, on a switcher's multiview or a monitor of their own, and call the take.

**Every output is off when the app starts**, unless you've said otherwise with a setting (`--output`, `--ndi`, `--syphon`, `--preview-ndi`, `--preview-sdi`, `--preview-syphon`: below). Nothing goes out until you turn it on: the **NDI**, **SDI** and **Syphon** switches at the right of each monitor's title are that feed's (or **Output → Program / Preview**, or `/outputs` in the control API). The switches aren't remembered: the next start is off again (or as the settings say). While nothing of the program goes out, its tag says **NOT ON AIR** (grey) instead of **ON AIR**, and while no output of either feed is on, the header says **No outputs on** (click it to see the switches). The first time the app starts, the program's switches are outlined until an output has been turned on.

Each feed's SDI goes out of its own port: the program's the first free one, the preview's the second, until you pick others (**Output → Program → SDI Port**, **Output → Preview → SDI Port**). One port carries one feed: the other feed's port is marked in the list, and can't be picked. Both feeds go out in the same format (`--decklink-mode`), as a switcher wants all its inputs. With the preview's outputs on, the preview's page draws at the full frame rate, as the program's does: twice the work for the Mac, so check it copes (the header's **drawn/s** and **ms/frame**).

The sources are named for their feed: in an ATEM or vMix, **Add Input → NDI**, `<this Mac's name> (Broadcast Browser Program)` and `(Broadcast Browser Preview)`; in OBS on the same Mac, **Sources → + → Syphon Client**, **Broadcast Browser Program** or **Preview**.

## Tabs, preview and program

Every page is a **tab**: a page of its own, loaded once and kept as it is (the article you clicked through to, scrolled to the right place, logged in) for as long as the tab is open. Two of them are on a vision mixer's two buses:

- **Preview** (green): the tab being checked and worked on. The address bar goes to its page. Click through a cookie banner or a login with **Interact**, scroll to the right place, zoom it. Nothing in the preview is on air.
- **Program** (red): on air. Every frame it draws goes to the outputs.

**TAKE** (Cmd+Return) swaps them: the preview goes on air, and what was on air comes back to the preview, ready to take back. Logins and cookies are shared by every tab, so a page you logged into in the preview is still logged in once it's on air.

The other tabs are **open in the background**, under the monitors (**Open Tabs**), each with a picture of it, new every 5 seconds (**Pictures**, in the Open Tabs heading: every 1, 2, 5, 10 or 30 s, or off: new only when a tab moves into or out of the preview or program; kept for next time). A new picture fades in over the one before. They keep running (a scoreboard stays current), drawing a frame a second for the picture, with their video and sound paused.

- **Click a tab** to bring it into the preview, at once and just as it was (its video plays again). The tab that was in the preview goes back to the background, also just as it was. **Shift-click**: on air (once loaded). **Cmd+1 … Cmd+9**: the first nine tabs into the preview, by their place in the row (each card shows its number: the numbers move as tabs open, close and are dragged), and **Control+Cmd+1 … 9** on air (Control, not Shift: Cmd+Shift+3, 4 and 5 are macOS's screenshot keys); the tab on air's own number does nothing. **Cmd+Option+→ / ←**: the next or previous tab into the preview.
- **A favorite** (or Home) opens in a **new tab** in the preview, so the tab you were preparing stays open. If a tab is already open on that page (not the one on air), that tab is brought into the preview instead of opening it twice. An empty tab (a new tab, or the one that takes a closed preview tab's place) is used for the next page opened, and closed rather than kept when another tab takes its place in the preview. **Black** opened as a favorite (or typed) is a tab like any other: it stays open, ready to take.
- **The address bar** goes to a page in the preview's own tab, as in any browser (`/go?url=…&newTab=true` from the API for a new one). **＋ New tab** (Cmd+T): a blank tab in the preview, with the address bar ready.
- **Close a tab** with its **×** (Cmd+W: the preview's tab; the tab beside it takes its place). The tab on air can't be closed: take another one first. **↶ Reopen closed** (Cmd+Shift+T) opens the tab closed last again, its page loaded again and scrolled to where it was (the last 20 are remembered).
- **Drag** a tab to reorder them.

Tabs are only ever closed by you. Each open tab holds its memory (a few hundred MB for a heavy site): past **8** (`--tabs-warn`) the count turns amber and Messages says so, but nothing is closed for you.

The tabs (their pages, their order, which is on air and which in the preview) are opened again at the next start; the one on air stays black until its page has loaded.

So in a show: type news.google.com, click through to the story, take it; open two favorites and take them in turn; when the producer wants the story back, it's still open in its tab: click it into the preview, and take it.

To go **straight to air**, skipping the check: Shift-click a favorite or a tab (or the keys: Control+Option+Cmd+1…9 for a favorite, Control+Cmd+1…9 for a tab), Shift+Enter in the address bar, Shift-click Home, or `take=true` in the API. The page loads into the preview and is taken once it has loaded. **Auto take** makes every page do that (a single-browser way of working).

**Hold while loading** (on by default): a page taken while it's still loading isn't put on air half drawn. The picture before stays on air until it has loaded (and settled for a moment), then it cuts to it; TAKE is amber meanwhile, and the program monitor says **HOLDING · LOADING**. The same when the page on air goes somewhere else itself (a link clicked with Interact, a redirect, ⟳ on the program). A page that fails to load stays held: the picture before stays on air, the program monitor shows why, and **Show as is** puts the failure on air (or Take, to go back). A page still loading after `hold-max` seconds (10) goes on air as it is. **Air → Take Now** (Cmd+Shift+Return, `take?now=true`) cuts at once, loaded or not.

What else can be on air instead of the program's page:

- **Freeze** (Cmd+Shift+F): the picture on air now stays on air. The program page carries on in its monitor (Interact with it, scroll it), then Freeze again (or Take) to show it.
- **Black** (Cmd+B): black on air. Black again (or Take) to end it.

While what's on air isn't the program's page, it's shown small in the corner of the program monitor, and the monitor's frame is amber. Pages are cut to, not dissolved.

**Sound:** the outputs are picture only. The page on air is muted unless you turn **Muted** off (it then plays out of this Mac's speakers, not the outputs); the preview is always muted.

**Zoom and sites:** Chromium keeps one zoom per site, shared by every page from that site, and the two browsers share one session (for the logins). So when the preview shows a page from the same site as the page on air, zooming the preview would zoom the air: it's refused (zoom it on air, with the program monitor's zoom, or after the take), and a favorite's zoom isn't put on if its site is on air at another zoom (Messages says so).

## Sign-ins

The pages share one browsing session, kept between starts: sign in to a site once (in the preview, with **Interact**) and it stays signed in, on air too. That's the point, for a scoreboard or a dashboard behind a login, but it means **a page on air shows whatever account it's signed in to**, as it would in your own browser. To sign out:

- **File → Sign Out of the Preview's Site**: that site's cookies (and its parent domain's, where sign-ins usually are: `.example.com` for `www.example.com`), and its stored data. Other sites stay signed in.
- **File → Sign Out of Every Site…** (asks first): every cookie, sign-in and stored datum, and the cache.
- From the control API: `/signout` (the preview's site), `/signout?target=program`, `/signout?url=example.com`, `/signout?all=true`.

A page already open keeps what it shows until it's loaded again (⟳): signing out never changes what's on air by itself.

**Not keeping sign-ins at all** (`--keep-signins=0`, or `"keep-signins": "0"` in the settings file): the session is in memory only, so every start begins signed out of everything, and nothing is saved for the next. Turning it off also wipes what earlier starts kept. For a Mac that's shared, rented or lent.

## Ad blocking (optional)

Two switches, both off to start with, with the other controls under the monitors (kept for next time):

- **Block ads**: ads and trackers (the lists uBlock Origin uses: EasyList, EasyPrivacy and its own). Their requests are cancelled, and what's left of them on the page (empty boxes, "Advertisement" labels) is hidden. Pages are lighter too, with several tabs running.
- **Hide cookie banners**: cookie notices and other pop-ups (EasyList Cookie, uBlock Origin's annoyances): the consent dialogs otherwise cleared with Interact before every take.

They apply to every tab, as pages load: switching one doesn't change a page already up (on air above all), only its next requests and the next page. **⟳** the preview to apply it there. Each monitor says how much has been blocked on its page (**37 blocked**), and so does each tab's card.

**Allow ads here** (under either monitor) leaves that page's site alone, from its next page load: for a site that won't work with an ad blocker (a paywall that detects it, a video player, a login). It's kept for next time; **Block ads here** takes it off the list. (A site allowed covers its subdomains: allowing `example.com` allows `video.example.com`.)

The filter lists are fetched the first time a switch is on (a second or two: the switch says **loading…**), kept in the app's folder, and fetched again once a day in the background; a start with no network uses the copy kept. With no copy and no network, the switch says **no lists**, Messages says why, and it tries again every 10 minutes.

It isn't a guarantee: most news, stats and scores sites come out clean, but sites that work hard to show ads (video sites above all) are a moving target. And showing someone else's page on air, with its ads or without, is a matter of rights and their terms: the switch is yours to use.

(It's Ghostery's ad blocker, `@ghostery/adblocker-electron`, MPL-2.0: `src/adblock.js`.)

## The control window

**Top: the preview's address bar.** Type an address and Enter (Cmd+L gets you there): `example.com` (https), `10.0.0.5:8080/gfx`, `localhost:3000`, `studio.local`, or a computer's name with a port or a slash, `graphics-pc:8080` or `graphics-pc/` (http: a computer on the network), `/Users/me/page.html` or `~/page.html` (a web page on this Mac: only `.html` and `.htm` files, never other kinds of file or a folder's listing, from here, the API, a favorite or a page's links; the page's own images, styles and scripts load as usual). Anything else is searched for on Google, as in Chrome: words (`big ten standings`), a single word with no dot (`weather`; so `graphics-pc` alone is a search: add the slash), anything with a space. Start with `?` to search for something that looks like an address (`?node.js`). Shift+Enter: straight to air. ◀ ▶ (Cmd+[ and Cmd+]), ⟳ (Cmd+R; Shift-click or Cmd+Shift+R: not from the cache; ✕ while loading stops it), ⌂ (Cmd+Shift+H).

**The monitors:** the preview on the left, the program (on air) on the right, each with its page's title and its own tools below it: **Scroll** ⇞ ⇟ ⤒ (a screen at a time, smoothly, and to the top), **Zoom** − 100% + (100% sets it back), and on the program, ⟳ (reload the page on air: held until it's loaded). Page Up / Page Down and ↑ ↓ (Shift: further) scroll the page on air when you're not typing; with Alt, the preview's.

**Room for the monitors:** drag the bar above **Open Tabs** to give the tabs more or less height; the monitors take the rest, as large as fits at 16:9. The monitors are usually limited by width (two side by side), so to make them larger, fold the favorites column away with **⟨** (it becomes a strip of numbered buttons; **⟩** brings it back), then drag the tabs down. The bar stops where the monitors can't grow any more, and never squeezes them below about 200 px high. Double-click the bar: the tabs as small as they go, or back. Both are kept for next time.

**Left: favorites.** Click one to open it in the preview (in a new tab, or the tab already on it); **Shift-click** to put it on air once it's loaded. **Cmd+Option+1 … 9** and **Control+Option+Cmd+1 … 9** do the same for the first nine (the **Favorites** menu): a favorite keeps its number, so these are the ones to learn by heart. The one on air is marked red, the one in the preview green.

- **＋ Preview's page** (Cmd+D in the menu: straight away) adds the page in the preview, with its title and its zoom; change the name or address first in the form.
- **✎** changes one (name, address, zoom) or deletes it. A favorite's zoom is put on with it: a page made for a smaller screen can be 150% on air.
- Drag one to reorder.
- **Home** is above them (Shift-click: on air); **Set** makes the preview's page home (also **Preview → Set This Page as Home**).

The first time there are two: **Test Pattern** (`app://pages/test.html`: colour bars, the picture's exact edges, a bar sweeping across once a second and a frame counter, to check an output end to end and that motion is smooth) and **Black**.

**Below the monitors:**

| | |
| --- | --- |
| **TAKE** | The preview on air (Cmd+Return). Amber while the page taken is loading |
| **Show as is** | (While the air is held for a loading or failed page.) The program's page on air as it is |
| **Freeze**, **Black** | What's on air (above) |
| **Auto take** | Every page loaded goes on air once it's loaded |
| **Hold while loading** | Above. On by default |
| **Interact** | The monitors are their pages: click, scroll and type into either. Esc twice (or Interact again) to stop. Cmd shortcuts stay the app's. What you do in the program's is on air, unless it's frozen |
| **Scrollbars** | Off by default: nothing on air the audience doesn't need |
| **Muted** | The sound of the page on air |

Problems appear under **Messages**, which opens by itself when there's a new one. The NDI, SDI and Syphon switches by each monitor turn that feed's outputs on and off, and show how they're doing. A grey dot: off. Green: working (**NDI · 2**: two receivers; **SDI · 2**: going out of port 2). Amber: on, but not working (hover to see why). **NDI** turns red while a switcher has that source on program. Hover over any of them for the detail.

The pages run in a browser session of their own (shared by every tab): cookies and logins are kept between starts (see "Sign-ins"). They see Chrome's user agent. A page's pop-ups and links to a new window open in the same tab; `alert()`, `confirm()` and `prompt()` are answered without showing anything; a page can't ask "leave this page?"; camera, microphone, location and notifications are refused. A video page plays without a click. **View → Preview Developer Tools** and **Program Developer Tools** open Chrome's tools on either page.

At start-up the tabs open last time are opened again (the first time: home on air and a blank preview). The program is black until its page has loaded.

The **Tabs** menu: **New Tab** (Cmd+T), **Close the Preview's Tab** (Cmd+W), **Reopen Closed Tab** (Cmd+Shift+T), **Next / Previous Tab into Preview** (Cmd+Option+→ / ←), and the open tabs themselves, by name, with their numbers (Cmd+1…9). Cmd+W never closes the window (closing it quits the app): Cmd+Q to quit.

### Keyboard shortcuts

| Keys | |
| --- | --- |
| Cmd+1 … 9 | The nth open tab into the preview (Control+Cmd+1 … 9: on air) |
| Cmd+Option+1 … 9 | The nth favorite into the preview, in a new tab or the one already on it (Control+Option+Cmd+1 … 9: on air) |
| Cmd+Option+→ / ← | The next / previous tab into the preview |
| Cmd+Return | Take (Cmd+Shift+Return: Take Now, not waiting for the page to load) |
| Cmd+Shift+F · Cmd+B | Freeze · Black |
| Cmd+L | The address bar (Shift+Enter there: on air) |
| Cmd+T · Cmd+W · Cmd+Shift+T | New tab · close the preview's tab · reopen the tab closed last |
| Cmd+[ · Cmd+] · Cmd+R · Cmd+Shift+H | The preview's Back · Forward · Reload · Home |
| Cmd+= · Cmd+- · Cmd+0 | The preview's zoom |
| Cmd+D | Add the preview's page to the favorites |
| Page Up / Down, ↑ ↓ | Scroll the page on air (with Option: the preview's) |

## Control API (for Companion)

The app listens on port **8793** (`--port` for another), and **at first, on this Mac only**: Companion on the same Mac can reach it, nothing else can. To let Companion on another computer reach it, choose where it listens in **File → Control API → Listen On**:

- **This Mac Only** (the default).
- **All Networks**: every network the Mac is on.
- **One network**, by its interface (`en0`, the Mac's address on it shown beside it): the API follows the Mac's address on that network if it changes, and stays off the others (a venue's guest Wi-Fi, say). If that network isn't connected, it listens on this Mac only until it is.

The choice takes effect at once (anything connected reconnects to the new address) and is kept for the next start. The header shows the address, and **(this Mac only)** while it is. (`--api-host=localhost`, `all`, `en0` or an address sets it for one start, over the saved choice.)

**Every request needs the API token.** The app makes one, at random, the first time it starts (it's `api-token` in the settings file). **File → Control API → Copy Control API Address** copies the address with the token in it (`http://10.0.0.5:8793/?token=…`); **File → Control API → Copy API Token**, the token alone. Send it either way:

- in the query string: `/take?token=…`, `/go?url=example.com&token=…`. This works in any Companion HTTP action;
- or as a header, `Authorization: Bearer …` (in Companion's HTTP actions, the header field: `{"Authorization": "Bearer …"}`), which keeps it out of the addresses;
- or **signed**, as the Companion module does: the token never crosses the network, and a request someone overhears can't be sent again. Three headers: `X-BB-Time` (now, in milliseconds since 1970: within a minute of the Mac's clock), `X-BB-Nonce` (16 to 64 random letters, digits, `-` or `_`, never used twice) and `X-BB-Signature`: the hex HMAC-SHA256, keyed with the token, of `BB1`, the method, the path and query as sent, `X-BB-Time`, `X-BB-Nonce` and the hex SHA-256 of the body (of nothing, for a GET), one per line. Every `401` carries the Mac's time in `X-BB-Time`, so a client whose clock is off can allow for it. `src/http.js` has the details.

Without it, or with the wrong one, the answer is `401`. **File → Control API → New API Token…** makes a new one, and the old one stops working at once (for a token that's been shared too widely). Treat it like a password: anyone who has it can put anything on air, and see the pages open in the app (and so whatever sites it's signed in to). The API also answers no web page in a browser (no CORS), so a site you visit can't use it from there, token or not. On a closed production network you can turn the token off, `--api-token=off` (the app says so in Messages each start).

Send a GET (or POST, arguments as a JSON body) to:

Pages load into the **preview**; `take=true` puts one on air once it's loaded (without it: as **Auto take** is set). Commands on a page act on the preview unless `target=program` (the page on air).

| Request | |
| --- | --- |
| `/status` | The app's `version`; what's on air (`air.state`: `live`, `loading`, `frozen` or `black`), the `preview` and `program` pages (address, title, loading, back/forward, error, zoom), the `tabs`, the look, home, the favorites, the outputs, recent messages |
| `/frame.png` | The frame on air now, full size (also when no output is on) |
| `/preview.png` | The preview's page as it is now, full size |
| `/tab-picture?n=3&width=72&height=40` · `?id=…` | A tab's latest picture (its card's, new every few seconds: **thumbs**), as a PNG that fits in that size (8 to 640 pixels; 72 × 40 if left out). `404` until it has one. The Companion module's tab buttons show it |
| `/go?url=example.com` · `&take=true` · `&zoom=150` · `&newTab=true` | The preview's tab to a page (as the address bar: words, `url=big%20ten%20standings`, are a Google search); on air once loaded; with a zoom; in a new tab instead |
| `/go?url=…&match=example.com` · `&n=3` · `&id=…` | That tab to a page, wherever it is: one in the background loads it and stays there; the preview's, as above; **the one on air changes on air** (with Hold While Loading on, the picture before stays on air until the page has loaded). `match`: the first tab with that text in its address or title (any case), so a button keeps working however the tabs are moved. `take` only with the preview's tab |
| `/favorite?n=2` · `/favorite?name=scores` · `/favorite?id=…` · `&take=true` | A favorite into the preview, in a new tab (or the tab already open on it): the nth, the one with that name (or with that in its name), or by id; on air once loaded |
| `/home` · `/home?take=true` | Home, as a favorite |
| `/tabs` | The tabs, in order: `[{ n, id, url, title, state, loading, error, picture }]`; `state`: `program`, `preview` or `open`; `picture`: its picture's version, a new number each time there's a new one (0: none yet) |
| `/tab?n=3` · `/tab?id=…` · `/tab?match=…` · `&take=true` | A tab into the preview, just as it was (the one there goes to the background); on air (once loaded). `match`, here and in `/tab-close`, `/tab-picture` and `/tab-move`: as `/go`'s |
| `/tab-next` · `/tab-next?by=-1` | The next or previous tab into the preview (past the one on air) |
| `/tab-new` · `/tab-new?url=…&take=true` | A new tab in the preview: blank, or with a page |
| `/tab-close` · `/tab-close?n=3` | Close the preview's tab, or that one (not the one on air) |
| `/tab-reopen` · `&take=true` | The tab closed last, open again where it was scrolled to |
| `/tab-move?n=3&to=1` · `/tab-move?id=…&by=-1` | Reorder: a tab to a place, or left / right |
| `/take` · `/take?now=true` | The preview on air, the program into the preview. A page still loading is cut to once it's loaded; `now`: at once |
| `/live` | The program's page on air as it is: not held, frozen or black |
| `/freeze` · `/freeze?on=true` · `/black` · `/black?on=false` | What's on air (without `on`: the other way) |
| `/back` · `/forward` · `/reload` · `/reload?hard=true` · `/stop` | The preview's page; `&target=program` for the page on air (a reload on air is held till it's loaded) |
| `/scroll?screens=1` · `/scroll?by=-300` · `/top` | Scroll the preview's page (`&target=program`: the page on air; `&smooth=false` to jump) |
| `/zoom?by=1` · `/zoom?factor=150` · `/zoom?reset=true` | The preview's zoom (`&target=program`: on air). Refused for the preview when it's the same site as on air (see "Zoom and sites") |
| `/look?autoTake=toggle` · `/look?hold=toggle` · `/look?muted=false` · `/look?scrollbars=true` | Auto take, hold while loading, sound on air, scrollbars: each `true`, `false` or `toggle` |
| `/look?adblock=toggle` · `/look?annoyances=toggle` | Ad blocking: ads and trackers; cookie banners and pop-ups (`true`, `false` or `toggle`). `status.adblock` says which are on, ready (`loading`, `error`) and the sites allowed; each page and tab has `blocked` |
| `/adblock-allow` · `?target=program` · `?url=example.com` · `&on=false` | Ad blocking off on the preview's site (the program's, or that one), or on again (`on=false`); without `on`, the other way |
| `/look?thumbs=5` | How often the tabs' pictures are new: 1, 2, 5, 10 or 30 seconds, or 0 (`off`) |
| `/favorites` | The favorites: `[{ n, id, name, url, zoom? }]` |
| `/favorite-add` · `/favorite-add?name=Scores&url=…&zoom=1.5` | A new favorite: the preview's page (`target=program`: the page on air), or that address |
| `/favorite-update?id=…&name=…&url=…&zoom=…` | Change one (by `n` or `id`: `name` is its new name; by `name`: `newName` is). `zoom=none`: as the page is |
| `/favorite-remove?n=3` · `/favorite-move?n=3&to=1` · `/favorite-move?id=…&by=-1` | Delete one; move one to a place, or up or down |
| `/signout` · `/signout?target=program` · `/signout?url=example.com` · `/signout?all=true` | Sign out of the preview's site (the page on air's, or that address's), or of every site (see "Sign-ins") |
| `/set-home` · `/set-home?url=…` · `/set-home?target=program` | Home: the preview's page, that address, or the page on air |
| `/outputs?mode=both` · `/outputs?ndi=toggle` · `/outputs?sdi=false` · `/outputs?device=3` · `&feed=preview` | A feed's video outputs: the program's (or with `feed=preview`, the preview's). `mode` `both` (NDI and SDI), `ndi`, `sdi` or `off` (everything off, Syphon too); or each of `ndi`, `sdi`, `syphon` on its own (`true`, `false` or `toggle`); `device`: its SDI port (`auto`, a number from 1, or part of a device's name; never the other feed's). `status.output` is the program's, `status.previewOutput` the preview's |
| `/outputs?syphon=toggle` · `/outputs?flip=toggle` | Syphon on or off; its picture flipped or not |
| `/update-check` | Look for a new version now (`status.update`: `state` idle, checking, downloading, ready, none, error or dev; `version`, `percent`). It's installed from the control window (or as the app quits), never from the API |

For a Stream Deck: one button per favorite (`/favorite?n=…`) and a TAKE button (`/take`) is the preview/program way (a favorite's button brings back its tab, if it's open, so pressing it twice doesn't open it twice); `/favorite?n=…&take=true` buttons go straight to air; `/tab-next` and `/tab-next?by=-1` step through the open tabs. `status.air.state`, `status.program.url` and `status.tabs` tell a button whether its page is on air or open.

Every answer is JSON: `{ "ok": true, "status": { ... } }` (favorites and tabs: `{ "ok": true, "favorites": [...] }`, `{ "ok": true, "tabs": [...] }`), or `{ "ok": false, "error": "..." }` with status 400. A page command answers at once, not once the page has loaded: `status.preview.loading` / `status.program.loading` and their `error` say how it's going, and `status.air.state` is `loading` while a take waits for its page. The token keeps it safe from the network, but it's plain HTTP: anyone who can watch the network's traffic can see a token sent as `?token=` or `Bearer` (not a signed request's), so keep it on the production network all the same.

**The Companion module**, [companion-module-broadcastbrowser](https://github.com/calebgroom/companion-module-broadcastbrowser) (Companion 4.3 and later), has all of this as actions, feedbacks (on air, in the preview, outputs, tally), variables and ready-made buttons, with every request signed. In Companion, **Modules → Import module package**, then its `.tgz`; add a **Broadcast Browser** connection with the Mac's address, port 8793, and the token (**File → Control API → Copy API Token**).

## Settings

Settings come from the command line, after `--`, in the environment (`BROADCAST_BROWSER_FPS=29.97`), or in the settings file (**File → Open Settings File**: `~/Library/Application Support/Broadcast Browser/settings.json`). The command line beats the environment, which beats the file.

| Setting | Default | |
| --- | --- | --- |
| `--url` | | A page on air at start-up, in a tab of its own beside the tabs open last time (command line or environment only). |
| `--home` | `app://pages/black.html` | Home (**Set** writes it in the file). |
| `--hold` | on | Hold the picture on air while the page taken (or the page on air) loads: `--hold=0` to cut straight away (the window's **Hold while loading** switches it as it runs). |
| `--tabs-warn` | `8` | More tabs open than this: the count turns amber and Messages says so (tabs are never closed for you). 0: never. |
| `--hold-max` | `10` | Seconds to hold a page that's still loading before showing it as it is (0: until it's loaded). |
| `--insecure` | | Hosts whose certificate errors are ignored, comma-separated: a graphics server on the LAN with a self-signed certificate (`--insecure=gfx.local,10.0.0.5`). The app says which host when it refuses one. |
| `--user-agent` | Chrome's | The user agent pages see. |
| `--keep-signins` | on | Sign-ins (cookies, stored data) kept between starts. `0`: in memory only, every start signed out (see "Sign-ins"). |
| `--fps` | `59.94` | Output frame rate: 59.94, 60, 50, 29.97, 30 or 25. Match the vMix project. |
| `--name` | `Broadcast Browser` | The NDI source name, and the Syphon server's. |
| `--port` | `8793` | The control API's port. |
| `--api-host` | `localhost` | Where the control API listens, for this start: `localhost` (this Mac only), `all` (every network), or one network: its interface (`en0`) or the Mac's address on it. Usually set in the app instead: **File → Control API → Listen On** (kept in the file as `api-host`). See "Control API". |
| `--api-token` | a new, random one, saved in the file | The control API's token (16 characters or more), or `off` for none (see "Control API"). **File → Control API → New API Token…** makes a new one. |
| `--output` | off | The outputs on at start-up: `both` (NDI and SDI), `ndi`, `sdi` or `off`. |
| `--ndi` | off | NDI on at start-up: `--ndi` (or `on`), or `off`. Beats `--output`. |
| `--syphon` | off | Syphon on at start-up: `--syphon` (or `on`), or `off`. `--output` leaves it as it is, except `off`. |
| `--decklink` | the first free device | The device the program's SDI/HDMI output uses once it's on: `--decklink=2`, or part of a device's name (**Output → Program → SDI Port** sets it). |
| `--preview-ndi`, `--preview-sdi`, `--preview-syphon` | off | The preview feed's outputs on at start-up: each on its own (`--preview-ndi`, or `on`), or `off`. |
| `--preview-decklink` | `2` | The device the preview's SDI output uses: a port's number, or part of a device's name (**Output → Preview → SDI Port** sets it). Never the program's. |
| `--decklink-mode` | `1080p59.94` | The SDI format (it sets the frame rate for NDI too). Match the switcher. |
| `--auto-update` | on | Look for updates at start-up and every 4 hours (they're installed only when you say, or as the app quits): `--auto-update=0` not to. **Check for Updates Automatically** in the app menu sets it. |
| `--syphon-flip` | off | Syphon's picture upside down (both feeds'), for an app that shows it so (**Output → Flip Syphon Picture** sets it). |

The file also keeps `favorites` (`[{ "id", "name", "url", "zoom"? }]`, in order: you can edit them there too, then restart), `tabs` (the tabs open, in order, and which is on air and which in the preview) and `look` (scrollbars, muted, hold, autoTake, thumbs, adblock, annoyances), `adblock-allow` (the sites ad blocking leaves alone) and `api-token` (unless you set it yourself), which the app writes itself.

## Building the app (for another Mac)

```sh
pnpm run dist                         # Apple Silicon
pnpm run dist -- --arch=universal     # any Mac: Apple Silicon and Intel in one app (about twice the size)
pnpm run dist -- --arch=x64           # Intel only
```

That makes **Broadcast Browser.app** and puts it in an installer, `release/Broadcast Browser-<version>-arm64.dmg` (`-universal.dmg`, `-x64.dmg`), and a `.zip` of the app. For a universal app, the NDI, DeckLink and Syphon addons are compiled for both kinds of Mac and joined into one file each (NDI's own library is universal already). Opening the `.dmg` shows the app and the Applications folder side by side with an arrow between them: drag one onto the other, as with any Mac app. Then eject the installer. Either kind of Mac builds either kind of app (but an Intel Mac can't run the Apple Silicon one, to try it).

With the Developer ID set up (below), the app is signed and **notarized** by Apple: on another Mac it opens like any app from the web, with no warning. The build says what it's doing (`[dist] signing: Developer ID Application: …; notarizing with the Keychain profile "developer-id"`), sends the app to Apple and waits for it (a few minutes), and at the end checks that Gatekeeper accepts it (`[dist] Gatekeeper accepts it`). `pnpm run dist -- --no-notarize` signs without sending it to Apple (quicker, to try a build: another Mac will warn); `-- --adhoc` signs ad hoc, as before.

On the other Mac: install Blackmagic **Desktop Video** for SDI, open the `.dmg` and drag **Broadcast Browser** into **Applications**, and **Allow** local network access when it asks (NDI, and pages on the LAN).

(Without a Developer ID, the build signs the app ad hoc: the first time, macOS won't open it ("can't be verified"). Open **System Settings → Privacy & Security**, and **Open Anyway** by its line, or once, in Terminal: `xattr -dr com.apple.quarantine "/Applications/Broadcast Browser.app"`.)

### Signing and notarizing (once per Mac that builds)

Nothing secret goes in the project: the certificate and the notarization password stay in this Mac's Keychain, and the build only knows the profile's name. (`.gitignore` keeps `.p12`, `.p8`, `.cer` files out of git too.) The same set-up signs any other app you build on this Mac.

1. **The certificate.** In Xcode: **Settings → Accounts**, your Apple ID, **Manage Certificates…**, **＋ → Developer ID Application**. (Only the account holder can make one.) Without Xcode: in **Keychain Access → Certificate Assistant → Request a Certificate From a Certificate Authority…**, save the request to disk; at developer.apple.com → **Certificates, Identifiers & Profiles → Certificates → ＋ → Developer ID Application** (the G2 Sub-CA), upload it, download the certificate and double-click it. Check it's there, with its private key:

   ```sh
   security find-identity -v -p codesigning
   #   1) 1A2B… "Developer ID Application: Your Name (AB12CD34EF)"
   ```

   Back it up: in Keychain Access, **My Certificates**, right-click it, **Export…** as a `.p12` with a password, kept in a password manager (not in the project). It's what another Mac needs to build, and it can't be downloaded again.

2. **Notarization.** Make an app-specific password: account.apple.com → **Sign-In and Security → App-Specific Passwords** (call it "notarytool"). Then store it in the Keychain under the profile name the build uses, `developer-id` (your Team ID is the code in brackets above, or developer.apple.com → Membership):

   ```sh
   xcrun notarytool store-credentials developer-id --apple-id you@example.com --team-id AB12CD34EF
   #   (it asks for the app-specific password, checks it with Apple, and stores it)
   ```

   (Or an App Store Connect API key instead of the password: `--key AuthKey_….p8 --key-id … --issuer …`. Another profile name: `NOTARY_PROFILE=name pnpm run dist`.)

3. `pnpm run dist`. The first time, macOS asks to let `codesign` use the certificate's key: **Always Allow**.

If notarization fails, the build shows Apple's reason; `xcrun notarytool history --keychain-profile developer-id` lists what was sent, and `xcrun notarytool log <id> --keychain-profile developer-id` says what Apple found.

### Hardening (Electron's fuses)

The packaged app has Electron's "fuses" set (`electron-builder.yml`, `electronFuses`): switches in its own binary, set before it's signed, so they can't be turned back on. Each `pnpm run dist` checks them in the app it made (and fails if they aren't as asked).

- **Off:** running the app as plain Node (`ELECTRON_RUN_AS_NODE`), `NODE_OPTIONS`, and `--inspect` (a debugger). Each would let someone with an account on the Mac run their own code as this signed app, with its permissions.
- **On:** the app's code loads only from its archive, and the archive is checked against the hash its signature covers. Sign-ins (cookies) are encrypted on disk, with a key in the Keychain.
- **file:// pages** get only what Chrome gives them (and only `.html` files open at all: "The control window").

`pnpm start` runs Electron as it comes, without them. It uses the same folder as the installed app, so once the installed app has encrypted the sign-ins, running from the project may not see them (sign in again there, or use the installed app).

### The icon

`resources/` has the app's icon and the installer's background, each as an SVG (the source) and the PNGs made from it, which are what the build uses: `icon.png` (1024 px: electron-builder makes the app's `.icns` from it) and `dmg-background.png` with `dmg-background@2x.png` (540×380 and 1080×760, for Retina). After changing an SVG, make its PNGs again:

```sh
brew install librsvg     # once
cd resources
rsvg-convert -w 1024 -h 1024 icon.svg -o icon.png
rsvg-convert -w 540 -h 380 dmg-background.svg -o dmg-background.png
rsvg-convert -w 1080 -h 760 dmg-background.svg -o dmg-background@2x.png
```

The installer window's size and where Finder puts the two icons are in `electron-builder.yml` (`dmg:`); the background's arrow and text are drawn to match them.

Running from the project (`pnpm start`), the Dock shows the icon too, but the menu bar's first menu still says **Electron**: only the built app is called Broadcast Browser there.

## Updates

The built app updates itself from this repo's GitHub releases. It looks for a new version a few seconds after it opens and every 4 hours (and **Broadcast Browser → Check for Updates…** at any time), and downloads it in the background. It **never installs by itself during a show**: the header says **Downloading update…**, then **Update 0.2.0 ready · Restart to Update**. Click it to restart into the new version (if an output is on, it asks first: the outputs stop while it restarts, and start off), or it's installed the next time you quit. **Check for Updates Automatically** (the same menu, or `--auto-update=0`) turns the checking off; Check for Updates… still works. Running from the project (`pnpm start`), there's nothing to update.

An update is only installed if it's signed with the same Developer ID as the app (so a release has to be made with `pnpm run release`, below). And only apps that already have the updater update: copies built before it (0.1.0) have to be replaced by hand once.

### Making a release

Once, on the Mac that builds:

1. **A GitHub token**, to upload releases: github.com → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**: repository access **Only select repositories: calebgroom/broadcastbrowser**, permission **Contents: Read and write**. Store it in the Keychain (it asks for the token; nothing goes in the project):

   ```sh
   security add-generic-password -a "$USER" -s github-release-token -w
   ```

   (A new token later: the same with `-U` to replace it.)

2. **The repo public**: the apps download the release with no sign-in. (github.com/calebgroom/broadcastbrowser → **Settings → General → Change visibility**.) Only what's been pushed is public: the releases hang on a tag of the first commit, so the source needn't be pushed for them (but the app's own code, `src/`, `operator/` and `pages/`, is inside every release, readable to anyone who unpacks it).

Each release:

1. A new version in `package.json` (`"version": "0.1.1"`): the apps update only to a higher one.
2. `pnpm run release`: two apps, **Apple Silicon** and **universal** (both kinds of Mac), each built, signed and notarized as `pnpm run dist` does (Apple checks each: allow 10 to 20 minutes), then uploaded to a **draft** release `v0.1.1`: each one's `.dmg` and `.zip`, and `latest-mac.yml` (what the apps read: it lists both).
3. Check them (the `.dmg`s in `release/` are the same), then on GitHub, **Releases → v0.1.1 → Edit → Publish release**. Only then do the apps find it. (A draft can be deleted instead: nothing's happened.)

Each Mac updates to its own: an Apple Silicon Mac to the Apple Silicon app (the smaller download), an Intel Mac to the universal one. For someone downloading it by hand from the release page, the **universal** `.dmg` is the one that runs on any Mac; the `arm64` one is for Apple Silicon only.

## Project layout

- `src/main.js` starts everything: the control window, the offscreen browser, the outputs, the HTTP API, the menus.
- `src/browser.js` is one tab: a page in an **offscreen** window at 1920×1080, its loading, history, scrolling and zoom, the monitors' mouse and keyboard into it, and its frames (a smaller JPEG of each to its monitor; a frame a second in the background).
- `src/graphic.js` is the switcher: the tabs (opening, closing, reopening, moving, which is in the preview and which on air), take, and what's on air (live, held while loading, frozen, black); the program's frames go to the outputs, and every tab's to its card's picture now and then.
- `src/commands.js` is everything the window and the API can ask for; `src/http.js` the API; `src/favorites.js` the favorites (and how a typed address becomes a URL); `src/config.js` the settings.
- `resources/`: the icon and the installer's background ("The icon", above).
- `src/adblock.js` is ad blocking: the filter engines (kept in the app's folder), the session's request hooks, the allow list and the counts.
- `src/updater.js` is updating (electron-updater).
- `src/site.js` serves `app://operator/` (the control window, `operator/`) and `app://pages/` (`pages/`: `black.html` and `test.html`).
- `src/ndi.js` sends the program's frames to the outputs (NDI itself, and SDI and Syphon through `src/decklink.js` and `src/syphon.js`, with their native addons in `decklink/` and `syphon/`).

## Troubleshooting

- **"NDI · the NDI library isn't installed"**: `pnpm install` didn't get the NDI SDK or build its addon. Run `pnpm install` again and look at what it says about NDI (it needs Xcode's command-line tools: `xcode-select --install`).
- **"DeckLink support isn't built"**: `pnpm run decklink` builds it again, and shows why it doesn't (usually Xcode's command-line tools).
- **"Blackmagic Desktop Video isn't installed"**: install Desktop Video (14.4 or later) from blackmagicdesign.com/support. On Apple Silicon, allow its system extension when macOS asks, and restart.
- **"… is in use by another app"**: another app (vMix, Media Express, another copy of this one), or this app's other feed, is playing out of that device. Close it there, or pick another port (**Output → Program → SDI Port**, or **Preview**).
- **"… can't output 1080p59.94"** (or another format): that device doesn't do that format. Pick one it does with `--decklink-mode`, or another device.
- **"… isn't active in the card's profile"**: on a card with several ports, Desktop Video Setup's profile decides which ones are outputs. Change it there, or pick an active port.
- **"the device has stopped taking frames"**: the device was unplugged, or another app took it. Turn SDI off and on again.
- **"Syphon support isn't built"**: `pnpm run syphon` builds it again and shows why not (usually Xcode's command-line tools).
- **Broadcast Browser isn't in an app's list of Syphon sources**: check the Syphon switch is on. Some apps only look for sources when you add one, so add it again.
- **A page stays held** (HOLDING · LOADING, with a message on the program monitor): it didn't load. The picture before is still on air. **Take** to go back to it (it's in the preview now), or **Show as is** to show the failure.
- **The Mac is slow, or short of memory**: count the open tabs (each holds its memory, and a heavy site in the background still runs): close the ones you don't need.
- **"zoom: the page on air is from the same site…"**: see "Zoom and sites". Zoom it with the program monitor's zoom, or after the take.
- **"certificate not trusted"**: add that host to `insecure`.
- **A site shows a cookie banner or wants a login**: open it in the preview, **Interact**, deal with it there, **Take**. The session remembers it for next time.
- **A page laid out for a phone or a small window**: it isn't: the browser is 1920 px wide. Zoom in (Cmd +), and save the zoom with the favorite.
- **"control API: port 8793 is in use"**: another copy is running, or use `--port`.

## About

Broadcast Browser is by **Caleb Groom**, © 2026, under the MIT License (`LICENSE`).

### Trademarks

NDI® is a registered trademark of Vizrt NDI AB. More about NDI, and its free tools: https://ndi.video/.
Blackmagic Design, DeckLink, UltraStudio and Desktop Video are trademarks of Blackmagic Design Pty. Ltd. Mac and macOS are trademarks of Apple Inc. Stream Deck is a trademark of Corsair Memory, Inc. Bitfocus Companion is a project of Bitfocus AS, Syphon of Tom Butterworth and Anton Marini, and Ghostery is a trademark of Ghostery GmbH. Other names are the trademarks of their owners. Broadcast Browser isn't affiliated with, or endorsed by, any of them: the names are used only to say what it works with.

### Third-party software

The app is built on, and ships with, other people's work, each under its own license. In full (every license text): `THIRD_PARTY_NOTICES.md`, which `pnpm run notices` makes from what's installed (`pnpm run dist` runs it; the app shows the same, as a page, in **Help → Acknowledgements**, and its license in **Help → License**). In short:

| Component | What it does here | License |
| --- | --- | --- |
| [Electron](https://github.com/electron/electron), with Chromium | The app, and the browser | MIT; Chromium's components under their own (`LICENSES.chromium.html`, inside the app) |
| NDI SDK (`libndi`), Vizrt NDI AB | NDI output | [NDI SDK License Agreement](http://ndi.link/ndisdk_license) (not open source: royalty-free, redistributable inside an app) |
| [@stagetimerio/grandiose](https://github.com/stagetimerio/grandiose), Lukas Hermann | Node's way to the NDI library | Apache-2.0 |
| DeckLink SDK, Blackmagic Design (`decklink/sdk/`) | SDI output | Blackmagic's licence at the top of each file, and the [DeckLink SDK EULA](https://www.blackmagicdesign.com/EULA/DeckLinkSDK) |
| [Syphon framework](https://github.com/Syphon/Syphon-Framework) (`syphon/vendor/`), Tom Butterworth and Anton Marini | Syphon output | BSD 2-clause (`syphon/vendor/License.txt`) |
| [@ghostery/adblocker-electron](https://github.com/ghostery/adblocker), and its parts | Ad blocking | MPL-2.0 (used unmodified; its source is at the link) |
| [electron-updater](https://github.com/electron-userland/electron-builder) | Updates | MIT |
| Their dependencies (about 100 packages) | | MIT, ISC, BSD, Apache-2.0, BlueOak-1.0.0, Python-2.0 and MPL-2.0: each listed, with its text, in `THIRD_PARTY_NOTICES.md` |

The filter lists ad blocking downloads (EasyList, EasyPrivacy, uBlock Origin's and others, copies kept in Ghostery's GitHub repository) are their maintainers', under their own licenses (mostly GPL-3.0 or CC BY-SA 3.0): they're fetched as data when ad blocking is on, not shipped in the app. Desktop Video (Blackmagic's driver) and NDI Tools are installed separately and aren't part of this app.
