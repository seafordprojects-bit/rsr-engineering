-- ============================================================================
-- apply-offline-punch-sync.sql                                          2026-08-27
--
-- Offline clock-in, restored under server-side identification.
--
-- A tablet with no connection cannot identify anybody, so it queues the RAW TYPED PIN and the punch
-- the worker pressed, and decides NOTHING else. On reconnect each entry is replayed through
-- sync_offline_punch, which verifies the PIN, validates the punch against that worker's real state
-- at that moment, and either writes it or files a reject for review. It never guesses.
--
-- Pairs with kiosk/index.html v2026-08-27a.
--
-- ---- HOW TO RUN -------------------------------------------------------------------------------
-- RUN ONE STEP AT A TIME, IN ORDER. Every step is a SINGLE statement. Steps 1-8 install, 9-12
-- verify. PART 2 at the bottom is the ROLLBACK; do not run it.
--
-- Plain ASCII only, and no dollar sign in any string literal - a dollar sign inside a literal made
-- the editor mis-parse an earlier script (42601). Bcrypt is tested with chr(36) instead.
--
-- ---- BEFORE YOU RUN IT ------------------------------------------------------------------------
--   1. Close the OTHER Supabase project's tab (the inventory backend).
--   2. STEP 1 confirms the database from inside the tab, never from its title.
--   3. Steps 2-8 are writes.
-- ============================================================================
-- ============================================================================
--  PART 1 - INSTALL
-- ============================================================================


-- ================================================================================================
-- STEP 1 - CANARY. Run alone, first.
-- ================================================================================================
select current_database()                                as database_name,
       (select count(*) from public.attendance_records)  as attendance_rows;


-- ================================================================================================
-- STEP 2 - THE REJECTS TABLE.
--
-- Every offline punch that could NOT be written lands here. Nothing is ever silently dropped: a
-- queued punch leaves the tablet only when the server has either written it or filed it here.
--
-- It NEVER stores the PIN. A rejected punch is reviewed by employee code where one was identified,
-- and by device + time where one was not.
-- ================================================================================================
create table if not exists public.kiosk_offline_rejects (
  id             bigint generated always as identity primary key,
  occurred_at    timestamptz not null default now(),
  device_id      text,
  punch_type     text        not null,
  client_ts      timestamptz not null,
  att_date       text,                  -- MM/DD/YYYY, the day the punch belonged to (null if unknown)
  employee_code  text,                  -- null when the PIN matched nobody
  employee_name  text,
  matched_codes  text[],                -- populated on a collision: the workers who share that PIN
  reason         text        not null,
  detail         text,
  reviewed       boolean     not null default false,
  reviewed_at    timestamptz,
  reviewed_by    text
);


-- ================================================================================================
-- STEP 3 - THE SYNCED-PUNCH LOG.
--
-- One row per offline punch that WAS written, carrying client_ts (what the tablet believed the time
-- was) next to server_received_at (when it actually arrived). drift_seconds is the gap: a tablet
-- with a wandering clock shows up here as a consistent non-zero drift, before it quietly shifts
-- somebody's pay.
--
-- It is also what makes the 5-minute dedupe possible, since attendance_records keeps only the punch
-- time, not when it was submitted or from which device.
-- ================================================================================================
create table if not exists public.kiosk_offline_punch_log (
  id                 bigint generated always as identity primary key,
  employee_code      text        not null,
  att_date           text        not null,     -- MM/DD/YYYY, matching what the kiosk writes
  punch_type         text        not null,
  client_ts          timestamptz not null,
  server_received_at timestamptz not null default now(),
  drift_seconds      int,
  device_id          text
);

create index if not exists kiosk_offline_punch_log_dedupe_idx
  on public.kiosk_offline_punch_log (employee_code, punch_type, client_ts);


-- ================================================================================================
-- STEP 4 - KEEP BOTH TABLES OFF THE API.
-- RLS is disabled project-wide. Without this, an anon key could read the rejects table over
-- PostgREST. The function writes them as its owner, so revoking costs it nothing. The admin
-- dashboard reads them with an authenticated session, not the anon key.
-- ================================================================================================
revoke all on table public.kiosk_offline_rejects, public.kiosk_offline_punch_log from anon;


-- ================================================================================================
-- STEP 5 - THE FUNCTION.
--
-- WHY EVERY OUT PARAMETER IS PREFIXED out_.
--   A RETURNS TABLE puts its column names in scope for the whole body, so a bare `status` or
--   `employee_code` inside would resolve to the PARAMETER, not the column - ERROR 42702, at runtime,
--   on one path only. attendance_records has BOTH of those names. Rather than rely on qualifying
--   every single reference correctly forever, the parameters are renamed so the collision cannot
--   happen at all. Table references are alias-qualified as well. See CLAUDE.md.
--
-- WHY THE DATE IS WRITTEN AS MM/DD/YYYY.
--   attendance_records.date is TEXT in MIXED formats, and the unique index uniq_attendance_emp_date
--   is on (employee_code, date) - the raw TEXT. The kiosk writes MM/DD/YYYY (toLocaleDateString
--   en-PH). If this function wrote 2026-08-27 for a day the kiosk had written as 08/27/2026, the
--   index would not collide and the worker would end up with TWO rows for one day: payroll would
--   read one of them and silently pay half a day. So: match on the NORMALISED date, write in the
--   kiosk's format.
--
-- WHY IT RETURNS THE WHOLE PUNCH SET.
--   The kiosk pushes its FULL local record on every sync. If this function wrote a punch the tablet
--   did not know about, the tablet's next full push would overwrite it and the punch would vanish.
--   out_punches hands the merged set back so the tablet can fold it into its local record first.
-- ================================================================================================
create or replace function public.sync_offline_punch(
  p_pin        text,
  p_punch_type text,
  p_client_ts  timestamptz,
  p_device_id  text,
  p_site       text default null
)
returns table(
  out_status        text,     -- 'ok' | 'rejected'
  out_reason        text,     -- null when ok
  out_employee_code text,
  out_employee_name text,
  out_att_date      text,
  out_punches       jsonb     -- the row's full punch set AFTER the write, for the tablet to merge
)
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  v_dedupe_minutes constant int := 5;
  v_max_age_hours  constant int := 48;   -- older than this is not a queue, it is a fossil
  v_matches   int;
  v_codes     text[];
  v_names     text[];
  v_code      text;
  v_name      text;
  v_local     timestamptz;
  v_date      text;
  v_time      text;
  v_drift     int;
  v_row       public.attendance_records%rowtype;
  v_found     boolean := false;
  v_prereq    text;
  v_existing  text;
  v_reason    text;
begin
  v_drift := round(extract(epoch from (now() - p_client_ts)))::int;

  -- ---- shape guards -------------------------------------------------------------------------
  if p_punch_type is null or p_punch_type not in
     ('timein','lunch_out','lunch_in','pm_out','pm_in','timeout') then
    v_reason := 'bad_punch_type';
  elsif p_pin is null or length(p_pin) <> 6
     or translate(p_pin, '0123456789', '') <> '' then
    v_reason := 'bad_pin_shape';
  elsif p_client_ts is null
     or p_client_ts > now() + interval '1 hour'
     or p_client_ts < now() - make_interval(hours => v_max_age_hours) then
    v_reason := 'implausible_timestamp';
  end if;

  if v_reason is not null then
    insert into public.kiosk_offline_rejects
      (device_id, punch_type, client_ts, reason, detail)
    values
      (p_device_id, coalesce(p_punch_type,'(null)'), coalesce(p_client_ts, now()), v_reason,
       'drift_seconds=' || v_drift);
    return query select 'rejected'::text, v_reason, null::text, null::text, null::text, null::jsonb;
    return;
  end if;

  -- ---- identify, exactly as identify_employee_by_pin does ------------------------------------
  -- Full scan, no limit: stopping at the first match would make a second one invisible, and a
  -- collision must be refused rather than resolved by picking somebody.
  select count(*),
         array_agg(e.code order by e.code),
         array_agg(e.name order by e.code)
    into v_matches, v_codes, v_names
  from public.employees e
  where e.pin is not null
    and substr(e.pin, 1, 1) = chr(36)
    and substr(e.pin, 2, 1) = '2'
    and e.pin = extensions.crypt(p_pin, e.pin);

  if v_matches = 0 then
    insert into public.kiosk_offline_rejects
      (device_id, punch_type, client_ts, reason, detail)
    values (p_device_id, p_punch_type, p_client_ts, 'no_match', 'drift_seconds=' || v_drift);
    return query select 'rejected'::text, 'no_match'::text, null::text, null::text, null::text, null::jsonb;
    return;
  end if;

  if v_matches > 1 then
    insert into public.kiosk_offline_rejects
      (device_id, punch_type, client_ts, reason, detail, matched_codes)
    values (p_device_id, p_punch_type, p_client_ts, 'collision',
            'drift_seconds=' || v_drift, v_codes);
    return query select 'rejected'::text, 'collision'::text, null::text, null::text, null::text, null::jsonb;
    return;
  end if;

  v_code := v_codes[1];
  v_name := v_names[1];

  -- ---- the day and time this punch belongs to, in yard time ----------------------------------
  v_local := p_client_ts at time zone 'Asia/Manila';
  v_date  := to_char(p_client_ts at time zone 'Asia/Manila', 'MM/DD/YYYY');
  v_time  := to_char(p_client_ts at time zone 'Asia/Manila', 'HH12:MI:SS AM');

  -- ---- dedupe: same worker, same punch, within five minutes -----------------------------------
  -- Keep the first, reject the second. A worker who taps twice because the tablet gave no feedback
  -- must not end up with two Time Ins, and the server must not have to guess which was meant.
  if exists (
    select 1 from public.kiosk_offline_punch_log l
    where l.employee_code = v_code
      and l.punch_type    = p_punch_type
      and abs(extract(epoch from (l.client_ts - p_client_ts)))
          <= (v_dedupe_minutes * 60)
  ) then
    insert into public.kiosk_offline_rejects
      (device_id, punch_type, client_ts, att_date, employee_code, employee_name, reason, detail)
    values (p_device_id, p_punch_type, p_client_ts, v_date, v_code, v_name, 'duplicate',
            'within ' || v_dedupe_minutes || ' minutes of an already-synced punch; drift_seconds=' || v_drift);
    return query select 'rejected'::text, 'duplicate'::text, v_code, v_name, v_date, null::jsonb;
    return;
  end if;

  -- ---- the worker's actual state on that day --------------------------------------------------
  -- Matched on the NORMALISED date so a row written in either text format is found.
  select a.* into v_row
  from public.attendance_records a
  where a.employee_code = v_code
    and case
          when a.date ~ '^[0-9][0-9][0-9][0-9]-'   then substr(a.date, 1, 10)::date
          when a.date ~ '^[0-9]{1,2}/[0-9]{1,2}/'  then to_date(a.date, 'MM/DD/YYYY')
          else null
        end = (p_client_ts at time zone 'Asia/Manila')::date
  limit 1;
  v_found := found;

  -- ---- validate against that state ------------------------------------------------------------
  -- Prerequisite for each punch. "missing its pair" is this rule: a Lunch In with no Lunch Out, or
  -- a PM Break In with no PM Break Out, is refused rather than written as a half-pair that payroll
  -- would then have to interpret.
  v_prereq := case p_punch_type
                when 'timein'    then null
                when 'lunch_out' then 'timein'
                when 'lunch_in'  then 'lunch_out'
                when 'pm_out'    then 'timein'
                when 'pm_in'     then 'pm_out'
                when 'timeout'   then 'timein'
              end;

  if v_found then
    v_existing := case p_punch_type
                    when 'timein'    then v_row.timein
                    when 'lunch_out' then v_row.lunch_out
                    when 'lunch_in'  then v_row.lunch_in
                    when 'pm_out'    then v_row.pm_out
                    when 'pm_in'     then v_row.pm_in
                    when 'timeout'   then v_row.timeout
                  end;
    if v_existing is not null and btrim(v_existing) <> '' then
      insert into public.kiosk_offline_rejects
        (device_id, punch_type, client_ts, att_date, employee_code, employee_name, reason, detail)
      values (p_device_id, p_punch_type, p_client_ts, v_date, v_code, v_name, 'already_recorded',
              'database already holds ' || p_punch_type || ' = ' || v_existing || '; drift_seconds=' || v_drift);
      return query select 'rejected'::text, 'already_recorded'::text, v_code, v_name, v_date, null::jsonb;
      return;
    end if;
  end if;

  if v_prereq is not null then
    v_existing := case
                    when not v_found then null
                    when v_prereq = 'timein'    then v_row.timein
                    when v_prereq = 'lunch_out' then v_row.lunch_out
                    when v_prereq = 'pm_out'    then v_row.pm_out
                  end;
    if v_existing is null or btrim(v_existing) = '' then
      insert into public.kiosk_offline_rejects
        (device_id, punch_type, client_ts, att_date, employee_code, employee_name, reason, detail)
      values (p_device_id, p_punch_type, p_client_ts, v_date, v_code, v_name, 'out_of_sequence',
              p_punch_type || ' needs ' || v_prereq || ' first, which is not on the record; drift_seconds=' || v_drift);
      return query select 'rejected'::text, 'out_of_sequence'::text, v_code, v_name, v_date, null::jsonb;
      return;
    end if;
  end if;

  -- ---- write it -------------------------------------------------------------------------------
  -- Only the one punch column is touched. Derived fields (worked_ms, ot_ms, status) are left for
  -- payroll's own recomputeDay, which recalculates from the punches anyway; writing a half-computed
  -- total here would be a second source of truth for pay.
  if not v_found then
    insert into public.attendance_records (employee_code, employee_name, date, site)
    values (v_code, v_name, v_date, coalesce(p_site, ''));
  end if;

  update public.attendance_records a
     set timein    = case when p_punch_type = 'timein'    then v_time else a.timein    end,
         lunch_out = case when p_punch_type = 'lunch_out' then v_time else a.lunch_out end,
         lunch_in  = case when p_punch_type = 'lunch_in'  then v_time else a.lunch_in  end,
         pm_out    = case when p_punch_type = 'pm_out'    then v_time else a.pm_out    end,
         pm_in     = case when p_punch_type = 'pm_in'     then v_time else a.pm_in     end,
         timeout   = case when p_punch_type = 'timeout'   then v_time else a.timeout   end
   where a.employee_code = v_code
     and case
           when a.date ~ '^[0-9][0-9][0-9][0-9]-'   then substr(a.date, 1, 10)::date
           when a.date ~ '^[0-9]{1,2}/[0-9]{1,2}/'  then to_date(a.date, 'MM/DD/YYYY')
           else null
         end = (p_client_ts at time zone 'Asia/Manila')::date
  returning a.* into v_row;

  insert into public.kiosk_offline_punch_log
    (employee_code, att_date, punch_type, client_ts, server_received_at, drift_seconds, device_id)
  values (v_code, v_date, p_punch_type, p_client_ts, now(), v_drift, p_device_id);

  return query select
    'ok'::text,
    null::text,
    v_code,
    v_name,
    v_row.date,
    jsonb_build_object(
      'timein',    v_row.timein,
      'lunch_out', v_row.lunch_out,
      'lunch_in',  v_row.lunch_in,
      'pm_out',    v_row.pm_out,
      'pm_in',     v_row.pm_in,
      'timeout',   v_row.timeout
    );
end;
$fn$;


-- ================================================================================================
-- STEP 6 - THE STATEMENT TIMEOUT.
-- Same bcrypt scan as identify_employee_by_pin: about 3.1s at 43 workers, and the project default
-- is 3s. Raising it per-function leaves the 3s default protecting everything else.
-- ================================================================================================
alter function public.sync_offline_punch(text, text, timestamptz, text, text)
  set statement_timeout = '15s';


-- ================================================================================================
-- STEP 7 - TAKE THE DEFAULT GRANT AWAY.
-- ================================================================================================
revoke all on function public.sync_offline_punch(text, text, timestamptz, text, text) from public;


-- ================================================================================================
-- STEP 8 - GRANT IT TO THE KIOSK ONLY.
-- ================================================================================================
grant execute on function public.sync_offline_punch(text, text, timestamptz, text, text) to anon;


-- ================================================================================================
-- STEP 9 - VERIFY: the function, its security flag and its timeout.
-- function_settings MUST show statement_timeout=15s and search_path=public.
-- ================================================================================================
select p.proname                             as function_name,
       p.prosecdef                           as security_definer,
       coalesce(p.proconfig::text, '(none)') as function_settings
from   pg_proc p
join   pg_namespace n on n.oid = p.pronamespace
where  n.nspname = 'public'
and    p.proname = 'sync_offline_punch';


-- ================================================================================================
-- STEP 9b - VERIFY: can this function actually INSERT a new day row?
--
-- When a worker's first punch of the day is an offline one, there is no attendance_records row yet
-- and the function creates one with employee_code / employee_name / date / site only. If the table
-- has any OTHER column that is NOT NULL with no default, that insert fails - and it would fail for
-- the first time during the walkthrough, on a real worker.
--
-- AN EMPTY RESULT IS THE GOOD OUTCOME. If anything is listed, send it to me and I will add it to
-- the insert before you run the walkthrough.
-- ================================================================================================
select c.column_name,
       c.data_type,
       c.is_nullable,
       coalesce(c.column_default, '(none)') as column_default
from   information_schema.columns c
where  c.table_schema = 'public'
and    c.table_name   = 'attendance_records'
and    c.is_nullable  = 'NO'
and    c.column_default is null
and    c.column_name not in ('id','employee_code','employee_name','date','site')
order  by c.ordinal_position;


-- ================================================================================================
-- STEP 10 - VERIFY: the grants. All three rows must read true.
-- ================================================================================================
select 'anon CAN execute sync_offline_punch' as check_name,
       has_function_privilege('anon',
         'public.sync_offline_punch(text,text,timestamptz,text,text)', 'EXECUTE') as ok
union all
select 'anon CANNOT read kiosk_offline_rejects',
       not has_table_privilege('anon', 'public.kiosk_offline_rejects', 'SELECT')
union all
select 'anon CANNOT read kiosk_offline_punch_log',
       not has_table_privilege('anon', 'public.kiosk_offline_punch_log', 'SELECT');


-- ================================================================================================
-- STEP 11 - SMOKE TEST. Reveals nothing; writes only reject rows, which is the point.
-- Expect, in order: rejected/bad_punch_type, rejected/bad_pin_shape, rejected/no_match.
-- Then STEP 12 shows the three rejects it just filed, proving nothing is silently dropped.
-- The ok path needs a real passcode and is proven at the kiosk, NOT by typing one here - the SQL
-- editor keeps a query history and that would write a live passcode into it in clear text.
-- ================================================================================================
select 'bad type'  as case_name, s.out_status, s.out_reason from public.sync_offline_punch('123456','nope',    now(), 'smoke-test') s
union all
select 'bad pin',              s.out_status, s.out_reason from public.sync_offline_punch('abc',   'timein',  now(), 'smoke-test') s
union all
select 'no match',             s.out_status, s.out_reason from public.sync_offline_punch('000000','timein',  now(), 'smoke-test') s;


-- ================================================================================================
-- STEP 12 - VERIFY: the rejects landed. Expect the three rows STEP 11 just filed.
-- Delete them afterwards if you like; they are marked device_id = smoke-test.
--   delete from public.kiosk_offline_rejects where device_id = 'smoke-test';
-- ================================================================================================
select occurred_at, device_id, punch_type, reason, detail
from   public.kiosk_offline_rejects
order  by occurred_at desc
limit  10;


-- ================================================================================================
-- STEP 13 - THE REVIEW QUERY. This is the one to run before every payroll.
-- Any day listed here has a punch that could not be written. Payroll will price that day from an
-- incomplete record unless it is fixed first. An empty result is the good outcome.
-- ================================================================================================
select r.att_date,
       r.employee_code,
       r.employee_name,
       r.punch_type,
       r.reason,
       r.client_ts,
       r.detail
from   public.kiosk_offline_rejects r
where  not r.reviewed
order  by r.att_date desc, r.employee_code, r.client_ts;


-- ================================================================================================
-- STEP 14 - CLOCK DRIFT BY DEVICE. Run occasionally.
-- A tablet whose clock has wandered shows a large, consistent avg_drift. Punches from it are being
-- written at the wrong time, which is a pay problem before it is an IT problem.
-- ================================================================================================
select l.device_id,
       count(*)                                as punches,
       round(avg(l.drift_seconds))             as avg_drift_seconds,
       min(l.drift_seconds)                    as min_drift,
       max(l.drift_seconds)                    as max_drift
from   public.kiosk_offline_punch_log l
where  l.server_received_at > now() - interval '30 days'
group  by l.device_id
order  by abs(round(avg(l.drift_seconds))) desc;




-- ============================================================================
-- ============================================================================
--
--   PART 2 - ROLLBACK.   DO NOT RUN THIS SECTION.
--
--   Removing the function stops offline punches syncing. Queued punches stay on the tablets and
--   keep retrying, so nothing is lost immediately - but revert kiosk/index.html too, or workers
--   will go on queueing punches that can never land.
--
--   Save STEP 13's result before dropping the tables: a reject is a punch somebody actually made.
--
-- ============================================================================
-- ============================================================================

-- -- ROLLBACK STEP 1 - canary
-- select current_database() as database_name,
--        (select count(*) from public.attendance_records) as attendance_rows;

-- -- ROLLBACK STEP 2 - save the evidence FIRST (unreviewed rejects are real punches)
-- select * from public.kiosk_offline_rejects where not reviewed order by client_ts;

-- -- ROLLBACK STEP 3 - the function (drops its grant and timeout with it)
-- drop function if exists public.sync_offline_punch(text, text, timestamptz, text, text);

-- -- ROLLBACK STEP 4 - the tables. Not until STEP 2's result is saved.
-- drop table if exists public.kiosk_offline_punch_log;

-- drop table if exists public.kiosk_offline_rejects;

-- -- ROLLBACK STEP 5 - verify all three are gone
-- select 'function sync_offline_punch' as object, not exists (
--          select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--          where n.nspname = 'public' and p.proname = 'sync_offline_punch') as dropped
-- union all
-- select 'table kiosk_offline_punch_log', to_regclass('public.kiosk_offline_punch_log') is null
-- union all
-- select 'table kiosk_offline_rejects',   to_regclass('public.kiosk_offline_rejects') is null;
