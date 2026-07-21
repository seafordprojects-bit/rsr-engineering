-- ============================================================================
--  LIQUIDATION - TRIAL DATA CLEANUP  (project wpmcbjrisuyjvobvzaus)
--  Clears the coordinator LIQUIDATION trial data and resets the LPR/LTR control-number
--  counter so the real books start at LPR-CAR-000001.
--
--  SCOPE (liquidation only): purchase_request (LPR/LTR slips), liq_fund, liq_advance,
--  liq_line, expenses, and the LPR/LTR rows in slip_counters. It does NOT touch tools
--  (borrow_issuance/tool_transfers/etc.) or their BS/DLV counters -- that is the separate,
--  broader coordinator/trial-cleanup.sql. Nothing here overwrites remediation.sql.
--
--  ASSUMPTION: every current liquidation row is TRIAL (STEP 0 lets you confirm that by
--  eye). If STEP 0 shows a row you want to KEEP, STOP and tell me -- resetting LPR while
--  keeping a real LPR-numbered row would eventually collide.
--
--  SAFETY
--   * STEP 1 backs the data up into bak_liq_*_trial tables FIRST (restorable).
--   * STEP 2 is ONE transaction, trigger-safe, self-verifying: any mismatch RAISEs and
--     the whole thing ROLLS BACK (deletes undone, any disabled trigger re-enabled).
--   * Protected tables (employees/payroll, voyages/vessels, jobs + efficiency_week/KPI,
--     materials/stock_item catalogues) are counted before & after -- one row moves, it aborts.
--   * Other modules' counters (DR/MI/PR/BS/DLV) must survive -- checked.
--
--  HOW TO RUN (Supabase SQL editor): run STEP 0 alone and eyeball it. Then STEP 1. Then
--  STEP 2. The editor hides RAISE NOTICE, so "Success" proves little -- re-query after (or
--  tell me and I'll re-query independently).
-- ============================================================================

-- == STEP 0 . CENSUS (read-only -- changes nothing) ==========================
-- 0a. Counts: what gets DELETED, what is KEPT, and the counters.
SELECT 'DELETE' AS plan, 'purchase_request' AS tbl, count(*) AS rows FROM purchase_request
UNION ALL SELECT 'DELETE','liq_fund',    count(*) FROM liq_fund
UNION ALL SELECT 'DELETE','liq_advance', count(*) FROM liq_advance
UNION ALL SELECT 'DELETE','liq_line',    count(*) FROM liq_line
UNION ALL SELECT 'DELETE','expenses',    count(*) FROM expenses
UNION ALL SELECT 'KEEP  ','employees (PAYROLL ROSTER)', count(*) FROM employees
UNION ALL SELECT 'KEEP  ','voyages (VESSEL SCHEDULE)',  count(*) FROM voyages
UNION ALL SELECT 'KEEP  ','jobs',                 count(*) FROM jobs
UNION ALL SELECT 'KEEP  ','efficiency_week (FROZEN KPI)', count(*) FROM efficiency_week
UNION ALL SELECT 'KEEP  ','materials (CATALOGUE)', count(*) FROM materials
UNION ALL SELECT 'KEEP  ','stock_item (CATALOGUE)', count(*) FROM stock_item
UNION ALL SELECT 'COUNTR','slip_counters ' || prefix || '/' || site_code, n FROM slip_counters
ORDER BY 1, 2;

-- 0b. PER-ROW DETAIL -- eyeball trial vs real (series numbers, dates, coordinator/custodian):
SELECT pr_no, date, requested_by, status, site, items, created_at
  FROM purchase_request ORDER BY pr_no;
SELECT * FROM liq_fund    ORDER BY created_at;
SELECT * FROM liq_advance ORDER BY created_at;
SELECT * FROM liq_line    ORDER BY created_at;
SELECT * FROM expenses    ORDER BY created_at;

-- 0c. IMMUTABILITY-TRIGGER CHECK on the liquidation tables (expect 0 rows -- they are normal
--     editable tables. If any appear, STEP 2 already disables them defensively; no action needed).
SELECT tgrelid::regclass::text AS table_name, tgname AS trigger_name, tgenabled
  FROM pg_trigger
 WHERE NOT tgisinternal
   AND tgrelid IN ('purchase_request'::regclass,'liq_fund'::regclass,'liq_advance'::regclass,
                   'liq_line'::regclass,'expenses'::regclass)
 ORDER BY 1,2;

-- 0d. The counter we reset (LPR/LTR) and the ones we keep:
SELECT prefix, site_code, n FROM slip_counters ORDER BY prefix, site_code;

-- == STEP 1 . BACKUP (run BEFORE STEP 2; persists even if STEP 2 aborts) =====
-- Snapshots the trial data into bak_liq_*_trial tables. Re-runnable: 'if not exists' keeps the
-- FIRST snapshot, so running this again after the delete does NOT overwrite it with empty tables.
CREATE TABLE IF NOT EXISTS bak_liq_purchase_request_trial AS SELECT * FROM purchase_request;
CREATE TABLE IF NOT EXISTS bak_liq_fund_trial             AS SELECT * FROM liq_fund;
CREATE TABLE IF NOT EXISTS bak_liq_advance_trial          AS SELECT * FROM liq_advance;
CREATE TABLE IF NOT EXISTS bak_liq_line_trial             AS SELECT * FROM liq_line;
CREATE TABLE IF NOT EXISTS bak_liq_expenses_trial         AS SELECT * FROM expenses;
CREATE TABLE IF NOT EXISTS bak_liq_slip_counters_trial    AS SELECT * FROM slip_counters WHERE prefix IN ('LPR','LTR');
-- Keep the backups out of the anon REST surface (they hold the trial money data).
REVOKE ALL ON bak_liq_purchase_request_trial, bak_liq_fund_trial, bak_liq_advance_trial,
              bak_liq_line_trial, bak_liq_expenses_trial, bak_liq_slip_counters_trial
  FROM anon, authenticated;
-- (To RESTORE later: INSERT INTO <table> SELECT * FROM bak_liq_<table>_trial;  and re-insert the
--  slip_counters rows. To discard once you're confident: DROP TABLE bak_liq_*_trial.)

-- == STEP 2 . CLEANUP (one transaction, trigger-safe, self-verifying, rollback on mismatch) ==
DO $$
DECLARE
  r         record;
  trg_list  text[] := '{}';
  b_emp int; b_voy int; b_job int; b_ew int; b_mat int; b_si int;
  a_emp int; a_voy int; a_job int; a_ew int; a_mat int; a_si int;
  a_pr int; a_lf int; a_la int; a_ll int; a_ex int; leftover int;
  liq_ctr int; keep_ctr int;
BEGIN
  -- BEFORE: protected tables (the guard that keeps payroll, vessels and the frozen KPI safe).
  SELECT count(*) INTO b_emp FROM employees;  SELECT count(*) INTO b_voy FROM voyages;
  SELECT count(*) INTO b_job FROM jobs;        SELECT count(*) INTO b_ew  FROM efficiency_week;
  SELECT count(*) INTO b_mat FROM materials;   SELECT count(*) INTO b_si  FROM stock_item;

  -- TRIGGER-SAFE: temporarily disable any app-level (non-internal) trigger on the liquidation
  -- tables, so an append-only immutability guard (like job_close's) can't block the delete. All in
  -- ONE transaction -> a rollback re-enables them automatically. Expected: none on these tables.
  FOR r IN
    SELECT tgrelid::regclass::text AS tbl, tgname
      FROM pg_trigger
     WHERE NOT tgisinternal
       AND tgrelid IN ('purchase_request'::regclass,'liq_fund'::regclass,'liq_advance'::regclass,
                       'liq_line'::regclass,'expenses'::regclass)
  LOOP
    EXECUTE format('ALTER TABLE %s DISABLE TRIGGER %I', r.tbl, r.tgname);
    trg_list := trg_list || (r.tbl || '|' || r.tgname);
  END LOOP;
  RAISE NOTICE 'Disabled % app-trigger(s) on liquidation tables.', COALESCE(array_length(trg_list,1),0);

  -- DELETE children before parents (liq_line / liq_advance reference liq_fund).
  DELETE FROM liq_line;
  DELETE FROM liq_advance;
  DELETE FROM liq_fund;
  DELETE FROM expenses;
  DELETE FROM purchase_request;

  -- RE-ENABLE the triggers we disabled.
  FOR r IN SELECT split_part(t,'|',1) AS tbl, split_part(t,'|',2) AS tgname FROM unnest(trg_list) t LOOP
    EXECUTE format('ALTER TABLE %s ENABLE TRIGGER %I', r.tbl, r.tgname);
  END LOOP;

  -- RESET the liquidation counters. next_no re-inserts at n=1 -> the next number is LPR-CAR-000001.
  DELETE FROM slip_counters WHERE prefix IN ('LPR','LTR');

  -- VERIFY 1 -- every delete target must be empty.
  SELECT count(*) INTO a_pr FROM purchase_request; SELECT count(*) INTO a_lf FROM liq_fund;
  SELECT count(*) INTO a_la FROM liq_advance;       SELECT count(*) INTO a_ll FROM liq_line;
  SELECT count(*) INTO a_ex FROM expenses;
  leftover := a_pr + a_lf + a_la + a_ll + a_ex;
  IF leftover <> 0 THEN
    RAISE EXCEPTION 'ABORT: % liquidation row(s) survived (pr=% fund=% adv=% line=% exp=%)',
      leftover, a_pr, a_lf, a_la, a_ll, a_ex;
  END IF;

  -- VERIFY 2 -- nothing protected may have moved.
  SELECT count(*) INTO a_emp FROM employees;  SELECT count(*) INTO a_voy FROM voyages;
  SELECT count(*) INTO a_job FROM jobs;        SELECT count(*) INTO a_ew  FROM efficiency_week;
  SELECT count(*) INTO a_mat FROM materials;   SELECT count(*) INTO a_si  FROM stock_item;
  IF a_emp <> b_emp THEN RAISE EXCEPTION 'ABORT: employees (PAYROLL ROSTER) changed % -> %', b_emp, a_emp; END IF;
  IF a_voy <> b_voy THEN RAISE EXCEPTION 'ABORT: voyages (VESSEL SCHEDULE) changed % -> %', b_voy, a_voy; END IF;
  IF a_job <> b_job THEN RAISE EXCEPTION 'ABORT: jobs changed % -> %', b_job, a_job; END IF;
  IF a_ew  <> b_ew  THEN RAISE EXCEPTION 'ABORT: efficiency_week (FROZEN KPI) changed % -> %', b_ew, a_ew; END IF;
  IF a_mat <> b_mat THEN RAISE EXCEPTION 'ABORT: materials CATALOGUE changed % -> %', b_mat, a_mat; END IF;
  IF a_si  <> b_si  THEN RAISE EXCEPTION 'ABORT: stock_item CATALOGUE changed % -> %', b_si, a_si; END IF;

  -- VERIFY 3 -- LPR/LTR counters gone; other modules' counters (DR/MI/PR/BS/DLV) survive.
  SELECT count(*) INTO liq_ctr  FROM slip_counters WHERE prefix IN ('LPR','LTR');
  SELECT count(*) INTO keep_ctr FROM slip_counters WHERE prefix IN ('DR','MI','PR','BS','DLV');
  IF liq_ctr <> 0 THEN RAISE EXCEPTION 'ABORT: LPR/LTR counter(s) survived (%) -- reset failed', liq_ctr; END IF;
  IF keep_ctr = 0 THEN RAISE EXCEPTION 'ABORT: DR/MI/PR/BS/DLV counters were removed -- not ours to reset'; END IF;

  RAISE NOTICE 'OK -- liquidation trial data cleared; LPR/LTR reset (next is LPR-CAR-000001); payroll/vessels/KPI/catalogues and % other counter row(s) intact.', keep_ctr;
END $$;

-- == STEP 3 . RE-QUERY (confirm; the editor hides the NOTICEs above) =========
SELECT (SELECT count(*) FROM purchase_request) AS pr, (SELECT count(*) FROM liq_fund) AS fund,
       (SELECT count(*) FROM liq_advance) AS adv, (SELECT count(*) FROM liq_line) AS line,
       (SELECT count(*) FROM expenses) AS exp,
       (SELECT count(*) FROM slip_counters WHERE prefix IN ('LPR','LTR')) AS liq_counters,  -- expect 0
       (SELECT count(*) FROM slip_counters) AS all_counters;                                -- expect 5 (BS/DLV/DR/MI/PR; LPR removed, no LTR row existed)
