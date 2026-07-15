-- ============================================================================
-- ROLL-CALL SITE TAGGING + TOOL-BORROW SAFETY
-- ----------------------------------------------------------------------------
-- Additive and reversible. Adds:
--   * borrow_issuance.source            -- which writer issued it (roll-call-phone | coordinator)
--   * uniq_borrow_unit_out              -- makes double-issue of one physical tool IMPOSSIBLE
--   * job_checkpoint.site, job_pause.site -- the yard NAME on every roll-call entry / pause
--
-- WHY THE UNIQUE INDEX MATTERS: today the borrow screen reads what is available when the screen
-- LOADS and never re-checks at the moment of issue (tools/index.html:585-597 vs :694). With one
-- writer that rarely bites. The roll-call phone makes a SECOND writer, so two people could hand
-- out the same physical grinder at the same moment and both slips would read "out". The database,
-- not the screen, is what prevents that.
--
-- SAFETY:
--   * STEP 1 is ONE DO block = ONE transaction. Any RAISE EXCEPTION rolls back EVERYTHING.
--   * Aborts rather than forcing the index through if a unit is somehow already out twice.
--   * Re-runnable (idempotent): IF NOT EXISTS throughout; a second run is a no-op.
--   * Row counts are verified unchanged -- this adds columns, it never inserts or deletes.
--   * The shared `sites` table is NOT modified. It is read only, for the code->name backfill.
--     Its stale 'Site A'/'Site B' rows are ignored: jobs carry CAR/MAN, so nothing matches them.
--
-- SCALE (live census 2026-07-16, so you know what to expect):
--   borrow_issuance = 1 row (0 currently out) | jobs = 1 (JOB-CAR-000001, site CAR)
--   job_checkpoint  = 4 rows -> all backfill to 'Carmen' | job_pause = 0 rows (empty)
--   This is a small, low-risk migration. The guards below still apply in full.
--
-- HOW TO RUN (Supabase SQL editor):
--   1. Run STEP 0 alone. It changes nothing.
--   2. If STEP 0 reports ANY unit already out more than once, STOP -- do not run STEP 1.
--   3. Run STEP 1.
--   4. NOTE: this editor does NOT display RAISE NOTICE output, so "Success. No rows returned"
--      proves nothing on its own. Claude Code re-queries independently afterwards to confirm
--      what actually landed.
-- ============================================================================

-- ── STEP 0 · PREVIEW (read-only -- run this by itself first) ────────────────
SELECT 'units already out more than once (MUST be zero)' AS check, unit_id::text AS value, count(*) AS rows
  FROM borrow_issuance WHERE status = 'out' GROUP BY unit_id HAVING count(*) > 1
UNION ALL
SELECT 'borrow_issuance rows total', '', count(*) FROM borrow_issuance
UNION ALL
SELECT 'job_checkpoint rows to backfill', '', count(*) FROM job_checkpoint
UNION ALL
SELECT 'job_pause rows to backfill', '', count(*) FROM job_pause
UNION ALL
SELECT 'jobs by site code (backfill source)', site, count(*) FROM jobs GROUP BY site
UNION ALL
SELECT 'sites code -> name pairing', code || ' -> ' || name, count(*) FROM sites GROUP BY code, name
ORDER BY 1, 3 DESC;

-- ── STEP 1 · MIGRATE (transaction-wrapped, self-verifying, rollback on mismatch) ──
DO $$
DECLARE
  dup int;
  bi_before int; bi_after int;
  jc_before int; jc_after int;
  jp_before int; jp_after int;
  jc_null int; jp_null int;
BEGIN
  SELECT count(*) INTO bi_before FROM borrow_issuance;
  SELECT count(*) INTO jc_before FROM job_checkpoint;
  SELECT count(*) INTO jp_before FROM job_pause;
  RAISE NOTICE 'BEFORE  borrow_issuance=%  job_checkpoint=%  job_pause=%', bi_before, jc_before, jp_before;

  -- Refuse to build a unique index over data that already violates it. If this fires, two
  -- borrows of one physical unit already exist and a human must decide which is real.
  SELECT count(*) INTO dup FROM (
    SELECT unit_id FROM borrow_issuance WHERE status = 'out' GROUP BY unit_id HAVING count(*) > 1
  ) d;
  IF dup > 0 THEN
    RAISE EXCEPTION 'ABORT: % tool unit(s) are already out more than once. Resolve those borrows first.', dup;
  END IF;

  -- Columns: additive and nullable -- every existing row predates them.
  ALTER TABLE borrow_issuance ADD COLUMN IF NOT EXISTS source text;
  ALTER TABLE job_checkpoint  ADD COLUMN IF NOT EXISTS site   text;
  ALTER TABLE job_pause       ADD COLUMN IF NOT EXISTS site   text;

  -- THE guarantee: one physical unit cannot be out twice.
  CREATE UNIQUE INDEX IF NOT EXISTS uniq_borrow_unit_out
    ON borrow_issuance (unit_id) WHERE status = 'out';

  -- Backfill the yard NAME from each job's own site CODE, via the shared sites table.
  -- Roll-call entries store the name ('Carmen'); jobs store the code ('CAR').
  UPDATE job_checkpoint c SET site = s.name
    FROM jobs j JOIN sites s ON s.code = j.site
   WHERE c.job_id = j.id AND c.site IS NULL;
  UPDATE job_pause p SET site = s.name
    FROM jobs j JOIN sites s ON s.code = j.site
   WHERE p.job_id = j.id AND p.site IS NULL;

  -- Row counts must not move.
  SELECT count(*) INTO bi_after FROM borrow_issuance;
  SELECT count(*) INTO jc_after FROM job_checkpoint;
  SELECT count(*) INTO jp_after FROM job_pause;
  IF bi_after <> bi_before THEN RAISE EXCEPTION 'ABORT: borrow_issuance rows changed % -> %', bi_before, bi_after; END IF;
  IF jc_after <> jc_before THEN RAISE EXCEPTION 'ABORT: job_checkpoint rows changed % -> %', jc_before, jc_after; END IF;
  IF jp_after <> jp_before THEN RAISE EXCEPTION 'ABORT: job_pause rows changed % -> %', jp_before, jp_after; END IF;

  -- Rows left with no yard mean a job whose site code is not in `sites`. Expected to be zero
  -- (every job is CAR today) -- reported, never silently ignored.
  SELECT count(*) INTO jc_null FROM job_checkpoint WHERE site IS NULL;
  SELECT count(*) INTO jp_null FROM job_pause      WHERE site IS NULL;

  RAISE NOTICE 'OK -- source + site columns added; uniq_borrow_unit_out created.';
  RAISE NOTICE 'AFTER   borrow_issuance=%  job_checkpoint=%  job_pause=%', bi_after, jc_after, jp_after;
  RAISE NOTICE 'Backfill left % checkpoint and % pause row(s) with no yard (job site code not in `sites`).', jc_null, jp_null;
END $$;
