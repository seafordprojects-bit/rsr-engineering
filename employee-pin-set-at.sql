-- ============================================================================
-- employee-pin-set-at.sql
--
-- Adds the "since <date>" behind the personnel screen's passcode status.
-- Pairs with home.js BUILD 2026-08-26c. Additive and idempotent; safe to re-run.
--
-- WHAT IT DOES NOT DO: it never reads, writes, or exposes employees.pin. It records only WHEN the
-- column last changed, never to what.
--
-- WHY A TRIGGER AND NOT AN EDIT TO set_employee_pin
--   set_employee_pin would be the obvious place to stamp a date, but its live definition is still
--   not in this repo (the dump output has not come back yet), and editing a passcode-writing
--   function blind is how a yard stops being able to clock in. A trigger needs no knowledge of it:
--   it fires on the COLUMN, so every path that changes a passcode is stamped - set_employee_pin,
--   the SQL editor, a future admin screen, anything. That is also strictly more correct than
--   stamping inside one function that might not be the only writer.
--
-- BEFORE YOU RUN IT: close the other project's tab. STEP 0 confirms the database from inside.
-- ============================================================================


-- ── STEP 0 — canary: proves this is the OPS project ─────────────────────────────────────────────
select current_database() as database_name,
       (select count(*) from public.attendance_records) as attendance_rows;


-- ── STEP 1 — the column ─────────────────────────────────────────────────────────────────────────
alter table public.employees add column if not exists pin_set_at timestamptz;

comment on column public.employees.pin_set_at is
  'When employees.pin last changed. Maintained by trigger trg_employees_pin_set_at, so it covers '
  'every writer, not just set_employee_pin. Never contains a PIN or a hash. NULL means "not '
  'recorded" - true of every passcode set before 2026-08-26 - and must be rendered as such, never '
  'as "no passcode": has_pin is the authority on whether one exists.';


-- ── STEP 2 — the trigger ────────────────────────────────────────────────────────────────────────
create or replace function public.employees_stamp_pin_set_at()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.pin is not null and btrim(new.pin) <> '' then
      new.pin_set_at := now();
    end if;
  elsif new.pin is distinct from old.pin then
    -- Clearing a passcode clears the date with it, so a blank row can never read
    -- "no PIN (since 24 Aug)" - which would be a sentence about nothing.
    new.pin_set_at := case
      when new.pin is not null and btrim(new.pin) <> '' then now()
      else null
    end;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_employees_pin_set_at on public.employees;
create trigger trg_employees_pin_set_at
before insert or update of pin on public.employees
for each row execute function public.employees_stamp_pin_set_at();


-- ── STEP 3 — backfill: DELIBERATELY NOT DONE ────────────────────────────────────────────────────
-- Every passcode that exists today was hashed by the 2026-08-24 migration, so it is tempting to
-- stamp them all with that date. It is left undone because it would be a claim about something
-- nobody recorded: the HASH dates from 24 Aug, but the PIN a worker actually types may be years
-- older, and the screen would state a "since" date that is not the date the worker's passcode was
-- chosen. The screen therefore shows "PIN set ✓" with no date for these rows, and real dates start
-- appearing as passcodes are changed from here on.
--
-- If you would rather see 24 Aug on every existing row, run this ONE statement and tell me, so the
-- screen's wording can be changed to say what it then means (hash date, not chosen date):
--
--   update public.employees
--      set pin_set_at = timestamptz '2026-08-24 20:31:52+08'
--    where pin_set_at is null
--      and substr(pin, 1, 1) = chr(36)
--      and substr(pin, 2, 1) = '2';
--
-- (chr(36) rather than a regex on purpose: a dollar sign inside a string literal is what made the
--  editor mis-parse an earlier script with ERROR 42601.)


-- ── STEP 4 — verification. Eyeball every row. ───────────────────────────────────────────────────
-- 4a. Column and trigger exist.
select 'column employees.pin_set_at' as object,
       exists (select 1 from information_schema.columns
               where table_schema='public' and table_name='employees' and column_name='pin_set_at') as present
union all
select 'trigger trg_employees_pin_set_at',
       exists (select 1 from pg_trigger where tgname='trg_employees_pin_set_at' and not tgisinternal);

-- 4b. Current state. `dated` will be 0 immediately after install - that is expected (STEP 3).
select count(*)                                        as total_rows,
       count(*) filter (where has_pin)                 as with_passcode,
       count(*) filter (where pin_set_at is not null)  as dated
from   public.employees;

-- 4c. LIVE TRIGGER TEST — proves the stamp actually fires, and rolls itself back so no passcode is
--     harmed. Run the whole block. It must report changed_by_trigger = true.
begin;
  update public.employees
     set pin = pin || 'x'
   where id = (select id from public.employees where pin is not null order by code limit 1);

  select (pin_set_at > now() - interval '1 minute') as changed_by_trigger, code
  from   public.employees
  where  id = (select id from public.employees where pin is not null order by code limit 1);
rollback;   -- nothing above is kept. The passcode and the date are both restored.


-- ── STEP 4b — PERSISTENCE CHECK (do not skip) ───────────────────────────────────────────────────
-- Same reason as every other migration in this repo: a 2026-07-31 install verified live and its
-- objects were later found in NEITHER project.
--   1. Run everything above.  2. CLOSE the editor tab.  3. Open a FRESH tab on this project.
--   4. Re-run STEP 0, then 4a.  5. If the column or trigger is missing, STOP and say so - do not
--      re-run this file on top, because that erases the evidence.
