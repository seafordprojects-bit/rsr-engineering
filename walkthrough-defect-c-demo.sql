-- ═══════════════════════════════════════════════════════════════════════════════════════════
--  DEFECT C — DEMO RUN. ONE IDENTITY (ZZ WALK7), NO CONTROL. Everything reverts SAME DAY.
--
--  Derived from walkthrough-defect-c.sql. Differences, all deliberate:
--    · ONE identity. The control (WALK6) existed to prove the gate is SELECTIVE — that it refuses
--      the barred man and not everyone. A DEMO does not need that proof, so it is dropped. BE AWARE
--      OF WHAT YOU GIVE UP: with no control, a gate that refused EVERY worker would pass this run
--      looking correct. Do not read a demo pass as a verification pass.
--    · ZZ WALK7 NEVER PUNCHES. This is the important one. The punch gate refuses only when there is
--      NO OPEN SHIFT (kiosk :2095). Punching first gives him an open shift, the bar then correctly
--      declines to refuse him, and the demo shows nothing. He enters his PIN, the card renders, and
--      that is the whole "a case does not bar" step. No punch window to wait for either — the PIN
--      gate fires at any hour, unlike Time In which is shut 10:00-12:40 and after 15:00.
--
--  IF ONLY THE SCREEN IS WANTED, DO NOT RUN THIS. In the kiosk console on localhost:
--    showBisayaModal('GI-SUSPEND ANG IMONG ACCOUNT\n\nAbsent ka og 3+ ka adlaw nga sunod-sunod nga
--    walay approved nga leave.\n\nKuhaa ug sulati ang AWOL letter, ihatag sa coordinator, dayon
--    hulaton ang approval sa admin una ka maka-punch.');
--  Same modal, verbatim from kiosk/index.html:2102. No writes, no hold, nothing to revert.
--
--  IDENTITY:  ZZ WALK7 · "Defect C Demo" · PIN 977977 · Carmen · regular · daily_rate 0
--  PIN is disposable and deleted in Section C. Never a real worker's PIN here.
--  Admin PIN for the bar/reinstate steps is the 6-digit kiosk/dashboard PIN, NOT owner_pin.
--  The throttle is GLOBAL and fail-closed: 10 wrong tries locks Admin on every device for 15 min.
-- ═══════════════════════════════════════════════════════════════════════════════════════════


-- ── A. BASELINE — read-only, run first, keep the output ─────────────────────────────────────

-- A1. Today's real punchers. Section D compares against this. SCREENSHOT IT.
select employee_code, date
  from public.attendance_records
 where date in (to_char(now() at time zone 'Asia/Manila', 'MM/DD/YYYY'),
                to_char(now() at time zone 'Asia/Manila', 'YYYY-MM-DD'),
                to_char(now() at time zone 'Asia/Manila', 'FMMM/FMDD/YYYY'))
 order by employee_code;

-- A2. ZZ WALK7 must not already exist, anywhere.
select (select count(*) from public.employees            where code          like 'ZZ WALK7%') as employees,
       (select count(*) from public.attendance_records   where employee_code like 'ZZ WALK7%') as attendance,
       (select count(*) from public.employee_suspensions where employee_code like 'ZZ WALK7%') as suspensions,
       (select count(*) from public.awol_events          where employee_code like 'ZZ WALK7%') as events,
       (select count(*) from public.leave_requests       where employee_code like 'ZZ WALK7%') as leaves,
       (select count(*) from public.violations           where employee_code like 'ZZ WALK7%') as violations,
       (select count(*) from public.sms_log              where employee_code like 'ZZ WALK7%') as sms,
       (select count(*) from public.late_break_requests  where employee_code like 'ZZ WALK7%') as late_breaks,
       (select count(*) from public.pending_approvals    where employee_code like 'ZZ WALK7%') as approvals,
       (select count(*) from public.straight_duty        where employee_code like 'ZZ WALK7%') as straight_duty;
-- EXPECT: all ten = 0

-- A3. Nobody barred before we start, or the refusal step proves nothing.
select count(*) as barred_must_be_0 from public.employee_suspensions where barred_at is not null;
-- EXPECT: 0

-- A5. WHO WOULD BE FLAGGED TODAY. The hold list comes from THIS, run today, never from yesterday's.
--     Mirrors collectAbsentDates(): chain begins YESTERDAY, a punch today does not break it, a
--     punch on any day breaks it, a no-punch Sunday is transparent, an Approved leave breaks it.
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
--
-- THE RULE, NOT A LIST: hold a row ONLY if has_30d_history = true. A false there is already stopped
-- by the client's never-punched/30-day net and holding it adds nothing.
-- DO NOT REUSE AN EARLIER DAY'S ANSWER. On 07/30 the list held RSR 0035; by 07/31 his 07/30 punch
-- had become a BREAK at pos 1 and he was gone from it. One day changed the list.
-- EXPECT on 2026-08-01, for orientation only — VERIFY, do not assume: RSR 0005 and RSR 0015 still
-- running, RSR 0014 CLEARED (his 07/31 punch is pos 1 on 08/01 and breaks the chain), plus the
-- has_30d_history = false rows (RSR 0000, and RSR 0017 / RSR 0020 are now separated and gone).


-- ── B. STAGING — kiosk CLOSED until B4 passes. It sweeps on boot. ───────────────────────────

-- B1. THE HOLD. Substitute the codes A5 just returned with has_30d_history = true, NORMALISED
--     (no spaces, upper). Canonical body is awol-defect-cdf.sql:493-503; the only additions are the
--     two hold clauses. create or replace PRESERVES the existing grant.
create or replace function public.awol_skip_list()
returns table (code text, skip boolean, reason text)
language sql stable as $$
  select e.code,
         public.awol_skip_detection(e.code)
           or upper(regexp_replace(e.code,'[^A-Za-z0-9]','','g'))
              in ( /* <-- A5's codes, e.g. 'RSR0005','RSR0015' */ ),
         coalesce(
           public.awol_skip_reason(e.code),
           case when upper(regexp_replace(e.code,'[^A-Za-z0-9]','','g'))
                     in ( /* <-- THE SAME LIST, both places */ )
                then 'DEMO HOLD 2026-08-01 — NOT A REAL EXEMPTION — REVERT REQUIRED (Section C1)'
           end)
    from public.employees e
   where e.separated_at is null
   order by e.code;
$$;

-- B1-VERIFY. Both halves.
select code, skip, reason from public.awol_skip_list()
 where reason like 'DEMO HOLD%' order by code;
-- EXPECT: exactly the codes you put in B1, skip = true.

select count(*) filter (where skip)     as skipped,
       count(*) filter (where not skip) as detectable,
       count(*)                         as roster
  from public.awol_skip_list();
-- EXPECT: skipped = 10 + N held. The 10 is 5 pakyaw + Jamaica + 4 Mandaue and is stable; N is
-- whatever A5 returned TODAY. roster = 41 active (43 rows less the 2 separated 2026-07-31), + 1
-- once B3 has run. A PARTIAL hold is the dangerous failure: it lets exactly one real man through.

-- B2. TELEGRAM REDIRECT — the demo's own alert must not land in the real AWOL group.
--     Deployed main never reads tg_awol_group, so this affects the LOCALHOST build only.
--     Restored in C1 and probed in D3.
update public.settings set value = '8586022901' where key = 'tg_awol_group';
select key, value from public.settings where key = 'tg_awol_group';
-- EXPECT: 8586022901. An UPDATE 0 means the key name is wrong and nothing was redirected — STOP.

-- B3. THE IDENTITY. daily_rate 0 keeps him unpayable.
insert into public.employees
  (id, code, name, home_site, daily_rate, vl_balance, sl_balance, phone, pin,
   employment_type, type_effective_from)
values
  (gen_random_uuid(), 'ZZ WALK7', 'Defect C Demo', 'Carmen', 0, 0, 0, null, '977977', 'regular', '2026-01-05')
on conflict do nothing;

-- One real punch ~5 days back, so hasRecentPunchHistory() is true and the chain can reach 3.
-- SUNDAY-AWARE: steps back one more day if the target lands on a Sunday, so no rest-day attendance
-- row is ever written. Computed once in a CTE.
with pd as (
  select case when extract(dow from d) = 0 then d - 1 else d end as punch_date
    from (select (now() at time zone 'Asia/Manila')::date - 5 as d) x
)
insert into public.attendance_records (employee_code, employee_name, date, timein, timeout, site)
select 'ZZ WALK7', 'Defect C Demo', to_char(pd.punch_date,'MM/DD/YYYY'), '08:00 AM', '05:00 PM', 'Carmen'
  from pd
on conflict do nothing;

-- B3-VERIFY. Punch date must be a WORKING day.
select employee_code, date, timein, timeout, site,
       to_char(public.leave_try_date(date), 'Day') as weekday_must_not_be_sunday
  from public.attendance_records where employee_code = 'ZZ WALK7';
-- EXPECT: one row. On 2026-08-01 the target is 07/27/2026, a Monday — no Sunday step-back needed.

-- B4. STAGING VERIFY — the last gate before the kiosk opens.
select code, skip, reason from public.awol_skip_list()
 where code = 'ZZ WALK7' or reason like 'DEMO HOLD%' order by skip, code;
-- EXPECT: ZZ WALK7 skip = false, reason NULL; every held code skip = true with the DEMO HOLD reason.
-- ZZ WALK7 skipped -> no case can open. ZZ WALK7 ABSENT from the list entirely -> worse: the sweep
-- treats him as unknown, fails open, and reports him, so nothing happens and nothing looks wrong.

select code, name, pin, employment_type, home_site,
       public.awol_effective_site(code) as effective_site
  from public.employees where code = 'ZZ WALK7';
-- EXPECT: Carmen / regular, effective_site Carmen, PIN 977977.


-- ── BOOT CHECKLIST — the on-screen part ─────────────────────────────────────────────────────
--
--  0. CONFIRM THE WORKING TREE FIRST. The demo serves the TREE, not a commit, so a wrong branch or
--     a stray edit silently changes what is demonstrated:
--         git -C C:\Users\PC\Documents\rsr-engineering branch --show-current
--         git -C C:\Users\PC\Documents\rsr-engineering diff --stat -- kiosk/index.html
--     EXPECT: awol-suspension-flow, and NO diff. Verified 2026-08-01: branch correct, tree clean,
--     stamp v2026-07-31a, and the SMS disable present with `return;` at kiosk/index.html:4905 — so
--     the demo build cannot fire an absence SMS at 17:00 even if it is still open then.
--
--  1. SERVE THE REPO ROOT — not kiosk/. The printable-letter link in the AWOL alert is built from
--     location.pathname with /kiosk stripped, so serving the subdirectory breaks it.
--     One command, no cd needed (Python 3.7+):
--         python -m http.server 8080 --directory C:\Users\PC\Documents\rsr-engineering
--
--     THE URL, with cache-buster:
--         http://localhost:8080/kiosk/index.html?site=Carmen&cb=1785539164
--
--     Change the cb value on every boot (any new number will do) or hard-reload with Ctrl+Shift+R.
--     ?site=Carmen is read at kiosk :4809 and sets activeSite; cb is ignored by the page and exists
--     only to defeat the browser cache. Extra params are harmless.
--
--  2. STAMP MUST READ v2026-07-31a. Deployed main is v2026-07-30a — one character apart. A cached
--     main build makes the sweep a no-op and the demo shows nothing. Ctrl+Shift+R if it reads 30a.
--  3. Console clean on load (no-camera warnings are expected and harmless).
--  4. SEED THE PUNCH INTO localStorage. The kiosk has ZERO .select() calls on attendance_records —
--     it never pulls history down — so the row staged in B3 is INVISIBLE to the sweep until the
--     client holds it. Without this the sweep silently does nothing, logs nothing, and looks
--     identical to not having run. In the console, substituting B3-VERIFY's date:
--
--       records['ZZ WALK7_07/27/2026'] = {code:'ZZ WALK7',
--         punches:{timein:'08:00 AM',timeout:'05:00 PM'}, msMap:{}, isLate:false, lateMs:0,
--         photos:{}, clockedSite:'Carmen', hasAllowance:false, allowanceAmt:0, nightShift:false};
--       saveData(); location.reload();
--
--     saveData() writes localStorage only — no queueRecord, so nothing is pushed to Supabase.
--  5. WAIT ~5 SECONDS after reload. The sweep is on a 3-second timer (kiosk :5400), not instant.
--  6. Expect: ONE case opened, ONE Telegram alert in the owner DM, and NOBODY barred.
--
--  DEMO-VERIFY — the C1 assertion, the point of the whole thing:
--      select employee_code, active, barred_at, barred_by, absent_dates
--        from public.employee_suspensions where employee_code = 'ZZ WALK7';
--      -- EXPECT: active = true, barred_at NULL, barred_by NULL.
--      -- A NON-NULL barred_at IS A FAILED DEMO: the sweep reached the punch gate.
--      select employee_code, event, actor from public.awol_events where employee_code = 'ZZ WALK7';
--      -- EXPECT: one row, 'suspended', actor 'detection'.
--
--  7. ENTER PIN 977977 AT THE KIOSK. He is NOT barred, so the card renders normally.
--     THIS IS THE "a case does not bar" STEP. Do not punch anything.
--  8. Dashboard http://localhost:8080/ -> AWOL card -> "Bar from starting work" -> admin PIN.
--     Expect the GI-BAR message in the DM.
--  9. WAIT UP TO 45 SECONDS. setInterval(loadSuspensionsFromCloud, 45000) at :5468 is how the
--     kiosk learns. Testing at 5 seconds shows him passing, and that is not a failure. Reload to
--     skip the wait.
-- 10. ENTER PIN 977977 AGAIN -> REFUSED at PIN entry, "GI-SUSPEND ANG IMONG ACCOUNT". THE VISUAL.
-- 11. Dashboard -> "Reinstate — he can punch again" -> admin PIN. Expect GI-REINSTATE in the DM.
-- 12. ENTER PIN 977977 -> accepted ON THE FIRST ATTEMPT. He is still in the kiosk's stale barred
--     map; the gate re-fetches BEFORE refusing and clears him. A refusal that only clears on the
--     SECOND try is a regression of the ordering fix — report it, do not retry past it.


-- ── C. TEARDOWN — same day, in this order ───────────────────────────────────────────────────

-- C0. CAPTURE THE TELEGRAM MESSAGE ID FIRST — deleting the suspension row destroys it.
select employee_code, awol_group_msg_id, awol_group_chat
  from public.employee_suspensions
 where employee_code = 'ZZ WALK7' and awol_group_msg_id is not null;
-- WRITE IT DOWN. Chat must read 8586022901, not -5510566104. Then delete BY HAND in Telegram:
-- this id, plus the GI-BAR and GI-REINSTATE messages, whose ids are never stored.

-- C1. LIFT THE HOLD AND RESTORE TELEGRAM. FIRST, before any delete — it is the step whose omission
--     does lasting harm, and a teardown that errors halfway must not leave it undone.
--     Body below is VERBATIM the canonical awol-defect-cdf.sql:493-503.
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

select count(*) filter (where skip) as skipped_must_be_10 from public.awol_skip_list();
select key, value from public.settings where key = 'tg_awol_group';
-- EXPECT: 10 (= 5 pakyaw + Jamaica + 4 Mandaue, as of 2026-08-01), and -5510566104.

-- C2. LOCAL CLEAR — ALWAYS BEFORE C3. A queued punch would re-push via syncFlush() and undo the
--     delete. In the kiosk console, then CLOSE THE TAB (no page, no syncFlush — the only airtight
--     guarantee). Re-runnable; uses var.
--
--       var Z = k => String(k||'').startsWith('ZZ WALK7');
--       for (let i=employees.length-1;i>=0;i--) if (Z(employees[i].code)) employees.splice(i,1);
--       Object.keys(records).forEach(k => { if (Z(k)) delete records[k]; });
--       Object.keys(suspendedEmployees).forEach(k => { if (Z(k)) delete suspendedEmployees[k]; });
--       Object.keys(syncPending).forEach(k => { if (Z(k)) delete syncPending[k]; });   savePending();
--       Object.keys(awolPending).forEach(k => { if (Z(k)) delete awolPending[k]; });   saveAwolPending();
--       Object.keys(awolUnsynced).forEach(k => { if (Z(k)) delete awolUnsynced[k]; }); saveAwolUnsynced();
--       awolDropped = awolDropped.filter(d => !Z(d.code));                             saveAwolDropped();
--       saveData();
--       ({records:Object.keys(records).filter(Z).length,
--         suspended:Object.keys(suspendedEmployees).filter(Z).length,
--         roster:employees.filter(e=>Z(e.code)).length,
--         sync:Object.keys(syncPending).filter(Z).length,
--         awolPending:Object.keys(awolPending).filter(Z).length,
--         awolUnsynced:Object.keys(awolUnsynced).filter(Z).length,
--         awolDropped:awolDropped.filter(d=>Z(d.code)).length,
--         rawKeys:Object.keys(localStorage).filter(k=>String(localStorage.getItem(k)||'').includes('ZZ WALK7')).length})
--
--     ALL EIGHT MUST BE 0.

-- C3. The delete. One transaction, guarded, children before parents.
do $$
declare v_n integer;
begin
  select count(*) into v_n from public.employees
   where code like 'ZZ WALK%' and code <> 'ZZ WALK7';
  if v_n > 0 then
    raise exception 'ABORT: % unexpected ZZ WALK employee row(s). Nothing deleted.', v_n;
  end if;

  delete from public.awol_events          where employee_code = 'ZZ WALK7';
  delete from public.employee_suspensions where employee_code = 'ZZ WALK7';
  delete from public.attendance_records   where employee_code = 'ZZ WALK7';
  delete from public.leave_requests       where employee_code = 'ZZ WALK7';
  delete from public.violations           where employee_code = 'ZZ WALK7';
  delete from public.sms_log              where employee_code = 'ZZ WALK7';
  delete from public.late_break_requests  where employee_code = 'ZZ WALK7';
  delete from public.pending_approvals    where employee_code = 'ZZ WALK7';
  delete from public.straight_duty        where employee_code = 'ZZ WALK7';
  delete from public.employees            where code          = 'ZZ WALK7';
end $$;


-- ── D. VERIFY ───────────────────────────────────────────────────────────────────────────────

-- D1. Every table clean for the one identity, and nobody barred.
select (select count(*) from public.employees            where code          = 'ZZ WALK7') as employees_0,
       (select count(*) from public.attendance_records   where employee_code = 'ZZ WALK7') as attendance_0,
       (select count(*) from public.employee_suspensions where employee_code = 'ZZ WALK7') as suspensions_0,
       (select count(*) from public.awol_events          where employee_code = 'ZZ WALK7') as events_0,
       (select count(*) from public.leave_requests       where employee_code = 'ZZ WALK7') as leaves_0,
       (select count(*) from public.violations           where employee_code = 'ZZ WALK7') as violations_0,
       (select count(*) from public.sms_log              where employee_code = 'ZZ WALK7') as sms_0,
       (select count(*) from public.late_break_requests  where employee_code = 'ZZ WALK7') as late_breaks_0,
       (select count(*) from public.pending_approvals    where employee_code = 'ZZ WALK7') as approvals_0,
       (select count(*) from public.straight_duty        where employee_code = 'ZZ WALK7') as straight_duty_0,
       (select count(*) from public.employee_suspensions where barred_at is not null)      as barred_anywhere_0;
-- EXPECT: all eleven = 0

-- D2. Real workers unchanged. IDENTICAL predicate to A1 — compare code lists.
select employee_code, date
  from public.attendance_records
 where date in (to_char(now() at time zone 'Asia/Manila', 'MM/DD/YYYY'),
                to_char(now() at time zone 'Asia/Manila', 'YYYY-MM-DD'),
                to_char(now() at time zone 'Asia/Manila', 'FMMM/FMDD/YYYY'))
 order by employee_code;
-- A code present in A1 and MISSING here means a real worker lost a punch. Stop and say so.

-- D3. THE REVERT PROBES. A forgotten revert here is INVISIBLE: men silently never flagged, and
--     every AWOL alert going to one phone while the group stays quiet. Nobody notices silence.

-- D3a. No DEMO HOLD survives anywhere — this replaces naming today's codes, so it cannot go stale.
select count(*) as demo_holds_must_be_0
  from public.awol_skip_list() where reason like 'DEMO HOLD%';
-- EXPECT: 0

-- D3b. Every code A5 returned is detectable again. Paste TODAY's list here.
select code, skip, reason from public.awol_skip_list()
 where upper(regexp_replace(code,'[^A-Za-z0-9]','','g'))
       in ( /* <-- the same list used in B1 */ )
 order by code;
-- EXPECT: skip = false, reason NULL, on every one.

-- D3c. The skip list is back to its verified shape.
select count(*) filter (where skip)     as skipped_must_be_10,
       count(*) filter (where not skip) as detectable
  from public.awol_skip_list();
-- EXPECT: 10 = 5 pakyaw + Jamaica + 4 Mandaue, as of 2026-08-01. Anything higher means C1 never ran.

-- D3d. TEXT probe — catches a partial or mistyped revert that a boolean probe would pass, and
--      asserts the two functions the hold never touched are still intact.
select position('DEMO HOLD' in pg_get_functiondef('public.awol_skip_list'::regproc))
         as must_be_0_skip_list,
       position('RSR' in pg_get_functiondef('public.awol_skip_list'::regproc))
         as must_be_0_no_hardcoded_codes,
       position('DEMO HOLD' in pg_get_functiondef('public.awol_skip_detection'::regproc))
         as must_be_0_skip_detection,
       position('DEMO HOLD' in pg_get_functiondef('public.awol_skip_reason'::regproc))
         as must_be_0_skip_reason;
-- EXPECT: 0 · 0 · 0 · 0

-- D3e. Telegram back on the real group.
select key, value, (value = '-5510566104') as must_be_true
  from public.settings where key = 'tg_awol_group';
-- EXPECT: -5510566104, true.

-- D4. Telegram messages from C0 deleted by hand — the alert, the GI-BAR and the GI-REINSTATE.
--     The only teardown step no SQL can verify. Tick it off deliberately.
