# Stuck-punch notifications — design (2026-07-20)

## Status
Designed + approved 2026-07-20. **Implementation ON HOLD at the owner's request** (owner has another
task first). Defaults approved: heartbeat 5 min, staleness 30 min, reminder 3 h.

## Problem
When the kiosk dead-letters a punch (5 rejects → kept in the per-tablet queue, surfaced in the hidden
Admin "Stuck punches" card), nobody finds out unless someone walks to that tablet and opens Admin.
Pay-impacting attendance can sit stuck and unnoticed. We want two push signals:

- **Part 1 (heartbeat):** each kiosk reports its health to Supabase; the RSR Admin dashboard shows a
  warning banner when any yard has stuck punches or a tablet has gone quiet.
- **Part 2 (Telegram):** when a punch first becomes dead-lettered, alert the existing punch-notification
  Telegram group, with de-duplication so it never spams on retry cycles.

## Hard constraint (non-negotiable)
Heartbeat writes and Telegram sends **must never interfere with punch sync**. Punches always take
priority. A failed heartbeat/alert is **silently dropped — never queued or retried** in any way that
could block or delay punch sync. The punch queue (`syncPending`) is not modified by either feature
except an additive `alerted` field that the sync logic ignores.

## Current-state anchors (verified 2026-07-20, kiosk v2026-07-20g)
- Dead-letter queue: `syncPending[k]` entries `{attempts, seq, dead, reason, sig}`, keyed by
  `employee_code + '_' + date`. `DEAD_MAX = 5`. `pendingCount()` = non-dead entries; `deadCount()` =
  dead entries. Persisted via `savePending()`.
- The dead-letter transition is `kiosk/index.html:5340`: `if (now.attempts >= DEAD_MAX) now.dead = true;`
  inside `syncFlush()`. A comment there already anticipates "report deadCount() to Supabase so a REMOTE
  admin can see stuck punches."
- Telegram: `tgSendText(chatId, text)` (async, `try/catch` → returns false on any error — already silent
  and non-throwing). Punch notifications go to `tgGroup` (`kiosk/index.html` ~1533). `tgToken`/`tgGroup`
  are pulled from Supabase `settings` on boot (`loadTgFromCloud`); empty in demo mode.
- Admin dashboard: `admin/index.html` loads `home.js` (Preact, ~1738 lines), which already reads
  Supabase tables and renders tiles. This is where the banner goes.
- The `active site` / yard NAME lives in the kiosk global `activeSite` (per-tablet; also `?site=`).

## Part 1 — Heartbeat + dashboard banner

### Supabase (SQL the owner runs once; additive + idempotent)
```sql
-- One row PER TABLET (device_id), so two tablets at the same yard never overwrite each other.
-- Non-sensitive (no secrets) → left REST-readable/writable under the project's RLS-disabled posture,
-- same as attendance_records. The dashboard reads it with the anon key; the kiosk upserts with it.
create table if not exists public.kiosk_health (
  device_id     text        primary key,
  site          text,
  stuck_count   integer     not null default 0,
  queue_length  integer     not null default 0,
  last_seen     timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
```
No grants/revokes needed (PostgREST exposes it to the anon role by default; that is intended here).

### Kiosk side (`kiosk/index.html`)
- **Device id:** on boot, read `localStorage['rsr_device_id']`; if absent, generate a stable random id
  (`crypto.randomUUID()` with a timestamp+random fallback) and persist it. One id per tablet, forever.
- **`sendHeartbeat()`** (fire-and-forget): if a punch sync is in flight (`syncing`), skip and return
  immediately (punch priority). Otherwise upsert to `kiosk_health` onConflict `device_id`:
  `{device_id, site: activeSite, stuck_count: deadCount(), queue_length: pendingCount(), last_seen: now,
  updated_at: now}`. Wrapped in `try/catch`; any failure is swallowed. Never queued, never retried.
- **When it fires:** a `setInterval` every **5 min**; once shortly after boot; and immediately (still
  fire-and-forget) right after a punch dead-letters and after a successful "Retry now" recovery, so the
  dashboard reflects changes promptly.

### Dashboard side (`home.js` / `admin/index.html`)
- Fetch `kiosk_health` on load and on a refresh interval (align with the dashboard's existing refresh;
  ~60 s). Group rows by `site`, summing `stuck_count` / `queue_length`, and taking the newest
  `last_seen` per site.
- **Banner (red, top of dashboard)** shown when ANY site has `stuck_count > 0` OR its newest `last_seen`
  is older than **30 min**. Content lists offending yards, e.g.
  `⚠ Carmen: 3 stuck punches · Mandaue: tablet quiet 42 min`. Hidden entirely when all healthy.
- Read-only display; no writes from the dashboard.

## Part 2 — Telegram alert on first dead-letter

- **Hook:** at `kiosk/index.html:5340`, immediately after `now.dead = true`, if this entry was not
  already alerted, call `tgAlertStuck(k, now)` **without awaiting it** (detached), so the sync loop is
  never delayed.
- **`tgAlertStuck(key, meta)`** (fire-and-forget): if no `tgToken`/`tgGroup`, return silently. Derive
  `code`/`date` from the key, worker name via `findEmp(code)`, reason from `meta.reason`. Send via
  `tgSendText(tgGroup, "⚠ 1 stuck punch on <site> — <name>, <date>, <reason>")`. Set
  `meta.alerted = Date.now()` and `savePending()`. All wrapped in `try/catch` → drop.
- **De-duplication:** an entry with `alerted` set is not re-alerted. When a punch recovers
  (`dead = false`, e.g. Retry-now or fresh data bumps `seq`), clear `alerted` so a genuine re-stick
  later alerts again. `alerted` is persisted, so a page reload never re-spams.
- **Periodic reminder:** off the same 5-min heartbeat timer, for each still-dead entry whose
  `alerted` is older than **3 h**, send one reminder (`"⚠ still stuck: …"`) and update
  `meta.alerted`. Detached, `try/catch` → drop.
- **Group:** `tgGroup` only (the punch-notification group). Not `tgPosGroup`/`tgPhotoGroup`/`mgrIds`.

## Data flow
```
punch → records (localStorage) → syncPending → syncFlush → Supabase attendance_records
                                                   │ (on 5th reject)
                                                   ├─► now.dead=true ──► tgAlertStuck() [detached, tgGroup]
                                                   │
heartbeat timer (5 min, skipped while syncing) ────┴─► upsert kiosk_health {device_id,site,counts,last_seen}
                                                        + reminder sweep (dead && alerted>3h → tgSendText)

home.js dashboard ──(read kiosk_health, group by site)──► red banner if stuck_count>0 OR last_seen>30min
```

## Error handling
- Every new external call (`kiosk_health` upsert, all `tgSendText`) is `try/catch`; failures are logged
  to console at most and dropped. No new queue, no new retry loop, no new persistent failure state.
- The heartbeat is gated on `!syncing` so it can never contend with an in-flight punch upload.
- `tgAlertStuck` is never awaited inside `syncFlush`; the sync loop proceeds without waiting on Telegram.

## Testing
- **Stress harness** (`tests/kiosk-stress`) must stay **26/26, 0 regressions**. The harness mocks
  `wpmcbjrisuyjvobvzaus` (so `kiosk_health` upserts are absorbed) and `api.telegram.org` (alerts
  absorbed); its SAFETY guard must still show **zero escaped external calls**. If the 5-min timer never
  fires within a scenario, add a targeted probe that forces a dead-letter and asserts: (a) exactly one
  `tgSendText` to `tgGroup`, (b) no second alert on the next retry cycle, (c) an attempted
  `kiosk_health` upsert, (d) punch `attendance_records` writes are unchanged/unblocked.
- `node --check` on the largest inline script; hygiene grep (`wpmcbjrisuyjvobvzaus` present,
  `azfmpleswqixaslvcito` absent).
- Bump kiosk stamp + preflight EXPECT in lockstep. **Localhost walkthrough before commit** (pay-adjacent).

## Scope exclusions
- No new Telegram groups or manager DMs (reuse `tgGroup`).
- No changes to the punch/sync algorithm itself, the dead-letter thresholds, or the Stuck-punches Admin
  card. This feature only *observes* the queue and *reports* out-of-band.
- No per-worker escalation logic; one group message + a 3 h reminder is the whole alerting policy.

## Tunables (approved defaults)
Heartbeat interval 5 min · staleness threshold 30 min · reminder interval 3 h · dead-letter threshold
unchanged (5).
