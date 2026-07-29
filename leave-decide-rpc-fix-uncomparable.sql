-- ═══════════════════════════════════════════════════════════════════════════════
--  FIX — leave_decide() reported `stood` for dates it could not actually read
--  Owner-approved 2026-07-29. Replaces leave_decide() only. Safe to re-run.
--  leave_try_date() is unchanged and is NOT redefined here.
--
--  THE BUG, found by the probe's case E and confirmed against the AFTER readout.
--  The uncomparable branch tested only whether absent_dates was MISSING or EMPTY:
--      if v_lv_from is null or v_lv_to is null or v_susp_dates is null
--         or jsonb_typeof(v_susp_dates) <> 'array' or jsonb_array_length(v_susp_dates) = 0
--  An array FULL OF UNREADABLE DATES — ["not-a-date","???"] — passes every one of those
--  tests. It fell through to the overlap check, where each element parsed to NULL, `null
--  between x and y` is not true, so `exists` was false and the result was `stood`.
--
--  That is the exact failure the owner legislated against: a man stays blocked because a
--  check could not run, and nothing says so. Worse than a silent gap — it reported
--  "dates don't overlap" with confidence, as though a real comparison had happened, and
--  the dashboard would have rendered that to the owner as an authoritative reason.
--
--  THE RULE NOW (owner-confirmed boundary):
--    overlap found                      -> cancelled     definitive, even amongst junk
--    ALL dates parsed, none overlap     -> stood         a real comparison; safe to leave blocked
--    ANY date unreadable, none overlap  -> uncomparable  LIFT AND FLAG
--  One unreadable date plus one readable date that does not overlap is UNCOMPARABLE, not
--  stood: we cannot say a leave "does not cover" a day we could not read.
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.leave_decide(
  p_id uuid, p_status text, p_actor text, p_passcode text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_leave        public.leave_requests%rowtype;
  v_emp          public.employees%rowtype;
  v_norm         text;
  v_col          text;
  v_old          numeric;
  v_new          numeric;
  v_susp_code    text;
  v_susp_dates   jsonb;
  v_susp_outcome text := 'not_applicable';
  v_overlap      boolean;
  v_unreadable   integer := 0;
  v_readable     integer := 0;
  v_lv_from      date;
  v_lv_to        date;
  v_cancel       jsonb := null;
  v_actor        text  := coalesce(nullif(btrim(p_actor), ''), 'Admin');
begin
  if public.admin_verify_passcode(p_passcode) is not true then
    return jsonb_build_object('ok', false, 'reason', 'Not authorised');
  end if;
  if p_status not in ('Approved', 'Rejected') then
    return jsonb_build_object('ok', false, 'reason', 'Unknown decision: ' || coalesce(p_status, 'null'));
  end if;

  select * into v_leave from public.leave_requests where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'Leave request not found');
  end if;
  if v_leave.status is distinct from 'Pending' then
    return jsonb_build_object('ok', false, 'reason', 'Already ' || v_leave.status);
  end if;

  v_norm := upper(regexp_replace(coalesce(v_leave.employee_code, ''), '[^A-Za-z0-9]', '', 'g'));

  if p_status = 'Approved' then
    select * into v_emp from public.employees where code_norm = v_norm;
    if not found then
      return jsonb_build_object('ok', false, 'reason',
        format('No employee matches code %s — refusing to approve a leave that cannot be deducted or matched to a suspension',
               v_leave.employee_code));
    end if;

    v_col := case v_leave.type when 'Vacation Leave' then 'vl_balance'
                               when 'Sick Leave'     then 'sl_balance' end;
    if v_col is not null then
      v_old := case v_col when 'vl_balance' then v_emp.vl_balance else v_emp.sl_balance end;
      v_new := greatest(0, coalesce(v_old, 0) - coalesce(v_leave.days, 0));
      execute format('update public.employees set %I = $1 where id = $2', v_col) using v_new, v_emp.id;
    end if;

    select s.employee_code, s.absent_dates into v_susp_code, v_susp_dates
      from public.employee_suspensions s
     where upper(regexp_replace(s.employee_code, '[^A-Za-z0-9]', '', 'g')) = v_norm
       and s.active is true
     limit 1;

    if v_susp_code is null then
      v_susp_outcome := 'none';
    else
      v_lv_from := public.leave_try_date(v_leave.start_date::text);
      v_lv_to   := public.leave_try_date(v_leave.end_date::text);

      if v_lv_from is null or v_lv_to is null or v_susp_dates is null
         or jsonb_typeof(v_susp_dates) <> 'array' or jsonb_array_length(v_susp_dates) = 0 then
        -- Nothing to compare AT ALL: no leave window, or no absent dates recorded.
        v_susp_outcome := 'uncomparable';
      else
        -- Count what could actually be READ, not just what is present. This is the fix:
        -- an array of unreadable strings is not a comparison, it is a failed one.
        select count(*) filter (where public.leave_try_date(d.v) is null),
               count(*) filter (where public.leave_try_date(d.v) is not null),
               bool_or(public.leave_try_date(d.v) between v_lv_from and v_lv_to)
          into v_unreadable, v_readable, v_overlap
          from jsonb_array_elements_text(v_susp_dates) as d(v);

        if coalesce(v_overlap, false) then
          -- An overlap that WAS read is definitive: the leave covers a day that caused the
          -- suspension. Unreadable siblings cannot make that less true.
          v_susp_outcome := 'cancelled';
        elsif v_unreadable > 0 then
          -- Owner-confirmed boundary: one unreadable date plus one readable non-overlapping
          -- date is UNCOMPARABLE. We cannot say "does not cover" about a day we could not read.
          v_susp_outcome := 'uncomparable';
        else
          -- Every date was read and none fell inside the leave. A real comparison.
          v_susp_outcome := 'stood';
        end if;
      end if;

      -- Act ONCE, from the decided outcome. Both lifting paths route through the same
      -- function so there is one implementation of "cancel because leave was approved",
      -- including its audit write — and the reason string records WHY it was lifted.
      if v_susp_outcome in ('cancelled', 'uncomparable') then
        v_cancel := public.awol_cancel_leave_approved(
                      v_susp_code,
                      case when v_susp_outcome = 'cancelled' then 'leave approved'
                           else 'leave approved (suspension dates unreadable)' end,
                      to_char(now() at time zone 'Asia/Manila', 'MM/DD/YYYY'));
      end if;
    end if;
  else
    v_susp_outcome := 'not_applicable';
  end if;

  update public.leave_requests
     set status = p_status, approved_by = v_actor, approved_via = 'Admin app', approved_at = now()
   where id = p_id;

  return jsonb_build_object(
    'ok', true, 'status', p_status,
    'employee_code', v_leave.employee_code, 'employee_name', v_leave.employee_name,
    'type', v_leave.type, 'days', v_leave.days,
    'balance_column', v_col, 'balance_before', v_old, 'balance_after', v_new,
    'suspension_outcome',   v_susp_outcome,
    'suspension_cancelled', (v_cancel is not null and (v_cancel->>'newly')::boolean is true),
    'suspension_dates',     v_susp_dates,
    'dates_readable',       v_readable,      -- how many absent dates could be parsed
    'dates_unreadable',     v_unreadable,    -- how many could NOT — non-zero explains uncomparable
    'leave_dates',          jsonb_build_object('from', v_leave.start_date, 'to', v_leave.end_date),
    'cancel_result',        v_cancel,
    'decided_by',           v_actor);
end $$;
grant execute on function public.leave_decide(uuid, text, text, text) to anon, authenticated;

-- ── VERIFY ───────────────────────────────────────────────────────────────────
select public.leave_decide('00000000-0000-0000-0000-000000000000'::uuid,
                           'Approved', 'probe', 'wrong-passcode');
-- EXPECT: {"ok": false, "reason": "Not authorised"}
