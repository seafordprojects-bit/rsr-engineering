# Provisional Per-Worker Incentive — Design Spec (LOCKED 2026-07-08)

> Phase-2 pay-incentive, **display-only / non-payable** first cut. Shows each worker's
> provisional incentive on the admin Job Monitoring tab so the owner can watch the numbers
> accumulate before committing to pay. **Nothing flows to payroll until the owner flips the
> payable gate on, after Butler calibration.** Interactive/pay-adjacent → walkthrough before push.

## Owner's locked decisions
- **Shape A — flat rate** (₱ per hour saved), same for everyone.
- **Compute + display** per-worker incentive on the admin tab, marked **"provisional — not payable yet."**
- **Rate = an owner-gated, editable setting** (change requires the owner passcode; change is audited).
- **Gated from payroll:** a separate payable flag, default OFF. Nothing reaches payroll until the owner
  flips it on (post-calibration). This task builds the display + setting + gate ONLY — no payroll wiring.

## Formula (per worker, per Sat–Fri week)
```
incentive = Σ over jobs that are (calibrated AND incentive-approved) of
              max(0, worker_earned_hours_on_job − worker_actual_hours_on_job) × RATE
```
- `worker_earned_hours` / `worker_actual_hours` already exist per (worker, job, week) via
  `v_worker_week_job` → `v_worker_week_efficiency` (D9 splits each job-day's earned hours across the
  crew by hours worked; individual differences come from job mix per D2). No new split needed.
- **Job gate:** only jobs with `calibrated = true` AND latest `v_job_close_status.action =
  'incentive_approve'` count. Overrun units already earn nothing (credited units capped at target).
- **Floor per job** at 0 (an inefficient job contributes nothing; it never subtracts from another job).
- `RATE` read live from `settings.incentive_rate_per_hour`, so editing the setting re-prices instantly.

## Settings (owner runs the SQL)
- `incentive_rate_per_hour` — numeric text, flat ₱/hour-saved. **Seed = `50`** (owner's chosen starting
  placeholder; fully editable, non-payable). Owner-gated + audited on change (settings_audit, like owner_pin).
- `incentive_payable` — 'false' default. The payable gate. Owner-gated to flip.

## Surfaces
- **Display:** By-worker tab of `monitoring/efficiency.html` (the embedded admin view) gains a per-worker
  provisional incentive amount + a **"provisional — not payable yet"** badge while `incentive_payable`
  is false.
- **Rate + gate editor:** owner-passcode-gated control (co-located in the By-worker view; prompts for the
  owner passcode, writes the setting + a `settings_audit` row). Reuses the server-side owner-PIN check.

## Explicit non-goals (later task)
- No payroll integration. When the owner eventually flips `incentive_payable` on, wiring the amount into
  payroll is a **separate** task with its own walkthrough.
- Rate stays a single admin-editable setting so re-tuning after more calibrated weeks is trivial.
