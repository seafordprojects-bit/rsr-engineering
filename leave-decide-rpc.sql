-- ═══════════════════════════════════════════════════════════════════════════════
--  leave_decide() — the ONE approval path for leave, atomic and PIN-gated
--  Owner-approved 2026-07-29. Additive; replaces no existing function. Safe to re-run.
--
--  WHY A SERVER FUNCTION AND NOT BROWSER CODE
--  The dashboard is now the single approval surface, and decideLeave() in home.js did FOUR
--  separate writes from the browser with no transaction: update the leave, read the balance,
--  write the balance, and (missing entirely) cancel the suspension. Half-success was likely,
--  not theoretical — leave approved, balance deducted, suspension left standing, worker still
--  blocked at the kiosk with nobody told.
--
--  It also had three defects that die here:
--    1. Every write's `error` was ignored — the same silent-success disease as saveCfg().
--    2. The employee lookup matched the RAW code, not code_norm. A spacing difference meant
--       `emp` came back null, the deduction was skipped, and the leave was approved anyway:
--       a live pay bug, silent, with no way to notice.
--    3. approved_at was never set, so there was no record of WHEN a leave was decided.
--
--  PASSCODE IS VERIFIED INSIDE, FIRST, BEFORE ANY LOOKUP. The anon key is published in
--  client-side JS on GitHub Pages, so a UI-only gate is no gate: anyone who views source
--  could otherwise approve leave for the whole roster. Same posture, same reason, as the
--  employee-lifecycle functions.
--
--  ATOMICITY: there is deliberately NO exception block around the writes. Any failure at any
--  step propagates and the entire transaction rolls back — including the leave status. You
--  cannot end up with an approved leave whose suspension was not cancelled.
--
--  AVAILABILITY NOTE: admin_verify_passcode carries a GLOBAL fail-closed throttle (10 wrong
--  tries locks it 15 minutes for everyone). Exposing it here widens that DoS surface, the
--  same accepted trade as the lifecycle functions.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Tolerant date parser. attendance and leave dates exist in TWO formats in this system —
-- ISO 'YYYY-MM-DD' and en-PH 'MM/DD/YYYY' — and comparing them as raw strings is what made an
-- approved leave silently fail to break the AWOL absence chain. Returns NULL when a value
-- cannot be understood, which the caller treats as "cannot compare" rather than as a date.
create or replace function public.leave_try_date(p_in text)
returns date language plpgsql immutable as $$
declare s text := btrim(coalesce(p_in, ''));
begin
  if s ~ '^\d{4}-\d{2}-\d{2}' then return substring(s from 1 for 10)::date; end if;
  if s ~ '^\d{1,2}/\d{1,2}/\d{4}$' then return to_date(s, 'MM/DD/YYYY'); end if;
  return null;
exception when others then
  return null;
end $$;
grant execute on function public.leave_try_date(text) to anon, authenticated;

create or replace function public.leave_decide(
  p_id uuid, p_status text, p_actor text, p_passcode text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_leave     public.leave_requests%rowtype;
  v_emp       public.employees%rowtype;
  v_norm      text;
  v_col       text;
  v_old       numeric;
  v_new       numeric;
  v_susp_code text;
  v_susp_dates jsonb;
  v_susp_outcome text := 'not_applicable';
  v_overlap   boolean := false;
  v_lv_from   date;
  v_lv_to     date;
  v_cancel    jsonb := null;
  v_actor     text  := coalesce(nullif(btrim(p_actor), ''), 'Admin');
begin
  -- 1. PASSCODE FIRST. Nothing is looked up and nothing is revealed until this passes,
  --    so a wrong passcode cannot be used to probe which leave ids exist.
  if public.admin_verify_passcode(p_passcode) is not true then
    return jsonb_build_object('ok', false, 'reason', 'Not authorised');
  end if;

  if p_status not in ('Approved', 'Rejected') then
    return jsonb_build_object('ok', false, 'reason', 'Unknown decision: ' || coalesce(p_status, 'null'));
  end if;

  -- 2. Lock the row. Two admins deciding the same request at once serialise here.
  select * into v_leave from public.leave_requests where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'Leave request not found');
  end if;
  if v_leave.status is distinct from 'Pending' then
    return jsonb_build_object('ok', false, 'reason', 'Already ' || v_leave.status);
  end if;

  v_norm := upper(regexp_replace(coalesce(v_leave.employee_code, ''), '[^A-Za-z0-9]', '', 'g'));

  -- 3. On APPROVAL the worker must be identifiable. Matched on code_norm — the database's
  --    own authority on whether two spellings are the same man — never the raw code.
  --    FAILS CLOSED: refuse the whole approval rather than approve a leave we cannot deduct
  --    and whose suspension we could not reliably find. This is admin data entry; the cost
  --    of refusing is a re-check, the cost of proceeding is silent underpayment.
  --    A REJECTION does not need the worker: a leave filed against a bad code should still
  --    be rejectable, which is how you clear it.
  if p_status = 'Approved' then
    select * into v_emp from public.employees where code_norm = v_norm;
    if not found then
      return jsonb_build_object('ok', false, 'reason',
        format('No employee matches code %s — refusing to approve a leave that cannot be deducted or matched to a suspension',
               v_leave.employee_code));
    end if;

    -- 4. Deduct the balance. Only Sick and Vacation draw down; LWP and Emergency do not.
    v_col := case v_leave.type when 'Vacation Leave' then 'vl_balance'
                               when 'Sick Leave'     then 'sl_balance' end;
    if v_col is not null then
      v_old := case v_col when 'vl_balance' then v_emp.vl_balance else v_emp.sl_balance end;
      v_new := greatest(0, coalesce(v_old, 0) - coalesce(v_leave.days, 0));
      execute format('update public.employees set %I = $1 where id = $2', v_col)
        using v_new, v_emp.id;
    end if;

    -- 5. Cancel a matching ACTIVE suspension — but ONLY when the leave actually covers the
    --    days that caused it. The owner's rule is that an absence LATER COVERED BY AN APPROVED
    --    LEAVE was a suspension issued in error. Cancelling on any approval would turn leave
    --    approval into a backdoor around the two-step letter gate: approving an unrelated
    --    August sick leave would clear a suspension earned for going AWOL in June, and the man
    --    walks back in with no letter and no admin decision.
    --
    --    Found by code_norm, because employee_suspensions stores a free-text code that can
    --    drift in spacing from employees.code. The STORED code is then passed through, since
    --    awol_cancel_leave_approved matches on it exactly. Reusing that function rather than
    --    duplicating it keeps ONE implementation of "cancel because leave was approved",
    --    including its audit write.
    select s.employee_code, s.absent_dates into v_susp_code, v_susp_dates
      from public.employee_suspensions s
     where upper(regexp_replace(s.employee_code, '[^A-Za-z0-9]', '', 'g')) = v_norm
       and s.active is true
     limit 1;

    if v_susp_code is null then
      v_susp_outcome := 'none';                       -- nothing was blocking him
    else
      -- Date parsing is deliberately tolerant. leave_requests dates arrive as ISO from the
      -- coordinator form, but the kiosk's own filing path can write MM/DD/YYYY — the mixed
      -- format landmine that already cost us the approved-leave chain bug. absent_dates is
      -- written as ISO by awolISO(), but is parsed the same way rather than assumed.
      v_lv_from := public.leave_try_date(v_leave.start_date::text);
      v_lv_to   := public.leave_try_date(v_leave.end_date::text);

      if v_lv_from is null or v_lv_to is null or v_susp_dates is null
         or jsonb_typeof(v_susp_dates) <> 'array' or jsonb_array_length(v_susp_dates) = 0 then
        -- CANNOT COMPARE. Unblock and report, per the owner's rule: a man must never stay
        -- blocked because a check could not run, and the owner must be TOLD it could not run.
        v_susp_outcome := 'uncomparable';
        v_cancel := public.awol_cancel_leave_approved(
                      v_susp_code, 'leave approved (dates uncomparable)',
                      to_char(now() at time zone 'Asia/Manila', 'MM/DD/YYYY'));
      else
        select exists (
          select 1 from jsonb_array_elements_text(v_susp_dates) d
           where public.leave_try_date(d) between v_lv_from and v_lv_to)
          into v_overlap;

        if v_overlap then
          v_susp_outcome := 'cancelled';
          v_cancel := public.awol_cancel_leave_approved(
                        v_susp_code, 'leave approved',
                        to_char(now() at time zone 'Asia/Manila', 'MM/DD/YYYY'));
        else
          -- STOOD. Reported as loudly as the cancelled case, with BOTH date sets, so the
          -- owner is never left inferring why a man is still blocked after an approval.
          v_susp_outcome := 'stood';
        end if;
      end if;
    end if;
  else
    v_susp_outcome := 'not_applicable';               -- a rejection cancels nothing
  end if;

  -- 6. The leave row last, so nothing is marked decided unless everything above succeeded.
  update public.leave_requests
     set status       = p_status,
         approved_by  = v_actor,
         approved_via = 'Admin app',
         approved_at  = now()
   where id = p_id;

  return jsonb_build_object(
    'ok',              true,
    'status',          p_status,
    'employee_code',   v_leave.employee_code,
    'employee_name',   v_leave.employee_name,
    'type',            v_leave.type,
    'start_date',      v_leave.start_date,
    'end_date',        v_leave.end_date,
    'days',            v_leave.days,
    'balance_column',  v_col,
    'balance_before',  v_old,
    'balance_after',   v_new,
    -- ALL THREE OUTCOMES ARE NAMED, so the caller never has to infer why a man is still
    -- blocked after an approval:
    --   'cancelled'     leave covers the absent days -> suspension lifted
    --   'stood'         dates do NOT overlap -> suspension deliberately left in place
    --   'uncomparable'  dates unreadable -> lifted anyway, and flagged
    --   'none'          he had no active suspension
    --   'not_applicable' this was a rejection
    'suspension_outcome',   v_susp_outcome,
    'suspension_cancelled', (v_cancel is not null and (v_cancel->>'newly')::boolean is true),
    'suspension_dates',     v_susp_dates,     -- the days that caused the suspension
    'leave_dates',          jsonb_build_object('from', v_leave.start_date, 'to', v_leave.end_date),
    'cancel_result',        v_cancel,
    'decided_by',           v_actor);
end $$;
grant execute on function public.leave_decide(uuid, text, text, text) to anon, authenticated;

-- ── VERIFY ───────────────────────────────────────────────────────────────────
-- Exists and refuses without a passcode. Expect: {"ok": false, "reason": "Not authorised"}
select public.leave_decide(
         '00000000-0000-0000-0000-000000000000'::uuid, 'Approved', 'probe', 'wrong-passcode');
