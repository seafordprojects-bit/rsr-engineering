# Kiosk punch/sync stress harness

Standing regression net for the **pay-critical** attendance path in `kiosk/index.html`.
Run it after **any** change to the kiosk before deploying — it drives the real punch and
sync-queue code in a headless browser with every external call mocked, so it can never
touch the live Supabase project.

> The RSR app itself has **no build step and no npm** (vanilla JS via CDN, GitHub Pages).
> This `tests/` folder is dev-only tooling and is **not** part of the deployed site.

## What it checks

It loads the real `kiosk/index.html`, enters PINs and calls the real `punch()` /
`syncFlush()` / `pushRecord()` code, and asserts on the upsert bodies the kiosk *attempts*
to send. Scenarios cover:

- **Time boundaries** — 08:00 on-time snap, noon lunch, 17:00 PM-out, night duty, midnight
  roll-over, and wrong-punch rejection.
- **Double / triple tap** — a second identical punch in the same second must not create a
  duplicate or a second queue entry.
- **In-flight sync (lost-update race)** — a second punch that lands *during* a sync
  round-trip must still be uploaded (seq-guarded delete).
- **Dead-letter / head-of-line blocking** — one poison row (persistent 4xx) must not stall
  every other punch behind it; it dead-letters after 5 tries and is surfaced in the
  per-tablet "Stuck punches" card, never discarded.
- **Refresh survival** — the queue persists across a page reload.
- **Safety guard** — asserts ZERO un-mocked external calls escaped, and that the live/old
  Supabase refs were never contacted.

Findings tagged `BUG!` are known real bugs the harness deliberately documents; a clean run
shows every scenario `PASS`.

## Safety

Every request is intercepted with `page.route('**/*')`. Localhost (the page + its own
assets) is served by a tiny in-process static server; **every** other host is fulfilled
locally. Nothing is ever `route.continue()`d off-box, so the live project
`wpmcbjrisuyjvobvzaus` (and Telegram, and CDNs) can never be reached. A final assertion
fails the run if any un-mocked request escaped.

## Running

Requires Node 18+ and Playwright's Chromium.

```sh
cd tests/kiosk-stress
npm install                 # installs Playwright (dev-only; creates a gitignored node_modules)
npx playwright install chromium
npm test                    # === node kiosk-stress.mjs
```

The harness starts its own static server on a random port and serves the repo root, so no
separate web server is needed. Exit code is non-zero if any non-finding scenario fails.
