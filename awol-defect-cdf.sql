-- ═══════════════════════════════════════════════════════════════════════════════════════════
--  DEFECTS C + D + F — separate case-open from worker-barred, site gate, non-punching category
--  Spec: docs/superpowers/specs/2026-07-30-awol-detector-preconditions-and-defects-rev2.md
--  Owner-approved 2026-07-30. Additive + idempotent. Run one STEP at a time, paste results back.
--
--  DEFECT C, in one line: today the kiosk punch gate reads employee_suspensions.active, which the
--  sweep writes. So a machine decision bars a man. After this, the gate reads barred_at, which ONLY
--  a PIN-gated human action can set, and the sweep has no path to it.
--
--  WHY THE RENAME IS NOT IN THIS FILE (owner told 2026-07-30):
--  Spec §3.5 asks for active -> case_open in this change. Renaming the column breaks EIGHT RPC
--  bodies in awol-reinstate-flow.sql and awol-suspensions.sql, which would have to be regenerated
--  in the same paste. The hazard is not the NAME — it is that the kiosk reads a sweep-writable
--  field. barred_at removes that completely, which demotes the rename to a clarity change that can
--  be done deliberately as its own step. `active` keeps its current meaning here: case open.
--
--  SPLIT OF ENFORCEMENT, deliberate:
--    pakyaw           refused at BOTH app and DB layers (existing, unchanged)
--    non-punching     refused at BOTH layers          (Defect F, spec §8 asks for both)
--    site-no-kiosk    APP layer only                  (Defect D)
--  Reason: a site without a kiosk must not be DETECTED, but the owner must still be able to
--  suspend such a worker by hand for a real disciplinary matter. A DB refusal would block that.
-- ═══════════════════════════════════════════════════════════════════════════════════════════


-- ── STEP 0 — CENSUS (read-only, run first) ──────────────────────────────────────────────────
select (select count(*) from public.employee_suspensions)                    as susp_rows,
       (select count(*) from public.employee_suspensions where active)       as case_open_rows,
       (select count(*) from public.awol_events)                             as event_rows,
       (select count(*) from public.employees where employment_type='pakyaw') as pakyaw;
-- EXPECT: 0 · 0 · 0 · 5   (an empty suspensions table is why this migration is cheap today)

select distinct site, count(*) as rows_ever
  from public.attendance_records group by site order by site;
-- EXPECT: Carmen only. Mandaue has never produced a row — that is Defect D.


-- ── STEP 1 — worker-barred, as its own field ────────────────────────────────────────────────
-- Nullable timestamp, not a boolean: "when" and "who" come free, and "never barred" is the
-- zero-migration default. No backfill — nobody is barred at cutover, which is the safe state.
alter table public.employee_suspensions
  add column if not exists barred_at timestamptz,
  add column if not exists barred_by text;

select column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema='public' and table_name='employee_suspensions'
   and column_name in ('barred_at','barred_by')
 order by column_name;
-- EXPECT: barred_at | timestamp with time zone | YES
--         barred_by | text                     | YES


-- ── STEP 2 — the guard. barred_at is settable ONLY through the PIN-gated RPC. ────────────────
-- Column grants alone are not enough: a `security definer` RPC runs as owner and bypasses them.
-- So authorization is a TRANSACTION-LOCAL flag that only awol_set_barred() sets. Any other path
-- — direct REST, a hand-typed UPDATE, or a future RPC that forgets — raises.
create or replace function public.employee_suspensions_bar_guard()
returns trigger language plpgsql as $$
begin
  if (tg_op = 'INSERT' and new.barred_at is not null)
     or (tg_op = 'UPDATE' and new.barred_at is distinct from old.barred_at) then
    if coalesce(current_setting('awol.bar_authorized', true), '') <> '1' then
      raise exception
        'barred_at may only be changed by awol_set_barred() (PIN-gated). Refused for %.',
        new.employee_code
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists employee_suspensions_bar_guard_biu on public.employee_suspensions;
create trigger employee_suspensions_bar_guard_biu
  before insert or update on public.employee_suspensions
  for each row execute function public.employee_suspensions_bar_guard();

-- Belt-and-braces on top of the trigger: take away anon's blanket UPDATE and hand back ONLY the
-- one column pair the client legitimately writes.
--
-- WHY NOT `revoke update (barred_at, barred_by)`: awol-suspensions.sql:23 grants TABLE-LEVEL update
-- to anon, and in PostgreSQL a column-level revoke cannot subtract from a table-level grant. That
-- statement would have parsed, run, changed nothing, and sat in this file looking like protection.
-- The only way to restrict is to revoke the table grant and re-grant per column.
--
-- The single legitimate client write is kiosk/index.html:2412, stamping the Telegram message id
-- after an alert. Every other write goes through a `security definer` RPC (awol_set_suspended,
-- awol_letter_received, awol_admin_decide, awol_manual_suspend, awol_cancel_leave_approved,
-- awol_set_barred) which runs as owner and is unaffected by anon's grants — verified before
-- writing this.
-- INSERT is deliberately left alone: a direct insert can open a case, which after Defect C gates
-- nothing. Narrowing it is a separate change with its own blast radius.
revoke update on public.employee_suspensions from anon, authenticated;
grant  update (awol_group_msg_id, awol_group_chat) on public.employee_suspensions to anon, authenticated;

select count(*) as bar_guard_trigger_must_be_1
  from pg_trigger where tgname='employee_suspensions_bar_guard_biu' and not tgisinternal;
-- EXPECT: 1

-- Prove the grant actually narrowed. anon must hold UPDATE on exactly the two message columns.
select column_name
  from information_schema.column_privileges
 where grantee='anon' and table_schema='public' and table_name='employee_suspensions'
   and privilege_type='UPDATE'
 order by column_name;
-- EXPECT exactly two rows: awol_group_chat, awol_group_msg_id
-- If barred_at or barred_by appears here, the revoke did not take — STOP.


-- ── STEP 3 — DEFECT F: the non-punching category ────────────────────────────────────────────
-- Jamaica is office-based and her rows are maintained by hand. No threshold makes detection
-- meaningful for her, and she is the one person who must never be locked out — she performs the
-- letter-received step of the reinstate flow.
alter table public.employees
  add column if not exists is_non_punching boolean not null default false,
  add column if not exists non_punching_set_by text,
  add column if not exists non_punching_set_at timestamptz;

-- GUARD FIRST. Without this the RPC is decoration: `employees` has table-level UPDATE granted to
-- anon (never granted in tracked SQL — it is a Supabase default), and PostgreSQL cannot subtract a
-- single column from a table-level grant. So anyone holding the published anon key could set
-- is_non_punching = true on their own row by direct REST and exempt themselves from AWOL detection
-- entirely. That is the exact mirror of the barred_at hole.
--
-- A blanket `revoke update on employees` is NOT the answer here and would break production the
-- moment it ran. Deployed main writes to this table from coordinator.js:27/33/37 (personnel form),
-- home.js:44/185/188/240 (salary, PIN, balances) and kiosk/index.html:5268/5270/5272 (employee
-- sync). Restricting by grant would mean re-granting ~24 columns individually and getting every one
-- right, with live pay and personnel screens as the blast radius. The trigger achieves the same
-- guarantee with none of that risk, exactly as it does for barred_at.
-- Column-level narrowing of `employees` is worth doing as its own change — note that `pin` is one of
-- those columns, so it belongs with the plaintext-PIN spec already on the out-of-scope list.
-- Covers TWO authorization columns, added 2026-07-30 on the owner's instruction:
--   is_non_punching  — AWOL exemption
--   is_awol_clerk    — who may perform the letter-received step of the disciplinary process
-- is_awol_clerk is guarded here because NOTHING in the client writes it: the only writer in the
-- repo is a one-time seed (awol-reinstate-flow.sql:389-390) and it is read by awol_clerk_for_pin.
-- So closing it costs nothing and stops self-appointment to a disciplinary role.
--
-- is_issuer is deliberately NOT guarded. home.js:1275 toggles it with a direct client update
-- (the dashboard Issuers card), so a trigger would break a live feature tonight. It needs its own
-- RPC plus a client change and belongs with 2026-07-30-anon-grant-surface-on-employees.md.
create or replace function public.employees_flag_guard()
returns trigger language plpgsql as $$
declare v_col text;
begin
  if (tg_op = 'INSERT' and new.is_non_punching is true)
     or (tg_op = 'UPDATE' and new.is_non_punching is distinct from old.is_non_punching) then
    v_col := 'is_non_punching';
  elsif (tg_op = 'INSERT' and new.is_awol_clerk is true)
     or (tg_op = 'UPDATE' and new.is_awol_clerk is distinct from old.is_awol_clerk) then
    v_col := 'is_awol_clerk';
  end if;

  if v_col is not null
     and coalesce(current_setting('awol.employee_flag_authorized', true), '') <> '1' then
    raise exception
      '% may only be changed by its PIN-gated RPC (set_non_punching / set_awol_clerk). Refused for %.',
      v_col, new.code
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

drop trigger if exists employees_non_punching_guard_biu on public.employees;
drop trigger if exists employees_flag_guard_biu on public.employees;
create trigger employees_flag_guard_biu
  before insert or update on public.employees
  for each row execute function public.employees_flag_guard();

-- With is_awol_clerk guarded there must be a legitimate way to change it, or the only route left
-- is raw SQL. Same shape as set_non_punching: PIN inside, actor recorded, audit row written.
create or replace function public.set_awol_clerk(
  p_code text, p_passcode text, p_value boolean,
  p_actor text default 'Admin', p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_norm  text := upper(regexp_replace(coalesce(p_code,''), '[^A-Za-z0-9]', '', 'g'));
        v_actor text := coalesce(nullif(btrim(p_actor), ''), 'Admin');
        v_code  text;
begin
  if public.admin_verify_passcode(p_passcode) is not true then
    return jsonb_build_object('ok', false, 'reason', 'Not authorised');
  end if;
  select code into v_code from public.employees where code_norm = v_norm;
  if v_code is null then
    return jsonb_build_object('ok', false, 'reason', 'No employee matches ' || coalesce(p_code,'null'));
  end if;
  perform set_config('awol.employee_flag_authorized', '1', true);
  update public.employees set is_awol_clerk = p_value where code_norm = v_norm;
  insert into public.awol_events (employee_code, event, actor, note)
  values (v_code, case when p_value then 'awol_clerk_set' else 'awol_clerk_cleared' end, v_actor, p_note);
  return jsonb_build_object('ok', true, 'employee_code', v_code, 'is_awol_clerk', p_value, 'by', v_actor);
end $$;
grant execute on function public.set_awol_clerk(text, text, boolean, text, text) to anon, authenticated;

-- PIN-gated, audited. Same posture as every other decision that changes what the system does.
-- p_actor is WHO decided. It lands in BOTH non_punching_set_by and the awol_events actor column,
-- so the audit row names a person rather than the literal string 'Admin'.
create or replace function public.set_non_punching(
  p_code text, p_passcode text, p_value boolean,
  p_actor text default 'Admin', p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_norm  text := upper(regexp_replace(coalesce(p_code,''), '[^A-Za-z0-9]', '', 'g'));
        v_actor text := coalesce(nullif(btrim(p_actor), ''), 'Admin');
        v_code  text;
begin
  if public.admin_verify_passcode(p_passcode) is not true then
    return jsonb_build_object('ok', false, 'reason', 'Not authorised');
  end if;
  select code into v_code from public.employees where code_norm = v_norm;
  if v_code is null then
    return jsonb_build_object('ok', false, 'reason', 'No employee matches ' || coalesce(p_code,'null'));
  end if;

  -- Authorise for THIS transaction only. The trigger above checks this flag.
  perform set_config('awol.employee_flag_authorized', '1', true);

  update public.employees
     set is_non_punching = p_value,
         non_punching_set_by = v_actor,
         non_punching_set_at = now()
   where code_norm = v_norm;
  insert into public.awol_events (employee_code, event, actor, note)
  values (v_code, case when p_value then 'non_punching_set' else 'non_punching_cleared' end,
          v_actor, p_note);
  return jsonb_build_object('ok', true, 'employee_code', v_code,
                            'is_non_punching', p_value, 'by', v_actor);
end $$;
grant execute on function public.set_non_punching(text, text, boolean, text, text) to anon, authenticated;


-- ── STEP 4 — DEFECT D: site capture status. EXPLICIT config, never inferred. ─────────────────
-- Spec §6: "Site status must be explicit configuration a person sets, never inferred from row
-- counts — a quiet yard and a broken yard look identical from the data." Honoured: this is a
-- table a human edits. Nothing derives it.
create table if not exists public.site_capture_status (
  site        text primary key,
  has_kiosk   boolean not null default false,
  note        text,
  updated_at  timestamptz not null default now(),
  updated_by  text
);
grant select on public.site_capture_status to anon, authenticated;
revoke insert, update, delete on public.site_capture_status from anon, authenticated;

insert into public.site_capture_status (site, has_kiosk, note, updated_by) values
  ('Carmen',  true,  'Kiosk commissioned and healthy — absences here carry real signal.', 'setup 2026-07-30'),
  ('Mandaue', false, 'Kiosk never commissioned; enclosure still to be fabricated. Detection OFF.', 'setup 2026-07-30')
on conflict (site) do nothing;

-- Which site does a worker ACTUALLY work at? NOT home_site — RSR 0014 is listed Mandaue and works
-- at Carmen (Defect H, out of scope). Keying the gate on home_site would exempt a Carmen worker
-- whose yard's kiosk is fine, invisibly. So: the site that captured his most recent real punch,
-- falling back to home_site only when he has never punched anywhere.
-- date is TEXT in MIXED formats, so ordering goes through leave_try_date(), never the raw string.
create or replace function public.awol_effective_site(p_code text)
returns text language sql stable as $$
  select coalesce(
    (select a.site
       from public.attendance_records a
      where upper(regexp_replace(a.employee_code,'[^A-Za-z0-9]','','g'))
            = upper(regexp_replace(coalesce(p_code,''),'[^A-Za-z0-9]','','g'))
        and a.timein is not null and a.timein <> '(auto-skipped)' and a.site is not null
      order by public.leave_try_date(a.date) desc nulls last
      limit 1),
    (select e.home_site from public.employees e
      where e.code_norm = upper(regexp_replace(coalesce(p_code,''),'[^A-Za-z0-9]','','g')))
  );
$$;
grant execute on function public.awol_effective_site(text) to anon, authenticated;


-- ── STEP 5 — one exemption authority for the sweep and the DB guard ─────────────────────────
-- Extends the pakyaw check rather than adding a parallel one, so there is a single answer to
-- "may this man be detected". awol_is_pem() keeps its name and its meaning (pakyaw only) because
-- the existing suspension trigger and two RPCs call it.
create or replace function public.awol_is_exempt(p_code text)
returns boolean language sql stable as $$
  select public.awol_is_pem(p_code)
      or coalesce((select e.is_non_punching from public.employees e
                    where e.code_norm = upper(regexp_replace(coalesce(p_code,''),'[^A-Za-z0-9]','','g'))), false);
$$;
grant execute on function public.awol_is_exempt(text) to anon, authenticated;

-- Detection-only exemption, which ADDS the site gate. The kiosk sweep calls this one.
-- Kept separate from awol_is_exempt so the DB guard never refuses a MANUAL suspension on
-- site grounds — the owner must still be able to act on a Mandaue worker by hand.
-- NOTE the placement of `not`: OUTSIDE the coalesce, deliberately. An unconfigured or unknown
-- site — 'TEST-SITE' (17 attendance rows exist), a newly opened yard, or a null effective site —
-- makes the subquery return NULL. With `coalesce(not has_kiosk, false)` that becomes false and the
-- worker is DETECTED: fail-closed, a man judged on a site nobody has configured. With the `not`
-- outside, NULL becomes skip: fail-open, and he shows up in the health banner instead.
--   has_kiosk true  -> not true  -> false -> detect
--   has_kiosk false -> not false -> true  -> skip   (Mandaue: no kiosk)
--   site unknown    -> not false -> true  -> skip   (fail open, surfaced)
create or replace function public.awol_skip_detection(p_code text)
returns boolean language sql stable as $$
  select public.awol_is_exempt(p_code)
      or not coalesce((select s.has_kiosk
                         from public.site_capture_status s
                        where s.site = public.awol_effective_site(p_code)), false);
$$;

-- Companion for the health banner: WHY a worker is being skipped, so a skip is never silent.
-- Returns null when he is not skipped at all.
create or replace function public.awol_skip_reason(p_code text)
returns text language sql stable as $$
  select case
    when public.awol_is_pem(p_code) then 'pakyaw'
    when coalesce((select e.is_non_punching from public.employees e
                    where e.code_norm = upper(regexp_replace(coalesce(p_code,''),'[^A-Za-z0-9]','','g'))), false)
         then 'non-punching'
    when public.awol_effective_site(p_code) is null then 'no site known'
    when not exists (select 1 from public.site_capture_status s
                      where s.site = public.awol_effective_site(p_code))
         then 'site not configured: ' || public.awol_effective_site(p_code)
    when not (select s.has_kiosk from public.site_capture_status s
               where s.site = public.awol_effective_site(p_code))
         then 'no kiosk at ' || public.awol_effective_site(p_code)
    else null end;
$$;
grant execute on function public.awol_skip_reason(text) to anon, authenticated;
grant execute on function public.awol_skip_detection(text) to anon, authenticated;

-- The DB guard now refuses pakyaw AND non-punching. Site is NOT included, by design (see header).
create or replace function public.employee_suspensions_no_pem_trg()
returns trigger language plpgsql as $$
begin
  if public.awol_is_exempt(new.employee_code) then
    raise exception 'Worker % is exempt from AWOL (pakyaw or non-punching) and cannot be suspended',
      new.employee_code using errcode = 'check_violation';
  end if;
  return new;
end $$;


-- ── STEP 6 — bar / unbar. The only door. Passcode verified INSIDE, first. ───────────────────
-- One function both directions so the audit is symmetric and there is one implementation of
-- "who barred or unbarred this man, when, and why".
-- p_bar = true  -> bar   (PIN-gated human decision, never the sweep)
-- p_bar = false -> UNBAR (the minimal reinstate path, spec §3.4)
-- No exception block by design: any failure rolls back the whole thing, including the event row.
-- p_actor is WHO decided; p_note is WHY. barred_by gets the actor. An earlier draft put the note in
-- barred_by, which would have made a disciplinary record answer the wrong question.
-- MUST be created AFTER awol_is_exempt() and employees.is_non_punching exist - it calls both.
create or replace function public.awol_set_barred(
  p_code text, p_passcode text, p_bar boolean,
  p_actor text default 'Admin', p_note text default null)
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

  if p_bar and public.awol_is_exempt(v_row.employee_code) then
    return jsonb_build_object('ok', false, 'reason',
      'Exempt worker — cannot be barred: ' || v_row.employee_code);
  end if;

  -- Authorise for THIS transaction only, then write. The trigger checks this flag.
  perform set_config('awol.bar_authorized', '1', true);

  update public.employee_suspensions
     set barred_at = case when p_bar then now() else null end,
         barred_by = case when p_bar then v_actor else null end,
         updated_at = now()
   where employee_code = v_row.employee_code;

  insert into public.awol_events (employee_code, event, actor, note)
  values (v_row.employee_code, case when p_bar then 'barred' else 'unbarred' end, v_actor, p_note);

  return jsonb_build_object('ok', true, 'employee_code', v_row.employee_code,
                            'barred', p_bar, 'at', now());
end $$;
grant execute on function public.awol_set_barred(text, text, boolean, text, text) to anon, authenticated;


-- ── STEP 7 — VERIFY the three defects, read-only ────────────────────────────────────────────
select public.awol_effective_site('RSR 0014') as art_must_be_Carmen,      -- home_site corrected 07-30
       public.awol_effective_site('RSR 0011') as galo_must_be_Mandaue,    -- never punched -> home_site
       public.awol_skip_detection('RSR 0011') as galo_skipped_must_be_true,
       public.awol_skip_detection('RSR 0014') as art_skipped_must_be_FALSE,
       public.awol_skip_detection('RSR 0015') as nino_skipped_must_be_FALSE;
-- EXPECT: Carmen · Mandaue · true · false · false
-- art_skipped = false is the one to read: Defect D must NOT swallow a Carmen worker. If it returns
-- true, the gate is keyed on the wrong thing.

-- The four no-history Mandaue men: home_site is genuinely the only signal, and D must SKIP them
-- rather than fall through to detected. Owner asked this explicitly 2026-07-30.
select code, public.awol_effective_site(code) as effective_site,
       public.awol_skip_detection(code) as skipped, public.awol_skip_reason(code) as reason
  from public.employees
 where code in ('RSR 0011','RSR 0018','RSR 0023','RSR 0034') order by code;
-- EXPECT all four: effective_site Mandaue · skipped TRUE · reason 'no kiosk at Mandaue'

-- Fail-open proof for an UNKNOWN site. TEST-SITE has 17 attendance rows and is not a real yard.
select public.awol_skip_detection('ZZ NOSITE') as unknown_must_skip_true,
       public.awol_skip_reason('ZZ NOSITE')    as unknown_reason;
-- EXPECT: true · 'no site known'   (a worker whose site cannot be determined is never judged)

-- Nobody should be skipped for a reason you did not intend. Read this list.
select code, name, public.awol_skip_reason(code) as skip_reason
  from public.employees
 where separated_at is null and public.awol_skip_detection(code)
 order by skip_reason, code;
-- EXPECT: 5 pakyaw · RSR 0025 non-punching · the Mandaue men. Nothing else.

select code, name, is_non_punching from public.employees where code = 'RSR 0025';
-- EXPECT: is_non_punching = false for now. Setting it is STEP 8, a separate deliberate action.


-- ── STEP 8 — mark Jamaica non-punching (Defect F, the live instance) ───────────────────────
-- REPLACE 'PASSCODE_HERE' in the editor. Do NOT save the passcode into this file.
select public.set_non_punching('RSR 0025', 'PASSCODE_HERE', true, 'Raffy',
       'Office-based, does not use the kiosk; attendance maintained by hand. Sole AWOL clerk.');
-- EXPECT: {"ok": true, "employee_code": "RSR 0025", "is_non_punching": true}

select code, name, is_non_punching, non_punching_set_at from public.employees where code='RSR 0025';
-- EXPECT: is_non_punching = true, timestamp set


-- ── STEP 9 — C1: PROVE a sweep-written row cannot reach the punch gate ─────────────────────
-- 9a. A hand-typed UPDATE without the flag must RAISE.
insert into public.employee_suspensions (employee_code, active, reason, suspended_on)
values ('ZZ BARTEST', true, 'C1 probe - case open only', '07/30/2026');

begin;
  update public.employee_suspensions set barred_at = now() where employee_code = 'ZZ BARTEST';
rollback;
-- EXPECT: ERROR - barred_at may only be changed by awol_set_barred() (PIN-gated). Refused.
-- If this SUCCEEDS, stop: the guard is not working and no client change may ship.

-- 9b. The case is open and the man is NOT barred — the whole point of Defect C.
select employee_code, active as case_open, barred_at, barred_by
  from public.employee_suspensions where employee_code = 'ZZ BARTEST';
-- EXPECT: case_open = true · barred_at NULL · barred_by NULL

-- 9c. The PIN-gated path DOES work, both directions. Replace the passcode in the editor.
select public.awol_set_barred('ZZ BARTEST', 'PASSCODE_HERE', true,  'C1 probe - bar');
select employee_code, barred_at is not null as now_barred from public.employee_suspensions where employee_code='ZZ BARTEST';
-- EXPECT: ok true, then now_barred = true

select public.awol_set_barred('ZZ BARTEST', 'PASSCODE_HERE', false, 'C1 probe - reinstate');
select employee_code, barred_at, barred_by from public.employee_suspensions where employee_code='ZZ BARTEST';
-- EXPECT: ok true, then barred_at NULL and barred_by NULL — the minimal reinstate path (§3.4)

-- 9d. Wrong passcode must refuse and change nothing.
select public.awol_set_barred('ZZ BARTEST', 'wrong-passcode', true, 'C1 probe - must refuse');
-- EXPECT: {"ok": false, "reason": "Not authorised"}

-- 9e. TEARDOWN of the probe row. Every identity a test writes as, per spec §14.
delete from public.awol_events          where employee_code = 'ZZ BARTEST';
delete from public.employee_suspensions where employee_code = 'ZZ BARTEST';
select count(*) as bartest_must_be_0 from public.employee_suspensions where employee_code='ZZ BARTEST';
-- EXPECT: 0


-- ── STEP 10 — FINAL VERIFY ──────────────────────────────────────────────────────────────────
select (select count(*) from information_schema.columns
         where table_name='employee_suspensions' and column_name in ('barred_at','barred_by'))   as new_cols_must_be_2,
       (select count(*) from pg_trigger
         where tgname='employee_suspensions_bar_guard_biu' and not tgisinternal)                 as bar_guard_must_be_1,
       (select count(*) from pg_proc where proname in
          ('awol_set_barred','set_non_punching','awol_effective_site','awol_is_exempt','awol_skip_detection')) as new_fns_must_be_5,
       (select count(*) from public.site_capture_status)                                         as sites_must_be_2,
       (select count(*) from public.site_capture_status where has_kiosk)                         as with_kiosk_must_be_1,
       (select count(*) from public.employees where is_non_punching)                             as non_punching_must_be_1,
       (select count(*) from public.employee_suspensions where barred_at is not null)            as barred_must_be_0;
-- EXPECT: 2 · 1 · 5 · 2 · 1 · 1 · 0
-- barred_must_be_0 is the line that matters: nobody is barred, and from here only a PIN-gated
-- human action can change that.

-- ── STEP 11 — batch skip list, and a way to see it fail ─────────────────────────────────────
-- WHY BATCH: the sweep iterates every employee. Calling awol_skip_detection() per worker is 43
-- REST round trips on every kiosk boot — seconds on yard wifi, on the boot path of a tablet that
-- has to stay responsive for punching. And the client CANNOT compute it locally: awol_effective_site
-- needs each worker's most recent punch across ALL sites, and a Carmen tablet only holds Carmen's
-- records. So one call returns the whole list.
--
-- Returns EVERY active employee with skip true/false, not just the exempt ones. That is deliberate:
-- it makes an empty result unambiguously a FAILURE rather than a legitimate "nobody is exempt".
create or replace function public.awol_skip_list()
returns table (code text, skip boolean, reason text)
language sql stable as $$
  select e.code,
         public.awol_skip_detection(e.code),
         public.awol_skip_reason(e.code)
    from public.employees e
   where e.separated_at is null
   order by e.code;
$$;
grant execute on function public.awol_skip_list() to anon, authenticated;

-- Owner requirement 2026-07-30: if awol_skip_list() errors OR returns nothing, the sweep must skip
-- detection ENTIRELY for that boot rather than treat everyone as detectable. An empty list read as
-- "nobody is exempt" would flag all 43 workers including the five pakyaw men and Jamaica.
-- Fail open — and the failure must not be invisible, so it rides the heartbeat to the dashboard the
-- same way unknown_type_count does. A LEVEL, not an event: the sweep rewrites it every run, so a
-- recovered tablet reports false and the banner clears itself.
alter table public.kiosk_health
  add column if not exists detection_skipped boolean not null default false;

-- ── STEP 11 VERIFY ──────────────────────────────────────────────────────────────────────────
select count(*) as rows_must_be_43_ish,
       count(*) filter (where skip)     as skipped_must_be_10,
       count(*) filter (where not skip) as detectable
  from public.awol_skip_list();
-- EXPECT: ~43 · 10 · ~33   (10 = five pakyaw + Jamaica + four Mandaue men)

select code, reason from public.awol_skip_list() where skip order by reason, code;
-- EXPECT exactly 10 rows. Read the reasons — nobody should be skipped for a reason you did not
-- intend. Any Carmen worker other than RSR 0025 appearing here means the site gate is wrong.

select code, skip, reason from public.awol_skip_list()
 where code in ('RSR 0015','RSR 0005','RSR 0014');
-- EXPECT all three skip = false, reason NULL. These are Z1's expected three flags: RSR 0015 is the
-- genuine AWOL control, RSR 0005 needs Defect E, RSR 0014 needs Defect G. If any is skipped, the
-- C+D+F scope has gone too far.

select column_name, data_type, column_default
  from information_schema.columns
 where table_schema='public' and table_name='kiosk_health' and column_name='detection_skipped';
-- EXPECT: detection_skipped | boolean | false
