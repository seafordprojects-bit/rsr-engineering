-- ═══════════════════════════════════════════════════════════════════════════════════════════
--  DEFECT C WALKTHROUGH — staging + teardown
--  Workflow under test: case opens -> worker still punches -> PIN-gated bar -> punch refused
--                       -> reinstate -> punch works again
--
--  THE TEARDOWN IS WRITTEN FIRST, ON PURPOSE (owner, 2026-07-30). Sections run in this order:
--    SECTION A  before the walkthrough  — baseline snapshot, read-only
--    SECTION B  before the walkthrough  — staging
--    SECTION C  after  the walkthrough  — teardown, guarded
--    SECTION D  after  the teardown     — verify against SECTION A's baseline
--
--  FRESH CODES: ZZ WALK5, ZZ WALK6. Never RSR 0000 — the owner's own code was silently exempted
--  on 2026-07-30 by a stray Mandaue test punch (awol_effective_site is last-punch-wins), so a
--  walkthrough run as RSR 0000 could pass while the gate was broken. ZZ WALK3/4 and PEM ZZ9 are
--  retired: deleting an employee retires its code permanently.
--
--  EVERY TABLE EACH TEST IDENTITY CAN TOUCH — enumerated from the kiosk's own writes, not from
--  memory. All nine key on employee_code:
--    attendance_records · employee_suspensions · awol_events · leave_requests · violations
--    sms_log · late_break_requests · pending_approvals · straight_duty
--  Plus `employees` (keyed on code) and the Telegram message the alert posts.
--  kiosk_health is NOT in scope: sendHeartbeat() is localhost-guarded, so a localhost walkthrough
--  writes no device row. If this is ever run on a real tablet, add it.
-- ═══════════════════════════════════════════════════════════════════════════════════════════


-- ╔═══════════════════════════════════════════════════════════════════════════════════════════╗
-- ║ SECTION A — BASELINE. Read-only. Run BEFORE staging and KEEP THE OUTPUT.                  ║
-- ╚═══════════════════════════════════════════════════════════════════════════════════════════╝

-- A1. The real workers who must survive untouched. SCREENSHOT THIS — Section D compares against it.
select employee_code
  from public.attendance_records
 where date = to_char(now() at time zone 'Asia/Manila', 'MM/DD/YYYY')
 order by employee_code;

-- A2. Every table must start clean for the ZZ codes. All zeros, or staging is not a clean slate.
select (select count(*) from public.employees            where code          like 'ZZ WALK%') as employees,
       (select count(*) from public.attendance_records   where employee_code like 'ZZ WALK%') as attendance,
       (select count(*) from public.employee_suspensions where employee_code like 'ZZ WALK%') as suspensions,
       (select count(*) from public.awol_events          where employee_code like 'ZZ WALK%') as events,
       (select count(*) from public.leave_requests       where employee_code like 'ZZ WALK%') as leaves,
       (select count(*) from public.violations           where employee_code like 'ZZ WALK%') as violations,
       (select count(*) from public.sms_log              where employee_code like 'ZZ WALK%') as sms,
       (select count(*) from public.late_break_requests  where employee_code like 'ZZ WALK%') as late_breaks,
       (select count(*) from public.pending_approvals    where employee_code like 'ZZ WALK%') as approvals,
       (select count(*) from public.straight_duty        where employee_code like 'ZZ WALK%') as straight_duty;
-- EXPECT: all ten = 0

-- A3. Nobody barred anywhere before we start.
select count(*) as barred_must_be_0 from public.employee_suspensions where barred_at is not null;
-- EXPECT: 0


-- ╔═══════════════════════════════════════════════════════════════════════════════════════════╗
-- ║ SECTION B — STAGING. Run BEFORE the walkthrough.                                          ║
-- ╚═══════════════════════════════════════════════════════════════════════════════════════════╝

-- ZZ WALK5 is the subject: regular, Carmen, has a PIN so he can actually punch at the kiosk.
-- ZZ WALK6 is the control: identical, never barred. He proves the gate is SELECTIVE — a gate that
-- refuses everyone would pass every step of this walkthrough except his.
-- daily_rate 0 keeps both unpayable. PINs are throwaway and deleted in Section C.
insert into public.employees
  (id, code, name, home_site, daily_rate, vl_balance, sl_balance, phone, pin,
   employment_type, type_effective_from)
values
  (gen_random_uuid(), 'ZZ WALK5', 'Defect C Subject', 'Carmen', 0, 0, 0, null, '955955', 'regular', '2026-01-05'),
  (gen_random_uuid(), 'ZZ WALK6', 'Defect C Control', 'Carmen', 0, 0, 0, null, '966966', 'regular', '2026-01-05')
on conflict do nothing;

-- One real punch 5 working days back for each, so hasRecentPunchHistory() is true and the absence
-- chain can reach 3. Without it the never-punched/30-day safety net skips them and no case opens.
-- Site Carmen so awol_effective_site resolves to a yard WITH a kiosk (else Defect D exempts them).
insert into public.attendance_records (employee_code, employee_name, date, timein, timeout, site)
values
  ('ZZ WALK5','Defect C Subject', to_char((now() at time zone 'Asia/Manila') - interval '5 days','MM/DD/YYYY'),'08:00 AM','05:00 PM','Carmen'),
  ('ZZ WALK6','Defect C Control', to_char((now() at time zone 'Asia/Manila') - interval '5 days','MM/DD/YYYY'),'08:00 AM','05:00 PM','Carmen')
on conflict do nothing;

-- B-VERIFY: both must be DETECTABLE. If either is skipped, the walkthrough cannot open a case.
select code, skip, reason from public.awol_skip_list() where code like 'ZZ WALK%' order by code;
-- EXPECT: both skip = false, reason NULL

select code, name, pin, employment_type, home_site,
       public.awol_effective_site(code) as effective_site
  from public.employees where code like 'ZZ WALK%' order by code;
-- EXPECT: both Carmen / regular, effective_site Carmen, PINs 955955 and 966966


-- ╔═══════════════════════════════════════════════════════════════════════════════════════════╗
-- ║ SECTION C — TEARDOWN. Run AFTER the walkthrough. Guarded; children before parents.        ║
-- ╚═══════════════════════════════════════════════════════════════════════════════════════════╝

-- C0. CAPTURE THE TELEGRAM MESSAGE ID FIRST. Deleting the suspension row destroys it, and the
--     message stays in the AWOL group forever otherwise. Message 6287 had to be pulled by hand
--     after the 07-30 walkthrough because this step did not exist.
select employee_code, awol_group_msg_id, awol_group_chat
  from public.employee_suspensions
 where employee_code like 'ZZ WALK%' and awol_group_msg_id is not null;
-- WRITE THESE DOWN, then delete each message in Telegram by hand after the teardown.

-- C1. TABLET FIRST — before running C2. Clear site data / localStorage on the kiosk you punched
--     from. A queued punch in rsr_records will re-push via saveData() -> syncFlush() and undo the
--     attendance delete below. reset.html alone does NOT clear it.

-- C2. The teardown. One transaction, aborts on unexpected state, nothing half-removed.
do $$
declare v_n integer;
begin
  -- GUARD: refuse to run if a REAL worker is somehow in scope. 'ZZ WALK%' should never match one,
  -- but a guard that never fires costs nothing and a delete that catches a real man costs a day's pay.
  select count(*) into v_n from public.employees
   where code like 'ZZ WALK%' and code not in ('ZZ WALK5','ZZ WALK6');
  if v_n > 0 then
    raise exception 'ABORT: % unexpected ZZ WALK employee row(s). Nothing deleted.', v_n;
  end if;

  -- Children first: an orphaned child row is harder to find later than an orphaned parent.
  delete from public.awol_events          where employee_code like 'ZZ WALK%';
  delete from public.employee_suspensions where employee_code like 'ZZ WALK%';
  delete from public.attendance_records   where employee_code like 'ZZ WALK%';
  delete from public.leave_requests       where employee_code like 'ZZ WALK%';
  delete from public.violations           where employee_code like 'ZZ WALK%';
  delete from public.sms_log              where employee_code like 'ZZ WALK%';
  delete from public.late_break_requests  where employee_code like 'ZZ WALK%';
  delete from public.pending_approvals    where employee_code like 'ZZ WALK%';
  delete from public.straight_duty        where employee_code like 'ZZ WALK%';
  -- Parent last.
  delete from public.employees            where code          like 'ZZ WALK%';
end $$;


-- ╔═══════════════════════════════════════════════════════════════════════════════════════════╗
-- ║ SECTION D — VERIFY. Compare D2 against SECTION A1.                                        ║
-- ╚═══════════════════════════════════════════════════════════════════════════════════════════╝

-- D1. Every table clean, and nobody barred.
select (select count(*) from public.employees            where code          like 'ZZ WALK%') as employees_0,
       (select count(*) from public.attendance_records   where employee_code like 'ZZ WALK%') as attendance_0,
       (select count(*) from public.employee_suspensions where employee_code like 'ZZ WALK%') as suspensions_0,
       (select count(*) from public.awol_events          where employee_code like 'ZZ WALK%') as events_0,
       (select count(*) from public.leave_requests       where employee_code like 'ZZ WALK%') as leaves_0,
       (select count(*) from public.violations           where employee_code like 'ZZ WALK%') as violations_0,
       (select count(*) from public.sms_log              where employee_code like 'ZZ WALK%') as sms_0,
       (select count(*) from public.late_break_requests  where employee_code like 'ZZ WALK%') as late_breaks_0,
       (select count(*) from public.pending_approvals    where employee_code like 'ZZ WALK%') as approvals_0,
       (select count(*) from public.straight_duty        where employee_code like 'ZZ WALK%') as straight_duty_0,
       (select count(*) from public.employee_suspensions where barred_at is not null)         as barred_anywhere_0;
-- EXPECT: all eleven = 0

-- D2. The real workers, unchanged. Compare against A1 — the SAME codes must be listed.
select employee_code
  from public.attendance_records
 where date = to_char(now() at time zone 'Asia/Manila', 'MM/DD/YYYY')
 order by employee_code;
-- EXPECT: identical to A1. The COUNT may be higher if men punched during the walkthrough — normal.
-- A code present in A1 and MISSING here means a real worker lost a punch: stop and say so.

-- D3. Telegram messages from C0 deleted by hand in the AWOL group? Tick this off deliberately —
--     it is the one teardown step no SQL can verify.
