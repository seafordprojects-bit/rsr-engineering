-- ═══════════════════════════════════════════════════════════════════════════════
--  EMPLOYEE LIFECYCLE — undo-mistaken-entry, separation, and permanent code retirement
--  Owner-approved design 2026-07-27. Additive + idempotent; creates no destructive path
--  that can run without a valid admin passcode.
--
--  WHY THIS EXISTS
--  A worker was encoded by mistake (RSR 0038) and has to go. But a plain DELETE is unsafe
--  here: only TWO of the twelve tables that reference a worker have a foreign key
--  (salary_history and borrow_issuance). The other ten reference employees by TEXT code with
--  no constraint at all, so a delete leaves orphan rows the database will never complain
--  about — and if the freed code is later re-minted, those orphans silently re-attach to a
--  DIFFERENT man. Same class of bug as the code_norm collision, opposite direction, invisible.
--
--  THE INVARIANT: deleting a worker must NEVER free his code. Burning a number is free.
--
--  HOW TO RUN — TWO SEPARATE PASTES:
--    PASTE 1 — STEP 0 alone. Read the numbers before anything is created.
--    PASTE 2 — STEP 1 to the end.
--  Nothing here deletes anything. The delete path is a function the app calls later, and it
--  refuses without a valid admin passcode.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── STEP 0 — CENSUS  ▓▓▓ PASTE 1 — RUN THIS ALONE ▓▓▓ ────────────────────────
select count(*) as employees_total,
       count(*) filter (where separated_at is not null) as already_separated
  from public.employees;
-- EXPECT (corrected 2026-07-31): employees_total = 43 = 38 RSR + 5 PEM + 0 other, census-verified
--   2026-07-31. already_separated = 2 as of 2026-07-31 — L2 HAS RUN (RSR 0017 -> 2026-07-11,
--   RSR 0020 -> 2026-06-27). It was 0 before that.
-- THE ORIGINAL "44" WAS NOT WRONG WHEN WRITTEN on 2026-07-27 — it was 43 real workers plus ONE
--   test identity (a ZZ-prefixed code) since deleted. This file proves it against itself: STEP 8
--   expects next_employee_code RSR 0039 / PEM 0006, which implies 38 + 5 = 43 REAL codes, so the
--   44th row was neither RSR nor PEM. employment-type.sql (2026-07-29, after the cleanup) reads
--   43 · 5 · 38 and matches the census exactly. Two files, two dates, both correct when authored —
--   which is why every count literal now carries its derivation and an as-of date.
-- already_separated errors if the column does not exist yet — that is fine on the first run, it
-- means STEP 2 has not been applied. Re-read after PASTE 2.
select to_regclass('public.employee_deletions') as deletions_table;   -- expect NULL first run

-- ═══════════════════════════════════════════════════════════════════════════════
-- ▓▓▓  PASTE 2 starts here.  ▓▓▓
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── STEP 1 — separation columns (DISTINCT from is_suspended) ─────────────────
-- is_suspended is DISCIPLINARY and REVERSIBLE — AWOL owns it, it comes and goes.
-- separated_at is PERMANENT — the man no longer works here. Never merge the two.
-- A timestamp, not a boolean: null = active, set = separated, and it records WHEN.
alter table public.employees
  add column if not exists separated_at     timestamptz,
  add column if not exists separated_by     text,
  add column if not exists separated_reason text;

-- ── STEP 2 — audit trail AND retired-code registry (one table, on purpose) ───
-- Written in the SAME transaction as the delete, BEFORE it. Also the permanent record of
-- which codes may never be re-minted, which is why it must NEVER be pruned. Deleting a row
-- from here would un-retire a code and re-open the orphan-reattachment hole.
create table if not exists public.employee_deletions (
  id           bigserial   primary key,
  employee_id  uuid        not null,
  code         text        not null,      -- as displayed, e.g. 'RSR 0038'
  code_norm    text        not null,      -- the retirement key
  old_row      jsonb       not null,      -- the ENTIRE row, verbatim, for reconstruction
  deleted_by   text        not null,
  reason       text        not null,
  deleted_at   timestamptz not null default now(),
  constraint employee_deletions_reason_len check (length(btrim(reason)) >= 10)
);
-- A code can be retired exactly once.
create unique index if not exists employee_deletions_code_norm_uniq
  on public.employee_deletions (code_norm);
-- Read-only to clients. Every write goes through the security-definer function below, so the
-- audit trail cannot be forged or erased with the public anon key.
revoke all on public.employee_deletions from anon, authenticated;
grant select on public.employee_deletions to anon, authenticated;

-- ── STEP 3 — the retirement is ENFORCED, not merely intended ─────────────────
-- Without this, "never re-mint a retired code" would be a promise the app makes. With it, the
-- database refuses — even a hand-written INSERT in this editor cannot resurrect RSR0038.
create or replace function public.employees_block_retired_code()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (
    select 1 from public.employee_deletions d
     where d.code_norm = upper(regexp_replace(coalesce(new.code,''), '[^A-Za-z0-9]', '', 'g'))
  ) then
    raise exception
      'Employee code % is RETIRED — it belonged to a deleted record and can never be reused.', new.code
      using errcode = '23505';
  end if;
  return new;
end $$;

drop trigger if exists employees_no_retired_code on public.employees;
create trigger employees_no_retired_code
  before insert or update of code on public.employees
  for each row execute function public.employees_block_retired_code();

-- ── STEP 4 — code minting now scans BOTH live and retired codes ──────────────
-- Supersedes the client-side nextCode() in coordinator.js: the client cannot see
-- employee_deletions without another round trip, and a stale roster would re-mint a retired
-- code. Server-side is the only place that can see both lists at once.
create or replace function public.next_employee_code(p_prefix text)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  v_p   text := upper(regexp_replace(coalesce(p_prefix, ''), '[^A-Za-z0-9]', '', 'g'));
  v_max int;
begin
  if v_p = '' then
    raise exception 'A prefix is required (e.g. RSR or PEM)';
  end if;
  select coalesce(max(substring(k from length(v_p) + 1)::int), 0) into v_max
    from (
      select code_norm as k from public.employees
      union all
      select code_norm as k from public.employee_deletions
    ) all_codes
   where k like v_p || '%'
     and substring(k from length(v_p) + 1) ~ '^[0-9]+$';   -- pure-numeric tails only
  return p_prefix || ' ' || lpad((v_max + 1)::text, 4, '0');
end $$;
grant execute on function public.next_employee_code(text) to anon, authenticated;

-- ── STEP 5 — eligibility, DERIVED from the catalog, never a maintained list ──
-- A hand-written list of referencing tables is correct the day it is written and silently
-- wrong six months later. This discovers them instead: every base table in `public` carrying
-- a column named employee_code or employee_id. Every such table today follows that convention
-- (verified across all twelve), so a table added later is covered automatically.
--
-- Each column is matched against BOTH the normalized code AND the id-as-text, because the
-- column NAME does not tell you the content: job_checkpoint.employee_code holds a UUID.
--
-- FAILS CLOSED. If the catalog cannot be read, or ANY single table cannot be counted, this
-- returns eligible=false with the reason. Absence of evidence is never evidence of safety.
-- Returns the list it scanned so the caller can SHOW it — coverage is visible on every use.
create or replace function public.employee_delete_eligibility(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_emp     public.employees%rowtype;
  v_norm    text;
  v_tbl     record;
  v_cnt     bigint;
  v_total   bigint := 0;
  v_checked jsonb  := '[]'::jsonb;
  v_counts  jsonb  := '{}'::jsonb;
begin
  select * into v_emp from public.employees where id = p_id;
  if not found then
    return jsonb_build_object('eligible', false, 'reason', 'Employee not found', 'checked', v_checked);
  end if;
  v_norm := v_emp.code_norm;

  for v_tbl in
    select c.table_name, c.column_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public'
       and t.table_type   = 'BASE TABLE'
       and c.column_name in ('employee_code', 'employee_id')
       and c.table_name not in ('employees', 'employee_deletions')
     order by c.table_name, c.column_name
  loop
    begin
      execute format(
        'select count(*) from public.%I where upper(regexp_replace(%I::text, ''[^A-Za-z0-9]'', '''', ''g'')) = $1 or lower(%I::text) = lower($2)',
        v_tbl.table_name, v_tbl.column_name, v_tbl.column_name)
        into v_cnt using v_norm, p_id::text;
    exception when others then
      return jsonb_build_object('eligible', false,
        'reason', format('Could not check %s.%s (%s) — refusing to delete', v_tbl.table_name, v_tbl.column_name, sqlerrm),
        'checked', v_checked);
    end;

    v_checked := v_checked || to_jsonb(v_tbl.table_name || '.' || v_tbl.column_name);
    if v_cnt > 0 then
      v_counts := v_counts || jsonb_build_object(v_tbl.table_name || '.' || v_tbl.column_name, v_cnt);
      v_total  := v_total + v_cnt;
    end if;
  end loop;

  if jsonb_array_length(v_checked) = 0 then
    return jsonb_build_object('eligible', false,
      'reason', 'No referencing tables were discovered — the check could not be computed', 'checked', v_checked);
  end if;

  return jsonb_build_object(
    'eligible',      v_total = 0,
    'checked',       v_checked,
    'checked_count', jsonb_array_length(v_checked),
    'counts',        v_counts,
    'total',         v_total,
    'reason',        case when v_total = 0 then null else 'This worker has history and cannot be deleted' end);
end $$;
grant execute on function public.employee_delete_eligibility(uuid) to anon, authenticated;

-- ── STEP 6 — UNDO MISTAKEN ENTRY (hard delete, code retired forever) ─────────
-- The passcode is verified INSIDE the function, FIRST, before any lookup. The anon key is
-- published in client-side JS on GitHub Pages, so a UI-only gate would mean anyone who views
-- source could call this directly. Nothing is revealed and nothing happens without it.
-- NOTE ON AVAILABILITY: admin_verify_passcode carries a GLOBAL fail-closed throttle (10 wrong
-- tries locks it 15 minutes for everyone). Exposing it here widens that DoS surface — a
-- deliberate trade: a locked PIN is recoverable, wrongly-destroyed records are not.
create or replace function public.employee_undo_mistaken_entry(
  p_id uuid, p_actor text, p_reason text, p_passcode text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_emp public.employees%rowtype; v_elig jsonb;
begin
  if public.admin_verify_passcode(p_passcode) is not true then
    return jsonb_build_object('ok', false, 'reason', 'Not authorised');
  end if;
  if p_reason is null or length(btrim(p_reason)) < 10 then
    return jsonb_build_object('ok', false, 'reason', 'A written reason of at least 10 characters is required');
  end if;

  -- Re-checked SERVER-SIDE. The button the admin tapped was rendered from an earlier snapshot;
  -- rows can appear in between. The client's opinion is never trusted.
  v_elig := public.employee_delete_eligibility(p_id);
  if (v_elig->>'eligible')::boolean is not true then
    return jsonb_build_object('ok', false, 'reason', coalesce(v_elig->>'reason', 'Not eligible'), 'eligibility', v_elig);
  end if;

  select * into v_emp from public.employees where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'Employee not found');
  end if;

  -- Audit FIRST, delete second, one transaction. Order is enforced by being one function
  -- rather than by callers remembering to do it.
  insert into public.employee_deletions (employee_id, code, code_norm, old_row, deleted_by, reason)
  values (v_emp.id, v_emp.code, v_emp.code_norm, to_jsonb(v_emp), coalesce(nullif(btrim(p_actor), ''), 'Admin'), btrim(p_reason));

  delete from public.employees where id = p_id;

  return jsonb_build_object('ok', true, 'code', v_emp.code, 'retired_code', v_emp.code_norm, 'eligibility', v_elig);
end $$;
grant execute on function public.employee_undo_mistaken_entry(uuid, text, text, text) to anon, authenticated;

-- ── STEP 7 — DEACTIVATE / SEPARATE (row stays forever, code stays retired) ───
-- No delete, no audit row: the employees row itself remains, so next_employee_code already
-- sees the code and it can never be re-minted.
create or replace function public.employee_separate(
  p_id uuid, p_actor text, p_reason text, p_passcode text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_emp public.employees%rowtype;
begin
  if public.admin_verify_passcode(p_passcode) is not true then
    return jsonb_build_object('ok', false, 'reason', 'Not authorised');
  end if;
  if p_reason is null or length(btrim(p_reason)) < 10 then
    return jsonb_build_object('ok', false, 'reason', 'A written reason of at least 10 characters is required');
  end if;

  select * into v_emp from public.employees where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'Employee not found');
  end if;
  if v_emp.separated_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'Already separated on ' || to_char(v_emp.separated_at, 'MM/DD/YYYY'));
  end if;

  update public.employees
     set separated_at     = now(),
         separated_by     = coalesce(nullif(btrim(p_actor), ''), 'Admin'),
         separated_reason = btrim(p_reason)
   where id = p_id;

  return jsonb_build_object('ok', true, 'code', v_emp.code, 'name', v_emp.name);
end $$;
grant execute on function public.employee_separate(uuid, text, text, text) to anon, authenticated;

-- ── STEP 8 — RE-QUERY / verify ───────────────────────────────────────────────
select count(*) as employees_total,
       count(*) filter (where separated_at is not null) as separated
  from public.employees;
-- EXPECT: 43 / 2  — 43 = 38 RSR + 5 PEM (rows are never deleted), separated = 2 as of
-- 2026-07-31, L2 having run. It read 43 / 0 before. On the original "44" see STEP 0's note.
select count(*) as deletions_logged from public.employee_deletions;         -- expect 0
select public.next_employee_code('RSR') as next_rsr,
       public.next_employee_code('PEM') as next_pem;       -- expect RSR 0039 / PEM 0006
-- Which tables the eligibility check discovers. Eyeball this list — it should name every table
-- that references a worker. If one you expect is missing, its column is not called
-- employee_code/employee_id and preflight's drift check needs to catch it.
select c.table_name || '.' || c.column_name as discovered
  from information_schema.columns c
  join information_schema.tables t
    on t.table_schema = c.table_schema and t.table_name = c.table_name
 where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
   and c.column_name in ('employee_code', 'employee_id')
   and c.table_name not in ('employees', 'employee_deletions')
 order by 1;
