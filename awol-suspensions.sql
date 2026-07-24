-- ═══════════════════════════════════════════════════════════════════════════════
--  AWOL suspension flow — shared state + dedup RPCs + dedicated group key
--  Additive + idempotent. RLS-disabled project convention (anon read/write via PostgREST).
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── STEP 0 — CENSUS (read-only; run first) ────────────────────────────────────
select to_regclass('public.employee_suspensions') as table_exists;             -- expect NULL first run
select key, value from public.settings where key = 'tg_awol_group';            -- expect 0 rows first run

-- ── STEP 1 — shared table (source of truth; one row per employee) ─────────────
create table if not exists public.employee_suspensions (
  employee_code     text primary key,
  active            boolean not null default true,
  reason            text,
  suspended_on      text,
  absent_dates      jsonb,
  awol_group_msg_id text,
  awol_group_chat   text,
  reinstated_by     text,
  reinstated_on     text,
  updated_at        timestamptz not null default now()
);
grant select, insert, update on public.employee_suspensions to anon, authenticated;

-- ── STEP 2 — atomic dedup RPCs (security definer) ─────────────────────────────
-- Returns TRUE only when THIS call newly activates the suspension → exactly one alert
-- even if two kiosks detect the same AWOL in the same run.
create or replace function public.awol_set_suspended(p_code text, p_reason text, p_dates jsonb, p_on text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_was_active boolean;
begin
  select active into v_was_active from employee_suspensions where employee_code = p_code;
  if v_was_active is true then
    return false;
  end if;
  insert into employee_suspensions(employee_code, active, reason, suspended_on, absent_dates, updated_at)
    values (p_code, true, p_reason, p_on, p_dates, now())
    on conflict (employee_code) do update
      set active = true, reason = excluded.reason, suspended_on = excluded.suspended_on,
          absent_dates = excluded.absent_dates,
          awol_group_msg_id = null, awol_group_chat = null,
          reinstated_by = null, reinstated_on = null, updated_at = now();
  return true;
end $$;
grant execute on function public.awol_set_suspended(text, text, jsonb, text) to anon, authenticated;

-- Flips an active row to inactive; returns the stored group msg id so ANY kiosk can edit
-- the original alert to RESOLVED. {newly:false} when nothing was active (dedup).
create or replace function public.awol_reinstate(p_code text, p_by text, p_on text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_active boolean; v_msg text; v_chat text;
begin
  select active, awol_group_msg_id, awol_group_chat into v_active, v_msg, v_chat
    from employee_suspensions where employee_code = p_code;
  if v_active is not true then
    return jsonb_build_object('newly', false);
  end if;
  update employee_suspensions
     set active = false, reinstated_by = p_by, reinstated_on = p_on, updated_at = now()
   where employee_code = p_code;
  return jsonb_build_object('newly', true, 'awol_group_msg_id', v_msg, 'awol_group_chat', v_chat);
end $$;
grant execute on function public.awol_reinstate(text, text, text) to anon, authenticated;

-- ── STEP 3 — dedicated AWOL group settings key (value set by owner after chat-ID capture) ──
insert into public.settings(key, value)
  select 'tg_awol_group', ''
  where not exists (select 1 from public.settings where key = 'tg_awol_group');

-- ── STEP 4 — RE-QUERY / verify ────────────────────────────────────────────────
select * from public.employee_suspensions order by updated_at desc limit 20;
select key, value from public.settings where key = 'tg_awol_group';
-- smoke (optional): select public.awol_set_suspended('TEST999','smoke','["2026-07-20"]'::jsonb,'07/24/2026');
--                    select public.awol_reinstate('TEST999','tester','07/24/2026');
--                    delete from public.employee_suspensions where employee_code='TEST999';
