-- ═══════════════════════════════════════════════════════════════════════════════════════════
--  17:05 HEARTBEAT SNAPSHOT — makes tablet wakefulness a MEASUREMENT, not an inference.
--
--  WHY. The absence-SMS tick fires at endH:endM = 17:00 Manila and has NO catch-up: miss the
--  minute and nothing happens that day, silently. So "the path sent nothing" is ambiguous until you
--  know the device was even running. On 2026-07-31 both evidence channels were blind (no phone, and
--  day 1 vs a day-3 violation gate), and device wakefulness was UNMEASURED — the exact ambiguity
--  this closes.
--
--  WHY kiosk_health ALONE CANNOT ANSWER IT. sendHeartbeat (kiosk :6100) upserts
--  `onConflict: device_id` every 5 minutes (:6120) — ONE ROW PER DEVICE, OVERWRITTEN IN PLACE. No
--  history exists anywhere in this repo. Reading it on Monday describes Monday; Sunday 17:00 is long
--  gone. This job appends a dated copy so the question stays answerable forever.
--
--  WHAT MAKES THE TIMESTAMP TRUSTWORTHY. kiosk_health carries trg_kiosk_health_touch, a
--  BEFORE INSERT OR UPDATE trigger stamping last_seen/updated_at = now() SERVER-SIDE
--  (kiosk-health.sql:21-33), written so a skewed tablet clock cannot influence detection. Without
--  that trigger an upsert would leave updated_at at its original insert time and this whole
--  instrument would read a fossil. STEP 0 checks the trigger is still there.
--
--  RESOLUTION, STATED HONESTLY. The snapshot proves the device was alive within one 5-minute
--  heartbeat cycle of 17:05 — it brackets 17:00, it does not pin it. A tablet that BOOTED at 17:02
--  would look awake here and still have missed the 17:00 tick. To pin the tick itself you would add
--  a second snapshot just before 17:00; not built, and not needed for the current question.
--
--  Monitoring only. WRITES NOTHING TO attendance_records, employees, or any pay-bearing table.
--  Additive + idempotent. Schedule is UTC: 17:05 Manila = 09:05 UTC = '5 9 * * *'.
-- ═══════════════════════════════════════════════════════════════════════════════════════════


-- ── DEVICE IDENTITY IS WEAK. READ THIS BEFORE INTERPRETING ANY ROW. ─────────────────────────
--
--  device_id (kiosk :6072) is a localStorage-persisted random UUID:
--      let id = localStorage.getItem('rsr_device_id');
--      if (!id) { id = crypto.randomUUID(); localStorage.setItem('rsr_device_id', id); }
--  No server registration, no hardware fingerprint, nothing durable behind it. IT REGENERATES —
--  producing a BRAND NEW identity for the same physical tablet — on ANY of:
--      · Fully Kiosk reinstall
--      · webview / site-data clear  <-- INCLUDING the tablet clears this project's own runbooks
--                                       prescribe before a DB teardown (see walkthrough §C2)
--      · a different browser, or a second profile in the same browser
--      · a different origin (localStorage is per-origin)
--      · a private/incognito window
--  And nothing ever DELETES a kiosk_health row: the upsert is onConflict device_id, so a retired
--  identity sits there forever with its last heartbeat frozen.
--  => COUNTING DISTINCT device_id OVERSTATES THE NUMBER OF PHYSICAL TABLETS. Two rows for one site
--     is the expected result of one tablet that was cleared once, not evidence of two tablets.
--
--  THE LOCALHOST GUARD IS HOSTNAME-ONLY (kiosk :6081):
--      const IS_LOCALHOST = (location.hostname === 'localhost' || '127.0.0.1' || '::1');
--  So it suppresses heartbeats ONLY from a page served at those hostnames. ANY BROWSER ON THE LIVE
--  GITHUB PAGES URL HEARTBEATS AS A REAL DEVICE — including an office PC or a phone that merely has
--  the kiosk page open. Such a device gets its own random device_id and reports whatever activeSite
--  its localStorage happens to hold, which may be a yard it has never been to.
--  A non-tablet device is ALSO structurally silent on the SMS path for a separate reason: it holds no
--  punch history, so every worker runs to the counter's 7-day cap and lands outside the 1..3 bound.
--
--  OBSERVED 2026-07-31: THREE rows — two distinct device_ids both reporting site Carmen
--  (updated_at 17:13 and 17:49 Manila, BOTH AFTER the 17:00 tick), and Mandaue last seen 13:56,
--  roughly four hours before shift end. Which of the two Carmen identities is the yard tablet, which
--  is a stale post-clear identity, and whether either is a PC on the live URL, is NOT DETERMINABLE
--  from this table. Resolve it by hand — read rsr_device_id out of the tablet's own localStorage and
--  match it — before treating any Carmen row as "the tablet".
--
--  THE SNAPSHOT IS ALREADY BUILT FOR THIS: it copies EVERY kiosk_health row, keyed on the table's own
--  bigserial id, with device_id carried per row. There is no unique constraint on site and no
--  one-row-per-site assumption anywhere in this file. Three devices produce three rows per fire.


-- ── STEP 0 — PRECHECK. Read-only. Run before anything else. ─────────────────────────────────

-- 0a. pg_cron must be enabled (Database -> Extensions). pg_net is listed for context; this job
--     does not need it (no Telegram send).
select extname, extversion from pg_extension where extname in ('pg_cron','pg_net') order by extname;
-- EXPECT: a row for pg_cron. If ABSENT, stop and enable it before STEP 4.

-- 0b. Jobs already scheduled — so a new entry is added knowingly, not on top of something.
select jobid, jobname, schedule, active from cron.job order by jobname;
-- EXPECT: kiosk-7pm-close-check at '10 11 * * *' (= 19:10 Manila). No 17:05 job yet.

-- 0c. THE ASSUMPTION THIS INSTRUMENT RESTS ON. Without this trigger, updated_at is the row's
--     ORIGINAL insert time and every heartbeat age below is meaningless.
select tgname from pg_trigger
 where tgrelid = 'public.kiosk_health'::regclass and not tgisinternal;
-- EXPECT: trg_kiosk_health_touch

-- 0d. What is in kiosk_health right now, and how stale.
select device_id, site, today_key,
       updated_at at time zone 'Asia/Manila' as last_heartbeat_manila,
       now() - updated_at                    as age
  from public.kiosk_health order by updated_at desc;


-- ── STEP 1 — the append-only table ──────────────────────────────────────────────────────────
-- APPEND-ONLY on purpose: one row per device per fire, never updated. kiosk_health answers "how is
-- the tablet now"; this answers "how was it at 17:05 on a given day", which is a different question
-- and the only one that survives to Monday.
create table if not exists public.kiosk_health_snapshot (
  id            bigserial   primary key,
  snapshot_at   timestamptz not null default now(),  -- when the job looked
  device_id     text,                                 -- null only on the "no devices" sentinel row
  site          text,
  today_key     text,
  heartbeat_at  timestamptz,                          -- kiosk_health.updated_at, server-stamped
  heartbeat_age interval,                             -- snapshot_at - heartbeat_at, precomputed
  note          text
);
create index if not exists kiosk_health_snapshot_at_idx on public.kiosk_health_snapshot (snapshot_at desc);

-- Evidence, not application data. Locked to the service role like kiosk_sweep_log.
revoke all on public.kiosk_health_snapshot from anon, authenticated;
revoke all on sequence public.kiosk_health_snapshot_id_seq from anon, authenticated;


-- ── STEP 2 — the snapshot function ──────────────────────────────────────────────────────────
create or replace function public.kiosk_health_snapshot_take()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_n   integer;
begin
  insert into public.kiosk_health_snapshot
    (snapshot_at, device_id, site, today_key, heartbeat_at, heartbeat_age, note)
  select v_now, h.device_id, h.site, h.today_key, h.updated_at, v_now - h.updated_at, null
    from public.kiosk_health h;
  get diagnostics v_n = row_count;

  -- A NIGHT WHEN NOTHING REPORTED MUST NOT LOOK LIKE A NIGHT THE JOB NEVER RAN. Same principle as
  -- the 7 PM reporter's unverified row: a monitor that goes quiet exactly when things are worst is
  -- worse than no monitor.
  if v_n = 0 then
    insert into public.kiosk_health_snapshot
      (snapshot_at, device_id, site, today_key, heartbeat_at, heartbeat_age, note)
    values (v_now, null, null, null, null, null,
            'NO DEVICES IN kiosk_health at snapshot time — recorded deliberately so an empty night '
            || 'is distinguishable from a job that did not fire');
  end if;

  return v_n;   -- device rows captured; 0 means the sentinel above was written instead
end $$;

-- Cron-only. Not reachable with the public anon key.
revoke all on function public.kiosk_health_snapshot_take() from public, anon, authenticated;


-- ── STEP 3 — TEST FIRE, BEFORE SCHEDULING ANYTHING ──────────────────────────────────────────
-- Prove the table receives rows tonight rather than discovering it empty on Monday. A scheduled job
-- that has never been observed to work is not an instrument, it is a hope.
select public.kiosk_health_snapshot_take() as devices_captured;
-- EXPECT: the number of tablets currently in kiosk_health (0d's row count). A 0 means the sentinel
-- row was written instead — read it, because it means no tablet has ever reported.

-- 3-VERIFY. Read it back with the interpretation applied.
select id,
       snapshot_at  at time zone 'Asia/Manila' as snapshot_manila,
       device_id, site, today_key,
       heartbeat_at at time zone 'Asia/Manila' as heartbeat_manila,
       heartbeat_age,
       (heartbeat_age is not null and heartbeat_age <= interval '6 minutes') as alive_within_one_cycle,
       note
  from public.kiosk_health_snapshot
 order by id desc
 limit 20;
-- HOW TO READ alive_within_one_cycle: heartbeats are every 5 minutes, so an age at or under ~6
-- minutes means the device reported within the last cycle and was running when the job looked.
-- A LARGE age is equally informative — it dates when the tablet was last alive.


-- ── STEP 4 — SCHEDULE. Only after STEP 3 returned rows. ─────────────────────────────────────
-- 17:05 Manila = 09:05 UTC. pg_cron schedules in UTC, hence '5 9 * * *' and not '5 17 * * *'.
-- Five minutes after the tick so a 17:00 heartbeat has landed; see the resolution note in the header.
-- Idempotent re-schedule: unschedule any existing entry of the same name first (ignore if absent).
do $$ begin perform cron.unschedule('kiosk-1705-heartbeat-snapshot'); exception when others then null; end $$;
select cron.schedule('kiosk-1705-heartbeat-snapshot', '5 9 * * *',
                     'select public.kiosk_health_snapshot_take();');


-- ── STEP 5 — VERIFY THE SCHEDULE ────────────────────────────────────────────────────────────
select jobid, jobname, schedule, active, command
  from cron.job where jobname = 'kiosk-1705-heartbeat-snapshot';
-- EXPECT: one row, schedule '5 9 * * *', active true.

select jobname, schedule, active from cron.job order by jobname;
-- EXPECT both jobs: kiosk-1705-heartbeat-snapshot '5 9 * * *' and kiosk-7pm-close-check '10 11 * * *'.


-- ── INSTALLED 2026-07-31, MEASURED NOT ASSUMED ──────────────────────────────────────────────
--    STEP 0c  trg_kiosk_health_touch PRESENT — so updated_at is server-stamped and every age
--             recorded here is a real measurement rather than a frozen insert time.
--    STEP 3   devices_captured = 3 on the manual test fire. All three kiosk_health rows were
--             copied — BOTH Carmen device_ids and Mandaue — which proves in practice, not just by
--             design, that nothing here collapses rows per site.
--    STEP 4/5 scheduled. cron.job holds exactly two entries:
--               kiosk-1705-heartbeat-snapshot  '5 9 * * *'   = 17:05 Manila
--               kiosk-7pm-close-check          '10 11 * * *' = 19:10 Manila
--    The table was proven to receive rows BEFORE the schedule was created, so the first scheduled
--    fire is not also the first test.
--

-- ── FIRST LIVE FIRE: SATURDAY 2026-08-01, 17:05 — AND IT IS ITSELF AN INSTRUMENT ────────────
--
--  The first scheduled fire lands on a SATURDAY, and that is not merely incidental.
--
--  FIVE WEEKS OF sms_log CONTAIN ZERO SATURDAY FIRES. Two explanations have been indistinguishable
--  all along: either nobody ever qualified on a Saturday, or THE TABLETS ARE NOT ON on Saturday
--  afternoons and the 17:00 tick simply never ran. The absence-SMS path could not tell them apart,
--  because a tick that does not run and a tick that finds nobody both write nothing.
--
--  Saturday's snapshot answers it directly, and independently of the SMS path being disabled:
--    rows with a small heartbeat_age  -> tablets ARE on Saturday afternoons. The five-week Saturday
--                                        silence was genuine non-qualification, and the weekend
--                                        tripwire's wakefulness leg is sound.
--    rows with a LARGE heartbeat_age  -> the tablet last spoke hours earlier. Saturday silence was
--                                        never evidence about workers at all, and every Saturday
--                                        inference drawn from sms_log is void.
--    the sentinel row (no devices)    -> nothing was reporting at all.
--
--  This matters for the 2026-08-02 tripwire directly: if Saturday shows the tablets asleep, expect
--  Sunday to show the same, and a zero-violations Sunday would prove nothing. Check Saturday's
--  snapshot BEFORE drawing any conclusion from Sunday.
--
-- ── READING DEVICE IDENTITY OVER TIME (once a few days have accumulated) ────────────────────
--  Which identities exist, when each was first and last seen, and how many days each appeared.
--  A device_id that stops appearing on the same day another starts is the signature of a data clear,
--  not of a tablet being replaced.
--
--    select device_id, site,
--           min(snapshot_at) at time zone 'Asia/Manila' as first_snapshot,
--           max(snapshot_at) at time zone 'Asia/Manila' as last_snapshot,
--           count(*)                                    as days_seen,
--           min(heartbeat_age)                          as best_age,
--           max(heartbeat_age)                          as worst_age
--      from public.kiosk_health_snapshot
--     where device_id is not null
--     group by device_id, site
--     order by site, last_snapshot desc;
--
--  Do NOT read `count(distinct device_id)` as a tablet count. See the identity note in the header.

--  RETENTION: none configured, deliberately. One row per device per day is a handful of rows a year
--  and the history is the whole point. Do not add a prune job without deciding what evidence you are
--  willing to lose.
