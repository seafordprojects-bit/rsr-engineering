-- personnel-kpi.sql  --  Personnel efficiency (phase 1). Idempotent: safe to re-run.
-- Run in the Supabase SQL editor for project wpmcbjrisuyjvobvzaus.

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
  employee_code             text not null,
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
  unique (employee_code, week_start, close_version)
);

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
-- Per job: earned-to-date (capped at estimate), actual (all tagged hours incl OT), efficiency.
create or replace view v_job_efficiency as
with prog as (
  select distinct on (job_id) job_id, units_cumulative
  from job_progress order by job_id, work_date desc
),
act as (
  select job_id, sum(hours)::numeric as actual_hours
  from job_checkpoint group by job_id
)
select j.id as job_id, j.job_no, j.vessel, j.site, j.status,
       j.quantity, j.unit, j.rate_used, j.correction_factor, j.calibrated,
       coalesce(p.units_cumulative,0)                                as units_cumulative,
       least(coalesce(p.units_cumulative,0), j.quantity)             as credited_units,
       (coalesce(p.units_cumulative,0) > j.quantity)                 as overrun,
       round(least(coalesce(p.units_cumulative,0), j.quantity)
             * j.rate_used * j.correction_factor, 2)                 as earned_hours,
       coalesce(a.actual_hours,0)                                    as actual_hours,
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

-- Per worker, per job, per DAY: split the day's earned delta by hours logged (spec D9).
-- Week bucket: Saturday on/before work_date. Postgres dow: Sun=0..Sat=6, so
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
crew as (
  select job_id, (work_date::date) as work_date, employee_code, sum(hours)::numeric as emp_hours
  from job_checkpoint
  group by job_id, (work_date::date), employee_code
),
crewtot as (
  select job_id, work_date, sum(emp_hours) as crew_hours
  from crew group by job_id, work_date
)
select c.employee_code,
       (c.work_date - ((extract(dow from c.work_date)::int + 1) % 7))::date       as week_start,
       (c.work_date - ((extract(dow from c.work_date)::int + 1) % 7) + 6)::date   as week_end,
       c.job_id, j.job_no, j.vessel, j.calibrated,
       c.emp_hours                                                                as actual_hours,
       case when ct.crew_hours > 0
            then round(coalesce(d.earned_delta,0) * c.emp_hours / ct.crew_hours, 3)
            else 0 end                                                            as earned_hours
from crew c
join crewtot ct on ct.job_id = c.job_id and ct.work_date = c.work_date
join jobs j     on j.id = c.job_id
left join deltas d on d.job_id = c.job_id and d.work_date = c.work_date;

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
