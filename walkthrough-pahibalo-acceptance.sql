-- ═══════════════════════════════════════════════════════════════════════════════════════════
--  PAHIBALO ACCEPTANCE — THE SHIP GATE for spec rev2 §3.7 + §3.8. ZZ WALK8. Branch only.
--
--  WHAT IS UNDER TEST, and it is the full shipping chain — the SWEEP opens the case, nothing is
--  staged into employee_suspensions by hand:
--
--      sweep opens case  ->  PIN  ->  PAHIBALO FIRES ON ITS OWN  ->  OK  ->  Time In  ->  ROW LANDS
--
--  THE GATE IS THE PUNCH, NOT THE MODAL. "The modal rendered" is not a pass. The 2026-08-01 demo
--  showed a dialog and a punch and could never establish they were on the same path; this run must.
--
--  IT ALSO PROVES §3.7 BY CONSTRUCTION. The notice keys on an ACTIVE case with barred_at NULL. If
--  the removed queue-merge were still there, a case would land in suspendedEmployees and the man
--  would be BARRED instead of notified — the run would fail at the PIN with GI-SUSPEND. So a pass
--  is simultaneously: the merge is gone, and the notice replaced it.
--
--  NO EXPECTED VALUES ARE PRE-FILLED (owner, 2026-08-02). Every verify carries a [PASTE RESULT]
--  blank. Predictions in this file have been wrong more than once — a stale A5 EXPECT, a
--  four-vs-five PEM count, an "OK blocks" claim the data contradicted — and a pre-filled number
--  invites reading the paper instead of the screen. Where a value MUST be checked, the file states
--  the DERIVATION or the STOP CONDITION, never the answer.
--
--  IDENTITY:  ZZ WALK8 · "PAHIBALO Acceptance" · PIN 988988 · Carmen · regular · daily_rate 0
--  Admin PIN is the 6-digit kiosk/dashboard PIN. The throttle is GLOBAL and fail-closed.
--
--  TIMING, 2026-08-02: Time In opens 07:00-10:00 and 12:40-15:00 Manila (kiosk :1032). The sweep,
--  the PIN and the modal fire at ANY hour — only the final punch needs the window. Today is a
--  SUNDAY: the punch will create a Sunday attendance row, which is pay-neutral at daily_rate 0.
-- ═══════════════════════════════════════════════════════════════════════════════════════════


-- ── A. BASELINE — read-only ─────────────────────────────────────────────────────────────────

-- A1. Today's real punchers. Section D compares against this. SCREENSHOT IT.
select employee_code, date
  from public.attendance_records
 where date in (to_char(now() at time zone 'Asia/Manila', 'MM/DD/YYYY'),
                to_char(now() at time zone 'Asia/Manila', 'YYYY-MM-DD'),
                to_char(now() at time zone 'Asia/Manila', 'FMMM/FMDD/YYYY'))
 order by employee_code;
-- [PASTE RESULT]

-- A2. ZZ WALK8 must not exist anywhere.
select (select count(*) from public.employees            where code          like 'ZZ WALK8%') as employees,
       (select count(*) from public.attendance_records   where employee_code like 'ZZ WALK8%') as attendance,
       (select count(*) from public.employee_suspensions where employee_code like 'ZZ WALK8%') as suspensions,
       (select count(*) from public.awol_events          where employee_code like 'ZZ WALK8%') as events,
       (select count(*) from public.leave_requests       where employee_code like 'ZZ WALK8%') as leaves,
       (select count(*) from public.violations           where employee_code like 'ZZ WALK8%') as violations,
       (select count(*) from public.sms_log              where employee_code like 'ZZ WALK8%') as sms,
       (select count(*) from public.late_break_requests  where employee_code like 'ZZ WALK8%') as late_breaks,
       (select count(*) from public.pending_approvals    where employee_code like 'ZZ WALK8%') as approvals,
       (select count(*) from public.straight_duty        where employee_code like 'ZZ WALK8%') as straight_duty;
-- [PASTE RESULT]
-- STOP CONDITION: any non-zero. Staging onto a leftover row tests stale state, not this build.

-- A3. Barred count before the run.
select count(*) as barred_anywhere from public.employee_suspensions where barred_at is not null;
-- [PASTE RESULT]
-- STOP CONDITION: anything other than zero. A pre-existing bar makes "PAHIBALO not GI-SUSPEND"
-- unprovable, because the gate could fire for a reason unrelated to this run.

-- A4. Open cases before the run — the notice keys on these, so the starting set must be known.
select employee_code, active, barred_at, suspended_on
  from public.employee_suspensions where active is true and barred_at is null
 order by employee_code;
-- [PASTE RESULT]
-- Any row here is a real worker who will ALSO see PAHIBALO at his next PIN entry on this build.
-- That is the feature working, but know the list before it happens rather than after.

-- A5. WHO WOULD BE FLAGGED TODAY. The B1 hold list comes from THIS, run today. Never reuse a
--     previous day's answer — the list has changed inside 24 hours before now.
with tz as (select (now() at time zone 'Asia/Manila')::date as today),
cand as (select code from public.awol_skip_list() where not skip),
days as (
  select c.code, g.d::date as d,
         row_number() over (partition by c.code order by g.d desc) as pos
    from cand c cross join tz
    cross join lateral generate_series(tz.today - 21, tz.today - 1, interval '1 day') g(d)
),
cls as (
  select dd.code, dd.pos,
    case
      when exists (select 1 from public.attendance_records a
                    where upper(regexp_replace(a.employee_code,'[^A-Za-z0-9]','','g'))
                        = upper(regexp_replace(dd.code,'[^A-Za-z0-9]','','g'))
                      and public.leave_try_date(a.date) = dd.d
                      and a.timein is not null and a.timein <> '(auto-skipped)')
           then 'BREAK'
      when extract(dow from dd.d) = 0 then 'SKIP'
      when exists (select 1 from public.leave_requests l
                    where upper(regexp_replace(l.employee_code,'[^A-Za-z0-9]','','g'))
                        = upper(regexp_replace(dd.code,'[^A-Za-z0-9]','','g'))
                      and l.status = 'Approved'
                      and public.leave_try_date(l.start_date::text) <= dd.d
                      and public.leave_try_date(coalesce(l.end_date::text, l.start_date::text)) >= dd.d)
           then 'BREAK'
      else 'ABSENT'
    end as k
  from days dd
),
fb as (select code, min(pos) as bpos from cls where k = 'BREAK' group by code),
chain as (
  select c.code, count(*) filter (where c.k = 'ABSENT' and c.pos < coalesce(f.bpos, 999)) as absent_run
    from cls c left join fb f on f.code = c.code
   group by c.code
)
select ch.code, e.name, ch.absent_run, e.employment_type,
       (select max(public.leave_try_date(a.date)) from public.attendance_records a
         where upper(regexp_replace(a.employee_code,'[^A-Za-z0-9]','','g'))
             = upper(regexp_replace(ch.code,'[^A-Za-z0-9]','','g'))
           and a.timein is not null and a.timein <> '(auto-skipped)') as last_punch,
       exists (select 1 from public.attendance_records a cross join tz
                where upper(regexp_replace(a.employee_code,'[^A-Za-z0-9]','','g'))
                    = upper(regexp_replace(ch.code,'[^A-Za-z0-9]','','g'))
                  and a.timein is not null and a.timein <> '(auto-skipped)'
                  and public.leave_try_date(a.date) between tz.today - 30 and tz.today
              ) as has_30d_history,
       exists (select 1 from public.leave_requests l
                where upper(regexp_replace(l.employee_code,'[^A-Za-z0-9]','','g'))
                    = upper(regexp_replace(ch.code,'[^A-Za-z0-9]','','g'))
                  and l.status = 'Pending') as has_pending_leave
  from chain ch
  join public.employees e
    on upper(regexp_replace(e.code,'[^A-Za-z0-9]','','g'))
     = upper(regexp_replace(ch.code,'[^A-Za-z0-9]','','g'))
 where ch.absent_run >= 3
 order by ch.absent_run desc, ch.code;
-- [PASTE RESULT]
-- THE RULE: hold a row ONLY if has_30d_history = true. A false there is already stopped by the
-- client's never-punched/30-day net, and holding it adds nothing.


-- ── B. STAGING — kiosk CLOSED until B4 is read. It sweeps on boot. ──────────────────────────

-- B1. THE HOLD. Put A5's has_30d_history = true codes in BOTH clauses, normalised (no spaces,
--     upper). Canonical body is awol-defect-cdf.sql:493-503; the only additions are the two clauses.
create or replace function public.awol_skip_list()
returns table (code text, skip boolean, reason text)
language sql stable as $$
  select e.code,
         public.awol_skip_detection(e.code)
           or upper(regexp_replace(e.code,'[^A-Za-z0-9]','','g'))
              in ( /* <-- A5's codes */ ),
         coalesce(
           public.awol_skip_reason(e.code),
           case when upper(regexp_replace(e.code,'[^A-Za-z0-9]','','g'))
                     in ( /* <-- THE SAME LIST */ )
                then 'PAHIBALO ACCEPTANCE HOLD 2026-08-02 — NOT A REAL EXEMPTION — REVERT REQUIRED (C1)'
           end)
    from public.employees e
   where e.separated_at is null
   order by e.code;
$$;

-- B1-VERIFY.
select code, skip, reason from public.awol_skip_list()
 where reason like 'PAHIBALO ACCEPTANCE HOLD%' order by code;
-- [PASTE RESULT]
-- DERIVATION: the row count here must equal the number of codes you put in B1. Fewer means a
-- PARTIAL hold, which is the dangerous failure — it lets exactly one real man through the sweep.
--
-- HAZARD, HIT LIVE 2026-08-02: THE create or replace CAN SILENTLY NOT TAKE. The first B1 attempt
-- left the function unchanged and this verify read the STANDING skip count with zero rows held.
-- That looks identical to "the hold list was wrong", and waving it through would have swept
-- against real workers with no hold at all. Re-running the create cleanly fixed it.
-- SO: TREAT A SHORT COUNT AS "THE CREATE DID NOT RUN" BEFORE TREATING IT AS "MY CODES ARE WRONG".
-- Re-run the create on its own, then re-read this. Do not proceed on a count you cannot derive.

select count(*) filter (where skip) as skipped, count(*) filter (where not skip) as detectable,
       count(*) as roster
  from public.awol_skip_list();
-- [PASTE RESULT]
-- DERIVATION: skipped = the standing skip count + the number held in B1. Record the standing count
-- from your last clean reading rather than assuming it; it moves when men are separated.

-- B2. TELEGRAM REDIRECT — the acceptance run's own alert must not reach the real AWOL group.
--     Deployed main never reads tg_awol_group, so this affects the LOCALHOST build only.
update public.settings set value = '8586022901' where key = 'tg_awol_group';
select key, value from public.settings where key = 'tg_awol_group';
-- [PASTE RESULT]
-- STOP CONDITION: UPDATE 0, or a value that is not the DM. Nothing was redirected.

-- B3. THE IDENTITY.
insert into public.employees
  (id, code, name, home_site, daily_rate, vl_balance, sl_balance, phone, pin,
   employment_type, type_effective_from)
values
  (gen_random_uuid(), 'ZZ WALK8', 'PAHIBALO Acceptance', 'Carmen', 0, 0, 0, null, '988988', 'regular', '2026-01-05')
on conflict do nothing;

-- One real punch ~5 days back so hasRecentPunchHistory() is true and the chain can reach 3.
-- Sunday-aware: steps back one more day if the target lands on a Sunday, so no rest-day attendance
-- row is written. Computed once so the date cannot drift between statements.
with pd as (
  select case when extract(dow from d) = 0 then d - 1 else d end as punch_date
    from (select (now() at time zone 'Asia/Manila')::date - 5 as d) x
)
insert into public.attendance_records (employee_code, employee_name, date, timein, timeout, site)
select 'ZZ WALK8', 'PAHIBALO Acceptance', to_char(pd.punch_date,'MM/DD/YYYY'), '08:00 AM', '05:00 PM', 'Carmen'
  from pd
on conflict do nothing;

-- B3-VERIFY. RECORD THE DATE — the boot seed must use this exact string.
select employee_code, date, timein, timeout, site,
       to_char(public.leave_try_date(date), 'Day') as weekday
  from public.attendance_records where employee_code = 'ZZ WALK8';
-- [PASTE RESULT]
-- STOP CONDITION: weekday reads Sunday. The Sunday-aware CTE failed and the row is on a rest day.

-- B4. STAGING VERIFY — the last read before the kiosk opens.
select code, skip, reason from public.awol_skip_list()
 where code = 'ZZ WALK8' or reason like 'PAHIBALO ACCEPTANCE HOLD%' order by skip, code;
-- [PASTE RESULT]
-- STOP CONDITIONS, both of which make the run prove nothing:
--   ZZ WALK8 with skip = true      -> no case can open.
--   ZZ WALK8 ABSENT from the list  -> worse, and silent: the sweep treats him as unknown to the
--                                     server, fails open, reports him, and nothing looks wrong.

select code, name, pin, employment_type, home_site,
       public.awol_effective_site(code) as effective_site
  from public.employees where code = 'ZZ WALK8';
-- [PASTE RESULT]
-- STOP CONDITION: effective_site is not Carmen. Defect D's site gate will exempt him.


-- ── BOOT CHECKLIST ──────────────────────────────────────────────────────────────────────────
--
--  0. CONFIRM THE TREE. The demo serves the TREE, not a commit:
--         git -C C:\Users\PC\Documents\rsr-engineering branch --show-current
--         git -C C:\Users\PC\Documents\rsr-engineering diff --stat -- kiosk/index.html
--     Branch must be awol-suspension-flow with no diff.
--
--  1. SERVE THE REPO ROOT — not kiosk/. The letter link is built from location.pathname with
--     /kiosk stripped, so serving the subdirectory breaks it.
--         python -m http.server 8080 --directory C:\Users\PC\Documents\rsr-engineering
--
--  2. OPEN, with a fresh cache-buster number each boot:
--         http://localhost:8080/kiosk/index.html?site=Carmen&cb=<any new number>
--
--  3. STAMP MUST READ v2026-08-02a. This is the build carrying the §3.7 removal and PAHIBALO.
--     v2026-07-31a is the previous branch build and has neither. v2026-07-30a is deployed main.
--     Ctrl+Shift+R if it reads anything else.
--
--  4. Console clean on load. No-camera warnings are expected.
--
--  5. SEED THE BACKDATED PUNCH INTO localStorage. The kiosk has ZERO .select() calls on
--     attendance_records and never pulls history down, so B3's row is INVISIBLE to the sweep until
--     the client holds it. Skip this and the sweep silently does nothing, logs nothing, and looks
--     exactly like never having run. Substitute B3-VERIFY's date:
--
--       records['ZZ WALK8_<B3 date>'] = {code:'ZZ WALK8',
--         punches:{timein:'08:00 AM',timeout:'05:00 PM'}, msMap:{}, isLate:false, lateMs:0,
--         photos:{}, clockedSite:'Carmen', hasAllowance:false, allowanceAmt:0, nightShift:false};
--       saveData(); location.reload();
--
--     saveData() writes localStorage only — no queueRecord, nothing pushed to Supabase.
--
--  6. WAIT ~5 SECONDS after the reload. The sweep is on a 3-second timer (:5430), not instant.


-- ── THE ACCEPTANCE BEATS ────────────────────────────────────────────────────────────────────
--
--  BEAT 1 — THE SWEEP OPENS THE CASE, AND BARS NOBODY.
      select employee_code, active, barred_at, barred_by, suspended_on, absent_dates
        from public.employee_suspensions where employee_code = 'ZZ WALK8';
--      [PASTE RESULT]
--      STOP CONDITION: barred_at is not null. The sweep reached the punch gate and §3.7 has failed.
      select employee_code, event, actor, note from public.awol_events
       where employee_code = 'ZZ WALK8' order by created_at;
--      [PASTE RESULT]
--
--      One Telegram alert should reach the DM, not the group. Note which chat it landed in.
--      [PASTE RESULT]
--
--  BEAT 2 — PIN 988988 AT THE KIOSK. PAHIBALO FIRES ON ITS OWN.
--      No reload, no console command, no second attempt. The sweep calls loadSuspensionsFromCloud()
--      at its own tail, so openCases is already populated on the pass that created the case.
--      WHAT TO RECORD, verbatim from the screen:
--        · the title line                                     [PASTE RESULT]
--        · does it name him                                   [PASTE RESULT]
--        · the full body text                                 [PASTE RESULT]
--      STOP CONDITION: the modal says GI-SUSPEND. That is the bar gate, which means the case
--      reached suspendedEmployees and the §3.7 removal did not hold.
--      STOP CONDITION: no modal at all. openCases is empty — the notice did not wire up.
--
--  BEAT 3 — PRESS OK.
--      The keypad must still hold his PIN and preview, with buttons live. The notice uses the KEEP
--      variant precisely so dismissal does not clear him.
--      WHAT TO RECORD: is the preview still up, are the buttons enabled   [PASTE RESULT]
--      STOP CONDITION: the PIN clears and he is returned to an empty keypad. That is blocking
--      behaviour and fails the non-blocking requirement.
--
--  BEAT 4 — PRESS TIME IN. THE PUNCH MUST RECORD.
--      Needs 07:00-10:00 or 12:40-15:00 Manila. Outside those the button is shut by the shift
--      window, which is not an AWOL refusal — wait for the window rather than recording a failure.
      select employee_code, date, timein, timeout, site
        from public.attendance_records where employee_code = 'ZZ WALK8' order by date;
--      [PASTE RESULT]
--      THIS IS THE GATE. Two rows — the backdated staging punch and today's live one — with today's
--      timein set. A modal that rendered without a punch landing is NOT a pass.
--
--  BEAT 5 — THE NOTICE IS ONCE PER DAY.
--      Clear the keypad, key 988988 again. The modal must NOT reappear.
--      WHAT TO RECORD: did it reappear   [PASTE RESULT]


-- ── C. TEARDOWN — same day, in this order ───────────────────────────────────────────────────

-- C0. CAPTURE THE TELEGRAM MESSAGE ID FIRST — deleting the suspension row destroys it.
select employee_code, awol_group_msg_id, awol_group_chat
  from public.employee_suspensions where employee_code = 'ZZ WALK8';
-- [PASTE RESULT]
-- Write it down, then delete the message by hand in Telegram after the teardown.

-- C1. LIFT THE HOLD AND RESTORE TELEGRAM. FIRST, before any delete — a teardown that errors halfway
--     must not leave this undone. Body is VERBATIM the canonical awol-defect-cdf.sql:493-503.
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

update public.settings set value = '-5510566104' where key = 'tg_awol_group';

select count(*) as holds_remaining from public.awol_skip_list() where reason like 'PAHIBALO ACCEPTANCE HOLD%';
select key, value from public.settings where key = 'tg_awol_group';
-- [PASTE RESULT]
-- STOP CONDITION: holds_remaining is not zero, or the chat id is not the real group.

-- C2. LOCAL CLEAR — ALWAYS BEFORE C3, AND LOAD-BEARING HERE. A real punch was made on this device,
--     so it sits in `records` and in rsr_sync_pending. Delete the row while the page still holds
--     it and syncFlush() re-pushes it. Run in the kiosk console, assert the nine zeros, CLOSE THE
--     TAB, then run C3. Re-runnable; uses var.
--
--       var Z = k => String(k||'').startsWith('ZZ WALK8');
--       for (let i=employees.length-1;i>=0;i--) if (Z(employees[i].code)) employees.splice(i,1);
--       Object.keys(records).forEach(k => { if (Z(k)) delete records[k]; });
--       Object.keys(suspendedEmployees).forEach(k => { if (Z(k)) delete suspendedEmployees[k]; });
--       Object.keys(openCases).forEach(k => { if (Z(k)) delete openCases[k]; });
--       Object.keys(awolNoticeShown).forEach(k => { if (Z(k)) delete awolNoticeShown[k]; }); saveAwolNoticeShown();
--       Object.keys(syncPending).forEach(k => { if (Z(k)) delete syncPending[k]; });   savePending();
--       Object.keys(awolPending).forEach(k => { if (Z(k)) delete awolPending[k]; });   saveAwolPending();
--       Object.keys(awolUnsynced).forEach(k => { if (Z(k)) delete awolUnsynced[k]; }); saveAwolUnsynced();
--       awolDropped = awolDropped.filter(d => !Z(d.code));                             saveAwolDropped();
--       saveData();
--       ({records:Object.keys(records).filter(Z).length,
--         suspended:Object.keys(suspendedEmployees).filter(Z).length,
--         openCases:Object.keys(openCases).filter(Z).length,
--         noticeShown:Object.keys(awolNoticeShown).filter(Z).length,
--         roster:employees.filter(e=>Z(e.code)).length,
--         sync:Object.keys(syncPending).filter(Z).length,
--         awolPending:Object.keys(awolPending).filter(Z).length,
--         awolUnsynced:Object.keys(awolUnsynced).filter(Z).length,
--         awolDropped:awolDropped.filter(d=>Z(d.code)).length,
--         rawKeys:Object.keys(localStorage).filter(k=>String(localStorage.getItem(k)||'').includes('ZZ WALK8')).length})
--
--       [PASTE RESULT]
--     Two keys are NEW to this run and did not exist in earlier teardowns: openCases and
--     awolNoticeShown. A stale awolNoticeShown entry would suppress the notice on a re-run and the
--     next acceptance attempt would silently fail its own BEAT 2.

-- C3. The delete. One transaction, guarded, children before parents.
do $$
declare v_n integer;
begin
  select count(*) into v_n from public.employees
   where code like 'ZZ WALK%' and code <> 'ZZ WALK8';
  if v_n > 0 then
    raise exception 'ABORT: % unexpected ZZ WALK employee row(s). Nothing deleted.', v_n;
  end if;
  delete from public.awol_events          where employee_code = 'ZZ WALK8';
  delete from public.employee_suspensions where employee_code = 'ZZ WALK8';
  delete from public.attendance_records   where employee_code = 'ZZ WALK8';
  delete from public.leave_requests       where employee_code = 'ZZ WALK8';
  delete from public.violations           where employee_code = 'ZZ WALK8';
  delete from public.sms_log              where employee_code = 'ZZ WALK8';
  delete from public.late_break_requests  where employee_code = 'ZZ WALK8';
  delete from public.pending_approvals    where employee_code = 'ZZ WALK8';
  delete from public.straight_duty        where employee_code = 'ZZ WALK8';
  delete from public.employees            where code          = 'ZZ WALK8';
end $$;


-- ── D. VERIFY ───────────────────────────────────────────────────────────────────────────────

-- D1. Every table clean for the identity, and the barred count.
select (select count(*) from public.employees            where code          = 'ZZ WALK8') as employees,
       (select count(*) from public.attendance_records   where employee_code = 'ZZ WALK8') as attendance,
       (select count(*) from public.employee_suspensions where employee_code = 'ZZ WALK8') as suspensions,
       (select count(*) from public.awol_events          where employee_code = 'ZZ WALK8') as events,
       (select count(*) from public.leave_requests       where employee_code = 'ZZ WALK8') as leaves,
       (select count(*) from public.violations           where employee_code = 'ZZ WALK8') as violations,
       (select count(*) from public.sms_log              where employee_code = 'ZZ WALK8') as sms,
       (select count(*) from public.late_break_requests  where employee_code = 'ZZ WALK8') as late_breaks,
       (select count(*) from public.pending_approvals    where employee_code = 'ZZ WALK8') as approvals,
       (select count(*) from public.straight_duty        where employee_code = 'ZZ WALK8') as straight_duty,
       (select count(*) from public.employee_suspensions where barred_at is not null)      as barred_anywhere;
-- [PASTE RESULT]

-- D2. Real workers unchanged. IDENTICAL predicate to A1 — compare the code lists.
select employee_code, date
  from public.attendance_records
 where date in (to_char(now() at time zone 'Asia/Manila', 'MM/DD/YYYY'),
                to_char(now() at time zone 'Asia/Manila', 'YYYY-MM-DD'),
                to_char(now() at time zone 'Asia/Manila', 'FMMM/FMDD/YYYY'))
 order by employee_code;
-- [PASTE RESULT]
-- STOP CONDITION: a code present in A1 and missing here. A real worker lost a punch.

-- D3. THE REVERT PROBES. A forgotten revert is invisible — men silently never flagged, and every
--     AWOL alert going to one phone while the group stays quiet.

select count(*) as demo_holds_remaining
  from public.awol_skip_list() where reason like 'PAHIBALO ACCEPTANCE HOLD%';
-- [PASTE RESULT]

select code, skip, reason from public.awol_skip_list()
 where upper(regexp_replace(code,'[^A-Za-z0-9]','','g')) in ( /* <-- the B1 list */ )
 order by code;
-- [PASTE RESULT]

select count(*) filter (where skip) as skipped, count(*) filter (where not skip) as detectable
  from public.awol_skip_list();
-- [PASTE RESULT]
-- DERIVATION: skipped must be back to the standing count recorded at B1-VERIFY, with the held
-- codes returned to detectable.

select position('PAHIBALO ACCEPTANCE HOLD' in pg_get_functiondef('public.awol_skip_list'::regproc)) as in_skip_list,
       position('RSR' in pg_get_functiondef('public.awol_skip_list'::regproc))                      as hardcoded_codes,
       position('PAHIBALO ACCEPTANCE HOLD' in pg_get_functiondef('public.awol_skip_detection'::regproc)) as in_skip_detection,
       position('PAHIBALO ACCEPTANCE HOLD' in pg_get_functiondef('public.awol_skip_reason'::regproc))    as in_skip_reason;
-- [PASTE RESULT]
-- A TEXT probe, because a boolean probe passes a partial revert.

select key, value from public.settings where key = 'tg_awol_group';
-- [PASTE RESULT]
-- Then hard-reload any kiosk that was open, so it re-caches rsr_tg.

-- D4. Telegram message from C0 deleted by hand? The one teardown step no SQL can verify.
