-- Night Duty Phase 2 — attendance_records night flag.
-- RUN THIS ONCE in the Supabase SQL editor BEFORE deploying the night-shift build.
-- The kiosk sync upsert now sends night_shift on EVERY punch; without this column the upsert
-- would fail and NO punches (day or night) would sync. So this migration is a hard prerequisite.
-- Idempotent: the IF NOT EXISTS guard lets you re-run it harmlessly.

alter table attendance_records
  add column if not exists night_shift boolean not null default false;

-- Historical night days worked before this flag existed stay night_shift = false, so payroll
-- does NOT auto-recompute them (they'd still hard-flag / pay 0). Pay those via the bridge:
-- payroll/adjustments.html. Going forward, kiosk-armed night records carry night_shift = true
-- and payroll computes their hours + night differential natively.
