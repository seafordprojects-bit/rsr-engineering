-- ============================================================================
-- apply-identify-rpc.sql                                                FINAL - 2026-08-26
--
-- Plain ASCII only, on purpose: copying from a terminal was corrupting multi-byte characters
-- and producing broken tokens (nulext, n:text, an unterminated string). Open THIS FILE and copy
-- from it. Nothing in here is outside 7-bit ASCII, so there is nothing left to mangle.
--
-- Option A: the kiosk keeps its keypad-only flow. A worker types six digits and the DATABASE says
-- who that is, because employees.pin has been a bcrypt hash since the 2026-08-24 migration and the
-- browser can no longer compare it.
--
-- Pairs with kiosk/index.html v2026-08-26b.
--
-- -- HOW TO RUN ----------------------------------------------------------------------------------
-- RUN ONE STEP AT A TIME, IN ORDER. Every step is a SINGLE statement: select the block and press
-- Run, or put the cursor in it and press Ctrl+Enter. Nothing here needs the file to be run as one
-- batch, and a step that fails leaves the others untouched - fix it and carry on from there.
--
-- Steps 1-7 install. Steps 8-12 verify. Step 13 is the pre-walkthrough check.
-- PART 2 at the bottom is the ROLLBACK. Do not run it. It is there for the day you need it.
--
-- Every statement is idempotent, so re-running a step is safe.
--
-- -- NO DOLLAR SIGNS IN LITERALS -----------------------------------------------------------------
-- The editor mis-parsed an earlier script (ERROR 42601) because a dollar sign inside a string
-- literal confused its client-side statement splitter. Bcrypt hashes begin with a dollar sign, so
-- the shape test is written as chr(36) instead of a regex, here and everywhere below. The function
-- body still uses proper dollar-quoting, which is well-formed and parses correctly.
--
-- -- BEFORE YOU RUN IT (standing rule, owner 2026-08-03) -----------------------------------------
--   1. Close the OTHER Supabase project's tab (the inventory backend).
--   2. STEP 1 confirms which database you are in, from inside the tab, never from its title.
--   3. A wrong-project WRITE succeeds silently, and steps 2-7 are writes.
-- ============================================================================
-- ============================================================================
--  PART 1 - INSTALL
-- ============================================================================


-- ================================================================================================
-- STEP 1 - CANARY. Run this first, alone. attendance_records does not exist in the inventory
-- project, so a wrong tab fails here, before anything is created.
-- ================================================================================================
select current_database()                                as database_name,
       (select count(*) from public.attendance_records)  as attendance_rows;


-- ================================================================================================
-- STEP 2 - THE THROTTLE COUNTER.
--
-- Reconciled to issuer_for_pin, not verify_pin, and that choice is the point:
--   verify_pin throttles PER EMPLOYEE (verify_pin_emp_throttle), which it can do because the caller
--   already names the employee - the PIN only confirms an identity it was given.
--   identify_employee_by_pin has no employee until AFTER the scan, and a failed identification
--   belongs to nobody, so there is no row to count against. Per-employee throttling is structurally
--   inapplicable here.
--   issuer_for_pin has exactly this problem and solves it with a SINGLE-ROW throttle. That is the
--   pattern this follows, with issuer_for_pin's numbers: 10 failures / 15 minutes.
--
-- Single row, boolean primary key whose only allowed value is true - the same shape
-- kiosk-admin-gate.sql uses for the admin passcode.
-- ================================================================================================
create table if not exists public.pin_identify_throttle (
  id           boolean primary key default true check (id),
  window_start timestamptz not null default now(),
  failures     int         not null default 0
);


-- ================================================================================================
-- STEP 3 - SEED THE THROTTLE ROW.
-- ================================================================================================
insert into public.pin_identify_throttle (id) values (true) on conflict (id) do nothing;


-- ================================================================================================
-- STEP 4 - THE COLLISION LOG.
-- Two active workers sharing a PIN is a payroll-integrity fault: whoever the system picks, one man
-- can punch as another. The function REFUSES to pick, and writes here so the office can fix it by
-- name. Records employee CODES and a count - never a PIN, never a hash.
-- ================================================================================================
create table if not exists public.pin_collision_log (
  id            bigint generated always as identity primary key,
  occurred_at   timestamptz not null default now(),
  matched_codes text[]      not null,
  matched_count int         not null
);


-- ================================================================================================
-- STEP 5 - LOCK BOTH TABLES AWAY FROM THE API.
-- RLS is disabled project-wide, so without this an anon key could read the collision log over
-- PostgREST and learn which workers share a PIN. The function writes them as its owner, so revoking
-- costs it nothing.
-- ================================================================================================
revoke all on table public.pin_collision_log, public.pin_identify_throttle from anon, authenticated;


-- ================================================================================================
-- STEP 6 - THE FUNCTION.
--
-- WHY THE SCAN IS ALWAYS FULL. A limit 1 would let Postgres stop at the first match and would cut
-- the average correct-PIN answer from about 3.1s to about 1.5s. It is not used, because stopping
-- early makes a second match invisible - and a collision must be detected and refused, never
-- resolved by picking someone. Defined collision behaviour costs the early exit. issuer_for_pin
-- makes the same trade.
--
-- WHY THE BCRYPT SHAPE GUARD. extensions.crypt(input, stored) uses `stored` as the salt. On a row
-- whose pin is still six plaintext digits, that raises "invalid salt" and the whole function errors
-- - which would refuse EVERY worker, not just that one. The guard keeps one un-migrated row from
-- taking the yard down. STEP 13 finds any such row.
--
-- WHY SUCCESS RESETS THE COUNTER. issuer_for_pin serves three issuers; this serves the whole yard at
-- 07:55. Ten failures inside fifteen minutes is easy to reach honestly on a Monday morning, and a
-- throttled yard cannot clock in at all. Resetting on a successful identification means the limit
-- only bites during a sustained run of failures with no successes between them - which is what an
-- attack looks like and what a fumbling morning does not. If verify_pin's throttle does NOT reset
-- on success and you want these to match exactly, delete the reset line marked below.
-- ================================================================================================
create or replace function public.identify_employee_by_pin(pin_input text)
returns table(status text, id uuid, code text, name text)
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  v_window_minutes constant int := 15;   -- issuer_for_pin's window
  v_max_failures   constant int := 10;   -- issuer_for_pin's limit
  v_failures int;
  v_matches  int;
  v_codes    text[];
  v_ids      uuid[];
  v_names    text[];
begin
  -- Shape guard: anything that is not six digits cannot be a PIN, so refuse before paying for a
  -- scan. This is also what makes a junk flood cheap to absorb. translate() strips every digit; an
  -- empty result means the input was all digits.
  if pin_input is null
     or length(pin_input) <> 6
     or translate(pin_input, '0123456789', '') <> '' then
    return query select 'not_found'::text, null::uuid, null::text, null::text;
    return;
  end if;

  -- EVERY reference to the throttle table is alias-qualified (t.). `id` is also an OUT parameter of
  -- this function, and inside a plpgsql body an unqualified `id` resolves to the PARAMETER, not the
  -- column: "column reference id is ambiguous", 42702, at runtime only. Same class as the 2026-08-24
  -- on-conflict lesson. Do not remove an alias here to tidy it up.
  --
  -- Read and, if the window has expired, reset - in ONE statement, so there is no read-then-write
  -- gap and no second place for the ambiguity to hide.
  update public.pin_identify_throttle t
     set window_start = case when t.window_start < now() - make_interval(mins => v_window_minutes)
                             then now() else t.window_start end,
         failures     = case when t.window_start < now() - make_interval(mins => v_window_minutes)
                             then 0 else t.failures end
   where t.id = true
  returning t.failures into v_failures;

  if not found then
    -- No throttle row (STEP 3 not run, or it was deleted). Create it and carry on rather than
    -- refusing every worker over a missing counter. The conflict target is named by CONSTRAINT
    -- rather than by column, because an inference target `(id)` is exposed to the same shadowing.
    insert into public.pin_identify_throttle (id, window_start, failures)
    values (true, now(), 0)
    on conflict on constraint pin_identify_throttle_pkey do nothing;
    v_failures := 0;
  end if;

  -- Refuse BEFORE the scan. The whole point of the throttle is to not spend the 3.1s.
  if v_failures >= v_max_failures then
    return query select 'throttled'::text, null::uuid, null::text, null::text;
    return;
  end if;

  -- One pass. Collect every match so a collision is visible; arrays are ordered by code so the
  -- answer is stable rather than whatever the heap happened to return.
  select count(*),
         array_agg(e.code order by e.code),
         array_agg(e.id   order by e.code),
         array_agg(e.name order by e.code)
    into v_matches, v_codes, v_ids, v_names
  from public.employees e
  -- NO employment-status filter. employees has no is_active column: adding one raised 42703 on the
  -- deployed function and refused every worker at every tablet until it was replaced. Identification
  -- is identity-only and changes nothing about who may punch - the same policy as the client-side
  -- lookup it replaces. See the OPTIONAL section after STEP 14 before adding any such filter.
  where e.pin is not null
    and substr(e.pin, 1, 1) = chr(36)
    and substr(e.pin, 2, 1) = '2'
    and e.pin = extensions.crypt(pin_input, e.pin);

  if v_matches = 1 then
    update public.pin_identify_throttle t
       set failures = 0, window_start = now()          -- <- the reset described above
     where t.id = true;
    return query select 'ok'::text, v_ids[1], v_codes[1], v_names[1];
    return;
  end if;

  update public.pin_identify_throttle t set failures = t.failures + 1 where t.id = true;

  if v_matches > 1 then
    -- Log once an hour per identical set, so a worker retrying does not bury the office in rows.
    if not exists (
      select 1 from public.pin_collision_log
      where matched_codes = v_codes
        and occurred_at > now() - interval '1 hour'
    ) then
      insert into public.pin_collision_log (matched_codes, matched_count)
      values (v_codes, v_matches);
    end if;
    return query select 'collision'::text, null::uuid, null::text, null::text;
    return;
  end if;

  return query select 'not_found'::text, null::uuid, null::text, null::text;
end;
$fn$;


-- ================================================================================================
-- STEP 7a - THE STATEMENT TIMEOUT.
-- A full bcrypt scan is about 3.1s at 43 active workers and grows linearly (about 4.3s at 60, 5.8s
-- at 80). The project default is 3s, which this function would exceed TODAY. Raising it
-- per-function leaves the 3s default protecting everything else - importantly, payroll.
-- ================================================================================================
alter function public.identify_employee_by_pin(text) set statement_timeout = '15s';


-- ================================================================================================
-- STEP 7b - TAKE THE DEFAULT GRANT AWAY.
-- ================================================================================================
revoke all on function public.identify_employee_by_pin(text) from public;


-- ================================================================================================
-- STEP 7c - GRANT IT TO THE KIOSK.
-- The kiosk calls it with the anon key. Nothing else should be able to.
-- ================================================================================================
grant execute on function public.identify_employee_by_pin(text) to anon;


-- ================================================================================================
-- STEP 8 - VERIFY: the function exists, is security definer, carries the timeout.
-- function_settings MUST contain both statement_timeout=15s and search_path=public.
-- ================================================================================================
select p.proname                             as function_name,
       p.prosecdef                           as security_definer,
       coalesce(p.proconfig::text, '(none)') as function_settings
from   pg_proc p
join   pg_namespace n on n.oid = p.pronamespace
where  n.nspname = 'public'
and    p.proname = 'identify_employee_by_pin';


-- ================================================================================================
-- STEP 9 - VERIFY: the grants. All three rows must read true.
-- ================================================================================================
select 'anon CAN execute the function' as check_name,
       has_function_privilege('anon', 'public.identify_employee_by_pin(text)', 'EXECUTE') as ok
union all
select 'anon CANNOT read pin_collision_log',
       not has_table_privilege('anon', 'public.pin_collision_log', 'SELECT')
union all
select 'anon CANNOT read pin_identify_throttle',
       not has_table_privilege('anon', 'public.pin_identify_throttle', 'SELECT');


-- ================================================================================================
-- STEP 10 - SMOKE-TEST EVERY RETURN PATH. Do not skip any of 10a-10d.
--
-- WHY THIS IS FOUR STEPS AND NOT ONE. This function has been broken twice by errors that no amount
-- of reading catches, because each lived on ONE path and only appeared when that path ran:
--   42703  a filter on a column that does not exist   - every path
--   42702  `where id` resolving to the OUT parameter  - the throttle UPDATEs only
-- A single not_found call exercises maybe half the statements in the body. Each sub-step below
-- reaches a different one. Run all of them.
--
-- WHAT EACH ONE PROVES:
--   10a  shape guard   - returns before the throttle is touched at all
--   10b  scanned miss  - the read/reset UPDATE *and* the failure-increment UPDATE
--   10c  throttle trip - the early-refuse branch, and that the counter really counts
--   10d  reset         - only reachable with a REAL passcode, so it happens at the kiosk
-- ================================================================================================
-- ---- STEP 10a - shape guard. Expect one row: not_found, with three nulls. ----
select * from public.identify_employee_by_pin('abc');


-- ------------------------------------------------------------------------------------------------
-- STEP 10b - a scanned miss. Six digits belonging to nobody. Expect one row: not_found.
-- THIS is the step that runs the two UPDATE statements that carried the 42702. A row back instead
-- of an error means they are fixed.
-- ------------------------------------------------------------------------------------------------
select * from public.identify_employee_by_pin('000000');


-- ------------------------------------------------------------------------------------------------
-- STEP 10c - the throttle actually trips. Eleven misses; the limit is ten per fifteen minutes.
-- Expect: the first ten answer not_found, the eleventh answers throttled.
-- If every row says not_found the counter is not incrementing, and the yard has no brute-force
-- protection. If the FIRST row says throttled, run STEP 12 and try again - an earlier test left the
-- counter high.
-- ------------------------------------------------------------------------------------------------
select i, (public.identify_employee_by_pin(lpad(i::text, 6, '0'))).status
from   generate_series(1, 11) as i;


-- ------------------------------------------------------------------------------------------------
-- STEP 10d - THE SUCCESS PATH. Not runnable here, and that is deliberate.
--
-- The `ok` branch has its own UPDATE of the throttle - one of the two statements that carried the
-- 42702 - and NOTHING above reaches it. It runs only when a real passcode matches.
--
-- DO NOT test it by typing a worker's real PIN into this editor. The SQL editor keeps a query
-- history, and that would write a live passcode into it in clear text.
--
-- Prove it at the kiosk instead, during the walkthrough:
--   1. Run STEP 12 first, so the counter is clean after 10c.
--   2. Have one worker clock in normally at a tablet.
--   3. Their name and photo appearing IS the proof - that is the ok branch, throttle UPDATE and all.
--   4. If they see "No connection - try again" instead, the ok path is still broken. Come back and
--      run STEP 11b: if failures moved but nobody was identified, it is this function, not the
--      network.
-- ------------------------------------------------------------------------------------------------


-- ------------------------------------------------------------------------------------------------
-- STEP 11b - the throttle counter, in the open. Safe to run at any time, reveals nothing.
-- After a successful clock-in, failures should read 0 and window_start should be recent: that is
-- the ok branch's UPDATE having run.
-- ------------------------------------------------------------------------------------------------
select failures, window_start, now() - window_start as window_age
from   public.pin_identify_throttle;


-- ================================================================================================
-- STEP 11 - VERIFY: how long a miss actually takes here.
-- Read "Execution Time" at the bottom. If it is anywhere near 15s the timeout at STEP 7a is too
-- tight for the current headcount and must go up before the walkthrough.
-- ================================================================================================
explain (analyze, timing on, costs off)
select e.code from public.employees e
where e.pin is not null
  and substr(e.pin, 1, 1) = chr(36)
  and substr(e.pin, 2, 1) = '2'
  and e.pin = extensions.crypt('000000', e.pin);


-- ================================================================================================
-- STEP 12 - RESET THE THROTTLE after the smoke tests, so the yard starts clean.
-- Run this once you are done poking at STEP 10.
-- ================================================================================================
-- Alias-qualified like the ones inside the function. At top level there is no OUT parameter to
-- shadow it, so a bare `where id` would work here - but this is the exact idiom that broke the
-- function, and the next person to copy a line will copy one of these.
update public.pin_identify_throttle t set failures = 0, window_start = now() where t.id = true;


-- ================================================================================================
-- STEP 12b - PERSISTENCE CHECK (do not skip, nothing to run here)
-- A 2026-07-31 install verified live and its objects were later found in NEITHER project; the cause
-- is still unknown. Anything that creates tables or functions carries this check, as
-- kiosk-heartbeat-snapshot.sql STEP 5b does.
--   1. Finish steps 1-12 and confirm 8, 9 and 10 look right.
--   2. CLOSE the SQL editor tab completely.
--   3. Open a FRESH tab on this project.
--   4. Re-run STEP 1, then STEP 8 and STEP 9.
--   5. If the function or either table is missing, STOP and say so. Do NOT re-run this file on top:
--      a silent disappearance is the thing worth understanding, and re-running erases the evidence.
-- ================================================================================================


-- ================================================================================================
-- STEP 13 - WHO CANNOT CLOCK IN. Run this BEFORE the walkthrough.
-- Every worker listed will type their PIN at the tablet and be refused, because their stored
-- passcode is not a bcrypt hash the function can match. This is the list of people to fix, by name.
-- Selects no secret. AN EMPTY RESULT IS THE GOOD OUTCOME.
-- ================================================================================================
select code,
       name,
       dept,
       case when pin is null or btrim(pin) = ''
                 then 'no passcode set'
            when length(btrim(pin)) = 6
                 and translate(btrim(pin), '0123456789', '') = ''
                 then 'still plaintext - never migrated'
            else 'unrecognised passcode format'
       end as problem
from   public.employees
where  not (substr(coalesce(pin,''), 1, 1) = chr(36) and substr(coalesce(pin,''), 2, 1) = '2')
order  by dept, name;


-- ================================================================================================
-- STEP 14 - WHAT COLUMNS employees ACTUALLY HAS.
-- Optional, but run it once and paste the result back. It is the authority on whether any
-- employment-status column exists, and it is the question that should have been asked before an
-- is_active filter was ever written. Costs nothing, reveals nothing.
-- ================================================================================================
select column_name,
       data_type,
       is_nullable,
       coalesce(column_default, '(none)') as column_default
from   information_schema.columns
where  table_schema = 'public'
and    table_name   = 'employees'
order  by ordinal_position;




-- ============================================================================
-- ============================================================================
--
--   OPTIONAL - AN EMPLOYMENT-STATUS FILTER.   DO NOT RUN THIS SECTION YET.
--
--   Nothing below is part of the install. It is a proposal, and it is deliberately not wired in.
--
--   -- WHAT HAPPENED, SO IT DOES NOT HAPPEN AGAIN ------------------------------------------------
--   A filter on is_active was added to this function on 2026-08-26 on the strength of a query that
--   returned zero rows. The column does not exist; the zero rows were the absence of a column, not
--   the absence of people. The deployed function then raised 42703 and refused EVERY worker at
--   EVERY tablet. This is the same failure home.js records at its getEmployees() select, which is
--   why that file names columns only after their migration is confirmed live.
--
--   The lesson is not "avoid filters". It is: a predicate cannot tell you whether its own column
--   exists. Ask information_schema (STEP 14), never a WHERE clause.
--
--   -- DO NOT USE employment_type FOR THIS -------------------------------------------------------
--   employees.employment_type exists and is tempting, but it holds 'regular' / 'pakyaw'. It is the
--   AWOL exemption marker (owner 2026-07-29), NOT employment status. A pakyaw worker is employed
--   and must be able to clock in. Filtering on it would stop real people working.
--
--   -- THE LIKELY CANDIDATE ----------------------------------------------------------------------
--   employee-lifecycle.sql introduces `separated_at`. home.js deliberately does NOT select it yet,
--   with the note that it "goes in only after that migration is live" - so whether it exists here
--   is exactly the open question STEP 14 answers.
--
--   -- HOW TO ADD IT, IF STEP 14 SHOWS separated_at EXISTS AND YOU WANT IT ------------------------
--   1. Run STEP 14 and confirm separated_at is in the list. If it is not, stop.
--   2. Run this to see who it would turn away. It must be a list you recognise as ex-employees,
--      and the ones with a passcode are the ones who would notice:
--
--        select code, name, dept, separated_at,
--               (substr(coalesce(pin,''),1,1) = chr(36)) as has_working_passcode
--        from   public.employees
--        where  separated_at is not null
--        order  by separated_at desc;
--
--   3. Only then, re-run STEP 6 with this line added to the function's WHERE, immediately after
--      `where e.pin is not null`:
--
--        and e.separated_at is null
--
--   4. Flip scenario H8 in tests/kiosk-stress/kiosk-stress.mjs, which currently asserts that NO
--      employment-status policy is applied. It is there to catch exactly this change being made by
--      accident; changing it should be a deliberate act.
--
-- ============================================================================
-- ============================================================================




-- ============================================================================
-- ============================================================================
--
--   PART 2 - ROLLBACK.   DO NOT RUN THIS SECTION.
--
--   Nothing below is part of the install. It is here so that the undo lives next to the thing it
--   undoes, instead of in a file nobody can find at 07:50 on a Monday.
--
--   !! READ BEFORE USING IT. Running this does NOT restore clock-in. It removes the only thing that
--     can identify a worker from a typed PIN, so with kiosk/index.html v2026-08-26b deployed EVERY
--     worker gets "No connection - try again" at every tablet. Rolling back the database means
--     rolling back the page too: revert kiosk/index.html and preflight.html to the previous commit.
--
--     Rolling back the PAGE ALONE, and leaving this function in place, is harmless - it just becomes
--     an unused function. That is the safer half to undo first if something looks wrong during the
--     walkthrough, and it is almost always the one you actually want.
--
--   Same rules as PART 1: one step at a time, and run the canary first.
--
-- ============================================================================
-- ============================================================================

-- -- ROLLBACK STEP 1 - canary --------------------------------------------------------------------
-- select current_database() as database_name,
--        (select count(*) from public.attendance_records) as attendance_rows;

-- -- ROLLBACK STEP 2 - save the evidence FIRST ---------------------------------------------------
-- Any collision recorded here is real workers sharing a real PIN, and that fault outlives this
-- feature. Copy the result somewhere before ROLLBACK STEP 4 deletes it.
-- select occurred_at, matched_codes, matched_count
-- from   public.pin_collision_log
-- order  by occurred_at desc;

-- -- ROLLBACK STEP 3 - the function (drops its grant and its timeout with it) ---------------------
-- drop function if exists public.identify_employee_by_pin(text);

-- -- ROLLBACK STEP 4 - the tables. Not until STEP 2's result is saved. ---------------------------
-- drop table if exists public.pin_identify_throttle;

-- drop table if exists public.pin_collision_log;

-- -- ROLLBACK STEP 5 - verify all three are gone -------------------------------------------------
-- select 'function identify_employee_by_pin' as object, not exists (
--          select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--          where n.nspname = 'public' and p.proname = 'identify_employee_by_pin') as dropped
-- union all
-- select 'table pin_identify_throttle', to_regclass('public.pin_identify_throttle') is null
-- union all
-- select 'table pin_collision_log',     to_regclass('public.pin_collision_log') is null;

-- -- ROLLBACK STEP 6 - confirm no passcode was touched -------------------------------------------
-- Neither this file nor the rollback ever writes employees.pin. Confirming it here so nobody has to
-- wonder mid-incident.
-- select count(*) as total_rows,
--        sum(case when substr(pin,1,1) = chr(36) and substr(pin,2,1) = '2' then 1 else 0 end) as bcrypt_rows
-- from   public.employees;
