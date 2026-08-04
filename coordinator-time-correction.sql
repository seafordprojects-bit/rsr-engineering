-- ═══════════════════════════════════════════════════════════════════════════════
--  COORDINATOR TIME-CORRECTION — pending queue, day lock, named attribution
--  Spec: docs/superpowers/specs/2026-08-03-coordinator-time-correction.md
--  Plan: docs/superpowers/plans/2026-08-04-coordinator-time-correction.md  (Task 1)
--  Additive + idempotent. RLS-disabled project convention (anon read/write via PostgREST).
-- ═══════════════════════════════════════════════════════════════════════════════
--
--  ▓▓▓ NOT APPLIED. DO NOT RUN THIS UNTIL A PAYROLL-QUIET WINDOW. ▓▓▓
--  Two reasons, both from the plan's "Payroll-quiet windows" section:
--    1. STEP 8 ends with `notify pgrst, 'reload schema';`, which bounces the PostgREST schema
--       cache. A saveTimes() insert landing in that instant can fail.
--    2. STEP 3 adds columns to attendance_edit_audit — the table saveTimes writes to BEFORE it
--       touches any punch. A log failure aborts the write by design, so a mid-run migration can
--       abort a live correction the owner is in the middle of making.
--  Run it when nobody is editing times.
--
-- ═══ RUNNING THIS — the standing rules (CLAUDE.md, owner 2026-08-03) ═══
--   1. CLOSE the azfmpleswqixaslvcito (inventory) tab. It is the only reliable guard.
--   2. Run STEP 0 ALONE, first, and read the answer before running anything else.
--   3. Everything after STEP 0 is writes. A wrong-project write succeeds silently.
--   4. After running, re-open a FRESH editor tab and re-run STEP 9. A 2026-07-31 install was
--      verified live and its objects were later found in NEITHER project. Cause still unknown.
--
-- WHAT THIS CREATES
--   attendance_time_edit   — the pending-proposal queue the coordinator screen writes to.
--                            It is a WORKFLOW table, not the audit trail: rows are updated
--                            (status, decision). The immutable record stays attendance_edit_audit.
--   attendance_day_lock    — presence of a row for a date = the coordinator can no longer edit it.
--   attendance_edit_audit  — five additive NULLABLE columns. Nullable so the existing append-only
--                            trigger and every existing reader keep working untouched.
--   employees.is_time_editor + time_editor_for_pin() + its throttle — named attribution.
--
-- WHAT THIS DOES NOT DO
--   Nothing here writes a punch. attendance_records is not touched by this migration at all,
--   and the coordinator client never writes its punch columns — those are written in exactly one
--   file, payroll/index.html. That invariant is grep-checkable and is the whole point.


-- ── STEP 0 — CANARY + CENSUS  ▓▓▓ RUN THIS BLOCK ALONE, NOTHING ELSE ▓▓▓ ─────
-- The count errors immediately in the inventory project: that table does not exist there.
select current_database() as must_be_the_ops_project;
select count(*) as attendance_rows_must_be_over_1000 from public.attendance_records;


-- ── STEP 1 — the pending queue ───────────────────────────────────────────────
-- One row per worker-day per submission.
--
-- `date` is TEXT and carries the SAME mixed spellings as attendance_records.date
-- ('MM/DD/YYYY' and 'YYYY-MM-DD'). It is deliberately NOT a date column: it has to be able to
-- point at the exact spelling of the row it proposes to change, so the approver's update matches.
-- NEVER put a gte/lte range filter on it — that compares TEXT lexically and silently drops rows.
--
-- `before` / `after` / `applied` hold the six punch values in the SAME stored format the kiosk
-- and payroll use ('08:03 AM'), so an approval writes them straight through with no conversion.
create table if not exists public.attendance_time_edit (
  id               bigint generated always as identity primary key,
  employee_code    text        not null,
  employee_name    text,
  date             text        not null,
  attendance_id    text,                                  -- NULL = no kiosk row exists for that day
  before           jsonb       not null default '{}'::jsonb,
  after            jsonb       not null default '{}'::jsonb,
  reason           text        not null,
  status           text        not null default 'pending',
  filed_by_code    text        not null,
  filed_by_name    text        not null,
  filed_at         timestamptz not null default now(),
  decided_by_code  text,
  decided_by_name  text,
  decided_at       timestamptz,
  decision_note    text,
  applied          jsonb,
  batch_id         uuid,
  updated_at       timestamptz not null default now()
);

-- Status is a closed set. A typo'd status would make a row invisible to every reader.
alter table public.attendance_time_edit drop constraint if exists attendance_time_edit_status_chk;
alter table public.attendance_time_edit add constraint attendance_time_edit_status_chk
  check (status in ('pending', 'approved', 'rejected', 'superseded'));

-- ONE live proposal per worker-day. Re-editing the same worker-day before approval UPDATES the
-- open pending row; it never stacks a second one. Partial, so approved/rejected history accumulates
-- freely — a worker-day can be corrected, approved, and corrected again later.
--
-- NOTE for the client: because this index is PARTIAL, PostgREST's `upsert(..., onConflict:
-- 'employee_code,date')` CANNOT use it — that syntax emits no WHERE predicate, so Postgres will not
-- match it and the write fails. The coordinator client therefore reads the open pending row and
-- UPDATEs it by id, or INSERTs when there is none. This index is the backstop, not the mechanism.
create unique index if not exists attendance_time_edit_one_pending
  on public.attendance_time_edit (employee_code, date)
  where status = 'pending';

create index if not exists attendance_time_edit_date_idx   on public.attendance_time_edit (date);
create index if not exists attendance_time_edit_status_idx on public.attendance_time_edit (status);


-- ── STEP 2 — the day lock ────────────────────────────────────────────────────
-- Presence of a row = the coordinator's whole view for that date is read-only.
-- Written by a bulk day approve or an explicit "Close day" — never by an individual approve
-- (owner, Q1: an individual approve freezes ONLY that worker).
--
-- `date` is TEXT here for the same reason as above, but this one is stored NORMALIZED to ISO
-- ('YYYY-MM-DD') because a lock is about a calendar day, not about a particular row's spelling.
-- Every reader must compare toISO(date) against it.
create table if not exists public.attendance_day_lock (
  date           text        primary key,
  locked_at      timestamptz not null default now(),
  locked_by_code text,
  locked_by_name text
);


-- ── STEP 3 — attendance_edit_audit: additive, nullable columns ───────────────
-- ADDITIVE AND NULLABLE ON PURPOSE. attendance_edit_audit carries a BEFORE UPDATE/DELETE trigger
-- that blocks mutation (payroll/attendance-edit-audit.sql). Existing rows stay valid and unchanged;
-- every existing reader keeps working; `actor` keeps its meaning — WHO APPLIED IT.
alter table public.attendance_edit_audit add column if not exists source        text;
alter table public.attendance_edit_audit add column if not exists filed_by_code text;
alter table public.attendance_edit_audit add column if not exists filed_by_name text;
alter table public.attendance_edit_audit add column if not exists edit_id       bigint;
alter table public.attendance_edit_audit add column if not exists batch_id      uuid;

comment on column public.attendance_edit_audit.source is
  'owner-direct | coordinator-approved | admin-corrected. NULL on every row written before 2026-08.';
comment on column public.attendance_edit_audit.filed_by_code is
  'Who PROPOSED the change. NULL for owner-direct. actor stays "who applied it".';
comment on column public.attendance_edit_audit.edit_id is
  'Back-pointer to attendance_time_edit.id. Deliberately NOT a foreign key: the audit trail must
   outlive anything in the workflow table and must never be blocked by it.';
comment on column public.attendance_edit_audit.batch_id is
  'Same value across every item of one bulk day approve. Bulk is a UI convenience, never one lumped
   log entry — a bulk-approved item and an individually-approved item are identical in this table
   except for the presence of this column.';


-- ── STEP 4 — the time-editor flag ────────────────────────────────────────────
-- Deliberately its OWN flag. is_issuer and is_awol_clerk grant unrelated powers and must never
-- silently confer the ability to propose a punch change (owner, Q6: Alvin RSR 0005 and Ritchie
-- RSR 0023 hold issuer PINs and are NOT time editors).
alter table public.employees add column if not exists is_time_editor boolean not null default false;


-- ── STEP 5 — the throttle ────────────────────────────────────────────────────
-- Same GLOBAL fail-closed shape as awol_clerk_throttle and admin_verify_passcode: one shared
-- credential space, and no trustworthy per-caller identity to key on (x-forwarded-for is
-- client-rotatable, inet_client_addr() is the Supabase pooler). REST-locked so anon can neither
-- read the counters nor reset them.
create table if not exists public.time_editor_throttle (
  id           boolean     primary key default true check (id),
  fails        integer     not null default 0,
  window_start timestamptz not null default now(),
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);
insert into public.time_editor_throttle (id) values (true) on conflict (id) do nothing;
revoke all on public.time_editor_throttle from anon, authenticated;


-- ── STEP 6 — time_editor_for_pin ─────────────────────────────────────────────
-- Identify the time editor from a typed PIN. Returns {ok:true, code, name} or {ok:false} —
-- never the PIN, never a reason, and a throttled state is INDISTINGUISHABLE from a wrong PIN
-- (no oracle leak: a caller must not be able to tell "locked" from "wrong").
--
-- RESIDUAL, stated not fixed (spec §2): employees.pin is plaintext and compared directly, exactly
-- as issuer_for_pin and awol_clerk_for_pin already do. This feature inherits it. Hardening the
-- employee-PIN store is its own job across all three RPCs.
create or replace function public.time_editor_for_pin(p_pin text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_now  timestamptz := now();
  v_row  public.time_editor_throttle%rowtype;
  v_code text;
  v_name text;
  MAX_FAILS constant int      := 10;
  COOLDOWN  constant interval := interval '15 minutes';
begin
  insert into public.time_editor_throttle (id) values (true) on conflict (id) do nothing;
  select * into v_row from public.time_editor_throttle where id for update;

  -- FAIL-CLOSED: while globally locked, deny WITHOUT checking the PIN.
  if v_row.locked_until is not null and v_row.locked_until > v_now then
    update public.time_editor_throttle set updated_at = v_now where id;
    return jsonb_build_object('ok', false);
  end if;

  if v_now - v_row.window_start > COOLDOWN then
    v_row.fails := 0;
    v_row.window_start := v_now;
  end if;

  select e.code, e.name into v_code, v_name
    from public.employees e
   where e.is_time_editor = true and e.pin is not null and e.pin = p_pin
   limit 1;

  if v_code is null then
    update public.time_editor_throttle
       set fails        = v_row.fails + 1,
           window_start = v_row.window_start,
           locked_until = case when v_row.fails + 1 >= MAX_FAILS then v_now + COOLDOWN else null end,
           updated_at   = v_now
     where id;
    return jsonb_build_object('ok', false);
  end if;

  update public.time_editor_throttle
     set fails = 0, window_start = v_now, locked_until = null, updated_at = v_now
   where id;
  return jsonb_build_object('ok', true, 'code', v_code, 'name', v_name);
end $$;
grant execute on function public.time_editor_for_pin(text) to anon, authenticated;


-- ── STEP 7 — seed: RSR 0025 Jamaica L. Batucan, and nobody else ─────────────
-- Matched on the NORMALIZED code (upper-case, whitespace stripped) so 'RSR 0025' == 'RSR0025',
-- exactly like the client normCode. Seeding by CODE (not name) means a spacing or case difference
-- cannot silently miss the intended person.
--
-- OWNER, Q6: adding a second time editor later is a FLAG FLIP, NOT A BUILD —
--   update public.employees set is_time_editor = true where employee_code = '…';
-- No code change, no deploy, no stamp bump, no walkthrough. Cover for Jamaica being out sick is a
-- one-line statement on the day.
update public.employees set is_time_editor = false where is_time_editor = true;
update public.employees set is_time_editor = true
 where upper(regexp_replace(code, '\s', '', 'g')) = 'RSR0025';


-- ── STEP 8 — grants + schema reload ──────────────────────────────────────────
-- RLS is disabled on this project; the client reaches these tables as anon through PostgREST,
-- the same way it reaches attendance_records and employee_suspensions today.
--
-- NO DELETE, deliberately, on either table: a client must never be able to erase a proposal or
-- a lock. Rejections are part of the record.
grant select, insert, update on public.attendance_time_edit to anon, authenticated;
grant usage, select on sequence public.attendance_time_edit_id_seq to anon, authenticated;
grant select, insert, update on public.attendance_day_lock  to anon, authenticated;

notify pgrst, 'reload schema';


-- ── STEP 9 — RE-QUERY / verify ───────────────────────────────────────────────
-- "Applied" is not evidence. Run every line below, then close the editor, open a FRESH tab, and
-- run them again. Nothing in the client may name a new column until this passes twice.
select count(*) as time_edits_must_be_0 from public.attendance_time_edit;   -- expect 0
select count(*) as day_locks_must_be_0  from public.attendance_day_lock;    -- expect 0

-- expect exactly the five new columns, all is_nullable = YES
select column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema = 'public' and table_name = 'attendance_edit_audit'
   and column_name in ('source', 'filed_by_code', 'filed_by_name', 'edit_id', 'batch_id')
 order by column_name;

-- expect exactly ONE row: RSR 0025, Jamaica L. Batucan
select code, name, is_time_editor from public.employees where is_time_editor;

-- expect the partial unique index to exist, WITH its WHERE clause
select indexname, indexdef from pg_indexes
 where schemaname = 'public' and tablename = 'attendance_time_edit';

-- expect {"ok": false} — a PIN that belongs to nobody
select public.time_editor_for_pin('000000') as wrong_pin_must_be_ok_false;

-- expect {"ok": true, "code": "RSR 0025", "name": "Jamaica L. Batucan"}
-- Substitute her real PIN. DO NOT leave it typed in the editor afterwards.
-- select public.time_editor_for_pin('<Jamaica-PIN>') as right_pin_must_name_her;

-- The throttle counts a failed attempt above; reset it so the live screen starts clean.
update public.time_editor_throttle set fails = 0, window_start = now(), locked_until = null where id;
