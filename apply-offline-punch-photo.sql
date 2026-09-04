-- ============================================================================
-- apply-offline-punch-photo.sql                                        2026-09-03
--
-- Adds a photo to the offline punch queue, for the REJECT case only.
--
-- On an ACCEPTED offline sync, the kiosk already has the photo locally and sends it straight to
-- Telegram itself (tgSendPhoto to the backup group) - exactly what an ONLINE punch already does.
-- Nothing new is written to attendance_records for that case: online punches have never stored a
-- photo there either, and this migration does not start.
--
-- On a REJECTED offline sync, there is no local record for the office to look at later - the entry
-- is gone from the tablet the moment the server accounts for it. This migration lets sync_offline_punch
-- persist the photo it was handed into kiosk_offline_rejects, so the admin dashboard's rejects card
-- can show the face next to a reject that needs a human decision.
--
-- Pairs with kiosk/index.html v2026-09-03a and home.js v2026-09-03a.
--
-- ---- HOW TO RUN -------------------------------------------------------------------------------
-- RUN ONE STEP AT A TIME, IN ORDER. Every step is a SINGLE statement. Steps 1-4 install, 5 verifies.
-- PART 2 at the bottom is the ROLLBACK; do not run it.
--
-- p_photo is OPTIONAL (default null) precisely so the CURRENTLY-DEPLOYED kiosk - which calls
-- sync_offline_punch with five arguments, no photo - keeps working unchanged the moment this ships.
-- Nothing here requires the kiosk update to land first. STEP 3 explicitly DROPS the old 5-argument
-- function before recreating it with the new parameter - see that step for why leaving both would
-- have broken every call from the currently-deployed kiosk instead of protecting it.
--
-- ---- BEFORE YOU RUN IT ------------------------------------------------------------------------
--   1. Close the OTHER Supabase project's tab (the inventory backend).
--   2. STEP 1 confirms the database from inside the tab, never from its title.
--   3. Steps 2-4 are writes.
-- ============================================================================
-- ============================================================================
--  PART 1 - INSTALL
-- ============================================================================


-- ================================================================================================
-- STEP 1 - CANARY. Run alone, first. attendance_records does not exist in the inventory project,
-- so a wrong tab fails here, before anything is created.
-- ================================================================================================
select current_database()                                as database_name,
       (select count(*) from public.attendance_records)  as attendance_rows,
       to_regclass('public.kiosk_offline_rejects')        as rejects_table_must_exist;


-- ================================================================================================
-- STEP 2 - THE PHOTO COLUMN.
-- A base64 JPEG data URL, same shape as everywhere else a photo passes through this app (never a
-- Storage bucket reference - this codebase has never used one for punch photos). Nullable: most
-- rejects will still have no photo, exactly as most punches today have none (camera unavailable).
-- ================================================================================================
alter table public.kiosk_offline_rejects
  add column if not exists photo text;

comment on column public.kiosk_offline_rejects.photo is
  'Base64 JPEG data URL captured on the tablet at reject time, or null. Written only by '
  'sync_offline_punch, from its p_photo argument. Never populated for an accepted (ok) sync - see '
  'apply-offline-punch-photo.sql header for why.';


-- ================================================================================================
-- STEP 3 - THE FUNCTION, REPLACED WITH THE NEW PARAMETER.
--
-- Identical to apply-offline-punch-sync.sql's version except: the new p_photo parameter (last, with
-- a default, so a 5-argument caller still resolves to this same function), and `photo` added to
-- every insert into kiosk_offline_rejects.
--
-- WHY A LENGTH GUARD ON THE STORED VALUE. capturePhotoOffline() on the kiosk targets ~30KB and steps
-- its JPEG quality down to hit that, so a legitimate photo should never come close to the 100000-char
-- cap below. The cap exists only so a client that somehow misbehaves cannot bloat this table with an
-- oversized payload - and it degrades to "reject written, no photo" rather than failing the write,
-- because a missing photo is a minor loss and a punch nobody can review is not.
--
-- WHY THE DROP BEFORE THE CREATE. Postgres identifies a function by name + parameter TYPE LIST.
-- (text,text,timestamptz,text,text) and (text,text,timestamptz,text,text,text) are different
-- signatures, so CREATE OR REPLACE would NOT touch the live 5-argument function - it would create a
-- SECOND, overloaded one and leave both in place. A currently-deployed kiosk calling with exactly the
-- 5 named parameters (no p_photo key) would then be a legal call against BOTH overloads - exactly the
-- shape of ambiguity PostgREST refuses outright with PGRST203 "Could not choose the best candidate
-- function". Backward compatibility has to come from there being ONE function that defaults p_photo,
-- not from two functions coexisting.
-- ================================================================================================
-- "if exists" so this step stays idempotent on a re-run: the first run removes the old 5-arg
-- function, and every run after that finds nothing there to drop (it was already replaced below).
drop function if exists public.sync_offline_punch(text, text, timestamptz, text, text);

create or replace function public.sync_offline_punch(
  p_pin        text,
  p_punch_type text,
  p_client_ts  timestamptz,
  p_device_id  text,
  p_site       text default null,
  p_photo      text default null
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
  v_photo_max_chars constant int := 100000;
  v_matches   int;
  v_codes     text[];
  v_names     text[];
  v_code      text;
  v_name      text;
  v_local     timestamptz;
  v_date      text;
  v_time      text;
  v_drift     int;
  v_photo     text;
  v_row       public.attendance_records%rowtype;
  v_found     boolean := false;
  v_prereq    text;
  v_existing  text;
  v_reason    text;
begin
  v_drift := round(extract(epoch from (now() - p_client_ts)))::int;
  v_photo := case when p_photo is not null and length(p_photo) <= v_photo_max_chars then p_photo else null end;

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
      (device_id, punch_type, client_ts, reason, detail, photo)
    values
      (p_device_id, coalesce(p_punch_type,'(null)'), coalesce(p_client_ts, now()), v_reason,
       'drift_seconds=' || v_drift, v_photo);
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
      (device_id, punch_type, client_ts, reason, detail, photo)
    values (p_device_id, p_punch_type, p_client_ts, 'no_match', 'drift_seconds=' || v_drift, v_photo);
    return query select 'rejected'::text, 'no_match'::text, null::text, null::text, null::text, null::jsonb;
    return;
  end if;

  if v_matches > 1 then
    insert into public.kiosk_offline_rejects
      (device_id, punch_type, client_ts, reason, detail, matched_codes, photo)
    values (p_device_id, p_punch_type, p_client_ts, 'collision',
            'drift_seconds=' || v_drift, v_codes, v_photo);
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
      (device_id, punch_type, client_ts, att_date, employee_code, employee_name, reason, detail, photo)
    values (p_device_id, p_punch_type, p_client_ts, v_date, v_code, v_name, 'duplicate',
            'within ' || v_dedupe_minutes || ' minutes of an already-synced punch; drift_seconds=' || v_drift,
            v_photo);
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
        (device_id, punch_type, client_ts, att_date, employee_code, employee_name, reason, detail, photo)
      values (p_device_id, p_punch_type, p_client_ts, v_date, v_code, v_name, 'already_recorded',
              'database already holds ' || p_punch_type || ' = ' || v_existing || '; drift_seconds=' || v_drift,
              v_photo);
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
        (device_id, punch_type, client_ts, att_date, employee_code, employee_name, reason, detail, photo)
      values (p_device_id, p_punch_type, p_client_ts, v_date, v_code, v_name, 'out_of_sequence',
              p_punch_type || ' needs ' || v_prereq || ' first, which is not on the record; drift_seconds=' || v_drift,
              v_photo);
      return query select 'rejected'::text, 'out_of_sequence'::text, v_code, v_name, v_date, null::jsonb;
      return;
    end if;
  end if;

  -- ---- write it -------------------------------------------------------------------------------
  -- Only the one punch column is touched. Derived fields (worked_ms, ot_ms, status) are left for
  -- payroll's own recomputeDay, which recalculates from the punches anyway; writing a half-computed
  -- total here would be a second source of truth for pay.
  --
  -- p_photo/v_photo is NOT written here. An accepted sync never touches a photo column on
  -- attendance_records - see this file's header for why (online punches never have either).
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
-- STEP 4 - THE STATEMENT TIMEOUT, REVOKE AND GRANT.
--
-- The DROP in STEP 3 took the old function's settings with it - timeout, grants, everything - so
-- these are not "extra", they are what makes this function callable at all. Applied against the
-- (text,text,timestamptz,text,text,text) signature: since the drop, that is the ONLY
-- sync_offline_punch there is, so there is nothing left for these to ambiguously miss.
-- ================================================================================================
alter function public.sync_offline_punch(text, text, timestamptz, text, text, text)
  set statement_timeout = '15s';

revoke all on function public.sync_offline_punch(text, text, timestamptz, text, text, text) from public;

grant execute on function public.sync_offline_punch(text, text, timestamptz, text, text, text) to anon;


-- ================================================================================================
-- STEP 5 - VERIFY: exactly ONE sync_offline_punch exists (the old signature is gone, not
-- overloaded alongside this one), the new column, the function's settings, and that a call shaped
-- EXACTLY like the currently-deployed kiosk's - 5 named arguments, no p_photo key - still works.
-- ================================================================================================
select column_name, data_type
from   information_schema.columns
where  table_schema = 'public' and table_name = 'kiosk_offline_rejects' and column_name = 'photo';
-- EXPECT: one row, data_type = text

select p.proname                             as function_name,
       pg_get_function_identity_arguments(p.oid) as arguments,
       coalesce(p.proconfig::text, '(none)') as function_settings
from   pg_proc p
join   pg_namespace n on n.oid = p.pronamespace
where  n.nspname = 'public'
and    p.proname = 'sync_offline_punch';
-- EXPECT: EXACTLY ONE row (proves the old 5-argument signature is gone, not left overloaded
--         alongside this one - two rows here means STEP 3's drop did not run and every call from
--         the currently-deployed kiosk is now at risk of PostgREST's PGRST203 ambiguity error).
--         arguments ending "..., site text DEFAULT NULL::text, photo text DEFAULT NULL::text",
--         function_settings containing statement_timeout=15s

select public.sync_offline_punch(
  p_pin        => '000000',
  p_punch_type => 'timein',
  p_client_ts  => now(),
  p_device_id  => 'test-device-old-shape',
  p_site       => 'Carmen'
) as old_kiosk_shaped_call_must_still_work;
-- EXPECT: one row of rejected/no_match — this is the EXACT call shape flushOfflinePunches() in the
-- currently-deployed (pre-photo) kiosk sends: 5 named arguments, no p_photo key at all. Proves the
-- live 08-28a kiosk keeps working unchanged against this migration, not just that SOME 5-argument
-- call happens to parse.
-- (This writes a throwaway kiosk_offline_rejects row for PIN 000000, which matches nobody. Harmless
-- to leave; delete it if you want a clean table: see PART 2 for the exact statement.)


-- ============================================================================
--  PART 2 - ROLLBACK. Do NOT run unless you are reverting this migration.
-- ============================================================================
-- Reverting the function means the mirror image of STEP 3: drop the 6-argument signature this file
-- created, then re-create the 5-argument version from apply-offline-punch-sync.sql (its STEP 5).
-- Running its CREATE OR REPLACE alone, without the drop below first, recreates THIS file's ambiguity
-- in reverse - do not skip the drop.
--
-- drop function if exists public.sync_offline_punch(text, text, timestamptz, text, text, text);
-- -- then run apply-offline-punch-sync.sql's STEP 5 (the create-or-replace) followed by its STEP 6-8
-- -- (timeout / revoke / grant) to restore the 5-argument function and its settings.
--
-- delete from public.kiosk_offline_rejects where employee_code is null and reason = 'no_match'
--   and device_id = 'test-device-old-shape';   -- removes STEP 5's throwaway verification row only
-- alter table public.kiosk_offline_rejects drop column if exists photo;
