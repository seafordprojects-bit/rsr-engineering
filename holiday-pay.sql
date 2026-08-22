-- ═══════════════════════════════════════════════════════════════════════════════════════════
--  HOLIDAY PAY — holidays, holiday_override, holiday_audit + the four passcode-gated RPCs
--
--  STATUS: NOT APPLIED. Written for the owner to run in the Supabase SQL editor.
--  Rollback ships with it: holiday-pay-rollback.sql (standing rule, owner 2026-08-04).
--  Spec: docs/superpowers/specs/2026-08-12-holiday-pay.md
--
--  WHAT THIS CREATES
--    public.holidays           — one row per declared holiday. READ by payroll, written only by RPC.
--    public.holiday_override   — per worker, per holiday: the owner granting pay to a man who did
--                                not qualify. Append-once, one row per (worker, holiday).
--    public.holiday_audit      — append-only. Every add/edit/delete/override, with before and after.
--    holiday_add / holiday_edit / holiday_delete / holiday_override_set
--
--  WHAT THIS DOES NOT TOUCH
--    attendance_records, attendance_edit_audit, attendance_day_lock, employees, settings, leave_*.
--    No existing table is altered. No existing row is written. Payroll history cannot move.
--
--  THE OWNER'S PAY DECISIONS, 2026-08-15 (these are WHY the numbers below are what they are)
--    Q1 qualifying day  = the day the yard last ran. Walk back from the holiday past Sundays and
--                         past other holidays until a day somebody actually punched.
--    Q2 holiday on Sun  = STACKED. Regular holiday on a rest day = 260%, per DOLE.
--    Q3 partial day     = the full holiday day rate, less the undertime the payroll already deducts.
--    Q4 holiday OT      = the holiday-adjusted rate (regular holiday OT ×2.60), per DOLE.
-- ═══════════════════════════════════════════════════════════════════════════════════════════


-- ── STEP 0 — WHICH DATABASE AM I IN? ────────────────────────────────────────────────────────
-- TWO LIVE SUPABASE PROJECTS ARE OPEN IN ONE BROWSER WITH IDENTICAL EDITORS.
-- A wrong-project READ errors or misleads. A wrong-project WRITE SUCCEEDS SILENTLY — and this file
-- is a write. Demonstrated live 2026-08-03.
--   1. CLOSE THE OTHER PROJECT'S TAB FIRST. It is the only reliable guard.
--   2. Confirm from INSIDE this tab, never from its title.
--   3. The canary errors immediately in the inventory project. If 0b errors, STOP.

-- 0a. Name the database.
select current_database();

-- 0b. CANARY — must return a row count. An error here means WRONG PROJECT.
select count(*) as attendance_rows_must_be_nonzero from public.attendance_records;

-- 0c. Dependencies this file assumes are already live. All three must be non-null.
select to_regproc('public.admin_verify_passcode(text)') as admin_gate_must_exist,
       to_regproc('public.att_date_iso(text)')          as date_normaliser_must_exist,
       to_regclass('public.attendance_day_lock')        as day_lock_must_exist;

-- 0d. Prove the new objects are NOT there yet. Expect all NULL on a first run.
select to_regclass('public.holidays')          as holidays_must_be_null,
       to_regclass('public.holiday_override')  as overrides_must_be_null,
       to_regclass('public.holiday_audit')     as audit_must_be_null;


-- ── STEP 1 — THE TABLES ─────────────────────────────────────────────────────────────────────
begin;

-- 1a. holidays.
-- `date` is a REAL date, not TEXT. attendance_records.date is mixed-format TEXT and that is a
-- permanent landmine in this system; this table is new, so it starts clean. Comparisons against
-- attendance cross over through att_date_iso(), which normalises the ATTENDANCE side.
create table if not exists public.holidays (
  id         bigint generated always as identity primary key,
  date       date        not null,
  name       text        not null,
  type       text        not null,
  scope      text        not null default 'national',
  added_by   text,
  created_at timestamptz not null default now(),
  constraint holidays_type_chk  check (type  in ('regular','special_nonworking','special_working')),
  constraint holidays_scope_chk check (scope in ('national','local')),
  constraint holidays_name_chk  check (btrim(name) <> '')
);

-- Two holidays CAN share a date — a special non-working day is sometimes proclaimed on top of a
-- regular holiday — so the identity key is (date, name), case- and space-insensitive.
create unique index if not exists holidays_date_name_uniq
  on public.holidays (date, lower(btrim(name)));

-- ...but only ONE of them may be PAID. Two paid holidays on one date would double the premium with
-- no rule saying which wins. A special WORKING day carries no premium, so it is exempt and may sit
-- alongside anything.
create unique index if not exists holidays_one_paid_per_date
  on public.holidays (date)
  where type in ('regular','special_nonworking');

comment on table public.holidays is
  'Declared holidays. Read by payroll (payroll/index.html) and the admin dashboard. Written ONLY by
   holiday_add/holiday_edit/holiday_delete, which verify the admin passcode inside. Forward-only:
   payroll ignores any row dated before settings.payroll_cfg -> holidayPayFrom.';
comment on column public.holidays.type is
  'regular = 200% worked / 100% unworked-if-qualified. special_nonworking = 130% worked-if-qualified,
   nothing unworked. special_working = an ordinary day, no premium, no qualification test.';
comment on column public.holidays.scope is
  'RECORD ONLY as of 2026-08-15 (owner Q6). Payroll applies every holiday to every worker regardless
   of scope. Making local holidays site-specific would need a site column and a rule; neither exists.';

-- 1b. holiday_override — the owner granting the holiday to a man who did not qualify.
-- One row per (worker, holiday). Re-deciding UPDATES the row rather than stacking, so there is
-- exactly one live answer per worker-day and the audit carries the history.
create table if not exists public.holiday_override (
  id            bigint generated always as identity primary key,
  employee_code text        not null,
  holiday_date  date        not null,
  granted       boolean     not null default true,
  actor         text        not null default 'Owner',
  reason        text,
  at            timestamptz not null default now()
);

-- Codes drift by spacing and case across sources ('RSR 0015' vs 'RSR0015'). The expression is
-- copied character for character from employees.code_norm, this system's existing authority on
-- whether two spellings are the same man, so the two can never disagree.
create unique index if not exists holiday_override_uniq
  on public.holiday_override (upper(regexp_replace(employee_code, '[^A-Za-z0-9]', '', 'g')), holiday_date);

comment on table public.holiday_override is
  'Owner override of the holiday qualification test, per worker per holiday. granted=true pays the
   man the holiday he did not qualify for; granted=false records a deliberate refusal. Written only
   by holiday_override_set (passcode-gated). It grants the COMPUTED holiday amount — it is not a
   free-text peso figure; that is what payroll_adjustment is for.';

-- 1c. holiday_audit — append-only, same shape of guarantee as attendance_edit_audit.
create table if not exists public.holiday_audit (
  id           bigint generated always as identity primary key,
  action       text        not null,
  holiday_date date,
  holiday_name text,
  subject_code text,
  before_val   jsonb,
  after_val    jsonb,
  actor        text        not null default 'Owner',
  note         text,
  at           timestamptz not null default now(),
  constraint holiday_audit_action_chk check (action in ('add','edit','delete','override'))
);

create index if not exists idx_holiday_audit_date on public.holiday_audit (holiday_date);

-- Append-only guard. A disciplinary or pay record that can be rewritten is not evidence.
create or replace function public.block_holiday_audit_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'holiday_audit is append-only — % is not permitted', tg_op;
end $$;

drop trigger if exists trg_holiday_audit_no_mutation on public.holiday_audit;
create trigger trg_holiday_audit_no_mutation
  before update or delete on public.holiday_audit
  for each row execute function public.block_holiday_audit_mutation();

commit;


-- ── STEP 2 — GRANTS ─────────────────────────────────────────────────────────────────────────
-- READ-ONLY to the client on all three. Payroll must read holidays and overrides to compute; the
-- dashboard must read holidays and the audit to display. NOTHING gets insert/update/delete: the
-- ONLY doors are the RPCs in STEP 3, and a table anon can write directly is not gated at all.
-- (This is the attendance_day_lock lesson: `revoke update` is what makes "insert-once" true.)
begin;

grant select on public.holidays         to anon, authenticated;
grant select on public.holiday_override to anon, authenticated;
grant select on public.holiday_audit    to anon, authenticated;

revoke insert, update, delete on public.holidays         from anon, authenticated;
revoke insert, update, delete on public.holiday_override from anon, authenticated;
revoke insert, update, delete on public.holiday_audit    from anon, authenticated;

commit;


-- ── STEP 3 — THE FOUR DOORS ─────────────────────────────────────────────────────────────────
-- Every one of these follows awol_void_case(), the house pattern for an admin act that changes a
-- record people are paid or judged by:
--   · security definer, search_path pinned
--   · cheap INPUT-SHAPE checks first (they leak nothing and let the verification script prove the
--     closed sets without ever holding a real passcode), THEN the passcode
--   · business refusals are RETURNED as {ok:false, reason:'…'}, never raised, so the dashboard can
--     show the owner a sentence instead of a Postgres error
--   · the database sends NO Telegram. It has no token and must not grow one — the dashboard sends
--     after a successful return, and says so plainly if the send fails.
begin;

-- 3a. ADD.
create or replace function public.holiday_add(
  p_date text, p_name text, p_type text, p_scope text,
  p_passcode text, p_actor text default 'Owner')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor text := coalesce(nullif(btrim(p_actor), ''), 'Owner');
  v_name  text := btrim(coalesce(p_name, ''));
  v_type  text := lower(btrim(coalesce(p_type, '')));
  v_scope text := lower(btrim(coalesce(p_scope, 'national')));
  v_date  date;
  v_row   public.holidays%rowtype;
begin
  if v_type not in ('regular','special_nonworking','special_working') then
    return jsonb_build_object('ok', false, 'reason',
      'Unknown holiday type — it must be regular, special_nonworking or special_working');
  end if;
  if v_scope not in ('national','local') then
    return jsonb_build_object('ok', false, 'reason', 'Scope must be national or local');
  end if;
  if v_name = '' then
    return jsonb_build_object('ok', false, 'reason', 'The holiday needs a name');
  end if;
  begin
    v_date := p_date::date;
  exception when others then
    return jsonb_build_object('ok', false, 'reason', 'That is not a valid date');
  end;

  if public.admin_verify_passcode(p_passcode) is not true then
    return jsonb_build_object('ok', false, 'reason', 'Not authorised');
  end if;

  -- Named refusals BEFORE the insert, so the owner reads a sentence rather than a constraint name.
  if exists (select 1 from public.holidays
              where date = v_date and lower(btrim(name)) = lower(v_name)) then
    return jsonb_build_object('ok', false, 'reason',
      v_name || ' is already recorded on ' || to_char(v_date, 'MM/DD/YYYY') || '.');
  end if;

  if v_type in ('regular','special_nonworking')
     and exists (select 1 from public.holidays
                  where date = v_date and type in ('regular','special_nonworking')) then
    return jsonb_build_object('ok', false, 'reason',
      to_char(v_date, 'MM/DD/YYYY') || ' already carries a paid holiday ('
      || (select name from public.holidays where date = v_date and type in ('regular','special_nonworking') limit 1)
      || '). Edit or delete that one first — two paid holidays on one day have no rule saying which wins.');
  end if;

  insert into public.holidays (date, name, type, scope, added_by)
  values (v_date, v_name, v_type, v_scope, v_actor)
  returning * into v_row;

  insert into public.holiday_audit (action, holiday_date, holiday_name, after_val, actor)
  values ('add', v_date, v_name, to_jsonb(v_row), v_actor);

  -- The dashboard sends the Telegram notice from these fields. Returned, not sent from here.
  return jsonb_build_object('ok', true, 'id', v_row.id, 'date', v_row.date,
                            'name', v_row.name, 'type', v_row.type, 'scope', v_row.scope);
end $$;
grant execute on function public.holiday_add(text, text, text, text, text, text) to anon, authenticated;


-- 3b. EDIT.
create or replace function public.holiday_edit(
  p_id bigint, p_date text, p_name text, p_type text, p_scope text,
  p_passcode text, p_actor text default 'Owner')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor text := coalesce(nullif(btrim(p_actor), ''), 'Owner');
  v_name  text := btrim(coalesce(p_name, ''));
  v_type  text := lower(btrim(coalesce(p_type, '')));
  v_scope text := lower(btrim(coalesce(p_scope, 'national')));
  v_date  date;
  v_old   public.holidays%rowtype;
  v_new   public.holidays%rowtype;
begin
  if v_type not in ('regular','special_nonworking','special_working') then
    return jsonb_build_object('ok', false, 'reason',
      'Unknown holiday type — it must be regular, special_nonworking or special_working');
  end if;
  if v_scope not in ('national','local') then
    return jsonb_build_object('ok', false, 'reason', 'Scope must be national or local');
  end if;
  if v_name = '' then
    return jsonb_build_object('ok', false, 'reason', 'The holiday needs a name');
  end if;
  begin
    v_date := p_date::date;
  exception when others then
    return jsonb_build_object('ok', false, 'reason', 'That is not a valid date');
  end;

  if public.admin_verify_passcode(p_passcode) is not true then
    return jsonb_build_object('ok', false, 'reason', 'Not authorised');
  end if;

  select * into v_old from public.holidays where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'That holiday no longer exists — reload the list.');
  end if;

  -- Moving a holiday OFF a closed day, or ON to one, both change what a settled week computes to.
  if exists (select 1 from public.attendance_day_lock l
              where l.date = to_char(v_old.date, 'YYYY-MM-DD')) then
    return jsonb_build_object('ok', false, 'reason',
      to_char(v_old.date, 'MM/DD/YYYY') || ' is already CLOSED — that week has been paid. Editing '
      || 'the holiday now would change what an already-paid week computes to.');
  end if;
  if v_date <> v_old.date
     and exists (select 1 from public.attendance_day_lock l
                  where l.date = to_char(v_date, 'YYYY-MM-DD')) then
    return jsonb_build_object('ok', false, 'reason',
      to_char(v_date, 'MM/DD/YYYY') || ' is already CLOSED — you cannot move a holiday on to a paid day.');
  end if;

  if exists (select 1 from public.holidays
              where date = v_date and lower(btrim(name)) = lower(v_name) and id <> p_id) then
    return jsonb_build_object('ok', false, 'reason',
      v_name || ' is already recorded on ' || to_char(v_date, 'MM/DD/YYYY') || '.');
  end if;

  if v_type in ('regular','special_nonworking')
     and exists (select 1 from public.holidays
                  where date = v_date and type in ('regular','special_nonworking') and id <> p_id) then
    return jsonb_build_object('ok', false, 'reason',
      to_char(v_date, 'MM/DD/YYYY') || ' already carries a paid holiday.');
  end if;

  update public.holidays
     set date = v_date, name = v_name, type = v_type, scope = v_scope
   where id = p_id
  returning * into v_new;

  insert into public.holiday_audit (action, holiday_date, holiday_name, before_val, after_val, actor)
  values ('edit', v_date, v_name, to_jsonb(v_old), to_jsonb(v_new), v_actor);

  return jsonb_build_object('ok', true, 'id', v_new.id, 'date', v_new.date,
                            'name', v_new.name, 'type', v_new.type, 'scope', v_new.scope,
                            'was_date', v_old.date, 'was_name', v_old.name, 'was_type', v_old.type);
end $$;
grant execute on function public.holiday_edit(bigint, text, text, text, text, text, text) to anon, authenticated;


-- 3c. DELETE — refused once that date's payroll has run.
-- "Payroll has run" = the day is CLOSED (a row in attendance_day_lock). Owner Q5, and the reason it
-- is the right marker: it already exists, the owner already performs it deliberately, and it
-- already means the pay day is final. Deleting a holiday on a closed day would silently change what
-- an already-paid week computes to — payroll stores no payslips and recomputes live every run.
create or replace function public.holiday_delete(
  p_id bigint, p_passcode text, p_actor text default 'Owner', p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor text := coalesce(nullif(btrim(p_actor), ''), 'Owner');
  v_row   public.holidays%rowtype;
  v_ovr   bigint;
begin
  if public.admin_verify_passcode(p_passcode) is not true then
    return jsonb_build_object('ok', false, 'reason', 'Not authorised');
  end if;

  select * into v_row from public.holidays where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'That holiday no longer exists — reload the list.');
  end if;

  if exists (select 1 from public.attendance_day_lock l
              where l.date = to_char(v_row.date, 'YYYY-MM-DD')) then
    return jsonb_build_object('ok', false, 'reason',
      to_char(v_row.date, 'MM/DD/YYYY') || ' is CLOSED — payroll for that day has already run. '
      || 'Deleting ' || v_row.name || ' now would change what an already-paid week computes to. '
      || 'If it was recorded in error, correct it with a payroll adjustment instead.');
  end if;

  select count(*) into v_ovr from public.holiday_override where holiday_date = v_row.date;
  if v_ovr > 0 then
    return jsonb_build_object('ok', false, 'reason',
      v_row.name || ' has ' || v_ovr || ' owner override(s) recorded against it. Deleting it would '
      || 'orphan them. Remove the overrides first if this holiday really was recorded in error.');
  end if;

  insert into public.holiday_audit (action, holiday_date, holiday_name, before_val, actor, note)
  values ('delete', v_row.date, v_row.name, to_jsonb(v_row), v_actor,
          nullif(btrim(coalesce(p_note, '')), ''));

  delete from public.holidays where id = p_id;

  return jsonb_build_object('ok', true, 'date', v_row.date, 'name', v_row.name, 'type', v_row.type);
end $$;
grant execute on function public.holiday_delete(bigint, text, text, text) to anon, authenticated;


-- 3d. OVERRIDE — grant (or deliberately refuse) the holiday to one man who did not qualify.
create or replace function public.holiday_override_set(
  p_code text, p_date text, p_granted boolean,
  p_passcode text, p_actor text default 'Owner', p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor  text := coalesce(nullif(btrim(p_actor), ''), 'Owner');
  v_norm   text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_date   date;
  v_hol    public.holidays%rowtype;
  v_old    public.holiday_override%rowtype;
  v_new    public.holiday_override%rowtype;
begin
  if v_norm = '' then
    return jsonb_build_object('ok', false, 'reason', 'No worker given');
  end if;
  if v_reason is null then
    return jsonb_build_object('ok', false, 'reason',
      'A reason is required — this is a pay decision and the record has to say why.');
  end if;
  begin
    v_date := p_date::date;
  exception when others then
    return jsonb_build_object('ok', false, 'reason', 'That is not a valid date');
  end;

  if public.admin_verify_passcode(p_passcode) is not true then
    return jsonb_build_object('ok', false, 'reason', 'Not authorised');
  end if;

  select * into v_hol from public.holidays
   where date = v_date and type in ('regular','special_nonworking') limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'reason',
      'There is no paid holiday on ' || to_char(v_date, 'MM/DD/YYYY') || ' to override.');
  end if;

  if exists (select 1 from public.attendance_day_lock l
              where l.date = to_char(v_date, 'YYYY-MM-DD')) then
    return jsonb_build_object('ok', false, 'reason',
      to_char(v_date, 'MM/DD/YYYY') || ' is CLOSED — that week has been paid. Use a payroll '
      || 'adjustment so the correction is visible as its own line rather than silently rewriting a '
      || 'settled week.');
  end if;

  -- A pakyaw man has no day rate, so a holiday amount cannot be computed for him at all. Refusing
  -- here rather than in the browser means it holds no matter which screen asks.
  if exists (select 1 from public.employees
              where upper(regexp_replace(code, '[^A-Za-z0-9]', '', 'g')) = v_norm
                and employment_type = 'pakyaw') then
    return jsonb_build_object('ok', false, 'reason',
      p_code || ' is pakyaw — paid by output, so there is no day rate to pay a holiday from.');
  end if;

  select * into v_old from public.holiday_override
   where upper(regexp_replace(employee_code, '[^A-Za-z0-9]', '', 'g')) = v_norm
     and holiday_date = v_date
   for update;

  if found then
    update public.holiday_override
       set granted = coalesce(p_granted, true), actor = v_actor, reason = v_reason, at = now()
     where id = v_old.id
    returning * into v_new;
  else
    insert into public.holiday_override (employee_code, holiday_date, granted, actor, reason)
    values (btrim(p_code), v_date, coalesce(p_granted, true), v_actor, v_reason)
    returning * into v_new;
  end if;

  insert into public.holiday_audit
    (action, holiday_date, holiday_name, subject_code, before_val, after_val, actor, note)
  values ('override', v_date, v_hol.name, btrim(p_code),
          case when v_old.id is null then null else to_jsonb(v_old) end,
          to_jsonb(v_new), v_actor, v_reason);

  return jsonb_build_object('ok', true, 'employee_code', v_new.employee_code,
                            'date', v_new.holiday_date, 'granted', v_new.granted,
                            'holiday', v_hol.name);
end $$;
grant execute on function public.holiday_override_set(text, text, boolean, text, text, text) to anon, authenticated;

commit;


-- ── STEP 4 — THE FORWARD-ONLY SWITCH ────────────────────────────────────────────────────────
-- Payroll computes a holiday ONLY when its date is >= payroll_cfg -> holidayPayFrom. Exactly the
-- shape of the live sundayPremiumFrom switch, and for the same reason: past weeks must not move
-- when this ships. A date, not a boolean, so "when did this start" is answerable a year from now.
--
-- SET THIS BEFORE THE PAYROLL BUILD GOES OUT. Until the key exists payroll treats it as
-- '2099-01-01' and computes NO holiday pay at all — deliberately fail-closed, so a half-finished
-- install cannot quietly start paying premiums.
--
-- SET BY THE OWNER 2026-08-22: holiday pay starts Saturday 2026-08-15.
--
-- That is the first day of the pay week 08-15 Sat -> 08-21 Fri, which has NOT been paid — payout is
-- today, 08-22. So this date is deliberately retrospective by one week, and safely so: the run that
-- pays that week has not happened yet, so the Friday 08-21 special-day premium is simply included in
-- the normal payment. Nothing already settled recomputes and no manual differential is needed.
--
-- The one closed day in that range is Tuesday 08-18 (attendance_day_lock, closed 08-21 by Owner).
-- It carries no holiday, so nothing about it moves. Note for the future: a holiday dated on a CLOSED
-- day would recompute a settled week silently — payroll stores no payslips — and holiday_delete,
-- holiday_edit and holiday_override_set all refuse on a closed day, leaving a payroll adjustment as
-- the only correction. Choose this date with that in mind if it is ever moved backwards again.
do $$
declare
  v_from text := '2026-08-15';
  v_cur  jsonb;
begin
  select case when jsonb_typeof(value::jsonb) = 'object' then value::jsonb else '{}'::jsonb end
    into v_cur
    from public.settings where key = 'payroll_cfg';

  if v_cur is null then
    insert into public.settings (key, value)
    values ('payroll_cfg', jsonb_build_object('holidayPayFrom', v_from)::text);
    raise notice 'payroll_cfg created with holidayPayFrom = %', v_from;
  else
    update public.settings
       set value = (v_cur || jsonb_build_object('holidayPayFrom', v_from))::text
     where key = 'payroll_cfg';
    raise notice 'payroll_cfg.holidayPayFrom set to %', v_from;
  end if;
end $$;


-- ── STEP 5 — VERIFY ─────────────────────────────────────────────────────────────────────────
-- The Supabase editor swallows RAISE NOTICE. Re-query. Do not trust "Success. No rows returned".

-- 5a. All three tables exist.
select to_regclass('public.holidays')         as holidays,
       to_regclass('public.holiday_override') as overrides,
       to_regclass('public.holiday_audit')    as audit;

-- 5b. All four RPCs exist.
select to_regproc('public.holiday_add(text,text,text,text,text,text)')              as add_fn,
       to_regproc('public.holiday_edit(bigint,text,text,text,text,text,text)')      as edit_fn,
       to_regproc('public.holiday_delete(bigint,text,text,text)')                   as delete_fn,
       to_regproc('public.holiday_override_set(text,text,boolean,text,text,text)')  as override_fn;

-- 5c. Grants: SELECT only for anon on all three. Expect NO insert/update/delete rows.
select table_name, grantee, privilege_type
  from information_schema.role_table_grants
 where table_schema = 'public'
   and table_name in ('holidays','holiday_override','holiday_audit')
   and grantee in ('anon','authenticated')
 order by table_name, grantee, privilege_type;

-- 5d. The forward-only switch is set and readable.
select value::jsonb ->> 'holidayPayFrom' as holiday_pay_from_must_not_be_null
  from public.settings where key = 'payroll_cfg';

-- 5e. Empty to start. Expect 0, 0, 0.
select (select count(*) from public.holidays)         as holidays_must_be_0,
       (select count(*) from public.holiday_override) as overrides_must_be_0,
       (select count(*) from public.holiday_audit)    as audit_must_be_0;

-- 5f. The append-only guard actually bites. This MUST raise
--     'holiday_audit is append-only — UPDATE is not permitted'.
--     It is wrapped so it can never leave anything behind.
do $$
begin
  insert into public.holiday_audit (action, holiday_date, holiday_name, actor)
  values ('add', current_date, 'ZZ APPEND-ONLY PROBE', 'probe');
  begin
    update public.holiday_audit set actor = 'tampered' where holiday_name = 'ZZ APPEND-ONLY PROBE';
    raise exception 'GUARD FAILED — holiday_audit accepted an UPDATE';
  exception when others then
    if sqlerrm like '%append-only%' then
      raise notice 'OK: append-only guard refused the update (%).', sqlerrm;
    else
      raise;
    end if;
  end;
  raise exception 'rolling back the probe row on purpose';
exception when others then
  if sqlerrm like 'rolling back%' then
    raise notice 'Probe rolled back. holiday_audit is clean.';
  else
    raise;
  end if;
end $$;

-- 5g. Confirm 5f left NOTHING behind. Expect 0.
select count(*) as probe_rows_must_be_0
  from public.holiday_audit where holiday_name = 'ZZ APPEND-ONLY PROBE';


-- ── STEP 6 — PASSCODE PROBES (optional; run only if you want to see the gate refuse) ────────
-- Shape checks come BEFORE the passcode, so the first probe proves the closed type set without a
-- real passcode. Expect {"ok": false, "reason": "Unknown holiday type — ..."}.
-- select public.holiday_add('2026-12-25', 'ZZ Probe', 'not_a_type', 'national', 'wrong-passcode');

-- Expect {"ok": false, "reason": "Not authorised"} — valid shape, wrong passcode.
-- select public.holiday_add('2026-12-25', 'ZZ Probe', 'regular', 'national', 'wrong-passcode');


-- ── STEP 7 — PERSISTENCE RE-CHECK (do this in a FRESH TAB) ──────────────────────────────────
-- A 2026-07-31 install verified live and its objects were later found in NEITHER project. Cause
-- still unknown. Close this editor, open a new tab on THIS project, and run 5a, 5b and 5d again.
-- If anything is missing, the install did not persist — do not deploy the payroll build against it.
