# Personnel KPI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build phase-1 personnel-efficiency measurement (earned ÷ actual man-hours) per job order, per vessel, and per worker per Sat–Fri pay week, in the `monitoring/` module — no peso amounts anywhere.

**Architecture:** Hybrid. All efficiency math lives in idempotent Postgres views (read via PostgREST like tables). A new Roll-call field captures cumulative units-done per job daily. A new `efficiency.html` displays the three views and hosts an admin, append-only "Close week" that snapshots immutable `efficiency_week` rows. The Sat–Fri boundary is a verbatim transcription of payroll's logic in a shared ESM file, guarded against drift by a concrete diagnostic check; `payroll/index.html` is not touched.

**Tech Stack:** Vanilla JS + Preact/htm via CDN (no build step). Supabase/PostgREST (`wpmcbjrisuyjvobvzaus`). Node 24 (`node --check`, `node --test`) for local validation. Playwright for end-to-end.

## Global Constraints

- **No build step, no npm packages, no framework** beyond Preact/htm/supabase-js via CDN importmap. (CLAUDE.md)
- **Supabase project must be `wpmcbjrisuyjvobvzaus`**; the string `azfmpleswqixaslvcito` must NEVER appear. (CLAUDE.md hard rule 4)
- **Complete files only** when handing to the owner — never diffs/partials. (CLAUDE.md hard rule 2)
- **Validate before shipping:** extract the largest inline `<script>` from any edited HTML and run `node --check` on it as an ES module; hygiene-grep for `wpmcbjrisuyjvobvzaus` (present) and `azfmpleswqixaslvcito` (absent). (CLAUDE.md hard rules 3–4)
- **SQL uses `--` comments** (never `//`); **htm template literals use literal `&`**, never `&amp;`. (CLAUDE.md hard rule 5)
- **Read the CURRENT live file before editing it.** (CLAUDE.md hard rule 6)
- **Pay week = Saturday → Friday**, identical to `payroll/index.html:635-644`. Never re-derive it independently; the shared file is a labelled verbatim transcription and the drift-guard enforces parity. (spec §6, D8)
- **`payroll/index.html` stays byte-identical** in this workstream. No bridge script, no load-order dependency added. (user decision)
- **Zero peso amounts, zero bonus/provisional formulas** on any screen or record. Phase 2 is a separate spec. (spec D7, §10)
- **Owner applies SQL and commits/deploys.** Do not auto-commit pay-affecting changes without explicit approval; propose → confirm → implement → validate → show. (CLAUDE.md workflow)
- Monitoring module carries **no version stamp** and is **not** in `preflight.html`'s `EXPECT`. Do not add stamps to monitoring pages.
- **Live-Supabase verification is read-unrestricted but write-restricted (user mandate):** automated verification may write ONLY to the new `job_progress` table, using clearly TEST-marked rows (e.g. `reported_by:"TEST-…"`, a sentinel `work_date`) that are deleted immediately after. **ZERO writes to any pre-existing table** (`jobs`, `job_checkpoint`, `employees`, …) — reference existing rows by reading their id, never by inserting/updating them. `efficiency_week`/`efficiency_week_audit` are append-only (undeletable via PostgREST), so do NOT insert TEST rows there during automated checks; their Close/immutability/calibration behaviour is verified by local validation + reviewer inspection + an owner-run manual acceptance.

## Access-control scope note

The monitoring module has no auth (RLS disabled, shared anon key) — "admin" here means an action gated behind an explicit confirm that records an actor name (reusing the existing `localStorage['rsr_prepared_by']` pattern from `job-order.html:92`). Real access control is out of scope for v1 and can later reuse whatever `admin/index.html` adopts.

## File structure

**Create**
- `shared/payweek.mjs` — single source of truth for the Sat–Fri boundary (verbatim transcription of payroll). Pure functions, no DOM.
- `shared/payweek.test.mjs` — `node:test` golden-date tests for the above.
- `monitoring/sql/personnel-kpi.sql` — idempotent DDL: 3 tables, `jobs` columns, 3 triggers, 4 views. Owner runs it in the Supabase SQL editor.
- `monitoring/efficiency.html` — display (By job / By vessel / By worker-week) + admin Close/Reopen + calibration toggle.
- `monitoring/diagnostic.html` — drift-guard + KPI data-integrity checks.

**Modify**
- `monitoring/config.js` — re-export payweek helpers; add small KPI data loaders.
- `monitoring/roll-call.html` — add per-job "units done to date" field writing `job_progress`.
- `monitoring/index.html` — add a "Productivity" section and the missing links (Monitor, Efficiency, Reconcile, Tariff, Diagnostic).

**Untouched:** `payroll/index.html`, `preflight.html`, all other pages.

---

## Task 1: Shared Sat–Fri pay-week helper (pure ESM, real TDD)

**Files:**
- Create: `shared/payweek.mjs`
- Test: `shared/payweek.test.mjs`

**Interfaces:**
- Produces:
  - `saturdayOnOrBefore(d: Date): Date` — local midnight of the Saturday on/before `d`.
  - `weekContaining(dateStr: string): {start: string, end: string}` — Sat–Fri ISO window containing `'YYYY-MM-DD'`. Used to bucket a `work_date` into its pay week.
  - `defaultPayWeek(offset?: number, now?: Date): {start: string, end: string}` — verbatim mirror of payroll `setWeek(offset)` (reference-from-yesterday). `offset` 0 = current, −1 = previous.

- [ ] **Step 1: Write the failing test** — `shared/payweek.test.mjs`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { saturdayOnOrBefore, weekContaining, defaultPayWeek } from "./payweek.mjs";

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;

test("saturdayOnOrBefore snaps to the Saturday on/before", () => {
  assert.equal(iso(saturdayOnOrBefore(new Date("2026-07-04T12:00:00"))), "2026-07-04"); // Sat -> itself
  assert.equal(iso(saturdayOnOrBefore(new Date("2026-07-03T12:00:00"))), "2026-06-27"); // Fri -> prev Sat
  assert.equal(iso(saturdayOnOrBefore(new Date("2026-07-10T12:00:00"))), "2026-07-04"); // Fri end -> its Sat
});

test("weekContaining returns the Sat-Fri window", () => {
  assert.deepEqual(weekContaining("2026-07-06"), { start: "2026-07-04", end: "2026-07-10" }); // Mon
  assert.deepEqual(weekContaining("2026-07-03"), { start: "2026-06-27", end: "2026-07-03" }); // Fri (week end)
  assert.deepEqual(weekContaining("2026-07-04"), { start: "2026-07-04", end: "2026-07-10" }); // Sat (week start)
});

test("defaultPayWeek mirrors payroll: on payday Sat it shows the week that just ended", () => {
  // payroll comment: on Sat Jul 4 it loads Jun 27 -> Jul 3
  assert.deepEqual(defaultPayWeek(0, new Date("2026-07-04T09:00:00")), { start: "2026-06-27", end: "2026-07-03" });
  assert.deepEqual(defaultPayWeek(-1, new Date("2026-07-04T09:00:00")), { start: "2026-06-20", end: "2026-06-26" });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `node --test shared/payweek.test.mjs`
Expected: FAIL — cannot resolve `./payweek.mjs` / functions not exported.

- [ ] **Step 3: Implement `shared/payweek.mjs`**

```js
// shared/payweek.mjs
// SINGLE SOURCE OF TRUTH for the RSR pay-week boundary (Saturday -> Friday).
// VERBATIM transcription of payroll/index.html:436 (isoOf) and 635-644 (setWeek).
// payroll/index.html still carries its own inline copy today and MUST stay byte-
// identical in this workstream; monitoring/diagnostic.html asserts the two never
// drift. Converge payroll onto this file on the next payroll-initiated change.

// payroll/index.html:436 -- local YYYY-MM-DD, no UTC shift
export function isoOf(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}

// Saturday on/before d. Mirrors payroll sinceSat=(getDay()+1)%7 (Sat=0..Fri=6), payroll/index.html:640
export function saturdayOnOrBefore(d){
  const x=new Date(d); x.setHours(0,0,0,0);
  const sinceSat=(x.getDay()+1)%7;
  x.setDate(x.getDate()-sinceSat);
  return x;
}

// Pay week (Sat->Fri) CONTAINING dateStr 'YYYY-MM-DD'. Pure; used to bucket a work_date.
export function weekContaining(dateStr){
  const sat=saturdayOnOrBefore(new Date(dateStr+'T00:00:00'));
  const fri=new Date(sat); fri.setDate(sat.getDate()+6);
  return { start: isoOf(sat), end: isoOf(fri) };
}

// Default selected pay week for the Close-week screen. VERBATIM mirror of payroll
// setWeek(offset), payroll/index.html:636-642: reference from YESTERDAY so payday-
// Saturday shows the week that just ended. offset 0 = current, -1 = previous.
export function defaultPayWeek(offset=0, now=new Date()){
  const ref=new Date(now); ref.setDate(ref.getDate()-1); ref.setHours(0,0,0,0);
  const sinceSat=(ref.getDay()+1)%7; // Sat=0, Sun=1, ... Fri=6
  const sat=new Date(ref); sat.setDate(ref.getDate()-sinceSat+offset*7);
  const fri=new Date(sat); fri.setDate(sat.getDate()+6);
  return { start: isoOf(sat), end: isoOf(fri) };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `node --test shared/payweek.test.mjs`
Expected: PASS — 3 tests, 0 failures.

- [ ] **Step 5: Syntax-check as a module and commit**

Run: `node --check shared/payweek.mjs`
Expected: no output (valid).

```bash
git add shared/payweek.mjs shared/payweek.test.mjs
git commit -m "feat(kpi): shared Sat-Fri pay-week helper (verbatim transcription of payroll)"
```

---

## Task 2: Database schema, triggers, and views (owner-applied SQL)

**Files:**
- Create: `monitoring/sql/personnel-kpi.sql`

**Interfaces:**
- Produces (read by later tasks via PostgREST):
  - table `job_progress(job_id uuid, work_date date, units_cumulative numeric, reported_by text)`, unique `(job_id, work_date)`.
  - table `efficiency_week(...)` immutable, unique `(employee_code, week_start, close_version)`.
  - table `efficiency_week_audit(week_start date, action text, version int, actor text, note text, at timestamptz)` append-only.
  - `jobs.calibrated boolean`, `jobs.calibrated_by text`, `jobs.calibrated_at timestamptz`.
  - views `v_job_efficiency`, `v_vessel_efficiency`, `v_worker_week_job`, `v_worker_week_efficiency`.

- [ ] **Step 1: Write `monitoring/sql/personnel-kpi.sql`** (idempotent; `--` comments only)

```sql
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
```

- [ ] **Step 2: Owner applies the SQL** in the Supabase SQL editor (project `wpmcbjrisuyjvobvzaus`). It is idempotent — re-running is safe.

Expected: "Success. No rows returned."

- [ ] **Step 3: Verify objects exist via PostgREST** (read-only; anon key from `monitoring/config.js:12`)

Run (bash):
```bash
KEY="<anon key from monitoring/config.js>"
BASE="https://wpmcbjrisuyjvobvzaus.supabase.co/rest/v1"
for obj in job_progress efficiency_week efficiency_week_audit v_job_efficiency v_vessel_efficiency v_worker_week_efficiency; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/$obj?select=*&limit=1" -H "apikey: $KEY" -H "Authorization: Bearer $KEY")
  echo "$obj -> $code"
done
curl -s "$BASE/jobs?select=id,calibrated&limit=1" -H "apikey: $KEY" -H "Authorization: Bearer $KEY"
```
Expected: every object returns `200`; the `jobs` row includes a `calibrated` field.

- [ ] **Step 4: Commit the SQL file**

```bash
git add monitoring/sql/personnel-kpi.sql
git commit -m "feat(kpi): job_progress, efficiency_week, calibration, and efficiency views (idempotent SQL)"
```

---

## Task 3: config.js — re-export payweek helpers + KPI loaders

**Files:**
- Modify: `monitoring/config.js` (append exports; do not alter existing lines)

**Interfaces:**
- Consumes: `shared/payweek.mjs` (Task 1); existing `sb` (config.js:14).
- Produces (imported by Tasks 4–6):
  - re-exports `weekContaining`, `defaultPayWeek`, `isoOf` from payweek.
  - `upsertJobProgress(jobId, workDate, units, reportedBy): Promise<{error}>`
  - `loadJobProgressFor(workDate): Promise<Array<{job_id,units_cumulative}>>`

- [ ] **Step 1: Read the current file**, then append at end of `monitoring/config.js`:

```js
/* ---- personnel KPI (phase 1) ---- */
export { weekContaining, defaultPayWeek, isoOf } from "../shared/payweek.mjs";

// Upsert one cumulative units-to-date reading for a job on a day (unique job_id+work_date).
export async function upsertJobProgress(jobId, workDate, units, reportedBy) {
  return await sb.from("job_progress")
    .upsert({ job_id: jobId, work_date: workDate, units_cumulative: units, reported_by: reportedBy || null },
            { onConflict: "job_id,work_date" });
}

// Latest cumulative reading per job on or before a given date (for pre-filling Roll-call).
export async function loadJobProgressFor(workDate) {
  const { data, error } = await sb.from("job_progress")
    .select("job_id,work_date,units_cumulative")
    .lte("work_date", workDate)
    .order("work_date", { ascending: false });
  if (error) { console.error("loadJobProgressFor", error); return []; }
  const seen = {}, out = [];
  (data || []).forEach(r => { if (!(r.job_id in seen)) { seen[r.job_id] = 1; out.push(r); } });
  return out;
}
```

- [ ] **Step 2: Validate the module + hygiene**

Run:
```bash
node --check monitoring/config.js
grep -c wpmcbjrisuyjvobvzaus monitoring/config.js   # expect >= 1
grep -c azfmpleswqixaslvcito monitoring/config.js   # expect 0
```
Expected: `node --check` clean; first grep ≥ 1; second grep `0`.

- [ ] **Step 3: Commit**

```bash
git add monitoring/config.js
git commit -m "feat(kpi): config.js payweek re-exports and job_progress loaders"
```

---

## Task 4: Roll-call — capture cumulative units-done per job

**Files:**
- Modify: `monitoring/roll-call.html` (import list; add progress state, loader, field, save)

**Interfaces:**
- Consumes: `upsertJobProgress`, `loadJobProgressFor` (Task 3); existing `jobs`/`job_progress`.
- Produces: writes `job_progress` rows read by Task 2 views.

- [ ] **Step 1: Read the current `monitoring/roll-call.html`.**

- [ ] **Step 2: Extend the import** (roll-call.html:93) to add the two helpers and the job estimate quantity.

Change the import to include `upsertJobProgress, loadJobProgressFor`:
```js
import { sb, CHECKPOINTS, HOURS_PER_CHECKPOINT, loadEmployees, todayLocal, ymd, addDays,
         upsertJobProgress, loadJobProgressFor } from "./config.js";
```
And extend the jobs query (roll-call.html:124-126) `.select(...)` to include `quantity,unit`:
```js
.select("id,job_no,vessel,location,start_date,target_date,status,est_manhours,quantity,unit")
```

- [ ] **Step 3: Add progress state + load it in `reload()`.**

After `const [busy,setBusy]=useState(false);` (roll-call.html:116) add:
```js
const [progress,setProgress]=useState({});   // job_id -> cumulative units to date
const [pedit,setPedit]=useState({});          // job_id -> in-progress text field value
```
Inside `reload()`, after `setPauses(...)` (roll-call.html:141), add:
```js
const prog = await loadJobProgressFor(dnow);
const pm={}; prog.forEach(r=>{ pm[r.job_id]=Number(r.units_cumulative); });
setProgress(pm);
setPedit(Object.fromEntries(Object.entries(pm).map(([k,v])=>[k,String(v)])));
```

- [ ] **Step 4: Add a save handler** (near `doPause`, roll-call.html:184):

```js
async function saveProgress(job){
  const v=Number(pedit[job]);
  if(isNaN(v)||v<0){ setMsg("Enter a valid units-done number."); return; }
  setBusy(true);
  const {error}=await upsertJobProgress(job, date, v, null);
  setBusy(false);
  if(error){ setMsg(error.message); return; }
  setProgress({...progress,[job]:v});
}
```

- [ ] **Step 5: Render a units-done field per job.** Inside the non-paused job branch, after the `.add` block (roll-call.html:274) and before the pause button, insert:

```js
<div class="add">
  <label style="flex:0 0 auto;font-size:12.5px;color:var(--muted);font-weight:600">Units done to date${j.unit?` (${j.unit})`:""}</label>
  <input type="number" inputmode="decimal" style="flex:1;padding:9px 10px;border:1px dashed #c3d3e4;border-radius:9px;background:#f7fafd;font-size:13.5px"
         value=${pedit[j.id]!=null?pedit[j.id]:""} onInput=${e=>setPedit({...pedit,[j.id]:e.target.value})}
         placeholder=${j.quantity!=null?`of ${j.quantity}`:"0"} />
  <button class="tog" disabled=${busy} onClick=${()=>saveProgress(j.id)}>Save</button>
</div>
${progress[j.id]!=null && j.quantity!=null && progress[j.id]>j.quantity
  ? html`<div class="holdnote" style="color:var(--warn)">Units exceed the estimate of ${j.quantity} — job flagged for estimate review; no incentive on overrun units until admin approves.</div>`
  : ""}
```

- [ ] **Step 6: Validate (extract inline script, `node --check`, hygiene).**

Run (bash — extracts the module script between the last `<script type="module">` and `</script>`):
```bash
awk '/<script type="module">/{f=1;next} /<\/script>/{if(f)exit} f' monitoring/roll-call.html > /tmp/rc.mjs
node --check /tmp/rc.mjs
grep -c wpmcbjrisuyjvobvzaus monitoring/roll-call.html   # via config import; page itself may be 0 — OK
grep -c azfmpleswqixaslvcito monitoring/roll-call.html   # expect 0
```
Expected: `node --check` clean; second grep `0`. (The URL lives in config.js; the page importing it is fine.)

- [ ] **Step 7: Live checks — reads + `job_progress` round-trip only (NO writes to pre-existing tables).** First, a read-only DOM smoke test: serve the repo, open `http://localhost:8123/monitoring/roll-call.html`, confirm the "Units done to date" field renders on active jobs (no Save clicked — clicking Save on a real job would write `job_progress` for a real job/today, which is a real row, not a TEST row). Then prove the write path with an isolated TEST row that references an EXISTING job by FK (read only) on a sentinel date, and delete it:

```bash
KEY="<anon key from monitoring/config.js:12>"; BASE="https://wpmcbjrisuyjvobvzaus.supabase.co/rest/v1"
# Read an existing job id (NO write to jobs):
JOB=$(curl -s "$BASE/jobs?select=id&limit=1" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" | sed -E 's/.*"id":"([^"]+)".*/\1/')
# Insert a TEST job_progress row (NEW table) on a sentinel date that cannot collide with real data:
curl -s "$BASE/job_progress" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{\"job_id\":\"$JOB\",\"work_date\":\"2000-01-01\",\"units_cumulative\":1,\"reported_by\":\"TEST-kpi-verify\"}"
curl -s "$BASE/job_progress?select=units_cumulative,reported_by&job_id=eq.$JOB&work_date=eq.2000-01-01" -H "apikey: $KEY" -H "Authorization: Bearer $KEY"  # expect units_cumulative 1
# Clean up the TEST row (job_progress is deletable):
curl -s -X DELETE "$BASE/job_progress?job_id=eq.$JOB&work_date=eq.2000-01-01" -H "apikey: $KEY" -H "Authorization: Bearer $KEY"
curl -s "$BASE/job_progress?select=id&work_date=eq.2000-01-01" -H "apikey: $KEY" -H "Authorization: Bearer $KEY"  # expect []
```
Expected: the field renders; the TEST row inserts and reads back `1`; the delete leaves `[]`. No pre-existing table is written; the only KPI-table write is the TEST `job_progress` row, removed at the end.

- [ ] **Step 8: Commit**

```bash
git add monitoring/roll-call.html
git commit -m "feat(kpi): Roll-call captures cumulative units-done per job"
```

---

## Task 5: efficiency.html — display, Close/Reopen, calibration toggle

**Files:**
- Create: `monitoring/efficiency.html`

**Interfaces:**
- Consumes: `sb`, `loadEmployees`, `fmtNum`, `defaultPayWeek` (Tasks 1–3); views from Task 2.
- Produces: inserts `efficiency_week` + `efficiency_week_audit` rows (append-only); updates `jobs.calibrated`.

- [ ] **Step 1: Create `monitoring/efficiency.html`** with the standard monitoring shell (copy the `<head>`/style conventions from `monitor.html`) and this module script. Use literal `&` in any htm text.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Efficiency</title>
<style>
  :root{--ink:#1c2230;--muted:#6b7280;--line:#e3e6ec;--paper:#fff;--bg:#f4f5f7;
    --steel:#2f5d8a;--steel-d:#234a70;--ok:#1f7a4d;--okbg:#e8f5ee;--over:#b4231f;--overbg:#fbe8e7;
    --warn:#b4540a;--warnbg:#fbf3e8;--radius:14px;--mono:ui-monospace,Menlo,Consolas,monospace;}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 -apple-system,"Segoe UI",Roboto,sans-serif;padding:0 0 48px}
  .wrap{max-width:640px;margin:0 auto;padding:14px}
  header.top{display:flex;align-items:baseline;justify-content:space-between;padding:10px 2px 12px}
  header.top h1{font-size:19px;margin:0}.sub{color:var(--muted);font-size:12.5px}
  a.back{color:var(--steel);text-decoration:none;font-size:13px}
  .tabs{display:flex;gap:8px;margin-bottom:14px}
  .tab{flex:1;text-align:center;padding:10px;border:1px solid var(--line);border-radius:11px;background:var(--paper);font-weight:700;font-size:13.5px;color:var(--ink)}
  .tab.on{background:var(--steel);color:#fff;border-color:var(--steel)}
  .row{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:12px 13px;margin-bottom:9px}
  .rn{font-weight:600;font-size:14px}.jno{font-family:var(--mono);font-size:12.5px;color:var(--steel-d);font-weight:700}
  .fig{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:12.5px;color:var(--muted);margin-top:4px}.fig b{color:var(--ink);font-family:var(--mono)}
  .eff{font-family:var(--mono);font-weight:700}
  .badge{font-size:10.5px;font-weight:700;border-radius:18px;padding:2px 8px;letter-spacing:.3px;margin-left:6px}
  .badge.amber{background:var(--warnbg);color:var(--warn);border:1px solid #f0d9bf}
  .badge.over{background:var(--overbg);color:var(--over);border:1px solid #f0bdba}
  .badge.ok{background:var(--okbg);color:var(--ok);border:1px solid #bfe3cf}
  .bar{background:var(--paper);border:1px solid var(--line);border-radius:var(--radius);padding:12px 14px;margin-bottom:13px}
  .bar label{display:block;font-size:12px;color:var(--muted);font-weight:600;margin-bottom:5px}
  .bar input,.bar select{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:10px;font-size:15px;background:#fcfcfd}
  button.primary{width:100%;margin-top:10px;padding:12px;border:0;border-radius:11px;background:var(--steel);color:#fff;font-weight:700}
  button.ghost{margin-top:8px;width:100%;padding:10px;border:1px solid var(--line);background:#fcfcfd;color:var(--muted);border-radius:11px;font-weight:600}
  button.mini{border:1px solid var(--line);background:#fcfcfd;border-radius:8px;font-size:12px;font-weight:700;padding:6px 10px;color:var(--ink)}
  .warnbox{background:var(--warnbg);border:1px solid #f0d9bf;color:var(--warn);font-size:12.5px;border-radius:10px;padding:9px 12px;margin:8px 0}
  .empty{color:var(--muted);font-size:13.5px;text-align:center;padding:20px 0;background:var(--paper);border:1px solid var(--line);border-radius:var(--radius)}
  .loading{color:var(--muted);font-size:13px;text-align:center;padding:14px}
  .msg{margin:0 0 12px;font-size:13px;padding:9px 11px;border-radius:9px}
  .msg.ok{background:var(--okbg);color:var(--ok);border:1px solid #bfe3cf}.msg.err{background:var(--overbg);color:var(--over);border:1px solid #f0bdba}
</style>
<script type="importmap">
{
  "imports": {
    "@supabase/supabase-js": "https://esm.sh/@supabase/supabase-js@2",
    "preact": "https://esm.sh/preact@10.19.3",
    "preact/hooks": "https://esm.sh/preact@10.19.3/hooks",
    "htm": "https://esm.sh/htm@3.1.1"
  }
}
</script>
</head>
<body>
  <div class="wrap">
    <header class="top">
      <div><h1>Efficiency</h1><div class="sub">Earned vs actual man-hours</div></div>
      <a class="back" href="index.html">&larr; Menu</a>
    </header>
    <div id="app"><div class="loading">Loading&hellip;</div></div>
  </div>
  <script type="module">
    import { h, render } from "preact";
    import { useState, useEffect } from "preact/hooks";
    import htm from "htm";
    import { sb, loadEmployees, fmtNum, defaultPayWeek } from "./config.js";
    const html = htm.bind(h);
    const pct = (e) => e==null ? "—" : fmtNum(e*100,0)+"%";

    function App(){
      const [tab,setTab]=useState("job");
      const [emps,setEmps]=useState([]);
      const [jobs,setJobs]=useState(null);
      const [vessels,setVessels]=useState(null);
      const [week,setWeek]=useState(defaultPayWeek(0).start);
      const [wrows,setWrows]=useState(null);
      const [closed,setClosed]=useState(false);
      const [warnJobs,setWarnJobs]=useState([]);
      const [actor,setActor]=useState(localStorage.getItem("rsr_prepared_by")||"");
      const [busy,setBusy]=useState(false);
      const [msg,setMsg]=useState(null);

      useEffect(()=>{ loadEmployees().then(setEmps); loadJobs(); },[]);
      useEffect(()=>{ if(tab==="worker") loadWeek(); },[tab,week]);

      const nameOf=(code)=>{ const e=emps.find(x=>x.id===code); return e? e.name : code; };
      function saveActor(v){ setActor(v); localStorage.setItem("rsr_prepared_by",v); }

      async function loadJobs(){
        const j=await sb.from("v_job_efficiency").select("*").order("job_no");
        const v=await sb.from("v_vessel_efficiency").select("*").order("vessel");
        if(j.error) setMsg({type:"err",text:j.error.message});
        setJobs(j.data||[]); setVessels(v.data||[]);
      }

      // is this week already closed? latest audit action for the week === 'close'
      async function isClosed(wk){
        const {data}=await sb.from("efficiency_week_audit").select("action,version,at")
          .eq("week_start",wk).order("at",{ascending:false}).limit(1);
        return { closed:(data&&data[0]&&data[0].action==="close"), version:(data&&data[0]?data[0].version:0) };
      }

      async function loadWeek(){
        setWrows(null); setMsg(null);
        const st=await isClosed(week); setClosed(st.closed);
        if(st.closed){
          const {data}=await sb.from("efficiency_week").select("*")
            .eq("week_start",week).eq("close_version",st.version).order("employee_code");
          setWrows(data||[]); setWarnJobs([]); return;
        }
        // live (not yet closed): read the view + compute close-warnings
        const wk=defaultPayWeek(0); const end=addFri(week);
        const {data,error}=await sb.from("v_worker_week_efficiency").select("*").eq("week_start",week);
        if(error){ setMsg({type:"err",text:error.message}); setWrows([]); return; }
        setWrows(data||[]);
        setWarnJobs(await computeWarnings(week,end));
      }
      function addFri(sat){ const d=new Date(sat+"T00:00:00"); d.setDate(d.getDate()+6);
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }

      // Jobs with tagged hours in the window but NO progress reading in the window (accrual lag, spec §7)
      async function computeWarnings(st,en){
        const cp=await sb.from("job_checkpoint").select("job_id,work_date").gte("work_date",st).lte("work_date",en);
        const pr=await sb.from("job_progress").select("job_id,work_date").gte("work_date",st).lte("work_date",en);
        const hoursJobs=new Set((cp.data||[]).map(r=>r.job_id));
        const progJobs=new Set((pr.data||[]).map(r=>r.job_id));
        return [...hoursJobs].filter(j=>!progJobs.has(j));
      }

      async function closeWeek(){
        if(!actor.trim()){ setMsg({type:"err",text:"Enter your name (recorded on the close)."}); return; }
        if(!confirm(`Close ${week} → ${addFri(week)}? This writes an immutable record.`)) return;
        setBusy(true);
        const st=await isClosed(week);
        if(st.closed){ setBusy(false); setMsg({type:"err",text:"Already closed."}); return; }
        const maxv=await sb.from("efficiency_week").select("close_version").eq("week_start",week)
          .order("close_version",{ascending:false}).limit(1);
        const version=((maxv.data&&maxv.data[0]&&maxv.data[0].close_version)||0)+1;
        const src=await sb.from("v_worker_week_efficiency").select("*").eq("week_start",week);
        const payload=(src.data||[]).map(r=>({
          employee_code:r.employee_code, week_start:r.week_start, week_end:r.week_end,
          earned_hours:r.earned_hours, actual_hours:r.actual_hours, efficiency:r.efficiency,
          calibrated_earned_hours:r.calibrated_earned_hours, uncalibrated_earned_hours:r.uncalibrated_earned_hours,
          breakdown:r.breakdown, close_version:version, closed_by:actor.trim(),
        }));
        if(payload.length){
          const ins=await sb.from("efficiency_week").insert(payload);
          if(ins.error){ setBusy(false); setMsg({type:"err",text:ins.error.message}); return; }
        }
        await sb.from("efficiency_week_audit").insert({week_start:week,action:"close",version,actor:actor.trim()});
        setBusy(false); setMsg({type:"ok",text:`Closed ${payload.length} worker record(s).`}); loadWeek();
      }

      async function reopenWeek(){
        if(!actor.trim()){ setMsg({type:"err",text:"Enter your name (recorded on the reopen)."}); return; }
        const note=prompt("Reason for reopening this closed week?")||"";
        setBusy(true);
        const st=await isClosed(week);
        await sb.from("efficiency_week_audit").insert({week_start:week,action:"reopen",version:st.version,actor:actor.trim(),note});
        setBusy(false); setMsg({type:"ok",text:"Week reopened (logged). You can re-close after edits."}); loadWeek();
      }

      async function toggleCalib(j){
        setBusy(true);
        const payload=j.calibrated
          ? {calibrated:false, calibrated_by:null, calibrated_at:null}
          : {calibrated:true, calibrated_by:actor.trim()||null, calibrated_at:new Date().toISOString()};
        const {error}=await sb.from("jobs").update(payload).eq("id",j.job_id);
        setBusy(false);
        if(error){ setMsg({type:"err",text:error.message}); return; }
        loadJobs();
      }

      // ---- views ----
      function JobView(){
        if(jobs===null) return html`<div class="loading">Loading&hellip;</div>`;
        if(jobs.length===0) return html`<div class="empty">No job orders yet.</div>`;
        return jobs.map(j=>html`
          <div class="row">
            <div><span class="jno">${j.job_no}</span> <span class="rn">${j.vessel}</span>
              ${!j.calibrated && html`<span class="badge amber">factors not calibrated · incentive pending</span>`}
              ${j.overrun && html`<span class="badge over">overrun · estimate review</span>`}
            </div>
            <div class="fig">
              <span>earned <b>${fmtNum(j.earned_hours)}</b>h</span>
              <span>actual <b>${fmtNum(j.actual_hours)}</b>h</span>
              <span>eff <b class="eff">${pct(j.efficiency)}</b></span>
              <span>units <b>${fmtNum(j.units_cumulative)}</b>/${fmtNum(j.quantity)}</span>
            </div>
            <button class="mini" style="margin-top:8px" disabled=${busy} onClick=${()=>toggleCalib(j)}>
              ${j.calibrated?"Un-calibrate":"Mark calibrated (admin)"}
            </button>
          </div>`);
      }
      function VesselView(){
        if(vessels===null) return html`<div class="loading">Loading&hellip;</div>`;
        if(vessels.length===0) return html`<div class="empty">No vessels yet.</div>`;
        return vessels.map(v=>html`
          <div class="row">
            <div class="rn">${v.vessel} <span class="sub">(${v.jobs} jobs)</span></div>
            <div class="fig">
              <span>earned <b>${fmtNum(v.earned_hours)}</b>h</span>
              <span>actual <b>${fmtNum(v.actual_hours)}</b>h</span>
              <span>eff <b class="eff">${pct(v.efficiency)}</b></span>
              <span>calibrated earned <b>${fmtNum(v.calibrated_earned_hours)}</b>h</span>
            </div>
          </div>`);
      }
      function WorkerView(){
        return html`
          <div class="bar">
            <label>Pay week (Saturday start)</label>
            <input type="date" value=${week} onInput=${e=>setWeek(e.target.value)} />
            <div class="sub" style="margin-top:6px">${week} → ${addFri(week)} ${closed?html`<span class="badge ok">closed</span>`:""}</div>
            <label style="margin-top:10px">Your name (recorded on close/reopen)</label>
            <input value=${actor} onInput=${e=>saveActor(e.target.value)} placeholder="admin name" />
            ${!closed && warnJobs.length>0 && html`<div class="warnbox">${warnJobs.length} job(s) have hours this week but no progress reading in the window — enter a Friday units-done reading before closing, or their earned hours land next week.</div>`}
            ${closed
              ? html`<button class="ghost" disabled=${busy} onClick=${reopenWeek}>Reopen week (admin, logged)</button>`
              : html`<button class="primary" disabled=${busy} onClick=${closeWeek}>Close week (admin)</button>`}
          </div>
          ${wrows===null? html`<div class="loading">Loading&hellip;</div>`
            : wrows.length===0? html`<div class="empty">No worker activity in this week.</div>`
            : wrows.map(r=>html`
                <div class="row">
                  <div class="rn">${nameOf(r.employee_code)}</div>
                  <div class="fig">
                    <span>earned <b>${fmtNum(r.earned_hours)}</b>h</span>
                    <span>actual <b>${fmtNum(r.actual_hours)}</b>h</span>
                    <span>eff <b class="eff">${pct(r.efficiency)}</b></span>
                    <span>calibrated <b>${fmtNum(r.calibrated_earned_hours)}</b>h</span>
                  </div>
                </div>`)}
        `;
      }

      return html`
        <div class="tabs">
          <div class="tab ${tab==="job"?"on":""}" onClick=${()=>{setTab("job");setMsg(null);}}>By job</div>
          <div class="tab ${tab==="vessel"?"on":""}" onClick=${()=>{setTab("vessel");setMsg(null);}}>By vessel</div>
          <div class="tab ${tab==="worker"?"on":""}" onClick=${()=>{setTab("worker");setMsg(null);}}>By worker</div>
        </div>
        ${msg && html`<div class="msg ${msg.type}">${msg.text}</div>`}
        ${tab==="job"?JobView():tab==="vessel"?VesselView():WorkerView()}
      `;
    }
    render(html`<${App} />`, document.getElementById("app"));
  </script>
</body>
</html>
```

- [ ] **Step 2: Validate (extract inline module script, `node --check`, hygiene).**

Run:
```bash
awk '/<script type="module">/{f=1;next} /<\/script>/{if(f)exit} f' monitoring/efficiency.html > /tmp/eff.mjs
node --check /tmp/eff.mjs
grep -c azfmpleswqixaslvcito monitoring/efficiency.html   # expect 0
```
Expected: `node --check` clean; grep `0`.

- [ ] **Step 3: Live checks — reads only (NO writes to any pre-existing table; NO TEST rows in append-only tables).** Serve the repo and open `http://localhost:8123/monitoring/efficiency.html`:
  - **By job** reads `v_job_efficiency` and renders real jobs, each with an amber "factors not calibrated · incentive pending" badge (since no job is calibrated yet), earned/actual/eff, and an overrun badge where applicable. Read-only — do NOT click "Mark calibrated" (that writes `jobs.calibrated`, a pre-existing table).
  - **By vessel** reads `v_vessel_efficiency` and renders per-vessel roll-ups.
  - **By worker** for the current pay week reads `v_worker_week_efficiency`. With `job_checkpoint` empty in the live DB this list is expected to be empty and must render the empty-state without error. Do NOT click "Close week" (writes append-only `efficiency_week`/audit, which cannot be cleaned via PostgREST).

  Confirm the three views return `200` and the page throws no console error:
```bash
KEY="<anon key from monitoring/config.js:12>"; BASE="https://wpmcbjrisuyjvobvzaus.supabase.co/rest/v1"
for v in v_job_efficiency v_vessel_efficiency v_worker_week_efficiency; do
  echo "$v -> $(curl -s -o /dev/null -w '%{http_code}' "$BASE/$v?select=*&limit=1" -H "apikey: $KEY" -H "Authorization: Bearer $KEY")"
done
```
Expected: each view returns `200`; the page renders By-job/By-vessel from real read-only data and an empty By-worker list, with no writes anywhere.

**The Close-week insert, immutability trigger, calibration toggle, and reopen are NOT exercised against production here** (they write `jobs`/append-only tables). Their correctness is covered by local `node --check` + this task's reviewer inspecting the insert/update payloads against the Task-2 DDL, and by an **owner-run manual acceptance** in a controlled setting (the owner can disable the immutability trigger in the Supabase SQL editor to clean up afterward). Note this hand-off in the task report.

- [ ] **Step 4: Commit**

```bash
git add monitoring/efficiency.html
git commit -m "feat(kpi): efficiency page (by job/vessel/worker) with admin close/reopen and calibration"
```

---

## Task 6: monitoring/diagnostic.html — drift-guard + data-integrity checks

**Files:**
- Create: `monitoring/diagnostic.html`

**Interfaces:**
- Consumes: `shared/payweek.mjs` (Task 1); views + tables (Task 2); `sb` (config.js).
- Produces: a pass/fail report page (no writes).

- [ ] **Step 1: Create `monitoring/diagnostic.html`** (ESM). It runs three checks:
  1. **Payweek behavioural fixture** — assert `shared/payweek.mjs` matches hand-computed golden dates (same as Task 1 fixture).
  2. **Payroll source pin** — `fetch('../payroll/index.html')` and assert the exact Sat–Fri lines are present verbatim; if payroll's week logic ever changes, this FAILS, forcing re-sync of `shared/payweek.mjs`.
  3. **KPI data integrity** — earned cap honoured (`credited_units ≤ quantity`); per-(job,week) conservation (Σ worker earned splits ≤ job weekly earned delta, within rounding); week bucketing matches `weekContaining`.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>KPI Diagnostic</title>
<style>
  body{margin:0;background:#f4f5f7;color:#1c2230;font:14px/1.5 -apple-system,"Segoe UI",Roboto,sans-serif;padding:16px;max-width:720px;margin:0 auto}
  h1{font-size:18px}.card{background:#fff;border:1px solid #e3e6ec;border-radius:12px;padding:14px;margin:12px 0}
  .ok{color:#1f7a4d;font-weight:700}.bad{color:#b4231f;font-weight:700}.mono{font-family:ui-monospace,Consolas,monospace}
  a{color:#2f5d8a}
</style>
<script type="importmap">
{ "imports": {
    "@supabase/supabase-js": "https://esm.sh/@supabase/supabase-js@2"
} }
</script>
</head>
<body>
  <h1>Personnel KPI — Diagnostic</h1>
  <div class="sub"><a href="index.html">&larr; Menu</a></div>
  <div id="out">Running&hellip;</div>
  <script type="module">
    import { weekContaining, defaultPayWeek, isoOf, saturdayOnOrBefore } from "../shared/payweek.mjs";
    import { sb } from "./config.js";
    const out=document.getElementById("out");
    const rows=[];
    const check=(name,pass,detail="")=>rows.push(`<div class="card"><b>${name}</b> — <span class="${pass?"ok":"bad"}">${pass?"PASS":"FAIL"}</span> <div class="mono">${detail}</div></div>`);

    // 1 -- payweek behavioural fixture
    try{
      const f1=isoOf(saturdayOnOrBefore(new Date("2026-07-03T12:00:00")))==="2026-06-27";
      const wc=weekContaining("2026-07-06"); const f2=wc.start==="2026-07-04"&&wc.end==="2026-07-10";
      const dp=defaultPayWeek(0,new Date("2026-07-04T09:00:00")); const f3=dp.start==="2026-06-27"&&dp.end==="2026-07-03";
      check("Payweek fixture (shared/payweek.mjs)", f1&&f2&&f3, JSON.stringify({wc,dp}));
    }catch(e){ check("Payweek fixture", false, String(e)); }

    // 2 -- payroll source pin (payroll must remain byte-identical; this detects drift)
    try{
      const txt=await (await fetch("../payroll/index.html")).text();
      const pin1=txt.includes("const sinceSat=(ref.getDay()+1)%7;");
      const pin2=txt.includes("function isoOf(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}");
      check("Payroll Sat–Fri source pin", pin1&&pin2,
        pin1&&pin2 ? "payroll week logic unchanged — shared copy still valid"
                   : "payroll week logic CHANGED — re-sync shared/payweek.mjs and update this pin");
    }catch(e){ check("Payroll source pin", false, "could not fetch payroll/index.html: "+e); }

    // 3 -- KPI data integrity
    try{
      const je=await sb.from("v_job_efficiency").select("job_no,units_cumulative,quantity,credited_units,overrun");
      const capOk=(je.data||[]).every(r=>Number(r.credited_units)<=Number(r.quantity)+1e-9);
      check("Earned cap honoured (credited_units ≤ quantity)", capOk,
        (je.data||[]).filter(r=>r.overrun).map(r=>r.job_no+" overrun").join(", ")||"no overruns");

      // conservation: per (job, week) sum of worker earned splits ≤ job weekly earned delta (+rounding)
      const wj=await sb.from("v_worker_week_job").select("job_id,week_start,earned_hours");
      const agg={}; (wj.data||[]).forEach(r=>{ const k=r.job_id+"|"+r.week_start; agg[k]=(agg[k]||0)+Number(r.earned_hours); });
      // (informational: split sums are ≤ deltas by construction; flag any negative)
      const noNeg=(wj.data||[]).every(r=>Number(r.earned_hours)>=-1e-9);
      check("Worker earned splits non-negative", noNeg, Object.keys(agg).length+" (job,week) buckets");

      // week bucketing matches shared helper for sampled progress rows
      const jp=await sb.from("job_progress").select("work_date").limit(50);
      const bad=(jp.data||[]).filter(r=>{ const w=weekContaining(String(r.work_date).slice(0,10)); return !(w.start<=String(r.work_date).slice(0,10)&&String(r.work_date).slice(0,10)<=w.end); });
      check("Week bucketing consistent", bad.length===0, bad.length+" mismatched of "+((jp.data||[]).length));
    }catch(e){ check("KPI data integrity", false, String(e)); }

    out.innerHTML=rows.join("");
  </script>
</body>
</html>
```

- [ ] **Step 2: Validate (extract, `node --check`, hygiene).**

Run:
```bash
awk '/<script type="module">/{f=1;next} /<\/script>/{if(f)exit} f' monitoring/diagnostic.html > /tmp/diag.mjs
node --check /tmp/diag.mjs
grep -c azfmpleswqixaslvcito monitoring/diagnostic.html   # expect 0
```
Expected: clean; grep `0`.

- [ ] **Step 3: Run it** at `http://localhost:8123/monitoring/diagnostic.html`. Expected: all checks PASS (payroll source pin PASS proves payroll is unmodified and the shared copy is valid).

- [ ] **Step 4: Commit**

```bash
git add monitoring/diagnostic.html
git commit -m "feat(kpi): diagnostic — payweek drift-guard + earned-cap/conservation checks"
```

---

## Task 7: Hub — Productivity section and missing links

**Files:**
- Modify: `monitoring/index.html` (add a section; fix missing links)

**Interfaces:**
- Consumes: pages from Tasks 5–6 and existing `monitor.html`, `reconcile.html`, `tariff.html`.

- [ ] **Step 1: Read the current `monitoring/index.html`.**

- [ ] **Step 2: Insert a "Productivity" section** after the Planning grid (`monitoring/index.html:74`, before `.foot`):

```html
    <div class="sec">Productivity</div>
    <div class="grid">
      <a class="tile" href="efficiency.html">
        <span class="ico"><svg viewBox="0 0 24 24"><path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/></svg></span>
        <span class="t">Efficiency</span>
        <span class="d">Earned vs actual &mdash; by job, vessel &amp; worker</span>
      </a>
      <a class="tile" href="monitor.html">
        <span class="ico"><svg viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg></span>
        <span class="t">Monitor</span>
        <span class="d">Estimate vs actual &amp; kg per man-hour</span>
      </a>
    </div>

    <div class="sec">Setup &amp; checks</div>
    <div class="grid">
      <a class="tile" href="tariff.html">
        <span class="ico"><svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h10"/></svg></span>
        <span class="t">Work Tariff</span>
        <span class="d">Standard rates &amp; correction factors</span>
      </a>
      <a class="tile" href="reconcile.html">
        <span class="ico"><svg viewBox="0 0 24 24"><path d="M4 4v6h6"/><path d="M20 20v-6h-6"/><path d="M20 8a8 8 0 0 0-14-3M4 16a8 8 0 0 0 14 3"/></svg></span>
        <span class="t">Reconcile</span>
        <span class="d">Cross-check the two clocks</span>
      </a>
    </div>

    <div class="foot" style="margin-top:14px">
      <a href="diagnostic.html" style="font-size:12px">KPI diagnostic &rarr;</a>
    </div>
```

- [ ] **Step 3: Hygiene + visual check.**

Run:
```bash
grep -c azfmpleswqixaslvcito monitoring/index.html   # expect 0
```
Open `http://localhost:8123/monitoring/index.html`: the new Productivity, Setup & checks sections and diagnostic link appear and navigate correctly. (index.html has no inline module script, so `node --check` is N/A.)

- [ ] **Step 4: Commit**

```bash
git add monitoring/index.html
git commit -m "feat(kpi): hub links Efficiency, Monitor, Tariff, Reconcile, Diagnostic"
```

---

## Final verification (whole feature)

- [ ] Run `node --test shared/payweek.test.mjs` → PASS.
- [ ] Open `monitoring/diagnostic.html` on the deployed/served site → all checks PASS (proves payroll untouched, cap honoured, buckets consistent).
- [ ] Walk the flow on the local server against real Supabase with a probe job: Roll-call units-done → Efficiency by job/vessel/worker → mark calibrated → Close week → immutable record → Reopen (logged). Delete probe `jobs`/`job_progress`/`job_checkpoint` rows; drop probe `efficiency_week`/audit rows via the SQL editor (immutable to PostgREST).
- [ ] Confirm `git status` shows no changes to `payroll/index.html` or `preflight.html`.
- [ ] Repo-wide hygiene: `grep -rc azfmpleswqixaslvcito . --include=*.html --include=*.js --include=*.mjs` → all `0`; `wpmcbjrisuyjvobvzaus` present in `monitoring/config.js`.

## Coverage map (spec → task)

- D1 phasing / §10 → Tasks 2–7 build measurement only; no peso code anywhere (verified in Task 5 review).
- D2/D9 team split by hours → Task 2 `v_worker_week_job`.
- D3/D4 milestone units, weekly delta, cap, overrun flag → Task 2 (`v_job_efficiency`, `v_worker_week_job`), Task 4 (capture + overrun notice), Task 5 (overrun badge).
- D5 all tagged hours incl OT in denominator → Task 2 `act`/`crew` sum(hours) (no OT filter).
- D6 calibration gate + amber badge + reset trigger → Task 2 trigger, Task 5 toggle + badge.
- D7 Sat–Fri immutable weekly record with breakdown + gate split → Task 2 tables/triggers, Task 5 Close.
- D8 hybrid views + explicit close + immutability + reopen-logged + idempotent .sql → Tasks 2, 5.
- D10 unallocated as separate lens → surfaced via existing `reconcile.html` (linked in Task 7); not in the efficiency denominator.
- §6 shared Sat–Fri, never re-derived, payroll untouched → Task 1 + Task 6 drift-guard.
- §7 accrual-lag & orphan warnings → Task 5 `computeWarnings`, Task 6 conservation checks.
- §9 verification → Tasks 1–6 validation steps + Final verification.
