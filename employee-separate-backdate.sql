-- ═══════════════════════════════════════════════════════════════════════════════════════════
--  employee_separate — accept the REAL last working day
--
--  WHY: employee-lifecycle.sql STEP 7 hardcodes `separated_at = now()`. For a man who left weeks
--  ago that records the wrong day, and separated_at is PERMANENT (STEP 1's own comment). Owner
--  requirement 2026-07-30: separated_at must be the real last working day, not today.
--
--  Immediate use: RSR 0017 Gaviola Salvador and RSR 0020 John Michael Armenion, both verified as
--  not returning, both then carrying separated_at = null — spec rev2 §2.5 and §16.
--  EXECUTED 2026-07-31: RSR 0017 -> 2026-07-11, RSR 0020 -> 2026-06-27 (corrected from 06/28, a
--  Sunday; see L2). Post-run measured: skip roster 41 · skipped 10 · detectable 31.
--
--  RUN ORDER: L0 (pre-check, read-only) -> L1 (this extension) -> L2 (the two calls) -> L3 (verify).
--  L0 comes first because employee-lifecycle.sql is UNTRACKED and may never have been applied to
--  production. Verify the function exists before extending it.
-- ═══════════════════════════════════════════════════════════════════════════════════════════


-- ── L0 — PRE-CHECK. Read-only. ──────────────────────────────────────────────────────────────

-- L0a. Is the lifecycle path actually in production? "I applied it" is not evidence.
select p.oid::regprocedure::text as signature
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('employee_separate','employee_delete_eligibility','next_employee_code')
 order by 1;
-- EXPECT at minimum: employee_separate(uuid,text,text,text)
-- If it is ABSENT, employee-lifecycle.sql has never been applied. STOP — applying an entire
-- untested lifecycle migration is not a walkthrough-prep step, and it carries a trigger
-- (employees_block_retired_code) and a code-minting change that deserve their own review.

-- L0b. The two men. Gives the ids for L2, and every fact that decides what changes.
select e.id, e.code, e.name, e.home_site, e.employment_type,
       e.separated_at, e.separated_by,
       (select count(*) from public.attendance_records a
         where upper(regexp_replace(a.employee_code,'[^A-Za-z0-9]','','g'))
             = upper(regexp_replace(e.code,'[^A-Za-z0-9]','','g'))) as attendance_rows,
       (select max(public.leave_try_date(a.date)) from public.attendance_records a
         where upper(regexp_replace(a.employee_code,'[^A-Za-z0-9]','','g'))
             = upper(regexp_replace(e.code,'[^A-Za-z0-9]','','g'))
           and a.timein is not null and a.timein <> '(auto-skipped)') as last_punch,
       s.skip, s.reason
  from public.employees e
  left join public.awol_skip_list() s on s.code = e.code
 where e.code in ('RSR 0017','RSR 0020')
 order by e.code;
-- READ THREE THINGS OFF THIS:
--   `id`            — needed for L2; do not retype the codes there.
--   `last_punch`    — if NOT NULL, the date supplied in L2 must be on or after it. The L1 guard
--                     refuses otherwise, which is the point: a typo must not backdate a separation
--                     behind real attendance.
--   `skip`          — RESOLVED 2026-07-31 by A5: BOTH men are DETECTABLE. Neither is in the
--                     skipped 10 (= 5 pakyaw + Jamaica + 4 Mandaue), because both appeared in A5,
--                     which filters `not skip`. Separating a DETECTABLE worker reduces the
--                     detectable count, NOT the skipped count. Expect `skip` = false on both rows
--                     here; a true on either means the base has moved since 07-31 and the agreed
--                     L3b numbers below are wrong.


-- ── L1 — THE EXTENSION ──────────────────────────────────────────────────────────────────────
-- Two functions, ONE implementation. The existing 4-arg entry point is KEPT and its behaviour is
-- BIT-FOR-BIT UNCHANGED — it delegates with p_on = null, which still means now().
--
-- NO DEFAULT on the 5th parameter, deliberately. A default would make a 4-argument call ambiguous
-- between the two overloads, and every existing caller of employee_separate — including anything in
-- the admin dashboard — would start failing with "function is not unique". The 4-arg wrapper passes
-- null explicitly instead.
create or replace function public.employee_separate(
  p_id uuid, p_actor text, p_reason text, p_passcode text, p_on date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_emp   public.employees%rowtype;
  v_today date := (now() at time zone 'Asia/Manila')::date;
  v_last  date;
  v_out   timestamptz;
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
    return jsonb_build_object('ok', false, 'reason',
      'Already separated on ' || to_char(v_emp.separated_at, 'MM/DD/YYYY'));
  end if;

  -- Guards apply ONLY when a date is given, so the 4-arg wrapper's behaviour is untouched.
  if p_on is not null then
    if p_on > v_today then
      return jsonb_build_object('ok', false, 'reason',
        'Last working day cannot be in the future: ' || to_char(p_on, 'MM/DD/YYYY'));
    end if;
    if p_on < date '2020-01-01' then
      return jsonb_build_object('ok', false, 'reason',
        'Last working day looks wrong (before 2020): ' || to_char(p_on, 'MM/DD/YYYY'));
    end if;

    -- A day he worked PAST is not his last working day. Catches a transposed digit that would
    -- otherwise silently backdate a permanent record behind real attendance.
    select max(public.leave_try_date(a.date)) into v_last
      from public.attendance_records a
     where upper(regexp_replace(a.employee_code,'[^A-Za-z0-9]','','g'))
         = upper(regexp_replace(v_emp.code,'[^A-Za-z0-9]','','g'))
       and a.timein is not null and a.timein <> '(auto-skipped)';
    if v_last is not null and v_last > p_on then
      return jsonb_build_object('ok', false, 'reason',
        v_emp.code || ' has a punch on ' || to_char(v_last, 'MM/DD/YYYY')
        || ', which is AFTER the last working day given (' || to_char(p_on, 'MM/DD/YYYY') || ')');
    end if;
  end if;

  -- 17:00 Manila, not midnight: separated_at is a timestamptz, and a man's last working day
  -- usually contains a punch. Midnight would place his separation BEFORE his own final punch.
  -- 17:00 is the standard dismissal boundary payroll already uses.
  v_out := case when p_on is null then now()
                else (p_on::text || ' 17:00')::timestamp at time zone 'Asia/Manila' end;

  update public.employees
     set separated_at     = v_out,
         separated_by     = coalesce(nullif(btrim(p_actor), ''), 'Admin'),
         separated_reason = btrim(p_reason)
   where id = p_id;

  return jsonb_build_object('ok', true, 'code', v_emp.code, 'name', v_emp.name,
                            'separated_at', v_out);
end $$;
grant execute on function public.employee_separate(uuid, text, text, text, date) to anon, authenticated;

-- The original entry point, now a thin delegate. Identical behaviour to employee-lifecycle.sql
-- STEP 7. create or replace preserves its existing grant.
create or replace function public.employee_separate(
  p_id uuid, p_actor text, p_reason text, p_passcode text)
returns jsonb language sql security definer set search_path = public as $$
  select public.employee_separate(p_id, p_actor, p_reason, p_passcode, null::date);
$$;

-- L1-VERIFY. Both overloads present, and the guards actually refuse.
select p.oid::regprocedure::text as signature
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'employee_separate'
 order by 1;
-- EXPECT exactly 2 rows:
--   employee_separate(uuid,text,text,text)
--   employee_separate(uuid,text,text,text,date)

-- Guard probe — wrong passcode must be refused before anything else is even looked at.
-- Uses a nonexistent id on purpose, so a PASS cannot mutate anybody.
select public.employee_separate(gen_random_uuid(), 'probe',
         'probe of the passcode guard only', '000000', date '2026-07-01') as must_be_not_authorised;
-- EXPECT: {"ok": false, "reason": "Not authorised"}
-- NOTE: this consumes ONE attempt on the GLOBAL admin_verify_throttle (10 fails = 15-minute
-- lockout of Admin on BOTH tablets). Run it once. Do not repeat it to "make sure".


-- ── L2 — THE TWO CALLS. EXECUTED 2026-07-31. This section is now a RECORD, not a runbook:
--    re-running it returns {"ok": false, "reason": "Already separated on ..."} by design.
--
--   RSR 0017  Gaviola Salvador      last working day 2026-07-11  -> separated_at 2026-07-11 17:00+08
--   RSR 0020  John Michael Armenion last working day 2026-06-27  -> separated_at 2026-06-27 17:00+08
--
-- RSR 0020's DATE WAS CORRECTED AFTER THE FIRST CALL. It was first written as 2026-06-28, which is
-- a SUNDAY — end-of-June recollection rather than a worked day. Corrected once, transaction-wrapped,
-- to Saturday 2026-06-27, the true last working day. His separated_reason carries the correction in
-- the permanent record: "last working day corrected 06/28 -> 06/27 on 07/31/2026".
-- THE DATE BELOW IS 06/27 SO THIS FILE MATCHES WHAT PRODUCTION HOLDS. The 06/28 in the original
-- run is deliberately not hidden — a permanent column that was written twice should say so.
--
-- The reason is written permanently to separated_reason and must be >= 10 characters.
-- RUN ONE, READ THE RESULT, THEN RUN THE OTHER. Each verifies the passcode, so a wrong PIN costs
-- an attempt on the global throttle — do not fire both blind.

select public.employee_separate(
         'cb5cb99e-395a-4777-a148-3b9860f1b843'::uuid,   -- RSR 0017, id captured at L0b
         'Raffy',
         'Left the company, verified not returning (spec rev2 s2.5)',
         '<admin PIN>',
         date '2026-07-11') as rsr_0017;

select public.employee_separate(
         '8082b0f4-11d3-4159-ba8a-d2d25312f244'::uuid,   -- RSR 0020, id captured at L0b
         'Raffy',
         'Left the company, verified not returning (spec rev2 s2.5)',
         '<admin PIN>',
         date '2026-06-27') as rsr_0020;

-- EXPECT each: {"ok": true, "code": "RSR 00xx", "name": "...", "separated_at": "...T17:00:00+08:00"}
-- An {"ok": false} is a guard working, not a failure to route around. Read the reason:
--   'Not authorised'        -> wrong PIN. One throttle attempt spent; 10 fails locks BOTH tablets.
--   'Already separated on'  -> someone got there first. Stop and reconcile, do not force.
--   'has a punch on ...'    -> the date given is BEFORE his last punch, so it is not his last
--                              working day. Do not pick a later date to satisfy the guard — find
--                              out why he has a punch you did not expect.


-- ── L3 — VERIFY ─────────────────────────────────────────────────────────────────────────────

-- L3a. Both separated, with the intended dates.
select code, name, separated_at, separated_by, separated_reason
  from public.employees where code in ('RSR 0017','RSR 0020') order by code;
-- EXPECT: separated_at at 17:00 +08 on each supplied date, separated_by 'Raffy', reason recorded.

-- L3b. Both gone from the detector's universe, and the roster count is down by two.
select count(*)                          as active_rows,
       count(*) filter (where skip)      as skipped,
       count(*) filter (where not skip)  as detectable
  from public.awol_skip_list();
-- EXPECT (agreed with the owner 2026-07-31, from the measured base 43 · 10 · 33):
--   active_rows 41  = 43 active - 2 separated        (43 census-verified 2026-07-31: 38 RSR + 5 PEM)
--   skipped     10  = 5 pakyaw + Jamaica + 4 Mandaue (UNCHANGED — both separated men were
--                     DETECTABLE, confirmed by A5 on 2026-07-31, so neither was in the 10)
--   detectable  31  = 41 - 10
-- Employees table itself: total 43 (rows are never deleted), separated 0 -> 2.

select count(*) as must_be_0 from public.awol_skip_list()
 where code in ('RSR 0017','RSR 0020');
-- EXPECT: 0 — awol_skip_list filters separated_at is null.

-- L3c. THEN re-run A5 in walkthrough-defect-c.sql. Do NOT expect a fixed list — it is
--      date-dependent and was already stale within 24 hours once. Expect only that RSR 0017 and
--      RSR 0020 are GONE from it. If either still appears, L2 did not
--      take. If a NEW code appears, add it to the B1 hold AND the D3a probe before staging.

-- L3d. Pay check. Both men have no attendance rows (L0b `attendance_rows`), so separation is
--      pay-neutral — there is nothing for payroll to include or exclude. If L0b showed a non-zero
--      count for either, STOP and price the change before running L2.
