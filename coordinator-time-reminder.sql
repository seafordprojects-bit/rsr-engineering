-- ═══════════════════════════════════════════════════════════════════════════════════════════
--  COORDINATOR TIME-CORRECTION — cutoff-day Telegram reminder
--  Spec: docs/superpowers/specs/2026-08-03-coordinator-time-correction.md §12 Q4
--  Plan: docs/superpowers/plans/2026-08-04-coordinator-time-correction.md, Task 10
--  Additive + idempotent. Creates one table and three functions. Touches no punch, no pay, no
--  existing object. Separate from coordinator-time-correction.sql on purpose, so the reminder can
--  be retuned or re-run without re-running the feature DDL.
--
--  ▓▓▓ NOT RUN YET. AND READ STEP 8 BEFORE YOU SCHEDULE ANYTHING. ▓▓▓
--  Everything up to STEP 7 is safe: it creates objects and lets you test them by hand. STEP 8 is
--  the cron schedule, and it FIRES ON CUTOFF DAY INTO A LIVE GROUP. Do not run STEP 8 until
--  STEP 7's forced-guard test has passed in front of you.
--
--  WHAT IT DOES
--  One message, on cutoff day, to the AWOL group — and ONLY if something is genuinely outstanding.
--  Silence means clean, which is what stops it becoming noise nobody reads.
--
--  WHAT IT DELIBERATELY DOES NOT DO (owner, Q4): it is NOT a per-filing message. The owner
--  explicitly rejected "6 time corrections waiting" every time Jamaica files something. One
--  reminder, cutoff day, or nothing.
--
--  "OUTSTANDING" IS ONE DEFINITION, USED TWICE.
--  The payroll banner computes it in weekOutstanding() (payroll/index.html); this file computes the
--  same two conditions in coordinator_time_outstanding(). They MUST agree — a banner and a Telegram
--  message that disagree about the same Friday is worse than having neither, because the owner then
--  has to work out which one is lying. The two conditions:
--    1. PENDING  — attendance_time_edit rows still awaiting a decision, in the pay week
--    2. UNCLOSED — any date with coordinator activity but no attendance_day_lock row
--  Condition 2 exists because an individual approve freezes only that worker, so a day can reach
--  cutoff fully approved and never CLOSED (spec §9, owner Q1).
--  IF YOU CHANGE ONE, CHANGE THE OTHER IN THE SAME COMMIT.
--
-- ═══ RUNNING THIS — the standing rules (CLAUDE.md, owner 2026-08-03) ═══
--   1. CLOSE the azfmpleswqixaslvcito (inventory) tab. It is the only reliable guard.
--   2. Run STEP 0 ALONE, first, and read the answer before running anything else.
--   3. Everything after STEP 0 is writes. A wrong-project write succeeds silently.
--
--  To undo: coordinator-time-reminder-rollback.sql, beside this file.


-- ── STEP 0 — CANARY  ▓▓▓ RUN THIS BLOCK ALONE, NOTHING ELSE ▓▓▓ ─────────────────────────────
select current_database() as must_be_the_ops_project;
select count(*) as attendance_rows_must_be_over_1000 from public.attendance_records;

-- Dependency check. This file is built on objects coordinator-time-correction.sql created, which
-- is APPLIED AND VERIFIED (2026-08-05). Prove it here anyway — if any of these is null, stop.
select to_regclass('public.attendance_time_edit') as edits_must_not_be_null,
       to_regclass('public.attendance_day_lock')  as locks_must_not_be_null;
select public.att_date_iso('08/07/2026') as must_be_2026_08_07;


-- ── STEP 1 — extensions ─────────────────────────────────────────────────────────────────────
-- Both are already on for kiosk-alerts / the heartbeat snapshot. Harmless to re-assert; if either
-- errors, enable it in Supabase Dashboard ▸ Database ▸ Extensions and re-run.
create extension if not exists pg_cron;
create extension if not exists pg_net;


-- ── STEP 2 — the send-once guard ────────────────────────────────────────────────────────────
-- KEYED TO THE CUTOFF DATE, in its own table, so re-running the tick — or re-opening payroll, or a
-- cron catch-up after downtime — cannot fire it twice. This is the same failure class as the vale
-- double-post on 2026-07-25, which over-credited the ledger ₱7,500 because a reload re-ran a
-- post that had already happened. A duplicate Telegram message is cheaper than that was, but the
-- fix is the same shape and there is no reason to learn it twice.
-- REST-locked: alert bookkeeping is not client data.
create table if not exists public.coordinator_time_reminder_log (
  cutoff_date date        primary key,
  sent_at     timestamptz not null default now(),
  pending_n   integer     not null default 0,
  unclosed_n  integer     not null default 0,
  chat        text
);
revoke all on public.coordinator_time_reminder_log from anon, authenticated;


-- ── STEP 3 — the ONE definition of outstanding ──────────────────────────────────────────────
-- Mirrors weekOutstanding() in payroll/index.html, INCLUDING its pay-week arithmetic.
--
-- PAY WEEK: Saturday → Friday, referenced from YESTERDAY — exactly as payroll's setWeek(0) and the
-- coordinator's payWeek(0) do it. Referencing from yesterday is what makes "this week" on payday
-- Saturday still mean the week that just ended. Fired on a Friday, this resolves to Sat..that Fri.
--   ref        := cutoff - 1
--   since_sat  := (dow(ref) + 1) % 7        -- Postgres dow Sun=0..Sat=6, same as JS getDay()
--   week_from  := ref - since_sat
--   week_to    := week_from + 6
--
-- DATE COMPARISON: attendance_time_edit.date is mixed-format TEXT, so this compares
-- att_date_iso(date) — the same normaliser the one-pending index keys on — as TEXT against ISO
-- bounds. Lexical comparison of 'YYYY-MM-DD' strings is exactly date order, so this is correct AND
-- it can never raise. Casting to ::date would look tidier and would throw the moment a row carried
-- a spelling att_date_iso could not parse (it echoes such input back rather than returning null,
-- deliberately) — and a reminder that errors on cutoff day is a reminder that does not arrive.
create or replace function public.coordinator_time_outstanding(p_cutoff date default null)
returns table (
  cutoff        date,
  week_from     date,
  week_to       date,
  pending_n     integer,
  unclosed_n    integer,
  unclosed_days text[]
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_cut  date := coalesce(p_cutoff, (now() at time zone 'Asia/Manila')::date);
  v_ref  date;
  v_ss   int;
  v_from date;
  v_to   date;
begin
  v_ref  := v_cut - 1;
  v_ss   := (extract(dow from v_ref)::int + 1) % 7;
  v_from := v_ref - v_ss;
  v_to   := v_from + 6;

  return query
  with wk as (
    select e.status, public.att_date_iso(e.date) as iso
      from public.attendance_time_edit e
     where public.att_date_iso(e.date) >= to_char(v_from, 'YYYY-MM-DD')
       and public.att_date_iso(e.date) <= to_char(v_to,   'YYYY-MM-DD')
  ),
  unclosed as (
    select distinct w.iso
      from wk w
     where not exists (select 1 from public.attendance_day_lock l where l.date = w.iso)
  )
  select v_cut, v_from, v_to,
         (select count(*)::int from wk where status = 'pending'),
         (select count(*)::int from unclosed),
         (select coalesce(array_agg(iso order by iso), '{}') from unclosed);
end $$;
-- Read-only and harmless, but there is no reason for a browser to call it: the payroll banner
-- computes the same thing client-side from data it has already fetched.
revoke all on function public.coordinator_time_outstanding(date) from public, anon, authenticated;


-- ── STEP 4 — the sender ─────────────────────────────────────────────────────────────────────
-- Goes to the AWOL group (settings.tg_awol_group), the same running log the AWOL open/resolved
-- messages use, with the manager-DM fallback so a message is never silently dropped while the
-- group id is unset — matching home.js:41 and coordinator.js:297.
--
-- TOKEN SOURCE, in order: the REST-LOCKED kiosk_alert_config first, settings.tg_token second.
-- settings.tg_token is anon-readable — that is a known, separately-tracked exposure (the kiosk
-- sends punch notifications client-side today). Preferring the locked copy costs three lines and
-- means this function is already on the safe source the day that migration happens.
--
-- NOT granted to anon: it takes arbitrary text, and exposing it would let anyone post to the group.
create or replace function public.coordinator_time_reminder_send(p_msg text)
returns text language plpgsql volatile security definer set search_path = public as $$
declare v_token text; v_chat text; v_ids text;
begin
  begin
    select tg_token into v_token from public.kiosk_alert_config where id;
  exception when others then v_token := null;   -- kiosk-alerts.sql not installed here
  end;
  if coalesce(v_token,'') = '' then
    select btrim(replace(value,'"','')) into v_token from public.settings where key = 'tg_token';
  end if;

  select btrim(replace(value,'"','')) into v_chat from public.settings where key = 'tg_awol_group';
  if coalesce(v_chat,'') = '' then
    select btrim(replace(value,'"','')) into v_ids from public.settings where key = 'mgr_ids';
    v_chat := btrim(split_part(coalesce(v_ids,''), ',', 1));   -- first manager DM as the fallback
  end if;

  if coalesce(v_token,'') = '' or coalesce(v_chat,'') = '' then
    return null;                                  -- not configured: send nothing, say so to caller
  end if;

  begin
    perform net.http_post(
      url     := 'https://api.telegram.org/bot' || v_token || '/sendMessage',
      body    := jsonb_build_object('chat_id', v_chat, 'text', p_msg, 'disable_web_page_preview', true),
      headers := jsonb_build_object('Content-Type','application/json'));
  exception when others then
    return null;                                  -- a send failure must not abort the tick
  end;
  return v_chat;
end $$;
revoke all on function public.coordinator_time_reminder_send(text) from public, anon, authenticated;


-- ── STEP 5 — the tick ───────────────────────────────────────────────────────────────────────
-- Returns a jsonb summary of what it decided, so a manual call tells you WHY it did or did not
-- send. Three outcomes: 'clean' (nothing outstanding), 'already-sent' (guard held), 'sent'.
--
-- THE GUARD IS CLAIMED BEFORE THE MESSAGE IS SENT, not after. `insert … on conflict do nothing`
-- then checking row_count means two concurrent ticks cannot both get through: the loser inserts
-- nothing, sees 0 rows, and returns without sending. Sending first and recording after would leave
-- a window where a crash between the two re-sends on the next run — which is exactly how a
-- double-post happens.
--
-- The cutoff day is NOT hardcoded to Friday. The cron schedule decides which day this runs, so the
-- owner can retune it (Q4 says they may want it closer to the actual payroll run) without editing
-- this function. The pay week is derived from whatever date it fires on, using payroll's own
-- reference-from-yesterday rule, so it stays correct either way.
create or replace function public.coordinator_time_reminder_tick(p_cutoff date default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  o          record;
  v_claimed  int;
  v_chat     text;
  v_msg      text;
  v_days     text;
begin
  select * into o from public.coordinator_time_outstanding(p_cutoff);

  -- SILENCE MEANS CLEAN. Nothing outstanding, no message, no guard row consumed.
  if o.pending_n = 0 and o.unclosed_n = 0 then
    return jsonb_build_object('result','clean','cutoff',o.cutoff,
                              'week_from',o.week_from,'week_to',o.week_to);
  end if;

  insert into public.coordinator_time_reminder_log (cutoff_date, pending_n, unclosed_n)
       values (o.cutoff, o.pending_n, o.unclosed_n)
  on conflict (cutoff_date) do nothing;
  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    return jsonb_build_object('result','already-sent','cutoff',o.cutoff);
  end if;

  v_msg := '⏰ Time corrections — cutoff day (' || to_char(o.cutoff, 'Dy DD Mon') || ')';
  if o.pending_n > 0 then
    v_msg := v_msg || E'\n⚠ ' || o.pending_n || ' still waiting for your approval (pay week '
                   || to_char(o.week_from,'MM/DD') || '–' || to_char(o.week_to,'MM/DD')
                   || '). They are NOT in this payroll.';
  end if;
  if o.unclosed_n > 0 then
    select string_agg(to_char(d::date,'Dy MM/DD'), ', ' order by d) into v_days
      from unnest(o.unclosed_days) as d;
    v_msg := v_msg || E'\n⚠ ' || o.unclosed_n || ' day(s) not closed: ' || coalesce(v_days,'')
                   || '. Corrections were filed on them and the day was never closed.';
  end if;
  v_msg := v_msg || E'\n➡️ Payroll ▸ Time approvals.';

  v_chat := public.coordinator_time_reminder_send(v_msg);
  update public.coordinator_time_reminder_log set chat = v_chat where cutoff_date = o.cutoff;

  return jsonb_build_object('result','sent','cutoff',o.cutoff,'pending',o.pending_n,
                            'unclosed',o.unclosed_n,'chat',v_chat);
end $$;
revoke all on function public.coordinator_time_reminder_tick(date) from public, anon, authenticated;


-- ── STEP 6 — VERIFY the pieces (read-only; sends nothing) ───────────────────────────────────
select to_regclass('public.coordinator_time_reminder_log') as log_must_not_be_null;

-- Today's picture. On a Friday, week_from/week_to must be that Sat..Fri.
select * from public.coordinator_time_outstanding();

-- Force a specific Friday to prove the pay-week arithmetic without waiting for one.
-- EXPECT week_from = 2026-08-01, week_to = 2026-08-07.
select cutoff, week_from, week_to from public.coordinator_time_outstanding('2026-08-07'::date);


-- ── STEP 7 — THE FORCED-GUARD TEST  ▓▓▓ DO THIS BEFORE STEP 8 ▓▓▓ ───────────────────────────
-- Proves the send-once guard holds. Uses a date far in the past so it cannot collide with a real
-- cutoff, and rolls everything back so no guard row survives.
--
-- Run this WHOLE BLOCK as one block. Run it piecemeal and the transaction stays open.
begin;
  -- Seed one pending proposal on a long-past week so there IS something outstanding to report.
  insert into public.attendance_time_edit
    (employee_code, employee_name, date, reason, filed_by_code, filed_by_name)
  values ('ZZ REMINDPROBE','probe','01/09/2026','probe','ZZ','probe');

  -- 2026-01-09 is a Friday. First call: expect result = "sent".
  select public.coordinator_time_reminder_tick('2026-01-09'::date) as first_call_must_say_sent;

  -- Second call, same cutoff: expect result = "already-sent", and NO second message.
  select public.coordinator_time_reminder_tick('2026-01-09'::date) as second_call_must_say_already_sent;

  -- Exactly ONE guard row for that cutoff.
  select count(*) as guard_rows_must_be_1 from public.coordinator_time_reminder_log
   where cutoff_date = '2026-01-09';

  -- And the clean path: a cutoff with nothing outstanding must say "clean" and consume no guard.
  select public.coordinator_time_reminder_tick('2025-01-10'::date) as must_say_clean;
  select count(*) as clean_left_no_guard_row from public.coordinator_time_reminder_log
   where cutoff_date = '2025-01-10';        -- expect 0
rollback;

-- Nothing survived the probe.
select count(*) as probe_edits_must_be_0 from public.attendance_time_edit where employee_code = 'ZZ REMINDPROBE';
select count(*) as probe_guards_must_be_0 from public.coordinator_time_reminder_log where cutoff_date in ('2026-01-09','2025-01-10');
-- NOTE: the two tick calls inside the block DID attempt a real Telegram send (pg_net fires
-- immediately; the rollback un-writes the guard row, not the HTTP request). Expect ONE message in
-- the AWOL group naming a January cutoff. That is the test working. Tell the group to ignore it.


-- ── STEP 8 — SCHEDULE.  ▓▓▓ RUN THIS ONLY AFTER STEP 7 PASSED. ▓▓▓ ──────────────────────────
-- IT FIRES ON CUTOFF DAY, INTO A LIVE GROUP.
--
-- pg_cron schedules in UTC. Manila is UTC+8, so subtract 8 hours:
--   08:00 Friday Manila  =  00:00 Friday UTC   ->  '0 0 * * 5'
-- 08:00 was chosen deliberately over an earlier time: anything before 08:00 Manila crosses back
-- into THURSDAY UTC and the day-of-week field has to change too (07:00 Manila Friday = 23:00 UTC
-- Thursday = '0 23 * * 4'). Same trap the heartbeat snapshot documents at
-- kiosk-heartbeat-snapshot.sql:226. If you retune the time, redo this arithmetic — do not just
-- edit the hour.
-- pg_cron dow: 0 and 7 are Sunday, so 5 = Friday.
--
-- Idempotent re-schedule: unschedule any existing entry of the same name first (ignore if absent).
do $$ begin perform cron.unschedule('coordinator-time-reminder'); exception when others then null; end $$;
select cron.schedule('coordinator-time-reminder', '0 0 * * 5',
                     'select public.coordinator_time_reminder_tick();');


-- ── STEP 9 — VERIFY THE SCHEDULE ────────────────────────────────────────────────────────────
select jobid, jobname, schedule, active, command
  from cron.job where jobname = 'coordinator-time-reminder';
-- EXPECT: one row, schedule '0 0 * * 5', active true.

select jobname, schedule, active from cron.job order by jobname;
-- EXPECT this alongside whatever else is scheduled. As of 2026-08-03 that is
-- kiosk-alert-tick '*/5 * * * *', kiosk-7pm-close-check '10 11 * * *' and
-- kiosk-1705-heartbeat-snapshot '5 9 * * *'.

-- ── STEP 10 — PERSISTENCE CHECK (standing rule after the 2026-07-31 vanishing install) ──────
-- CLOSE this editor tab. Open a FRESH one. Run these two and nothing else.
select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname='public' and p.proname like 'coordinator_time_%' order by proname;
-- EXPECT three rows: coordinator_time_outstanding, coordinator_time_reminder_send,
--                    coordinator_time_reminder_tick
select jobname, schedule from cron.job where jobname = 'coordinator-time-reminder';
-- EXPECT one row.
