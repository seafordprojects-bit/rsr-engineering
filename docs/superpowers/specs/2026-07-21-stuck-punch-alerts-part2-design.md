# Stuck-punch alerts — Part 2 (Telegram), server-side design (2026-07-21)

## Status
Designed + approved 2026-07-21. Supersedes the Part-2 sketch in
`2026-07-20-stuck-punch-notifications-design.md` (which had the kiosk send Telegram directly to
`tgGroup`). Part 1 (heartbeat + dashboard banner) is LIVE (kiosk/home.js v2026-07-21b).

## Goal
Push Telegram alerts about stuck punches and offline tablets to a dedicated **"RSR Kiosk Alerts"**
group, so problems surface without watching the dashboard. Owner decisions (locked):
- **Dedicated group** (not the punch-notification `tgGroup`). Owner creates it, adds the existing bot,
  supplies the chat ID.
- Alerts include **stuck workers' names + punch times**.
- **Immediate** first alert; **2-hour** reminders while unresolved; during work hours **6 AM -> the live OT cut-off** (settings.dismissal, e.g. 22:00) Asia/Manila.
- **✅ recovery** when the queue drains (stuck resolved) or a silent tablet resumes.
- **Once-daily digest ~9 AM Manila**, sent **every day** (states "all healthy" or lists issues).

## Architecture — ALL alert sending is server-side
The kiosk sends **no** Telegram for Part 2. A central Supabase watcher does all sending, reading the
bot token from a **REST-locked** table (owner's condition). This adds **zero** new anon token reads.

- **Kiosk (`kiosk/index.html`)** only *writes data*: on each heartbeat it includes
  `stuck_details` (names + punch times + reason for each currently dead-lettered punch) in its
  `kiosk_health` upsert, and on a dead-letter it **pings** the watcher for a near-immediate check.
  Both are fire-and-forget, localhost-guarded, `try/catch`→drop, never block punch sync (Part-1 rules).
- **Central watcher (Supabase pg_cron + pg_net)** — `kiosk_alert_tick()` runs every 5 min (and on the
  kiosk ping). Reads `kiosk_health` + config, sends Telegram via pg_net, tracks state in locked tables.

### Why server-side (recap of the security condition)
The bot token must not be anon-readable. The kiosk can't hold it. So the watcher owns all sending and
reads the token from a locked table. **Accepted residuals** (documented, not fixed here):
1. The **existing punch-notification** token stays anon-readable in `settings.tg_token` (kiosk sends
   punch notifications client-side). Closing that = migrating punch notifications server-side — a
   separate parked task, not Part 2.
2. `kiosk_health` is anon-writable (Part 1), so a spoofed row could trigger a false alert. Inherent to
   client kiosks holding the anon key; low severity (false alert, not data loss).

## Supabase (SQL the owner runs; additive + idempotent; STEP 0 census pattern)

### Extensions + schema
- `create extension if not exists pg_cron;` and `create extension if not exists pg_net;` (Supabase).
- **`kiosk_alert_config`** (single row, REST-locked): `id boolean pk default true check(id)`,
  `tg_token text`, `alert_chat_id text`, `updated_at`. `revoke all … from anon, authenticated;`
  Owner inserts their bot token (same token as punch notifications) + the "RSR Kiosk Alerts" chat ID.
- **`kiosk_alert_state`** (per-device bookkeeping, REST-locked): `device_id text pk`,
  `silence_state text default 'ok'` (`ok`|`silent`), `stuck_alerted_at timestamptz`. Revoked from anon.
- **`kiosk_alert_meta`** (singleton, REST-locked): `id boolean pk default true check(id)`,
  `last_summary_date date`. Revoked from anon.
- **`kiosk_health.stuck_details jsonb`** — add column (anon-writable, the kiosk writes it). Shape:
  `[{ "code": "...", "name": "...", "date": "MM/DD/YYYY", "times": "in 08:00 AM, out 05:00 PM",
  "reason": "server rejected" }, …]`.

### Functions
- **`public.kiosk_alert_send(msg text)`** (`security definer`): read `kiosk_alert_config`; if token or
  chat_id null → return. `perform net.http_post(url := 'https://api.telegram.org/bot'||token||
  '/sendMessage', body := jsonb_build_object('chat_id', chat_id, 'text', msg, 'parse_mode','HTML'),
  headers := jsonb_build_object('Content-Type','application/json'));` Wrapped so a send failure never
  aborts the tick.
- **`public.kiosk_alert_tick()`** (`security definer`, `set search_path=public`): the whole watcher.
  `now_mnl := now() at time zone 'Asia/Manila'`; `hr := extract(hour from now_mnl)`;
  `work_hours` = now (Manila) is between 6 AM and the LIVE OT cut-off read from `settings.dismissal`
  (fallback 22:00), so evening OT is covered (minute precision). Then:
  - **Per device in `kiosk_health`** (join `kiosk_alert_state`, upserting state rows as needed):
    - `is_silent := last_seen < now() - interval '30 minutes'`.
    - **Silence:** if `work_hours and is_silent and silence_state <> 'silent'` → send
      `🔴 <site> tablet silent — last seen <X> min ago` (+ `· <n> stuck` if stuck_count>0);
      set `silence_state='silent'`.
    - **Resume:** if `not is_silent and silence_state='silent'` → send `✅ <site> tablet back online`;
      set `silence_state='ok'`.
    - **Stuck (uses `stuck_details`):** if `stuck_count>0`:
      - if `stuck_alerted_at is null` (new) OR (`work_hours` and `now - stuck_alerted_at >= 2h`)
        (reminder) → send the stuck message (see format); set `stuck_alerted_at = now()`.
    - **Stuck recovery:** if `stuck_count=0 and stuck_alerted_at is not null` → send
      `✅ <site> — all stuck punches resolved`; set `stuck_alerted_at = null`.
  - **Daily digest:** if `now_mnl::date > coalesce(meta.last_summary_date,'1970-01-01') and hr >= 9`
    → build a digest across reporting tablets (and note yards from `attendance_sites` with no row as
    "no tablet reporting"): `✅ Daily check — all reporting tablets healthy (N tablets, 0 stuck)` or
    `⚠ Daily check — <issues>`; send; set `last_summary_date = now_mnl::date`.
- `grant execute on function public.kiosk_alert_tick() to anon, authenticated;` — the kiosk **pings**
  it. Safe to expose: idempotent + state-tracked (hammering sends nothing new). `kiosk_alert_send` is
  NOT granted to anon.
- Schedule: `select cron.schedule('kiosk-alert-tick','*/5 * * * *','select public.kiosk_alert_tick();');`

### Stuck message format (HTML)
```
⚠ Stuck punches — <site> (<n>)
• <name> (<date>): <times>
• …
Fix the cause + Retry in Admin ▸ Stuck punches.
```
Reminders prefix `⏰ Still stuck`. All emoji/text plain (no HTML entities needed beyond parse_mode).

## Kiosk changes (`kiosk/index.html`)
- **`buildStuckDetails()`** — from the dead entries in `syncPending`, produce the `stuck_details` array
  (code, name via `findEmp`, date, a human `times` string from `records[key].punches`, reason).
- **Heartbeat upsert** — add `stuck_details: buildStuckDetails()` to the `kiosk_health` upsert payload.
- **Ping on dead-letter** — in `syncFlush`'s `finally`, after the deferred `sendHeartbeat()` writes the
  fresh `stuck_details`, call `pingAlertWatcher()` (fire-and-forget): `if (IS_LOCALHOST) return;`
  then `try { sbClient.rpc('kiosk_alert_tick'); } catch(e){}` (not awaited in a blocking way).
- No token, no `tg_alert_group`, no Telegram in the kiosk. Bump the kiosk version stamp + preflight.

## Data flow
```
punch dead-letters ──► kiosk writes kiosk_health {…, stuck_details:[names+times]} ──► pings kiosk_alert_tick()
                                                                                         │
pg_cron every 5 min ─────────────────────────────────────────────────────────────────► kiosk_alert_tick()
                                                                                         │ reads kiosk_health + kiosk_alert_config (locked token)
                                                                                         ▼
                                              pg_net → Telegram "RSR Kiosk Alerts" group (stuck / reminder / recovery / silent / resume / daily digest)
```

## Error handling
- Every Telegram send is `net.http_post` (async, fire-and-forget) wrapped so a failure never aborts the
  tick. The kiosk's stuck_details write + ping are `try/catch`→drop, localhost-guarded, never queued.
- The tick is idempotent and state-guarded, so the cron and the kiosk ping can't double-send.

## Testing
- **Stress harness** — must stay **26/26**. On 127.0.0.1 the kiosk's heartbeat/ping are localhost-
  guarded (skipped), so the harness proves Part 2 adds no punch-sync regression.
- **Targeted kiosk probe** — force a dead-letter, call `buildStuckDetails()` via `page.evaluate`, assert
  it returns the worker name, formatted punch times, and reason.
- **Watcher** — STEP 0 census; `select kiosk_alert_tick();` smoke; force a silence alert by ageing a
  test row's `last_seen`, and a stuck alert via a `stuck_details` test row, confirm Telegram fires, then
  clean up. Verified in the owner walkthrough.
- Localhost walkthrough before commit (pay-adjacent kiosk file changes).

## Scope exclusions / parked
- Migrating **punch notifications** server-side (to remove the anon-readable `settings.tg_token`) —
  parked as a future task.
- No per-worker escalation beyond the group message + 2 h reminder.
- Digest covers reporting tablets (+ "no tablet reporting" note per `attendance_sites` yard); it does
  not page for a yard that has simply never been rolled out (that's the dashboard's grey note).

## Overnight behavior (tablets are OFF overnight, on ~8 AM shift)
- **Silence alert fires only for a tablet that reported earlier TODAY and then stopped**
  (`last_seen` Manila-date = today), so a not-yet-started tablet in the morning never false-alarms.
- **Daily digest at ~9 AM Manila** (after the 8 AM shift + boot). By 9 AM a tablet that hasn't reported
  today is flagged in the digest as "no report today" (it catches the tablet-never-came-on case that
  the real-time silence alert intentionally skips). Yards from `attendance_sites` with no row at all →
  "no tablet reporting" info line.

## Tunables (approved)
Silence threshold 30 min · reminder 2 h · alert window 6 AM -> live OT cut-off (settings.dismissal, e.g. 22:00) Manila · **digest ~9 AM Manila**, daily,
always-send · cron every 5 min + kiosk ping for immediacy.
