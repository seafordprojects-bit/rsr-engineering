# Close Job Order — Design Spec

**Date:** 2026-07-07
**Status:** approved design → implementation plan next
**Module:** monitoring (personnel-KPI). Vanilla JS + Preact/htm via CDN, no build. Supabase `wpmcbjrisuyjvobvzaus` (RLS off, PostgREST).

## Context & goal

Jobs are never formally "closed" today — `jobs.status` is free text (`open`/`ongoing`/`done`), never transitioned in code, and there is no finalize/lock anywhere. This feature adds an explicit, authorized, two-stage **Close job order** with a required **actual-installed-quantity** encoding, so a finished job's final credited units, earned hours, and incentive eligibility are frozen and auditable. This is **Phase 1**: it ends at a job being **"approved."** Actual peso incentive amounts / vessel-level settlement are **Phase 2 (out of scope)**.

## The two-stage flow

**Stage 1 — Operational close (coordinator).**
- Coordinator confirms two things: work **physically complete**, and **testing/inspection done** (two checkboxes).
- Coordinator enters the **actual-installed quantity** (final measured figure, in the job's unit).
- Requires the **coordinator PIN** (existing `settings.coordinator_pin`).
- Effect: job → **"closed — pending incentive approval"**, freezes, drops off roll-call/progress screens.

**Stage 2 — Incentive approval (owner only).**
- Owner reviews final quantity, discrepancy note, overrun flag, earned/actual/efficiency.
- Requires the **owner PIN** (NEW `settings.owner_pin`, unset by default). If no owner PIN exists yet, the first approval **forces the owner to create one** (server-side) before proceeding — see Authorization model.
- Effect: job → **"approved"**. Only approved jobs will feed the Phase-2 vessel-level settlement.
- **Gate:** Approve is disabled unless the job is **calibrated**. A **no-target** job (`quantity` null) can be operationally closed but can **never** be approved (never payable).

**Reopen (owner only, any stage).** Owner PIN + a required reason. Un-freezes the job (accepts tags/progress again). The immutable snapshot stays; re-closing bumps a version.

**Authorization model.** No login system exists; gates are client-side PINs read from the `settings` table (same pattern as the coordinator app), and the actor is a typed name recorded in the audit. This is a **workflow lock, not hacker-proof security** (RLS is off) — consistent with the rest of the app. Stage 1 = coordinator PIN; Stage 2 + reopen = owner PIN. The new `settings.owner_pin` starts **UNSET — no default of any kind.** The PIN is checked **only against the server-side stored value** (never a client default, never localStorage). Until it is set, **Stage 2 approval is blocked**: the first approval attempt (or the admin dashboard setter) forces the owner to choose a PIN before any approval can happen. **Setting or changing the owner PIN is logged** to a security-config audit table (event + actor + timestamp — never the PIN value itself).

## Settlement mechanics

- **Actual-installed supersedes the last roll-call cumulative** by writing a **final `job_progress` row** (max `work_date`) via the existing upsert. Every settlement view already keys off the latest `work_date`, so earned/efficiency recompute with no view changes.
- **Do NOT write `jobs.quantity`** — the `jobs_reset_calibration` trigger fires on `quantity`/`rate_used`/`correction_factor` changes and would silently un-calibrate the job. The target is untouched; only the progress (cumulative) is superseded.
- **Cap & overrun already exist** in `v_job_efficiency`: `credited_units = least(units_cumulative, quantity)`, `overrun = units_cumulative > quantity`, `earned = credited_units × rate_used × correction_factor`. Installing beyond target earns nothing on the overage; overrun is flagged and surfaced to the owner at Stage 2 (no auto-recalc — existing "overrun · estimate review" behavior).
- **Earned/actual are frozen** into the snapshot at operational close (values copied from `v_job_efficiency`), so later data/view changes cannot alter a closed job's record.

## Discrepancy note (always shown, no threshold)

Computed at close from `actual_installed − last_rollcall_units` (the latest `job_progress` cumulative *before* the close write):
- Exact match → **"matches last report"**.
- Otherwise → delta with size and direction, e.g. **"−12 kg vs last roll-call report (−5.7%)"** (`pct = delta / last_rollcall_units × 100`; percent omitted when the base is 0/null).
- Informational, stored on the snapshot, **never blocks**.

## Freeze behavior

On operational close, set `jobs.status = 'closed'` (new value). Consequences:
- `roll-call.html` and `assign.html` exclude `status in ('done','closed')` from taggable/active lists (today they exclude only `'done'`).
- **DB backstop:** a trigger rejects `job_progress` / `job_checkpoint` inserts for a job whose `status = 'closed'`. Sequence at close: write the final `job_progress` row *first* → write snapshot + audit → *then* flip `status='closed'` (so the trigger blocks only subsequent writes).
- Reopen sets `jobs.status = 'ongoing'` and logs the reopen; writes are accepted again.

## Closed-week warning (non-blocking)

At close, if the final actual-installed changes earned hours that fall in an **already-closed** payroll week (frozen `efficiency_week`), show an informational note naming the affected week(s): the frozen week will not recalculate; the owner can choose to reopen that week separately. Never blocks the close. (Client computes the weeks the job's checkpoints span, checks each via the existing `isClosed(week)` audit read, and warns only when actual differs from the last cumulative.)

## Data model (append-only, mirrors Close-week)

Add to `monitoring/sql/personnel-kpi.sql` (owner re-runs it):

```sql
-- One immutable snapshot per operational-close version of a job.
create table if not exists job_close (
  id                  uuid primary key default gen_random_uuid(),
  job_id              uuid not null references jobs(id),
  close_version       integer not null default 1,
  actual_installed    numeric not null,           -- coordinator's final measured quantity (job unit)
  last_rollcall_units numeric,                     -- latest job_progress cumulative BEFORE this close
  target_quantity     numeric,                     -- jobs.quantity at close (null = no target)
  credited_units      numeric,                     -- least(actual_installed, target); null if no target
  earned_hours        numeric,                     -- frozen from v_job_efficiency at close
  actual_hours        numeric,
  efficiency          numeric,
  overrun             boolean not null default false,   -- actual_installed > target
  discrepancy_delta   numeric,                     -- actual_installed - last_rollcall_units
  discrepancy_pct     numeric,                     -- delta / last_rollcall_units * 100 (null if base 0/null)
  calibrated_at_close boolean not null default false,
  closed_by           text,                        -- coordinator (typed name)
  closed_at           timestamptz not null default now(),
  unique (job_id, close_version)
);

-- Action log; current status = latest action for the job.
create table if not exists job_close_audit (
  id      uuid primary key default gen_random_uuid(),
  job_id  uuid not null references jobs(id),
  action  text not null,        -- 'operational_close' | 'incentive_approve' | 'reopen'
  version integer not null,
  actor   text,
  note    text,
  at      timestamptz not null default now()
);

-- Security-config audit (append-only): logs owner-PIN set/change events. NEVER stores the PIN value.
create table if not exists settings_audit (
  id     uuid primary key default gen_random_uuid(),
  key    text not null,          -- e.g. 'owner_pin'
  action text not null,          -- 'set' | 'change'
  actor  text,
  at     timestamptz not null default now()
);

-- Reuse the existing block_mutation(): job_close, job_close_audit, and settings_audit are append-only.
-- (create triggers trg_jobclose_immutable / trg_jobcloseaudit_immutable / trg_settingsaudit_immutable
--  before update or delete)
-- owner_pin lives in the existing `settings` table; there is NO row/value until the owner sets one.

-- Latest close-status per job, for badges.
create or replace view v_job_close_status as
select distinct on (job_id) job_id, action, version, actor, at
from job_close_audit order by job_id, at desc;

-- Backstop: block progress/checkpoint writes to a closed job.
-- (trigger function raises when the target job's status = 'closed')
```

**Status derivation:** latest `job_close_audit.action` → `operational_close` = "pending approval", `incentive_approve` = "approved", `reopen` (or none) = open. Mirrors `efficiency.html:isClosed()`.

## UI

**`monitoring/efficiency.html` — By-job view (primary home, beside the existing calibrate button):**
- Status badge per job: *pending approval* / *approved* (from `v_job_close_status`).
- **Close job order (coordinator)** button → close form: shows **target · last roll-call cumulative · actual-installed (input)**; live discrepancy line; overrun indicator; closed-week warning; two confirm checkboxes; coordinator-PIN field; Confirm.
- **Approve for incentive (owner)** button when pending + calibrated (else "calibrate first", disabled) → owner-PIN prompt.
- **Reopen (owner)** button on closed/approved jobs → owner-PIN + reason.
- All writes go through helpers in `config.js` (`closeJobOrder`, `approveJob`, `reopenJob`, `loadJobCloseStatus`, PIN check).

**`monitoring/roll-call.html`, `monitoring/assign.html`:** exclude `status in ('done','closed')`.

**`home.js`:** add a **"Job Monitoring"** admin-dashboard tile (`href:'../monitoring/'`, Operations pattern) and an **owner-PIN setter** in the admin PIN area (mirrors `saveCoordPin` but with **no default** — the field starts empty and must be chosen; writes `settings.owner_pin` and appends a `settings_audit` `set`/`change` row). Approval stays blocked until a PIN exists.

**Owner-PIN check (shared helper):** always reads `settings.owner_pin` fresh from the server at check time; returns "not set" when absent (triggering the forced-setup path), never falls back to any default or cached value.

**Optional (consistency):** show closed/approved badge on `monitor.html` / `job-order.html` rows.

## Landmines / interactions (must respect)

- `jobs_reset_calibration` trigger — never write `jobs.quantity`/`rate_used`/`correction_factor` in the close flow.
- `efficiency_week` is immutable — a job closed after a week is frozen won't change that week (hence the closed-week warning).
- `job_checkpoint`/`job_assignment.employee_code` hold `employees.id` as **text** (uuid-as-text); `job_progress.work_date` is a real `date`.
- `next_job_no` is a Supabase-only RPC (not in repo) — not touched here (no new job numbers).
- Base `jobs`/`job_checkpoint` tables are not in repo SQL (created in Supabase); this feature only adds new tables + reads/writes existing columns.

## Verification

- SQL applied by owner; then `node --check` the largest inline script of every edited HTML (efficiency, roll-call, assign, home) + hygiene grep (`wpmcbjrisuyjvobvzaus` present in config, `azfmpleswqixaslvcito` absent; literal `&` in htm).
- End-to-end via Playwright on a **TEST-prefixed job** (not a live/frozen one): operational close → pending badge + frozen snapshot + roll-call exclusion + backstop rejects further progress; approve (blocked until calibrated) → approved; reopen → re-accepts writes, version bumps. Verify `job_close` snapshot + `job_close_audit` rows + discrepancy math.
- Interactive pages → **pause for the owner's localhost walkthrough before pushing to `main`** (deploy rule). SQL/view changes may be handed to the owner to run directly.

## Files touched

- `monitoring/sql/personnel-kpi.sql` — new tables (`job_close`, `job_close_audit`, `settings_audit`), append-only triggers, `v_job_close_status`, backstop trigger.
- `monitoring/efficiency.html` — close form, badges, approve/reopen, PIN gates, closed-week warning.
- `monitoring/config.js` — close/approve/reopen/status helpers + PIN check.
- `monitoring/roll-call.html`, `monitoring/assign.html` — exclude closed jobs.
- `home.js` — Job Monitoring tile + owner-PIN setter.
- (optional) `monitoring/monitor.html`, `monitoring/job-order.html` — status badge.
