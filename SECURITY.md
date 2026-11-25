# Security

Broadcast Browser is a web browser that visits any site you give it and has a network control API, so security reports are welcome and taken seriously.

## Reporting a vulnerability

**Please don't open a public issue for a security problem.** Report it privately instead:

- **GitHub:** [Report a vulnerability](https://github.com/calebgroom/broadcastbrowser/security/advisories/new) (the repository's **Security** tab → **Report a vulnerability**). Only the maintainer sees it.

Include what you can of:

- what's affected (the control API, the control window, the pages it shows, the Companion module…) and the version (**Broadcast Browser → About Broadcast Browser**);
- how to reproduce it, and what an attacker would need (to be on the same network, to have the API token, to get a page shown…);
- what it lets them do.

This is a project maintained by one person, so there's no fixed timetable, but you can expect an acknowledgement within a week, and a fix released as soon as one is ready. Once it is, you'll be credited in the release notes if you'd like to be.

## Supported versions

Only the **latest release** gets security fixes. The app updates itself (**Broadcast Browser → Check for Updates…**), so staying current is the fix for most problems. Electron, which includes Chromium, is kept up to date for the same reason: a page on air can come from anywhere.

## What's in scope

- **The control API** (`src/http.js`): getting it to act without the API token; replaying or altering a signed request; reaching it from a network it isn't set to listen on (**File → Control API → Listen On**); reading its answers from a web page in a browser.
- **Pages the app shows:** a page reaching the app itself, the control window, other tabs' contents beyond what the web allows, or files on the Mac (only `.html` files open from disk, and pages can't download).
- **The control window and the app's own windows** (`src/preload.cjs`, the IPC handlers in `src/main.js`).
- **Updates:** getting the app to install something that isn't a signed Broadcast Browser release.
- **The Companion module** ([companion-module-broadcastbrowser](https://github.com/calebgroom/companion-module-broadcastbrowser)): its handling of the token and of requests.

## What isn't a vulnerability

- **Anyone with the API token can control the app.** That's what the token is for: it can put any page on air, read what the pages show, and sign out of sites. Keep it like a password; **File → Control API → New API Token…** replaces it.
- **The API is plain HTTP.** Someone who can watch the network's traffic can see a token sent with `?token=` or `Authorization: Bearer`. The Companion module signs its requests instead, so its token never crosses the network. Keep the API on a production network, or on this Mac only (the default).
- **A page on air shows whatever its site shows,** including an account signed in to there (see "Sign-ins" in the README).
- **Someone with access to the Mac's user account,** who can read the app's settings file (and its API token) or change the app.
- Problems in Chromium itself that a current Electron fixes: they're fixed by updating (but do report it if the app's bundled Electron is behind on a known, exploited one).
