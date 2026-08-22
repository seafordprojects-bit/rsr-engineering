-- ═══════════════════════════════════════════════════════════════════════════════════════════
--  ROLLBACK — holiday-pay.sql
--
--  STATUS: NOT APPLIED. Emergency use only.
--  Pairs with: holiday-pay.sql (standing rule — every migration ships its rollback, written at the
--  same time, in the same commit).
--
--  READ THIS FIRST — THE CHEAP REVERSAL IS NOT IN THIS FILE
--  To stop holiday pay WITHOUT destroying anything, move the forward-only switch instead:
--
--      update public.settings
--         set value = (value::jsonb || '{"holidayPayFrom":"2099-01-01"}'::jsonb)::text
--       where key = 'payroll_cfg';
--
--  Payroll then computes no holiday for any date, the tables sit harmlessly, and every declared
--  holiday and every override is preserved. That is the correct response to "the numbers look
--  wrong" — it is instant, reversible, and loses nothing. STEP 1 below does exactly that.
--
--  Everything after STEP 1 DESTROYS RECORDS: which days were declared holidays, who the owner
--  granted them to, and the audit of who decided what. Payroll stores no payslips and recomputes
--  live, so dropping these tables makes an already-paid week compute to a DIFFERENT number than was
--  paid, with nothing on screen saying so.
--
--  ORDER MATTERS: functions first, then tables. Dropping a table out from under a live function
--  leaves a security-definer function that errors on call instead of refusing cleanly.
-- ═══════════════════════════════════════════════════════════════════════════════════════════


-- ── STEP 0 — WHICH DATABASE AM I IN? ────────────────────────────────────────────────────────
-- Same two-project rule, and it matters more here: this file DROPS.
-- CLOSE THE OTHER PROJECT'S TAB FIRST.

-- 0a. Name the database.
select current_database();

-- 0b. CANARY — must return a row count. An error means WRONG PROJECT. Stop.
select count(*) as attendance_rows_must_be_nonzero from public.attendance_records;


-- ── STEP 1 — THE SAFE STOP (try this before anything below) ─────────────────────────────────
-- Disables all holiday computation without destroying a single row. Reversible by setting the date
-- back. Run it, re-run payroll, confirm the numbers are what you expect, and STOP HERE.
update public.settings
   set value = (case when jsonb_typeof(value::jsonb) = 'object' then value::jsonb else '{}'::jsonb end
                || '{"holidayPayFrom":"2099-01-01"}'::jsonb)::text
 where key = 'payroll_cfg';

-- Verify. Expect 2099-01-01.
select value::jsonb ->> 'holidayPayFrom' as holiday_pay_from
  from public.settings where key = 'payroll_cfg';


-- ── STEP 2 — WHAT WOULD BE LOST ─────────────────────────────────────────────────────────────
-- Read all four before deciding to drop. Screenshot them.

-- 2a. Every declared holiday.
select id, date, name, type, scope, added_by, created_at
  from public.holidays order by date;

-- 2b. Every owner override, with the holiday it belongs to.
select o.employee_code, o.holiday_date, h.name as holiday, o.granted, o.actor, o.reason, o.at
  from public.holiday_override o
  left join public.holidays h on h.date = o.holiday_date and h.type in ('regular','special_nonworking')
 order by o.holiday_date, o.employee_code;

-- 2c. The full decision trail.
select id, action, holiday_date, holiday_name, subject_code, actor, note, at
  from public.holiday_audit order by at;

-- 2d. WHICH OF THOSE DAYS HAVE ALREADY BEEN PAID. Any row here means dropping changes a settled
--     week. Expect ZERO rows before you proceed.
select h.date, h.name, h.type, l.locked_at, l.locked_by_name
  from public.holidays h
  join public.attendance_day_lock l on l.date = to_char(h.date, 'YYYY-MM-DD')
 order by h.date;


-- ── STEP 3 — SNAPSHOT (mandatory; STEP 5 refuses without it) ────────────────────────────────
-- bak_ tables, REST-locked so the snapshot cannot be read or altered from the browser.
begin;

create table if not exists public.bak_holidays_20260815         as select * from public.holidays;
create table if not exists public.bak_holiday_override_20260815 as select * from public.holiday_override;
create table if not exists public.bak_holiday_audit_20260815    as select * from public.holiday_audit;

revoke all on public.bak_holidays_20260815         from anon, authenticated;
revoke all on public.bak_holiday_override_20260815 from anon, authenticated;
revoke all on public.bak_holiday_audit_20260815    from anon, authenticated;

commit;

-- Verify the snapshot MATCHES the live tables. Every pair must be equal.
select (select count(*) from public.holidays)                     as live_holidays,
       (select count(*) from public.bak_holidays_20260815)         as bak_holidays,
       (select count(*) from public.holiday_override)              as live_overrides,
       (select count(*) from public.bak_holiday_override_20260815) as bak_overrides,
       (select count(*) from public.holiday_audit)                 as live_audit,
       (select count(*) from public.bak_holiday_audit_20260815)    as bak_audit;


-- ── STEP 4 — DROP THE FUNCTIONS ─────────────────────────────────────────────────────────────
-- Safe and independently useful: it SHUTS THE DOORS while leaving every record intact. The
-- dashboard's Holidays section will error on save, which is loud and correct — nothing silently
-- half-works. If you only want to stop new holidays being recorded, run STEP 4 and stop.
begin;

drop function if exists public.holiday_override_set(text, text, boolean, text, text, text);
drop function if exists public.holiday_delete(bigint, text, text, text);
drop function if exists public.holiday_edit(bigint, text, text, text, text, text, text);
drop function if exists public.holiday_add(text, text, text, text, text, text);

commit;

-- Expect all four NULL.
select to_regproc('public.holiday_add(text,text,text,text,text,text)')             as add_fn,
       to_regproc('public.holiday_edit(bigint,text,text,text,text,text,text)')     as edit_fn,
       to_regproc('public.holiday_delete(bigint,text,text,text)')                  as delete_fn,
       to_regproc('public.holiday_override_set(text,text,boolean,text,text,text)') as override_fn;


-- ── STEP 5 — DROP THE TABLES, GUARDED ───────────────────────────────────────────────────────
-- REFUSES if the snapshot is short, and REFUSES if any declared holiday sits on a day that has
-- already been paid. Both refusals are the point of this file.
--
-- To override the already-paid refusal — having read STEP 2d and accepted that a settled week will
-- recompute to a different number — uncomment the set_config line.
begin;

-- UNCOMMENT ONLY IF YOU HAVE READ STEP 2d AND ACCEPT CHANGING AN ALREADY-PAID WEEK:
-- select set_config('holiday.force_drop', '1', true);

do $$
declare
  v_live  bigint;
  v_bak   bigint;
  v_paid  bigint;
  v_force boolean := coalesce(nullif(current_setting('holiday.force_drop', true), ''), '0') = '1';
begin
  if to_regclass('public.attendance_records') is null then
    raise exception 'attendance_records does not exist — WRONG PROJECT. Nothing dropped.';
  end if;
  if to_regclass('public.holidays') is null then
    raise notice 'holidays is already absent — nothing to do.';
    return;
  end if;

  -- Snapshot completeness, table by table.
  select count(*) into v_live from public.holidays;
  select count(*) into v_bak  from public.bak_holidays_20260815;
  if v_bak < v_live then
    raise exception 'REFUSING TO DROP: bak_holidays_20260815 has % rows, holidays has %. Run STEP 3 first.', v_bak, v_live;
  end if;

  select count(*) into v_live from public.holiday_override;
  select count(*) into v_bak  from public.bak_holiday_override_20260815;
  if v_bak < v_live then
    raise exception 'REFUSING TO DROP: bak_holiday_override_20260815 has % rows, holiday_override has %. Run STEP 3 first.', v_bak, v_live;
  end if;

  select count(*) into v_live from public.holiday_audit;
  select count(*) into v_bak  from public.bak_holiday_audit_20260815;
  if v_bak < v_live then
    raise exception 'REFUSING TO DROP: bak_holiday_audit_20260815 has % rows, holiday_audit has %. Run STEP 3 first.', v_bak, v_live;
  end if;

  -- Already-paid days.
  select count(*) into v_paid
    from public.holidays h
    join public.attendance_day_lock l on l.date = to_char(h.date, 'YYYY-MM-DD');

  if v_paid > 0 and not v_force then
    raise exception
      'REFUSING TO DROP: % declared holiday(s) fall on days that are already CLOSED and paid. Dropping makes those weeks recompute to a different number than was paid. Read STEP 2d, then uncomment the set_config line to override.', v_paid;
  end if;

  if v_paid > 0 then
    raise notice 'FORCED: dropping with % already-paid holiday day(s). Those weeks will now recompute lower.', v_paid;
  end if;

  drop table public.holiday_override;
  drop table public.holiday_audit;
  drop table public.holidays;
  drop function if exists public.block_holiday_audit_mutation();

  raise notice 'holidays, holiday_override and holiday_audit dropped. bak_ snapshots kept.';
end $$;

commit;


-- ── STEP 6 — VERIFY ─────────────────────────────────────────────────────────────────────────
-- 6a. Gone. Expect all NULL.
select to_regclass('public.holidays')         as holidays,
       to_regclass('public.holiday_override') as overrides,
       to_regclass('public.holiday_audit')    as audit;

-- 6b. The snapshots survive. These are now the only copy — do not drop them casually.
select to_regclass('public.bak_holidays_20260815')         as bak_holidays,
       to_regclass('public.bak_holiday_override_20260815') as bak_overrides,
       to_regclass('public.bak_holiday_audit_20260815')    as bak_audit;

-- 6c. Nothing else moved. attendance_records, its audit and the day locks are untouched by this
--     file from beginning to end.
select (select count(*) from public.attendance_records)    as attendance_rows_unchanged,
       (select count(*) from public.attendance_edit_audit) as edit_audit_unchanged,
       (select count(*) from public.attendance_day_lock)   as day_locks_unchanged;


-- ── STEP 7 — THE CODE SIDE ──────────────────────────────────────────────────────────────────
-- Dropping the tables does NOT require an emergency redeploy. payroll/index.html probes for
-- holidays (loadHolidays swallows its own error and leaves the list empty), so with the tables gone
-- it computes exactly as it did before this feature — every day at its ordinary or Sunday rate.
-- home.js's Holidays section will show its load error, which is visible and correct.
-- Revert the payroll and home.js commits at leisure, and remember the version stamps travel with
-- them: payroll/index.html, home.js and preflight.html's EXPECT move together or payroll disables
-- itself behind the stale-build banner.
