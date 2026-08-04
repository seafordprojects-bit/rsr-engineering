-- ═══════════════════════════════════════════════════════════════════════════════════════════
--  DEFECT 1 — the AWOL detector must read punch history from the DATABASE, not the tablet
--  Spec: docs/superpowers/specs/2026-08-04-awol-detector-punch-history-and-void.md  §3
--  Read-only, additive, idempotent. Creates ONE function. Touches no data, no table, no grant
--  that anything else depends on.
--
--  IN ONE LINE: the kiosk decides "did he punch that day?" from its own localStorage `records`
--  map, which is pruned to 10 days, while the absence chain looks back 21 and the safety net 30.
--  Past the horizon `records[key]` is undefined, and MISSING DATA READS AS ABSENCE. That is how
--  RSR 0015's count went 6 -> 10 overnight, adding two days he demonstrably worked (07/24, 07/25).
--  This function is the authoritative answer the sweep will read instead.
--
--  SHAPE, and why: one call, whole roster, like awol_skip_list(). Per-worker reads would be ~41
--  REST round trips on the boot path of a tablet that must stay responsive for punching.
--  It returns EVERY detectable worker, punched or not, so an EMPTY result is unambiguously a
--  FAILURE and never a legitimate "nobody punched" — that is what makes the client's fail-open
--  test (`!data.length` -> abandon the sweep) sound.
-- ═══════════════════════════════════════════════════════════════════════════════════════════


-- ── STEP 0 — PROJECT CANARY. Run this FIRST, alone, with the other project's tab CLOSED. ────
select current_database();
-- EXPECT: postgres  (read the NEXT line, not this one — both projects answer 'postgres')

select count(*) as attendance_rows_must_be_nonzero from public.attendance_records;
-- EXPECT: ~1039. This statement ERRORS in the OTHER live project (the shipyard-inventory backend)
-- because the table does not exist there. If it errors, you are in the WRONG PROJECT — stop.

-- Dependency check. awol_punch_days() calls leave_try_date() to normalise the mixed-format
-- date column; awol_effective_site() already depends on it, so it must be live. Prove it.
select public.leave_try_date('07/25/2026') as mmddyyyy_must_be_2026_07_25,
       public.leave_try_date('2026-07-25') as iso_must_be_2026_07_25,
       public.leave_try_date('garbage')    as junk_must_be_null;
-- EXPECT: 2026-07-25 · 2026-07-25 · (null)
-- If this ERRORS with "function does not exist", STOP: leave_try_date has not been installed
-- and nothing below can be trusted.


-- ── STEP 0b — CENSUS of the marker literals, so the rule below is read from data, not guessed ──
-- Spec §3.2.1, owner instruction: "I want to SEE which stored values mean 'no punch' versus
-- 'punched but auto-filled', not have it inferred."
select coalesce(btrim(timein),'(null/empty)') as timein_value, count(*) as rows
  from public.attendance_records
 where timein is null or btrim(timein) = '' or btrim(timein) like '(%'
 group by 1 order by 2 desc;
-- EXPECT: '(null/empty)' ~18 and NOTHING ELSE. No marker literal has ever been written to
-- `timein` in this table. The four markers are excluded in the function below defensively —
-- so a legacy row or a future writer can never smuggle one in as if it were a punch.
-- If a marker DOES appear here, read it before continuing: the exclusion list may need to grow.


-- ── STEP 1 — the function ────────────────────────────────────────────────────────────────────
-- Every punched day per worker, in one answer.
--
-- Load-bearing details, each one a landmine if got wrong:
--
--  1. attendance_records.date is TEXT in MIXED 'MM/DD/YYYY' and 'YYYY-MM-DD' forms. A >= / <=
--     range on the raw text column SILENTLY DROPS ROWS — the standing repo landmine. So the
--     window filter runs on leave_try_date(a.date), which normalises inside SQL and returns
--     NULL (never raises) for anything that does not parse.
--  2. "Punched" = a real clock Time In. NULL, empty, and the four marker literals are all
--     "no punch" — same test as isAutoMark/isMissingMark in kiosk/index.html:1005, so the
--     server and the kiosk agree on what a punch is.
--  3. Codes are normalised the way the kiosk's normCode() does ('RSR 0015' vs 'RSR0015').
--     Codes drift by spacing across sources, and a mismatch here would silently read as
--     "never punched" — i.e. it would invent an absence, the exact defect being fixed.
--  4. Dates come back ISO 'YYYY-MM-DD' so the client compares through awolISO() only.
--  5. The window is anchored to the MANILA date, not the server's UTC date. current_date on a
--     UTC server is a day behind Manila between 00:00 and 08:00 PH — the exact hours the boot
--     sweep runs. 31 days would absorb the slip, but a detector must not depend on slack.
--  6. Default 31 days = the 21-day chain lookback plus the 30-day never-punched safety net,
--     one fetch serving both (30 days back inclusive of today = 31 dates).
create or replace function public.awol_punch_days(p_days int default 31)
returns table (code text, days jsonb)
language sql stable security definer set search_path = public as $$
  with win as (
    select ((now() at time zone 'Asia/Manila')::date
            - greatest(coalesce(p_days, 31), 1)) as from_date
  ),
  punched as (
    select upper(regexp_replace(a.employee_code, '[^A-Za-z0-9]', '', 'g')) as code_norm,
           public.leave_try_date(a.date) as d
      from public.attendance_records a, win w
     where a.timein is not null
       and btrim(a.timein) <> ''
       and btrim(a.timein) not in ('(auto-skipped)','(auto-deducted)','(missing)','(skipped)')
       and public.leave_try_date(a.date) is not null
       and public.leave_try_date(a.date) >= w.from_date
  )
  select e.code,
         coalesce(
           (select jsonb_agg(distinct to_char(p.d, 'YYYY-MM-DD'))
              from punched p
             where p.code_norm = e.code_norm),
           '[]'::jsonb)
    from public.employees e
   where e.separated_at is null
   order by e.code;
$$;

grant execute on function public.awol_punch_days(int) to anon, authenticated;
notify pgrst, 'reload schema';


-- ── STEP 2 — VERIFY. Read every one of these before touching the kiosk. ─────────────────────

-- 2a. Shape. Must mirror awol_skip_list()'s roster exactly — same separated_at filter, so the
--     sweep can never meet a worker who is in one list and absent from the other.
select (select count(*) from public.awol_punch_days())                          as rows_must_be_41,
       (select count(*) from public.awol_skip_list())                           as skip_list_must_match,
       (select count(*) from public.awol_punch_days() where days <> '[]'::jsonb) as with_punches;
-- EXPECT: 41 · 41 · (a real number, well short of 41 — the Mandaue men have never punched)
-- If rows_must_be_41 is 0, the client will fail open and abandon every sweep. That is the
-- SAFE direction, but it means detection is off — do not ship the kiosk change until this is 41.

-- 2b. The case that produced this whole document. RSR 0015 (Niño Nieto Panut).
select days from public.awol_punch_days() where code = 'RSR 0015';
-- EXPECT the array to CONTAIN "2026-07-24" and "2026-07-25" — the two days the 08/04 sweep
-- charged him with being absent, and which he demonstrably worked (08:55/12:00 and 08:15/17:00).
-- EXPECT it to CONTAIN NONE of 2026-07-27 .. 2026-08-03 — those are the real absences.
-- This single row is the whole fix: with it on file, the chain walks back from 08/03 and stops
-- at 07/25, so he reads 7 days instead of 10, and no letter names a day he was at work.

-- 2c. Spacing drift must NOT hide a punch. The roster stores 'RSR 0015'; attendance rows have
--     been written both ways. Both spellings must resolve to the same day list.
select (select count(*) from public.attendance_records
         where employee_code = 'RSR 0015' and timein is not null)               as rows_spaced,
       (select count(*) from public.attendance_records
         where employee_code = 'RSR0015'  and timein is not null)               as rows_unspaced,
       (select jsonb_array_length(days) from public.awol_punch_days()
         where code = 'RSR 0015')                                              as days_returned;
-- EXPECT: days_returned >= rows_spaced + rows_unspaced restricted to the 31-day window.
-- The point of the check is that days_returned is NOT zero when either spelling has rows.

-- 2d. Markers can never read as a punch. Probe rows, then rolled back — nothing is kept.
begin;
  insert into public.attendance_records (employee_code, date, timein, site)
  values ('ZZ PUNCHPROBE', to_char((now() at time zone 'Asia/Manila')::date - 2, 'MM/DD/YYYY'),
          '(missing)', 'Carmen'),
         ('ZZ PUNCHPROBE', to_char((now() at time zone 'Asia/Manila')::date - 3, 'YYYY-MM-DD'),
          '(auto-skipped)', 'Carmen'),
         ('ZZ PUNCHPROBE', to_char((now() at time zone 'Asia/Manila')::date - 4, 'MM/DD/YYYY'),
          '08:15 AM', 'Carmen');
  -- ZZ PUNCHPROBE is not on the roster, so it will not appear in awol_punch_days()'s output.
  -- Test the predicate directly instead, over the probe rows only.
  select a.date, a.timein,
         (a.timein is not null and btrim(a.timein) <> ''
          and btrim(a.timein) not in ('(auto-skipped)','(auto-deducted)','(missing)','(skipped)'))
           as counts_as_punch,
         public.leave_try_date(a.date) as parses_to
    from public.attendance_records a
   where a.employee_code = 'ZZ PUNCHPROBE'
   order by a.date;
  -- EXPECT: '(missing)' false · '(auto-skipped)' false · '08:15 AM' TRUE
  -- EXPECT parses_to non-null on ALL THREE — including the ISO-spelled row. A null there means
  -- the mixed-format normaliser is not doing its job and real punches would vanish.
rollback;

select count(*) as probe_must_be_0 from public.attendance_records
 where employee_code = 'ZZ PUNCHPROBE';
-- EXPECT: 0   (the rollback held; nothing was written to a live pay table)

-- 2e. The window really is a window. Nothing older than p_days may come back.
select code, d as oldest_day_returned,
       ((now() at time zone 'Asia/Manila')::date - d) as days_ago_must_be_le_31
  from (select code, min(x.value #>> '{}')::date as d
          from public.awol_punch_days(), jsonb_array_elements(days) x
         group by code) t
 order by days_ago_must_be_le_31 desc
 limit 5;
-- EXPECT: every days_ago_must_be_le_31 <= 31. A larger number means the filter is not applying.

-- 2f. Fail-open proof for the client: a nonsense window must still return the full roster with
--     empty day lists, NOT an empty result. (An empty RESULT is the client's failure signal;
--     an empty DAY LIST is a legitimate "this man has not punched".)
select count(*) as rows_must_still_be_41,
       count(*) filter (where days = '[]'::jsonb) as all_empty_must_equal_41
  from public.awol_punch_days(1);
-- EXPECT: 41 · (41 or 40 — only someone who punched today or yesterday is non-empty)
-- The number that matters is the FIRST one. If a narrow window collapses the row count, the
-- client's `!data.length` test would misread it as an outage and switch detection off.


-- ── STEP 3 — PERSISTENCE CHECK (standing rule after the 2026-07-31 vanishing install) ───────
-- CLOSE this editor tab. Open a FRESH one. Run the two statements below and nothing else.
select proname, pronargs, prosecdef
  from pg_proc where proname = 'awol_punch_days';
-- EXPECT: awol_punch_days | 1 | true

select count(*) as roster_must_be_41 from public.awol_punch_days();
-- EXPECT: 41
-- Only after BOTH of these answer from a fresh tab may the kiosk change be pushed.
