-- ═══════════════════════════════════════════════════════════════════════════════════════════
--  ROLLBACK for coordinator-time-reminder.sql
--  Unschedules the cron job and removes the three functions and the guard table.
--  Pairs 1:1 with coordinator-time-reminder.sql — if that file changes, change this one with it.
-- ═══════════════════════════════════════════════════════════════════════════════════════════
--
--  ▓▓▓ IF ALL YOU WANT IS TO STOP THE MESSAGES, DO STEP 2 AND STOP THERE. ▓▓▓
--  Unscheduling the cron job silences the reminder completely and instantly. Everything after
--  STEP 2 is cleanup, and cleanup is not urgent — the functions are read-only or REST-locked, and
--  a silenced job costs nothing to leave in place. Run the rest only when you have decided the
--  feature is not coming back.
--
--  WHAT THIS DOES NOT TOUCH: attendance_time_edit, attendance_day_lock, attendance_edit_audit,
--  att_date_iso, or one punch of attendance_records. The reminder only ever READ those. Removing
--  it changes nothing about the approvals queue or payroll — it just stops the Friday message.
--  (To remove the feature itself, that is coordinator-time-correction-rollback.sql.)
--
-- ═══ RUNNING THIS — the standing rules (CLAUDE.md, owner 2026-08-03) ═══
--   1. CLOSE the azfmpleswqixaslvcito (inventory) tab. It is the only reliable guard.
--   2. Run STEP 0 ALONE, first, and read the answer before running anything else.
--   3. Everything after STEP 0 is writes.


-- ── STEP 0 — CANARY  ▓▓▓ RUN THIS BLOCK ALONE, NOTHING ELSE ▓▓▓ ─────────────────────────────
select current_database() as must_be_the_ops_project;
select count(*) as attendance_rows_must_be_over_1000 from public.attendance_records;


-- ── STEP 1 — WHAT IS THERE NOW ──────────────────────────────────────────────────────────────
select jobid, jobname, schedule, active from cron.job where jobname = 'coordinator-time-reminder';
select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname='public' and p.proname like 'coordinator_time_%' order by proname;
-- Every cutoff this reminder has ever fired on. Read it before STEP 3 removes it — it is the only
-- record of which Fridays the owner was told about, and how much was outstanding on each.
select cutoff_date, sent_at, pending_n, unclosed_n, chat
  from public.coordinator_time_reminder_log order by cutoff_date desc;


-- ── STEP 2 — SILENCE IT.  This alone stops every future message. ────────────────────────────
do $$ begin perform cron.unschedule('coordinator-time-reminder'); exception when others then null; end $$;
select count(*) as job_must_be_0 from cron.job where jobname = 'coordinator-time-reminder';
-- EXPECT 0. If you only wanted the messages stopped, STOP HERE. Nothing below is time-sensitive.


-- ── STEP 3 — SNAPSHOT the guard log, then drop it ───────────────────────────────────────────
-- Per the standing rollback rule: nothing that holds real work is dropped before it is copied, and
-- the drop refuses if the copy is short. This table is small but it is a record of what was sent —
-- the sort of thing that is only ever wanted after it has been thrown away.
create table if not exists public.bak_coord_time_reminder_log_20260805 as
  select * from public.coordinator_time_reminder_log;
revoke all on public.bak_coord_time_reminder_log_20260805 from anon, authenticated;

do $$
declare v_live int; v_bak int;
begin
  select count(*) into v_live from public.coordinator_time_reminder_log;
  select count(*) into v_bak  from public.bak_coord_time_reminder_log_20260805;
  if v_bak < v_live then
    raise exception 'REFUSING TO DROP coordinator_time_reminder_log: backup has % rows, table has %.', v_bak, v_live;
  end if;
  drop table public.coordinator_time_reminder_log;
  raise notice 'guard log dropped; backup kept';
end $$;
-- The Supabase editor swallows RAISE NOTICE. Do not trust it — STEP 5 re-queries.


-- ── STEP 4 — the three functions ────────────────────────────────────────────────────────────
-- Revoke first, so a failed drop cannot leave anything reachable in a half-undone state. (These
-- were never granted to anon, but the order is the habit, not the exception.)
-- Drop the tick FIRST: it calls the other two, and dropping a callee first would leave the tick
-- present but broken between statements.
revoke all on function public.coordinator_time_reminder_tick(date) from public, anon, authenticated;
drop function if exists public.coordinator_time_reminder_tick(date);

revoke all on function public.coordinator_time_reminder_send(text) from public, anon, authenticated;
drop function if exists public.coordinator_time_reminder_send(text);

-- NO CASCADE. If something added later has come to depend on the outstanding calculation, this
-- FAILS LOUDLY and leaves it in place — which is right. Cascade would silently delete whatever
-- that other thing was using it for. If it fails: read what depends on it and decide deliberately.
revoke all on function public.coordinator_time_outstanding(date) from public, anon, authenticated;
drop function if exists public.coordinator_time_outstanding(date);


-- ── STEP 5 — VERIFY ─────────────────────────────────────────────────────────────────────────
select count(*) as job_must_be_0 from cron.job where jobname = 'coordinator-time-reminder';

select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname='public' and p.proname like 'coordinator_time_%';
-- EXPECT 0 rows.

select to_regclass('public.coordinator_time_reminder_log')          as log_must_be_null,
       to_regclass('public.bak_coord_time_reminder_log_20260805')   as backup_must_not_be_null;

-- The feature this reminder watched must be COMPLETELY unaffected. That is the whole point of
-- keeping the reminder in its own file.
select to_regclass('public.attendance_time_edit') as edits_must_still_exist,
       to_regclass('public.attendance_day_lock')  as locks_must_still_exist;
select public.att_date_iso('08/07/2026') as normaliser_must_still_work;
select count(*) as attendance_rows_unchanged from public.attendance_records;


-- ── STEP 6 — PERSISTENCE CHECK (standing rule after the 2026-07-31 vanishing install) ───────
-- CLOSE this editor tab. Open a FRESH one. Run these two and nothing else.
select count(*) as job_must_be_0 from cron.job where jobname = 'coordinator-time-reminder';
select count(*) as funcs_must_be_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname='public' and p.proname like 'coordinator_time_%';


-- ── STEP 7 — AFTER ──────────────────────────────────────────────────────────────────────────
-- 1. The payroll banner is UNAFFECTED and still shows pending corrections and unclosed days. It
--    computes weekOutstanding() client-side and never called this file. Removing the reminder
--    removes the Friday nudge, not the visibility.
-- 2. To restore: re-run coordinator-time-reminder.sql in full, including STEP 7's forced-guard
--    test before STEP 8's schedule.
-- 3. bak_coord_time_reminder_log_20260805 is the record of what was sent. Drop it only when you
--    are certain the reminder is not coming back.
