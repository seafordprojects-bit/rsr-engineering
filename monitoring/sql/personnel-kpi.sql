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

-- ============================================================ VIEWS
-- Payroll-effective hours per worker (employees.id) per ISO day. Reads the SAME worked_ms
-- payroll persists after edits, so KPI actual == paid. attendance_records.date is TEXT in
-- mixed formats (YYYY-MM-DD and MM/DD/YYYY) -> normalized to a real date here, once.
-- attendance is keyed by employees.code; roll-call by employees.id -> bridge via employees.
create or replace view v_attendance_day as
select e.id   as employee_id,
       e.code as employee_code,
       e.name as employee_name,
       (case
          when a.date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'   then substr(a.date,1,10)::date
          when a.date ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$' then to_date(a.date,'MM/DD/YYYY')
          else null
        end)                                   as work_date,
       (coalesce(a.worked_ms,0)/3600000.0)::numeric as paid_hours,
       coalesce(a.is_incomplete,false)         as is_incomplete,
       a.status                                as status
from attendance_records a
join employees e on e.code = a.employee_code;

-- Attribute each worker-day's paid hours across the jobs they were roll-call-tagged to
-- that day, in proportion to checkpoint blocks (spec D9). Sum over a worker-day == paid_hours.
-- Tagged but no attendance row -> paid_hours 0 -> actual_hours 0 (spec edge case).
create or replace view v_job_worker_day as
with crew as (
  select job_id, employee_code as employee_id, (work_date::date) as work_date, count(*) as blocks
  from job_checkpoint
  group by job_id, employee_code, (work_date::date)
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
create or replace view v_worker_week_efficiency as
select employee_code, week_start, week_end,
       round(sum(earned_hours),3)                                   as earned_hours,
       round(sum(actual_hours),3)                                   as actual_hours,
       case when sum(actual_hours) > 0
            then round(sum(earned_hours)/sum(actual_hours),3) else null end as efficiency,
       round(coalesce(sum(earned_hours) filter (where calibrated),0),3)     as calibrated_earned_hours,
       round(coalesce(sum(earned_hours) filter (where not calibrated),0),3) as uncalibrated_earned_hours,
       jsonb_agg(jsonb_build_object(
         'job_id', job_id, 'job_no', job_no, 'vessel', vessel,
         'earned', earned_hours, 'actual', actual_hours, 'calibrated', calibrated
       ) order by job_no)                                            as breakdown
from v_worker_week_job
group by employee_code, week_start, week_end;

-- Payroll-readiness per Sat-Fri week for the Close-week ordering guard: unresolved rows =
-- payroll's own is_incomplete (missing OUT under Policy A) OR a zero-hour present-day anomaly.
create or replace view v_week_payroll_health as
select (work_date - ((extract(dow from work_date)::int + 1) % 7))::date as week_start,
       count(*) filter (where is_incomplete or (paid_hours = 0 and status is distinct from 'absent'))
                                                                          as unresolved
from v_attendance_day
where work_date is not null
group by (work_date - ((extract(dow from work_date)::int + 1) % 7))::date;
