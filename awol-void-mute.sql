-- ═══════════════════════════════════════════════════════════════════════════════
--  AWOL — VOID A CASE, AND MUTE IT SO NO SWEEP RE-OPENS IT
--  Design: docs/superpowers/specs/2026-08-04-awol-detector-punch-history-and-void.md §4,
--          amended by the owner 2026-08-04 — the MUTE variant, built BEFORE Defect 1.
--  Additive + idempotent. RLS-disabled project convention (anon read/write via PostgREST).
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS FIXES
-- On 08/03 the owner voided RSR 0015's case by hand. At 07:53 the next morning the sweep
-- re-created it, with a worse charge. awol_set_suspended re-activates any row whose active is not
-- true, and a voided row is exactly that. Every night, indefinitely.
--
-- WHY A MUTE AND NOT THE WATERMARK IN THE SPEC
-- The spec's detect_resume_after freezes a date: "nothing on or before this day is ever counted
-- again for this worker". That is permanent and one-way, and right now the detector INVENTS
-- absences (Defect 1 — it reads a 10-day local map while looking back 21 days). Setting permanent
-- watermarks off fabricated counts would seal real absences shut and would also make RSR 0015 —
-- the only worker whose true answer we know — report zero, destroying the test case for Defect 1.
--
-- So: mute the CASE, freeze NOTHING. Detection keeps computing every night and keeps refreshing
-- what it computed onto the row; it simply cannot re-open the case or fire the group alert. The
-- number on the dashboard is live, so the night Defect 1 ships it corrects itself with no migration
-- and nothing to unwind.
--
-- OWNER DECISION 2026-08-04, recorded here because the code cannot show it:
--   "No new case, no group message until I clear the mute. The case stays on the dashboard,
--    that's enough."
-- Release is therefore MANUAL and only manual. There is deliberately no auto-release: the only
-- honest auto-release trigger is "has he punched since?", and that question cannot be answered
-- truthfully until Defect 1 gives the sweep real punch history.
--
-- ═══ RUNNING THIS — the standing rules (CLAUDE.md, owner 2026-08-03) ═══
--   1. CLOSE the azfmpleswqixaslvcito (inventory) tab. It is the only reliable guard.
--   2. Run STEP 0 ALONE, first, and read the answer before running anything else.
--   3. This whole file is writes. A wrong-project write succeeds silently.


-- ── STEP 0 — CANARY + CENSUS  ▓▓▓ RUN THIS BLOCK ALONE, NOTHING ELSE ▓▓▓ ─────
select current_database() as must_be_the_ops_project;
select count(*) as attendance_rows_must_be_over_1000 from public.attendance_records;
-- ^ errors immediately in the inventory project. If it errors, you are in the wrong tab. STOP.

select employee_code, active, reason, suspended_on, barred_at
  from public.employee_suspensions order by updated_at desc;
-- EXPECT today: one row, RSR 0015, active=false, barred_at NULL.
-- That row is the live instance of the defect: inactive, un-muted, and the next sweep re-opens it.

select count(*) as void_cols_must_be_0 from information_schema.columns
 where table_schema='public' and table_name='employee_suspensions'
   and column_name in ('voided_at','voided_by','voided_reason','voided_note');
-- EXPECT: 0 on the first run, 4 on any re-run.


-- ── STEP 1 — the mute columns ────────────────────────────────────────────────
-- Nullable timestamp, not a boolean, for the same reason barred_at is: "when" and "who" come free
-- and "never voided" is the zero-migration default. No backfill — nothing is muted at cutover,
-- which is the safe state. RSR 0015 is muted by the owner in STEP 8, deliberately and on the record,
-- not silently by this migration.
alter table public.employee_suspensions
  add column if not exists voided_at     timestamptz,
  add column if not exists voided_by     text,
  add column if not exists voided_reason text,
  add column if not exists voided_note   text;

-- The two reasons are a CLOSED set. The owner must choose which one he means every single time —
-- they say different things about a man's standing, and awol_events is the company's evidence if a
-- case is ever contested. A free-text column here would let a typo become an unanswerable record.
-- NOT VALID: the existing rows have NULL, which passes anyway; this only avoids a full table scan
-- and matches how employee_suspensions_no_pem was added.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'employee_suspensions_void_reason') then
    alter table public.employee_suspensions
      add constraint employee_suspensions_void_reason
      check (voided_reason is null or voided_reason in ('counted_wrong','handled_by_owner')) not valid;
  end if;
end $$;

select column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema='public' and table_name='employee_suspensions'
   and column_name in ('voided_at','voided_by','voided_reason','voided_note')
 order by column_name;
-- EXPECT 4 rows: voided_at (timestamp with time zone), voided_by / voided_note / voided_reason (text),
--                all nullable.


-- ── STEP 2 — the guard. The mute is settable ONLY through the PIN-gated RPCs. ─
-- Identical reasoning to the bar guard (awol-defect-cdf.sql STEP 2), and it must be identical:
-- column grants alone are not enough, because a `security definer` function runs as the owner and
-- bypasses them. So authorization is a TRANSACTION-LOCAL flag that only awol_void_case() and
-- awol_release_mute() set. Any other path — direct REST, a hand-typed UPDATE, or some future RPC
-- that forgets — raises.
--
-- This is the load-bearing line of the whole change. If anon can set voided_at, then anyone holding
-- the public anon key can silence AWOL detection for any worker, permanently, with no audit row and
-- nobody the wiser. The PIN gate would be decoration.
create or replace function public.employee_suspensions_void_guard()
returns trigger language plpgsql as $$
begin
  if (tg_op = 'INSERT' and (new.voided_at is not null or new.voided_by is not null
                            or new.voided_reason is not null or new.voided_note is not null))
     or (tg_op = 'UPDATE' and (new.voided_at     is distinct from old.voided_at
                            or new.voided_by     is distinct from old.voided_by
                            or new.voided_reason is distinct from old.voided_reason
                            or new.voided_note   is distinct from old.voided_note)) then
    if coalesce(current_setting('awol.void_authorized', true), '') <> '1' then
      raise exception
        'The AWOL mute may only be changed by awol_void_case() / awol_release_mute() (PIN-gated). Refused for %.',
        new.employee_code
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists employee_suspensions_void_guard_biu on public.employee_suspensions;
create trigger employee_suspensions_void_guard_biu
  before insert or update on public.employee_suspensions
  for each row execute function public.employee_suspensions_void_guard();

-- Re-assert the narrowed column grant. awol-defect-cdf.sql STEP 2 already revoked the table-level
-- UPDATE and handed back only the two Telegram message columns, so the four columns added in STEP 1
-- are ALREADY unreachable by anon — new columns inherit nothing. These two statements restate that
-- state rather than change it, so that this file is correct even if run against a database where
-- the earlier revoke was undone. Re-running them is a no-op.
revoke update on public.employee_suspensions from anon, authenticated;
grant  update (awol_group_msg_id, awol_group_chat) on public.employee_suspensions to anon, authenticated;

select count(*) as void_guard_trigger_must_be_1
  from pg_trigger where tgname='employee_suspensions_void_guard_biu' and not tgisinternal;
-- EXPECT: 1

select column_name from information_schema.column_privileges
 where grantee='anon' and table_schema='public' and table_name='employee_suspensions'
   and privilege_type='UPDATE'
 order by column_name;
-- EXPECT exactly two rows: awol_group_chat, awol_group_msg_id
-- If ANY voided_* column appears here, the revoke did not take — STOP, ship nothing.


-- ── STEP 3 — the sweep learns to respect a mute ──────────────────────────────
-- Replaces awol-reinstate-flow.sql STEP 6. Everything that was there is preserved verbatim — the
-- PEM refusal, the gate-column reset on a genuinely new case, the 'detected' event and its comment.
-- The ONLY addition is the mute branch at the top.
--
-- WHY THE MUTED BRANCH STILL WRITES: it refreshes the FACTS (what the sweep computed tonight) and
-- changes no STATE. That is what keeps the dashboard honest — the owner sees the current number for
-- a muted man, not the number that was on screen the day he voided it — and it is what makes this
-- self-correcting: when Defect 1 ships and the sweep starts reading real punch history, RSR 0015's
-- muted card goes from "10 consecutive days" to "7" by itself, on the next sweep, with no migration.
--
-- suspended_on is deliberately NOT refreshed. That is the date the case was opened; it belongs to
-- the case, not to tonight's arithmetic, and the printable letter is dated from it.
create or replace function public.awol_set_suspended(p_code text, p_reason text, p_dates jsonb, p_on text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_newly boolean; v_voided timestamptz; v_found boolean := false;
begin
  if awol_is_pem(p_code) then return false; end if;   -- PAKYAW exempt: no suspension, no alert

  -- THE MUTE. Matched on employee_code EXACTLY, the same way the insert below conflicts, so a
  -- spacing drift can never make a row look un-muted here and then collide there.
  select voided_at, true into v_voided, v_found
    from employee_suspensions where employee_code = p_code for update;
  if coalesce(v_found, false) and v_voided is not null then
    update employee_suspensions
       set reason = p_reason, absent_dates = p_dates, updated_at = now()
     where employee_code = p_code;
    -- FALSE means "not newly opened", which is what the kiosk keys the Telegram alert off
    -- (kiosk/index.html:2560 — `if(data===true) await sendAwolAlert(...)`). So this one return
    -- closes both halves of the defect: no case re-opened, no group message. Every caller goes
    -- through here — the nightly sweep, the offline retry queue (:2651) and the migration path
    -- (:2699) — so there is exactly one place this can leak from, and this is it.
    return false;
  end if;

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
    -- 'detected', NEVER 'suspended'. Detection OPENS A CASE and stops; it does not suspend anyone.
    -- (Preserved from awol-reinstate-flow.sql STEP 6 — see that file for the full rationale.)
    insert into awol_events(employee_code, event, actor, note)
      values (p_code, 'detected', 'detection', p_reason);
  end if;
  return coalesce(v_newly, false);
end $$;
grant execute on function public.awol_set_suspended(text, text, jsonb, text) to anon, authenticated;


-- ── STEP 4 — VOID A CASE. The only door. Passcode verified INSIDE, first. ────
-- Admin PIN only (spec §5 Q4). The AWOL clerk PIN does not open this: voiding erases a disciplinary
-- case, and the clerk's role is confirming a letter was received, which is a different kind of act —
-- the same way holding an issuer PIN must never confer time editing.
--
-- Works on an ACTIVE case (the normal path) and on an already-inactive one. That second case is not
-- theoretical: RSR 0015 sits inactive-and-un-muted right now, hand-voided on 08/03, and the sweep
-- will re-open it tonight. Requiring active=true would leave the live instance of the defect with
-- no way to reach the fix.
create or replace function public.awol_void_case(
  p_code text, p_passcode text, p_reason_kind text,
  p_actor text default 'Admin', p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_norm  text := upper(regexp_replace(coalesce(p_code,''), '[^A-Za-z0-9]', '', 'g'));
  v_row   public.employee_suspensions%rowtype;
  v_actor text := coalesce(nullif(btrim(p_actor), ''), 'Admin');
  v_kind  text := lower(btrim(coalesce(p_reason_kind, '')));
begin
  -- Reason kind is checked BEFORE the PIN on purpose: it is input shape, not authorisation, it
  -- leaks nothing that is not already in this repo, and putting it first is what lets the
  -- verification script prove the closed set without ever holding a real passcode.
  if v_kind not in ('counted_wrong', 'handled_by_owner') then
    return jsonb_build_object('ok', false, 'reason',
      'Unknown void reason — it must be counted_wrong or handled_by_owner');
  end if;

  if public.admin_verify_passcode(p_passcode) is not true then
    return jsonb_build_object('ok', false, 'reason', 'Not authorised');
  end if;

  select * into v_row from public.employee_suspensions
   where upper(regexp_replace(employee_code,'[^A-Za-z0-9]','','g')) = v_norm
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'No case exists for ' || coalesce(p_code,'null'));
  end if;

  if v_row.voided_at is not null then
    return jsonb_build_object('ok', false, 'reason',
      'Already voided on ' || to_char(v_row.voided_at at time zone 'Asia/Manila', 'MM/DD/YYYY')
      || ' by ' || coalesce(v_row.voided_by, '-'));
  end if;

  -- REFUSED while the man is barred, and this refusal is the fail-open rule doing its job.
  -- Voiding takes the case off the "needs your decision" list, which is where the ↩️ Reinstate
  -- button lives. Void a barred man and he is left unable to Time In with nothing on screen
  -- explaining why and no button to fix it — a silent indefinite block, the exact shape the
  -- standing rule forbids. The alternative, silently unbarring him here, would hide a second
  -- disciplinary act inside the first. So: two acts, two decisions, in the order that never
  -- strands anybody.
  if v_row.barred_at is not null then
    return jsonb_build_object('ok', false, 'reason',
      'He is BARRED from starting work. Reinstate him first (the "Reinstate - he can punch again" '
      || 'button), then void the case. Voiding now would leave him unable to punch with no case on '
      || 'screen to undo it.');
  end if;

  -- Authorise for THIS transaction only, then write. The STEP 2 trigger checks this flag.
  perform set_config('awol.void_authorized', '1', true);

  update public.employee_suspensions
     set active        = false,
         voided_at     = now(),
         voided_by     = v_actor,
         voided_reason = v_kind,
         voided_note   = nullif(btrim(coalesce(p_note, '')), ''),
         updated_at    = now()
   where employee_code = v_row.employee_code;

  -- 'voided' is its own event, distinct from 'cancelled_leave_approved' (absence excused by an
  -- approved leave), 'reinstated' and 'kept_suspended'. They mean different things and the audit
  -- log is the company's evidence if a case is contested (spec §4.3).
  -- The reason kind is written into the note in plain words, because a year from now
  -- 'handled_by_owner' on its own will not tell anyone what was decided.
  insert into public.awol_events (employee_code, event, actor, note)
  values (v_row.employee_code, 'voided', v_actor,
          case v_kind
            when 'counted_wrong'    then 'Case voided - the count was wrong'
            when 'handled_by_owner' then 'Case voided - real absence, the owner is handling it'
          end
          || ' [' || v_kind || ']'
          || coalesce(' - ' || nullif(btrim(coalesce(p_note,'')), ''), ''));

  -- The message ids come back so the dashboard can edit the original AWOL-group alert to VOIDED.
  -- Returned, not sent from here: this database has no Telegram token and must not grow one.
  return jsonb_build_object('ok', true, 'employee_code', v_row.employee_code,
                            'voided_reason', v_kind, 'at', now(),
                            'awol_group_msg_id', v_row.awol_group_msg_id,
                            'awol_group_chat',   v_row.awol_group_chat);
end $$;
grant execute on function public.awol_void_case(text, text, text, text, text) to anon, authenticated;


-- ── STEP 5 — RELEASE the mute. Same door, same PIN, opposite direction. ──────
-- One function per direction rather than a boolean flag on the void, because the audit must be
-- symmetric and unambiguous: one awol_events row either way, naming the actor.
--
-- Releasing does NOT re-open the case. It clears the mute and leaves active=false, so the very next
-- sweep decides on the facts as they stand that night: still absent -> a fresh case opens normally
-- and the group is told; back at work -> nothing happens. That is the whole point of not having
-- frozen anything.
create or replace function public.awol_release_mute(
  p_code text, p_passcode text, p_actor text default 'Admin')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_norm  text := upper(regexp_replace(coalesce(p_code,''), '[^A-Za-z0-9]', '', 'g'));
  v_row   public.employee_suspensions%rowtype;
  v_actor text := coalesce(nullif(btrim(p_actor), ''), 'Admin');
begin
  if public.admin_verify_passcode(p_passcode) is not true then
    return jsonb_build_object('ok', false, 'reason', 'Not authorised');
  end if;

  select * into v_row from public.employee_suspensions
   where upper(regexp_replace(employee_code,'[^A-Za-z0-9]','','g')) = v_norm
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'No case exists for ' || coalesce(p_code,'null'));
  end if;
  if v_row.voided_at is null then
    return jsonb_build_object('ok', false, 'reason', 'Nothing to release - this case is not muted');
  end if;

  perform set_config('awol.void_authorized', '1', true);

  update public.employee_suspensions
     set voided_at = null, voided_by = null, voided_reason = null, voided_note = null,
         updated_at = now()
   where employee_code = v_row.employee_code;

  insert into public.awol_events (employee_code, event, actor, note)
  values (v_row.employee_code, 'mute_released', v_actor,
          'Mute released - detection may open a new case again from the next sweep');

  return jsonb_build_object('ok', true, 'employee_code', v_row.employee_code, 'at', now());
end $$;
grant execute on function public.awol_release_mute(text, text, text) to anon, authenticated;


-- ── STEP 6 — PROVE IT. This block, not the node script, is the proof. ────────
-- tests/awol-void-mute/verify-sql.mjs runs as anon and therefore cannot hold a PIN, so it can only
-- prove the door is fitted. This block runs as the table owner and proves the lock works.
-- It RAISES on any failed assertion, which rolls the whole block back — a silent pass is impossible.
-- Supabase's editor swallows RAISE NOTICE, so success is asserted by the absence of an error plus
-- the re-query in STEP 6b.
do $$
declare
  v_code text := 'ZZ MUTETEST';
  v_ok   boolean;
  v_row  public.employee_suspensions%rowtype;
begin
  -- clean slate, in case a previous run of this file left the probe behind
  perform set_config('awol.void_authorized', '1', true);
  delete from public.awol_events          where employee_code = v_code;
  delete from public.employee_suspensions where employee_code = v_code;

  -- 6.1 an ordinary case opens, exactly as it does every night
  v_ok := public.awol_set_suspended(v_code, 'probe - absent 4 consecutive days',
                                    '["2026-07-27","2026-07-28","2026-07-29","2026-07-30"]'::jsonb,
                                    '08/04/2026');
  if v_ok is not true then
    raise exception 'ASSERTION FAILED 6.1: a fresh case did not open (got %). The normal path is broken.', v_ok;
  end if;

  -- 6.2 the second sweep of the same night does not re-open it (pre-existing dedup, unchanged)
  v_ok := public.awol_set_suspended(v_code, 'probe - repeat sweep', '["2026-07-27"]'::jsonb, '08/04/2026');
  if v_ok is not false then
    raise exception 'ASSERTION FAILED 6.2: an already-open case re-opened (got %).', v_ok;
  end if;

  -- 6.3 the guard refuses a hand-typed mute. Checked by CATCHING the exception: if the update
  --     succeeds, the guard is not working and nothing may ship.
  begin
    perform set_config('awol.void_authorized', '', true);
    update public.employee_suspensions set voided_at = now() where employee_code = v_code;
    raise exception 'ASSERTION FAILED 6.3: a hand-typed UPDATE set voided_at. The STEP 2 guard is not working.';
  exception when insufficient_privilege then
    null;   -- correct: refused
  end;

  -- 6.4 mute it the way awol_void_case does (this block cannot call that RPC - it has no PIN)
  perform set_config('awol.void_authorized', '1', true);
  update public.employee_suspensions
     set active = false, voided_at = now(), voided_by = 'probe',
         voided_reason = 'counted_wrong', updated_at = now()
   where employee_code = v_code;

  -- 6.5 THE POINT OF THE WHOLE FILE: the sweep runs again, with a DIFFERENT and larger count,
  --     and must not re-open the case.
  v_ok := public.awol_set_suspended(v_code, 'probe - absent 9 consecutive days',
                                    '["2026-07-20","2026-07-21","2026-07-22","2026-07-23","2026-07-24","2026-07-27","2026-07-28","2026-07-29","2026-07-30"]'::jsonb,
                                    '08/05/2026');
  if v_ok is not false then
    raise exception 'ASSERTION FAILED 6.5: a MUTED case was re-opened (got %). This is the 08/04 defect, unfixed.', v_ok;
  end if;

  select * into v_row from public.employee_suspensions where employee_code = v_code;
  if v_row.active is not false then
    raise exception 'ASSERTION FAILED 6.5a: the muted row went active again.';
  end if;
  -- false from the function is what suppresses the Telegram alert (kiosk :2560). Asserting the row
  -- stayed closed AND the return was false covers both halves.

  -- 6.6 ... but the FACTS were refreshed. This is what keeps the dashboard honest and what makes
  --     the count self-correct when Defect 1 ships.
  if v_row.reason <> 'probe - absent 9 consecutive days' then
    raise exception 'ASSERTION FAILED 6.6: a muted case did not refresh its reason (got %). The dashboard would show a stale count forever.', v_row.reason;
  end if;
  if jsonb_array_length(v_row.absent_dates) <> 9 then
    raise exception 'ASSERTION FAILED 6.6a: a muted case did not refresh absent_dates (got % dates).', jsonb_array_length(v_row.absent_dates);
  end if;
  -- and suspended_on did NOT move: it belongs to the case, and the letter is dated from it
  if v_row.suspended_on <> '08/04/2026' then
    raise exception 'ASSERTION FAILED 6.6b: suspended_on moved to % - the case date must not follow tonight''s arithmetic.', v_row.suspended_on;
  end if;

  -- 6.7 no 'detected' event was forged for the muted sweep. The audit log must not fill up with
  --     nightly detections of a case nobody is acting on.
  if (select count(*) from public.awol_events where employee_code = v_code and event = 'detected') <> 1 then
    raise exception 'ASSERTION FAILED 6.7: expected exactly one detected event, found %.',
      (select count(*) from public.awol_events where employee_code = v_code and event = 'detected');
  end if;

  -- 6.8 release the mute (as awol_release_mute does) and the sweep opens a NEW case normally.
  --     Nothing was frozen, so the very next run decides on the facts as they stand.
  perform set_config('awol.void_authorized', '1', true);
  update public.employee_suspensions
     set voided_at = null, voided_by = null, voided_reason = null, voided_note = null
   where employee_code = v_code;
  v_ok := public.awol_set_suspended(v_code, 'probe - after release', '["2026-08-03"]'::jsonb, '08/05/2026');
  if v_ok is not true then
    raise exception 'ASSERTION FAILED 6.8: after releasing the mute the sweep did not re-open the case (got %). The mute would be permanent.', v_ok;
  end if;

  -- 6.9 teardown of this block's probe
  perform set_config('awol.void_authorized', '1', true);
  delete from public.awol_events          where employee_code = v_code;
  delete from public.employee_suspensions where employee_code = v_code;
end $$;
-- EXPECT: "Success. No rows returned." Any ERROR above names the exact assertion that failed.

-- 6b. Re-query, because the editor swallows notices and an empty result set is not proof.
select count(*) as mutetest_leftovers_must_be_0
  from public.employee_suspensions where employee_code = 'ZZ MUTETEST';
-- EXPECT: 0


-- ── STEP 7 — the PIN-gated path, by hand. Replace the passcode in the editor. ─
-- STEP 6 proved the mute. This proves the DOOR to it: that the real RPCs work, refuse a wrong PIN,
-- and refuse a double void. Run these one at a time and read each answer.
-- ZZ VOIDTEST is also the probe row left behind by tests/awol-void-mute/verify-sql.mjs, so running
-- that script first and this step second clears it in the same pass.

-- 7a. open a probe case (safe: 'ZZ VOIDTEST' can never collide with a real code)
select public.awol_set_suspended('ZZ VOIDTEST', 'probe - 3 consecutive days', '["2026-07-20"]'::jsonb, '08/04/2026');
-- EXPECT: true  (or false if verify-sql.mjs already opened it — either is fine)

-- 7b. wrong PIN must refuse and change nothing
select public.awol_void_case('ZZ VOIDTEST', 'wrong-passcode', 'counted_wrong', 'probe', null);
-- EXPECT: {"ok": false, "reason": "Not authorised"}

-- 7c. unknown reason must refuse
select public.awol_void_case('ZZ VOIDTEST', 'PASSCODE_HERE', 'because_i_said_so', 'probe', null);
-- EXPECT: {"ok": false, "reason": "Unknown void reason - it must be counted_wrong or handled_by_owner"}

-- 7d. the real thing
select public.awol_void_case('ZZ VOIDTEST', 'PASSCODE_HERE', 'counted_wrong', 'probe-admin', 'probe void');
-- EXPECT: {"ok": true, ...}
select employee_code, active, voided_at is not null as muted, voided_by, voided_reason
  from public.employee_suspensions where employee_code = 'ZZ VOIDTEST';
-- EXPECT: active=false · muted=true · voided_by='probe-admin' · voided_reason='counted_wrong'

-- 7e. voiding twice must refuse — a second void would overwrite who decided and why
select public.awol_void_case('ZZ VOIDTEST', 'PASSCODE_HERE', 'handled_by_owner', 'probe-admin', null);
-- EXPECT: {"ok": false, "reason": "Already voided on ..."}

-- 7f. the sweep cannot re-open it
select public.awol_set_suspended('ZZ VOIDTEST', 'probe - 9 consecutive days', '["2026-07-20","2026-07-21"]'::jsonb, '08/05/2026');
-- EXPECT: false   <- this is the defect, fixed
select active, reason from public.employee_suspensions where employee_code = 'ZZ VOIDTEST';
-- EXPECT: active=false, reason='probe - 9 consecutive days'  <- closed, but the facts are current

-- 7g. release, and confirm it can open again
select public.awol_release_mute('ZZ VOIDTEST', 'PASSCODE_HERE', 'probe-admin');
-- EXPECT: {"ok": true, ...}
select public.awol_set_suspended('ZZ VOIDTEST', 'probe - after release', '["2026-08-03"]'::jsonb, '08/05/2026');
-- EXPECT: true

-- 7h. the audit trail reads as a story
select event, actor, note, at from public.awol_events
 where employee_code = 'ZZ VOIDTEST' order by at asc;
-- EXPECT, in order: detected · voided (actor probe-admin) · mute_released · detected

-- 7i. TEARDOWN. Every identity a test writes as.
select set_config('awol.void_authorized', '1', true);
delete from public.awol_events          where employee_code = 'ZZ VOIDTEST';
delete from public.employee_suspensions where employee_code = 'ZZ VOIDTEST';
select count(*) as voidtest_must_be_0 from public.employee_suspensions where employee_code = 'ZZ VOIDTEST';
-- EXPECT: 0


-- ── STEP 8 — the live instance: mute RSR 0015 ────────────────────────────────
-- RUN THIS ONLY AFTER STEPS 6 AND 7 BOTH PASSED, and only if you still mean to void his case.
-- This is a real disciplinary record, not a probe. It is 'counted_wrong' because the 08/04 count of
-- 10 days included 07/24 and 07/25, on both of which he clocked in at Carmen — the case was a data
-- error, which is exactly what that reason means.
-- Replace the passcode. Nothing else in this file writes to a real worker.
--
-- select public.awol_void_case('RSR 0015', 'PASSCODE_HERE', 'counted_wrong', 'Owner',
--                              'Voided 08/03 by hand; the 10-day count included days he worked. Muted so the sweep stops re-opening it.');
-- EXPECT: {"ok": true, ...}
--
-- Then confirm, and confirm it is the only muted case:
-- select employee_code, active, voided_at is not null as muted, voided_by, voided_reason, reason
--   from public.employee_suspensions where voided_at is not null;


-- ── STEP 9 — FINAL VERIFY ────────────────────────────────────────────────────
select (select count(*) from information_schema.columns
         where table_schema='public' and table_name='employee_suspensions'
           and column_name in ('voided_at','voided_by','voided_reason','voided_note')) as mute_cols_must_be_4,
       (select count(*) from pg_trigger
         where tgname='employee_suspensions_void_guard_biu' and not tgisinternal)      as void_guard_must_be_1,
       (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname in ('awol_void_case','awol_release_mute')) as new_rpcs_must_be_2,
       (select count(*) from information_schema.column_privileges
         where grantee='anon' and table_schema='public' and table_name='employee_suspensions'
           and privilege_type='UPDATE')                                                as anon_update_cols_must_be_2,
       (select count(*) from public.employee_suspensions where employee_code like 'ZZ %') as probes_must_be_0;

-- PostgREST caches the schema; without this the new columns and RPCs 404 from the browser and the
-- dashboard looks broken for no reason.
notify pgrst, 'reload schema';

-- ── PERSISTENCE CHECK (standing rule — a 2026-07-31 install vanished from both projects) ──
-- CLOSE this editor tab, open a FRESH one, and re-run STEP 9 alone. All five numbers must still
-- read 4 / 1 / 2 / 2 / 0. Only then is this migration real.
