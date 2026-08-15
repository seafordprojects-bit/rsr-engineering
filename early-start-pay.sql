-- ═══════════════════════════════════════════════════════════════════════════════════════════
--  EARLY-START PAY — attendance_records.early_start_paid
--
--  STATUS: NOT APPLIED. Written for the owner to run in the Supabase SQL editor.
--  Rollback ships with it: early-start-pay-rollback.sql (standing rule, owner 2026-08-04).
--
--  WHAT THIS DOES
--  Adds ONE additive, nullable boolean to attendance_records. Nothing else. No index, no trigger,
--  no grant change, no backfill, no data touched.
--
--  WHY IT EXISTS
--  payroll/index.html prSessions() snaps any Time In at or before 08:10 forward to 08:00, so an
--  authorized 05:00 vessel start was paid from 08:00 and the first three hours vanished with no
--  flag. This column is the owner's explicit per-day authorization to pay from the actual Time In.
--  It is set ONLY by the passcode-gated Edit-times modal and read ONLY by prSessions().
--
--  WHY NULLABLE AND WHY NO DEFAULT
--  Every existing row stays NULL. The client reads the flag as `=== true`, so NULL, false and a
--  missing column all mean "no" — which is what makes every historical week recompute byte-for-byte
--  identically to today. A `default false` would rewrite all ~N thousand rows for no behavioural
--  gain and would make the rollback's "was this ever used?" check impossible to answer.
--
--  SAFE TO RUN BEFORE OR AFTER THE CODE DEPLOYS
--  The client probes for this column (recordsHaveEarlyStart()) and omits the field until it exists,
--  so an un-migrated database keeps working — the checkbox just does not persist.
-- ═══════════════════════════════════════════════════════════════════════════════════════════


-- ── STEP 0 — WHICH DATABASE AM I IN? ────────────────────────────────────────────────────────
-- TWO LIVE SUPABASE PROJECTS ARE OPEN IN ONE BROWSER WITH IDENTICAL EDITORS.
-- A wrong-project READ errors or misleads. A wrong-project WRITE SUCCEEDS SILENTLY — and this file
-- is a write. Demonstrated live 2026-08-03: a migration's STEP 0 went into the inventory project
-- through a leftover tab.
--
--   1. CLOSE THE OTHER PROJECT'S TAB FIRST. It is the only reliable guard.
--   2. Confirm from INSIDE this tab, never from its title.
--   3. The canary below errors immediately in the inventory project — that table does not exist
--      there. If STEP 0b errors, YOU ARE IN THE WRONG PROJECT. Stop.

-- 0a. Name the database.
select current_database();

-- 0b. CANARY — must return a row count. An error here means WRONG PROJECT.
select count(*) as attendance_rows_must_be_nonzero from public.attendance_records;

-- 0c. Prove the column is NOT there yet. Expect ZERO rows.
--     If this returns a row, the migration has already run — skip to STEP 2 and verify.
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema = 'public'
   and table_name   = 'attendance_records'
   and column_name  = 'early_start_paid';


-- ── STEP 1 — ADD THE COLUMN ─────────────────────────────────────────────────────────────────
-- Transaction-wrapped so a failure leaves nothing behind. `if not exists` makes a re-run a no-op
-- rather than an error, which matters because this file may be pasted twice by accident.
begin;

alter table public.attendance_records
  add column if not exists early_start_paid boolean;

comment on column public.attendance_records.early_start_paid is
  'Owner-authorized early start for THIS worker-day. When true, payroll credits the morning from
   the actual Time In instead of snapping forward to the 08:00 shift start (payroll/index.html
   prSessions, the mOpen anchor). NULL on every row written before 2026-08 and on every ordinary
   day since — the client reads it as === true, so NULL and false are identical in effect.
   Set ONLY by the passcode-gated Edit-times modal, which logs the change to attendance_edit_audit
   as a synthetic {"field":"early_start_paid"} entry. The kiosk never writes it.';

commit;


-- ── STEP 2 — VERIFY ─────────────────────────────────────────────────────────────────────────
-- Run these AFTER the commit. Do not trust "Success. No rows returned" — the Supabase editor
-- swallows RAISE NOTICE, so always re-query (owner rule; wrong four times in one day, 2026-07-28).

-- 2a. The column exists, is boolean, is nullable, has NO default. Expect exactly ONE row:
--       early_start_paid | boolean | YES | (null)
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema = 'public'
   and table_name   = 'attendance_records'
   and column_name  = 'early_start_paid';

-- 2b. NOTHING was backfilled. Expect true_rows = 0, false_rows = 0, and null_rows = total.
--     If true_rows or false_rows is non-zero on a fresh install, something wrote data — stop and
--     find out what before letting payroll run.
select count(*)                                          as total_rows,
       count(*) filter (where early_start_paid is true)   as true_rows,
       count(*) filter (where early_start_paid is false)  as false_rows,
       count(*) filter (where early_start_paid is null)   as null_rows
  from public.attendance_records;

-- 2c. Grants are UNCHANGED — this file alters none. attendance_records already carries whatever
--     anon holds; the new column simply inherits it. Listed so the reviewer can see it did not
--     grow a new permission surface.
select grantee, privilege_type
  from information_schema.role_table_grants
 where table_schema = 'public'
   and table_name   = 'attendance_records'
   and grantee in ('anon','authenticated')
 order by grantee, privilege_type;


-- ── STEP 3 — PERSISTENCE RE-CHECK (do this in a FRESH TAB) ──────────────────────────────────
-- A 2026-07-31 install verified live and its objects were later found in NEITHER project. Cause
-- still unknown. So: close this editor, open a new tab on THIS project, and run 2a again. If the
-- column is gone, the install did not persist — do not deploy the payroll build against it.
