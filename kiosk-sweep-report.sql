-- ═══════════════════════════════════════════════════════════════════════════════════════════
--  7 PM close-check — server-side READ-ONLY reporter (pg_cron + pg_net)
--
--  The UNRETURNED pm_out day-close is done CLIENT-side at 7:00 PM (autoCloseAbandonedBreaks writes
--  timeout=pm_out locally, then the kiosk syncs it — durable, because the kiosk pushes its full local
--  record on every save; a server-side WRITE would be clobbered by the next re-sync). This reporter
--  does NOT write attendance — it READS the settled DB a few minutes later and sends a LOUD Telegram
--  report to the alerts group: "N of M pm-break days closed ✅", or a ⚠️ anomaly (days still open, no
--  tablet reported, or a count far below the norm). It reuses kiosk_alert_send() from kiosk-alerts.sql.
--
--  Requires kiosk-alerts.sql already applied (kiosk_alert_send + config). Additive + idempotent.
--  "today" is matched via the kiosk's OWN todayKey() (kiosk_health.today_key) — no second date
--  implementation server-side (Req 2). Cron fires at 7:10 PM Asia/Manila = 11:10 UTC.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- ── STEP 0 — CENSUS (read-only; run first) ───────────────────────────────────────────────────
-- Recent pm-break-close population by date: how many pm_out-no-pm_in days exist, and how many are
-- still OPEN (no timeout). After a healthy 7 PM client close, open_count should be 0.
select date,
       count(*) filter (where pm_out is not null and pm_in is null)                      as pmbreak_days,
       count(*) filter (where pm_out is not null and pm_in is null and timeout is null)  as still_open
  from public.attendance_records
 group by date
 order by date desc
 limit 10;

-- ── STEP 1 — schema (idempotent) ─────────────────────────────────────────────────────────────
-- The kiosk heartbeat writes its own todayKey() string here; the reporter matches "today" on it.
alter table public.kiosk_health add column if not exists today_key text;

-- Nightly close-check history — REST-locked (feeds the anomaly band; not attendance data).
create table if not exists public.kiosk_sweep_log (
  sweep_date    text primary key,   -- the kiosk todayKey string, e.g. '07/23/2026'
  pmbreak_count int,                -- pm_out-no-pm_in days that should be closed
  closed_count  int,                -- of those, how many had timeout set (closed by the client)
  open_count    int,                -- of those, how many were STILL OPEN at report time
  ran_at        timestamptz default now()
);
revoke all on public.kiosk_sweep_log from anon, authenticated;

-- ── STEP 2 — the reporter (read-only on attendance) ──────────────────────────────────────────
create or replace function public.kiosk_sweep_report()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today  text;
  v_m      int;      -- pm-break-close population (pm_out set, pm_in null)
  v_open   int;      -- of those, STILL open (no timeout) — should be 0 after the 7 PM client close
  v_closed int;
  v_median numeric;
begin
  -- "today" = the kiosk's OWN todayKey() (Req 2: no second date implementation). Most recent report.
  select today_key into v_today
    from public.kiosk_health
    where today_key is not null
    order by updated_at desc
    limit 1;

  -- No tablet reported today by report time → LOUD (this report is the only backstop now that the
  -- close is client-side; a silent tablet means we cannot verify any day got closed).
  if v_today is null then
    perform public.kiosk_alert_send('⚠️ 7 PM CLOSE CHECK — no tablet reported today. Cannot verify day-closes. Check the kiosks.');
    return;
  end if;

  select
      count(*) filter (where pm_out is not null and pm_in is null),
      count(*) filter (where pm_out is not null and pm_in is null and timeout is null)
    into v_m, v_open
    from public.attendance_records
    where date = v_today;
  v_closed := v_m - v_open;

  -- Log tonight (own table, not attendance) for history + the anomaly band.
  insert into public.kiosk_sweep_log(sweep_date, pmbreak_count, closed_count, open_count, ran_at)
    values (v_today, v_m, v_closed, v_open, now())
    on conflict (sweep_date) do update
      set pmbreak_count = excluded.pmbreak_count, closed_count = excluded.closed_count,
          open_count = excluded.open_count, ran_at = excluded.ran_at;

  -- LOUD ⚠️ #1 — days that should have closed but are STILL OPEN (a tablet off/failed at 7 PM). This
  -- is the primary backstop: pay still computes 8h from pm_out, but the record needs an Admin close.
  if v_open > 0 then
    perform public.kiosk_alert_send('⚠️ 7 PM CLOSE CHECK — ' || v_open || ' of ' || v_m ||
      ' pm-break days STILL OPEN (' || v_today || '). A tablet did not close them — close via Admin ▸ Edit times.');
    return;
  end if;

  -- Anomaly band (accepted default; tune after real nights): LOUD if the closed count is far below the
  -- trailing-7-night median (and the median is meaningful, ≥2).
  select percentile_cont(0.5) within group (order by closed_count)
    into v_median
    from (select closed_count from public.kiosk_sweep_log
          where sweep_date <> v_today order by ran_at desc limit 7) s;

  if v_median is not null and v_median >= 2 and v_closed < v_median * 0.5 then
    perform public.kiosk_alert_send('⚠️ 7 PM CLOSE CHECK — only ' || v_closed || ' pm-break days closed, well below the ~'
      || round(v_median) || '/night norm (' || v_today || '). Possible stuck/absent tablet — verify.');
  else
    perform public.kiosk_alert_send('✅ 7 PM close check — ' || v_closed || ' of ' || v_m || ' pm-break days closed (' || v_today || ').');
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

-- ── STEP 4 — RE-QUERY / smoke (verify) ───────────────────────────────────────────────────────
-- select public.kiosk_sweep_report();                       -- fires a live report now (uses latest today_key)
-- select * from public.kiosk_sweep_log order by ran_at desc limit 7;
-- select jobname, schedule, active from cron.job where jobname = 'kiosk-7pm-close-check';
