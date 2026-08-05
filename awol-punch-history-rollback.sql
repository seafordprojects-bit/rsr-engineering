-- ═══════════════════════════════════════════════════════════════════════════════════════════
--  ROLLBACK for awol-punch-history.sql  (Defect 1 — server-side punch history)
--  Removes public.awol_punch_days(int) and nothing else.
--  Pairs 1:1 with awol-punch-history.sql — if that file changes, change this one with it.
-- ═══════════════════════════════════════════════════════════════════════════════════════════
--
-- ═══ WHY THIS ONE HAS NO BACKUP STEP ═══
-- The standing rule (owner, 2026-08-04) is that a rollback snapshots into bak_ tables before
-- dropping anything that can hold real work, and refuses the drop when the snapshot is missing.
-- That step is ABSENT HERE ON PURPOSE, not by oversight: awol_punch_days() is a `stable`,
-- read-only SQL function. It owns no table, no column, no sequence and no row. It computes its
-- answer from attendance_records and employees every time it is called. There is nothing to copy,
-- and re-running awol-punch-history.sql restores it byte-for-byte.
-- If a future revision of that migration ever creates a TABLE, this file gets a STEP 2 snapshot.
--
--
-- ▓▓▓ READ THIS BEFORE YOU RUN IT — WHAT DROPPING THIS FUNCTION ACTUALLY DOES ▓▓▓
--
-- It turns AWOL detection OFF. It does NOT put the old behaviour back.
--
-- Verified in the kiosk code on this branch (awolLoadPunchHistory, kiosk/index.html):
--   const {data,error} = await sbClient.rpc('awol_punch_days',{p_days:31});
--   if(error) throw error;                                  <- a missing function lands HERE
--   ...
--   catch(e){ awolPunched = null;  ... }                    <- sweep abandoned
-- With the function gone, PostgREST answers "function does not exist", the fetch throws, the map
-- is left null, and the boot sweep is ABANDONED ENTIRELY: no suspensions, no group alerts, no
-- retry push. The tablet shows the skipped-detection notice naming punch history as the authority
-- it could not read. That is the FAIL-OPEN direction and it is deliberate — see the standing rule
-- that attendance gates fail open, a man always gets to punch and the owner gets TOLD.
--
-- So the two live states are:
--   function PRESENT  -> detection runs on real server-side punch history (the fix)
--   function ABSENT   -> detection does not run at all, and says so on screen
-- Neither state re-enables the defect. The buggy path — judging absences from the tablet's
-- 10-day-pruned localStorage `records` map — was DELETED from kiosk/index.html in commit 284bf8d
-- and cannot come back by dropping a function. If you want the old behaviour you must revert the
-- kiosk change too, and you almost certainly do not: that path invented absences on exactly the
-- long chains that end in a suspension letter (RSR 0015: 6 -> 10 overnight, two of the added days
-- demonstrably worked).
--
-- CONSEQUENCE TO ACCEPT BEFORE RUNNING: while the function is absent, nobody is detected. A real
-- AWOL case starting the day you run this will not be picked up until it is restored. Detection
-- being off is safe for the workers and visible to you; it is not free.
--
--
-- ═══ RUNNING THIS — the standing rules (CLAUDE.md, owner 2026-08-03) ═══
--   1. CLOSE the azfmpleswqixaslvcito (inventory) tab. It is the only reliable guard.
--   2. Run STEP 0 ALONE, first, and read the answer before running anything else.
--   3. STEP 2 is a write (a drop) and ends in a schema reload. A wrong-project write succeeds
--      silently — though in this case the drop would simply find nothing there.


-- ── STEP 0 — PROJECT CANARY.  ▓▓▓ RUN THIS BLOCK ALONE, NOTHING ELSE ▓▓▓ ────────────────────
select current_database();
-- EXPECT: postgres  (read the NEXT line, not this one — both projects answer 'postgres')

select count(*) as attendance_rows_must_be_nonzero from public.attendance_records;
-- EXPECT: ~1039. This statement ERRORS in the OTHER live project (the shipyard-inventory backend)
-- because the table does not exist there. If it errors, you are in the WRONG PROJECT — stop.


-- ── STEP 1 — WHAT IS THERE NOW, before you remove it ────────────────────────────────────────
-- Confirms you are dropping the object you think you are dropping, and that it is the only one
-- by that name. `create or replace` cannot make a duplicate, but an overload with a different
-- argument list is a different function and the drop below would MISS it.
select p.oid::regprocedure as signature, p.prosecdef as security_definer, p.provolatile
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'awol_punch_days';
-- EXPECT exactly ONE row: awol_punch_days(integer) | true | s
-- MORE THAN ONE ROW = there is an overload this file does not know about. STOP and read it;
-- dropping only (int) would leave the other one live and the rollback would be a half-undo.


-- ── STEP 2 — the drop ───────────────────────────────────────────────────────────────────────
-- Revoke first. If the drop is rolled back or fails, the function must not be left reachable by
-- anon in a half-undone state. `if exists` on both, so re-running this file is harmless.
revoke execute on function public.awol_punch_days(int) from anon, authenticated;
drop function if exists public.awol_punch_days(int);

notify pgrst, 'reload schema';


-- ── STEP 3 — VERIFY ─────────────────────────────────────────────────────────────────────────

-- 3a. EXPECT 0 rows. The function is gone.
select p.oid::regprocedure as still_here
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'awol_punch_days';

-- 3b. Nothing else may have moved. This rollback touches ONE function; every table it read from
--     must be untouched, and the sibling authority the sweep also reads must still answer.
select (select count(*) from public.attendance_records) as attendance_rows_unchanged,
       (select count(*) from public.employees)          as employee_rows_unchanged,
       (select count(*) from public.awol_skip_list())   as skip_list_still_works;

-- 3c. Same guard as the migration's STEP 2d, and here for the same reason (2026-08-05).
--     An earlier version of that step probed by INSERTING 'ZZ PUNCHPROBE' rows into
--     attendance_records inside begin/rollback. It failed on a NOT NULL column so nothing landed —
--     but a rollback is the moment to confirm that, not assume it. A stray probe row left in
--     attendance_records is a FABRICATED ABSENCE sitting in the detector's input, and it would be
--     read as fact by the next sweep on a date that is already disputed.
--     Matched on the normalised code so a spacing variant cannot hide.
select count(*) as stray_probe_rows_must_be_0
  from public.attendance_records
 where upper(regexp_replace(employee_code, '[^A-Za-z0-9]', '', 'g')) like 'ZZ%';
-- EXPECT: 0. Anything else: read the rows and remove them deliberately. Do not leave them for the
-- next sweep to find.
--
-- ▓▓▓ THIS FILE ALSO NEVER WRITES TO attendance_records. ▓▓▓ It drops one function and reads.
-- Same rule as the migration: not even to test, not even inside a transaction.
-- EXPECT: ~1039 · 41-ish · 41
-- If skip_list_still_works ERRORS, something beyond this rollback has gone wrong — awol_skip_list
-- is a separate object and nothing in this file goes near it.

-- 3c. leave_try_date() is a DEPENDENCY, not a product, of the migration. It was installed by the
--     leave work and awol_effective_site() still needs it. It must SURVIVE this rollback.
select public.leave_try_date('07/25/2026') as must_still_be_2026_07_25;
-- EXPECT: 2026-07-25. If this errors, something dropped it — that was not this file.


-- ── STEP 4 — PERSISTENCE CHECK (standing rule after the 2026-07-31 vanishing install) ───────
-- CLOSE this editor tab. Open a FRESH one. Run this and nothing else.
select count(*) as must_be_0
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'awol_punch_days';
-- EXPECT: 0
-- A drop that verified live and then reappeared is the same class of event as the 2026-07-31
-- install that verified live and was later found in neither project. Confirm it from a new tab.


-- ── STEP 5 — AFTER the rollback ─────────────────────────────────────────────────────────────
-- 1. Check a tablet. It should show the skipped-detection notice naming PUNCH HISTORY as the
--    authority it could not read. If it instead suspends somebody, the kiosk on that tablet is a
--    STALE BUILD still running the old local-map path — send it through reset.html immediately.
-- 2. Detection is now OFF for everyone. Decide how you are covering it, and for how long.
-- 3. To restore: re-run awol-punch-history.sql in full, including its STEP 2 verification block.
--    It is idempotent (`create or replace`) and safe to re-run at any time.
