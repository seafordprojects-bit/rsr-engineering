-- ═══════════════════════════════════════════════════════════════════════════════════════════
--  7 PM close-check — server-side READ-ONLY reporter (pg_cron + pg_net)
--
--  THIS FUNCTION WRITES NOTHING TO attendance_records. It reads that table and writes only to
--  its own kiosk_sweep_log, plus a Telegram send. That is unchanged from the original and is
--  load-bearing: the kiosk pushes its FULL local record on every save, so any server-side write
--  to attendance would be clobbered by the next re-sync.
--
--  The day-close itself is CLIENT-side, in autoCloseAbandonedBreaks() (kiosk ~:5178 on main):
--    PM break    pm_out set, pm_in never pressed   -> at 19:00 writes timeout = pm_out
--    Lunch       lunch_out set, lunch_in never pressed, pm_out never pressed
--                                                  -> from 17:00 writes timeout = lunch_out
--  Neither path ever writes pm_in or lunch_in. A worker who did not press it never gets one.
--
--  REVISED 2026-07-30 after a false accusation in production. Four changes, all owner-specified:
--   1. "Still open" no longer means "timeout is null". A handled break has the signature
--      timeout = pm_out (or timeout = lunch_out). Anything else -- null, or a timeout at some
--      OTHER time -- is an unresolved break. The old condition treated a later manual Time Out as
--      proof the break was handled, which it is not.
--   2. The LUNCH half is now monitored. It was completely absent: both old counters filtered on
--      pm_out/pm_in only, so an abandoned-lunch day that failed to close was invisible and the
--      check stayed green while it silently failed.
--   3. A stale tablet is no longer accused. If no kiosk has reported recently the report says the
--      state is UNVERIFIED rather than blaming a tablet for not closing days.
--   4. PEM/pakyaw rows are excluded from the counts. They are still auto-closed by the client
--      (harmless), but is_incomplete true with worked_ms 0 is their normal state and would be
--      permanent noise in this report.
--
--  AND THE ALERT TEXT NOW LEADS WITH THE SYNC WARNING. The old text said "close via Admin >
--  Edit times". Following that during sync lag SILENTLY DESTROYS the edit: the tablet re-pushes
--  its full local record and overwrites the correction. Check the tablet is online and synced
--  FIRST. This is a pay-affecting instruction and it was pointing the wrong way.
--
--  Requires kiosk-alerts.sql already applied (kiosk_alert_send + config). Additive + idempotent.
--  "today" is matched via the kiosk's OWN todayKey() (kiosk_health.today_key) -- no second date
--  implementation server-side (Req 2). Cron fires at 7:10 PM Asia/Manila = 11:10 UTC.
--
--  KNOWN LIMITATION, deliberately not changed here: `date` is TEXT in mixed formats and this
--  matches it with `=`. A row written as YYYY-MM-DD would not be seen. Normalising both sides is
--  the right fix but touches the Req 2 "one definition of today" rule, so it belongs in its own
--  change with its own verify, not folded into this one.
-- ═══════════════════════════════════════════════════════════════════════════════════════════


-- ── STEP 0 — CENSUS (read-only; run first) ───────────────────────────────────────────────────
-- Both halves, PEM excluded, using the CLOSED SIGNATURE rather than "timeout is not null".
-- Run this before STEP 2 so you can see what the new condition will report tonight.
select a.date,
       count(*) filter (where a.pm_out is not null and a.pm_in is null)                     as pm_population,
       count(*) filter (where a.pm_out is not null and a.pm_in is null
                          and (a.timeout is null or btrim(a.timeout) <> btrim(a.pm_out)))   as pm_open,
       count(*) filter (where a.lunch_out is not null and a.lunch_in is null
                          and a.pm_out is null)                                             as lunch_population,
       count(*) filter (where a.lunch_out is not null and a.lunch_in is null
                          and a.pm_out is null
                          and (a.timeout is null or btrim(a.timeout) <> btrim(a.lunch_out))) as lunch_open
  from public.attendance_records a
 where not public.awol_is_pem(a.employee_code)
 group by a.date
 order by a.date desc
 limit 10;

-- Which codes the PEM filter removes. EYEBALL THIS — all four PEM men must appear, and no
-- regular worker may. awol_is_pem() is the project's single authority on pakyaw; if a PEM man is
-- missing here his rows will still be counted and the report will carry permanent noise.
select distinct a.employee_code, public.awol_is_pem(a.employee_code) as excluded_as_pem
  from public.attendance_records a
 where public.awol_is_pem(a.employee_code)
 order by a.employee_code;


-- ── STEP 1 — schema (idempotent) ─────────────────────────────────────────────────────────────
-- The kiosk heartbeat writes its own todayKey() string here; the reporter matches "today" on it.
alter table public.kiosk_health add column if not exists today_key text;

-- Nightly close-check history — REST-locked (feeds the anomaly band; not attendance data).
create table if not exists public.kiosk_sweep_log (
  sweep_date    text primary key,   -- the kiosk todayKey string, e.g. '07/23/2026'
  pmbreak_count int,                -- pm_out-no-pm_in days that should be closed
  closed_count  int,                -- of those, how many carry the closed signature
  open_count    int,                -- of those, how many were STILL OPEN at report time
  ran_at        timestamptz default now()
);
revoke all on public.kiosk_sweep_log from anon, authenticated;

-- Lunch half + the unverified marker. A night with no reachable tablet now LEAVES A ROW rather
-- than a hole in the history, so the anomaly band can tell "quiet night" from "we could not look".
alter table public.kiosk_sweep_log
  add column if not exists lunch_count  int,
  add column if not exists lunch_closed int,
  add column if not exists lunch_open   int,
  add column if not exists unverified   boolean not null default false,
  add column if not exists note         text;

-- EVERY EXISTING ROW WAS COMPUTED UNDER THE SUPERSEDED OPEN-CONDITION and its closed_count is
-- understated — measured 2026-07-30, the old condition reported non-zero every single day since it
-- shipped (23 on 07/28 and on 07/25), while the corrected condition reads 0. Those numbers must not
-- seed the anomaly median, or the band calibrates against counts that were never real.
-- LABEL, do not delete: the history is still evidence of how long this was wrong.
-- Consequence to expect: the anomaly band stays INERT for about seven nights, because its
-- `v_median >= 2` guard has nothing comparable to read yet. That is the correct behaviour — silence
-- while it recalibrates, rather than alerts computed off bad history. The ⚠️ open-break and
-- unverified branches are unaffected and work from tonight.
-- Date literal, not now(), so re-running this file later cannot relabel good rows.
update public.kiosk_sweep_log
   set unverified = true,
       note = 'counts computed under the pre-2026-07-30 open-condition; not comparable'
 where ran_at < timestamptz '2026-07-31 00:00+08'
   and note is null;


-- ── STEP 2 — the reporter (READ-ONLY on attendance_records) ──────────────────────────────────
create or replace function public.kiosk_sweep_report()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  -- A tablet that has not checked in for this long cannot vouch for a 19:00 close. The report runs
  -- at 19:10, so 90 minutes means "has not reported since ~17:40" — comfortably before the close.
  c_stale_after constant interval := interval '90 minutes';

  v_today   text;
  v_seen_at timestamptz;
  v_stale   boolean;

  v_pm_m    int;  v_pm_open    int;  v_pm_closed    int;
  v_lun_m   int;  v_lun_open   int;  v_lun_closed   int;
  v_open    int;  v_m          int;  v_closed       int;
  v_median  numeric;
begin
  -- "today" = the kiosk's OWN todayKey() (Req 2: no second date implementation), plus WHEN that
  -- tablet last spoke, which is what decides whether we may accuse it of anything.
  select today_key, updated_at
    into v_today, v_seen_at
    from public.kiosk_health
   where today_key is not null
   order by updated_at desc
   limit 1;

  -- ── No tablet has EVER reported a today_key. Alert AND leave a row: a monitor must not go
  --    quiet exactly when things are worst, and a missing history row is indistinguishable from a
  --    night nobody looked at.
  if v_today is null then
    insert into public.kiosk_sweep_log(sweep_date, pmbreak_count, closed_count, open_count,
                                       lunch_count, lunch_closed, lunch_open, unverified, note, ran_at)
      values (to_char(now() at time zone 'Asia/Manila', 'MM/DD/YYYY'),
              null, null, null, null, null, null, true,
              'no tablet has ever reported a today_key', now())
      on conflict (sweep_date) do update
        set unverified = true, note = excluded.note, ran_at = excluded.ran_at;

    perform public.kiosk_alert_send(
      '⚠️ 7 PM CLOSE CHECK — TABLET UNREACHABLE, STATE UNVERIFIED.' || chr(10) ||
      'No kiosk has reported at all, so no day-close can be confirmed or denied.' || chr(10) ||
      'This is NOT a report that days were left open — it is a report that we cannot see.' || chr(10) ||
      'Check the kiosks are powered, online and synced. Do NOT edit times until one is back.');
    return;
  end if;

  v_stale := (v_seen_at is null) or (now() - v_seen_at > c_stale_after);

  -- ── A tablet reported at some point but has gone quiet. Its last-known today_key may be
  --    yesterday's, and any day it closed locally may not have synced. REFUSE TO ACCUSE IT.
  if v_stale then
    insert into public.kiosk_sweep_log(sweep_date, pmbreak_count, closed_count, open_count,
                                       lunch_count, lunch_closed, lunch_open, unverified, note, ran_at)
      values (v_today, null, null, null, null, null, null, true,
              'tablet stale; last heartbeat ' || coalesce(to_char(v_seen_at at time zone 'Asia/Manila',
                                                                 'MM/DD/YYYY HH24:MI'), 'never'), now())
      on conflict (sweep_date) do update
        set unverified = true, note = excluded.note, ran_at = excluded.ran_at;

    perform public.kiosk_alert_send(
      '⚠️ 7 PM CLOSE CHECK — TABLET UNREACHABLE, STATE UNVERIFIED (' || v_today || ').' || chr(10) ||
      'Last heartbeat: ' || coalesce(to_char(v_seen_at at time zone 'Asia/Manila', 'MM/DD/YYYY HH24:MI'),
                                     'never') || '.' || chr(10) ||
      'Days may have been closed on the tablet and not yet synced. Nobody is accused of anything.' ||
      chr(10) ||
      '⛔ DO NOT use Admin ▸ Edit times yet — a tablet that comes back re-pushes its own copy and ' ||
      'SILENTLY OVERWRITES your edit. Get it online and synced first, then re-check.');
    return;
  end if;

  -- ── Counts. PEM/pakyaw excluded (owner 2026-07-30): they are still auto-closed by the client,
  --    which is harmless, but is_incomplete true with worked_ms 0 is their NORMAL state and would
  --    sit in this report as permanent noise.
  --
  --    CLOSED SIGNATURE, not "timeout is not null". autoCloseAbandonedBreaks() copies the break
  --    punch into timeout, so a handled PM break reads timeout = pm_out exactly. A timeout at any
  --    OTHER time means the man pressed Time Out himself and the break was never resolved — the
  --    old condition read that as closed and said nothing.
  select
      count(*) filter (where a.pm_out is not null and a.pm_in is null),
      count(*) filter (where a.pm_out is not null and a.pm_in is null
                         and (a.timeout is null or btrim(a.timeout) <> btrim(a.pm_out))),
      -- Lunch half mirrors the client's own condition, INCLUDING `pm_out is null`: once a man
      -- reaches the PM break his day is the PM path's business, not lunch's.
      count(*) filter (where a.lunch_out is not null and a.lunch_in is null and a.pm_out is null),
      count(*) filter (where a.lunch_out is not null and a.lunch_in is null and a.pm_out is null
                         and (a.timeout is null or btrim(a.timeout) <> btrim(a.lunch_out)))
    into v_pm_m, v_pm_open, v_lun_m, v_lun_open
    from public.attendance_records a
   where a.date = v_today
     and not public.awol_is_pem(a.employee_code);

  v_pm_closed  := v_pm_m  - v_pm_open;
  v_lun_closed := v_lun_m - v_lun_open;
  v_m          := v_pm_m    + v_lun_m;
  v_open       := v_pm_open + v_lun_open;
  v_closed     := v_m - v_open;

  insert into public.kiosk_sweep_log(sweep_date, pmbreak_count, closed_count, open_count,
                                     lunch_count, lunch_closed, lunch_open, unverified, note, ran_at)
    values (v_today, v_pm_m, v_pm_closed, v_pm_open,
            v_lun_m, v_lun_closed, v_lun_open, false, null, now())
    on conflict (sweep_date) do update
      set pmbreak_count = excluded.pmbreak_count, closed_count = excluded.closed_count,
          open_count    = excluded.open_count,    lunch_count  = excluded.lunch_count,
          lunch_closed  = excluded.lunch_closed,  lunch_open   = excluded.lunch_open,
          unverified    = false, note = null,     ran_at       = excluded.ran_at;

  -- ── LOUD ⚠️ #1 — genuinely unresolved breaks, from a tablet we know is online and current.
  if v_open > 0 then
    perform public.kiosk_alert_send(
      '⚠️ 7 PM CLOSE CHECK — ' || v_open || ' unresolved break' || case when v_open = 1 then '' else 's' end ||
      ' (' || v_today || ').' || chr(10) ||
      'PM: ' || v_pm_open  || ' of ' || v_pm_m  || ' · Lunch: ' || v_lun_open || ' of ' || v_lun_m || chr(10) ||
      'Tablet is online and current, so this is a real gap, not a sync delay.' || chr(10) ||
      '1️⃣ CONFIRM the tablet is online and fully synced (sync badge clear).' || chr(10) ||
      '2️⃣ ONLY THEN close via Admin ▸ Edit times. Editing while a punch is still queued lets the ' ||
      'tablet overwrite your correction when it re-pushes — silently, with no error.');
    return;
  end if;

  -- Anomaly band: LOUD if the closed count is far below the trailing-7-night median. Unverified
  -- nights are excluded from the median — "we could not look" is not a low night.
  select percentile_cont(0.5) within group (order by closed_count)
    into v_median
    from (select closed_count from public.kiosk_sweep_log
           where sweep_date <> v_today and unverified is false and closed_count is not null
           order by ran_at desc limit 7) s;

  if v_median is not null and v_median >= 2 and v_closed < v_median * 0.5 then
    perform public.kiosk_alert_send(
      '⚠️ 7 PM CLOSE CHECK — only ' || v_closed || ' break' || case when v_closed = 1 then '' else 's' end ||
      ' resolved, well below the ~' || round(v_median) || '/night norm (' || v_today || ').' || chr(10) ||
      'Possible stuck tablet. Verify it is online and synced BEFORE any Edit-times change.');
  else
    perform public.kiosk_alert_send(
      '✅ 7 PM close check — ' || v_closed || ' of ' || v_m || ' breaks resolved (' || v_today || ')' ||
      '. PM ' || v_pm_closed || '/' || v_pm_m || ' · Lunch ' || v_lun_closed || '/' || v_lun_m || '.');
  end if;
end;
$$;


-- ── STEP 3 — grants + schedule ───────────────────────────────────────────────────────────────
-- Cron-only. NOT granted to anon/authenticated (it sends Telegram via the security-definer chain).
revoke all on function public.kiosk_sweep_report() from public, anon, authenticated;

-- 7:10 PM Asia/Manila = 11:10 UTC (a few minutes after the 7:00 PM client close + sync settles).
-- Idempotent re-schedule: unschedule an existing entry of the same name first (ignore if absent).
do $$ begin perform cron.unschedule('kiosk-7pm-close-check'); exception when others then null; end $$;
select cron.schedule('kiosk-7pm-close-check', '10 11 * * *', 'select public.kiosk_sweep_report();');


-- ── STEP 4 — VERIFY ──────────────────────────────────────────────────────────────────────────

-- 4a. PROOF IT CANNOT TOUCH ATTENDANCE. The function body must contain no write against
--     attendance_records. This greps the INSTALLED definition, not this file.
select position('attendance_records' in pg_get_functiondef('public.kiosk_sweep_report'::regproc)) > 0
         as reads_attendance_expected_true,
       (pg_get_functiondef('public.kiosk_sweep_report'::regproc)
          ~* '(insert|update|delete)\s+(into\s+)?(public\.)?attendance_records')
         as writes_attendance_MUST_BE_FALSE;
-- EXPECT: true · false

-- 4b. Fire a live report now against the latest today_key.
-- select public.kiosk_sweep_report();

-- 4c. History, including the new lunch columns and the unverified marker.
select sweep_date, pmbreak_count, closed_count, open_count,
       lunch_count, lunch_closed, lunch_open, unverified, note, ran_at
  from public.kiosk_sweep_log order by ran_at desc limit 7;

-- 4d. Schedule still registered.
select jobname, schedule, active from cron.job where jobname = 'kiosk-7pm-close-check';

-- 4e. Staleness as the function sees it right now — tells you which branch tonight will take.
select today_key,
       updated_at at time zone 'Asia/Manila' as last_heartbeat_manila,
       now() - updated_at                    as age,
       (now() - updated_at > interval '90 minutes') as would_report_unverified
  from public.kiosk_health
 where today_key is not null
 order by updated_at desc
 limit 3;
