-- ============================================================================
-- employee-pin-set-at-rollback.sql
--
-- Undoes employee-pin-set-at.sql.
--
-- Safe to run on its own: pin_set_at is display-only. Nothing can clock in or out because of it,
-- and no passcode depends on it. The personnel screen simply stops showing "(since …)" - revert
-- home.js alongside it, or the screen will read pin_set_at and always find undefined, which it
-- already renders as a plain "PIN set ✓".
--
-- BEFORE YOU RUN IT: close the other project's tab. STEP 0 confirms the database from inside.
-- ============================================================================


-- ── STEP 0 — canary: proves this is the OPS project ─────────────────────────────────────────────
select current_database() as database_name,
       (select count(*) from public.attendance_records) as attendance_rows;


-- ── STEP 1 — keep the dates before dropping them ────────────────────────────────────────────────
-- Once the column goes, these are unrecoverable: nothing else records when a passcode changed.
select code, name, pin_set_at
from   public.employees
where  pin_set_at is not null
order  by pin_set_at desc;


-- ── STEP 2 — trigger, then function, then column ────────────────────────────────────────────────
drop trigger  if exists trg_employees_pin_set_at on public.employees;
drop function if exists public.employees_stamp_pin_set_at();
alter table public.employees drop column if exists pin_set_at;


-- ── STEP 3 — verification: all three gone, and no passcode was touched ──────────────────────────
select 'column employees.pin_set_at' as object,
       not exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='employees' and column_name='pin_set_at') as dropped
union all
select 'trigger trg_employees_pin_set_at',
       not exists (select 1 from pg_trigger where tgname='trg_employees_pin_set_at' and not tgisinternal)
union all
select 'function employees_stamp_pin_set_at',
       not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                   where n.nspname='public' and p.proname='employees_stamp_pin_set_at');

-- Passcodes are untouched by all of the above. Confirming it here so nobody has to wonder.
select count(*)                                     as total_rows,
       count(*) filter (where has_pin)              as with_passcode,
       count(*) filter (where pin ~ '^\$2[aby]\$')  as bcrypt_rows
from   public.employees;
