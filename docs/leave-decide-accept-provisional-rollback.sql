-- ═══════════════════════════════════════════════════════════════════════════════════════════
--  ROLLBACK for leave-decide-accept-provisional.sql
--  Restores leave_decide's guard to Pending-only, so 'Provisional' rows are refused again.
--  Pairs 1:1 with that file — if it changes, change this one with it.
--
--  ▓▓▓ NOT RUN. Run it yourself in the Supabase editor. ▓▓▓
--
-- ═══ READ THIS BEFORE RUNNING ═══
--
--  THE DASHBOARD BUTTONS MUST COME OFF IN THE SAME CHANGE. The Leave tab shows Approve/Reject on
--  Provisional rows (home.js, the `r.status === 'Pending' || r.status === 'Provisional'` test).
--  Undo the RPC without undoing that and every press returns "Already Provisional" to whoever
--  tries — a button that exists and always fails is worse than no button. Revert the home.js line
--  to `r.status === 'Pending'` and bump the dashboard stamp in the same deploy.
--
--  DECISIONS ALREADY MADE STAY MADE. This restores a guard; it does not revert anything. A
--  Provisional row that was approved is now Approved, and if that approval cancelled an AWOL case
--  the case is cancelled and awol_events carries the row saying so. Rolling this back does not
--  undo any of it, and it should not — the audit log is append-only by design. If a specific
--  decision was wrong, that is a correction on that case, not a rollback of this migration.
--
-- ═══ WHY THERE IS NO bak_ SNAPSHOT ═══
--  The standing rule is that a rollback snapshots into a bak_ table before dropping anything that
--  can hold real work, and refuses when the snapshot is missing. That step is ABSENT HERE ON
--  PURPOSE, not by oversight: this migration changed ONE SUBSTRING of a function definition. It
--  owns no table, no column and no row, and it wrote nothing. There is nothing to copy. The
--  function's previous text is reconstructed by the inverse swap below, and STEP 0b prints the
--  live body first so you can keep a copy by hand if you want one.
--
-- ═══ RUNNING THIS — the standing rules (CLAUDE.md, owner 2026-08-03) ═══
--   1. CLOSE the azfmpleswqixaslvcito (inventory) tab. It is the only reliable guard.
--   2. Run STEP 0 ALONE first and read the printed body before running STEP 1.
--   3. STEP 1 is a write (it replaces a function definition).
--
--  No schema change, so no `notify pgrst, 'reload schema'` — the signature is unchanged.
-- ═══════════════════════════════════════════════════════════════════════════════════════════


-- ── STEP 0 — CANARY + READ THE LIVE DEFINITION  ▓▓▓ READ-ONLY. RUN ALONE. ▓▓▓ ───────────────

select current_database() as must_be_the_ops_project;
select count(*) as attendance_rows_must_be_over_1000 from public.attendance_records;
-- ^ the count errors immediately in the inventory project. If it errors, you are in the wrong tab.

-- 0a. Exactly one leave_decide, as the forward migration also required.
select p.oid::regprocedure as signature, p.prosecdef as security_definer, p.provolatile
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'leave_decide';
-- EXPECT one row. More than one: STOP — the patch reaches only the one it finds.

-- 0b. THE LIVE BODY. Read it, and keep a copy if you want one — see the no-snapshot note above.
select pg_get_functiondef(p.oid) as live_definition
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'leave_decide';

-- 0c. The patched guard must be present exactly once, and the original absent.
select (length(d) - length(replace(d, 'v_leave.status not in (''Pending'', ''Provisional'')', '')))
         / length('v_leave.status not in (''Pending'', ''Provisional'')') as patched_guard_must_be_1,
       (length(d) - length(replace(d, 'v_leave.status is distinct from ''Pending''', '')))
         / length('v_leave.status is distinct from ''Pending''')          as original_guard_must_be_0
  from (select pg_get_functiondef(p.oid) as d
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'leave_decide') s;
-- EXPECT: 1 · 0
-- patched 0 → the forward migration was never applied, or the body has drifted since. Nothing to
--             roll back; STEP 1 will say so and exit without writing.

-- 0d. What goes back to being undecidable, and what has already been decided since the migration.
select status, count(*) from public.leave_requests group by status order by status;

select id, employee_code, employee_name, start_date, end_date, status, approved_by, approved_at
  from public.leave_requests
 where status in ('Approved','Rejected') and approved_via = 'Admin app'
   and approved_at is not null
 order by approved_at desc limit 20;
-- Any 'Reported Absence' rows in here were decided BECAUSE of the forward migration. They stay
-- decided. Read them before rolling back so you know what this does not undo.


-- ── STEP 1 — THE INVERSE PATCH  ▓▓▓ WRITES. ▓▓▓ ────────────────────────────────────────────
-- Same mechanism as the forward migration and for the same reason: it patches whatever is LIVE
-- rather than pasting a body from the repo, so any drift is preserved and only this one line moves.
-- Dollar-tagged $rb$ deliberately — the function body is itself dollar-quoted.

do $rb$
declare
  v_oid oid;
  v_def text;
  v_old text := 'v_leave.status not in (''Pending'', ''Provisional'')';
  v_new text := 'v_leave.status is distinct from ''Pending''';
  v_n   int;
begin
  select p.oid into v_oid
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'leave_decide';

  if v_oid is null then
    raise exception 'leave_decide does not exist in this database. Wrong project, or it was never installed.';
  end if;

  v_def := pg_get_functiondef(v_oid);

  -- Idempotent: already Pending-only is a no-op, not an error.
  if position(v_new in v_def) > 0 then
    raise notice 'leave_decide is already Pending-only — nothing changed.';
    return;
  end if;

  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  if v_n <> 1 then
    raise exception
      'REFUSING: expected the patched guard exactly once in the live body, found %. Read STEP 0b before going further. Nothing changed.',
      v_n using errcode = 'data_exception';
  end if;

  execute replace(v_def, v_old, v_new);
  raise notice 'leave_decide restored to Pending-only.';
end $rb$;
-- The Supabase editor swallows RAISE NOTICE. Do not trust it — STEP 2 re-queries.


-- ── STEP 2 — VERIFY  ▓▓▓ READ-ONLY ▓▓▓ ─────────────────────────────────────────────────────

-- 2a. The guard is back to Pending-only.
select (length(d) - length(replace(d, 'is distinct from ''Pending''', '')))
         / length('is distinct from ''Pending''')                        as original_guard_must_be_1,
       (length(d) - length(replace(d, 'not in (''Pending'', ''Provisional'')', '')))
         / length('not in (''Pending'', ''Provisional'')')               as patched_guard_must_be_0
  from (select pg_get_functiondef(p.oid) as d
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'leave_decide') s;
-- EXPECT: 1 · 0

-- 2b. Nothing else moved.
select p.oid::regprocedure as signature, p.prosecdef as security_definer_must_be_true, p.provolatile
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'leave_decide';

-- 2c. Still callable and still refuses safely — a nonexistent id with a wrong passcode writes
--     nothing whichever check fires first.
select public.leave_decide(
         '00000000-0000-0000-0000-000000000000'::uuid,
         'Approved', 'rollback probe', 'definitely-not-the-passcode') as must_be_ok_false;

-- 2d. A Provisional row is refused again. Pick one from STEP 0d if any remain. Safe: the guard
--     rejects it before anything is written, and the passcode is wrong anyway.
-- select public.leave_decide(
--          '<a-real-Provisional-row-id>'::uuid,
--          'Approved', 'rollback probe', 'definitely-not-the-passcode') as must_say_already_provisional;

-- 2e. Nothing in the data moved. This file touches one function and no rows.
select count(*) as leave_rows_unchanged from public.leave_requests;
select count(*) as awol_events_unchanged from public.awol_events;


-- ── STEP 3 — AFTER ─────────────────────────────────────────────────────────────────────────
-- 1. REVERT THE DASHBOARD IN THE SAME DEPLOY. home.js must go back to `r.status === 'Pending'`
--    and the stamp must be bumped, or the Leave tab shows buttons that always fail.
-- 2. Provisional rows are undecidable again and will accumulate. They still suppress AWOL
--    detection (LEAVE_SUPPRESSES includes 'Provisional'), so nobody is wrongly detected — but
--    nobody can close them either, which is the state the forward migration existed to fix.
-- 3. The repo's two full copies of this function — leave-decide-rpc.sql and
--    leave-decide-rpc-fix-uncomparable.sql — carry the Pending-only guard already, so they now
--    agree with the database again. That is the one thing this rollback tidies.
