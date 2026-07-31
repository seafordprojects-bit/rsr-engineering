-- ═══════════════════════════════════════════════════════════════════════════════════════════
--  WHO THE PRE-DISABLE BUILD WOULD HAVE TEXTED AT 17:00 TODAY — per tablet. READ-ONLY.
--
--  PURPOSE. `sms_log` held ZERO rows after 17:00 on 2026-07-31, the first quiet evening in over a
--  month, and the absence-SMS path was disabled that morning (commit 6f6338f, kiosk v2026-07-30a,
--  ported to the branch as v2026-07-31a). A zero is consistent with the disable working. It is ALSO
--  consistent with nobody having qualified. This query separates the two.
--
--  RUN IT WHILE "TODAY" IS STILL THE DAY UNDER TEST. The deployed counter adds 1 for today, so its
--  arithmetic can only be measured live — reconstructing it tomorrow changes every number.
--
--  IT MODELS THE DEPLOYED BUILD EXACTLY (main kiosk/index.html), not the branch and not the fix:
--    :2222  getConsecutiveAbsences -> i = 1..7 back from YESTERDAY, break on the first non-absent
--           day, TODAY IS NOT COUNTED. So the counter tops out at 7.
--    :4493  consecutive = that + 1  (today included), and the whole worker is SKIPPED if he punched
--           today. Bound is `consecutive >= 1 && consecutive <= 3`.
--           NOTE count = 0 QUALIFIES: a man who punched yesterday and not today is day 1.
--    Sunday is INVISIBLE — the deployed counter has no rest-day concept whatsoever.
--    NO exemptions of any kind: no awol_skip_list(), no pakyaw, no is_non_punching, no site gate.
--    The LEAVE GUARD IS INERT ON DEPLOYED. onLeaveToday (:1341) and isAbsentOnDate both compare
--      r.startDate <= todayKey(), i.e. 'YYYY-MM-DD' <= 'MM/DD/YYYY' — a lexicographic compare that
--      is ALWAYS false. So approved leave neither suppresses the send nor breaks the chain. This is
--      the same date-format defect the branch fixed for the detector on 2026-07-26, still live in
--      the SMS path. Modelled faithfully here, and surfaced as its own column.
--    sendAbsenceSMS returns early on `!emp.phone`, BEFORE writing sms_log — so a man can qualify
--      and still leave no row. Qualifying and logging are different events; both are reported.
--
--  WHY PER-SITE. Each tablet computes this from its OWN localStorage, and the kiosk has ZERO
--  .select() calls on attendance_records — it never pulls history down. A Carmen tablet therefore
--  knows only Carmen punches. Site is matched with LIKE on purpose: the column drifts ("A" vs
--  "Site A") and an equality test would silently drop rows.
--
--  employees is NOT filtered on separated_at, deliberately: the kiosk's roster sync does not carry
--  that column, so a just-separated man may still sit in a tablet's local roster. separated_at is
--  reported instead, so it is visible rather than assumed.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

with tz as (select (now() at time zone 'Asia/Manila')::date as today),
sites as (select * from (values ('Carmen'),('Mandaue')) v(site)),
emp as (select code, name, phone, separated_at from public.employees),
nrm as (select code, upper(regexp_replace(code,'[^A-Za-z0-9]','','g')) as k from emp),
days as (
  select n.code, s.site, g.d::date as d,
         row_number() over (partition by n.code, s.site order by g.d desc) as pos
    from nrm n cross join sites s cross join tz
    cross join lateral generate_series(tz.today - 7, tz.today - 1, interval '1 day') g(d)
),
cls as (
  select dd.code, dd.site, dd.pos,
         exists (select 1 from public.attendance_records a
                  where upper(regexp_replace(a.employee_code,'[^A-Za-z0-9]','','g'))
                      = upper(regexp_replace(dd.code,'[^A-Za-z0-9]','','g'))
                    and public.leave_try_date(a.date) = dd.d
                    and a.timein is not null and a.timein <> '(auto-skipped)'
                    and upper(coalesce(a.site,'')) like '%'||upper(dd.site)||'%') as punched
    from days dd
),
fp as (select code, site, min(pos) as ppos from cls where punched group by code, site),
cnt as (
  select c.code, c.site,
         count(*) filter (where not c.punched and c.pos < coalesce(f.ppos, 999)) as absent_before_today
    from cls c left join fp f on f.code = c.code and f.site = c.site
   group by c.code, c.site
),
todaypunch as (
  select n.code, s.site,
         exists (select 1 from public.attendance_records a cross join tz
                  where upper(regexp_replace(a.employee_code,'[^A-Za-z0-9]','','g')) = n.k
                    and public.leave_try_date(a.date) = tz.today
                    and a.timein is not null and a.timein <> '(auto-skipped)'
                    and upper(coalesce(a.site,'')) like '%'||upper(s.site)||'%') as punched_today
    from nrm n cross join sites s
),
lv as (
  select n.code,
         exists (select 1 from public.leave_requests l cross join tz
                  where upper(regexp_replace(l.employee_code,'[^A-Za-z0-9]','','g')) = n.k
                    and l.status = 'Approved'
                    and public.leave_try_date(l.start_date::text) <= tz.today
                    and public.leave_try_date(coalesce(l.end_date::text,l.start_date::text)) >= tz.today
                ) as on_approved_leave_today
    from nrm n
)
select c.site, e.code, e.name,
       c.absent_before_today                                  as counter_before_today,
       c.absent_before_today + 1                              as sms_day_number,
       t.punched_today,
       (e.phone is not null and btrim(e.phone) <> '')         as has_phone,
       lv.on_approved_leave_today,
       e.separated_at,
       (not t.punched_today and c.absent_before_today + 1 between 1 and 3) as would_qualify,
       (not t.punched_today and c.absent_before_today + 1 between 1 and 3
        and e.phone is not null and btrim(e.phone) <> '')     as would_write_sms_log_row
  from cnt c
  join emp e on e.code = c.code
  join todaypunch t on t.code = c.code and t.site = c.site
  join lv on lv.code = c.code
 where not t.punched_today
   and c.absent_before_today + 1 between 1 and 3
 order by c.site, c.absent_before_today desc, e.code;


-- ── RESULT — RUN LIVE 2026-07-31, AFTER 17:00 MANILA ────────────────────────────────────────
--
--  TWO qualifiers, both Carmen, both day 1 (counter 0 — punched 07/30, not 07/31):
--      PEM 0004  Erwin            has_phone = false
--      RSR 0001  Elias Entero     has_phone = false
--  MANDAUE: zero rows. The structural silence held exactly as predicted — it holds no punches for
--  anyone, so every worker ran to the 7-day cap and landed at day 8, outside the bound.
--
--  VERDICT: 2026-07-31 DISCRIMINATES NOTHING. The path was live for these two in the sense that
--  they qualified — but it would have written NO evidence either way, on both channels:
--    · sms_log   — sendAbsenceSMS returns on !emp.phone BEFORE the log write, and neither man has
--                  a phone. Zero rows was guaranteed with or without the disable.
--    · violations — the write is a SIBLING statement below the return; (main :4532), gated on
--                  `consecutive === 3` EXACTLY. Both men are at day 1. It could not have fired.
--  STRUCK 2026-07-31 (owner): an earlier draft here said the quiet evening "proves the device was
--  awake". IT DOES NOT. With BOTH channels blind, nothing on 07/31 measured the device at all. The
--  three-for-three at 17:00 on 07/28-07/30 remains valid evidence FOR THOSE DAYS — a message fired,
--  so the tick ran — but it says nothing about 07/31. Device-wakefulness on 07/31 is UNMEASURED.
--
--  WHAT A CLEAN KILL NEEDS
--    · for sms_log:    a qualifier at day 1..3 WITH a phone.
--    · for violations: a man at day 3 EXACTLY — no phone required, so this is the stronger test.
--
--  DATED PREDICTION FROM THIS RUN. If neither man punches on 2026-08-01, both reach day 3 on
--  SUNDAY 2026-08-02 (counter 2 from Sat 08/01 + Fri 07/31, plus one for today). The pre-disable
--  build would have written TWO violation rows on a Sunday, one of them against a PAKYAW man.
--  That is precisely what the disable is holding back this weekend, and it is the Sunday-unaware
--  counter in its purest form: a rest day counted as an absence, escalating a man to a permanent
--  disciplinary record.
--
--  ALSO MEASURED, and now spec rev2 §10a: PEM 0004 is PAKYAW and qualified anyway. The SMS path
--  has no code filter and never consults awol_skip_list(), so the pakyaw exemption never reaches
--  it. Measured on 2026-07-31, not inferred from reading.
--

-- ── WEEKEND PROTOCOL — the 2026-08-02 tripwire (owner, 2026-07-31) ──────────────────────────
--
--  ARMING CONDITION: neither PEM 0004 nor RSR 0001 punches on Saturday 2026-08-01.
--  If so, both reach DAY 3 on Sunday 2026-08-02 (counter 2 from Sat 08/01 + Fri 07/31, plus one
--  for today), which is the violations channel — PHONE-INDEPENDENT, so the blank-phone blindness
--  that made 07/31 undecidable does not apply. That is why Sunday is the strong test.
--  If either man punches Saturday his chain breaks and he is back to day 1 on Sunday: no violation,
--  no evidence, tripwire disarmed for him.
--
--  MONDAY READS, in order:
--    1. Saturday 08/01 attendance for both men   -> did the tripwire arm at all?
--    2. violations rows dated 08/02              -> ANY row = a stale build is still running the
--                                                   path somewhere. That is the catch.
--    3. kiosk_sweep_log row for sweep_date 08/02 -> unverified flag + note.
--
--  DECISION TABLE
--    armed + ZERO 08/02 violations + tablet demonstrably awake at 17:00 -> DISABLE MEASURED, strong
--                                                                          channel. This is the win.
--    armed + ANY 08/02 violations row                                   -> stale build caught; find
--                                                                          the device and re-stamp it.
--    not armed (either man punched Saturday)                            -> nothing proved; re-arm.
--    armed + zero violations + wakefulness UNKNOWN                      -> STILL UNDECIDED. Do not
--                                                                          record it as a pass.
--
--  THE WAKEFULNESS LEG IS THE WEAK ONE, AND kiosk_health CANNOT CARRY IT.
--  sendHeartbeat (kiosk :6100) upserts onConflict device_id every 5 minutes (:6120) — ONE ROW PER
--  DEVICE, OVERWRITTEN IN PLACE. No history table exists in any SQL file in this repo. Reading
--  kiosk_health on Monday describes MONDAY; Sunday 17:00 is long overwritten. It is an excellent
--  real-time instrument (5-min resolution, IS_LOCALHOST-guarded so only real tablets appear, carries
--  site and today_key) and worthless retrospectively.
--  kiosk_sweep_log IS retrospective but pins 19:10, not 17:00: a tablet asleep 16:00-19:00 that woke
--  at 19:05 records as healthy. Treat unverified=false as a FLOOR ("alive by ~17:40"), never as proof
--  of 17:00. unverified=true with a pre-17:00 last-heartbeat note DOES settle it the other way.
--
--  TO MAKE WAKEFULNESS A MEASUREMENT RATHER THAN AN INFERENCE, PERMANENTLY: a pg_cron job at 17:05
--  Manila snapshotting device_id, site, today_key, updated_at from kiosk_health into a small
--  append-only table. Monitoring only, writes no attendance. NOT BUILT — proposed 2026-07-31.
--  Until it exists, the only way to witness 17:00 is to query kiosk_health at 17:00.
--

-- ── HOW TO READ IT ──────────────────────────────────────────────────────────────────────────
--
--  ZERO ROWS FOR BOTH SITES
--    Nobody qualified. Tonight's sms_log zero then proves only that the device was awake — which
--    Carmen being three-for-three at 17:00 this week already established. It does NOT prove the
--    disable took a hit. The real test is the first evening a worker sits at day 1..3.
--
--  ANY ROW WITH would_write_sms_log_row = true
--    That message was not sent and that row was not written. The `return;` took a real hit and the
--    disable is measured, not assumed. Record the codes — they are the evidence.
--
--  would_qualify = true BUT has_phone = false
--    The old path would have run the send and written NOTHING, because sendAbsenceSMS returns on
--    !emp.phone before it reaches the log. Counts as a qualifying worker, not as a suppressed row.
--
--  on_approved_leave_today = true ON ANY ROW
--    That man would have been texted WHILE ON APPROVED LEAVE, because the deployed guard's string
--    comparison never matches. True regardless of tonight's outcome, and worth reporting on its own.
--
--  MANDAUE RETURNING ANY ROWS
--    Expected to return NONE, structurally: it holds no punches for anyone, so every worker's
--    counter runs to the 7-day cap and lands at day 8, outside the bound. That is the second
--    accidental protection recorded in spec rev2 §10a Required #7. If Mandaue DOES return rows, it
--    has punch history that contradicts "never commissioned" — stop and find out where it came from.
--
--  sms_day_number 1 IS THE COMMON CASE, NOT THE EDGE
--    counter 0 -> day 1. Every man who punched yesterday and not today qualifies for a day-1
--    "Attendance Notice". This path was never rare; it fired at every single absence.
--
-- ── VARIANT: what ONE device holding ALL history would have done ────────────────────────────
--  Replace the `sites` CTE with the line below. This is the POST-COMMISSIONING risk — what happens
--  once Mandaue accumulates real punches and two tablets both qualify the same man on the same
--  evening. It is not a measurement of tonight.
--
--    sites as (select * from (values ('')) v(site)),
--
--  ('' matches every site, because LIKE '%%' is always true.)
