# Personnel KPI — Design Spec

**Date:** 2026-07-06
**Module:** `monitoring/`
**Status:** Design approved (pending written-spec review)
**Scope:** Phase 1 (efficiency measurement) fully specified here. Phase 2 (pay-incentive
formula) is a **separate** spec, written later — see "Phasing".

---

## 1. Goal

Measure worker productivity against the work tariff, to eventually drive pay incentives.

- **earned hours** = units completed × tariff standard man-hours/unit × correction factor
- **efficiency** = earned hours ÷ actual man-hours

Reported **per job order**, **per vessel**, and **per worker per pay week**. Phase 1 produces
and stores these numbers only — **no peso amounts, no bonus formula, anywhere**. Phase 2
turns the accumulated efficiency data into pay, once the data is trusted and factors calibrated.

## 2. What already exists (no rebuild)

The `monitoring/` module already implements most of the concept under different names:

- `jobs.est_manhours` = `quantity × rate_used × correction_factor` — this **is** earned hours
  at full completion. `rate_used` and `correction_factor` are snapshotted onto the job at creation.
- `job_checkpoint` (job_id, employee_code, work_date, checkpoint, hours=2, is_ot) — actual
  hours, already captured **per worker**, one exclusive job per 2-hour checkpoint block.
- `job_monitor` view — est vs actual, kg/man-hour, pace (per job).
- `labor_reconcile` view — per worker/day kiosk_hours vs job_hours vs unallocated_hours.
- `work_tariff` (manhours_per_unit) and `correction_factor` (6 groups) — the tariff and the
  Butler factors. **Butler factors are all placeholder 1.0 today.**

Phase 1 **adds** progress capture, three efficiency views, a stored weekly record, a calibration
gate, and read-only display surfaces. It does not replace existing pages.

## 3. Decisions (resolved in brainstorming)

| # | Decision |
|---|----------|
| D1 | Ship as **phased-in-one-spec**: measurement (phase 1) now; pay engine (phase 2) later on the same data model. |
| D2 | Credit is **team/job-based**. Everyone on a job-day shares that job-day's efficiency. Individual differentiation comes from a worker's **mix of jobs** over the period, not from splitting output within a job. (Foreman-allocated shares are a possible later refinement — **not** in v1.) |
| D3 | Earned hours recognized via **milestone/unit check-ins**: cumulative units-done-to-date reported per job; earned-to-date = `LEAST(units_cumulative, quantity) × rate_used × correction_factor`. |
| D4 | Progress captured **daily on Roll-call**, one cumulative field per active job. Weekly earned = (week's last cumulative − prior week's last cumulative) × rate × factor. Missed days self-correct on the next entry. **Credited units capped at estimated quantity**; overruns **flag the job for estimate review** and pay **no** incentive on overrun units until admin approves. |
| D5 | Actual-hours denominator = **payroll-effective `worked_ms`** (post-edit, from `attendance_records`; regular + OT equally), **attributed to jobs by roll-call block share** — NOT the roll-call 2h blocks themselves and NOT raw punches. The KPI reads the `worked_ms` payroll persists (payroll/index.html:1016); it must not re-implement payroll's `prSessions`. Per-worker-day: sum of attributed job hours = that day's paid hours. A cost view (hours × actual rates incl. OT premium) may be added later — out of the worker productivity score. |
| D6 | **Calibration pay-gate**: efficiency displays for all jobs always. The phase-2 pay engine includes only jobs where `calibrated = true`, set **per job by admin** after real Butler values are entered — **never auto-set**. Uncalibrated jobs show an amber **"factors not calibrated — incentive pending"** badge (mirrors payroll amber/red flag convention). Changing a job's estimate inputs after calibration **resets `calibrated` to false** pending re-approval. |
| D7 | Phase-1 output contract: per worker, per **Sat–Fri** pay week (same anchor as payroll), a **stored, immutable** efficiency record with its full input breakdown (earned by job, actual by job, calibrated-gate split). **No peso amounts, no provisional formula on any screen.** Phase-2 spec is written only after several live pay weeks exist and Butler factors are calibrated, so thresholds derive from observed distributions, not guesses. |
| D8 | Architecture = **hybrid**. Efficiency math lives in **Postgres views** (ISO date normalization done once, inside the view SQL), read via PostgREST like tables. **"Close week"** is an explicit **admin button** (Sat–Fri, same anchor as payroll) that inserts **immutable** rows into `efficiency_week`. Closed weeks are **never recomputed** even if tariff rates or Butler factors change later. **Re-opening** a closed week requires an explicit admin action and is **logged**. View/table SQL is delivered as **one idempotent `.sql` file** (`CREATE OR REPLACE` / `IF NOT EXISTS`) runnable in the Supabase SQL editor. |
| D9 | A day's earned delta on a job is split among that day's crew **proportional to hours each logged on that job that day** → everyone on the job-day lands at the same efficiency (team principle preserved under unequal hours). Per-job hours come from roll-call tagging; because each 2-hour checkpoint is exclusive to one job, a worker's per-job hours already sum to their tagged block-hours with **no double-counting**. |
| D10 | **Clocked-but-untagged (unallocated) hours** are surfaced as a **separate utilization lens** (paid vs tagged), **never** inside the productivity denominator. |

## 4. Data model

### 4.1 New base tables

```
job_progress
  id            uuid pk default gen_random_uuid()
  job_id        uuid not null references jobs(id)   -- jobs.id confirmed uuid
  work_date     date not null            -- clean YYYY-MM-DD from roll-call
  units_cumulative numeric not null       -- units done TO DATE (not delta)
  reported_by   text
  created_at    timestamptz default now()
  unique (job_id, work_date)              -- one reading per job per day; upsert
```

```
efficiency_week                            -- immutable weekly snapshot per worker
  id            uuid pk default gen_random_uuid()
  employee_code text not null              -- employees.id (uuid), the KPI worker key
  week_start    date not null              -- Saturday
  week_end      date not null              -- Friday
  earned_hours  numeric not null
  actual_hours  numeric not null
  efficiency    numeric                    -- earned/actual, null when actual=0
  calibrated_earned_hours   numeric not null   -- earned from calibrated jobs only
  uncalibrated_earned_hours numeric not null
  breakdown     jsonb not null             -- [{job_id, job_no, vessel, earned, actual, calibrated}]
  close_version integer not null default 1
  closed_by     text
  closed_at     timestamptz default now()
  finalized_ack_by    text                 -- admin who affirmed payroll finalized (D5 ordering guard)
  finalized_ack_at    timestamptz
  unresolved_at_close integer              -- payroll-health unresolved count at close
  unique (employee_code, week_start, close_version)
```

```
efficiency_week_audit                      -- reopen / re-close log
  id            uuid pk default gen_random_uuid()
  week_start    date not null
  action        text not null              -- 'close' | 'reopen'
  actor         text
  note          text
  at            timestamptz default now()
```

### 4.2 Columns added to `jobs`

```
calibrated     boolean not null default false
calibrated_by  text
calibrated_at  timestamptz
```

Reset rule (D6): any update to `jobs.correction_factor`, `jobs.rate_used`, or `jobs.quantity`
sets `calibrated=false`, clears `calibrated_by/at`. Implemented via a `BEFORE UPDATE` trigger in
the SQL file (idempotent `CREATE OR REPLACE FUNCTION` + `DROP/CREATE TRIGGER`).

## 5. Views (one idempotent `.sql`, ISO-normalized inside)

### 5.0 `v_attendance_day` and `v_job_worker_day` — the actual-hours source (D5)
- `v_attendance_day`: per worker (`employees.id`) per ISO day, `paid_hours = worked_ms/3.6e6`,
  plus `is_incomplete`, `status`. Bridges keys: `attendance_records.employee_code = employees.code`;
  the KPI worker key is `employees.id`. **`attendance_records.date` is mixed-format TEXT → normalized
  to a real date inside this view** (the landmine now applies here).
- `v_job_worker_day`: per (job, worker, day), `actual_hours = paid_hours × blocks_on_job / total_blocks`
  (blocks from `job_checkpoint`). Sum over a worker-day = `paid_hours`. Tagged-but-no-attendance → 0.

### 5.1 `v_job_efficiency` — per job
- `units_cumulative` = latest `job_progress.units_cumulative` for the job (max work_date).
- `credited_units` = `LEAST(units_cumulative, quantity)`.
- `overrun` = `units_cumulative > quantity` (boolean flag → estimate review, D4).
- `earned_to_date` = `credited_units × rate_used × correction_factor`.
- `actual_to_date` = `Σ v_job_worker_day.actual_hours` for the job (payroll-effective, incl. OT — D5).
- `efficiency` = `earned_to_date / NULLIF(actual_to_date,0)`.
- carries `calibrated`, `status`, `vessel`, `job_no`, `site`.

### 5.2 `v_vessel_efficiency` — per vessel roll-up
- Group `v_job_efficiency` by `vessel`: `Σ earned_to_date`, `Σ actual_to_date`,
  `efficiency`, job count, `Σ earned where calibrated` (calibrated share).

### 5.3 `v_worker_week_job` / `v_worker_week_efficiency` — per worker, per Sat–Fri week (live, any week)
Computed as:
1. **Per (job, day) earned delta**: order `job_progress` by `work_date` within each job;
   `delta = (LEAST(cum_today,qty) − LEAST(cum_prev,qty)) × rate_used × correction_factor`,
   floored at 0. First reading's `cum_prev = 0`.
2. **Attributed actual per (job, day, worker)**: from `v_job_worker_day` (D5 — payroll-effective).
3. **Split** (D9): each worker's earned for that job-day = `delta × (worker_actual / crew_actual)`,
   where actual = attributed payroll-effective hours. Orphan case (`delta>0` but `crew_actual=0`)
   → earned attributed to **no worker**, flagged (§7).
4. **Aggregate to the Sat–Fri week** (`work_date` in `[week_start, week_end]`):
   `earned_hours = Σ splits`, `actual_hours = Σ attributed worker hours`,
   `efficiency = earned/NULLIF(actual,0)`, plus calibrated/uncalibrated earned split and a
   `breakdown` array. Week bucket via `(dow+1)%7` in SQL, identical to the shared JS helper (§6).

### 5.4 `v_week_payroll_health` — Close-week ordering guard (D5 / §7)
- Per Sat–Fri week: `unresolved` = count of `v_attendance_day` rows that are `is_incomplete`
  OR a zero-hour present-day anomaly. Consumed by Close-week to warn + gate the admin ack.

All views normalize mixed-format text dates to ISO **inside** the SQL — `attendance_records.date`
specifically (the KPI now reads it), plus defensive casts on `job_checkpoint.work_date`.

## 6. Week boundary — shared, never re-derived

Pay week = **Saturday → Friday**, matching `payroll/index.html:636-643`
(`sinceSat=(getDay()+1)%7`; reference-from-yesterday so payday-Saturday shows the week that
just ended). `shared/payweek.mjs` is a **verbatim transcription** of that logic; `payroll/index.html`
stays **byte-identical** this workstream (no bridge, no import added), and `monitoring/diagnostic.html`
carries a **concrete drift-guard** (behavioural fixture + a source-pin on payroll's exact lines) so the
two cannot silently diverge. Payroll convergence onto the shared file is backlog. The Schedule page's
Mon–Sun `mondayOf` is a look-ahead concern and is **not** used here.

## 7. Boundary effects & guards (inherent to milestone reporting)

- **Accrual lag**: a job worked all week but reported the following Monday shows
  hours-but-no-earned that week, earned the next. Mitigation: the **Close-week screen flags any
  job with tagged hours in the window but no `job_progress` reading in the window**, prompting a
  Friday reading before closing.
- **Orphan earned**: units reported on a day with no crew tagged → flagged on Close-week and on
  `v_job_efficiency` (earned present, not attributable to any worker).
- **Zero-earned crew day**: crew tagged, no progress that day → their hours count in actual, earned
  lands when units are reported. Self-corrects over the week (D4).
- **Payroll-ordering guard (D5)**: because actual hours = post-edit `worked_ms`, closing a week before
  its payroll is finalized would freeze wrong hours. Close-week reads `v_week_payroll_health`, **warns**
  on unresolved rows, and **requires an admin ack** ("payroll for this week is finalized") recorded on
  the `efficiency_week` rows (`finalized_ack_by/at`, `unresolved_at_close`). No auto-detectable finalized
  flag exists; a real marker is backlog.
- **Unallocated (D10)**: paid hours on a day with no roll-call tag are not in any job denominator —
  surfaced via `reconcile.html`, never silently dropped.
- **Conservation invariants** (verification, §9): per (job, week), `Σ worker earned splits + orphan
  earned = job weekly earned delta`; and per (worker, day), `Σ attributed job hours = payroll paid hours`.

## 8. Surfaces (phase 1 — no pesos)

1. **`monitoring/roll-call.html`** — add a per-job **"units done to date"** numeric field (upsert
   into `job_progress` on the day's entry). One field per active job. Shows cumulative + est qty.
2. **`monitoring/efficiency.html` (new)** — tabs:
   - *By job* (`v_job_efficiency`): efficiency %, earned vs actual, overrun flag, calibrated badge.
   - *By vessel* (`v_vessel_efficiency`).
   - *By worker — week* (`v_worker_week_efficiency` for a chosen Sat–Fri week): efficiency, earned,
     actual, per-job breakdown, calibrated split, **unallocated/utilization lens** (D10).
   - **Admin: Close week** — Sat–Fri picker, review, warnings (§7), **Close** → insert immutable
     `efficiency_week` rows; **Reopen** (logged to `efficiency_week_audit`). Admin-gated.
3. **Calibration control** — admin toggles `jobs.calibrated` (per job) after entering real Butler
   values. Lives on `efficiency.html` (By-job tab) or a small admin panel; amber badge when false.
4. **`monitoring/index.html` (hub)** — add a **Productivity** section and fix the currently-missing
   links: Monitor, Efficiency (new), Reconcile, Tariff.

## 9. Verification (before shipping)

- Extract the largest inline `<script>` from each new/edited HTML, `node --check` as ES module.
- Hygiene grep: `wpmcbjrisuyjvobvzaus` present, `azfmpleswqixaslvcito` absent.
- Data checks (extend `payroll/diagnostic.html` or a monitoring diagnostic):
  - `earned_to_date` never exceeds `quantity × rate × factor` (cap honored).
  - Conservation invariant (§7) holds per (job, week).
  - No `efficiency_week` row mutates after `closed_at` except via a logged reopen.
- Playwright end-to-end: report progress on Roll-call → see per-job/vessel/worker efficiency →
  Close a week → confirm immutable record + breakdown.

## 10. Phasing

**Phase 1 (this spec, build now):** tables, trigger, three views (one `.sql`), Roll-call units
field, `efficiency.html` display + Close/Reopen, calibration toggle, hub links, verification.
Zero peso figures.

**Phase 2 (separate spec, later):** the efficiency → pay formula. Written only after several live
Sat–Fri weeks of `efficiency_week` data exist **and** Butler factors are calibrated, so thresholds
come from observed distributions. Reads the frozen `efficiency_week` contract; does not change it.

## 11. Out of scope (v1)

- Any peso/bonus computation or display.
- Foreman-allocated within-job shares (D2 — later refinement).
- Deriving/estimating the real Butler correction factor values (an estimating exercise; the system
  only stores them and gates pay on `calibrated`).
- Job-costing cost view with OT premium (D5 — later, separate from the productivity score).
