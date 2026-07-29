-- ═══════════════════════════════════════════════════════════════════════════════
--  WALKTHROUGH STAGING — leave `stood` render + AWOL keypad
--  Run STEP 1, do the walkthrough at http://localhost:8000/admin/, then run STEP 2.
--  Nothing here decides anything: both workers are left waiting so the UI does the work.
--
--  SAFE ON PRODUCTION. Two throwaway codes, ZZ WALK1 / ZZ WALK2, belonging to no worker.
--  daily_rate 0 and no attendance rows, so payroll cannot pay them. Neither starts with
--  PEM, so the pakyaw exemption constraint is not involved.
--
--  ZZ WALK1 — pending leave 08/03-08/05 + ACTIVE suspension for 06/10-06/11.
--             Readable dates, NO overlap -> approving the leave must return `stood`.
--             letter_received = false, so he also appears in the AWOL card's
--             waiting-for-letter list — which is the point: after the leave is approved
--             he must STILL BE THERE. That is the closed backdoor, visible on screen.
--  ZZ WALK2 — ACTIVE suspension with the letter already confirmed, so the AWOL card
--             offers "Approve / Keep suspended" and the extracted keypad can be opened.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── STEP 1 — STAGE ───────────────────────────────────────────────────────────
insert into public.employees (id, code, name, home_site, daily_rate, vl_balance, sl_balance)
values
  (gen_random_uuid(), 'ZZ WALK1', 'Walkthrough Stood',  'Carmen', 0, 0, 10),
  (gen_random_uuid(), 'ZZ WALK2', 'Walkthrough Keypad', 'Carmen', 0, 0, 10)
on conflict do nothing;

insert into public.leave_requests
  (employee_code, employee_name, type, start_date, end_date, days, reason, status, filed_by, filed_on)
values
  ('ZZ WALK1', 'Walkthrough Stood', 'Sick Leave', '2026-08-03', '2026-08-05', 3,
   'WALKTHROUGH — approve this one to see the STOOD warning', 'Pending', 'Coordinator', '07/29/2026');

insert into public.employee_suspensions
  (employee_code, active, reason, suspended_on, absent_dates, letter_received, letter_received_by)
values
  ('ZZ WALK1', true, 'WALKTHROUGH no-overlap', '07/29/2026',
   '["2026-06-10","2026-06-11"]'::jsonb, false, null),
  ('ZZ WALK2', true, 'WALKTHROUGH keypad',     '07/29/2026',
   '["2026-06-15","2026-06-16"]'::jsonb, true,  'Walkthrough setup')
on conflict (employee_code) do update
  set active = true, absent_dates = excluded.absent_dates,
      letter_received = excluded.letter_received, letter_received_by = excluded.letter_received_by,
      reinstated_by = null, reinstated_on = null, last_decision = null, updated_at = now();

select 'staged' as step,
       (select count(*) from public.leave_requests
         where employee_code like 'ZZ WALK%' and status = 'Pending')            as pending_leaves,
       (select count(*) from public.employee_suspensions
         where employee_code like 'ZZ WALK%' and active is true)                as active_susps,
       (select count(*) from public.employee_suspensions
         where employee_code like 'ZZ WALK%' and letter_received is true)       as letter_ticked,
       (select count(*) from public.employees where code like 'ZZ WALK%')       as emps;
-- EXPECT: pending_leaves 1 · active_susps 2 · letter_ticked 1 · emps 2

-- ── STEP 2 — TEARDOWN (run after the walkthrough) ───────────────────────────
delete from public.awol_events          where employee_code like 'ZZ WALK%';
delete from public.employee_suspensions where employee_code like 'ZZ WALK%';
delete from public.leave_requests       where employee_code like 'ZZ WALK%';
delete from public.employees            where code like 'ZZ WALK%';

select 'cleaned' as step,
       (select count(*) from public.leave_requests       where employee_code like 'ZZ WALK%') as leaves,
       (select count(*) from public.employee_suspensions where employee_code like 'ZZ WALK%') as susps,
       (select count(*) from public.employees            where code like 'ZZ WALK%')          as emps,
       (select count(*) from public.awol_events          where employee_code like 'ZZ WALK%') as events;
-- EXPECT: all four = 0
-- NOTE: the lifecycle work retires a code when its employee row is deleted, so ZZ WALK1/2
-- may be unusable for a SECOND walkthrough. Use ZZ WALK3/4 next time — do not fight the
-- retirement, it is the rule that a deleted code is never freed.
