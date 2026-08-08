-- ═══════════════════════════════════════════════════════════════════════════════════════════
--  VOID THE FALSE AWOL CASES — awol_events 41–77
--  Incidents: docs/superpowers/specs/2026-08-05-awol-detection-data-source.md §7
--             docs/superpowers/specs/2026-08-06-awol-stale-build-incident.md §4
--
--  ▓▓▓ NOT RUN. Written 2026-08-06. Read the whole header before executing anything. ▓▓▓
--
--  Corrects by ADDITION, never by deletion. The original `detected` rows stay exactly as they are;
--  this adds a `correction` row and a `voided` row per worker and flips the case inactive. The
--  audit log is the company's evidence if a case is ever contested, so nothing in it is rewritten.
--
-- ═══ TWO HARD PRECONDITIONS ═══
--
--  1. awol-void-mute.sql MUST BE APPLIED FIRST. It is WRITTEN AND NOT APPLIED as of 2026-08-06.
--     This file writes voided_at / voided_by / voided_reason / voided_note and relies on the STEP 2
--     guard trigger. Without that migration the columns do not exist and STEP 0's precondition
--     check below will tell you so before anything is attempted.
--
--  2. IDENTIFY THE STALE-BUILD TABLET FIRST. A device running a pre-v2026-07-24b build wrote ids
--     51–77 and is still running its own local sweep. Correcting before it is neutralised risks a
--     third batch landing mid-correction. And DO NOT send that tablet through reset.html — clearing
--     its site data re-arms awolCutover() and refires its whole backlog.
--
-- ═══ RUNNING THIS — the standing rules (CLAUDE.md, owner 2026-08-03) ═══
--   1. CLOSE the azfmpleswqixaslvcito (inventory) tab. It is the only reliable guard.
--   2. Run STEP 0 ALONE, first, and read every answer before running STEP 1.
--   3. STEP 1 is writes, inside one transaction that rolls back unless it touches EXACTLY 36 rows.
--
-- ═══ WHAT IS AND IS NOT TOUCHED ═══
--   37 workers appear across ids 41–77. RSR 0015 is EXCLUDED — his case is real (6 consecutive
--   days, 07/27–08/01, established in the correction of 2026-08-04) and his row is left completely
--   untouched. 37 − 1 = 36, and the transaction refuses to proceed on any other number.
--
-- ═══ ONE DELIBERATE DEVIATION FROM THE BRIEF, STATED PLAINLY ═══
--   The brief asked for one note explaining the 10-day-pruned-local-map-over-a-21-day-lookback
--   defect. That is the true cause of ids 41–50 ONLY. Ids 51–77 have a DIFFERENT cause — a retired
--   build replaying a 7-day local map through awolCutover() — and writing the 21-day explanation
--   onto those 27 rows would put a factually wrong statement into the permanent log, which is the
--   one thing this file exists to avoid. So the note is chosen PER BATCH from the event id that
--   produced the row. Both notes are in plain words. If you want a single shared note instead,
--   replace the CASE in STEP 1 with the batch-A text and re-run STEP 0 first.
-- ═══════════════════════════════════════════════════════════════════════════════════════════


-- ── STEP 0 — CANARY + PRECONDITIONS + CENSUS  ▓▓▓ READ-ONLY. RUN THIS ALONE. ▓▓▓ ────────────

select current_database() as must_be_the_ops_project;
select count(*) as attendance_rows_must_be_over_1000 from public.attendance_records;
-- ^ the count errors immediately in the inventory project. If it errors, you are in the wrong tab.

-- 0a. Precondition 1: the void columns and the guard exist (awol-void-mute.sql applied).
select count(*) as void_cols_must_be_4 from information_schema.columns
 where table_schema='public' and table_name='employee_suspensions'
   and column_name in ('voided_at','voided_by','voided_reason','voided_note');
-- EXPECT 4. If 0, STOP — apply awol-void-mute.sql first.

select count(*) as void_guard_trigger_must_be_1
  from pg_trigger where tgname='employee_suspensions_void_guard_biu' and not tgisinternal;
-- EXPECT 1.

-- 0b. The evidence. These are the rows this file is about; read them before touching anything.
select id, employee_code, event, actor, at, note
  from public.awol_events
 where id between 41 and 77
 order by id;
-- EXPECT 37 rows, all event='detected', actor='detection'.

-- 0c. THE CENSUS. One open case per worker named in those events.
select s.employee_code,
       case when e.max_id <= 50 then 'A · 41-50 pruned-cache defect'
            when e.min_id >= 51 then 'B · 51-77 retired build'
            else 'BOTH · appears in each batch' end                       as batch,
       s.active, s.barred_at, s.voided_at, s.suspended_on, s.reason
  from public.employee_suspensions s
  join (select employee_code, min(id) as min_id, max(id) as max_id
          from public.awol_events where id between 41 and 77 group by employee_code) e
    on e.employee_code = s.employee_code
 order by batch, s.employee_code;
-- EXPECT 37 rows. READ THE barred_at COLUMN: every one must be NULL.

select count(*) as census_must_be_37
  from public.employee_suspensions s
 where s.employee_code in (select employee_code from public.awol_events where id between 41 and 77);

-- 0d. The exclusion, shown explicitly so it is a decision and not an omission.
select employee_code, active, voided_at, suspended_on, reason
  from public.employee_suspensions
 where upper(regexp_replace(employee_code,'[^A-Za-z0-9]','','g')) = 'RSR0015';
-- EXPECT 1 row. It must still be there, UNCHANGED, after STEP 1. His case is real.

-- 0e. What STEP 1 will actually touch: 37 minus RSR 0015, minus anything already voided.
select count(*) as will_touch_must_be_36
  from public.employee_suspensions s
 where s.employee_code in (select employee_code from public.awol_events where id between 41 and 77)
   and upper(regexp_replace(s.employee_code,'[^A-Za-z0-9]','','g')) <> 'RSR0015'
   and s.voided_at is null;

-- 0f. Nobody may be barred. awol_void_case() refuses a barred man for a reason: voiding takes the
--     case off the list where the Reinstate button lives, so it would strand him unable to punch
--     with nothing on screen to undo it. This file honours the same refusal.
select count(*) as barred_must_be_0
  from public.employee_suspensions s
 where s.employee_code in (select employee_code from public.awol_events where id between 41 and 77)
   and s.barred_at is not null;


-- ── STEP 1 — THE CORRECTION AND VOID  ▓▓▓ WRITES. ONE TRANSACTION. ▓▓▓ ──────────────────────
-- Rolls back untouched unless it can void EXACTLY 36 rows. Every refusal below raises, which
-- aborts the transaction, which makes the COMMIT at the bottom a no-op rollback.

begin;

do $$
declare
  v_actor  text := 'Owner';          -- change if someone else runs it; it goes in the log verbatim
  v_codes  text[];
  v_n      int;
  v_barred int;
  v_upd    int;
begin
  -- Who: named by the event ids, so the correction is tied to the evidence rather than to a
  -- reason string that could match something unrelated. Already-voided rows are skipped so a
  -- re-run is safe (it would then find fewer than 36 and refuse, which is the intended outcome).
  select array_agg(s.employee_code order by s.employee_code) into v_codes
    from public.employee_suspensions s
   where s.employee_code in (select employee_code from public.awol_events where id between 41 and 77)
     and upper(regexp_replace(s.employee_code,'[^A-Za-z0-9]','','g')) <> 'RSR0015'
     and s.voided_at is null;

  v_n := coalesce(array_length(v_codes, 1), 0);

  -- Refuse a barred man, exactly as awol_void_case() does.
  select count(*) into v_barred
    from public.employee_suspensions
   where employee_code = any(v_codes) and barred_at is not null;
  if v_barred > 0 then
    raise exception
      'REFUSING: % of these workers are BARRED. Reinstate them first, then void. Nothing written.',
      v_barred using errcode = 'insufficient_privilege';
  end if;

  -- The count gate. 37 in the census, minus RSR 0015, is 36 and only 36.
  if v_n <> 36 then
    raise exception
      'REFUSING: expected exactly 36 cases to void, found %. Re-run STEP 0 and reconcile before retrying. Nothing written.',
      v_n using errcode = 'data_exception';
  end if;

  -- 1) CORRECTION FIRST — the statement of what was wrong, added before the state changes, so the
  --    log reads in the order the decision was actually made. Per batch, because the causes differ.
  insert into public.awol_events (employee_code, event, actor, note)
  select c, 'correction', v_actor,
         case
           when upper(regexp_replace(c,'[^A-Za-z0-9]','','g')) = 'RSR0000' then
             'This case is false. RSR 0000 is the owner''s own test worker and is not a member of '
             || 'staff, so no absence of his can be a disciplinary matter. It was opened only '
             || 'because the detector had no check that the code belonged to a real worker. '
             || 'No NTE was issued or served and he was never barred from punching.'
           when exists (select 1 from public.awol_events e
                         where e.employee_code = c and e.id between 51 and 77) then
             'This case is false. It was written by a retired kiosk build (older than v2026-07-24b) '
             || 'that was still running on one tablet. That old build worked out absences from a list '
             || 'kept on the tablet itself, then sent everything it had built up to the server in one '
             || 'go. It had no check for staff who had left, no exemption list and no way of seeing '
             || 'the real punch records, so it flagged people who had done nothing wrong. The days '
             || 'named in the original row were never checked against attendance_records. '
             || 'No NTE was issued or served and nobody was barred from punching.'
           else
             'This case is false. The detector decided whether each day had been worked by reading a '
             || 'list of punches kept on the tablet itself. That list only keeps the last 10 days, but '
             || 'the detector was looking back 21 days. Anything older than 10 days was simply not '
             || 'there, and a day it could not see was counted as a day absent. The punches were in '
             || 'attendance_records the whole time — the database was never wrong, only the tablet''s '
             || 'copy. The men named here were at work on the days the case lists. '
             || 'No NTE was issued or served and nobody was barred from punching.'
         end
    from unnest(v_codes) as c;

  -- 2) Authorise the void for THIS transaction only. The STEP 2 guard in awol-void-mute.sql
  --    refuses any write to the voided_* columns without it.
  perform set_config('awol.void_authorized', '1', true);

  update public.employee_suspensions s
     set active        = false,
         voided_at     = now(),
         voided_by     = v_actor,
         voided_reason = 'counted_wrong',
         voided_note   = case
           when upper(regexp_replace(s.employee_code,'[^A-Za-z0-9]','','g')) = 'RSR0000'
             then 'Owner test worker — not staff, never a disciplinary matter.'
           when exists (select 1 from public.awol_events e
                         where e.employee_code = s.employee_code and e.id between 51 and 77)
             then 'Written by a retired kiosk build replaying its own local list. Never checked against attendance_records.'
           else 'Detector read a 10-day list on the tablet while looking back 21 days; unseen days were counted as absences.'
         end,
         updated_at    = now()
   where s.employee_code = any(v_codes);
  get diagnostics v_upd = row_count;

  if v_upd <> 36 then
    raise exception
      'REFUSING: the void updated % rows, expected 36. Rolling back — nothing is written.',
      v_upd using errcode = 'data_exception';
  end if;

  -- 3) The void event, mirroring awol_void_case()'s own note shape so a bulk void and a
  --    single-case void read identically in the log a year from now.
  insert into public.awol_events (employee_code, event, actor, note)
  select c, 'voided', v_actor,
         'Case voided - the count was wrong [counted_wrong] - '
         || case
              when upper(regexp_replace(c,'[^A-Za-z0-9]','','g')) = 'RSR0000'
                then 'owner test worker'
              when exists (select 1 from public.awol_events e
                            where e.employee_code = c and e.id between 51 and 77)
                then 'written by a retired kiosk build (awol_events 51-77)'
              else 'pruned-cache detector defect (awol_events 41-50)'
            end
    from unnest(v_codes) as c;

  raise notice 'Voided % cases. RSR 0015 untouched.', v_upd;
end $$;

commit;
-- The Supabase editor swallows RAISE NOTICE. Do not trust it — STEP 2 re-queries.


-- ── STEP 2 — VERIFY  ▓▓▓ READ-ONLY ▓▓▓ ─────────────────────────────────────────────────────

-- 2a. Every case in the batch is now inactive and voided — except RSR 0015.
select s.employee_code, s.active, s.voided_at is not null as voided, s.voided_reason, s.barred_at
  from public.employee_suspensions s
 where s.employee_code in (select employee_code from public.awol_events where id between 41 and 77)
 order by s.employee_code;
-- EXPECT 37 rows: 36 with active=false, voided=true, voided_reason='counted_wrong', barred_at NULL;
-- and RSR 0015 exactly as STEP 0d showed him.

select count(*) as voided_must_be_36
  from public.employee_suspensions s
 where s.employee_code in (select employee_code from public.awol_events where id between 41 and 77)
   and s.voided_reason = 'counted_wrong' and s.active is false;

-- 2b. RSR 0015 UNCHANGED. This is the one that matters most — his case is real.
select employee_code, active, voided_at, voided_reason, suspended_on, reason
  from public.employee_suspensions
 where upper(regexp_replace(employee_code,'[^A-Za-z0-9]','','g')) = 'RSR0015';
-- EXPECT voided_at NULL and voided_reason NULL. If either is set, this file touched a real case.

-- 2c. The log grew by addition only. The 37 original rows are untouched.
select event, count(*) from public.awol_events
 where employee_code in (select employee_code from public.awol_events where id between 41 and 77)
 group by event order by event;
-- EXPECT: detected 37 (unchanged), correction 36, voided 36, plus whatever pre-existed.

select id, employee_code, event, note from public.awol_events
 where id between 41 and 77 order by id;
-- EXPECT the SAME 37 rows, byte for byte, as STEP 0b. Nothing here is ever rewritten.

-- 2d. Read three of the new notes end to end. They are what a person sees if a case is contested,
--     and a note nobody has read is a note nobody has checked.
select employee_code, event, actor, note, at from public.awol_events
 where event in ('correction','voided') and at > now() - interval '10 minutes'
 order by employee_code, id limit 6;

-- No `notify pgrst, 'reload schema'` — this file changes no schema, only rows.
