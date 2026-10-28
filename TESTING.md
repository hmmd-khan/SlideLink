# Test report

## Automated checks
Run `npm test` (25 tests). It covers:
- the original local server (`server.js`): health, sessions, offline/unsupported commands, command relay
- the online API (`lib/` + `api/index.mjs`): exact status codes and error wording of the local server, order of checks, 180 ms rate limit, 15 s helper / 10 s phone presence, 3-hour expiry, stale-command dropping, simultaneous taps, heavy concurrent traffic with no lost or duplicated commands, brute-force protection, missing-database configuration
- the real Python helper (with a stand-in for pyautogui) turning phone taps into right/left keys, and exiting clearly on an expired code

The online tests use an in-memory stand-in for Redis. They cannot prove that Vercel routing or your Upstash database work.

## After every deployment
Run `npm run smoke -- https://YOUR-SITE.vercel.app`. It walks through every endpoint on the live site and expects `0 failed`. The same script also passes against the local server (`npm start`, then `npm run smoke -- http://127.0.0.1:3000`), which shows both behave the same.

## Manual checks still required on your hardware
Automated tests cannot touch your phone or presentation software. Before a real presentation:
1. Open SlideLink on the laptop and create a session.
2. Start the Python helper and enter the code.
3. Open the phone remote (LAN address locally, or the site address online).
4. Tap Next and Previous; verify the helper logs the commands.
5. Start a Google Slides or PowerPoint slideshow, focus it, and confirm real slide movement.
6. Online mode: test once from mobile data to confirm the phone does not need your Wi-Fi.
7. Local mode: test firewall and Wi-Fi isolation behaviour on your network.
8. macOS: test Accessibility permission.
