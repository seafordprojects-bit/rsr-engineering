-- ═══════════════════════════════════════════════════════════════════════════════
--  ROLLBACK for coordinator-time-correction.sql
--  Undoes the Task 1 schema change if the migration causes trouble.
--  Pairs 1:1 with coordinator-time-correction.sql — if that file changes, change this one
--  in the same commit.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- WHEN TO RUN THIS
--   The migration is additive: it creates two new tables, one RPC, one throttle table, one flag
--   column, and five nullable columns on attendance_edit_audit. Nothing existing is altered and
--   no punch is touched. So the realistic failure is not corruption — it is the schema reload
--   (`notify pgrst`) misbehaving, a grant being wrong, or simply wanting the objects gone again.
--
-- ▓▓▓ PAYROLL-QUIET WINDOW, SAME AS THE MIGRATION. ▓▓▓
--   This file ends in `notify pgrst, 'reload schema';` too, and STEP 6 (optional) touches
--   attendance_edit_audit — the table saveTimes writes to BEFORE it writes any punch. A log
--   failure aborts the punch write by design, so running this while somebody is editing times
--   can abort a live correction. Run it when nobody is editing times.
--
-- ═══ RUNNING THIS — the standing rules (CLAUDE.md, owner 2026-08-03) ═══
--   1. CLOSE the azfmpleswqixaslvcito (inventory) tab. It is the only reliable guard.
--   2. Run STEP 0 ALONE, first, and read the answer before running anything else.
--   3. Everything after STEP 0 is writes. A wrong-project write succeeds silently.
--
-- ═══ HOW THIS FILE IS BUILT ═══
--   NOTHING IS DROPPED BEFORE IT IS COPIED. STEP 2 snapshots every table that can hold real work
--   into a bak_ table; STEP 4's drops REFUSE to run if that snapshot is missing. A rollback that
--   loses the coordinator's filed proposals or the day locks is not a rollback, it is a second
--   incident — and those rows are the only record that a correction was ever proposed or refused.
--
--   STEP 5 and STEP 6 are DELIBERATELY COMMENTED OUT. They drop columns, which is the one part of
--   this that is not cheap to undo, and leaving those columns in place costs nothing at all:
--   employees.is_time_editor set to false grants nobody anything, and the five audit columns are
--   nullable and ignored by every existing reader. Run them only if you specifically want the
--   columns gone. Read each one's banner first.


-- ── STEP 0 — CANARY + CENSUS  ▓▓▓ RUN THIS BLOCK ALONE, NOTHING ELSE ▓▓▓ ─────
-- The count errors immediately in the inventory project: that table does not exist there.
select current_database() as must_be_the_ops_project;
select count(*) as attendance_rows_must_be_over_1000 from public.attendance_records;


-- ── STEP 1 — WHAT WILL BE LOST  ▓▓▓ READ THE NUMBERS BEFORE GOING ON ▓▓▓ ────
-- If these are all zero, the migration never got used and this rollback is free.
-- If they are NOT zero, real work is in there: proposals Jamaica filed, decisions the admin made,
-- days that were closed. STEP 2 copies all of it, but you should still know what you are undoing.
select count(*) as proposals_total          from public.attendance_time_edit;
select status, count(*) as n                from public.attendance_time_edit group by status order by status;
select count(*) as day_locks                from public.attendance_day_lock;
-- Audit rows that already carry the new columns = approvals that really went through the queue.
-- If this is > 0, think hard before STEP 6: those five columns are the only record of WHO PROPOSED
-- each of those changes. `actor` still tells you who applied it, but the proposer would be gone.
select count(*) as audit_rows_using_new_cols
  from public.attendance_edit_audit
 where source is not null or filed_by_code is not null or filed_by_name is not null
    or edit_id is not null or batch_id is not null;


-- ── STEP 2 — SNAPSHOT FIRST. Nothing below drops anything that isn't copied here ──
-- Suffixed with the date so a second rollback attempt cannot silently overwrite the first one's
-- copy. If you re-run this on a different day, change the suffix in STEP 2 AND STEP 4 together.
create table if not exists public.bak_attendance_time_edit_20260804 as
  select * from public.attendance_time_edit;
create table if not exists public.bak_attendance_day_lock_20260804 as
  select * from public.attendance_day_lock;
-- Only the id + the five new columns: enough to reattach the proposer to an audit row later,
-- without duplicating the audit trail itself.
create table if not exists public.bak_audit_newcols_20260804 as
  select id, source, filed_by_code, filed_by_name, edit_id, batch_id
    from public.attendance_edit_audit
   where source is not null or filed_by_code is not null or filed_by_name is not null
      or edit_id is not null or batch_id is not null;

-- Backups are a record, not a client resource. anon must not be able to read or erase them.
revoke all on public.bak_attendance_time_edit_20260804 from anon, authenticated;
revoke all on public.bak_attendance_day_lock_20260804  from anon, authenticated;
revoke all on public.bak_audit_newcols_20260804        from anon, authenticated;

-- Prove the copy landed before anything is dropped.
select (select count(*) from public.attendance_time_edit)              as live_proposals,
       (select count(*) from public.bak_attendance_time_edit_20260804) as backed_up_proposals,
       (select count(*) from public.attendance_day_lock)               as live_locks,
       (select count(*) from public.bak_attendance_day_lock_20260804)  as backed_up_locks;


-- ── STEP 3 — the RPC and its throttle ────────────────────────────────────────
-- Revoke before dropping: if the drop is rolled back or fails, the function must not be left
-- reachable by anon in a half-undone state.
revoke execute on function public.time_editor_for_pin(text) from anon, authenticated;
drop function if exists public.time_editor_for_pin(text);
drop table    if exists public.time_editor_throttle;


-- ── STEP 4 — the two new tables ──────────────────────────────────────────────
-- GUARDED. This refuses to drop a table whose backup is missing or short. There is no client
-- delete on either table precisely so no audit trail can be erased from a screen — this script
-- must not become the loophole that does it from the editor instead.
do $$
declare
  v_live int; v_bak int;
begin
  select count(*) into v_live from public.attendance_time_edit;
  select count(*) into v_bak  from public.bak_attendance_time_edit_20260804;
  if v_bak < v_live then
    raise exception 'REFUSING TO DROP attendance_time_edit: backup has % rows, table has %. Run STEP 2 first.', v_bak, v_live;
  end if;

  select count(*) into v_live from public.attendance_day_lock;
  select count(*) into v_bak  from public.bak_attendance_day_lock_20260804;
  if v_bak < v_live then
    raise exception 'REFUSING TO DROP attendance_day_lock: backup has % rows, table has %. Run STEP 2 first.', v_bak, v_live;
  end if;

  -- Both indexes on attendance_time_edit and the sequence go with the table.
  drop table public.attendance_time_edit;
  drop table public.attendance_day_lock;
  raise notice 'attendance_time_edit and attendance_day_lock dropped; backups kept.';
end $$;
-- The Supabase editor swallows RAISE NOTICE. Do not trust the notice above — re-query in STEP 7.


-- ── STEP 5 — employees.is_time_editor ────────────────────────────────────────
-- The flag is cleared unconditionally: with the RPC gone nothing reads it, but a stale `true`
-- sitting on a live employee row is exactly the kind of thing that quietly grants access when a
-- future migration re-creates the function. Clear it, always.
update public.employees set is_time_editor = false where is_time_editor = true;

-- ▓▓▓ OPTIONAL — the column itself. Leaving it costs nothing (it is boolean not null default
--     false, and every row is now false). Uncomment ONLY if you want the column gone. Re-running
--     coordinator-time-correction.sql re-creates it and re-seeds RSR 0025 either way. ▓▓▓
-- alter table public.employees drop column if exists is_time_editor;


-- ── STEP 6 — attendance_edit_audit's five columns  ▓▓▓ READ THIS ▓▓▓ ─────────
-- COMMENTED OUT ON PURPOSE. These five columns are additive and nullable; every reader that
-- existed before the migration ignores them, so leaving them in place changes NOTHING and breaks
-- NOTHING. Dropping them is the only irreversible act in this file — attendance_edit_audit is the
-- append-only audit trail, and for any approval that already went through the queue these columns
-- are the ONLY record of who PROPOSED the change. `actor` survives and still says who applied it;
-- the proposer's name would be gone from the trail, recoverable only by hand from
-- bak_audit_newcols_20260804.
--
-- If STEP 1 reported audit_rows_using_new_cols = 0, dropping them is genuinely free.
-- If it reported more than 0, do not drop them without deciding you are willing to lose that.
--
-- The append-only trigger blocks UPDATE and DELETE on rows; it does not block ALTER TABLE, so
-- these will succeed. That is not permission — it is just the absence of a guard.
--
-- alter table public.attendance_edit_audit drop column if exists source;
-- alter table public.attendance_edit_audit drop column if exists filed_by_code;
-- alter table public.attendance_edit_audit drop column if exists filed_by_name;
-- alter table public.attendance_edit_audit drop column if exists edit_id;
-- alter table public.attendance_edit_audit drop column if exists batch_id;


-- ── STEP 7 — schema reload + verify ──────────────────────────────────────────
notify pgrst, 'reload schema';

-- expect 0 rows: both tables gone
select table_name from information_schema.tables
 where table_schema = 'public'
   and table_name in ('attendance_time_edit', 'attendance_day_lock', 'time_editor_throttle');

-- expect 0 rows: the RPC gone
select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'time_editor_for_pin';

-- expect 0 — nobody is flagged, whether or not the column was dropped in STEP 5
select count(*) as time_editors_must_be_0 from public.employees where is_time_editor;

-- expect the three backups, present and REST-locked (relacl null/owner-only = no anon grant)
select relname, relacl from pg_class
 where relname in ('bak_attendance_time_edit_20260804',
                   'bak_attendance_day_lock_20260804',
                   'bak_audit_newcols_20260804');

-- expect the five columns still there UNLESS STEP 6 was uncommented and run
select column_name from information_schema.columns
 where table_schema = 'public' and table_name = 'attendance_edit_audit'
   and column_name in ('source', 'filed_by_code', 'filed_by_name', 'edit_id', 'batch_id')
 order by column_name;

-- The kiosk and payroll must be unaffected. This is the whole point of an additive migration:
-- the rollback should be invisible from the punch side.
select count(*) as attendance_rows_unchanged from public.attendance_records;
select count(*) as audit_rows_unchanged      from public.attendance_edit_audit;


-- ── STEP 8 — AFTER the rollback ──────────────────────────────────────────────
-- 1. Re-open a FRESH editor tab and re-run STEP 7. A 2026-07-31 install was verified live and its
--    objects were later found in NEITHER project; the same doubt applies to a drop.
-- 2. The coordinator's Time-correction screen will now fail to load its day and say so. That is
--    correct behaviour for a missing backend, not a new bug — the screen is all-three-or-none by
--    design so it can never be typed into with the lock state unknown.
-- 3. Take the screen down as well if the rollback is meant to be lasting: revert the
--    coordinator.js / coordinator/index.html change, or leave the tile unreachable.
-- 4. The bak_ tables are the record. Drop them only once you are certain the feature is not
--    coming back.
