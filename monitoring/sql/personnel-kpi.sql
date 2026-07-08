-- personnel-kpi.sql  --  Personnel efficiency (phase 1). Idempotent: safe to re-run.
-- Run in the Supabase SQL editor for project wpmcbjrisuyjvobvzaus.
--
-- ACTUAL HOURS come from payroll-effective worked_ms (attendance_records), NOT the
-- roll-call 2h blocks. Roll-call only supplies the WHICH-JOB split. See v_attendance_day
-- and v_job_worker_day. worked_ms is what payroll persists after punch edits
-- (payroll/index.html:1016), so KPI actual hours equal paid hours exactly.

-- ============================================================ TABLES
create table if not exists job_progress (
  id               uuid primary key default gen_random_uuid(),
  job_id           uuid not null references jobs(id),
  work_date        date not null,
  units_cumulative numeric not null,           -- units done TO DATE (cumulative, not a delta)
  reported_by      text,
  created_at       timestamptz not null default now(),
  unique (job_id, work_date)
);

create table if not exists efficiency_week (
  id                        uuid primary key default gen_random_uuid(),
  employee_code             text not null,     -- employees.id (uuid), the KPI worker key
  week_start                date not null,     -- Saturday
  week_end                  date not null,     -- Friday
  earned_hours              numeric not null,
  actual_hours              numeric not null,
  efficiency                numeric,           -- earned/actual, null when actual=0
  calibrated_earned_hours   numeric not null,
  uncalibrated_earned_hours numeric not null,
  breakdown                 jsonb not null,    -- [{job_id,job_no,vessel,earned,actual,calibrated}]
  close_version             integer not null default 1,
  closed_by                 text,
  closed_at                 timestamptz not null default now(),
  finalized_ack_by          text,              -- admin who affirmed payroll finalized for the week
  finalized_ack_at          timestamptz,
  unresolved_at_close       integer,           -- payroll-health unresolved count at close time
  unique (employee_code, week_start, close_version)
);
-- Add the finalize-ack columns on re-run if an older efficiency_week already exists.
alter table efficiency_week add column if not exists finalized_ack_by    text;
alter table efficiency_week add column if not exists finalized_ack_at    timestamptz;
alter table efficiency_week add column if not exists unresolved_at_close integer;
alter table efficiency_week add column if not exists no_target_at_close  integer;   -- jobs active this week with no target quantity (shown but not payable) at close time

create table if not exists efficiency_week_audit (
  id         uuid primary key default gen_random_uuid(),
  week_start date not null,
  action     text not null,                    -- 'close' | 'reopen'
  version    integer not null,
  actor      text,
  note       text,
  at         timestamptz not null default now()
);

-- ============================================================ JOBS COLUMNS
alter table jobs add column if not exists calibrated    boolean not null default false;
alter table jobs add column if not exists calibrated_by text;
alter table jobs add column if not exists calibrated_at timestamptz;

-- A job with NO target quantity is NOT payable: it can never be calibrated (owner rule 2026-07-06).
-- Enforced at the DB so no path (UI or API) can mark a target-less job calibrated. Existing rows all
-- have calibrated=false (column defaulted above), so the constraint holds on add. The reset trigger
-- below already flips calibrated->false when quantity changes, so clearing a quantity can't violate it.
-- Idempotent: only added if absent.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'jobs_calibrated_needs_quantity') then
    alter table jobs add constraint jobs_calibrated_needs_quantity
      check (calibrated = false or quantity is not null);
  end if;
end $$;

-- ============================================================ TRIGGERS
-- Editing a job's estimate inputs invalidates its calibration (spec D6).
create or replace function jobs_reset_calibration() returns trigger as $$
begin
  if (new.correction_factor is distinct from old.correction_factor)
     or (new.rate_used is distinct from old.rate_used)
     or (new.quantity is distinct from old.quantity) then
    new.calibrated := false;
    new.calibrated_by := null;
    new.calibrated_at := null;
  end if;
  return new;
end;
$$ language plpgsql;
drop trigger if exists trg_jobs_reset_calibration on jobs;
create trigger trg_jobs_reset_calibration before update on jobs
  for each row execute function jobs_reset_calibration();

-- efficiency_week / audit are append-only: block UPDATE and DELETE (spec D8 immutability).
create or replace function block_mutation() returns trigger as $$
begin
  raise exception 'efficiency records are append-only and immutable';
end;
$$ language plpgsql;
drop trigger if exists trg_effweek_immutable on efficiency_week;
create trigger trg_effweek_immutable before update or delete on efficiency_week
  for each row execute function block_mutation();
drop trigger if exists trg_effaudit_immutable on efficiency_week_audit;
create trigger trg_effaudit_immutable before update or delete on efficiency_week_audit
  for each row execute function block_mutation();

-- ============================================================ COLUMN CONTRACTS
-- The monitoring module keys people by employees.id (uuid): roll-call and assign write
-- employees.id into these *_code columns, NOT the human "RSR 0009" code. Make it explicit.
-- (Confirmed in roll-call.html: <option value=${e.id}> and job_checkpoint insert employee_code:e.id.)
comment on column job_checkpoint.employee_code is
  'Holds employees.id (uuid), NOT the human code. Monitoring keys people by employees.id; attendance/payroll use employees.code, bridged in v_attendance_day.';
comment on column job_assignment.employee_code is
  'Holds employees.id (uuid), NOT the human code. Same contract as job_checkpoint.employee_code.';
comment on column efficiency_week.employee_code is
  'Holds employees.id (uuid), the KPI worker key (same key as job_checkpoint.employee_code).';

-- ============================================================ WEEK HELPER (drift-guard)
-- Saturday-on/before a date, exposed so monitoring/diagnostic.html can compare the SQL week
-- bucketing against shared/payweek.mjs. This is the SAME formula the views use inline:
-- Postgres dow Sun=0..Sat=6, so (dow+1)%7 gives Sat=0..Fri=6 (matches the JS helper).
create or replace function kpi_week_start(d date) returns date
language sql immutable as $$
  select (d - ((extract(dow from d)::int + 1) % 7))::date
$$;

-- ============================================================ VIEWS
-- Payroll-effective hours per worker (employees.id) per ISO day. Reads the SAME worked_ms
-- payroll persists after edits, so KPI actual == paid. attendance_records.date is TEXT in
-- mixed formats (YYYY-MM-DD and MM/DD/YYYY) -> normalized to a real date here, once.
-- attendance is keyed by employees.code; roll-call by employees.id -> bridge via employees.
-- The code join is NORMALIZED exactly like payroll's client normCode (payroll/index.html:682):
--   normCode = upper(code) with ALL whitespace stripped  ('rsr 0009' == 'RSR 0009' == 'RSR0009').
-- Exact-match here would silently drop rows on any spacing/case difference (the payroll landmine).
create or replace view v_attendance_day as
with norm as (
  -- employee_id is the KPI worker key. It equals employees.id but is exposed as LOWERCASE TEXT,
  -- because the monitoring tables (job_checkpoint/job_assignment/efficiency_week) store that key
  -- in TEXT columns. Comparing text=text (never uuid=text) both avoids the operator-mismatch error
  -- and, like payroll's normCode, is immune to any case drift that would otherwise silently drop rows.
  select lower(e.id::text) as employee_id,
         e.code as employee_code,
         e.name as employee_name,
         (case
            when a.date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'   then substr(a.date,1,10)::date
            when a.date ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$' then to_date(a.date,'MM/DD/YYYY')
            else null
          end)                                   as work_date,
         (coalesce(a.worked_ms,0)/3600000.0)::numeric as paid_hours,
         coalesce(a.is_incomplete,false)         as is_incomplete,
         a.status                                as status,
         -- has_out: the worker actually punched an end-of-day clock-out (afternoon-out or final out).
         -- A real short day (e.g. a 3:00 PM early-out) HAS this; a forgotten-OUT day does not. Legacy
         -- placeholder literals like '(auto-deducted)'/'(skipped)' are NOT real punches, so exclude them.
         (   (a.pm_out  is not null and a.pm_out  !~* 'auto|skip')
          or (a.timeout is not null and a.timeout !~* 'auto|skip')) as has_out
  from attendance_records a
  join employees e
    on upper(regexp_replace(e.code, '\s', '', 'g')) = upper(regexp_replace(a.employee_code, '\s', '', 'g'))
)
-- Collapse cross-format duplicate rows for the same logical day to ONE row per
-- (employee, work_date). The unique index on attendance_records is on the RAW TEXT date,
-- so a mixed-format duplicate (e.g. 2026-07-04 and 07/04/2026) could otherwise fan out the
-- downstream join and double a worker's attributed actual hours. Keep the fuller record.
select employee_id, employee_code, min(employee_name) as employee_name, work_date,
       max(paid_hours)        as paid_hours,
       bool_or(is_incomplete) as is_incomplete,
       max(status)            as status,
       bool_or(has_out)       as has_out
from norm
group by employee_id, employee_code, work_date;

-- Attribute each worker-day's paid hours across the jobs they were roll-call-tagged to
-- that day, in proportion to checkpoint blocks (spec D9). Sum over a worker-day == paid_hours.
-- Tagged but no attendance row -> paid_hours 0 -> actual_hours 0 (spec edge case).
create or replace view v_job_worker_day as
with crew as (
  -- job_checkpoint.employee_code is TEXT holding employees.id (a uuid string). Normalize it to
  -- lowercase text so it joins v_attendance_day.employee_id (also lowercase text) as text=text.
  select job_id, lower(employee_code) as employee_id, (work_date::date) as work_date, count(*) as blocks
  from job_checkpoint
  group by job_id, lower(employee_code), (work_date::date)
),
daytot as (
  select employee_id, work_date, sum(blocks) as total_blocks
  from crew group by employee_id, work_date
)
select c.job_id, c.employee_id, c.work_date, c.blocks,
       round(coalesce(p.paid_hours,0) * c.blocks / nullif(dt.total_blocks,0), 3) as actual_hours
from crew c
join daytot dt        on dt.employee_id = c.employee_id and dt.work_date = c.work_date
left join v_attendance_day p on p.employee_id = c.employee_id and p.work_date = c.work_date;

-- Per job: earned-to-date (capped at estimate) vs attributed payroll-effective actual hours.
create or replace view v_job_efficiency as
with prog as (
  select distinct on (job_id) job_id, units_cumulative
  from job_progress order by job_id, work_date desc
),
act as (
  select job_id, sum(actual_hours)::numeric as actual_hours
  from v_job_worker_day group by job_id
)
select j.id as job_id, j.job_no, j.vessel, j.site, j.status,
       j.quantity, j.unit, j.rate_used, j.correction_factor, j.calibrated,
       coalesce(p.units_cumulative,0)                                as units_cumulative,
       least(coalesce(p.units_cumulative,0), j.quantity)             as credited_units,
       (coalesce(p.units_cumulative,0) > j.quantity)                 as overrun,
       round(least(coalesce(p.units_cumulative,0), j.quantity)
             * j.rate_used * j.correction_factor, 2)                 as earned_hours,
       round(coalesce(a.actual_hours,0),2)                           as actual_hours,
       case when coalesce(a.actual_hours,0) > 0
            then round(least(coalesce(p.units_cumulative,0), j.quantity)
                       * j.rate_used * j.correction_factor / a.actual_hours, 3)
            else null end                                           as efficiency
from jobs j
left join prog p on p.job_id = j.id
left join act  a on a.job_id = j.id;

-- Per vessel roll-up.
create or replace view v_vessel_efficiency as
select vessel,
       count(*)                                                     as jobs,
       round(sum(earned_hours),2)                                   as earned_hours,
       round(sum(actual_hours),2)                                   as actual_hours,
       case when sum(actual_hours) > 0
            then round(sum(earned_hours)/sum(actual_hours),3) else null end as efficiency,
       round(coalesce(sum(earned_hours) filter (where calibrated),0),2)     as calibrated_earned_hours
from v_job_efficiency
group by vessel;

-- Per worker, per job, per DAY: split the day's earned delta among the day's crew in
-- proportion to their ATTRIBUTED paid hours (spec D9) -> everyone lands at the job-day's
-- efficiency. Week bucket: Saturday on/before work_date. Postgres dow Sun=0..Sat=6, so
-- (dow+1)%7 gives Sat=0..Fri=6, identical to shared/payweek.mjs.
create or replace view v_worker_week_job as
with deltas as (
  select jp.job_id, jp.work_date,
         greatest(
           least(jp.units_cumulative, j.quantity)
           - least(coalesce(lag(jp.units_cumulative)
                    over (partition by jp.job_id order by jp.work_date), 0), j.quantity)
         , 0) * j.rate_used * j.correction_factor as earned_delta
  from job_progress jp
  join jobs j on j.id = jp.job_id
),
jobday as (
  select job_id, work_date, sum(actual_hours) as crew_actual
  from v_job_worker_day group by job_id, work_date
)
select jwd.employee_id                                                        as employee_code,
       (jwd.work_date - ((extract(dow from jwd.work_date)::int + 1) % 7))::date     as week_start,
       (jwd.work_date - ((extract(dow from jwd.work_date)::int + 1) % 7) + 6)::date as week_end,
       jwd.job_id, j.job_no, j.vessel, j.calibrated,
       jwd.actual_hours,
       case when jd.crew_actual > 0
            then round(coalesce(d.earned_delta,0) * jwd.actual_hours / jd.crew_actual, 3)
            else 0 end                                                        as earned_hours
from v_job_worker_day jwd
join jobday jd  on jd.job_id = jwd.job_id and jd.work_date = jwd.work_date
join jobs j     on j.id = jwd.job_id
left join deltas d on d.job_id = jwd.job_id and d.work_date = jwd.work_date;

-- Per worker, per week: aggregate + breakdown. Source snapshotted by "Close week".
-- v_worker_week_job is per (worker, job, DAY); collapse to one row per (worker, job) FIRST so the
-- breakdown lists each job ONCE, not once per day. Weekly totals are unchanged (sum of per-day sums).
create or replace view v_worker_week_efficiency as
with per_job as (
  select employee_code, week_start, week_end, job_id,
         min(job_no)          as job_no,
         min(vessel)          as vessel,
         bool_and(calibrated) as calibrated,   -- constant per job across its days; bool_and just collapses them
         sum(earned_hours)    as earned_hours,
         sum(actual_hours)    as actual_hours
  from v_worker_week_job
  group by employee_code, week_start, week_end, job_id
)
select employee_code, week_start, week_end,
       round(sum(earned_hours),3)                                   as earned_hours,
       round(sum(actual_hours),3)                                   as actual_hours,
       case when sum(actual_hours) > 0
            then round(sum(earned_hours)/sum(actual_hours),3) else null end as efficiency,
       round(coalesce(sum(earned_hours) filter (where calibrated),0),3)     as calibrated_earned_hours,
       round(coalesce(sum(earned_hours) filter (where not calibrated),0),3) as uncalibrated_earned_hours,
       jsonb_agg(jsonb_build_object(
         'job_id', job_id, 'job_no', job_no, 'vessel', vessel,
         'earned', round(earned_hours,3), 'actual', round(actual_hours,3), 'calibrated', calibrated
       ) order by job_no)                                            as breakdown
from per_job
group by employee_code, week_start, week_end;

-- Payroll-readiness per Sat-Fri week for the Close-week ordering guard. A row counts as UNRESOLVED
-- only when its hours are genuinely NOT settled -- the gate must stay small and real, not cry wolf
-- (a weekly false alarm gets ignored). Two cases:
--   (a) zero usable hours: paid_hours = 0 and not marked 'absent', OR
--   (b) a missing-OUT day (is_incomplete) with NO real clock-out punch (not has_out) whose credit
--       fell MEANINGFULLY short of a full regular day. Regular day = 8h (4h AM + 4h PM); a <1h trim
--       is just a late-in, so flag only < 7h. A forgotten-OUT day boundary-credited to a full ~8h is
--       SETTLED and does NOT count.
-- BLOCK ON UNKNOWNS, INFORM ON KNOWNS: a short day that HAS a real clock-out punch (e.g. a 3:00 PM
-- early-out, is_incomplete only because the final `timeout` is blank) is a KNOWN, correct short day.
-- It is NOT counted in `unresolved`; it is surfaced separately as `short_days` (informational,
-- non-blocking) so real early-outs stay visible on the Close-week summary instead of vanishing.
-- Approved leave days are excluded (when not already 'absent'): leave_requests is keyed by human
-- employee_code and its start/end dates are TEXT (mixed-format landmine), so normalize the code the
-- same way payroll does (upper + strip whitespace) and normalize+expand the date range per day.
create or replace view v_week_payroll_health as
with leave_days as (
  select upper(regexp_replace(lr.employee_code, '\s', '', 'g')) as nc,
         gs::date                                               as leave_date
  from leave_requests lr
  cross join lateral generate_series(
    (case when lr.start_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'                       then substr(lr.start_date,1,10)::date
          when lr.start_date ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$'                  then to_date(lr.start_date,'MM/DD/YYYY') end),
    (case when coalesce(lr.end_date,lr.start_date) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'      then substr(coalesce(lr.end_date,lr.start_date),1,10)::date
          when coalesce(lr.end_date,lr.start_date) ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$' then to_date(coalesce(lr.end_date,lr.start_date),'MM/DD/YYYY') end),
    interval '1 day'
  ) as gs
  where lr.status = 'Approved'
)
select (a.work_date - ((extract(dow from a.work_date)::int + 1) % 7))::date as week_start,
       count(*) filter (where
             (a.is_incomplete and a.paid_hours < 7 and not a.has_out)       -- missing-OUT short day (UNKNOWN -> block)
          or (a.paid_hours = 0 and a.status is distinct from 'absent')       -- zero usable hours, not absent (block)
       )                                                                    as unresolved,
       count(*) filter (where
             a.is_incomplete and a.paid_hours > 0 and a.paid_hours < 7 and a.has_out
       )                                                                    as short_days   -- real early-out, KNOWN -> inform, non-blocking
from v_attendance_day a
where a.work_date is not null
  and not exists (                                    -- drop approved-leave days (not already 'absent')
    select 1 from leave_days ld
    where ld.nc = upper(regexp_replace(a.employee_code, '\s', '', 'g'))
      and ld.leave_date = a.work_date
  )
group by (a.work_date - ((extract(dow from a.work_date)::int + 1) % 7))::date;

-- ============================================================ CLOSE JOB ORDER
-- Two-stage close (coordinator operational close -> owner incentive approval),
-- append-only, mirroring the efficiency_week pattern. See
-- docs/superpowers/specs/2026-07-07-close-job-order-design.md
create table if not exists job_close (
  id                  uuid primary key default gen_random_uuid(),
  job_id              uuid not null references jobs(id),
  close_version       integer not null default 1,
  actual_installed    numeric not null,        -- coordinator's final measured quantity (job unit)
  last_rollcall_units numeric,                 -- latest job_progress cumulative BEFORE this close
  target_quantity     numeric,                 -- jobs.quantity at close (null = no target)
  credited_units      numeric,                 -- least(actual_installed, target); null if no target
  earned_hours        numeric,                 -- frozen from v_job_efficiency at close
  actual_hours        numeric,
  efficiency          numeric,
  overrun             boolean not null default false,
  discrepancy_delta   numeric,
  discrepancy_pct     numeric,
  calibrated_at_close boolean not null default false,
  closed_by           text,
  closed_at           timestamptz not null default now(),
  unique (job_id, close_version)
);

create table if not exists job_close_audit (
  id      uuid primary key default gen_random_uuid(),
  job_id  uuid not null references jobs(id),
  action  text not null,        -- 'operational_close' | 'incentive_approve' | 'reopen'
  version integer not null,
  actor   text,
  note    text,
  at      timestamptz not null default now()
);

-- Security-config audit: logs owner-PIN set/change. NEVER stores the PIN value.
create table if not exists settings_audit (
  id     uuid primary key default gen_random_uuid(),
  key    text not null,         -- e.g. 'owner_pin'
  action text not null,         -- 'set' | 'change'
  actor  text,
  at     timestamptz not null default now()
);

-- Append-only immutability (reuse the existing block_mutation() from this file).
drop trigger if exists trg_jobclose_immutable on job_close;
create trigger trg_jobclose_immutable before update or delete on job_close
  for each row execute function block_mutation();
drop trigger if exists trg_jobcloseaudit_immutable on job_close_audit;
create trigger trg_jobcloseaudit_immutable before update or delete on job_close_audit
  for each row execute function block_mutation();
drop trigger if exists trg_settingsaudit_immutable on settings_audit;
create trigger trg_settingsaudit_immutable before update or delete on settings_audit
  for each row execute function block_mutation();

-- Current close status per job = latest audit action (mirrors efficiency isClosed()).
create or replace view v_job_close_status as
select distinct on (job_id) job_id, action, version, actor, at
from job_close_audit order by job_id, at desc;

-- Backstop: once a job is closed, freeze it — reject progress/checkpoint writes.
-- The close flow writes the final job_progress row BEFORE flipping status='closed',
-- so only post-close writes are blocked. Reopen sets status back to 'ongoing'.
create or replace function block_closed_job_write() returns trigger as $$
begin
  if exists (select 1 from jobs j where j.id = new.job_id and j.status = 'closed') then
    raise exception 'job % is closed; progress/checkpoint writes are frozen', new.job_id;
  end if;
  return new;
end;
$$ language plpgsql;
drop trigger if exists trg_jp_block_closed on job_progress;
create trigger trg_jp_block_closed before insert or update on job_progress
  for each row execute function block_closed_job_write();
drop trigger if exists trg_jc_block_closed on job_checkpoint;
create trigger trg_jc_block_closed before insert or update on job_checkpoint
  for each row execute function block_closed_job_write();

-- ============================================================ INCENTIVE (phase 2, PROVISIONAL)
-- Per worker, per Sat-Fri week: provisional incentive = Σ over ELIGIBLE jobs of
--   max(0, worker_earned_hours − worker_actual_hours) × RATE.
--   · earned_hours already counts only credited (within-target) units — overruns earn 0.
--   · floored per job at 0 (an inefficient job contributes nothing; never subtracts from another).
--   · ELIGIBLE = job is CURRENTLY calibrated AND its latest close action is 'incentive_approve'.
--   · RATE read LIVE from settings.incentive_rate_per_hour — editing the setting re-prices on read.
-- DISPLAY-ONLY / NON-PAYABLE: nothing here flows to payroll. The payable gate is
-- settings.incentive_payable (default 'false'), enforced by the UI, not this view. Owner rule 2026-07-08.
create or replace view v_worker_week_incentive as
with rate as (
  select coalesce((select nullif(btrim(value),'')::numeric
                   from settings where key = 'incentive_rate_per_hour'), 0) as rate_per_hour
),
approved as (   -- jobs whose latest close action is owner incentive-approval
  select job_id from v_job_close_status where action = 'incentive_approve'
),
per_job as (    -- collapse per (worker, week, job): v_worker_week_job is per-day
  select employee_code, week_start, week_end, job_id,
         min(job_no)          as job_no,
         bool_and(calibrated) as calibrated,
         sum(earned_hours)    as earned_hours,
         sum(actual_hours)    as actual_hours
  from v_worker_week_job
  group by employee_code, week_start, week_end, job_id
),
eligible as (
  select pj.employee_code, pj.week_start, pj.week_end, pj.job_id, pj.job_no,
         pj.earned_hours, pj.actual_hours,
         greatest(pj.earned_hours - pj.actual_hours, 0) as hours_saved   -- floor per job at 0
  from per_job pj
  join approved a on a.job_id = pj.job_id
  where pj.calibrated = true
)
select e.employee_code, e.week_start, e.week_end,
       round(sum(e.hours_saved), 3)                                    as hours_saved,
       (select rate_per_hour from rate)                                as rate_per_hour,
       round(sum(e.hours_saved) * (select rate_per_hour from rate), 2) as incentive_amount,
       jsonb_agg(jsonb_build_object(
         'job_id', e.job_id, 'job_no', e.job_no,
         'earned', round(e.earned_hours,3), 'actual', round(e.actual_hours,3),
         'hours_saved', round(e.hours_saved,3),
         'amount', round(e.hours_saved * (select rate_per_hour from rate), 2)
       ) order by e.job_no)                                            as breakdown
from eligible e
group by e.employee_code, e.week_start, e.week_end;

-- Seed the incentive settings. Idempotent and NON-destructive: never overwrites an owner-set value.
insert into settings(key, value) select 'incentive_rate_per_hour', '50'
  where not exists (select 1 from settings where key = 'incentive_rate_per_hour');
insert into settings(key, value) select 'incentive_payable', 'false'
  where not exists (select 1 from settings where key = 'incentive_payable');

-- Force PostgREST to pick up newly-created views immediately (else the REST API 404s them
-- until its schema cache next reloads on its own). Harmless to re-run.
notify pgrst, 'reload schema';
