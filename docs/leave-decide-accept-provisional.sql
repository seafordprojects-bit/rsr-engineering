-- ═══════════════════════════════════════════════════════════════════════════════════════════
--  leave_decide: accept 'Provisional' as a decidable status
--  Companion to the home.js change of 2026-08-08 that gives Provisional rows Approve/Reject
--  buttons in the admin dashboard's Leave tab.
--
--  ▓▓▓ NOT RUN. Run it yourself in the Supabase editor. ▓▓▓
--
--  WHY: ReportedAbsence (home.js:479, coordinator.js:775) writes leave_requests rows with
--  status 'Provisional' — a man told someone he would be out and it was recorded that day
--  (Defect G). Those rows suppress AWOL detection immediately and NEVER expire, and nothing
--  anywhere read them back for a decision. leave_decide refuses them:
--
--      if v_leave.status is distinct from 'Pending' then
--        return jsonb_build_object('ok', false, 'reason', 'Already ' || v_leave.status);
--      end if;
--
--  so the new buttons would return "Already Provisional" without this.
--
-- ═══ WHY THIS PATCHES THE LIVE FUNCTION INSTEAD OF RE-CREATING IT ═══
--  leave_decide is verified live. TWO files in this repo define it in full —
--  leave-decide-rpc.sql and leave-decide-rpc-fix-uncomparable.sql — and neither is guaranteed
--  to match what the database is actually running. Pasting either body over the live function
--  would silently revert any hotfix that was applied straight in the editor and never made it
--  back to the repo. That is a real risk on this project, not a theoretical one.
--
--  So this migration does NOT contain a function body. It reads the live definition with
--  pg_get_functiondef(), swaps ONE substring, and re-executes the result. Whatever else is in
--  the live body is preserved byte for byte. If the expected text is not found exactly once,
--  it REFUSES and changes nothing — which is the honest outcome when the code has drifted.
--
--  Verified before writing: the string being replaced appears exactly ONCE in both repo copies,
--  and 'Pending' appears nowhere else in the function body, so this one line is the whole
--  server-side change.
--
-- ═══ RUNNING THIS — the standing rules (CLAUDE.md, owner 2026-08-03) ═══
--   1. CLOSE the azfmpleswqixaslvcito (inventory) tab. It is the only reliable guard.
--   2. Run STEP 0 ALONE first and READ THE PRINTED FUNCTION BODY before running STEP 1.
--   3. STEP 1 is a write (it replaces a function definition).
--
--  No schema change, so no `notify pgrst, 'reload schema'` is needed — PostgREST resolves
--  functions per call and the signature is unchanged.
--
--  TO UNDO: docs/leave-decide-accept-provisional-rollback.sql, beside this file. Read its header
--  first — the dashboard buttons must come off in the same change, and decisions already made
--  stay made.
-- ═══════════════════════════════════════════════════════════════════════════════════════════


-- ── STEP 0 — CANARY + READ THE LIVE DEFINITION  ▓▓▓ READ-ONLY. RUN ALONE. ▓▓▓ ───────────────

select current_database() as must_be_the_ops_project;
select count(*) as attendance_rows_must_be_over_1000 from public.attendance_records;
-- ^ the count errors immediately in the inventory project. If it errors, you are in the wrong tab.

-- 0a. It exists, and there is exactly one of it.
select p.oid::regprocedure as signature, p.prosecdef as security_definer, p.provolatile
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'leave_decide';
-- EXPECT exactly ONE row. More than one means an overload this migration does not know about —
-- STOP and read them, because the patch below would only reach the one it finds.

-- 0b. THE LIVE BODY. Read it. This is the only way to know what is actually running, and it is
--     what the patch will be applied to.
select pg_get_functiondef(p.oid) as live_definition
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'leave_decide';

-- 0c. The anchor must appear EXACTLY ONCE, and the patched form must not be there already.
select (length(d) - length(replace(d, 'v_leave.status is distinct from ''Pending''', '')))
         / length('v_leave.status is distinct from ''Pending''')      as old_guard_must_be_1,
       (length(d) - length(replace(d, 'v_leave.status not in (''Pending'', ''Provisional'')', '')))
         / length('v_leave.status not in (''Pending'', ''Provisional'')') as new_guard_must_be_0
  from (select pg_get_functiondef(p.oid) as d
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'leave_decide') s;
-- EXPECT: 1 · 0
-- old_guard 0 → the live body has drifted from both repo copies. STOP, read 0b, and tell me what
--               it says instead; do not hand-edit around it.
-- new_guard 1 → already patched. Nothing to do; STEP 1 will say so and exit without writing.

-- 0d. How many rows this actually unblocks, and for whom.
select status, count(*) from public.leave_requests group by status order by status;
select id, employee_code, employee_name, type, start_date, end_date, status, reason
  from public.leave_requests where status = 'Provisional' order by start_date;
-- Read this list. After STEP 1 every one of these becomes decidable in the dashboard, which
-- means each is a decision waiting for you — approving one cancels any overlapping AWOL case.


-- ── STEP 1 — THE PATCH  ▓▓▓ WRITES. ▓▓▓ ────────────────────────────────────────────────────
-- Dollar-tagged $mig$ deliberately: the function body itself is dollar-quoted, so a bare $$ here
-- would terminate this block early.

do $mig$
declare
  v_oid oid;
  v_def text;
  v_old text := 'v_leave.status is distinct from ''Pending''';
  v_new text := 'v_leave.status not in (''Pending'', ''Provisional'')';
  v_n   int;
begin
  select p.oid into v_oid
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'leave_decide';

  if v_oid is null then
    raise exception 'leave_decide does not exist in this database. Wrong project, or it was never installed.';
  end if;

  v_def := pg_get_functiondef(v_oid);

  -- Idempotent: a second run is a no-op rather than an error.
  if position(v_new in v_def) > 0 then
    raise notice 'leave_decide already accepts Provisional — nothing changed.';
    return;
  end if;

  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  if v_n <> 1 then
    raise exception
      'REFUSING: expected the Pending guard exactly once in the live body, found %. The function has drifted from both repo copies — read STEP 0b before going further. Nothing changed.',
      v_n using errcode = 'data_exception';
  end if;

  -- Everything else in the live definition is carried through untouched.
  execute replace(v_def, v_old, v_new);
  raise notice 'leave_decide now accepts Pending and Provisional.';
end $mig$;
-- The Supabase editor swallows RAISE NOTICE. Do not trust it — STEP 2 re-queries.


-- ── STEP 2 — VERIFY  ▓▓▓ READ-ONLY ▓▓▓ ─────────────────────────────────────────────────────

-- 2a. The guard now names both statuses, and the old one is gone.
select (length(d) - length(replace(d, 'not in (''Pending'', ''Provisional'')', '')))
         / length('not in (''Pending'', ''Provisional'')')            as new_guard_must_be_1,
       (length(d) - length(replace(d, 'is distinct from ''Pending''', '')))
         / length('is distinct from ''Pending''')                     as old_guard_must_be_0
  from (select pg_get_functiondef(p.oid) as d
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'leave_decide') s;
-- EXPECT: 1 · 0

-- 2b. Nothing else moved. Signature, security-definer flag and volatility must be unchanged.
select p.oid::regprocedure as signature, p.prosecdef as security_definer_must_be_true, p.provolatile
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'leave_decide';

-- 2c. Still callable, and still refuses safely. A nonexistent id with a deliberately wrong
--     passcode: whichever check fires first, it returns ok:false and writes nothing.
select public.leave_decide(
         '00000000-0000-0000-0000-000000000000'::uuid,
         'Approved', 'migration probe', 'definitely-not-the-passcode') as must_be_ok_false;

-- 2d. Read the live body once more, end to end, and satisfy yourself that only the guard moved.
select pg_get_functiondef(p.oid) as live_definition_after
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'leave_decide';


-- ── STEP 3 — AFTER ─────────────────────────────────────────────────────────────────────────
-- 1. The repo's two full copies of this function — leave-decide-rpc.sql and
--    leave-decide-rpc-fix-uncomparable.sql — STILL CARRY THE OLD GUARD. Re-running either of
--    them in full would silently revert this patch. If one of them is ever re-run, re-run this
--    file after it. Better: fold the change into whichever of the two is the true current source
--    and retire the other, so there is one definition rather than three.
-- 2. The dashboard change ships with this. Deploying the buttons WITHOUT this migration gives
--    "Already Provisional" on every press; running this WITHOUT the buttons changes nothing
--    visible. Either order is safe, but both are needed for the feature to work.
-- 3. Approving a Provisional row whose dates overlap an open AWOL case CANCELS that case, through
--    awol_cancel_leave_approved, and writes "absence covered by an approved leave" to awol_events.
--    That is the intended behaviour, and it is a real disciplinary outcome — see STEP 0d for who
--    it currently applies to.
