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
-- ║ TEST IDENTITIES — everything you need to type, so you never query employees mid-run.       ║
-- ╚═══════════════════════════════════════════════════════════════════════════════════════════╝
--
--   code       name               kiosk PIN   site     employment_type   type_effective_from   role
--   ─────────  ─────────────────  ─────────   ──────   ───────────────   ───────────────────   ──────────
--   ZZ WALK5   Defect C Subject   955955      Carmen   regular           2026-01-05            the subject
--   ZZ WALK6   Defect C Control   966966      Carmen   regular           2026-01-05            the control
--
--   Admin PIN for every PIN-gated step (bar, reinstate): the 6-digit kiosk/dashboard admin PIN.
--   NOT owner_pin. Verified by admin_verify_passcode against kiosk_admin_credential.
--   The global throttle is fail-closed: 10 wrong tries locks BOTH tablets out of Admin for 15 min.
--
--   955955 and 966966 ARE DISPOSABLE TEST PINS. They exist for the length of this walkthrough and
--   are deleted with the employee rows in Section C. They are written in this file on purpose, so
--   nothing has to be edited in two places mid-run — but do NOT read them as a pattern: real worker
--   PINs are plaintext in employees.pin, which is its own open defect
--   (docs/superpowers/specs/2026-07-30-anon-grant-surface-on-employees.md). Never put a real PIN here.
--
--   ZZ WALK6 exists only to prove the gate is SELECTIVE. A gate that refuses everyone would pass
--   every other step of this walkthrough. He must punch normally at the moment ZZ WALK5 is refused.


-- ╔═══════════════════════════════════════════════════════════════════════════════════════════╗
-- ║ THE DETECTION HOLD — why three real workers are suppressed for this run                    ║
-- ╚═══════════════════════════════════════════════════════════════════════════════════════════╝
--
--  The sweep reads EVERY employee, not just the ZZ codes. Left alone it would, during this
--  walkthrough, act against three real men who have done nothing wrong (A5, 2026-07-31):
--
--    RSR 0005  Alvin H. Operio      leave FILED, awaiting the owner's decision (Defect E open)
--    RSR 0014  Art Clenthon Tañola  absence verbally authorised by the owner  (Defect G open).
--                                   HE PUNCHED 07/31 AND IS STILL AT RISK TODAY: the chain starts
--                                   at YESTERDAY (collectAbsentDates i=1), so a punch made today is
--                                   invisible to it and his run still reads 10. It clears itself on
--                                   08/01, when 07/31 becomes pos 1 and breaks the run.
--    RSR 0015  Niño Nieto Panut     a GENUINE unexcused absence, but he has NO case row yet
--                                   (verified A4a) and his NTE goes out on paper this week. A case
--                                   row born from a test run must not sit behind that paper trail.
--
--  RSR 0035 Allan Manos was held on 2026-07-30 and is NOT held now — his 07/30 punch became a BREAK
--  at pos 1 the next morning, run 0. That single day's difference is the whole argument for
--  rebuilding this list from a live A5 every time; see CODE LIST DEPENDENCY below.
--
--  RSR 0005 alone would not create a row — his pending leave takes the HOLD branch at
--  kiosk/index.html:2505 — but it WOULD post "Pending leave — please decide" to the AWOL group.
--  The other two would each write a suspension row AND post an alert.
--
--  HELD AT awol_skip_list() ONLY, and deliberately so:
--    - it is the sweep's SOLE call, and the skip test at :2481 fires BEFORE any DB write and
--      BEFORE any Telegram send, so one hold suppresses row + message + awolPending together;
--    - its canonical body is six lines (awol-defect-cdf.sql:493-503), so the revert cannot be
--      botched the way re-pasting awol_skip_detection's fail-open logic could be;
--    - awol_skip_detection() and awol_skip_reason() are NOT touched, so Section D can probe them
--      as independent witnesses that the verified logic never moved;
--    - awol_is_exempt(), the suspension guard and awol_set_barred() are NOT touched either, so a
--      MANUAL action on any of the three still works normally mid-run.
--
--  NO AUTO-EXPIRY, BY OWNER DECISION (2026-07-30). An earlier draft expired the hold at 23:59+08.
--  That fails in the WRONG DIRECTION: if the walkthrough runs long or stops halfway, the hold lifts
--  unattended and the next kiosk sweep opens false cases on Art at night with nobody watching. A
--  hold that waits for an explicit revert fails the other way — three men briefly not detected —
--  which costs nothing real, since two of them should be exempt anyway and the third is being
--  handled on paper. It is also the direction the attendance-gate rule requires: fail open, in the
--  worker's favour.
--
--  THE HOLD IS NOT VISIBLE IN THE UI. renderAwolCards() (kiosk/index.html:2322-2341) surfaces only
--  the whole-list failure and workers ABSENT from the list; a worker IN the list with skip=true is
--  skipped silently by design. So the tripwires are SQL-side and there are four:
--    1. Section D3 probes all three codes back to skip=false / reason NULL.
--    2. Section D3 probes the function TEXT for the word WALKTHROUGH — catches a partial revert
--       that a boolean probe would pass.
--    3. awol-defect-cdf.sql STEP 11's own verify expects skipped_must_be_10; the hold makes it 13.
--       Any future session re-running that migration's verify trips over it.
--    4. The reason string itself says NOT A REAL EXEMPTION — REVERT REQUIRED, and is dated.
--
--  THIS IS TEST SCAFFOLDING, NOT DEFECT G. G needs a real, owner-facing way to record a verbally
--  authorised absence on the day. Do not let this hold be mistaken for it or grow into it.
--
--  CODE LIST DEPENDENCY — REBUILD FROM A LIVE A5 EVERY RUN, NEVER REUSE YESTERDAY'S.
--  These three came from A5 on 2026-07-31. The list changed in 24 hours: RSR 0035 was held on 07/30
--  and had dropped off by 07/31. §2.2 of the spec is NOT a safe substitute either — its window is
--  "no attendance 07/28-07/30", which misses a man absent 3 days who punched today.
--  Hold a row only when has_30d_history = true; a false there is already stopped by the client's
--  30-day net. Any code A5 returns that you cannot account for goes into BOTH the B1 hold and the
--  D3a probe before staging, or it goes into neither and you stop.


-- ╔═══════════════════════════════════════════════════════════════════════════════════════════╗
-- ║ SECTION A — BASELINE. Read-only. Run BEFORE staging and KEEP THE OUTPUT.                  ║
-- ╚═══════════════════════════════════════════════════════════════════════════════════════════╝

-- A1. The real workers who must survive untouched. SCREENSHOT THIS — Section D compares against it.
--     Matches all three live date spellings, not just the kiosk's. `date` is TEXT in mixed formats
--     (MM/DD/YYYY from the kiosk, YYYY-MM-DD from other paths, and legacy single-digit M/D/YYYY);
--     a single-format predicate would leave today's non-kiosk rows out of the safety net entirely.
--     D2 uses the IDENTICAL predicate — if you change one, change both or the comparison is void.
select employee_code, date
  from public.attendance_records
 where date in (to_char(now() at time zone 'Asia/Manila', 'MM/DD/YYYY'),
                to_char(now() at time zone 'Asia/Manila', 'YYYY-MM-DD'),
                to_char(now() at time zone 'Asia/Manila', 'FMMM/FMDD/YYYY'))
 order by employee_code;
-- CAPTURED 2026-07-30: 30 codes — PEM 0001/0003/0004/0005, RSR 0001/0002/0003/0004/0006/0007/
-- 0008/0009/0010/0012/0013/0016/0019/0021/0022/0024/0026/0027/0028/0029/0030/0032/0033/0035/
-- 0036/0037. All 07/30/2026. RSR 0035 is Allan's 14:19 punch after the lockout cleared.

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
-- EXPECT: 0        VERIFIED 2026-07-30: 0

-- A4. PRE-CHECK behind the hold decision. Read-only. KEEP THIS OUTPUT.
-- A4a. Case state for the real workers in scope. Any row with active=false is a TRAP: the sweep's
--      upsert (awol-reinstate-flow.sql:135-147) reactivates it and wipes letter_received,
--      last_decision* and awol_group_msg_id — destroying paper-trail state. Do not stage until any
--      such row is understood.
select employee_code, active, barred_at, suspended_on, letter_received,
       last_decision, awol_group_msg_id, awol_group_chat
  from public.employee_suspensions
 where employee_code in ('RSR 0005','RSR 0014','RSR 0015','RSR 0035')
 order by employee_code;
-- VERIFIED 2026-07-30: NO ROWS for 0005 / 0014 / 0015. Nothing to protect, and nothing pre-existing
-- that a teardown could be blamed for.

-- A4b. All in scope currently DETECTABLE, so the hold is doing real work.
select code, skip, reason from public.awol_skip_list()
 where code in ('RSR 0005','RSR 0014','RSR 0015','RSR 0035') order by code;
-- VERIFIED 2026-07-30: 0005 / 0014 / 0015 all skip=false, reason NULL.

-- A4c. The Telegram revert value. Restored as a LITERAL in C1 — this file is the stash, because it
--      is committed. No new settings key is created, so there is none to clean up.
select key, value from public.settings where key in ('tg_awol_group','mgr_ids');
-- VERIFIED 2026-07-30: tg_awol_group = -5510566104 (the real AWOL group)
--                      mgr_ids       = 8586022901  (owner DM — the redirect target in B2)

-- A5. Who actually flags RIGHT NOW. Mirrors collectAbsentDates(): the chain begins YESTERDAY, so a
--     punch TODAY does not break it; a punch on any day breaks it; a no-punch Sunday is transparent;
--     an Approved leave breaks it. This is the authority for the B1 code list — NOT spec §2.2.
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
                      and l.status in ('Approved','Provisional','Pending')  -- one definition of
                      -- "explained": Approved decided, Provisional reported (G), Pending filed (E)
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
-- DO NOT EXPECT A FIXED LIST. The result is date-dependent and changes every day — a hardcoded
-- EXPECT here was already stale within 24 hours (it named RSR 0035, whose 07/30 punch became a
-- BREAK at pos 1 the next morning, run 0). Read the RULE instead:
--
--   HOLD a row only if has_30d_history = true.
--   SKIP a row with has_30d_history = false — the client's never-punched/30-day net
--        (hasRecentPunchHistory) already stops it, and holding it adds nothing.
--
-- Worked example, 2026-07-31: six rows returned, three held.
--   RSR 0000 · 18 · false  -> net-skipped. NOTE: the chain does NOT consult started_on (the kiosk
--                            has zero references to it), so his stopgap start date protects nothing.
--                            His only protection is never having punched — Defect A, §9.
--   RSR 0017 · 18 · false  -> net-skipped; separation pending in employee-separate-backdate.sql
--   RSR 0020 · 18 · false  -> net-skipped; same
--   RSR 0014 · 10 · true   -> HELD. He punched 07/31, but the chain starts YESTERDAY, so today's
--                            punch is invisible to it and he would still be flagged. Clears itself
--                            on 08/01, when 07/31 becomes pos 1 and breaks the run.
--   RSR 0005 ·  4 · true   -> HELD (pending leave — Defect E)
--   RSR 0015 ·  4 · true   -> HELD (genuine, handled on paper)
--
-- A code appearing here that you cannot account for means the chain model is wrong — stop and say
-- so before staging.


-- ╔═══════════════════════════════════════════════════════════════════════════════════════════╗
-- ║ SECTION B — STAGING. Run BEFORE the walkthrough, in this order.                           ║
-- ║ THE KIOSK MUST NOT BE OPEN OR BOOTING UNTIL B4 PASSES. It sweeps on boot.                 ║
-- ╚═══════════════════════════════════════════════════════════════════════════════════════════╝

-- B1. THE HOLD. Must be in place BEFORE the kiosk ever loads, or the sweep acts on the three first.
--     Canonical body is awol-defect-cdf.sql:493-503; the ONLY additions are the two hold clauses.
--     Codes are compared NORMALISED (spacing drifts across sources — RSR 0025 vs RSR0025 is a known
--     landmine in this repo), so the hold cannot be defeated by a stray space.
--     create or replace PRESERVES the existing grant to anon/authenticated.
create or replace function public.awol_skip_list()
returns table (code text, skip boolean, reason text)
language sql stable as $$
  select e.code,
         public.awol_skip_detection(e.code)
           or upper(regexp_replace(e.code,'[^A-Za-z0-9]','','g'))
              in ('RSR0005','RSR0014','RSR0015'),
         coalesce(
           public.awol_skip_reason(e.code),
           case when upper(regexp_replace(e.code,'[^A-Za-z0-9]','','g'))
                     in ('RSR0005','RSR0014','RSR0015')
                then 'WALKTHROUGH HOLD 2026-07-31 — NOT A REAL EXEMPTION — REVERT REQUIRED (Section C1)'
           end)
    from public.employees e
   where e.separated_at is null
   order by e.code;
$$;

-- B1-VERIFY. Both halves, or the hold is not doing what the comment claims.
select code, skip, reason from public.awol_skip_list()
 where upper(regexp_replace(code,'[^A-Za-z0-9]','','g'))
       in ('RSR0005','RSR0014','RSR0015')
 order by code;
-- EXPECT: 3 rows, skip = true, reason = 'WALKTHROUGH HOLD 2026-07-31 — ...'

select count(*) filter (where skip)     as skipped_must_be_13,
       count(*) filter (where not skip) as detectable
  from public.awol_skip_list();
-- EXPECT: 13 = 10 real skips + 3 held (as of 2026-07-31, after employee-separate-backdate.sql L2, 3-code hold).
-- The 10 is 5 pakyaw + Jamaica + 4 Mandaue and is stable; the 3 is whatever A5 returned THIS run.
-- Anything else means the code list does not match A5 — 12 or 11 is the dangerous one: a PARTIAL
-- hold lets exactly one real man through.

-- B2. TELEGRAM REDIRECT. The walkthrough's own AWOL alert for ZZ WALK5 must not land in the real
--     group. Sent to the owner's DM instead, so the alert text and the printable-letter link are
--     still verified by eye. Restored in C1.
--     SCOPE, established from main's code 2026-07-30: deployed main NEVER READS tg_awol_group. Its
--     only five 'awol' mentions are two comments and three SMS strings, and its admin dashboard has
--     no AWOL code at all. So B2 affects the LOCALHOST branch build only — the live tablets cannot
--     send an AWOL Telegram message by any path (their checkAllAbsences is a no-op; see spec §10a).
--     Restored in C1 regardless, because a shared setting left pointing at a DM is how the real
--     group goes quiet after this branch DOES ship.
update public.settings set value = '8586022901' where key = 'tg_awol_group';

-- B2-VERIFY
select key, value from public.settings where key = 'tg_awol_group';
-- EXPECT: 8586022901        Original -5510566104 is restored in C1 and probed in D3.

-- B2-THEN. DO NOT BOOT THE KIOSK YET. An earlier draft told you to hard-reload here, which
--          contradicts this section's own rule that the kiosk stays closed until B4 passes — and
--          booting now would run a sweep before the ZZ identities exist and before anything has
--          confirmed the hold took. The reload is REAL and REQUIRED, but it belongs at B5.
--          Why it is required: loadTgFromCloud() caches rsr_tg in localStorage, and the CACHED
--          value is used if the cloud read fails (kiosk/index.html:5458) — so a kiosk still holding
--          the old cache would send the test alert straight to the real AWOL group.

-- B3. The test identities.
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

-- One real punch ~5 days back for each, so hasRecentPunchHistory() is true and the absence chain
-- can reach 3. Without it the never-punched/30-day safety net skips them and no case opens.
-- Site Carmen so awol_effective_site resolves to a yard WITH a kiosk (else Defect D exempts them).
--
-- SUNDAY-AWARE, added 2026-07-31. A bare `now() - interval '5 days'` landed on Sunday 07/26 that
-- day. The run would still have passed — collectAbsentDates() tests hasTimein BEFORE the Sunday
-- skip, so the punch breaks the chain and the run reads 4 — but it writes a rest-day attendance row
-- into production, and no test should put unusual-shaped data in the one table payroll reads.
-- Computed once in a CTE so both rows are guaranteed the same date.
with pd as (
  select case when extract(dow from d) = 0 then d - 1 else d end as punch_date
    from (select (now() at time zone 'Asia/Manila')::date - 5 as d) x
)
insert into public.attendance_records (employee_code, employee_name, date, timein, timeout, site)
select v.code, v.name, to_char(pd.punch_date,'MM/DD/YYYY'), '08:00 AM', '05:00 PM', 'Carmen'
  from pd
 cross join (values ('ZZ WALK5','Defect C Subject'),
                    ('ZZ WALK6','Defect C Control')) as v(code, name)
on conflict do nothing;

-- B3-VERIFY. Confirm the punch date is a WORKING day and both rows carry it.
select employee_code, date, timein, timeout, site,
       to_char(public.leave_try_date(date), 'Day') as weekday_must_not_be_sunday
  from public.attendance_records
 where employee_code like 'ZZ WALK%'
 order by employee_code;
-- EXPECT: two rows, same date, weekday NOT Sunday, site Carmen.

-- B4. STAGING VERIFY. Both ZZ codes DETECTABLE, all three real codes HELD, in one answer.
select code, skip, reason from public.awol_skip_list()
 where code like 'ZZ WALK%'
    or upper(regexp_replace(code,'[^A-Za-z0-9]','','g'))
       in ('RSR0005','RSR0014','RSR0015')
 order by skip, code;
-- EXPECT: ZZ WALK5 and ZZ WALK6 skip=false reason NULL; the three RSR codes skip=true with the
-- WALKTHROUGH HOLD reason. If either ZZ code is skipped, no case can open and the walkthrough
-- cannot test anything.

select code, name, pin, employment_type, home_site,
       public.awol_effective_site(code) as effective_site
  from public.employees where code like 'ZZ WALK%' order by code;
-- EXPECT: both Carmen / regular, effective_site Carmen, PINs 955955 and 966966

-- Roster totals. A ZZ code that is ABSENT from the list entirely is a DIFFERENT failure from
-- skip=true and is easy to miss by eye: the sweep hits `if(!_s)` at :2481, treats the worker as
-- unknown to the server, fails open and reports him in the health banner — so no case opens and
-- the walkthrough silently tests nothing.
select count(*)                         as roster_must_be_43,
       count(*) filter (where skip)     as skipped_must_be_13,
       count(*) filter (where not skip) as detectable_must_be_30
  from public.awol_skip_list();
-- EXPECT: 43 · 13 · 30   as of 2026-07-31, after employee-separate-backdate.sql L2, ASSUMING A 3-CODE HOLD.
--   roster     43 = 41 active + 2 ZZ identities staged in B3.
--   skipped    13 = 10 real (5 pakyaw + Jamaica + 4 Mandaue) + 3 held by B1.
--   detectable 30 = 43 - 13.
-- THE HELD COUNT IS NOT A CONSTANT. B1's list is rebuilt from a live A5 every run, so if A5
-- returns N holdable codes the numbers are 43 · (10+N) · (33-N). Recompute, do not assume 3.
-- NOTE the collision: 43 meant ACTIVE ROSTER before 2026-07-31 and means WALKTHROUGH TOTAL after.
-- That is exactly why every count here now carries its derivation.


-- B5. ONLY NOW BOOT THE KIOSK. Hard-reload it (localhost) so loadTgFromCloud() replaces the cached
--     rsr_tg. Until it does, the tablet still holds the REAL AWOL group id in localStorage and
--     kiosk/index.html:5458 falls back to that cache whenever the cloud read fails — which would
--     put the ZZ WALK5 test alert in the real group, the one thing B2 exists to prevent.
--
--     CONFIRM BEFORE PUNCHING ANYTHING:
--       - the version stamp in the header is the BRANCH build, not v2026-07-30a (main). This
--         walkthrough tests the Defect C client half, which is NOT deployed — running it against a
--         main build proves nothing and the sweep there is a no-op.
--       - the browser console is clean on load (the harness wires pageerror/console.error for a
--         reason; a card that fails to render looks identical to a gate that refused).
--     The sweep runs on boot — 3 SECONDS after load (kiosk/index.html:5400, setTimeout 3000), not
--     instantly — so this reload IS the moment the cases open. Wait ~5s before judging anything.
--
--     BOTH ZZ men take a case, and that is CORRECT, not a fault. Both are detectable with a
--     4-day chain. Under Defect C a case does not bar anyone, so ZZ WALK6 ends up holding an open
--     case AND still able to punch — which is a stronger control than one with no case at all.

-- B5-VERIFY. THE C1 ASSERTION. Run after the sweep. This is the whole point of Defect C: a
--            machine may open a case, and a machine may not bar a man.
select employee_code, active, barred_at, barred_by, suspended_on, absent_dates
  from public.employee_suspensions
 where employee_code like 'ZZ WALK%' order by employee_code;
-- EXPECT: 2 rows, active = true, barred_at NULL, barred_by NULL.
-- A NON-NULL barred_at HERE IS A FAILED WALKTHROUGH — the sweep reached the punch gate and Defect C
-- is not closed. Stop, do not punch anything, and say so.

select employee_code, event, actor, note, created_at
  from public.awol_events
 where employee_code like 'ZZ WALK%' order by created_at;
-- EXPECT: 2 rows, event 'suspended', actor 'detection'. ONE row for two cases is Defect B
-- reproducing (§10) — record which code is missing its event before going on.

select count(*) as barred_anywhere_must_still_be_0
  from public.employee_suspensions where barred_at is not null;
-- EXPECT: 0


-- ╔═══════════════════════════════════════════════════════════════════════════════════════════╗
-- ║ SECTION C — TEARDOWN. Run AFTER the walkthrough. Guarded; children before parents.        ║
-- ╚═══════════════════════════════════════════════════════════════════════════════════════════╝

-- C0. CAPTURE THE TELEGRAM MESSAGE ID FIRST. Deleting the suspension row destroys it, and the
--     message stays in the chat forever otherwise. Message 6287 had to be pulled by hand
--     after the 07-30 walkthrough because this step did not exist.
select employee_code, awol_group_msg_id, awol_group_chat
  from public.employee_suspensions
 where employee_code like 'ZZ WALK%' and awol_group_msg_id is not null;
-- WRITE THESE DOWN. With B2 in force the chat will be the owner DM (8586022901), not the group.
-- Delete each message by hand after the teardown.

-- C1. LIFT THE HOLD AND RESTORE TELEGRAM. DO THIS FIRST, before the deletes — it is the step whose
--     omission does lasting harm, and a teardown that errors halfway must not leave it undone.
--     Body below is VERBATIM the canonical awol-defect-cdf.sql:493-503. Nothing else changes.
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

-- C1-VERIFY. Do not proceed to C3 until both read correctly. Full probes are in D3.
select count(*) filter (where skip) as skipped_must_be_10 from public.awol_skip_list();
select key, value from public.settings where key = 'tg_awol_group';
-- EXPECT: 10 = 5 pakyaw + Jamaica + 4 Mandaue (as of 2026-07-31, after employee-separate-backdate.sql L2), and -5510566104.
-- 13 here means C1 never ran and three real men are still held.

-- C2. LOCAL CLEAR — ALWAYS BEFORE C3. See the block below for the LOCALHOST version (targeted and
--     verifiable). The original tablet wording follows it.
--
--     LOCALHOST (this walkthrough): run the JS in the kiosk console. A blanket "clear site data" is
--     wrong here — it is unverifiable, and it destroys the rsr_sync_pending dead-letter evidence,
--     which on 2026-07-31 was the only record that a forced-rejection test punch had ever existed.
--     Targeted removal touches ONLY 'ZZ WALK' keys and can be asserted to zero afterwards.
--     MUTATE THE IN-MEMORY VARIABLE, NOT localStorage DIRECTLY, for anything saveData() owns
--     (records, suspendedEmployees, employees) — saveData() would otherwise write the old value
--     straight back over the edit.
--
--       for(let i=employees.length-1;i>=0;i--)
--         if(String(employees[i].code||'').startsWith('ZZ WALK')) employees.splice(i,1);
--       Object.keys(records).forEach(k=>{ if(k.startsWith('ZZ WALK')) delete records[k]; });
--       Object.keys(suspendedEmployees).forEach(k=>{ if(k.startsWith('ZZ WALK')) delete suspendedEmployees[k]; });
--       Object.keys(syncPending).forEach(k=>{ if(k.startsWith('ZZ WALK')) delete syncPending[k]; });   savePending();
--       Object.keys(awolPending).forEach(k=>{ if(k.startsWith('ZZ WALK')) delete awolPending[k]; });   saveAwolPending();
--       Object.keys(awolUnsynced).forEach(k=>{ if(k.startsWith('ZZ WALK')) delete awolUnsynced[k]; }); saveAwolUnsynced();
--       awolDropped = awolDropped.filter(d=>!String(d.code||'').startsWith('ZZ WALK'));               saveAwolDropped();
--       saveData();
--
--     THEN ASSERT ZERO, including a raw sweep of every localStorage key for the literal string:
--
--       ({records:Object.keys(records).filter(k=>k.startsWith('ZZ WALK')).length,
--         suspended:Object.keys(suspendedEmployees).filter(k=>k.startsWith('ZZ WALK')).length,
--         roster:employees.filter(e=>String(e.code||'').startsWith('ZZ WALK')).length,
--         sync:Object.keys(syncPending).filter(k=>k.startsWith('ZZ WALK')).length,
--         awolPending:Object.keys(awolPending).filter(k=>k.startsWith('ZZ WALK')).length,
--         awolUnsynced:Object.keys(awolUnsynced).filter(k=>k.startsWith('ZZ WALK')).length,
--         awolDropped:awolDropped.filter(d=>String(d.code||'').startsWith('ZZ WALK')).length,
--         rawKeys:Object.keys(localStorage).filter(k=>String(localStorage.getItem(k)||'').includes('ZZ WALK')).length})
--
--     ALL EIGHT MUST BE 0. Then CLOSE THE KIOSK TAB before running C3 — no page means no
--     syncFlush(), which is the only airtight guarantee against the resurrection rule.
--
--     TABLET (if this is ever run on a real kiosk) — before running C3. Clear site data / localStorage on the kiosk you punched
--     from. A queued punch in rsr_records will re-push via saveData() -> syncFlush() and undo the
--     attendance delete below. reset.html alone does NOT clear it. This also drops the stale
--     rsr_tg cache and any awolPending flags the run may have set.

-- C3. The teardown. One transaction, aborts on unexpected state, nothing half-removed.
--     Scope is ZZ WALK% ONLY — no real worker row is created at any point in this walkthrough
--     (that is what the B1 hold buys), so no real code needs to be in scope here.
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
-- ║ SECTION D — VERIFY. Compare D2 against SECTION A1. D3 is the one that must not be skipped. ║
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
--     Predicate is IDENTICAL to A1 by design. Do not change one without the other.
select employee_code, date
  from public.attendance_records
 where date in (to_char(now() at time zone 'Asia/Manila', 'MM/DD/YYYY'),
                to_char(now() at time zone 'Asia/Manila', 'YYYY-MM-DD'),
                to_char(now() at time zone 'Asia/Manila', 'FMMM/FMDD/YYYY'))
 order by employee_code;
-- EXPECT: identical to A1's 30 codes. The COUNT may be higher if men punched during the walkthrough
-- — normal. A code present in A1 and MISSING here means a real worker lost a punch: stop and say so.

-- D3. THE REVERT PROBES. Four checks, because a forgotten revert here is INVISIBLE — no UI surfaces
--     it, and its two failure modes are both silent: four men never flagged again, and every AWOL
--     alert going to one phone while the group goes quiet. Nobody notices silence.

-- D3a. All four codes detectable again, with no reason string.
select code, skip, reason from public.awol_skip_list()
 where upper(regexp_replace(code,'[^A-Za-z0-9]','','g'))
       in ('RSR0005','RSR0014','RSR0015')
 order by code;
-- EXPECT: 3 rows, skip = false, reason NULL. Any true, or any reason text, means the hold is live.

-- D3b. The skip list is back to its verified shape — the same assertion awol-defect-cdf.sql STEP 11
--      makes, so this and that migration cannot disagree.
select count(*) filter (where skip)     as skipped_must_be_10,
       count(*) filter (where not skip) as detectable
  from public.awol_skip_list();
-- EXPECT: 10 = 5 pakyaw + Jamaica + 4 Mandaue (as of 2026-07-31, after employee-separate-backdate.sql L2). A 13 means C1 never ran.

-- D3c. TEXT probe on the function body — catches a partial or mistyped revert that D3a would pass.
--      Also asserts the two functions the hold deliberately never touched are still intact.
select position('WALKTHROUGH' in pg_get_functiondef('public.awol_skip_list'::regproc))
         as must_be_0_skip_list,
       position('RSR' in pg_get_functiondef('public.awol_skip_list'::regproc))
         as must_be_0_no_hardcoded_codes,
       position('WALKTHROUGH' in pg_get_functiondef('public.awol_skip_detection'::regproc))
         as must_be_0_skip_detection,
       position('WALKTHROUGH' in pg_get_functiondef('public.awol_skip_reason'::regproc))
         as must_be_0_skip_reason;
-- EXPECT: 0 · 0 · 0 · 0

-- D3d. Telegram back on the real group. If this is wrong, AWOL alerts go to one phone and the group
--      goes silent — and silence is not noticed until an AWOL case is missed.
select key, value,
       (value = '-5510566104') as must_be_true
  from public.settings where key = 'tg_awol_group';
-- EXPECT: -5510566104, must_be_true = t
-- THEN hard-reload BOTH tablets' kiosks so each re-caches rsr_tg. Until a tablet reloads it still
-- holds the DM in localStorage and would send there on a cloud-read failure.

-- D4. Telegram messages from C0 deleted by hand? Tick this off deliberately — it is the one
--     teardown step no SQL can verify.
