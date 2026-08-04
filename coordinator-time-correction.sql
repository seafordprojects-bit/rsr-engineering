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

-- ── the date normaliser the unique index keys on ─────────────────────────────
-- MUST be IMMUTABLE: Postgres will not build an index on a stable or volatile expression.
-- Written with regexp/substring only for exactly that reason — to_date/to_char are STABLE
-- (they read locale and TimeZone) and could not be used here.
--
-- Deliberately NOT leave_try_date(): that one is used by the AWOL work and returns a real `date`,
-- and its volatility is not guaranteed immutable. An index needs its own frozen contract, so this
-- feature owns a small one rather than borrowing a function it does not control.
--
-- Mirrors the client's toISO() exactly, including the MM/DD/YYYY field order (month, day, year).
--
-- THE FALLBACK IS LOAD-BEARING: an unrecognised spelling returns the trimmed input, NEVER null.
-- If it returned null, every unparseable row would key as null in the unique index — and null is
-- not equal to null, so unlimited duplicates would be allowed on exactly the rows nobody can read
-- properly. Returning the raw text keeps such a row uniquely keyed to itself.
create or replace function public.att_date_iso(p_date text)
returns text language sql immutable strict as $$
  select case
    when btrim(p_date) ~ '^\d{4}-\d{2}-\d{2}'
      then substring(btrim(p_date) from 1 for 10)
    when btrim(p_date) ~ '^\d{1,2}/\d{1,2}/\d{4}'
      then (regexp_match(btrim(p_date), '^(\d{1,2})/(\d{1,2})/(\d{4})'))[3] || '-' ||
           lpad((regexp_match(btrim(p_date), '^(\d{1,2})/(\d{1,2})/(\d{4})'))[1], 2, '0') || '-' ||
           lpad((regexp_match(btrim(p_date), '^(\d{1,2})/(\d{1,2})/(\d{4})'))[2], 2, '0')
    else btrim(p_date)
  end;
$$;

-- ONE live proposal per worker-day. Re-editing the same worker-day before approval UPDATES the
-- open pending row; it never stacks a second one. Partial, so approved/rejected history accumulates
-- freely — a worker-day can be corrected, approved, and corrected again later.
--
-- KEYED ON att_date_iso(date), NOT ON THE RAW COLUMN. `date` carries the same mixed spellings as
-- attendance_records.date, so a raw key made '08/01/2026' and '2026-08-01' two different keys and
-- the constraint could be walked straight past by a spelling difference — precisely the guarantee
-- it exists to give. The kiosk writes MM/DD/YYYY and other paths write ISO for the same calendar
-- day, so this was not hypothetical.
--
-- The drop below is here so a re-run replaces an index built by an EARLIER version of this file:
-- `create unique index if not exists` sees the old name, does nothing, and would silently leave
-- the raw-date key in place. Dropping first is what makes the fix actually land on a second run.
-- BOTH key columns are normalised, for the same reason. Codes drift by spacing and case across
-- sources — 'RSR 0015' and 'RSR0015' are the same man, and awol-punch-history.sql had to handle
-- exactly that drift — so a raw employee_code let two spellings each hold an open proposal on the
-- same day, which is the guarantee this index exists to give.
--
-- The expression is copied CHARACTER FOR CHARACTER from the system's existing authority on whether
-- two spellings are the same worker: the generated column
--   employees.code_norm = upper(regexp_replace(code, '[^A-Za-z0-9]', '', 'g'))
-- backed by unique index employees_code_norm_uniq. Copying it exactly means this index can never
-- disagree with the roster about worker identity. It also proves immutability by precedent: a
-- GENERATED ALWAYS column will not accept a non-immutable expression, so Postgres has already
-- accepted this one.
--
-- ORDER OF OPERATIONS IS DELIBERATE: strip first, THEN upper-case — same as the generated column
-- and same as the client's codeNorm. The reverse order disagrees on characters whose upper-case
-- form is alphanumeric when the original is not ('ß' -> 'SS', 'ﬁ' -> 'FI'), which would let the
-- client compute a different key than the database.
--
-- (STEP 7's seed below uses the weaker '\s'-only idiom instead. That is the shape used by
-- awol-reinstate-flow.sql and named-issuer-access.sql, and it resolves 'RSR 0025' identically, so
-- it is harmless here. Aligning those three files on the stricter form is a tracked follow-up,
-- not this migration's job.)
drop index if exists public.attendance_time_edit_one_pending;
create unique index if not exists attendance_time_edit_one_pending
  on public.attendance_time_edit (upper(regexp_replace(employee_code, '[^A-Za-z0-9]', '', 'g')),
                                  public.att_date_iso(date))
  where status = 'pending';

-- NOTE for the client: because this index is PARTIAL, PostgREST's `upsert(..., onConflict:
-- 'employee_code,date')` CANNOT use it — that syntax emits no WHERE predicate, so Postgres will not
-- match it and the write fails. The coordinator client therefore reads the open pending row and
-- UPDATEs it by id, or INSERTs when there is none. This index is the backstop, not the mechanism.
-- The client's lookup must key the SAME WAY this index does — NORMALISED code, NORMALISED date —
-- or it will look for an open row, miss it on a spelling, insert, and take a 23505 here.
-- getOpenPending() in coordinator.js is that lookup; it matches on codeNorm() + toISO(), which are
-- the client-side twins of the two expressions above. If either pair ever drifts apart, the
-- symptom is a coordinator who cannot re-send a correction she has already filed.
--
-- The client still STORES the raw employee_code it read off the attendance row, deliberately: the
-- record should say what was actually there, and the index is what makes two spellings collide.

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
--   update public.employees set is_time_editor = true where code = 'RSR 0026';
-- (The column on `employees` is `code`. An earlier draft of this comment said `employee_code`,
-- which is the column name used on attendance_records / attendance_time_edit, NOT on the roster —
-- running it verbatim would have failed with "column employee_code does not exist". Corrected so
-- the one-liner can be copied straight out of this file and run.)
-- To be spelling-proof, the normalised form works for any code:
--   update public.employees set is_time_editor = true
--    where upper(regexp_replace(code, '\s', '', 'g')) = 'RSR0026';
-- No code change, no deploy, no stamp bump, no walkthrough. Cover for Jamaica being out sick is a
-- one-line statement on the day.
--
-- SEEDS ONLY WHEN NOBODY IS FLAGGED YET. The previous version opened with an unconditional
--   update public.employees set is_time_editor = false where is_time_editor = true;
-- which made this file a REVOKE for anyone added after it first ran. Re-running a migration is a
-- normal thing to do — after a schema-cache problem, or to re-verify an install — and doing so
-- would have silently switched off a second editor the owner had flag-flipped on, with no error
-- and nothing on screen. The next time Jamaica was off sick, her cover would just stop working.
-- An idempotent migration must converge on the same state, not undo the owner's later decisions.
do $$
begin
  if exists (select 1 from public.employees where is_time_editor) then
    raise notice 'is_time_editor already set for at least one employee — seed SKIPPED, existing editors left alone';
  else
    update public.employees set is_time_editor = true
     where upper(regexp_replace(code, '\s', '', 'g')) = 'RSR0025';
    raise notice 'seeded is_time_editor for RSR0025';
  end if;
end $$;
-- The Supabase editor swallows RAISE NOTICE. Do not trust the notice — STEP 9 re-queries.
--
-- To deliberately RESET the roster of editors back to Jamaica alone, run this by hand first:
--   update public.employees set is_time_editor = false where is_time_editor = true;
-- then re-run the block above. That is now an explicit act, not a side effect of a re-run.


-- ── STEP 7b — triggers on attendance_time_edit ───────────────────────────────
-- attendance_time_edit is a WORKFLOW table, so it must be updatable — but only while the proposal
-- is still open. These two triggers make that a database rule instead of a client convention.
--
-- BEFORE UPDATE trigger firing order is ALPHABETICAL BY TRIGGER NAME, so `..._freeze_trg` runs
-- before `..._touch_trg`. That is the order we want (refuse first, stamp second) and it is not an
-- accident of naming — do not rename one without checking it still sorts ahead.

-- (a) FREEZE — a decided row can never be changed again.
-- Without this, anon holds UPDATE on the whole table (it needs it to revise an open proposal), so
-- a stale screen, a replayed request or a future bug could rewrite an APPROVED row's `after` or
-- `applied` — the record of what the admin actually authorised — long after the punch was written.
-- Nothing legitimate needs to: an approve/reject moves a row OUT of 'pending' exactly once, and
-- from then on it is history. Corrections after that are a NEW proposal, which is the whole design.
create or replace function public.attendance_time_edit_freeze()
returns trigger language plpgsql as $$
begin
  if old.status is distinct from 'pending' then
    raise exception
      'attendance_time_edit id % is already % — a decided correction cannot be changed. File a new one.',
      old.id, old.status
      using errcode = '42501';       -- insufficient_privilege: reads as "not allowed", not "bad data"
  end if;
  return new;
end $$;

drop trigger if exists attendance_time_edit_freeze_trg on public.attendance_time_edit;
create trigger attendance_time_edit_freeze_trg
  before update on public.attendance_time_edit
  for each row execute function public.attendance_time_edit_freeze();

-- (b) TOUCH — updated_at is owned by the database, not by whoever sent the write.
-- A client-supplied timestamp is worth nothing on an audit-adjacent table: it comes from the
-- tablet's clock, which is not trusted anywhere else in this system, and a caller that simply
-- omits the field leaves the column reading as if the row had never been revised.
create or replace function public.attendance_time_edit_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists attendance_time_edit_touch_trg on public.attendance_time_edit;
create trigger attendance_time_edit_touch_trg
  before update on public.attendance_time_edit
  for each row execute function public.attendance_time_edit_touch();


-- ── STEP 8 — grants + schema reload ──────────────────────────────────────────
-- RLS is disabled on this project; the client reaches these tables as anon through PostgREST,
-- the same way it reaches attendance_records and employee_suspensions today.
--
-- NO DELETE, deliberately, on either table: a client must never be able to erase a proposal or
-- a lock. Rejections are part of the record.
grant select, insert, update on public.attendance_time_edit to anon, authenticated;
grant usage, select on sequence public.attendance_time_edit_id_seq to anon, authenticated;

-- attendance_day_lock is INSERT-ONCE. A lock is a fact — "this day was closed, by this person, at
-- this time" — not a setting. UPDATE is revoked rather than merely unused: with it granted, any
-- client could rewrite locked_by_name and locked_at and quietly reassign who closed a pay day.
-- Re-opening a day is deliberately NOT a client action; it is an owner decision made in SQL.
-- The revoke is explicit as well as the grant being narrower, so a re-run over a database that
-- already got the wider grant from an earlier version of this file actually takes it away.
grant select, insert on public.attendance_day_lock to anon, authenticated;
revoke update on public.attendance_day_lock from anon, authenticated;

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

-- expect the partial unique index to exist, and its indexdef to show ALL THREE of
--   upper(regexp_replace(employee_code, ...))   (not a bare `employee_code`)
--   att_date_iso(date)                          (not a bare `date`)
--   WHERE (status = 'pending'::text)
-- A bare column on either side means an older version of this file built the index and the
-- drop-then-create did not run — the one-proposal-per-worker-day guarantee would then be
-- defeated by a spelling difference on whichever column was left raw.
select indexname, indexdef from pg_indexes
 where schemaname = 'public' and tablename = 'attendance_time_edit';

-- expect all four to be 'RSR0015' — the code normaliser agrees with the client's codeNorm(), and
-- every spelling of one worker collapses to a single index key.
select upper(regexp_replace('RSR 0015', '[^A-Za-z0-9]', '', 'g')) as spaced,
       upper(regexp_replace('RSR0015',  '[^A-Za-z0-9]', '', 'g')) as unspaced,
       upper(regexp_replace('rsr 0015', '[^A-Za-z0-9]', '', 'g')) as lower_spaced,
       upper(regexp_replace('RSR-0015', '[^A-Za-z0-9]', '', 'g')) as hyphenated;

-- expect 0 rows — this index must agree with the roster's own authority on worker identity.
-- Any row here is a code whose two normalisers disagree, which would mean the roster and this
-- queue could hold different opinions about who a proposal belongs to.
select code, code_norm, upper(regexp_replace(code, '[^A-Za-z0-9]', '', 'g')) as index_form
  from public.employees
 where code_norm is distinct from upper(regexp_replace(code, '[^A-Za-z0-9]', '', 'g'));

-- expect all three the same: the normaliser agrees with the client's toISO() on every spelling.
select public.att_date_iso('08/01/2026')  as slash_padded,
       public.att_date_iso('8/1/2026')    as slash_unpadded,
       public.att_date_iso('2026-08-01')  as iso;
-- expect the input back, NOT null — the fallback that keeps an unreadable spelling uniquely keyed
select public.att_date_iso('not a date') as junk_must_echo;

-- expect exactly two triggers: attendance_time_edit_freeze_trg then attendance_time_edit_touch_trg
-- (alphabetical = firing order; freeze must sort first)
select tgname, tgenabled from pg_trigger
 where tgrelid = 'public.attendance_time_edit'::regclass and not tgisinternal
 order by tgname;

-- FREEZE PROOF. Inserts a pending row, decides it, then tries to change the decided row.
-- The third update MUST fail. Everything is rolled back — nothing is kept.
begin;
  insert into public.attendance_time_edit
    (employee_code, employee_name, date, reason, filed_by_code, filed_by_name)
  values ('ZZ FREEZEPROBE', 'probe', '08/01/2026', 'probe', 'ZZ', 'probe');

  -- (i) a PENDING row may be revised, and updated_at must move on its own
  update public.attendance_time_edit set reason = 'revised while pending'
   where employee_code = 'ZZ FREEZEPROBE';
  select (updated_at > filed_at) as touch_trigger_must_be_true
    from public.attendance_time_edit where employee_code = 'ZZ FREEZEPROBE';

  -- (ii) deciding it is allowed exactly once (old.status is still 'pending' here)
  update public.attendance_time_edit set status = 'approved', decided_by_name = 'probe'
   where employee_code = 'ZZ FREEZEPROBE';

  -- (iii) THIS MUST RAISE: "id N is already approved — a decided correction cannot be changed."
  -- If it SUCCEEDS, the freeze trigger is not attached and an approved record is still rewritable.
  update public.attendance_time_edit set applied = '{"tampered":true}'::jsonb
   where employee_code = 'ZZ FREEZEPROBE';
rollback;

select count(*) as freeze_probe_must_be_0 from public.attendance_time_edit
 where employee_code = 'ZZ FREEZEPROBE';
-- expect 0 — the rollback held. (Run the block above as ONE block, or the transaction stays open.)

-- expect attendance_day_lock to carry SELECT and INSERT for anon, and NO UPDATE
select grantee, privilege_type from information_schema.role_table_grants
 where table_schema = 'public' and table_name = 'attendance_day_lock'
   and grantee in ('anon', 'authenticated')
 order by grantee, privilege_type;

-- expect {"ok": false} — a PIN that belongs to nobody
select public.time_editor_for_pin('000000') as wrong_pin_must_be_ok_false;

-- expect {"ok": true, "code": "RSR 0025", "name": "Jamaica L. Batucan"}
-- Substitute her real PIN. DO NOT leave it typed in the editor afterwards.
-- select public.time_editor_for_pin('<Jamaica-PIN>') as right_pin_must_name_her;

-- The throttle counts a failed attempt above; reset it so the live screen starts clean.
update public.time_editor_throttle set fails = 0, window_start = now(), locked_until = null where id;
