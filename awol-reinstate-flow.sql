-- ═══════════════════════════════════════════════════════════════════════════════
--  AWOL reinstate flow — walkthrough cleanup + two-role gate + PEM exemption
--  Spec: docs/superpowers/specs/2026-07-26-dashboard-reinstate-flow-design.md
--  Additive + idempotent EXCEPT step 2 (a one-time DELETE, backed up in step 1) — STEP 2 ships
--  commented out; see its own "RUN ONCE" banner before ever uncommenting it.
--
--  HOW TO RUN THIS FILE — TWO SEPARATE PASTES, NOT ONE:
--    PASTE 1 — STEP 0 ONLY. Select and run just the STEP 0 census below, by itself, and read the
--              three numbers it returns against the EXPECT line before doing anything else. The
--              Supabase SQL editor only shows the result of the LAST statement in a paste, so if
--              STEP 0 is pasted together with anything below it, its numbers are never seen and
--              this stop-and-eyeball gate cannot fire.
--    PASTE 2 — everything from STEP 1 to the end of the file, run once STEP 0's numbers check out.
--              STEP 2 and STEP 14 stay commented out inside this second paste — see their own
--              banners before ever uncommenting either one.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── STEP 0 — CENSUS  ▓▓▓ PASTE 1 — RUN THIS STATEMENT ALONE, NOTHING ELSE ▓▓▓ ──
select count(*) as total,
       count(*) filter (where active)     as active_now,
       count(*) filter (where not active) as inactive
  from public.employee_suspensions;
-- EXPECT (owner-confirmed 2026-07-26): total = 45, active_now = 0, inactive = 45.
-- Of the 45: 43 are the original walkthrough rows, and 2 (TEST999, PEM TEST9) are inactive probe
-- rows written by the pre-migration verification run (it called two RPCs that already existed in
-- production from an earlier build). Both are already inactive, so all 45 are removed by STEP 2
-- below, which deletes inactive rows only.
-- If active_now > 0 someone is REALLY suspended right now — STOP and re-check before step 2.

-- ═══════════════════════════════════════════════════════════════════════════════
-- ▓▓▓  STOP.  Confirm the STEP 0 numbers above match EXPECT before going any further.  ▓▓▓
-- ▓▓▓  PASTE 2 starts on the next line: select from STEP 1 to the end and run it separately.  ▓▓▓
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── STEP 1 — BACKUP everything before deleting ───────────────────────────────
create table if not exists public.bak_employee_suspensions_20260726 as
  select * from public.employee_suspensions;
-- Mirrors STEP 8's treatment of the throttle table: a backup a client can erase with the anon key
-- is not a backup. Supabase's default privileges can otherwise expose a freshly created table to
-- anon, which would include DELETE on the only copy of the rows STEP 2 is about to destroy.
revoke all on public.bak_employee_suspensions_20260726 from anon, authenticated;
select count(*) as backed_up from public.bak_employee_suspensions_20260726;   -- expect 45

-- ═══════════════════════════════════════════════════════════════════════════════
-- ── STEP 2 — RUN ONCE — uncomment deliberately — delete the walkthrough residue ──
-- STEP 1's `create table if not exists` is a no-op on every run after the first, so its backup is
-- only written FRESH the very first time this file executes. If this file is ever re-pasted later,
-- re-running this DELETE would remove every resolved suspension since then with NO fresh backup
-- underneath it. The `active is not true` guard means it can never touch a LIVE suspension, but
-- that does not make a second run of this delete safe. Uncomment the two lines below only the
-- first time this file is run, then leave them commented out for good.
-- ═══════════════════════════════════════════════════════════════════════════════
-- delete from public.employee_suspensions where active is not true;
-- select count(*) as remaining from public.employee_suspensions;                -- expect 0

-- ── STEP 3 — PAKYAW/PEM exemption helper ─────────────────────────────────────
-- Moved ahead of the gate columns (was STEP 5) so the PEM guard constraint added in STEP 4 below
-- has something to reference — a check constraint cannot call a function that does not exist yet.
-- Owner rule 2026-07-26: PAKYAW/PEM workers are exempt from AWOL entirely — piece-rate/casual,
-- irregular attendance is normal. The employee CODE PREFIX is the marker (coordinator.js sets it
-- at creation: empType 'RSR' = regular, 'PEM' = pakyaw). Normalized like the client normCode —
-- upper-cased with whitespace stripped — so 'PEM 0001' and 'PEM9001' both match.
create or replace function public.awol_is_pem(p_code text)
returns boolean language sql immutable as $$
  select upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g')) like 'PEM%';
$$;
grant execute on function public.awol_is_pem(text) to anon, authenticated;

-- ── STEP 4 — two-role gate columns + PEM exemption constraint ────────────────
alter table public.employee_suspensions
  add column if not exists letter_received    boolean not null default false,
  add column if not exists letter_received_by text,
  add column if not exists letter_received_at timestamptz,
  add column if not exists last_decision      text,
  add column if not exists last_decision_by   text,
  add column if not exists last_decision_at   timestamptz,
  add column if not exists manual             boolean not null default false,
  add column if not exists ref_note           text;

-- Belt-and-braces at the schema level: the PEM guard inside awol_set_suspended/awol_manual_suspend
-- refuses a PEM code, but employee_suspensions still grants insert to anon, so a raw REST insert
-- could otherwise create a suspension for a pakyaw worker straight past the RPCs. This closes that
-- path. STEP 2 empties the table first, so the constraint has nothing pre-existing to violate.
-- Guarded via pg_constraint so re-running this file is a no-op instead of an error.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'employee_suspensions_no_pem') then
    alter table public.employee_suspensions
      add constraint employee_suspensions_no_pem check (not public.awol_is_pem(employee_code));
  end if;
end $$;

-- ── STEP 5 — append-only audit log ───────────────────────────────────────────
-- The suspension row is REUSED on every cycle, so without this a repeat offender's
-- history is overwritten. This is the permanent trail behind "Recently closed".
create table if not exists public.awol_events (
  id            bigserial   primary key,
  employee_code text        not null,
  event         text        not null,   -- suspended | suspended_manual | letter_received
                                        -- | reinstated | kept_suspended | cancelled_leave_approved
  actor         text,
  note          text,
  at            timestamptz not null default now()
);
create index if not exists awol_events_code_at_idx on public.awol_events (employee_code, at desc);
-- SELECT only: every event insert happens inside a security definer RPC, which runs as the
-- function owner and needs no table grant to write. Granting anon INSERT (plus sequence usage)
-- would let anyone holding the public anon key forge audit entries directly — e.g. a fake
-- letter_received event attributed to a named person. No delete grant either: an append-only log
-- a client can delete is not append-only. Probe rows from the verification script are removed by
-- the owner in STEP 14 below, not by the client.
grant select on public.awol_events to anon, authenticated;

-- ── STEP 6 — detection RPC: PEM guard + reset the gate on a NEW suspension ───
-- Replaces the 07-24 version. Two changes: a PEM refusal, and clearing the gate/decision
-- columns when a row is re-activated (a new case must start at "waiting for the letter").
create or replace function public.awol_set_suspended(p_code text, p_reason text, p_dates jsonb, p_on text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_newly boolean;
begin
  if awol_is_pem(p_code) then return false; end if;   -- PAKYAW exempt: no suspension, no alert
  insert into employee_suspensions(employee_code, active, reason, suspended_on, absent_dates, updated_at)
    values (p_code, true, p_reason, p_on, p_dates, now())
    on conflict (employee_code) do update
      set active = true, reason = excluded.reason, suspended_on = excluded.suspended_on,
          absent_dates = excluded.absent_dates,
          awol_group_msg_id = null, awol_group_chat = null,
          reinstated_by = null, reinstated_on = null,
          letter_received = false, letter_received_by = null, letter_received_at = null,
          last_decision = null, last_decision_by = null, last_decision_at = null,
          manual = false, ref_note = null,
          updated_at = now()
      where employee_suspensions.active is distinct from true
  returning true into v_newly;
  if coalesce(v_newly, false) then
    insert into awol_events(employee_code, event, actor, note)
      values (p_code, 'suspended', 'detection', p_reason);
  end if;
  return coalesce(v_newly, false);
end $$;
grant execute on function public.awol_set_suspended(text, text, jsonb, text) to anon, authenticated;

-- ── STEP 7 — leave-approval auto-cancel (the ONLY caller of this now) ────────
-- Owner decision: an absence later covered by an APPROVED leave means the suspension was issued
-- in error. It clears with no letter and no two-step, and is logged as CANCELLED — never as a
-- reinstatement, so the two are always distinguishable.
-- Renamed from awol_reinstate (2026-07-26 review): the old name un-suspended unconditionally and
-- stamped the permanent audit log with "absence covered by an approved leave" regardless of why it
-- was actually called — so any legacy or raw caller bypassed the two-role gate AND wrote a false
-- statement into awol_events. A caller that still expects awol_reinstate now fails loudly (function
-- not found) instead of silently mislabelling the record.
create or replace function public.awol_cancel_leave_approved(p_code text, p_by text, p_on text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_msg text; v_chat text;
begin
  update employee_suspensions
     set active = false, reinstated_by = p_by, reinstated_on = p_on,
         last_decision = 'cancelled_leave_approved', last_decision_by = p_by,
         last_decision_at = now(), updated_at = now()
   where employee_code = p_code and active is true
  returning awol_group_msg_id, awol_group_chat into v_msg, v_chat;
  if not found then
    return jsonb_build_object('newly', false);
  end if;
  insert into awol_events(employee_code, event, actor, note)
    values (p_code, 'cancelled_leave_approved', p_by, 'absence covered by an approved leave');
  return jsonb_build_object('newly', true, 'awol_group_msg_id', v_msg, 'awol_group_chat', v_chat);
end $$;
grant execute on function public.awol_cancel_leave_approved(text, text, text) to anon, authenticated;

-- Drop the old ungated entry point now that the renamed function above exists. The only legitimate
-- caller of the old name was the kiosk's leave-approval path (now switched to
-- awol_cancel_leave_approved), so this was renamed specifically so a stale cached build or a raw
-- REST rpc call can no longer reach the old ungated entry point.
drop function if exists public.awol_reinstate(text, text, text);

-- ── STEP 8 — the AWOL clerk (Jamaica only) + its throttle ────────────────────
alter table public.employees add column if not exists is_awol_clerk boolean not null default false;

-- Same GLOBAL fail-closed throttle shape as admin_verify_passcode: one shared credential space,
-- no trustworthy per-caller identity (x-forwarded-for is client-rotatable, inet_client_addr() is
-- the Supabase pooler). REST-locked so anon can neither read nor reset the counters.
create table if not exists public.awol_clerk_throttle (
  id           boolean     primary key default true check (id),
  fails        integer     not null default 0,
  window_start timestamptz not null default now(),
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);
insert into public.awol_clerk_throttle (id) values (true) on conflict (id) do nothing;
revoke all on public.awol_clerk_throttle from anon, authenticated;

-- Identify the AWOL clerk from a typed PIN. Returns {ok:true, code, name} or {ok:false} — never the
-- PIN, and a throttled state is indistinguishable from a wrong PIN (no oracle leak). Deliberately
-- keyed on is_awol_clerk and NOT is_issuer: RSR 0005 and RSR 0023 are issuers and must be refused.
create or replace function public.awol_clerk_for_pin(p_pin text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_now  timestamptz := now();
  v_row  public.awol_clerk_throttle%rowtype;
  v_code text;
  v_name text;
  MAX_FAILS constant int      := 10;
  COOLDOWN  constant interval := interval '15 minutes';
begin
  insert into public.awol_clerk_throttle (id) values (true) on conflict (id) do nothing;
  select * into v_row from public.awol_clerk_throttle where id for update;

  -- FAIL-CLOSED: while globally locked, deny WITHOUT checking the PIN.
  if v_row.locked_until is not null and v_row.locked_until > v_now then
    update public.awol_clerk_throttle set updated_at = v_now where id;
    return jsonb_build_object('ok', false);
  end if;

  if v_now - v_row.window_start > COOLDOWN then
    v_row.fails := 0;
    v_row.window_start := v_now;
  end if;

  select e.code, e.name into v_code, v_name
    from public.employees e
   where e.is_awol_clerk = true and e.pin is not null and e.pin = p_pin
   limit 1;

  if v_code is null then
    update public.awol_clerk_throttle
       set fails        = v_row.fails + 1,
           window_start = v_row.window_start,
           locked_until = case when v_row.fails + 1 >= MAX_FAILS then v_now + COOLDOWN else null end,
           updated_at   = v_now
     where id;
    return jsonb_build_object('ok', false);
  end if;

  update public.awol_clerk_throttle
     set fails = 0, window_start = v_now, locked_until = null, updated_at = v_now
   where id;
  return jsonb_build_object('ok', true, 'code', v_code, 'name', v_name);
end $$;
grant execute on function public.awol_clerk_for_pin(text) to anon, authenticated;

-- ── STEP 9 — STEP 1 of the gate: letter received ─────────────────────────────
-- Idempotent: a double-tap returns {newly:false} so exactly one Telegram message is posted.
create or replace function public.awol_letter_received(p_code text, p_by text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_n integer;
begin
  update employee_suspensions
     set letter_received = true, letter_received_by = p_by, letter_received_at = now(), updated_at = now()
   where employee_code = p_code and active is true and letter_received is not true;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('newly', false);
  end if;
  insert into awol_events(employee_code, event, actor, note)
    values (p_code, 'letter_received', p_by, null);
  return jsonb_build_object('newly', true);
end $$;
grant execute on function public.awol_letter_received(text, text) to anon, authenticated;

-- ── STEP 10 — STEP 2 of the gate: the admin decision ─────────────────────────
-- THIS IS WHERE THE TWO-STEP GATE ACTUALLY LIVES. 'approve' refuses unless the letter is
-- confirmed, so a stale screen, a replayed request, or a future UI bug cannot bypass it.
create or replace function public.awol_admin_decide(p_code text, p_by text, p_decision text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_row employee_suspensions%rowtype; v_msg text; v_chat text; v_n integer;
begin
  if p_decision not in ('approve', 'keep') then
    return jsonb_build_object('newly', false, 'reason', 'unknown decision');
  end if;

  select * into v_row from employee_suspensions where employee_code = p_code for update;
  if not found or v_row.active is not true then
    return jsonb_build_object('newly', false, 'reason', 'not currently suspended');
  end if;

  if p_decision = 'approve' then
    if v_row.letter_received is not true then
      return jsonb_build_object('newly', false, 'reason', 'letter not yet confirmed');
    end if;
    -- Belt-and-braces: repeat the gate in the WHERE clause itself, so the approval does not
    -- depend solely on the row lock / check two statements above staying in sync with this UPDATE.
    update employee_suspensions
       set active = false, reinstated_by = p_by,
           reinstated_on = to_char(now() at time zone 'Asia/Manila', 'MM/DD/YYYY'),
           last_decision = 'approved', last_decision_by = p_by, last_decision_at = now(),
           updated_at = now()
     where employee_code = p_code and active is true and letter_received is true
    returning awol_group_msg_id, awol_group_chat into v_msg, v_chat;
    get diagnostics v_n = row_count;
    if v_n = 0 then
      return jsonb_build_object('newly', false, 'reason', 'letter not yet confirmed');
    end if;
    insert into awol_events(employee_code, event, actor, note) values (p_code, 'reinstated', p_by, null);
    return jsonb_build_object('newly', true, 'awol_group_msg_id', v_msg, 'awol_group_chat', v_chat);
  end if;

  -- keep: stays blocked, and the letter tick is CLEARED so the case returns to the clerk's list.
  -- Deduped exactly like awol_letter_received: `and letter_received is true` means a second tap
  -- (two admins racing, or a double-tap) after the first has already cleared the tick changes zero
  -- rows here, instead of firing a second Telegram message and a second kept_suspended audit row.
  update employee_suspensions
     set letter_received = false, letter_received_by = null, letter_received_at = null,
         last_decision = 'kept', last_decision_by = p_by, last_decision_at = now(), updated_at = now()
   where employee_code = p_code and letter_received is true;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('newly', false, 'reason', 'letter not confirmed');
  end if;
  insert into awol_events(employee_code, event, actor, note) values (p_code, 'kept_suspended', p_by, null);
  return jsonb_build_object('newly', true, 'kept', true);
end $$;
grant execute on function public.awol_admin_decide(text, text, text) to anon, authenticated;

-- ── STEP 11 — manual suspension / re-suspension from the dashboard ───────────
-- p_letter_on_file = true is the wrong-approval recovery: the letter is already on file, so the
-- case lands straight in "needs your decision" — no new letter, no second tick.
create or replace function public.awol_manual_suspend(p_code text, p_by text, p_reason text,
                                                      p_dates jsonb, p_ref_note text,
                                                      p_letter_on_file boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_newly boolean; v_letter boolean := coalesce(p_letter_on_file, false);
begin
  if awol_is_pem(p_code) then
    return jsonb_build_object('newly', false, 'reason', 'PAKYAW/PEM workers are exempt from AWOL');
  end if;
  -- Owner rule: at least one absent date. The printable letter is built from these, so an empty
  -- list would hand the worker a letter with a blank absence section to sign.
  if p_dates is null or jsonb_typeof(p_dates) <> 'array' or jsonb_array_length(p_dates) = 0 then
    return jsonb_build_object('newly', false, 'reason', 'at least one absent date is required');
  end if;

  insert into employee_suspensions(employee_code, active, reason, suspended_on, absent_dates,
                                   letter_received, letter_received_by, letter_received_at,
                                   manual, ref_note, updated_at)
    values (p_code, true, p_reason,
            to_char(now() at time zone 'Asia/Manila', 'MM/DD/YYYY'), p_dates,
            v_letter,
            case when v_letter then p_by  else null end,
            case when v_letter then now() else null end,
            true, p_ref_note, now())
    on conflict (employee_code) do update
      set active = true, reason = excluded.reason, suspended_on = excluded.suspended_on,
          absent_dates = excluded.absent_dates,
          awol_group_msg_id = null, awol_group_chat = null,
          reinstated_by = null, reinstated_on = null,
          letter_received = excluded.letter_received,
          letter_received_by = excluded.letter_received_by,
          letter_received_at = excluded.letter_received_at,
          last_decision = null, last_decision_by = null, last_decision_at = null,
          manual = true, ref_note = excluded.ref_note, updated_at = now()
      where employee_suspensions.active is distinct from true
  returning true into v_newly;

  if not coalesce(v_newly, false) then
    return jsonb_build_object('newly', false, 'reason', 'already suspended');
  end if;
  insert into awol_events(employee_code, event, actor, note)
    values (p_code, 'suspended_manual', p_by, coalesce(p_ref_note, p_reason));
  -- The letter tick above is carried into the row silently (letter_received = true); without this,
  -- the audit stream would show only "suspended_manual" with no explanation for why the case lands
  -- straight at "needs your decision" instead of "waiting for the letter".
  if v_letter then
    insert into awol_events(employee_code, event, actor, note)
      values (p_code, 'letter_received', p_by,
              'letter on file at re-suspension time, carried over from the referenced case');
  end if;
  return jsonb_build_object('newly', true);
end $$;
grant execute on function public.awol_manual_suspend(text, text, text, jsonb, text, boolean) to anon, authenticated;

-- ── STEP 12 — seed the AWOL clerk: RSR 0025 Jamaica L. Batucan, and nobody else ──
-- Matched on the NORMALIZED code (upper-case, whitespace stripped) so 'RSR 0025' == 'RSR0025',
-- exactly like the client normCode. Seeding by CODE (not name) means a spacing or case difference
-- cannot silently miss the intended person.
update public.employees set is_awol_clerk = false where is_awol_clerk = true;
update public.employees set is_awol_clerk = true
 where upper(regexp_replace(code, '\s', '', 'g')) = 'RSR0025';

-- ── STEP 13 — RE-QUERY / verify ──────────────────────────────────────────────
select count(*) as suspensions_remaining from public.employee_suspensions;    -- expect 0
select code, name, is_awol_clerk from public.employees where is_awol_clerk;    -- expect exactly RSR 0025
select count(*) as events from public.awol_events;                            -- expect 0
select column_name from information_schema.columns
 where table_schema = 'public' and table_name = 'employee_suspensions'
 order by ordinal_position;
-- Confirms the STEP 1 revoke actually landed: relacl should show no grant to anon/authenticated —
-- a null/owner-only relacl here means the backup table still carries only default privileges.
select relacl from pg_class where relname = 'bak_employee_suspensions_20260726';

-- ═══════════════════════════════════════════════════════════════════════════════
-- ── STEP 14 — RUN THIS SEPARATELY, *AFTER* the verification script has been run ──
-- The verification script exercises the RPCs against two throwaway codes, TEST999 and 'PEM TEST9'.
-- It cannot delete them itself: anon holds no delete on either table, deliberately, so that no
-- client can erase an audit trail. Clear the probes here once verification has passed.
-- ═══════════════════════════════════════════════════════════════════════════════
-- delete from public.employee_suspensions where employee_code in ('TEST999', 'PEM TEST9');
-- delete from public.awol_events          where employee_code in ('TEST999', 'PEM TEST9');
-- select count(*) as suspensions_remaining from public.employee_suspensions;   -- expect 0
-- select count(*) as events_remaining      from public.awol_events;            -- expect 0
