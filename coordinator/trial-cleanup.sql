-- ============================================================================
-- COORDINATOR AREA — TRIAL DATA CLEANUP (dry-run -> real books)
-- ----------------------------------------------------------------------------
-- Clears the coordinator area's dry-run data and resets its trial control-number
-- counters, so real work starts at LPR-CAR-000001 / LTR-CAR-000001.
--
-- DO NOT RUN until the roll-call/tool-borrow build (Task 6) has shipped: this clears
-- borrow_issuance, which Tasks 4-5 are still being built and tested against.
--
-- ── WHAT IS **KEPT** (owner-confirmed 2026-07-16) ───────────────────────────
--   voyages ............. THE VESSEL SCHEDULE. Kept fully, explicitly out of scope.
--   employees ........... The coordinator page WRITES this table, but these are the real
--                         payroll roster + kiosk PINs (daily rate, leave balances, home
--                         site). Clearing them would stop payroll paying real salaries,
--                         lock every worker out of the kiosk, and orphan 472 attendance
--                         rows. NEVER touched here.
--   jobs, job_checkpoint, job_progress, job_assignment, job_pause
--                         Kept: the CLOSED, IMMUTABLE KPI week 2026-06-27 (Allan Manos
--                         16/13/123%, closed 2026-07-07) is computed from JOB-CAR-000001
--                         and its checkpoints. efficiency_week is append-only and CANNOT
--                         be deleted, so removing the job would leave a frozen record
--                         permanently citing a job that no longer exists — unrepairable.
--   stock_item .......... A CATALOGUE of standard items (si_gloves, si_darkglass, …), not
--                         trial transactions. Kept so the real books don't start empty.
--   materials ........... Catalogue; the coordinator only reads it.
--   straight_duty, leave_requests
--                         Payroll-adjacent (payroll reads both). Already empty; left alone.
--
-- ── WHAT IS **DELETED** (all dry-run) ───────────────────────────────────────
--   Liquidation ......... liq_line, liq_fund, liq_advance, expenses
--   Purchasing .......... purchase_request  (its number LPR-CAR-000004 shares the LPR counter)
--   Tools ............... borrow_issuance, tool_transfers, repair_log, item_units, items
--                         (tool_transfers is FK-forced: GR001 is mid-transfer, status='transit')
--
-- ── COUNTERS RESET (deleted; next_no re-inserts at n=1 -> ...-000001) ───────
--   LPR (liquidation PR) · LTR (liquidation TR) · BS (borrow slips) · DLV (deliveries)
--   LEFT ALONE: DR (warehouse), MI (material issuance), PR (purchasing) — not coordinator.
--
-- ── SAFETY ─────────────────────────────────────────────────────────────────
--   * ONE transaction. Any RAISE EXCEPTION rolls back EVERYTHING.
--   * No append-only table is touched, so NO immutability trigger is disabled. (A cleanup
--     that removed append-only efficiency_week / efficiency_week_audit rows would first have
--     to disable the block_mutation trigger; this script deletes none of those, so it never
--     needs to — avoiding that risk entirely.)
--   * Every KEPT table's row count is captured before and re-checked after: if a single
--     row moved, the whole thing aborts.
--   * Deletes run in foreign-key order (borrows -> transfers -> units -> items).
--   * Re-runnable: a second run finds nothing to delete and is a no-op.
--
-- HOW TO RUN (Supabase SQL editor):
--   1. Run STEP 0 alone. It changes nothing. Confirm the delete/keep split.
--   2. Run STEP 1.
--   3. The editor does NOT show RAISE NOTICE, so "Success" proves nothing. Claude Code
--      re-queries independently afterwards to confirm what actually landed.
-- ============================================================================

-- ── STEP 0 · PREVIEW (read-only) ────────────────────────────────────────────
SELECT 'DELETE' AS plan, 'borrow_issuance' AS tbl, count(*) AS rows FROM borrow_issuance
UNION ALL SELECT 'DELETE','tool_transfers',  count(*) FROM tool_transfers
UNION ALL SELECT 'DELETE','repair_log',      count(*) FROM repair_log
UNION ALL SELECT 'DELETE','item_units',      count(*) FROM item_units
UNION ALL SELECT 'DELETE','items',           count(*) FROM items
UNION ALL SELECT 'DELETE','liq_line',        count(*) FROM liq_line
UNION ALL SELECT 'DELETE','liq_fund',        count(*) FROM liq_fund
UNION ALL SELECT 'DELETE','liq_advance',     count(*) FROM liq_advance
UNION ALL SELECT 'DELETE','expenses',        count(*) FROM expenses
UNION ALL SELECT 'DELETE','purchase_request',count(*) FROM purchase_request
UNION ALL SELECT 'KEEP  ','voyages (VESSEL SCHEDULE)', count(*) FROM voyages
UNION ALL SELECT 'KEEP  ','employees (PAYROLL ROSTER)', count(*) FROM employees
UNION ALL SELECT 'KEEP  ','jobs',            count(*) FROM jobs
UNION ALL SELECT 'KEEP  ','job_checkpoint',  count(*) FROM job_checkpoint
UNION ALL SELECT 'KEEP  ','job_progress',    count(*) FROM job_progress
UNION ALL SELECT 'KEEP  ','job_assignment',  count(*) FROM job_assignment
UNION ALL SELECT 'KEEP  ','efficiency_week (FROZEN)', count(*) FROM efficiency_week
UNION ALL SELECT 'KEEP  ','stock_item (CATALOGUE)',   count(*) FROM stock_item
UNION ALL SELECT 'KEEP  ','materials (CATALOGUE)',    count(*) FROM materials
UNION ALL SELECT 'COUNTR','slip_counters ' || prefix || '/' || site_code, n FROM slip_counters
ORDER BY 1, 2;

-- ── STEP 1 · CLEANUP (one transaction, self-verifying, rollback on mismatch) ──
DO $$
DECLARE
  -- kept (must not move)
  k_voy int; k_emp int; k_job int; k_jc int; k_jp int; k_ja int; k_ew int; k_ewa int; k_si int; k_mat int;
  a_voy int; a_emp int; a_job int; a_jc int; a_jp int; a_ja int; a_ew int; a_ewa int; a_si int; a_mat int;
  -- deleted (must reach zero)
  d_bi int; d_tt int; d_rl int; d_iu int; d_it int; d_ll int; d_lf int; d_la int; d_ex int; d_pr int;
  left_over int; keep_counters int;
BEGIN
  -- BEFORE: everything we promised to keep.
  SELECT count(*) INTO k_voy FROM voyages;          SELECT count(*) INTO k_emp FROM employees;
  SELECT count(*) INTO k_job FROM jobs;             SELECT count(*) INTO k_jc  FROM job_checkpoint;
  SELECT count(*) INTO k_jp  FROM job_progress;     SELECT count(*) INTO k_ja  FROM job_assignment;
  SELECT count(*) INTO k_ew  FROM efficiency_week;  SELECT count(*) INTO k_ewa FROM efficiency_week_audit;
  SELECT count(*) INTO k_si  FROM stock_item;       SELECT count(*) INTO k_mat FROM materials;
  RAISE NOTICE 'KEEP BEFORE  voyages=% employees=% jobs=% checkpoints=% progress=% assign=% eff_week=% eff_audit=% stock_item=% materials=%',
    k_voy, k_emp, k_job, k_jc, k_jp, k_ja, k_ew, k_ewa, k_si, k_mat;

  -- DELETE in foreign-key order: the borrow references the unit; the transfer references the
  -- unit; the unit references the item. Reverse that order and the FKs reject the delete.
  DELETE FROM borrow_issuance;
  DELETE FROM tool_transfers;      -- GR001 is mid-transfer (status='transit') — FK-forced
  DELETE FROM repair_log;
  DELETE FROM item_units;
  DELETE FROM items;
  -- Liquidation: lines reference the fund.
  DELETE FROM liq_line;
  DELETE FROM liq_fund;
  DELETE FROM liq_advance;
  DELETE FROM expenses;
  DELETE FROM purchase_request;    -- numbered LPR-CAR-000004, shares the LPR counter

  -- Reset ONLY the coordinator's trial counters. next_no re-inserts at n=1, so the next
  -- number is ...-000001. DR (warehouse), MI (material issuance) and PR (purchasing) are
  -- other modules' books — deliberately untouched.
  DELETE FROM slip_counters WHERE prefix IN ('LPR','LTR','BS','DLV');

  -- AFTER: every delete target must be empty.
  SELECT count(*) INTO d_bi FROM borrow_issuance;  SELECT count(*) INTO d_tt FROM tool_transfers;
  SELECT count(*) INTO d_rl FROM repair_log;       SELECT count(*) INTO d_iu FROM item_units;
  SELECT count(*) INTO d_it FROM items;            SELECT count(*) INTO d_ll FROM liq_line;
  SELECT count(*) INTO d_lf FROM liq_fund;         SELECT count(*) INTO d_la FROM liq_advance;
  SELECT count(*) INTO d_ex FROM expenses;         SELECT count(*) INTO d_pr FROM purchase_request;
  left_over := d_bi + d_tt + d_rl + d_iu + d_it + d_ll + d_lf + d_la + d_ex + d_pr;
  IF left_over <> 0 THEN
    RAISE EXCEPTION 'ABORT: % row(s) survived the cleanup (borrow=% transfers=% repair=% units=% items=% liq_line=% liq_fund=% liq_adv=% expenses=% pr=%)',
      left_over, d_bi, d_tt, d_rl, d_iu, d_it, d_ll, d_lf, d_la, d_ex, d_pr;
  END IF;

  -- AFTER: nothing we promised to keep may have moved. This is the guard that protects
  -- payroll (employees), the vessel schedule (voyages) and the frozen KPI week.
  SELECT count(*) INTO a_voy FROM voyages;          SELECT count(*) INTO a_emp FROM employees;
  SELECT count(*) INTO a_job FROM jobs;             SELECT count(*) INTO a_jc  FROM job_checkpoint;
  SELECT count(*) INTO a_jp  FROM job_progress;     SELECT count(*) INTO a_ja  FROM job_assignment;
  SELECT count(*) INTO a_ew  FROM efficiency_week;  SELECT count(*) INTO a_ewa FROM efficiency_week_audit;
  SELECT count(*) INTO a_si  FROM stock_item;       SELECT count(*) INTO a_mat FROM materials;
  IF a_voy <> k_voy THEN RAISE EXCEPTION 'ABORT: VESSEL SCHEDULE changed % -> % (must be untouched)', k_voy, a_voy; END IF;
  IF a_emp <> k_emp THEN RAISE EXCEPTION 'ABORT: employees (PAYROLL ROSTER) changed % -> %', k_emp, a_emp; END IF;
  IF a_job <> k_job THEN RAISE EXCEPTION 'ABORT: jobs changed % -> % (the frozen KPI week needs them)', k_job, a_job; END IF;
  IF a_jc  <> k_jc  THEN RAISE EXCEPTION 'ABORT: job_checkpoint changed % -> % (the frozen KPI week needs them)', k_jc, a_jc; END IF;
  IF a_jp  <> k_jp  THEN RAISE EXCEPTION 'ABORT: job_progress changed % -> %', k_jp, a_jp; END IF;
  IF a_ja  <> k_ja  THEN RAISE EXCEPTION 'ABORT: job_assignment changed % -> %', k_ja, a_ja; END IF;
  IF a_ew  <> k_ew  THEN RAISE EXCEPTION 'ABORT: efficiency_week changed % -> %', k_ew, a_ew; END IF;
  IF a_ewa <> k_ewa THEN RAISE EXCEPTION 'ABORT: efficiency_week_audit changed % -> %', k_ewa, a_ewa; END IF;
  IF a_si  <> k_si  THEN RAISE EXCEPTION 'ABORT: stock_item CATALOGUE changed % -> %', k_si, a_si; END IF;
  IF a_mat <> k_mat THEN RAISE EXCEPTION 'ABORT: materials CATALOGUE changed % -> %', k_mat, a_mat; END IF;

  -- The other modules' counters must survive.
  SELECT count(*) INTO keep_counters FROM slip_counters WHERE prefix IN ('DR','MI','PR');
  IF keep_counters = 0 THEN
    RAISE EXCEPTION 'ABORT: warehouse/purchasing counters (DR/MI/PR) were removed — they are not ours to reset';
  END IF;

  RAISE NOTICE 'OK — trial data cleared; vessel schedule, payroll roster, job/KPI data and catalogues all intact.';
  RAISE NOTICE 'Counters reset: LPR, LTR, BS, DLV -> next numbers are ...-000001. Kept: % other counter row(s).', keep_counters;
END $$;
