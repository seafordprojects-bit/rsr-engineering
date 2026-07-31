-- ═══════════════════════════════════════════════════════════════════════════════════════════
--  PAKYAW EXEMPTION BY EMPLOYMENT TYPE — replaces the PEM code-prefix inference
--  Owner-approved 2026-07-29. Additive + idempotent. Run one STEP at a time and paste back.
--
--  WHY: exemption is currently inferred from the code text 'PEM' in SEVEN places across THREE
--  independent implementations. The owner's rule is that a converted man KEEPS his PEM code and
--  displays as regular, so a prefix can no longer decide anything: every one of those sites would
--  keep exempting him forever. Exemption becomes a dated fact on the employee row.
--
--  DESIGN NOTE — the CHECK constraint has to become a TRIGGER.
--  employee_suspensions_no_pem is `check (not public.awol_is_pem(employee_code))`, and
--  awol_is_pem is declared IMMUTABLE because today it only parses a string. Once it reads
--  employees.employment_type it is a table lookup, which is STABLE at best. A CHECK constraint
--  that calls a table-reading function is unsound: pg_dump/restore re-validates constraints, and
--  if employees has not been loaded at that moment the restore fails. Postgres will not stop you
--  writing it — it just breaks later, during a restore, which is the worst possible time.
--  So STEP 3 drops the constraint, redefines the function and installs an equivalent BEFORE
--  INSERT/UPDATE trigger, all in ONE transaction so no unguarded window ever exists.
--
--  DOES NOT TOUCH PAY. Owner-confirmed: conversion changes AWOL treatment only. daily_rate is
--  untouched here, and payroll/ contains no reference to PEM or pakyaw at all.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════════════════
--  STEP 0 — CENSUS. READ-ONLY. Run this ALONE and read it before anything else.
--  Nothing below STEP 0 should be pasted until the five men listed here are the five you expect.
--  This is the last moment the code prefix decides anything, so it is the moment to check it.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- 0a. THE FIVE MEN who will be marked pakyaw. Eyeball this list.
select code, name, home_site, position, daily_rate,
       started_on, public.leave_try_date(started_on::text) as start_parses_to
  from public.employees
 where upper(regexp_replace(code,'\s','','g')) like 'PEM%'
 order by code;
-- EXPECT exactly five: PEM 0001 Julius · PEM 0002 Jembo · PEM 0003 Warren
--                      PEM 0004 Erwin  · PEM 0005 Melvin      (all Carmen)
-- If ANY other man appears here, or one of these five is missing, STOP and tell me.

-- 0b. Totals.
select count(*)                                                                     as employees_total,
       count(*) filter (where upper(regexp_replace(code,'\s','','g')) like 'PEM%')     as pem_by_prefix,
       count(*) filter (where upper(regexp_replace(code,'\s','','g')) not like 'PEM%') as regular_by_prefix
  from public.employees;
-- EXPECT: employees_total 43 · pem_by_prefix 5 · regular_by_prefix 38 (as of 2026-07-31).
-- THIS COUNTS EVERY ROW, separated or not — there is no separated_at filter here, and rows are
-- never deleted. So it stays 43 even though the ACTIVE roster is 41 after the 2026-07-31
-- separations (RSR 0017, RSR 0020). Only awol_skip_list(), which filters separated_at is null,
-- reads 41. Two different questions, two different 43-vs-41 answers, both correct.

-- 0c. Anyone whose start date will NOT parse falls back to created_at for type_effective_from.
-- Harmless for anyone not later converted, but worth seeing before it is written.
select code, name, started_on
  from public.employees
 where public.leave_try_date(started_on::text) is null
 order by code;
-- EXPECT: however many rows — these get created_at as their floor instead. Not an error.

-- 0d. Does anyone NOT prefixed PEM look like a pakyaw man by name or position?
-- The prefix is about to become permanent truth; this is the last chance to catch a miscoded man.
select code, name, position, dept
  from public.employees
 where upper(regexp_replace(code,'\s','','g')) not like 'PEM%'
   and (position ilike '%pakyaw%' or dept ilike '%pakyaw%' or position ilike '%piece%')
 order by code;
-- EXPECT: zero rows. Any row here is a man the prefix would silently mark 'regular'.

-- 0e. The constraint that STEP 3 replaces.
select conname, convalidated from pg_constraint where conname = 'employee_suspensions_no_pem';
-- EXPECT: one row, convalidated = false  (added NOT VALID, never validated)

-- ── STEP 1 — the columns ────────────────────────────────────────────────────────────────────
-- Additive and nullable: no default, no rewrite, no lock of consequence. Every existing reader
-- keeps working because nothing selects these yet — the JS is deliberately NOT edited until
-- STEP 6 passes (naming a column before its migration is live is what killed the dashboard
-- employee list in commit b64ed5c).
alter table public.employees
  add column if not exists employment_type     text,
  add column if not exists type_effective_from date;

-- VERIFY — touch the new thing rather than assume it landed.
select column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema = 'public' and table_name = 'employees'
   and column_name in ('employment_type','type_effective_from')
 order by column_name;
-- EXPECT exactly two rows:
--   employment_type      | text | YES
--   type_effective_from  | date | YES
-- Both must be YES (nullable) at this stage — STEP 2 is what fills them.

-- ── STEP 2 — backfill from the prefix, ONCE, then never again ───────────────────────────────
-- This is the only moment the prefix is ever allowed to decide anything. After this the column
-- is the authority and the prefix is decoration.
-- type_effective_from: their start date, so the counter floor sits before any attendance they
-- have and nothing changes for anyone who is not converted later.
update public.employees
   set employment_type = case
         when upper(regexp_replace(code,'\s','','g')) like 'PEM%' then 'pakyaw'
         else 'regular' end,
       type_effective_from = coalesce(
         public.leave_try_date(started_on::text),   -- tolerant: handles ISO and MM/DD/YYYY
         created_at::date)
 where employment_type is null;

-- Guarded so re-running STEP 2 is a no-op instead of an error, and added VALID rather than
-- NOT VALID: the column is brand new and the update above wrote every row, so there is nothing
-- to grandfather. employee_suspensions_no_pem has sat NOT VALID and unvalidated since 07-26
-- precisely because "validate it later" never happens — not repeating that here.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'employees_employment_type_chk') then
    alter table public.employees
      add constraint employees_employment_type_chk
      check (employment_type in ('pakyaw','regular'));
  end if;
end $$;

select conname, convalidated from pg_constraint where conname = 'employees_employment_type_chk';
-- EXPECT: one row, convalidated = TRUE (contrast with employee_suspensions_no_pem, still false)

select employment_type, count(*), min(type_effective_from) as earliest, max(type_effective_from) as latest
  from public.employees group by 1 order by 1;
-- EXPECT: pakyaw 5 · regular 38, both with non-null dates

select code, name, employment_type, type_effective_from
  from public.employees
 where employment_type = 'pakyaw' order by code;
-- EXPECT exactly: PEM 0001 Julius · PEM 0002 Jembo · PEM 0003 Warren · PEM 0004 Erwin · PEM 0005 Melvin

-- ── STEP 3 — the swap: constraint out, function redefined, trigger in — ONE transaction ─────
-- ORDER MATTERS AND IS THE REASON THIS IS ONE STEP.
-- awol_is_pem is IMMUTABLE today and employee_suspensions_no_pem is a CHECK that calls it.
-- Redefining the function while that constraint still depends on it either errors outright or,
-- worse, succeeds and leaves a CHECK calling a table-reading function — the state that breaks a
-- pg_dump/restore. And dropping the constraint in a separate step would leave a window with no
-- guard at all, where a raw REST insert could suspend a pakyaw man.
-- Wrapping all three in one transaction removes both problems: DDL is transactional in Postgres,
-- so the guard is never absent and the unsound intermediate state is never visible.
-- If ANY statement fails, the whole thing rolls back and nothing has changed. Paste it whole.
begin;

-- 3a. Constraint out first, so nothing depends on the function when it is replaced.
alter table public.employee_suspensions drop constraint if exists employee_suspensions_no_pem;

-- 3b. Redefine IN PLACE — same name, same signature, so awol_set_suspended (:134) and
--     awol_manual_suspend (:337) are corrected by this one change and cannot be forgotten.
--       * STABLE, not IMMUTABLE — it now reads a table.
--       * Matched on code_norm, never the raw code: employee_suspensions stores a free-text code
--         that drifts in spacing from employees.code ('RSR 0025' vs 'RSR0025').
--       * UNKNOWN CODE RETURNS FALSE (= not exempt), deliberately. A silent exemption is the
--         exact failure the owner named; an unknown code gets processed and noticed, a wrongly
--         exempted man is never noticed at all.
create or replace function public.awol_is_pem(p_code text)
returns boolean language sql stable as $$
  select coalesce(
    (select e.employment_type = 'pakyaw'
       from public.employees e
      where e.code_norm = upper(regexp_replace(coalesce(p_code,''), '[^A-Za-z0-9]', '', 'g'))
      limit 1),
    false);
$$;
grant execute on function public.awol_is_pem(text) to anon, authenticated;

-- 3c. Trigger in — the sound way to enforce a rule that depends on another table. Same guarantee
--     the constraint gave: a raw REST insert still cannot suspend a pakyaw worker past the RPCs.
create or replace function public.employee_suspensions_no_pem_trg()
returns trigger language plpgsql as $$
begin
  if public.awol_is_pem(new.employee_code) then
    raise exception 'PAKYAW worker % is exempt from AWOL and cannot be suspended', new.employee_code
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists employee_suspensions_no_pem_bi on public.employee_suspensions;
create trigger employee_suspensions_no_pem_bi
  before insert or update on public.employee_suspensions
  for each row execute function public.employee_suspensions_no_pem_trg();

commit;

-- ── STEP 4 — verify the swap landed ─────────────────────────────────────────────────────────
select public.awol_is_pem('PEM 0001') as pem_spaced,   -- EXPECT true
       public.awol_is_pem('PEM0001')  as pem_tight,    -- EXPECT true
       public.awol_is_pem('RSR 0025') as regular,      -- EXPECT false
       public.awol_is_pem('NOPE 999') as unknown_code, -- EXPECT false (fails toward not-exempt)
       public.awol_is_pem(null)       as null_code;    -- EXPECT false

select (select provolatile from pg_proc where proname = 'awol_is_pem')                     as volatility_must_be_s,
       (select count(*) from pg_constraint where conname = 'employee_suspensions_no_pem')  as old_check_must_be_0,
       (select count(*) from pg_trigger
         where tgname = 'employee_suspensions_no_pem_bi' and not tgisinternal)             as trigger_must_be_1;
-- EXPECT: s · 0 · 1

-- ── STEP 5 — PROVE the guard actually fires (rolled back, writes nothing) ───────────────────
begin;
  insert into public.employee_suspensions (employee_code, active, reason, suspended_on)
  values ('PEM 0001', true, 'PROBE - must be refused', '07/29/2026');
rollback;
-- EXPECT: ERROR - PAKYAW worker PEM 0001 is exempt from AWOL and cannot be suspended
-- If this INSERTS instead of erroring, STOP: the guard is not working and no JS may be edited.

begin;
  insert into public.employee_suspensions (employee_code, active, reason, suspended_on)
  values ('RSR ZZPROBE', true, 'PROBE - must be allowed', '07/29/2026');
  select 'control row accepted' as control;
rollback;
-- EXPECT: succeeds, then rolls back. Proves the guard is not over-broad.

-- ── STEP 6 — FINAL VERIFY (read-only) ───────────────────────────────────────────────────────
select (select count(*) from public.employees where employment_type is null)          as untyped_must_be_0,
       (select count(*) from public.employees where type_effective_from is null)       as undated_must_be_0,
       (select count(*) from public.employees where employment_type = 'pakyaw')        as pakyaw_must_be_5,
       (select provolatile from pg_proc where proname = 'awol_is_pem')                 as volatility_must_be_s,
       (select count(*) from pg_trigger
         where tgname = 'employee_suspensions_no_pem_bi' and not tgisinternal)         as trigger_must_be_1,
       (select count(*) from pg_constraint where conname = 'employee_suspensions_no_pem') as old_check_must_be_0;
-- EXPECT: 0 · 0 · 5 · s · 1 · 0
-- Only when this row is exactly right may the two JS copies be edited.

-- ── STEP 7 — no employment type may begin in the future ─────────────────────────────────────
-- Found during the STEP 6 review: PEM 0001 (Julius) carries started_on = '2026-12-07', so his
-- type_effective_from landed four months in the future. Not a parse bug — leave_try_date read
-- an ISO date correctly; the roster record itself is wrong.
-- Harmless while he is pakyaw (the floor is never consulted for an exempt man), but the day he
-- is converted to regular that floor makes him UNCOUNTABLE until December: a silent exemption,
-- which is the exact failure this whole migration exists to remove. Guard it at the database.
-- NOT VALID so the existing bad row does not block the constraint; it is enforced on every
-- write from now on, and validating it later is the checklist item that proves Julius is fixed.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'employees_type_from_not_future') then
    alter table public.employees
      add constraint employees_type_from_not_future
      check (type_effective_from <= current_date) not valid;
  end if;
end $$;

-- 7a. Who is currently in breach? Expect exactly one: PEM 0001.
select code, name, employment_type, type_effective_from, started_on
  from public.employees
 where type_effective_from > current_date
 order by code;

-- 7b. AFTER you have corrected Julius's start date (owner decision - I am not guessing it),
--     re-run these two. The second must return convalidated = true.
--   update public.employees
--      set started_on = '<the real date>',
--          type_effective_from = public.leave_try_date('<the real date>')
--    where code = 'PEM 0001';
--   alter table public.employees validate constraint employees_type_from_not_future;
--   select conname, convalidated from pg_constraint where conname = 'employees_type_from_not_future';
